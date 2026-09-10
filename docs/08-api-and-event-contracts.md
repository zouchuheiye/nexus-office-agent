# 08 API 与事件契约

## 1. API 约定

基础路径：`/api/v1`。所有响应携带 `traceId`，错误使用稳定 code，不把内部异常和供应商响应原样返回。

### 1.1 请求上下文

服务端从会话推导：

```ts
type RequestContext = {
  tenantId: string;
  actorId: string;
  sessionId: string;
  channel: "web" | "feishu" | "dingtalk" | "wecom";
  traceId: string;
  policyContext: PolicyContext;
};
```

客户端不得指定 tenantId 或冒充 actorId。

### 1.2 错误格式

```json
{
  "error": {
    "code": "POLICY_DENIED",
    "message": "你没有执行此操作的权限",
    "details": {},
    "retryable": false
  },
  "traceId": "..."
}
```

### 1.3 写操作

- 支持 `Idempotency-Key`。
- 使用 `If-Match` 或 version 进行并发控制。
- R3/R4 动作返回 proposal，不直接执行。

## 2. 主要资源 API

```text
/session /me /organizations /users
/objectives /key-results /metrics
/portfolios /projects /milestones /tasks
/risks /issues /decisions /action-items
/meetings /documents /knowledge/search
/process-definitions /process-instances /approvals
/agent/runs /agent/proposals /confirmations
/agent/proposals/:id /agent/proposals/:id/confirm /agent/proposals/:id/amend
/integrations /integrations/:id/sync /integrations/:id/health
/notifications /inbox
/task-command/workspace /task-command/board /task-command/people
/task-command/missions /task-command/packages /task-command/templates /task-command/message-pools/messages
/task-command/templates/:id
/task-command/packages/:id/claim /task-command/packages/:id/transition /task-command/packages/:id/handoffs
/task-command/packages/:id/timeline /task-command/handoffs/:id/response
/task-command/packages/:id/subtasks /task-command/packages/:id/subtasks/:subtaskId
/task-command/notifications /task-command/notifications/:id/read /task-command/notifications/read-all
/task-command/reports/export /task-command/events
/organization/members /organization/members/:id /organization/members/:id/reactivate
/auth/development-identities /auth/development-identities/switch
/admin/policies /admin/audit /admin/models
```

`GET /api/v1/task-command/board` 返回当前身份可见的任务、成员负载、使命与组织单元，作为任务看板、表格与筛选的单一授权数据源。`GET /api/v1/task-command/people` 返回成员负载只读视图。`GET /api/v1/task-command/reports/export` 复用该数据源并按 `scope=all|mine|published`、`status`、`overdueOnly`、`assigneeId`、`missionId`、`from/to` 过滤导出，行内容与页面筛选项一致。

开发/内网验证身份仅在本机开发或显式开启 `NEXUS_ALLOW_DEMO_IDENTITY` 时提供：`GET /auth/development-identities` 列出服务端定义的可选身份（不含权限明细），`POST /auth/development-identities/switch` 用 `key` 签发已签名会话 Cookie。关闭或未开启时二者分别返回 `403 DEMO_IDENTITY_DISABLED` 与 `503 DEMO_IDENTITY_SECRET_MISSING`，不会退化为任意扮演。

任务推进 `POST /packages/:id/transition` 是验收闭环的唯一写通道，接受 `expectedVersion/nextStatus`，并按目标状态要求 `evidenceRefs`、`blockedReason` 或验收退回原因 `reviewNote`。从 `in_review` 离开时只有发布人或管理员能决定 `completed`（通过，payload 记 `decision=accept`）或退回 `in_progress`（payload 记 `decision=reject` 与 `reviewNote`，退回原因至少 4 字）；执行人不可自我验收，AI 只能起草意见、不能代为通过/退回。

任务时间门禁：发布（`POST /missions`）时任务包的 `dueAt` 必须晚于开始时间，也必须晚于当前时间——数据库约束是 `due_at > created_at`，也就是"逾期任务只能随实际时间推移产生，不能在发布时直接写成过去时间"；违反时返回 `422 WORK_PACKAGE_DUE_AT_IN_PAST`（或开始时间不早于截止时间时的 `422 WORK_INVALID_TIME_RANGE`），而不是此前的 500。

任务包子任务（P3）：`GET /packages/:id/subtasks` 只读列出子任务与进度 `{done,total}`；`POST /packages/:id/subtasks` 新增（发布人/承接人/管理员可拆，`title` 2–160 字，每条记 `createdBy`）；`PATCH /packages/:id/subtasks/:subtaskId` 勾选 `done=true`（可带完成说明 `note` 与可核验 `evidenceRefs`，证据格式同任务验收）或重新打开 `done=false`；`DELETE /packages/:id/subtasks/:subtaskId?expectedVersion=` 删除。三条写操作都要求子任务版本 CAS（冲突返回 `409 WORK_PACKAGE_SUBTASK_CONFLICT`），并把 `package_progress_updated` 事件（payload `action` 为 `subtask_created/subtask_completed/subtask_reopened/subtask_deleted`）追加进任务事件链。锁定期规则：任务进入 `in_review/completed/cancelled` 后禁止新增/勾选/删除子任务（`409 WORK_PACKAGE_SUBTASKS_LOCKED`），发布人退回 `in_progress` 后恢复；若任务已拆分且存在未完成子任务，`in_progress → in_review` 被拦截（`409 WORK_PACKAGE_SUBTASKS_PENDING:done/total`）。子任务写通道同样只对负责人/发布人开放，AI 经 `work.add_package_subtask`/`work.update_package_subtask` 只能生成 R3 待确认提案、不能直接改状态。

成员管理（员工目录）：`GET /organization/members` 返回在职成员目录（成员+部门+岗位+状态+邮箱）与可选部门/岗位（`orgUnits`/`positions`）以及当前主体是否可管理（`canManage`），读取需 `organization_member:read`；`?includeDeparted=true` 连已停用成员一起返回，但**该参数仅对 `organization_member:admin` 生效**——普通成员默认只见在职同事，显式索取离职名单返回 `403 ACCESS_DENIED`（不静默降级，便于发现越权）。`POST /organization/members` 新增成员（`displayName`、可选 `email/orgUnitId/positionId/isManager`）；`PATCH /organization/members/:id` 按 `expectedVersion` 编辑资料/任职；`DELETE /organization/members/:id?expectedVersion=` 软停用（不物理删，保留 users 行、历史任务与审计），并在同一事务内到期角色授权、撤销委托、客户端设备与外部身份；`POST /organization/members/:id/reactivate` 重新启用（`expectedVersion`，可选 `orgUnitId/positionId/isManager`，留空沿用停用前任职），只恢复在职与任职，不自动恢复停用时收回的角色授权/委托/设备/外部身份。写操作需 `organization_member:admin`（开发白名单仅管理员持有；正式环境由授权解析器预置）。邮箱同租户唯一（`MEMBER_EMAIL_TAKEN`）、岗位必须属于所选部门（`MEMBER_POSITION_ORG_MISMATCH`）、旧版本写入（`MEMBER_VERSION_CONFLICT`）、不能停用自己（`MEMBER_SELF_DEACTIVATE_DENIED`）、仍有进行中任务的成员不能停用（`MEMBER_HAS_ACTIVE_WORK`，需先完成或交接）、非停用成员不能重新启用（`MEMBER_NOT_DEPARTED`）、目标部门已归档不能恢复（`MEMBER_ORG_NOT_ACTIVE`）、非管理员查看离职名单（`POLICY_DENIED:organization_member:admin` → 403）。写入 users/memberships 由 0001 RLS 与 0009 原子审计触发器兜底，变更即时反映到任务工作区的人员/负载与授权解析。

R3 提案（可编辑预览卡）：`GET /agent/proposals/:id` 返回本人可见的提案结构（含工具输入）；`POST /agent/proposals/:id/amend`（`proposalHash + input`）把人修正后的输入重新解析为一份新提案，并把原提案作废为 `revoked`——R3 提案本身不可篡改，只有新提案可被确认执行。无实际变更返回 `409 PROPOSAL_AMEND_NO_CHANGE`，非本人或非 pending 提案无法 amend，版本漂移在 amend 时同样拦截。

站内通知（P4）：`GET /task-command/notifications?unreadOnly=&limit=` 返回当前主体自己的通知与未读数（`{notifications, unreadCount}`，收件人恒为会话身份，**不接受客户端指定他人**，`limit` 1–100 默认 30）；`POST /task-command/notifications/:id/read` 标记本人一条已读（幂等，不覆盖更早的 `read_at`）；`POST /task-command/notifications/read-all` 一键把本人未读清空。读取需 `work_task:read`。九类通知来自任务链路的真实事件——`task_assigned`（定向分派给某人）、`task_claimed`（公开承接被他人领取，通知发布人）、`handoff_requested`（待对方签收）、`handoff_responded`（签收/退回/撤回结果）、`review_requested`（待发布人验收）、`review_decided`（验收通过或被退回，退回原因进正文），以及常驻调度器产生的 `task_due_soon`/`task_overdue`/`task_blocked`（临期、逾期、阻塞升级；见 docs/18 §4.4）；操作人等于收件人时不产生通知，`open_claim` 只挂部门池没有收件人时也不产生通知，子任务勾选不通知（避免噪声）。前六类通知与业务变更、`work_task_events` 审计事件在**同一租户事务**内写入：版本 CAS 冲突或校验失败时既不写事件也不写通知；后三类由后台扫描产生，没有对应的任务事件行，改用 `日期+任务+类型+收件人` 的确定性 `source_event_id` 落到唯一索引上做幂等。定时提醒以 `actor_type/kind='system'`、`actor_id` 为空写入（`work_task_notifications.actor_type`、`work_pool_messages.author_type`、`work_message_events.actor_type`），`CHECK ((actor_type='user') = (actor_id IS NOT NULL))` 保证"系统署名不挂真人、真人署名必须有 ID"。越权（他人通知 ID）与不存在统一返回 `404 WORK_NOTIFICATION_NOT_FOUND`，不泄露存在性。`GET /task-command/workspace` 的载荷同时携带 `notifications`（本人最近 30 条）与 `unreadNotificationCount`，客户端据此渲染未读角标，不需要额外轮询接口。Agent 侧只提供只读工具 `work.list_my_notifications`（R0，无确认），不提供任何通知写工具。

会议确认转化的决定保存 `sourceMeetingId`，服务端校验来源会议和决定属于同一租户、同一项目；行动项通过 `decisionId` 关联该决定。知识搜索只返回当前已生效且未过期版本，并在引用中返回原始 `sourceRef`、版本定位、有效时间和不泄露 ACL 明细的 `accessBasis`。

## 3. Agent API

### 创建运行

`POST /api/v1/agent/runs`

输入包含 message、contextRefs 和 clientRequestId；服务端解析身份与权限。返回 runId 和流式事件地址。

主工作对话调用还包含 `conversationId`，用户消息、Agent 最终答复和实际 Skill/Tool 路由会幂等写回该会话。

### 运行事件

- run.started
- retrieval.completed
- response.delta
- proposal.created
- confirmation.required
- tool.started
- tool.completed
- run.completed
- run.failed

### 确认

`POST /api/v1/agent/proposals/:id/confirm`

必须携带 proposalHash；服务端重新校验权限、策略、对象版本和有效期。成功返回 `202 Accepted`、唯一 `jobId` 和状态查询地址，只创建持久化 Agent Tool Job，不同步执行工具。重复确认返回同一任务；执行前 Worker 再次鉴权。

## 4. 领域事件

```ts
type DomainEvent<T> = {
  id: string;
  type: string;
  version: number;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  actor: { type: "user" | "agent" | "system"; id: string };
  traceId: string;
  causationId?: string;
  correlationId?: string;
  payload: T;
};
```

首期事件：

- objective.activated / objective.status_changed
- project.approved / project.status_changed
- milestone.at_risk
- risk.identified / risk.realized / risk.closed
- decision.decided / decision.superseded
- action_item.assigned / action_item.overdue / action_item.completed
- approval.requested / approval.decided
- meeting.record_confirmed
- integration.event_received / integration.sync_failed
- agent.proposal_created / agent.action_executed
- work.mission_published / work.package_published / work.package_claimed / work.package_status_changed / work.package_progress_updated

子任务相关事件 `package_progress_updated` 的 payload：`action`（`subtask_created|subtask_completed|subtask_reopened|subtask_deleted`）、`subtaskId`、`title`，完成类动作带 `done/note/evidenceRefs`。工作区任务对象附带聚合后的 `progress:{done,total}`，与 `package_progress_updated` 事件一一对应。

## 5. 事件兼容

- 事件只追加字段，不改变既有字段语义。
- 破坏性变化提升 version，并保留旧消费者过渡期。
- 消费者忽略未知字段。
- Schema 存放在代码仓并通过契约测试验证。

## 6. Outbox/Inbox

业务事务写 aggregate 和 outbox 同一事务。Dispatcher 使用租约领用，并以 eventId 写入唯一发布回执；消费者使用 eventId 写 inbox 去重。失败按类型进入有限重试、结果未知或死信，旧租约令牌不能提交终态。完整协议见 [持久化执行设计](./16-durable-runtime.md)。

## 7. Webhook 处理

接入路由：

```text
/api/integrations/feishu/events
/api/integrations/dingtalk/events
/api/integrations/wecom/events
```

公开路由只做连接绑定、协议验证、大小限制、HTTP replay claim、完整统一事件信封的 Inbox 幂等持久化和 ACK，不执行模型推理或复杂业务。平台长连接事件复用标准化与 Inbox 层，不使用 HTTP replay claim。Replay claim 记录首次接收时间；若后续 Inbox 持久化失败，平台重试必须使用该时间重新生成稳定事件 ID 并重试 Inbox。数据库首次持久化失败时不得返回成功 ACK；只有 Inbox 已存在的合法 duplicate 才返回平台成功 ACK，同时报告 duplicate 且不得重复入队。

## 8. Deep Link

平台卡片链接只传内部 opaque reference，不传敏感业务值。打开网页后重新认证、授权并读取最新状态。确认动作不能只依赖 Deep Link 参数。

## 9. 管理智能中枢 API 与事件

M12 的完整资源 API 见 [17 管理智能中枢](./17-management-intelligence-web-wecom.md)。新增领域事件包括：

- `management_cadence.created`
- `cadence_occurrence.prepared` / `cadence_occurrence.status_changed`
- `metric_semantic_profile.updated` / `metric_quality.checked`
- `portfolio_scenario.created` / `portfolio_scenario.selected`
- `enterprise_case.created` / `enterprise_case.status_changed`
- `ai_governance.evaluated`
- `management_channel_action.created` / `management_channel_action.executed`

所有写 API 仍使用请求上下文推导租户和主体、以版本拒绝丢失更新，并通过与业务事实相同的数据库事务追加 Outbox 事件。
