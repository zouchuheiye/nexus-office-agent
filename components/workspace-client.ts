"use client";

import { useCallback, useEffect, useState } from "react";

export type WorkspacePerson = { id: string; displayName: string; orgName?: string; positionName?: string; activeTaskCount: number };
export type WorkspaceTask = {
  id: string; missionId: string; title: string; description: string; acceptanceCriteria: string; requiredSkills: string[];
  assignmentMode: "direct" | "open_claim"; assigneeId?: string; targetOrgUnitId?: string; publishedBy: string; priority: "critical" | "high" | "medium" | "low";
  dueAt: string; startedAt?: string; estimatedDays?: number; dueState?: "overdue" | "due_soon" | "normal" | "done"; capacityPoints: number; status: "published" | "assigned" | "claimed" | "in_progress" | "blocked" | "in_review" | "completed" | "cancelled";
  evidenceRefs: string[]; blockedReason?: string; isTemplate: boolean; missingFields: string[]; version: number;
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
export type TimelineEvent = { id: string; sequence: number; eventType: string; actorId: string; occurredAt: string; payload: Record<string, unknown> };
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
  generatedAt: string;
};

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as { data?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "请求未完成");
  return payload.data as T;
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
