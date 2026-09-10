import type { TaskCommandRepository } from "@/src/modules/task-command/application/contracts";
import { createWorkConversation, type WorkArtifact, type WorkArtifactVersion, type WorkConversation, type WorkConversationMessage, type WorkMessageEvent, type WorkMission, type WorkOrgUnit, type WorkPackage, type WorkPackageSubtask, type WorkPerson, type WorkPoolFeedback, type WorkPoolMessage, type WorkTaskEvent, type WorkTaskHandoff, type WorkTaskNotification } from "@/src/modules/task-command/domain/task-command";
import { DEMO_MANAGER_ID, DEMO_TENANT_ID } from "@/src/platform/context/development-context";

export const DEMO_DELIVERY_OWNER_ID = "10000000-0000-4000-8000-000000000002";
export const DEMO_PRODUCT_OWNER_ID = "10000000-0000-4000-8000-000000000003";
export const DEMO_OPERATIONS_OWNER_ID = "10000000-0000-4000-8000-000000000004";
export const DEMO_MANAGEMENT_ORG_ID = "20000000-0000-4000-8000-000000000001";
export const DEMO_DELIVERY_ORG_ID = "20000000-0000-4000-8000-000000000002";
export const DEMO_PRODUCT_ORG_ID = "20000000-0000-4000-8000-000000000003";
export const DEMO_OPERATIONS_ORG_ID = "20000000-0000-4000-8000-000000000004";

export class InMemoryTaskCommandRepository implements TaskCommandRepository {
  private readonly conversations = new Map<string, WorkConversation>();
  private readonly messages: WorkConversationMessage[] = [];
  private readonly missions: WorkMission[] = [];
  private readonly packages: WorkPackage[] = [];
  private readonly subtasks = new Map<string, WorkPackageSubtask>();
  private readonly events: WorkTaskEvent[] = [];
  private readonly handoffs: WorkTaskHandoff[] = [];
  private readonly artifacts = new Map<string, WorkArtifact>();
  private readonly artifactVersions: WorkArtifactVersion[] = [];
  private readonly poolMessages: WorkPoolMessage[] = [];
  private readonly poolFeedback: WorkPoolFeedback[] = [];
  private readonly messageEvents: WorkMessageEvent[] = [];
  private readonly notifications: WorkTaskNotification[] = [];
  private sequence = 0;
  private messageSequence = 0;
  private readonly orgUnits: WorkOrgUnit[] = [
    { id: DEMO_MANAGEMENT_ORG_ID, name: "经营管理" },
    { id: DEMO_DELIVERY_ORG_ID, name: "交付中心" },
    { id: DEMO_PRODUCT_ORG_ID, name: "产品中心" },
    { id: DEMO_OPERATIONS_ORG_ID, name: "运营中心" },
  ];
  private readonly people: WorkPerson[] = [
    { id: DEMO_MANAGER_ID, displayName: "开发管理员", orgUnitId: DEMO_MANAGEMENT_ORG_ID, orgName: "经营管理", positionName: "企业负责人", activeTaskCount: 0, inProgressTaskCount: 0, dueSoonTaskCount: 0, capacityPoints: 0 },
    { id: DEMO_DELIVERY_OWNER_ID, displayName: "周然", orgUnitId: DEMO_DELIVERY_ORG_ID, orgName: "交付中心", positionName: "交付负责人", activeTaskCount: 0, inProgressTaskCount: 0, dueSoonTaskCount: 0, capacityPoints: 0 },
    { id: DEMO_PRODUCT_OWNER_ID, displayName: "林悦", orgUnitId: DEMO_PRODUCT_ORG_ID, orgName: "产品中心", positionName: "产品负责人", activeTaskCount: 0, inProgressTaskCount: 0, dueSoonTaskCount: 0, capacityPoints: 0 },
    { id: DEMO_OPERATIONS_OWNER_ID, displayName: "陈屿", orgUnitId: DEMO_OPERATIONS_ORG_ID, orgName: "运营中心", positionName: "运营负责人", activeTaskCount: 0, inProgressTaskCount: 0, dueSoonTaskCount: 0, capacityPoints: 0 },
  ];

  async getOrCreatePrimaryConversation(tenantId: string, ownerId: string) {
    const key = `${tenantId}:${ownerId}`;
    let value = this.conversations.get(key);
    if (!value) {
      value = createWorkConversation(tenantId, ownerId);
      this.conversations.set(key, structuredClone(value));
    }
    return structuredClone(value);
  }

  async appendMessage(message: WorkConversationMessage) {
    if (message.runId && this.messages.some((item) => item.tenantId === message.tenantId && item.runId === message.runId && item.role === message.role)) return;
    this.messages.push(structuredClone(message));
  }

  async listMessages(tenantId: string, conversationId: string, limit: number) {
    return structuredClone(this.messages.filter((item) => item.tenantId === tenantId && item.conversationId === conversationId).slice(-limit));
  }

  async listPeople(tenantId: string) {
    if (tenantId !== DEMO_TENANT_ID) return [];
    return structuredClone(this.people.map((person) => {
      const tasks = this.packages.filter((item) => item.tenantId === tenantId && item.assigneeId === person.id);
      const active = tasks.filter((item) => !["completed", "cancelled"].includes(item.status));
      const now = Date.now();
      return {
        ...person,
        activeTaskCount: active.length,
        inProgressTaskCount: tasks.filter((item) => ["assigned", "claimed", "in_progress"].includes(item.status)).length,
        dueSoonTaskCount: active.filter((item) => Date.parse(item.dueAt) <= now + 7 * 24 * 60 * 60 * 1000).length,
        capacityPoints: active.reduce((sum, item) => sum + item.capacityPoints, 0),
      };
    }));
  }

  async listOrgUnits(tenantId: string) { return tenantId === DEMO_TENANT_ID ? structuredClone(this.orgUnits) : []; }

  async listMissions(tenantId: string) { return structuredClone(this.missions.filter((item) => item.tenantId === tenantId)); }
  async listPackages(tenantId: string) { return structuredClone(this.packages.filter((item) => item.tenantId === tenantId)); }
  async getPackage(tenantId: string, id: string) { return structuredClone(this.packages.find((item) => item.tenantId === tenantId && item.id === id) ?? null); }

  async listPackageSubtasks(tenantId: string, packageId: string) {
    return structuredClone([...this.subtasks.values()]
      .filter((item) => item.tenantId === tenantId && item.packageId === packageId)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
  }

  async listPackageSubtaskProgress(tenantId: string, packageIds: string[]) {
    const wanted = new Set(packageIds);
    const byPackage = new Map<string, { done: number; total: number }>();
    for (const item of this.subtasks.values()) {
      if (item.tenantId !== tenantId || !wanted.has(item.packageId)) continue;
      const entry = byPackage.get(item.packageId) ?? { done: 0, total: 0 };
      entry.total += 1;
      if (item.status === "done") entry.done += 1;
      byPackage.set(item.packageId, entry);
    }
    return [...byPackage.entries()].map(([packageId, value]) => ({ packageId, ...value }));
  }

  async savePackageSubtask(subtask: WorkPackageSubtask, event: Omit<WorkTaskEvent, "sequence">) {
    const key = `${subtask.tenantId}:${subtask.packageId}:${subtask.id}`;
    const current = this.subtasks.get(key);
    if (current && current.version !== subtask.version - 1) return false;
    this.subtasks.set(key, structuredClone(subtask));
    this.events.push({ ...structuredClone(event), sequence: ++this.sequence });
    return true;
  }

  async deletePackageSubtask(tenantId: string, packageId: string, subtaskId: string, expectedVersion: number, event: Omit<WorkTaskEvent, "sequence">) {
    const key = `${tenantId}:${packageId}:${subtaskId}`;
    const current = this.subtasks.get(key);
    if (!current || current.version !== expectedVersion) return false;
    this.subtasks.delete(key);
    this.events.push({ ...structuredClone(event), sequence: ++this.sequence });
    return true;
  }

  async publishMission(mission: WorkMission, packages: WorkPackage[], events: Omit<WorkTaskEvent, "sequence">[], notifications: WorkTaskNotification[] = []) {
    const existing = mission.sourceRunId ? this.missions.find((item) => item.tenantId === mission.tenantId && item.sourceRunId === mission.sourceRunId) : undefined;
    if (existing) return { mission: structuredClone(existing), packages: structuredClone(this.packages.filter((item) => item.missionId === existing.id)), created: false };
    this.missions.push(structuredClone(mission));
    this.packages.push(...structuredClone(packages));
    for (const item of events) this.events.push({ ...structuredClone(item), sequence: ++this.sequence });
    for (const item of notifications) this.insertNotification(item);
    return { mission: structuredClone(mission), packages: structuredClone(packages), created: true };
  }

  async updateTaskTemplate(input: { currentMission: WorkMission; nextMission: WorkMission; currentPackage: WorkPackage; nextPackage: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence"> }) {
    const missionIndex = this.missions.findIndex((item) => item.tenantId === input.currentMission.tenantId && item.id === input.currentMission.id && item.version === input.currentMission.version && item.isTemplate);
    const packageIndex = this.packages.findIndex((item) => item.tenantId === input.currentPackage.tenantId && item.id === input.currentPackage.id && item.version === input.expectedVersion && item.isTemplate);
    if (missionIndex < 0 || packageIndex < 0) return false;
    this.missions[missionIndex] = structuredClone(input.nextMission);
    this.packages[packageIndex] = structuredClone(input.nextPackage);
    this.events.push({ ...structuredClone(input.event), sequence: ++this.sequence });
    return true;
  }

  async claimPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number; notifications?: WorkTaskNotification[] }) {
    return this.updatePackage(input.current, input.next, input.expectedVersion, input.event, input.notifications);
  }

  async transitionPackage(input: { current: WorkPackage; next: WorkPackage; event: Omit<WorkTaskEvent, "sequence">; expectedVersion: number; notifications?: WorkTaskNotification[] }) {
    return this.updatePackage(input.current, input.next, input.expectedVersion, input.event, input.notifications);
  }

  async listEvents(tenantId: string, actorId: string, after: number, limit: number) {
    void actorId;
    return structuredClone(this.events.filter((item) => item.tenantId === tenantId && item.sequence > after).slice(0, limit));
  }

  async listPackageEvents(tenantId: string, packageId: string) {
    return structuredClone(this.events.filter((item) => item.tenantId === tenantId && item.packageId === packageId));
  }

  async listHandoffs(tenantId: string, packageIds: string[]) {
    const ids = new Set(packageIds);
    return structuredClone(this.handoffs.filter((item) => item.tenantId === tenantId && ids.has(item.packageId)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async getHandoff(tenantId: string, id: string) {
    return structuredClone(this.handoffs.find((item) => item.tenantId === tenantId && item.id === id) ?? null);
  }

  async createArtifact(artifact: WorkArtifact, initialVersion: WorkArtifactVersion) {
    if (this.artifacts.has(`${artifact.tenantId}:${artifact.id}`)) throw new Error("WORK_ARTIFACT_CONFLICT");
    this.artifacts.set(`${artifact.tenantId}:${artifact.id}`, structuredClone(artifact));
    this.artifactVersions.push(structuredClone(initialVersion));
    return structuredClone(artifact);
  }

  async getArtifact(tenantId: string, id: string) {
    return structuredClone(this.artifacts.get(`${tenantId}:${id}`) ?? null);
  }

  async getArtifactVersions(tenantId: string, artifactIds: string[]) {
    const ids = new Set(artifactIds);
    return structuredClone(this.artifactVersions.filter((item) => item.tenantId === tenantId && ids.has(item.artifactId)).sort((left, right) => left.version - right.version));
  }

  async appendArtifactVersion(artifact: WorkArtifact, version: WorkArtifactVersion, expectedVersion: number) {
    const key = `${artifact.tenantId}:${artifact.id}`;
    const current = this.artifacts.get(key);
    if (!current || current.currentVersion !== expectedVersion || this.artifactVersions.some((item) => item.tenantId === artifact.tenantId && item.artifactId === artifact.id && item.version === version.version)) return false;
    this.artifacts.set(key, structuredClone({ ...current, currentVersion: version.version }));
    this.artifactVersions.push(structuredClone(version));
    return true;
  }

  async initiateHandoff(handoff: WorkTaskHandoff, event: Omit<WorkTaskEvent, "sequence">, notifications: WorkTaskNotification[] = []) {
    const existing = handoff.sourceRunId ? this.handoffs.find((item) => item.tenantId === handoff.tenantId && item.sourceRunId === handoff.sourceRunId) : undefined;
    if (existing) return { handoff: structuredClone(existing), created: false };
    this.handoffs.push(structuredClone(handoff));
    this.events.push({ ...structuredClone(event), sequence: ++this.sequence });
    for (const item of notifications) this.insertNotification(item);
    return { handoff: structuredClone(handoff), created: true };
  }

  async respondToHandoff(input: { current: WorkTaskHandoff; next: WorkTaskHandoff; currentPackage: WorkPackage; nextPackage?: WorkPackage; expectedVersion: number; event: Omit<WorkTaskEvent, "sequence">; notifications?: WorkTaskNotification[] }) {
    const handoffIndex = this.handoffs.findIndex((item) => item.tenantId === input.current.tenantId && item.id === input.current.id && item.status === "pending");
    const packageIndex = this.packages.findIndex((item) => item.tenantId === input.currentPackage.tenantId && item.id === input.currentPackage.id && item.version === input.expectedVersion && item.assigneeId === input.current.fromAssigneeId);
    if (handoffIndex < 0 || packageIndex < 0) return false;
    this.handoffs[handoffIndex] = structuredClone(input.next);
    if (input.nextPackage) this.packages[packageIndex] = structuredClone(input.nextPackage);
    this.events.push({ ...structuredClone(input.event), sequence: ++this.sequence });
    for (const item of input.notifications ?? []) this.insertNotification(item);
    return true;
  }

  /** 后台提醒扫描的批量写入；命中同一 (tenant, recipient, sourceEventId) 时视为已存在。 */
  async saveNotifications(notifications: WorkTaskNotification[]) {
    let saved = 0;
    for (const item of notifications) {
      const before = this.notifications.length;
      this.insertNotification(item);
      if (this.notifications.length > before) saved += 1;
    }
    return saved;
  }

  async listNotifications(tenantId: string, recipientId: string, options: { unreadOnly?: boolean; limit: number }) {
    const limit = Math.min(Math.max(options.limit, 1), 100);
    return structuredClone(this.notifications
      .filter((item) => item.tenantId === tenantId && item.recipientId === recipientId && (options.unreadOnly !== true || !item.readAt))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, limit));
  }

  async countUnreadNotifications(tenantId: string, recipientId: string) {
    return this.notifications.filter((item) => item.tenantId === tenantId && item.recipientId === recipientId && !item.readAt).length;
  }

  async getNotification(tenantId: string, id: string) {
    return structuredClone(this.notifications.find((item) => item.tenantId === tenantId && item.id === id) ?? null);
  }

  async markNotificationRead(tenantId: string, id: string, recipientId: string, readAt: string) {
    const index = this.notifications.findIndex((item) => item.tenantId === tenantId && item.id === id && item.recipientId === recipientId);
    if (index < 0) return false;
    if (!this.notifications[index].readAt) this.notifications[index] = { ...this.notifications[index], readAt };
    return true;
  }

  async markAllNotificationsRead(tenantId: string, recipientId: string, readAt: string) {
    let updated = 0;
    for (let index = 0; index < this.notifications.length; index += 1) {
      const item = this.notifications[index];
      if (item.tenantId !== tenantId || item.recipientId !== recipientId || item.readAt) continue;
      this.notifications[index] = { ...item, readAt };
      updated += 1;
    }
    return updated;
  }

  private async updatePackage(current: WorkPackage, next: WorkPackage, expectedVersion: number, event: Omit<WorkTaskEvent, "sequence">, notifications: WorkTaskNotification[] = []) {
    const index = this.packages.findIndex((item) => item.tenantId === current.tenantId && item.id === current.id);
    if (index < 0 || this.packages[index].version !== expectedVersion) return false;
    this.packages[index] = structuredClone(next);
    this.events.push({ ...structuredClone(event), sequence: ++this.sequence });
    for (const item of notifications) this.insertNotification(item);
    return true;
  }

  /** 同一事件对同一收件人只保留一条（与 PostgreSQL 唯一约束语义一致）。 */
  private insertNotification(value: WorkTaskNotification) {
    if (this.notifications.some((item) => item.tenantId === value.tenantId && item.recipientId === value.recipientId && item.sourceEventId === value.sourceEventId)) return;
    this.notifications.push(structuredClone(value));
  }

  async listPoolMessages(tenantId: string) {
    return structuredClone(this.poolMessages.filter((item) => item.tenantId === tenantId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
  }

  async listPoolFeedback(tenantId: string, messageIds: string[]) {
    const ids = new Set(messageIds);
    return structuredClone(this.poolFeedback.filter((item) => item.tenantId === tenantId && ids.has(item.messageId)).sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  async getPoolMessage(tenantId: string, id: string) {
    return structuredClone(this.poolMessages.find((item) => item.tenantId === tenantId && item.id === id) ?? null);
  }

  async publishPoolMessage(message: WorkPoolMessage, event: Omit<WorkMessageEvent, "sequence">) {
    const existing = message.sourceRunId
      ? this.poolMessages.find((item) => item.tenantId === message.tenantId && item.sourceRunId === message.sourceRunId)
      : this.poolMessages.find((item) => item.tenantId === message.tenantId && item.id === message.id);
    if (existing) return { message: structuredClone(existing), created: false };
    this.poolMessages.push(structuredClone(message));
    this.messageEvents.push({ ...structuredClone(event), sequence: ++this.messageSequence });
    return { message: structuredClone(message), created: true };
  }

  async appendPoolFeedback(feedback: WorkPoolFeedback, event: Omit<WorkMessageEvent, "sequence">) {
    this.poolFeedback.push(structuredClone(feedback));
    this.messageEvents.push({ ...structuredClone(event), sequence: ++this.messageSequence });
  }

  async listMessageEvents(tenantId: string, after: number, limit: number) {
    return structuredClone(this.messageEvents.filter((item) => item.tenantId === tenantId && item.sequence > after).slice(0, limit));
  }
}

const runtime = globalThis as typeof globalThis & { __nexusTaskCommandRepository?: InMemoryTaskCommandRepository; __nexusTaskCommandFixtureVersion?: number };

export function getDevelopmentTaskCommandRepository() {
  if (runtime.__nexusTaskCommandFixtureVersion !== 5) {
    runtime.__nexusTaskCommandRepository = new InMemoryTaskCommandRepository();
    runtime.__nexusTaskCommandFixtureVersion = 5;
  }
  return runtime.__nexusTaskCommandRepository!;
}
