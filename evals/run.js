// Golden-set eval harness. Runs every buyer query through each configured model
// via the same parse core the live app uses, scores structured-field accuracy,
// prints a scoreboard, writes evals/results.csv, and (when Langfuse is
// configured) pushes a dataset run so you get the side-by-side experiment view.
//
//   npm run eval                      # all configured models
//   npm run eval gemini-2.5-flash     # only ids containing these substrings
//
// Reads keys from .env (via dotenv) or the ambient environment.

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

import { MODELS } from "../api/_models.js";
import { parse } from "../api/_parse-core.js";
import { getLangfuse } from "../api/_langfuse.js";
import { scoreOne } from "./score.js";

const DATASET = "carscout-buyer-queries";
const CURRENT_YEAR = new Date().getFullYear();
const RUN_STAMP = new Date().toISOString();

const golden = JSON.parse(readFileSync(new URL("./golden.json", import.meta.url), "utf8"));

// Which providers have a key on this machine.
const providerConfigured = {
  gemini: Boolean(process.env.GEMINI_API_KEY),
  openrouter: Boolean(process.env.OPENROUTER_API_KEY),
};

// Optional CLI filter: only models whose id contains one of the given substrings.
const filters = process.argv.slice(2);
const selected = MODELS.filter((m) => {
  if (!providerConfigured[m.provider]) return false;
  if (filters.length && !filters.some((f) => m.id.includes(f))) return false;
  return true;
});

if (!selected.length) {
  console.error(
    "No runnable models. Set GEMINI_API_KEY and/or OPENROUTER_API_KEY (in .env), " +
      "and check your CLI filter."
  );
  process.exit(1);
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pad = (s, n) => String(s).padEnd(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free tiers throttle hard. Space calls out and retry 429s with exponential
// backoff so a transient rate limit doesn't zero out a model's score.
// Tune via EVAL_DELAY_MS (between calls) and EVAL_RETRIES (per call).
const DELAY_MS = Number(process.env.EVAL_DELAY_MS ?? 3000);
const MAX_RETRIES = Number(process.env.EVAL_RETRIES ?? 5);

async function parseWithRetry(opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await parse(opts);
    } catch (e) {
      if (e?.code !== "rate_limited" || attempt >= MAX_RETRIES) throw e;
      process.stdout.write("·"); // backoff tick
      await sleep(2000 * 2 ** attempt);
    }
  }
}

async function runModel(model) {
  const rows = [];
  for (let i = 0; i < golden.length; i++) {
    const c = golden[i];
    if (i > 0) await sleep(DELAY_MS); // stay under per-minute limits
    try {
      const { params, usage, latencyMs } = await parseWithRetry({
        query: c.query,
        previous: c.previous || null,
        model: model.id,
        env: process.env,
        currentYear: CURRENT_YEAR,
      });
      const s = scoreOne(c.expected, params);
      rows.push({
        caseId: c.id,
        score: s.score,
        matched: s.matched,
        total: s.total,
        latencyMs,
        totalTokens: usage.totalTokens,
        misses: s.misses,
        params,
        error: null,
      });
      process.stdout.write(s.score === 1 ? "." : "x");
    } catch (e) {
      rows.push({
        caseId: c.id,
        score: 0,
        matched: 0,
        total: Object.keys(c.expected).length,
        latencyMs: null,
        totalTokens: null,
        misses: [],
        params: null,
        error: e?.code || e?.message || String(e),
      });
      process.stdout.write("!");
    }
  }
  process.stdout.write("\n");
  return rows;
}

async function pushToLangfuse(lf, allResults) {
  // Upsert the dataset + items (id-keyed, so re-runs don't duplicate).
  await lf.createDataset({
    name: DATASET,
    description: "CarScout buyer queries → expected structured search params",
  });
  for (const c of golden) {
    await lf.createDatasetItem({
      datasetName: DATASET,
      id: c.id,
      input: { query: c.query, previous: c.previous || null },
      expectedOutput: c.expected,
    });
  }

  const dataset = await lf.getDataset(DATASET);
  for (const { model, rows } of allResults) {
    const runName = `${model.id} · ${RUN_STAMP}`;
    const byId = new Map(rows.map((r) => [r.caseId, r]));
    for (const item of dataset.items) {
      const r = byId.get(item.id);
      if (!r) continue;
      const trace = lf.trace({ name: "eval-parse", input: item.input, output: r.params });
      const gen = trace.generation({
        name: "parse",
        model: model.id,
        input: item.input,
        output: r.params ?? { error: r.error },
        usage: r.totalTokens != null ? { total: r.totalTokens, unit: "TOKENS" } : undefined,
        metadata: { provider: model.provider, latencyMs: r.latencyMs },
      });
      gen.end();
      await item.link(gen, runName, {
        description: "Golden-set field-accuracy eval",
        metadata: { provider: model.provider },
      });
      trace.score({ name: "field_accuracy", value: r.score, comment: r.misses.join("; ") || undefined });
    }
    console.log(`  Langfuse run created: ${runName}`);
  }
  await lf.flushAsync();
}

async function main() {
  console.log(
    `Eval: ${selected.length} model(s) × ${golden.length} queries  (. pass  x partial  ! error)\n`
  );

  const allResults = [];
  for (const model of selected) {
    console.log(`▶ ${model.id}`);
    const rows = await runModel(model);
    allResults.push({ model, rows });
  }

  // ---- Scoreboard + per-model summary ----
  console.log("\n" + pad("MODEL", 42) + pad("ACC", 8) + pad("PASS@1", 9) + pad("LAT(ms)", 10) + "TOKENS");
  console.log("-".repeat(80));
  const summaryModels = [];
  for (const { model, rows } of allResults) {
    const acc = avg(rows.map((r) => r.score));
    const pass = rows.filter((r) => r.score === 1).length;
    const lat = avg(rows.filter((r) => r.latencyMs != null).map((r) => r.latencyMs));
    const tok = avg(rows.filter((r) => r.totalTokens != null).map((r) => r.totalTokens));
    const errs = rows.filter((r) => r.error).length;
    console.log(
      pad(model.id, 42) +
        pad((acc * 100).toFixed(1) + "%", 8) +
        pad(`${pass}/${rows.length}`, 9) +
        pad(Math.round(lat) || "—", 10) +
        (Math.round(tok) || "—") +
        (errs ? `   (${errs} err)` : "")
    );
    summaryModels.push({
      id: model.id,
      label: model.label,
      provider: model.provider,
      accuracy: Number(acc.toFixed(4)),
      pass1: pass,
      total: rows.length,
      avgLatencyMs: Math.round(lat) || null,
      avgTokens: Math.round(tok) || null,
      errors: errs,
    });
  }

  // ---- summary.json (feeds the homepage eval banner via /api/eval-summary) ----
  summaryModels.sort((a, b) => b.accuracy - a.accuracy);
  const summary = {
    generatedAt: RUN_STAMP,
    datasetSize: golden.length,
    models: summaryModels,
  };
  writeFileSync(new URL("./summary.json", import.meta.url), JSON.stringify(summary, null, 2) + "\n");
  console.log("Wrote summary → evals/summary.json");

  // ---- CSV ----
  const csvRows = [["model", "case_id", "score", "matched", "total", "latency_ms", "total_tokens", "error", "misses"]];
  for (const { model, rows } of allResults) {
    for (const r of rows) {
      csvRows.push([
        model.id,
        r.caseId,
        r.score.toFixed(3),
        r.matched,
        r.total,
        r.latencyMs ?? "",
        r.totalTokens ?? "",
        r.error ?? "",
        r.misses.join(" | "),
      ]);
    }
  }
  const csv = csvRows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const csvPath = new URL("./results.csv", import.meta.url);
  writeFileSync(csvPath, csv);
  console.log(`\nWrote ${csvRows.length - 1} rows → evals/results.csv`);

  // ---- Langfuse dataset run ----
  const lf = getLangfuse();
  if (lf) {
    try {
      console.log("\nPushing dataset run to Langfuse…");
      await pushToLangfuse(lf, allResults);
    } catch (e) {
      console.warn("Langfuse push failed (scoreboard + CSV are still valid):", e?.message || e);
    }
  } else {
    console.log("\nLangfuse not configured — skipping dataset run (set LANGFUSE_* keys to enable).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
