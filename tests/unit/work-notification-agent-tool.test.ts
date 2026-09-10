// Requirements: PR-009, PR-010, MR-046, MR-047, MR-048, AC-012, AC-013（P4：Agent 只读通知工具）
import { describe, expect, it } from "vitest";
import { registerTaskCommandTools } from "@/src/modules/task-command/application/agent-tools";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import {
  DEMO_DELIVERY_OWNER_ID,
  DEMO_PRODUCT_OWNER_ID,
  InMemoryTaskCommandRepository,
} from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { assertToolPolicy, ToolRegistry } from "@/src/modules/agent/domain/tool";
import { createDefaultSkillRegistry } from "@/src/modules/agent/domain/skill";
import { createDevelopmentRequestContext } from "@/src/platform/context/development-context";

const TOOL_ID = "work.list_my_notifications";

function setup() {
  const service = new TaskCommandService(new InMemoryTaskCommandRepository());
  const registry = new ToolRegistry();
  registerTaskCommandTools(registry, service);
  return { service, registry };
}

const manager = () => createDevelopmentRequestContext("notification-tools-manager");
const assignee = () => ({ ...createDevelopmentRequestContext("notification-tools-assignee"), actorId: DEMO_PRODUCT_OWNER_ID });
const outsider = () => ({ ...createDevelopmentRequestContext("notification-tools-outsider"), permissions: [] as string[] });

describe("P4 站内通知 Agent 工具", () => {
  it("注册为 work-orchestration 的只读工具，风险等级 0 且无需人工确认", () => {
    const { registry } = setup();
    expect(registry.list().map((item) => item.id)).toContain(TOOL_ID);
    expect(createDefaultSkillRegistry().forTool(TOOL_ID)?.id).toBe("work-orchestration");
    const registered = registry.list().find((item) => item.id === TOOL_ID)!;
    expect(registered).toMatchObject({ riskLevel: 0, confirmationPolicy: "never", sideEffect: "none", requiredPermissions: ["work_task:read"] });
    expect(registered.description).toContain("当前用户自己");
    const allowed = registry.available(manager()).find((item) => item.id === TOOL_ID)!;
    expect(assertToolPolicy(manager(), allowed)).toEqual({ requiresConfirmation: false });
    // 无 work_task:read 的身份看不到该工具
    expect(registry.available(outsider()).map((item) => item.id)).not.toContain(TOOL_ID);
  });

  it("只返回调用者自己的通知，并支持 unreadOnly 过滤", async () => {
    const { service, registry } = setup();
    const owner = manager();
    const conversation = (await service.workspace(owner)).conversation;
    const task = (await service.publishMission(owner, {
      conversationId: conversation.id,
      title: "通知工具验证",
      objective: "验证 Agent 通过工具只能读取自己的通知。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: "整理通知工具证据", description: "验证只读通知工具。", acceptanceCriteria: "只能看到自己的通知。", requiredSkills: ["交付"],
        assignmentMode: "direct", assigneeId: DEMO_PRODUCT_OWNER_ID, priority: "high", dueAt: "2030-08-30T10:00:00.000Z",
        startedAt: "2030-08-01T00:00:00.000Z", estimatedDays: 7, capacityPoints: 2,
      }],
    })).packages[0];
    const tool = registry.available(assignee()).find((item) => item.id === TOOL_ID)!;

    const all = await tool.execute(assignee(), {}) as { notifications: Array<{ kind: string; packageId: string }>; unreadCount: number };
    expect(all.notifications.filter((item) => item.packageId === task.id).map((item) => item.kind)).toEqual(["task_assigned"]);
    expect(all.unreadCount).toBeGreaterThanOrEqual(1);

    const unread = await tool.execute(assignee(), { unreadOnly: true, limit: 5 }) as { notifications: Array<{ packageId: string }> };
    expect(unread.notifications.every((item) => item.packageId === task.id)).toBe(true);

    // 另一个身份（非收件人）通过工具拿不到这条通知
    const otherTool = registry.available({ ...createDevelopmentRequestContext("notification-tools-other"), actorId: DEMO_DELIVERY_OWNER_ID }).find((item) => item.id === TOOL_ID)!;
    const other = await otherTool.execute({ ...createDevelopmentRequestContext("notification-tools-other"), actorId: DEMO_DELIVERY_OWNER_ID }, {}) as { notifications: Array<{ packageId: string }> };
    expect(other.notifications.filter((item) => item.packageId === task.id)).toEqual([]);

    expect(() => tool.execute(assignee(), { limit: 0 })).toThrow();
  });
});
