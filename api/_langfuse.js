// Thin Langfuse accessor. Returns a configured client, or null when the keys
// are absent — callers then no-op silently, so missing observability config
// never breaks a parse request (local dev, or before keys are added to Vercel).
//
// Env:
//   LANGFUSE_PUBLIC_KEY   (pk-lf-...)
//   LANGFUSE_SECRET_KEY   (sk-lf-...)
//   LANGFUSE_BASEURL      (optional; defaults to https://cloud.langfuse.com)

import { Langfuse } from "langfuse";

let cached;

export function getLangfuse(env = process.env) {
  if (cached !== undefined) return cached;

  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    cached = null;
    return cached;
  }

  cached = new Langfuse({
    publicKey,
    secretKey,
    baseUrl: env.LANGFUSE_BASEURL || "https://cloud.langfuse.com",
  });
  return cached;
}
