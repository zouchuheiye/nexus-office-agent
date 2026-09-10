import { ToolRegistry } from "@/src/modules/agent/domain/tool";
import { taskDraftInputSchema, type TaskDraftService } from "@/src/modules/agent/application/task-draft";

/** P5：把纪要拆成任务草稿的只读工具（不落库、不发布，发布仍由人确认后走正式接口）。 */
export function registerTaskDraftTools(registry: ToolRegistry, service: TaskDraftService) {
  registry.register({
    id: "work.draft_tasks_from_minutes",
    skillId: "work-orchestration",
    version: 1,
    description: "把会议纪要、口头安排或一段自然语言拆成可发布的任务包草稿：只返回结构化草稿（标题、任务说明、验收标准、所需技能、负责人姓名、时间），不落库、不发布、不授予权限。用户粘贴一段纪要并希望“拆成任务/生成任务清单”时先用本工具；拿到草稿后必须让用户确认，再用 work.publish_task_bundle 发布。不要编造人名、时间或人员 ID。",
    requiredPermissions: ["work_task:create"],
    riskLevel: 0,
    confirmationPolicy: "never",
    sideEffect: "none",
    timeoutMs: 30_000,
    maxAttempts: 1,
    allowedChannels: ["web", "feishu", "dingtalk", "wecom"],
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 10, description: "会议纪要或口头安排的原文" },
        projectId: { type: "string", format: "uuid", description: "可选：关联项目" },
      },
      required: ["text"],
    },
    inputSchema: taskDraftInputSchema,
    preview(input) { const value = taskDraftInputSchema.parse(input); return `按纪要拆出任务草稿（${value.text.length} 字），只生成草稿、不发布。`; },
    execute(context, input) { return service.draftFromMinutes(context, taskDraftInputSchema.parse(input)); },
  });
}
