import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { AgentPrincipal } from "../src/agent/context";
import type { LifecycleFollowupController, LifecycleFollowupPayload } from "../src/agent/followups";
import type { ReminderWorkflowPayload } from "../src/core/types";
import {
  createOwnedItem,
  manageOwnedReminder,
  manageOwnedWorkSessions,
  replanOwnedWorkSessions,
  transitionOwnedItem,
  updateOwnedItem,
  updateOwnedProfile,
} from "../src/agent/tools/write";
import { createItem, getItem } from "../src/db/items";
import { listOwnedWorkSessions, replaceWorkSessions } from "../src/db/work-sessions";
import { ensureUserProfile, getUserProfile } from "../src/db/user-profiles";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "qq-user-42",
  eventId: "agent-write-event",
  receivedAt: "2026-08-16T08:00:00.000Z",
};

function fakeFollowups() {
  const set = vi.fn<LifecycleFollowupController["set"]>().mockImplementation(
    async (payload: LifecycleFollowupPayload) => ({
      scheduled: true,
      scheduleId: `schedule-${Date.parse(payload.reviewAt)}`,
      reviewAt: payload.reviewAt,
    }),
  );
  const cancel = vi.fn<LifecycleFollowupController["cancel"]>().mockResolvedValue({ canceled: 1 });
  return { controller: { set, cancel } satisfies LifecycleFollowupController, set, cancel };
}

describe("agent write capabilities", () => {
  it("automatically schedules a review at the end of a newly created bounded event", async () => {
    const { controller, set } = fakeFollowups();
    const startAt = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();
    const createPrincipal = {
      ...principal,
      eventId: "automatic-created-event-review",
    };
    const input = {
      actionIndex: 0,
      type: "task" as const,
      title: "和同学面试",
      content: "固定安排，预计两小时",
      tags: [],
      status: "open" as const,
      priority: "normal" as const,
      dueAt: startAt,
      estimatedDuration: 120,
      temporalRole: "event" as const,
    };
    const result = await createOwnedItem(env, createPrincipal, input, controller);

    const expectedReviewAt = new Date(Date.parse(startAt) + 120 * 60_000).toISOString();
    expect(result).toMatchObject({
      created: true,
      lifecycleReview: { scheduled: true, reviewAt: expectedReviewAt, basis: "event_end" },
    });
    const scheduled = set.mock.calls[0]?.[0];
    expect(scheduled?.itemId).toBe(result.itemId);
    expect(scheduled?.reviewAt).toBe(expectedReviewAt);
    expect(scheduled?.reason).toContain("预设结果");

    const retried = await createOwnedItem(env, createPrincipal, input, controller);
    expect(retried).toMatchObject({ created: false, itemId: result.itemId });
    expect(set.mock.calls[1]?.[0]).toMatchObject({
      itemId: result.itemId,
      reviewAt: expectedReviewAt,
    });
  });

  it("replaces an event review when its boundary changes and cancels it when the boundary is removed", async () => {
    const { controller, set, cancel } = fakeFollowups();
    const item = await createItem(env.DB, {
      type: "task",
      title: "项目讨论",
      content: "固定事件",
      rawMessage: "明天讨论",
      dueAt: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      estimatedDuration: 60,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "updated-event-review",
    });
    const movedStart = new Date(Date.now() + 72 * 60 * 60_000).toISOString();

    await updateOwnedItem(env, principal, {
      itemId: item.id,
      dueAt: movedStart,
      estimatedDuration: 90,
    }, controller);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({
      itemId: item.id,
      reviewAt: new Date(Date.parse(movedStart) + 90 * 60_000).toISOString(),
    }));

    await updateOwnedItem(env, principal, {
      itemId: item.id,
      temporalRole: "none",
      dueAt: null,
    }, controller);
    expect(cancel).toHaveBeenLastCalledWith(item.id, "boundary");
  });

  it("updates only the authenticated user's persistent assistant profile", async () => {
    await ensureUserProfile(env.DB, principal.channel, principal.userId, {
      timezone: "Asia/Singapore",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });
    await ensureUserProfile(env.DB, principal.channel, "someone-else", {
      timezone: "UTC",
      locale: "zh-CN",
      dailyPlanTime: "08:00",
    });

    const updated = await updateOwnedProfile(env, principal, {
      assistantCallName: "小九",
      dailyPlanTime: "11:00",
      chronotype: "late",
      routineCoaching: true,
      preferences: { planningDensity: "light" },
    });

    expect(updated.profile).toMatchObject({
      assistantCallName: "小九",
      dailyPlanTime: "11:00",
      chronotype: "late",
      routineCoaching: true,
    });
    await expect(getUserProfile(env.DB, principal.channel, "someone-else")).resolves.toMatchObject({
      timezone: "UTC",
      assistantCallName: "拾序",
    });
  });

  it("enriches the same recruitment item with structured facts and provenance", async () => {
    const item = await createItem(env.DB, {
      type: "resource",
      title: "这个招聘信息帮我记录一下",
      content: "https://jobs.example/notice",
      rawMessage: "招聘信息",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "recruitment-to-update",
    });

    const result = await updateOwnedItem(env, principal, {
      itemId: item.id,
      title: "深圳理工大学人工智能研究院招聘",
      content: "招聘教学科研人员；申请材料包括简历、研究计划与代表作。",
      tags: ["招聘", "深圳理工大学", "人工智能"],
      primaryUrl: "https://jobs.example/notice",
      structuredData: {
        category: "recruitment",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
      },
      provenance: { sourceUrls: ["https://jobs.example/notice"] },
    });

    expect(result).toEqual({ updated: true, itemId: item.id });
    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({
      id: item.id,
      title: "深圳理工大学人工智能研究院招聘",
      aiEnrichment: {
        category: "recruitment",
        organizations: ["深圳理工大学人工智能研究院"],
        roles: ["教学科研人员"],
      },
      metadata: { provenance: { sourceUrls: ["https://jobs.example/notice"] } },
    });
  });

  it("supports natural lifecycle operations without deleting the record", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "候选任务",
      content: "待决定",
      rawMessage: "待决定",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "transition-item",
    });

    await expect(transitionOwnedItem(env, principal, { itemId: item.id, transition: "abandon" })).resolves.toMatchObject({ status: "archived" });
    await expect(transitionOwnedItem(env, principal, { itemId: item.id, transition: "restore" })).resolves.toMatchObject({ status: "open" });
    await expect(getItem(env.DB, item.id)).resolves.toMatchObject({ id: item.id, status: "open" });
  });

  it("lets the Agent use any future reminder time and reports actual schedule conflicts", async () => {
    const base = Date.now() + 24 * 60 * 60_000;
    const item = await createItem(env.DB, {
      type: "task",
      title: "稍后研究数据",
      content: "暂时不做",
      rawMessage: "暂时不做",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "reminder-item",
    });
    await createItem(env.DB, {
      type: "task",
      title: "已有会议",
      content: "这一小时有事",
      rawMessage: "已有会议",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "busy-item",
      dueAt: new Date(base).toISOString(),
      estimatedDuration: 60,
    });

    const reminderEnv: Env = {
      ...env,
      REMINDER_WORKFLOW: {
        create: async (options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}) => ({
          id: options.id ?? "generated",
        }) as WorkflowInstance,
      } as Workflow<ReminderWorkflowPayload>,
    };
    const immediate = await manageOwnedReminder(reminderEnv, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      kind: "deferred_action",
    });
    expect(immediate.scheduled).toBe(true);

    const conflict = await manageOwnedReminder(reminderEnv, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(base).toISOString(),
      kind: "deferred_action",
    });
    expect(conflict.scheduled).toBe(true);
    expect("scheduleConflicts" in conflict ? conflict.scheduleConflicts[0]?.title : "").toBe("已有会议");
  });

  it("returns a retryable time anchor instead of terminating a turn on a past reminder", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "告诉同事可以运行了",
      content: "明天中午告诉同事可以运行了",
      rawMessage: "明天中午告诉同事可以运行了",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "past-reminder-retry",
    });

    await expect(manageOwnedReminder(env, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: "2026-08-15T04:00:00.000Z",
      kind: "deferred_action",
    })).resolves.toMatchObject({
      scheduled: false,
      retryable: true,
      reasonCode: "past_time",
      turnReceivedAt: principal.receivedAt,
    });
  });

  it("allows a reminder to serve as a transition cue during a flexible work plan", async () => {
    const base = Date.now() + 48 * 60 * 60_000;
    const item = await createItem(env.DB, {
      type: "task",
      title: "会后处理材料",
      content: "当前活动结束后提醒切换",
      rawMessage: "等会提醒我",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "broad-time-target",
    });
    const flexible = await createItem(env.DB, {
      type: "task",
      title: "原来的论文工作",
      content: "这是可调整的工作计划",
      rawMessage: "原工作计划",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "broad-time-conflict",
    });
    await replaceWorkSessions(env.DB, flexible.id, [{
      startAt: new Date(base).toISOString(),
      endAt: new Date(base + 60 * 60_000).toISOString(),
      label: "论文工作",
    }], "原计划");

    const reminderEnv: Env = {
      ...env,
      REMINDER_WORKFLOW: {
        create: async (options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}) => ({
          id: options.id ?? "generated",
        }) as WorkflowInstance,
      } as Workflow<ReminderWorkflowPayload>,
    };
    const result = await manageOwnedReminder(reminderEnv, principal, {
      operation: "set",
      itemId: item.id,
      remindAt: new Date(base).toISOString(),
      kind: "switch_attention_after_current_activity",
    });

    expect(result.scheduled).toBe(true);
    expect("scheduleConflicts" in result ? result.scheduleConflicts : []).toEqual([
      expect.objectContaining({ itemId: flexible.id, source: "work_session" }),
    ]);
  });

  it("does not invent a pre-meeting conflict window for a reminder", async () => {
    const meetingAt = Date.now() + 144 * 60 * 60_000;
    const target = await createItem(env.DB, {
      type: "task",
      title: "会前带材料",
      content: "在会议前提醒",
      rawMessage: "会前带材料",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "pre-meeting-reminder",
    });
    await createItem(env.DB, {
      type: "task",
      title: "项目会议",
      content: "固定会议",
      rawMessage: "项目会议",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "pre-meeting-event",
      dueAt: new Date(meetingAt).toISOString(),
      estimatedDuration: 60,
    });
    const reminderEnv: Env = {
      ...env,
      REMINDER_WORKFLOW: {
        create: async (options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}) => ({
          id: options.id ?? "generated",
        }) as WorkflowInstance,
      } as Workflow<ReminderWorkflowPayload>,
    };

    await expect(manageOwnedReminder(reminderEnv, principal, {
      operation: "set",
      itemId: target.id,
      remindAt: new Date(meetingAt - 5 * 60_000).toISOString(),
      kind: "bring_materials",
    })).resolves.toMatchObject({ scheduled: true });
  });

  it("persists model-selected work sessions and rejects overlapping plans", async () => {
    const base = Date.now() + 72 * 60 * 60_000;
    const first = await createItem(env.DB, {
      type: "task",
      title: "整理研究内容",
      content: "需要三小时",
      rawMessage: "整理研究内容",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "work-session-first",
    });
    const second = await createItem(env.DB, {
      type: "task",
      title: "撰写 proposal",
      content: "需要五小时",
      rawMessage: "撰写 proposal",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "work-session-second",
    });
    const firstStart = new Date(base).toISOString();
    const firstEnd = new Date(base + 2 * 60 * 60_000).toISOString();
    const laterStart = new Date(base + 3 * 60 * 60_000).toISOString();
    const laterEnd = new Date(base + 5 * 60 * 60_000).toISOString();

    await expect(manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: first.id,
      sessions: [{ startAt: firstStart, endAt: firstEnd, label: "整理现状" }],
      rationale: "先完成较早截止的 update",
    })).resolves.toMatchObject({ scheduled: true, sessionCount: 1, totalMinutes: 120 });

    const overlapping = await manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: second.id,
      sessions: [{ startAt: firstStart, endAt: firstEnd }],
      rationale: "proposal 第一段",
    });
    expect(overlapping).toMatchObject({ scheduled: false });
    expect("conflicts" in overlapping ? overlapping.conflicts[0]?.source : "").toBe("work_session");

    await expect(manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: second.id,
      sessions: [{ startAt: laterStart, endAt: laterEnd, label: "proposal 框架" }],
      rationale: "避开已有工作段",
    })).resolves.toMatchObject({ scheduled: true, sessionCount: 1 });

    await expect(listOwnedWorkSessions(env.DB, second.id, "qq", principal.userId)).resolves.toMatchObject([
      { startAt: laterStart, endAt: laterEnd, label: "proposal 框架", status: "planned" },
    ]);
  });

  it("schedules one lifecycle review after the final planned work session and removes it with the plan", async () => {
    const { controller, set, cancel } = fakeFollowups();
    const base = Date.now() + 5 * 24 * 60 * 60_000;
    const item = await createItem(env.DB, {
      type: "task",
      title: "准备研究汇报",
      content: "需要分两段完成",
      rawMessage: "安排两段时间",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "automatic-work-plan-review",
    });
    const firstEnd = new Date(base + 60 * 60_000).toISOString();
    const finalEnd = new Date(base + 4 * 60 * 60_000).toISOString();

    await expect(manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [
        { startAt: new Date(base).toISOString(), endAt: firstEnd },
        { startAt: new Date(base + 3 * 60 * 60_000).toISOString(), endAt: finalEnd },
      ],
      rationale: "按当前空档分段推进",
    }, controller)).resolves.toMatchObject({
      scheduled: true,
      lifecycleReview: { scheduled: true, reviewAt: finalEnd, basis: "work_plan_end" },
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ itemId: item.id, reviewAt: finalEnd }));

    await manageOwnedWorkSessions(env, principal, {
      operation: "cancel",
      itemId: item.id,
    }, controller);
    expect(cancel).toHaveBeenLastCalledWith(item.id, "boundary");
  });

  it("restores a bounded event's own review when its separate work plan is canceled", async () => {
    const { controller, set } = fakeFollowups();
    const base = Date.now() + 6 * 24 * 60 * 60_000;
    const eventEnd = new Date(base + 60 * 60_000).toISOString();
    const workEnd = new Date(base + 4 * 60 * 60_000).toISOString();
    const item = await createItem(env.DB, {
      type: "task",
      title: "固定讨论与准备",
      content: "事件之外另有准备时段",
      rawMessage: "安排讨论和准备",
      dueAt: new Date(base).toISOString(),
      estimatedDuration: 60,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "event-review-restored-after-work-cancel",
    });

    await manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [{
        startAt: new Date(base + 3 * 60 * 60_000).toISOString(),
        endAt: workEnd,
      }],
      rationale: "讨论后整理结果",
    }, controller);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ reviewAt: workEnd }));

    await manageOwnedWorkSessions(env, principal, {
      operation: "cancel",
      itemId: item.id,
    }, controller);
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ reviewAt: eventEnd }));
  });

  it("rejects internally overlapping sessions and cancels sessions at terminal lifecycle", async () => {
    const base = Date.now() + 96 * 60 * 60_000;
    const item = await createItem(env.DB, {
      type: "task",
      title: "深度工作",
      content: "分段完成",
      rawMessage: "深度工作",
      sourceChannel: "qq",
      sourceUserId: principal.userId,
      sourceMessageId: "work-session-lifecycle",
    });
    const start = new Date(base).toISOString();
    const middle = new Date(base + 60 * 60_000).toISOString();
    const end = new Date(base + 2 * 60 * 60_000).toISOString();

    const overlappingPlan = await manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [
        { startAt: start, endAt: end },
        { startAt: middle, endAt: end },
      ],
      rationale: "错误重叠方案",
    });
    expect(overlappingPlan).toMatchObject({ scheduled: false });
    expect("reason" in overlappingPlan ? overlappingPlan.reason : "").toContain("overlap");

    await manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [{ startAt: start, endAt: middle }],
      rationale: "可执行的一段",
    });
    await transitionOwnedItem(env, principal, { itemId: item.id, transition: "complete" });
    await expect(listOwnedWorkSessions(env.DB, item.id, "qq", principal.userId)).resolves.toMatchObject([
      { status: "canceled" },
    ]);
  });

  it("does not allow work-session writes through another user's item ID", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "别人的工作",
      content: "私有",
      rawMessage: "私有",
      sourceChannel: "qq",
      sourceUserId: "another-user",
      sourceMessageId: "private-work-session",
    });
    const start = Date.now() + 120 * 60 * 60_000;
    await expect(manageOwnedWorkSessions(env, principal, {
      operation: "replace",
      itemId: item.id,
      sessions: [{ startAt: new Date(start).toISOString(), endAt: new Date(start + 60 * 60_000).toISOString() }],
      rationale: "不应成功",
    })).rejects.toThrow("not found");
  });

  it("atomically replans several flexible items when current priorities change", async () => {
    const { controller, set } = fakeFollowups();
    const base = Date.now() + 7 * 24 * 60 * 60_000;
    const oldPriority = await createItem(env.DB, {
      type: "task",
      title: "原来的论文工作",
      content: "原先排在前面，但现在可以移动",
      rawMessage: "原计划",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "adaptive-old-priority",
    });
    const newPriority = await createItem(env.DB, {
      type: "task",
      title: "临时提升优先级的工作",
      content: "当前活动结束后优先处理",
      rawMessage: "会后优先处理这个",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "adaptive-new-priority",
    });
    const fixedMeeting = await createItem(env.DB, {
      type: "task",
      title: "不可移动的会议",
      content: "固定事件保持原位",
      rawMessage: "固定会议",
      dueAt: new Date(base + 2 * 60 * 60_000).toISOString(),
      estimatedDuration: 60,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "adaptive-fixed-meeting",
    });
    await replaceWorkSessions(env.DB, oldPriority.id, [{
      startAt: new Date(base).toISOString(),
      endAt: new Date(base + 2 * 60 * 60_000).toISOString(),
      label: "原任务",
    }], "原计划");
    await replaceWorkSessions(env.DB, newPriority.id, [{
      startAt: new Date(base + 3 * 60 * 60_000).toISOString(),
      endAt: new Date(base + 4 * 60 * 60_000).toISOString(),
      label: "原来较晚处理",
    }], "原计划");

    const result = await replanOwnedWorkSessions(env, principal, {
      plans: [
        {
          itemId: newPriority.id,
          sessions: [{
            startAt: new Date(base).toISOString(),
            endAt: new Date(base + 60 * 60_000).toISOString(),
            label: "先处理新优先事项",
          }],
        },
        {
          itemId: oldPriority.id,
          sessions: [{
            startAt: new Date(base + 60 * 60_000).toISOString(),
            endAt: new Date(base + 2 * 60 * 60_000).toISOString(),
            label: "随后继续原任务",
          }],
        },
      ],
      rationale: "用户当前状态和优先级变化，局部重排可移动工作段",
    }, controller);

    expect(result).toMatchObject({ scheduled: true, planCount: 2, sessionCount: 2 });
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      itemId: newPriority.id,
      reviewAt: new Date(base + 60 * 60_000).toISOString(),
    }));
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      itemId: oldPriority.id,
      reviewAt: new Date(base + 2 * 60 * 60_000).toISOString(),
    }));
    const newPrioritySessions = await listOwnedWorkSessions(env.DB, newPriority.id, principal.channel, principal.userId);
    const oldPrioritySessions = await listOwnedWorkSessions(env.DB, oldPriority.id, principal.channel, principal.userId);
    expect(newPrioritySessions.filter((session) => session.status === "planned")).toEqual([
      expect.objectContaining({ startAt: new Date(base).toISOString(), label: "先处理新优先事项" }),
    ]);
    expect(oldPrioritySessions.filter((session) => session.status === "planned")).toEqual([
      expect.objectContaining({ startAt: new Date(base + 60 * 60_000).toISOString(), label: "随后继续原任务" }),
    ]);
    await expect(getItem(env.DB, fixedMeeting.id)).resolves.toMatchObject({
      dueAt: new Date(base + 2 * 60 * 60_000).toISOString(),
      temporalRole: "event",
    });
  });

  it("keeps an existing plan intact when a coupled replan conflicts with a fixed event", async () => {
    const base = Date.now() + 8 * 24 * 60 * 60_000;
    const task = await createItem(env.DB, {
      type: "task",
      title: "可移动工作",
      content: "原计划仍然有效，除非整个新方案可提交",
      rawMessage: "可移动工作",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "atomic-replan-task",
    });
    await createItem(env.DB, {
      type: "task",
      title: "固定会面",
      content: "不能由工作计划工具移动",
      rawMessage: "固定会面",
      dueAt: new Date(base + 60 * 60_000).toISOString(),
      estimatedDuration: 60,
      temporalRole: "event",
      sourceChannel: principal.channel,
      sourceUserId: principal.userId,
      sourceMessageId: "atomic-replan-event",
    });
    const originalStart = new Date(base).toISOString();
    const originalEnd = new Date(base + 60 * 60_000).toISOString();
    await replaceWorkSessions(env.DB, task.id, [{ startAt: originalStart, endAt: originalEnd }], "原计划");

    const result = await replanOwnedWorkSessions(env, principal, {
      plans: [{
        itemId: task.id,
        sessions: [{
          startAt: new Date(base + 90 * 60_000).toISOString(),
          endAt: new Date(base + 150 * 60_000).toISOString(),
        }],
      }],
      rationale: "尝试移动到固定会面上",
    });

    expect(result).toMatchObject({ scheduled: false });
    await expect(listOwnedWorkSessions(env.DB, task.id, principal.channel, principal.userId)).resolves.toEqual([
      expect.objectContaining({ startAt: originalStart, endAt: originalEnd, status: "planned" }),
    ]);
  });

  it("does not replan another user's item", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "其他人的安排",
      content: "不能访问",
      rawMessage: "其他人的安排",
      sourceChannel: principal.channel,
      sourceUserId: "another-user",
      sourceMessageId: "private-calendar-replan",
    });
    const start = Date.now() + 9 * 24 * 60 * 60_000;

    await expect(replanOwnedWorkSessions(env, principal, {
      plans: [{
        itemId: item.id,
        sessions: [{
          startAt: new Date(start).toISOString(),
          endAt: new Date(start + 60 * 60_000).toISOString(),
        }],
      }],
      rationale: "不应成功",
    })).rejects.toThrow("not found");
  });
});
