import type { RuntimeConfig } from "../config";
import { fetchXiaohongshuPage } from "./fetch";
import { parseXiaohongshuPage } from "./parser";
import type { XiaohongshuReadResult } from "./types";

export async function readXiaohongshuPost(
  rawUrl: string,
  config: Pick<RuntimeConfig, "urlFetchTimeoutMs" | "xhsMaxBytes">,
  cookie: string,
  fetcher: typeof fetch = fetch,
): Promise<XiaohongshuReadResult> {
  const accountConfigured = Boolean(cookie.trim());
  const page = await fetchXiaohongshuPage(rawUrl, {
    cookie,
    timeoutMs: config.urlFetchTimeoutMs,
    maxBytes: config.xhsMaxBytes,
  }, fetcher);
  if (page.truncated) {
    return {
      status: "unavailable",
      accountConfigured,
      authenticated: false,
      noteId: null,
      canonicalUrl: null,
      reasonCode: "page_too_large",
      reason: "The Xiaohongshu page exceeded the configured size limit before its post data could be read.",
    };
  }
  return parseXiaohongshuPage(page.body, page.url, accountConfigured);
}
