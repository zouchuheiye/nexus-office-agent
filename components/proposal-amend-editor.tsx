"use client";

import { useMemo, useState } from "react";

/**
 * P2 可编辑预览卡：把 R3 提案的 tool input 渲染成可逐字段编辑的结构化卡片。
 * 标量/字符串数组字段直接用输入框；嵌套对象用 JSON 子编辑器，避免层级状态失控。
 * 只产出 JSON 文本，由调用方解析后走 amend（服务端仍会按工具 schema 重新解析）。
 */
export function ProposalAmendEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: string) => void;
}) {
  const [jsonError, setJsonError] = useState("");

  const parsed = useMemo(() => {
    if (typeof value === "string") {
      try {
        return { ok: true as const, data: JSON.parse(value) as unknown };
      } catch {
        return { ok: false as const };
      }
    }
    return { ok: true as const, data: value };
  }, [value]);

  if (!parsed.ok) {
    return <textarea className="work-dialog-textarea" value={typeof value === "string" ? value : ""} rows={10} onChange={(event) => { setJsonError(""); onChange(event.target.value); }} />;
  }

  const root = parsed.data;

  function updatePath(path: string[], next: unknown) {
    const source = typeof value === "string" ? root : value;
    const copy = structuredClone(source as Record<string, unknown>);
    let cursor = copy as Record<string, unknown>;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      const child = cursor[key];
      cursor[key] = child && typeof child === "object" && !Array.isArray(child) ? { ...(child as Record<string, unknown>) } : {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[path[path.length - 1]] = next;
    onChange(JSON.stringify(copy, null, 2));
  }

  function scalarEditor(path: string[], key: string, entry: unknown) {
    const isNumber = typeof entry === "number";
    const isBoolean = typeof entry === "boolean";
    const isDateLike = typeof entry === "string" && /^\d{4}-\d{2}-\d{2}/.test(entry) && /[TZ]/.test(entry);
    if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      return <label key={key}><span>{key}</span><textarea rows={Math.max(2, entry.length)} value={entry.join("\n")} onChange={(event) => updatePath(path, event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))} /></label>;
    }
    if (isDateLike) {
      return <label key={key}><span>{key}</span><input type="datetime-local" value={(entry as string).slice(0, 16)} onChange={(event) => { const iso = new Date(event.target.value).toISOString(); if (!Number.isNaN(Date.parse(event.target.value))) updatePath(path, iso); }} /></label>;
    }
    return <label key={key}><span>{key}</span><input type={isNumber ? "number" : isBoolean ? "checkbox" : "text"} checked={isBoolean ? Boolean(entry) : undefined} value={isBoolean ? undefined : String(entry)} onChange={(event) => updatePath(path, isNumber ? Number(event.target.value) : isBoolean ? event.target.checked : event.target.value)} /></label>;
  }

  function renderNode(path: string[], node: unknown): React.ReactNode {
    if (node === null || node === undefined) return null;
    if (typeof node === "object") {
      if (Array.isArray(node)) {
        if (node.every((item) => typeof item !== "object")) {
          return <label key={path.join(".") || "root"}><span>{path.at(-1) ?? "值"}</span><textarea rows={Math.max(2, node.length)} value={node.join("\n")} onChange={(event) => updatePath(path, event.target.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))} /></label>;
        }
        return <details className="work-dialog-json-sub" key={path.join(".") || "root"} open={path.length === 0}><summary>{path.at(-1) ?? "列表"} · {node.length} 项</summary><textarea rows={8} value={JSON.stringify(node, null, 2)} onChange={(event) => { setJsonError(""); try { const parsedJson = JSON.parse(event.target.value) as unknown; if (Array.isArray(parsedJson)) { updatePath(path, parsedJson); setJsonError(""); } else { setJsonError("此处需要 JSON 数组"); } } catch { setJsonError("JSON 语法有误，暂未保存"); } }} /></details>;
      }
      const entries = Object.entries(node as Record<string, unknown>);
      return <div className="work-dialog-json-group" key={path.join(".") || "root"}>{entries.map(([key, entry]) => (entry && typeof entry === "object"
        ? renderNode([...path, key], entry)
        : scalarEditor([...path, key], key, entry)))}</div>;
    }
    return scalarEditor(path, path.at(-1) ?? "值", node);
  }

  const rendered = renderNode([], root);
  return <div className="work-dialog-json-editor" data-error={jsonError || undefined}>{rendered}{jsonError ? <p className="work-dialog-json-error">{jsonError}</p> : null}</div>;
}
