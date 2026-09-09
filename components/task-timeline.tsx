"use client";

import { Activity, AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TimelineEvent } from "@/components/workspace-client";
import { readBoard, type Board } from "@/components/board-client";

const eventCopy: Record<string, string> = {
  mission_published: "使命发布",
  package_published: "任务发布",
  package_claimed: "承接任务",
  package_status_changed: "状态变更",
  package_handoff_initiated: "发起交接",
  package_handoff_accepted: "交接签收",
  package_handoff_rejected: "交接退回",
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

type TimelinePage = {
  events: TimelineEvent[];
  nextCursor: number | null;
  hasMore: boolean;
  generatedAt: string;
};

type EventView = {
  action: string;
  detail?: string;
  taskTitle: string;
  actor: string;
  time: string;
  tone: string;
};

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusLabel(value: unknown): string | undefined {
  const status = textValue(value);
  return status ? statusCopy[status] ?? status : undefined;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function eventView(event: TimelineEvent, board: Board | null): EventView {
  const payload = event.payload ?? {};
  const task = event.packageId ? board?.tasks.find(({ id }) => id === event.packageId) : undefined;
  const mission = event.missionId ? board?.missions.find(({ id }) => id === event.missionId) : undefined;
  const actor = board?.people.find(({ id }) => id === event.actorId)?.displayName ?? "已授权成员";
  const taskTitle = event.eventType === "mission_published"
    ? textValue(payload.title) ?? mission?.title ?? "使命记录"
    : task?.title ?? textValue(payload.title) ?? "任务记录";
  let action = eventCopy[event.eventType] ?? "任务操作";
  let detail: string | undefined;
  let tone = "neutral";

  if (event.eventType === "package_status_changed") {
    const previous = statusLabel(payload.previousStatus);
    const next = statusLabel(payload.nextStatus);
    if (next === "已取消") {
      action = "取消任务";
      tone = "danger";
    } else if (previous && next) {
      detail = `${previous} → ${next}`;
      tone = next === "已完成" ? "done" : next === "已阻塞" ? "danger" : "active";
    } else {
      detail = next;
    }
  } else if (event.eventType === "package_handoff_initiated") {
    const target = board?.people.find(({ id }) => id === payload.toAssigneeId)?.displayName;
    detail = target ? `交给 ${target}` : "等待签收";
    tone = "handoff";
  } else if (event.eventType === "package_handoff_accepted") {
    const source = board?.people.find(({ id }) => id === payload.fromAssigneeId)?.displayName;
    detail = source ? `${source} 已交出` : "责任已切换";
    action = "交接签收";
    tone = "done";
  } else if (event.eventType === "package_handoff_rejected") {
    detail = payload.decision === "revoke" ? "已撤回" : "已退回";
    action = payload.decision === "revoke" ? "撤回交接" : "交接退回";
    tone = "danger";
  } else if (event.eventType === "package_claimed") {
    detail = "责任人已确认";
    tone = "active";
  } else if (event.eventType === "package_published") {
    detail = textValue(payload.assignmentMode) === "open_claim" ? "开放承接" : "定向分派";
    tone = "active";
  } else if (event.eventType === "mission_published") {
    detail = typeof payload.packageCount === "number" ? `${payload.packageCount} 项任务` : undefined;
    tone = "active";
  }

  return { action, detail, taskTitle, actor, time: formatDate(event.occurredAt), tone };
}

export function TaskTimeline() {
  const [board, setBoard] = useState<Board | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const initialLoad = useRef(false);

  const load = useCallback(async (append = false) => {
    if (append && (loadingMore || !hasMore || nextCursor === null)) return;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const after = append ? nextCursor ?? 0 : 0;
      const [page, currentBoard] = await Promise.all([
        api<TimelinePage>(`/api/v1/task-command/timeline?after=${after}&limit=50`, { cache: "no-store" }),
        board ? Promise.resolve(board) : readBoard(),
      ]);
      setBoard(currentBoard);
      setEvents((current) => append ? [...current, ...page.events.filter((item) => !current.some(({ id }) => id === item.id))] : page.events);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务时间线加载失败");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [board, hasMore, loadingMore, nextCursor]);

  useEffect(() => {
    if (initialLoad.current) return;
    initialLoad.current = true;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]); // The first read is intentionally one-shot; refresh is explicit below.

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("nexus:task-command-changed", refresh);
    return () => window.removeEventListener("nexus:task-command-changed", refresh);
  }, [load]);

  const views = useMemo(() => [...events]
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.sequence - right.sequence)
    .map((event) => ({ event, view: eventView(event, board) })), [board, events]);
  const taskCount = useMemo(() => new Set(events.map(({ packageId }) => packageId).filter(Boolean)).size, [events]);
  const latest = views.at(-1)?.event.occurredAt;

  return (
    <div className={`task-timeline-view${loading && events.length ? " is-refreshing" : ""}`}>
      <header className="task-timeline-head">
        <div>
          <p className="eyebrow">TASK ACTIVITY · AUTHORIZED HISTORY</p>
          <h1>任务时间线</h1>
          <p>按发生时间记录当前身份可见的任务发布、承接、状态变化与交接操作。</p>
        </div>
        <button className="task-timeline-refresh" type="button" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} size={14} />刷新
        </button>
      </header>

      <section className="task-timeline-facts" aria-label="时间线摘要">
        <div><span>事件</span><strong>{events.length}</strong><small>当前已加载</small></div>
        <div><span>涉及任务</span><strong>{taskCount}</strong><small>经过权限过滤</small></div>
        <div><span>最新操作</span><strong>{latest ? formatDate(latest) : "—"}</strong><small>服务端事实时间</small></div>
      </section>

      {error && !events.length ? (
        <div className="task-timeline-state is-error"><AlertCircle size={22} /><strong>时间线暂时不可用</strong><span>{error}</span><button type="button" onClick={() => void load()}>重新加载</button></div>
      ) : loading && !events.length ? (
        <div className="task-timeline-state"><Activity className="spin" size={22} /><span>正在读取已授权任务事件…</span></div>
      ) : !events.length ? (
        <div className="task-timeline-state"><Activity size={22} /><strong>还没有可显示的任务操作</strong><span>这里不会填充未经服务端返回的任务记录。</span></div>
      ) : (
        <>
          <ol className="task-timeline-track" aria-label="任务操作时间线">
            {views.map(({ event, view }, index) => (
              <li className={`task-timeline-event ${index % 2 ? "is-right" : "is-left"} is-${view.tone}`} key={event.id}>
                <span className="task-timeline-node" aria-hidden="true" />
                <article className="task-timeline-card" tabIndex={0} aria-label={`${view.actor}${view.action}：${view.taskTitle}`}>
                  <div className="task-timeline-card-top"><span className="task-timeline-action">{view.action}</span><time dateTime={event.occurredAt}>{view.time}</time></div>
                  <strong>{view.taskTitle}</strong>
                  <div className="task-timeline-card-meta"><span>{view.actor}</span>{view.detail ? <i>{view.detail}</i> : null}</div>
                </article>
              </li>
            ))}
          </ol>
          {error ? <p className="task-timeline-inline-error" role="status">{error}</p> : null}
          {hasMore ? <button className="task-timeline-load-more" type="button" onClick={() => void load(true)} disabled={loadingMore}>{loadingMore ? "正在加载…" : "加载更多操作"}</button> : null}
        </>
      )}
    </div>
  );
}
