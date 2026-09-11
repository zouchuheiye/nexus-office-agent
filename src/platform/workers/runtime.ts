import { randomUUID } from "node:crypto";
import { ManagementContextProvider } from "@/src/modules/agent/application/context-provider";
import { getAgentOrchestrator, getAgentToolRegistry } from "@/src/modules/agent/runtime";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { AgentChannelActionHandler } from "@/src/modules/integration/application/channel-action-handler";
import { createIdentityConnectorRegistry, PostgresChannelActorContextResolver } from "@/src/modules/integration/infrastructure/postgres-identity-control-plane";
import { TaskNotificationChannelDispatcher, taskNotificationChannelOptionsFromEnv } from "@/src/modules/integration/application/task-notification-channel";
import { DEFAULT_TASK_NOTIFICATION_DISPATCH_OPTIONS, TaskNotificationDispatchWorker } from "@/src/modules/integration/application/task-notification-dispatch-worker";
import { PostgresChannelPreferenceDirectory, PostgresChannelRecipientDirectory, PostgresTaskNotificationChannelSource } from "@/src/modules/integration/infrastructure/postgres-task-notification-channel";
import { RuntimeTaskNotificationChannelSender } from "@/src/modules/integration/infrastructure/task-notification-channel-sender";
import { PostgresNotificationDeliveryStore } from "@/src/modules/integration/infrastructure/postgres-notification-store";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { getTaskCommandService } from "@/src/modules/task-command/runtime";
import { DEFAULT_TASK_REMINDER_OPTIONS, TaskReminderWorker } from "@/src/modules/task-command/application/reminder-worker";
import { notificationRetentionOptionsFromEnv } from "@/src/modules/task-command/application/notification-retention";
import { TaskCommandService } from "@/src/modules/task-command/application/service";
import { PostgresTaskCommandRepository } from "@/src/modules/task-command/infrastructure/postgres-repository";
import { ManagementChannelActionHandler } from "@/src/modules/management-intelligence/application/channel-action-handler";
import { createManagementIntelligenceService } from "@/src/modules/management-intelligence/runtime";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { PostgresAuthorizationResolver } from "@/src/platform/identity/authorization-resolver";
import { AgentJobWorker, DurableInboundEventHandler, InboxWorker, OutboxDispatcher } from "@/src/platform/workers/durable-workers";
import { PiChangeDeliveryOutboxWorker } from "@/src/modules/pi-agent/application/change-delivery-worker";
import { PiChangeDeliveryService } from "@/src/modules/pi-agent/application/change-delivery-service";
import { PostgresPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/postgres-change-delivery-store";
import { PiChangeDeliveryApprovalObjectVersionReader } from "@/src/modules/pi-agent/infrastructure/change-delivery-approval";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { PostgresPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import { createPiGitCredentialBroker, createPiWorkspaceProvider } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { createPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { ApprovalPolicyResolver, FailClosedPiApprovalApproverDirectory, PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import { PostgresPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";
import { PostgresPiApprovalEventSink } from "@/src/modules/pi-agent/infrastructure/approval-events";
import { createPiChangeDeliveryGateways } from "@/src/modules/pi-agent/infrastructure/change-delivery-gateway";
import {
  PostgresAgentJobRepository,
  PostgresInboxWorkRepository,
  PostgresOutboxWorkRepository,
  PostgresTenantDirectory,
  PostgresWorkerHeartbeatRepository,
} from "@/src/platform/workers/postgres-work-repositories";
import { WorkerSupervisor, type TenantWorker } from "@/src/platform/workers/supervisor";
import type { WorkerRole } from "@/src/platform/workers/contracts";

function workerRoles(value = process.env.WORKER_ROLES ?? "inbox,agent,outbox"): WorkerRole[] {
  const roles = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  const known: WorkerRole[] = ["inbox", "agent", "outbox", "pi-change-delivery", "task-reminder", "notification-dispatch"];
  if (roles.some((role) => !known.includes(role as WorkerRole))) {
    if (roles.includes("pi-runner")) throw new Error("PI_RUNNER_REQUIRES_DEDICATED_ENTRYPOINT");
    throw new Error("WORKER_ROLE_INVALID");
  }
  if (roles.length === 0) throw new Error("WORKER_ROLE_REQUIRED");
  return roles as WorkerRole[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("WORKER_CONFIGURATION_INVALID");
  return parsed;
}

export function createDurableWorkerRuntime() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const database = createPostgresDatabase(databaseUrl);
  const authorization = new PostgresAuthorizationResolver(database);
  const connectors = createIdentityConnectorRegistry(database);
  const channelContexts = new PostgresChannelActorContextResolver(database, authorization);
  const channelActions = new AgentChannelActionHandler(connectors, channelContexts, getAgentOrchestrator(), getTaskCommandService());
  const managementChannelActions = new ManagementChannelActionHandler(connectors, channelContexts, createManagementIntelligenceService(database));
  const events = new PostgresEventStore(database);
  const roles = workerRoles();
  const leaseMs = positiveInteger(process.env.WORKER_LEASE_MS, 30_000);
  const maxTenantConcurrency = positiveInteger(process.env.WORKER_MAX_CONCURRENT_PER_TENANT, 2);
  const workers = new Map<WorkerRole, TenantWorker>([
    ["inbox", new InboxWorker(new PostgresInboxWorkRepository(database), new DurableInboundEventHandler(channelActions, events, managementChannelActions), leaseMs, maxTenantConcurrency)],
    ["agent", new AgentJobWorker(new PostgresAgentJobRepository(database), authorization, new ManagementContextProvider(getManagementLoopService(), getTaskCommandService()), getAgentToolRegistry(), leaseMs, maxTenantConcurrency)],
    ["outbox", new OutboxDispatcher(new PostgresOutboxWorkRepository(database), leaseMs, maxTenantConcurrency)],
  ]);
  if (roles.includes("pi-change-delivery")) {
    const workspaceService = new PiWorkspaceService({
      store: new PostgresPiWorkspaceStore(database),
      provider: createPiWorkspaceProvider(),
      credentialBroker: createPiGitCredentialBroker(),
      objectStorage: createPiObjectStorageGateway(),
      sessionStore: new PostgresPiSessionStore(database),
    });
    const changeStore = new PostgresPiChangeDeliveryStore(database);
    const evidence = {
      getRepository: workspaceService.getRepository.bind(workspaceService),
      getWorkspace: workspaceService.getWorkspace.bind(workspaceService),
      deliveryDiff: workspaceService.deliveryDiff.bind(workspaceService),
      checkpoints: workspaceService.checkpoints.bind(workspaceService),
      listArtifacts: workspaceService.listArtifacts.bind(workspaceService),
    };
    const approvals = new PiApprovalService(
      new PostgresPiApprovalStore(database),
      new ApprovalPolicyResolver(new FailClosedPiApprovalApproverDirectory(), { policyVersion: 1 }),
      new PostgresPiApprovalEventSink(database),
      new PiChangeDeliveryApprovalObjectVersionReader(changeStore, evidence),
    );
    const gateways = createPiChangeDeliveryGateways();
    const changeDelivery = new PiChangeDeliveryService(
      changeStore,
      evidence,
      approvals,
      gateways.pullRequests,
      gateways.releases,
      positiveInteger(process.env.PI_CHANGE_DELIVERY_LEASE_MS, 60_000),
    );
    workers.set("pi-change-delivery", new PiChangeDeliveryOutboxWorker(changeDelivery, positiveInteger(process.env.PI_CHANGE_DELIVERY_WORKER_BATCH, 1), gateways.enabled));
  }
  if (roles.includes("task-reminder")) {
    // 复用同一份数据库连接构造服务，避免常驻进程额外开池。
    // 留存策略（保留多久/是否启用）只在这里从环境变量映射一次，服务与脚本共用同一份口径。
    const reminders = new TaskCommandService(new PostgresTaskCommandRepository(database), notificationRetentionOptionsFromEnv());
    workers.set("task-reminder", new TaskReminderWorker(reminders, {
      intervalMs: positiveInteger(process.env.TASK_REMINDER_INTERVAL_MS, DEFAULT_TASK_REMINDER_OPTIONS.intervalMs),
      dueSoonHours: positiveInteger(process.env.TASK_REMINDER_DUE_SOON_HOURS, DEFAULT_TASK_REMINDER_OPTIONS.dueSoonHours),
      blockedEscalationHours: positiveInteger(process.env.TASK_REMINDER_BLOCKED_HOURS, DEFAULT_TASK_REMINDER_OPTIONS.blockedEscalationHours),
      timeoutMs: positiveInteger(process.env.TASK_REMINDER_TIMEOUT_MS, DEFAULT_TASK_REMINDER_OPTIONS.timeoutMs),
      summary: {
        enabled: process.env.TASK_SUMMARY_ENABLED !== "false",
        scope: process.env.TASK_SUMMARY_SCOPE === "weekly" ? "weekly" : "daily",
      },
    }));
  }
  if (roles.includes("notification-dispatch")) {
    // 外部通道投递是独立角色：默认关闭，开启后也只投"用户显式 opt-in 且身份已验证"的通知。
    const channelOptions = taskNotificationChannelOptionsFromEnv();
    const deliveryStore = new PostgresNotificationDeliveryStore(database);
    const dispatcher = new TaskNotificationChannelDispatcher(
      new PostgresTaskNotificationChannelSource(database),
      new PostgresChannelRecipientDirectory(database),
      new PostgresChannelPreferenceDirectory(database),
      new RuntimeTaskNotificationChannelSender(deliveryStore),
      channelOptions,
    );
    workers.set("notification-dispatch", new TaskNotificationDispatchWorker(dispatcher, {
      intervalMs: positiveInteger(process.env.TASK_NOTIFICATION_CHANNEL_INTERVAL_MS, DEFAULT_TASK_NOTIFICATION_DISPATCH_OPTIONS.intervalMs),
      timeoutMs: positiveInteger(process.env.TASK_NOTIFICATION_CHANNEL_TIMEOUT_MS, DEFAULT_TASK_NOTIFICATION_DISPATCH_OPTIONS.timeoutMs),
      enabled: channelOptions.enabled,
    }));
  }
  const enabled = roles.map((role) => workers.get(role)!);
  const supervisor = new WorkerSupervisor(
    new PostgresTenantDirectory(database),
    new PostgresWorkerHeartbeatRepository(database),
    enabled,
    {
      instanceId: process.env.WORKER_INSTANCE_ID ?? `${process.pid}-${randomUUID().slice(0,8)}`,
      releaseVersion: process.env.NEXUS_RELEASE_VERSION ?? "0.15.0-pi-runner-spike",
      pollIntervalMs: positiveInteger(process.env.WORKER_POLL_INTERVAL_MS, 500),
      heartbeatIntervalMs: positiveInteger(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 10_000),
      maxItemsPerRolePerCycle: positiveInteger(process.env.WORKER_MAX_ITEMS_PER_ROLE, 32),
    },
  );
  return { database, supervisor, roles };
}
