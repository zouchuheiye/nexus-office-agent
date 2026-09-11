"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, BookOpenText, Download, FilePlus2, FileText, LockKeyhole, Search, ShieldCheck, Upload } from "lucide-react";

type LibraryDocument = {
  id: string; title: string; kind: "text" | "file"; category: DocumentCategory; summary?: string;
  classification: string; status: string; currentVersion: number; ownerId: string;
  applicableTo: { orgUnits: number; positions: string[]; users: number; roles: string[] };
  agentIndexingAllowed: boolean;
};
type DocumentCategory = "policy" | "standard" | "agreement" | "contract" | "template" | "form" | "certificate" | "record" | "other";
type DocumentVersion = { version: number; effectiveAt: string; expiresAt?: string; publishedBy: string; publishedAt: string; sourceRef?: string; fileName?: string; mediaType?: string; sizeBytes?: number; contentDigest: string; supersedesVersion?: number };
type DocumentDetail = { document: LibraryDocument & { access: { allowedUserIds: string[]; allowedRoleCodes: string[]; allowedOrgUnitIds: string[]; allowedPositionNames: string[]; agentIndexingAllowed: boolean } }; accessBasis: string; versions: DocumentVersion[] };
type Citation = { id: string; title: string; excerpt: string; locator: string; documentVersion: number; classification: string; untrustedContent: true };
type DirectoryMember = { id: string; displayName: string; orgUnitId?: string; orgUnitName?: string; positionName?: string };
type Directory = { members: DirectoryMember[]; orgUnits: Array<{ id: string; name: string }>; positions: Array<{ id: string; name: string; orgUnitId: string }> };

const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  policy: "制度办法", standard: "标准规范", agreement: "协议", contract: "合同", template: "模板",
  form: "表单", certificate: "证照", record: "记录归档", other: "其他",
};
const CLASSIFICATION_LABELS: Record<string, string> = { public: "公开", internal: "内部", confidential: "机密", restricted: "受限" };
const CATEGORY_ORDER: DocumentCategory[] = ["policy", "standard", "agreement", "contract", "template", "form", "certificate", "record", "other"];

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 企业信息库（E-162）。
 *
 * 这是「企业的信息放在哪里」的界面入口：把协议、标准、表单、证照这类**文件**与制度文本放在同一处，
 * 统一带分类、密级、适用范围（人/角色/部门/岗位）、生效期与版本历史。
 * 此前的「知识与会议」页只有检索框与文档标题列表，没有上传入口、没有分类、没有适用范围，
 * 也没有独立页面（和「智能审批」共用同一个组件）。
 */
export function LibraryCenterView({ onNotice }: { onNotice: (message: string) => void }) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [category, setCategory] = useState<"" | DocumentCategory>("");
  const [keyword, setKeyword] = useState("");
  const [applicableOnly, setApplicableOnly] = useState(false);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);

  async function load(filters: { category?: string; keyword?: string; applicableOnly?: boolean } = {}) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const nextCategory = filters.category ?? category;
      const nextKeyword = filters.keyword ?? keyword;
      const nextApplicable = filters.applicableOnly ?? applicableOnly;
      if (nextCategory) params.set("category", nextCategory);
      if (nextKeyword.trim()) params.set("keyword", nextKeyword.trim());
      if (nextApplicable) params.set("applicableOnly", "true");
      const response = await fetch(`/api/v1/knowledge/documents?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "企业信息库加载失败");
      setDocuments(payload.data.documents);
    } catch (error) { onNotice(error instanceof Error ? error.message : "企业信息库加载失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/v1/knowledge/documents", { cache: "no-store" })
      .then(async (response) => ({ response, payload: await response.json() }))
      .then(({ response, payload }) => { if (!response.ok) throw new Error(payload.error?.message || "企业信息库加载失败"); if (active) setDocuments(payload.data.documents); })
      .catch((error) => { if (active) onNotice(error instanceof Error ? error.message : "企业信息库加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    // 适用范围的多选需要名册；拿不到就不显示这些选项（不影响上传与可见性判定）。
    void fetch("/api/v1/organization/members", { cache: "no-store" })
      .then(async (response) => response.ok ? (await response.json()).data : null)
      .then((data) => { if (active && data) setDirectory({ members: data.members ?? [], orgUnits: data.orgUnits ?? [], positions: data.positions ?? [] }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => CATEGORY_ORDER.map((item) => ({ category: item, items: documents.filter((document) => document.category === item) })).filter((group) => group.items.length), [documents]);

  async function openDetail(id: string) {
    setWorking(`detail-${id}`);
    try {
      const response = await fetch(`/api/v1/knowledge/documents/${id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "条目详情加载失败");
      setDetail(payload.data);
    } catch (error) { onNotice(error instanceof Error ? error.message : "条目详情加载失败"); }
    finally { setWorking(""); }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setWorking("upload");
    try {
      const response = await fetch("/api/v1/knowledge/documents/files", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "上传失败");
      onNotice(`已上传「${payload.data.document.title}」v${payload.data.document.currentVersion}`);
      setUploadOpen(false);
      await load();
    } catch (error) { onNotice(error instanceof Error ? error.message : "上传失败"); }
    finally { setWorking(""); }
  }

  async function publishText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      title: String(form.get("title") ?? ""),
      content: String(form.get("content") ?? ""),
      classification: String(form.get("classification") ?? "internal"),
      category: String(form.get("category") ?? "policy") as DocumentCategory,
      summary: String(form.get("summary") ?? "") || undefined,
      allowedPositionNames: splitList(String(form.get("allowedPositionNames") ?? "")),
      allowedRoleCodes: splitList(String(form.get("allowedRoleCodes") ?? "")),
      allowedUserIds: splitList(String(form.get("allowedUserIds") ?? "")),
      agentIndexingAllowed: form.get("agentIndexingAllowed") === "on",
    };
    setWorking("text");
    try {
      const response = await fetch("/api/v1/knowledge/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "发布失败");
      onNotice(`已发布文本条目，切分为 ${payload.data.itemCount} 个知识片段`);
      setTextOpen(false);
      await load();
    } catch (error) { onNotice(error instanceof Error ? error.message : "发布失败"); }
    finally { setWorking(""); }
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!keyword.trim()) return;
    setWorking("search");
    try {
      const response = await fetch(`/api/v1/knowledge/search?q=${encodeURIComponent(keyword)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "检索失败");
      setCitations(payload.data);
      if (!payload.data.length) onNotice("当前权限和有效版本内没有找到结果");
    } catch (error) { onNotice(error instanceof Error ? error.message : "检索失败"); }
    finally { setWorking(""); }
  }

  return (
    <div className="governance-view governance-focus-knowledge">
      <header className="governance-hero">
        <div><p className="eyebrow">ENTERPRISE LIBRARY</p><h1>企业信息库</h1><p>制度、标准、协议、合同、表单与证照都放在这里：统一分类、密级、适用范围、生效期与版本历史；文件字节存在企业自己的存储里。</p></div>
        <span className="governance-safety"><ShieldCheck size={15} /> 检索与下载都按密级与适用范围过滤</span>
      </header>

      <section className="governance-metrics" aria-busy={loading}>
        <div><BookOpenText size={17} /><span><strong>{documents.length || (loading ? "—" : 0)}</strong><small>可见条目</small></span></div>
        <div><FileText size={17} /><span><strong>{documents.filter((item) => item.kind === "file").length || (loading ? "—" : 0)}</strong><small>文件</small></span></div>
        <div><Upload size={17} /><span><strong>{documents.filter((item) => item.kind === "text").length || (loading ? "—" : 0)}</strong><small>文本知识</small></span></div>
        <div><LockKeyhole size={17} /><span><strong>{documents.filter((item) => ["confidential", "restricted"].includes(item.classification)).length || (loading ? "—" : 0)}</strong><small>机密及以上</small></span></div>
      </section>

      <div className="governance-columns">
        <div className="governance-main">
          <section className="governance-card library-card">
            <div className="governance-card-head">
              <div><span className="card-icon"><BookOpenText size={16} /></span><div><h2>信息库</h2><p>按分类浏览；点开看版本历史与适用范围</p></div></div>
              <div className="library-actions">
                <button type="button" className="library-primary" onClick={() => { setUploadOpen(true); setTextOpen(false); }}><FilePlus2 size={14} />上传文件</button>
                <button type="button" onClick={() => { setTextOpen(true); setUploadOpen(false); }}><FileText size={14} />发布文本</button>
              </div>
            </div>

            <div className="library-filters">
              <label><span>分类</span><select value={category} onChange={(event) => { const next = event.target.value as "" | DocumentCategory; setCategory(next); void load({ category: next }); }}><option value="">全部</option>{CATEGORY_ORDER.map((item) => <option key={item} value={item}>{CATEGORY_LABELS[item]}</option>)}</select></label>
              <label className="library-check"><input type="checkbox" checked={applicableOnly} onChange={(event) => { setApplicableOnly(event.target.checked); void load({ applicableOnly: event.target.checked }); }} /><span>只看对我适用的</span></label>
              <form className="library-keyword" onSubmit={search}><Search size={14} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="按标题或摘要筛选，回车同时做知识检索" /><button disabled={working === "search"}>检索</button></form>
            </div>

            {uploadOpen ? <form className="library-upload" onSubmit={upload}>
              <header><FilePlus2 size={15} /><div><strong>上传企业文件</strong><small>单文件 ≤ 25MB，支持 PDF/Office/图片/文本；字节按摘要存到企业存储</small></div></header>
              <label><span>文件</span><input type="file" name="file" required /></label>
              <label><span>标题</span><input name="title" required minLength={2} maxLength={180} placeholder="例如：实习生协议（2026 版）" /></label>
              <div className="library-form-pair">
                <label><span>分类</span><select name="category" defaultValue="agreement">{CATEGORY_ORDER.map((item) => <option key={item} value={item}>{CATEGORY_LABELS[item]}</option>)}</select></label>
                <label><span>密级</span><select name="classification" defaultValue="internal"><option value="public">公开</option><option value="internal">内部</option><option value="confidential">机密</option><option value="restricted">受限</option></select></label>
              </div>
              <label><span>摘要</span><input name="summary" maxLength={1000} placeholder="一句话说明它是什么、给谁看" /></label>
              <div className="library-form-pair">
                <label><span>生效时间</span><input type="datetime-local" name="effectiveAt" /></label>
                <label><span>失效时间</span><input type="datetime-local" name="expiresAt" /></label>
              </div>
              <label><span>适用岗位（逗号分隔）</span><input name="allowedPositionNames" list="library-positions" placeholder="例如：HRBP,招聘专员" /></label>
              <datalist id="library-positions">{directory?.positions.map((position) => <option key={position.id} value={position.name} />)}</datalist>
              <label><span>适用部门</span><select name="allowedOrgUnitIds" multiple size={Math.min(4, directory?.orgUnits.length ?? 1)}>{directory?.orgUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
              <label><span>指定可见成员</span><select name="allowedUserIds" multiple size={Math.min(4, directory?.members.length ?? 1)}>{directory?.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}{member.orgUnitName ? ` · ${member.orgUnitName}` : ""}</option>)}</select></label>
              <p className="library-hint">密级为「内部/公开」时全员可读；「机密/受限」必须命中上面任意一项（成员/部门/岗位/角色）才可见。</p>
              <footer><button type="button" onClick={() => setUploadOpen(false)}>取消</button><button type="submit" className="library-primary" disabled={working === "upload"}>{working === "upload" ? "上传中…" : "上传"}</button></footer>
            </form> : null}

            {textOpen ? <form className="library-upload" onSubmit={publishText}>
              <header><FileText size={15} /><div><strong>发布文本知识</strong><small>制度、标准条文这类纯文本会被切块，供 Agent 按权限检索</small></div></header>
              <label><span>标题</span><input name="title" required minLength={2} maxLength={180} /></label>
              <div className="library-form-pair">
                <label><span>分类</span><select name="category" defaultValue="policy">{CATEGORY_ORDER.map((item) => <option key={item} value={item}>{CATEGORY_LABELS[item]}</option>)}</select></label>
                <label><span>密级</span><select name="classification" defaultValue="internal"><option value="public">公开</option><option value="internal">内部</option><option value="confidential">机密</option><option value="restricted">受限</option></select></label>
              </div>
              <label><span>摘要</span><input name="summary" maxLength={1000} /></label>
              <label><span>正文</span><textarea name="content" rows={8} required placeholder="段落之间空一行，便于切块" /></label>
              <div className="library-form-pair">
                <label><span>适用岗位（逗号分隔）</span><input name="allowedPositionNames" /></label>
                <label><span>适用角色（逗号分隔）</span><input name="allowedRoleCodes" /></label>
              </div>
              <label className="library-check"><input type="checkbox" name="agentIndexingAllowed" defaultChecked /><span>允许 Agent 在权限范围内检索这段内容</span></label>
              <footer><button type="button" onClick={() => setTextOpen(false)}>取消</button><button type="submit" className="library-primary" disabled={working === "text"}>{working === "text" ? "发布中…" : "发布"}</button></footer>
            </form> : null}

            {!loading && !documents.length ? <div className="governance-empty">库里还没有你能看到的条目。点右上角「上传文件」放第一份企业文件（例如实习生协议），或用「发布文本」录入制度条文。</div> : null}

            {grouped.map((group) => <section className="library-group" key={group.category}>
              <h3>{CATEGORY_LABELS[group.category]}<b>{group.items.length}</b></h3>
              {group.items.map((document) => <article className="library-item" key={document.id}>
                <div className="library-item-main">
                  <div className="library-item-title">
                    <span className={`classification class-${document.classification}`}>{CLASSIFICATION_LABELS[document.classification] ?? document.classification}</span>
                    {document.kind === "file" ? <FileText size={13} /> : <BookOpenText size={13} />}
                    <strong>{document.title}</strong>
                    <small>v{document.currentVersion}</small>
                  </div>
                  {document.summary ? <p>{document.summary}</p> : null}
                  <div className="library-item-scope">
                    <span>适用：</span>
                    {document.applicableTo.users ? <em>{document.applicableTo.users} 位指定成员</em> : null}
                    {document.applicableTo.positions.map((position) => <em key={position}>{position}</em>)}
                    {document.applicableTo.orgUnits ? <em>{document.applicableTo.orgUnits} 个部门</em> : null}
                    {document.applicableTo.roles.map((role) => <em key={role}>{role}</em>)}
                    {!document.applicableTo.users && !document.applicableTo.positions.length && !document.applicableTo.orgUnits && !document.applicableTo.roles.length ? <em>按密级可见</em> : null}
                    {document.agentIndexingAllowed ? <em>Agent 可检索</em> : null}
                  </div>
                </div>
                <div className="library-item-actions">
                  {document.kind === "file" ? <a className="library-download" href={`/api/v1/knowledge/documents/${document.id}/versions/${document.currentVersion}/content`}><Download size={13} />下载</a> : null}
                  <button type="button" onClick={() => void openDetail(document.id)} disabled={working === `detail-${document.id}`}>{working === `detail-${document.id}` ? "加载中…" : "详情"}<ArrowRight size={13} /></button>
                </div>
              </article>)}
            </section>)}
          </section>

          {detail ? <section className="governance-card library-detail">
            <div className="governance-card-head"><div><span className="card-icon"><FileText size={16} /></span><div><h2>{detail.document.title}</h2><p>{CATEGORY_LABELS[detail.document.category]} · {CLASSIFICATION_LABELS[detail.document.classification]} · 可见依据：{accessBasisLabel(detail.accessBasis)}</p></div></div><button type="button" onClick={() => setDetail(null)}>关闭</button></div>
            {detail.document.summary ? <p className="library-detail-summary">{detail.document.summary}</p> : null}
            <div className="library-detail-scope">
              <div><span>指定成员</span><strong>{detail.document.access.allowedUserIds.length || "—"}</strong></div>
              <div><span>适用部门</span><strong>{detail.document.access.allowedOrgUnitIds.length || "—"}</strong></div>
              <div><span>适用岗位</span><strong>{detail.document.access.allowedPositionNames.join("、") || "—"}</strong></div>
              <div><span>适用角色</span><strong>{detail.document.access.allowedRoleCodes.join("、") || "—"}</strong></div>
            </div>
            <table className="library-versions">
              <thead><tr><th>版本</th><th>文件</th><th>大小</th><th>生效</th><th>失效</th><th>发布人</th><th></th></tr></thead>
              <tbody>{detail.versions.map((version) => <tr key={version.version}>
                <td>v{version.version}{version.supersedesVersion ? <small> 替代 v{version.supersedesVersion}</small> : null}</td>
                <td>{version.fileName ?? "文本条目"}</td>
                <td>{formatSize(version.sizeBytes) || "—"}</td>
                <td>{new Date(version.effectiveAt).toLocaleDateString("zh-CN")}</td>
                <td>{version.expiresAt ? new Date(version.expiresAt).toLocaleDateString("zh-CN") : "—"}</td>
                <td>{version.publishedBy.slice(0, 8)}…</td>
                <td>{version.fileName ? <a href={`/api/v1/knowledge/documents/${detail.document.id}/versions/${version.version}/content`}><Download size={12} />下载</a> : <span>—</span>}</td>
              </tr>)}</tbody>
            </table>
          </section> : null}
        </div>

        <aside className="knowledge-rail">
          <section className="governance-card knowledge-search-card">
            <div className="governance-card-head"><div><span className="card-icon"><Search size={16} /></span><div><h2>权限感知检索</h2><p>检索前过滤，返回前再次校验</p></div></div></div>
            <form onSubmit={search}><Search size={15} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索制度、标准或决定" /><button disabled={working === "search"}>检索</button></form>
            {citations.length > 0 && <div className="citation-results">{citations.map((citation) => <article key={citation.id}><div><span>[{citation.locator}]</span><b>{citation.title} · v{citation.documentVersion}</b></div><p>{citation.excerpt}</p><small><ShieldCheck size={11} />已通过权限、有效版本与二次过滤 · 外部文字按不可信数据处理</small></article>)}</div>}
          </section>
          <div className="knowledge-policy-note"><LockKeyhole size={16} /><div><strong>文件不进通用 RAG</strong><p>文件类条目只保存字节与元数据，不会被切块进 Agent 检索；机密/受限条目、过期或被替代版本默认不进入检索。</p></div></div>
        </aside>
      </div>
    </div>
  );
}

function accessBasisLabel(basis: string): string {
  return ({ owner: "本人负责", explicit_user: "指定成员", role: "角色", project: "项目", org_unit: "部门", position: "岗位", classification: "密级" } as Record<string, string>)[basis] ?? basis;
}

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean))];
}
