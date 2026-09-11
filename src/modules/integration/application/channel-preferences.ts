import { z } from "zod";
import type { RequestContext } from "@/src/platform/context/request-context";

/**
 * P4（外部通道）：**用户自己的**通知通道偏好。
 *
 * 表结构在 `0004_connector_platform.sql` 里早就有了（`channel_preferences`：`ordered_providers`、
 * `quiet_hours`、`digest_enabled`），但一直没有读写路径。本模块把它接起来，语义是：
 * - `ordered_providers` 是**投递顺序**，也是**opt-in 名单**：默认 `["web"]` 表示只发站内，
 *   用户显式加上 `feishu`/`dingtalk`/`wecom` 之后，外部通道才会给他发消息。
 * - `quiet_hours` 是免打扰窗口（`{ start, end, timezoneOffsetMinutes }`，支持跨午夜）；
 *   命中的通知本轮不投递，留在扫描窗口里等下一轮。
 * - `digest_enabled` 目前只做透传保留（站内任务通知里还没有"摘要类"收件人语义），
 *   避免以后加字段又要改一遍契约。
 *
 * 边界：偏好**只作用于本人**（`context.actorId`），没有"管理员替别人设通道"的入口——
 * 外部通道属于个人隐私与打扰面，不接受代设。
 */
export const CHANNEL_PROVIDERS = ["web", "feishu", "dingtalk", "wecom"] as const;
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

export type QuietHours = { start?: string; end?: string; timezoneOffsetMinutes?: number };

export type ChannelPreference = {
  tenantId: string;
  userId: string;
  orderedProviders: ChannelProvider[];
  quietHours: QuietHours;
  digestEnabled: boolean;
  updatedAt: string;
};

export const DEFAULT_CHANNEL_PREFERENCE = { orderedProviders: ["web"] as ChannelProvider[], quietHours: {} as QuietHours, digestEnabled: true };

export const channelPreferenceInputSchema = z.object({
  orderedProviders: z.array(z.enum(CHANNEL_PROVIDERS)).min(1).max(CHANNEL_PROVIDERS.length),
  quietHours: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "免打扰开始时间必须是 HH:MM。"),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "免打扰结束时间必须是 HH:MM。"),
    timezoneOffsetMinutes: z.number().int().min(-720).max(840).optional(),
  }).nullable().optional(),
  digestEnabled: z.boolean().optional(),
}).strict();

export type ChannelPreferenceInput = z.infer<typeof channelPreferenceInputSchema>;

/**
 * 服务层入参：比 HTTP 的 zod 契约更宽松（`quietHours` 允许只给一半），
 * 因为"开始/结束必须成对"这条业务规则由服务显式判定并给出专门错误码，
 * 而不是靠 schema 的字段必填糊过去。
 */
export type ChannelPreferenceUpdate = {
  orderedProviders: ChannelProvider[];
  quietHours?: QuietHours | null;
  digestEnabled?: boolean;
};

export interface ChannelPreferenceRepository {
  list(tenantId: string, userIds: string[]): Promise<Map<string, ChannelPreference>>;
  get(tenantId: string, userId: string): Promise<ChannelPreference | null>;
  upsert(preference: ChannelPreference): Promise<ChannelPreference>;
}

export class InMemoryChannelPreferenceRepository implements ChannelPreferenceRepository {
  private readonly preferences = new Map<string, ChannelPreference>();
  async list(tenantId: string, userIds: string[]) {
    const result = new Map<string, ChannelPreference>();
    for (const userId of userIds) {
      const value = this.preferences.get(`${tenantId}:${userId}`);
      if (value) result.set(userId, structuredClone(value));
    }
    return result;
  }
  async get(tenantId: string, userId: string) {
    return structuredClone(this.preferences.get(`${tenantId}:${userId}`) ?? null);
  }
  async upsert(preference: ChannelPreference) {
    this.preferences.set(`${preference.tenantId}:${preference.userId}`, structuredClone(preference));
    return structuredClone(preference);
  }
}

export type ChannelPreferenceView = {
  orderedProviders: ChannelProvider[];
  quietHours: QuietHours;
  digestEnabled: boolean;
  updatedAt: string | null;
  /** 是否已显式设置过（false 表示返回的是默认值，外部通道不会被开启）。 */
  configured: boolean;
  availableProviders: readonly ChannelProvider[];
};

function normalizeProviders(values: ChannelProvider[]): ChannelProvider[] {
  const unique = [...new Set(values)];
  if (!unique.length) throw new Error("CHANNEL_PREFERENCE_PROVIDERS_REQUIRED");
  return unique;
}

export class ChannelPreferenceService {
  constructor(
    private readonly repository: ChannelPreferenceRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(context: RequestContext): Promise<ChannelPreferenceView> {
    const current = await this.repository.get(context.tenantId, context.actorId);
    return this.view(current);
  }

  /** 只写本人偏好：忽略任何试图指定他人的入参（schema 是 strict 的，多余字段直接 422）。 */
  async update(context: RequestContext, input: ChannelPreferenceUpdate): Promise<ChannelPreferenceView> {
    const current = await this.repository.get(context.tenantId, context.actorId);
    const quietHours = input.quietHours === null ? {} : input.quietHours ?? current?.quietHours ?? {};
    if ((quietHours.start && !quietHours.end) || (!quietHours.start && quietHours.end)) throw new Error("CHANNEL_PREFERENCE_QUIET_HOURS_INCOMPLETE");
    const next: ChannelPreference = {
      tenantId: context.tenantId,
      userId: context.actorId,
      orderedProviders: normalizeProviders(input.orderedProviders),
      quietHours,
      digestEnabled: input.digestEnabled ?? current?.digestEnabled ?? DEFAULT_CHANNEL_PREFERENCE.digestEnabled,
      updatedAt: this.now().toISOString(),
    };
    await this.repository.upsert(next);
    return this.view(next);
  }

  private view(preference: ChannelPreference | null): ChannelPreferenceView {
    return {
      orderedProviders: preference?.orderedProviders ?? [...DEFAULT_CHANNEL_PREFERENCE.orderedProviders],
      quietHours: preference?.quietHours ?? { ...DEFAULT_CHANNEL_PREFERENCE.quietHours },
      digestEnabled: preference?.digestEnabled ?? DEFAULT_CHANNEL_PREFERENCE.digestEnabled,
      updatedAt: preference?.updatedAt ?? null,
      configured: Boolean(preference),
      availableProviders: CHANNEL_PROVIDERS,
    };
  }
}
