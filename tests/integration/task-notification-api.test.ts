// Requirements: PR-009, PR-010, MR-046, MR-047, MR-048, MR-049, AC-012, AC-013（P4 站内通知 HTTP 契约）
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as listNotifications } from "@/app/api/v1/task-command/notifications/route";
import { POST as markRead } from "@/app/api/v1/task-command/notifications/[id]/read/route";
import { POST as markAllRead } from "@/app/api/v1/task-command/notifications/read-all/route";
import { POST as publishMission } from "@/app/api/v1/task-command/missions/route";
import { POST as transitionTask } from "@/app/api/v1/task-command/packages/[id]/transition/route";
import { GET as getWorkspace } from "@/app/api/v1/task-command/workspace/route";
import { POST as switchIdentity } from "@/app/api/v1/auth/development-identities/switch/route";

const secret = "0123456789abcdef0123456789abcdef";
const DELIVERY_ID = "10000000-0000-4000-8000-000000000002";

function request(url: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-trace-id": "task-notification-api-test" };
  if (cookie) headers.cookie = `nexus_session=${encodeURIComponent(cookie)}`;
  return new Request(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function sessionFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(/nexus_session=([^;]+)/);
  if (!match) throw new Error("session cookie missing");
  return decodeURIComponent(match[1]);
}

async function deliveryCookie(): Promise<string> {
  const switched = await switchIdentity(new Request("http://localhost/api/v1/auth/development-identities/switch", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "delivery" }),
  }));
  expect(switched.status).toBe(200);
  return sessionFrom(switched);
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("站内通知 HTTP 契约", () => {
  it("只返回本人通知：分派通知可被收件人读取、标记已读；发布人自己看不到", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");

    const marker = crypto.randomUUID().slice(0, 8);
    const workspace = await (await getWorkspace(request("http://localhost/api/v1/task-command/workspace"))).json();
    const published = await publishMission(request("http://localhost/api/v1/task-command/missions", {
      conversationId: workspace.data.conversation.id,
      title: `通知接口验证 ${marker}`,
      objective: "验证站内通知的 HTTP 契约。",
      priority: "high",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: `定向分派通知包 ${marker}`,
        description: "分派给周然后检查通知。",
        acceptanceCriteria: "通知只对收件人可见。",
        requiredSkills: ["交付"],
        assignmentMode: "direct",
        assigneeId: DELIVERY_ID,
        priority: "high",
        dueAt: "2030-08-30T10:00:00.000Z",
        startedAt: "2030-08-01T00:00:00.000Z",
        estimatedDays: 7,
        capacityPoints: 2,
      }],
    }));
    expect(published.status).toBe(201);
    const task = (await published.json()).data.packages[0];

    // 发布人（默认开发身份）不会收到"自己给自己派任务"的通知
    const publisherList = await (await listNotifications(request("http://localhost/api/v1/task-command/notifications"))).json();
    expect(publisherList.data.notifications.filter((item: { packageId: string }) => item.packageId === task.id)).toEqual([]);

    // 收件人（周然）能看到这条分派通知
    const cookie = await deliveryCookie();
    const assigneeResponse = await listNotifications(request("http://localhost/api/v1/task-command/notifications?unreadOnly=true", undefined, cookie));
    expect(assigneeResponse.status).toBe(200);
    const assigneeList = await assigneeResponse.json();
    const mine = assigneeList.data.notifications.filter((item: { packageId: string }) => item.packageId === task.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "task_assigned", refType: "work_package", recipientId: DELIVERY_ID });
    expect(mine[0].title).toContain(marker);
    expect(assigneeList.data.unreadCount).toBeGreaterThanOrEqual(1);

    // 标记已读幂等
    const firstRead = await markRead(request(`http://localhost/api/v1/task-command/notifications/${mine[0].id}/read`, {}, cookie), { params: Promise.resolve({ id: mine[0].id }) });
    expect(firstRead.status).toBe(200);
    const firstPayload = await firstRead.json();
    expect(firstPayload.data.notification.readAt).toBeTruthy();
    const secondRead = await markRead(request(`http://localhost/api/v1/task-command/notifications/${mine[0].id}/read`, {}, cookie), { params: Promise.resolve({ id: mine[0].id }) });
    expect((await secondRead.json()).data.notification.readAt).toBe(firstPayload.data.notification.readAt);

    // 全部已读：幂等，只影响本人
    const allRead = await markAllRead(request("http://localhost/api/v1/task-command/notifications/read-all", {}, cookie));
    expect(allRead.status).toBe(200);
    const allPayload = await allRead.json();
    expect(allPayload.data.unreadCount).toBe(0);
    const unreadOnly = await (await listNotifications(request("http://localhost/api/v1/task-command/notifications?unreadOnly=true", undefined, cookie))).json();
    expect(unreadOnly.data.notifications.filter((item: { packageId: string }) => item.packageId === task.id)).toEqual([]);
  });

  it("越权读取他人通知返回 404，非法查询参数返回 422", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DATABASE_URL", "");

    const marker = crypto.randomUUID().slice(0, 8);
    const workspace = await (await getWorkspace(request("http://localhost/api/v1/task-command/workspace"))).json();
    const published = await publishMission(request("http://localhost/api/v1/task-command/missions", {
      conversationId: workspace.data.conversation.id,
      title: `越权验证 ${marker}`,
      objective: "验证通知的越权边界。",
      priority: "medium",
      dueAt: "2030-09-01T10:00:00.000Z",
      packages: [{
        title: `越权通知包 ${marker}`,
        description: "由周然承接后提交验收，使发布人收到待验收通知。",
        acceptanceCriteria: "越权读取被拒。",
        requiredSkills: ["交付"],
        assignmentMode: "direct",
        assigneeId: DELIVERY_ID,
        priority: "medium",
        dueAt: "2030-08-30T10:00:00.000Z",
        startedAt: "2030-08-01T00:00:00.000Z",
        estimatedDays: 7,
        capacityPoints: 1,
      }],
    }));
    const task = (await published.json()).data.packages[0];
    const cookie = await deliveryCookie();

    const started = await transitionTask(
      request(`http://localhost/api/v1/task-command/packages/${task.id}/transition`, { expectedVersion: task.version, nextStatus: "in_progress" }, cookie),
      { params: Promise.resolve({ id: task.id }) },
    );
    const startedTask = (await started.json()).data.task;
    const submitted = await transitionTask(
      request(`http://localhost/api/v1/task-command/packages/${task.id}/transition`, { expectedVersion: startedTask.version, nextStatus: "in_review", evidenceRefs: ["https://example.test/evidence.pdf"] }, cookie),
      { params: Promise.resolve({ id: task.id }) },
    );
    expect(submitted.status).toBe(200);

    // 发布人收到"待你验收"通知
    const publisherList = await (await listNotifications(request("http://localhost/api/v1/task-command/notifications"))).json();
    const reviewNotification = publisherList.data.notifications.find((item: { packageId: string; kind: string }) => item.packageId === task.id && item.kind === "review_requested");
    expect(reviewNotification).toBeTruthy();

    // 承接人（周然）不能标记发布人的通知
    const forbidden = await markRead(
      request(`http://localhost/api/v1/task-command/notifications/${reviewNotification.id}/read`, {}, cookie),
      { params: Promise.resolve({ id: reviewNotification.id }) },
    );
    expect(forbidden.status).toBe(404);
    expect((await forbidden.json()).error.code).toBe("WORK_NOTIFICATION_NOT_FOUND");

    const invalid = await listNotifications(request("http://localhost/api/v1/task-command/notifications?limit=0", undefined, cookie));
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.code).toBe("VALIDATION_FAILED");
  });
});
