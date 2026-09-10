import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });
const priority = z.enum(["critical", "high", "medium", "low"]);
const dataClassification = z.enum(["public", "internal", "confidential", "restricted"]);
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/i, "内容摘要必须是 SHA-256 十六进制值。");

/**
 * A4/P2：验收证据先做格式校验，再补附件上传（决策点 6）。
 * 只接受 http(s) 链接或“类型:文档/记录引用”形如 document:xxx / minutes:… / artifact:uuid，
 * 拒绝“已完成”这类无法核验的自由文本。格式由 schema 强制，HTTP 与 Agent 写通道共用。
 */
export const evidenceReference = z.string().trim().min(2).max(240).refine(
  (value) => /^https?:\/\/\S+$/i.test(value) || /^[a-z][a-z0-9_-]*:[^\s]{1,219}$/i.test(value),
  "验收证据必须是 http(s) 链接，或“类型:引用”形式的文档/记录 ID（如 document:acceptance-v1、minutes:weekly-ops:2026-W32、artifact:${uuid}），不接受无法核验的自由文本。",
);

export const evidenceRefs = z.array(evidenceReference).max(20).optional();

export const publishMissionSchema = z.object({
  conversationId: z.uuid(),
  projectId: z.uuid().optional(),
  title: z.string().trim().min(2).max(160),
  objective: z.string().trim().min(2).max(1200).optional(),
  priority: priority.optional(),
  dueAt: isoDateTime.optional(),
  packages: z.array(z.object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().min(2).max(1200).optional(),
    acceptanceCriteria: z.string().trim().min(2).max(800).optional(),
    requiredSkills: z.array(z.string().trim().min(1).max(80)).max(12).optional().default([]),
    assignmentMode: z.enum(["direct", "open_claim"]).optional(),
    assigneeId: z.uuid().optional(),
    targetOrgUnitId: z.uuid().optional(),
    priority: priority.optional(),
    dueAt: isoDateTime.optional(),
    startedAt: isoDateTime.optional(),
    estimatedDays: z.number().int().min(1).max(365).optional(),
    capacityPoints: z.number().int().min(1).max(40).optional(),
  }).strict().superRefine((value, context) => {
    if (value.startedAt && value.dueAt && new Date(value.startedAt).getTime() >= new Date(value.dueAt).getTime()) context.addIssue({ code: "custom", path: ["startedAt"], message: "开始时间必须早于截止时间。" });
    if (value.assignmentMode === "direct" && !value.assigneeId) context.addIssue({ code: "custom", path: ["assigneeId"], message: "定向分派必须指定负责人。" });
    if (value.assignmentMode === "direct" && value.targetOrgUnitId) context.addIssue({ code: "custom", path: ["targetOrgUnitId"], message: "定向个人任务不能同时指定部门。" });
    if (value.assignmentMode === "open_claim" && value.assigneeId) context.addIssue({ code: "custom", path: ["assigneeId"], message: "公开承接任务不能预设负责人。" });
  })).min(1).max(20),
}).strict();

export const createTaskTemplateSchema = z.object({
  conversationId: z.uuid(),
  title: z.string().trim().min(2).max(160),
  objective: z.string().trim().min(2).max(1200).optional(),
  description: z.string().trim().min(2).max(1200).optional(),
  acceptanceCriteria: z.string().trim().min(2).max(800).optional(),
  requiredSkills: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  assignmentMode: z.enum(["direct", "open_claim"]).optional(),
  assigneeId: z.uuid().optional(),
  targetOrgUnitId: z.uuid().optional(),
  priority: priority.optional(),
  dueAt: isoDateTime.optional(),
  startedAt: isoDateTime.optional(),
  estimatedDays: z.number().int().min(1).max(365).optional(),
  capacityPoints: z.number().int().min(1).max(40).optional(),
}).strict();

export const updateTaskTemplateSchema = z.object({
  taskId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(2).max(160).optional(),
  objective: z.string().trim().min(2).max(1200).optional(),
  description: z.string().trim().min(2).max(1200).optional(),
  acceptanceCriteria: z.string().trim().min(2).max(800).optional(),
  requiredSkills: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  assignmentMode: z.enum(["direct", "open_claim"]).optional(),
  assigneeId: z.uuid().nullable().optional(),
  targetOrgUnitId: z.uuid().nullable().optional(),
  priority: priority.optional(),
  dueAt: isoDateTime.optional(),
  startedAt: isoDateTime.optional(),
  estimatedDays: z.number().int().min(1).max(365).optional(),
  capacityPoints: z.number().int().min(1).max(40).optional(),
}).strict();

export const claimPackageSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export const transitionPackageSchema = z.object({
  expectedVersion: z.number().int().positive(),
  nextStatus: z.enum(["published", "assigned", "claimed", "in_progress", "blocked", "in_review", "completed", "cancelled"]),
  evidenceRefs,
  blockedReason: z.string().trim().min(4).max(500).optional(),
  /** P2: 验收退回（in_review → in_progress）时记录退回原因，进入事件链审计。 */
  reviewNote: z.string().trim().min(4).max(500).optional(),
}).strict();

export const listPackageSubtasksSchema = z.object({ packageId: z.uuid() }).strict();

export const addPackageSubtaskSchema = z.object({
  packageId: z.uuid(),
  title: z.string().trim().min(2).max(160),
  /** 可选完成说明与证据引用（http 链接或“类型:引用”），建立时可为空。 */
  note: z.string().trim().min(2).max(800).optional(),
  evidenceRefs,
}).strict();

export const updatePackageSubtaskSchema = z.object({
  packageId: z.uuid(),
  subtaskId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  /** true=标为完成；false=重新打开为待办 */
  done: z.boolean(),
  note: z.string().trim().min(2).max(800).optional(),
  evidenceRefs,
}).strict();

export const deletePackageSubtaskSchema = z.object({
  packageId: z.uuid(),
  subtaskId: z.uuid(),
  expectedVersion: z.number().int().positive(),
}).strict();

export type ListPackageSubtasksInput = z.infer<typeof listPackageSubtasksSchema>;
export type AddPackageSubtaskInput = z.infer<typeof addPackageSubtaskSchema>;
export type UpdatePackageSubtaskInput = z.infer<typeof updatePackageSubtaskSchema>;
export type DeletePackageSubtaskInput = z.infer<typeof deletePackageSubtaskSchema>;

export const initiateTaskHandoffSchema = z.object({
  taskId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  toAssigneeId: z.uuid(),
  note: z.string().trim().min(4).max(1_200),
  currentProgress: z.string().trim().min(2).max(1_200),
  completedWork: z.string().trim().min(2).max(1_200),
  pendingWork: z.string().trim().min(2).max(1_200),
  attentionPoints: z.string().trim().max(800).optional(),
  artifactIds: z.array(z.uuid()).max(40).default([]),
  /** @deprecated Only accepted while older clients move to versioned artifacts. */
  artifactRefs: z.array(z.string().trim().min(2).max(240)).max(40).default([]),
}).strict();

export const registerTaskArtifactSchema = z.object({
  title: z.string().trim().min(2).max(160),
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, "mediaType 必须是有效 MIME 类型。"),
  contentDigest,
  storageRef: z.string().trim().min(1).max(500).optional(),
  classification: dataClassification.default("internal"),
}).strict();

export const appendTaskArtifactVersionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  fileName: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, "mediaType 必须是有效 MIME 类型。"),
  contentDigest,
  storageRef: z.string().trim().min(1).max(500).optional(),
}).strict();

export const respondToTaskHandoffSchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(["accept", "reject"]),
  responseNote: z.string().trim().min(4).max(800).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "reject" && !value.responseNote) context.addIssue({ code: "custom", path: ["responseNote"], message: "退回交接必须说明原因。" });
});

export const taskHandoffTrailSchema = z.object({ taskId: z.uuid() }).strict();

export const publishPoolMessageSchema = z.object({
  poolKey: z.union([z.literal("company"), z.uuid()]),
  subject: z.string().trim().min(2).max(160),
  content: z.string().trim().min(2).max(1_200),
  kind: z.enum(["announcement", "notice"]).optional(),
}).strict();

export const appendPoolFeedbackSchema = z.object({
  messageId: z.uuid(),
  content: z.string().trim().min(2).max(800),
}).strict();

export type PublishMissionInput = z.infer<typeof publishMissionSchema>;
export type CreateTaskTemplateInput = z.infer<typeof createTaskTemplateSchema>;
export type UpdateTaskTemplateInput = z.infer<typeof updateTaskTemplateSchema>;
export type TransitionPackageInput = z.infer<typeof transitionPackageSchema>;
export type InitiateTaskHandoffInput = z.input<typeof initiateTaskHandoffSchema>;
export type RegisterTaskArtifactInput = z.infer<typeof registerTaskArtifactSchema>;
export type AppendTaskArtifactVersionInput = z.infer<typeof appendTaskArtifactVersionSchema>;
export type RespondToTaskHandoffInput = z.infer<typeof respondToTaskHandoffSchema>;
export type PublishPoolMessageInput = z.infer<typeof publishPoolMessageSchema>;
export type AppendPoolFeedbackInput = z.infer<typeof appendPoolFeedbackSchema>;

export const exportReportSchema = z.object({
  groupBy: z.enum(["person", "project", "period"]).optional(),
  format: z.enum(["csv", "json"]).optional(),
  scope: z.enum(["all", "mine", "published"]).optional(),
  status: z.enum(["published", "assigned", "claimed", "in_progress", "blocked", "in_review", "completed", "cancelled"]).optional(),
  overdueOnly: z.enum(["true", "false"]).optional(),
  assigneeId: z.uuid().optional(),
  missionId: z.uuid().optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
}).strict();

export const runReminderScanSchema = z.object({
  now: isoDateTime.optional(),
  dueSoonHours: z.number().int().min(1).max(24 * 14).optional(),
  blockedEscalationHours: z.number().int().min(1).max(24 * 90).optional(),
}).strict();

export type ExportReportInput = z.infer<typeof exportReportSchema>;
export type RunReminderScanInput = z.infer<typeof runReminderScanSchema>;

/** P4 站内通知：只读本人列表（收件人由会话身份决定，不接受客户端指定）。 */
export const listNotificationsSchema = z.object({
  unreadOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;
