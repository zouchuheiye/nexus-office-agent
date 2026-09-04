"use client";

import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  CircleDashed,
  FileCheck2,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  Radio,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  UsersRound,
} from "lucide-react";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  useWorkspace,
  type TaskHandoff,
  type TimelineEvent,
  type WorkspaceTask as Task,
} from "@/components/workspace-client";

type Citation = { id: string; label: string; excerpt: string; objectType: string };
type DisplayMessage = {
  role: "assistant" | "user";
  content: string;
  runId?: string;
  citations?: Citation[];
  routing?: { skills: string[]; tools: string[] };
  proposal?: { id: string; proposalHash: string; preview: string; riskLevel: number; expiresAt: string; status: string };
  job?: { id: string; status: "queued" | "executing" | "retry_scheduled" | "succeeded" | "failed" | "unknown" | "dead_letter" | "cancelled" | "compensated"; errorCode?: string; unknownReason?: string };
};

const statusCopy: Record<Task["status"], string> = {
  published: "待承接", assigned: "已分派", claimed: "已承接", in_progress: "进行中", blocked: "阻塞", in_review: "待验收", completed: "已完成", cancelled: "已取消",
};
const priorityCopy = { critical: "紧急", high: "高", medium: "中", low: "低" } as const;
const dueCopy: Record<string, string> = { overdue: "已逾期", due_soon: "临期", normal: "进行中", done: "已完成" };
const timelineEventCopy: Record<string, string> = {
  mission_published: "使命发布", package_published: "任务发布", package_claimed: "已承接", package_status_changed: "状态变更",
  package_handoff_initiated: "交接发起", package_handoff_accepted: "交接签收", package_handoff_rejected: "交接退回",
};
function dueLabel(task: Task): string { return dueCopy[task.dueState ?? "normal"]; }
function dueRank(task: Task): number { return task.dueState === "overdue" ? 0 : task.dueState === "due_soon" ? 1 : task.dueState === "done" ? 3 : 2; }
export function WorkCommandCenter({
  messages,
  query,
  isThinking,
  confirmingProposal,
  onQueryChange,
  onSubmit,
  onConfirmProposal,
  onHydrate,
  onNotice,
}: {
  messages: DisplayMessage[];
  query: string;
  isThinking: boolean;
  confirmingProposal: string;
  onQueryChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onConfirmProposal: (proposal: NonNullable<DisplayMessage["proposal"]>) => void;
  onHydrate: (conversationId: string, messages: DisplayMessage[]) => void;
  onNotice: (message: string) => void;
}) {
  const { workspace, loading, error, load: loadWorkspace } = useWorkspace();
  const [taskMode, setTaskMode] = useState<"mine" | "available" | "published" | "handoffs">("mine");
  const [railMode, setRailMode] = useState<"tasks" | "messages">("tasks");
  const [busyTask, setBusyTask] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const hydrated = useRef(false);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const didInitialJump = useRef(false);
  const stickToBottomRef = useRef(true); // follow new content only while the user is near the bottom
  const handledCountRef = useRef(0); // last message count we already positioned

  const [timelines, setTimelines] = useState<Record<string, TimelineEvent[]>>({});
  const refreshWorkspace = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadWorkspace();
      onNotice(`已刷新 · ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    } catch {
      onNotice("刷新失败，请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }, [loadWorkspace, onNotice]);
  const loadTimeline = useCallback(async (taskId: string) => {
    if (timelines[taskId]) return;
    try {
      const data = await api<{ task: Task; timeline: TimelineEvent[] }>(`/api/v1/task-command/packages/${taskId}/timeline`, { cache: "no-store" });
      setTimelines((current) => ({ ...current, [taskId]: data.timeline }));
    } catch { /* timeline is best-effort */ }
  }, [timelines]);

  useEffect(() => {
    if (!workspace || hydrated.current) return;
    hydrated.current = true;
    onHydrate(workspace.conversation.id, workspace.messages.filter(({ role }) => role !== "tool").map((item) => ({
      role: item.role as "assistant" | "user", content: item.content, runId: item.runId, citations: item.citations, routing: item.route,
    })));
  }, [workspace, onHydrate]);
  useEffect(() => {
    const stream = new EventSource("/api/v1/task-command/message-events");
    const refresh = () => void loadWorkspace().catch(() => undefined);
    stream.addEventListener("message-change", refresh);
    return () => stream.close();
  }, [loadWorkspace]);
  useEffect(() => {
    const stream = new EventSource("/api/v1/task-command/events");
    const refresh = () => void loadWorkspace().catch(() => undefined);
    stream.addEventListener("task-change", refresh);
    window.addEventListener("nexus:task-command-changed", refresh);
    return () => { stream.close(); window.removeEventListener("nexus:task-command-changed", refresh); };
  }, [loadWorkspace]);
  useEffect(() => {
    // On returning to the conversation, jump straight to the latest message (no animation).
    if (!didInitialJump.current) {
      if (!messages.length || !workspace) return; // wait for the real workspace hydration
      didInitialJump.current = true;
      stickToBottomRef.current = true;
      handledCountRef.current = messages.length;
      const frame = window.requestAnimationFrame(() => {
        const container = conversationEnd.current?.parentElement as HTMLElement | null;
        if (container) container.scrollTop = container.scrollHeight;
      });
      return () => window.cancelAnimationFrame(frame);
    }
    // Skip re-renders that carry the same messages (e.g. re-hydration) so we never move the view.
    const hasNewContent = messages.length > handledCountRef.current || isThinking;
    if (!hasNewContent || !stickToBottomRef.current) return;
    // Follow only while the user is near the bottom; land on the START of a long new answer
    // so long replies are read from the beginning instead of jumping to their end.
    const frame = window.requestAnimationFrame(() => {
      const container = conversationEnd.current?.parentElement as HTMLElement | null;
      if (!container) return;
      const messagesList = Array.from(container.querySelectorAll<HTMLElement>(".command-message"));
      const last = messagesList[messagesList.length - 1];
      if (last && last.offsetHeight >= container.clientHeight - 8) {
        last.scrollIntoView({ block: "start" });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    });
    handledCountRef.current = messages.length;
    return () => window.cancelAnimationFrame(frame);
  }, [messages, isThinking, workspace]);

  // Remember whether the user is reading near the bottom, so auto-follow never yanks them away from history.
  useEffect(() => {
    const container = conversationEnd.current?.parentElement as HTMLElement | null;
    if (!container) return;
    const onScroll = () => {
      stickToBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 96;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  const tasks = taskMode === "mine" ? workspace?.myTasks ?? [] : taskMode === "available" ? workspace?.availableTasks ?? [] : taskMode === "published" ? workspace?.publishedByMe ?? [] : workspace?.pendingHandoffs.map(({ task }) => task) ?? [];
  const peopleById = useMemo(() => new Map(workspace?.people.map((person) => [person.id, person]) ?? []), [workspace]);
  const orgUnitsById = useMemo(() => new Map(workspace?.orgUnits.map((unit) => [unit.id, unit]) ?? []), [workspace]);
  const handoffsByPackage = useMemo(() => {
    const values = new Map<string, TaskHandoff[]>();
    for (const handoff of workspace?.handoffs ?? []) values.set(handoff.packageId, [...(values.get(handoff.packageId) ?? []), handoff]);
    return values;
  }, [workspace]);
  const pendingHandoffsByTask = useMemo(() => new Map(workspace?.pendingHandoffs.filter((entry) => entry.direction === "incoming").map(({ task, handoff }) => [task.id, handoff]) ?? []), [workspace]);
  const outgoingHandoffsByTask = useMemo(() => new Map((workspace?.pendingHandoffs.filter((entry) => entry.direction === "outgoing") ?? []).map((entry) => [entry.task.id, entry.handoff])), [workspace]);
  const messageCount = useMemo(() => workspace?.messagePools.reduce((total, pool) => total + pool.messages.length, 0) ?? 0, [workspace]);
  const cancellableStatuses = new Set<Task["status"]>(["published", "assigned", "claimed", "in_progress", "blocked", "in_review"]);
  const hasPendingHandoff = (taskId: string) => (handoffsByPackage.get(taskId) ?? []).some((handoff) => handoff.status === "pending");
  const canCancelTask = (task: Task) => !task.isTemplate && cancellableStatuses.has(task.status) && (taskMode === "published" || taskMode === "mine") && !hasPendingHandoff(task.id);

  async function claim(task: Task) {
    setBusyTask(task.id);
    try {
      await api(`/api/v1/task-command/packages/${task.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version }) });
      onNotice(`已承接“${task.title}”`);
      await loadWorkspace();
      setTaskMode("mine");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "承接失败"); }
    finally { setBusyTask(""); }
  }

  async function transition(task: Task, nextStatus: Task["status"]) {
    setBusyTask(task.id);
    try {
      await api(`/api/v1/task-command/packages/${task.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version, nextStatus }) });
      onNotice(`任务已进入“${statusCopy[nextStatus]}”`);
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "任务推进失败"); }
    finally { setBusyTask(""); }
  }

  async function cancelTask(task: Task) {
    if (!window.confirm(`确认取消任务「${task.title}」？取消后保留审计记录，任务不可恢复。`)) return;
    await transition(task, "cancelled");
  }

  async function revokeHandoff(handoff: TaskHandoff, version: number) {
    if (!window.confirm("确认撤回这条交接？对方将不能再签收，任务继续留在你名下。")) return;
    setBusyTask(handoff.packageId);
    try {
      await api(`/api/v1/task-command/handoffs/${handoff.id}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: version }) });
      onNotice("已撤回交接");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "撤回交接失败"); }
    finally { setBusyTask(""); }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const composing = Boolean((event.nativeEvent as unknown as { isComposing?: boolean }).isComposing);
    if (event.key === "Enter" && !event.shiftKey && !composing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return <div className="work-command-center is-unified-office-entry">
    <div className="command-center-grid">
      <section className="primary-conversation-panel">
        <div className="conversation-toolbar">
          <div><span className="command-agent-mark"><Sparkles size={16} /></span><div><strong>枢纽 Agent</strong><small><i /> 企业办公入口</small></div></div>
          <div className="conversation-guard"><span><ShieldCheck size={14} />权限已同步</span></div>
        </div>

        <div className="command-conversation" aria-live="polite">
          {!messages.length ? <div className="command-welcome"><h1>有什么需要处理？</h1><p>直接说就可以。审批、项目、会议、知识、经营分析和任务都可以从这里开始。</p></div> : null}
          {messages.map((message, index) => <article key={`${message.runId ?? "message"}-${index}`} className={`command-message is-${message.role}`}>
            {message.role === "assistant" ? <span className="command-message-avatar"><Bot size={16} /></span> : null}
            <div className="command-message-body">
              {message.role === "assistant" ? <div className="command-message-meta"><span>{message.proposal ? "待确认" : message.job ? "执行状态" : "枢纽"}</span></div> : null}
              <p>{message.content}</p>
              {message.routing?.tools.length ? <details className="route-proof"><summary>已使用 {message.routing.tools.length} 项办公能力</summary><span>{message.routing.tools.join(" · ")}</span></details> : null}
              {message.citations?.length ? <div className="command-citations"><span><ShieldCheck size={12} />核验依据</span>{message.citations.slice(0, 5).map((citation, citationIndex) => <details key={citation.id}><summary><b>[{citationIndex + 1}]</b>{citation.label}</summary><small>{citation.excerpt}</small></details>)}</div> : null}
              {message.proposal ? <div className="command-proposal"><div><span>R{message.proposal.riskLevel} · 人工确认</span><b>{new Date(message.proposal.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 前有效</b></div><strong>{message.proposal.preview}</strong><button disabled={confirmingProposal === message.proposal.id} onClick={() => onConfirmProposal(message.proposal!)}>{confirmingProposal === message.proposal.id ? "正在校验…" : "确认并执行"}<ArrowRight size={13} /></button></div> : null}
              {message.job ? <div className="command-job"><Radio size={13} /><span>{message.job.status}</span><code>{message.job.id.slice(0, 8)}</code></div> : null}
            </div>
          </article>)}
          {isThinking ? <article className="command-message is-assistant"><span className="command-message-avatar"><Bot size={16} /></span><div className="command-thinking"><i /><i /><i /><span>正在处理</span></div></article> : null}
          <div ref={conversationEnd} />
        </div>

        <form className="primary-composer" onSubmit={onSubmit}>
          <textarea id="primary-work-command" aria-label="说说你要处理什么" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={handleComposerKeyDown} rows={6} placeholder="输入一件要处理的事…" />
          <footer><div><small>Enter 发送 · Shift + Enter 换行</small></div><button type="submit" aria-label="发送" disabled={!query.trim() || isThinking}>{isThinking ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></footer>
        </form>
      </section>

      <aside className="live-task-rail">
        <header><div><h2>{railMode === "tasks" ? "任务" : "消息池"}</h2><p>{workspace ? `已同步 · ${formatTime(workspace.generatedAt)}` : "正在同步"}</p></div><div className="task-rail-actions"><button type="button" onClick={() => void refreshWorkspace()} disabled={refreshing} aria-label="刷新工作区"><RotateCcw className={refreshing ? "spin" : ""} size={15} /></button></div></header>
        <div className="task-rail-tabs task-rail-mode-tabs" role="tablist" aria-label="工作上下文">
          <button type="button" role="tab" aria-selected={railMode === "tasks"} className={railMode === "tasks" ? "active" : ""} onClick={() => setRailMode("tasks")}><ListTodo size={14} />任务 <b>{(workspace?.myTasks.length ?? 0) + (workspace?.availableTasks.length ?? 0)}</b></button>
          <button type="button" role="tab" aria-selected={railMode === "messages"} className={railMode === "messages" ? "active" : ""} onClick={() => setRailMode("messages")}><MessageCircle size={14} />消息 <b>{messageCount}</b></button>
        </div>
        {railMode === "tasks" ? <>
          <div className="task-rail-tabs task-rail-task-tabs" role="tablist" aria-label="任务范围">
            <button type="button" role="tab" aria-selected={taskMode === "mine"} className={taskMode === "mine" ? "active" : ""} onClick={() => setTaskMode("mine")}><UserRoundCheck size={14} />我的 <b>{workspace?.myTasks.length ?? 0}</b></button>
            <button type="button" role="tab" aria-selected={taskMode === "available"} className={taskMode === "available" ? "active" : ""} onClick={() => setTaskMode("available")}><UsersRound size={14} />可承接 <b>{workspace?.availableTasks.length ?? 0}</b></button>
            <button type="button" role="tab" aria-selected={taskMode === "published"} className={taskMode === "published" ? "active" : ""} onClick={() => setTaskMode("published")}><Radio size={14} />已发布 <b>{workspace?.publishedByMe.length ?? 0}</b></button>
            <button type="button" role="tab" aria-selected={taskMode === "handoffs"} className={taskMode === "handoffs" ? "active" : ""} onClick={() => setTaskMode("handoffs")}><FileCheck2 size={14} />待交接 <b>{workspace?.pendingHandoffs.length ?? 0}</b></button>
          </div>
          <div className="task-rail-list">
          {loading && !workspace ? <TaskRailState icon={LoaderCircle} title="正在同步任务" detail="" spinning /> : error && !workspace ? <TaskRailState icon={CircleAlert} title="任务暂时不可用" detail={error} action={() => void loadWorkspace()} /> : !tasks.length ? <TaskRailState icon={CircleDashed} title={taskMode === "mine" ? "没有待处理任务" : taskMode === "available" ? "没有可承接任务" : taskMode === "handoffs" ? "没有待签收交接" : "还没有发布任务"} detail="" /> : (() => { const sortedTasks = [...tasks].sort((left, right) => dueRank(left) - dueRank(right)); return sortedTasks.map((task, index) => {
            const taskHandoffs = handoffsByPackage.get(task.id) ?? [];
            const pendingHandoff = pendingHandoffsByTask.get(task.id);
            const prevDue = index > 0 ? sortedTasks[index - 1].dueState ?? "normal" : null;
            const showDueHeader = (taskMode === "mine" || taskMode === "published") && (task.dueState ?? "normal") !== prevDue;
            return <div className="task-rail-group" key={task.id}>{showDueHeader ? <div className="task-due-group-label">{dueLabel(task)} · {sortedTasks.filter((item) => (item.dueState ?? "normal") === (task.dueState ?? "normal")).length}</div> : null}<article className={`task-dispatch-card is-${task.status}${task.isTemplate ? " is-template" : ""}`}>
            <div className="task-dispatch-top"><span className={`task-priority is-${task.priority}`}>{task.isTemplate ? "模板" : priorityCopy[task.priority]}</span>{!task.isTemplate && task.dueState && ["overdue", "due_soon"].includes(task.dueState) ? <span className={`task-due is-${task.dueState}`}>{dueLabel(task)}</span> : null}<span className="task-state"><i />{task.isTemplate ? "待补充" : statusCopy[task.status]}</span>{taskMode === "handoffs" && outgoingHandoffsByTask.has(task.id) ? <span className="task-handoff-waiting">等对方签收</span> : null}{canCancelTask(task) ? <button className="task-cancel-action" type="button" disabled={busyTask === task.id} onClick={() => void cancelTask(task)}>{busyTask === task.id ? "取消中…" : "取消"}</button> : null}</div>
            <h3>{task.title}</h3><p>{task.description}</p>
            <dl><div><dt>接收对象</dt><dd>{task.assigneeId ? peopleById.get(task.assigneeId)?.displayName ?? "已指派成员" : task.targetOrgUnitId ? `${orgUnitsById.get(task.targetOrgUnitId)?.name ?? "指定部门"}待承接` : "公司公开承接"}</dd></div>{task.startedAt ? <div><dt>开始</dt><dd>{formatDate(task.startedAt)}</dd></div> : null}<div><dt>截止</dt><dd>{formatDate(task.dueAt)}{task.dueState === "overdue" ? " · 已逾期" : task.dueState === "due_soon" ? " · 临期" : ""}</dd></div>{task.estimatedDays ? <div><dt>工期</dt><dd>{task.estimatedDays} 天</dd></div> : null}</dl>
            <details className="task-acceptance"><summary>验收标准</summary><p>{task.acceptanceCriteria}</p></details>
            {task.missingFields.length ? <div className="task-template-missing">待补充：{task.missingFields.join("、")}</div> : null}
            {taskHandoffs.length ? <details className="task-handoff-trail"><summary>交接链 · {taskHandoffs.length} 棒{taskHandoffs.some(({ status }) => status === "pending") ? " · 待签收" : ""}</summary>{taskHandoffs.slice(-4).map((handoff) => <div className="task-handoff-line" key={handoff.id}><span>{peopleById.get(handoff.fromAssigneeId)?.displayName ?? "前负责人"}<ArrowRight size={11} />{peopleById.get(handoff.toAssigneeId)?.displayName ?? "接收人"}</span><small>{handoff.status === "pending" ? "待签收" : handoff.status === "accepted" ? "已签收" : handoff.respondedBy === handoff.fromAssigneeId ? "已撤回" : "已退回"} · 文件/资料 {handoff.artifactRefs.length} · v{handoff.snapshot.packageVersion}</small><p>{handoff.note}</p>{handoff.currentProgress ? <p className="task-handoff-field"><b>当前进度</b>{handoff.currentProgress}</p> : null}{handoff.completedWork ? <p className="task-handoff-field"><b>已完成</b>{handoff.completedWork}</p> : null}{handoff.pendingWork ? <p className="task-handoff-field"><b>未完成</b>{handoff.pendingWork}</p> : null}{handoff.attentionPoints ? <p className="task-handoff-field"><b>注意</b>{handoff.attentionPoints}</p> : null}{handoff.responseNote ? <p className="task-handoff-response">{handoff.responseNote}</p> : null}</div>)}</details> : null}
            <details className="task-timeline" onToggle={(event) => { if (event.currentTarget.open) void loadTimeline(task.id); }}><summary>时间线 · {timelines[task.id]?.length ?? 0} 条</summary>{(timelines[task.id] ?? []).map((item) => <div className="task-timeline-line" key={item.id}><span>{timelineEventCopy[item.eventType] ?? item.eventType}</span><small>{formatDate(item.occurredAt)}</small></div>)}</details>
            {taskMode === "mine" && task.assigneeId && !taskHandoffs.some(({ status }) => status === "pending") && !["in_review", "completed", "cancelled"].includes(task.status) ? <button className="task-handoff-action" type="button" onClick={() => onQueryChange(`我需要正式交接任务“${task.title}”。请先通过 work.get_task_handoff_trail 核验现有交接链和文件/资料引用，再向我确认：交给哪位当前可用成员、交接说明、当前进度、已完成部分、未完成部分和注意事项；确认后用 work.initiate_task_handoff 发起版本 ${task.version} 的交接。`)}>发起交接<ArrowRight size={13} /></button> : null}
            <footer>{task.isTemplate && taskMode === "published" ? <button onClick={() => onQueryChange(`补充任务模板“${task.title}”，模板 ID 为 ${task.id}，当前版本为 ${task.version}。请先询问我想补充哪些字段，再使用 work.update_task_template 更新；不要正式分派。`)}>补充模板<ArrowRight size={13} /></button> : taskMode === "handoffs" && pendingHandoff ? <><button onClick={() => onQueryChange(`请先使用 work.get_task_handoff_trail 核验待我签收的交接 ${pendingHandoff.id} 与文件/资料引用。若信息完整，我决定签收该交接，请使用 work.respond_to_task_handoff，handoffId 为 ${pendingHandoff.id}，任务当前版本为 ${task.version}。`)}>签收交接<Check size={13} /></button><button className="task-handoff-reject" onClick={() => onQueryChange(`请先使用 work.get_task_handoff_trail 核验交接 ${pendingHandoff.id}。我需要退回此交接，请向我询问退回原因后使用 work.respond_to_task_handoff，handoffId 为 ${pendingHandoff.id}，任务当前版本为 ${task.version}。`)}>退回</button></> : taskMode === "available" ? <button disabled={busyTask === task.id} onClick={() => void claim(task)}>{busyTask === task.id ? "承接中…" : "承接"}<ArrowRight size={13} /></button> : taskMode === "mine" && task.status === "in_progress" ? <button onClick={() => onQueryChange(`任务“${task.title}”已完成执行，请使用 work.update_my_task 工具将任务 ${task.id}（当前版本 ${task.version}）提交验收，并附上证据引用：`)}>提交验收<Check size={13} /></button> : taskMode === "mine" && task.status === "blocked" ? <button disabled={busyTask === task.id} onClick={() => void transition(task, "in_progress")}>解除阻塞<ArrowRight size={13} /></button> : taskMode === "mine" && task.status === "in_review" ? <button onClick={() => onQueryChange(`任务“${task.title}”已通过验收，请使用 work.update_my_task 工具将任务 ${task.id}（当前版本 ${task.version}）标记完成，证据引用为：`)}>完成<ArrowRight size={13} /></button> : <span>{formatRelative(task.dueAt)}</span>}{taskMode === "handoffs" && outgoingHandoffsByTask.has(task.id) ? <button className="task-handoff-revoke" type="button" disabled={busyTask === task.id} onClick={() => void revokeHandoff(outgoingHandoffsByTask.get(task.id)!, task.version)}>{busyTask === task.id ? "撤回中…" : "撤回交接"}<ArrowRight size={13} /></button> : null}</footer>
          </article></div>}); })()}
          </div>
        </> : <div className="message-pool-list">
          {loading && !workspace ? <TaskRailState icon={LoaderCircle} title="正在同步消息" detail="" spinning /> : error && !workspace ? <TaskRailState icon={CircleAlert} title="消息池暂时不可用" detail={error} action={() => void loadWorkspace()} /> : !workspace?.messagePools.some((pool) => pool.messages.length) ? <TaskRailState icon={MessageCircle} title="还没有沟通消息" detail="推送只用于同步、征询和反馈，不会创建任务。" /> : workspace.messagePools.map((pool) => <section className="message-pool-section" key={pool.key}><header><span>{pool.scope === "company" ? "公司" : "部门"}</span><h3>{pool.name}</h3><b>{pool.messages.length}</b></header>{pool.messages.map((message) => <article className="message-pool-card" key={message.id}><h4>{message.subject}</h4><p>{message.content}</p><footer><span>{peopleById.get(message.authorId)?.displayName ?? "成员"} · {formatTime(message.createdAt)}</span><button type="button" onClick={() => onQueryChange(`我想针对消息“${message.subject}”补充反馈。请使用 communication.add_feedback 工具向消息 ${message.id} 写入以下反馈：`)}>{message.feedback.length ? `${message.feedback.length} 条反馈` : "反馈"}</button></footer>{message.feedback.length ? <details><summary>查看反馈</summary>{message.feedback.slice(-3).map((feedback) => <p className="message-pool-feedback" key={feedback.id}><b>{peopleById.get(feedback.authorId)?.displayName ?? "成员"}</b>{feedback.content}</p>)}</details> : null}</article>)}</section>)}
        </div>}
      </aside>
    </div>
  </div>;
}

function TaskRailState({ icon: Icon, title, detail, spinning, action }: { icon: typeof CircleAlert; title: string; detail: string; spinning?: boolean; action?: () => void }) {
  return <div className="task-rail-state"><Icon className={spinning ? "spin" : ""} size={20} /><strong>{title}</strong>{detail ? <p>{detail}</p> : null}{action ? <button onClick={action}>重新连接</button> : null}</div>;
}
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatRelative(value: string) {
  const hours = Math.round((Date.parse(value) - Date.now()) / 3_600_000);
  return hours < 0 ? `逾期 ${Math.abs(hours)} 小时` : hours < 24 ? `${hours} 小时后截止` : `${Math.ceil(hours / 24)} 天后截止`;
}
