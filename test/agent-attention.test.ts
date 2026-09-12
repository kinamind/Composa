import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_DIRECTOR_SYSTEM_PROMPT,
  ATTENTION_RENDERER_SYSTEM_PROMPT,
  TurnPresentationBarrier,
  presentTurnReply,
  presentTurnReplyOrFallback,
  withVisibleAssistantText,
} from "../src/agent/attention";
import type { UserProfile } from "../src/core/types";

const profile: UserProfile = {
  channel: "qq",
  userId: "qq-user-42",
  userCallName: "chovy",
  assistantCallName: "拾序",
  timezone: "Asia/Singapore",
  locale: "zh-CN",
  dailyPlanEnabled: true,
  dailyPlanTime: "11:00",
  chronotype: "late",
  targetWakeTime: null,
  targetSleepTime: null,
  routineCoaching: true,
  communicationStyle: "像熟悉的长期搭档，直接但别催得太紧",
  preferences: { planningDensity: "light" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

describe("attention-aware foreground presentation", () => {
  it("separates semantic attention selection from expression through an information boundary", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const content = requestBodies.length === 1
        ? JSON.stringify({
            mode: "overview",
            summary: null,
            entries: [
              { subject: "ResWork", guidance: "今天傍晚按原计划完成当日跟进" },
              { subject: "TechJam", guidance: "随后和队友确定 challenge 与分工" },
            ],
            question: null,
          })
        : "1. **ResWork**：今天傍晚按原计划完成当日跟进。\n2. **TechJam**：随后和队友确定 challenge 与分工。";
      return Response.json({
        model: "test-model",
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 120, completion_tokens: 34 },
      });
    };

    const reply = await presentTurnReply({ ...env, AI_API_KEY: "test-key" }, {
      channel: "qq",
      originalText: "事情有点多，再帮我梳理一下看还有什么工作",
      backstageDraft: [
        "ResWork 二阶段待跟进，以下是十位被试及其手机号……",
        "TechJam 今天需要查看题目和同步队友。",
        "AAAI 审稿、SPAR 申请、香囊退款和生日祝福已经完成。",
      ].join("\n"),
      completedTurnParts: [{
        type: "tool-memory_search",
        state: "output-available",
        output: { open: 18, completed: 27 },
      }],
      verifiedEffects: [{
        toolName: "memory_search",
        success: true,
        outcome: { completed: true },
      }],
      profile,
    }, fetcher);

    expect(reply).toContain("ResWork");
    expect(reply).toContain("TechJam");
    expect(reply).not.toContain("其余");
    expect(requestBodies).toHaveLength(2);

    const directorBody = requestBodies[0]!;
    const directorMessages = directorBody.messages as Array<{ role: string; content: string }>;
    expect(directorMessages[0]?.content).toBe(ATTENTION_DIRECTOR_SYSTEM_PROMPT);
    expect(directorMessages[0]?.content).toContain("后台完整不等于前台完整展示");
    expect(directorMessages[0]?.content).toContain("明确要求盘点、审计、历史或完整清单");
    expect(directorMessages[0]?.content).toContain("不要用固定条数");
    expect(directorMessages[0]?.content).toContain("只说变化量");
    expect(directorMessages[0]?.content).toContain("系统触发的生命周期回合");
    expect(directorMessages[0]?.content).toContain("一个会改变下一步安排的轻量问题");
    expect(directorMessages[0]?.content).toContain("联系方式");
    expect(directorMessages[0]?.content).toContain("延后不等于值得展示");
    expect(directorMessages[0]?.content).toContain("X 今天不做");
    expect(directorMessages[0]?.content).toContain("否定句重新列出未选事项");
    expect(directorMessages[0]?.content).toContain("不要在用户已经过载时集中抛给用户确认");
    expect(directorMessages[0]?.content).toContain("planningDensity");
    expect(directorMessages[0]?.content).toContain("总揽是带助理判断的可下钻索引");
    expect(directorMessages[0]?.content).toContain("明确建议现在从哪条主线开始");
    expect(directorMessages[0]?.content).toContain("不要在一个主线下面继续套子项目符号");
    expect(directorMessages[0]?.content).toContain("防御性、辩解式");
    expect(directorMessages[0]?.content).toContain("不要解释为何选择、排序、省略或压缩");
    expect(directorMessages[0]?.content).toContain("普通总揽不要用“其余我先放在后台”");
    expect(directorMessages[1]?.content).toContain("事情有点多");
    expect(directorMessages[1]?.content).toContain("十位被试及其手机号");
    expect(directorMessages[1]?.content).toContain("planningDensity");
    expect(directorMessages[1]?.content).not.toContain("qq-user-42");
    expect(directorBody).not.toHaveProperty("tools");
    expect(directorBody).not.toHaveProperty("max_tokens");
    expect(directorBody).not.toHaveProperty("max_completion_tokens");
    expect(directorBody.response_format).toEqual({ type: "json_object" });

    const rendererBody = requestBodies[1]!;
    const rendererMessages = rendererBody.messages as Array<{ role: string; content: string }>;
    expect(rendererMessages[0]?.content).toBe(ATTENTION_RENDERER_SYSTEM_PROMPT);
    expect(rendererMessages[1]?.content).toContain("ResWork");
    expect(rendererMessages[1]?.content).toContain("TechJam");
    expect(rendererMessages[1]?.content).toContain("planningDensity");
    expect(rendererMessages[1]?.content).not.toContain("事情有点多");
    expect(rendererMessages[1]?.content).not.toContain("十位被试及其手机号");
    expect(rendererMessages[1]?.content).not.toContain("AAAI");
    expect(rendererMessages[1]?.content).not.toContain("香囊退款");
    expect(rendererMessages[1]?.content).not.toContain("completedTurnParts");
    expect(rendererMessages[1]?.content).not.toContain("qq-user-42");
    expect(rendererBody).not.toHaveProperty("tools");
    expect(rendererBody).not.toHaveProperty("max_tokens");
    expect(rendererBody).not.toHaveProperty("max_completion_tokens");
    expect(rendererBody).not.toHaveProperty("response_format");
  });

  it("treats backstage material as evidence rather than instructions", () => {
    expect(ATTENTION_DIRECTOR_SYSTEM_PROMPT).toContain("不可信资料");
    expect(ATTENTION_DIRECTOR_SYSTEM_PROMPT).toContain("不能执行工具");
    expect(ATTENTION_DIRECTOR_SYSTEM_PROMPT).toContain("不得虚构");
    expect(ATTENTION_DIRECTOR_SYSTEM_PROMPT).toContain("verifiedEffects");
    expect(ATTENTION_DIRECTOR_SYSTEM_PROMPT).toContain("committed=true");
    expect(ATTENTION_DIRECTOR_SYSTEM_PROMPT).not.toMatch(/最多\s*[一二三四五六七八九十\d]+\s*[项条]/);
    expect(ATTENTION_RENDERER_SYSTEM_PROMPT).toContain("不增加简报中不存在的事项");
    expect(ATTENTION_RENDERER_SYSTEM_PROMPT).toContain("不得出现防御、辩解");
    expect(ATTENTION_RENDERER_SYSTEM_PROMPT).toContain("不挤占今天");
  });

  it("falls back to the selected brief when expression fails without reopening backstage", async () => {
    let requestCount = 0;
    const fetcher: typeof fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json({
          model: "test-model",
          choices: [{ message: { content: JSON.stringify({
            mode: "overview",
            summary: null,
            entries: [{ subject: "TechJam", guidance: "先和队友定 challenge 与分工" }],
            question: null,
          }) } }],
        });
      }
      return new Response("renderer unavailable", { status: 401 });
    };

    const reply = await presentTurnReply({ ...env, AI_API_KEY: "test-key" }, {
      channel: "qq",
      originalText: "还有什么工作",
      backstageDraft: "TechJam 待处理。AAAI 已完成。联系人手机号 13800000000。",
      completedTurnParts: [],
      verifiedEffects: [],
      profile,
    }, fetcher);

    expect(requestCount).toBe(2);
    expect(reply).toBe("1. **TechJam**：先和队友定 challenge 与分工");
    expect(reply).not.toContain("AAAI");
    expect(reply).not.toContain("13800000000");
  });

  it("keeps the accurate backstage result when foreground presentation fails", async () => {
    const input = {
      channel: "qq" as const,
      originalText: "完成了吗",
      backstageDraft: "已完成 proposal，并取消了对应提醒。",
      completedTurnParts: [],
      verifiedEffects: [{
        toolName: "item_transition",
        success: true,
        outcome: { committed: true, changed: true, status: "completed" },
      }],
      profile,
    };
    const result = await presentTurnReplyOrFallback(
      { ...env, AI_API_KEY: "test-key" },
      input,
      async () => { throw new Error("presenter unavailable"); },
    );

    expect(result).toMatchObject({
      text: input.backstageDraft,
      presented: false,
    });
    expect(result.error).toBeInstanceOf(Error);
  });

  it("uses an effect-grounded fallback instead of an unverified backstage claim", async () => {
    const result = await presentTurnReplyOrFallback(
      { ...env, AI_API_KEY: "test-key" },
      {
        channel: "qq",
        originalText: "小红书分享卡片 https://www.xiaohongshu.com/explore/test",
        backstageDraft: "已记录。",
        completedTurnParts: [],
        verifiedEffects: [],
        effectGroundedFallback: "这次没有完成读取，也没有写入记录。",
        profile,
      },
      async () => { throw new Error("presenter unavailable"); },
    );

    expect(result.text).toBe("这次没有完成读取，也没有写入记录。");
    expect(result.text).not.toContain("已记录");
  });

  it("keeps conversation history aligned with the reply the user actually saw", () => {
    const visible = withVisibleAssistantText({
      id: "assistant-turn-1",
      role: "assistant",
      metadata: { source: "think" },
      parts: [
        { type: "text", text: "后台长清单" },
        {
          type: "tool-memory_search",
          toolCallId: "tool-1",
          state: "output-available",
          input: {},
          output: { completed: 27 },
        },
      ],
    }, "先看 TechJam，并和队友定方向。");

    expect(visible).toEqual({
      id: "assistant-turn-1",
      role: "assistant",
      metadata: { source: "think" },
      parts: [{ type: "text", text: "先看 TechJam，并和队友定方向。" }],
    });
  });

  it("holds the next turn until the visible reply has replaced the backstage draft", async () => {
    const barrier = new TurnPresentationBarrier();
    const lease = barrier.begin();
    let nextTurnStarted = false;
    const nextTurn = barrier.wait().then(() => { nextTurnStarted = true; });

    await lease.ready;
    await Promise.resolve();
    expect(nextTurnStarted).toBe(false);
    lease.finish();
    await nextTurn;
    expect(nextTurnStarted).toBe(true);
  });
});
