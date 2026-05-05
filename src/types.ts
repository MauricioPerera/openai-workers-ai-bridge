export interface Env {
  AI: Ai;
  DEFAULT_CHAT_MODEL?: string;
  DEFAULT_EMBEDDING_MODEL?: string;
  API_KEY?: string;
  // Optional — if set, the bridge calls Workers AI via the REST API instead
  // of the AI binding. Strongly recommended: the binding has been observed
  // to ignore tool definitions in some Hono-routed contexts (Hermes, Llama 70B).
  CLOUDFLARE_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: string; json_schema?: unknown };
  user?: string;
}

export interface EmbeddingsRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  user?: string;
}
