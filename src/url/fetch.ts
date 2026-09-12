import { validatePublicHttpUrl } from "../security/ssrf";
import { extractPageMetadataFromResponse, type PageMetadata } from "./extract";

export interface FetchedPage extends PageMetadata {
  url: string;
  contentType: string;
  truncated: boolean;
}

export interface UrlFetchOptions {
  timeoutMs: number;
  maxTextBytes: number;
  maxRedirects?: number;
}

export async function fetchPage(
  rawUrl: string,
  options: UrlFetchOptions,
  fetcher: typeof fetch = fetch,
): Promise<FetchedPage> {
  let current = validatePublicHttpUrl(rawUrl);
  const maxRedirects = options.maxRedirects ?? 3;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("URL fetch timed out"), options.timeoutMs);
    try {
      const response = await fetcher(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
        },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new UrlFetchError("Redirect response had no Location header");
        if (redirect === maxRedirects) throw new UrlFetchError("Too many redirects");
        current = validatePublicHttpUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new UrlFetchError(`Upstream returned HTTP ${response.status}`);

      const contentTypeHeader = response.headers.get("content-type");
      const contentType = contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "text/html" && contentType !== "text/plain" && contentType !== "application/xhtml+xml") {
        throw new UrlFetchError(`Unsupported content type: ${contentType || "unknown"}`);
      }
      if (contentType === "text/plain") {
        const { text, truncated } = await readLimitedText(
          normalizeTextStream(response.body, contentTypeHeader),
          options.maxTextBytes,
        );
        return {
          url: current.toString(),
          contentType,
          title: null,
          description: null,
          canonicalUrl: null,
          source: current.hostname,
          text,
          images: [],
          truncated,
        };
      }
      const extracted = await extractPageMetadataFromResponse(
        normalizeHtmlResponse(response, contentTypeHeader),
        current.toString(),
        options.maxTextBytes,
      );
      return { url: current.toString(), contentType, ...extracted };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new UrlFetchError("URL fetch did not produce a response");
}

function normalizeHtmlResponse(response: Response, contentType: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(normalizeTextStream(response.body, contentType), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeTextStream(
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const decoder = createPageDecoder(contentType);
  const encoder = new TextEncoder();
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const decoded = decoder.decode(chunk, { stream: true });
      if (decoded) controller.enqueue(encoder.encode(decoded));
    },
    flush(controller) {
      const decoded = decoder.decode();
      if (decoded) controller.enqueue(encoder.encode(decoded));
    },
  }));
}

function createPageDecoder(contentType: string | null): TextDecoder {
  const declared = contentType?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared, { fatal: false });
    } catch {
      // Unknown labels are treated as UTF-8; malformed bytes are replaced below.
    }
  }
  return new TextDecoder("utf-8", { fatal: false });
}

async function readLimitedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.slice(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel("Desk-IX size limit reached");
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder().decode(combined);
  return { text: truncated ? decoded.replace(/\uFFFD$/, "") : decoded, truncated };
}

export class UrlFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UrlFetchError";
  }
}
