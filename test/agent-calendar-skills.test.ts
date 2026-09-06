import { SkillRegistry } from "agents/skills";
import { describe, expect, it } from "vitest";
import { CALENDAR_SKILL_NAMES, calendarSkillSource } from "../src/agent/skills/calendar";

describe("calendar skill catalog", () => {
  it("publishes four focused on-demand skills with concrete trigger descriptions", async () => {
    const descriptors = await calendarSkillSource.list();

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(CALENDAR_SKILL_NAMES);
    expect(descriptors.every((descriptor) => descriptor.description.length > 60)).toBe(true);
    expect(descriptors.find((descriptor) => descriptor.name === "calendar-read")?.description).toContain("日程");
    expect(descriptors.find((descriptor) => descriptor.name === "calendar-plan")?.description).toContain("安排");
    expect(descriptors.find((descriptor) => descriptor.name === "calendar-manage")?.description).toContain("改期");
    expect(descriptors.find((descriptor) => descriptor.name === "calendar-review")?.description).toContain("复盘");
  });

  it("loads actionable instructions without fixed clock or session-count templates", async () => {
    const read = await calendarSkillSource.load("calendar-read");
    const plan = await calendarSkillSource.load("calendar-plan");
    const manage = await calendarSkillSource.load("calendar-manage");
    const review = await calendarSkillSource.load("calendar-review");

    expect(read?.body).toContain("calendar_snapshot");
    expect(read?.body).toContain("deadline");
    expect(plan?.body).toContain("availability_find");
    expect(plan?.body).toContain("work_session_manage");
    expect(plan?.body).not.toContain("14:00");
    expect(manage?.body).toContain("整体变更");
    expect(manage?.body).toContain("保持原时长");
    expect(review?.body).toContain("发生确定性");
    expect(review?.body).toContain("结果确定性");
    expect(review?.body).toContain("可靠唤醒 Agent");
    expect(review?.body).toContain("不预先决定“已经完成”");
    expect(review?.body).toContain("不能把上述判断改写成事项类别、标题关键词或固定置信度表");
    expect(plan?.body).toContain("不建立统一提前量或固定周期");
    expect(review?.body).toContain("进度同步是另一条独立通道");
    expect(review?.body).toContain("不要机械沿用上一次间隔");
  });

  it("builds the Think skill catalog and exposes activation tools", async () => {
    const registry = new SkillRegistry([calendarSkillSource]);
    await registry.load();

    const snapshot = await registry.snapshot();
    expect(snapshot.catalogPrompt).toContain("calendar-read");
    expect(snapshot.catalogPrompt).toContain("calendar-plan");
    expect(Object.keys(registry.tools())).toEqual(expect.arrayContaining([
      "activate_skill",
      "read_skill_resource",
    ]));
    expect(registry.warnings).toEqual([]);
  });
});
