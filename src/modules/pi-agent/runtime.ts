import { PiAgentService } from "@/src/modules/pi-agent/application/service";
import { InMemoryPiSessionStore } from "@/src/modules/pi-agent/infrastructure/in-memory-store";
import { PostgresPiSessionStore } from "@/src/modules/pi-agent/infrastructure/postgres-store";
import { InMemoryPiRunStore, PostgresPiRunStore } from "@/src/modules/pi-agent/infrastructure/run-store";
import { createPiSandboxProvider } from "@/src/modules/pi-agent/infrastructure/sandbox";
import { PiWorkspaceService } from "@/src/modules/pi-agent/application/workspace-service";
import { InMemoryPiWorkspaceStore, PostgresPiWorkspaceStore } from "@/src/modules/pi-agent/infrastructure/workspace-store";
import { createPiGitCredentialBroker, createPiWorkspaceProvider } from "@/src/modules/pi-agent/infrastructure/workspace-provider";
import { createPiObjectStorageGateway } from "@/src/modules/pi-agent/infrastructure/object-storage";
import { PiResourceRegistryService, createPiResourceRegistry } from "@/src/modules/pi-agent/application/resource-registry";
import { InMemoryPiResourceRegistryStore, PostgresPiResourceRegistryStore } from "@/src/modules/pi-agent/infrastructure/resource-store";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { createMcpRegistry, McpRegistryService } from "@/src/modules/pi-agent/application/mcp-registry";
import { InMemoryMcpRegistryStore, PostgresMcpAuditScopeReadinessStore, PostgresMcpRegistryStore } from "@/src/modules/pi-agent/infrastructure/mcp-store";
import { ApprovalPolicyResolver, FailClosedPiApprovalApproverDirectory, InMemoryPiApprovalEventSink, PiApprovalService } from "@/src/modules/pi-agent/application/approval-service";
import { InMemoryPiApprovalStore, PostgresPiApprovalStore } from "@/src/modules/pi-agent/infrastructure/approval-store";
import { PostgresPiApprovalEventSink } from "@/src/modules/pi-agent/infrastructure/approval-events";
import { SessionTreeService } from "@/src/modules/pi-agent/application/session-tree-service";
import { StaticAgentProfileRegistry, PostgresAgentProfileRegistry } from "@/src/modules/pi-agent/application/profile-registry";
import { DelegationService } from "@/src/modules/pi-agent/application/delegation-service";
import { InMemoryPiSessionTreeStore, PostgresPiSessionTreeStore } from "@/src/modules/pi-agent/infrastructure/session-tree-store";
import { InMemoryPiDelegationStore, PostgresPiDelegationStore } from "@/src/modules/pi-agent/infrastructure/delegation-store";
import { EnterpriseModelGateway } from "@/src/modules/pi-agent/application/model-gateway";
import { PiTelemetryService } from "@/src/modules/pi-agent/application/telemetry-evaluation";
import { PiQuotaService } from "@/src/modules/pi-agent/application/quota-service";
import { InMemoryPiModelRouteStore, InMemoryPiObservabilityStore, InMemoryPiQuotaStore, PostgresPiM30Store } from "@/src/modules/pi-agent/infrastructure/m30-store";
import { PiSecurityResilienceService } from "@/src/modules/pi-agent/application/security-resilience";
import { InMemoryPiSecurityResilienceStore, PostgresPiSecurityResilienceStore } from "@/src/modules/pi-agent/infrastructure/m31-store";
import { CompositePiPreproductionProbe, FailClosedPiPreproductionProbe, McpAuditScopePreproductionProbe, PiPreproductionService } from "@/src/modules/pi-agent/application/preproduction-service";
import { InMemoryPiPreproductionStore, PostgresPiPreproductionStore } from "@/src/modules/pi-agent/infrastructure/m32-store";
import { PiPilotService } from "@/src/modules/pi-agent/application/pilot-service";
import { InMemoryPiPilotStore, PostgresPiPilotStore } from "@/src/modules/pi-agent/infrastructure/m33-store";
import { PiReleaseGovernanceService } from "@/src/modules/pi-agent/application/release-governance-service";
import { InMemoryPiReleaseGovernanceStore, PostgresPiReleaseGovernanceStore } from "@/src/modules/pi-agent/infrastructure/m34-store";
import { PiChangeDeliveryService } from "@/src/modules/pi-agent/application/change-delivery-service";
import { InMemoryPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/change-delivery-store";
import { PostgresPiChangeDeliveryStore } from "@/src/modules/pi-agent/infrastructure/postgres-change-delivery-store";
import { PiChangeDeliveryApprovalObjectVersionReader } from "@/src/modules/pi-agent/infrastructure/change-delivery-approval";
import { createPiChangeDeliveryGateways } from "@/src/modules/pi-agent/infrastructure/change-delivery-gateway";
import type { PiChangeDeliveryEvidenceReader } from "@/src/modules/pi-agent/domain/change-delivery-contracts";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

type PiAgentRuntimeBundle = {
  agent: PiAgentService;
  workspace: PiWorkspaceService;
  resourceRegistry: PiResourceRegistryService;
  mcpRegistry: McpRegistryService;
  approval: PiApprovalService;
  sessionTree: SessionTreeService;
  delegation: DelegationService;
  profileRegistry: StaticAgentProfileRegistry | PostgresAgentProfileRegistry;
  modelGateway: EnterpriseModelGateway;
  telemetry: PiTelemetryService;
  quota: PiQuotaService;
  securityResilience: PiSecurityResilienceService;
  preproduction: PiPreproductionService;
  pilot: PiPilotService;
  releaseGovernance: PiReleaseGovernanceService;
  changeDelivery: PiChangeDeliveryService;
};

const runtimeGeneration = Symbol("pi-agent");

function buildPiAgentRuntime(): PiAgentRuntimeBundle {
  const database = process.env.DATABASE_URL ? createPostgresDatabase(process.env.DATABASE_URL) : undefined;
  const store = database ? new PostgresPiSessionStore(database) : new InMemoryPiSessionStore();
  const runStore = database ? new PostgresPiRunStore(database) : new InMemoryPiRunStore();
  const resourceRegistry = createPiResourceRegistry(database ? new PostgresPiResourceRegistryStore(database) : new InMemoryPiResourceRegistryStore());
  const mcpRegistry = createMcpRegistry(database ? new PostgresMcpRegistryStore(database) : new InMemoryMcpRegistryStore());
  const approvalStore = database ? new PostgresPiApprovalStore(database) : new InMemoryPiApprovalStore();
  const approvalEvents = database ? new PostgresPiApprovalEventSink(database) : new InMemoryPiApprovalEventSink();
  const approvalPolicy = new ApprovalPolicyResolver(new FailClosedPiApprovalApproverDirectory(), { policyVersion: 1 });
  const treeStore = database ? new PostgresPiSessionTreeStore(database) : new InMemoryPiSessionTreeStore();
  const profileRegistry = database ? new PostgresAgentProfileRegistry(database) : new StaticAgentProfileRegistry();
  const delegationStore = database ? new PostgresPiDelegationStore(database) : new InMemoryPiDelegationStore();
  const m30Store = database ? new PostgresPiM30Store(database) : undefined;
  const m31Store = database ? new PostgresPiSecurityResilienceStore(database) : new InMemoryPiSecurityResilienceStore();
  const securityResilience = new PiSecurityResilienceService(m31Store);
  const m32Store = database ? new PostgresPiPreproductionStore(database) : new InMemoryPiPreproductionStore();
  const m33Store = database ? new PostgresPiPilotStore(database) : new InMemoryPiPilotStore();
  const m34Store = database ? new PostgresPiReleaseGovernanceStore(database) : new InMemoryPiReleaseGovernanceStore();
  const sessionTree = new SessionTreeService({ sessionStore: store, treeStore });
  const delegation = new DelegationService(store, delegationStore, profileRegistry, undefined, false);
  const modelGateway = new EnterpriseModelGateway({ store: m30Store ?? new InMemoryPiModelRouteStore(), safety: securityResilience });
  const telemetry = new PiTelemetryService(m30Store ?? new InMemoryPiObservabilityStore());
  const quota = new PiQuotaService(m30Store ?? new InMemoryPiQuotaStore());
  const preproductionProbe = database
    ? new CompositePiPreproductionProbe([new FailClosedPiPreproductionProbe(), new McpAuditScopePreproductionProbe(new PostgresMcpAuditScopeReadinessStore(database))])
    : new FailClosedPiPreproductionProbe();
  const preproduction = new PiPreproductionService(m32Store, preproductionProbe);
  const pilot = new PiPilotService(m33Store);
  const releaseGovernance = new PiReleaseGovernanceService(m34Store);
  const agent = new PiAgentService(store, createPiSandboxProvider(), runStore, resourceRegistry, mcpRegistry);
  const workspace = new PiWorkspaceService({
    store: database ? new PostgresPiWorkspaceStore(database) : new InMemoryPiWorkspaceStore(),
    provider: createPiWorkspaceProvider(),
    credentialBroker: createPiGitCredentialBroker(),
    objectStorage: createPiObjectStorageGateway(),
    sessionStore: store,
  });
  const changeEvidence: PiChangeDeliveryEvidenceReader = {
    getRepository: workspace.getRepository.bind(workspace),
    getWorkspace: workspace.getWorkspace.bind(workspace),
    deliveryDiff: workspace.deliveryDiff.bind(workspace),
    checkpoints: workspace.checkpoints.bind(workspace),
    listArtifacts: workspace.listArtifacts.bind(workspace),
  };
  const changeStore = database ? new PostgresPiChangeDeliveryStore(database) : new InMemoryPiChangeDeliveryStore();
  const changeObjectVersions = new PiChangeDeliveryApprovalObjectVersionReader(changeStore, changeEvidence);
  const approval = new PiApprovalService(approvalStore, approvalPolicy, approvalEvents, changeObjectVersions);
  const gateways = createPiChangeDeliveryGateways();
  const changeDelivery = new PiChangeDeliveryService(changeStore, changeEvidence, approval, gateways.pullRequests, gateways.releases);
  return {
    agent, workspace, resourceRegistry, mcpRegistry, approval, sessionTree, delegation, profileRegistry,
    modelGateway, telemetry, quota, securityResilience, preproduction, pilot, releaseGovernance, changeDelivery,
  };
}

export function getPiAgentRuntime(): PiAgentRuntimeBundle {
  return moduleRuntime("pi-agent", runtimeGeneration, buildPiAgentRuntime);
}

export function getPiAgentService(): PiAgentService { return getPiAgentRuntime().agent; }
export function getPiMcpRegistry(): McpRegistryService { return getPiAgentRuntime().mcpRegistry; }
export function getPiResourceRegistry(): PiResourceRegistryService { return getPiAgentRuntime().resourceRegistry; }
export function getPiApprovalService(): PiApprovalService { return getPiAgentRuntime().approval; }
export function getPiWorkspaceService(): PiWorkspaceService { return getPiAgentRuntime().workspace; }
export function getPiSessionTreeService(): SessionTreeService { return getPiAgentRuntime().sessionTree; }
export function getPiDelegationService(): DelegationService { return getPiAgentRuntime().delegation; }
export function getPiProfileRegistry(): StaticAgentProfileRegistry | PostgresAgentProfileRegistry { return getPiAgentRuntime().profileRegistry; }
export function getPiModelGateway(): EnterpriseModelGateway { return getPiAgentRuntime().modelGateway; }
export function getPiTelemetryService(): PiTelemetryService { return getPiAgentRuntime().telemetry; }
export function getPiQuotaService(): PiQuotaService { return getPiAgentRuntime().quota; }
export function getPiSecurityResilienceService(): PiSecurityResilienceService { return getPiAgentRuntime().securityResilience; }
export function getPiPreproductionService(): PiPreproductionService { return getPiAgentRuntime().preproduction; }
export function getPiPilotService(): PiPilotService { return getPiAgentRuntime().pilot; }
export function getPiReleaseGovernanceService(): PiReleaseGovernanceService { return getPiAgentRuntime().releaseGovernance; }
export function getPiChangeDeliveryService(): PiChangeDeliveryService { return getPiAgentRuntime().changeDelivery; }
