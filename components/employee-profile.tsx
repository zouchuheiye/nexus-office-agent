"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";

type Person = {
  id: string;
  displayName: string;
  orgName?: string;
  positionName?: string;
  activeTaskCount: number;
  inProgressTaskCount: number;
  dueSoonTaskCount: number;
  capacityPoints: number;
};
type Mission = { id: string; projectId?: string; title: string; isTemplate: boolean };
type Task = {
  id: string;
  title: string;
  missionId: string;
  assigneeId?: string;
  status: string;
  dueState?: "overdue" | "due_soon" | "normal" | "done";
  capacityPoints: number;
  priority?: string;
  requiredSkills: string[];
  assignmentMode?: string;
};
type Board = { tasks: Task[]; people: Person[]; missions: Mission[]; generatedAt: string };

const statusCopy: Record<string, string> = {
  published: "待承接",
  assigned: "已分派",
  claimed: "已承接",
  in_progress: "进行中",
  blocked: "已阻塞",
  in_review: "待验收",
  completed: "已完成",
  cancelled: "已取消",
};
const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

async function readBoard(): Promise<Board> {
  const response = await fetch("/api/v1/task-command/board", { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { data?: Board; error?: { message?: string } };
  if (!response.ok || !payload.data) throw new Error(payload.error?.message || "员工画像加载失败");
  return payload.data;
}

function initials(name: string) {
  return name.trim().slice(0, 1) || "人";
}
function isBusy(person: Person) {
  return person.inProgressTaskCount > 0;
}
function statusTone(task: Task) {
  if (task.status === "blocked" || task.dueState === "overdue") return "danger";
  if (task.status === "completed") return "done";
  if (task.dueState === "due_soon") return "warning";
  return "active";
}

export function EmployeeProfile({ onAsk }: { onAsk: (text: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await readBoard());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "员工画像加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const people = useMemo(() => board?.people ?? [], [board]);
  const tasks = useMemo(() => board?.tasks ?? [], [board]);
  const missions = useMemo(() => board?.missions ?? [], [board]);
  const missionById = useMemo(() => new Map(missions.map((mission) => [mission.id, mission])), [missions]);

  const selected = selectedId ? people.find((person) => person.id === selectedId) ?? people[0] : people[0];

  const skillCountsByPerson = useMemo(() => {
    const result = new Map<string, Map<string, number>>();
    for (const task of tasks) {
      if (!task.assigneeId) continue;
      const counts = result.get(task.assigneeId) ?? new Map<string, number>();
      for (const skill of task.requiredSkills ?? []) counts.set(skill, (counts.get(skill) ?? 0) + 1);
      result.set(task.assigneeId, counts);
    }
    return result;
  }, [tasks]);

  const tasksByPerson = useMemo(() => {
    const result = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.assigneeId) continue;
      const list = result.get(task.assigneeId) ?? [];
      list.push(task);
      result.set(task.assigneeId, list);
    }
    return result;
  }, [tasks]);

  const openTasks = useMemo(() => tasks.filter((task) => !task.assigneeId && task.status === "published"), [tasks]);

  const suggestions = useMemo(() => {
    if (!selected) return [];
    const skillSet = new Set(skillCountsByPerson.get(selected.id)?.keys() ?? []);
    return openTasks
      .map((task) => {
        const required = task.requiredSkills ?? [];
        const overlap = required.filter((skill) => skillSet.has(skill)).length;
        const score = required.length ? overlap / required.length : 0.5;
        return { task, overlap, score };
      })
      .sort((a, b) => b.score - a.score || (priorityRank[a.task.priority ?? "medium"] ?? 2) - (priorityRank[b.task.priority ?? "medium"] ?? 2))
      .slice(0, 8);
  }, [selected, openTasks, skillCountsByPerson]);

  const selectedSkills = selected ? [...(skillCountsByPerson.get(selected.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1]) : [];
  const selectedTasks = selected ? tasksByPerson.get(selected.id) ?? [] : [];
  const selectedProjectIds = selected ? [...new Set(selectedTasks.map((task) => missionById.get(task.missionId)?.projectId).filter(Boolean) as string[])] : [];

  function askAssign(task: Task) {
    if (!selected) return;
    onAsk(`请评估将任务“${task.title}”分派给成员“${selected.displayName}”的匹配度：该成员已有技能 ${selectedSkills.map(([skill]) => skill).join("、") || "暂无派生技能"}，当前进行中 ${selected.inProgressTaskCount} 项、容量 ${selected.capacityPoints} 点。若匹配合理，请生成正式分派提案（确认负责人、截止与验收标准），不要绕过确认直接执行。`);
  }

  return <div className="employee-profile ep">
    <header className="ep-head">
      <div>
        <span className="command-kicker"><Users size={13} />EMPLOYEE PROFILE</span>
        <h1>员工画像</h1>
        <p>从任务历史派生技能与负载画像，为定向分派提供匹配建议。</p>
      </div>
      <button type="button" className="ep-refresh" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={14} />刷新</button>
    </header>

    {error && !board ? <div className="project-people-state is-error"><AlertTriangle size={18} /><strong>{error}</strong><button type="button" onClick={() => void load()}>重试</button></div>
      : !board ? <div className="project-people-state"><LoaderCircle className="spin" size={20} /><strong>正在生成员工画像…</strong><span>只读取当前身份可见的任务事实。</span></div>
        : <div className="ep-layout">
          <aside className="ep-list">
            <header><div><span>PEOPLE</span><h2>成员</h2></div><b>{people.length}</b></header>
            <div className="ep-list-body">
              {people.map((person) => <button type="button" key={person.id} className={`ep-person-item${selected?.id === person.id ? " is-active" : ""}`} onClick={() => setSelectedId(person.id)}>
                <span className={`person-avatar is-${isBusy(person) ? "busy" : "idle"}`}>{initials(person.displayName)}<i /></span>
                <span className="pp-row-copy"><strong>{person.displayName}</strong><small>{person.positionName ?? person.orgName ?? "成员"}</small></span>
                <span className="ep-load"><b>{person.inProgressTaskCount} 进行中</b><small>{person.capacityPoints} 点</small></span>
              </button>)}
            </div>
          </aside>

          {selected ? <main className="ep-detail">
            <section className="ep-profile-card">
              <div className="ep-profile-head"><span className={`person-avatar is-${isBusy(selected) ? "busy" : "idle"} ep-avatar`}>{initials(selected.displayName)}<i /></span><div><h2>{selected.displayName}</h2><p>{selected.positionName ?? "成员"} · {selected.orgName ?? "未分部门"}</p></div></div>
              <div className="ep-metrics">
                <div><span>在手任务</span><strong>{selected.activeTaskCount}</strong></div>
                <div><span>进行中</span><strong>{selected.inProgressTaskCount}</strong></div>
                <div><span>临期</span><strong>{selected.dueSoonTaskCount}</strong></div>
                <div><span>容量点</span><strong>{selected.capacityPoints}</strong></div>
                <div><span>参与项目</span><strong>{selectedProjectIds.length}</strong></div>
              </div>
            </section>

            <section className="ep-block">
              <header><div><span>SKILLS</span><h3>技能画像</h3></div><small>由历史任务所需技能派生</small></header>
              <div className="ep-skills">{selectedSkills.length ? selectedSkills.map(([skill, count]) => <span className="ep-skill" key={skill}><b>{skill}</b><i>{count} 次</i></span>) : <span className="ep-empty-inline">暂无派生技能</span>}</div>
            </section>

            <section className="ep-block">
              <header><div><span>TASKS</span><h3>当前任务</h3></div><small>{selectedTasks.length} 项</small></header>
              <div className="ep-task-list">{selectedTasks.length ? selectedTasks.map((task) => <button type="button" className="ep-task" key={task.id}><i className={`task-status-dot is-${statusTone(task)}`} /><span><strong>{task.title}</strong><small>{missionById.get(task.missionId)?.title ?? "未归属使命"} · {statusCopy[task.status] ?? task.status}{task.capacityPoints ? ` · ${task.capacityPoints} 点` : ""}</small></span></button>) : <div className="ep-empty">暂无在手任务</div>}</div>
            </section>

            <section className="ep-block ep-suggestions">
              <header><div><span>MATCH</span><h3>任务匹配建议</h3></div><small><Sparkles size={13} />基于技能重合与开放任务</small></header>
              <div className="ep-suggestion-list">
                {suggestions.length ? suggestions.map(({ task, overlap, score }) => <article className="ep-suggestion" key={task.id}>
                  <div className="ep-suggestion-copy"><strong>{task.title}</strong><small>需要 {task.requiredSkills?.length ? task.requiredSkills.join("、") : "未标注技能"} · {task.capacityPoints} 点</small><span className={`ep-match is-${score >= 0.66 ? "high" : score >= 0.33 ? "mid" : "low"}`}>匹配 {overlap}/{task.requiredSkills?.length || 0}</span></div>
                  <button type="button" onClick={() => askAssign(task)}><Zap size={13} />让 Agent 分派<ArrowRight size={13} /></button>
                </article>) : <div className="ep-empty">当前没有可匹配的开放任务</div>}
              </div>
            </section>
          </main> : <div className="project-people-empty project-map-empty"><BriefcaseBusiness size={22} /><strong>没有可见成员</strong><span>成员数据返回后即可生成画像。</span></div>}
        </div>}

    <footer className="project-people-footer"><Clock3 size={12} />{board ? `同步于 ${new Date(board.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · 每 30 秒刷新` : ""} · 画像仅由当前身份可见任务派生</footer>
  </div>;
}
