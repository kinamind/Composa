import type {
  XiaohongshuAuthor,
  XiaohongshuMedia,
  XiaohongshuReadResult,
} from "./types";

const INITIAL_STATE_PATTERN = /window\.__INITIAL_STATE__\s*=\s*/;

export function parseXiaohongshuPage(
  html: string,
  sourceUrl: string,
  accountConfigured: boolean,
): XiaohongshuReadResult {
  const noteId = noteIdFromUrl(sourceUrl);
  const canonicalUrl = noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : null;
  const state = asRecord(extractInitialState(html));
  const authenticated = readBoolean(asRecord(state.user), "loggedIn") ?? false;
  const noteState = asRecord(state.note);
  const noteMap = asRecord(noteState.noteDetailMap);
  const detail = noteId ? asRecord(noteMap[noteId]) : firstRecordValue(noteMap);
  const note = asRecord(detail.note);
  const parsedNoteId = readString(note, "noteId") ?? noteId;
  if (!parsedNoteId || Object.keys(note).length === 0) {
    const status = !accountConfigured
      ? "login_required"
      : authenticated
        ? "unavailable"
        : "session_expired";
    return {
      status,
      accountConfigured,
      authenticated,
      noteId,
      canonicalUrl,
      reasonCode: status,
      reason: failureReason(status),
    };
  }

  const parsedCanonicalUrl = `https://www.xiaohongshu.com/explore/${parsedNoteId}`;
  const title = readString(note, "title");
  const description = readString(note, "desc") ?? "";
  return {
    status: "read",
    accountConfigured,
    authenticated,
    noteId: parsedNoteId,
    canonicalUrl: parsedCanonicalUrl,
    title,
    description,
    author: parseAuthor(note.user),
    tags: parseTags(note.tagList),
    publishedAt: parseTimestamp(note.time),
    media: parseMedia(note),
    mediaTextStatus: "not_extracted",
  };
}

export function extractInitialState(html: string): unknown {
  const marker = INITIAL_STATE_PATTERN.exec(html);
  if (!marker) throw new XiaohongshuParseError("Initial state was not found");
  const objectStart = skipWhitespace(html, marker.index + marker[0].length);
  if (html[objectStart] !== "{") throw new XiaohongshuParseError("Initial state was not an object");
  const objectText = readBalancedObject(html, objectStart);
  try {
    return parseJsonishValue(objectText);
  } catch {
    const user = extractTopLevelObject(objectText, "user");
    const note = extractTopLevelObject(objectText, "note");
    if (user || note) return { user: user ?? {}, note: note ?? {} };
    throw new XiaohongshuParseError("Initial state could not be parsed");
  }
}

function readBalancedObject(source: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new XiaohongshuParseError("Initial state object was incomplete");
}

function replaceBareJavaScriptValues(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index] ?? "";
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      index += 1;
      continue;
    }
    let replaced = false;
    for (const token of ["undefined", "-Infinity", "Infinity", "NaN"]) {
      if (source.startsWith(token, index)
        && isTokenBoundary(source[index - 1])
        && isTokenBoundary(source[index + token.length])) {
        result += "null";
        index += token.length;
        replaced = true;
        break;
      }
    }
    if (replaced) continue;
    result += character;
    index += 1;
  }
  return result;
}

function parseJsonishValue(source: string): unknown {
  return JSON.parse(replaceBareJavaScriptValues(source)) as unknown;
}

function extractTopLevelObject(source: string, wantedKey: string): Record<string, unknown> | null {
  let objectDepth = 0;
  let arrayDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      const end = readJsonStringEnd(source, index);
      if (objectDepth === 1 && arrayDepth === 0) {
        let key: unknown;
        try {
          key = JSON.parse(source.slice(index, end + 1)) as unknown;
        } catch {
          index = end;
          continue;
        }
        let cursor = skipWhitespace(source, end + 1);
        if (key === wantedKey && source[cursor] === ":") {
          cursor = skipWhitespace(source, cursor + 1);
          if (source[cursor] !== "{") return null;
          try {
            return asRecord(parseJsonishValue(readBalancedObject(source, cursor)));
          } catch {
            return null;
          }
        }
      }
      index = end;
      continue;
    }
    if (character === "{") objectDepth += 1;
    else if (character === "}") objectDepth -= 1;
    else if (character === "[") arrayDepth += 1;
    else if (character === "]") arrayDepth -= 1;
  }
  return null;
}

function readJsonStringEnd(source: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index;
  }
  throw new XiaohongshuParseError("Initial state contained an incomplete string");
}

function isTokenBoundary(value: string | undefined): boolean {
  return value === undefined || !/[A-Za-z0-9_$]/.test(value);
}

function noteIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const pathMatch = url.pathname.match(/\/(?:discovery\/item|explore)\/([0-9a-z]+)/i)?.[1];
    return pathMatch ?? url.searchParams.get("target_note_id");
  } catch {
    return null;
  }
}

function parseAuthor(value: unknown): XiaohongshuAuthor | null {
  const nickname = readString(asRecord(value), "nickname");
  return nickname ? { nickname } : null;
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((entry) => readString(asRecord(entry), "name"))
    .filter((entry): entry is string => Boolean(entry))));
}

function parseMedia(note: Record<string, unknown>): XiaohongshuMedia[] {
  const images = Array.isArray(note.imageList) ? note.imageList : [];
  const result: XiaohongshuMedia[] = [];
  for (const entry of images) {
    const image = asRecord(entry);
    const url = readString(image, "urlDefault") ?? readString(image, "urlPre") ?? readString(image, "url");
    if (!url) continue;
    const width = readPositiveNumber(image, "width");
    const height = readPositiveNumber(image, "height");
    result.push({
      type: "image",
      url,
      ...(width !== null ? { width } : {}),
      ...(height !== null ? { height } : {}),
    });
  }
  const videoUrl = firstVideoUrl(note.video);
  if (videoUrl) result.push({ type: "video", url: videoUrl });
  return result;
}

function firstVideoUrl(value: unknown): string | null {
  const stream = asRecord(asRecord(asRecord(value).media).stream);
  for (const codec of ["h264", "h265", "av1"]) {
    const variants = stream[codec];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const video = asRecord(variant);
      const url = readString(video, "masterUrl") ?? readString(video, "url");
      if (url) return url;
    }
  }
  return null;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstRecordValue(value: Record<string, unknown>): Record<string, unknown> {
  const first = Object.values(value).find((entry) => isRecord(entry));
  return asRecord(first);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function readPositiveNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function failureReason(status: "login_required" | "session_expired" | "unavailable"): string {
  if (status === "login_required") return "This post requires a configured Xiaohongshu account session.";
  if (status === "session_expired") return "The configured Xiaohongshu account session is missing or expired.";
  return "Xiaohongshu did not make this post available to the configured account session.";
}

export class XiaohongshuParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "XiaohongshuParseError";
  }
}
