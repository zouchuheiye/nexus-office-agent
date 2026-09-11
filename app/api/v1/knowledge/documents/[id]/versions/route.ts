import { NextResponse } from "next/server";
import { splitList } from "@/src/modules/knowledge/application/file-schemas";
import { parseFileUpload } from "@/src/modules/knowledge/application/file-upload";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/**
 * 给已有文件型条目追加新版本（E-161）：换一版协议/更新标准时保留历史版本与替代关系。
 * 只有条目 Owner（或 `document:admin`）能追加；密级与适用范围按本次请求覆盖。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) throw new Error("DOCUMENT_UPLOAD_REQUIRES_MULTIPART");
    const upload = await parseFileUpload(request);
    const data = await getGovernanceRuntime().knowledge.publishFile(context, {
      documentId: id,
      title: upload.metadata.title,
      category: upload.metadata.category,
      classification: upload.metadata.classification,
      summary: upload.metadata.summary,
      agentIndexingAllowed: upload.metadata.agentIndexingAllowed,
      sourceRef: upload.metadata.sourceRef,
      effectiveAt: upload.metadata.effectiveAt,
      expiresAt: upload.metadata.expiresAt,
      allowedUserIds: splitList(upload.metadata.allowedUserIds),
      allowedRoleCodes: splitList(upload.metadata.allowedRoleCodes),
      projectIds: splitList(upload.metadata.projectIds),
      allowedOrgUnitIds: splitList(upload.metadata.allowedOrgUnitIds),
      allowedPositionNames: splitList(upload.metadata.allowedPositionNames),
      fileName: upload.fileName,
      mediaType: upload.mediaType,
      bytes: upload.bytes,
    });
    return NextResponse.json({
      data: { document: data.document, version: { ...data.version, content: undefined } },
      meta: { traceId: context.traceId },
    }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
