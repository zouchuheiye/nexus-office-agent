import { z } from "zod";
import type { ModelGateway } from "@/src/modules/agent/domain/model-gateway";
import type { RequestContext } from "@/src/platform/context/request-context";

/**
 * P5：把会议纪要/口头安排这类"一段自然语言"拆成可发布的任务包草稿。
 *
 * 边界（与本平台其它 AI 能力一致）：
 * - 只产草稿，不落库、不发布、不授予任何权限；发布仍走 `POST /task-command/missions` 的同一套校验。
 * - 不允许编造人员 ID：模型只允许给"姓名提示"，真实 assigneeId 由页面按名册解析，解析不到就留待补充。
 * - 时间必须过 E-152 的发布闸门（截止晚于现在、晚于开始），模型给过去时间就丢弃并标记待补充。
 * - 模型不可用或返回不可解析时，退化为"按文本行拆候选"，每条字段待补充，功能不会因此不可用。
 */

const priority = z.enum(["critical", "high", "medium", "low"]);

function hasPermission(context: RequestContext, permission: string): boolean {
  const [resource, action] = permission.split(":");
  return context.permissions.some((value) => value === "*" || value === permission || value === `${resource}:*` || value === `*:${action}`);
}

function requirePermission(context: RequestContext, permission: string) {
  if (!hasPermission(context, permission)) throw new Error(`POLICY_DENIED:${permission}`);
}

const modelDraftSchema = z.object({
  title: z.string().trim().min(2).max(160),
  objective: z.string().trim().max(1200).optional(),
  packages: z.array(z.object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(1200).optional(),
    acceptanceCriteria: z.string().trim().max(800).optional(),
    requiredSkills: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
    assigneeName: z.string().trim().max(80).optional(),
    priority: priority.optional(),
    dueAt: z.string().trim().max(40).optional(),
    startedAt: z.string().trim().max(40).optional(),
    estimatedDays: z.number().int().min(1).max(365).optional(),
    capacityPoints: z.number().int().min(1).max(40).optional(),
  })).min(1).max(20),
}).strict();

export type DraftPackage = {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  requiredSkills: string[];
  assignmentMode: "direct" | "open_claim";
  assigneeName?: string;
  priority: "critical" | "high" | "medium" | "low";
  dueAt?: string;
  startedAt?: string;
  estimatedDays?: number;
  capacityPoints?: number;
  /** 仍然缺哪些字段（与正式发布同一套话术，发布时系统会继续标"待补充"）。 */
  missingFields: string[];
  /** 需要用户注意的点（例如模型给的截止时间已过期被丢弃）。 */
  warnings: string[];
};

export type TaskBundleDraft = {
  source: "model" | "fallback";
  title: string;
  objective?: string;
  packages: DraftPackage[];
  /** 给用户看的总体说明（例如"模型不可用，已按文本行拆候选"）。 */
  notes: string[];
  model?: { provider: string; model: string; latencyMs: number };
  generatedAt: string;
};

export const taskDraftInputSchema = z.object({
  text: z.string().trim().min(10, "纪要多于 10 个字才能拆分。").max(20_000),
  projectId: z.uuid().optional(),
}).strict();

export type TaskDraftInput = z.infer<typeof taskDraftInputSchema>;

const DRAFT_SYSTEM_PROMPT = `你是企业任务拆解助手。把用户给出的会议纪要/口头安排拆成可直接发布的任务包。
只输出 JSON：{"title":"使命标题","objective":"整体目标","packages":[{"title":"任务包标题","description":"任务说明","acceptanceCriteria":"验收标准","requiredSkills":["技能"],"assigneeName":"负责人姓名（仅当纪要里明确写了名字时）","priority":"critical|high|medium|low","dueAt":"ISO 时间（仅当纪要里明确写了时间时）","startedAt":"ISO 时间","estimatedDays":3,"capacityPoints":2}]}
硬性规则：
1. 只使用纪要里出现过的信息，绝不编造人名、时间、技能或验收标准；缺失就省略该字段。
2. 不要输出任何 ID（人员 ID、部门 ID、任务 ID）；负责人只写姓名。
3. 每条任务包必须可独立验收：写清产出与验收标准；拆得过多时优先合并成 3~8 条。
4. 时间必须是 ISO 8601 且晚于当前时间：${""}（以 currentTime 字段为准），过期时间一律省略。
5. 不要输出 JSON 以外任何文字。`;

function isFuture(iso: string | undefined, now: Date): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > now.getTime();
}

/** 按文本行拆候选：模型不可用时的确定性退化路径（字段全部待补充，由发布流程继续标）。 */
function fallbackPackages(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*·•]|\d+[.、)]|\([0-9]+\))\s*/, "").trim())
    .filter((line) => line.length >= 4 && line.length <= 160)
    .filter((line) => !/[：:]$/.test(line));
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
    if (unique.length >= 8) break;
  }
  return unique;
}

function missingFieldsOf(item: z.infer<typeof modelDraftSchema>["packages"][number]): string[] {
  const missing: string[] = [];
  if (!item.description?.trim()) missing.push("任务说明");
  if (!item.acceptanceCriteria?.trim()) missing.push("验收标准");
  if (!item.requiredSkills?.length) missing.push("所需技能");
  if (!item.priority) missing.push("优先级");
  if (!item.dueAt) missing.push("截止时间");
  if (!item.startedAt) missing.push("任务开始时间");
  if (!item.estimatedDays) missing.push("工期");
  if (!item.capacityPoints) missing.push("容量点");
  return missing;
}

export class TaskDraftService {
  constructor(private readonly model: ModelGateway) {}

  async draftFromMinutes(context: RequestContext, input: TaskDraftInput, now = new Date()): Promise<TaskBundleDraft> {
    requirePermission(context, "work_task:create");
    const text = input.text.trim();
    const fallback = (notes: string[]): TaskBundleDraft => ({
      source: "fallback",
      title: text.split(/\r?\n/).find((line) => line.trim().length >= 2)?.trim().slice(0, 160) || "待补充使命",
      objective: undefined,
      packages: fallbackPackages(text).map((title) => ({
        title, requiredSkills: [], assignmentMode: "open_claim" as const, priority: "medium" as const,
        missingFields: ["任务说明", "验收标准", "所需技能", "优先级", "截止时间", "任务开始时间", "工期", "容量点"],
        warnings: [],
      })),
      notes,
      generatedAt: now.toISOString(),
    });

    let parsed: z.infer<typeof modelDraftSchema>;
    let modelMeta: TaskBundleDraft["model"];
    try {
      const response = await this.model.complete({
        tenantId: context.tenantId,
        traceId: context.traceId,
        dataClassification: "internal",
        responseFormat: "json",
        messages: [
          { role: "system", content: `${DRAFT_SYSTEM_PROMPT}\ncurrentTime=${now.toISOString()}` },
          { role: "user", content: `<meeting_notes>\n${text}\n</meeting_notes>` },
        ],
      });
      modelMeta = { provider: response.provider, model: response.model, latencyMs: response.latencyMs };
      const jsonText = response.content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      parsed = modelDraftSchema.parse(JSON.parse(jsonText));
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":")[0] : "DRAFT_FAILED";
      const candidates = fallbackPackages(text);
      if (!candidates.length) throw new Error(`TASK_DRAFT_UNAVAILABLE:${code}`);
      return fallback([
        `模型当前不可用（${code}），已按纪要中的条目拆成 ${candidates.length} 条候选任务；请逐条确认后再发布。`,
        "字段缺失属于正常情况：发布后系统会继续把它们标成「待补充」。",
      ]);
    }

    const packages: DraftPackage[] = parsed.packages.map((item) => {
      const warnings: string[] = [];
      const dueAt = isFuture(item.dueAt, now) ? item.dueAt : undefined;
      if (item.dueAt && !dueAt) warnings.push("模型给出的截止时间已过期，已忽略，请重新指定。");
      // 开始时间允许在未来（"计划某天开始"），只要早于截止时间即可；与截止时间冲突时丢弃。
      const startedAt = item.startedAt && Number.isFinite(Date.parse(item.startedAt)) && (!dueAt || Date.parse(item.startedAt) < Date.parse(dueAt))
        ? item.startedAt
        : undefined;
      if (item.startedAt && !startedAt) warnings.push("模型给出的开始时间不早于截止时间，已忽略。");
      const normalized = { ...item, dueAt, startedAt, estimatedDays: item.estimatedDays, capacityPoints: item.capacityPoints };
      return {
        title: item.title,
        description: item.description,
        acceptanceCriteria: item.acceptanceCriteria,
        requiredSkills: item.requiredSkills ?? [],
        assignmentMode: item.assigneeName ? "direct" as const : "open_claim" as const,
        assigneeName: item.assigneeName,
        priority: item.priority ?? "medium",
        dueAt: normalized.dueAt,
        startedAt: normalized.startedAt,
        estimatedDays: item.estimatedDays,
        capacityPoints: item.capacityPoints,
        missingFields: missingFieldsOf({ ...item, dueAt: normalized.dueAt, startedAt: normalized.startedAt }),
        warnings,
      };
    });

    const notes: string[] = [];
    if (packages.some((item) => item.assigneeName)) notes.push("负责人姓名来自纪要原文，发布前请确认能对应到名册里的成员；对应不上会按待补充处理。");
    if (packages.some((item) => item.missingFields.length)) notes.push("带「待补充」的字段不会阻断发布，发布后可在任务卡里补齐。");

    return {
      source: "model",
      title: parsed.title,
      objective: parsed.objective,
      packages,
      notes,
      model: modelMeta,
      generatedAt: now.toISOString(),
    };
  }
}
