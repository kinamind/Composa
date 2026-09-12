import { action } from "@cloudflare/think";
import { z } from "zod";
import { CHRONOTYPES, ITEM_TYPES, PRIORITIES, type Item, type UserProfileUpdate, type WorkSession } from "../../core/types";
import { scheduleReminder } from "../../core/reminder-service";
import {
  archiveItem,
  completeItem,
  createItem,
  getItemBySource,
  getOwnedItem,
  mergeItemEnrichment,
  restoreItem,
  updateItem,
} from "../../db/items";
import { cancelOpenReminders } from "../../db/reminders";
import { listScheduleWindows } from "../../db/schedule";
import { clearPendingAction } from "../../db/pending-actions";
import { ensureUserProfile, isValidTimezone, updateUserProfile } from "../../db/user-profiles";
import {
  cancelOpenWorkSessions,
  listOwnedWorkSessions,
  replaceWorkSessionPlans,
  replaceWorkSessions,
} from "../../db/work-sessions";
import { getConfig } from "../../config";
import type { AgentPrincipal } from "../context";
import {
  deriveItemLifecycleReview,
  deriveWorkSessionLifecycleReview,
  type DerivedLifecycleReview,
  type LifecycleFollowupController,
} from "../followups";
import { stableFingerprint } from "../idempotency";

type PrincipalProvider = () => AgentPrincipal;

const itemTypeSchema = z.enum(ITEM_TYPES);
const prioritySchema = z.enum(PRIORITIES);

const createItemSchema = z.object({
  actionIndex: z.number().int().min(0).default(0),
  type: itemTypeSchema,
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(100_000),
  url: z.string().url().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  status: z.enum(["open", "raw", "active"]).default("open"),
  priority: prioritySchema.default("normal"),
  estimatedDuration: z.number().int().min(1).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  startAfter: z.string().datetime().nullable().optional(),
  originalTimeExpression: z.string().max(300).nullable().optional(),
  temporalRole: z.enum(["none", "deadline", "event"]),
  structuredData: z.record(z.string(), z.unknown()).optional(),
});

export const updateItemSchema = z.object({
  itemId: z.string().uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().trim().min(1).max(100_000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  status: z.enum(["open", "raw", "active"]).optional(),
  priority: prioritySchema.optional(),
  estimatedDuration: z.number().int().min(1).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  startAfter: z.string().datetime().nullable().optional(),
  originalTimeExpression: z.string().max(300).nullable().optional(),
  temporalRole: z.enum(["none", "deadline", "event"]).optional(),
  primaryUrl: z.string().url().optional(),
  structuredData: z.record(z.string(), z.unknown()).optional(),
  provenance: z.object({
    sourceUrls: z.array(z.string().url()).default([]),
    note: z.string().max(1_000).optional(),
  }).optional(),
}).refine((input) => Object.keys(input).some((key) => key !== "itemId"), "Provide at least one field to update");

const transitionSchema = z.object({
  itemId: z.string().uuid(),
  transition: z.enum(["complete", "abandon", "archive", "restore"]),
});

const clockSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);
const preferenceValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(20),
]);

export const profileUpdateSchema = z.object({
  userCallName: z.string().trim().max(80).nullable().optional(),
  assistantCallName: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().trim().min(1).max(100).refine(isValidTimezone, "Invalid IANA timezone").optional(),
  locale: z.string().trim().min(2).max(40).optional(),
  dailyPlanEnabled: z.boolean().optional(),
  dailyPlanTime: clockSchema.optional(),
  chronotype: z.enum(CHRONOTYPES).optional(),
  targetWakeTime: clockSchema.nullable().optional(),
  targetSleepTime: clockSchema.nullable().optional(),
  routineCoaching: z.boolean().optional(),
  communicationStyle: z.string().trim().min(1).max(500).optional(),
  preferences: z.record(z.string().trim().min(1).max(80), preferenceValueSchema).refine(
    (value) => Object.keys(value).length <= 30,
    "Too many profile preferences",
  ).optional(),
}).refine((input) => Object.keys(input).length > 0, "Provide at least one profile field to update");

export const reminderInputSchema = z.object({
  operation: z.enum(["set", "reschedule", "cancel"]),
  itemId: z.string().uuid(),
  remindAt: z.string().datetime().optional(),
  kind: z.string().trim().min(1).max(80).default("reminder"),
}).superRefine((input, context) => {
  if (input.operation !== "cancel" && !input.remindAt) {
    context.addIssue({
      code: "custom",
      path: ["remindAt"],
      message: "remindAt is required when setting or rescheduling a reminder",
    });
  }
});

export const lifecycleFollowupInputSchema = z.object({
  operation: z.enum(["set", "cancel"]),
  itemId: z.string().uuid(),
  reviewAt: z.string().datetime().optional(),
  reason: z.string().trim().min(1).max(1_000).optional(),
}).superRefine((input, context) => {
  if (input.operation === "set" && !input.reviewAt) {
    context.addIssue({ code: "custom", path: ["reviewAt"], message: "reviewAt is required when setting a follow-up" });
  }
  if (input.operation === "set" && !input.reason) {
    context.addIssue({ code: "custom", path: ["reason"], message: "reason is required when setting a follow-up" });
  }
});

const workSessionBlockSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  label: z.string().trim().min(1).max(300).optional(),
});

export const workSessionInputSchema = z.object({
  operation: z.enum(["replace", "cancel"]),
  itemId: z.string().uuid(),
  sessions: z.array(workSessionBlockSchema).optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).superRefine((input, context) => {
  if (input.operation === "replace" && !input.sessions?.length) {
    context.addIssue({ code: "custom", path: ["sessions"], message: "sessions are required when replacing a work plan" });
  }
  if (input.operation === "replace" && !input.rationale) {
    context.addIssue({ code: "custom", path: ["rationale"], message: "rationale is required when replacing a work plan" });
  }
});

export const calendarReplanInputSchema = z.object({
  plans: z.array(z.object({
    itemId: z.string().uuid(),
    sessions: z.array(workSessionBlockSchema),
  })).min(1),
  rationale: z.string().trim().min(1).max(1_000),
}).superRefine((input, context) => {
  const ids = input.plans.map((plan) => plan.itemId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["plans"], message: "Each item may appear only once in a replan" });
  }
});

export async function synchronizeLifecycleReview(
  item: Item,
  followups: LifecycleFollowupController,
  sessions: Array<Pick<WorkSession, "endAt" | "status">>,
) {
  const now = Date.now();
  const candidates = [
    deriveItemLifecycleReview(item),
    deriveWorkSessionLifecycleReview(item, sessions),
  ].filter((candidate): candidate is DerivedLifecycleReview => (
    candidate !== null && Date.parse(candidate.payload.reviewAt) > now
  ));
  const { canceled } = await followups.cancel(item.id, "boundary");
  if (candidates.length === 0) return { scheduled: false as const, canceled };

  const reviews = [];
  for (const candidate of candidates) {
    const scheduled = await followups.set(candidate.payload);
    reviews.push({ ...scheduled, basis: candidate.basis, lane: candidate.payload.lane });
  }
  const latest = reviews.reduce((selected, review) => (
    Date.parse(review.reviewAt) > Date.parse(selected.reviewAt) ? review : selected
  ));
  return {
    scheduled: true as const,
    canceled,
    scheduleId: latest.scheduleId,
    reviewAt: latest.reviewAt,
    basis: latest.basis,
    reviews,
  };
}

export async function createOwnedItem(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof createItemSchema>,
  followups?: LifecycleFollowupController,
) {
  const existing = await getItemBySource(env.DB, principal.channel, principal.eventId, input.actionIndex);
  if (existing) {
    if (existing.sourceUserId !== principal.userId) throw new Error("Source event is already owned by another user");
    const sessions = followups
      ? await listOwnedWorkSessions(env.DB, existing.id, principal.channel, principal.userId)
      : [];
    const lifecycleReview = followups
      ? await synchronizeLifecycleReview(existing, followups, sessions)
      : null;
    return {
      created: false,
      itemId: existing.id,
      title: existing.title,
      status: existing.status,
      ...(lifecycleReview ? { lifecycleReview } : {}),
    };
  }
  const item = await createItem(env.DB, {
    type: input.type,
    title: input.title,
    content: input.content,
    rawMessage: input.content,
    url: input.url ?? null,
    tags: input.tags,
    status: input.status,
    priority: input.priority,
    estimatedDuration: input.estimatedDuration ?? null,
    dueAt: input.dueAt ?? null,
    startAfter: input.startAfter ?? null,
    originalTimeExpression: input.originalTimeExpression ?? null,
    temporalRole: input.temporalRole,
    sourceChannel: principal.channel,
    sourceUserId: principal.userId,
    sourceMessageId: principal.eventId,
    sourceActionIndex: input.actionIndex,
    aiEnrichment: input.structuredData ?? {},
    metadata: { agentRuntime: "composa-v2" },
  });
  const lifecycleReview = followups
    ? await synchronizeLifecycleReview(item, followups, [])
    : null;
  return {
    created: true,
    itemId: item.id,
    title: item.title,
    status: item.status,
    ...(lifecycleReview ? { lifecycleReview } : {}),
  };
}

export async function updateOwnedItem(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof updateItemSchema>,
  followups?: LifecycleFollowupController,
) {
  const current = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!current) throw new Error("Item not found in the current user's memory");
  const changed = await updateItem(env.DB, current.id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.estimatedDuration !== undefined ? { estimatedDuration: input.estimatedDuration } : {}),
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    ...(input.startAfter !== undefined ? { startAfter: input.startAfter } : {}),
    ...(input.originalTimeExpression !== undefined ? { originalTimeExpression: input.originalTimeExpression } : {}),
    ...(input.temporalRole !== undefined ? { temporalRole: input.temporalRole } : {}),
  });
  if (input.structuredData || input.provenance || input.primaryUrl) {
    await mergeItemEnrichment(
      env.DB,
      current.id,
      { ...current.aiEnrichment, ...(input.structuredData ?? {}) },
      {
        ...current.metadata,
        ...(input.provenance ? { provenance: input.provenance } : {}),
        agentRuntime: "composa-v2",
      },
      { ...(input.primaryUrl ? { primaryUrl: input.primaryUrl } : {}) },
    );
  }
  const updated = changed || Boolean(input.structuredData || input.provenance || input.primaryUrl);
  const changesLifecycleBoundary = input.dueAt !== undefined
    || input.estimatedDuration !== undefined
    || input.temporalRole !== undefined;
  if (!followups || !changesLifecycleBoundary) return { updated, itemId: current.id };
  const canonical = await getOwnedItem(env.DB, current.id, principal.channel, principal.userId);
  if (!canonical) throw new Error("Updated item was not found in the current user's memory");
  const sessions = await listOwnedWorkSessions(env.DB, canonical.id, principal.channel, principal.userId);
  return {
    updated,
    itemId: current.id,
    lifecycleReview: await synchronizeLifecycleReview(canonical, followups, sessions),
  };
}

export async function transitionOwnedItem(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof transitionSchema>,
  followups?: LifecycleFollowupController,
) {
  const current = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!current) throw new Error("Item not found in the current user's memory");
  let changed: boolean;
  if (input.transition === "complete") changed = await completeItem(env.DB, current.id);
  else if (input.transition === "restore") changed = await restoreItem(env.DB, current.id);
  else changed = await archiveItem(env.DB, current.id);
  if (input.transition !== "restore") {
    await cancelOpenReminders(env.DB, current.id);
    await cancelOpenWorkSessions(env.DB, current.id);
    await followups?.cancel(current.id);
  } else if (followups) {
    const restored = await getOwnedItem(env.DB, current.id, principal.channel, principal.userId);
    if (!restored) throw new Error("Restored item was not found in the current user's memory");
    const sessions = await listOwnedWorkSessions(env.DB, restored.id, principal.channel, principal.userId);
    await synchronizeLifecycleReview(restored, followups, sessions);
  }
  return {
    changed,
    itemId: current.id,
    status: input.transition === "complete" ? "completed" : input.transition === "restore" ? "open" : "archived",
  };
}

export async function manageOwnedWorkSessions(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof workSessionInputSchema>,
  followups?: LifecycleFollowupController,
) {
  const item = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!item) throw new Error("Item not found in the current user's memory");
  if (input.operation === "cancel") {
    const canceled = await cancelOpenWorkSessions(env.DB, item.id);
    const lifecycleReview = followups
      ? await synchronizeLifecycleReview(item, followups, [])
      : undefined;
    return { canceled, itemId: item.id, ...(lifecycleReview ? { lifecycleReview } : {}) };
  }
  if (!input.sessions?.length || !input.rationale) throw new Error("Work sessions and rationale are required");

  const sessions = input.sessions.map((session) => ({
    ...session,
    startMs: new Date(session.startAt).getTime(),
    endMs: new Date(session.endAt).getTime(),
  })).sort((left, right) => left.startMs - right.startMs);
  if (sessions.some((session) => !Number.isFinite(session.startMs) || !Number.isFinite(session.endMs) || session.endMs <= session.startMs)) {
    return { scheduled: false, reason: "Every work session must have a valid end after its start." };
  }
  if (sessions.some((session) => session.endMs <= Date.now())) {
    return { scheduled: false, reason: "Work sessions must end in the future." };
  }
  for (let index = 1; index < sessions.length; index += 1) {
    if (sessions[index]!.startMs < sessions[index - 1]!.endMs) {
      return { scheduled: false, reason: "The proposed work sessions overlap each other." };
    }
  }

  const now = new Date();
  const latestSessionEnd = Math.max(...sessions.map((session) => session.endMs));
  const horizonDays = Math.max(1, Math.ceil((latestSessionEnd - now.getTime()) / 86_400_000) + 1);
  const windows = await listScheduleWindows(env.DB, principal.channel, principal.userId, now, horizonDays);
  const occupiedWindows = windows.filter((window) => window.itemId !== item.id && window.source !== "reminder");
  const conflicts = sessions.flatMap((session) => occupiedWindows.filter((window) => overlaps(
    session.startMs,
    session.endMs,
    new Date(window.startAt).getTime(),
    new Date(window.endAt).getTime(),
  )));
  if (conflicts.length > 0) {
    return {
      scheduled: false,
      reason: "The proposed work plan overlaps occupied time. Replan every affected flexible item together or choose different sessions.",
      conflicts,
    };
  }

  const saved = await replaceWorkSessions(
    env.DB,
    item.id,
    sessions.map(({ startAt, endAt, label }) => ({ startAt, endAt, ...(label ? { label } : {}) })),
    input.rationale,
  );
  const totalMinutes = Math.round(sessions.reduce((total, session) => total + session.endMs - session.startMs, 0) / 60_000);
  const dueAt = item.dueAt;
  const lifecycleReview = followups
    ? await synchronizeLifecycleReview(item, followups, saved)
    : undefined;
  return {
    scheduled: true,
    itemId: item.id,
    sessionCount: saved.length,
    totalMinutes,
    sessions: saved,
    conflictsAccepted: conflicts.length,
    deadlineWarnings: dueAt
      ? saved.filter((session) => session.endAt > dueAt).map((session) => session.id)
      : [],
    ...(lifecycleReview ? { lifecycleReview } : {}),
  };
}

export async function replanOwnedWorkSessions(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof calendarReplanInputSchema>,
  followups?: LifecycleFollowupController,
) {
  const items = await Promise.all(input.plans.map((plan) => getOwnedItem(
    env.DB,
    plan.itemId,
    principal.channel,
    principal.userId,
  )));
  if (items.some((item) => !item)) throw new Error("One or more items were not found in the current user's memory");

  const sessions = input.plans.flatMap((plan) => plan.sessions.map((session) => ({
    itemId: plan.itemId,
    ...session,
    startMs: new Date(session.startAt).getTime(),
    endMs: new Date(session.endAt).getTime(),
  }))).sort((left, right) => left.startMs - right.startMs);
  if (sessions.some((session) => !Number.isFinite(session.startMs) || !Number.isFinite(session.endMs) || session.endMs <= session.startMs)) {
    return { scheduled: false, reason: "Every work session must have a valid end after its start." };
  }
  if (sessions.some((session) => session.endMs <= Date.now())) {
    return { scheduled: false, reason: "Work sessions must end in the future." };
  }
  for (let index = 1; index < sessions.length; index += 1) {
    if (sessions[index]!.startMs < sessions[index - 1]!.endMs) {
      return { scheduled: false, reason: "The proposed work sessions overlap each other." };
    }
  }

  if (sessions.length > 0) {
    const now = new Date();
    const latestSessionEnd = Math.max(...sessions.map((session) => session.endMs));
    const horizonDays = Math.max(1, Math.ceil((latestSessionEnd - now.getTime()) / 86_400_000) + 1);
    const changedItemIds = new Set(input.plans.map((plan) => plan.itemId));
    const windows = await listScheduleWindows(env.DB, principal.channel, principal.userId, now, horizonDays);
    const occupiedWindows = windows.filter((window) => (
      window.source !== "reminder"
      && !(window.source === "work_session" && window.itemId && changedItemIds.has(window.itemId))
    ));
    const conflicts = sessions.flatMap((session) => occupiedWindows.filter((window) => overlaps(
      session.startMs,
      session.endMs,
      new Date(window.startAt).getTime(),
      new Date(window.endAt).getTime(),
    )));
    if (conflicts.length > 0) {
      return {
        scheduled: false,
        reason: "The combined replan overlaps an unaffected fixed event or work session.",
        conflicts,
      };
    }
  }

  const saved = await replaceWorkSessionPlans(env.DB, input.plans.map((plan) => ({
    itemId: plan.itemId,
    sessions: plan.sessions.map(({ startAt, endAt, label }) => ({
      startAt,
      endAt,
      ...(label ? { label } : {}),
    })),
  })), input.rationale);
  const lifecycleReviews = followups
    ? await Promise.all((items as Item[]).map(async (item) => ({
      itemId: item.id,
      result: await synchronizeLifecycleReview(
        item,
        followups,
        saved.filter((session) => session.itemId === item.id),
      ),
    })))
    : undefined;
  return {
    scheduled: true,
    planCount: input.plans.length,
    sessionCount: saved.length,
    sessions: saved,
    ...(lifecycleReviews ? { lifecycleReviews } : {}),
  };
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export async function manageOwnedReminder(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof reminderInputSchema>,
) {
  const item = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!item) throw new Error("Item not found in the current user's memory");
  if (input.operation === "cancel") {
    await cancelOpenReminders(env.DB, item.id);
    await clearPendingAction(env.DB, principal.channel, principal.userId, item.id);
    return { canceled: true, itemId: item.id };
  }

  if (!input.remindAt) throw new Error("Reminder time is required");
  const now = new Date();
  const remindAt = new Date(input.remindAt);
  if (Number.isNaN(remindAt.getTime())) {
    return {
      scheduled: false,
      retryable: true,
      reasonCode: "invalid_time",
      reason: "The reminder timestamp is invalid. Recompute it from the turn time anchor and retry in this turn.",
      currentUtc: now.toISOString(),
      turnReceivedAt: principal.receivedAt,
    };
  }
  if (remindAt.getTime() <= now.getTime()) {
    return {
      scheduled: false,
      retryable: true,
      reasonCode: "past_time",
      reason: "The reminder timestamp is not in the future. Recompute the user's relative time from the turn time anchor, update any affected item time, and retry in this turn.",
      requestedRemindAt: remindAt.toISOString(),
      currentUtc: now.toISOString(),
      turnReceivedAt: principal.receivedAt,
    };
  }

  const horizonDays = Math.max(1, Math.ceil((remindAt.getTime() - now.getTime()) / 86_400_000) + 1);
  const windows = await listScheduleWindows(env.DB, principal.channel, principal.userId, now, horizonDays);
  const conflicts = windows.filter((window) => window.itemId !== item.id && (
    remindAt.getTime() >= new Date(window.startAt).getTime()
    && remindAt.getTime() < new Date(window.endAt).getTime()
  ));

  const reminder = await scheduleReminder(env, {
    itemId: item.id,
    remindAt: remindAt.toISOString(),
    kind: input.kind,
    target: { channel: principal.channel, userId: principal.userId },
  });
  await cancelOpenReminders(env.DB, item.id, reminder.id);
  await clearPendingAction(env.DB, principal.channel, principal.userId, item.id);
  return {
    scheduled: true,
    itemId: item.id,
    reminderId: reminder.id,
    remindAt: reminder.remindAt,
    scheduleConflicts: conflicts,
  };
}

export async function manageOwnedLifecycleFollowup(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof lifecycleFollowupInputSchema>,
  followups: LifecycleFollowupController,
) {
  const item = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!item) throw new Error("Item not found in the current user's memory");
  if (input.operation === "cancel") {
    const result = await followups.cancel(item.id, "progress");
    return { ...result, itemId: item.id };
  }
  if (!input.reviewAt || !input.reason) throw new Error("Review time and reason are required");
  const reviewAt = new Date(input.reviewAt);
  if (Number.isNaN(reviewAt.getTime()) || reviewAt.getTime() <= Date.now()) {
    throw new Error("Lifecycle review time must be in the future");
  }
  return followups.set({
    itemId: item.id,
    channel: principal.channel,
    userId: principal.userId,
    reviewAt: reviewAt.toISOString(),
    reason: input.reason,
    kind: "progress",
    lane: "progress",
  });
}

export async function updateOwnedProfile(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof profileUpdateSchema>,
) {
  const config = getConfig(env);
  await ensureUserProfile(env.DB, principal.channel, principal.userId, {
    timezone: config.timezone,
    locale: config.locale,
    dailyPlanTime: config.dailyPlanTime,
  });
  const update: UserProfileUpdate = {
    ...(input.userCallName !== undefined ? { userCallName: input.userCallName } : {}),
    ...(input.assistantCallName !== undefined ? { assistantCallName: input.assistantCallName } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.dailyPlanEnabled !== undefined ? { dailyPlanEnabled: input.dailyPlanEnabled } : {}),
    ...(input.dailyPlanTime !== undefined ? { dailyPlanTime: input.dailyPlanTime } : {}),
    ...(input.chronotype !== undefined ? { chronotype: input.chronotype } : {}),
    ...(input.targetWakeTime !== undefined ? { targetWakeTime: input.targetWakeTime } : {}),
    ...(input.targetSleepTime !== undefined ? { targetSleepTime: input.targetSleepTime } : {}),
    ...(input.routineCoaching !== undefined ? { routineCoaching: input.routineCoaching } : {}),
    ...(input.communicationStyle !== undefined ? { communicationStyle: input.communicationStyle } : {}),
    ...(input.preferences !== undefined ? { preferences: input.preferences } : {}),
  };
  const profile = await updateUserProfile(env.DB, principal.channel, principal.userId, update);
  return { updated: true, profile };
}

export function createWriteActions(
  env: Env,
  principal: PrincipalProvider,
  followups: LifecycleFollowupController,
) {
  return {
    item_create: action({
      description: "Create a new saved item only when the user is introducing a genuinely new task, note, resource, idea, or project. Do not use this for a reference to an existing item; search and update instead. Set temporalRole=deadline when dueAt is a latest-completion deadline, event when dueAt is the start of a fixed occurrence that occupies estimatedDuration, and none when dueAt has no schedule meaning. A bounded event automatically receives an Agent lifecycle review at its expected end, so provide a contextually inferred estimatedDuration whenever the event has an inferable end; ask only when that inference would materially change the plan. For non-fixed work that would benefit from progress synchronization, use lifecycle_followup_manage after this action to choose a context-dependent first checkpoint before replying. Use distinct actionIndex values only when one message explicitly creates several items.",
      inputSchema: createItemSchema,
      permissions: ["items:write"],
      idempotencyKey: ({ input }) => `create:${principal().eventId}:${input.actionIndex}`,
      execute: (input) => createOwnedItem(env, principal(), input, followups),
    }),
    item_update: action({
      description: "Update one existing owned item. Use after memory_search/item_get and the appropriate link reader. Put extracted facts in structuredData and source URLs in provenance so the same record becomes useful instead of storing a bare link. When a raw capture has been fully organized, set status=open; keep status=raw when important source content remains unread.",
      inputSchema: updateItemSchema,
      permissions: ["items:write"],
      idempotencyKey: ({ input }) => `update:${principal().eventId}:${input.itemId}:${stableFingerprint(input)}`,
      execute: (input) => updateOwnedItem(env, principal(), input, followups),
    }),
    item_transition: action({
      description: "Change an existing item's lifecycle: complete it, abandon/archive it, or restore it. Search first when the user refers to it conversationally.",
      inputSchema: transitionSchema,
      permissions: ["items:write"],
      idempotencyKey: ({ input }) => `transition:${principal().eventId}:${input.itemId}:${input.transition}`,
      execute: (input) => transitionOwnedItem(env, principal(), input, followups),
    }),
    reminder_manage: action({
      description: "Set, reschedule, or cancel a reminder for an existing item. A reminder is an attention signal, not occupied work. Interpret relative time from the explicit turn time anchor and user timezone, never from a recalled item's date. When timing depends on the user's schedule, inspect calendar_snapshot first and choose a useful point from the user's wording, current reality, priorities, and preferences. The action reports overlapping calendar entries as advisory scheduleConflicts. If it returns scheduled=false with retryable=true because the timestamp is invalid or past, recompute the absolute time, update the item's affected time fields, and call this action again in the same turn instead of reporting the first failure. You own interruption judgment and may reschedule again in the same turn. Code enforces only ownership and a valid future timestamp.",
      inputSchema: reminderInputSchema,
      permissions: ["reminders:write"],
      idempotencyKey: ({ input }) => `reminder:${principal().eventId}:${input.itemId}:${stableFingerprint(input)}`,
      execute: (input) => manageOwnedReminder(env, principal(), input),
    }),
    work_session_manage: action({
      description: "Replace or cancel concrete work sessions for one existing item. The model chooses the number, duration, and timestamps from the user's actual calendar, deadline, effort, chronotype, preferences, and current reality; code does not apply a category template. Call calendar_snapshot and, when looking for a duration, availability_find for an explicit relevant range first. Split substantial work when the evidence supports it, without imposing a fixed session count. startAfter is only an earliest-start constraint and does not reserve time. Work sessions cannot physically overlap; use calendar_replan when several flexible items must move together. Saving the plan automatically schedules an Agent lifecycle review after its final session; the review does not assume the work is complete.",
      inputSchema: workSessionInputSchema,
      permissions: ["schedule:write"],
      idempotencyKey: ({ input }) => `work-sessions:${principal().eventId}:${input.itemId}:${stableFingerprint(input)}`,
      execute: (input) => manageOwnedWorkSessions(env, principal(), input, followups),
    }),
    calendar_replan: action({
      description: "Atomically replace the concrete work sessions of several existing items when the user's current reality or priorities make the old plan stale. Load the affected items and calendar first, then submit the complete coupled change once. Fixed events, deadlines, reminders, and unrelated work sessions are never moved by this action. The model decides what should move; code only verifies ownership, valid future intervals, and physical non-overlap.",
      inputSchema: calendarReplanInputSchema,
      permissions: ["schedule:write"],
      idempotencyKey: ({ input }) => `calendar-replan:${principal().eventId}:${stableFingerprint(input)}`,
      execute: (input) => replanOwnedWorkSessions(env, principal(), input, followups),
    }),
    lifecycle_followup_manage: action({
      description: "Set or cancel an Agent-owned progress review for an existing item when current judgment calls for a checkpoint. Boundary reviews for bounded events, explicit deadlines, and saved work plans are maintained independently and will not be replaced by this action. Use progress reviews for non-fixed work, pre-deadline synchronization, unresolved outcomes, or another contextually meaningful check; choose the time from actual risk, effort, progress, calendar, and user preferences rather than a fixed interval. At review time the Agent will judge whether to update, ask one useful question, adjust plans, complete, create follow-on work, or schedule the next progress review. Use an item-specific reason, not a category rule.",
      inputSchema: lifecycleFollowupInputSchema,
      permissions: ["followups:write"],
      idempotencyKey: ({ input }) => `followup:${principal().eventId}:${input.itemId}:${stableFingerprint(input)}`,
      execute: (input) => manageOwnedLifecycleFollowup(env, principal(), input, followups),
    }),
    profile_update: action({
      description: "Update this user's persistent assistant relationship and planning preferences when the user states them or asks you to choose a safe, reversible default. Use for mutual forms of address, IANA timezone, daily-plan subscription/time, chronotype, explicit sleep/wake goals, routine coaching, and communication style. Never infer sensitive personal attributes.",
      inputSchema: profileUpdateSchema,
      permissions: ["profile:write"],
      idempotencyKey: ({ input }) => `profile:${principal().eventId}:${stableFingerprint(input)}`,
      execute: (input) => updateOwnedProfile(env, principal(), input),
    }),
  };
}
