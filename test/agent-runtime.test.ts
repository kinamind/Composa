import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseTurnPrincipal, stampTurnPrincipal, type AgentPrincipal } from "../src/agent/context";
import { DESK_IX_PERSONA } from "../src/agent/prompt";
import type { ComposaAgent } from "../src/agent/composa-agent";
import { forgetContextSchema, rememberContextSchema } from "../src/agent/tools/context-memory";
import {
  calendarReplanInputSchema,
  lifecycleFollowupInputSchema,
  profileUpdateSchema,
  reminderInputSchema,
  updateItemSchema,
  workSessionInputSchema,
} from "../src/agent/tools/write";

describe("ComposaAgent runtime", () => {
  it("uses natural model completion instead of a step-count cutoff", async () => {
    const agent = await getAgentByName(env.COMPOSA_AGENT, "qq:user-42");
    const profile = await agent.getRuntimeProfile();

    expect(profile).toEqual({
      runtime: "cloudflare-think",
      stepLimit: null,
      messageConcurrency: "queue",
      recovery: true,
      recoveryPolicy: "bounded",
      streamStallTimeoutMs: 0,
      immediateSubmissionDrain: true,
      sessionReady: true,
      mcpTools: false,
      workspaceBash: false,
      presentation: "attention-director-renderer",
      presentationFallback: "brief-then-backstage",
      presentationOrdering: "barrier-before-next-turn",
      skills: ["calendar-read", "calendar-plan", "calendar-manage", "calendar-review", "xiaohongshu-organize"],
    });
  });

  it("assembles the always-on Desk-IX persona together with loadable skills", async () => {
    const agent = await getAgentByName(env.COMPOSA_AGENT, "qq:prompt-owner");
    const system = await runInDurableObject(agent, (instance: ComposaAgent) => (
      instance.session.freezeSystemPrompt()
    ));

    expect(system).toContain("Desk-IX（拾序）");
    expect(system).toContain("历史候选事实");
    expect(system).toContain("calendar-plan");
  });

  it("persists the authenticated principal in Think turn metadata", () => {
    const principal: AgentPrincipal = {
      channel: "qq",
      userId: "qq-user-42",
      eventId: "qq-event-42",
      receivedAt: "2026-08-16T12:14:53.000Z",
    };
    const message = stampTurnPrincipal({
      id: "message-42",
      role: "user",
      parts: [{ type: "text", text: "更新刚才的记录" }],
    }, principal);
    expect(parseTurnPrincipal(message.metadata.turnMetadata)).toEqual(principal);
  });

  it("exposes an OpenAI-compatible object schema for reminder management", () => {
    const reminderSchema = z.toJSONSchema(reminderInputSchema);
    expect(reminderSchema.type).toBe("object");
    expect(reminderSchema.properties).not.toHaveProperty("timeSelection");
    expect(reminderSchema.properties).not.toHaveProperty("allowConflict");
    expect(z.toJSONSchema(lifecycleFollowupInputSchema)).toMatchObject({ type: "object" });
  });

  it("does not cap normal multi-source records or model-selected work-session counts", () => {
    expect(updateItemSchema.safeParse({
      itemId: "34e0fd26-fe66-4b84-bc26-4474fbca116e",
      provenance: {
        sourceUrls: Array.from({ length: 12 }, (_, index) => `https://example.com/source-${index}`),
      },
    }).success).toBe(true);
    expect(workSessionInputSchema.safeParse({
      operation: "replace",
      itemId: "34e0fd26-fe66-4b84-bc26-4474fbca116e",
      sessions: Array.from({ length: 25 }, (_, index) => ({
        startAt: new Date(Date.UTC(2026, 7, 18, index, 0)).toISOString(),
        endAt: new Date(Date.UTC(2026, 7, 18, index, 30)).toISOString(),
      })),
      rationale: "数量由任务与日程决定",
    }).success).toBe(true);
    const workSessionSchema = z.toJSONSchema(workSessionInputSchema);
    expect(workSessionSchema.properties).not.toHaveProperty("timeSelection");
    expect(workSessionSchema.properties).not.toHaveProperty("allowConflict");
    expect(z.toJSONSchema(calendarReplanInputSchema)).toMatchObject({ type: "object" });
  });

  it("has a stable Desk-IX persona and object-shaped profile action", () => {
    expect(DESK_IX_PERSONA).toContain("Desk-IX（拾序）");
    expect(DESK_IX_PERSONA).toContain("desk nine");
    expect(DESK_IX_PERSONA).toContain("长期搭档");
    expect(DESK_IX_PERSONA).toContain("[引用消息]");
    expect(DESK_IX_PERSONA).toContain("真实会话历史");
    expect(DESK_IX_PERSONA).toContain("recent_fallback");
    expect(DESK_IX_PERSONA).toContain("平台分享卡片");
    expect(DESK_IX_PERSONA).toContain("识别为“同一篇”只用于避免重复建记录");
    expect(DESK_IX_PERSONA).toContain("calendar-* 技能");
    expect(DESK_IX_PERSONA).toContain("截止时间、固定事件、提醒和实际投入工作的时段");
    expect(DESK_IX_PERSONA).toContain("media_read");
    expect(DESK_IX_PERSONA).toContain("context_remember");
    expect(DESK_IX_PERSONA).toContain("会议、材料和后续行动是不同对象");
    expect(DESK_IX_PERSONA).toContain("系统会重新唤醒你");
    expect(DESK_IX_PERSONA).toContain("不预先决定");
    expect(DESK_IX_PERSONA).toContain("后台认知与执行层");
    expect(DESK_IX_PERSONA).toContain("完整性属于后台状态");
    expect(DESK_IX_PERSONA).toContain("独立前台注意力层");
    expect(DESK_IX_PERSONA).toContain("不要用固定条数");
    expect(DESK_IX_PERSONA).toContain("同名人物");
    expect(DESK_IX_PERSONA).toContain("本轮时间锚点");
    expect(DESK_IX_PERSONA).toContain("午夜当成机械的语义分界");
    expect(DESK_IX_PERSONA).not.toContain("不要固定套用 14:00");
    expect(z.toJSONSchema(profileUpdateSchema)).toMatchObject({ type: "object" });
    expect(z.toJSONSchema(rememberContextSchema)).toMatchObject({ type: "object" });
    expect(z.toJSONSchema(forgetContextSchema)).toMatchObject({ type: "object" });
  });
});
