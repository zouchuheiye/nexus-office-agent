// Requirements: PR-009, PR-010, MR-046, MR-047, MR-048, AC-012, AC-013（P5：纪要→任务草稿）
import { describe, expect, it } from "vitest";
import { TaskDraftService } from "@/src/modules/agent/application/task-draft";
import { registerTaskDraftTools } from "@/src/modules/agent/application/task-draft-tools";
import type { ModelGateway, ModelRequest } from "@/src/modules/agent/domain/model-gateway";
import { UnavailableModelGateway } from "@/src/modules/agent/domain/model-gateway";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { createDefaultSkillRegistry } from "@/src/modules/agent/domain/skill";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

const MINUTES = [
  "华东上线准备会（2026-09-10）",
  "1. 周然负责在 2026-10-01 前完成灰度环境的压测报告，验收标准是报告含 P95 延迟与错误率。",
  "2. 林悦在 2026-09-30 前把客服话术库更新到 v2，验收标准是抽检 20 条全部通过。",
  "3. 陈屿跟进客户机房的门禁权限申请。",
].join("\n");

function scriptedModel(payload: unknown, extra?: Partial<{ provider: string; model: string }>): ModelGateway {
  return {
    async complete(request: ModelRequest) {
      expect(request.responseFormat).toBe("json");
      return {
        content: typeof payload === "string" ? payload : JSON.stringify(payload),
        provider: extra?.provider ?? "scripted", model: extra?.model ?? "draft-test",
        inputTokens: 100, outputTokens: 50, latencyMs: 12,
      };
    },
  };
}

const context = () => createDevelopmentRequestContext("task-draft");

describe("P5 纪要→任务草稿", () => {
  it("把模型返回的结构化草稿规范化：保留姓名提示、不编造 ID、未来时间保留、过去时间丢弃", async () => {
    const service = new TaskDraftService(scriptedModel({
      title: "华东上线准备",
      objective: "在华东环境完成上线前准备。",
      packages: [
        {
          title: "压测报告", description: "完成灰度压测并出报告。", acceptanceCriteria: "含 P95 延迟与错误率。",
          requiredSkills: ["压测"], assigneeName: "周然", priority: "high",
          dueAt: "2031-10-01T10:00:00.000Z", startedAt: "2031-09-01T00:00:00.000Z", estimatedDays: 5, capacityPoints: 3,
        },
        {
          title: "话术库更新", description: "更新客服话术库。", acceptanceCriteria: "抽检 20 条通过。",
          requiredSkills: ["客服"], assigneeName: "林悦", priority: "medium",
          // 模型给了过去时间：必须被丢弃并给出提醒，而不是让发布阶段撞库约束
          dueAt: "2020-01-01T00:00:00.000Z", startedAt: "2019-12-01T00:00:00.000Z", estimatedDays: 3,
        },
        { title: "门禁权限跟进" },
      ],
    }));

    const draft = await service.draftFromMinutes(context(), { text: MINUTES });
    expect(draft.source).toBe("model");
    expect(draft.title).toBe("华东上线准备");
    expect(draft.packages).toHaveLength(3);

    const [report, script, access] = draft.packages;
    expect(report).toMatchObject({ assignmentMode: "direct", assigneeName: "周然", dueAt: "2031-10-01T10:00:00.000Z", estimatedDays: 5, capacityPoints: 3, missingFields: [] });
    expect(script.dueAt).toBeUndefined();
    expect(script.missingFields).toContain("截止时间");
    expect(script.warnings.join()).toContain("已过期");
    expect(access).toMatchObject({ assignmentMode: "open_claim", missingFields: expect.arrayContaining(["任务说明", "验收标准", "所需技能", "截止时间"]) });
    // 草稿里绝不能出现任何 ID 字段
    expect(JSON.stringify(draft)).not.toMatch(/"[a-zA-Z]*[iI]d"\s*:/);
  });

  it("模型不可用时退化为按行拆候选，字段待补充但功能可用", async () => {
    const service = new TaskDraftService(new UnavailableModelGateway());
    const draft = await service.draftFromMinutes(context(), { text: MINUTES });
    expect(draft.source).toBe("fallback");
    expect(draft.packages.length).toBeGreaterThanOrEqual(3);
    expect(draft.notes.join()).toContain("模型当前不可用");
    expect(draft.packages[0].missingFields).toContain("验收标准");
    expect(draft.packages.every((item) => item.assignmentMode === "open_claim")).toBe(true);
  });

  it("模型返回不可解析内容时同样退化，而不是把整次导入打成失败", async () => {
    const service = new TaskDraftService(scriptedModel("抱歉，我无法完成这个请求。"));
    const draft = await service.draftFromMinutes(context(), { text: MINUTES });
    expect(draft.source).toBe("fallback");
    expect(draft.packages.length).toBeGreaterThanOrEqual(3);
  });

  it("纪要太短或没有可拆条目时给出明确错误", async () => {
    const service = new TaskDraftService(new UnavailableModelGateway());
    await expect(service.draftFromMinutes(context(), { text: "短" })).rejects.toThrow();
    await expect(service.draftFromMinutes(context(), { text: "标题：\n说明：" })).rejects.toThrow("TASK_DRAFT_UNAVAILABLE");
  });

  it("缺少 work_task:create 权限时拒绝", async () => {
    const service = new TaskDraftService(new UnavailableModelGateway());
    await expect(service.draftFromMinutes({ ...context(), permissions: [] }, { text: MINUTES })).rejects.toThrow("POLICY_DENIED:work_task:create");
  });

  it("注册为 work-orchestration 下的只读工具，且只产草稿不落库", async () => {
    const service = new TaskDraftService(scriptedModel({ title: "按需拆解", objective: "o", packages: [{ title: "任务一" }] }));
    const registry = new ToolRegistry();
    registerTaskDraftTools(registry, service);
    const registered = registry.available(context()).find((item) => item.id === "work.draft_tasks_from_minutes");
    expect(registered).toMatchObject({ skillId: "work-orchestration", riskLevel: 0, confirmationPolicy: "never", sideEffect: "none", requiredPermissions: ["work_task:create"] });
    expect(createDefaultSkillRegistry().forTool("work.draft_tasks_from_minutes")?.id).toBe("work-orchestration");
    const result = await registered!.execute(context(), { text: MINUTES }, undefined) as { source: string; packages: unknown[] };
    expect(result.source).toBe("model");
    expect(result.packages).toHaveLength(1);
  });
});
