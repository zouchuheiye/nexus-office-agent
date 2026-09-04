import { randomUUID } from "node:crypto";
import type { RequestContext } from "@/src/platform/context/request-context";
import type { TaskCommandRepository } from "@/src/modules/task-command/application/contracts";
import type { AppendPoolFeedbackInput, AppendTaskArtifactVersionInput, CreateTaskTemplateInput, ExportReportInput, GeneratePeriodicSummaryInput, InitiateTaskHandoffInput, PublishMissionInput, PublishPoolMessageInput, RegisterTaskArtifactInput, RespondToTaskHandoffInput, RunReminderScanInput, TransitionPackageInput, UpdateTaskTemplateInput } from "@/src/modules/task-command/application/schemas";
import { claimWorkPackage, collectTaskReminderCandidates, createConversationMessage, createMissionBundle, createPoolFeedback, createPoolMessage, createTaskHandoff, createTaskTemplateBundle, deterministicUuid, dueStateOf, handoffWorkPackage, respondToTaskHandoff, transitionWorkPackage, type WorkArtifact, type WorkArtifactVersion, type WorkConversationMessage, type WorkMessageEvent, type WorkMessagePool, type WorkPackage, type WorkTaskEvent, type WorkTaskHandoffArtifactSnapshot, type WorkTemplateField } from "@/src/modules/task-command/domain/task-command";

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
  return { ...input, id: randomUUID(), occurredAt: new Date().toISOString() };
}

function canAccessOrgScope(context: RequestContext, orgUnitId: string): boolean {
  return context.dataScopes.some((scope) =>
    scope.type === "tenant" ||
    (scope.type === "org_subtree" && scope.orgUnitIds.includes(orgUnitId)) ||
    (scope.type === "explicit" && scope.resourceIds.includes(orgUnitId)),
  );
}

type WorkPackageWithDue = WorkPackage & { dueState: "overdue" | "due_soon" | "normal" | "done" };

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
    const messagePools = hasPermission(context, "message_pool:read")
      ? await this.messagePools(context, people, orgUnits)
      : [];
    return {
      conversation,
      messages,
      people,
      orgUnits,
      missions: missions.filter((mission) => visible.some((item) => item.missionId === mission.id)),
      myTasks: visible.filter((item) => item.assigneeId === context.actorId && !item.isTemplate && !["completed", "cancelled"].includes(item.status)).map(withDueState),
      availableTasks: visible.filter((item) => !item.isTemplate && item.assignmentMode === "open_claim" && item.status === "published" && !item.assigneeId).map(withDueState),
      publishedByMe: visible.filter((item) => item.publishedBy === context.actorId).map(withDueState),
      templates: visible.filter((item) => item.publishedBy === context.actorId && item.isTemplate).map(withDueState),
      handoffTasks: visible.filter((item) => handoffParticipantPackageIds.has(item.id)).map(withDueState),
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
    const events: Omit<WorkTaskEvent, "sequence">[] = [
      event({ tenantId: context.tenantId, missionId: bundle.mission.id, eventType: "mission_published", actorId: context.actorId, audience: "tenant", payload: { title: bundle.mission.title, packageCount: bundle.packages.length } }),
      ...bundle.packages.map((item) => event({ tenantId: context.tenantId, missionId: item.missionId, packageId: item.id, eventType: "package_published", actorId: context.actorId, audience: item.assignmentMode === "open_claim" ? "tenant" : "participants", payload: { title: item.title, assigneeId: item.assigneeId, assignmentMode: item.assignmentMode, version: item.version } })),
    ];
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
    const result = await this.repository.publishMission(bundle.mission, bundle.packages, events);
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
    const changed = await this.repository.claimPackage({ current, next, expectedVersion, event: event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_claimed", actorId: context.actorId, audience: "participants", payload: { assigneeId: context.actorId, version: next.version } }) });
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
    const next = transitionWorkPackage(current, input);
    const changed = await this.repository.transitionPackage({ current, next, expectedVersion: input.expectedVersion, event: event({ tenantId: context.tenantId, missionId: current.missionId, packageId: current.id, eventType: "package_status_changed", actorId: context.actorId, audience: "participants", payload: { previousStatus: current.status, nextStatus: next.status, version: next.version } }) });
    if (!changed) throw new Error("WORK_PACKAGE_VERSION_CONFLICT");
    return next;
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
    return this.repository.initiateHandoff(handoff, event({
      tenantId: context.tenantId,
      missionId: current.missionId,
      packageId: current.id,
      eventType: "package_handoff_initiated",
      actorId: context.actorId,
      audience: "participants",
      payload: { handoffId: handoff.id, fromAssigneeId: handoff.fromAssigneeId, toAssigneeId: handoff.toAssigneeId, packageVersion: handoff.snapshot.packageVersion, artifactSnapshotCount: handoff.artifactSnapshots.length, legacyArtifactRefCount: handoff.artifactRefs.length },
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
    const changed = await this.repository.respondToHandoff({
      current,
      next,
      currentPackage: task,
      nextPackage,
      expectedVersion: input.expectedVersion,
      event: event({
        tenantId: context.tenantId,
        missionId: task.missionId,
        packageId: task.id,
        eventType: status === "accepted" ? "package_handoff_accepted" : "package_handoff_rejected",
        actorId: context.actorId,
        audience: "participants",
        payload: { handoffId: current.id, fromAssigneeId: current.fromAssigneeId, toAssigneeId: current.toAssigneeId, decision: input.decision, packageVersion: nextPackage?.version ?? task.version, artifactSnapshotCount: current.artifactSnapshots.length, legacyArtifactRefCount: current.artifactRefs.length },
      }),
    });
    if (!changed) throw new Error("WORK_HANDOFF_CHAIN_CHANGED");
    return { handoff: next, task: nextPackage ?? task };
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
    const [items, workspace] = await Promise.all([
      this.repository.listEvents(context.tenantId, context.actorId, after, 200),
      this.workspace(context),
    ]);
    const visiblePackageIds = new Set([...workspace.myTasks, ...workspace.availableTasks, ...workspace.publishedByMe].map(({ id }) => id));
    const visibleMissionIds = new Set(workspace.missions.map(({ id }) => id));
    return items.filter((item) => item.packageId ? visiblePackageIds.has(item.packageId) : visibleMissionIds.has(item.missionId)).slice(0, Math.min(limit, 200));
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

  /** 后台到期提醒 + F-085 阻塞升级扫描（每天/每小时由脚本触发，池消息按 source_run_id 幂等去重）。 */
  async runReminderScan(context: RequestContext, input: RunReminderScanInput) {
    requirePermission(context, "work_task:read");
    requirePermission(context, "message_pool:publish");
    const now = input.now ? new Date(input.now) : new Date();
    const dueSoonHours = input.dueSoonHours ?? 72;
    const blockedEscalationHours = input.blockedEscalationHours ?? 24;
    const [packages, people] = await Promise.all([
      this.repository.listPackages(context.tenantId),
      this.repository.listPeople(context.tenantId),
    ]);
    const peopleById = new Map(people.map((item) => [item.id, item]));
    const active = packages.filter((item) => !item.isTemplate && !["completed", "cancelled"].includes(item.status));
    const dateKey = now.toISOString().slice(0, 10);
    const candidates = collectTaskReminderCandidates(packages, { now, dueSoonHours, blockedEscalationHours });
    const created: Array<{ kind: string; packageId: string; messageId: string }> = [];
    let deduplicated = 0;
    for (const candidate of candidates) {
      const assignee = candidate.package.assigneeId ? peopleById.get(candidate.package.assigneeId) : undefined;
      const subject = candidate.kind === "overdue" ? `⏰ 任务逾期提醒：${candidate.package.title}`
        : candidate.kind === "due_soon" ? `⏰ 任务临期提醒：${candidate.package.title}`
        : `🚧 任务阻塞升级：${candidate.package.title}`;
      const content = candidate.kind === "blocked_escalation"
        ? `任务「${candidate.package.title}」已阻塞约 ${candidate.hours.toFixed(1)} 天（阻塞原因：${candidate.package.blockedReason ?? "未填写"}）。请发布人与负责人确认处置。截止 ${candidate.package.dueAt}。`
        : `任务「${candidate.package.title}」${candidate.kind === "overdue" ? `已逾期约 ${candidate.hours.toFixed(1)} 天` : `约 ${candidate.hours.toFixed(1)} 天后到期`}，负责人：${assignee?.displayName ?? (candidate.package.assignmentMode === "open_claim" ? "待承接" : "未分派")}，截止 ${candidate.package.dueAt}。请及时推进。`;
      const dedupKey = `${candidate.kind === "blocked_escalation" ? "task-escalation" : "task-reminder"}:${candidate.package.id}:${candidate.kind}:${dateKey}`;
      const message = { ...createPoolMessage({ tenantId: context.tenantId, poolKey: "company", poolScope: "company", subject, content, kind: "notice", authorId: context.actorId, source: "agent" }), id: deterministicUuid(dedupKey) };
      const result = await this.repository.publishPoolMessage(message, messageEvent({ tenantId: context.tenantId, poolKey: "company", poolScope: "company", messageId: message.id, eventType: "message_published", actorId: context.actorId }));
      if (result.created) created.push({ kind: candidate.kind, packageId: candidate.package.id, messageId: result.message.id });
      else deduplicated += 1;
    }
    return { scanned: active.length, candidates: candidates.length, created: created.length, deduplicated, items: created, ranAt: now.toISOString() };
  }

  /** F-083: 周期进度摘要（日报/周报草稿），发布到公司消息池（按期间幂等）。 */
  async generatePeriodicSummary(context: RequestContext, input: GeneratePeriodicSummaryInput) {
    requirePermission(context, "work_task:read");
    requirePermission(context, "message_pool:publish");
    const scope = input.scope ?? "daily";
    const now = input.now ? new Date(input.now) : new Date();
    const [workspace, packages] = await Promise.all([
      this.workspace(context),
      this.repository.listPackages(context.tenantId),
    ]);
    const dateKey = now.toISOString().slice(0, 10);
    const weekKey = (() => { const d = new Date(now); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d.toISOString().slice(0, 10); })();
    const periodKey = scope === "weekly" ? weekKey : dateKey;
    const done = packages.filter((item) => !item.isTemplate && ["completed", "cancelled"].includes(item.status) && (item.assigneeId === context.actorId || item.publishedBy === context.actorId));
    const byStatus = (list: Array<WorkPackage & { dueState?: string }>) => ({
      total: list.length,
      overdue: list.filter((item) => item.dueState === "overdue").length,
      dueSoon: list.filter((item) => item.dueState === "due_soon").length,
      blocked: list.filter((item) => item.status === "blocked").length,
    });
    const mine = byStatus(workspace.myTasks);
    const published = byStatus(workspace.publishedByMe);
    const available = byStatus(workspace.availableTasks);
    const content = [
      `【工作进度摘要 · ${scope === "weekly" ? "周报" : "日报"} · ${periodKey}】`,
      `- 我负责：${mine.total} 项（逾期 ${mine.overdue} / 临期 ${mine.dueSoon} / 阻塞 ${mine.blocked}）`,
      `- 我发布：${published.total} 项（逾期 ${published.overdue} / 临期 ${published.dueSoon} / 阻塞 ${published.blocked}）`,
      `- 待承接：${available.total} 项（逾期 ${available.overdue} / 临期 ${available.dueSoon}）`,
      `- 已完成/已取消：${done.length} 项`,
      `请确认后发出；如需详细任务列表可进入任务进度看板查看。`,
    ].join("\n");
    const message = { ...createPoolMessage({ tenantId: context.tenantId, poolKey: "company", poolScope: "company", subject: `工作进度摘要（${scope === "weekly" ? "周报" : "日报"} · ${periodKey}）`, content, kind: "notice", authorId: context.actorId, source: "agent" }), id: deterministicUuid(`task-summary:${scope}:${periodKey}`) };
    const result = await this.repository.publishPoolMessage(message, messageEvent({ tenantId: context.tenantId, poolKey: "company", poolScope: "company", messageId: message.id, eventType: "message_published", actorId: context.actorId }));
    return { scope, periodKey, summary: content, messageId: result.message.id, created: result.created, generatedAt: now.toISOString() };
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
