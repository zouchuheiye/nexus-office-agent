"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/workspace-client";

export type BoardPerson = {
  id: string;
  displayName: string;
  orgName?: string;
  positionName?: string;
  activeTaskCount: number;
  inProgressTaskCount: number;
  dueSoonTaskCount: number;
  capacityPoints: number;
};
export type BoardMission = { id: string; projectId?: string; title: string; isTemplate: boolean };
export type BoardTask = {
  id: string;
  title: string;
  description: string;
  missionId: string;
  priority: "critical" | "high" | "medium" | "low";
  assignmentMode: "direct" | "open_claim";
  assigneeId?: string;
  targetOrgUnitId?: string;
  dueAt: string;
  startedAt?: string;
  estimatedDays?: number;
  capacityPoints: number;
  status: "published" | "assigned" | "claimed" | "in_progress" | "blocked" | "in_review" | "completed" | "cancelled";
  dueState?: "overdue" | "due_soon" | "normal" | "done";
  publishedBy: string;
  requiredSkills: string[];
  version: number;
};
export type Board = {
  tasks: BoardTask[];
  people: BoardPerson[];
  missions: BoardMission[];
  orgUnits: Array<{ id: string; name: string }>;
  actorId: string;
  generatedAt: string;
};

export const boardStatusCopy: Record<string, string> = {
  published: "待承接",
  assigned: "已分派",
  claimed: "已承接",
  in_progress: "进行中",
  blocked: "已阻塞",
  in_review: "待验收",
  completed: "已完成",
  cancelled: "已取消",
};
export const boardHealthCopy: Record<string, string> = { healthy: "健康", watch: "需关注", at_risk: "有风险", critical: "高风险" };

export async function readBoard(): Promise<Board> {
  const [peopleData, tasksData, missionsData] = await Promise.all([
    api<{ people: BoardPerson[]; actorId: string; generatedAt: string }>("/api/v1/task-command/people", { cache: "no-store" }),
    api<{ tasks: BoardTask[]; actorId: string; generatedAt: string }>("/api/v1/task-command/packages", { cache: "no-store" }),
    api<{ missions: BoardMission[]; generatedAt: string }>("/api/v1/task-command/missions", { cache: "no-store" }),
  ]);
  return {
    tasks: tasksData.tasks,
    people: peopleData.people,
    missions: missionsData.missions,
    orgUnits: [],
    actorId: peopleData.actorId,
    generatedAt: missionsData.generatedAt || tasksData.generatedAt || peopleData.generatedAt,
  };
}

export function useTaskBoard(refreshMs = 30_000) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await readBoard());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务看板加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => window.clearInterval(timer);
  }, [load, refreshMs]);
  return { board, loading, error, load };
}

export function boardInitials(name: string) {
  return name.trim().slice(0, 1) || "人";
}
export function boardIsBusy(person: BoardPerson) {
  return person.inProgressTaskCount > 0;
}
export function boardStatusTone(task: BoardTask) {
  if (task.status === "blocked" || task.dueState === "overdue") return "danger";
  if (task.status === "completed") return "done";
  if (task.dueState === "due_soon") return "warning";
  return "active";
}
