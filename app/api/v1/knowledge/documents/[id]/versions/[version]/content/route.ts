import { resolveActorApplicability } from "@/src/modules/knowledge/application/actor-applicability";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/** RFC 5987 文件名：中文文件名不能直接塞进 header。 */
function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 下载文件型条目的某一版（E-161）。默认取当前版本；`?version=N` 取历史版本，`?inline=1` 用于预览。
 * 权限与检索共用同一套判定（密级 + 本人/白名单/角色/项目/部门/岗位），越权与不存在都返回 404。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; version: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id, version } = await params;
    const numericVersion = Number(version);
    if (!Number.isInteger(numericVersion) || numericVersion <= 0) throw new Error("DOCUMENT_VERSION_INVALID");
    const actor = await resolveActorApplicability(context);
    const file = await getGovernanceRuntime().knowledge.downloadFile(context, id, { version: numericVersion, actor });
    const inline = new URL(request.url).searchParams.get("inline") === "1";
    return new Response(file.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": file.mediaType,
        "content-length": String(file.sizeBytes),
        "content-disposition": contentDisposition(file.fileName, inline),
        "x-content-digest": file.contentDigest,
        // 企业文件不进中间缓存：每次下载都重新过一遍权限。
        "cache-control": "private, no-store",
      },
    });
  } catch (error) { return applicationErrorResponse(error); }
}
