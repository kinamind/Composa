import { formatInTimeZone } from "date-fns-tz";
import { getConfig, isAIEnabled } from "../config";
import { OpenAICompatibleProvider } from "../ai/openai-compatible";
import { DAILY_PLAN_PROMPT } from "../ai/prompts";
import { presentTurnReply } from "../agent/attention";
import { getChannelAdapter } from "../channels/registry";
import { loadCalendarSnapshot } from "../db/calendar";
import { claimDailyPlanRun, failDailyPlanRun, finishDailyPlanRun } from "../db/daily-plan-runs";
import { searchItems, searchOwnedItems } from "../db/items";
import { ensureUserProfile, getUserProfile, listEnabledDailyPlanProfiles } from "../db/user-profiles";
import { log } from "../observability/log";
import { summarizeItemEnrichment } from "./enrichment-summary";
import { localDate, localDayBounds, localTime } from "./time";
import type { ChannelTarget, Item, UserProfile } from "./types";

export function shouldRunDailyPlan(now: Date, timezone: string, configuredTime: string): boolean {
  return localTime(now, timezone) >= configuredTime;
}

export async function buildDailyPlan(
  env: Env,
  now = new Date(),
  fetcher: typeof fetch = fetch,
  target?: ChannelTarget,
): Promise<string> {
  const config = getConfig(env);
  const profile = target
    ? await getUserProfile(env.DB, target.channel, target.userId)
      ?? await ensureUserProfile(env.DB, target.channel, target.userId, {
        timezone: config.timezone,
        locale: config.locale,
        dailyPlanTime: config.dailyPlanTime,
      }, now)
    : null;
  const timezone = profile?.timezone ?? config.timezone;
  const filters = { statuses: ["open", "raw", "active"], limit: null };
  const items = target
    ? await searchOwnedItems(env.DB, target.channel, target.userId, filters)
    : await searchItems(env.DB, filters);
  const today = localDayBounds(now, timezone);
  const calendar = target
    ? await loadCalendarSnapshot(
      env.DB,
      target.channel,
      target.userId,
      today.start,
      localDayBounds(now, timezone, 1).end,
    )
    : null;
  const fallback = deterministicPlan(items, now, timezone, profile?.userCallName ?? null);
  if (items.length === 0) return fallback;
  if (!isAIEnabled(env)) return annotateFallback(fallback);

  try {
    const provider = new OpenAICompatibleProvider(env.DB, config, env.AI_API_KEY, fetcher, () => now);
    const planningContext = {
      date: localDate(now, timezone),
      currentLocalTime: localTime(now, timezone),
      timezone,
      profile: profile ? dailyPlanProfileContext(profile) : null,
      calendar,
      items: items.map((item) => {
        const enrichment = summarizeItemEnrichment(item.aiEnrichment);
        return {
          id: item.id,
          type: item.type,
          title: item.title,
          content: item.content,
          status: item.status,
          priority: item.priority,
          estimated_duration: item.estimatedDuration,
          due_at: item.dueAt,
          start_after: item.startAfter,
          ...(enrichment ? { enrichment } : {}),
        };
      }),
    };
    const response = await provider.generate({
      purpose: "daily_plan",
      messages: [
        { role: "system", content: DAILY_PLAN_PROMPT },
        { role: "user", content: JSON.stringify(planningContext) },
      ],
    });
    return await presentTurnReply(env, {
      channel: target?.channel ?? "qq",
      originalText: "这是 Desk-IX 主动生成的今日安排。只呈现今天真正值得我关注、行动或决定的内容。",
      backstageDraft: response.text,
      completedTurnParts: [{ type: "daily_plan_context", ...planningContext }],
      verifiedEffects: [],
      profile,
    }, fetcher);
  } catch (error) {
    log("warn", "daily_plan_ai_fallback", { error: error instanceof Error ? error.message : String(error) });
    return annotateFallback(fallback);
  }
}

export async function listDailyPlanProfiles(env: Env): Promise<UserProfile[]> {
  const config = getConfig(env);
  const profiles = await listEnabledDailyPlanProfiles(env.DB);
  const byIdentity = new Map(profiles.map((profile) => [`${profile.channel}:${profile.userId}`, profile]));
  for (const target of config.dailyPlanTargets) {
    const key = `${target.channel}:${target.userId}`;
    if (byIdentity.has(key)) continue;
    const profile = await ensureUserProfile(env.DB, target.channel, target.userId, {
      timezone: config.timezone,
      locale: config.locale,
      dailyPlanTime: config.dailyPlanTime,
    });
    if (profile.dailyPlanEnabled) byIdentity.set(key, profile);
  }
  return [...byIdentity.values()];
}

export async function listDueDailyPlanProfiles(
  env: Env,
  now = new Date(),
  force = false,
): Promise<UserProfile[]> {
  const profiles = await listDailyPlanProfiles(env);
  return force
    ? profiles
    : profiles.filter((profile) => shouldRunDailyPlan(now, profile.timezone, profile.dailyPlanTime));
}

export async function runDailyPlan(env: Env, now = new Date(), fetcher: typeof fetch = fetch, force = false): Promise<void> {
  const dueProfiles = await listDueDailyPlanProfiles(env, now, force);
  if (dueProfiles.length === 0) {
    log("warn", "daily_plan_no_targets");
    return;
  }

  const claims = await Promise.all(dueProfiles.map(async (profile) => ({
    profile,
    day: localDate(now, profile.timezone),
    claimed: await claimDailyPlanRun(
      env.DB,
      localDate(now, profile.timezone),
      profile.channel,
      profile.userId,
      now,
    ),
  })));
  const pending = claims.filter((entry) => entry.claimed);
  if (pending.length === 0) return;

  for (const { profile, day } of pending) {
    const target = { channel: profile.channel, userId: profile.userId };
    try {
      const content = await buildDailyPlan(env, now, fetcher, target);
      const adapter = getChannelAdapter(env, target.channel, fetcher);
      await adapter.send(target, { text: content });
      await finishDailyPlanRun(env.DB, day, target.channel, target.userId, content, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failDailyPlanRun(env.DB, day, target.channel, target.userId, message, now);
      log("error", "daily_plan_delivery_failed", { channel: target.channel, userId: target.userId, error: message });
    }
  }
}

function deterministicPlan(items: Item[], now: Date, timezone: string, userCallName: string | null): string {
  const today = localDayBounds(now, timezone);
  const weekEnd = localDayBounds(now, timezone, 7).start;
  const must: Item[] = [];
  const should: Item[] = [];

  for (const item of items) {
    if (item.priority === "urgent" || item.priority === "high" || (item.dueAt && item.dueAt < today.end)) must.push(item);
    else if (item.dueAt && item.dueAt <= weekEnd) should.push(item);
    else if (item.priority !== "low" && item.type !== "idea" && item.type !== "resource") should.push(item);
  }

  const date = formatInTimeZone(now, timezone, "M/d");
  const heading = `${userCallName ? `${userCallName}，` : ""}${date} 今日安排`;
  if (items.length === 0) return `${heading}\n\n今天没有未完成事项。`;
  const lines = [heading];
  appendSection(lines, "Must", must);
  appendSection(lines, "Should", should);
  if (lines.length === 1) lines.push("", "今天没有需要主动打断你的事项。");
  return lines.join("\n");
}

function dailyPlanProfileContext(profile: UserProfile) {
  return {
    userCallName: profile.userCallName,
    assistantCallName: profile.assistantCallName,
    dailyPlanTime: profile.dailyPlanTime,
    chronotype: profile.chronotype,
    targetWakeTime: profile.targetWakeTime,
    targetSleepTime: profile.targetSleepTime,
    routineCoaching: profile.routineCoaching,
    communicationStyle: profile.communicationStyle,
    preferences: profile.preferences,
  };
}

function annotateFallback(plan: string): string {
  return `模型暂不可用，以下按截止时间与优先级整理。\n${plan}`;
}

function appendSection(lines: string[], label: string, items: Item[]): void {
  if (items.length === 0) return;
  lines.push("", label);
  for (const item of items) lines.push(`• ${item.title}`);
}
