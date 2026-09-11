import { NextResponse } from "next/server";
import { channelPreferenceInputSchema } from "@/src/modules/integration/application/channel-preferences";
import { getChannelPreferenceService } from "@/src/modules/integration/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse, parseJson } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";

/** 读取**本人**的通知通道偏好（默认值表示只走站内，外部通道未被开启）。 */
export async function GET(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const data = await getChannelPreferenceService().get(context);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}

/** 覆盖写入本人偏好。通道顺序同时是 opt-in 名单；不填 `quietHours` 表示保持原值。 */
export async function PUT(request: Request) {
  try {
    const context = await resolveRequestContext(request);
    const input = channelPreferenceInputSchema.parse(await parseJson(request));
    const data = await getChannelPreferenceService().update(context, input);
    return NextResponse.json({ data, meta: { traceId: context.traceId } });
  } catch (error) { return applicationErrorResponse(error); }
}
