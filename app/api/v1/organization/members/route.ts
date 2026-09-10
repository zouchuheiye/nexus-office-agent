import { NextResponse } from "next/server";
import { createMemberSchema } from "@/src/modules/organization/application/member-directory-schemas";
import { getMemberDirectoryService } from "@/src/modules/organization/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    // includeDeparted=true 时连已停用成员一起返回，供“重新启用”入口使用。
    const includeDeparted = new URL(request.url).searchParams.get("includeDeparted") === "true";
    const data = await getMemberDirectoryService().list(context, { includeDeparted });
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = createMemberSchema.parse(await parseJson(request));
    const member = await getMemberDirectoryService().createMember(context, input);
    return NextResponse.json({ data: { member }, meta: { traceId: context.traceId } }, { status: 201 });
  } catch (error) { return applicationErrorResponse(error); }
}
