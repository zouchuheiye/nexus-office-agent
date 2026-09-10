"use client";

import { useCallback, useEffect, useState } from "react";

export type WorkspacePerson = { id: string; displayName: string; orgName?: string; positionName?: string; activeTaskCount: number };
export type WorkspaceTask = {
  id: string; missionId: string; title: string; description: string; acceptanceCriteria: string; requiredSkills: string[];
  assignmentMode: "direct" | "open_claim"; assigneeId?: string; targetOrgUnitId?: string; publishedBy: string; priority: "critical" | "high" | "medium" | "low";
  dueAt: string; startedAt?: string; estimatedDays?: number; dueState?: "overdue" | "due_soon" | "normal" | "done"; capacityPoints: number; status: "published" | "assigned" | "claimed" | "in_progress" | "blocked" | "in_review" | "completed" | "cancelled";
  evidenceRefs: string[]; blockedReason?: string; isTemplate: boolean; missingFields: string[]; version: number;
  progress?: { done: number; total: number };
};
export type PackageSubtask = {
  id: string; title: string; status: "pending" | "done"; sortOrder: number; doneBy?: string; doneAt?: string; doneNote?: string;
  evidenceRefs: string[]; createdBy: string; createdAt: string; updatedAt: string; version: number;
};
export type PoolFeedback = { id: string; messageId: string; content: string; authorId: string; createdAt: string };
export type PoolMessage = { id: string; poolKey: string; subject: string; content: string; kind: "announcement" | "notice"; authorId: string; createdAt: string; feedback: PoolFeedback[] };
export type MessagePool = { key: string; name: string; scope: "company" | "department"; orgUnitId?: string; messages: PoolMessage[] };
export type TaskHandoff = {
  id: string; packageId: string; fromAssigneeId: string; toAssigneeId: string; note: string;
  currentProgress?: string; completedWork?: string; pendingWork?: string; attentionPoints?: string;
  artifactRefs: string[]; status: "pending" | "accepted" | "rejected";
  responseNote?: string; respondedBy?: string; createdAt: string; respondedAt?: string;
  snapshot: { packageVersion: number; title: string; description: string; acceptanceCriteria: string; evidenceRefs: string[]; dueAt: string };
};
export type TaskHandoffEntry = {
  handoff: TaskHandoff;
  task: WorkspaceTask;
  direction: "incoming" | "outgoing";
};
export type TimelineEvent = {
  id: string;
  sequence: number;
  tenantId?: string;
  missionId?: string;
  packageId?: string;
  eventType: string;
  actorId: string;
  audience?: "tenant" | "participants";
  occurredAt: string;
  payload: Record<string, unknown>;
};
/** P4 站内通知：只有收件人本人能看到（服务端按会话身份过滤）。 */
export type WorkspaceNotification = {
  id: string;
  recipientId: string;
  actorId: string;
  kind: "task_assigned" | "task_claimed" | "handoff_requested" | "handoff_responded" | "review_requested" | "review_decided";
  title: string;
  body: string;
  refType: "work_package" | "work_handoff";
  refId: string;
  packageId: string;
  createdAt: string;
  readAt?: string;
};
export type PersistedMessage = { id: string; role: "user" | "assistant" | "tool"; content: string; runId?: string; route: { skills: string[]; tools: string[] }; citations: Array<{ id: string; label: string; excerpt: string; objectType: string }>; createdAt: string };
export type WorkspaceData = {
  conversation: { id: string; title: string };
  messages: PersistedMessage[];
  people: WorkspacePerson[];
  orgUnits: Array<{ id: string; name: string }>;
  myTasks: WorkspaceTask[];
  availableTasks: WorkspaceTask[];
  publishedByMe: WorkspaceTask[];
  templates: WorkspaceTask[];
  handoffs: TaskHandoff[];
  pendingHandoffs: TaskHandoffEntry[];
  messagePools: MessagePool[];
  notifications: WorkspaceNotification[];
  unreadNotificationCount: number;
  generatedAt: string;
};

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "请求未完成");
  return payload.data as T;
}

/** P4：标记本人通知已读（服务端只接受收件人本人）。 */
export async function markNotificationRead(id: string) {
  return api<{ notification: WorkspaceNotification; unreadCount: number }>(`/api/v1/task-command/notifications/${id}/read`, { method: "POST" });
}

export async function markAllNotificationsRead() {
  return api<{ updated: number; unreadCount: number }>("/api/v1/task-command/notifications/read-all", { method: "POST" });
}

/**
 * P4：全局未读角标。只取一个计数，避免 office-shell 重复拉整份 workspace；
 * 30 秒轮询兜底，并在本页动作后由 nexus:task-command-changed 立即刷新。
 */
export function useNotificationBadge(refreshMs = 30_000) {
  const [unreadCount, setUnreadCount] = useState(0);
  const load = useCallback(async () => {
    try {
      const data = await api<{ notifications: WorkspaceNotification[]; unreadCount: number }>("/api/v1/task-command/notifications?limit=1", { cache: "no-store" });
      setUnreadCount(data.unreadCount);
    } catch { /* 角标是尽力而为，不阻塞主界面 */ }
  }, []);
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), refreshMs);
    window.addEventListener("nexus:task-command-changed", load);
    return () => { window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener("nexus:task-command-changed", load); };
  }, [load, refreshMs]);
  return { unreadCount, refresh: load };
}

export function useWorkspace(refreshMs = 30_000) {
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setWorkspace(await api<WorkspaceData>("/api/v1/task-command/workspace", { cache: "no-store" }));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务工作区加载失败");
      throw cause instanceof Error ? cause : new Error("任务工作区加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch(() => undefined), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load().catch(() => undefined), refreshMs);
    return () => window.clearInterval(timer);
  }, [load, refreshMs]);
  return { workspace, loading, error, load };
}
