export interface VerifiedTurnEffect {
  toolName: string;
  success: boolean;
  outcome: Record<string, unknown>;
}

export interface ToolEffectInput {
  toolName: string;
  success: boolean;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

const WRITE_TOOLS = new Set([
  "item_create",
  "item_update",
  "item_transition",
  "reminder_manage",
  "work_session_manage",
  "calendar_replan",
  "lifecycle_followup_manage",
  "profile_update",
  "context_remember",
  "context_forget",
]);

export function summarizeToolEffect(effect: ToolEffectInput): VerifiedTurnEffect {
  if (!effect.success) {
    return {
      toolName: effect.toolName,
      success: false,
      outcome: { errorType: errorType(effect.error) },
    };
  }

  if (effect.toolName === "activate_skill") {
    const input = asRecord(effect.input);
    return {
      toolName: effect.toolName,
      success: true,
      outcome: {
        activated: true,
        ...(readString(input, "name") ? { skill: readString(input, "name") } : {}),
      },
    };
  }
  if (effect.toolName === "xiaohongshu_read") {
    return {
      toolName: effect.toolName,
      success: true,
      outcome: summarizeXiaohongshuOutput(effect.output),
    };
  }
  if (WRITE_TOOLS.has(effect.toolName)) {
    return {
      toolName: effect.toolName,
      success: true,
      outcome: summarizeWriteOutput(effect.toolName, effect.output),
    };
  }
  return {
    toolName: effect.toolName,
    success: true,
    outcome: { completed: true },
  };
}

export function summarizeXiaohongshuOutput(output: unknown): Record<string, unknown> {
  const root = asRecord(output);
  const posts = Array.isArray(root.posts) ? root.posts : [];
  const failures = Array.isArray(root.failures) ? root.failures : [];
  const statuses: Record<string, number> = {};
  const reasonCodes: Record<string, number> = {};
  const mediaTextStatuses: Record<string, number> = {};
  let imageCount = 0;
  let analyzedImageCount = 0;
  let skippedImageCount = 0;
  let accountConfigured = false;
  let authenticated = false;

  for (const entry of posts) {
    const result = asRecord(asRecord(entry).result);
    const status = readString(result, "status") ?? "unknown";
    statuses[status] = (statuses[status] ?? 0) + 1;
    const reasonCode = readString(result, "reasonCode");
    if (reasonCode) reasonCodes[reasonCode] = (reasonCodes[reasonCode] ?? 0) + 1;
    accountConfigured ||= result.accountConfigured === true;
    authenticated ||= result.authenticated === true;
    if (status !== "read") continue;
    const media = Array.isArray(result.media) ? result.media : [];
    imageCount += media.filter((item) => asRecord(item).type === "image").length;
    const mediaStatus = readString(result, "mediaTextStatus") ?? "not_extracted";
    mediaTextStatuses[mediaStatus] = (mediaTextStatuses[mediaStatus] ?? 0) + 1;
    analyzedImageCount += readNumber(result, "analyzedImageCount") ?? 0;
    skippedImageCount += readNumber(result, "skippedImageCount") ?? 0;
  }

  const attemptedCount = readArray(root, "requestedUrls").length;
  return {
    attemptedCount,
    returnedCount: posts.length,
    readCount: statuses.read ?? 0,
    fetchFailureCount: failures.length,
    statuses,
    reasonCodes,
    mediaTextStatuses,
    imageCount,
    analyzedImageCount,
    skippedImageCount,
    accountConfigured,
    authenticated,
  };
}

export function hasToolAttempt(effects: VerifiedTurnEffect[], toolName: string): boolean {
  return effects.some((effect) => effect.toolName === toolName);
}

export function nextXiaohongshuSourceTool(
  effects: VerifiedTurnEffect[],
): "activate_skill" | "xiaohongshu_read" | null {
  if (!hasToolAttempt(effects, "activate_skill")) return "activate_skill";
  if (!hasToolAttempt(effects, "xiaohongshu_read")) return "xiaohongshu_read";
  return null;
}

export function hasCommittedWrite(effects: VerifiedTurnEffect[]): boolean {
  return effects.some((effect) => effect.success && effect.outcome.committed === true);
}

export function buildXiaohongshuEffectFallback(effects: VerifiedTurnEffect[]): string {
  const read = [...effects].reverse().find((effect) => effect.toolName === "xiaohongshu_read");
  const wrote = effects.some((effect) => (
    (effect.toolName === "item_create" || effect.toolName === "item_update")
    && effect.success
    && effect.outcome.committed === true
  ));
  if (!read || !read.success) {
    return wrote
      ? "这篇小红书没有完成读取，但原始分享已经保存为待整理记录。"
      : "这次没有完成小红书读取，也没有写入记录。请稍后重试。";
  }

  const readCount = readNumber(read.outcome, "readCount") ?? 0;
  const statuses = asRecord(read.outcome.statuses);
  const reasonCodes = asRecord(read.outcome.reasonCodes);
  if (readCount > 0) {
    const imageCount = readNumber(read.outcome, "imageCount") ?? 0;
    const analyzedImageCount = readNumber(read.outcome, "analyzedImageCount") ?? 0;
    const page = imageCount > 0 && analyzedImageCount < imageCount
      ? "正文已读取，但配图没有全部解析"
      : "正文和可用配图已经读取";
    return wrote ? `${page}，记录也已写入。` : `${page}，但这次没有把结果写入记录。`;
  }
  if ((readNumber(statuses, "session_expired") ?? 0) > 0) {
    return wrote
      ? "已配置的小红书登录态失效；原始分享已保存为待整理记录，正文和配图还没有补全。"
      : "已配置的小红书登录态失效，这次没有读取正文，也没有写入记录。更新登录信息后可以直接重试原消息。";
  }
  if ((readNumber(statuses, "login_required") ?? 0) > 0) {
    return wrote
      ? "小红书账号尚未配置；原始分享已保存为待整理记录。"
      : "小红书账号尚未配置，这次没有读取正文，也没有写入记录。";
  }
  if ((readNumber(reasonCodes, "page_too_large") ?? 0) > 0) {
    return wrote
      ? "这篇小红书的页面状态没有完整读取；原始分享已保存为待整理记录。"
      : "这篇小红书的页面状态没有完整读取，这次也没有写入记录。";
  }
  return wrote
    ? "这篇小红书暂时没有读到可用正文；原始分享已保存为待整理记录。"
    : "这篇小红书暂时没有读到可用正文，这次也没有写入记录。";
}

function summarizeWriteOutput(toolName: string, output: unknown): Record<string, unknown> {
  const result = asRecord(output);
  const outcome: Record<string, unknown> = {};
  for (const key of [
    "created",
    "updated",
    "changed",
    "scheduled",
    "canceled",
    "retryable",
  ]) {
    if (typeof result[key] === "boolean") outcome[key] = result[key];
    else if (typeof result[key] === "number" && key === "canceled") outcome[key] = result[key];
  }
  for (const key of ["status", "reasonCode", "remindAt", "reviewAt"]) {
    const value = readString(result, key);
    if (value) outcome[key] = value;
  }
  outcome.committed = committedWrite(toolName, result);
  return outcome;
}

function committedWrite(toolName: string, output: Record<string, unknown>): boolean {
  if (toolName === "item_create") return output.created === true;
  if (toolName === "item_update") return output.updated === true;
  if (toolName === "item_transition") return output.changed === true;
  if (toolName === "reminder_manage") return output.scheduled === true || output.canceled === true;
  if (toolName === "work_session_manage") return output.scheduled === true || (readNumber(output, "canceled") ?? 0) > 0;
  if (toolName === "calendar_replan") return output.scheduled === true;
  if (toolName === "lifecycle_followup_manage") return output.scheduled === true || (readNumber(output, "canceled") ?? 0) > 0;
  if (toolName === "profile_update") return output.updated === true;
  if (toolName === "context_remember") {
    return readArray(output, "factIds").length > 0
      || Object.keys(asRecord(output.entities)).length > 0
      || (readNumber(output, "linkedItems") ?? 0) > 0;
  }
  if (toolName === "context_forget") {
    return (readNumber(output, "retractedFacts") ?? 0) > 0
      || (readNumber(output, "deletedEntities") ?? 0) > 0;
  }
  return false;
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return error === null ? "null" : typeof error;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}
