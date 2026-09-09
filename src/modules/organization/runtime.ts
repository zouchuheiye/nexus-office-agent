import { MemberDirectoryService } from "@/src/modules/organization/application/member-directory-service";
import { InMemoryMemberDirectoryRepository } from "@/src/modules/organization/infrastructure/in-memory-member-directory-repository";
import { PostgresMemberDirectoryRepository } from "@/src/modules/organization/infrastructure/postgres-member-directory-repository";
import { createPostgresDatabase } from "@/src/platform/database/postgres";
import { moduleRuntime } from "@/src/platform/runtime/module-runtime";

const runtimeGeneration = Symbol("organization-member-directory");

export function getMemberDirectoryService() {
  return moduleRuntime("organization-member-directory", runtimeGeneration, () => {
    const repository = process.env.DATABASE_URL
      ? new PostgresMemberDirectoryRepository(createPostgresDatabase(process.env.DATABASE_URL))
      : new InMemoryMemberDirectoryRepository();
    return new MemberDirectoryService(repository);
  });
}
