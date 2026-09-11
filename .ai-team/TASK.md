# Current Task

- ID: `MVP-FIX`
- Title: `枢纽任务管理 MVP 缺陷修复（P0–P5 计划执行）`
- Status: `handoff`
- Owner: `MVP-FIX`
- Next owner: `P01`

## Goal

在 fork 分支（基线 commit 6835699 + 后续合并）上，按《枢纽任务管理 MVP：现状评估·缺陷·产品设想·改造计划》的缺陷清单与 P0–P5 改造计划，逐批修复任务管理 MVP 缺陷并形成可提交里程碑。产品方向为 Everything to Agent——一切改变业务状态的动作仍由 Agent 承载、人在对话内确认；本任务补齐 Agent 体验工程、多人身份、表单/直连通道、可编辑预览与浏览视图，并坚守“验收通过/退回永不自动、AI 只读意见”的自动化边界。

## Acceptance scenarios

- [x] P0：任务进度页在看板之外提供表格视图，任务表列含标题、使命/项目、负责人、部门、状态、开始、工期、截止、到期态、容量点，并在存在 `missingFields` 的任务上显示待补充列。
- [x] P0：任务表支持按范围（全部/我负责/我发布）、负责人、使命/项目、状态、仅逾期过滤，并按到期态/截止时间稳定排序；导出复用 `GET /reports/export`，服务端按相同过滤参数返回，页面与导出口径一致。
- [x] P0：看板、表格、筛选与聚合只读取 `/task-command/board` 单一授权数据源（board-client 统一入口），各组件不再各自重复拉取；视图注册进 office-shell 的 viewRenderers。
- [x] P0：进度总览第一版按“进行/待验收/完成/逾期/容量点”与成员负载行展示，不包含完成率（与 P3 解耦）。
- [x] P1：服务端定义多开发身份（开发管理员 + 周然等 3 名演示人员），以签名会话 Cookie 支持“选人登录”式切换；生产未显式开启 `NEXUS_ALLOW_DEMO_IDENTITY` 时接口失败关闭，不暴露权限明细。
- [x] P1：切换身份后 workspace/board/bootstrap 均按所选身份解析，“我的/我发布/待承接/待交接”与任务表按人隔离可验证；主对话与任务栏随身份重建。
- [x] P1：开发身份切换不影响正式 OIDC（Authorization Code + PKCE）路径；正式身份接入待企业 IdP 确认，不阻塞本批验证。
- [x] P2：提交验收直连按钮（证据对话框：URL/文档 ID/交付说明，至少一条或复用既有证据），无证据仍由服务端拒绝（`WORK_REVIEW_EVIDENCE_REQUIRED`）；AI 起草证据仍可经对话作为可选辅助。
- [x] P2：验收通过/退回直连按钮——通过为轻确认（`decision=accept`），退回强制填原因（`reviewNote` ≥4 字，`decision=reject`）；服务端限定只有发布人/管理员能离开 `in_review`，执行人不可自我验收，AI 不能代为通过/退回。
- [x] P2：发起交接支持 AI 起草结构化交接单 + 可编辑预览卡：AI 起草仍走 Agent 生成 R3 提案，「修正草稿」以 amend 编辑交接单字段（交接对象/说明/当前进度/已完成/未完成/注意点/交付物引用等 tool input 逐字段可改）并生成需再次确认的新提案；直连“发起交接”表单通道保留。
- [x] P2：发布任务提供表单录入入口（任务栏“发布任务”按钮 + 表单对话框：使命标题/目标/优先级/截止 + 1..N 任务包：定向或开放承接、负责人/部门、说明/验收/技能/工期/容量点）；服务端复用 `POST /missions`（human），缺省字段仍标记“待补充”，口述走 AI 的既有通道保留。
- [x] P2：AI 起草的提案卡升级为可编辑预览卡——服务端 amend/supersede（`GET/POST /api/v1/agent/proposals/:id[/amend]`）已实现并通过单元/集成测试；网页对话提案卡新增「修正草稿」：读取结构化输入、按字段编辑（标量/日期/字符串数组用输入框，嵌套结构用 JSON 子编辑器）、保存后旧提案作废、生成需再次确认的新提案。
- [x] P3（第一批，按第六节推荐值）：任务包子任务拆分/勾选/重开/删除 + 进度 done/total + 验收门禁 + AI 只起草勾选建议（R3 确认）。
- [x] 成员管理（员工目录，用户确认补入口）：并入“组织与人才”页，管理员（开发管理员，`organization_member:admin`）可新增成员、编辑姓名/邮箱/部门/岗位/是否负责人、软停用员工（设 users.status+archived_at、结束现行任职，不物理删、保留历史与审计）；`organization_member:read` 允许查看（各演示身份）。
- [x] 员工入职登记 Agent 通道（用户要求“把名字打上就好”）：会话内新增 `organization.list/add/update/deactivate_member` 与 `organization-member-directory` Skill；登记只要求姓名、部门/岗位/邮箱可留空后补，只建名册不授予角色权限，停用/离职仍需人工确认；同时修复工具可见性（意图过滤白名单未含新技能）与工具入参不合规导致整轮 422 的通用缺陷；真实会话已登记新员工“张三”（部门/岗位待补充）。
- [x] 停用员工不得再进入枢纽 Agent（用户要求）：新增平台级在职校验（有库查 `users.status/archived_at`，内存夹具用标记）；开发验证身份下停用者的旧会话 401 且不回退为默认管理员、切换列表移除该身份、切换返回 `403 DEMO_IDENTITY_INACTIVE`；停用同一事务收回 `user_roles`/`delegations`/`client_devices`/`external_identities`；软删除仍保留档案与历史审计。
- [x] 成员重新启用（用户要求）：`GET /organization/members?includeDeparted=true` 列出已停用成员，`POST /organization/members/:id/reactivate` 恢复在职并重建现行任职（部门/岗位/负责人可指定、留空沿用停用前设置，版本 CAS）；成员管理页新增“已停用成员”分区与重新启用对话框；Agent 新增 `organization.reactivate_member`（R2 强制人工确认）；只恢复在职与任职，停用时收回的角色授权/设备/外部身份需另行授予或重新登录（已在界面与文档写明）。
- [x] project-to-act 台账强制门禁（用户要求"台账要一直写"）：`check.mjs --base` 在"改了代码/产品文件但 `.project-to-act/PROJECT_PROGRESS.md` 未更新"时判 blocked（与 TASK.md 同级）；AGENTS.md 固化"长期要求"章节（PROGRESS 每次必写，FEATURES/VERSIONS/ACCEPTANCE 按适用性同步）；新增门禁测试覆盖拦截与放行。
- [x] 离职名单仅管理员可见（用户要求“只有管理员能看到谁谁谁已离职”）：`includeDeparted=true` 收紧为 `organization_member:admin`，非管理员显式索取返回 `403 ACCESS_DENIED`（不静默降级），默认目录只含在职成员；成员管理卡片仅在 `canManage` 时补取已停用分区；Agent 工具 `organization.list_members` 增加 `includeDeparted` 入参并注明仅管理员可用。
- [x] P4 站内通知（改造计划 P4 最小版，用户要求继续 P4）：`work_task_notifications`（0049 迁移）+ 六个触发点（定向分派/公开承接被领取/交接发起/交接签收退回撤回/提交验收/验收通过退回）在与业务变更同一事务内通知当事人，收件人等于操作人、部门池公开承接、子任务勾选均不通知；`GET /task-command/notifications`、`POST /notifications/:id/read`、`POST /notifications/read-all` 只作用于本人（越权与不存在统一 404）；workspace 载荷带 `notifications` + `unreadNotificationCount`；工作台右栏「通知」页签 + 顶栏全局未读铃铛；Agent 侧仅只读工具 `work.list_my_notifications`。不含外部通道/Web Push/偏好设置/留存清理。
- [x] P4 第二半：提醒挂常驻调度 + 以「系统」署名 + 提醒到人（用户确认"以系统署名"）。新增 Durable Worker 角色 `task-reminder`（活跃租户枚举 + 心跳 + SIGTERM 排空 + 按租户间隔节流 + 重叠保护），`0050` 迁移放宽 `worker_heartbeats.role` 并为池消息/通知/消息事件增加 `author_type`/`actor_type` 与署名- ID 互斥约束；`runScheduledReminderScan` 系统入口以 `system` 署名写池消息/通知/事件并直达负责人（阻塞升级同时到发布人），重复扫描由确定性 ID 幂等；`scripts/task-reminder.ts` 改为复用同一入口并默认遍历活跃租户（移除 `--watch`）。
- [x] P4 第二半收尾：周期摘要并入常驻调度（用户要求"把这半收干净"）。`generateScheduledSummary({ tenantId, scope })` 生成**租户级**日报/周报（在办按状态分布、逾期/临期计数、本周期完成与取消、逾期最长三条），以 `system` 署名发公司消息池，消息 ID 由「作用域 + 周期」确定（`task-summary:tenant:{scope}:{periodKey}`）；worker 按周期键每周期只发一次（跨进程靠确定性 ID 兜底），`TASK_SUMMARY_SCOPE=daily|weekly`、`TASK_SUMMARY_ENABLED=false` 可配置/关闭；替换掉原来只服务脚本、用开发身份、把个人视图广播到公司池的 `generatePeriodicSummary`；`scripts/task-summary.ts` 改为同一系统入口并默认遍历活跃租户（移除 `--watch`）。
- [x] project-to-act 台账同步：本批 P0/P1/P2/P3、成员管理、入职登记、停用进入权、重新启用、台账门禁、离职名单可见性与 P4（站内通知 + 提醒常驻调度 + 周期摘要 + 端到端实测）已补记 `PROJECT_PROGRESS.md`（E-139～E-152）、`PROJECT_FEATURES.md`（F-091～F-103）、`PROJECT_VERSIONS.md` 与 `PROJECT_ACCEPTANCE.md`。
- [ ] P3 后续与 P4/P5 剩余项：子任务证据附件上传（决策点 6 补件）、通知的外部通道（飞书/钉钉/企微/短信/邮件）与 Web Push、通知偏好/免打扰/留存清理、token 级流式输出仍待产品排期（站内通知、提醒常驻调度、周期摘要、对话体验与纪要导入已完成，见 E-149～E-156）。

## Invariants

- 保持租户隔离、服务端权限重算、数据范围过滤和失败关闭；不得信任请求体自报的租户、身份、版本或设备可信状态。
- 验收通过/退回永不自动执行；高风险业务副作用只能经 Tool Registry、持久化提案和人工确认执行。
- 默认内存仓储只在未配置 `DATABASE_URL` 时启用；正式 PostgreSQL 路径不因本批改动降级。
- 不删除或弱化既有测试来消除失败；改动同步更新权威文档（docs/08、docs/18）与追踪证据。
- 代码、测试、文档、`.ai-team/TASK.md` 与 `.project-to-act/` 台账在同一提交/PR 中同步更新；不提交密钥、私人数据或运行产物。
- 员工名册写入只维护主数据，不授予角色、权限或账号能力（`identity-administration` 不向 Agent 开放）；入职登记只要姓名即可，停用/离职必须人工确认。
- 停用（软删除）即失去进入权：鉴权入口按在职状态判定，非在职主体的旧会话一律失败关闭且不降级为默认身份；停用同时收回角色授权、委托、设备与外部身份。重新启用只恢复在职与任职（可指定或沿用停用前任职），停用时收回的授权/设备/外部身份不自动回滚，需另行授予或重新登录。

## Decisions

- 按用户确认，本轮先收尾 P0（任务表+进度表视图）与 P1（多身份选人登录）为可提交里程碑，随后继续 P2 双通道补齐与 P3 子任务拆分/勾选；用户确认“成员管理”并入现有组织与人才页、管理员直改即时生效（软删除保留审计）、不改正式 IdP/授权语义（生产启用需另行预置权限，默认失败关闭）。
- 第六节待确认决策点按文档建议值执行：子任务双方可拆（P3）、提交验收一键确认、验证版选人登录 + 正式 OIDC 后置、进度口径先用状态+剩余天数+逾期、4B 模型档位、验收证据先做字符串格式约束后补附件上传。
- 成员管理属组织/员工主数据层（users/memberships/org_units/positions），由 0001 建表并强制 RLS、0009 原子审计兜底；任务工作区人员/负载与本目录同源，改动即时反映。
- P3 六项决策均按推荐执行：双方可拆（含承接人，记拆分人）；AI 只起草勾选建议、R3 待人工确认；有子任务时必须全部完成才能 in_review；in_review/completed/cancelled 后禁止增删改子任务、退回 in_progress 恢复；子任务两态 pending/done（可选完成说明与可核验证据）；进度 = done/total。
- 任务表/进度聚合的数据源统一收敛到 `/task-command/board`，避免页面口径与导出不一致；导出过滤参数（scope/status/overdueOnly）由 exportReportSchema 与导出路由同时承接。
- P1 身份切换以签名会话 Cookie 承载，服务端按 actorId 反查白名单身份重建权限集；演示身份不复制正式权限语义。

## Completed

- 复用与收尾了工作树中已具备的 P0 视图能力：任务进度页看板/表格双形态、负责人/使命/状态/仅逾期筛选、按使命与按人员聚合、成员负载行、筛选后导出。
- 任务表补齐 部门、开始、工期、到期态 与 待补充 列，BoardTask 类型补充 `missingFields` 可选字段，表格样式横向滚动列宽适配。
- board-client 收敛为单一 `/task-command/board` 授权读取；office-shell 的 viewRenderers 已注册任务进度与任务时间线视图。
- P1 多身份：`development-context` 定义 4 个开发身份（manager/delivery/product/operations），提供 `GET/POST /auth/development-identities[/switch]`；resolve-request-context 从签名 Cookie 反查身份，workspace-bootstrap 内存仓储按身份返回展示名。
- office-shell 增加开发验证身份切换器：切换后重签会话 Cookie、重置并重建主对话与任务栏上下文（WorkCommandCenter 按 actorId 重挂载），同身份重复切换守卫修正；身份列表仅在服务端开放时显示。
- P2 首批：任务栏“提交验收”改为直连按钮 + 证据对话框（复用既有证据或新增 URL/文档 ID），不再把 130+ 字指令注入对话；发布人“已发布/我的”视图中 in_review 任务提供“验收通过/退回”直连按钮（通过轻确认；退回对话框强制填原因）。
- P2 服务端 amend 底座：proposal 域新增 `supersedeProposal`（作废 pending 提案，reason=human_amended，记录被替代提案 ID）；orchestrator 新增 `amendProposal`（校验 actor/hash/pending、工具 schema 重新解析、无变更拒绝 `PROPOSAL_AMEND_NO_CHANGE`、版本漂移拦截、生成新提案并作废旧提案）；新增 `GET /agent/proposals/:id` 与 `POST /agent/proposals/:id/amend`，API 错误文案映射。单元 + 集成测试覆盖作废、防篡改、防空转、仅新提案可确认、非本人不可改。docs/08 契约同步。
- P2 前端可编辑预览卡：主对话与 Agent 侧栏的提案卡新增「修正草稿」按钮；`ProposalAmendEditor` 把 tool input 渲染成逐字段编辑器（标量/日期/数字/字符串数组用输入框，数组/对象用 JSON 子编辑器并就地校验），保存时调用 amend 并替换对话中的提案卡为待再次确认的新提案。office-shell / work-command-center / globals.css 同步，typecheck、零警告 lint、全量测试与生产构建通过（浏览器视觉验收待可用浏览器复核）。
- P2 发布任务表单入口：任务栏新增“发布任务”按钮与表单对话框（使命标题/目标/优先级/截止 + 1..N 任务包），POST 到既有 `/missions`（source=human）；直派/开放承接、负责人/部门选择复用 workspace people/orgUnits；缺省任务说明/验收/技能仍由服务端标记“待补充”，不阻断录入。新增 API 集成测试覆盖表单 payload 混合直派+开放包与“待补充”标记。
- P2 服务端边界：`transitionPackageSchema` 增补 `reviewNote`；从 `in_review` 离开到 `completed`（decision=accept）或退回 `in_progress`（decision=reject + reviewNote）只允许发布人或管理员，执行人自我验收返回 `POLICY_DENIED:work_task:review_decision`，退回无原因返回 `WORK_REVIEW_RETURN_REASON_REQUIRED`；决定与原因进入 `package_status_changed` 事件 payload。
- 新增开发身份 API 集成测试（列表/生产关闭/缺密钥/未知 key/轮换签名/跨租户伪造拒绝）与“切换后 bootstrap/board 解析为周然”的 P1 端到端覆盖；新增 P2 验收流转单测（执行人不可自我验收、发布人退回带原因入事件链、再提交后通过 decision=accept）；新增 F-086/P0 导出过滤测试。
- 时间线只读视图与历史接口沿用既有实现并随本批复核；相关文档（docs/08、docs/18）同步补充。
- P3 服务端：`work_package_tasks` 迁移 0048（+down，含事件类型扩展 `package_progress_updated`）；域模型新增子任务两态、进度聚合、CAS 版本、锁定/验收门禁（`WORK_PACKAGE_SUBTASKS_PENDING` / `WORK_PACKAGE_SUBTASKS_LOCKED`）；InMemory/Postgres 仓储新增 list/save/delete/进度聚合；服务新增 list/add/update/deletePackageSubtask 并把 `progress:{done,total}` 挂到工作区任务；路由 `GET/POST /packages/:id/subtasks` 与 `PATCH/DELETE /packages/:id/subtasks/:subtaskId`。
- P3 Agent 工具：`work.list_package_subtasks`（只读）、`work.add_package_subtask`/`work.update_package_subtask`（风险 2 + 确认策略 always → AI 只能生成 R3 提案，不直接改子任务状态）。
- P3 网页：任务卡新增子任务面板（折叠清单、勾选/重开/删除/新增、显示 done/total 与完成人/证据）；存在未完成子任务时“提交验收”按钮前置禁用并提示剩余项；提供“让 Agent 起草勾选建议”快捷预填；globals.css 配套样式。
- P3 测试与验证：单测新增 6 个场景（双方可拆且旁观者拒绝、完成/重开与证据门禁、in_review 锁定、workspace 进度暴露、Agent 工具注册与确认策略、schema 证据格式）；Postgres 集成测试覆盖落库、CAS 冲突、进度聚合与锁定期；本地开发库应用 0048 后 workspace 接口恢复 200。
- P3 HTTP 通道修复与回归：子任务 POST/PATCH 路由改为“先注入路径 packageId/subtaskId 再校验 body”（body 不再携带 id），并补 API 级路由测试（新增/勾选/列表/门禁/锁定全链路）；`applicationErrorResponse` 补 `_LOCKED` 类错误 → 409，保证 `WORK_PACKAGE_SUBTASKS_LOCKED` 不再落为 500。
- P1 身份切换缺陷修复：开发管理员（manager）权限集约 140 项，签发到签名会话 Cookie 后接近 5KB、超过浏览器单 Cookie ~4KB 上限，浏览器静默丢弃新 Cookie 导致切回管理员后仍停留旧身份（如周然）。已改为会话 Cookie 只承载最小身份标识（tenantId/actorId/channel/sessionId），roles/permissions/dataScopes 不再内嵌（服务端本就按 actorId 从白名单/授权解析器每请求重建权限，Cookie 快照从不被信任）；开发切换与 OIDC 回调两条签发通道同时瘦身，manager Cookie 由 ~4.96KB 降至 ~343B，并补“超 4KB 亦可被浏览器覆盖”的回归测试。
- 成员管理（员工目录）：`organization` 模块新增 member-directory 域（create/edit/deactivate 不变量）+ application service（`organization_member:read` 读、`organization_member:admin` 写；邮箱唯一/岗位归属部门/禁止停用自己/有进行中任务禁止停用）+ contracts/schemas；Postgres 与 InMemory 仓储（users/memberships/org_units/positions 读写，RLS+原子审计沿用）；runtime 与 HTTP 路由 `GET/POST /organization/members`、`PATCH/DELETE /organization/members/:id`；开发身份权限补 `organization_member:read/admin`（read 覆盖各演示身份）；`EnterpriseIntelligenceView` people 页并入“成员管理”卡片（目录列表 + 新增/编辑对话框 + 停用二次确认 + 仅管理员可见操作）；单测（域不变量、门禁、越权拒绝、自停用拦截）+ PGlite 集成（CRUD/RLS/审计/进行中任务保护/邮箱大小写唯一）。
- 员工入职登记 Agent 通道：新增 `src/modules/organization/application/member-directory-agent-tools.ts`（`organization.list_members` R0、`add_member`/`update_member` R1 直写、`deactivate_member` R2 强制确认）与 `organization-member-directory` Skill，接入 `agent/runtime`、技能目录与系统提示词；姓名放宽为唯一必填（域/schema/UI 同步，单字姓名合法），未知部门岗位留空；修复 `filterToolsByIntent` 核心技能白名单漏配新技能（工具在注入模型前被裁掉），以及工具入参不合规把整轮对话打成 422 的通用缺陷（改为回灌模型纠正重试，仅反复失败且从未执行时降级说明）；新增 `tests/unit/member-directory-agent-tools.test.ts`（注册/技能归属/权限可见性/仅姓名登记/岗位归属/版本 CAS/软停用与自停用拦截）。

## Pending

- P3（后续）/P4/P5 不在本批 MVP-FIX 交付范围：子任务证据附件上传（决策点 6 补件）、通知链路（分派/交接/验收主动通知与提醒脚本常驻调度）、体验细节（文案人话化、空态引导、流式/阶段提示、一键重试）按产品后续排期与文档第六节建议推进，本任务不替代产品决策。
- 成员管理正式化前置：`organization_member:admin/read` 目前只在开发白名单可用；正式环境需在 roles/permissions 预置对应权限与角色绑定（本次保持失败关闭），员工主数据仍以企业 IdP/授权目录为准。
- 入职登记后续可选项：目前只登记姓名（部门/岗位/邮箱留空）；如需“入职即带部门/岗位”“入职跟进任务自动创建”“新员工欢迎通知”，需产品确认后再立项（当前不自动造字段、不自动发消息）。
- 浏览器端视觉验收（表格视图、身份切换器、发布任务/验收/修正草稿对话框、子任务面板、成员管理卡片、时间线移动端布局）仍需可用浏览器环境；本机未安装浏览器驱动，已在 Verification 中如实标注。已用 Playwright 缓存 Chromium + 原生 CDP 覆盖：发布任务对话框两页签与纪要草稿（E-155）、对话空态引导（E-155）、通知页签与任务卡「承接/提交验收/验收通过」按钮（E-156）、子任务新增勾选重开删除 + 「取消」+ 交接「签收/退回」（E-157）；仍缺像素级视觉复核（当前模型不支持读图）与「发起交接」对话框、撤回交接、任务模板补充、时间线展开等交互的点击验证。

## Next step

P01 复核 MVP-FIX 的 P0/P1 快照、P2 双通道交付（提交验收/验收通过退回/发起交接/发布任务 + 表单发布入口 + 可编辑提案预览卡）、P3 子任务拆分/勾选（全部按推荐决策执行）、成员管理页（组织与人才 · 管理员新增/编辑/软停用）与员工入职登记 Agent 通道（仅姓名即可登记）并决定合并；P3 证据附件与 P4/P5 由产品按排期另行立项。

## Verification

- [x] `npm run typecheck`：exit 0。
- [x] `npm run lint`：exit 0（零警告）。
- [x] 全量测试 `npm test -- --maxWorkers=2`：exit 0（140 文件 602 passed / 26 skipped）。
- [x] P0 导出过滤单测、P1 身份切换集成测试、P2 验收流转单测（review_decision 边界 + reviewNote 事件审计）、P2 amend/supersede 单元与集成测试：通过。
- [x] P3 单测（双方可拆且旁观者拒绝、完成/重开与证据门禁、in_review 锁定、workspace 进度暴露、Agent 工具注册与 R3 确认策略、schema 证据格式）与 Postgres 集成测试（落库、CAS 冲突、进度聚合、锁定期）：通过。
- [x] 成员管理测试：域单测（创建/编辑/停用不变量与岗位归属校验）、服务单测（读门禁与 canManage、管理员增改停、越权拒绝、邮箱唯一、版本 CAS、禁止停用自己）、PGlite 集成（CRUD + RLS + users/memberships 审计 + 有进行中任务禁止停用 + 邮箱大小写不敏感唯一）：通过。
- [x] 员工入职登记测试：`tests/unit/member-directory-agent-tools.test.ts` 6 项（四个工具注册与技能归属、权限可见性、确认策略、仅姓名登记、岗位归属拒绝、资料补全与版本 CAS、软停用与自停用拦截）通过。
- [x] 停用进入权测试：`tests/integration/development-identity-gate.test.ts` 2 项（停用后旧会话 401 且不降级为管理员；停用身份从切换列表消失、切换 403 `DEMO_IDENTITY_INACTIVE`、其他在职身份不受影响）与 Postgres 集成“停用收回设备与角色授权”断言通过。
- [x] 重新启用测试：域/服务单测（仅停用可启用、版本 CAS、岗位归属、部门不存在、includeDeparted 可见性）、Agent 工具单测（R2 确认策略与预览、启用后不可重复启用）、Postgres 集成（状态恢复 + archived_at 清空 + 重建现行任职 + 留空沿用原部门岗位）、身份门禁补充用例（重新启用后旧会话恢复且可再次切换）：通过。
- [x] 离职名单可见性测试：服务单测（普通成员默认目录不含离职者、`includeDeparted=true` 被拒、管理员可见且状态为 departed）、Agent 工具单测（普通成员经 `organization.list_members` 同样拿不到）、新增 HTTP 契约测试 `tests/integration/organization-member-api.test.ts`（默认目录无离职者 / `?includeDeparted=true` → `403 ACCESS_DENIED` / 管理员 200 含 departed / 非管理员重新启用 403）：通过。
- [x] 站内通知测试：`tests/unit/task-notifications.test.ts` 9 项（六类触发点收件人与文案、自己操作不通知自己、部门池公开承接无收件人、验收退回原因进正文、标记已读幂等且不覆盖原时间、越权 404、全部已读只清本人、workspace 载荷、CAS 冲突不产生通知、子任务勾选不通知）、`tests/unit/work-notification-agent-tool.test.ts` 2 项（工具 R0/never 只读且属 work-orchestration、只返回本人通知）、PGlite 集成 1 项（同事务落库与 source_event_id 对齐、CAS 冲突不写事件与通知、越权 404、FORCE RLS/审计触发器/策略数）、新增 `tests/integration/task-notification-api.test.ts` 2 项（分派通知只对收件人可见并幂等标记已读/全部已读、越权 404、非法 `limit=0` → 422）：通过。证据边界：PGlite 用例的适配器不包事务（只 `set_config`），它证明的是写入顺序与 CAS 早退（冲突时既不写事件也不写通知）；"异常回滚"由生产 `withTenant`（`sql.begin`）代码保证，未做故障注入验证，已同步 docs/18 与台账口径。
- [x] 提醒调度测试：`tests/unit/task-reminder-worker.test.ts` 9 项（系统署名、重复扫描幂等、逾期/阻塞升级收件人、无人承接不通知、人工触发按调用人署名、按租户节流与排空、失败不推进节流、周期摘要按周期键只发一条且跨周期重发、摘要可关闭）与 `tests/integration/task-reminder-scheduler.test.ts` 3 项（系统署名落库与 actor 为空、重复扫描 created=0/deduplicated=1、周期摘要系统署名 + 租户级内容 + 按周期幂等 + 次日重发、heartbeat 接受新角色、署名约束拒绝 system 挂真人 ID）：通过；真实库复核首扫 created=2/notificationsCreated=2、再扫 created=0/deduplicated=2，`npm run task:summary` 首次 created=true/再次 created=false，`WORKER_ROLES=task-reminder npm run worker` 常驻写心跳、摘要每周期只发一次且各次扫描幂等。证据边界：Windows 强杀不触发 Node 信号处理，`drain()` 优雅排空未在本机实测。
- [x] P5 第一批：对话体验（E-153）。`createRun` 支持 `hooks.onStage` 上报真实阶段；`POST /agent/runs?stream=1` 以 SSE 推 `ready → stage… → final`（失败用 `error`，与 HTTP 共用错误映射），非流式 JSON 契约不变；工具阶段显示所属 Skill 标题（补全 work-orchestration 漏登记的 10 个工具 + 不变量测试）；页面新增「重试这条请求」、提案卡改「需要你确认」+ 剩余分钟、对话空态给可点示例。验证：新增单测 2 项 + 不变量 1 项 + SSE 契约集成 2 项；真实 dev server 逐帧观测到 +61ms → +8417ms 的真实阶段序列。遗留：像素级视觉验收缺浏览器驱动；未做 token 级流式。
- [x] P5 第二批：纪要文本批量导入（E-154，P5 收口）。`POST /agent/task-drafts` 只读抽取使命与多条任务包草稿（含逐条待补充与提醒），**不落库不发布**；「发布任务」加「从纪要批量导入」页签（粘贴→拆草稿→逐条勾选→发布选中），发布仍走 `/task-command/missions` 同一套校验；不编造人员 ID（只给姓名，前端按名册解析，解析不到按公开承接并提示）、不编造时间（过期截止丢弃并提醒）、模型不可用时按条退化拆候选；Agent 侧只读工具 `work.draft_tasks_from_minutes`（R0）。验证：新增单测 6 项 + 集成 3 项（含"草稿前后任务数不变"证明只读）；真实 dev server 用含三人名的纪要实测返回 `source=model` 与正确姓名抽取。遗留：像素级视觉验收缺浏览器驱动；草稿不支持改字段后发布；附件需先转文本。
- [x] P5 真实浏览器验收（E-155）：用 Playwright 缓存里的 Chromium + 原生 CDP 驱动真实浏览器（`node test-artifacts/browser-check.mjs`，11 项 DOM 断言全绿）——通知铃铛、发布对话框两页签、真实模型拆分后逐条渲染草稿、待补充与姓名标记、发布按钮计数、身份切换、无历史对话时的空态引导与点示例回填，截图在 `test-artifacts/p5-shots/`。验收中发现并修复"新用户永远看不到欢迎区与空态引导"的 hydrate 缺陷（改为无条件 `setMessages`，脚本最终 17/17 全绿）。遗留：截图未经我视觉复核（模型不支持读图）；通知页签与任务卡按钮的点击交互已在 E-156 补齐（见下一条）。
- [x] P5 第三批：通知页签与任务卡按钮的真实浏览器点击验收（E-156）。夹具 `test-artifacts/prepare-task-browser-fixture.mjs`（真实接口 + 真实身份 Cookie，造出"周然承接了我的开放任务"这一真实场景与真实 `task_claimed` 通知）＋验收 `test-artifacts/browser-check-tasks.mjs`（Chromium + 原生 CDP，`node test-artifacts/browser-check-tasks.mjs`，自行启动/关闭浏览器）30 项 DOM 与网络断言全绿：通知页签渲染与「N 条未读 · 共 M 条」、承接通知的 kind/标题/署名到人、「标记已读」`POST /notifications/:id/read` 实测 200 且未读数 2→1、「全部已读」`POST /notifications/read-all` 实测 200 且未读归零并同时清掉页签按钮与顶栏铃铛角标、「查看任务」切回任务栏并按关系选中「已发布」分组且定位到 `#task-card-<id>`、顶栏铃铛打开通知页签、「可承接」点「承接」`POST /packages/:id/claim` 实测 200 且「我的」中变「已承接」、「我的」点「提交验收」弹出证据对话框（填可核验证据后按钮解禁）且 `POST …/transition` 实测 200、状态转「待验收」，「已发布」点「验收通过」弹出确认对话框后 `POST …/transition` 实测 200 且变「已完成」。本轮未发现产品缺陷（三次断言失败均为验收脚本自身取值/预期问题）。夹具数据已清理（开发库仍为 14 使命/15 任务包）。遗留：未做像素级视觉复核（模型不支持读图）；交接签收/退回、取消任务、子任务勾选等其余任务卡按钮未覆盖。
- [x] P5 第四批：剩余任务卡按钮的真实浏览器点击验收（E-157）。夹具 `test-artifacts/prepare-task-browser-fixture.mjs` 扩到 8 条任务包（含由管理员发起、分别等周然签收/退回的两条交接，以及让周然提交验收从而给管理员制造第二条未读通知的任务），验收 `test-artifacts/browser-check-tasks.mjs` 扩到 **65 项断言全绿**：子任务面板空态→「添加」`POST …/subtasks` 实测 201 且标「待办 · 拆分：开发管理员」→ 未完成子任务时底部按钮被门禁替换为禁用的「子任务 0/1」→ 勾选 `PATCH` 实测 200（`is-done`＋「由 开发管理员 完成」）→ 可重开 `is-pending` → 第二条新增 → 删除按钮二次确认 `DELETE` 实测 200；「取消」确认对话框（含"不可恢复"文案）→ `POST …/transition` 实测 200 → 状态「已取消」且取消按钮消失；切到周然身份后「待交接」两条任务提供「签收」「退回」→ 签收实测 `POST /handoffs/<id>/response` 200 且任务转入其「我的」为「进行中」→ 退回在原因不足 4 字时本地拦截不发请求、填够后实测 200 且离开「待交接」。产品代码零改动（修的三处问题均在验收脚本自身）。夹具数据已清理（开发库仍 14 使命/15 任务包）。遗留：像素级视觉未经复核（模型不支持读图）；「发起交接」对话框、撤回交接、模板补充、时间线展开未覆盖。
- [x] P4 第五批：站内通知的留存清理（E-158，用户"然后是 c 和 d"的 c 前半）。`NotificationRetentionService` 两条线（已读超 90 天 / 无论已读与否超 365 天硬上限，配置非法即抛 `NOTIFICATION_RETENTION_CONFIG_INVALID`）；仓储新增按批真删的 `deleteNotifications`（Postgres CTE+LIMIT+tenant 谓词）；`0051` 迁移补 `(tenant_id, created_at)` 索引；常驻 Worker `task-reminder` 按 UTC 日期每租户每天清理一次（失败不推进当天标记），手工入口 `npm run task:notifications:prune`；环境变量映射只有 `notificationRetentionOptionsFromEnv` 一处。刻意无 HTTP/Agent 入口。验证：新增单测 9 项 + worker 2 项 + PGlite 集成 3 项；真实本地 PostgreSQL 复核 12 项断言全通过（迁移 applied、CLI 实测 readPruned=1/expiredPruned=1、租户隔离、审计留痕 `database.delete`、幂等），常驻 Worker 实跑记录 `task_reminder.notification_retention_pruned`，复核数据已清理。遗留：留存窗口是运行口径而非合规保留策略；不清理审计历史；外部通道投递仍属后续（c 后半）。
- [x] P4 第六批：站内通知的外部通道投递与通知偏好（E-159，c 后半）。默认关闭（`TASK_NOTIFICATION_CHANNELS=enabled` 才启用），**三重门槛缺一不发**：收件人外部身份已验证 + 连接 active + 本人偏好显式 opt-in（默认 `["web"]` 只走站内）；`TaskNotificationChannelDispatcher` 候选＝最近 60 分钟内的站内通知、投递键 `task-notification:<ID>` 落 `connector_deliveries` 唯一约束（无需 `dispatched_at` 列即幂等）；出站按连接构造连接器，只有已知不可重试失败才换通道（限流/未知不换，避免重复打扰）；免打扰命中本轮延后；`GET/PUT /api/v1/me/channel-preferences` 只写本人（strict schema）；独立 Worker 角色 `notification-dispatch`（`0052` 放宽心跳角色约束）。验证：新增单测 30 项 + 集成 7 项；真实本地 PostgreSQL 复核 8 项断言全通过（`0052` applied、开关关闭时无投递日志、打开后 `skipped=1`/`reasons={"NO_BOUND_CHANNEL":1}`/`delivered=0`），复核数据已清理。遗留：**真实外部送达未在本机验证**（无企业凭据与连接）；偏好自助界面待排期；`digest_enabled` 仅透传。
- [x] P5 第五批：Agent 回答的 token 级流式输出（E-160，d）。`AnswerStreamExtractor` 在模型的结构化 JSON 流里定位**顶层 `answer`** 并增量解码转义序列（只认顶层键、跨分片不吐半个字符、支持 ```json 包裹）；`ModelGateway.completeStream?` 可选能力（OpenAI 兼容 `stream: true`，按 `index` 累积工具调用；不支持则退回整段调用）；`AgentRunHooks.onDelta` + SSE 新增 `delta` 事件（早于 `final`）；界面渲染 `.command-draft` 预览并在结果到达后替换。失败语义：已流出内容后出错不重试。验证：新增单测 18 项 + 端到端集成 2 项（逐字符分包 SSE，拼接等于最终回答、无协议噪声、工具轮不产生增量）；真实浏览器验收 10 项断言全通过（预览长度 `1→61→…→230` 严格递增，最终回答与预览一致）。遗留：不支持 `stream` 的通道静默降级为整段显示；未做按句合并渲染。
- [x] 企业信息库第一批：文件存储底座 + 文件型条目/版本/适用范围（E-161，用户确认"先做骨架 + 本地磁盘 + 人群/部门/岗位维度"）。`0053` 给 `documents` 加 `kind`(text/file)/`category`/`summary`、给 `document_versions` 加文件元数据并放开 `content` 非空（CHECK：要么有正文、要么有完整文件元数据）；新增 `FileObjectStore` + 本地磁盘实现（内容寻址、读取校验穿越与 sha256、生产未配根目录即失败关闭）；`publishFile`/`downloadFile`/`listLibrary`/`describeDocument`（文件型不产生知识条目、下载复用检索可见性、写库失败回收对象）；适用范围新增部门/岗位维度（只查自己的解析器，不需要人事权限，解析不到即不匹配）；HTTP 列表/详情/multipart 上传/追加版本/下载五个入口（越权与不存在统一 404）。验证：新增单测 18 项 + 集成 8 项；真实 dev server + 真实 PostgreSQL + 真实磁盘复核 21 项断言全通过，残留已清理。遗留：三页拆分与信息库界面（E-162）、文件内容不进 Agent 检索、岗位按名称匹配、未做短时下载授权/杀毒/绑定与到期提醒。
- [x] P4 端到端实测（E-152）：真实 HTTP + 真实身份 Cookie 驱动（`test-artifacts/verify-p4-e2e.ts` 34 项、`test-artifacts/verify-p4-scheduler.ts` 18 项断言）全部通过；实测暴露既有缺陷"截止时间写成过去 → 500"，已修为 `422 WORK_PACKAGE_DUE_AT_IN_PAST` 并修正 F-079 单测口径（不能靠内存仓储发布已逾期任务）。遗留：无浏览器驱动，铃铛/通知页签只验证到接口与载荷层。
- [x] 真实 dev server 端到端：把用户先前停用的陈屿重新启用（v2→v3、恢复运营中心/运营负责人），可切换身份重新出现 operations、切换返回 200 且会话可访问员工目录、任务可指派人员列表重新包含陈屿。
- [x] 真实 dev server 端到端：对“今天新入职了一名员工叫张三”Agent 调用 `organization.add_member` 仅凭姓名登记张三（active、v1、部门/岗位/邮箱留空），成员目录与任务可指派人员列表均可查到；skills/tools 路由记录为 `organization-member-directory` / `organization.add_member`。
- [x] project-to-act 台账：`PROJECT_PROGRESS.md`（E-139～E-144）、`PROJECT_FEATURES.md`（F-091～F-096）、`PROJECT_VERSIONS.md`、`PROJECT_ACCEPTANCE.md` 已同步本批交付；AGENTS.md 已加入“每批次必须写 project-to-act”的长期要求。
- [x] `node .ai-team/check.mjs --base <base>`：Result: valid（functional 19/20，唯一未勾为 P3 后续证据附件与 P4/P5 排期项）；并新增台账门禁测试 `tests/integration/project-ledger-gate.test.ts`（只改代码不写台账 → blocked；代码与台账同批 → valid）来证明该规则真的会拦。
- [x] Next 生产构建 `npm run build`：exit 0。
- [ ] 浏览器端视觉验收（表格视图/身份切换器/发布任务/验收/修正草稿对话框/子任务面板/成员管理卡片/时间线移动端）：待有浏览器驱动的环境复核。

## Handoff note

- From: `MVP-FIX`
- To: `P01`
- Summary: P0（任务表+进度表视图、单一 /board 数据源、筛选导出口径一致）、P1（开发身份选人登录、按人隔离验证、生产失败关闭）、P2（提交验收/验收通过退回双通道 + reviewNote 审计边界、发起交接直连/可编辑预览、发布任务表单入口 + AI 通道、R3 提案 amend/supersede 服务端与网页可编辑预览卡）、P3 第一批（任务包子任务拆分/勾选/重开/删除、进度 done/total、全部完成后才可 in_review、in_review 后清单锁定、AI 只起草勾选建议经 R3 确认）已完成：typecheck、零警告 lint、全量 526 测试与生产构建通过，`.ai-team/TASK.md` functional 13/14，唯一未勾为 P3 证据附件与 P4/P5 排期项；浏览器视觉验收待有驱动的环境复核。分支 `codex/pr5-task-iter` 下一批新增/改动文件按 P3 里程碑提交（含迁移 0048、HTTP 路由、Agent 工具、任务卡子任务面板与文档）。
