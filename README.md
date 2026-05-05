# OpenAI ↔ Workers AI Bridge

OpenAI-compatible API for **Cloudflare Workers AI**. Deploy this Worker to your own Cloudflare account and you get a drop-in OpenAI endpoint that lets **n8n**, **LibreChat**, **Open WebUI**, **Cursor**, **Continue.dev**, the OpenAI SDKs, or any tool that speaks the OpenAI API talk to Workers AI models (Llama 3, Mistral, Qwen, Gemma, DeepSeek, BGE embeddings, …).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/openai-workers-ai-bridge)

> Replace `YOUR_USERNAME/openai-workers-ai-bridge` in the badge URL above with your fork's path before publishing.

## What it does

| OpenAI endpoint | Status | Notes |
|---|---|---|
| `GET  /v1/models` | ✅ | Lists OpenAI-style aliases (`gpt-4o`, `gpt-3.5-turbo`, …) plus native `@cf/...` IDs. |
| `POST /v1/chat/completions` | ✅ | Streaming (SSE) and non-streaming. Tool/function calling passed through. Vision-capable when `image_url` parts are present. |
| `POST /v1/embeddings` | ✅ | Single string or array. Returns OpenAI shape. |
| `POST /v1/audio/transcriptions` | ✅ | Multipart upload → Whisper (`@cf/openai/whisper` or `whisper-large-v3-turbo`). Supports `json`, `text`, `verbose_json`, `vtt`. |

OpenAI model names are mapped to Workers AI equivalents (see [`src/mapping.ts`](src/mapping.ts)). Any model id starting with `@cf/` is forwarded as-is, so you can target any Workers AI model directly.

## Deploy in one click

1. Fork this repo.
2. Update the **Deploy to Cloudflare** button URL in this README to point at your fork.
3. Click the button. Cloudflare will:
   - clone the repo into your account,
   - install dependencies,
   - bind Workers AI automatically (the `[ai]` block in `wrangler.toml`),
   - deploy the Worker.
4. (Recommended) Set an API key so the endpoint isn't open to the world:
   ```bash
   wrangler secret put API_KEY
   # paste any string, e.g. `sk-myproject-7f3a...`
   ```
   Without `API_KEY` the Worker runs in open mode.

Your endpoint is now live at `https://openai-workers-ai-bridge.<your-subdomain>.workers.dev`.

## Deploy from the CLI

```bash
git clone https://github.com/YOUR_USERNAME/openai-workers-ai-bridge.git
cd openai-workers-ai-bridge
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put API_KEY   # optional but recommended
```

## Local development

```bash
cp .dev.vars.example .dev.vars   # edit API_KEY if you want auth locally
npm install
npm run dev                       # http://127.0.0.1:8787
npm test                          # hermetic unit tests with vitest-pool-workers
```

Quick sanity checks:
```bash
# Chat
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-local-dev-change-me" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'

# Embeddings
curl http://127.0.0.1:8787/v1/embeddings \
  -H "Authorization: Bearer sk-local-dev-change-me" \
  -H "Content-Type: application/json" \
  -d '{"model":"text-embedding-3-small","input":"hello"}'

# Whisper (whisper-1 → @cf/openai/whisper)
curl http://127.0.0.1:8787/v1/audio/transcriptions \
  -H "Authorization: Bearer sk-local-dev-change-me" \
  -F "file=@audio.mp3" \
  -F "model=whisper-1"
```

## Use it in n8n

1. In n8n, open **Credentials → New → OpenAI**.
2. Set:
   - **API Key**: the value you set with `wrangler secret put API_KEY`.
   - **Base URL**: `https://openai-workers-ai-bridge.<your-subdomain>.workers.dev/v1`
3. Drop an **OpenAI Chat Model** node (or use it as the LLM in any AI Agent / Chain node) and pick a model — `gpt-4o`, `gpt-4o-mini`, or any `@cf/...` id you want.
4. For embeddings, use the **Embeddings OpenAI** node with the same credential and model `text-embedding-3-small` (or any `@cf/baai/...`).

## Use it from the OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.WORKERS_AI_KEY,
  baseURL: "https://openai-workers-ai-bridge.<your-subdomain>.workers.dev/v1",
});

const res = await client.chat.completions.create({
  model: "gpt-4o",                              // → @cf/meta/llama-3.3-70b-instruct-fp8-fast
  messages: [{ role: "user", content: "hi" }],
  stream: true,
});
for await (const chunk of res) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

## Configuration

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `API_KEY` | secret | *(unset)* | If set, requires `Authorization: Bearer <API_KEY>` on `/v1/*`. |
| `DEFAULT_CHAT_MODEL` | var | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Used when the request's `model` doesn't match a known alias. |
| `DEFAULT_EMBEDDING_MODEL` | var | `@cf/baai/bge-m3` | Same, for `/v1/embeddings`. |

Set vars in `wrangler.toml` (or the Cloudflare dashboard); set secrets with `wrangler secret put NAME`.

## Limitations & notes

- **Pricing** — calls hit Workers AI on *your* Cloudflare account; you pay for the neurons consumed.
- **Tool calling** — passed through to models that support it (Llama 3.x). Behaviour matches Workers AI's native output.
- **Vision / multipart messages** — text-only multipart `content` arrays are flattened to a string; if any part is `image_url` the whole array is forwarded as-is. Combine with a vision-capable model (e.g. `@cf/meta/llama-3.2-11b-vision-instruct`) to use it.
- **Token usage** — Workers AI doesn't always return usage counts, so `usage` may be zero in responses.
- **Rate limits** — the Worker itself is unmetered, but Workers AI applies its own quotas per account.

## Project layout

```
src/
├── index.ts        Hono router, CORS, bearer auth
├── chat.ts         /v1/chat/completions (streaming + non-streaming)
├── embeddings.ts   /v1/embeddings
├── models.ts       /v1/models, /v1/models/:id
├── mapping.ts      OpenAI → Workers AI model alias table
└── types.ts        Shared types
```

## License

MIT.
