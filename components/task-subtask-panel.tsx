"use client";

import { Check, CircleDashed, LoaderCircle, Plus, RotateCcw, Trash2 } from "lucide-react";
import { FormEvent, useCallback, useState } from "react";
import { api, type PackageSubtask, type WorkspaceTask as Task } from "@/components/workspace-client";

type SubtaskListResult = { packageId: string; subtasks: PackageSubtask[]; progress: { done: number; total: number } };
type SubtaskUpdateResult = { subtask: PackageSubtask; progress: { done: number; total: number } };

function renderEvidence(value: string, key: number) {
  return <code key={key}>{value}</code>;
}

export function TaskSubtaskPanel({ task, editable, resolveName, onChanged, onNotice, onAskAgent }: {
  task: Task;
  /** 当前用户对这条子任务可勾选/新增/删除（负责人或发布人且任务未进入验收锁定期）。 */
  editable: boolean;
  resolveName: (id?: string) => string;
  onChanged: () => void;
  onNotice: (message: string) => void;
  onAskAgent: (instruction: string) => void;
}) {
  const [items, setItems] = useState<PackageSubtask[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<SubtaskListResult>(`/api/v1/task-command/packages/${task.id}/subtasks`, { cache: "no-store" });
      setItems(data.subtasks);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "子任务加载失败"); }
    finally { setLoading(false); }
  }, [task.id, onNotice]);

  async function toggle(subtask: PackageSubtask) {
    if (!editable || busyId) return;
    setBusyId(subtask.id);
    try {
      const result = await api<SubtaskUpdateResult>(`/api/v1/task-command/packages/${task.id}/subtasks/${subtask.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: subtask.version, done: subtask.status !== "done" }),
      });
      setItems((current) => current?.map((item) => item.id === subtask.id ? result.subtask : item) ?? null);
      onChanged();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "更新子任务失败"); }
    finally { setBusyId(""); }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!editable || busyId) return;
    const title = draft.trim();
    if (title.length < 2) { onNotice("子任务至少需要 2 个字"); return; }
    setBusyId("new");
    try {
      const result = await api<{ subtask: PackageSubtask }>(`/api/v1/task-command/packages/${task.id}/subtasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setItems((current) => [...(current ?? []), result.subtask]);
      setDraft("");
      onChanged();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "新增子任务失败"); }
    finally { setBusyId(""); }
  }

  async function remove(subtask: PackageSubtask) {
    if (!editable || busyId) return;
    setBusyId(subtask.id);
    try {
      await api<{ deletedSubtaskId: string }>(`/api/v1/task-command/packages/${task.id}/subtasks/${subtask.id}?expectedVersion=${subtask.version}`, { method: "DELETE" });
      setItems((current) => current?.filter((item) => item.id !== subtask.id) ?? null);
      setConfirmDeleteId("");
      onChanged();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "删除子任务失败"); }
    finally { setBusyId(""); }
  }

  const askAgentDraft = () => onAskAgent(`请为任务「${task.title}」（ID ${task.id}）起草子任务勾选建议：先调用 work.list_package_subtasks 查看当前子任务清单，再对照任务要求逐条建议哪些可以勾选完成（调用 work.update_package_subtask，每条生成待我确认的提案），或建议还需要补充哪些子任务。不要直接推进任务状态。`);

  return <section className={`task-subtask-panel${editable ? " is-editable" : ""}`}>
    <details onToggle={(event) => { if (event.currentTarget.open && items === null) void load(); }}>
      <summary><Check size={12} />子任务{items?.length ? ` · ${items.filter((item) => item.status === "done").length}/${items.length}` : task.progress && task.progress.total > 0 ? ` · ${task.progress.done}/${task.progress.total}` : ""}{loading ? <LoaderCircle className="spin" size={11} /> : null}</summary>
      {items === null && loading ? <p className="task-subtask-hint"><LoaderCircle className="spin" size={10} />正在加载子任务…</p> : null}
      {items !== null && !items.length ? <p className="task-subtask-hint">还没有子任务。</p> : null}
      {items?.length ? <ol className="task-subtask-list">
        {items.map((subtask) => <li className={`is-${subtask.status}`} key={subtask.id}>
          <button type="button" className="task-subtask-toggle" aria-label={subtask.status === "done" ? "重新打开" : "标为完成"} disabled={!editable || busyId === subtask.id || busyId === "new"} onClick={() => void toggle(subtask)}>
            {subtask.status === "done" ? <Check size={12} /> : busyId === subtask.id ? <LoaderCircle className="spin" size={12} /> : <CircleDashed size={12} />}
          </button>
          <span className="task-subtask-title">{subtask.title}</span>
          {subtask.doneNote ? <p className="task-subtask-note">{subtask.doneNote}</p> : null}
          {subtask.evidenceRefs.length ? <p className="task-subtask-evidence">{subtask.evidenceRefs.map((value, index) => renderEvidence(value, index))}</p> : null}
          <small className="task-subtask-meta">{subtask.status === "done" && subtask.doneBy ? `由 ${resolveName(subtask.doneBy)} 完成` : "待办"}{subtask.createdBy && subtask.createdBy !== subtask.doneBy ? ` · 拆分：${resolveName(subtask.createdBy)}` : ""}</small>
          {editable ? <button type="button" className={`task-subtask-delete${confirmDeleteId === subtask.id ? " is-armed" : ""}`} disabled={busyId === subtask.id} onClick={() => { if (confirmDeleteId === subtask.id) void remove(subtask); else setConfirmDeleteId(subtask.id); }}>{confirmDeleteId === subtask.id ? "确认删除？" : <Trash2 size={11} />}</button> : null}
        </li>)}
      </ol> : null}
      {editable ? <form className="task-subtask-add" onSubmit={add}>
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="新增子任务，例如：完成登录页验收" maxLength={160} disabled={busyId === "new"} />
        <button type="submit" disabled={busyId === "new" || !draft.trim()}>{busyId === "new" ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}添加</button>
      </form> : null}
    </details>
    {editable ? <button type="button" className="task-subtask-ai" onClick={askAgentDraft}><RotateCcw size={11} />让 Agent 起草勾选建议</button> : null}
  </section>;
}
