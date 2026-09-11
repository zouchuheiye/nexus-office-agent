import { NextResponse } from "next/server";
import { resolveActorApplicability } from "@/src/modules/knowledge/application/actor-applicability";
import { listLibraryQuerySchema } from "@/src/modules/knowledge/application/file-schemas";
import { publishDocumentSchema } from "@/src/modules/knowledge/application/schemas";
import { getGovernanceRuntime } from "@/src/modules/governance-workspace/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/**
 * 企业信息库列表（E-161）：只返回"当前主体读得到的已发布条目"，再按类型/关键字/适用范围过滤。
 * 过滤在服务端做，保证越权条目根本不出现在响应里（也不泄露数量）。
 */
export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const url = new URL(request.url);
    const query = listLibraryQuerySchema.parse({
      category: url.searchParams.get("category") ?? undefined,
      kind: url.searchParams.get("kind") ?? undefined,
      keyword: url.searchParams.get("keyword") ?? undefined,
      applicableOnly: url.searchParams.get("applicableOnly") ?? undefined,
    });
    const actor = await resolveActorApplicability(context);
    const documents = await getGovernanceRuntime().knowledge.listLibrary(context, {
      category: query.category, kind: query.kind, keyword: query.keyword,
      applicableOnly: query.applicableOnly === "true", actor,
    });
    return NextResponse.json({
      data: {
        documents: documents.map((document) => ({
          id: document.id, title: document.title, kind: document.kind, category: document.category,
          summary: document.summary, classification: document.classification, status: document.status,
          currentVersion: document.currentVersion, ownerId: document.ownerId,
          applicableTo: {
            orgUnits: document.access.allowedOrgUnitIds.length,
            positions: document.access.allowedPositionNames,
            users: document.access.allowedUserIds.length,
            roles: document.access.allowedRoleCodes,
          },
          agentIndexingAllowed: document.access.agentIndexingAllowed,
        })),
      },
      meta: { traceId: context.traceId, count: documents.length },
    });
  } catch (error) { return applicationErrorResponse(error); }
}

/** 发布/追加**文本型**知识条目（原有契约不变；文件型走 `/documents/files` 与 `/documents/:id/versions`）。 */
export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = publishDocumentSchema.parse(await parseJson(request));
    const data = await getGovernanceRuntime().knowledge.publish(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
