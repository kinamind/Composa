import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { synthesizeTurnReply } from "../src/agent/finalize";
import type { AgentPrincipal } from "../src/agent/context";

const principal: AgentPrincipal = {
  channel: "qq",
  userId: "qq-user-42",
  eventId: "empty-turn-event",
  receivedAt: "2026-08-17T08:26:30.000Z",
};

describe("empty agent response finalization", () => {
  it("uses a text-only model pass to explain completed tool work", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return Response.json({
        model: "test-model",
        choices: [{ message: { content: "已经拆成两段不冲突的工作时间，并保留了截止日期。" } }],
        usage: { prompt_tokens: 30, completion_tokens: 18 },
      });
    };

    await expect(synthesizeTurnReply({ ...env, AI_API_KEY: "test-key" }, {
      principal,
      originalText: "20号之前准备好 proposal，别临近 ddl 做",
      responseParts: [{
        type: "tool-work_session_manage",
        state: "output-available",
        output: { scheduled: true, sessionCount: 2 },
      }],
      verifiedEffects: [{
        toolName: "work_session_manage",
        success: true,
        outcome: { scheduled: true, committed: true },
      }],
    }, fetcher)).resolves.toBe("已经拆成两段不冲突的工作时间，并保留了截止日期。");

    const requestBody = requestBodies[0]!;
    const messages = requestBody.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("后台回合恢复器");
    expect(messages[0]?.content).toContain("前台注意力层");
    expect(messages.at(-1)?.content).toContain("work_session_manage");
    expect(requestBody).not.toHaveProperty("tools");
    expect(requestBody).not.toHaveProperty("max_tokens");
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
  });
});
