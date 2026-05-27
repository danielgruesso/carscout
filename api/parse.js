// Vercel Edge serverless function — proxies to Google Gemini.
// The API key lives in env (GEMINI_API_KEY) so visitors don't need to bring their own.

export const config = { runtime: "edge" };

const DEFAULT_MODEL = "gemini-3.1-flash-lite";

const SYSTEM_PROMPT = `You are CarScout, a friendly assistant that helps users find used and new cars across the US.

Your job is to (a) parse the user's natural-language query into structured search parameters, and (b) write a short, warm acknowledgement message as if you're about to run the search.

Return ONLY a JSON object — no commentary, no markdown fences.

Fields:

Vehicle:
- make: string. Expand shorthand: vw→Volkswagen, chevy→Chevrolet, mb/benz→Mercedes-Benz, bimmer/beemer→BMW, caddy→Cadillac, vette→Chevrolet (model "Corvette").
- model: string.
- body_type: "sedan"|"SUV"|"truck"|"coupe"|"hatchback"|"minivan"|"wagon"|"convertible" if user describes body type instead of make/model.
- year_min, year_max: integers. Single year → both equal that year. "newer"/"recent"/"late-model" → year_min = current_year - 4, year_max = current_year. (Current year: ${new Date().getFullYear()}.)
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ error: "server_not_configured", detail: "GEMINI_API_KEY env var missing" }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }
  const query = body?.query;
  const previous = body?.previous || null;

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return json({ error: "missing_query" }, 400);
  }
  if (query.length > 500) return json({ error: "query_too_long" }, 400);

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const userContent = previous
    ? `previous params: ${JSON.stringify(previous)}\n\nuser message: ${query}`
    : query;

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 400,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      // Forward rate-limit signal so the UI can show a friendly note
      if (upstream.status === 429) {
        return json({ error: "rate_limited", detail: text.slice(0, 300) }, 429);
      }
      return json({ error: "gemini_upstream", status: upstream.status, detail: text.slice(0, 400) }, 502);
    }

    const data = await upstream.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const content = parts.map((p) => p.text || "").join("");
    const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) return json({ error: "invalid_json_from_model", detail: cleaned.slice(0, 300) }, 502);
      parsed = JSON.parse(m[0]);
    }
    return json(parsed, 200);
  } catch (e) {
    return json({ error: "fetch_failed", detail: (e && e.message) || String(e) }, 502);
  }
}
