import { NextResponse } from "next/server";
import { splitList } from "@/src/modules/knowledge/application/file-schemas";
import { parseFileUpload } from "@/src/modules/knowledge/application/file-upload";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/**
 * 上传一个**文件型**条目（E-161）：实习生协议、转正材料、标准规范这类企业文件的入口。
 *
 * `multipart/form-data`：`file` 字段是字节，其余字段是元数据（标题/类型/密级/适用范围/生效期…）。
 * 服务端统一做大小与 MIME 白名单校验、算 sha256、内容寻址落盘，然后与版本行一起落库。
 */
export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) throw new Error("DOCUMENT_UPLOAD_REQUIRES_MULTIPART");
    const upload = await parseFileUpload(request);
    const data = await getGovernanceRuntime().knowledge.publishFile(context, {
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
      data: {
        document: data.document, version: { ...data.version, content: undefined },
        itemCount: 0,
      },
      meta: { traceId: context.traceId },
    }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
