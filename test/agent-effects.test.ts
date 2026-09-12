import { describe, expect, it } from "vitest";
import {
  buildXiaohongshuEffectFallback,
  nextXiaohongshuSourceTool,
  summarizeToolEffect,
} from "../src/agent/effects";

describe("verified Agent effects", () => {
  it("requires source acquisition for explicit Xiaohongshu turns without limiting later reasoning", () => {
    expect(nextXiaohongshuSourceTool([])).toBe("activate_skill");
    expect(nextXiaohongshuSourceTool([{
      toolName: "activate_skill",
      success: true,
      outcome: { skill: "xiaohongshu-organize", activated: true },
    }])).toBe("xiaohongshu_read");
    expect(nextXiaohongshuSourceTool([
      { toolName: "activate_skill", success: true, outcome: { activated: true } },
      { toolName: "xiaohongshu_read", success: true, outcome: { readCount: 1 } },
    ])).toBeNull();
  });

  it("records page and image outcomes without retaining URLs or source text", () => {
    const effect = summarizeToolEffect({
      toolName: "xiaohongshu_read",
      success: true,
      output: {
        requestedUrls: ["https://www.xiaohongshu.com/explore/private?xsec_token=sensitive"],
        posts: [{
          requestedUrl: "https://www.xiaohongshu.com/explore/private?xsec_token=sensitive",
          result: {
            status: "read",
            accountConfigured: true,
            authenticated: true,
            mediaTextStatus: "partially_extracted",
            analyzedImageCount: 7,
            skippedImageCount: 1,
            media: Array.from({ length: 8 }, () => ({ type: "image" })),
          },
        }],
        failures: [],
      },
    });

    expect(effect).toEqual({
      toolName: "xiaohongshu_read",
      success: true,
      outcome: {
        attemptedCount: 1,
        returnedCount: 1,
        readCount: 1,
        fetchFailureCount: 0,
        statuses: { read: 1 },
        reasonCodes: {},
        mediaTextStatuses: { partially_extracted: 1 },
        imageCount: 8,
        analyzedImageCount: 7,
        skippedImageCount: 1,
        accountConfigured: true,
        authenticated: true,
      },
    });
    expect(JSON.stringify(effect)).not.toContain("xsec_token");
    expect(buildXiaohongshuEffectFallback([effect])).toContain("没有全部解析");
    expect(buildXiaohongshuEffectFallback([effect])).toContain("没有把结果写入记录");
  });

  it("does not turn a spoken acknowledgement into a committed write", () => {
    const read = summarizeToolEffect({
      toolName: "xiaohongshu_read",
      success: true,
      output: {
        requestedUrls: ["https://www.xiaohongshu.com/explore/test"],
        posts: [{ result: {
          status: "session_expired",
          accountConfigured: true,
          authenticated: false,
        } }],
        failures: [],
      },
    });
    expect(buildXiaohongshuEffectFallback([read])).toContain("登录态失效");
    expect(buildXiaohongshuEffectFallback([read])).toContain("没有写入记录");
  });
});
