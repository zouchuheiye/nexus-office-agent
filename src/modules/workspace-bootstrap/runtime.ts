import { WorkspaceBootstrapService } from "@/src/modules/workspace-bootstrap/application/service";
import { InMemoryWorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/infrastructure/in-memory-repository";
import { PostgresWorkspaceBootstrapRepository } from "@/src/modules/workspace-bootstrap/infrastructure/postgres-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("workspace-bootstrap");

export function getWorkspaceBootstrapService() {
  return moduleRuntime("workspace-bootstrap", runtimeGeneration, () => process.env.DATABASE_URL
    ? new WorkspaceBootstrapService(new PostgresWorkspaceBootstrapRepository(createPostgresDatabase(process.env.DATABASE_URL)), "production")
    : new WorkspaceBootstrapService(new InMemoryWorkspaceBootstrapRepository(), "development_fixture"));
}
