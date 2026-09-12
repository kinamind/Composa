import type { Schedule } from "agents";
import { z } from "zod";
import type { Item, WorkSession } from "../core/types";

export const LIFECYCLE_FOLLOWUP_CALLBACK = "reviewScheduledItem";
export const LIFECYCLE_REVIEW_EVENT_PREFIX = "lifecycle-review";

export const lifecycleFollowupKinds = ["boundary", "progress"] as const;
export const lifecycleFollowupLanes = ["event_end", "deadline", "work_plan_end", "progress"] as const;
export type LifecycleFollowupKind = typeof lifecycleFollowupKinds[number];
export type LifecycleFollowupLane = typeof lifecycleFollowupLanes[number];

export const lifecycleFollowupPayloadSchema = z.object({
  itemId: z.string().uuid(),
  channel: z.enum(["telegram", "qq"]),
  userId: z.string().min(1).max(256),
  reviewAt: z.string().datetime(),
  reason: z.string().trim().min(1).max(1_000),
  kind: z.enum(lifecycleFollowupKinds).optional(),
  lane: z.enum(lifecycleFollowupLanes).optional(),
});

export type LifecycleFollowupPayload = z.infer<typeof lifecycleFollowupPayloadSchema>;

export interface DerivedLifecycleReview {
  basis: Exclude<LifecycleFollowupLane, "progress">;
  payload: LifecycleFollowupPayload;
}

export interface LifecycleFollowupController {
  set(payload: LifecycleFollowupPayload): Promise<{
    scheduled: true;
    scheduleId: string;
    reviewAt: string;
  }>;
  cancel(itemId: string, kind?: LifecycleFollowupKind, lane?: LifecycleFollowupLane): Promise<{ canceled: number }>;
}

export function isLifecycleFollowupSchedule(
  schedule: Schedule<unknown>,
  itemId: string,
  kind?: LifecycleFollowupKind,
  lane?: LifecycleFollowupLane,
): boolean {
  if (schedule.callback !== LIFECYCLE_FOLLOWUP_CALLBACK) return false;
  const payload = lifecycleFollowupPayloadSchema.safeParse(schedule.payload);
  if (!payload.success || payload.data.itemId !== itemId) return false;
  const resolvedKind = payload.data.kind ?? "boundary";
  if (kind && resolvedKind !== kind) return false;
  if (!lane) return true;
  const resolvedLane = payload.data.lane
    ?? (payload.data.kind === "progress" ? "progress" : null);
  return resolvedLane === lane;
}

export function lifecycleReviewEventId(payload: LifecycleFollowupPayload): string {
  return `${LIFECYCLE_REVIEW_EVENT_PREFIX}:${payload.itemId}:${payload.lane ?? payload.kind ?? "legacy"}:${Date.parse(payload.reviewAt)}`;
}

export function deriveItemLifecycleReview(item: Item): DerivedLifecycleReview | null {
  if (item.status === "completed" || item.status === "archived") return null;
  if (!item.dueAt) return null;
  const dueAt = Date.parse(item.dueAt);
  if (!Number.isFinite(dueAt)) return null;
  if (item.temporalRole === "event" && !item.estimatedDuration) return null;
  const basis = item.temporalRole === "event" ? "event_end" : "deadline";
  const reviewAt = new Date(
    basis === "event_end" ? dueAt + item.estimatedDuration! * 60_000 : dueAt,
  );
  if (Number.isNaN(reviewAt.getTime())) return null;
  return {
    basis,
    payload: {
      itemId: item.id,
      channel: item.sourceChannel,
      userId: item.sourceUserId,
      reviewAt: reviewAt.toISOString(),
      reason: basis === "event_end"
        ? `事项保存的固定时段已到预计结束点（开始 ${item.dueAt}，持续 ${item.estimatedDuration} 分钟）；请结合当前上下文判断其生命周期，而不是预设结果。`
        : `事项保存的明确截止边界已到（${item.dueAt}）；请结合当前上下文核对结果与后续安排，不要把截止已到等同于已经完成。`,
      kind: "boundary",
      lane: basis,
    },
  };
}

export function deriveWorkSessionLifecycleReview(
  item: Item,
  sessions: Array<Pick<WorkSession, "endAt" | "status">>,
): DerivedLifecycleReview | null {
  if (item.status === "completed" || item.status === "archived") return null;
  const latestEnd = sessions
    .filter((session) => session.status === "planned")
    .map((session) => Date.parse(session.endAt))
    .filter(Number.isFinite)
    .reduce<number | null>((latest, endAt) => latest === null || endAt > latest ? endAt : latest, null);
  if (latestEnd === null) return null;
  const reviewAt = new Date(latestEnd).toISOString();
  return {
    basis: "work_plan_end",
    payload: {
      itemId: item.id,
      channel: item.sourceChannel,
      userId: item.sourceUserId,
      reviewAt,
      reason: `为该事项保存的工作计划已到最后一个时段的结束点（${reviewAt}）；请结合实际进展判断完成、继续安排或轻量确认，不预设结果。`,
      kind: "boundary",
      lane: "work_plan_end",
    },
  };
}

export function buildLifecycleReviewMessage(
  item: Item,
  payload: LifecycleFollowupPayload,
  now = new Date(),
): string {
  const isBoundaryReview = (payload.kind ?? "boundary") === "boundary";
  const boundaryGuidance = payload.lane === "deadline"
    ? "系统已经可靠确认的是明确截止边界已到，不是提交、交付或完成结果。先激活 calendar-review 技能并用 item_get；需要时间上下文时，用 calendar_snapshot。结合最新对话、已有执行和后续影响判断完成、舍弃、继续推进、调整计划或只问一个轻量问题。"
    : "先激活 calendar-review 技能并用 item_get；需要时间上下文时，用 calendar_snapshot 查看覆盖该事项的明确范围。系统已经可靠确认的是安排的时间边界已到，不是事项结果。分别判断发生确定性与结果确定性，不得按“会议”“任务”等名称套固定规则。";
  const compactItem = {
    id: item.id,
    type: item.type,
    title: item.title,
    content: item.content,
    status: item.status,
    priority: item.priority,
    estimatedDuration: item.estimatedDuration,
    dueAt: item.dueAt,
    startAfter: item.startAfter,
    originalTimeExpression: item.originalTimeExpression,
    temporalRole: item.temporalRole,
    updatedAt: item.updatedAt,
  };
  return [
    `[Desk-IX 内部事件：系统触发的${isBoundaryReview ? "边界复盘" : "进度同步"}]`,
    "这不是用户声称事项已完成，也不是新的用户指令。请对下面这一项做一次独立、上下文相关的判断。",
    `触发时间：${now.toISOString()}`,
    `当初安排复盘的理由：${payload.reason}`,
    `目标事项：${JSON.stringify(compactItem)}`,
    isBoundaryReview
      ? boundaryGuidance
      : "先激活 calendar-review 技能并用 item_get；需要时间上下文时，用 calendar_snapshot 查看相关范围。这是 Agent 此前根据事项状态选择的进度检查点，不表示任何时间段已经发生，也不表示进度停滞。结合截止、已有投入、后续空档和最新上下文判断此刻是否需要推进、调整或询问。",
    isBoundaryReview
      ? "如果现有证据让你高度确信原事件已自然发生或结束，且原事项本身表示的就是这次发生而非某个尚未确认的产出，可以标记完成并用一句自然的话告知，允许用户纠正；不要展开复盘报告。"
      : "如果现有证据足以判断进展，直接维护状态、工作计划或下一步；如果缺少的进展会改变后续规划，只问一个轻量问题。事项仍需持续承载时，根据当下风险和节奏自主安排下一次进度同步，不使用固定周期。",
    "如果是否发生、是否完成或结果仍不确定，保持原状态并简短询问用户；若此刻打扰不合适，也可以由你选择新的复盘时间。",
    "如果原事件已经结束但产生了仍需推进的后续事项，完成原事项，并按实际语义创建或更新独立的后续事项。不要把未确认的结果写成事实。",
    "用户可见回复只报告实际状态变化或提出一个确有价值的问题；不要复述事项详情、完整历史或你的内部判断过程。",
  ].join("\n");
}
