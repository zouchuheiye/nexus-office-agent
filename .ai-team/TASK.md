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
- [x] project-to-act 台账同步：本批 P0/P1/P2/P3、成员管理、入职登记、停用进入权、重新启用与台账门禁已补记 `PROJECT_PROGRESS.md`（E-139～E-147）、`PROJECT_FEATURES.md`（F-091～F-099）、`PROJECT_VERSIONS.md` 与 `PROJECT_ACCEPTANCE.md`。
- [ ] P3（后续）/P4/P5：子任务证据附件上传、通知链路、体验细节按产品后续排期推进（本任务不替代产品决策）。

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
- 浏览器端视觉验收（表格视图、身份切换器、发布任务/验收/修正草稿对话框、子任务面板、成员管理卡片、时间线移动端布局）仍需可用浏览器环境；本机未安装浏览器驱动，已在 Verification 中如实标注。

## Next step

P01 复核 MVP-FIX 的 P0/P1 快照、P2 双通道交付（提交验收/验收通过退回/发起交接/发布任务 + 表单发布入口 + 可编辑提案预览卡）、P3 子任务拆分/勾选（全部按推荐决策执行）、成员管理页（组织与人才 · 管理员新增/编辑/软停用）与员工入职登记 Agent 通道（仅姓名即可登记）并决定合并；P3 证据附件与 P4/P5 由产品按排期另行立项。

## Verification

- [x] `npm run typecheck`：exit 0。
- [x] `npm run lint`：exit 0（零警告）。
- [x] 全量测试 `npm test -- --maxWorkers=2`：exit 0（132 文件 558 passed / 26 skipped）。
- [x] P0 导出过滤单测、P1 身份切换集成测试、P2 验收流转单测（review_decision 边界 + reviewNote 事件审计）、P2 amend/supersede 单元与集成测试：通过。
- [x] P3 单测（双方可拆且旁观者拒绝、完成/重开与证据门禁、in_review 锁定、workspace 进度暴露、Agent 工具注册与 R3 确认策略、schema 证据格式）与 Postgres 集成测试（落库、CAS 冲突、进度聚合、锁定期）：通过。
- [x] 成员管理测试：域单测（创建/编辑/停用不变量与岗位归属校验）、服务单测（读门禁与 canManage、管理员增改停、越权拒绝、邮箱唯一、版本 CAS、禁止停用自己）、PGlite 集成（CRUD + RLS + users/memberships 审计 + 有进行中任务禁止停用 + 邮箱大小写不敏感唯一）：通过。
- [x] 员工入职登记测试：`tests/unit/member-directory-agent-tools.test.ts` 6 项（四个工具注册与技能归属、权限可见性、确认策略、仅姓名登记、岗位归属拒绝、资料补全与版本 CAS、软停用与自停用拦截）通过。
- [x] 停用进入权测试：`tests/integration/development-identity-gate.test.ts` 2 项（停用后旧会话 401 且不降级为管理员；停用身份从切换列表消失、切换 403 `DEMO_IDENTITY_INACTIVE`、其他在职身份不受影响）与 Postgres 集成“停用收回设备与角色授权”断言通过。
- [x] 重新启用测试：域/服务单测（仅停用可启用、版本 CAS、岗位归属、部门不存在、includeDeparted 可见性）、Agent 工具单测（R2 确认策略与预览、启用后不可重复启用）、Postgres 集成（状态恢复 + archived_at 清空 + 重建现行任职 + 留空沿用原部门岗位）、身份门禁补充用例（重新启用后旧会话恢复且可再次切换）：通过。
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
