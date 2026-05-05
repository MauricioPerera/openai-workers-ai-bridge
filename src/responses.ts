import type { Context } from "hono";
import { resolveChatModel } from "./mapping";
import type { Env } from "./types";

// OpenAI Responses API (`POST /v1/responses`) — released 2025. Some clients
// (n8n, LangChain.js, the new OpenAI SDK helpers) prefer it over the legacy
// /v1/chat/completions. We translate it into the same Workers AI chat call.

interface ResponsesContentPart {
  type: string;
  text?: string;
  image_url?: string | { url: string };
}

interface ResponsesInputItem {
  role?: "system" | "user" | "assistant" | "developer";
  content?: string | ResponsesContentPart[];
  type?: string;
}

interface ResponsesRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  seed?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: string; json_schema?: unknown };
  text?: { format?: { type: string; json_schema?: unknown } };
  user?: string;
  previous_response_id?: string;
  store?: boolean;
}

function flattenResponsesContent(content: ResponsesInputItem["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      // Responses API uses `input_text` / `output_text` / `input_image`.
      if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && p.text) return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function adaptInputToMessages(req: ResponsesRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  if (req.instructions) messages.push({ role: "system", content: req.instructions });

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
  } else if (Array.isArray(req.input)) {
    for (const item of req.input) {
      // OpenAI sometimes nests assistant outputs as items with type="message" — handle both.
      const role = item.role === "developer" ? "system" : (item.role ?? "user");
      const content = flattenResponsesContent(item.content);
      if (content) messages.push({ role, content });
    }
  }
  return messages;
}

function generateResponseId(): string {
  return "resp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function generateMessageId(): string {
  return "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export async function handleResponses(c: Context<{ Bindings: Env }>) {
  let body: ResponsesRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  if (!body.input) {
    return c.json({ error: { message: "`input` is required", type: "invalid_request_error" } }, 400);
  }

  const model = resolveChatModel(body.model, c.env.DEFAULT_CHAT_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const messages = adaptInputToMessages(body);
  const stream = body.stream === true;

  const aiInput: Record<string, unknown> = { messages, stream };
  if (typeof body.temperature === "number") aiInput.temperature = body.temperature;
  if (typeof body.top_p === "number") aiInput.top_p = body.top_p;
  const maxOut = body.max_output_tokens ?? body.max_tokens;
  if (typeof maxOut === "number") aiInput.max_tokens = maxOut;
  if (typeof body.seed === "number") aiInput.seed = body.seed;
  if (Array.isArray(body.tools) && body.tools.length > 0) aiInput.tools = body.tools;
  const responseFormat = body.response_format ?? body.text?.format;
  if (responseFormat) aiInput.response_format = responseFormat;

  const responseId = generateResponseId();
  const messageId = generateMessageId();
  const created = Math.floor(Date.now() / 1000);
  const modelLabel = body.model || model;

  if (!stream) {
    let result: any;
    try {
      result = await c.env.AI.run(model as keyof AiModels, aiInput as never);
    } catch (err) {
      return c.json(
        { error: { message: (err as Error).message ?? "Workers AI call failed", type: "upstream_error" } },
        502,
      );
    }

    // Same dual-shape handling as chat.ts: legacy `response` field vs.
    // OpenAI-native `choices[].message.content` (Granite, DeepSeek-R1, ...).
    const nativeChoice = Array.isArray(result?.choices) ? result.choices[0] : null;
    const text: string = nativeChoice?.message?.content
      ?? (typeof result?.response === "string" ? result.response : "")
      ?? result?.result?.response
      ?? "";
    const inputTokens = result?.usage?.prompt_tokens ?? 0;
    const outputTokens = result?.usage?.completion_tokens ?? 0;

    return c.json({
      id: responseId,
      object: "response",
      created_at: created,
      status: "completed",
      model: modelLabel,
      output: [
        {
          type: "message",
          id: messageId,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      output_text: text,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      parallel_tool_calls: true,
      tool_choice: body.tool_choice ?? "auto",
      tools: body.tools ?? [],
    });
  }

  // Streaming: emit the SSE event types the Responses API consumers (n8n,
  // LangChain.js, OpenAI's responses.stream helper) listen for.
  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = (await c.env.AI.run(model as keyof AiModels, aiInput as never)) as unknown as ReadableStream<Uint8Array>;
  } catch (err) {
    return c.json(
      { error: { message: (err as Error).message ?? "Workers AI call failed", type: "upstream_error" } },
      502,
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const initialResponse = {
    id: responseId,
    object: "response",
    created_at: created,
    status: "in_progress",
    model: modelLabel,
    output: [],
    parallel_tool_calls: true,
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
  };

  const out = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sequence = 0;
      const writeEvent = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ ...(data as object), sequence_number: sequence++ })}\n\n`),
        );
      };

      writeEvent("response.created", { type: "response.created", response: initialResponse });
      writeEvent("response.in_progress", { type: "response.in_progress", response: initialResponse });

      const itemAdded = {
        type: "message",
        id: messageId,
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      writeEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: itemAdded,
      });
      writeEvent("response.content_part.added", {
        type: "response.content_part.added",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });

      const reader = upstream.getReader();
      let buffer = "";
      let fullText = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sepIndex: number;
          while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);

            for (const line of rawEvent.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const nativeDelta = Array.isArray(parsed.choices) ? parsed.choices[0]?.delta : null;
                const token: string = nativeDelta?.content ?? parsed.response ?? parsed.delta ?? "";
                if (token) {
                  fullText += token;
                  writeEvent("response.output_text.delta", {
                    type: "response.output_text.delta",
                    item_id: messageId,
                    output_index: 0,
                    content_index: 0,
                    delta: token,
                  });
                }
              } catch {
                // Ignore malformed chunks.
              }
            }
          }
        }
      } catch (err) {
        writeEvent("response.failed", {
          type: "response.failed",
          response: { ...initialResponse, status: "failed", error: { message: (err as Error).message } },
        });
        controller.close();
        return;
      }

      writeEvent("response.output_text.done", {
        type: "response.output_text.done",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text: fullText,
      });
      writeEvent("response.content_part.done", {
        type: "response.content_part.done",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: fullText, annotations: [] },
      });
      const finalItem = {
        type: "message",
        id: messageId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: fullText, annotations: [] }],
      };
      writeEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: finalItem,
      });
      writeEvent("response.completed", {
        type: "response.completed",
        response: {
          ...initialResponse,
          status: "completed",
          output: [finalItem],
          output_text: fullText,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(out, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
