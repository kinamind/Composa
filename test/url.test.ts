import { describe, expect, it } from "vitest";
import { validatePublicHttpUrl } from "../src/security/ssrf";
import { extractPageMetadata } from "../src/url/extract";
import { fetchPage } from "../src/url/fetch";
import { discoverUrls, readWebPage } from "../src/url/reader";

describe("URL safety and extraction", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://service.internal/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
  ])("blocks %s", (url) => {
    expect(() => validatePublicHttpUrl(url)).toThrow();
  });

  it("accepts public HTTP URLs", () => {
    expect(validatePublicHttpUrl("https://example.com/a").hostname).toBe("example.com");
  });

  it("extracts metadata and strips executable content", () => {
    const metadata = extractPageMetadata(`
      <html><head><title>Fallback</title><meta property="og:title" content="A &amp; B">
      <meta name="description" content="Useful page"><meta property="og:image" content="/cover.jpg">
      <link rel="canonical" href="/canonical"></head>
      <body>Hello <img src="https://cdn.example/detail.png"><script>steal()</script> world</body></html>
    `, "https://example.com/path");
    expect(metadata).toMatchObject({
      title: "A & B",
      description: "Useful page",
      canonicalUrl: "https://example.com/canonical",
      source: "example.com",
      images: ["https://example.com/cover.jpg", "https://cdn.example/detail.png"],
    });
    expect(metadata.text).toContain("Hello world");
    expect(metadata.text).not.toContain("steal");
  });

  it("validates redirects and truncates oversized streams", async () => {
    const calls: string[] = [];
    const requestHeaders: Headers[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      requestHeaders.push(new Headers(init?.headers));
      if (url === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }
      return new Response("abcdefghij", { headers: { "content-type": "text/plain" } });
    };
    await expect(fetchPage("https://example.com/start", { timeoutMs: 1_000, maxTextBytes: 5 }, fetcher)).resolves.toEqual({
      url: "https://example.com/final",
      contentType: "text/plain",
      title: null,
      description: null,
      canonicalUrl: null,
      source: "example.com",
      text: "abcde",
      images: [],
      truncated: true,
    });
    expect(calls).toEqual(["https://example.com/start", "https://example.com/final"]);
    expect(requestHeaders[0]?.get("user-agent")).toContain("Mozilla/5.0");
    expect(requestHeaders[0]?.get("accept-language")).toContain("zh-CN");
  });

  it("does not let a large script and style preamble consume the visible-text budget", async () => {
    const preamble = `<script>${"ignored()".repeat(4_000)}</script><style>${"x".repeat(20_000)}</style>`;
    const article = "公开文章正文：这是需要交给 Agent 理解和整理的内容。";
    const fetcher: typeof fetch = async () => new Response(
      `<html><head><meta property="og:title" content="公众号文章"></head><body>${preamble}<article id="js_content">${article}</article></body></html>`,
      { headers: { "content-type": "text/html" } },
    );

    const reading = await readWebPage("https://mp.weixin.qq.com/s/public-article", {
      urlFetchTimeoutMs: 1_000,
      urlMaxTextBytes: 1_024,
    }, fetcher);

    expect(reading).toMatchObject({ title: "公众号文章", truncated: false });
    expect(reading.text).toContain(article);
    expect(reading.text).not.toContain("ignored()");
    expect(reading.text).not.toContain("xxxxx");
  });

  it("normalizes malformed UTF-8 before streaming HTML into HTMLRewriter", async () => {
    const bytes = concatBytes(
      new TextEncoder().encode("<html><head><title>可读文章</title></head><body><article>正文前"),
      new Uint8Array([0x80]),
      new TextEncoder().encode("正文后</article></body></html>"),
    );
    const fetcher: typeof fetch = async () => new Response(bytes, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const reading = await readWebPage("https://mp.weixin.qq.com/s/malformed-byte", {
      urlFetchTimeoutMs: 1_000,
      urlMaxTextBytes: 20_000,
    }, fetcher);

    expect(reading.title).toBe("可读文章");
    expect(reading.text).toContain("正文前");
    expect(reading.text).toContain("正文后");
  });

  it("decodes a declared legacy CJK charset before HTML extraction", async () => {
    const chinese = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const bytes = concatBytes(
      new TextEncoder().encode("<html><head><title>"),
      chinese,
      new TextEncoder().encode("</title></head><body><article>"),
      chinese,
      new TextEncoder().encode("</article></body></html>"),
    );
    const fetcher: typeof fetch = async () => new Response(bytes, {
      headers: { "content-type": "text/html; charset=gb2312" },
    });

    const reading = await readWebPage("https://example.com/legacy-cjk", {
      urlFetchTimeoutMs: 1_000,
      urlMaxTextBytes: 20_000,
    }, fetcher);

    expect(reading.title).toBe("中文");
    expect(reading.text).toContain("中文");
  });

  it("bounds actual visible text rather than raw markup", async () => {
    const visibleText = `正文${"内容".repeat(2_000)}`;
    const fetcher: typeof fetch = async () => new Response(visibleText, {
      headers: { "content-type": "text/plain" },
    });

    const reading = await readWebPage("https://example.com/long-note", {
      urlFetchTimeoutMs: 1_000,
      urlMaxTextBytes: 256,
    }, fetcher);

    expect(reading.truncated).toBe(true);
    expect(new TextEncoder().encode(reading.text).byteLength).toBeLessThanOrEqual(256);
    expect(reading.text).toContain("正文");
  });

  it("blocks redirects to private destinations", async () => {
    const fetcher: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
    await expect(fetchPage("https://example.com", { timeoutMs: 1_000, maxTextBytes: 1_000 }, fetcher)).rejects.toThrow("Private");
  });

  it("discovers card links and returns a bounded readable webpage", async () => {
    expect(discoverUrls("分享卡片 https://example.com/post?id=1 ，备用 https://example.org/")).toEqual([
      "https://example.com/post?id=1",
      "https://example.org/",
    ]);
    const fetcher: typeof fetch = async () => new Response(
      `<html><head><title>招聘信息</title><meta property="og:title" content="">
      <meta name="description" content="岗位说明"><meta property="og:image" content="/cover.jpg">
      <meta name="twitter:image" content="/social.jpg"><link rel="canonical" href="/canonical"></head>
      <body><main><p>招募研究助理。</p><p>周五截止，原文写作 &amp;amp; FAQ。</p>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/detail.png"></main></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
    const reading = await readWebPage("https://example.com/post", { urlFetchTimeoutMs: 1_000, urlMaxTextBytes: 20_000 }, fetcher);
    expect(reading).toMatchObject({
      title: "招聘信息",
      description: "岗位说明",
      canonicalUrl: "https://example.com/canonical",
      images: [
        "https://example.com/cover.jpg",
        "https://example.com/social.jpg",
        "https://example.com/detail.png",
      ],
      source: "example.com",
      truncated: false,
    });
    expect(reading.text).toContain("招募研究助理。 周五截止");
    expect(reading.text).toContain("&amp; FAQ");
    expect(reading.text).not.toContain("原文写作 & FAQ");
  });
});

function concatBytes(...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
