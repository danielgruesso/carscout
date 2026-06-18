// Vercel Edge function — parses a buyer's query into structured search params
// using the model the client picked, and traces the call to Langfuse.
//
// Routing + provider adapters live in _parse-core.js; the model registry in
// _models.js; Langfuse client in _langfuse.js. This file is just the HTTP
// boundary: validate → parse → trace → respond.

import { parse, UpstreamError } from "./_parse-core.js";
import { getLangfuse } from "./_langfuse.js";

export const config = { runtime: "edge" };

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }
  const query = body?.query;
  const previous = body?.previous || null;
  const requestedModel = body?.model;

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return json({ error: "missing_query" }, 400);
  }
  if (query.length > 500) return json({ error: "query_too_long" }, 400);

  const lf = getLangfuse();
  const trace = lf?.trace({
    name: "parse",
    input: { query, previous },
    metadata: { requestedModel: requestedModel || null },
    tags: ["carscout", "parse"],
  });
  const startTime = new Date();

  try {
    const result = await parse({ query, previous, model: requestedModel });

    // Record the generation so Langfuse shows latency + token usage + cost.
    trace?.generation({
      name: "parse",
      model: result.model,
      startTime,
      endTime: new Date(),
      input: { query, previous },
      output: result.params,
      usage: {
        input: result.usage.promptTokens ?? undefined,
        output: result.usage.completionTokens ?? undefined,
        total: result.usage.totalTokens ?? undefined,
        unit: "TOKENS",
      },
      metadata: { provider: result.provider, latencyMs: result.latencyMs },
    });
    trace?.update({ output: result.params });

    return json(
      {
        ...result.params,
        meta: {
          model: result.model,
          provider: result.provider,
          latencyMs: result.latencyMs,
          usage: result.usage,
        },
      },
      200
    );
  } catch (e) {
    const code = e?.code || "fetch_failed";
    const status = e instanceof UpstreamError ? e.status : 502;
    trace?.update({ output: { error: code }, metadata: { error: code, detail: e?.detail } });
    return json({ error: code, detail: e?.detail || (e && e.message) || String(e) }, status);
  } finally {
    // Serverless: must flush before the function suspends or events are lost.
    if (lf) await lf.flushAsync().catch(() => {});
  }
}
