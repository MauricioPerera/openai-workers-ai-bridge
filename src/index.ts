import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleTranscriptions } from "./audio";
import { handleChatCompletions } from "./chat";
import { handleEmbeddings } from "./embeddings";
import { handleListModels, handleRetrieveModel } from "./models";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "OpenAI-Beta", "x-api-key"],
  exposeHeaders: ["x-request-id"],
  maxAge: 86400,
}));

// Bearer-token auth. Skipped only when API_KEY is not configured (open mode).
app.use("/v1/*", async (c, next) => {
  const expected = c.env.API_KEY;
  if (!expected) return next();

  const header = c.req.header("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (provided !== expected) {
    return c.json(
      {
        error: {
          message: "Invalid or missing API key. Send `Authorization: Bearer <API_KEY>`.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      },
      401,
    );
  }
  return next();
});

app.get("/", (c) =>
  c.json({
    name: "openai-workers-ai-bridge",
    description: "OpenAI-compatible API for Cloudflare Workers AI",
    endpoints: [
      "/v1/models",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/audio/transcriptions",
    ],
    auth: c.env.API_KEY ? "bearer-token" : "open (set API_KEY secret to enable auth)",
  }),
);

app.get("/v1/models", handleListModels);
app.get("/v1/models/:id{.+}", handleRetrieveModel);
app.post("/v1/chat/completions", handleChatCompletions);
app.post("/v1/embeddings", handleEmbeddings);
app.post("/v1/audio/transcriptions", handleTranscriptions);

app.notFound((c) =>
  c.json({ error: { message: `No route for ${c.req.method} ${c.req.path}`, type: "not_found" } }, 404),
);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: { message: err.message ?? "Internal error", type: "internal_error" } }, 500);
});

export default app;
