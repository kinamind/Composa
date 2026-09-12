export interface XiaohongshuAuthor {
  nickname: string;
}

export interface XiaohongshuMedia {
  type: "image" | "video";
  url: string;
  width?: number;
  height?: number;
}

interface XiaohongshuReadBase {
  accountConfigured: boolean;
  authenticated: boolean;
  noteId: string | null;
  canonicalUrl: string | null;
}

export interface XiaohongshuPost extends XiaohongshuReadBase {
  status: "read";
  noteId: string;
  canonicalUrl: string;
  title: string | null;
  description: string;
  author: XiaohongshuAuthor | null;
  tags: string[];
  publishedAt: string | null;
  media: XiaohongshuMedia[];
  mediaTextStatus: "not_extracted" | "extracted" | "partially_extracted" | "analysis_failed";
  mediaText?: string;
  analyzedImageCount?: number;
  skippedImageCount?: number;
  mediaAnalysisError?: string;
}

export interface XiaohongshuReadFailure extends XiaohongshuReadBase {
  status: "login_required" | "session_expired" | "unavailable";
  reasonCode: "login_required" | "session_expired" | "unavailable" | "page_too_large";
  reason: string;
}

export type XiaohongshuReadResult = XiaohongshuPost | XiaohongshuReadFailure;

export interface FetchedXiaohongshuPage {
  url: string;
  body: string;
  truncated: boolean;
}
