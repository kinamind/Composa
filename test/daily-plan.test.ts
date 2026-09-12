import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDailyPlan, listDueDailyPlanProfiles, shouldRunDailyPlan } from "../src/core/daily-plan";
import { claimDailyPlanRun, failDailyPlanRun } from "../src/db/daily-plan-runs";
import { createItem } from "../src/db/items";
import { createReminder } from "../src/db/reminders";
import { ensureUserProfile, updateUserProfile } from "../src/db/user-profiles";
import { replaceWorkSessions } from "../src/db/work-sessions";

const now = new Date("2026-08-15T02:00:00.000Z");

describe("daily planning", () => {
  it("uses configured local time", () => {
    expect(shouldRunDailyPlan(new Date("2026-08-14T23:59:00.000Z"), "Asia/Singapore", "08:00")).toBe(false);
    expect(shouldRunDailyPlan(new Date("2026-08-15T00:00:00.000Z"), "Asia/Singapore", "08:00")).toBe(true);
    expect(shouldRunDailyPlan(new Date("2026-08-15T11:59:00.000Z"), "America/New_York", "08:00")).toBe(false);
    expect(shouldRunDailyPlan(new Date("2026-08-15T12:00:00.000Z"), "America/New_York", "08:00")).toBe(true);
  });

  it("keeps low-attention background out of the degraded plan when AI is unavailable", async () => {
    await createItem(env.DB, {
      type: "task",
      title: "今天提交报告",
      content: "今天提交报告",
      rawMessage: "今天提交报告",
      priority: "urgent",
      dueAt: "2026-08-15T07:00:00.000Z",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "daily-must",
    }, now);
    await createItem(env.DB, {
      type: "idea",
      title: "整理研究想法",
      content: "整理研究想法",
      rawMessage: "整理研究想法",
      priority: "low",
      sourceChannel: "telegram",
      sourceUserId: "42",
      sourceMessageId: "daily-if-time",
    }, now);
    const plan = await buildDailyPlan(env, now);
    expect(plan).toContain("8/15 今日安排");
    expect(plan).toContain("Must\n• 今天提交报告");
    expect(plan).not.toContain("整理研究想法");
    expect(plan.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("keeps each scheduled plan scoped to its own channel identity", async () => {
    await createItem(env.DB, {
      type: "task",
      title: "只属于 QQ 用户的任务",
      content: "QQ 私人事项",
      rawMessage: "QQ 私人事项",
      sourceChannel: "qq",
      sourceUserId: "qq-only",
      sourceMessageId: "daily-qq-private",
    }, now);
    await createItem(env.DB, {
      type: "task",
      title: "只属于 Telegram 用户的任务",
      content: "Telegram 私人事项",
      rawMessage: "Telegram 私人事项",
      sourceChannel: "telegram",
      sourceUserId: "telegram-only",
      sourceMessageId: "daily-telegram-private",
    }, now);

    const plan = await buildDailyPlan(env, now, fetch, { channel: "qq", userId: "qq-only" });

    expect(plan).toContain("只属于 QQ 用户的任务");
    expect(plan).not.toContain("只属于 Telegram 用户的任务");
  });

  it("selects each subscribed profile using its own timezone and preferred time", async () => {
    await ensureUserProfile(env.DB, "qq", "late-singapore", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await ensureUserProfile(env.DB, "telegram", "new-york-morning", {
      timezone: "America/New_York",
      locale: "zh-CN",
      dailyPlanTime: "23:30",
    });
    await ensureUserProfile(env.DB, "qq", "disabled-plan", {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });
    await updateUserProfile(env.DB, "qq", "disabled-plan", { dailyPlanEnabled: false });

    const due = await listDueDailyPlanProfiles(env, new Date("2026-08-15T03:15:00.000Z"));
    expect(due.map((profile) => profile.userId)).toContain("late-singapore");
    expect(due.map((profile) => profile.userId)).not.toContain("new-york-morning");
    expect(due.map((profile) => profile.userId)).not.toContain("disabled-plan");
  });

  it("personalizes the fallback plan with the profile's address and local date", async () => {
    await ensureUserProfile(env.DB, "qq", "personal-plan", {
      timezone: "America/New_York",
      locale: "zh-CN",
      dailyPlanTime: "11:00",
    });
    await updateUserProfile(env.DB, "qq", "personal-plan", { userCallName: "小王" });
    await createItem(env.DB, {
      type: "task",
      title: "准备下午的材料",
      content: "准备下午的材料",
      rawMessage: "准备下午的材料",
      sourceChannel: "qq",
      sourceUserId: "personal-plan",
      sourceMessageId: "personal-plan-item",
    }, now);

    const plan = await buildDailyPlan(
      env,
      new Date("2026-08-15T02:00:00.000Z"),
      fetch,
      { channel: "qq", userId: "personal-plan" },
    );
    expect(plan).toContain("小王，8/14 今日安排");
    expect(plan).toContain("准备下午的材料");
  });

  it("deduplicates a successful day and allows a failed retry", async () => {
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(true);
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(false);
    await failDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", "temporary", now);
    await expect(claimDailyPlanRun(env.DB, "2026-08-15", "telegram", "42", now)).resolves.toBe(true);
  });

  it("keeps complete context backstage but exposes only the attention-selected daily plan", async () => {
    const userId = "long-ai-plan";
    const longItemContent = `${"背景".repeat(300)}末尾关键限制：必须避开组会。`;
    await createItem(env.DB, {
      type: "task",
      title: "复杂的一天",
      content: longItemContent,
      rawMessage: "需要完整安排",
      sourceChannel: "qq",
      sourceUserId: userId,
      sourceMessageId: "long-ai-plan-item",
    }, now);
    const longPlan = "安排".repeat(1_500);
    const requestBodies: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "");
      const content = requestBodies.length === 1
        ? longPlan
        : requestBodies.length === 2
          ? JSON.stringify({
              mode: "plan",
              summary: null,
              entries: [{ subject: "复杂的一天", guidance: "避开组会时段完成今天的关键推进" }],
              question: null,
            })
          : "**复杂的一天**：避开组会时段完成今天的关键推进。";
      return Response.json({
        model: "test-model",
        choices: [{ message: { content } }],
      });
    };
    const aiEnv = {
      ...env,
      AI_API_KEY: "test-key",
      AI_MODEL: "test-model",
      AI_DAILY_REQUEST_LIMIT: "0",
    } as unknown as Env;

    const plan = await buildDailyPlan(aiEnv, now, fetcher, { channel: "qq", userId });
    expect(requestBodies[0]).toContain("末尾关键限制：必须避开组会");
    expect(requestBodies[1]).toContain(longPlan);
    expect(plan).toBe("**复杂的一天**：避开组会时段完成今天的关键推进。");
    expect(plan).not.toContain(longPlan);
    expect(requestBodies).toHaveLength(3);
  });

  it("gives the daily planner canonical events, deadlines, work sessions, reminders, and conflicts", async () => {
    const userId = "canonical-calendar-plan";
    const event = await createItem(env.DB, {
      type: "task",
      title: "固定组会",
      content: "必须参加",
      rawMessage: "固定组会",
      dueAt: "2026-08-15T06:00:00.000Z",
      estimatedDuration: 120,
      temporalRole: "event",
      sourceChannel: "qq",
      sourceUserId: userId,
      sourceMessageId: "canonical-plan-event",
    }, now);
    const deadline = await createItem(env.DB, {
      type: "task",
      title: "提交报告",
      content: "当天截止",
      rawMessage: "提交报告",
      dueAt: "2026-08-15T12:00:00.000Z",
      estimatedDuration: 120,
      temporalRole: "deadline",
      sourceChannel: "qq",
      sourceUserId: userId,
      sourceMessageId: "canonical-plan-deadline",
    }, now);
    await replaceWorkSessions(env.DB, deadline.id, [{
      startAt: "2026-08-15T07:00:00.000Z",
      endAt: "2026-08-15T09:00:00.000Z",
      label: "完成报告",
    }], "截止前完成", now);
    await createReminder(env.DB, {
      itemId: deadline.id,
      remindAt: "2026-08-15T05:00:00.000Z",
      kind: "deadline_warning",
      targetChannel: "qq",
      targetUserId: userId,
    }, now);
    const requestBodies: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "");
      const content = requestBodies.length === 1
        ? "已按真实日程整理"
        : requestBodies.length === 2
          ? JSON.stringify({
              mode: "plan",
              summary: "今天按真实日程推进。",
              entries: [],
              question: null,
            })
          : "今天按真实日程推进。";
      return Response.json({
        model: "test-model",
        choices: [{ message: { content } }],
      });
    };
    const aiEnv = {
      ...env,
      AI_API_KEY: "test-key",
      AI_MODEL: "test-model",
      AI_DAILY_REQUEST_LIMIT: "0",
    } as unknown as Env;

    await buildDailyPlan(aiEnv, now, fetcher, { channel: "qq", userId });

    const request = z.object({
      messages: z.array(z.object({ role: z.string(), content: z.string() })),
    }).parse(JSON.parse(requestBodies[0] ?? "null") as unknown);
    const context = z.object({
      calendar: z.object({
        entries: z.array(z.object({
          itemId: z.string(),
          kind: z.enum(["event", "deadline", "work_session", "reminder"]),
          blocksTime: z.boolean(),
        })),
        conflicts: z.array(z.unknown()),
      }),
    }).parse(JSON.parse(request.messages.at(-1)?.content ?? "null") as unknown);
    expect(context.calendar.entries).toEqual(expect.arrayContaining([
      { itemId: event.id, kind: "event", blocksTime: true },
      { itemId: deadline.id, kind: "deadline", blocksTime: false },
      { itemId: deadline.id, kind: "work_session", blocksTime: true },
      { itemId: deadline.id, kind: "reminder", blocksTime: false },
    ]));
    expect(context.calendar.conflicts).toHaveLength(1);
  });
});
