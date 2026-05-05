import type { Context } from "hono";
import { runAI } from "./ai-client";
import { resolveEmbeddingModel } from "./mapping";
import type { EmbeddingsRequest, Env } from "./types";

// Embeddings are deterministic for a given (model, text) pair. Cache them in
// the Worker's edge cache so repeated calls (RAG pipelines, n8n loops) don't
// burn neurons on identical inputs. Cache by SHA-256 of model+text.
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7; // one week

async function vectorCacheKey(model: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(model + "\0" + text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  // Cache API requires an http(s) URL key.
  return `https://cache.local/embeddings/${model.replace(/[^a-z0-9]/gi, "_")}/${hex}`;
}

async function readCached(model: string, text: string): Promise<number[] | null> {
  const cache = (caches as any).default as Cache | undefined;
  if (!cache) return null;
  try {
    const key = await vectorCacheKey(model, text);
    const hit = await cache.match(new Request(key));
    if (!hit) return null;
    return (await hit.json()) as number[];
  } catch {
    return null;
  }
}

async function writeCached(model: string, text: string, vector: number[]): Promise<void> {
  const cache = (caches as any).default as Cache | undefined;
  if (!cache) return;
  try {
    const key = await vectorCacheKey(model, text);
    const res = new Response(JSON.stringify(vector), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      },
    });
    await cache.put(new Request(key), res);
  } catch {
    // best-effort
  }
}

export async function handleEmbeddings(c: Context<{ Bindings: Env }>) {
  let body: EmbeddingsRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  if (!body.input) {
    return c.json({ error: { message: "`input` is required", type: "invalid_request_error" } }, 400);
  }

  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  if (inputs.some((s) => typeof s !== "string")) {
    return c.json({ error: { message: "`input` must be string or string[]", type: "invalid_request_error" } }, 400);
  }

  const model = resolveEmbeddingModel(body.model, c.env.DEFAULT_EMBEDDING_MODEL ?? "@cf/baai/bge-m3");

  // Check cache for each input; collect misses for a single upstream call.
  const cached = await Promise.all(inputs.map((t) => readCached(model, t)));
  const misses: { idx: number; text: string }[] = [];
  cached.forEach((v, i) => {
    if (!v) misses.push({ idx: i, text: inputs[i] });
  });

  let upstreamResult: any = null;
  if (misses.length > 0) {
    try {
      upstreamResult = await runAI(c.env, model, { text: misses.map((m) => m.text) });
    } catch (err) {
      return c.json(
        { error: { message: (err as Error).message ?? "Workers AI call failed", type: "upstream_error" } },
        502,
      );
    }

    const fresh: number[][] = upstreamResult?.data ?? [];
    if (fresh.length !== misses.length) {
      return c.json(
        { error: { message: "Upstream returned fewer vectors than requested", type: "upstream_error" } },
        502,
      );
    }
    // Stitch fresh vectors back into the cached array and prime the cache.
    await Promise.all(
      misses.map(async (m, i) => {
        cached[m.idx] = fresh[i];
        await writeCached(model, m.text, fresh[i]);
      }),
    );
  }

  return c.json({
    object: "list",
    data: cached.map((embedding, index) => ({
      object: "embedding",
      index,
      embedding: embedding ?? [],
    })),
    model: body.model || model,
    usage: {
      prompt_tokens: upstreamResult?.usage?.prompt_tokens ?? 0,
      total_tokens: upstreamResult?.usage?.total_tokens ?? 0,
    },
  });
}
