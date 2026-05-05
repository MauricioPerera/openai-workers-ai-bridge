// Workers AI vision models accept only `data:` URIs for image inputs (not
// remote URLs). OpenAI clients can send either, so we transparently fetch
// any http/https URL the caller provides and inline it as base64.
//
// Failures are intentionally non-fatal: we leave the original URL in place
// and let the upstream return its own error so the caller sees the real
// reason (timeout, 404, oversized, …).

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard ceiling

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        // Many image hosts (Wikipedia, GitHub user-content, …) reject
        // requests without a User-Agent.
        "User-Agent": "openai-workers-ai-bridge/0.1 (+https://github.com/MauricioPerera/openai-workers-ai-bridge)",
        Accept: "image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0]?.trim() || "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    return `data:${contentType};base64,${bytesToBase64(new Uint8Array(buf))}`;
  } catch {
    return null;
  }
}

function extractUrl(part: any): string | null {
  if (!part) return null;
  // chat.completions: { type:"image_url", image_url:{url} | url }
  // Responses input: { type:"input_image", image_url:{url} | url } or top-level url
  const raw = part.image_url ?? part.url;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw.url === "string") return raw.url;
  return null;
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// Walk a chat.completions-style messages array and inline any remote image
// URLs as base64 data URIs in place. Returns the same array reference for
// convenience.
export async function inlineImageUrls(messages: any[]): Promise<any[]> {
  const jobs: Promise<void>[] = [];
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || part.type !== "image_url") continue;
      const url = extractUrl(part);
      if (!url || !isHttpUrl(url)) continue;
      jobs.push(
        fetchAsDataUri(url).then((dataUri) => {
          if (!dataUri) return;
          part.image_url = { url: dataUri };
        }),
      );
    }
  }
  if (jobs.length) await Promise.all(jobs);
  return messages;
}
