// Vercel Edge function — serves the latest golden-set eval summary to the
// homepage banner. The data is produced by `npm run eval` (evals/summary.json,
// bundled at build time). Zero-state until the first run has been committed.

import summary from "../evals/summary.json";

export const config = { runtime: "edge" };

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Short cache so a fresh eval (redeploy) shows up quickly, but repeated
      // banner polls don't hammer the function.
      "cache-control": "public, max-age=30, stale-while-revalidate=300",
      ...corsHeaders,
    },
  });
}
