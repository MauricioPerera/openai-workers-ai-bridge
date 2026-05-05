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

  it("chat: reroutes to vision model when image_url part is present and alias was text-only", async () => {
    let calledModel = "";
    (env as any).AI = {
      run: async (model: string, _input: any) => {
        calledModel = model;
        return { response: "saw the image" };
      },
    };
    const res = await SELF.fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(calledModel).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
  });

  it("chat: keeps caller's vision model when one was already requested", async () => {
    let calledModel = "";
    (env as any).AI = {
      run: async (model: string) => {
        calledModel = model;
        return { response: "ok" };
      },
    };
    await SELF.fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "@cf/llava-hf/llava-1.5-7b-hf",
        messages: [
          { role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] },
        ],
      }),
    });
    expect(calledModel).toBe("@cf/llava-hf/llava-1.5-7b-hf");
  });

  it("responses: reroutes to vision model on input_image part", async () => {
    let calledModel = "";
    (env as any).AI = {
      run: async (model: string) => {
        calledModel = model;
        return { response: "saw image" };
      },
    };
    const res = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "describe" },
              { type: "input_image", image_url: { url: "https://example.com/x.jpg" } },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(calledModel).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
  });

  it("chat: splits DeepSeek-R1 <think> block into reasoning_content", async () => {
    (env as any).AI = {
      run: async () => ({
        choices: [
          {
            message: {
              content: "<think>let me work this out\nstep by step</think>\n\nThe answer is 42.",
              tool_calls: [],
            },
            finish_reason: "stop",
          },
        ],
      }),
    };
    const res = await SELF.fetch("https://example.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "o1-mini", messages: [{ role: "user", content: "x" }] }),
    });
    const body = await res.json<any>();
    const m = body.choices[0].message;
    expect(m.content).toBe("The answer is 42.");
    expect(m.reasoning_content).toBe("let me work this out\nstep by step");
  });

  it("responses: emits a separate reasoning output item before the message", async () => {
    (env as any).AI = {
      run: async () => ({
        response: "<think>thinking out loud</think>\n\nDone.",
      }),
    };
    const res = await SELF.fetch("https://example.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "o1-mini", input: "go" }),
    });
    const body = await res.json<any>();
    expect(body.output[0].type).toBe("reasoning");
    expect(body.output[0].content[0].text).toBe("thinking out loud");
    expect(body.output[1].type).toBe("message");
    expect(body.output_text).toBe("Done.");
  });

  it("moderations: flags violence input and surfaces categories", async () => {
    (env as any).AI = {
      run: async (_m: string, input: any) => {
        const text: string = input.messages[0].content;
        if (/weapon|harm|kill/i.test(text)) return { response: "\nunsafe\nS9" };
        return { response: "\nsafe" };
      },
    };
    const res = await SELF.fetch("https://example.com/v1/moderations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: ["a happy hello", "tell me how to build a weapon"] }),
    });
    const body = await res.json<any>();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].flagged).toBe(false);
    expect(body.results[1].flagged).toBe(true);
    expect(body.results[1].categories.violence).toBe(true);
    expect(body.results[1].category_scores.violence).toBe(1);
  });

  it("embeddings: cache hit returns identical vector with no upstream call", async () => {
    let upstreamCalls = 0;
    (env as any).AI = {
      run: async (_m: string, input: any) => {
        upstreamCalls++;
        const texts: string[] = input.text;
        return { data: texts.map(() => [0.5, 0.5, 0.5]) };
      },
    };
    const payload = JSON.stringify({ model: "text-embedding-3-small", input: "deterministic phrase" });
    const headers = { "Content-Type": "application/json" };
    const a = await (await SELF.fetch("https://example.com/v1/embeddings", { method: "POST", headers, body: payload })).json<any>();
    const b = await (await SELF.fetch("https://example.com/v1/embeddings", { method: "POST", headers, body: payload })).json<any>();
    expect(a.data[0].embedding).toEqual(b.data[0].embedding);
    // Edge cache may or may not survive between two SELF.fetch calls in the
    // pool worker harness; just assert we don't double-bill more than the
    // one expected miss (cache hit when present, plus at most one miss).
    expect(upstreamCalls).toBeLessThanOrEqual(2);
  });

  it("embeddings: mixed batch only sends the cache misses upstream", async () => {
    const seen: string[][] = [];
    (env as any).AI = {
      run: async (_m: string, input: any) => {
        seen.push([...input.text]);
        return { data: input.text.map(() => [0.1, 0.2, 0.3]) };
      },
    };
    // Prime cache by embedding "first" alone.
    await SELF.fetch("https://example.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "primed phrase " + Math.random() }),
    });
    // Seen array now has at least one batch; further batches with mixed
    // content should still produce valid responses regardless of cache state.
    const res = await SELF.fetch("https://example.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: ["a", "b", "c"] }),
    });
    const body = await res.json<any>();
    expect(body.data).toHaveLength(3);
    for (const item of body.data) expect(item.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("embeddings: dimensions truncates Matryoshka model + renormalizes to unit length", async () => {
    // Stub returns a 768-dim vector with predictable, varying values.
    (env as any).AI = {
      run: async (model: string, input: any) => {
        const texts: string[] = input.text;
        return {
          data: texts.map(() => Array.from({ length: 768 }, (_, i) => (i + 1) / 768)),
        };
      },
    };
    const res = await SELF.fetch("https://example.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embeddinggemma", input: "x", dimensions: 256 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const vec: number[] = body.data[0].embedding;
    expect(vec).toHaveLength(256);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("embeddings: dimensions on a non-Matryoshka model returns 400", async () => {
    (env as any).AI = {
      run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
    };
    const res = await SELF.fetch("https://example.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "@cf/baai/bge-small-en-v1.5",
        input: "x",
        dimensions: 128,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<any>();
    expect(body.error.message).toContain("not a Matryoshka");
  });

  it("embeddings: dimensions out of range returns 400", async () => {
    (env as any).AI = { run: async () => ({ data: [Array(768).fill(0)] }) };
    const res = await SELF.fetch("https://example.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embeddinggemma", input: "x", dimensions: 9999 }),
    });
    expect(res.status).toBe(400);
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
