import type { Context } from "hono";
import type { Env } from "./types";

const WHISPER_ALIASES: Record<string, string> = {
  "whisper-1": "@cf/openai/whisper",
  "whisper-large": "@cf/openai/whisper-large-v3-turbo",
  "whisper-large-v3": "@cf/openai/whisper-large-v3-turbo",
};

function resolveWhisperModel(requested: string | undefined): string {
  if (!requested) return "@cf/openai/whisper";
  if (requested.startsWith("@cf/")) return requested;
  return WHISPER_ALIASES[requested] ?? "@cf/openai/whisper";
}

// Convert ArrayBuffer to base64 without spilling >100KB strings on the stack.
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function handleTranscriptions(c: Context<{ Bindings: Env }>) {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: { message: "Body must be multipart/form-data", type: "invalid_request_error" } },
      400,
    );
  }

  const file = form.get("file") as unknown as Blob | null;
  if (!file || typeof (file as Blob).arrayBuffer !== "function") {
    return c.json({ error: { message: "`file` field is required", type: "invalid_request_error" } }, 400);
  }

  const requestedModel = (form.get("model") as string | null) ?? undefined;
  const responseFormat = (form.get("response_format") as string | null) ?? "json";
  const language = (form.get("language") as string | null) ?? undefined;
  const model = resolveWhisperModel(requestedModel);

  const buffer = await file.arrayBuffer();

  // The two Whisper variants on Workers AI take different inputs: the original
  // model wants a byte array, the large-v3-turbo wants base64.
  const aiInput: Record<string, unknown> = model.includes("whisper-large-v3")
    ? { audio: toBase64(buffer), task: "transcribe", ...(language ? { source_lang: language } : {}) }
    : { audio: [...new Uint8Array(buffer)] };

  let result: any;
  try {
    result = await c.env.AI.run(model as keyof AiModels, aiInput as never);
  } catch (err) {
    return c.json(
      { error: { message: (err as Error).message ?? "Workers AI call failed", type: "upstream_error" } },
      502,
    );
  }

  const text: string = result?.text ?? result?.transcription ?? "";

  if (responseFormat === "text") {
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (responseFormat === "vtt" && typeof result?.vtt === "string") {
    return new Response(result.vtt, { headers: { "Content-Type": "text/vtt; charset=utf-8" } });
  }
  if (responseFormat === "verbose_json") {
    return c.json({
      task: "transcribe",
      language: language ?? "unknown",
      duration: result?.duration ?? 0,
      text,
      words: result?.words ?? [],
    });
  }

  // Default: json
  return c.json({ text });
}
