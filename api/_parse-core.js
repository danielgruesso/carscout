// Provider-agnostic parse core. Turns a buyer's natural-language query into the
// structured search params used by api/listings.js, routing to whichever model
// the caller picked. Pure async logic — no HTTP handler, no logging — so it is
// shared by api/parse.js (live) and evals/run.js (offline scoring).

import { resolveModel } from "./_models.js";

export function buildSystemPrompt(currentYear) {
  return `You are CarScout, a friendly assistant that helps users find used and new cars across the US.

Your job is to (a) parse the user's natural-language query into structured search parameters, and (b) write a short, warm acknowledgement message as if you're about to run the search.

Return ONLY a JSON object — no commentary, no markdown fences.

Fields:

Vehicle:
- make: string. Expand shorthand: vw→Volkswagen, chevy→Chevrolet, mb/benz→Mercedes-Benz, bimmer/beemer→BMW, caddy→Cadillac, vette→Chevrolet (model "Corvette").
- model: string.
- body_type: "sedan"|"SUV"|"truck"|"coupe"|"hatchback"|"minivan"|"wagon"|"convertible" if user describes body type instead of make/model.
- year_min, year_max: integers. Single year → both equal that year. "newer"/"recent"/"late-model" → year_min = current_year - 4, year_max = current_year. (Current year: ${currentYear}.)
- price_max: integer USD. Default 50000.
- mileage_max: integer.
- new_or_used: "new"|"used"|"any". Default "any".
- transmission: "automatic"|"manual"|"any".
- fuel_type: "gas"|"hybrid"|"electric"|"diesel"|"any".

Location (US, nationwide search):
- city: string. If the user mentions a US city, fill it. If not mentioned, default to "Atlanta".
- state: 2-letter uppercase US state code. Default "GA" when city defaults to Atlanta.
- zip: 5-digit US ZIP. If user gives a ZIP, use it; otherwise pick a reasonable downtown ZIP for the chosen city (Atlanta→30303, Seattle→98101, NYC→10001, LA→90001, Chicago→60601, etc.). Default "30303".
- radius_miles: int, default 50.

Conversation:
- ack_message: 1-2 short, friendly sentences confirming what you understood. Mention the make/model (or body type) and the city. Sound like an assistant about to do work — e.g. "Got it — looking for 1999 VW Jettas around Atlanta. Pulling listings now." Do not list every parameter. Do not use emoji.

Refinement:
- If "previous params" appear before the user message, treat the user message as a refinement of that prior search. Merge: keep previous fields unless the user explicitly changes them. Overwrite any field the user updates. In ack_message, acknowledge the refinement ("Narrowing to manual only…", "Switching to Seattle…").

Examples:
"1999 vw jetta" → {"make":"Volkswagen","model":"Jetta","year_min":1999,"year_max":1999,"price_max":50000,"city":"Atlanta","state":"GA","zip":"30303","radius_miles":50,"ack_message":"Got it — a 1999 Volkswagen Jetta around Atlanta. Pulling listings now."}
"red SUV under 20k in Seattle" → {"body_type":"SUV","price_max":20000,"city":"Seattle","state":"WA","zip":"98101","radius_miles":50,"ack_message":"On it — SUVs under $20k around Seattle. Searching now."}
"manual mazda miata" → {"make":"Mazda","model":"MX-5 Miata","transmission":"manual","price_max":50000,"city":"Atlanta","state":"GA","zip":"30303","radius_miles":50,"ack_message":"Nice — manual Mazda Miatas around Atlanta. One sec."}
"hybrid truck 78701" → {"body_type":"truck","fuel_type":"hybrid","price_max":50000,"city":"Austin","state":"TX","zip":"78701","radius_miles":50,"ack_message":"Hybrid trucks around Austin — searching."}`;
}

function buildUserContent(query, previous) {
  return previous
    ? `previous params: ${JSON.stringify(previous)}\n\nuser message: ${query}`
    : query;
}

// Pull a JSON object out of a model response that may include prose or fences.
function extractJson(content) {
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) {
      const err = new Error("invalid_json_from_model");
      err.code = "invalid_json_from_model";
      err.detail = cleaned.slice(0, 300);
      throw err;
    }
    return JSON.parse(m[0]);
  }
}

class UpstreamError extends Error {
  constructor(code, status, detail) {
    super(code);
    this.code = code;
    this.status = status; // HTTP status to surface to the client
    this.detail = detail;
  }
}

// --- Gemini (native generateContent) ------------------------------------------
async function callGemini({ modelId, system, user, apiKey }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelId
  )}:generateContent`;

  const upstream = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 400, responseMimeType: "application/json" },
    }),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    if (upstream.status === 429) throw new UpstreamError("rate_limited", 429, text.slice(0, 300));
    throw new UpstreamError("gemini_upstream", 502, text.slice(0, 400));
  }

  const data = await upstream.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const content = parts.map((p) => p.text || "").join("");
  const u = data?.usageMetadata || {};
  return {
    content,
    usage: {
      promptTokens: u.promptTokenCount ?? null,
      completionTokens: u.candidatesTokenCount ?? null,
      totalTokens: u.totalTokenCount ?? null,
    },
  };
}

// --- OpenRouter (OpenAI-compatible chat/completions) --------------------------
async function callOpenRouter({ modelId, system, user, apiKey }) {
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      // Optional attribution headers OpenRouter recommends.
      "http-referer": "https://carscout.app",
      "x-title": "CarScout",
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0.2,
      max_tokens: 400,
      // Most models honor this; the extractJson fallback covers those that don't.
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    if (upstream.status === 429) throw new UpstreamError("rate_limited", 429, text.slice(0, 300));
    if (upstream.status === 401 || upstream.status === 403) {
      throw new UpstreamError("unauthorized", upstream.status, text.slice(0, 300));
    }
    throw new UpstreamError("openrouter_upstream", 502, text.slice(0, 400));
  }

  const data = await upstream.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const u = data?.usage || {};
  return {
    content,
    usage: {
      promptTokens: u.prompt_tokens ?? null,
      completionTokens: u.completion_tokens ?? null,
      totalTokens: u.total_tokens ?? null,
    },
  };
}

// Read the right API key for a provider, or throw a config error the handler
// can translate into a 500/503 without leaking which key is missing.
function keyFor(provider, env) {
  if (provider === "gemini") {
    const k = env.GEMINI_API_KEY;
    if (!k) throw new UpstreamError("server_not_configured", 500, "GEMINI_API_KEY env var missing");
    return k;
  }
  if (provider === "openrouter") {
    const k = env.OPENROUTER_API_KEY;
    if (!k) throw new UpstreamError("server_not_configured", 503, "OPENROUTER_API_KEY env var missing");
    return k;
  }
  throw new UpstreamError("unknown_provider", 500, provider);
}

/**
 * Parse a buyer query into structured search params with the chosen model.
 * @returns {Promise<{params: object, model: string, provider: string,
 *   usage: {promptTokens:number|null, completionTokens:number|null, totalTokens:number|null},
 *   latencyMs: number}>}
 * Throws UpstreamError (with .status/.code/.detail) on any failure.
 */
export async function parse({ query, previous = null, model, env = process.env, currentYear }) {
  const entry = resolveModel(model);
  const apiKey = keyFor(entry.provider, env);
  const system = buildSystemPrompt(currentYear ?? new Date().getFullYear());
  const user = buildUserContent(query, previous);

  const started = Date.now();
  const adapter = entry.provider === "gemini" ? callGemini : callOpenRouter;
  const { content, usage } = await adapter({ modelId: entry.id, system, user, apiKey });
  const latencyMs = Date.now() - started;

  const params = extractJson(content);
  return { params, model: entry.id, provider: entry.provider, usage, latencyMs };
}

export { UpstreamError };
