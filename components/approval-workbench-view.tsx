"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Bot, CheckCircle2, FileCheck2, GitBranch, LockKeyhole, ShieldCheck } from "lucide-react";

type Approval = { id: string; instanceId: string; dueAt: string; version: number; status: string };
type Instance = { id: string; definitionId: string; title: string; definitionVersion: number; status: string; riskLevel: number; formSnapshot: Record<string, unknown>; version: number };
type Definition = { id: string; name: string; currentVersion: number; status: string };
type Workspace = { workflow: { definitions: Definition[]; instances: Instance[]; pendingApprovals: Approval[] } };
type AssistantResult = { recommendation?: string; findings?: string[]; agenda?: string[]; evidenceGaps?: string[]; citations: Array<{ id: string; title: string; documentVersion: number }>; stateChanged: false };

/**
 * 智能审批（E-162 从"治理工作台"拆出的独立页面）。
 *
 * 拆分原因：此前「智能审批」和「知识与会议」渲染的是同一个组件、只换一行标题，
 * 用户点进去看到的是同一份内容。现在审批页只承载审批工作台与流程实例，
 * 会议与知识/文件各自独立成页（见 `meeting-center-view.tsx`、`library-center-view.tsx`）。
 */
export function ApprovalWorkbenchView({ onNotice }: { onNotice: (message: string) => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [assistant, setAssistant] = useState<AssistantResult | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/governance/workspace", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "审批工作台加载失败");
      setWorkspace(payload.data);
    } catch (error) { onNotice(error instanceof Error ? error.message : "审批工作台加载失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/governance/workspace", { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error?.message || "审批工作台加载失败");
        if (active) setWorkspace(payload.data);
      })
      .catch((error) => { if (active) onNotice(error instanceof Error ? error.message : "审批工作台加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = workspace?.workflow.pendingApprovals[0];
  const instance = workspace?.workflow.instances.find(({ id }) => id === pending?.instanceId) ?? workspace?.workflow.instances[0];
  const definition = workspace?.workflow.definitions.find(({ id }) => id === instance?.definitionId) ?? workspace?.workflow.definitions[0];
  const running = workspace?.workflow.instances.filter(({ status }) => status === "running") ?? [];

  async function runPreReview() {
    if (!instance) return;
    setWorking("review");
    try {
      const response = await fetch(`/api/v1/workflows/process-instances/${instance.id}/pre-review`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "预审失败");
      setAssistant(payload.data);
      onNotice("Agent 只生成了预审意见，审批状态没有改变");
    } catch (error) { onNotice(error instanceof Error ? error.message : "预审失败"); }
    finally { setWorking(""); }
  }

  async function approve() {
    if (!pending) return;
    setWorking("approve");
    try {
      const response = await fetch(`/api/v1/workflows/approvals/${pending.id}/decide`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", comment: "已核对事实与职责分离", version: pending.version }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "审批失败");
      onNotice("审批已由当前责任人确认并写入审计链");
      await load();
    } catch (error) { onNotice(error instanceof Error ? error.message : "审批失败"); }
    finally { setWorking(""); }
  }

  return (
    <div className="governance-view governance-focus-approvals">
      <header className="governance-hero">
        <div><p className="eyebrow">APPROVAL WORKBENCH</p><h1>审批工作台</h1><p>权限来自岗位与策略，不来自按钮是否可见；运行中的流程锁定启动时的定义版本，AI 只做预审与材料准备。</p></div>
        <span className="governance-safety"><ShieldCheck size={15} /> 运行中流程锁定定义版本</span>
      </header>

      <section className="governance-metrics" aria-busy={loading}>
        <div><FileCheck2 size={17} /><span><strong>{workspace?.workflow.pendingApprovals.length ?? "—"}</strong><small>待我审批</small></span></div>
        <div><GitBranch size={17} /><span><strong>{running.length || (workspace ? 0 : "—")}</strong><small>运行中流程</small></span></div>
        <div><CheckCircle2 size={17} /><span><strong>{workspace?.workflow.definitions.length ?? "—"}</strong><small>已发布流程定义</small></span></div>
      </section>

      <div className="governance-columns">
        <div className="governance-main">
          <section className="governance-card approval-workbench">
            <div className="governance-card-head"><div><span className="card-icon"><FileCheck2 size={16} /></span><div><h2>待我审批</h2><p>职责分离由服务端强制：发起人不能自己批自己</p></div></div>{instance && <span className={`risk-badge risk-${instance.riskLevel}`}>R{instance.riskLevel} · 人工决定</span>}</div>
            {instance ? <>
              <div className="approval-title"><div><strong>{instance.title}</strong><span>{definition?.name ?? "版本化流程"} · 实例锁定 v{instance.definitionVersion} / 当前发布 v{definition?.currentVersion ?? instance.definitionVersion}</span></div><span className="status-pill">{instance.status === "running" ? "审批中" : instance.status === "approved" ? "已通过" : instance.status}</span></div>
              <div className="form-facts">{Object.entries(instance.formSnapshot).slice(0, 5).map(([key, value]) => <div key={key}><span>{key}</span><strong>{typeof value === "number" ? value.toLocaleString("zh-CN") : String(value)}</strong></div>)}</div>
              <div className="version-pin"><LockKeyhole size={14} /><span>本实例始终按启动时的 v{instance.definitionVersion} 执行；后续发布的新规则只影响新实例。</span></div>
              <div className="workbench-actions">
                <button onClick={() => void runPreReview()} disabled={working === "review"}><Bot size={14} />{working === "review" ? "分析中…" : "Agent 预审"}</button>
                {pending
                  ? <button className="decision-button" disabled={Boolean(working)} onClick={() => void approve()}>人工通过 <ArrowRight size={13} /></button>
                  : <span className="completed-note"><CheckCircle2 size={14} />当前审批已处理</span>}
              </div>
            </> : <div className="governance-empty">暂无审批实例。审批实例由流程定义发起（组织异动、基线变更、结项验收在「经营控制」页提交后进入这里）。</div>}
          </section>

          {assistant && <section className="assistant-review-card"><div><span><Bot size={15} /></span><div><strong>Agent 准备结果</strong><small>{assistant.stateChanged === false ? "只读分析 · 未改变业务状态" : ""}</small></div></div>{assistant.recommendation && <p className="recommendation">建议：{assistant.recommendation === "request_more_information" ? "补充材料后再决定" : "转人工复核"}</p>}<ul>{[...(assistant.findings ?? []), ...(assistant.evidenceGaps ?? []), ...(assistant.agenda ?? [])].map((item) => <li key={item}>{item}</li>)}</ul>{assistant.citations.length > 0 && <div className="assistant-sources">{assistant.citations.map((citation) => <span key={citation.id}><ShieldCheck size={11} />{citation.title} · v{citation.documentVersion}</span>)}</div>}</section>}

          <section className="governance-card">
            <div className="governance-card-head"><div><span className="card-icon"><GitBranch size={16} /></span><div><h2>运行中流程</h2><p>同一份定义版本 + 当前节点 + 风险等级</p></div></div></div>
            {running.length
              ? <div className="change-ledger">{running.map((item) => <div className="change-record" key={item.id}><div className="change-icon"><GitBranch size={16} /></div><div><span className="record-meta">{definitionsName(workspace, item.definitionId)} · v{item.definitionVersion} · R{item.riskLevel}</span><strong>{item.title}</strong><small>发起后按启动时的规则执行，发布新版本不影响本实例</small></div><span className={`record-status is-${item.status}`}>{item.status === "running" ? "审批中" : item.status}</span></div>)}</div>
              : <div className="governance-empty">当前没有运行中的流程实例。</div>}
          </section>
        </div>

        <aside className="knowledge-rail">
          <section className="governance-card">
            <div className="governance-card-head"><div><span className="card-icon"><ShieldCheck size={16} /></span><div><h2>审批纪律</h2><p>三条硬边界</p></div></div></div>
            <ul className="library-policy-list">
              <li><b>发起人不能自批</b><small>职责分离由服务端判定，不依赖按钮是否可见。</small></li>
              <li><b>AI 不改变审批状态</b><small>预审只准备意见与缺口，决定永远由人做。</small></li>
              <li><b>结论进审计链</b><small>每次决定写入不可改写审计，含决定人与理由。</small></li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function definitionsName(workspace: Workspace | null, definitionId: string): string {
  return workspace?.workflow.definitions.find(({ id }) => id === definitionId)?.name ?? "版本化流程";
}
