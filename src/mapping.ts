// Maps OpenAI-style model names to Cloudflare Workers AI model IDs.
// Anything matching `@<provider>/...` (`@cf/`, `@hf/`, …) is passed through
// verbatim so callers can target any model their account has access to.

const CHAT_ALIASES: Record<string, string> = {
  // GPT-3.5 family — small/cheap
  "gpt-3.5-turbo": "@cf/meta/llama-3.1-8b-instruct",
  "gpt-3.5-turbo-16k": "@cf/meta/llama-3.1-8b-instruct",

  // GPT-4 family — large
  "gpt-4": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4-turbo": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4o": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4o-mini": "@cf/meta/llama-3.2-3b-instruct",
  "gpt-4.1": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "gpt-4.1-mini": "@cf/meta/llama-3.2-3b-instruct",
  "gpt-4.1-nano": "@cf/meta/llama-3.2-1b-instruct",

  // o-series → reasoning-style models on Workers AI
  "o1": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "o1-mini": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "o1-preview": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "o3": "@cf/qwen/qwq-32b",
  "o3-mini": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "o4-mini": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",

  // Code-specialised
  "gpt-4o-code": "@cf/qwen/qwen2.5-coder-32b-instruct",
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

// Reasoning-style models stream a <think>...</think> block before their
// final answer. The chat / responses handlers split that off into
// reasoning_content / a Responses API "reasoning" item respectively.
const REASONING_ID_HINTS = ["deepseek-r1", "qwq"];

export function isReasoningModel(id: string | undefined | null): boolean {
  if (!id) return false;
  const lower = id.toLowerCase();
  return REASONING_ID_HINTS.some((hint) => lower.includes(hint));
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
  // OpenAI-style aliases — chat
  "gpt-3.5-turbo",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o1",
  "o1-mini",
  "o3",
  "o3-mini",
  "o4-mini",
  // OpenAI-style aliases — embeddings, audio, images
  "text-embedding-ada-002",
  "text-embedding-3-small",
  "text-embedding-3-large",
  "whisper-1",
  "tts-1",
  "tts-1-hd",
  "dall-e-3",
  "dall-e-2",
  "text-moderation-latest",
  "text-moderation-stable",
  // Native Workers AI IDs (chat)
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/qwen/qwq-32b",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/google/gemma-3-12b-it",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@hf/nousresearch/hermes-2-pro-mistral-7b",
  // Embeddings
  "@cf/baai/bge-m3",
  "@cf/baai/bge-large-en-v1.5",
  "@cf/baai/bge-base-en-v1.5",
  "@cf/baai/bge-small-en-v1.5",
  // Audio
  "@cf/openai/whisper",
  "@cf/openai/whisper-large-v3-turbo",
  "@cf/myshell-ai/melotts",
  "@cf/deepgram/aura-1",
  // Images
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/bytedance/stable-diffusion-xl-lightning",
  "@cf/lykon/dreamshaper-8-lcm",
  // Moderation
  "@cf/meta/llama-guard-3-8b",
];
