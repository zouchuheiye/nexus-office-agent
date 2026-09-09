"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Download, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useTaskBoard, type BoardTask as Task } from "@/components/board-client";

const priorityCopy = { critical: "紧急", high: "高", medium: "中", low: "低" } as const;
const statusCopy: Record<Task["status"], string> = {
  published: "待承接", assigned: "已分派", claimed: "已承接", in_progress: "进行中",
  blocked: "已阻塞", in_review: "待验收", completed: "已完成", cancelled: "已取消",
};
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

function stableTaskSort(left: Task, right: Task) {
  const dueRank = (task: Task) => task.dueState === "overdue" ? 0 : task.dueState === "due_soon" ? 1 : task.dueState === "done" ? 3 : 2;
  return dueRank(left) - dueRank(right)
    || new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime()
    || left.title.localeCompare(right.title, "zh-CN")
    || left.id.localeCompare(right.id);
}

type Aggregate = { name: string; total: number; active: number; review: number; completed: number; overdue: number; capacity: number };

function aggregateTasks(tasks: Task[], nameOf: (task: Task) => string): Aggregate[] {
  const groups = new Map<string, Aggregate>();
  for (const task of tasks) {
    const name = nameOf(task);
    const current = groups.get(name) ?? { name, total: 0, active: 0, review: 0, completed: 0, overdue: 0, capacity: 0 };
    current.total += 1;
    if (["assigned", "claimed", "in_progress", "blocked"].includes(task.status)) current.active += 1;
    if (task.status === "in_review") current.review += 1;
    if (task.status === "completed") current.completed += 1;
    if (task.dueState === "overdue") current.overdue += 1;
    current.capacity += task.capacityPoints;
    groups.set(name, current);
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export function TaskProgressBoard() {
  const { board, loading, error, load } = useTaskBoard();
  const [scope, setScope] = useState<"all" | "mine" | "published">("all");
  const [view, setView] = useState<"board" | "table">("board");
  const [assigneeId, setAssigneeId] = useState("");
  const [missionId, setMissionId] = useState("");
  const [status, setStatus] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const peopleById = useMemo(() => new Map(board?.people.map((person) => [person.id, person]) ?? []), [board]);
  const missionsById = useMemo(() => new Map(board?.missions.map((mission) => [mission.id, mission]) ?? []), [board]);
  const tasks = useMemo(() => {
    const list = board?.tasks ?? [];
    return list
      .filter((task) => scope === "mine" ? task.assigneeId === board?.actorId : scope === "published" ? task.publishedBy === board?.actorId : true)
      .filter((task) => !assigneeId || task.assigneeId === assigneeId)
      .filter((task) => !missionId || task.missionId === missionId)
      .filter((task) => !status || task.status === status)
      .filter((task) => !overdueOnly || task.dueState === "overdue")
      .sort(stableTaskSort);
  }, [board, scope, assigneeId, missionId, status, overdueOnly]);

  const projectGroups = useMemo(() => aggregateTasks(tasks, (task) => {
    const mission = missionsById.get(task.missionId);
    return mission?.title ?? "未归档项目";
  }), [missionsById, tasks]);
  const peopleGroups = useMemo(() => aggregateTasks(tasks, (task) => task.assigneeId ? peopleById.get(task.assigneeId)?.displayName ?? "已指派成员" : "待承接/未分派"), [peopleById, tasks]);

  function exportFiltered() {
    const params = new URLSearchParams({ format: "csv" });
    if (scope !== "all") params.set("scope", scope);
    if (assigneeId) params.set("assigneeId", assigneeId);
    if (missionId) params.set("missionId", missionId);
    if (status) params.set("status", status);
    if (overdueOnly) params.set("overdueOnly", "true");
    window.open(`/api/v1/task-command/reports/export?${params.toString()}`, "_blank", "noopener,noreferrer");
  }

  const resetFilters = () => { setAssigneeId(""); setMissionId(""); setStatus(""); setOverdueOnly(false); };
  const activeCount = tasks.filter((task) => ["assigned", "claimed", "in_progress", "blocked"].includes(task.status)).length;
  const reviewCount = tasks.filter((task) => task.status === "in_review").length;
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const overdueCount = tasks.filter((task) => task.dueState === "overdue").length;

  return <div className="task-progress-view">
    <header className="task-progress-head">
      <div><span className="command-kicker"><ShieldCheck size={13} />TASK PROGRESS</span><h1>任务进度</h1><p>所有你有权看到的任务，来自同一份服务端事实；可在看板与可访问表格间切换。</p></div>
      <div className="task-progress-actions">
        <div className="task-progress-tabs" role="tablist" aria-label="任务范围">
          {(["all", "mine", "published"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={scope === item} className={scope === item ? "active" : ""} onClick={() => setScope(item)}>{item === "all" ? "全部" : item === "mine" ? "我负责" : "我发布"}{item === "all" ? <b>{board?.tasks.length ?? 0}</b> : null}</button>)}
        </div>
        <div className="task-progress-tabs" role="tablist" aria-label="任务视图"><button type="button" role="tab" aria-selected={view === "board"} className={view === "board" ? "active" : ""} onClick={() => setView("board")}>看板</button><button type="button" role="tab" aria-selected={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}>表格</button></div>
        <button type="button" className="task-progress-refresh" onClick={() => void load()} aria-label="刷新看板"><RefreshCw className={loading ? "spin" : ""} size={15} />刷新</button>
        <button type="button" className="task-progress-export" onClick={exportFiltered} aria-label="导出筛选后的报表"><Download size={15} />导出</button>
      </div>
    </header>

    <div className="task-progress-filters" aria-label="任务筛选">
      <label>负责人<select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}><option value="">全部负责人</option>{board?.people.map((person) => <option value={person.id} key={person.id}>{person.displayName}</option>)}</select></label>
      <label>使命/项目<select value={missionId} onChange={(event) => setMissionId(event.target.value)}><option value="">全部使命/项目</option>{board?.missions.map((mission) => <option value={mission.id} key={mission.id}>{mission.title}</option>)}</select></label>
      <label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(statusCopy).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label className="task-progress-check"><input type="checkbox" checked={overdueOnly} onChange={(event) => setOverdueOnly(event.target.checked)} />仅逾期</label>
      <button type="button" onClick={resetFilters}>清除筛选</button>
    </div>

    {board?.people?.length ? <div className="task-progress-people" aria-label="成员负载"><span className="task-progress-people-title">成员负载</span>{board.people.map((person) => <span key={person.id} className={`task-progress-person${person.inProgressTaskCount >= 5 || person.capacityPoints >= 20 ? " is-high" : ""}`}>{person.displayName}<i>{person.inProgressTaskCount} 进行 / {person.dueSoonTaskCount} 临期 / {person.capacityPoints} 点</i></span>)}</div> : null}

    {error && !board ? <div className="task-progress-state is-error"><AlertTriangle size={18} />{error}<button onClick={() => void load()}>重试</button></div> : !board ? <div className="task-progress-state"><LoaderCircle className="spin" size={18} />正在加载看板…</div> : <>
      <div className="task-progress-summary"><span>当前结果 <b>{tasks.length}</b></span><span>进行中 <b>{activeCount}</b></span><span>待验收 <b>{reviewCount}</b></span><span>已完成 <b>{completedCount}</b></span><span>逾期 <b>{overdueCount}</b></span></div>
      {view === "board" ? <div className="task-progress-board">{columns.map((column) => { const items = tasks.filter((task) => column.statuses.includes(task.status)); return <section className="task-progress-column" key={column.key}><header><span>{column.label}</span><b>{items.length}</b></header><div className="task-progress-list">{!items.length ? <div className="task-progress-empty"><CircleDashed size={15} />暂无</div> : items.map((task) => { const assignee = task.assigneeId ? peopleById.get(task.assigneeId) : undefined; return <article key={task.id} className={`task-progress-card is-${task.status}${task.dueState === "overdue" ? " is-overdue" : task.dueState === "due_soon" ? " is-due-soon" : ""}`}><div className="task-progress-top"><span className={`task-priority is-${task.priority}`}>{priorityCopy[task.priority]}</span>{task.dueState === "overdue" || task.dueState === "due_soon" ? <span className={`task-due is-${task.dueState}`}>{dueCopy[task.dueState]}</span> : null}{task.status === "completed" ? <CheckCircle2 size={14} className="task-progress-done" /> : null}</div><h3>{task.title}</h3><dl><div><dt>负责人</dt><dd>{assignee?.displayName ?? (task.assignmentMode === "open_claim" ? "待承接" : "待分派")}</dd></div><div><dt>截止</dt><dd>{formatDate(task.dueAt)}</dd></div><div><dt>剩余</dt><dd className={task.dueState === "overdue" ? "is-overdue" : ""}>{daysLeft(task)}</dd></div></dl></article>; })}</div></section>; })}</div> : <>
        <div className="task-progress-table-wrap"><table className="task-progress-table"><caption className="sr-only">筛选后的任务表</caption><thead><tr><th>任务</th><th>使命/项目</th><th>负责人</th><th>部门</th><th>状态</th><th>开始</th><th>工期</th><th>截止</th><th>到期态</th><th>容量点</th>{board?.tasks.some((task) => task.missingFields?.length) ? <th>待补充</th> : null}</tr></thead><tbody>{tasks.map((task) => { const assignee = task.assigneeId ? peopleById.get(task.assigneeId) : undefined; return <tr key={task.id}><th scope="row">{task.title}</th><td>{missionsById.get(task.missionId)?.title ?? "未归档项目"}</td><td>{assignee?.displayName ?? (task.assignmentMode === "open_claim" ? "待承接" : "待分派")}</td><td>{assignee?.orgName ?? (task.targetOrgUnitId ? "部门待承接" : "—")}</td><td>{statusCopy[task.status]}</td><td>{task.startedAt ? formatDate(task.startedAt) : "—"}</td><td>{task.estimatedDays ? `${task.estimatedDays} 天` : "—"}</td><td className={task.dueState === "overdue" ? "is-overdue" : ""}>{formatDate(task.dueAt)}</td><td className={task.dueState === "overdue" ? "is-overdue" : ""}>{dueCopy[task.dueState ?? "normal"]}</td><td>{task.capacityPoints}</td>{board?.tasks.some((item) => item.missingFields?.length) ? <td>{task.missingFields?.length ? `待补充：${task.missingFields.join("、")}` : "—"}</td> : null}</tr>; })}</tbody></table></div>
        <div className="task-progress-aggregates"><section><h2>按使命/项目</h2>{projectGroups.map((group) => <div key={group.name}><strong>{group.name}</strong><span>{group.total} 项 · 进行 {group.active} · 待验收 {group.review} · 完成 {group.completed} · 逾期 {group.overdue} · {group.capacity} 点</span></div>)}</section><section><h2>按人员</h2>{peopleGroups.map((group) => <div key={group.name}><strong>{group.name}</strong><span>{group.total} 项 · 进行 {group.active} · 待验收 {group.review} · 完成 {group.completed} · 逾期 {group.overdue} · {group.capacity} 点</span></div>)}</section></div>
      </>}
    </>}
    <footer className="task-progress-footer"><Clock size={12} />{board ? `同步于 ${new Date(board.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · 30 秒自动刷新` : ""} · 服务端已按权限过滤</footer>
  </div>;
}
