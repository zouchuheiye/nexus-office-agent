// Requirements: PR-009, PR-010, MR-046, MR-047, MR-048, MR-049, AR-011, AC-012, AC-013
import { describe, expect, it } from "vitest";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import {
  DEMO_DELIVERY_OWNER_ID,
  DEMO_PRODUCT_OWNER_ID,
  InMemoryTaskCommandRepository,
} from "@/src/modules/task-command/infrastructure/in-memory-repository";
import { createDevelopmentRequestContext, DEMO_MANAGER_ID } from "@/src/platform/context/development-context";

const FUTURE = "2030-08-18T10:00:00.000Z";

async function fixture() {
  const service = new TaskCommandService(new InMemoryTaskCommandRepository());
  const manager = createDevelopmentRequestContext("task-notification-manager");
  const member = { ...createDevelopmentRequestContext("task-notification-member"), actorId: DEMO_PRODUCT_OWNER_ID };
  const other = { ...createDevelopmentRequestContext("task-notification-other"), actorId: DEMO_DELIVERY_OWNER_ID };
  const conversation = (await service.workspace(manager)).conversation;
  return { service, manager, member, other, conversation };
}

/** 定向分派一个任务给 product 身份，返回任务包。 */
async function publishDirect(service: TaskCommandService, manager: ReturnType<typeof createDevelopmentRequestContext>, conversationId: string) {
  const result = await service.publishMission(manager, {
    conversationId,
    title: "客户验收闭环",
    objective: "完成客户验收并归档证据。",
    priority: "high",
    dueAt: FUTURE,
    packages: [{
      title: "整理验收证据",
      description: "汇总功能清单与测试结果。",
      acceptanceCriteria: "形成客户可签字的证据包。",
      requiredSkills: ["交付"],
      assignmentMode: "direct",
      assigneeId: DEMO_PRODUCT_OWNER_ID,
      priority: "high",
      dueAt: "2030-08-16T10:00:00.000Z",
      startedAt: "2030-08-01T00:00:00.000Z",
      estimatedDays: 7,
      capacityPoints: 3,
    }],
  });
  return result.packages[0];
}

describe("P4 站内通知", () => {
  it("定向分派只通知被分派人，且不通知操作人自己", async () => {
    const { service, manager, member, conversation } = await fixture();
    await publishDirect(service, manager, conversation.id);

    const assignee = await service.notifications(member, {});
    expect(assignee.notifications).toHaveLength(1);
    expect(assignee.unreadCount).toBe(1);
    expect(assignee.notifications[0]).toMatchObject({ kind: "task_assigned", recipientId: DEMO_PRODUCT_OWNER_ID, actorId: DEMO_MANAGER_ID, refType: "work_package" });
    expect(assignee.notifications[0].title).toContain("整理验收证据");
    expect(assignee.notifications[0].body).toContain("2030-08-16");
    expect(assignee.notifications[0].readAt).toBeUndefined();

    // 发布人自己不会收到"我给我自己派任务"的通知
    const publisher = await service.notifications(manager, {});
    expect(publisher.notifications).toEqual([]);
  });

  it("公开承接被他人领取时通知发布人，承接人自己承接不产生通知", async () => {
    const { service, manager, member, conversation } = await fixture();
    const published = await service.publishMission(manager, {
      conversationId: conversation.id,
      title: "值班巡检",
      objective: "完成本周值班巡检。",
      packages: [{
        title: "巡检机房",
        description: "按清单巡检并留痕。",
        acceptanceCriteria: "巡检记录完整。",
        requiredSkills: ["运营"],
        assignmentMode: "open_claim",
        priority: "medium",
        dueAt: FUTURE,
        startedAt: "2030-08-01T00:00:00.000Z",
        estimatedDays: 2,
        capacityPoints: 1,
      }],
    });
    const task = published.packages[0];
    await service.claimPackage(member, task.id, task.version);
    const publisherNotifications = await service.notifications(manager, {});
    expect(publisherNotifications.notifications.map((item) => item.kind)).toEqual(["task_claimed"]);
    expect(publisherNotifications.notifications[0].packageId).toBe(task.id);
    // 承接人自己不会收到"你承接了任务"的通知
    expect((await service.notifications(member, {})).notifications).toEqual([]);
  });

  it("交接发起、签收与撤回各自通知对手方", async () => {
    const { service, manager, member, other, conversation } = await fixture();
    const task = await publishDirect(service, manager, conversation.id);
    await service.transitionPackage(member, task.id, { expectedVersion: task.version, nextStatus: "in_progress" });

    const handoff = (await service.initiateTaskHandoff(member, {
      taskId: task.id,
      expectedVersion: task.version + 1,
      toAssigneeId: DEMO_DELIVERY_OWNER_ID,
      note: "客户临时改期，请接手后续联调。",
      currentProgress: "证据已整理 80%。",
      completedWork: "功能清单",
      pendingWork: "联调签字",
    })).handoff;
    const target = await service.notifications(other, { unreadOnly: true });
    expect(target.unreadCount).toBe(1);
    expect(target.notifications[0]).toMatchObject({ kind: "handoff_requested", refType: "work_handoff", refId: handoff.id });

    const pending = (await service.workspace(other)).pendingHandoffs.find((item) => item.handoff.id === handoff.id)!;
    await service.respondToTaskHandoff(other, handoff.id, { expectedVersion: pending.task.version, decision: "reject", responseNote: "手上还有两个交付，先退回。" });
    const initiator = await service.notifications(member, {});
    // 最新一条是交接退回；更早的 task_assigned 来自最初的分派
    expect(initiator.notifications.map((item) => item.kind)).toEqual(["handoff_responded", "task_assigned"]);
    expect(initiator.notifications[0].title).toContain("退回");
    expect(initiator.notifications[0].body).toContain("手上还有两个交付");
  });

  it("提交验收通知发布人，验收退回把原因带给承接人", async () => {
    const { service, manager, member, conversation } = await fixture();
    const task = await publishDirect(service, manager, conversation.id);
    const started = await service.transitionPackage(member, task.id, { expectedVersion: task.version, nextStatus: "in_progress" });
    const submitted = await service.transitionPackage(member, task.id, { expectedVersion: started.version, nextStatus: "in_review", evidenceRefs: ["https://example.test/evidence/1"] });

    const reviewer = await service.notifications(manager, {});
    expect(reviewer.notifications.map((item) => item.kind)).toEqual(["review_requested"]);
    expect(reviewer.notifications[0].title).toContain("待你验收");

    await service.transitionPackage(manager, task.id, { expectedVersion: submitted.version, nextStatus: "in_progress", reviewNote: "证据里缺少客户签字页。" });
    const assignee = await service.notifications(member, {});
    const decision = assignee.notifications.find((item) => item.kind === "review_decided")!;
    expect(decision.title).toContain("验收被退回");
    expect(decision.body).toContain("证据里缺少客户签字页");
  });

  it("标记已读幂等：只影响本人，不覆盖更早的已读时间", async () => {
    const { service, manager, member, conversation } = await fixture();
    await publishDirect(service, manager, conversation.id);
    const [notification] = (await service.notifications(member, {})).notifications;

    const first = await service.markNotificationRead(member, notification.id);
    expect(first.notification.readAt).toBeTruthy();
    expect(first.unreadCount).toBe(0);
    const second = await service.markNotificationRead(member, notification.id);
    expect(second.notification.readAt).toBe(first.notification.readAt);
    expect(second.unreadCount).toBe(0);

    // 他人不能读我的通知，也不能通过错误码探测存在性
    await expect(service.markNotificationRead(manager, notification.id)).rejects.toThrow("WORK_NOTIFICATION_NOT_FOUND");
    await expect(service.markNotificationRead(member, "00000000-0000-4000-8000-000000000099")).rejects.toThrow("WORK_NOTIFICATION_NOT_FOUND");
  });

  it("全部已读只清本人未读，不影响他人", async () => {
    const { service, manager, member, conversation } = await fixture();
    const task = await publishDirect(service, manager, conversation.id);
    await service.transitionPackage(member, task.id, { expectedVersion: task.version, nextStatus: "in_progress" });
    await service.transitionPackage(member, task.id, { expectedVersion: task.version + 1, nextStatus: "in_review", evidenceRefs: ["document:acceptance-v1"] });

    expect((await service.notifications(member, {})).unreadCount).toBe(1);
    expect((await service.notifications(manager, {})).unreadCount).toBe(1);

    const result = await service.markAllNotificationsRead(manager);
    expect(result.updated).toBe(1);
    expect(result.unreadCount).toBe(0);
    // 承接人的未读不受影响
    expect((await service.notifications(member, {})).unreadCount).toBe(1);
    expect((await service.markAllNotificationsRead(manager)).updated).toBe(0);
  });

  it("workspace 载荷带上本人通知与未读数", async () => {
    const { service, manager, member, other, conversation } = await fixture();
    await publishDirect(service, manager, conversation.id);
    const assigneeWorkspace = await service.workspace(member);
    expect(assigneeWorkspace.unreadNotificationCount).toBe(1);
    expect(assigneeWorkspace.notifications).toHaveLength(1);
    const bystanderWorkspace = await service.workspace(other);
    expect(bystanderWorkspace.notifications).toEqual([]);
    expect(bystanderWorkspace.unreadNotificationCount).toBe(0);
  });

  it("版本冲突时不产生通知（与业务变更同事务失败）", async () => {
    const { service, manager, member, conversation } = await fixture();
    const task = await publishDirect(service, manager, conversation.id);
    await service.notifications(member, {});
    const before = (await service.notifications(member, {})).unreadCount;
    // 用过期版本号推进状态：应被 CAS 拒绝，也不留下通知
    await expect(service.transitionPackage(member, task.id, { expectedVersion: task.version + 5, nextStatus: "in_progress" })).rejects.toThrow("WORK_PACKAGE_VERSION_CONFLICT");
    expect((await service.notifications(member, {})).unreadCount).toBe(before);
  });

  it("子任务勾选不产生通知（避免噪声）", async () => {
    const { service, manager, member, conversation } = await fixture();
    const task = await publishDirect(service, manager, conversation.id);
    const started = await service.transitionPackage(member, task.id, { expectedVersion: task.version, nextStatus: "in_progress" });
    const baseline = (await service.notifications(member, {})).notifications.length;
    const subtask = (await service.addPackageSubtask(member, { packageId: task.id, title: "收集客户签字页" })).subtask;
    await service.updatePackageSubtask(member, { packageId: task.id, subtaskId: subtask.id, expectedVersion: subtask.version, done: true, note: "已收到扫描件" });
    expect(started.version).toBe(task.version + 1);
    expect((await service.notifications(manager, {})).unreadCount).toBe(0);
    expect((await service.notifications(member, {})).notifications.length).toBe(baseline);
  });
});
