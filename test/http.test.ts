import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ReminderWorkflowPayload } from "../src/core/types";
import { createItem } from "../src/db/items";
import { routeRequest } from "../src/http/router";
import { replaceWorkSessions } from "../src/db/work-sessions";

class FakeWorkflowInstance implements WorkflowInstance {
  public constructor(public id: string) {}
  public pause(): Promise<void> { return Promise.resolve(); }
  public resume(): Promise<void> { return Promise.resolve(); }
  public terminate(): Promise<void> { return Promise.resolve(); }
  public restart(): Promise<void> { return Promise.resolve(); }
  public delete(): Promise<void> { return Promise.resolve(); }
  public status(): Promise<InstanceStatus> { return Promise.resolve({ status: "waiting" }); }
  public sendEvent(): Promise<void> { return Promise.resolve(); }
}

class FakeWorkflow implements Workflow<ReminderWorkflowPayload> {
  public readonly creates: WorkflowInstanceCreateOptions<ReminderWorkflowPayload>[] = [];
  public get(id: string): Promise<WorkflowInstance> { return Promise.resolve(new FakeWorkflowInstance(id)); }
  public create(options: WorkflowInstanceCreateOptions<ReminderWorkflowPayload> = {}): Promise<WorkflowInstance> {
    this.creates.push(options);
    return Promise.resolve(new FakeWorkflowInstance(options.id ?? "generated"));
  }
  public createBatch(batch: WorkflowInstanceCreateOptions<ReminderWorkflowPayload>[]): Promise<WorkflowInstance[]> {
    this.creates.push(...batch);
    return Promise.resolve(batch.map((options) => new FakeWorkflowInstance(options.id ?? "generated")));
  }
  public deleteBatch(instanceIds: string[]): Promise<WorkflowBatchDeleteResult> {
    return Promise.resolve({ deleted: instanceIds.map((id) => ({ id })), errors: [] });
  }
}

describe("HTTP router", () => {
  it("reports health without leaking secrets", async () => {
    const ctx = createExecutionContext();
    const response = await routeRequest(new Request("https://worker.test/health"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      ok: true,
      service: "Desk-IX",
      channels: { telegram: true, qq: true },
      integrations: { xiaohongshu: { configured: true } },
      ai: { configured: false, verified: false },
    });
    expect(JSON.stringify(body)).not.toContain("test-admin-token");
    expect(JSON.stringify(body)).not.toContain("test-session");
  });

  it("protects admin routes with a bearer token", async () => {
    const unauthorizedContext = createExecutionContext();
    const unauthorized = await routeRequest(new Request("https://worker.test/api/items"), env, unauthorizedContext);
    expect(unauthorized.status).toBe(401);

    const authorizedContext = createExecutionContext();
    const authorized = await routeRequest(new Request("https://worker.test/api/items", {
      headers: { Authorization: "Bearer test-admin-token" },
    }), env, authorizedContext);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ items: [] });
  });

  it("accepts QQ challenges through the stable /desk route", async () => {
    const ctx = createExecutionContext();
    const response = await routeRequest(new Request("https://kinamind.org/desk/webhooks/qq", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bot-Appid": "test-app",
      },
      body: JSON.stringify({ op: 13, d: { plain_token: "desk-route", event_ts: "1786894200" } }),
    }), env, ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ plain_token: "desk-route" });
  });

  it("reschedules an item through the protected Workflow-backed admin route", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "需要错开的提醒",
      content: "维护改期",
      rawMessage: "维护改期",
      sourceChannel: "qq",
      sourceUserId: "qq-user-42",
      sourceMessageId: "admin-reminder-route",
    });
    const workflow = new FakeWorkflow();
    const requestEnv: Env = { ...env, REMINDER_WORKFLOW: workflow };
    const ctx = createExecutionContext();
    const remindAt = "2030-08-17T07:30:00.000Z";
    const response = await routeRequest(new Request(`https://worker.test/api/items/${item.id}/reminder`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-admin-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ remindAt, kind: "maintenance_reschedule" }),
    }), requestEnv, ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, remindAt });
    expect(workflow.creates).toHaveLength(1);
    expect(workflow.creates[0]?.params?.remindAt).toBe(remindAt);
  });

  it("synchronizes a future item's lifecycle review through the protected admin route", async () => {
    const item = await createItem(env.DB, {
      type: "task",
      title: "存量未来工作",
      content: "补装生命周期复盘",
      rawMessage: "补装生命周期复盘",
      sourceChannel: "qq",
      sourceUserId: "qq-user-42",
      sourceMessageId: "admin-lifecycle-review-route",
    });
    const endAt = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    await replaceWorkSessions(env.DB, item.id, [{
      startAt: new Date(Date.now() + 47 * 60 * 60_000).toISOString(),
      endAt,
    }], "已有未来工作时段");
    const ctx = createExecutionContext();
    const response = await routeRequest(new Request(
      `https://worker.test/api/items/${item.id}/lifecycle-review`,
      {
        method: "POST",
        headers: { Authorization: "Bearer test-admin-token" },
      },
    ), env, ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      lifecycleReview: {
        scheduled: true,
        reviewAt: endAt,
        basis: "work_plan_end",
      },
    });
  });
});
