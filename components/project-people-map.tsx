"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  CircleDashed,
  Clock3,
  GripVertical,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  SquareKanban,
  Table2,
  TableRowsSplit,
  Users,
} from "lucide-react";

type Project = {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  status: string;
  priority: string;
  health: string;
  targetEndAt: string;
};
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
  dueAt?: string;
};
type Board = { tasks: Task[]; people: Person[]; missions: Mission[]; generatedAt: string };
type ViewMode = "matrix" | "projectLanes" | "personLanes";

type ProjectPeopleMapProps = {
  projects: Project[];
  projectsLoading: boolean;
  onOpenProject: (projectId: string) => void;
  onAsk: (text: string) => void;
};

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
const healthCopy: Record<string, string> = { healthy: "健康", watch: "需关注", at_risk: "有风险", critical: "高风险" };

async function readBoard(): Promise<Board> {
  const response = await fetch("/api/v1/task-command/board", { cache: "no-store" });
  const payload = await response.json().catch(() => ({})) as { data?: Board; error?: { message?: string } };
  if (!response.ok || !payload.data) throw new Error(payload.error?.message || "人员与项目关系加载失败");
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
function tasksForProject(tasks: Task[], missionById: Map<string, Mission>, projectId: string) {
  return tasks.filter((task) => missionById.get(task.missionId)?.projectId === projectId);
}
function tasksForPersonProject(tasks: Task[], missionById: Map<string, Mission>, personId: string, projectId: string) {
  return tasks.filter((task) => task.assigneeId === personId && missionById.get(task.missionId)?.projectId === projectId);
}
type TaskRelationFn = typeof tasksForPersonProject;

export function ProjectPeopleMap({ projects, projectsLoading, onOpenProject, onAsk }: ProjectPeopleMapProps) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ViewMode>("matrix");
  const [dragPersonId, setDragPersonId] = useState<string | null>(null);
  const [dropProjectId, setDropProjectId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBoard(await readBoard());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "人员与项目关系加载失败");
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
  const personById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);

  const projectCards = useMemo(() => projects.map((project) => {
    const projectTasks = tasksForProject(tasks, missionById, project.id);
    const assigneeIds = new Set<string>();
    for (const task of projectTasks) if (task.assigneeId) assigneeIds.add(task.assigneeId);
    assigneeIds.add(project.ownerId);
    const members = [...assigneeIds].map((id) => personById.get(id)).filter((person): person is Person => Boolean(person));
    const completed = projectTasks.filter((task) => task.status === "completed").length;
    const blocked = projectTasks.filter((task) => task.status === "blocked" || task.dueState === "overdue").length;
    const progress = projectTasks.length ? Math.round((completed / projectTasks.length) * 100) : 0;
    return { project, tasks: projectTasks, members, completed, blocked, progress };
  }), [projects, tasks, missionById, personById]);

  const personProjectIds = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const person of people) {
      const ids = new Set<string>();
      for (const project of projects) {
        if (project.ownerId === person.id || tasksForPersonProject(tasks, missionById, person.id, project.id).length) {
          ids.add(project.id);
        }
      }
      result.set(person.id, [...ids]);
    }
    return result;
  }, [people, projects, tasks, missionById]);

  const unlinkedTaskCount = tasks.filter((task) => !missionById.get(task.missionId)?.projectId).length;

  function dropPersonIntoProject(projectId: string) {
    const person = dragPersonId ? personById.get(dragPersonId) : undefined;
    const project = projects.find((item) => item.id === projectId);
    setDropProjectId(null);
    setDragPersonId(null);
    if (!person || !project) return;
    onAsk(`请将成员“${person.displayName}”加入项目“${project.name}”（${project.code}），先询问并确认其要负责的模块或任务，再创建责任关系；不要绕过确认直接执行。`);
  }

  const modeOptions: Array<{ id: ViewMode; label: string; icon: typeof Table2 }> = [
    { id: "matrix", label: "矩阵", icon: Table2 },
    { id: "projectLanes", label: "项目泳道", icon: SquareKanban },
    { id: "personLanes", label: "人员泳道", icon: TableRowsSplit },
  ];

  return <div className="project-people-map pp-map">
    <header className="pp-head">
      <div>
        <span className="command-kicker"><Network size={13} />PEOPLE × PROJECT</span>
        <h1>人员 × 项目</h1>
        <p>按实时任务关系组织人员与项目，支持矩阵、项目泳道、人员泳道三种视角。</p>
      </div>
      <div className="pp-head-actions">
        <div className="pp-mode-tabs" role="tablist" aria-label="视图模式">
          {modeOptions.map(({ id, label, icon: Icon }) => <button type="button" key={id} role="tab" aria-selected={mode === id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}><Icon size={14} />{label}</button>)}
        </div>
        <button type="button" className="pp-secondary" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={14} />刷新</button>
        <button type="button" className="pp-primary" onClick={() => onAsk("请新建一个项目任务，先向我询问项目、负责人、截止时间和验收标准，再生成任务发布提案。")}><Plus size={14} />新建任务</button>
      </div>
    </header>

    {people.length ? <section className="pp-people-pool" aria-label="人员池">
      <div className="pp-pool-label"><Users size={13} />人员池</div>
      <div className="pp-pool-list">
        {people.map((person) => <button type="button" key={person.id} draggable onDragStart={(event) => { setDragPersonId(person.id); event.dataTransfer.effectAllowed = "copy"; }} onDragEnd={() => setDragPersonId(null)} className="pp-person-chip" title={`${person.displayName} · ${person.positionName ?? "成员"}`}><span className={`person-avatar is-${isBusy(person) ? "busy" : "idle"}`}>{initials(person.displayName)}<i /></span><span>{person.displayName}</span><GripVertical size={12} /></button>)}
      </div>
      <small className="pp-pool-hint">拖动人员到任意项目上，生成“加入项目并分配任务”的 Agent 提案</small>
    </section> : null}

    {error && !board ? <div className="project-people-state is-error"><AlertTriangle size={18} /><strong>{error}</strong><button type="button" onClick={() => void load()}>重试</button></div>
      : !board ? <div className="project-people-state"><LoaderCircle className="spin" size={20} /><strong>正在整理人员与项目关系…</strong><span>只读取当前身份可见的任务事实。</span></div>
        : <main className="pp-body">
          {mode === "matrix" ? <MatrixView projects={projects} people={people} missionById={missionById} tasks={tasks} tasksForPersonProject={tasksForPersonProject} personById={personById} projectsLoading={projectsLoading} dragPersonId={dragPersonId} dropProjectId={dropProjectId} setDragPersonId={setDragPersonId} setDropProjectId={setDropProjectId} dropPersonIntoProject={dropPersonIntoProject} onOpenProject={onOpenProject} /> : null}
          {mode === "projectLanes" ? <ProjectLanes projectCards={projectCards} tasksForPersonProject={tasksForPersonProject} missionById={missionById} tasks={tasks} personById={personById} dropProjectId={dropProjectId} setDropProjectId={setDropProjectId} dropPersonIntoProject={dropPersonIntoProject} onOpenProject={onOpenProject} /> : null}
          {mode === "personLanes" ? <PersonLanes people={people} projects={projects} personProjectIds={personProjectIds} tasksForPersonProject={tasksForPersonProject} missionById={missionById} tasks={tasks} personById={personById} dropProjectId={dropProjectId} setDropProjectId={setDropProjectId} dropPersonIntoProject={dropPersonIntoProject} onOpenProject={onOpenProject} /> : null}

          {unlinkedTaskCount ? <div className="pp-unlinked"><CircleDashed size={14} />有 {unlinkedTaskCount} 项任务尚未归入任何项目，适合交给 Agent 归类。<button type="button" onClick={() => onAsk("请找出当前未关联项目的任务，给出应归入哪个项目的建议；只提供建议，不直接修改。")}>让 Agent 整理 <ArrowRight size={13} /></button></div> : null}
        </main>}

    <footer className="project-people-footer"><Clock3 size={12} />{board ? `同步于 ${new Date(board.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} · 每 30 秒刷新` : ""} · 只显示当前身份有权看到的事实</footer>
  </div>;
}

function MatrixView({ projects, people, missionById, tasks, tasksForPersonProject, personById, projectsLoading, dragPersonId, dropProjectId, setDragPersonId, setDropProjectId, dropPersonIntoProject, onOpenProject }: {
  projects: Project[];
  people: Person[];
  missionById: Map<string, Mission>;
  tasks: Task[];
  tasksForPersonProject: TaskRelationFn;
  personById: Map<string, Person>;
  projectsLoading: boolean;
  dragPersonId: string | null;
  dropProjectId: string | null;
  setDragPersonId: (id: string | null) => void;
  setDropProjectId: (id: string | null) => void;
  dropPersonIntoProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  return <div className="pp-matrix-scroll">
    <table className="pp-matrix">
      <thead>
        <tr>
          <th className="pp-corner">人员 \ 项目</th>
          {projects.map((project) => <ProjectColumnHead key={project.id} project={project} setDropProjectId={setDropProjectId} dropPersonIntoProject={dropPersonIntoProject} onOpenProject={onOpenProject} />)}
        </tr>
      </thead>
      <tbody>
        {people.map((person) => <tr key={person.id}>
          <th className="pp-row-head" draggable onDragStart={(event) => { setDragPersonId(person.id); event.dataTransfer.effectAllowed = "copy"; }} onDragEnd={() => setDragPersonId(null)}>
            <span className={`person-avatar is-${isBusy(person) ? "busy" : "idle"}`}>{initials(person.displayName)}<i /></span>
            <span className="pp-row-copy"><strong>{person.displayName}</strong><small>{person.positionName ?? person.orgName ?? "成员"} · {person.activeTaskCount} 项</small></span>
            <GripVertical size={14} className="pp-drag" />
          </th>
          {projects.map((project) => {
            const cellTasks = tasksForPersonProject(tasks, missionById, person.id, project.id);
            const isOwner = project.ownerId === person.id;
            const isDrop = dropProjectId === project.id && dragPersonId === person.id;
            return <td key={project.id} className={`pp-cell${isDrop ? " is-drop" : ""}`} onDragOver={(event) => { event.preventDefault(); setDropProjectId(project.id); }} onDragLeave={() => setDropProjectId(null)} onDrop={() => dropPersonIntoProject(project.id)}>
              {isOwner ? <span className="pp-owner-badge">负责人</span> : null}
              {cellTasks.length ? cellTasks.map((task) => <TaskRow key={task.id} task={task} assigneeName={personById.get(task.assigneeId ?? "")?.displayName} />) : <span className="pp-cell-empty">{isOwner ? "暂无任务" : "—"}</span>}
            </td>;
          })}
        </tr>)}
      </tbody>
    </table>
    {!projects.length ? <div className="project-people-empty project-map-empty"><BriefcaseBusiness size={22} /><strong>{projectsLoading ? "正在加载项目" : "还没有可见项目"}</strong><span>项目接口返回后，这里会自动生成行列。</span></div> : null}
  </div>;
}

function ProjectColumnHead({ project, setDropProjectId, dropPersonIntoProject, onOpenProject }: {
  project: Project;
  setDropProjectId: (id: string | null) => void;
  dropPersonIntoProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  return <th className="pp-col-head" onDragOver={(event) => { event.preventDefault(); setDropProjectId(project.id); }} onDragLeave={() => setDropProjectId(null)} onDrop={() => dropPersonIntoProject(project.id)}>
    <button type="button" onClick={() => onOpenProject(project.id)}><span className="project-code">{project.code}</span><strong>{project.name}</strong></button>
    <small className={`project-health is-${project.health}`}>{healthCopy[project.health] ?? project.health}</small>
  </th>;
}

function ProjectLanes({ projectCards, tasksForPersonProject, missionById, tasks, personById, dropProjectId, setDropProjectId, dropPersonIntoProject, onOpenProject }: {
  projectCards: Array<{ project: Project; tasks: Task[]; members: Person[]; completed: number; blocked: number; progress: number }>;
  tasksForPersonProject: TaskRelationFn;
  missionById: Map<string, Mission>;
  tasks: Task[];
  personById: Map<string, Person>;
  dropProjectId: string | null;
  setDropProjectId: (id: string | null) => void;
  dropPersonIntoProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  return <div className="pp-lanes-scroll">
    {projectCards.map(({ project, tasks: cardTasks, members, completed, blocked, progress }) => <section key={project.id} className={`pp-lane pp-project-lane${dropProjectId === project.id ? " is-drop" : ""}`} onDragOver={(event) => { event.preventDefault(); setDropProjectId(project.id); }} onDragLeave={() => setDropProjectId(null)} onDrop={() => dropPersonIntoProject(project.id)}>
      <header className="pp-lane-head">
        <button type="button" onClick={() => onOpenProject(project.id)}><span className="project-code">{project.code}</span><strong>{project.name}</strong></button>
        <span className={`project-health is-${project.health}`}>{healthCopy[project.health] ?? project.health}</span>
        <ProgressBar progress={progress} done={completed} total={cardTasks.length} blocked={blocked} />
      </header>
      <div className="pp-lane-body">
        {members.map((person) => <article key={person.id} className="pp-person-card"><PersonCardHead person={person} /><TaskList tasks={tasksForPersonProject(tasks, missionById, person.id, project.id)} personById={personById} /></article>)}
        {!members.length ? <div className="pp-lane-empty"><Users size={16} />拖入人员开始分配</div> : null}
      </div>
    </section>)}
  </div>;
}

function PersonLanes({ people, projects, personProjectIds, tasksForPersonProject, missionById, tasks, personById, dropProjectId, setDropProjectId, dropPersonIntoProject, onOpenProject }: {
  people: Person[];
  projects: Project[];
  personProjectIds: Map<string, string[]>;
  tasksForPersonProject: TaskRelationFn;
  missionById: Map<string, Mission>;
  tasks: Task[];
  personById: Map<string, Person>;
  dropProjectId: string | null;
  setDropProjectId: (id: string | null) => void;
  dropPersonIntoProject: (projectId: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  return <div className="pp-lanes-scroll">
    {people.map((person) => <section key={person.id} className="pp-lane pp-person-lane">
      <header className="pp-lane-head pp-person-lane-head"><PersonCardHead person={person} /></header>
      <div className="pp-lane-body">
        {(personProjectIds.get(person.id) ?? []).map((projectId) => {
          const project = projects.find((item) => item.id === projectId);
          if (!project) return null;
          const cellTasks = tasksForPersonProject(tasks, missionById, person.id, projectId);
          return <article key={projectId} className={`pp-project-card${dropProjectId === projectId ? " is-drop" : ""}`} onDragOver={(event) => { event.preventDefault(); setDropProjectId(projectId); }} onDragLeave={() => setDropProjectId(null)} onDrop={() => dropPersonIntoProject(projectId)}>
            <button type="button" className="pp-project-card-head" onClick={() => onOpenProject(projectId)}><span className="project-code">{project.code}</span><strong>{project.name}</strong><ArrowRight size={13} /></button>
            <TaskList tasks={cellTasks} personById={personById} />
          </article>;
        })}
        {!(personProjectIds.get(person.id) ?? []).length ? <div className="pp-lane-empty"><BriefcaseBusiness size={16} />暂无项目</div> : null}
      </div>
    </section>)}
  </div>;
}

function PersonCardHead({ person }: { person: Person }) {
  return <div className="pp-person-card-head"><span className={`person-avatar is-${isBusy(person) ? "busy" : "idle"}`}>{initials(person.displayName)}<i /></span><span className="pp-row-copy"><strong>{person.displayName}</strong><small>{person.positionName ?? person.orgName ?? "成员"} · {person.inProgressTaskCount} 进行中</small></span></div>;
}

function ProgressBar({ progress, done, total, blocked }: { progress: number; done: number; total: number; blocked: number }) {
  return <div className="pp-progress"><span><b>{progress}%</b> 完成 · {done}/{total}</span><i><em style={{ width: `${progress}%` }} /></i>{blocked ? <small className="is-alert">{blocked} 需介入</small> : null}</div>;
}

function TaskList({ tasks, personById }: { tasks: Task[]; personById: Map<string, Person> }) {
  if (!tasks.length) return <div className="pp-task-empty">暂无任务</div>;
  return <div className="pp-task-list">{tasks.map((task) => <TaskRow key={task.id} task={task} assigneeName={personById.get(task.assigneeId ?? "")?.displayName} />)}</div>;
}

function TaskRow({ task, assigneeName }: { task: Task; assigneeName?: string }) {
  return <button type="button" className="pp-task-row" title={task.title}><i className={`task-status-dot is-${statusTone(task)}`} /><span><strong>{task.title}</strong><small>{assigneeName ?? "待承接"} · {statusCopy[task.status] ?? task.status}{task.capacityPoints ? ` · ${task.capacityPoints} 点` : ""}</small></span><ArrowRight size={12} /></button>;
}
