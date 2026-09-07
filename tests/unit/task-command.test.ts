// Requirements: PR-009, PR-010, PR-012, MR-046, MR-047, MR-048, MR-049, MR-050, AR-011, SR-007, AC-012, AC-013
import { describe, expect, it } from "vitest";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { DEMO_DELIVERY_OWNER_ID, DEMO_OPERATIONS_OWNER_ID, DEMO_PRODUCT_ORG_ID, DEMO_PRODUCT_OWNER_ID, InMemoryTaskCommandRepository } from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";
import { createMissionBundle, createTaskTemplateBundle } from "@/src/modules/task-command/domain/task-command";
import { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { registerTaskCommandTools } from "@/src/modules/task-command/application/agent-tools";

async function fixture() {
  const service = new TaskCommandService(new InMemoryTaskCommandRepository());
  const publisher = createDevelopmentRequestContext("task-command-test");
  const conversation = (await service.workspace(publisher)).conversation;
  return { service, publisher, conversation };
}

function missionInput(conversationId: string) {
  return {
    conversationId,
    title: "客户验收闭环",
    objective: "在本周内完成客户验收材料、联调和签字闭环。",
    priority: "high" as const,
    dueAt: "2030-08-18T10:00:00.000Z",
    packages: [
      {
        title: "整理验收证据",
        description: "汇总功能清单、测试结果和遗留项。",
        acceptanceCriteria: "形成客户可签字的验收证据包。",
        requiredSkills: ["交付", "测试"],
        assignmentMode: "open_claim" as const,
startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7,         priority: "high" as const,
        dueAt: "2030-08-16T10:00:00.000Z",
        capacityPoints: 3,
      },
      {
        title: "确认产品遗留项",
        description: "逐项确认遗留项处置口径。",
        acceptanceCriteria: "所有遗留项都有责任人与承诺日期。",
        requiredSkills: ["产品"],
        assignmentMode: "direct" as const,
        assigneeId: DEMO_PRODUCT_OWNER_ID,
startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7,         priority: "medium" as const,
        dueAt: "2030-08-15T10:00:00.000Z",
        capacityPoints: 2,
      },
    ],
  };
}

describe("real-time task command domain", () => {
  it("publishes direct and open-claim packages with resumable task events", async () => {
    const { service, publisher, conversation } = await fixture();
    const result = await service.publishMission(publisher, missionInput(conversation.id));
    expect(result.created).toBe(true);
    expect(result.packages.map(({ status }) => status)).toEqual(["published", "assigned"]);

    const workspace = await service.workspace(publisher);
    expect(workspace.availableTasks).toHaveLength(1);
    expect(workspace.publishedByMe).toHaveLength(2);
    const firstPage = await service.events(publisher, 0, 2);
    const nextPage = await service.events(publisher, firstPage.at(-1)!.sequence, 10);
    expect(firstPage).toHaveLength(2);
    expect(nextPage).toHaveLength(1);
    expect(nextPage[0].sequence).toBeGreaterThan(firstPage[1].sequence);
  });

  it("creates incomplete work as a private editable template instead of blocking on missing fields", async () => {
    const { service, publisher, conversation } = await fixture();
    const created = await service.createTaskTemplate(publisher, { conversationId: conversation.id, title: "API 申请工作" });
    expect(created.created).toBe(true);
    expect(created.templateId).toBe(created.packages[0].id);
    expect(created.missionId).toBe(created.mission.id);
    expect(created.mission).toMatchObject({ isTemplate: true, title: "API 申请工作" });
    expect(created.packages[0]).toMatchObject({ isTemplate: true, assignmentMode: "open_claim", status: "published" });
    expect(created.packages[0].missingFields).toEqual(expect.arrayContaining(["工作目标", "任务说明", "负责人或承接范围", "截止时间", "验收标准"]));
    expect((await service.workspace(publisher)).availableTasks).toEqual([]);
    expect((await service.workspace(publisher)).templates).toHaveLength(1);

    const updated = await service.updateTaskTemplate(publisher, {
      taskId: created.packages[0].id, expectedVersion: 1, objective: "申请并完成内部 API 访问审批", description: "补齐申请人、用途和访问范围。",
    });
    expect(updated.task).toMatchObject({ isTemplate: true, version: 2, description: "补齐申请人、用途和访问范围。" });
    expect(updated.missingFields).not.toContain("工作目标");
    expect((await service.workspace(publisher)).templates[0]).toMatchObject({ version: 2, description: "补齐申请人、用途和访问范围。" });
  });

  it("allows exactly one claimant for the same task version", async () => {
    const { service, publisher, conversation } = await fixture();
    const task = (await service.publishMission(publisher, missionInput(conversation.id))).packages[0];
    const first = { ...createDevelopmentRequestContext("claim-a"), actorId: DEMO_PRODUCT_OWNER_ID };
    const second = createDevelopmentRequestContext("claim-b");
    const outcomes = await Promise.allSettled([
      service.claimPackage(first, task.id, task.version),
      service.claimPackage(second, task.id, task.version),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const claimed = (await service.workspace(publisher)).publishedByMe.find(({ id }) => id === task.id);
    expect(claimed).toMatchObject({ status: "claimed", version: 2 });
  });

  it("requires an owner, a valid transition and evidence before completion", async () => {
    const { service, publisher, conversation } = await fixture();
    const assigned = (await service.publishMission(publisher, missionInput(conversation.id))).packages[1];
    const owner = { ...createDevelopmentRequestContext("task-owner"), actorId: DEMO_PRODUCT_OWNER_ID };
    const inProgress = await service.transitionPackage(owner, assigned.id, { expectedVersion: 1, nextStatus: "in_progress" });
    await expect(service.transitionPackage(owner, assigned.id, { expectedVersion: inProgress.version, nextStatus: "in_review" })).rejects.toThrow("WORK_REVIEW_EVIDENCE_REQUIRED");
    await expect(service.transitionPackage(owner, assigned.id, { expectedVersion: inProgress.version, nextStatus: "completed" })).rejects.toThrow("WORK_COMPLETION_EVIDENCE_REQUIRED");
    const completed = await service.transitionPackage(owner, assigned.id, {
      expectedVersion: inProgress.version,
      nextStatus: "completed",
      evidenceRefs: ["document:acceptance-evidence-v1"],
    });
    expect(completed).toMatchObject({ status: "completed", evidenceRefs: ["document:acceptance-evidence-v1"], version: 3 });
    expect((await service.workspace(owner)).myTasks).toHaveLength(0);
  });

  it("gates formal department dispatch and keeps pool communication out of the task state machine", async () => {
    const { service, publisher, conversation } = await fixture();
    const departmentBundle = await service.publishMission(publisher, {
      conversationId: conversation.id,
      title: "产品体验复核",
      objective: "由产品中心完成新版体验复核并提交正式结论。",
      priority: "medium",
      dueAt: "2030-08-20T10:00:00.000Z",
      packages: [{
        title: "体验复核", description: "检查新版关键路径与异常提示。", acceptanceCriteria: "提交体验复核结论和证据链接。", requiredSkills: ["产品"],
        assignmentMode: "open_claim", targetOrgUnitId: DEMO_PRODUCT_ORG_ID, startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, priority: "medium", dueAt: "2030-08-18T10:00:00.000Z", capacityPoints: 2,
      }],
    });
    const productMember = { ...createDevelopmentRequestContext("product-claim"), actorId: DEMO_PRODUCT_OWNER_ID, dataScopes: [{ type: "self" as const }] };
    const otherMember = { ...createDevelopmentRequestContext("operations-claim"), actorId: DEMO_OPERATIONS_OWNER_ID, dataScopes: [{ type: "self" as const }] };
    expect((await service.workspace(productMember)).availableTasks.map(({ id }) => id)).toContain(departmentBundle.packages[0].id);
    expect((await service.workspace(otherMember)).availableTasks).toEqual([]);
    await expect(service.claimPackage(otherMember, departmentBundle.packages[0].id, 1)).rejects.toThrow("POLICY_DENIED:work_task:claim_scope");

    const posted = await service.publishPoolMessage(publisher, { poolKey: "company", subject: "体验复核同步", content: "产品体验复核本周启动，欢迎在消息下补充关注点。" });
    const feedback = await service.appendPoolFeedback(productMember, { messageId: posted.message.id, content: "产品中心已排入本周评审。" });
    const workspace = await service.workspace(publisher);
    expect(workspace.messagePools.find(({ key }) => key === "company")?.messages[0]).toMatchObject({ id: posted.message.id, feedback: [{ id: feedback.id }] });
    expect(workspace.publishedByMe.map(({ id }) => id)).toContain(departmentBundle.packages[0].id);
    expect(workspace.myTasks).toEqual([]);
  });

  it("preserves a signed multi-person task handoff chain with frozen artifact snapshots and no ownership gap", async () => {
    const { service, publisher, conversation } = await fixture();
    const assigned = (await service.publishMission(publisher, {
      ...missionInput(conversation.id),
      packages: [{
        title: "交付交接演练", description: "将客户验收资料稳定交接给后续负责人。", acceptanceCriteria: "接收人签收完整资料并继续推进。", requiredSkills: ["交付"],
        assignmentMode: "direct", assigneeId: DEMO_DELIVERY_OWNER_ID, startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, priority: "high", dueAt: "2030-08-16T10:00:00.000Z", capacityPoints: 3,
      }],
    })).packages[0];
    const delivery = { ...createDevelopmentRequestContext("handoff-delivery"), actorId: DEMO_DELIVERY_OWNER_ID };
    const acceptancePack = await service.registerTaskArtifact(delivery, {
      title: "验收资料包", fileName: "acceptance-pack-v2.zip", mediaType: "application/zip", contentDigest: "a".repeat(64), classification: "internal",
    });
    const first = await service.initiateTaskHandoff(delivery, {
      taskId: assigned.id, expectedVersion: assigned.version, toAssigneeId: DEMO_PRODUCT_OWNER_ID,
      note: "已完成客户问题复现，验收材料和遗留清单均已归档。", currentProgress: "问题已完成初步复现，验收材料已归档。", completedWork: "复现与验收材料整理完成。", pendingWork: "产品侧口径复核与客户签字。", artifactIds: [acceptancePack.artifact.id],
    });
    expect(first.handoff).toMatchObject({ status: "pending", fromAssigneeId: DEMO_DELIVERY_OWNER_ID, toAssigneeId: DEMO_PRODUCT_OWNER_ID, artifactSnapshots: [{ artifactId: acceptancePack.artifact.id, version: 1, contentDigest: "a".repeat(64) }], snapshot: { packageVersion: 1, title: "交付交接演练" } });
    await expect(service.transitionPackage(delivery, assigned.id, { expectedVersion: 1, nextStatus: "in_progress" })).rejects.toThrow("WORK_HANDOFF_PENDING");

    const product = { ...createDevelopmentRequestContext("handoff-product"), actorId: DEMO_PRODUCT_OWNER_ID };
    const acceptanceRunId = crypto.randomUUID();
    const accepted = await service.respondToTaskHandoff(product, first.handoff.id, { expectedVersion: 1, decision: "accept" }, { source: "agent", sourceRunId: acceptanceRunId });
    expect(accepted.task).toMatchObject({ assigneeId: DEMO_PRODUCT_OWNER_ID, version: 2, status: "assigned" });
    expect(await service.respondToTaskHandoff(product, first.handoff.id, { expectedVersion: 1, decision: "accept" }, { source: "agent", sourceRunId: acceptanceRunId })).toMatchObject({ task: { assigneeId: DEMO_PRODUCT_OWNER_ID, version: 2 } });
    const releaseChecklist = await service.registerTaskArtifact(product, {
      title: "发布检查清单", fileName: "release-checklist.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentDigest: "b".repeat(64), classification: "internal",
    });
    const second = await service.initiateTaskHandoff(product, {
      taskId: assigned.id, expectedVersion: accepted.task.version, toAssigneeId: DEMO_OPERATIONS_OWNER_ID,
      note: "产品口径已确认，请继续准备客户侧发布安排。", currentProgress: "产品口径已确认，准备发布安排。", completedWork: "产品口径与清单确认。", pendingWork: "客户侧发布安排与执行。", artifactIds: [acceptancePack.artifact.id, releaseChecklist.artifact.id],
    });
    const operations = { ...createDevelopmentRequestContext("handoff-operations"), actorId: DEMO_OPERATIONS_OWNER_ID };
    const final = await service.respondToTaskHandoff(operations, second.handoff.id, { expectedVersion: 2, decision: "accept" });
    expect(final.task).toMatchObject({ assigneeId: DEMO_OPERATIONS_OWNER_ID, version: 3 });

    const trail = await service.taskHandoffTrail(delivery, assigned.id);
    expect(trail.handoffs).toMatchObject([
      { id: first.handoff.id, status: "accepted", snapshot: { packageVersion: 1 }, artifactSnapshots: [{ artifactId: acceptancePack.artifact.id, version: 1 }] },
      { id: second.handoff.id, status: "accepted", snapshot: { packageVersion: 2 }, artifactSnapshots: [{ artifactId: acceptancePack.artifact.id, version: 1 }, { artifactId: releaseChecklist.artifact.id, version: 1 }] },
    ]);
    expect((await service.events(publisher, 0)).map(({ eventType }) => eventType)).toEqual(expect.arrayContaining(["package_handoff_initiated", "package_handoff_accepted"]));
  });

  it("F-077: formal missions require start time and duration; templates mark them missing", async () => {
    const now = new Date("2030-08-01T00:00:00.000Z");
    const base = (tag: string) => ({ conversationId: `conv-${tag}`, title: `工期门禁-${tag}`, objective: "验证正式发布必须携带开始时间和工期。", priority: "high" as const, dueAt: "2030-08-20T10:00:00.000Z", publishedBy: DEMO_MANAGER_ID, source: "human" as const, isTemplate: false as const, packages: [{ title: "门禁包", description: "描述", acceptanceCriteria: "验收", requiredSkills: [], assignmentMode: "open_claim" as const, priority: "high" as const, dueAt: "2030-08-18T10:00:00.000Z", capacityPoints: 1 }] });
    expect(() => createMissionBundle({ ...base("a"), tenantId: DEMO_TENANT_ID, packages: [{ ...base("a").packages[0], startedAt: undefined, estimatedDays: undefined }] }, now)).toThrow("WORK_START_TIME_REQUIRED");
    const withStart = createMissionBundle({ ...base("b"), tenantId: DEMO_TENANT_ID, packages: [{ ...base("b").packages[0], startedAt: "2030-08-10T00:00:00.000Z", estimatedDays: 7 }] }, now);
    expect(withStart.packages[0].startedAt).toBe("2030-08-10T00:00:00.000Z");
    expect(withStart.packages[0].estimatedDays).toBe(7);
    expect(() => createMissionBundle({ ...base("c"), tenantId: DEMO_TENANT_ID, packages: [{ ...base("c").packages[0], startedAt: "2030-08-20T10:00:00.000Z", estimatedDays: 7 }] }, now)).toThrow("WORK_INVALID_TIME_RANGE");
    const template = createTaskTemplateBundle({ tenantId: DEMO_TENANT_ID, conversationId: "conv", title: "缺工期模板", publishedBy: DEMO_MANAGER_ID, source: "human" }, now);
    expect(template.packages[0].missingFields).toEqual(expect.arrayContaining(["任务开始时间", "工期"]));
    expect(template.packages[0].startedAt).toBe(now.toISOString());
    expect(template.packages[0].estimatedDays).toBe(7);
  });

  it("F-079: workspace exposes due state for overdue, due-soon and normal tasks", async () => {
    const { service, publisher, conversation } = await fixture();
    const overdue = (await service.publishMission(publisher, { ...missionInput(conversation.id), packages: [{ title: "已逾期", description: "d", acceptanceCriteria: "a", requiredSkills: [], assignmentMode: "open_claim", priority: "high", dueAt: "2020-01-01T00:00:00.000Z", startedAt: "2019-12-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 1 }] })).packages[0];
    const dueSoon = (await service.publishMission(publisher, { ...missionInput(conversation.id), packages: [{ title: "临期", description: "d", acceptanceCriteria: "a", requiredSkills: [], assignmentMode: "open_claim", priority: "medium", dueAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), startedAt: new Date().toISOString(), estimatedDays: 7, capacityPoints: 1 }] })).packages[0];
    const normal = (await service.publishMission(publisher, { ...missionInput(conversation.id), packages: [{ title: "正常", description: "d", acceptanceCriteria: "a", requiredSkills: [], assignmentMode: "open_claim", priority: "medium", dueAt: "2030-08-20T10:00:00.000Z", startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 1 }] })).packages[0];
    const published = (await service.workspace(publisher)).publishedByMe;
    expect(published.find(({ id }) => id === overdue.id)?.dueState).toBe("overdue");
    expect(published.find(({ id }) => id === dueSoon.id)?.dueState).toBe("due_soon");
    expect(published.find(({ id }) => id === normal.id)?.dueState).toBe("normal");
  });

  it("F-078/F-080: task timeline and read-only progress fact card", async () => {
    const { service, publisher, conversation } = await fixture();
    const bundle = await service.publishMission(publisher, missionInput(conversation.id));
    const openTask = bundle.packages[0];
    const directTask = bundle.packages[1];
    const timeline = await service.taskTimeline(publisher, openTask.id);
    expect(timeline.task.id).toBe(openTask.id);
    expect(timeline.timeline.map(({ eventType }) => eventType)).toEqual(expect.arrayContaining(["package_published"]));
    const fact = await service.taskProgressFact(publisher, openTask.id);
    expect(fact.task.id).toBe(openTask.id);
    expect(fact.task.dueState).toBeDefined();
    expect(Array.isArray(fact.handoffs)).toBe(true);
    const outsider = { ...createDevelopmentRequestContext("outsider"), actorId: DEMO_OPERATIONS_OWNER_ID, dataScopes: [{ type: "self" as const }] };
    await expect(service.taskTimeline(outsider, directTask.id)).rejects.toThrow("WORK_TASK_NOT_VISIBLE");
    await expect(service.taskProgressFact(outsider, directTask.id)).rejects.toThrow("WORK_TASK_NOT_VISIBLE");
  });

  it("F-080: work.get_task_progress tool is registered and returns the fact card", async () => {
    const { service, publisher, conversation } = await fixture();
    const task = (await service.publishMission(publisher, missionInput(conversation.id))).packages[0];
    const tools = new ToolRegistry();
    registerTaskCommandTools(tools, service);
    const tool = tools.available(publisher).find((item) => item.id === "work.get_task_progress");
    expect(tool).toBeDefined();
    const result = await tool!.execute(publisher, { taskId: task.id });
    expect((result as { task: { id: string } }).task.id).toBe(task.id);
  });

  it("F-081: handoff card stores structured progress fields and keeps them on accept", async () => {
    const { service, publisher, conversation } = await fixture();
    const bundle = await service.publishMission(publisher, missionInput(conversation.id));
    const task = bundle.packages[1];
    const created = await service.initiateTaskHandoff(publisher, {
      taskId: task.id, expectedVersion: task.version, toAssigneeId: DEMO_OPERATIONS_OWNER_ID,
      note: "交付证据整理中，请接收后继续推进。", currentProgress: "证据已整理 80%。", completedWork: "复现与材料归档完成。", pendingWork: "客户签字与发布安排。", attentionPoints: "签名文件需走线下流程。", artifactIds: [],
    });
    expect(created.handoff).toMatchObject({ currentProgress: "证据已整理 80%。", completedWork: "复现与材料归档完成。", pendingWork: "客户签字与发布安排。", attentionPoints: "签名文件需走线下流程。" });
    const recipient = { ...createDevelopmentRequestContext("f081-recipient"), actorId: DEMO_OPERATIONS_OWNER_ID };
    const accepted = await service.respondToTaskHandoff(recipient, created.handoff.id, { expectedVersion: 1, decision: "accept" });
    expect(accepted.handoff.currentProgress).toBe("证据已整理 80%。");
  });

  it("F-082: board returns visible tasks with due state and actor, excluding templates", async () => {
    const { service, publisher, conversation } = await fixture();
    await service.publishMission(publisher, missionInput(conversation.id));
    await service.createTaskTemplate(publisher, { conversationId: conversation.id, title: "看板模板", objective: "不应出现在看板", });
    const board = await service.board(publisher);
    expect(board.actorId).toBe(publisher.actorId);
    expect(board.tasks.length).toBeGreaterThanOrEqual(2);
    expect(board.tasks.some(({ title }) => title === "看板模板")).toBe(false);
    expect(board.tasks.every(({ dueState }) => ["overdue", "due_soon", "normal", "done"].includes(dueState ?? "normal"))).toBe(true);
  });
});
