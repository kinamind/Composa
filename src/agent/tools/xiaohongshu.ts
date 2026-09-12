import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { getConfig } from "../../config";
import { getOwnedItem } from "../../db/items";
import { getMessageTextBySource } from "../../db/messages";
import { log } from "../../observability/log";
import { discoverUrls } from "../../url/reader";
import { isXiaohongshuUrl, XiaohongshuFetchError } from "../../xiaohongshu/fetch";
import { XiaohongshuParseError } from "../../xiaohongshu/parser";
import { readXiaohongshuPost } from "../../xiaohongshu/reader";
import type { XiaohongshuImageAnalysis, XiaohongshuVisionOptions } from "../../xiaohongshu/vision";
import { analyzeXiaohongshuImages } from "../../xiaohongshu/vision";
import type { XiaohongshuMedia, XiaohongshuReadResult } from "../../xiaohongshu/types";
import type { AgentPrincipal } from "../context";
import { summarizeXiaohongshuOutput } from "../effects";

type PrincipalProvider = () => AgentPrincipal;
export type XiaohongshuMediaAnalyzer = (
  media: XiaohongshuMedia[],
  options?: Pick<XiaohongshuVisionOptions, "abortSignal">,
) => Promise<XiaohongshuImageAnalysis>;

export interface XiaohongshuReadInput {
  itemId?: string | undefined;
  urls?: string[] | undefined;
}

export async function readOwnedXiaohongshuPosts(
  env: Env,
  principal: AgentPrincipal,
  input: XiaohongshuReadInput,
  fetcher: typeof fetch = fetch,
  mediaAnalyzer?: XiaohongshuMediaAnalyzer,
) {
  let sourceText = (input.urls ?? []).join("\n");
  if (input.itemId) {
    const item = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
    if (!item) throw new Error("Item not found in the current user's memory");
    const originalMessage = await getMessageTextBySource(env.DB, item.sourceChannel, item.sourceMessageId);
    sourceText = [sourceText, item.url ?? "", item.content, item.rawMessage, originalMessage ?? ""].join("\n");
  }

  const requestedUrls = discoverUrls(sourceText).filter(isXiaohongshuUrl);
  const urls = preferReusableXiaohongshuUrls(requestedUrls);
  if (urls.length === 0) throw new Error("No Xiaohongshu share URL was found");

  const config = getConfig(env);
  const posts: Array<{ requestedUrl: string; result: Awaited<ReturnType<typeof readXiaohongshuPost>> }> = [];
  const failures: Array<{ requestedUrl: string; errorCode: string; error: string }> = [];
  for (const requestedUrl of urls) {
    try {
      const result = await readXiaohongshuPost(requestedUrl, config, env.XHS_COOKIE ?? "", fetcher);
      posts.push({ requestedUrl, result: await addMediaAnalysis(result, mediaAnalyzer) });
    } catch (error) {
      const errorCode = classifyXiaohongshuError(error);
      failures.push({
        requestedUrl,
        errorCode,
        error: xiaohongshuErrorMessage(errorCode),
      });
    }
  }
  const output = {
    itemId: input.itemId ?? null,
    requestedUrls: urls,
    posts,
    failures,
  };
  log("info", "xiaohongshu_source_read_finished", summarizeXiaohongshuOutput(output));
  return output;
}

export function createXiaohongshuTools(
  env: Env,
  principal: PrincipalProvider,
  fetcher: typeof fetch = fetch,
  mediaAnalyzer: XiaohongshuMediaAnalyzer = (media, options) => analyzeXiaohongshuImages(env, media, options),
): ToolSet {
  return {
    xiaohongshu_read: tool({
      description: "Read explicitly shared Xiaohongshu posts with the configured account session, then use the configured multimodal model to extract visible text and facts from every trusted post image. Supply direct share URLs or an owned itemId whose saved URL/content contains them. Use this instead of ordinary web_read for Xiaohongshu. A matching existing item only prevents duplicate creation: call this again whenever that item is raw, partial, or its previous read failed. It returns separate page-text and mediaText statuses, degrades without losing successful text, and never exposes credentials.",
      inputSchema: z.object({
        itemId: z.string().uuid().optional(),
        urls: z.array(z.string().url()).optional(),
      }).refine((value) => Boolean(value.itemId || value.urls?.length), "Provide itemId or urls"),
      execute: (input, options) => readOwnedXiaohongshuPosts(
        env,
        principal(),
        input,
        fetcher,
        (media) => mediaAnalyzer(media, { abortSignal: options.abortSignal }),
      ),
    }),
  };
}

async function addMediaAnalysis(
  result: XiaohongshuReadResult,
  mediaAnalyzer?: XiaohongshuMediaAnalyzer,
): Promise<XiaohongshuReadResult> {
  const imageCount = result.status === "read"
    ? result.media.filter((entry) => entry.type === "image").length
    : 0;
  if (result.status !== "read" || imageCount === 0 || !mediaAnalyzer) return result;
  try {
    const analysis = await mediaAnalyzer(result.media);
    return {
      ...result,
      mediaTextStatus: analysis.skippedImageCount > 0 ? "partially_extracted" : "extracted",
      mediaText: analysis.text,
      analyzedImageCount: analysis.analyzedImageCount,
      skippedImageCount: analysis.skippedImageCount,
    };
  } catch {
    return {
      ...result,
      mediaTextStatus: "analysis_failed",
      analyzedImageCount: 0,
      skippedImageCount: imageCount,
      mediaAnalysisError: "The configured AI model could not analyze this post's images.",
    };
  }
}

function classifyXiaohongshuError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|abort/i.test(message)) return "fetch_timeout";
  if (error instanceof XiaohongshuParseError) return "page_structure_changed";
  if (error instanceof XiaohongshuFetchError) {
    if (/size limit/i.test(error.message)) return "page_too_large";
    if (/HTTP 429/i.test(error.message)) return "upstream_rate_limited";
    if (/HTTP 5\d\d/i.test(error.message)) return "upstream_unavailable";
    if (/content type/i.test(error.message)) return "unexpected_content";
    if (/redirect/i.test(error.message)) return "redirect_failed";
    if (/session cookie/i.test(error.message)) return "invalid_session";
    return "fetch_failed";
  }
  if (error instanceof DOMException && error.name === "AbortError") return "fetch_timeout";
  return "unexpected_failure";
}

function xiaohongshuErrorMessage(errorCode: string): string {
  if (errorCode === "page_structure_changed") return "Xiaohongshu returned a page format that could not be parsed.";
  if (errorCode === "page_too_large") return "The Xiaohongshu page exceeded the configured transport budget.";
  if (errorCode === "fetch_timeout") return "Xiaohongshu did not finish responding before the fetch timeout.";
  if (errorCode === "upstream_rate_limited") return "Xiaohongshu temporarily rate-limited the read request.";
  if (errorCode === "upstream_unavailable") return "Xiaohongshu was temporarily unavailable.";
  if (errorCode === "unexpected_content") return "Xiaohongshu returned an unexpected response instead of a post page.";
  if (errorCode === "redirect_failed") return "The Xiaohongshu share link could not be resolved safely.";
  if (errorCode === "invalid_session") return "The configured Xiaohongshu session is invalid.";
  return "The Xiaohongshu post could not be fetched.";
}

function preferReusableXiaohongshuUrls(urls: string[]): string[] {
  const selected = new Map<string, string>();
  for (const rawUrl of urls) {
    const identity = xiaohongshuUrlIdentity(rawUrl);
    const current = selected.get(identity);
    if (!current || reusableUrlScore(rawUrl) > reusableUrlScore(current)) selected.set(identity, rawUrl);
  }
  return Array.from(selected.values());
}

function xiaohongshuUrlIdentity(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const noteId = url.pathname.match(/\/(?:discovery\/item|explore)\/([0-9a-z]+)/i)?.[1]
      ?? url.searchParams.get("target_note_id");
    return noteId ? `note:${noteId.toLowerCase()}` : `url:${url.toString()}`;
  } catch {
    return `url:${rawUrl}`;
  }
}

function reusableUrlScore(rawUrl: string): number {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has("xsec_token")) return 2;
    if (url.hostname.toLowerCase().endsWith("xhslink.com")) return 1;
  } catch {
    return 0;
  }
  return 0;
}
