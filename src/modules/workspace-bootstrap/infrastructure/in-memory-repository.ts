import type { WorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/application/contracts";
import { getDevelopmentManagementRepository } from "@/src/modules/management-loop/infrastructure/in-memory-repository";
import { DEMO_PROJECT_ID, DEMO_TENANT_ID, getDevelopmentIdentityByActorId } from "@/src/platform/context/development-context";

export class InMemoryWorkspaceBootstrapRepository implements WorkspaceBootstrapRepository {
  async getIdentity(tenantId: string, actorId: string) {
    const identity = getDevelopmentIdentityByActorId(actorId);
    if (tenantId !== DEMO_TENANT_ID || !identity) return null;
    return {
      tenantId,
      tenantName: "本地开发工作区",
      actorId,
      displayName: identity.displayName,
    };
  }

  async listProjects(tenantId: string) {
    const snapshot = await getDevelopmentManagementRepository().getSnapshot(tenantId, DEMO_PROJECT_ID);
    if (!snapshot) return [];
    const { project } = snapshot;
    return [{
      id: project.id,
      code: project.code,
      name: project.name,
      ownerId: project.ownerId,
      status: project.status,
      priority: project.priority,
      health: project.health,
      targetEndAt: project.targetEndAt,
    }];
  }
}
