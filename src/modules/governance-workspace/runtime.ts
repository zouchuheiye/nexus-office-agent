import { MeetingService } from "@/src/modules/collaboration/application/meeting-service";
import { getDevelopmentMeetingRepository } from "@/src/modules/collaboration/infrastructure/in-memory-meeting-repository";
import { PostgresMeetingRepository } from "@/src/modules/collaboration/infrastructure/postgres-meeting-repository";
import { InMemoryEventStore } from "@/src/modules/events/application/event-store";
import { PostgresEventStore } from "@/src/modules/events/infrastructure/postgres-event-store";
import { KnowledgeService } from "@/src/modules/knowledge/application/service";
import { getDevelopmentKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/in-memory-repository";
import { PostgresKnowledgeRepository } from "@/src/modules/knowledge/infrastructure/postgres-repository";
import { getManagementLoopService } from "@/src/modules/management-loop/runtime";
import { WorkflowService } from "@/src/modules/workflow/application/service";
import { getDevelopmentWorkflowRepository } from "@/src/modules/workflow/infrastructure/in-memory-repository";
import { PostgresWorkflowRepository } from "@/src/modules/workflow/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

type GovernanceRuntime = {
  workflow: WorkflowService;
  knowledge: KnowledgeService;
  meetings: MeetingService;
};

const runtimeGeneration = Symbol("governance-workspace");

export function getGovernanceRuntime(): GovernanceRuntime {
  return moduleRuntime("governance-workspace", runtimeGeneration, () => {
    if (process.env.DATABASE_URL) {
      const database = createPostgresDatabase(process.env.DATABASE_URL);
      const knowledge = new KnowledgeService(new PostgresKnowledgeRepository(database));
      return {
        workflow: new WorkflowService(new PostgresWorkflowRepository(database), new PostgresEventStore(database)),
        knowledge,
        meetings: new MeetingService(new PostgresMeetingRepository(database), getManagementLoopService(), knowledge, new PostgresEventStore(database)),
      };
    }
    const events = new InMemoryEventStore();
    const knowledge = new KnowledgeService(getDevelopmentKnowledgeRepository());
    return {
      workflow: new WorkflowService(getDevelopmentWorkflowRepository(), events),
      knowledge,
      meetings: new MeetingService(getDevelopmentMeetingRepository(), getManagementLoopService(), knowledge, events),
    };
  });
}
