"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Bot, CheckCircle2, Clock3, MessageSquareText, ShieldCheck, Users } from "lucide-react";

type Meeting = {
  id: string; title: string; status: string; outcomeStatus: string; version: number; startsAt?: string;
  confirmedByIds: string[]; requiredConfirmerIds: string[];
  draftMinutes: { discussions: string[]; conclusions: string[]; decisions: Array<{ topic: string; selectedOption: string; rationale: string; actionItems: Array<{ title: string; dueAt: string }> }>; openQuestions: string[] };
};
type Workspace = { meetings: Meeting[] };
type AssistantResult = { recommendations?: string[]; findings?: string[]; agenda?: string[]; evidenceGaps?: string[]; citations: Array<{ id: string; title: string; documentVersion: number }>; stateChanged: false };

/**
 * 会议纪要（E-162 从"治理工作台"拆出的独立页面）。
 *
 * 与审批页的区别：这里只做"讨论 → AI 纪要 → 参会人确认 → 决定与行动项沉淀"这条链路，
 * 审批与文件库分别是「智能审批」和「企业信息库」两页。
 */
export function MeetingCenterView({ onNotice }: { onNotice: (message: string) => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [assistant, setAssistant] = useState<AssistantResult | null>(null);
  const [selectedId, setSelectedId] = useState("");

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/governance/workspace", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "会议数据加载失败");
      setWorkspace(payload.data);
    } catch (error) { onNotice(error instanceof Error ? error.message : "会议数据加载失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/governance/workspace", { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error?.message || "会议数据加载失败");
        if (active) setWorkspace(payload.data);
      })
      .catch((error) => { if (active) onNotice(error instanceof Error ? error.message : "会议数据加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const meetings = workspace?.meetings ?? [];
  const meeting = meetings.find(({ id }) => id === selectedId) ?? meetings[0];

  async function prepareMeeting() {
    if (!meeting) return;
    setWorking("meeting-prepare");
    try {
      const response = await fetch(`/api/v1/meetings/${meeting.id}/prepare`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "会议准备失败");
      setAssistant(payload.data);
      onNotice("会议准备包已生成，没有修改正式纪要");
    } catch (error) { onNotice(error instanceof Error ? error.message : "会议准备失败"); }
    finally { setWorking(""); }
  }

  async function confirmMeeting() {
    if (!meeting) return;
    setWorking("meeting-confirm");
    try {
      const response = await fetch(`/api/v1/meetings/${meeting.id}/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: meeting.version }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "纪要确认失败");
      onNotice("纪要已确认，决定与行动项已幂等写回项目");
      await load();
    } catch (error) { onNotice(error instanceof Error ? error.message : "纪要确认失败"); }
    finally { setWorking(""); }
  }

  const pendingCount = meetings.filter(({ status }) => status === "pending_confirmation").length;

  return (
    <div className="governance-view governance-focus-meetings">
      <header className="governance-hero">
        <div><p className="eyebrow">MEETING TO DECISION</p><h1>会议纪要</h1><p>讨论不是决定：AI 起草纪要，参会人确认后，决定与行动项才幂等写回项目与任务。</p></div>
        <span className="governance-safety"><ShieldCheck size={15} /> 纪要确认前不改业务状态</span>
      </header>

      <section className="governance-metrics" aria-busy={loading}>
        <div><MessageSquareText size={17} /><span><strong>{pendingCount || (workspace ? 0 : "—")}</strong><small>待确认纪要</small></span></div>
        <div><CheckCircle2 size={17} /><span><strong>{meetings.filter(({ outcomeStatus }) => outcomeStatus === "materialized").length || (workspace ? 0 : "—")}</strong><small>已沉淀决定</small></span></div>
        <div><Users size={17} /><span><strong>{meeting ? meeting.requiredConfirmerIds.length : "—"}</strong><small>本次需确认人</small></span></div>
      </section>

      <div className="governance-columns">
        <div className="governance-main">
          <section className="governance-card meeting-workbench">
            <div className="governance-card-head"><div><span className="card-icon"><Users size={16} /></span><div><h2>会议确认闭环</h2><p>讨论不是决定，AI 纪要确认后才能沉淀</p></div></div>{meeting && <span className="status-pill">{meeting.status === "pending_confirmation" ? "待参会人确认" : meeting.status === "confirmed" ? "已确认" : meeting.status}</span>}</div>
            {meeting ? <div className="meeting-body">
              <div className="meeting-meta"><strong>{meeting.title}</strong><span><Clock3 size={12} />需 {meeting.requiredConfirmerIds.length} 人确认 · 已确认 {meeting.confirmedByIds.length}{meeting.startsAt ? ` · ${new Date(meeting.startsAt).toLocaleString("zh-CN")}` : ""}</span></div>
              <div className="minutes-grid">
                <div><span>讨论</span><p>{meeting.draftMinutes.discussions[0] ?? "—"}</p></div>
                <div><span>结论</span><p>{meeting.draftMinutes.conclusions[0] ?? "—"}</p></div>
                <div><span>决定</span><p>{meeting.draftMinutes.decisions[0] ? `${meeting.draftMinutes.decisions[0].topic}：${meeting.draftMinutes.decisions[0].selectedOption}` : "—"}</p></div>
                <div><span>行动</span><p>{meeting.draftMinutes.decisions[0]?.actionItems[0]?.title ?? "—"}</p></div>
              </div>
              {meeting.draftMinutes.openQuestions.length ? <ul className="library-policy-list">{meeting.draftMinutes.openQuestions.slice(0, 3).map((question) => <li key={question}><b>待确认</b><small>{question}</small></li>)}</ul> : null}
              <div className="workbench-actions">
                <button onClick={() => void prepareMeeting()} disabled={Boolean(working)}><Bot size={14} />{working === "meeting-prepare" ? "准备中…" : "准备会议依据"}</button>
                {meeting.status !== "confirmed"
                  ? <button className="decision-button" disabled={Boolean(working)} onClick={() => void confirmMeeting()}>确认纪要并沉淀 <ArrowRight size={13} /></button>
                  : <span className="completed-note"><CheckCircle2 size={14} />决定与行动已沉淀</span>}
              </div>
            </div> : <div className="governance-empty">暂无会议。会议由日历/渠道同步或 Agent 记录后进入这里等待参会人确认。</div>}
          </section>

          {assistant && <section className="assistant-review-card"><div><span><Bot size={15} /></span><div><strong>会议准备包</strong><small>{assistant.stateChanged === false ? "只读准备 · 未修改正式纪要" : ""}</small></div></div><ul>{[...(assistant.recommendations ?? []), ...(assistant.agenda ?? []), ...(assistant.evidenceGaps ?? []), ...(assistant.findings ?? [])].map((item) => <li key={item}>{item}</li>)}</ul>{assistant.citations.length > 0 && <div className="assistant-sources">{assistant.citations.map((citation) => <span key={citation.id}><ShieldCheck size={11} />{citation.title} · v{citation.documentVersion}</span>)}</div>}</section>}
        </div>

        <aside className="knowledge-rail">
          <section className="governance-card">
            <div className="governance-card-head"><div><span className="card-icon"><MessageSquareText size={16} /></span><div><h2>会议列表</h2><p>{meetings.length} 场</p></div></div></div>
            {meetings.length
              ? <div className="library-list">{meetings.map((item) => <button type="button" key={item.id} className={`library-row${item.id === meeting?.id ? " is-active" : ""}`} onClick={() => setSelectedId(item.id)}><div><strong>{item.title}</strong><small>{item.status === "pending_confirmation" ? "待确认" : item.status === "confirmed" ? "已确认" : item.status} · {item.outcomeStatus === "materialized" ? "决定已沉淀" : "尚未沉淀"}</small></div><ArrowRight size={13} /></button>)}</div>
              : <div className="governance-empty">暂无会议记录。</div>}
          </section>
        </aside>
      </div>
    </div>
  );
}
