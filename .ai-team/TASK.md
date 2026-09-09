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
- [ ] P3/P4/P5：子任务模型与 AI 勾选、通知链路、体验细节按产品后续排期推进（本任务不替代产品决策）。

## Invariants

- 保持租户隔离、服务端权限重算、数据范围过滤和失败关闭；不得信任请求体自报的租户、身份、版本或设备可信状态。
- 验收通过/退回永不自动执行；高风险业务副作用只能经 Tool Registry、持久化提案和人工确认执行。
- 默认内存仓储只在未配置 `DATABASE_URL` 时启用；正式 PostgreSQL 路径不因本批改动降级。
- 不删除或弱化既有测试来消除失败；改动同步更新权威文档（docs/08、docs/18）与追踪证据。
- 代码、测试、文档和 `.ai-team/TASK.md` 在同一提交/PR 中同步更新；不提交密钥、私人数据或运行产物。

## Decisions

- 按用户确认，本轮先收尾 P0（任务表+进度表视图）与 P1（多身份选人登录）为可提交里程碑，随后继续 P2 双通道补齐；P3–P5 记录为后续排期，不在本轮虚构完成。
- 第六节待确认决策点按文档建议值执行：子任务双方可拆（P3）、提交验收一键确认、验证版选人登录 + 正式 OIDC 后置、进度口径先用状态+剩余天数+逾期、4B 模型档位、验收证据先做字符串格式约束后补附件上传。
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

## Pending

- P3/P4/P5 不在本批 MVP-FIX 交付范围：子任务模型（work_package_tasks + 事件类型扩展 + AI 勾选建议）、通知链路（分派/交接/验收主动通知与提醒脚本常驻调度）、体验细节（文案人话化、空态引导、流式/阶段提示、一键重试）按产品后续排期与文档第六节建议推进，本任务不替代产品决策。
- 浏览器端视觉验收（表格视图、身份切换器、发布任务/验收/修正草稿对话框、时间线移动端布局）仍需可用浏览器环境；本机未安装浏览器驱动，已在 Verification 中如实标注。

## Next step

P01 复核 MVP-FIX 的 P0/P1 快照与 P2 双通道交付（提交验收/验收通过退回/发起交接/发布任务 + 表单发布入口 + 可编辑提案预览卡）并决定合并；P3–P5 由产品按排期另行立项。

## Verification

- [x] `npm run typecheck`：exit 0。
- [x] `npm run lint`：exit 0（零警告）。
- [x] 全量测试 `npm test -- --maxWorkers=2`：exit 0（518 passed / 26 skipped）。
- [x] P0 导出过滤单测、P1 身份切换集成测试、P2 验收流转单测（review_decision 边界 + reviewNote 事件审计）、P2 amend/supersede 单元与集成测试：通过。
- [x] `node .ai-team/check.mjs`：Result: valid（functional 12/13，唯一未勾为 P3–P5 排期项）。
- [x] Next 生产构建 `npm run build`：exit 0。
- [ ] 浏览器端视觉验收（表格视图/身份切换器/发布任务/验收/修正草稿对话框/时间线移动端）：待有浏览器驱动的环境复核。

## Handoff note

- From: `MVP-FIX`
- To: `P01`
- Summary: P0（任务表+进度表视图、单一 /board 数据源、筛选导出口径一致）、P1（开发身份选人登录、按人隔离验证、生产失败关闭）、P2（提交验收/验收通过退回双通道 + reviewNote 审计边界、发起交接直连/可编辑预览、发布任务表单入口 + AI 通道、R3 提案 amend/supersede 服务端与网页可编辑预览卡）已完成：typecheck、零警告 lint、全量 518 测试与生产构建通过，`.ai-team/TASK.md` functional 12/13，唯一未勾为按产品排期的 P3–P5 项；浏览器视觉验收待有驱动的环境复核。分支 `codex/pr5-task-iter` 自基线共 6 个提交（3ff66cc/109b755/be50da1/221ae2f/fe19e26/5e34451），工作树 clean。
