import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Schedule } from "agents";
import type { AgentPrincipal } from "../src/agent/context";
import {
  buildLifecycleReviewMessage,
  deriveItemLifecycleReview,
  deriveWorkSessionLifecycleReview,
  isLifecycleFollowupSchedule,
  lifecycleReviewEventId,
  type LifecycleFollowupController,
} from "../src/agent/followups";
import {
  manageOwnedLifecycleFollowup,
  synchronizeLifecycleReview,
  transitionOwnedItem,
} from "../src/agent/tools/write";
import { createItem } from "../src/db/items";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "qq-user-42",
  eventId: "followup-event",
  receivedAt: "2026-08-17T05:00:00.000Z",
};

describe("agent-owned lifecycle follow-ups", () => {
  it("derives a review from a bounded event without deciding its outcome", async () => {
    const meeting = await createItem(env.DB, {
      type: "task",
      title: "讨论研究进度",
      content: "固定会面",
      rawMessage: "明晚九点开会，大约一小时",
      dueAt: "2026-09-07T13:00:00.000Z",
      estimatedDuration: 60,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "derived-event-review",
    });

    const review = deriveItemLifecycleReview(meeting);
    expect(review?.basis).toBe("event_end");
    expect(review?.payload.itemId).toBe(meeting.id);
    expect(review?.payload.reviewAt).toBe("2026-09-07T14:00:00.000Z");
    expect(review?.payload.reason).toContain("预设结果");
    expect(review?.payload.kind).toBe("boundary");
    expect(review?.payload.lane).toBe("event_end");
  });

  it("reviews explicit deadlines, including legacy due items, without inventing event endings", async () => {
    const note = await createItem(env.DB, {
      type: "note",
      title: "研究资料",
      content: "留作参考",
      rawMessage: "记录一下",
      temporalRole: "none",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "no-derived-note-review",
    });
    expect(deriveItemLifecycleReview(note)).toBeNull();
    const deadline = deriveItemLifecycleReview({
      ...note,
      temporalRole: "deadline",
      dueAt: "2026-09-07T14:00:00.000Z",
      estimatedDuration: 60,
    });
    expect(deadline?.basis).toBe("deadline");
    expect(deadline?.payload.reviewAt).toBe("2026-09-07T14:00:00.000Z");
    expect(deadline?.payload.reason).toContain("等同于已经完成");
    expect(deadline?.payload.lane).toBe("deadline");
    expect(deriveItemLifecycleReview({
      ...note,
      temporalRole: "none",
      dueAt: "2026-09-07T14:00:00.000Z",
    })?.basis).toBe("deadline");
    expect(deriveItemLifecycleReview({
      ...note,
      temporalRole: "event",
      dueAt: "2026-09-07T14:00:00.000Z",
      estimatedDuration: null,
    })).toBeNull();
  });

  it("reviews a work plan after its final planned session", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "修改论文",
      content: "分两段处理",
      rawMessage: "安排一下",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "derived-work-review",
    });

    const review = deriveWorkSessionLifecycleReview(item, [
      { endAt: "2026-09-07T10:00:00.000Z", status: "planned" },
      { endAt: "2026-09-07T12:00:00.000Z", status: "canceled" },
      { endAt: "2026-09-08T11:30:00.000Z", status: "planned" },
    ]);
    expect(review?.basis).toBe("work_plan_end");
    expect(review?.payload.itemId).toBe(item.id);
    expect(review?.payload.reviewAt).toBe("2026-09-08T11:30:00.000Z");
    expect(review?.payload.reason).toContain("不预设结果");
    expect(review?.payload.kind).toBe("boundary");
    expect(review?.payload.lane).toBe("work_plan_end");
  });

  it("keeps a work-plan review and a later deadline review as independent schedules", async () => {
    const workEndsAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const deadlineAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const item = await createItem(env.DB, {
      type: "task",
      title: "提交论文",
      content: "先结束修改，之后仍需确认投稿结果",
      rawMessage: "今天截止",
      dueAt: deadlineAt,
      temporalRole: "none",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "independent-lifecycle-boundaries",
    });
    const set = vi.fn<LifecycleFollowupController["set"]>().mockImplementation(async (payload) => ({
      scheduled: true,
      scheduleId: `schedule-${payload.lane}`,
      reviewAt: payload.reviewAt,
    }));
    const cancel = vi.fn<LifecycleFollowupController["cancel"]>().mockResolvedValue({ canceled: 1 });

    const result = await synchronizeLifecycleReview(item, { set, cancel }, [
      { endAt: workEndsAt, status: "planned" },
    ]);

    expect(cancel).toHaveBeenCalledWith(item.id, "boundary");
    expect(set.mock.calls.map(([payload]) => payload.lane)).toEqual(["deadline", "work_plan_end"]);
    expect(result).toMatchObject({ scheduled: true, reviewAt: deadlineAt, basis: "deadline" });
    expect(result.reviews).toHaveLength(2);
  });

  it("matches only the exact callback and item payload", () => {
    const itemId = "10000000-0000-4000-8000-000000000001";
    const otherItemId = "10000000-0000-4000-8000-000000000002";
    const matching = {
      id: "schedule-1",
      callback: "reviewScheduledItem",
      payload: {
        itemId,
        channel: "qq" as const,
        userId: "user-1",
        reviewAt: "2026-08-17T08:00:00.000Z",
        reason: "review this item",
      },
      type: "scheduled",
      time: 1_787_000_000,
    } satisfies Schedule<unknown>;
    expect(isLifecycleFollowupSchedule(matching, itemId)).toBe(true);
    expect(isLifecycleFollowupSchedule(matching, itemId, "boundary")).toBe(true);
    expect(isLifecycleFollowupSchedule(matching, itemId, "progress")).toBe(false);
    expect(isLifecycleFollowupSchedule(matching, otherItemId)).toBe(false);
    expect(isLifecycleFollowupSchedule({ ...matching, callback: "anotherCallback" }, itemId)).toBe(false);
    expect(isLifecycleFollowupSchedule({ ...matching, payload: "not-an-object" }, itemId)).toBe(false);
    const boundary = { ...matching, payload: { ...matching.payload, kind: "boundary" as const } } satisfies Schedule<unknown>;
    const progress = { ...matching, payload: { ...matching.payload, kind: "progress" as const } } satisfies Schedule<unknown>;
    const deadline = { ...matching, payload: { ...matching.payload, kind: "boundary" as const, lane: "deadline" as const } } satisfies Schedule<unknown>;
    expect(isLifecycleFollowupSchedule(boundary, itemId, "boundary")).toBe(true);
    expect(isLifecycleFollowupSchedule(boundary, itemId, "progress")).toBe(false);
    expect(isLifecycleFollowupSchedule(progress, itemId, "progress")).toBe(true);
    expect(isLifecycleFollowupSchedule(deadline, itemId, "boundary", "deadline")).toBe(true);
    expect(isLifecycleFollowupSchedule(deadline, itemId, "boundary", "work_plan_end")).toBe(false);
    expect(lifecycleReviewEventId(boundary.payload)).not.toBe(lifecycleReviewEventId(progress.payload));
  });

  it("builds a review turn that leaves the decision to the Agent", async () => {
    const meeting = await createItem(env.DB, {
      type: "task",
      title: "和 Amiya 开会",
      content: "讨论迁移进度",
      rawMessage: "今晚十点开会",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "meeting-review",
      dueAt: "2026-08-17T14:00:00.000Z",
    });
    const prompt = buildLifecycleReviewMessage(meeting, {
      itemId: meeting.id,
      channel: principal.channel,
      userId: principal.userId,
      reviewAt: "2026-08-17T15:00:00.000Z",
      reason: "安排结束后判断是否自然完成，或是否还有迁移跟进",
      kind: "boundary",
    }, new Date("2026-08-17T15:00:00.000Z"));

    expect(prompt).toContain("系统触发的边界复盘");
    expect(prompt).toContain("不是用户声称");
    expect(prompt).toContain("发生确定性");
    expect(prompt).toContain("结果确定性");
    expect(prompt).toContain("可以标记完成");
    expect(prompt).toContain("保持原状态并简短询问");
    expect(prompt).toContain("后续事项");
    expect(prompt).toContain("不要展开复盘报告");
    expect(prompt).toContain("时间边界已到");
    expect(prompt).toContain("只报告实际状态变化");
    expect(prompt).not.toContain("会议一律完成");
  });

  it("builds a separate rolling progress turn without pretending a boundary ended", async () => {
    const task = await createItem(env.DB, {
      type: "project",
      title: "准备申请材料",
      content: "截止前分阶段推进",
      rawMessage: "帮我持续跟一下",
      temporalRole: "deadline",
      dueAt: "2026-09-20T16:00:00.000Z",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "rolling-progress-review",
    });
    const prompt = buildLifecycleReviewMessage(task, {
      itemId: task.id,
      channel: principal.channel,
      userId: principal.userId,
      reviewAt: "2026-09-12T10:00:00.000Z",
      reason: "在截止前结合已安排投入同步一次进展",
      kind: "progress",
    }, new Date("2026-09-12T10:00:00.000Z"));

    expect(prompt).toContain("系统触发的进度同步");
    expect(prompt).toContain("不表示任何时间段已经发生");
    expect(prompt).toContain("只问一个轻量问题");
    expect(prompt).toContain("自主安排下一次进度同步");
    expect(prompt).toContain("不使用固定周期");
  });

  it("verifies ownership, schedules reviews, and cancels them on terminal transitions", async () => {
    const reviewAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const item = await createItem(env.DB, {
      type: "task",
      title: "固定安排",
      content: "结束后复盘",
      rawMessage: "安排一下",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "followup-owned-item",
    });
    const set = vi.fn<LifecycleFollowupController["set"]>().mockResolvedValue({
      scheduled: true,
      scheduleId: "schedule-1",
      reviewAt,
    });
    const cancel = vi.fn<LifecycleFollowupController["cancel"]>().mockResolvedValue({ canceled: 1 });
    const controller: LifecycleFollowupController = { set, cancel };

    await expect(manageOwnedLifecycleFollowup(env, principal, {
      operation: "set",
      itemId: item.id,
      reviewAt,
      reason: "到点后结合上下文判断是否结束",
    }, controller)).resolves.toMatchObject({ scheduled: true, scheduleId: "schedule-1" });
    expect(set).toHaveBeenCalledWith({
      itemId: item.id,
      channel: principal.channel,
      userId: principal.userId,
      reviewAt,
      reason: "到点后结合上下文判断是否结束",
      kind: "progress",
      lane: "progress",
    });

    await manageOwnedLifecycleFollowup(env, principal, {
      operation: "cancel",
      itemId: item.id,
    }, controller);
    expect(cancel).toHaveBeenLastCalledWith(item.id, "progress");

    await transitionOwnedItem(env, principal, { itemId: item.id, transition: "complete" }, controller);
    expect(cancel).toHaveBeenCalledWith(item.id);

    await expect(manageOwnedLifecycleFollowup(env, { ...principal, userId: "someone-else" }, {
      operation: "cancel",
      itemId: item.id,
    }, controller)).rejects.toThrow("Item not found");
  });
});
