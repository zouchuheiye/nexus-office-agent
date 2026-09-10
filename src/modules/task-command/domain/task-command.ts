import { createHash, randomUUID } from "node:crypto";
import type { DataClassification } from "@/src/platform/security/data-classification";

export type WorkPriority = "critical" | "high" | "medium" | "low";
export type AssignmentMode = "direct" | "open_claim";
export type WorkMissionStatus = "active" | "completed" | "cancelled";
export type WorkPackageStatus = "published" | "assigned" | "claimed" | "in_progress" | "blocked" | "in_review" | "completed" | "cancelled";
export type WorkTaskHandoffStatus = "pending" | "accepted" | "rejected";
export type WorkArtifactStatus = "active" | "revoked";
export type WorkTemplateField = "工作目标" | "任务说明" | "负责人或承接范围" | "截止时间" | "验收标准" | "优先级" | "容量点" | "所需技能" | "任务开始时间" | "工期";

export type WorkConversation = {
  id: string;
  tenantId: string;
  ownerId: string;
  title: string;
  status: "active" | "archived";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkConversationMessage = {
  id: string;
  tenantId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  runId?: string;
  route: { skills: string[]; tools: string[] };
  citations: Array<{ id: string; label: string; excerpt: string; objectType: string }>;
  createdAt: string;
};

export type WorkPerson = {
  id: string;
  displayName: string;
  orgUnitId?: string;
  orgName?: string;
  positionName?: string;
  activeTaskCount: number;
  /** F-084: 进行中（assigned/claimed/in_progress）任务数 */
  inProgressTaskCount: number;
  /** F-084: 7 天内到期（未完成）任务数 */
  dueSoonTaskCount: number;
  /** F-084: 未完成任务容量点合计 */
  capacityPoints: number;
};

export type WorkOrgUnit = {
  id: string;
  name: string;
};

export type WorkMission = {
  id: string;
  tenantId: string;
  conversationId: string;
  projectId?: string;
  title: string;
  objective: string;
  priority: WorkPriority;
  dueAt: string;
  status: WorkMissionStatus;
  publishedBy: string;
  source: "human" | "agent";
  sourceRunId?: string;
  isTemplate: boolean;
  missingFields: WorkTemplateField[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkPackage = {
  id: string;
  tenantId: string;
  missionId: string;
  ordinal: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  requiredSkills: string[];
  assignmentMode: AssignmentMode;
  assigneeId?: string;
  targetOrgUnitId?: string;
  publishedBy: string;
  isTemplate: boolean;
  missingFields: WorkTemplateField[];
  priority: WorkPriority;
  dueAt: string;
  startedAt?: string;
  estimatedDays?: number;
  capacityPoints: number;
  status: WorkPackageStatus;
  evidenceRefs: string[];
  blockedReason?: string;
  claimedAt?: string;
  completedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * P3：任务包下的可勾选子任务（拆分清单）。
 * 二态 pending/done + 可选完成说明与证据引用；谁都能拆，但每条都记录添加人与操作时间。
 * 勾选/拆分写包时以 expectedVersion CAS 防并发覆盖。
 */
export type WorkPackageSubtaskStatus = "pending" | "done";
export type WorkPackageSubtask = {
  id: string;
  tenantId: string;
  missionId: string;
  packageId: string;
  title: string;
  status: WorkPackageSubtaskStatus;
  sortOrder: number;
  doneBy?: string;
  doneAt?: string;
  doneNote?: string;
  evidenceRefs: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type WorkPackageProgress = { done: number; total: number };

export function progressOfSubtasks(subtasks: WorkPackageSubtask[]): WorkPackageProgress {
  return { done: subtasks.filter((item) => item.status === "done").length, total: subtasks.length };
}

/** P3 决策 4：in_review/completed/cancelled 后禁止新增或删除子任务，退回(in_progress)后才可再拆。 */
export function canMutatePackageSubtasks(packageStatus: WorkPackageStatus): boolean {
  return !["in_review", "completed", "cancelled"].includes(packageStatus);
}

export function allSubtasksDone(subtasks: WorkPackageSubtask[]): boolean {
  return subtasks.length > 0 && subtasks.every((item) => item.status === "done");
}

export function createWorkPackageSubtask(input: {
  tenantId: string;
  missionId: string;
  packageId: string;
  title: string;
  sortOrder: number;
  createdBy: string;
}, now = new Date()): WorkPackageSubtask {
  const timestamp = now.toISOString();
  const title = input.title.trim();
  if (title.length < 2) throw new Error("WORK_SUBTASK_TITLE_REQUIRED");
  return {
    id: randomUUID(), tenantId: input.tenantId, missionId: input.missionId, packageId: input.packageId,
    title, status: "pending", sortOrder: input.sortOrder, evidenceRefs: [], createdBy: input.createdBy,
    createdAt: timestamp, updatedAt: timestamp, version: 1,
  };
}

export function completeWorkPackageSubtask(value: WorkPackageSubtask, input: { doneBy: string; note?: string; evidenceRefs?: string[] }, now = new Date()): WorkPackageSubtask {
  if (value.status === "done") throw new Error("WORK_SUBTASK_ALREADY_DONE");
  const timestamp = now.toISOString();
  return {
    ...value,
    status: "done",
    doneBy: input.doneBy,
    doneAt: timestamp,
    doneNote: input.note?.trim() || undefined,
    evidenceRefs: [...new Set(input.evidenceRefs ?? [])],
    version: value.version + 1,
    updatedAt: timestamp,
  };
}

export function reopenWorkPackageSubtask(value: WorkPackageSubtask, now = new Date()): WorkPackageSubtask {
  if (value.status !== "done") throw new Error("WORK_SUBTASK_NOT_DONE");
  const timestamp = now.toISOString();
  return {
    ...value,
    status: "pending",
    doneBy: undefined,
    doneAt: undefined,
    doneNote: undefined,
    evidenceRefs: [],
    version: value.version + 1,
    updatedAt: timestamp,
  };
}

export type WorkTaskEvent = {
  sequence: number;
  id: string;
  tenantId: string;
  missionId: string;
  packageId?: string;
  eventType: "mission_published" | "package_published" | "package_claimed" | "package_status_changed" | "package_handoff_initiated" | "package_handoff_accepted" | "package_handoff_rejected" | "package_progress_updated";
  actorId: string;
  audience: "tenant" | "participants";
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type WorkTaskHandoffSnapshot = {
  packageVersion: number;
  status: WorkPackageStatus;
  title: string;
  description: string;
  acceptanceCriteria: string;
  requiredSkills: string[];
  evidenceRefs: string[];
  dueAt: string;
};

/**
 * Artifact metadata is intentionally separated from the binary object. A storage integration
 * owns download authorization; task handoffs carry an immutable digest/version snapshot only.
 */
export type WorkArtifact = {
  id: string;
  tenantId: string;
  ownerId: string;
  title: string;
  classification: DataClassification;
  status: WorkArtifactStatus;
  currentVersion: number;
  createdAt: string;
};

export type WorkArtifactVersion = {
  id: string;
  tenantId: string;
  artifactId: string;
  version: number;
  fileName: string;
  mediaType: string;
  contentDigest: string;
  storageRef?: string;
  createdBy: string;
  createdAt: string;
};

export type WorkTaskHandoffArtifactSnapshot = {
  artifactId: string;
  artifactVersionId: string;
  version: number;
  title: string;
  fileName: string;
  mediaType: string;
  contentDigest: string;
  classification: DataClassification;
};

export type WorkTaskHandoff = {
  id: string;
  tenantId: string;
  packageId: string;
  missionId: string;
  fromAssigneeId: string;
  toAssigneeId: string;
  initiatedBy: string;
  note: string;
  currentProgress?: string;
  completedWork?: string;
  pendingWork?: string;
  attentionPoints?: string;
  /** @deprecated Unversioned reference retained solely for backwards-compatible migration. */
  artifactRefs: string[];
  artifactSnapshots: WorkTaskHandoffArtifactSnapshot[];
  snapshot: WorkTaskHandoffSnapshot;
  source: "human" | "agent";
  sourceRunId?: string;
  status: WorkTaskHandoffStatus;
  responseNote?: string;
  respondedBy?: string;
  responseRunId?: string;
  createdAt: string;
  respondedAt?: string;
};

export type WorkMessagePool = {
  key: "company" | string;
  name: string;
  scope: "company" | "department";
  orgUnitId?: string;
};

/** P4 站内通知：收件人自己的任务动态（分派/承接/交接/验收 + 定时提醒），与消息池广播语义分开。 */
export const WORK_NOTIFICATION_KINDS = [
  "task_assigned", "task_claimed", "handoff_requested", "handoff_responded", "review_requested", "review_decided",
  "task_due_soon", "task_overdue", "task_blocked",
] as const;

export type WorkNotificationKind = (typeof WORK_NOTIFICATION_KINDS)[number];

export type WorkTaskNotification = {
  id: string;
  tenantId: string;
  recipientId: string;
  /** system 署名表示由常驻调度器发出，此时 actorId 为空（不冒名任何同事）。 */
  actorType: "user" | "system";
  actorId?: string;
  kind: WorkNotificationKind;
  title: string;
  body: string;
  refType: "work_package" | "work_handoff";
  refId: string;
  packageId: string;
  sourceEventId: string;
  createdAt: string;
  readAt?: string;
};

export type WorkPoolMessage = {
  id: string;
  tenantId: string;
  poolKey: WorkMessagePool["key"];
  poolScope: WorkMessagePool["scope"];
  orgUnitId?: string;
  subject: string;
  content: string;
  kind: "announcement" | "notice";
  /** system 署名表示由常驻调度器发出，此时 authorId 为空。 */
  authorType: "user" | "system";
  authorId?: string;
  source: "human" | "agent" | "system";
  sourceRunId?: string;
  createdAt: string;
};

export type WorkPoolFeedback = {
  id: string;
  tenantId: string;
  messageId: string;
  content: string;
  authorId: string;
  createdAt: string;
};

export type WorkMessageEvent = {
  sequence: number;
  id: string;
  tenantId: string;
  poolKey: WorkMessagePool["key"];
  poolScope: WorkMessagePool["scope"];
  orgUnitId?: string;
  messageId: string;
  eventType: "message_published" | "feedback_published";
  /** system 署名表示常驻调度器发布，此时 actorId 为空。 */
  actorType: "user" | "system";
  actorId?: string;
  occurredAt: string;
};

const TRANSITIONS: Record<WorkPackageStatus, WorkPackageStatus[]> = {
  published: ["claimed", "cancelled"],
  assigned: ["in_progress", "cancelled"],
  claimed: ["in_progress", "cancelled"],
  in_progress: ["blocked", "in_review", "completed", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  in_review: ["in_progress", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function createWorkConversation(tenantId: string, ownerId: string, now = new Date()): WorkConversation {
  const timestamp = now.toISOString();
  return { id: randomUUID(), tenantId, ownerId, title: "主工作对话", status: "active", version: 1, createdAt: timestamp, updatedAt: timestamp };
}

export function createConversationMessage(input: Omit<WorkConversationMessage, "id" | "createdAt">, now = new Date()): WorkConversationMessage {
  return { ...input, id: randomUUID(), createdAt: now.toISOString() };
}

export function createMissionBundle(input: {
  tenantId: string;
  conversationId: string;
  projectId?: string;
  title: string;
  objective: string;
  priority: WorkPriority;
  dueAt: string;
  publishedBy: string;
  source: WorkMission["source"];
  sourceRunId?: string;
  packages: Array<{
    title: string;
    description: string;
    acceptanceCriteria: string;
    requiredSkills: string[];
    assignmentMode: AssignmentMode;
    assigneeId?: string;
    targetOrgUnitId?: string;
    priority: WorkPriority;
    dueAt: string;
    startedAt?: string;
    estimatedDays?: number;
    capacityPoints: number;
    isTemplate?: boolean;
    missingFields?: WorkTemplateField[];
  }>;
  isTemplate?: boolean;
  missingFields?: WorkTemplateField[];
}, now = new Date()): { mission: WorkMission; packages: WorkPackage[] } {
  if (input.packages.length === 0) throw new Error("WORK_PACKAGES_REQUIRED");
  const timestamp = now.toISOString();
  const mission: WorkMission = {
    id: randomUUID(), tenantId: input.tenantId, conversationId: input.conversationId, projectId: input.projectId,
    title: input.title, objective: input.objective, priority: input.priority, dueAt: input.dueAt, status: "active",
    publishedBy: input.publishedBy, source: input.source, sourceRunId: input.sourceRunId, version: 1, createdAt: timestamp, updatedAt: timestamp,
    isTemplate: input.isTemplate ?? false, missingFields: [...new Set(input.missingFields ?? [])],
  };
  const packages = input.packages.map((item, index): WorkPackage => {
    if (item.assignmentMode === "direct" && !item.assigneeId) throw new Error("WORK_ASSIGNEE_REQUIRED");
    if (item.assignmentMode === "direct" && item.targetOrgUnitId) throw new Error("WORK_DIRECT_TARGET_ORG_FORBIDDEN");
    if (item.assignmentMode === "open_claim" && item.assigneeId) throw new Error("WORK_OPEN_CLAIM_ASSIGNEE_FORBIDDEN");
    if (!(input.isTemplate ?? false) && !item.startedAt) throw new Error("WORK_START_TIME_REQUIRED");
    if (!(input.isTemplate ?? false) && !item.estimatedDays) throw new Error("WORK_ESTIMATED_DAYS_REQUIRED");
    if (item.startedAt && item.dueAt && new Date(item.startedAt).getTime() >= new Date(item.dueAt).getTime()) throw new Error("WORK_INVALID_TIME_RANGE");
    return {
      id: randomUUID(), tenantId: input.tenantId, missionId: mission.id, ordinal: index + 1,
      title: item.title, description: item.description, acceptanceCriteria: item.acceptanceCriteria,
      requiredSkills: [...new Set(item.requiredSkills)], assignmentMode: item.assignmentMode, assigneeId: item.assigneeId,
      targetOrgUnitId: item.targetOrgUnitId,
      publishedBy: input.publishedBy, isTemplate: item.isTemplate ?? input.isTemplate ?? false, missingFields: [...new Set(item.missingFields ?? input.missingFields ?? [])], priority: item.priority, dueAt: item.dueAt, startedAt: item.startedAt, estimatedDays: item.estimatedDays, capacityPoints: item.capacityPoints,
      status: item.assignmentMode === "direct" ? "assigned" : "published", evidenceRefs: [], version: 1,
      createdAt: timestamp, updatedAt: timestamp,
    };
  });
  return { mission, packages };
}

export function createTaskTemplateBundle(input: {
  tenantId: string;
  conversationId: string;
  title: string;
  objective?: string;
  description?: string;
  acceptanceCriteria?: string;
  requiredSkills?: string[];
  assignmentMode?: AssignmentMode;
  assigneeId?: string;
  targetOrgUnitId?: string;
  priority?: WorkPriority;
  dueAt?: string;
  startedAt?: string;
  estimatedDays?: number;
  capacityPoints?: number;
  publishedBy: string;
  source: WorkMission["source"];
  sourceRunId?: string;
}, now = new Date()): { mission: WorkMission; packages: WorkPackage[] } {
  const missingFields: WorkTemplateField[] = [];
  const objective = input.objective?.trim() || `待补充“${input.title.trim()}”的工作目标`;
  const description = input.description?.trim() || "待补充任务说明";
  const acceptanceCriteria = input.acceptanceCriteria?.trim() || "待补充验收标准";
  const requiredSkills = [...new Set(input.requiredSkills?.map((item) => item.trim()).filter(Boolean) ?? [])];
  const assignmentMode: AssignmentMode = input.assignmentMode === "direct" && !input.assigneeId ? "open_claim" : input.assignmentMode ?? "open_claim";
  const priority = input.priority ?? "medium";
  const dueAt = input.dueAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const startedAt = input.startedAt ?? now.toISOString();
  const estimatedDays = input.estimatedDays ?? 7;
  const capacityPoints = input.capacityPoints ?? 1;
  if (!input.objective?.trim()) missingFields.push("工作目标");
  if (!input.description?.trim()) missingFields.push("任务说明");
  if (!input.acceptanceCriteria?.trim()) missingFields.push("验收标准");
  if (!input.assignmentMode || (assignmentMode === "direct" && !input.assigneeId) || (assignmentMode === "open_claim" && !input.targetOrgUnitId)) missingFields.push("负责人或承接范围");
  if (!input.dueAt) missingFields.push("截止时间");
  if (!input.startedAt) missingFields.push("任务开始时间");
  if (!input.estimatedDays) missingFields.push("工期");
  if (!input.priority) missingFields.push("优先级");
  if (!input.capacityPoints) missingFields.push("容量点");
  if (!requiredSkills.length) missingFields.push("所需技能");
  return createMissionBundle({
    tenantId: input.tenantId, conversationId: input.conversationId, title: input.title.trim(), objective,
    priority, dueAt, publishedBy: input.publishedBy, source: input.source, sourceRunId: input.sourceRunId, isTemplate: true, missingFields,
    packages: [{ title: input.title.trim(), description, acceptanceCriteria, requiredSkills, assignmentMode, assigneeId: assignmentMode === "direct" ? input.assigneeId : undefined,
      targetOrgUnitId: assignmentMode === "open_claim" ? input.targetOrgUnitId : undefined, priority, dueAt, startedAt, estimatedDays, capacityPoints, isTemplate: true, missingFields }],
  }, now);
}

export type WorkDueState = "overdue" | "due_soon" | "normal" | "done";

export function dueStateOf(task: Pick<WorkPackage, "status" | "dueAt">, now = new Date()): WorkDueState {
  if (task.status === "completed" || task.status === "cancelled") return "done";
  const due = new Date(task.dueAt).getTime();
  const current = now.getTime();
  if (due < current) return "overdue";
  if (due <= current + 48 * 60 * 60 * 1000) return "due_soon";
  return "normal";
}

export type TaskReminderCandidate = {
  kind: "overdue" | "due_soon" | "blocked_escalation";
  package: WorkPackage;
  /** 与提醒相关的时长（逾期/临期按天，阻塞按天）。 */
  hours: number;
};

/** 后台提醒扫描的纯逻辑：找出需要提醒的候选任务（临期/逾期/阻塞升级）。 */
export function collectTaskReminderCandidates(packages: WorkPackage[], options: { now?: Date; dueSoonHours?: number; blockedEscalationHours?: number } = {}): TaskReminderCandidate[] {
  const now = options.now ?? new Date();
  const dueSoonHours = options.dueSoonHours ?? 72;
  const blockedEscalationHours = options.blockedEscalationHours ?? 24;
  const active = packages.filter((item) => !item.isTemplate && !item.missingFields.length && !["completed", "cancelled"].includes(item.status));
  const candidates: TaskReminderCandidate[] = [];
  for (const item of active) {
    if (item.status === "blocked") continue; // 阻塞任务走升级通道，避免重复提醒
    const diffHours = (new Date(item.dueAt).getTime() - now.getTime()) / 3_600_000;
    if (diffHours < 0) candidates.push({ kind: "overdue", package: item, hours: Math.abs(diffHours) });
    else if (diffHours <= dueSoonHours) candidates.push({ kind: "due_soon", package: item, hours: diffHours });
  }
  for (const item of active.filter((entry) => entry.status === "blocked")) {
    const blockedHours = (now.getTime() - new Date(item.updatedAt).getTime()) / 3_600_000;
    if (blockedHours >= blockedEscalationHours) candidates.push({ kind: "blocked_escalation", package: item, hours: blockedHours });
  }
  return candidates;
}
const REMINDER_UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** 由业务键生成确定性 UUID（UUIDv5）：同一键永远得到同一 ID，用于消息幂等去重。 */
export function deterministicUuid(name: string): string {
  const namespace = Buffer.from(REMINDER_UUID_NAMESPACE.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(namespace).update(Buffer.from(name, "utf8")).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/** 消息池消息：system 署名（常驻调度器）不带 authorId；历史数据默认 human 署名。 */
export function createPoolMessage(input: Omit<WorkPoolMessage, "id" | "createdAt" | "authorType"> & { authorType?: WorkPoolMessage["authorType"] }, now = new Date()): WorkPoolMessage {
  const authorType = input.authorType ?? "user";
  return { ...input, authorType, authorId: authorType === "system" ? undefined : input.authorId, id: randomUUID(), createdAt: now.toISOString() };
}

/**
 * P4 站内通知：只按"某条事件通知某个人"生成，同一事件对同一收件人唯一。
 * 调用方负责跳过"自己操作自己"的情况（收件人等于操作人时不生成）。
 */
export function createWorkTaskNotification(input: Omit<WorkTaskNotification, "id" | "createdAt" | "readAt">, now = new Date()): WorkTaskNotification {
  return {
    ...input,
    title: input.title.trim(),
    body: input.body.trim(),
    actorId: input.actorType === "system" ? undefined : input.actorId,
    id: randomUUID(),
    createdAt: now.toISOString(),
  };
}

export function createPoolFeedback(input: Omit<WorkPoolFeedback, "id" | "createdAt">, now = new Date()): WorkPoolFeedback {
  return { ...input, id: randomUUID(), createdAt: now.toISOString() };
}

export function createTaskHandoff(input: Omit<WorkTaskHandoff, "id" | "createdAt" | "status" | "responseNote" | "respondedBy" | "respondedAt">, now = new Date()): WorkTaskHandoff {
  return {
    ...input,
    id: randomUUID(),
    note: input.note.trim(),
    currentProgress: input.currentProgress?.trim() || undefined,
    completedWork: input.completedWork?.trim() || undefined,
    pendingWork: input.pendingWork?.trim() || undefined,
    attentionPoints: input.attentionPoints?.trim() || undefined,
    artifactRefs: [...new Set(input.artifactRefs)],
    artifactSnapshots: [...new Map(input.artifactSnapshots.map((item) => [item.artifactVersionId, item])).values()],
    snapshot: {
      ...input.snapshot,
      requiredSkills: [...new Set(input.snapshot.requiredSkills)],
      evidenceRefs: [...new Set(input.snapshot.evidenceRefs)],
    },
    status: "pending",
    createdAt: now.toISOString(),
  };
}

export function respondToTaskHandoff(value: WorkTaskHandoff, input: { status: "accepted" | "rejected"; responseNote?: string; respondedBy: string; responseRunId?: string }, now = new Date()): WorkTaskHandoff {
  if (value.status !== "pending") throw new Error("WORK_HANDOFF_NOT_PENDING");
  if (input.respondedBy !== value.toAssigneeId) throw new Error("WORK_HANDOFF_RESPONDER_FORBIDDEN");
  if (input.status === "rejected" && !input.responseNote?.trim()) throw new Error("WORK_HANDOFF_REJECTION_REASON_REQUIRED");
  return {
    ...value,
    status: input.status,
    responseNote: input.responseNote?.trim() || undefined,
    respondedBy: input.respondedBy,
    responseRunId: input.responseRunId,
    respondedAt: now.toISOString(),
  };
}

export function revokeTaskHandoff(value: WorkTaskHandoff, input: { respondedBy: string; responseRunId?: string }, now = new Date()): WorkTaskHandoff {
  if (value.status !== "pending") throw new Error("WORK_HANDOFF_NOT_PENDING");
  if (input.respondedBy !== value.fromAssigneeId && input.respondedBy !== value.initiatedBy) throw new Error("WORK_HANDOFF_REVOKE_FORBIDDEN");
  return {
    ...value,
    status: "rejected",
    responseNote: "发起人撤回交接",
    respondedBy: input.respondedBy,
    responseRunId: input.responseRunId,
    respondedAt: now.toISOString(),
  };
}

export function claimWorkPackage(value: WorkPackage, actorId: string, now = new Date()): WorkPackage {
  if (value.assignmentMode !== "open_claim" || value.status !== "published" || value.assigneeId) throw new Error("WORK_PACKAGE_NOT_CLAIMABLE");
  const timestamp = now.toISOString();
  return { ...value, assigneeId: actorId, status: "claimed", claimedAt: timestamp, version: value.version + 1, updatedAt: timestamp };
}

export function transitionWorkPackage(value: WorkPackage, input: { nextStatus: WorkPackageStatus; evidenceRefs?: string[]; blockedReason?: string }, now = new Date()): WorkPackage {
  if (!TRANSITIONS[value.status].includes(input.nextStatus)) throw new Error(`WORK_PACKAGE_INVALID_TRANSITION:${value.status}:${input.nextStatus}`);
  if (input.nextStatus === "in_review" && !(input.evidenceRefs?.length || value.evidenceRefs.length)) throw new Error("WORK_REVIEW_EVIDENCE_REQUIRED");
  if (input.nextStatus === "completed" && !(input.evidenceRefs?.length || value.evidenceRefs.length)) throw new Error("WORK_COMPLETION_EVIDENCE_REQUIRED");
  if (input.nextStatus === "blocked" && !input.blockedReason?.trim()) throw new Error("WORK_BLOCKED_REASON_REQUIRED");
  const timestamp = now.toISOString();
  return {
    ...value,
    status: input.nextStatus,
    evidenceRefs: input.evidenceRefs ? [...new Set(input.evidenceRefs)] : value.evidenceRefs,
    blockedReason: input.nextStatus === "blocked" ? input.blockedReason?.trim() : undefined,
    completedAt: input.nextStatus === "completed" ? timestamp : value.completedAt,
    version: value.version + 1,
    updatedAt: timestamp,
  };
}

export function handoffWorkPackage(value: WorkPackage, nextAssigneeId: string, now = new Date()): WorkPackage {
  if (!value.assigneeId || ["published", "in_review", "completed", "cancelled"].includes(value.status)) throw new Error("WORK_HANDOFF_PACKAGE_NOT_TRANSFERABLE");
  const timestamp = now.toISOString();
  return {
    ...value,
    assigneeId: nextAssigneeId,
    version: value.version + 1,
    updatedAt: timestamp,
  };
}
