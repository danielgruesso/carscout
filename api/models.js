// Vercel Edge function — exposes the model registry to the frontend so the
// dropdown stays in sync with api/_models.js without a build step.

import { MODELS, DEFAULT_MODEL_ID } from "./_models.js";

export const config = { runtime: "edge" };

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  // Advertise only providers that are actually configured on this deployment,
  // so the dropdown never offers a model that will 500 for missing keys.
  const providersConfigured = {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
  };
  const available = MODELS.filter((m) => providersConfigured[m.provider]);

  return new Response(
    JSON.stringify({
      models: available.length ? available : MODELS,
      default: DEFAULT_MODEL_ID,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
        ...corsHeaders,
      },
    }
  );
}
