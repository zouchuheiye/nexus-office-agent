// Requirements: PR-009, PR-010, PR-012, MR-046, MR-047, MR-048, MR-049, MR-050, AR-011, SR-007, AC-012, AC-013
import { describe, expect, it } from "vitest";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { DEMO_DELIVERY_OWNER_ID, DEMO_PRODUCT_OWNER_ID, InMemoryTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import { collectTaskReminderCandidates, type WorkPackage } from "@/src/modules/task-command/domain/task-command";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { registerTaskCommandTools } from "@/src/modules/task-command/application/agent-tools";

async function fixture() {
  const service = new TaskCommandService(new InMemoryTaskCommandRepository());
  const publisher = createDevelopmentRequestContext("reminder-export-test");
  const conversation = (await service.workspace(publisher)).conversation;
  return { service, publisher, conversation };
}

function basePackage(overrides: Partial<WorkPackage>): WorkPackage {
  const now = new Date().toISOString();
  return {
    id: "80000000-0000-4000-8000-000000000001",
    tenantId: "00000000-0000-4000-8000-000000000001",
    missionId: "81000000-0000-4000-8000-000000000001",
    ordinal: 1,
    title: "测试任务",
    description: "用于提醒扫描测试。",
    acceptanceCriteria: "验收标准。",
    requiredSkills: ["测试"],
    assignmentMode: "open_claim",
    publishedBy: DEMO_MANAGER_ID,
    isTemplate: false,
    missingFields: [],
    priority: "medium",
    dueAt: now,
    startedAt: now,
    estimatedDays: 3,
    capacityPoints: 1,
    status: "published",
    evidenceRefs: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("D-043: 后台到期提醒 / 负载 / 报表 / 周期摘要", () => {
  it("collectTaskReminderCandidates 纯逻辑：临期、逾期、阻塞升级分类正确", () => {
    const now = new Date();
    const iso = (offsetHours: number) => new Date(now.getTime() + offsetHours * 3_600_000).toISOString();
    const packages = [
      basePackage({ id: "a1", dueAt: iso(-48), status: "in_progress", assigneeId: DEMO_DELIVERY_OWNER_ID }),
      basePackage({ id: "a2", dueAt: iso(24), status: "in_progress", assigneeId: DEMO_DELIVERY_OWNER_ID }),
      basePackage({ id: "a3", dueAt: iso(24 * 10), status: "in_progress" }),
      basePackage({ id: "a4", dueAt: iso(-48), status: "blocked", blockedReason: "等待客户接口", updatedAt: new Date(now.getTime() - 48 * 3_600_000).toISOString() }),
      basePackage({ id: "a5", dueAt: iso(-48), status: "completed" }),
      basePackage({ id: "a6", dueAt: iso(24), isTemplate: true }),
    ];
    const candidates = collectTaskReminderCandidates(packages, { now, dueSoonHours: 72, blockedEscalationHours: 24 });
    expect(candidates.find((item) => item.package.id === "a1")?.kind).toBe("overdue");
    expect(candidates.find((item) => item.package.id === "a2")?.kind).toBe("due_soon");
    expect(candidates.find((item) => item.package.id === "a3")).toBeUndefined();
    expect(candidates.find((item) => item.package.id === "a4")?.kind).toBe("blocked_escalation");
    expect(candidates.find((item) => item.package.id === "a5")).toBeUndefined();
    expect(candidates.find((item) => item.package.id === "a6")).toBeUndefined();
  });

  it("F-084: memberWorkload 返回进行中/临期/容量点，负载过高时定向分派返回 warnings", async () => {
    const { service, publisher, conversation } = await fixture();
    for (let index = 0; index < 5; index += 1) {
      await service.publishMission(publisher, {
        conversationId: conversation.id,
        title: `负载任务 ${index}`,
        objective: "累积负载。",
        priority: "medium",
        dueAt: "2030-12-01T00:00:00.000Z",
        packages: [{
          title: `负载包 ${index}`, description: "负载。", acceptanceCriteria: "完成。", requiredSkills: ["交付"],
          assignmentMode: "direct", assigneeId: DEMO_DELIVERY_OWNER_ID, priority: "medium",
          dueAt: "2030-12-01T00:00:00.000Z", startedAt: "2030-11-01T00:00:00.000Z", estimatedDays: 5, capacityPoints: 4,
        }],
      });
    }
    const people = await service.memberWorkload(publisher);
    const target = people.find((item) => item.id === DEMO_DELIVERY_OWNER_ID);
    expect(target?.inProgressTaskCount).toBe(5);
    expect(target?.capacityPoints).toBe(20);
    const result = await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "负载超标分派",
      objective: "验证负载警告。",
      priority: "low",
      dueAt: "2030-12-01T00:00:00.000Z",
      packages: [{
        title: "再派一个", description: "验证。", acceptanceCriteria: "完成。", requiredSkills: ["交付"],
        assignmentMode: "direct", assigneeId: DEMO_DELIVERY_OWNER_ID, priority: "low",
        dueAt: "2030-12-01T00:00:00.000Z", startedAt: "2030-11-01T00:00:00.000Z", estimatedDays: 2, capacityPoints: 1,
      }],
    });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("负载较高");
  });

  it("F-086: exportReport 支持按负责人/项目/时段过滤并返回表头与行", async () => {
    const { service, publisher, conversation } = await fixture();
    const bundle = await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "导出任务",
      objective: "导出验证。",
      priority: "high",
      dueAt: "2030-12-01T00:00:00.000Z",
      packages: [{
        title: "导出包 A", description: "A。", acceptanceCriteria: "完成。", requiredSkills: ["交付"],
        assignmentMode: "direct", assigneeId: DEMO_DELIVERY_OWNER_ID, priority: "high",
        dueAt: "2030-12-01T00:00:00.000Z", startedAt: "2030-11-01T00:00:00.000Z", estimatedDays: 5, capacityPoints: 3,
      }],
    });
    const all = await service.exportReport(publisher, {});
    expect(all.headers).toContain("任务ID");
    expect(all.rows.length).toBe(1);
    const byAssignee = await service.exportReport(publisher, { assigneeId: DEMO_PRODUCT_OWNER_ID });
    expect(byAssignee.rows.length).toBe(0);
    const byMission = await service.exportReport(publisher, { missionId: bundle.mission.id });
    expect(byMission.rows.length).toBe(1);
    const byPeriod = await service.exportReport(publisher, { from: "2030-11-01T00:00:00.000Z", to: "2030-12-31T00:00:00.000Z" });
    expect(byPeriod.rows.length).toBe(1);
  });

  it("F-086/P0: exportReport 支持 scope/status/overdueOnly 过滤器并与任务表筛选项一致", async () => {
    const { service, publisher, conversation } = await fixture();
    const nowMs = Date.now();
    const iso = (offsetDays: number) => new Date(nowMs + offsetDays * 86_400_000).toISOString();
    const bundle = await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "导出过滤任务",
      objective: "导出过滤验证。",
      priority: "high",
      dueAt: "2030-12-01T00:00:00.000Z",
      packages: [
        { title: "我负责·已逾期", description: "B。", acceptanceCriteria: "完成。", requiredSkills: ["交付"], assignmentMode: "direct", assigneeId: DEMO_DELIVERY_OWNER_ID, priority: "high", dueAt: iso(-2), startedAt: iso(-30), estimatedDays: 2, capacityPoints: 1 },
        { title: "我发布·进行中", description: "C。", acceptanceCriteria: "完成。", requiredSkills: ["交付"], assignmentMode: "direct", assigneeId: DEMO_PRODUCT_OWNER_ID, priority: "medium", dueAt: iso(10), startedAt: iso(-5), estimatedDays: 5, capacityPoints: 2 },
        { title: "我发布·已完成", description: "D。", acceptanceCriteria: "完成。", requiredSkills: ["交付"], assignmentMode: "direct", assigneeId: DEMO_MANAGER_ID, priority: "low", dueAt: iso(10), startedAt: iso(-5), estimatedDays: 5, capacityPoints: 1 },
      ],
    });
    const taskIds = bundle.packages.map(({ id }) => id);
    // 直派包初始为 assigned；把第三包按合法路径推进到 completed（in_progress→completed 需证据）
    const running = await service.transitionPackage(publisher, taskIds[2], { expectedVersion: 1, nextStatus: "in_progress" });
    await service.transitionPackage(publisher, taskIds[2], { expectedVersion: running.version, nextStatus: "completed", evidenceRefs: ["document:export-accepted"] });
    // 发布方视角：全部 + status + overdueOnly
    const byStatus = await service.exportReport(publisher, { status: "completed" });
    expect(byStatus.rows.map(({ id }) => id)).toEqual([taskIds[2]]);
    const overdueRows = await service.exportReport(publisher, { overdueOnly: "true" });
    expect(overdueRows.rows.map(({ id }) => id)).toEqual([taskIds[0]]);
    // scope=published 只保留我发布（三条）；scope=mine 需要交付负责人身份
    const publishedScope = await service.exportReport(publisher, { scope: "published" });
    expect(publishedScope.rows.length).toBe(3);
    const delivery = { ...createDevelopmentRequestContext("export-delivery"), actorId: DEMO_DELIVERY_OWNER_ID };
    const deliveryMine = await service.exportReport(delivery, { scope: "mine" });
    expect(deliveryMine.rows.map(({ id }) => id)).toEqual([taskIds[0]]);
    const deliveryPublished = await service.exportReport(delivery, { scope: "published" });
    expect(deliveryPublished.rows).toEqual([]);
    const combined = await service.exportReport(delivery, { scope: "mine", status: "completed" });
    expect(combined.rows).toEqual([]);
    void conversation;
  });

  it("提醒扫描：临期/逾期任务发布公司池提醒，且按天幂等去重", async () => {
    const { service, publisher, conversation } = await fixture();
    const now = new Date();
    const iso = (offsetHours: number) => new Date(now.getTime() + offsetHours * 3_600_000).toISOString();
    await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "提醒任务",
      objective: "验证提醒。",
      priority: "high",
      dueAt: iso(24),
      packages: [
        { title: "临期包", description: "快到期。", acceptanceCriteria: "完成。", requiredSkills: ["交付"], assignmentMode: "open_claim", priority: "high", dueAt: iso(24), startedAt: iso(-48), estimatedDays: 3, capacityPoints: 1 },
        { title: "逾期包", description: "已逾期。", acceptanceCriteria: "完成。", requiredSkills: ["交付"], assignmentMode: "open_claim", priority: "high", dueAt: iso(-72), startedAt: iso(-168), estimatedDays: 3, capacityPoints: 1 },
      ],
    });
    const first = await service.runReminderScan(publisher, { now: now.toISOString(), dueSoonHours: 72 });
    expect(first.scanned).toBe(2);
    expect(first.created).toBe(2);
    const second = await service.runReminderScan(publisher, { now: now.toISOString(), dueSoonHours: 72 });
    expect(second.created).toBe(0);
    expect(second.deduplicated).toBe(2);
    const workspace = await service.workspace(publisher);
    const company = workspace.messagePools.find(({ key }) => key === "company");
    expect(company?.messages.some(({ subject }) => subject.includes("任务临期提醒"))).toBe(true);
    expect(company?.messages.some(({ subject }) => subject.includes("任务逾期提醒"))).toBe(true);
  });

  it("F-083/E-151: 周期摘要面向整个租户、以系统署名发布并按周期幂等", async () => {
    const { service, publisher, conversation } = await fixture();
    await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "摘要任务",
      objective: "验证摘要。",
      priority: "medium",
      dueAt: "2030-12-01T00:00:00.000Z",
      packages: [{
        title: "摘要包", description: "摘要。", acceptanceCriteria: "完成。", requiredSkills: ["交付"],
        assignmentMode: "direct", assigneeId: DEMO_DELIVERY_OWNER_ID, priority: "medium",
        dueAt: "2030-12-01T00:00:00.000Z", startedAt: "2030-11-01T00:00:00.000Z", estimatedDays: 5, capacityPoints: 2,
      }],
    });
    const summary = await service.generateScheduledSummary({ tenantId: DEMO_TENANT_ID, scope: "daily" });
    expect(summary.created).toBe(true);
    expect(summary.attribution).toBe("system");
    expect(summary.summary).toContain("工作进度摘要");
    expect(summary.summary).toContain("在办任务");
    // 公司池里这条摘要是系统署名，不指向任何同事
    const company = (await service.workspace(publisher)).messagePools.find(({ key }) => key === "company");
    const posted = company?.messages.find(({ subject }) => subject.includes("工作进度摘要"));
    expect(posted).toBeDefined();
    expect(posted).toMatchObject({ authorType: "system", source: "system" });
    expect(posted?.authorId).toBeUndefined();
    // 同一周期重复发布只会得到一条
    const again = await service.generateScheduledSummary({ tenantId: DEMO_TENANT_ID, scope: "daily" });
    expect(again.created).toBe(false);
    expect(again.messageId).toBe(summary.messageId);
  });

  it("F-084: work.get_member_workload 工具已注册并可调用", async () => {
    const { service, publisher } = await fixture();
    const registry = new ToolRegistry();
    registerTaskCommandTools(registry, service);
    const tool = registry.available(publisher).find((item) => item.id === "work.get_member_workload");
    expect(tool).toBeDefined();
    const people = await tool!.execute(publisher, {}, undefined);
    expect(Array.isArray(people)).toBe(true);
  });
});
