import type { WorkArtifact, WorkArtifactVersion, WorkConversation, WorkConversationMessage, WorkMessageEvent, WorkMission, WorkOrgUnit, WorkPackage, WorkPackageSubtask, WorkPerson, WorkPoolFeedback, WorkPoolMessage, WorkTaskEvent, WorkTaskHandoff, WorkTaskNotification } from "@/src/modules/task-command/domain/task-command";

export interface TaskCommandRepository {
  getOrCreatePrimaryConversation(tenantId: string, ownerId: string): Promise<WorkConversation>;
  appendMessage(message: WorkConversationMessage): Promise<void>;
  listMessages(tenantId: string, conversationId: string, limit: number): Promise<WorkConversationMessage[]>;
  listPeople(tenantId: string): Promise<WorkPerson[]>;
  listOrgUnits(tenantId: string): Promise<WorkOrgUnit[]>;
  listMissions(tenantId: string): Promise<WorkMission[]>;
  listPackages(tenantId: string): Promise<WorkPackage[]>;
  getPackage(tenantId: string, id: string): Promise<WorkPackage | null>;
  listPackageSubtasks(tenantId: string, packageId: string): Promise<WorkPackageSubtask[]>;
  listPackageSubtaskProgress(tenantId: string, packageIds: string[]): Promise<Array<{ packageId: string; done: number; total: number }>>;
  savePackageSubtask(subtask: WorkPackageSubtask, event: Omit<WorkTaskEvent, "sequence">): Promise<boolean>;
  deletePackageSubtask(tenantId: string, packageId: string, subtaskId: string, expectedVersion: number, event: Omit<WorkTaskEvent, "sequence">): Promise<boolean>;
  publishMission(mission: WorkMission, packages: WorkPackage[], events: Omit<WorkTaskEvent, "sequence">[], notifications?: WorkTaskNotification[]): Promise<{ mission: WorkMission; packages: WorkPackage[]; created: boolean }>;
  updateTaskTemplate(input: { currentMission: WorkMission; nextMission: WorkMission; currentPackage: WorkPackage; nextPackage: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence"> }): Promise<boolean>;
  claimPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number; notifications?: WorkTaskNotification[] }): Promise<boolean>;
  transitionPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number; notifications?: WorkTaskNotification[] }): Promise<boolean>;
  listEvents(tenantId: string, actorId: string, after: number, limit: number): Promise<WorkTaskEvent[]>;
  listPackageEvents(tenantId: string, packageId: string): Promise<WorkTaskEvent[]>;
  listHandoffs(tenantId: string, packageIds: string[]): Promise<WorkTaskHandoff[]>;
  getHandoff(tenantId: string, id: string): Promise<WorkTaskHandoff | null>;
  createArtifact(artifact: WorkArtifact, initialVersion: WorkArtifactVersion): Promise<WorkArtifact>;
  getArtifact(tenantId: string, id: string): Promise<WorkArtifact | null>;
  getArtifactVersions(tenantId: string, artifactIds: string[]): Promise<WorkArtifactVersion[]>;
  appendArtifactVersion(artifact: WorkArtifact, version: WorkArtifactVersion, expectedVersion: number): Promise<boolean>;
  initiateHandoff(handoff: WorkTaskHandoff, event: Omit<WorkTaskEvent, "sequence">, notifications?: WorkTaskNotification[]): Promise<{ handoff: WorkTaskHandoff; created: boolean }>;
  respondToHandoff(input: { current: WorkTaskHandoff; next: WorkTaskHandoff; currentPackage: WorkPackage; nextPackage?: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence">; notifications?: WorkTaskNotification[] }): Promise<boolean>;
  listNotifications(tenantId: string, recipientId: string, options: { unreadOnly?: boolean; limit: number }): Promise<WorkTaskNotification[]>;
  /** 后台提醒扫描的批量写入：按 (tenant_id, recipient_id, source_event_id) 幂等，返回真正新增的条数。 */
  saveNotifications(notifications: WorkTaskNotification[]): Promise<number>;
  countUnreadNotifications(tenantId: string, recipientId: string): Promise<number>;
  getNotification(tenantId: string, id: string): Promise<WorkTaskNotification | null>;
  markNotificationRead(tenantId: string, id: string, recipientId: string, readAt: string): Promise<boolean>;
  markAllNotificationsRead(tenantId: string, recipientId: string, readAt: string): Promise<number>;
  /**
   * 留存清理：删除 `createdAt < createdBefore` 的通知，`onlyRead=true` 时只删已读的。
   * 返回真正删除的条数（调用方按批循环，达到上限就停）。
   */
  deleteNotifications(tenantId: string, input: { createdBefore: string; onlyRead: boolean; limit: number }): Promise<number>;
  listPoolMessages(tenantId: string): Promise<WorkPoolMessage[]>;
  listPoolFeedback(tenantId: string, messageIds: string[]): Promise<WorkPoolFeedback[]>;
  getPoolMessage(tenantId: string, id: string): Promise<WorkPoolMessage | null>;
  publishPoolMessage(message: WorkPoolMessage, event: Omit<WorkMessageEvent, "sequence">): Promise<{ message: WorkPoolMessage; created: boolean }>;
  appendPoolFeedback(feedback: WorkPoolFeedback, event: Omit<WorkMessageEvent, "sequence">): Promise<void>;
  listMessageEvents(tenantId: string, after: number, limit: number): Promise<WorkMessageEvent[]>;
}
