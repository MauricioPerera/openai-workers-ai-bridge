import { env, SELF } from "cloudflare:test";
import { describe, expect, it, beforeEach } from "vitest";
import worker from "../src/index";

describe("OpenAI bridge smoke tests", () => {
  beforeEach(() => {
    // Stub the AI binding so unit tests stay hermetic.
    (env as any).AI = {
      run: async (model: string, input: any) => {
        if (model.includes("bge")) {
          const inputs: string[] = input.text;
          return { data: inputs.map(() => [0.1, 0.2, 0.3]) };
        }
        return { response: `echo: ${input.messages?.at(-1)?.content ?? ""}` };
      },
    };
    delete (env as any).API_KEY;
  });

  it("GET / returns service info", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    const body = await res.json<{ endpoints: string[] }>();
    expect(body.endpoints).toContain("/v1/chat/completions");
  });

  it("GET /v1/models lists at least the OpenAI aliases", async () => {
    const res = await SELF.fetch("https://example.com/v1/models");
    expect(res.status).toBe(200);
    const body = await res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("@cf/meta/llama-3.1-8b-instruct");
  });

  it("POST /v1/chat/completions returns OpenAI-shaped response", async () => {
    const res = await SELF.fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toContain("echo: ping");
  });

  it("POST /v1/embeddings returns vector list", async () => {
    const res = await SELF.fetch("https://example.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: ["a", "b"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("POST /v1/responses returns Responses-API-shaped output", async () => {
    const res = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: "ping",
        instructions: "Be terse.",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output[0].role).toBe("assistant");
    expect(body.output_text).toContain("echo: ping");
  });

  it("chat: tool_calls in non-stream response set finish_reason=tool_calls", async () => {
    (env as any).AI = {
      run: async () => ({
        response: null,
        tool_calls: [{ name: "do_thing", arguments: { x: 1 } }],
      }),
    };
    const res = await SELF.fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "do" }] }),
    });
    const body = await res.json<any>();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls?.[0]?.name).toBe("do_thing");
    expect(body.choices[0].message.content).toBe(null);
  });

  it("responses streaming emits function_call events when model returns tool_calls", async () => {
    const sse =
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_42","function":{"name":"do_thing","arguments":"{\\"x\\":1}"}}]}}]}\n\n` +
      `data: [DONE]\n\n`;
    (env as any).AI = {
      run: async (_m: string, input: any) => {
        if (input.stream) return new Response(sse).body!;
        return { choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }] };
      },
    };

    const res = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: "do it",
        stream: true,
        tools: [{ type: "function", name: "do_thing", parameters: { type: "object" } }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Must include the function-call lifecycle events
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain("event: response.function_call_arguments.delta");
    expect(text).toContain("event: response.function_call_arguments.done");
    expect(text).toContain("event: response.completed");
    // No empty message item should be emitted when there's no text
    expect(text).not.toContain('"type":"output_text","text":""');
  });

  it("chat streaming sets finish_reason=tool_calls when model emitted tool_calls", async () => {
    const sse =
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{}"}}]}}]}\n\n` +
      `data: [DONE]\n\n`;
    (env as any).AI = {
      run: async (_m: string, input: any) => {
        if (input.stream) return new Response(sse).body!;
        return { response: "x" };
      },
    };
    const res = await SELF.fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "x" }], stream: true }),
    });
    const text = await res.text();
    // Last meaningful chunk before [DONE] should carry finish_reason="tool_calls"
    expect(text).toMatch(/"finish_reason":"tool_calls"/);
  });

  it("rejects requests when API_KEY is set and bearer is missing", async () => {
    (env as any).API_KEY = "sk-test";
    const res = await SELF.fetch("https://example.com/v1/models");
    expect(res.status).toBe(401);
  });

  it("accepts requests with the matching bearer token", async () => {
    (env as any).API_KEY = "sk-test";
    const res = await SELF.fetch("https://example.com/v1/models", {
      headers: { Authorization: "Bearer sk-test" },
    });
    expect(res.status).toBe(200);
  });
});

// Quiet "unused import" warning in environments where worker is treeshaken.
void worker;
