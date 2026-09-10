import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { TaskCommandRepository } from "@/src/modules/task-command/application/contracts";
import type { AddPackageSubtaskInput, AppendPoolFeedbackInput, AppendTaskArtifactVersionInput, CreateTaskTemplateInput, DeletePackageSubtaskInput, ExportReportInput, InitiateTaskHandoffInput, ListPackageSubtasksInput, PublishMissionInput, PublishPoolMessageInput, RegisterTaskArtifactInput, RespondToTaskHandoffInput, RunReminderScanInput, TransitionPackageInput, UpdatePackageSubtaskInput, UpdateTaskTemplateInput } from "@/src/modules/task-command/application/schemas";
import { canMutatePackageSubtasks, claimWorkPackage, collectTaskReminderCandidates, completeWorkPackageSubtask, createConversationMessage, createMissionBundle, createPoolFeedback, createPoolMessage, createTaskHandoff, createTaskTemplateBundle, createWorkPackageSubtask, createWorkTaskNotification, deterministicUuid, dueStateOf, handoffWorkPackage, reopenWorkPackageSubtask, respondToTaskHandoff, revokeTaskHandoff, transitionWorkPackage, type WorkArtifact, type WorkArtifactVersion, type WorkConversationMessage, type WorkMessageEvent, type WorkMessagePool, type WorkPackage, type WorkPoolMessage, type WorkTaskEvent, type WorkTaskHandoffArtifactSnapshot, type WorkTaskNotification, type WorkTemplateField } from "@/src/modules/task-command/domain/task-command";

function hasPermission(context: RequestContext, permission: string): boolean {
  const [resource, action] = permission.split(":");
  return context.permissions.some((value) => value === "*" || value === permission || value === `${resource}:*` || value === `*:${action}`);
}

function requirePermission(context: RequestContext, permission: string) {
  if (!hasPermission(context, permission)) throw new Error(`POLICY_DENIED:${permission}`);
}

function event(input: Omit<WorkTaskEvent, "sequence" | "id" | "occurredAt">): Omit<WorkTaskEvent, "sequence"> {
  return { ...input, id: randomUUID(), occurredAt: new Date().toISOString() };
}

function messageEvent(input: Omit<WorkMessageEvent, "sequence" | "id" | "occurredAt">): Omit<WorkMessageEvent, "sequence"> {
  return { ...input, actorId: input.actorType === "system" ? undefined : input.actorId, id: randomUUID(), occurredAt: new Date().toISOString() };
}

function canAccessOrgScope(context: RequestContext, orgUnitId: string): boolean {
  return context.dataScopes.some((scope) =>
    scope.type === "tenant" ||
    (scope.type === "org_subtree" && scope.orgUnitIds.includes(orgUnitId)) ||
    (scope.type === "explicit" && scope.resourceIds.includes(orgUnitId)),
  );
}

type WorkPackageWithDue = WorkPackage & { dueState: "overdue" | "due_soon" | "normal" | "done" };

/** 通知文案不用术语：优先级与状态都用人话。 */
const PRIORITY_LABELS: Record<WorkPackage["priority"], string> = { critical: "紧急", high: "高", medium: "中", low: "低" };

/**
 * 周期摘要的周期键（UTC）：日报用日期，周报用当周周一日期。
 * 常驻调度器与脚本共用它，保证"同一周期只发一条"的口径一致。
 */
export function summaryPeriodKey(scope: "daily" | "weekly", now = new Date()): string {
  if (scope === "daily") return now.toISOString().slice(0, 10);
  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/**
 * P4 站内通知：由"某条刚写入的任务事件 + 一个收件人"生成一条通知。
 * 收件人等于操作人、或没有收件人时返回空数组（自己操作自己不需要提醒）。
 */
function taskNotification(input: {
  event: Omit<WorkTaskEvent, "sequence">;
  recipientId?: string;
  actorId: string;
  kind: WorkTaskNotification["kind"];
  title: string;
  body: string;
  refType: WorkTaskNotification["refType"];
  refId: string;
  packageId: string;
}): WorkTaskNotification[] {
  if (!input.recipientId || input.recipientId === input.actorId) return [];
  return [createWorkTaskNotification({
    tenantId: input.event.tenantId,
    recipientId: input.recipientId,
    actorType: "user",
    actorId: input.actorId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    refType: input.refType,
    refId: input.refId,
    packageId: input.packageId,
    sourceEventId: input.event.id,
  })];
}

/**
 * 定时提醒（临期/逾期/阻塞）：由后台扫描产生，没有对应的任务事件行，
 * 因此用确定性的 sourceEventId 做幂等键——重复扫描或两个实例同时跑都不会重复提醒。
 */
function reminderNotification(input: {
  tenantId: string;
  recipientId?: string;
  actorType: WorkTaskNotification["actorType"];
  actorId?: string;
  kind: WorkTaskNotification["kind"];
  title: string;
  body: string;
  packageId: string;
  dedupKey: string;
  now: Date;
}): WorkTaskNotification[] {
  // 系统署名不是人，不存在"自己提醒自己"的抑制；人工触发时才跳过自己。
  if (!input.recipientId) return [];
  if (input.actorType === "user" && input.recipientId === input.actorId) return [];
  return [createWorkTaskNotification({
    tenantId: input.tenantId,
    recipientId: input.recipientId,
    actorType: input.actorType,
    actorId: input.actorId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    refType: "work_package",
    refId: input.packageId,
    packageId: input.packageId,
    sourceEventId: deterministicUuid(input.dedupKey),
  }, input.now)];
}

function withDueState(item: WorkPackage): WorkPackageWithDue {
  return { ...item, dueState: dueStateOf(item) };
}

type TemplateFieldValues = {
  objective: string;
  description: string;
  acceptanceCriteria: string;
  requiredSkills: string[];
  assignmentMode: "direct" | "open_claim";
  assigneeId?: string;
  targetOrgUnitId?: string;
  priority: "critical" | "high" | "medium" | "low";
  dueAt: string;
  startedAt?: string;
  estimatedDays?: number;
  capacityPoints: number;
};

function updateTemplateMissingFields(current: WorkTemplateField[], input: UpdateTaskTemplateInput, values: TemplateFieldValues): WorkTemplateField[] {
  const missing = new Set<WorkTemplateField>(current);
  const has = (key: keyof UpdateTaskTemplateInput) => Object.prototype.hasOwnProperty.call(input, key);
  const setField = (field: WorkTemplateField, complete: boolean) => { if (complete) missing.delete(field); else missing.add(field); };
  if (has("objective")) setField("工作目标", Boolean(values.objective && !values.objective.startsWith("待补充")));
  if (has("description")) setField("任务说明", Boolean(values.description && !values.description.startsWith("待补充")));
  if (has("acceptanceCriteria")) setField("验收标准", Boolean(values.acceptanceCriteria && !values.acceptanceCriteria.startsWith("待补充")));
  if (has("requiredSkills")) setField("所需技能", values.requiredSkills.length > 0);
  if (has("priority")) setField("优先级", Boolean(values.priority));
  if (has("dueAt")) setField("截止时间", Boolean(values.dueAt));
  if (has("startedAt")) setField("任务开始时间", Boolean(values.startedAt));
  if (has("estimatedDays")) setField("工期", values.estimatedDays != null);
  if (has("capacityPoints")) setField("容量点", Boolean(values.capacityPoints));
  if (has("assignmentMode") || has("assigneeId") || has("targetOrgUnitId")) setField("负责人或承接范围", values.assignmentMode === "direct" ? Boolean(values.assigneeId) : Boolean(values.targetOrgUnitId));
  return [...missing];
}

export class TaskCommandService {
  constructor(private readonly repository: TaskCommandRepository) {}

  /** Resolve the user's primary conversation without loading the full workspace. */
  async primaryConversation(context: RequestContext) {
    requirePermission(context, "work_task:read");
    return this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
  }

  async workspace(context: RequestContext) {
    requirePermission(context, "work_task:read");
    const conversation = await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
    const [messages, people, orgUnits, missions, packages] = await Promise.all([
      this.repository.listMessages(context.tenantId, conversation.id, 100),
      this.repository.listPeople(context.tenantId),
      this.repository.listOrgUnits(context.tenantId),
      this.repository.listMissions(context.tenantId),
      this.repository.listPackages(context.tenantId),
    ]);
    const handoffs = await this.repository.listHandoffs(context.tenantId, packages.map(({ id }) => id));
    const actorOrgUnitIds = new Set(people.filter(({ id }) => id === context.actorId).flatMap(({ orgUnitId }) => orgUnitId ? [orgUnitId] : []));
    const canSeeClaim = (item: WorkPackage) => item.assignmentMode === "open_claim" && (!item.targetOrgUnitId || canAccessOrgScope(context, item.targetOrgUnitId) || actorOrgUnitIds.has(item.targetOrgUnitId));
    const handoffParticipantPackageIds = new Set(handoffs.filter((item) => item.fromAssigneeId === context.actorId || item.toAssigneeId === context.actorId).map(({ packageId }) => packageId));
    const visible = packages.filter((item) => item.publishedBy === context.actorId || item.assigneeId === context.actorId || canSeeClaim(item) || handoffParticipantPackageIds.has(item.id));
    const visiblePackageIds = new Set(visible.map(({ id }) => id));
    const visibleHandoffs = handoffs.filter((item) => visiblePackageIds.has(item.packageId));
    const subtaskProgress = await this.repository.listPackageSubtaskProgress(context.tenantId, [...visiblePackageIds]);
    const progressByPackage = new Map(subtaskProgress.map((item) => [item.packageId, { done: item.done, total: item.total }]));
    const withDueAndProgress = (item: WorkPackage) => {
      const progress = progressByPackage.get(item.id);
      return progress ? { ...withDueState(item), progress } : withDueState(item);
    };
    const messagePools = hasPermission(context, "message_pool:read")
      ? await this.messagePools(context, people, orgUnits)
      : [];
    // P4：站内通知随工作区一起返回，收件人恒为当前主体（另见 notifications()）。
    const [notifications, unreadNotificationCount] = await Promise.all([
      this.repository.listNotifications(context.tenantId, context.actorId, { limit: 30 }),
      this.repository.countUnreadNotifications(context.tenantId, context.actorId),
    ]);
    return {
      conversation,
      messages,
      people,
      orgUnits,
      notifications,
      unreadNotificationCount,
      missions: missions.filter((mission) => visible.some((item) => item.missionId === mission.id)),
      myTasks: visible.filter((item) => item.assigneeId === context.actorId && !item.isTemplate && !["completed", "cancelled"].includes(item.status)).map(withDueAndProgress),
      availableTasks: visible.filter((item) => !item.isTemplate && item.assignmentMode === "open_claim" && item.status === "published" && !item.assigneeId).map(withDueAndProgress),
      publishedByMe: visible.filter((item) => item.publishedBy === context.actorId).map(withDueAndProgress),
      templates: visible.filter((item) => item.publishedBy === context.actorId && item.isTemplate).map(withDueAndProgress),
      handoffTasks: visible.filter((item) => handoffParticipantPackageIds.has(item.id)).map(withDueAndProgress),
      handoffs: visibleHandoffs,
      pendingHandoffs: visibleHandoffs.filter((item) => item.status === "pending" && (item.toAssigneeId === context.actorId || item.fromAssigneeId === context.actorId)).flatMap((handoff) => {
        const task = visible.find((item) => item.id === handoff.packageId);
        return task ? [{ handoff, task, direction: handoff.toAssigneeId === context.actorId ? "incoming" : "outgoing" as const }] : [];
      }),
      messagePools,
      generatedAt: new Date().toISOString(),
    };
  }

  async findTask(context: RequestContext, input: { keyword: string; projectId?: string }) {
    requirePermission(context, "work_task:read");
    const data = await this.workspace(context);
    const keyword = input.keyword.trim().toLocaleLowerCase("zh-CN");
    const contains = (value?: string) => typeof value === "string" && value.toLocaleLowerCase("zh-CN").includes(keyword);
    const missionById = new Map(data.missions.map((mission) => [mission.id, mission]));
    const tasks = new Map<string, {
      id: string; title: string; description: string; status: string; category: string[]; missionTitle?: string;
      isTemplate: boolean; missingFields: string[]; assigneeId?: string; publishedBy: string; dueAt: string; version: number;
    }>();
    const push = (task: { id: string; missionId: string; title: string; description: string; status: string; isTemplate: boolean; missingFields: string[]; assigneeId?: string; publishedBy: string; dueAt: string; version: number }, category: string) => {
      const mission = missionById.get(task.missionId);
      if (input.projectId && mission?.projectId !== input.projectId) return;
      if (!contains(task.title) && !contains(task.description) && !(mission && contains(mission.title))) return;
      const existing = tasks.get(task.id);
      if (existing) {
        if (!existing.category.includes(category)) existing.category.push(category);
        return;
      }
      tasks.set(task.id, {
        id: task.id, title: task.title, description: task.description, status: task.status, category: [category],
        missionTitle: mission?.title, isTemplate: task.isTemplate, missingFields: task.missingFields,
        assigneeId: task.assigneeId, publishedBy: task.publishedBy, dueAt: task.dueAt, version: task.version,
      });
    };
    for (const task of data.myTasks) push(task, "我的");
    for (const task of data.availableTasks) push(task, "可承接");
    for (const task of data.publishedByMe) push(task, "已发布");
    for (const task of data.templates) push(task, "模板");
    for (const task of data.handoffTasks) push(task, "交接参与");
    for (const entry of data.pendingHandoffs) push(entry.task, entry.direction === "incoming" ? "待签收" : "待对方签收");
    return { tasks: [...tasks.values()], generatedAt: data.generatedAt };
  }

  async projectTaskInventory(context: RequestContext, input: { projectId: string }) {
    requirePermission(context, "work_task:read");
    const data = await this.workspace(context);
    const missionById = new Map(data.missions.map((mission) => [mission.id, mission]));
    const tasks = new Map<string, {
      id: string; title: string; status: string; category: string[]; missionId: string; missionTitle?: string;
      assignmentMode?: string; assigneeId?: string; publishedBy: string; dueAt: string; dueState?: string;
      isTemplate: boolean; missingFields: string[]; version: number;
    }>();
    const push = (task: { id: string; missionId: string; title: string; status: string; assignmentMode?: string; assigneeId?: string; publishedBy: string; dueAt: string; dueState?: string; isTemplate: boolean; missingFields: string[]; version: number }, category: string) => {
      const mission = missionById.get(task.missionId);
      if (mission?.projectId !== input.projectId) return;
      const existing = tasks.get(task.id);
      if (existing) {
        if (!existing.category.includes(category)) existing.category.push(category);
        return;
      }
      tasks.set(task.id, {
        id: task.id, title: task.title, status: task.status, category: [category], missionId: task.missionId,
        missionTitle: mission?.title, assignmentMode: task.assignmentMode, assigneeId: task.assigneeId,
        publishedBy: task.publishedBy, dueAt: task.dueAt, dueState: task.dueState,
        isTemplate: task.isTemplate, missingFields: task.missingFields, version: task.version,
      });
    };
    for (const task of data.myTasks) push(task, "我的");
    for (const task of data.availableTasks) push(task, "可承接");
    for (const task of data.publishedByMe) push(task, "已发布");
    for (const task of data.templates) push(task, "模板");
    for (const task of data.handoffTasks) push(task, "交接参与");
    for (const entry of data.pendingHandoffs) push(entry.task, entry.direction === "incoming" ? "待签收" : "待对方签收");
    const order: Record<string, number> = { published: 0, assigned: 1, claimed: 2, in_progress: 3, blocked: 4, in_review: 5, completed: 6, cancelled: 7 };
    const listed = [...tasks.values()].sort((left, right) => (order[left.status] ?? 9) - (order[right.status] ?? 9) || left.title.localeCompare(right.title, "zh-CN"));
    return { projectId: input.projectId, tasks: listed, generatedAt: data.generatedAt };
  }

  async appendMessage(context: RequestContext, input: Omit<WorkConversationMessage, "id" | "tenantId" | "createdAt">) {
    if (input.role === "user" && input.conversationId !== (await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId)).id) {
      throw new Error("WORK_CONVERSATION_NOT_FOUND");
    }
    const message = createConversationMessage({ ...input, tenantId: context.tenantId });
    await this.repository.appendMessage(message);
    return message;
  }

  async publishMission(context: RequestContext, input: PublishMissionInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:create");
    const conversation = await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
    if (conversation.id !== input.conversationId) throw new Error("WORK_CONVERSATION_NOT_FOUND");
    const people = await this.repository.listPeople(context.tenantId);
    const activeIds = new Set(people.map(({ id }) => id));
    const now = new Date();
    const missionMissing = new Set<WorkTemplateField>();
    if (!input.objective?.trim()) missionMissing.add("工作目标");
    if (!input.priority) missionMissing.add("优先级");
    if (!input.dueAt) missionMissing.add("截止时间");
    const missionDueAt = input.dueAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const normalizedPackages = input.packages.map((item) => {
      const missing = new Set<WorkTemplateField>();
      if (!item.description?.trim()) missing.add("任务说明");
      if (!item.acceptanceCriteria?.trim()) missing.add("验收标准");
      if (!item.requiredSkills || !item.requiredSkills.length) missing.add("所需技能");
      if (!item.priority) missing.add("优先级");
      if (!item.dueAt) missing.add("截止时间");
      if (!item.startedAt) missing.add("任务开始时间");
      if (!item.estimatedDays) missing.add("工期");
      if (!item.capacityPoints) missing.add("容量点");
      const assignmentMode: "direct" | "open_claim" = item.assignmentMode ?? (item.assigneeId ? "direct" : "open_claim");
      if (assignmentMode === "direct" && !item.assigneeId) missing.add("负责人或承接范围");
      return {
        ...item,
        description: item.description?.trim() || "待补充任务说明",
        acceptanceCriteria: item.acceptanceCriteria?.trim() || "待补充验收标准",
        requiredSkills: [...new Set(item.requiredSkills ?? [])],
        assignmentMode,
        priority: item.priority ?? "medium",
        dueAt: item.dueAt ?? missionDueAt,
        startedAt: item.startedAt ?? now.toISOString(),
        estimatedDays: item.estimatedDays ?? 7,
        capacityPoints: item.capacityPoints ?? 1,
        missingFields: [...missing],
      };
    });
    const missingFields = [...new Set<WorkTemplateField>([...missionMissing, ...normalizedPackages.flatMap((item) => item.missingFields)])];
    for (const item of normalizedPackages) {
      if (item.assignmentMode === "direct") {
        requirePermission(context, "work_task:assign");
        if (!item.assigneeId || !activeIds.has(item.assigneeId)) throw new Error("WORK_ASSIGNEE_NOT_FOUND");
      }
      if (item.targetOrgUnitId) {
        requirePermission(context, "work_task:assign_department");
        if (!canAccessOrgScope(context, item.targetOrgUnitId)) throw new Error("POLICY_DENIED:work_task:target_scope");
        const exists = (await this.repository.listOrgUnits(context.tenantId)).some(({ id }) => id === item.targetOrgUnitId);
        if (!exists) throw new Error("WORK_TARGET_DEPARTMENT_NOT_FOUND");
      }
    }
    const bundle = createMissionBundle({
      tenantId: context.tenantId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      title: input.title,
      objective: input.objective?.trim() || `待补充：${input.title} 的工作目标`,
      priority: input.priority ?? "medium",
      dueAt: missionDueAt,
      publishedBy: context.actorId,
      source: execution?.source ?? "human",
      sourceRunId: execution?.sourceRunId,
      isTemplate: false,
      missingFields,
      packages: normalizedPackages,
    });
    const missionEvent = event({ tenantId: context.tenantId, missionId: bundle.mission.id, eventType: "mission_published", actorId: context.actorId, audience: "tenant", payload: { title: bundle.mission.title, packageCount: bundle.packages.length } });
    const packageEvents = bundle.packages.map((item) => event({ tenantId: context.tenantId, missionId: item.missionId, packageId: item.id, eventType: "package_published", actorId: context.actorId, audience: item.assignmentMode === "open_claim" ? "tenant" : "participants", payload: { title: item.title, assigneeId: item.assigneeId, assignmentMode: item.assignmentMode, version: item.version } }));
    const events: Omit<WorkTaskEvent, "sequence">[] = [missionEvent, ...packageEvents];
    // P4：定向分派时通知被分派人（公开承接没有收件人，不产生通知）。
    const notifications = bundle.packages.flatMap((item, index) => item.assignmentMode === "direct" ? taskNotification({
      event: packageEvents[index], recipientId: item.assigneeId, actorId: context.actorId,
      kind: "task_assigned", title: `新任务：${item.title}`,
      body: `你被指定为负责人，截止 ${item.dueAt.slice(0, 10)}（优先级 ${PRIORITY_LABELS[item.priority]}）。`,
      refType: "work_package", refId: item.id, packageId: item.id,
    }) : []);
    const warnings: string[] = [];
    for (const item of normalizedPackages) {
      if (item.assignmentMode === "direct" && item.assigneeId) {
        const person = people.find((entry) => entry.id === item.assigneeId);
        if (person && (person.inProgressTaskCount >= 5 || person.capacityPoints >= 20)) {
          warnings.push(`负责人 ${person.displayName} 当前负载较高（进行中 ${person.inProgressTaskCount} 项 / 容量点 ${person.capacityPoints}），请确认是否继续定向分派。`);
        }
      }
    }
    if (missingFields.length) warnings.push(`任务已按当前信息发布，待补充：${missingFields.join("、")}。`);
    const result = await this.repository.publishMission(bundle.mission, bundle.packages, events, notifications);
    return { ...result, warnings };
  }

  async createTaskTemplate(context: RequestContext, input: CreateTaskTemplateInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:create");
    const conversation = await this.repository.getOrCreatePrimaryConversation(context.tenantId, context.actorId);
    if (conversation.id !== input.conversationId) throw new Error("WORK_CONVERSATION_NOT_FOUND");
    const bundle = createTaskTemplateBundle({ ...input, tenantId: context.tenantId, publishedBy: context.actorId, source: execution?.source ?? "human", sourceRunId: execution?.sourceRunId });
    const events: Omit<WorkTaskEvent, "sequence">[] = [
      event({ tenantId: context.tenantId, missionId: bundle.mission.id, eventType: "mission_published", actorId: context.actorId, audience: "participants", payload: { title: bundle.mission.title, packageCount: bundle.packages.length, template: true, missingFields: bundle.mission.missingFields } }),
      ...bundle.packages.map((item) => event({ tenantId: context.tenantId, missionId: item.missionId, packageId: item.id, eventType: "package_published", actorId: context.actorId, audience: "participants", payload: { title: item.title, template: true, missingFields: item.missingFields, version: item.version } })),
    ];
    const result = await this.repository.publishMission(bundle.mission, bundle.packages, events);
    const task = result.packages[0];
    return { ...result, missionId: result.mission.id, templateId: task?.id, task };
  }

  async updateTaskTemplate(context: RequestContext, input: UpdateTaskTemplateInput) {
    requirePermission(context, "work_task:update");
    const current = await this.requirePackage(context.tenantId, input.taskId);
    if (!current.isTemplate) throw new Error("WORK_TEMPLATE_ONLY");
    if (current.version !== input.expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    if (current.publishedBy !== context.actorId && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:template_ownership");
    const missions = await this.repository.listMissions(context.tenantId);
    const mission = missions.find((item) => item.id === current.missionId);
    if (!mission) throw new Error("WORK_MISSION_NOT_FOUND");
    const people = await this.repository.listPeople(context.tenantId);
    const orgUnits = await this.repository.listOrgUnits(context.tenantId);
    const assignmentMode = input.assignmentMode ?? current.assignmentMode;
    const assigneeId = input.assigneeId === null ? undefined : input.assigneeId ?? (assignmentMode === "direct" ? current.assigneeId : undefined);
    const targetOrgUnitId = input.targetOrgUnitId === null ? undefined : input.targetOrgUnitId ?? (assignmentMode === "open_claim" ? current.targetOrgUnitId : undefined);
    if (assignmentMode === "direct") {
      requirePermission(context, "work_task:assign");
      if (!assigneeId || !people.some(({ id }) => id === assigneeId)) throw new Error("WORK_ASSIGNEE_NOT_FOUND");
    }
    if (assignmentMode === "open_claim" && assigneeId) throw new Error("WORK_OPEN_CLAIM_ASSIGNEE_FORBIDDEN");
    if (targetOrgUnitId) {
      requirePermission(context, "work_task:assign_department");
      if (!canAccessOrgScope(context, targetOrgUnitId)) throw new Error("POLICY_DENIED:work_task:target_scope");
      if (!orgUnits.some(({ id }) => id === targetOrgUnitId)) throw new Error("WORK_TARGET_DEPARTMENT_NOT_FOUND");
    }
    const title = input.title ?? current.title;
    const objective = input.objective ?? mission.objective;
    const description = input.description ?? current.description;
    const acceptanceCriteria = input.acceptanceCriteria ?? current.acceptanceCriteria;
    const requiredSkills = input.requiredSkills ?? current.requiredSkills;
    const priority = input.priority ?? current.priority;
    const dueAt = input.dueAt ?? current.dueAt;
    const startedAt = input.startedAt ?? current.startedAt;
    const estimatedDays = input.estimatedDays ?? current.estimatedDays;
    const capacityPoints = input.capacityPoints ?? current.capacityPoints;
    const missingFields = updateTemplateMissingFields(current.missingFields, input, { objective, description, acceptanceCriteria, requiredSkills, assignmentMode, assigneeId, targetOrgUnitId, priority, dueAt, startedAt, estimatedDays, capacityPoints });
    const timestamp = new Date().toISOString();
    const nextMission = { ...mission, title, objective, priority, dueAt, version: mission.version + 1, updatedAt: timestamp, missingFields };
    const nextPackage = { ...current, title, description, acceptanceCriteria, requiredSkills: [...new Set(requiredSkills)], assignmentMode, assigneeId, targetOrgUnitId, priority, dueAt, startedAt, estimatedDays, capacityPoints, version: current.version + 1, updatedAt: timestamp, missingFields };
    const changed = await this.repository.updateTaskTemplate({ currentMission: mission, nextMission, currentPackage: current, nextPackage, expectedVersion: input.expectedVersion, event: event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_status_changed", actorId: context.actorId, audience: "participants", payload: { template: true, missingFields, version: nextPackage.version } }) });
    if (!changed) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    return { mission: nextMission, task: nextPackage, missingFields };
  }

  async claimPackage(context: RequestContext, id: string, expectedVersion: number) {
    requirePermission(context, "work_task:claim");
    const current = await this.requirePackage(context.tenantId, id);
    if (current.targetOrgUnitId) {
      const actorIsMember = (await this.repository.listPeople(context.tenantId)).some((person) => person.id === context.actorId && person.orgUnitId === current.targetOrgUnitId);
      if (!actorIsMember && !canAccessOrgScope(context, current.targetOrgUnitId)) throw new Error("POLICY_DENIED:work_task:claim_scope");
    }
    if (current.version !== expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    const next = claimWorkPackage(current, context.actorId);
    const claimEvent = event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_claimed", actorId: context.actorId, audience: "participants", payload: { assigneeId: context.actorId, version: next.version } });
    const changed = await this.repository.claimPackage({
      current, next, expectedVersion,
      event: claimEvent,
      notifications: taskNotification({
        event: claimEvent, recipientId: current.publishedBy, actorId: context.actorId,
        kind: "task_claimed", title: `任务已被承接：${current.title}`,
        body: `有人承接了你发布的任务，责任已转到承接人（截止 ${current.dueAt.slice(0, 10)}）。`,
        refType: "work_package", refId: current.id, packageId: current.id,
      }),
    });
    if (!changed) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    return next;
  }

  async transitionPackage(context: RequestContext, id: string, input: TransitionPackageInput) {
    requirePermission(context, "work_task:update");
    const current = await this.requirePackage(context.tenantId, id);
    if ((await this.repository.listHandoffs(context.tenantId, [current.id])).some(({ status }) => status === "pending")) throw new Error("WORK_HANDOFF_PENDING");
    const canManage = current.assigneeId === context.actorId || current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canManage) throw new Error("POLICY_DENIED:work_task:ownership");
    if (current.version !== input.expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    if (input.nextStatus === "in_review" && current.status === "in_progress") {
      const subtasks = await this.repository.listPackageSubtasks(context.tenantId, id);
      if (subtasks.length > 0 && !subtasks.every((item) => item.status === "done")) {
        const done = subtasks.filter((item) => item.status === "done").length;
        throw new Error(`WORK_PACKAGE_SUBTASKS_PENDING:${done}/${subtasks.length}`);
      }
    }
    // P2 产品边界：验收通过/退回是发布人（管理者）的决定，不是执行人的自助操作；
    // 从 in_review 离开到 completed/in_progress 只允许发布人或管理员，AI 仅能起草意见、不能代为通过/退回。
    if (current.status === "in_review" && ["completed", "in_progress"].includes(input.nextStatus)) {
      const isReviewer = current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
      if (!isReviewer) throw new Error("POLICY_DENIED:work_task:review_decision");
      if (input.nextStatus === "in_progress" && !input.reviewNote?.trim()) throw new Error("WORK_REVIEW_RETURN_REASON_REQUIRED");
    }
    const next = transitionWorkPackage(current, input);
    const eventPayload: Record<string, unknown> = { previousStatus: current.status, nextStatus: next.status, version: next.version };
    if (current.status === "in_review" && input.nextStatus === "in_progress" && input.reviewNote) {
      eventPayload.reviewNote = input.reviewNote.trim();
      eventPayload.decision = "reject";
    } else if (current.status === "in_review" && input.nextStatus === "completed") {
      eventPayload.decision = "accept";
    }
    const statusEvent = event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_status_changed", actorId: context.actorId, audience: "participants", payload: eventPayload });
    // P4：提交验收通知发布人，验收结论通知承接人（退回时把原因带进通知正文）。
    const statusNotifications = next.status === "in_review"
      ? taskNotification({
        event: statusEvent, recipientId: current.publishedBy, actorId: context.actorId,
        kind: "review_requested", title: `待你验收：${current.title}`,
        body: "执行人已提交验收并附证据，请核验后决定通过或退回。",
        refType: "work_package", refId: current.id, packageId: current.id,
      })
      : current.status === "in_review" && ["completed", "in_progress"].includes(next.status)
        ? taskNotification({
          event: statusEvent, recipientId: current.assigneeId, actorId: context.actorId,
          kind: "review_decided", title: next.status === "completed" ? `验收通过：${current.title}` : `验收被退回：${current.title}`,
          body: next.status === "completed" ? "发布人已验收通过，任务完成。" : `发布人退回了验收，原因：${input.reviewNote?.trim() ?? "未填写"}`,
          refType: "work_package", refId: current.id, packageId: current.id,
        })
        : [];
    const changed = await this.repository.transitionPackage({
      current, next, expectedVersion: input.expectedVersion,
      event: statusEvent,
      notifications: statusNotifications,
    });
    if (!changed) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    return next;
  }

  /** P3：列出任务包子任务（只读，随服务端可见性过滤）。 */
  async listPackageSubtasks(context: RequestContext, input: ListPackageSubtasksInput) {
    requirePermission(context, "work_task:read");
    const current = await this.requirePackage(context.tenantId, input.packageId);
    if (!(await this.isTaskVisible(context, current))) throw new Error("WORK_TASK_NOT_VISIBLE");
    const items = await this.repository.listPackageSubtasks(context.tenantId, input.packageId);
    const done = items.filter((item) => item.status === "done").length;
    return { packageId: input.packageId, subtasks: items, progress: { done, total: items.length } };
  }

  /** P3：谁都能拆子任务（发布人或承接人/管理员），但每条记录添加人；in_review/completed/cancelled 后禁止新增。 */
  async addPackageSubtask(context: RequestContext, input: AddPackageSubtaskInput) {
    requirePermission(context, "work_task:update");
    const current = await this.requirePackage(context.tenantId, input.packageId);
    if (current.isTemplate) throw new Error("WORK_TEMPLATE_ONLY");
    const canMutate = current.assigneeId === context.actorId || current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canMutate) throw new Error("POLICY_DENIED:work_task:ownership");
    if (!canMutatePackageSubtasks(current.status)) throw new Error("WORK_PACKAGE_SUBTASKS_LOCKED");
    const existing = await this.repository.listPackageSubtasks(context.tenantId, input.packageId);
    const subtask = createWorkPackageSubtask({
      tenantId: context.tenantId, missionId: current.missionId, packageId: current.id,
      title: input.title, sortOrder: existing.length + 1, createdBy: context.actorId,
    });
    const changed = await this.repository.savePackageSubtask(subtask, event({
      tenantId: context.tenantId, missionId: current.missionId, packageId: current.id,
      eventType: "package_progress_updated", actorId: context.actorId, audience: "participants",
      payload: { action: "subtask_created", subtaskId: subtask.id, title: subtask.title, sortOrder: subtask.sortOrder, done: false },
    }));
    if (!changed) throw new Error("WORK_PACKAGE_SUBTASK_CONFLICT");
    return { subtask };
  }

  /** P3：勾选/重新打开子任务；勾选可带完成说明与证据引用（AI 只起草建议、本接口由人确认触发）。 */
  async updatePackageSubtask(context: RequestContext, input: UpdatePackageSubtaskInput) {
    requirePermission(context, "work_task:update");
    const current = await this.requirePackage(context.tenantId, input.packageId);
    if (current.isTemplate) throw new Error("WORK_TEMPLATE_ONLY");
    const canMutate = current.assigneeId === context.actorId || current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canMutate) throw new Error("POLICY_DENIED:work_task:ownership");
    if (!canMutatePackageSubtasks(current.status)) throw new Error("WORK_PACKAGE_SUBTASKS_LOCKED");
    const items = await this.repository.listPackageSubtasks(context.tenantId, input.packageId);
    const existing = items.find((item) => item.id === input.subtaskId);
    if (!existing) throw new Error("WORK_PACKAGE_SUBTASK_NOT_FOUND");
    if (existing.version !== input.expectedVersion) throw new Error("WORK_PACKAGE_SUBTASK_CONFLICT");
    const next = input.done
      ? completeWorkPackageSubtask(existing, { doneBy: context.actorId, note: input.note, evidenceRefs: input.evidenceRefs })
      : reopenWorkPackageSubtask(existing);
    const changed = await this.repository.savePackageSubtask(next, event({
      tenantId: context.tenantId, missionId: current.missionId, packageId: current.id,
      eventType: "package_progress_updated", actorId: context.actorId, audience: "participants",
      payload: { action: input.done ? "subtask_completed" : "subtask_reopened", subtaskId: next.id, title: next.title, done: next.status === "done", note: next.doneNote, evidenceRefs: next.evidenceRefs },
    }));
    if (!changed) throw new Error("WORK_PACKAGE_SUBTASK_CONFLICT");
    const remaining = items.map((item) => item.id === next.id ? next : item);
    return { subtask: next, progress: { done: remaining.filter((item) => item.status === "done").length, total: remaining.length } };
  }

  /** P3：删除子任务（拆分人/发布人/管理员；in_review 后禁止）。 */
  async deletePackageSubtask(context: RequestContext, input: DeletePackageSubtaskInput) {
    requirePermission(context, "work_task:update");
    const current = await this.requirePackage(context.tenantId, input.packageId);
    if (current.isTemplate) throw new Error("WORK_TEMPLATE_ONLY");
    const canMutate = current.assigneeId === context.actorId || current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canMutate) throw new Error("POLICY_DENIED:work_task:ownership");
    if (!canMutatePackageSubtasks(current.status)) throw new Error("WORK_PACKAGE_SUBTASKS_LOCKED");
    const items = await this.repository.listPackageSubtasks(context.tenantId, input.packageId);
    const existing = items.find((item) => item.id === input.subtaskId);
    if (!existing) throw new Error("WORK_PACKAGE_SUBTASK_NOT_FOUND");
    const changed = await this.repository.deletePackageSubtask(context.tenantId, input.packageId, input.subtaskId, input.expectedVersion, event({
      tenantId: context.tenantId, missionId: current.missionId, packageId: current.id,
      eventType: "package_progress_updated", actorId: context.actorId, audience: "participants",
      payload: { action: "subtask_deleted", subtaskId: existing.id, title: existing.title },
    }));
    if (!changed) throw new Error("WORK_PACKAGE_SUBTASK_CONFLICT");
    const remaining = items.filter((item) => item.id !== input.subtaskId);
    return { deletedSubtaskId: input.subtaskId, progress: { done: remaining.filter((item) => item.status === "done").length, total: remaining.length } };
  }

  async initiateTaskHandoff(context: RequestContext, input: InitiateTaskHandoffInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:handoff");
    const artifactIds = input.artifactIds ?? [];
    const artifactRefs = input.artifactRefs ?? [];
    const current = await this.requirePackage(context.tenantId, input.taskId);
    if (current.version !== input.expectedVersion) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    if (!current.assigneeId || ["published", "in_review", "completed", "cancelled"].includes(current.status)) throw new Error("WORK_HANDOFF_PACKAGE_NOT_TRANSFERABLE");
    const canInitiate = current.assigneeId === context.actorId || current.publishedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canInitiate) throw new Error("POLICY_DENIED:work_task:handoff_ownership");
    if ((await this.repository.listHandoffs(context.tenantId, [current.id])).some(({ status }) => status === "pending")) throw new Error("WORK_HANDOFF_ALREADY_PENDING");
    const people = await this.repository.listPeople(context.tenantId);
    const target = people.find(({ id }) => id === input.toAssigneeId);
    const source = people.find(({ id }) => id === current.assigneeId);
    if (!target) throw new Error("WORK_HANDOFF_TARGET_NOT_FOUND");
    if (target.id === current.assigneeId) throw new Error("WORK_HANDOFF_SAME_ASSIGNEE");
    if (target.orgUnitId !== source?.orgUnitId) {
      requirePermission(context, "work_task:handoff_cross_department");
      if (target.orgUnitId && !canAccessOrgScope(context, target.orgUnitId)) throw new Error("POLICY_DENIED:work_task:handoff_target_scope");
    }
    if (artifactIds.length && artifactRefs.length) throw new Error("WORK_HANDOFF_MIXED_ARTIFACT_REFERENCES_FORBIDDEN");
    const artifactSnapshots = await this.freezeHandoffArtifacts(context, current, artifactIds);
    const handoff = createTaskHandoff({
      tenantId: context.tenantId,
      packageId: current.id,
      missionId: current.missionId,
      fromAssigneeId: current.assigneeId,
      toAssigneeId: target.id,
      initiatedBy: context.actorId,
      note: input.note,
      currentProgress: input.currentProgress,
      completedWork: input.completedWork,
      pendingWork: input.pendingWork,
      attentionPoints: input.attentionPoints,
      artifactRefs,
      artifactSnapshots,
      snapshot: {
        packageVersion: current.version,
        status: current.status,
        title: current.title,
        description: current.description,
        acceptanceCriteria: current.acceptanceCriteria,
        requiredSkills: current.requiredSkills,
        evidenceRefs: current.evidenceRefs,
        dueAt: current.dueAt,
      },
      source: execution?.source ?? "human",
      sourceRunId: execution?.sourceRunId,
    });
    const handoffEvent = event({
      tenantId: context.tenantId,
      missionId: current.missionId,
      packageId: current.id,
      eventType: "package_handoff_initiated",
      actorId: context.actorId,
      audience: "participants",
      payload: { handoffId: handoff.id, fromAssigneeId: handoff.fromAssigneeId, toAssigneeId: handoff.toAssigneeId, packageVersion: handoff.snapshot.packageVersion, artifactSnapshotCount: handoff.artifactSnapshots.length, legacyArtifactRefCount: handoff.artifactRefs.length },
    });
    return this.repository.initiateHandoff(handoff, handoffEvent, taskNotification({
      event: handoffEvent, recipientId: handoff.toAssigneeId, actorId: context.actorId,
      kind: "handoff_requested", title: `待你签收交接：${current.title}`,
      body: `有人把任务交接给你：${handoff.note}（签收后责任才转到你）。`,
      refType: "work_handoff", refId: handoff.id, packageId: current.id,
    }));
  }

  async respondToTaskHandoff(context: RequestContext, handoffId: string, input: RespondToTaskHandoffInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:accept_handoff");
    const current = await this.repository.getHandoff(context.tenantId, handoffId);
    if (!current) throw new Error("WORK_HANDOFF_NOT_FOUND");
    if (current.toAssigneeId !== context.actorId) throw new Error("POLICY_DENIED:work_task:handoff_recipient");
    const task = await this.requirePackage(context.tenantId, current.packageId);
    if (current.status !== "pending") {
      if (execution?.sourceRunId && current.responseRunId === execution.sourceRunId) return { handoff: current, task };
      throw new Error("WORK_HANDOFF_NOT_PENDING");
    }
    if (task.version !== input.expectedVersion || task.version !== current.snapshot.packageVersion || task.assigneeId !== current.fromAssigneeId) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
    const status = input.decision === "accept" ? "accepted" : "rejected" as const;
    const next = respondToTaskHandoff(current, { status, responseNote: input.responseNote, respondedBy: context.actorId, responseRunId: execution?.sourceRunId });
    const nextPackage = status === "accepted" ? handoffWorkPackage(task, current.toAssigneeId) : undefined;
    const handoffResponseEvent = event({
      tenantId: context.tenantId,
      missionId: task.missionId,
      packageId: task.id,
      eventType: status === "accepted" ? "package_handoff_accepted" : "package_handoff_rejected",
      actorId: context.actorId,
      audience: "participants",
      payload: { handoffId: current.id, fromAssigneeId: current.fromAssigneeId, toAssigneeId: current.toAssigneeId, decision: input.decision, packageVersion: nextPackage?.version ?? task.version, artifactSnapshotCount: current.artifactSnapshots.length, legacyArtifactRefCount: current.artifactRefs.length },
    });
    const changed = await this.repository.respondToHandoff({
      current,
      next,
      currentPackage: task,
      nextPackage,
      expectedVersion: input.expectedVersion,
      event: handoffResponseEvent,
      notifications: taskNotification({
        event: handoffResponseEvent, recipientId: current.fromAssigneeId, actorId: context.actorId,
        kind: "handoff_responded", title: status === "accepted" ? `交接已签收：${task.title}` : `交接被退回：${task.title}`,
        body: status === "accepted" ? "接收人已签收，责任已转到对方。" : `接收人退回了交接，原因：${input.responseNote?.trim() || "未填写"}。`,
        refType: "work_handoff", refId: current.id, packageId: task.id,
      }),
    });
    if (!changed) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
    return { handoff: next, task: nextPackage ?? task };
  }

  async revokeTaskHandoff(context: RequestContext, handoffId: string, expectedVersion: number, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "work_task:update");
    const current = await this.repository.getHandoff(context.tenantId, handoffId);
    if (!current) throw new Error("WORK_HANDOFF_NOT_FOUND");
    const canRevoke = current.fromAssigneeId === context.actorId || current.initiatedBy === context.actorId || hasPermission(context, "work_task:admin");
    if (!canRevoke) throw new Error("POLICY_DENIED:work_task:handoff_revoke");
    const task = await this.requirePackage(context.tenantId, current.packageId);
    if (current.status !== "pending") {
      if (execution?.sourceRunId && current.responseRunId === execution.sourceRunId) return { handoff: current, task };
      throw new Error("WORK_HANDOFF_NOT_PENDING");
    }
    if (task.version !== expectedVersion || task.version !== current.snapshot.packageVersion || task.assigneeId !== current.fromAssigneeId) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
    const next = revokeTaskHandoff(current, { respondedBy: context.actorId, responseRunId: execution?.sourceRunId });
    const revokeEvent = event({
      tenantId: context.tenantId,
      missionId: task.missionId,
      packageId: task.id,
      eventType: "package_handoff_rejected",
      actorId: context.actorId,
      audience: "participants",
      payload: { handoffId: current.id, fromAssigneeId: current.fromAssigneeId, toAssigneeId: current.toAssigneeId, decision: "revoke", packageVersion: task.version, artifactSnapshotCount: current.artifactSnapshots.length, legacyArtifactRefCount: current.artifactRefs.length },
    });
    const changed = await this.repository.respondToHandoff({
      current,
      next,
      currentPackage: task,
      nextPackage: undefined,
      expectedVersion,
      event: revokeEvent,
      notifications: taskNotification({
        event: revokeEvent, recipientId: current.toAssigneeId, actorId: context.actorId,
        kind: "handoff_responded", title: `交接已撤回：${task.title}`,
        body: "发起人撤回了这条待签收交接，任务继续由原负责人负责，你无需再处理。",
        refType: "work_handoff", refId: current.id, packageId: task.id,
      }),
    });
    if (!changed) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
    return { handoff: next, task };
  }

  async taskHandoffTrail(context: RequestContext, taskId: string) {
    requirePermission(context, "work_task:read");
    const workspace = await this.workspace(context);
    const task = [...workspace.myTasks, ...workspace.availableTasks, ...workspace.publishedByMe, ...workspace.handoffTasks, ...workspace.pendingHandoffs.map(({ task: item }) => item)].find((item) => item.id === taskId);
    if (!task) throw new Error("WORK_HANDOFF_NOT_VISIBLE");
    return { task, handoffs: workspace.handoffs.filter((item) => item.packageId === task.id) };
  }

  async registerTaskArtifact(context: RequestContext, input: RegisterTaskArtifactInput) {
    requirePermission(context, "work_task:update");
    const timestamp = new Date().toISOString();
    const artifact: WorkArtifact = {
      id: randomUUID(), tenantId: context.tenantId, ownerId: context.actorId, title: input.title,
      classification: input.classification, status: "active", currentVersion: 1, createdAt: timestamp,
    };
    const version: WorkArtifactVersion = {
      id: randomUUID(), tenantId: context.tenantId, artifactId: artifact.id, version: 1,
      fileName: input.fileName, mediaType: input.mediaType, contentDigest: input.contentDigest.toLowerCase(),
      storageRef: input.storageRef, createdBy: context.actorId, createdAt: timestamp,
    };
    await this.repository.createArtifact(artifact, version);
    return { artifact, version: this.publicArtifactVersion(version) };
  }

  async appendTaskArtifactVersion(context: RequestContext, artifactId: string, input: AppendTaskArtifactVersionInput) {
    requirePermission(context, "work_task:update");
    const artifact = await this.repository.getArtifact(context.tenantId, artifactId);
    if (!artifact) throw new Error("WORK_ARTIFACT_NOT_FOUND");
    if (artifact.status !== "active") throw new Error("WORK_ARTIFACT_NOT_ACTIVE");
    if (artifact.ownerId !== context.actorId && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:artifact_ownership");
    if (artifact.currentVersion !== input.expectedVersion) throw new Error("WORK_ARTIFACT_VERSION_CONFLICT");
    const timestamp = new Date().toISOString();
    const next: WorkArtifactVersion = {
      id: randomUUID(), tenantId: context.tenantId, artifactId: artifact.id, version: artifact.currentVersion + 1,
      fileName: input.fileName, mediaType: input.mediaType, contentDigest: input.contentDigest.toLowerCase(),
      storageRef: input.storageRef, createdBy: context.actorId, createdAt: timestamp,
    };
    const changed = await this.repository.appendArtifactVersion(artifact, next, input.expectedVersion);
    if (!changed) throw new Error("WORK_ARTIFACT_VERSION_CONFLICT");
    return { artifact: { ...artifact, currentVersion: next.version }, version: this.publicArtifactVersion(next) };
  }

  async taskArtifact(context: RequestContext, artifactId: string) {
    requirePermission(context, "work_task:read");
    const artifact = await this.repository.getArtifact(context.tenantId, artifactId);
    if (!artifact) throw new Error("WORK_ARTIFACT_NOT_FOUND");
    const workspace = await this.workspace(context);
    const visibleByHandoff = workspace.handoffs.some((handoff) => handoff.artifactSnapshots.some((snapshot) => snapshot.artifactId === artifact.id));
    if (artifact.ownerId !== context.actorId && !visibleByHandoff && !hasPermission(context, "work_task:admin")) throw new Error("WORK_ARTIFACT_NOT_VISIBLE");
    const versions = await this.repository.getArtifactVersions(context.tenantId, [artifact.id]);
    return { artifact, versions: versions.map((item) => this.publicArtifactVersion(item)) };
  }

  async events(context: RequestContext, after: number, limit = 100) {
    requirePermission(context, "work_task:read");
    const workspace = await this.workspace(context);
    const visiblePackageIds = new Set([
      ...workspace.myTasks,
      ...workspace.availableTasks,
      ...workspace.publishedByMe,
      ...workspace.handoffTasks,
      ...workspace.pendingHandoffs.map(({ task }) => task),
    ].map(({ id }) => id));
    const visibleMissionIds = new Set(workspace.missions.map(({ id }) => id));
    const requestedLimit = Math.min(Math.max(limit, 0), 200);
    if (!requestedLimit) return [];

    // Fetch in chunks until enough visible events are collected. Filtering after a
    // fixed repository page could otherwise hide later authorized events forever.
    const result: WorkTaskEvent[] = [];
    let cursor = after;
    while (result.length < requestedLimit) {
      const items = await this.repository.listEvents(context.tenantId, context.actorId, cursor, 200);
      if (!items.length) break;
      for (const item of items) {
        if (item.packageId ? visiblePackageIds.has(item.packageId) : visibleMissionIds.has(item.missionId)) {
          result.push(item);
          if (result.length === requestedLimit) break;
        }
      }
      const lastSequence = items.at(-1)?.sequence;
      if (lastSequence === undefined || items.length < 200 || lastSequence <= cursor) break;
      cursor = lastSequence;
    }
    return result;
  }

  async messageEvents(context: RequestContext, after: number, limit = 100) {
    requirePermission(context, "message_pool:read");
    const [people, orgUnits, events] = await Promise.all([
      this.repository.listPeople(context.tenantId),
      this.repository.listOrgUnits(context.tenantId),
      this.repository.listMessageEvents(context.tenantId, after, Math.min(limit, 200)),
    ]);
    const visibleKeys = new Set((await this.messagePoolCatalog(context, people, orgUnits)).map(({ key }) => key));
    return events.filter(({ poolKey }) => visibleKeys.has(poolKey));
  }

  /** P4：只读本人通知（收件人恒为当前主体，不接受他人 ID）。 */
  async notifications(context: RequestContext, input: { unreadOnly?: boolean; limit?: number }) {
    requirePermission(context, "work_task:read");
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const [notifications, unreadCount] = await Promise.all([
      this.repository.listNotifications(context.tenantId, context.actorId, { unreadOnly: input.unreadOnly === true, limit }),
      this.repository.countUnreadNotifications(context.tenantId, context.actorId),
    ]);
    return { notifications, unreadCount };
  }

  /** P4：标记本人某条通知已读；越权或不存在都返回同一错误码，不泄露存在性。 */
  async markNotificationRead(context: RequestContext, id: string) {
    requirePermission(context, "work_task:read");
    const current = await this.repository.getNotification(context.tenantId, id);
    if (!current || current.recipientId !== context.actorId) throw new Error("WORK_NOTIFICATION_NOT_FOUND");
    const readAt = current.readAt ?? new Date().toISOString();
    await this.repository.markNotificationRead(context.tenantId, id, context.actorId, readAt);
    return { notification: { ...current, readAt }, unreadCount: await this.repository.countUnreadNotifications(context.tenantId, context.actorId) };
  }

  /** P4：一键全部已读（只影响本人未读）。 */
  async markAllNotificationsRead(context: RequestContext) {
    requirePermission(context, "work_task:read");
    const updated = await this.repository.markAllNotificationsRead(context.tenantId, context.actorId, new Date().toISOString());
    return { updated, unreadCount: await this.repository.countUnreadNotifications(context.tenantId, context.actorId) };
  }

  async publishPoolMessage(context: RequestContext, input: PublishPoolMessageInput, execution?: { sourceRunId?: string; source?: "human" | "agent" }) {
    requirePermission(context, "message_pool:publish");
    const [people, orgUnits] = await Promise.all([this.repository.listPeople(context.tenantId), this.repository.listOrgUnits(context.tenantId)]);
    const pool = (await this.messagePoolCatalog(context, people, orgUnits)).find(({ key }) => key === input.poolKey);
    if (!pool) throw new Error("MESSAGE_POOL_NOT_VISIBLE");
    const message = createPoolMessage({
      tenantId: context.tenantId,
      poolKey: pool.key,
      poolScope: pool.scope,
      orgUnitId: pool.orgUnitId,
      subject: input.subject,
      content: input.content,
      kind: input.kind ?? "notice",
      authorType: "user",
      authorId: context.actorId,
      source: execution?.source ?? "human",
      sourceRunId: execution?.sourceRunId,
    });
    return this.repository.publishPoolMessage(message, messageEvent({
      tenantId: context.tenantId,
      poolKey: message.poolKey,
      poolScope: message.poolScope,
      orgUnitId: message.orgUnitId,
      messageId: message.id,
      eventType: "message_published",
      actorType: "user",
      actorId: context.actorId,
    }));
  }

  async appendPoolFeedback(context: RequestContext, input: AppendPoolFeedbackInput) {
    requirePermission(context, "message_pool:publish");
    const message = await this.repository.getPoolMessage(context.tenantId, input.messageId);
    if (!message) throw new Error("MESSAGE_POOL_MESSAGE_NOT_FOUND");
    const [people, orgUnits] = await Promise.all([this.repository.listPeople(context.tenantId), this.repository.listOrgUnits(context.tenantId)]);
    const visibleKeys = new Set((await this.messagePoolCatalog(context, people, orgUnits)).map(({ key }) => key));
    if (!visibleKeys.has(message.poolKey)) throw new Error("MESSAGE_POOL_NOT_VISIBLE");
    const feedback = createPoolFeedback({ tenantId: context.tenantId, messageId: message.id, content: input.content, authorId: context.actorId });
    await this.repository.appendPoolFeedback(feedback, messageEvent({
      tenantId: context.tenantId,
      poolKey: message.poolKey,
      poolScope: message.poolScope,
      orgUnitId: message.orgUnitId,
      messageId: message.id,
      eventType: "feedback_published",
      actorType: "user",
      actorId: context.actorId,
    }));
    return feedback;
  }

  async agentContext(context: RequestContext) {
    const workspace = await this.workspace(context);
    const people = workspace.people.map((person) => `${person.displayName}[${person.id}]：在手 ${person.activeTaskCount} 项${person.positionName ? `，${person.positionName}` : ""}`).join("；") || "没有可分派成员";
    const myTasks = workspace.myTasks.slice(0, 8).map((item) => `${item.title}[${item.id}]，${item.status}，v${item.version}`).join("；") || "无";
    const templates = workspace.templates.slice(0, 8).map((item) => `${item.title}[${item.id}]，模板，待补充：${item.missingFields.join("、") || "无"}，v${item.version}`).join("；") || "无";
    const available = workspace.availableTasks.slice(0, 8).map((item) => `${item.title}[${item.id}]，v${item.version}`).join("；") || "无";
    const departments = workspace.orgUnits.map((unit) => `${unit.name}[${unit.id}]`).join("；") || "无";
    const pools = workspace.messagePools.map((pool) => `${pool.name}[${pool.key}]：${pool.messages.slice(0, 2).map((item) => `${item.subject}[${item.id}]`).join("、") || "暂无消息"}`).join("；") || "当前无可见消息池";
    const pendingHandoffs = workspace.pendingHandoffs.slice(0, 6).map(({ handoff, task }) => `${task.title}[${task.id}] 的交接[${handoff.id}]：${handoff.fromAssigneeId} → 当前用户，任务版本 v${handoff.snapshot.packageVersion}，冻结交付物 ${handoff.artifactSnapshots.length} 项${handoff.artifactRefs.length ? `，旧式引用 ${handoff.artifactRefs.length} 项` : ""}`).join("；") || "无";
    const handoffTrail = workspace.handoffs.slice(-8).map((item) => `${item.snapshot.title}[${item.packageId}]：${item.fromAssigneeId} → ${item.toAssigneeId}，${item.status}，冻结交付物 ${item.artifactSnapshots.length} 项${item.artifactRefs.length ? `，旧式引用 ${item.artifactRefs.length} 项` : ""}`).join("；") || "无";
    return {
      conversationId: workspace.conversation.id,
      summary: `<untrusted_task_context>\n主对话ID：${workspace.conversation.id}\n可分派成员：${people}\n可定向部门：${departments}\n我的进行中任务：${myTasks}\n我的任务模板：${templates}\n可主动承接任务：${available}\n待我签收的交接：${pendingHandoffs}\n可见交接链：${handoffTrail}\n</untrusted_task_context>\n<untrusted_message_pool_context>\n可见消息池：${pools}\n</untrusted_message_pool_context>`,
      packages: [...workspace.myTasks, ...workspace.availableTasks, ...workspace.templates].slice(0, 12),
      handoffs: workspace.handoffs.slice(-12),
      poolMessages: workspace.messagePools.flatMap((pool) => pool.messages).slice(0, 12),
    };
  }

  private async messagePools(context: RequestContext, people: Awaited<ReturnType<TaskCommandRepository["listPeople"]>>, orgUnits: Awaited<ReturnType<TaskCommandRepository["listOrgUnits"]>>) {
    const pools = await this.messagePoolCatalog(context, people, orgUnits);
    const poolKeys = new Set(pools.map(({ key }) => key));
    const messages = (await this.repository.listPoolMessages(context.tenantId)).filter((item) => poolKeys.has(item.poolKey));
    const feedback = await this.repository.listPoolFeedback(context.tenantId, messages.map(({ id }) => id));
    return pools.map((pool) => ({
      ...pool,
      messages: messages.filter((item) => item.poolKey === pool.key).slice(0, 20).map((message) => ({
        ...message,
        feedback: feedback.filter((item) => item.messageId === message.id),
      })),
    }));
  }

  private async messagePoolCatalog(context: RequestContext, people: Awaited<ReturnType<TaskCommandRepository["listPeople"]>>, orgUnits: Awaited<ReturnType<TaskCommandRepository["listOrgUnits"]>>): Promise<WorkMessagePool[]> {
    const canModerate = hasPermission(context, "message_pool:moderate");
    const actorOrgUnitIds = new Set(people.filter(({ id }) => id === context.actorId).flatMap(({ orgUnitId }) => orgUnitId ? [orgUnitId] : []));
    return [
      { key: "company", name: "全公司", scope: "company" as const },
      ...orgUnits.filter((unit) => canModerate || actorOrgUnitIds.has(unit.id) || canAccessOrgScope(context, unit.id)).map((unit) => ({ key: unit.id, name: unit.name, scope: "department" as const, orgUnitId: unit.id })),
    ];
  }

  /** RQ-2/F-078: full lifecycle timeline for one visible task. */
  async taskTimeline(context: RequestContext, taskId: string) {
    requirePermission(context, "work_task:read");
    const task = await this.requirePackage(context.tenantId, taskId);
    if (!(await this.isTaskVisible(context, task))) throw new Error("WORK_TASK_NOT_VISIBLE");
    const timeline = await this.repository.listPackageEvents(context.tenantId, taskId);
    return { task: withDueState(task), timeline };
  }

  /** RQ-4/F-080: read-only progress fact card for the agent. */
  async taskProgressFact(context: RequestContext, taskId: string) {
    requirePermission(context, "work_task:read");
    const task = await this.requirePackage(context.tenantId, taskId);
    if (!(await this.isTaskVisible(context, task))) throw new Error("WORK_TASK_NOT_VISIBLE");
    const [timeline, handoffs] = await Promise.all([
      this.repository.listPackageEvents(context.tenantId, taskId),
      this.repository.listHandoffs(context.tenantId, [taskId]),
    ]);
    return { task: withDueState(task), timeline, handoffs };
  }

  /** F-082: read-only board of all visible tasks with due state. */
  async board(context: RequestContext) {
    const data = await this.taskData(context);
    const orgUnits = await this.repository.listOrgUnits(context.tenantId);
    return { ...data, orgUnits };
  }

  /** 细粒度只读数据：可见任务、成员与关联使命，供各视图按需组合。 */
  async taskData(context: RequestContext) {
    requirePermission(context, "work_task:read");
    const [workspace, people, missions] = await Promise.all([
      this.workspace(context),
      this.repository.listPeople(context.tenantId),
      this.repository.listMissions(context.tenantId),
    ]);
    const byId = new Map<string, WorkPackageWithDue>();
    for (const list of [workspace.myTasks, workspace.availableTasks, workspace.publishedByMe, workspace.handoffTasks]) {
      for (const item of list) if (!byId.has(item.id)) byId.set(item.id, item);
    }
    const tasks = [...byId.values()].filter((item) => !item.isTemplate);
    return { tasks, people, missions: missions.filter((mission) => !mission.isTemplate && tasks.some((task) => task.missionId === mission.id)), actorId: context.actorId, generatedAt: new Date().toISOString() };
  }

  /** F-084: 成员负载只读视图（供 Agent 定向分派前查询）。 */
  async memberWorkload(context: RequestContext) {
    requirePermission(context, "work_task:read");
    return this.repository.listPeople(context.tenantId);
  }

  /** F-086: 进度报表导出数据（按人/项目/时段过滤）。 */
  async exportReport(context: RequestContext, input: ExportReportInput) {
    requirePermission(context, "work_task:read");
    const [packages, missions, people] = await Promise.all([
      this.repository.listPackages(context.tenantId),
      this.repository.listMissions(context.tenantId),
      this.repository.listPeople(context.tenantId),
    ]);
    const missionById = new Map(missions.map((item) => [item.id, item]));
    const peopleById = new Map(people.map((item) => [item.id, item]));
    const from = input.from ? new Date(input.from).getTime() : null;
    const to = input.to ? new Date(input.to).getTime() : null;
    const rows = packages
      .filter((item) => !item.isTemplate)
      .filter((item) => input.scope !== "mine" || item.assigneeId === context.actorId)
      .filter((item) => input.scope !== "published" || item.publishedBy === context.actorId)
      .filter((item) => !input.status || item.status === input.status)
      .filter((item) => input.overdueOnly !== "true" || dueStateOf(item) === "overdue")
      .filter((item) => !input.assigneeId || item.assigneeId === input.assigneeId)
      .filter((item) => !input.missionId || item.missionId === input.missionId)
      .filter((item) => { const due = new Date(item.dueAt).getTime(); return (!from || due >= from) && (!to || due <= to); })
      .map((item) => {
        const assignee = item.assigneeId ? peopleById.get(item.assigneeId) : undefined;
        return {
          id: item.id,
          title: item.title,
          missionTitle: missionById.get(item.missionId)?.title ?? "",
          status: item.status,
          assigneeName: assignee?.displayName ?? "",
          orgName: assignee?.orgName ?? "",
          priority: item.priority,
          startedAt: item.startedAt ?? "",
          dueAt: item.dueAt,
          estimatedDays: item.estimatedDays ?? "",
          capacityPoints: item.capacityPoints,
          dueState: dueStateOf(item),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        };
      });
    const headers = ["任务ID", "任务标题", "所属任务/项目", "状态", "负责人", "部门", "优先级", "开始时间", "截止时间", "工期(天)", "容量点", "到期状态", "创建时间", "更新时间"];
    return { headers, rows, count: rows.length, generatedAt: new Date().toISOString() };
  }

  /** 后台到期提醒 + F-085 阻塞升级扫描（人工/Agent 触发，池消息按 source_run_id 幂等去重）。 */
  async runReminderScan(context: RequestContext, input: RunReminderScanInput) {
    requirePermission(context, "work_task:read");
    requirePermission(context, "message_pool:publish");
    return this.reminderScan(context.tenantId, {
      now: input.now ? new Date(input.now) : new Date(),
      dueSoonHours: input.dueSoonHours ?? 72,
      blockedEscalationHours: input.blockedEscalationHours ?? 24,
      attribution: { source: "agent", actorType: "user", actorId: context.actorId },
    });
  }

  /**
   * P4（第二半）：常驻调度器的系统入口。不经过 HTTP/Agent，也不借用任何同事身份：
   * 池消息与通知都以 system 署名写入（actor_id/author_id 为空），避免"定时提醒冒充某人发出"。
   * 该方法的调用点只有后台 Worker；HTTP 与 Agent 通道继续走 runReminderScan（按调用人署名）。
   */
  async runScheduledReminderScan(input: { tenantId: string; now?: Date; dueSoonHours?: number; blockedEscalationHours?: number }) {
    return this.reminderScan(input.tenantId, {
      now: input.now ?? new Date(),
      dueSoonHours: input.dueSoonHours ?? 72,
      blockedEscalationHours: input.blockedEscalationHours ?? 24,
      attribution: { source: "system", actorType: "system" },
    });
  }

  /** 提醒扫描的唯一实现：池消息（公司池公告）与"提醒到人"的通知共用同一批候选。 */
  private async reminderScan(tenantId: string, input: {
    now: Date;
    dueSoonHours: number;
    blockedEscalationHours: number;
    attribution: { source: WorkPoolMessage["source"]; actorType: WorkTaskNotification["actorType"]; actorId?: string };
  }) {
    const { now, attribution } = input;
    const [packages, people] = await Promise.all([
      this.repository.listPackages(tenantId),
      this.repository.listPeople(tenantId),
    ]);
    const peopleById = new Map(people.map((item) => [item.id, item]));
    const active = packages.filter((item) => !item.isTemplate && !["completed", "cancelled"].includes(item.status));
    const dateKey = now.toISOString().slice(0, 10);
    const candidates = collectTaskReminderCandidates(packages, { now, dueSoonHours: input.dueSoonHours, blockedEscalationHours: input.blockedEscalationHours });
    const created: Array<{ kind: string; packageId: string; messageId: string }> = [];
    const notificationItems: Array<{ kind: string; packageId: string; recipientId: string }> = [];
    let deduplicated = 0;
    let notificationsDeduplicated = 0;
    for (const candidate of candidates) {
      const assignee = candidate.package.assigneeId ? peopleById.get(candidate.package.assigneeId) : undefined;
      const subject = candidate.kind === "overdue" ? `⏰ 任务逾期提醒：${candidate.package.title}`
        : candidate.kind === "due_soon" ? `⏰ 任务临期提醒：${candidate.package.title}`
        : `🚧 任务阻塞升级：${candidate.package.title}`;
      const content = candidate.kind === "blocked_escalation"
        ? `任务「${candidate.package.title}」已阻塞约 ${candidate.hours.toFixed(1)} 天（阻塞原因：${candidate.package.blockedReason ?? "未填写"}）。请发布人与负责人确认处置。截止 ${candidate.package.dueAt}。`
        : `任务「${candidate.package.title}」${candidate.kind === "overdue" ? `已逾期约 ${candidate.hours.toFixed(1)} 天` : `约 ${candidate.hours.toFixed(1)} 天后到期`}，负责人：${assignee?.displayName ?? (candidate.package.assignmentMode === "open_claim" ? "待承接" : "未分派")}，截止 ${candidate.package.dueAt}。请及时推进。`;
      const dedupKey = `${candidate.kind === "blocked_escalation" ? "task-escalation" : "task-reminder"}:${candidate.package.id}:${candidate.kind}:${dateKey}`;
      const message = { ...createPoolMessage({
        tenantId, poolKey: "company", poolScope: "company", subject, content, kind: "notice",
        authorType: attribution.actorType, authorId: attribution.actorId, source: attribution.source,
      }), id: deterministicUuid(dedupKey) };
      const result = await this.repository.publishPoolMessage(message, messageEvent({ tenantId, poolKey: "company", poolScope: "company", messageId: message.id, eventType: "message_published", actorType: attribution.actorType, actorId: attribution.actorId }));
      if (result.created) created.push({ kind: candidate.kind, packageId: candidate.package.id, messageId: result.message.id });
      else deduplicated += 1;

      // 提醒到人：临期/逾期给负责人；阻塞升级同时给负责人与发布人（无人承接的公开任务没有收件人）。
      const kind: WorkTaskNotification["kind"] = candidate.kind === "overdue" ? "task_overdue" : candidate.kind === "due_soon" ? "task_due_soon" : "task_blocked";
      const title = candidate.kind === "overdue" ? `任务已逾期：${candidate.package.title}`
        : candidate.kind === "due_soon" ? `任务临期：${candidate.package.title}`
        : `任务阻塞待处置：${candidate.package.title}`;
      const body = candidate.kind === "blocked_escalation"
        ? `任务已阻塞约 ${candidate.hours.toFixed(1)} 天，原因：${candidate.package.blockedReason ?? "未填写"}。请与相关同事确认处置，截止 ${candidate.package.dueAt.slice(0, 10)}。`
        : candidate.kind === "overdue"
          ? `已逾期约 ${candidate.hours.toFixed(1)} 天（截止 ${candidate.package.dueAt.slice(0, 10)}），请尽快推进或说明阻塞原因。`
          : `约 ${candidate.hours.toFixed(1)} 天后到期（截止 ${candidate.package.dueAt.slice(0, 10)}），请及时推进。`;
      const recipients = [...new Set([
        candidate.package.assigneeId,
        candidate.kind === "blocked_escalation" ? candidate.package.publishedBy : undefined,
      ].filter((value): value is string => Boolean(value)))];
      for (const recipientId of recipients) {
        const items = reminderNotification({
          tenantId, recipientId, actorType: attribution.actorType, actorId: attribution.actorId,
          kind, title, body, packageId: candidate.package.id,
          dedupKey: `${dedupKey}:${recipientId}`, now,
        });
        if (!items.length) continue;
        const saved = await this.repository.saveNotifications(items);
        if (saved > 0) notificationItems.push({ kind, packageId: candidate.package.id, recipientId });
        else notificationsDeduplicated += 1;
      }
    }
    return {
      scanned: active.length,
      candidates: candidates.length,
      created: created.length,
      deduplicated,
      items: created,
      notificationsCreated: notificationItems.length,
      notificationsDeduplicated,
      notificationItems,
      ranAt: now.toISOString(),
      attribution: attribution.actorType,
    };
  }

  /**
   * 周期进度摘要：由常驻调度器按周期（日报/周报）发布到公司消息池。
   *
   * 与个人视角的区别：这条摘要面向整个租户（在办/风险/本周期完成），并以 system 署名发布——
   * 公司池是广播语义，把"某个人的个人视图"广播给全员既难读也容易误解。个人视角继续看
   * 工作台「我的」与任务进度看板。
   * 幂等：消息 ID 由「作用域 + 周期」确定（`task-summary:tenant:{scope}:{periodKey}`），
   * 重复调度或两个实例同时运行都只会留下一条；同一周期的第二次调用返回 `created=false`。
   */
  async generateScheduledSummary(input: { tenantId: string; scope?: "daily" | "weekly"; now?: Date }) {
    const scope = input.scope ?? "daily";
    const now = input.now ?? new Date();
    const periodKey = summaryPeriodKey(scope, now);
    const periodStart = new Date(`${periodKey}T00:00:00.000Z`);
    const packages = (await this.repository.listPackages(input.tenantId)).filter((item) => !item.isTemplate);
    const withDue = packages.map((item) => ({ ...item, dueState: dueStateOf(item, now) }));
    const active = withDue.filter((item) => !["completed", "cancelled"].includes(item.status));
    const count = (predicate: (item: WorkPackageWithDue) => boolean) => withDue.filter(predicate).length;
    const overdue = withDue.filter((item) => item.dueState === "overdue" && !["completed", "cancelled"].includes(item.status));
    const completed = withDue.filter((item) => item.status === "completed" && item.completedAt && new Date(item.completedAt) >= periodStart);
    const cancelled = withDue.filter((item) => item.status === "cancelled" && new Date(item.updatedAt) >= periodStart);
    const content = [
      `【工作进度摘要 · ${scope === "weekly" ? "周报" : "日报"} · ${periodKey}】`,
      `- 在办任务：${active.length} 项（进行中 ${count((item) => item.status === "in_progress")} / 待验收 ${count((item) => item.status === "in_review")} / 阻塞 ${count((item) => item.status === "blocked")} / 待承接 ${count((item) => item.status === "published" && item.assignmentMode === "open_claim")}）`,
      `- 风险：逾期 ${overdue.length} 项 · 临期（≤72 小时）${count((item) => item.dueState === "due_soon" && !["completed", "cancelled"].includes(item.status))} 项`,
      `- 本周期完成：${completed.length} 项 · 取消：${cancelled.length} 项`,
      ...(overdue.length ? [`- 逾期最长：${[...overdue].sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime()).slice(0, 3).map((item) => `${item.title}（截止 ${item.dueAt.slice(0, 10)}）`).join("；")}`] : []),
      `逾期与阻塞任务已单独提醒到负责人；明细见任务进度看板。`,
    ].join("\n");
    const message = { ...createPoolMessage({
      tenantId: input.tenantId, poolKey: "company", poolScope: "company",
      subject: `工作进度摘要（${scope === "weekly" ? "周报" : "日报"} · ${periodKey}）`,
      content, kind: "notice", authorType: "system", source: "system",
    }), id: deterministicUuid(`task-summary:tenant:${scope}:${periodKey}`) };
    const result = await this.repository.publishPoolMessage(message, messageEvent({
      tenantId: input.tenantId, poolKey: "company", poolScope: "company",
      messageId: message.id, eventType: "message_published", actorType: "system",
    }));
    return {
      scope, periodKey, summary: content, messageId: result.message.id, created: result.created,
      effective: active.length, generatedAt: now.toISOString(), attribution: "system" as const,
    };
  }
  private async isTaskVisible(context: RequestContext, task: WorkPackage): Promise<boolean> {
    if (task.publishedBy === context.actorId || task.assigneeId === context.actorId) return true;
    if (task.assignmentMode === "open_claim" && task.status === "published" && !task.assigneeId) {
      const people = await this.repository.listPeople(context.tenantId);
      const actorOrgUnitIds = new Set(people.filter((person) => person.id === context.actorId).flatMap((person) => person.orgUnitId ? [person.orgUnitId] : []));
      return !task.targetOrgUnitId || canAccessOrgScope(context, task.targetOrgUnitId) || actorOrgUnitIds.has(task.targetOrgUnitId);
    }
    return (await this.repository.listHandoffs(context.tenantId, [task.id])).some((item) => item.fromAssigneeId === context.actorId || item.toAssigneeId === context.actorId);
  }

  private async requirePackage(tenantId: string, id: string): Promise<WorkPackage> {
    const item = await this.repository.getPackage(tenantId, id);
    if (!item) throw new Error("WORK_PACKAGE_NOT_FOUND");
    return item;
  }

  private async freezeHandoffArtifacts(context: RequestContext, task: WorkPackage, artifactIds: string[]): Promise<WorkTaskHandoffArtifactSnapshot[]> {
    if (!artifactIds.length) return [];
    const uniqueIds = [...new Set(artifactIds)];
    const [artifacts, versions] = await Promise.all([
      Promise.all(uniqueIds.map((id) => this.repository.getArtifact(context.tenantId, id))),
      this.repository.getArtifactVersions(context.tenantId, uniqueIds),
    ]);
    if (artifacts.some((item) => !item)) throw new Error("WORK_HANDOFF_ARTIFACT_NOT_FOUND");
    const resolved = artifacts as WorkArtifact[];
    const inheritedArtifactIds = new Set((await this.repository.listHandoffs(context.tenantId, [task.id]))
      .filter((handoff) => handoff.status === "accepted" && handoff.toAssigneeId === task.assigneeId)
      .flatMap((handoff) => handoff.artifactSnapshots.map((snapshot) => snapshot.artifactId)));
    for (const artifact of resolved) {
      if (artifact.status !== "active") throw new Error("WORK_HANDOFF_ARTIFACT_NOT_ACTIVE");
      if (artifact.ownerId !== task.assigneeId && artifact.ownerId !== context.actorId && !inheritedArtifactIds.has(artifact.id) && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:artifact_ownership");
      if (["confidential", "restricted"].includes(artifact.classification) && !hasPermission(context, "work_task:admin")) throw new Error("POLICY_DENIED:work_task:artifact_classification");
    }
    return resolved.map((artifact) => {
      const version = versions.find((item) => item.artifactId === artifact.id && item.version === artifact.currentVersion);
      if (!version) throw new Error("WORK_HANDOFF_ARTIFACT_VERSION_MISSING");
      return {
        artifactId: artifact.id, artifactVersionId: version.id, version: version.version, title: artifact.title,
        fileName: version.fileName, mediaType: version.mediaType, contentDigest: version.contentDigest,
        classification: artifact.classification,
      };
    });
  }

  private publicArtifactVersion(value: WorkArtifactVersion) {
    const safe = { ...value };
    delete safe.storageRef;
    return safe;
  }
}
