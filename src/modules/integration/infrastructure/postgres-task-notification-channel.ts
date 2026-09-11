import type { ChannelPreference, ChannelPreferenceRepository, ChannelProvider, QuietHours } from "@/src/modules/integration/application/channel-preferences";
import type { ChannelRecipientDirectory, ChannelTarget, ChannelPreferenceDirectory, TaskNotificationCandidate, TaskNotificationChannelSource, TaskNotificationKind } from "@/src/modules/integration/application/task-notification-channel";
import type { ExternalProvider } from "@/src/modules/identity/domain/entities";
import type { TransactionalDatabase } from "@/src/platform/database/executor";

type PreferenceRow = {
  user_id: string; ordered_providers: unknown; quiet_hours: unknown; digest_enabled: boolean; updated_at: string;
};

function mapPreference(tenantId: string, row: PreferenceRow): ChannelPreference {
  const providers = Array.isArray(row.ordered_providers) ? row.ordered_providers.filter((value): value is ChannelProvider => typeof value === "string") : [];
  return {
    tenantId,
    userId: row.user_id,
    orderedProviders: providers.length ? providers : ["web"],
    quietHours: (row.quiet_hours && typeof row.quiet_hours === "object" ? row.quiet_hours : {}) as QuietHours,
    digestEnabled: row.digest_enabled !== false,
    updatedAt: row.updated_at,
  };
}

export class PostgresChannelPreferenceRepository implements ChannelPreferenceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async list(tenantId: string, userIds: string[]) {
    const result = new Map<string, ChannelPreference>();
    if (!userIds.length) return result;
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<PreferenceRow>(
        `SELECT user_id::text, ordered_providers, quiet_hours, digest_enabled, updated_at::text
         FROM channel_preferences WHERE tenant_id=$1 AND user_id = ANY($2::uuid[])`,
        [tenantId, userIds],
      );
      for (const row of rows) result.set(row.user_id, mapPreference(tenantId, row));
      return result;
    });
  }

  async get(tenantId: string, userId: string) {
    const listed = await this.list(tenantId, [userId]);
    return listed.get(userId) ?? null;
  }

  async upsert(preference: ChannelPreference) {
    await this.database.withTenant(preference.tenantId, async (executor) => {
      await executor.query(
        `INSERT INTO channel_preferences(tenant_id,user_id,ordered_providers,quiet_hours,digest_enabled,updated_at)
         VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET ordered_providers=EXCLUDED.ordered_providers,
           quiet_hours=EXCLUDED.quiet_hours, digest_enabled=EXCLUDED.digest_enabled, updated_at=EXCLUDED.updated_at`,
        [preference.tenantId, preference.userId, JSON.stringify(preference.orderedProviders), JSON.stringify(preference.quietHours), preference.digestEnabled, preference.updatedAt],
      );
    });
    return preference;
  }
}

export class PostgresTaskNotificationChannelSource implements TaskNotificationChannelSource {
  constructor(private readonly database: TransactionalDatabase) {}

  async listRecent(input: { tenantId: string; sinceIso: string; limit: number }): Promise<TaskNotificationCandidate[]> {
    const limit = Math.min(Math.max(input.limit, 1), 500);
    return this.database.withTenant(input.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string; recipient_id: string; kind: TaskNotificationKind; title: string; body: string; package_id: string; created_at: string }>(
        `SELECT id::text, recipient_id::text, kind, title, body, package_id::text, created_at::text
         FROM work_task_notifications
         WHERE tenant_id=$1 AND created_at >= $2
         ORDER BY created_at ASC, id ASC LIMIT $3`,
        [input.tenantId, input.sinceIso, limit],
      );
      return rows.map((row) => ({
        id: row.id, recipientId: row.recipient_id, kind: row.kind, title: row.title, body: row.body,
        packageId: row.package_id, createdAt: row.created_at,
      }));
    });
  }
}

/**
 * 收件人 → 可用的外部通道。只认"身份已验证 + 连接处于 active"的绑定：
 * 未验证的身份、停用/吊销的连接都不投递（失败关闭，不猜）。
 */
export class PostgresChannelRecipientDirectory implements ChannelRecipientDirectory {
  constructor(private readonly database: TransactionalDatabase) {}

  async resolve(tenantId: string, recipientIds: string[], providers?: readonly ExternalProvider[]) {
    const result = new Map<string, ChannelTarget[]>();
    if (!recipientIds.length) return result;
    const allowed: ExternalProvider[] = providers ? [...providers] : ["feishu", "dingtalk", "wecom"];
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{ user_id: string; provider: ExternalProvider; connection_id: string; external_subject_id: string }>(
        `SELECT identity.internal_subject_id::text AS user_id, identity.provider, identity.connection_id::text, identity.external_subject_id
         FROM external_identities identity
         JOIN connections connection ON connection.tenant_id = identity.tenant_id AND connection.id = identity.connection_id
         WHERE identity.tenant_id=$1 AND identity.internal_subject_id = ANY($2::uuid[])
           AND identity.subject_type='user' AND identity.internal_subject_type='user'
           AND identity.status='verified' AND connection.status='active'
           AND identity.provider = ANY($3::text[])
         ORDER BY identity.provider, identity.created_at`,
        [tenantId, recipientIds, allowed],
      );
      for (const row of rows) {
        const list = result.get(row.user_id) ?? [];
        list.push({ provider: row.provider, connectionId: row.connection_id, externalUserId: row.external_subject_id });
        result.set(row.user_id, list);
      }
      return result;
    });
  }
}

/** 外部通道投递只关心"偏好顺序 + 免打扰"，因此与 HTTP 侧共用同一张表与同一个仓储。 */
export class PostgresChannelPreferenceDirectory implements ChannelPreferenceDirectory {
  private readonly repository: PostgresChannelPreferenceRepository;
  constructor(database: TransactionalDatabase) {
    this.repository = new PostgresChannelPreferenceRepository(database);
  }
  async list(tenantId: string, userIds: string[]) {
    return this.repository.list(tenantId, userIds);
  }
}
