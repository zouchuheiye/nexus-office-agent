import { NextResponse } from "next/server";
import { reactivateMemberSchema } from "@/src/modules/organization/application/member-directory-schemas";
import { getMemberDirectoryService } from "@/src/modules/organization/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/**
 * 重新启用已停用/离职成员：恢复在职身份与任职。
 * 只恢复"能重新上班"（部门/岗位/负责人可用参数覆盖，留空则沿用停用前任职），
 * 停用时被收回的角色授权、委托、设备与外部身份不会自动恢复。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = reactivateMemberSchema.parse(await parseJson(request));
    const member = await getMemberDirectoryService().reactivateMember(context, id, input);
    return NextResponse.json({ data: { member }, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
