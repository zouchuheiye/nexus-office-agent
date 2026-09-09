import { NextResponse } from "next/server";
import { deactivateMemberSchema, updateMemberSchema } from "@/src/modules/organization/application/member-directory-schemas";
import { getMemberDirectoryService } from "@/src/modules/organization/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const input = updateMemberSchema.parse(await parseJson(request));
    const member = await getMemberDirectoryService().updateMember(context, id, input);
    return NextResponse.json({ data: { member }, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    const url = new URL(request.url);
    const expectedVersion = Number(url.searchParams.get("expectedVersion") ?? "0");
    const input = deactivateMemberSchema.parse({ expectedVersion });
    const result = await getMemberDirectoryService().deactivateMember(context, id, input);
    return NextResponse.json({ data: result, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
