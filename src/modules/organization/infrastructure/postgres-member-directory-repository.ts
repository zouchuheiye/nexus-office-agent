import type { DatabaseExecutor, TransactionalDatabase } from "@/src/platform/database/executor";
import type { MemberDirectoryRepository, MemberDirectoryResult } from "@/src/modules/organization/application/member-directory-contracts";
import type { DirectoryMember, OrgUnitOption, PositionOption } from "@/src/modules/organization/domain/member-directory";

type Row = Record<string, unknown>;
const asText = (value: unknown) => value instanceof Date ? value.toISOString() : String(value ?? "");
const optionalText = (value: unknown) => value === null || value === undefined ? undefined : asText(value);

const mapMember = (row: Row): DirectoryMember => ({
  id: asText(row.user_id),
  displayName: asText(row.display_name),
  email: optionalText(row.email),
  status: asText(row.status) as DirectoryMember["status"],
  version: Number(row.version),
  orgUnitId: optionalText(row.org_unit_id),
  orgUnitName: optionalText(row.org_name),
  positionId: optionalText(row.position_id),
  positionName: optionalText(row.position_name),
  isManager: Boolean(row.is_manager),
  archivedAt: optionalText(row.archived_at),
});

const mapOrgUnit = (row: Row): OrgUnitOption => ({ id: asText(row.id), name: asText(row.name), status: asText(row.status) as OrgUnitOption["status"] });
const mapPosition = (row: Row): PositionOption => ({ id: asText(row.id), orgUnitId: asText(row.org_unit_id), name: asText(row.name), code: asText(row.code), status: asText(row.status) as PositionOption["status"] });

export class PostgresMemberDirectoryRepository implements MemberDirectoryRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async list(tenantId: string): Promise<MemberDirectoryResult> {
    return this.database.withTenant(tenantId, async (db) => {
      const [members, orgUnits, positions] = await Promise.all([
        db.query(
          `SELECT u.id::text AS user_id,u.display_name,u.email,u.status,u.version,u.archived_at,
             m.org_unit_id::text,m.position_id,m.is_manager,ou.name AS org_name,p.name AS position_name
           FROM users u
           LEFT JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.ends_at IS NULL
           LEFT JOIN org_units ou ON ou.tenant_id=m.tenant_id AND ou.id=m.org_unit_id
           LEFT JOIN positions p ON p.tenant_id=m.tenant_id AND p.id=m.position_id
           WHERE u.tenant_id=$1 AND u.archived_at IS NULL
           ORDER BY u.display_name,u.id`, [tenantId],
        ),
        db.query("SELECT id::text,name,status FROM org_units WHERE tenant_id=$1 AND status='active' ORDER BY name,id", [tenantId]),
        db.query("SELECT id::text,org_unit_id::text,name,code,status FROM positions WHERE tenant_id=$1 AND status='active' ORDER BY name,id", [tenantId]),
      ]);
      return { members: members.map(mapMember), orgUnits: orgUnits.map(mapOrgUnit), positions: positions.map(mapPosition) };
    });
  }

  async get(tenantId: string, userId: string): Promise<DirectoryMember | null> {
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query(
        `SELECT u.id::text AS user_id,u.display_name,u.email,u.status,u.version,u.archived_at,
           m.org_unit_id::text,m.position_id,m.is_manager,ou.name AS org_name,p.name AS position_name
         FROM users u
         LEFT JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.ends_at IS NULL
         LEFT JOIN org_units ou ON ou.tenant_id=m.tenant_id AND ou.id=m.org_unit_id
         LEFT JOIN positions p ON p.tenant_id=m.tenant_id AND p.id=m.position_id
         WHERE u.tenant_id=$1 AND u.id=$2`, [tenantId, userId],
      );
      return rows[0] ? mapMember(rows[0]) : null;
    });
  }

  async emailTaken(tenantId: string, email: string, excludeUserId?: string): Promise<boolean> {
    const sql = excludeUserId
      ? "SELECT 1 FROM users WHERE tenant_id=$1 AND lower(email)=lower($2) AND id<>$3"
      : "SELECT 1 FROM users WHERE tenant_id=$1 AND lower(email)=lower($2)";
    const params = excludeUserId ? [tenantId, email.trim(), excludeUserId] : [tenantId, email.trim()];
    const rows = await this.database.withTenant(tenantId, (db) => db.query(sql, params));
    return rows.length > 0;
  }

  async create(tenantId: string, member: DirectoryMember): Promise<boolean> {
    return this.database.withTenant(tenantId, async (db) => {
      const inserted = await this.insertUser(db, tenantId, member).catch((error: { code?: string }) => {
        if (error.code === "23505") return [];
        throw error;
      });
      if (inserted.length !== 1) return false;
      if (member.orgUnitId) await this.upsertCurrentMembership(db, tenantId, member.id, member.orgUnitId, member.positionId, member.isManager);
      return true;
    });
  }

  async update(tenantId: string, member: DirectoryMember, expectedVersion: number): Promise<boolean> {
    return this.database.withTenant(tenantId, async (db) => {
      const updated = await db.query(
        "UPDATE users SET display_name=$3,email=$4,version=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$6 RETURNING id",
        [tenantId, member.id, member.displayName, member.email ?? null, member.version, expectedVersion],
      );
      if (updated.length !== 1) return false;
      if (member.orgUnitId) await this.upsertCurrentMembership(db, tenantId, member.id, member.orgUnitId, member.positionId, member.isManager);
      return true;
    });
  }

  async deactivate(tenantId: string, userId: string, expectedVersion: number): Promise<"ok" | "version" | "active_work"> {
    return this.database.withTenant(tenantId, async (db) => {
      const active = await db.query(
        `SELECT 1 FROM work_packages WHERE tenant_id=$1 AND assignee_id=$2 AND status NOT IN ('completed','cancelled') LIMIT 1`,
        [tenantId, userId],
      );
      if (active.length > 0) return "active_work";
      const departed = await db.query(
        "UPDATE users SET status='departed',archived_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING id",
        [tenantId, userId, expectedVersion],
      );
      if (departed.length !== 1) return "version";
      await db.query("UPDATE memberships SET ends_at=now(),updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND ends_at IS NULL", [tenantId, userId]);
      return "ok";
    });
  }

  private async insertUser(db: DatabaseExecutor, tenantId: string, member: DirectoryMember) {
    return db.query(
      `INSERT INTO users(id,tenant_id,display_name,email,status,version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,1,now(),now()) RETURNING id`,
      [member.id, tenantId, member.displayName, member.email ?? null, member.status],
    );
  }

  private async upsertCurrentMembership(db: DatabaseExecutor, tenantId: string, userId: string, orgUnitId: string, positionId?: string, isManager = false) {
    const updated = await db.query(
      "UPDATE memberships SET org_unit_id=$3,position_id=$4,is_manager=$5,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND ends_at IS NULL RETURNING id",
      [tenantId, userId, orgUnitId, positionId ?? null, isManager],
    );
    if (updated.length === 0) {
      await db.query(
        "INSERT INTO memberships(id,tenant_id,user_id,org_unit_id,position_id,is_manager,starts_at,ends_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,now(),NULL,now(),now())",
        [crypto.randomUUID(), tenantId, userId, orgUnitId, positionId ?? null, isManager],
      );
    }
  }
}
