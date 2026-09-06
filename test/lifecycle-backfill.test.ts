import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { agentSessionName } from "../src/agent/ingress";
import type { ComposaAgent } from "../src/agent/composa-agent";
import { runLifecycleBoundaryBackfill } from "../src/core/lifecycle-backfill";
import { createItem } from "../src/db/items";
import { replaceWorkSessions } from "../src/db/work-sessions";
import { isLifecycleFollowupSchedule } from "../src/agent/followups";

describe("lifecycle boundary compatibility backfill", () => {
  it("schedules only future legacy plans once and remains silent", async () => {
    const channel = "qq" as const;
    const userId = "lifecycle-backfill-user";
    const item = await createItem(env.DB, {
      type: "task",
      title: "已经排好的未来工作",
      content: "兼容上线前保存的计划",
      rawMessage: "兼容上线前保存的计划",
      sourceChannel: channel,
      sourceUserId: userId,
      sourceMessageId: "future-work-before-lifecycle-release",
    });
    const endAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    await replaceWorkSessions(env.DB, item.id, [{
      startAt: new Date(Date.now() + 47 * 60 * 60_000).toISOString(),
      endAt,
    }], "已存在的未来计划");
    const past = await createItem(env.DB, {
      type: "task",
      title: "过去的固定事件",
      content: "不得被重新唤醒",
      rawMessage: "过去的固定事件",
      dueAt: "2026-01-01T10:00:00.000Z",
      estimatedDuration: 60,
      temporalRole: "event",
      sourceChannel: channel,
      sourceUserId: userId,
      sourceMessageId: "past-event-before-lifecycle-release",
    });

    await expect(runLifecycleBoundaryBackfill(env)).resolves.toEqual({ ran: true, synchronized: 1 });
    await expect(runLifecycleBoundaryBackfill(env)).resolves.toEqual({ ran: false, synchronized: 0 });

    const name = await agentSessionName(channel, userId);
    const agent = await getAgentByName<Env, ComposaAgent>(env.COMPOSA_AGENT, name);
    const schedules = await runInDurableObject(agent, (instance: ComposaAgent) => (
      instance.listSchedules({ type: "scheduled" })
    ));
    expect(schedules.some((schedule) => isLifecycleFollowupSchedule(schedule, item.id, "boundary"))).toBe(true);
    expect(schedules.some((schedule) => isLifecycleFollowupSchedule(schedule, past.id))).toBe(false);
  });
});
