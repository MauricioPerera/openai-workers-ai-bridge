// Maps OpenAI-style model names to Cloudflare Workers AI model IDs.
// If the incoming name already starts with "@cf/" it is passed through unchanged,
// so callers can target any Workers AI model directly.

const CHAT_ALIASES: Record<string, string> = {
  "gpt-3.5-turbo": "@cf/meta/llama-3.1-8b-instruct",
  "gpt-3.5-turbo-16k": "@cf/meta/llama-3.1-8b-instruct",
  "gpt-4": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4-turbo": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4o": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4o-mini": "@cf/meta/llama-3.2-3b-instruct",
  "o1-mini": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "o1": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
};

const EMBEDDING_ALIASES: Record<string, string> = {
  "text-embedding-ada-002": "@cf/baai/bge-base-en-v1.5",
  "text-embedding-3-small": "@cf/baai/bge-small-en-v1.5",
  "text-embedding-3-large": "@cf/baai/bge-large-en-v1.5",
};

// Workers AI model IDs use a `@<provider>/<name>` shape — e.g. `@cf/...`,
// `@hf/...`. Pass through anything that looks like a native provider ID so
// callers can target any model the account has access to.
const NATIVE_ID_RE = /^@[a-z0-9-]+\//i;

// Default vision-capable model on Workers AI. Used when the caller asks
// for a text-only model but sends image_url / input_image content parts.
export const VISION_DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

// Names containing any of these substrings are treated as vision-capable
// and don't get rerouted. Keeps us forward-compatible with new vision
// model releases without an explicit allowlist.
const VISION_ID_HINTS = ["vision", "llava", "uform", "vlm"];

export function isVisionModel(id: string | undefined | null): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  return VISION_ID_HINTS.some((hint) => lower.includes(hint));
}

export function resolveChatModel(requested: string, fallback: string): string {
  if (!requested) return fallback;
  if (NATIVE_ID_RE.test(requested)) return requested;
  return CHAT_ALIASES[requested] ?? fallback;
}

export function resolveEmbeddingModel(requested: string, fallback: string): string {
  if (!requested) return fallback;
  if (NATIVE_ID_RE.test(requested)) return requested;
  return EMBEDDING_ALIASES[requested] ?? fallback;
}

// Public catalogue surfaced through GET /v1/models. Keep names that real clients
// (n8n, LibreChat) expect to see, plus a handful of native Workers AI IDs.
export const ADVERTISED_MODELS: string[] = [
  // OpenAI-style aliases
  "gpt-3.5-turbo",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4o",
  "gpt-4o-mini",
  "o1-mini",
  "text-embedding-ada-002",
  "text-embedding-3-small",
  "text-embedding-3-large",
  // Native Workers AI IDs
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-70b-instruct",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/mistral/mistral-7b-instruct-v0.1",
  "@cf/qwen/qwen1.5-14b-chat-awq",
  "@cf/google/gemma-7b-it",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/baai/bge-m3",
  "@cf/baai/bge-large-en-v1.5",
  "@cf/baai/bge-base-en-v1.5",
  "@cf/baai/bge-small-en-v1.5",
];
