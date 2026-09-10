/**
 * P5：Agent 运行的真实阶段进度。
 *
 * 只描述"服务端真的走到了哪一步"，不预测、不编造百分比：
 * 分类 → 取授权事实 → 逐轮模型推理 → 逐个工具执行（开始/结束）→ 整理回答。
 * 文案由服务端生成，保证 HTTP/SSE 与不同客户端口径一致，也便于测试断言。
 */
export type AgentStageName = "classification" | "context" | "thinking" | "tool" | "answer";

export type AgentStageEvent = {
  stage: AgentStageName;
  /** 面向用户的人话说明（不暴露 R2/R3、工具 ID 或内部枚举）。 */
  label: string;
  /** 模型推理轮次（stage=thinking 时有值）。 */
  round?: number;
  /** 工具阶段：工具 ID 与它所属 Skill 的标题（用于运维核对，客户端可只显示 label）。 */
  toolId?: string;
  skillTitle?: string;
  phase?: "started" | "finished";
  /** 事件产生时间，供客户端计算"已经等了多久"。 */
  at: string;
};

type StageInput = Omit<AgentStageEvent, "at">;

/** 服务端统一生成阶段事件（含时间戳），保证 label 文案只有一处定义。 */
export function createAgentStage(input: StageInput): AgentStageEvent {
  return { ...input, at: new Date().toISOString() };
}
