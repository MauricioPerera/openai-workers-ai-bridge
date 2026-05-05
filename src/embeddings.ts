import type { Context } from "hono";
import { resolveEmbeddingModel } from "./mapping";
import type { EmbeddingsRequest, Env } from "./types";

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

  let result: any;
  try {
    result = await c.env.AI.run(model as keyof AiModels, { text: inputs } as never);
  } catch (err) {
    return c.json(
      { error: { message: (err as Error).message ?? "Workers AI call failed", type: "upstream_error" } },
      502,
    );
  }

  // Workers AI embedding response: { shape: [n, dim], data: number[][] }
  const vectors: number[][] = result?.data ?? [];

  return c.json({
    object: "list",
    data: vectors.map((embedding, index) => ({
      object: "embedding",
      index,
      embedding,
    })),
    model: body.model || model,
    usage: {
      prompt_tokens: 0,
      total_tokens: 0,
    },
  });
}
