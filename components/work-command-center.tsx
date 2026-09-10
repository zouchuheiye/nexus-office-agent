"use client";

import {
  ArrowRight,
  Bell,
  Bot,
  Check,
  CheckCheck,
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
import { TaskSubtaskPanel } from "@/components/task-subtask-panel";
import {
  api,
  markAllNotificationsRead,
  markNotificationRead,
  useWorkspace,
  type TaskHandoff,
  type TimelineEvent,
  type WorkspaceNotification,
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
  /** P5：失败提示带原始请求内容，便于一键重试。 */
  failed?: boolean;
  retryOf?: string;
};

/** 把"还有几分钟有效"说成人话，而不是让用户对着绝对时间自己算。 */
function proposalMinutesLeft(expiresAt: string) {
  const minutes = Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
  return minutes;
}

/** P5：纪要拆分接口返回的草稿（只产草稿，不含任何 ID）。 */
type MinutesDraftPackage = {
  title: string; description?: string; acceptanceCriteria?: string; requiredSkills: string[];
  assignmentMode: "direct" | "open_claim"; assigneeName?: string;
  priority: "critical" | "high" | "medium" | "low";
  dueAt?: string; startedAt?: string; estimatedDays?: number; capacityPoints?: number;
  missingFields: string[]; warnings: string[];
};
type MinutesDraft = {
  source: "model" | "fallback";
  title: string; objective?: string;
  packages: MinutesDraftPackage[];
  notes: string[];
};

const statusCopy: Record<Task["status"], string> = {
  published: "待承接", assigned: "已分派", claimed: "已承接", in_progress: "进行中", blocked: "阻塞", in_review: "待验收", completed: "已完成", cancelled: "已取消",
};
const priorityCopy = { critical: "紧急", high: "高", medium: "中", low: "低" } as const;

/** P4：通知类型的中文标签（人话，不暴露内部枚举）。 */
const notificationKindCopy: Record<WorkspaceNotification["kind"], string> = {
  task_assigned: "新任务",
  task_claimed: "已承接",
  handoff_requested: "待签收交接",
  handoff_responded: "交接结果",
  review_requested: "待你验收",
  review_decided: "验收结果",
  task_due_soon: "任务临期",
  task_overdue: "任务逾期",
  task_blocked: "任务阻塞",
};

/** 系统署名的提醒不指向任何同事；有时效类提醒用警示色标签。 */
function notificationAttribution(notification: WorkspaceNotification, resolveName: (id: string | undefined) => string | undefined) {
  if (notification.actorType === "system" || !notification.actorId) return "系统提醒";
  return resolveName(notification.actorId) ?? "成员";
}
const dueCopy: Record<string, string> = { overdue: "已逾期", due_soon: "临期", normal: "进行中", done: "已完成" };
const timelineEventCopy: Record<string, string> = {
  mission_published: "使命发布", package_published: "任务发布", package_claimed: "已承接", package_status_changed: "状态变更",
  package_handoff_initiated: "交接发起", package_handoff_accepted: "交接签收", package_handoff_rejected: "交接退回",
};

type PublishPackageDraft = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  requiredSkills: string;
  assignmentMode: "direct" | "open_claim";
  assigneeId: string;
  targetOrgUnitId: string;
  priority: "critical" | "high" | "medium" | "low";
  dueAt: string;
  estimatedDays: string;
  capacityPoints: string;
};

function emptyPublishPackage(): PublishPackageDraft {
  return {
    title: "", description: "", acceptanceCriteria: "", requiredSkills: "",
    assignmentMode: "direct", assigneeId: "", targetOrgUnitId: "", priority: "medium",
    dueAt: "", estimatedDays: "7", capacityPoints: "1",
  };
}
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
  onAmendProposal,
  onHydrate,
  onNotice,
  notificationRequest,
  agentStage,
  onRetryMessage,
}: {
  messages: DisplayMessage[];
  query: string;
  isThinking: boolean;
  confirmingProposal: string;
  onQueryChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onConfirmProposal: (proposal: NonNullable<DisplayMessage["proposal"]>) => void;
  onAmendProposal: (proposal: NonNullable<DisplayMessage["proposal"]>) => void;
  onHydrate: (conversationId: string, messages: DisplayMessage[]) => void;
  onNotice: (message: string) => void;
  /** P4：外部（侧栏铃铛）递增该计数即可把右栏切到通知页签。 */
  notificationRequest?: number;
  /** P5：服务端回报的真实阶段文案（运行中显示，不做假进度）。 */
  agentStage?: string;
  /** P5：一键重试失败的那条请求。 */
  onRetryMessage?: (message: string) => void;
}) {
  const { workspace, loading, error, load: loadWorkspace } = useWorkspace();
  const [taskMode, setTaskMode] = useState<"mine" | "available" | "published" | "handoffs">("mine");
  const [railMode, setRailMode] = useState<"tasks" | "messages" | "notifications">("tasks");
  const [busyTask, setBusyTask] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [handoffTask, setHandoffTask] = useState<Task | null>(null);
  const [handoffDraft, setHandoffDraft] = useState({ toAssigneeId: "", note: "", currentProgress: "", completedWork: "", pendingWork: "", attentionPoints: "" });
  const [confirmAction, setConfirmAction] = useState<{ kind: "cancel" | "revoke" | "accept" | "approve_review"; task?: Task; handoff?: TaskHandoff } | null>(null);
  const [rejectHandoffDraft, setRejectHandoffDraft] = useState<{ handoff: TaskHandoff; version: number; responseNote: string } | null>(null);
  const [reviewSubmitTask, setReviewSubmitTask] = useState<Task | null>(null);
  const [reviewEvidenceDraft, setReviewEvidenceDraft] = useState("");
  const [reviewReturnTask, setReviewReturnTask] = useState<Task | null>(null);
  const [reviewReturnNote, setReviewReturnNote] = useState("");
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishMode, setPublishMode] = useState<"form" | "minutes">("form");
  const [minutesDraftText, setMinutesDraftText] = useState("");
  const [minutesDraft, setMinutesDraft] = useState<MinutesDraft | null>(null);
  const [minutesSelected, setMinutesSelected] = useState<boolean[]>([]);
  const [minutesTitle, setMinutesTitle] = useState("");
  const [minutesBusy, setMinutesBusy] = useState(false);
  const [publishForm, setPublishForm] = useState({
    title: "",
    objective: "",
    priority: "medium" as "critical" | "high" | "medium" | "low",
    dueAt: "",
    packages: [emptyPublishPackage()],
  });
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
  /** P4：从通知跳到对应任务（按当前身份与任务的关系选目标分组），并顺手标记已读。 */
  const openNotification = useCallback((notification: WorkspaceNotification) => {
    if (!workspace) return;
    setRailMode("tasks");
    setTaskMode(
      workspace.myTasks.some((item) => item.id === notification.packageId) ? "mine"
        : workspace.publishedByMe.some((item) => item.id === notification.packageId) ? "published"
          : workspace.pendingHandoffs.some(({ task }) => task.id === notification.packageId) ? "handoffs"
            : "available",
    );
    if (!notification.readAt) void markNotificationRead(notification.id).then(() => loadWorkspace()).catch(() => undefined);
    window.requestAnimationFrame(() => document.getElementById(`task-card-${notification.packageId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [workspace, loadWorkspace]);
  const markOneRead = useCallback(async (id: string) => {
    try {
      await markNotificationRead(id);
      await loadWorkspace();
      window.dispatchEvent(new Event("nexus:task-command-changed"));
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "标记已读失败"); }
  }, [loadWorkspace, onNotice]);
  const markAllRead = useCallback(async () => {
    try {
      const result = await markAllNotificationsRead();
      await loadWorkspace();
      window.dispatchEvent(new Event("nexus:task-command-changed"));
      onNotice(result.updated ? `已把 ${result.updated} 条通知标记为已读` : "没有未读通知");
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "标记已读失败"); }
  }, [loadWorkspace, onNotice]);

  useEffect(() => {
    if (!workspace || hydrated.current) return;
    hydrated.current = true;
    onHydrate(workspace.conversation.id, workspace.messages.filter(({ role }) => role !== "tool").map((item) => ({
      role: item.role as "assistant" | "user", content: item.content, runId: item.runId, citations: item.citations, routing: item.route,
    })));
  }, [workspace, onHydrate]);
  useEffect(() => {
    // 侧栏铃铛点进来时把右栏切到通知页签（延迟一拍，避免在 effect 体内同步 setState）
    if (!notificationRequest) return;
    const timer = window.setTimeout(() => setRailMode("notifications"), 0);
    return () => window.clearTimeout(timer);
  }, [notificationRequest]);
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
  const pendingSubtaskCount = (task: Task) => (task.progress && task.progress.total > 0 && task.progress.done < task.progress.total) ? task.progress.total - task.progress.done : 0;

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

  async function submitReview(task: Task) {
    if (!reviewEvidenceDraft.trim() && !task.evidenceRefs.length) { onNotice("提交验收必须附上可核验证据引用"); return; }
    const lines = [...new Set(reviewEvidenceDraft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    setBusyTask(task.id);
    try {
      await api(`/api/v1/task-command/packages/${task.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version, nextStatus: "in_review", evidenceRefs: [...new Set([...task.evidenceRefs, ...lines])] }) });
      setReviewSubmitTask(null);
      setReviewEvidenceDraft("");
      onNotice("已提交验收，等待发布人核验");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "提交验收失败"); }
    finally { setBusyTask(""); }
  }

  async function approveReviewRequest(task: Task) {
    setBusyTask(task.id);
    try {
      await api(`/api/v1/task-command/packages/${task.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version, nextStatus: "completed" }) });
      onNotice("验收已通过，任务完成");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "验收通过失败"); }
    finally { setBusyTask(""); }
  }

  async function submitReviewReturn(task: Task) {
    if (!reviewReturnNote.trim()) { onNotice("退回必须填写至少 4 字的退回原因"); return; }
    setBusyTask(task.id);
    try {
      await api(`/api/v1/task-command/packages/${task.id}/transition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version, nextStatus: "in_progress", reviewNote: reviewReturnNote.trim() }) });
      setReviewReturnTask(null);
      setReviewReturnNote("");
      onNotice("已退回任务，等待承接人补充后再次提交");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "退回任务失败"); }
    finally { setBusyTask(""); }
  }

  async function submitPublish() {
    const missionTitle = publishForm.title.trim();
    const packages = publishForm.packages.map((item) => {
      const skills = item.requiredSkills.split(/[,，、]/).map((part) => part.trim()).filter(Boolean);
      return {
        title: item.title.trim(),
        description: item.description.trim() || undefined,
        acceptanceCriteria: item.acceptanceCriteria.trim() || undefined,
        requiredSkills: skills,
        assignmentMode: item.assignmentMode,
        assigneeId: item.assignmentMode === "direct" && item.assigneeId ? item.assigneeId : undefined,
        targetOrgUnitId: item.assignmentMode === "open_claim" && item.targetOrgUnitId ? item.targetOrgUnitId : undefined,
        priority: item.priority,
        dueAt: item.dueAt || undefined,
        startedAt: undefined,
        estimatedDays: item.estimatedDays ? Number(item.estimatedDays) : undefined,
        capacityPoints: item.capacityPoints ? Number(item.capacityPoints) : undefined,
      };
    }).filter((item) => item.title.length >= 2);
    const conversationId = workspace?.conversation.id;
    if (!conversationId) { onNotice("主对话尚未就绪，无法发布任务"); return; }
    if (missionTitle.length < 2) { onNotice("请填写使命标题（至少 2 字）"); return; }
    if (!packages.length) { onNotice("请至少填写一个任务包标题（至少 2 字）"); return; }
    if (packages.some((item) => item.assignmentMode === "direct" && !item.assigneeId)) { onNotice("定向分派的每个任务包都必须指定负责人"); return; }
    setPublishBusy(true);
    try {
      await api("/api/v1/task-command/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          title: missionTitle,
          objective: publishForm.objective.trim() || undefined,
          priority: publishForm.priority,
          dueAt: publishForm.dueAt || undefined,
          packages,
        }),
      });
      setPublishOpen(false);
      setPublishForm({ title: "", objective: "", priority: "medium", dueAt: "", packages: [emptyPublishPackage()] });
      onNotice(`已发布“${missionTitle}”（${packages.length} 个任务包）`);
      await loadWorkspace();
      window.dispatchEvent(new Event("nexus:task-command-changed"));
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "发布任务失败"); }
    finally { setPublishBusy(false); }
  }

  /** P5：把一段纪要拆成草稿（只读接口，不落库），草稿进入可逐条勾选/编辑的清单。 */
  async function draftFromMinutes() {
    const text = minutesDraftText.trim();
    if (text.length < 10) { onNotice("请粘贴至少 10 个字的纪要内容"); return; }
    setMinutesBusy(true);
    try {
      const draft = await api<MinutesDraft>("/api/v1/agent/task-drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, projectId: undefined }),
      });
      setMinutesDraft(draft);
      setMinutesSelected(draft.packages.map(() => true));
      setMinutesTitle(publishForm.title.trim() || draft.title);
      onNotice(draft.source === "model"
        ? `已按纪要拆出 ${draft.packages.length} 条候选任务，请逐条确认后再发布`
        : `模型当前不可用，已按纪要条目拆出 ${draft.packages.length} 条候选（字段待补充）`);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "纪要拆分失败"); }
    finally { setMinutesBusy(false); }
  }

  async function submitMinutesImport() {
    const conversationId = workspace?.conversation.id;
    const draft = minutesDraft;
    if (!conversationId || !draft) return;
    const chosen = draft.packages.filter((_, index) => minutesSelected[index]);
    if (!chosen.length) { onNotice("请至少勾选一条要发布的任务"); return; }
    if (minutesTitle.trim().length < 2) { onNotice("请填写使命标题（至少 2 字）"); return; }
    // 负责人姓名按当前名册解析；解析不到就按公开承接处理并在提示里说明（不编造 ID）。
    const people = workspace?.people ?? [];
    const packages = chosen.map((item) => {
      const matched = item.assigneeName ? people.find((person) => person.displayName === item.assigneeName) : undefined;
      return {
        title: item.title,
        description: item.description, acceptanceCriteria: item.acceptanceCriteria,
        requiredSkills: item.requiredSkills,
        assignmentMode: matched ? "direct" as const : "open_claim" as const,
        assigneeId: matched?.id,
        priority: item.priority, dueAt: item.dueAt, startedAt: item.startedAt,
        estimatedDays: item.estimatedDays, capacityPoints: item.capacityPoints,
      };
    });
    const unmatched = chosen.filter((item) => item.assigneeName && !people.some((person) => person.displayName === item.assigneeName)).map((item) => item.assigneeName!);
    setPublishBusy(true);
    try {
      await api("/api/v1/task-command/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, title: minutesTitle.trim(), objective: draft.objective, priority: publishForm.priority, dueAt: undefined, packages }),
      });
      setPublishOpen(false);
      setMinutesDraft(null); setMinutesDraftText(""); setMinutesSelected([]); setMinutesTitle("");
      onNotice(unmatched.length
        ? `已发布 ${packages.length} 个任务包；${unmatched.join("、")} 不在当前名册中，已按公开承接处理，请到任务卡指定负责人`
        : `已发布 ${packages.length} 个任务包（来源：纪要导入）`);
      await loadWorkspace();
      window.dispatchEvent(new Event("nexus:task-command-changed"));
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "发布任务失败"); }
    finally { setPublishBusy(false); }
  }

  async function cancelTask(task: Task) {
    setConfirmAction({ kind: "cancel", task });
  }

  async function revokeHandoff(handoff: TaskHandoff, version: number) {
    setConfirmAction({ kind: "revoke", handoff });
    void version;
  }

  async function acceptHandoff(handoff: TaskHandoff, version: number) {
    setConfirmAction({ kind: "accept", handoff });
    void version;
  }

  async function rejectHandoff(handoff: TaskHandoff, version: number) {
    setRejectHandoffDraft({ handoff, version, responseNote: "" });
  }

  async function executeConfirmAction() {
    const action = confirmAction;
    if (!action) return;
    setConfirmAction(null);
    if (action.kind === "cancel" && action.task) await transition(action.task, "cancelled");
    if (action.kind === "approve_review" && action.task) await approveReviewRequest(action.task);
    if (action.kind === "revoke" && action.handoff) await revokeHandoffRequest(action.handoff);
    if (action.kind === "accept" && action.handoff) await acceptHandoffRequest(action.handoff);
  }

  async function revokeHandoffRequest(handoff: TaskHandoff) {
    setBusyTask(handoff.packageId);
    try {
      await api(`/api/v1/task-command/handoffs/${handoff.id}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: workspace?.myTasks.find(({ id }) => id === handoff.packageId)?.version ?? 0 }) });
      onNotice("已撤回交接");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "撤回交接失败"); }
    finally { setBusyTask(""); }
  }

  async function acceptHandoffRequest(handoff: TaskHandoff) {
    setBusyTask(handoff.packageId);
    try {
      const task = workspace?.pendingHandoffs.find(({ handoff: item }) => item.id === handoff.id)?.task;
      if (!task) throw new Error("任务已不在当前权限范围内");
      await api(`/api/v1/task-command/handoffs/${handoff.id}/response`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: task.version, decision: "accept" }) });
      onNotice("已签收交接，任务已切换到你的名下");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "签收失败"); }
    finally { setBusyTask(""); }
  }

  async function submitRejectHandoff() {
    const draft = rejectHandoffDraft;
    if (!draft) return;
    if (draft.responseNote.trim().length < 4) { onNotice("退回必须填写至少 4 字的理由"); return; }
    setRejectHandoffDraft(null);
    setBusyTask(draft.handoff.packageId);
    try {
      await api(`/api/v1/task-command/handoffs/${draft.handoff.id}/response`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: draft.version, decision: "reject", responseNote: draft.responseNote.trim() }) });
      onNotice("已退回交接");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "退回失败"); }
    finally { setBusyTask(""); }
  }

  async function submitHandoff() {
    if (!handoffTask) return;
    const draft = handoffDraft;
    if (!draft.toAssigneeId || draft.note.trim().length < 4 || draft.currentProgress.trim().length < 2 || draft.completedWork.trim().length < 2 || draft.pendingWork.trim().length < 2) { onNotice("请完整填写交接对象、说明、当前进度、已完成和未完成"); return; }
    setBusyTask(handoffTask.id);
    try {
      await api(`/api/v1/task-command/packages/${handoffTask.id}/handoffs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: handoffTask.version, toAssigneeId: draft.toAssigneeId, note: draft.note.trim(), currentProgress: draft.currentProgress.trim(), completedWork: draft.completedWork.trim(), pendingWork: draft.pendingWork.trim(), attentionPoints: draft.attentionPoints.trim() || undefined, artifactIds: [], artifactRefs: [] }) });
      setHandoffTask(null);
      setHandoffDraft({ toAssigneeId: "", note: "", currentProgress: "", completedWork: "", pendingWork: "", attentionPoints: "" });
      onNotice("交接已发起，等待对方确认");
      await loadWorkspace();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "发起交接失败"); }
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
          {!messages.length ? <div className="command-welcome"><h1>有什么需要处理？</h1><p>直接说就可以。审批、项目、会议、知识、经营分析和任务都可以从这里开始。</p><div className="command-empty-guide"><strong>不知道从哪句话开始？试试这些</strong><p>点一句填进输入框，再按需改人名和时间即可。</p>{[
            `把「华东环境巡检」交给${workspace?.people[0]?.displayName ?? "某位同事"}，本周五前完成`,
            "今天新入职了一名员工叫李小明，先登记到名册里",
            "以「智能客服 2.0 上线」为主题，拆成发布、联调和验收三个任务包",
          ].map((example) => <button type="button" key={example} onClick={() => onQueryChange(example)}>{example}</button>)}</div></div> : null}
          {messages.map((message, index) => <article key={`${message.runId ?? "message"}-${index}`} className={`command-message is-${message.role}`}>
            {message.role === "assistant" ? <span className="command-message-avatar"><Bot size={16} /></span> : null}
            <div className="command-message-body">
              {message.role === "assistant" ? <div className="command-message-meta"><span>{message.proposal ? "待确认" : message.job ? "执行状态" : "枢纽"}</span></div> : null}
              <p>{message.content}</p>
              {message.routing?.tools.length ? <details className="route-proof"><summary>已使用 {message.routing.tools.length} 项办公能力</summary><span>{message.routing.tools.join(" · ")}</span></details> : null}
              {message.citations?.length ? <div className="command-citations"><span><ShieldCheck size={12} />核验依据</span>{message.citations.slice(0, 5).map((citation, citationIndex) => <details key={citation.id}><summary><b>[{citationIndex + 1}]</b>{citation.label}</summary><small>{citation.excerpt}</small></details>)}</div> : null}
              {message.proposal ? <div className="command-proposal"><div><span>需要你确认</span><b>请在 {proposalMinutesLeft(message.proposal.expiresAt)} 分钟内确认，过期需重新发起</b></div><strong>{message.proposal.preview}</strong><footer><button onClick={() => onAmendProposal(message.proposal!)}>修正草稿<ArrowRight size={13} /></button><button disabled={confirmingProposal === message.proposal.id} onClick={() => onConfirmProposal(message.proposal!)}>{confirmingProposal === message.proposal.id ? "正在校验…" : "确认并执行"}<ArrowRight size={13} /></button></footer></div> : null}
              {message.job ? <div className="command-job"><Radio size={13} /><span>{message.job.status}</span><code>{message.job.id.slice(0, 8)}</code></div> : null}
              {message.failed && message.retryOf ? <div className="command-retry"><button type="button" onClick={() => onRetryMessage?.(message.retryOf!)}>重试这条请求<RotateCcw size={13} /></button><small>原始内容已保留，不需要重新输入</small></div> : null}
            </div>
          </article>)}
          {isThinking ? <article className="command-message is-assistant"><span className="command-message-avatar"><Bot size={16} /></span><div className="command-thinking"><i /><i /><i /><span>{agentStage || "正在处理"}</span></div></article> : null}
          <div ref={conversationEnd} />
        </div>

        <form className="primary-composer" onSubmit={onSubmit}>
          <textarea id="primary-work-command" aria-label="说说你要处理什么" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={handleComposerKeyDown} rows={6} placeholder="输入一件要处理的事…" />
          <footer><div><small>Enter 发送 · Shift + Enter 换行</small></div><button type="submit" aria-label="发送" disabled={!query.trim() || isThinking}>{isThinking ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></footer>
        </form>
      </section>

      <aside className="live-task-rail">
        <header><div><h2>{railMode === "tasks" ? "任务" : railMode === "notifications" ? "通知" : "消息池"}</h2><p>{workspace ? `已同步 · ${formatTime(workspace.generatedAt)}` : "正在同步"}</p></div><div className="task-rail-actions"><button type="button" className="task-publish-action" onClick={() => setPublishOpen(true)} disabled={loading}><Sparkles size={14} />发布任务</button><button type="button" onClick={() => void refreshWorkspace()} disabled={refreshing} aria-label="刷新工作区"><RotateCcw className={refreshing ? "spin" : ""} size={15} /></button></div></header>
        <div className="task-rail-tabs task-rail-mode-tabs" role="tablist" aria-label="工作上下文">
          <button type="button" role="tab" aria-selected={railMode === "tasks"} className={railMode === "tasks" ? "active" : ""} onClick={() => setRailMode("tasks")}><ListTodo size={14} />任务 <b>{(workspace?.myTasks.length ?? 0) + (workspace?.availableTasks.length ?? 0)}</b></button>
          <button type="button" role="tab" aria-selected={railMode === "notifications"} className={railMode === "notifications" ? "active" : ""} onClick={() => setRailMode("notifications")}><Bell size={14} />通知 {workspace?.unreadNotificationCount ? <b className="task-rail-badge">{workspace.unreadNotificationCount}</b> : <b>0</b>}</button>
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
            return <div className="task-rail-group" key={task.id}>{showDueHeader ? <div className="task-due-group-label">{dueLabel(task)} · {sortedTasks.filter((item) => (item.dueState ?? "normal") === (task.dueState ?? "normal")).length}</div> : null}<article id={`task-card-${task.id}`} className={`task-dispatch-card is-${task.status}${task.isTemplate ? " is-template" : ""}`}>
            <div className="task-dispatch-top"><span className={`task-priority is-${task.priority}`}>{task.isTemplate ? "模板" : priorityCopy[task.priority]}</span>{!task.isTemplate && task.dueState && ["overdue", "due_soon"].includes(task.dueState) ? <span className={`task-due is-${task.dueState}`}>{dueLabel(task)}</span> : null}<span className="task-state"><i />{task.isTemplate ? "待补充" : statusCopy[task.status]}</span>{outgoingHandoffsByTask.has(task.id) ? <span className="task-handoff-waiting">{taskMode === "handoffs" ? "等对方签收" : `正在交接中 · 等待${peopleById.get(outgoingHandoffsByTask.get(task.id)!.toAssigneeId)?.displayName ?? "对方"}确认`}</span> : null}{canCancelTask(task) ? <button className="task-cancel-action" type="button" disabled={busyTask === task.id} onClick={() => void cancelTask(task)}>{busyTask === task.id ? "取消中…" : "取消"}</button> : null}</div>
            <h3>{task.title}</h3><p>{task.description}</p>
            <dl><div><dt>接收对象</dt><dd>{task.assigneeId ? peopleById.get(task.assigneeId)?.displayName ?? "已指派成员" : task.targetOrgUnitId ? `${orgUnitsById.get(task.targetOrgUnitId)?.name ?? "指定部门"}待承接` : "公司公开承接"}</dd></div>{task.startedAt ? <div><dt>开始</dt><dd>{formatDate(task.startedAt)}</dd></div> : null}<div><dt>截止</dt><dd>{formatDate(task.dueAt)}{task.dueState === "overdue" ? " · 已逾期" : task.dueState === "due_soon" ? " · 临期" : ""}</dd></div>{task.estimatedDays ? <div><dt>工期</dt><dd>{task.estimatedDays} 天</dd></div> : null}</dl>
            <details className="task-acceptance"><summary>验收标准</summary><p>{task.acceptanceCriteria}</p></details>
            {task.missingFields.length ? <div className="task-template-missing">待补充：{task.missingFields.join("、")}</div> : null}
            {taskHandoffs.length ? <details className="task-handoff-trail"><summary>交接链 · {taskHandoffs.length} 棒{taskHandoffs.some(({ status }) => status === "pending") ? " · 待签收" : ""}</summary>{taskHandoffs.slice(-4).map((handoff) => <div className="task-handoff-line" key={handoff.id}><span>{peopleById.get(handoff.fromAssigneeId)?.displayName ?? "前负责人"}<ArrowRight size={11} />{peopleById.get(handoff.toAssigneeId)?.displayName ?? "接收人"}</span><small>{handoff.status === "pending" ? "待签收" : handoff.status === "accepted" ? "已签收" : handoff.respondedBy === handoff.fromAssigneeId ? "已撤回" : "已退回"} · 文件/资料 {handoff.artifactRefs.length} · v{handoff.snapshot.packageVersion}</small><p>{handoff.note}</p>{handoff.currentProgress ? <p className="task-handoff-field"><b>当前进度</b>{handoff.currentProgress}</p> : null}{handoff.completedWork ? <p className="task-handoff-field"><b>已完成</b>{handoff.completedWork}</p> : null}{handoff.pendingWork ? <p className="task-handoff-field"><b>未完成</b>{handoff.pendingWork}</p> : null}{handoff.attentionPoints ? <p className="task-handoff-field"><b>注意</b>{handoff.attentionPoints}</p> : null}{handoff.responseNote ? <p className="task-handoff-response">{handoff.responseNote}</p> : null}</div>)}</details> : null}
            <details className="task-timeline" onToggle={(event) => { if (event.currentTarget.open) void loadTimeline(task.id); }}><summary>时间线 · {timelines[task.id]?.length ?? 0} 条</summary>{(timelines[task.id] ?? []).map((item) => <div className="task-timeline-line" key={item.id}><span>{timelineEventCopy[item.eventType] ?? item.eventType}</span><small>{formatDate(item.occurredAt)}</small></div>)}</details>
            <TaskSubtaskPanel task={task} editable={!task.isTemplate && !["in_review", "completed", "cancelled"].includes(task.status) && !hasPendingHandoff(task.id) && (taskMode === "mine" || taskMode === "published")} resolveName={(id) => peopleById.get(id ?? "")?.displayName ?? "成员"} onChanged={() => void loadWorkspace().catch(() => undefined)} onNotice={onNotice} onAskAgent={onQueryChange} />
            {taskMode === "mine" && task.assigneeId && !taskHandoffs.some(({ status }) => status === "pending") && !["in_review", "completed", "cancelled"].includes(task.status) ? <button className="task-handoff-action" type="button" onClick={() => { setHandoffTask(task); setHandoffDraft((current) => ({ ...current, toAssigneeId: workspace?.people.find(({ id }) => id !== task.assigneeId)?.id ?? "" })); }}>发起交接<ArrowRight size={13} /></button> : null}
            <footer>{task.isTemplate && taskMode === "published" ? <button onClick={() => onQueryChange(`补充任务模板“${task.title}”，模板 ID 为 ${task.id}，当前版本为 ${task.version}。请先询问我想补充哪些字段，再使用 work.update_task_template 更新；不要正式分派。`)}>补充模板<ArrowRight size={13} /></button> : taskMode === "handoffs" && pendingHandoff ? <><button disabled={busyTask === task.id} onClick={() => void acceptHandoff(pendingHandoff, task.version)}>{busyTask === task.id ? "处理中…" : "签收"}<Check size={13} /></button><button className="task-handoff-reject" disabled={busyTask === task.id} onClick={() => void rejectHandoff(pendingHandoff, task.version)}>退回</button></> : taskMode === "available" ? <button disabled={busyTask === task.id} onClick={() => void claim(task)}>{busyTask === task.id ? "承接中…" : "承接"}<ArrowRight size={13} /></button> : taskMode === "published" && !task.isTemplate && task.status === "in_review" ? <><button disabled={busyTask === task.id} onClick={() => setConfirmAction({ kind: "approve_review", task })}>{busyTask === task.id ? "处理中…" : "验收通过"}<Check size={13} /></button><button className="task-handoff-reject" disabled={busyTask === task.id} onClick={() => { setReviewReturnTask(task); setReviewReturnNote(""); }}>退回</button></> : taskMode === "mine" && task.status === "in_progress" && pendingSubtaskCount(task) > 0 ? <button type="button" className="task-handoff-reject" disabled title={`还有 ${pendingSubtaskCount(task)} 个子任务未完成，全部完成才能提交验收`}>子任务 {task.progress?.done}/{task.progress?.total}<CircleDashed size={13} /></button> : taskMode === "mine" && task.status === "in_progress" ? <button disabled={busyTask === task.id} onClick={() => { setReviewEvidenceDraft(task.evidenceRefs.join("\n")); setReviewSubmitTask(task); }}>提交验收<Check size={13} /></button> : taskMode === "mine" && task.status === "blocked" ? <button disabled={busyTask === task.id} onClick={() => void transition(task, "in_progress")}>解除阻塞<ArrowRight size={13} /></button> : taskMode === "mine" && task.status === "in_review" && task.assigneeId === task.publishedBy ? <><button disabled={busyTask === task.id} onClick={() => setConfirmAction({ kind: "approve_review", task })}>{busyTask === task.id ? "处理中…" : "验收通过"}<Check size={13} /></button><button className="task-handoff-reject" disabled={busyTask === task.id} onClick={() => { setReviewReturnTask(task); setReviewReturnNote(""); }}>退回</button></> : taskMode === "mine" && task.status === "in_review" ? <span className="task-review-waiting"><i />等待发布人验收</span> : <span>{formatRelative(task.dueAt)}</span>}{taskMode === "handoffs" && outgoingHandoffsByTask.has(task.id) ? <button className="task-handoff-revoke" type="button" disabled={busyTask === task.id} onClick={() => void revokeHandoff(outgoingHandoffsByTask.get(task.id)!, task.version)}>{busyTask === task.id ? "撤回中…" : "撤回交接"}<ArrowRight size={13} /></button> : null}</footer>
          </article></div>}); })()}
          </div>
        </> : railMode === "notifications" ? <div className="notification-list">
          {loading && !workspace ? <TaskRailState icon={LoaderCircle} title="正在同步通知" detail="" spinning /> : error && !workspace ? <TaskRailState icon={CircleAlert} title="通知暂时不可用" detail={error} action={() => void loadWorkspace()} /> : !(workspace?.notifications.length) ? <TaskRailState icon={Bell} title="还没有通知" detail="任务分派、承接、交接与验收都会在这里提醒你，不需要自己反复刷新。" /> : <>
            <div className="notification-list-head"><span><b>{workspace.unreadNotificationCount}</b> 条未读 · 共 {workspace.notifications.length} 条</span>{workspace.unreadNotificationCount ? <button type="button" onClick={() => void markAllRead()}><CheckCheck size={13} />全部已读</button> : null}</div>
            {workspace.notifications.map((notification) => <article className={`notification-card${notification.readAt ? "" : " is-unread"}`} key={notification.id}>
              <div className="notification-card-top"><span className="notification-kind">{notificationKindCopy[notification.kind]}</span>{notification.readAt ? null : <i className="notification-dot" aria-label="未读" />}<small>{notificationAttribution(notification, (id) => peopleById.get(id ?? "")?.displayName)} · {formatTime(notification.createdAt)}</small></div>
              <h4>{notification.title}</h4>
              <p>{notification.body}</p>
              <footer>
                <button type="button" className="notification-open" onClick={() => openNotification(notification)}>查看任务<ArrowRight size={13} /></button>
                {notification.readAt ? null : <button type="button" onClick={() => void markOneRead(notification.id)}>标记已读</button>}
              </footer>
            </article>)}
          </>}
        </div> : <div className="message-pool-list">
          {loading && !workspace ? <TaskRailState icon={LoaderCircle} title="正在同步消息" detail="" spinning /> : error && !workspace ? <TaskRailState icon={CircleAlert} title="消息池暂时不可用" detail={error} action={() => void loadWorkspace()} /> : !workspace?.messagePools.some((pool) => pool.messages.length) ? <TaskRailState icon={MessageCircle} title="还没有沟通消息" detail="推送只用于同步、征询和反馈，不会创建任务。" /> : workspace.messagePools.map((pool) => <section className="message-pool-section" key={pool.key}><header><span>{pool.scope === "company" ? "公司" : "部门"}</span><h3>{pool.name}</h3><b>{pool.messages.length}</b></header>{pool.messages.map((message) => <article className="message-pool-card" key={message.id}><h4>{message.subject}</h4><p>{message.content}</p><footer><span>{message.authorType === "system" ? "系统提醒" : peopleById.get(message.authorId ?? "")?.displayName ?? "成员"} · {formatTime(message.createdAt)}</span><button type="button" onClick={() => onQueryChange(`我想针对消息“${message.subject}”补充反馈。请使用 communication.add_feedback 工具向消息 ${message.id} 写入以下反馈：`)}>{message.feedback.length ? `${message.feedback.length} 条反馈` : "反馈"}</button></footer>{message.feedback.length ? <details><summary>查看反馈</summary>{message.feedback.slice(-3).map((feedback) => <p className="message-pool-feedback" key={feedback.id}><b>{peopleById.get(feedback.authorId)?.displayName ?? "成员"}</b>{feedback.content}</p>)}</details> : null}</article>)}</section>)}
        </div>}
      </aside>
    </div>
    {handoffTask ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-dialog-title"><header><div><span className="command-kicker"><ArrowRight size={13} />TASK HANDOFF</span><h2 id="handoff-dialog-title">发起交接</h2><p>{handoffTask.title} · 当前版本 {handoffTask.version}</p></div><button type="button" className="icon-button" aria-label="关闭发起交接" onClick={() => setHandoffTask(null)}>×</button></header><label>交接给谁<select value={handoffDraft.toAssigneeId} onChange={(event) => setHandoffDraft((current) => ({ ...current, toAssigneeId: event.target.value }))}><option value="">选择成员</option>{workspace?.people.filter(({ id }) => id !== handoffTask.assigneeId).map((person) => <option value={person.id} key={person.id}>{person.displayName} · {person.orgName ?? ""}</option>)}</select></label><label>交接说明<textarea value={handoffDraft.note} onChange={(event) => setHandoffDraft((current) => ({ ...current, note: event.target.value }))} rows={2} /></label><label>当前进度<textarea value={handoffDraft.currentProgress} onChange={(event) => setHandoffDraft((current) => ({ ...current, currentProgress: event.target.value }))} rows={2} /></label><label>已完成<textarea value={handoffDraft.completedWork} onChange={(event) => setHandoffDraft((current) => ({ ...current, completedWork: event.target.value }))} rows={2} /></label><label>未完成<textarea value={handoffDraft.pendingWork} onChange={(event) => setHandoffDraft((current) => ({ ...current, pendingWork: event.target.value }))} rows={2} /></label><label>注意事项（可选）<textarea value={handoffDraft.attentionPoints} onChange={(event) => setHandoffDraft((current) => ({ ...current, attentionPoints: event.target.value }))} rows={2} /></label><footer><button type="button" onClick={() => setHandoffTask(null)}>取消</button><button type="button" className="primary" disabled={busyTask === handoffTask.id} onClick={() => void submitHandoff()}>{busyTask === handoffTask.id ? "提交中…" : "预览并发起"}<ArrowRight size={13} /></button></footer></section></div> : null}
    {publishOpen ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog work-dialog-publish" role="dialog" aria-modal="true" aria-labelledby="publish-dialog-title"><header><div><span className="command-kicker"><Radio size={13} />PUBLISH TASK</span><h2 id="publish-dialog-title">发布任务</h2><p>表单录入或把会议纪要交给 AI 拆成任务包；两种方式都走同一套发布校验。</p></div><button type="button" className="icon-button" aria-label="关闭发布任务" onClick={() => { setPublishOpen(false); setMinutesDraft(null); }}>×</button></header>
      <div className="publish-mode-tabs" role="tablist" aria-label="发布方式">
        <button type="button" role="tab" aria-selected={publishMode === "form"} className={publishMode === "form" ? "active" : ""} onClick={() => setPublishMode("form")}>表单录入</button>
        <button type="button" role="tab" aria-selected={publishMode === "minutes"} className={publishMode === "minutes" ? "active" : ""} onClick={() => setPublishMode("minutes")}>从纪要批量导入</button>
      </div>
      {publishMode === "minutes" ? <>
        <label>粘贴会议纪要或口头安排<textarea value={minutesDraftText} onChange={(event) => { setMinutesDraftText(event.target.value); setMinutesDraft(null); }} rows={6} placeholder={"如：\n1. 周然在 10/1 前完成灰度压测报告，验收标准是含 P95 延迟与错误率\n2. 林悦把客服话术库更新到 v2"} /></label>
        <div className="publish-minutes-actions"><button type="button" disabled={minutesBusy || minutesDraftText.trim().length < 10} onClick={() => void draftFromMinutes()}>{minutesBusy ? "正在拆分…" : "让 AI 拆成任务草稿"}</button><small>只生成草稿，不会直接创建任务</small></div>
        {minutesDraft ? <div className="publish-minutes-draft">
          {minutesDraft.notes.map((note) => <p className="publish-minutes-note" key={note}>{note}</p>)}
          <label>使命标题 *<input value={minutesTitle} onChange={(event) => setMinutesTitle(event.target.value)} /></label>
          <div className="publish-minutes-list">{minutesDraft.packages.map((item, index) => <label className={`publish-minutes-item${minutesSelected[index] ? " is-selected" : ""}`} key={`${item.title}-${index}`}>
            <span className="publish-minutes-pick"><input type="checkbox" checked={Boolean(minutesSelected[index])} onChange={(event) => setMinutesSelected((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.checked : value))} /><b>{item.title}</b></span>
            <small>{item.assigneeName ? `负责人（纪要里写的）：${item.assigneeName}` : "未指定负责人，将按公开承接发布"} · {priorityCopy[item.priority]}{item.dueAt ? ` · 截止 ${item.dueAt.slice(0, 10)}` : ""}</small>
            {item.description ? <small>{item.description}</small> : null}
            {item.missingFields.length ? <small className="publish-minutes-missing">待补充：{item.missingFields.join("、")}</small> : null}
            {item.warnings.map((warning) => <small className="publish-minutes-warning" key={warning}>{warning}</small>)}
          </label>)}</div>
          <footer><button type="button" onClick={() => { setMinutesDraft(null); setMinutesSelected([]); }}>重新拆分</button><button type="button" className="primary" disabled={publishBusy || !minutesSelected.some(Boolean)} onClick={() => void submitMinutesImport()}>{publishBusy ? "发布中…" : `发布选中的 ${minutesSelected.filter(Boolean).length} 条`}<ArrowRight size={13} /></button></footer>
        </div> : null}
      </> : <>
      <label>使命标题 *<input value={publishForm.title} onChange={(event) => setPublishForm((current) => ({ ...current, title: event.target.value }))} placeholder="如：华东交付冲刺" /></label>
      <label>目标<input value={publishForm.objective} onChange={(event) => setPublishForm((current) => ({ ...current, objective: event.target.value }))} placeholder="本轮要达成的结果（可选）" /></label>
      <div className="work-dialog-row"><label>优先级<select value={publishForm.priority} onChange={(event) => setPublishForm((current) => ({ ...current, priority: event.target.value as PublishPackageDraft["priority"] }))}>{(["critical", "high", "medium", "low"] as const).map((value) => <option value={value} key={value}>{priorityCopy[value]}</option>)}</select></label><label>截止（可选）<input type="date" value={publishForm.dueAt.slice(0, 10)} onChange={(event) => setPublishForm((current) => ({ ...current, dueAt: event.target.value ? `${event.target.value}T18:00:00.000+08:00` : "" }))} /></label></div>
      <div className="publish-package-list">{publishForm.packages.map((item, index) => <fieldset className="publish-package-box" key={index}><legend>任务包 {index + 1}{publishForm.packages.length > 1 ? <button type="button" aria-label={`删除任务包 ${index + 1}`} onClick={() => setPublishForm((current) => ({ ...current, packages: current.packages.length > 1 ? current.packages.filter((_, itemIndex) => itemIndex !== index) : current.packages }))}>×</button> : null}</legend>
        <label>任务标题 *<input value={item.title} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, title: event.target.value } : entry) }))} placeholder="如：完成客户验收材料" /></label>
        <div className="work-dialog-row"><label>承接方式<select value={item.assignmentMode} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, assignmentMode: event.target.value as PublishPackageDraft["assignmentMode"] } : entry) }))}><option value="direct">定向分派（指定负责人）</option><option value="open_claim">公开承接</option></select></label>{item.assignmentMode === "direct" ? <label>负责人 *<select value={item.assigneeId} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, assigneeId: event.target.value } : entry) }))}><option value="">选择成员</option>{workspace?.people.map((person) => <option value={person.id} key={person.id}>{person.displayName} · {person.orgName ?? ""}</option>)}</select></label> : <label>限定部门（可选）<select value={item.targetOrgUnitId} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, targetOrgUnitId: event.target.value } : entry) }))}><option value="">公司公开承接</option>{workspace?.orgUnits.map((unit) => <option value={unit.id} key={unit.id}>{unit.name}</option>)}</select></label>}</div>
        <label>任务说明<input value={item.description} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, description: event.target.value } : entry) }))} placeholder="要完成什么（可选，缺省标记待补充）" /></label>
        <label>验收标准<input value={item.acceptanceCriteria} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, acceptanceCriteria: event.target.value } : entry) }))} placeholder="怎样算完成（可选，缺省标记待补充）" /></label>
        <div className="work-dialog-row"><label>所需技能<input value={item.requiredSkills} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, requiredSkills: event.target.value } : entry) }))} placeholder="逗号分隔（可选）" /></label><label>优先级<select value={item.priority} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, priority: event.target.value as PublishPackageDraft["priority"] } : entry) }))}>{(["critical", "high", "medium", "low"] as const).map((value) => <option value={value} key={value}>{priorityCopy[value]}</option>)}</select></label><label>工期（天）<input type="number" min={1} max={365} value={item.estimatedDays} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, estimatedDays: event.target.value } : entry) }))} /></label><label>容量点<input type="number" min={1} max={40} value={item.capacityPoints} onChange={(event) => setPublishForm((current) => ({ ...current, packages: current.packages.map((entry, entryIndex) => entryIndex === index ? { ...entry, capacityPoints: event.target.value } : entry) }))} /></label></div>
      </fieldset>)}</div>
      <button type="button" className="publish-add-package" onClick={() => setPublishForm((current) => ({ ...current, packages: [...current.packages, emptyPublishPackage()] }))}>+ 再加一个任务包</button>
      <footer><button type="button" onClick={() => setPublishOpen(false)}>取消</button><button type="button" className="primary" disabled={publishBusy} onClick={() => void submitPublish()}>{publishBusy ? "发布中…" : "确认发布"}<ArrowRight size={13} /></button></footer>
      </>}
      </section></div> : null}
    {confirmAction ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog work-dialog-compact" role="dialog" aria-modal="true" aria-labelledby="task-confirm-title"><h2 id="task-confirm-title">确认操作</h2><p>{confirmAction.kind === "cancel" ? `确认取消任务「${confirmAction.task?.title}」？取消后不可恢复。` : confirmAction.kind === "accept" ? "确认签收交接？签收后任务责任将切换到你的名下。" : confirmAction.kind === "approve_review" ? `确认验收通过「${confirmAction.task?.title}」？任务将标记为已完成，操作将记录验收人。` : "确认撤回交接？对方将不能再签收。"}</p><footer><button type="button" onClick={() => setConfirmAction(null)}>返回</button><button type="button" className="primary" onClick={() => void executeConfirmAction()}>确认</button></footer></section></div> : null}
    {rejectHandoffDraft ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog work-dialog-compact" role="dialog" aria-modal="true" aria-labelledby="reject-handoff-title"><h2 id="reject-handoff-title">退回交接</h2><p>请填写退回原因，至少 4 个字。</p><textarea autoFocus value={rejectHandoffDraft.responseNote} onChange={(event) => setRejectHandoffDraft((current) => current ? { ...current, responseNote: event.target.value } : current)} rows={4} /><footer><button type="button" onClick={() => setRejectHandoffDraft(null)}>取消</button><button type="button" className="primary" onClick={() => void submitRejectHandoff()}>确认退回</button></footer></section></div> : null}
    {reviewSubmitTask ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog work-dialog-compact" role="dialog" aria-modal="true" aria-labelledby="review-submit-title"><h2 id="review-submit-title">提交验收</h2><p>任务将进入“待验收”，由发布人核验。证据必须是可核验引用（每行一条）：<b>http(s) 链接</b> 或 <b>类型:引用</b>（如 document:xxx、minutes:…、artifact:uuid），不能只写“已完成”。</p><textarea autoFocus value={reviewEvidenceDraft} onChange={(event) => setReviewEvidenceDraft(event.target.value)} rows={5} placeholder={reviewSubmitTask.evidenceRefs.length ? "已有证据可直接提交，或补充新证据…" : "https://… 或 document:… ，每行一条"} /><footer><button type="button" onClick={() => { setReviewSubmitTask(null); setReviewEvidenceDraft(""); }}>取消</button><button type="button" className="primary" disabled={busyTask === reviewSubmitTask.id || (!reviewEvidenceDraft.trim() && !reviewSubmitTask.evidenceRefs.length)} onClick={() => void submitReview(reviewSubmitTask)}>{busyTask === reviewSubmitTask.id ? "提交中…" : "提交验收"}<Check size={13} /></button></footer></section></div> : null}
    {reviewReturnTask ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog work-dialog-compact" role="dialog" aria-modal="true" aria-labelledby="review-return-title"><h2 id="review-return-title">退回任务</h2><p>任务将回到执行人手中继续补充。退回原因必须填写且至少 4 个字，会记入事件链供执行人查看。</p><textarea autoFocus value={reviewReturnNote} onChange={(event) => setReviewReturnNote(event.target.value)} rows={4} placeholder="说明未通过的原因（例如：证据缺少客户签字页）" /><footer><button type="button" onClick={() => { setReviewReturnTask(null); setReviewReturnNote(""); }}>取消</button><button type="button" className="primary" disabled={busyTask === reviewReturnTask.id || reviewReturnNote.trim().length < 4} onClick={() => void submitReviewReturn(reviewReturnTask)}>{busyTask === reviewReturnTask.id ? "退回中…" : "确认退回"}<ArrowRight size={13} /></button></footer></section></div> : null}
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
