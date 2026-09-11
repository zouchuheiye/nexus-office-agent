import type { RequestContext } from "@/src/platform/context/request-context";
import type { ActorApplicability } from "@/src/modules/knowledge/application/service";

/**
 * 把"当前主体"解析成适用范围判据（部门 + 岗位名），供企业信息库的可见性判定使用。
 *
 * 方向说明：knowledge 只向 organization 要一个**只读、只查自己**的方法，不引入组织架构的写语义。
 * 解析失败（例如人事模块不可用、尚未建立任职）一律返回空判据 = 这两个维度不匹配（失败关闭），
 * 而不是放宽成"人人可见"；其他维度（本人/白名单/角色/项目/密级）不受影响。
 */
export async function resolveActorApplicability(context: RequestContext): Promise<ActorApplicability> {
  try {
    const { getMemberDirectoryService } = await import("@/src/modules/organization/runtime");
    return await getMemberDirectoryService().actorApplicability(context);
  } catch {
    return { orgUnitIds: [], positionNames: [] };
  }
}
