"use client";

import { Check, LoaderCircle, Pencil, Plus, RotateCcw, Trash2, UserRoundPlus, Users } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";

type OrgUnit = { id: string; name: string };
type Position = { id: string; orgUnitId: string; name: string };
type Member = {
  id: string; displayName: string; email?: string; status: "invited" | "active" | "suspended" | "departed";
  version: number; orgUnitId?: string; orgUnitName?: string; positionId?: string; positionName?: string; isManager: boolean;
};
type Directory = { members: Member[]; orgUnits: OrgUnit[]; positions: Position[]; canManage: boolean };

const statusCopy: Record<Member["status"], string> = { invited: "待加入", active: "在职", suspended: "停用", departed: "已离职" };

function editorDefaults(member?: Member) {
  return { displayName: member?.displayName ?? "", email: member?.email ?? "", orgUnitId: member?.orgUnitId ?? "", positionId: member?.positionId ?? "", isManager: member?.isManager ?? false };
}

export function MemberDirectoryCard({ onNotice }: { onNotice: (message: string) => void }) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [draft, setDraft] = useState(editorDefaults());
  const [confirmRemove, setConfirmRemove] = useState("");
  const [reactivating, setReactivating] = useState<Member | null>(null);
  const [reactivateDraft, setReactivateDraft] = useState({ orgUnitId: "", positionId: "", isManager: false });

  const load = useCallback(async () => {
    try {
      // 先取在职目录（并得知自己是否管理员）；管理员再补取已停用名单——
      // 已停用/离职属于敏感人事信息，服务端只对管理员返回。
      const response = await fetch("/api/v1/organization/members", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "成员目录加载失败");
      let data = payload.data as Directory;
      if (data.canManage) {
        const withDeparted = await fetch("/api/v1/organization/members?includeDeparted=true", { cache: "no-store" });
        if (withDeparted.ok) data = (await withDeparted.json()).data as Directory;
      }
      setDirectory(data);
      setLoading(false);
    } catch (cause) {
      setLoading(false);
      // 403/无权限：静默隐藏卡片即可，不打断整页。
      if (cause instanceof Error && !cause.message.includes("无权")) onNotice(cause.message);
      setDirectory(null);
    }
  }, [onNotice]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch(() => undefined), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function openCreate() { setEditing(null); setDraft(editorDefaults()); setOpen(true); }
  function openEdit(member: Member) { setEditing(member); setDraft(editorDefaults(member)); setOpen(true); }
  function closeEditor() { setOpen(false); setEditing(null); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        displayName: draft.displayName.trim(),
        email: draft.email.trim() || undefined,
        orgUnitId: draft.orgUnitId || undefined,
        positionId: draft.positionId || undefined,
        isManager: draft.isManager,
      };
      const url = editing ? `/api/v1/organization/members/${editing.id}` : "/api/v1/organization/members";
      const body = editing ? { ...payload, expectedVersion: editing.version } : payload;
      const response = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "保存成员失败");
      onNotice(editing ? "成员资料已更新" : "已新增成员");
      closeEditor();
      await load();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function remove(member: Member) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/organization/members/${member.id}?expectedVersion=${member.version}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "停用成员失败");
      onNotice(`已停用 ${member.displayName}（保留历史与审计，不物理删除）`);
      setConfirmRemove("");
      await load();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "停用失败"); }
    finally { setBusy(false); }
  }

  async function reactivate(event: FormEvent) {
    event.preventDefault();
    const member = reactivating;
    if (!member || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/organization/members/${member.id}/reactivate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: member.version,
          orgUnitId: reactivateDraft.orgUnitId || undefined,
          positionId: reactivateDraft.positionId || undefined,
          isManager: reactivateDraft.isManager,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "重新启用失败");
      onNotice(`已重新启用 ${member.displayName}（恢复在职与任职；角色授权/设备需另行授予或重新登录）`);
      setReactivating(null);
      await load();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : "重新启用失败"); }
    finally { setBusy(false); }
  }

  const activeMembers = directory?.members.filter((member) => member.status !== "departed") ?? [];
  const departedMembers = directory?.members.filter((member) => member.status === "departed") ?? [];
  const positionsInOrg = (orgUnitId: string) => directory?.positions.filter((position) => position.orgUnitId === orgUnitId) ?? [];

  return <section className="enterprise-card member-directory-card">
    <div className="enterprise-card-head">
      <div><span><Users size={16} /></span><div><h2>成员管理</h2><p>员工目录 · 新增/编辑/停用/重新启用即时生效并同步到任务与组织数据</p></div></div>
      {directory?.canManage ? <button type="button" className="member-add-button" onClick={openCreate}><UserRoundPlus size={14} />新增成员</button> : null}
    </div>
    {loading ? <div className="member-directory-loading"><LoaderCircle className="spin" size={15} />正在加载成员目录…</div> : !directory ? <p className="task-subtask-hint">成员目录不可用（需要组织成员查看权限）。</p> : (activeMembers.length === 0 && departedMembers.length === 0) ? <p className="task-subtask-hint">还没有在职成员，请先新增。</p> : (
      <div className="member-directory-table">
        <div className="member-directory-row member-directory-head"><span>成员</span><span>组织与岗位</span><span>状态</span>{directory.canManage ? <span>操作</span> : null}</div>
        {activeMembers.map((member) => <div className="member-directory-row" key={member.id}>
          <span><strong>{member.displayName}</strong><small>{member.email || "未设置邮箱"}{member.isManager ? " · 负责人" : ""}</small></span>
          <span><strong>{member.orgUnitName ?? "未分组织"}</strong><small>{member.positionName ?? "未设岗位"}</small></span>
          <span className={`member-status is-${member.status}`}>{statusCopy[member.status]}</span>
          {directory.canManage ? <span className="member-row-actions">
            <button type="button" aria-label={`编辑 ${member.displayName}`} onClick={() => openEdit(member)}><Pencil size={13} />编辑</button>
            <button type="button" className={`member-remove${confirmRemove === member.id ? " is-armed" : ""}`} aria-label={`停用 ${member.displayName}`} disabled={busy} onClick={() => { if (confirmRemove === member.id) void remove(member); else setConfirmRemove(member.id); }}>{confirmRemove === member.id ? "确认停用？" : <Trash2 size={13} />}</button>
          </span> : null}
        </div>)}
        {departedMembers.length ? <>
          <div className="member-directory-row member-directory-head member-directory-departed-head"><span>已停用成员 · {departedMembers.length}</span><span>停用后不能进入枢纽 Agent</span><span>状态</span>{directory.canManage ? <span>操作</span> : null}</div>
          {departedMembers.map((member) => <div className="member-directory-row is-departed" key={member.id}>
            <span><strong>{member.displayName}</strong><small>{member.email || "未设置邮箱"}</small></span>
            <span><strong>留空则沿用停用前任职</strong><small>恢复后可重新分配部门与岗位</small></span>
            <span className={`member-status is-${member.status}`}>{statusCopy[member.status]}</span>
            {directory.canManage ? <span className="member-row-actions">
              <button type="button" aria-label={`重新启用 ${member.displayName}`} disabled={busy} onClick={() => { setReactivating(member); setReactivateDraft({ orgUnitId: "", positionId: "", isManager: false }); }}><RotateCcw size={13} />重新启用</button>
            </span> : null}
          </div>)}
        </> : null}
      </div>
    )}
    <p className="member-directory-note"><Check size={12} />停用为软删除：仅结束现行任职并标记离职，历史任务与审计链保留；无法停用仍有进行中任务的成员。重新启用只恢复在职与任职，停用时收回的角色授权、设备与外部身份需另行授予或重新登录。</p>

    {reactivating ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog work-dialog-compact" role="dialog" aria-modal="true" aria-labelledby="member-reactivate-title">
      <header><div><h2 id="member-reactivate-title">重新启用「{reactivating.displayName}」</h2><p>恢复在职与任职；不自动恢复角色授权、设备与外部身份</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setReactivating(null)}>×</button></header>
      <form onSubmit={reactivate} className="member-editor-form">
        <label>所在部门<select value={reactivateDraft.orgUnitId} onChange={(event) => setReactivateDraft((current) => ({ ...current, orgUnitId: event.target.value, positionId: "" }))}><option value="">沿用停用前的部门</option>{directory?.orgUnits.map((unit) => <option value={unit.id} key={unit.id}>{unit.name}</option>)}</select></label>
        <label>岗位（限本部门）<select value={reactivateDraft.positionId} onChange={(event) => setReactivateDraft((current) => ({ ...current, positionId: event.target.value }))} disabled={!reactivateDraft.orgUnitId}><option value="">沿用停用前的岗位</option>{positionsInOrg(reactivateDraft.orgUnitId).map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
        <label className="member-checkbox"><input type="checkbox" checked={reactivateDraft.isManager} onChange={(event) => setReactivateDraft((current) => ({ ...current, isManager: event.target.checked }))} />恢复为所在部门负责人</label>
        <footer><button type="button" onClick={() => setReactivating(null)}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}确认重新启用</button></footer>
      </form>
    </section></div> : null}

    {open ? <div className="work-dialog-backdrop" role="presentation"><section className="work-dialog work-dialog-compact" role="dialog" aria-modal="true" aria-labelledby="member-editor-title">
      <header><div><h2 id="member-editor-title">{editing ? "编辑成员" : "新增成员"}</h2><p>{editing ? editing.displayName : "姓名、邮箱、组织与岗位"}</p></div><button type="button" className="icon-button" aria-label="关闭" onClick={closeEditor}>×</button></header>
      <form onSubmit={submit} className="member-editor-form">
        <label>姓名 *<input value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} minLength={1} maxLength={80} required autoFocus placeholder="入职登记只需姓名，部门与岗位可留空" /></label>
        <label>邮箱（可选）<input type="email" value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} placeholder="name@company.test" /></label>
        <label>所在部门<select value={draft.orgUnitId} onChange={(event) => { setDraft((current) => ({ ...current, orgUnitId: event.target.value, positionId: "" })); }}><option value="">未分组织</option>{directory?.orgUnits.map((unit) => <option value={unit.id} key={unit.id}>{unit.name}</option>)}</select></label>
        <label>岗位（限本部门）<select value={draft.positionId} onChange={(event) => setDraft((current) => ({ ...current, positionId: event.target.value }))} disabled={!draft.orgUnitId}><option value="">未设岗位</option>{positionsInOrg(draft.orgUnitId).map((position) => <option value={position.id} key={position.id}>{position.name}</option>)}</select></label>
        <label className="member-checkbox"><input type="checkbox" checked={draft.isManager} onChange={(event) => setDraft((current) => ({ ...current, isManager: event.target.checked }))} />该成员是所在部门负责人</label>
        <footer><button type="button" onClick={closeEditor}>取消</button><button type="submit" className="primary" disabled={busy || draft.displayName.trim().length < 1}>{busy ? <LoaderCircle className="spin" size={13} /> : <Plus size={13} />}{editing ? "保存修改" : "确认新增"}</button></footer>
      </form>
    </section></div> : null}
  </section>;
}
