// Requirements: PR-009, PR-010, MR-046, MR-047, MR-048, AC-012, AC-013（P5：纪要批量导入的 HTTP 契约与发布衔接）
import { describe, expect, it } from "vitest";
import { POST as draftTasks } from "@/app/api/v1/agent/task-drafts/route";
import { POST as publishMission } from "@/app/api/v1/task-command/missions/route";
import { GET as getWorkspace } from "@/app/api/v1/task-command/workspace/route";

const MINUTES = [
  "华东上线准备会",
  "1. 完成灰度环境的压测报告",
  "2. 更新客服话术库到 v2",
  "3. 跟进客户机房门禁权限",
].join("\n");

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-trace-id": "task-draft-api-test" }, body: JSON.stringify(body) });
}

describe("P5 纪要批量导入 HTTP 契约", () => {
  it("拆出草稿但不落库：workspace 在草稿前后不新增任何任务", async () => {
    const before = (await (await getWorkspace(new Request("http://localhost/api/v1/task-command/workspace"))).json()).data.publishedByMe.length;
    const response = await draftTasks(jsonRequest("http://localhost/api/v1/agent/task-drafts", { text: MINUTES }));
    expect(response.status).toBe(200);
    const draft = (await response.json()).data as { source: string; packages: Array<{ title: string; missingFields: string[]; assignmentMode: string }>; notes: string[] };
    expect(draft.packages.length).toBeGreaterThanOrEqual(3);
    expect(draft.packages.every((item) => item.assignmentMode === "open_claim")).toBe(true);
    expect(draft.packages.every((item) => item.missingFields.length > 0)).toBe(true);
    const after = (await (await getWorkspace(new Request("http://localhost/api/v1/task-command/workspace"))).json()).data.publishedByMe.length;
    expect(after).toBe(before);
  });

  it("确认后的草稿可以直接发布：只发布选中的条目，缺失字段继续标待补充", async () => {
    const draft = (await (await draftTasks(jsonRequest("http://localhost/api/v1/agent/task-drafts", { text: MINUTES }))).json()).data as { packages: Array<{ title: string }> };
    const workspace = (await (await getWorkspace(new Request("http://localhost/api/v1/task-command/workspace"))).json()).data;
    const selected = draft.packages.slice(0, 2);
    const marker = crypto.randomUUID().slice(0, 8);
    const published = await publishMission(jsonRequest("http://localhost/api/v1/task-command/missions", {
      conversationId: workspace.conversation.id,
      title: `纪要导入验收 ${marker}`,
      objective: "验证逐条确认后只发布选中的条目。",
      priority: "medium",
      dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      packages: selected.map((item) => ({ title: `${item.title} ${marker}`, assignmentMode: "open_claim", priority: "medium", capacityPoints: 1 })),
    }));
    const payload = await published.json();
    expect(published.status).toBe(201);
    expect(payload.data.packages).toHaveLength(2);
    expect(payload.data.packages.every((item: { missingFields: string[] }) => item.missingFields.length > 0)).toBe(true);
    // 只发布选中的两条：未选中的条目没有进入任务事实源
    const after = (await (await getWorkspace(new Request("http://localhost/api/v1/task-command/workspace"))).json()).data.publishedByMe as Array<{ title: string }>;
    const imported = after.filter((item) => item.title.includes(marker));
    expect(imported).toHaveLength(2);
    expect(imported.map((item) => item.title)).toEqual(selected.map((item) => `${item.title} ${marker}`));
  });

  it("纪要过短被拒绝（422 而不是 500）", async () => {
    const response = await draftTasks(jsonRequest("http://localhost/api/v1/agent/task-drafts", { text: "太短" }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
