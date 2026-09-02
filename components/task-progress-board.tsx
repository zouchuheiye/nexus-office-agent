"use client";

import { useMemo, useState } from "react";
import {
  useTaskBoard,
  type BoardTask as Task,
} from "@/components/board-client";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Download, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";

const priorityCopy = { critical: "紧急", high: "高", medium: "中", low: "低" } as const;
const dueCopy: Record<string, string> = { overdue: "已逾期", due_soon: "临期", normal: "进行中", done: "已完成" };
const columns: Array<{ key: string; label: string; statuses: Task["status"][] }> = [
  { key: "published", label: "待承接", statuses: ["published"] },
  { key: "active", label: "进行中", statuses: ["assigned", "claimed", "in_progress", "blocked"] },
  { key: "review", label: "待验收", statuses: ["in_review"] },
  { key: "done", label: "已完成", statuses: ["completed"] },
  { key: "cancelled", label: "已取消", statuses: ["cancelled"] },
];

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}
function daysLeft(task: Task): string {
  if (task.status === "completed" || task.status === "cancelled") return "";
  const diff = Math.ceil((new Date(task.dueAt).getTime() - Date.now()) / 86_400_000);
  return diff < 0 ? `逾期 ${-diff} 天` : diff === 0 ? "今天到期" : `剩 ${diff} 天`;
}

export function TaskProgressBoard() {
  const { board, loading, error, load } = useTaskBoard();
  const [scope, setScope] = useState<"all" | "mine" | "published">("all");

  const peopleById = useMemo(() => new Map(board?.people.map((person) => [person.id, person]) ?? []), [board]);
  const tasks = useMemo(() => {
    const list = board?.tasks ?? [];
    if (scope === "mine") return list.filter((task) => task.assigneeId === board?.actorId);
    if (scope === "published") return list.filter((task) => task.publishedBy === board?.actorId);
    return list;
  }, [board, scope]);

  return <div className="task-progress-view">
    <header className="task-progress-head">
      <div><span className="command-kicker"><ShieldCheck size={13} />TASK PROGRESS</span><h1>任务进度</h1><p>所有你有权看到的任务，按状态分列；逾期与临期自动高亮。只看：</p></div>
      <div className="task-progress-actions">
        <div className="task-progress-tabs" role="tablist">
          <button type="button" role="tab" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全部 <b>{board?.tasks.length ?? 0}</b></button>
          <button type="button" role="tab" className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")}>我负责</button>
          <button type="button" role="tab" className={scope === "published" ? "active" : ""} onClick={() => setScope("published")}>我发布</button>
        </div>
        <button type="button" className="task-progress-refresh" onClick={() => void load()} aria-label="刷新看板"><RefreshCw className={loading ? "spin" : ""} size={15} />刷新</button>
        <button type="button" className="task-progress-export" onClick={() => window.open("/api/v1/task-command/reports/export?format=csv", "_blank")} aria-label="导出报表"><Download size={15} />导出报表</button>
      </div>
    </header>
    {board?.people?.length ? <div className="task-progress-people" aria-label="成员负载">
      <span className="task-progress-people-title">成员负载</span>
      {board.people.map((person) => {
        const high = person.inProgressTaskCount >= 5 || person.capacityPoints >= 20;
        return <span key={person.id} className={`task-progress-person${high ? " is-high" : ""}`} title={`${person.positionName ?? ""} · ${person.orgName ?? ""}`}>
          {person.displayName}<i>{person.inProgressTaskCount} 进行 / {person.dueSoonTaskCount} 临期 / {person.capacityPoints} 点{high ? " · 负载高" : ""}</i>
        </span>;
      })}
    </div> : null}

    {error && !board ? <div className="task-progress-state is-error"><AlertTriangle size={18} />{error}<button onClick={() => void load()}>重试</button></div>
      : !board ? <div className="task-progress-state"><LoaderCircle className="spin" size={18} />正在加载看板…</div>
      : <div className="task-progress-board">
        {columns.map((column) => {
          const items = tasks.filter((task) => column.statuses.includes(task.status));
          return <section className="task-progress-column" key={column.key}>
            <header><span>{column.label}</span><b>{items.length}</b></header>
            <div className="task-progress-list">
              {!items.length ? <div className="task-progress-empty"><CircleDashed size={15} />暂无</div>
                : items.map((task) => {
                  const assignee = task.assigneeId ? peopleById.get(task.assigneeId) : undefined;
                  return <article key={task.id} className={`task-progress-card is-${task.status}${task.dueState === "overdue" ? " is-overdue" : task.dueState === "due_soon" ? " is-due-soon" : ""}`}>
                    <div className="task-progress-top"><span className={`task-priority is-${task.priority}`}>{priorityCopy[task.priority]}</span>{task.dueState === "overdue" || task.dueState === "due_soon" ? <span className={`task-due is-${task.dueState}`}>{dueCopy[task.dueState]}</span> : null}{task.status === "completed" ? <CheckCircle2 size={14} className="task-progress-done" /> : null}</div>
                    <h3>{task.title}</h3>
                    <dl>
                      <div><dt>负责人</dt><dd>{assignee?.displayName ?? (task.assignmentMode === "open_claim" ? (task.targetOrgUnitId ? "部门待承接" : "公开待承接") : "待分派")}</dd></div>
                      <div><dt>截止</dt><dd>{formatDate(task.dueAt)}</dd></div>
                      <div><dt>剩余</dt><dd className={task.dueState === "overdue" ? "is-overdue" : ""}>{daysLeft(task)}</dd></div>
                      {task.estimatedDays ? <div><dt>工期</dt><dd>{task.estimatedDays} 天</dd></div> : null}
                    </dl>
                  </article>;
                })}
            </div>
          </section>;
        })}
      </div>}
    <footer className="task-progress-footer"><Clock size={12} />{board ? `同步于 ${new Date(board.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · 30 秒自动刷新` : ""} · 只读视图，任务操作请回工作对话或任务栏</footer>
  </div>;
}
