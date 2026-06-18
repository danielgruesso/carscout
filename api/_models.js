// Shared model registry — the single source of truth for which models the
// dropdown offers and how api/parse.js routes a request.
//
// Every model here MUST have a usable free tier:
//   - provider "gemini":     Google AI Studio free tier  (GEMINI_API_KEY)
//   - provider "openrouter": OpenRouter ":free" variants  (OPENROUTER_API_KEY)
//
// NOTE: OpenRouter's ":free" model ids rotate over time (a model can lose its
// free variant, or a new one appears). This file is the ONE place to edit them.
// Verify current free ids at: https://openrouter.ai/models?max_price=0
//
// Imported by:
//   - api/_parse-core.js  (routing)
//   - api/models.js       (GET endpoint that feeds the frontend dropdown)
//   - evals/run.js        (cross-model scoring)

export const MODELS = [
  // --- Google Gemini (native adapter) ---
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "gemini", free: true },
  { id: "gemini-2.5-flash",      label: "Gemini 2.5 Flash",      provider: "gemini", free: true },
  { id: "gemini-2.0-flash",      label: "Gemini 2.0 Flash",      provider: "gemini", free: true },

  // --- OpenRouter (OpenAI-compatible adapter), all ":free" tier ---
  // Verified present on the free list 2026-06-18; re-check at the URL above —
  // OpenRouter retires free variants regularly (the old DeepSeek/Qwen2.5/Mistral
  // ids 404'd once they went paid-only).
  { id: "meta-llama/llama-3.3-70b-instruct:free",   label: "Llama 3.3 70B (free)",       provider: "openrouter", free: true },
  { id: "openai/gpt-oss-120b:free",                 label: "GPT-OSS 120B (free)",        provider: "openrouter", free: true },
  { id: "qwen/qwen3-next-80b-a3b-instruct:free",    label: "Qwen3 Next 80B (free)",      provider: "openrouter", free: true },
  { id: "google/gemma-4-31b-it:free",               label: "Gemma 4 31B (free)",         provider: "openrouter", free: true },
  { id: "nousresearch/hermes-3-llama-3.1-405b:free", label: "Hermes 3 405B (free)",      provider: "openrouter", free: true },
];

// The default model used when the client sends none / an unknown id.
export const DEFAULT_MODEL_ID = "gemini-3.1-flash-lite";

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

// Resolve a requested model id to a registry entry. Falls back to the default
// so a stale or hostile client value can never route us to an arbitrary model.
export function resolveModel(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_MODEL_ID);
}
