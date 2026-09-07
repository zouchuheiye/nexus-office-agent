# 架构清理清单

> 状态：诊断稿 + 零风险批已完成（2026-08-31）。这份文档只列问题与清理顺序，不包含对已实现能力的否定；所有“本地工程 Gate”结论不因此改变。

## 一、乱点清单

按“越早处理越省钱”排序，每项标注证据位置和风险。

### 1. 前端数据层复制粘贴

- 现象：`components/project-people-map.tsx`、`components/employee-profile.tsx`、`components/task-progress-board.tsx` 各自维护一份 `readBoard()`、Person/Task/Mission 类型和状态文案。
- 证据：三个组件内重复的 `fetch("/api/v1/task-command/board")` 与同名类型定义。
- 风险：低。改动面集中在 `components/`，无数据库/API 语义变化。
- 清理方式：抽一个 `components/board-client.ts`（或 `lib/task-board.ts`）作为唯一数据源，导出共享类型和 `useTaskBoard()` hook；三个视图改为消费它。
- 状态：已完成（E-106）。新增 `components/board-client.ts`，统一 Board/Person/Mission/Task 类型、`readBoard()`、`useTaskBoard()` 和状态文案；`project-people-map`、`employee-profile`、`task-progress-board` 三个视图全部改为消费共享客户端。
- 补充（E-108）：新增 `components/workspace-client.ts` 统一 `useWorkspace()` 与工作区类型，`work-command-center` 与 `announcement-center` 共用，消除第二处“取数复制”。

### 2. board 接口膨胀

- 现象：`GET /api/v1/task-command/board` 一次返回 tasks/people/orgUnits/missions/actorId，成为多个视图共用的“上帝接口”。
- 证据：`src/modules/task-command/application/service.ts` 的 `board()` 不断追加字段（missions 为近期新增）。
- 风险：中。拆接口会同时改 API、服务和前端消费方，需要一次性完成。
- 清理方式：按读取场景拆成细粒度只读接口（人员负载、项目关系、开放任务），旧 board 保留兼容期，前端切到新接口后下线。
- 状态：已完成（E-108）。新增 `GET /api/v1/task-command/people|packages|missions` 三个细粒度接口（服务端统一走 `taskData()` 可见性逻辑），`board-client.readBoard()` 改为并行取三个接口；旧 board 保留兼容。

### 3. runtime 魔法版本号

- 现象：`src/modules/*/runtime.ts` 用 `__nexusXxxRuntimeVersion !== N` 手工控制单例失效。
- 证据：task-command 曾因版本守卫 4→5 未及时更新导致 dev 行为不一致。
- 风险：低-中。只影响开发期热更新，不改运行时语义；但漏改会带来“改代码不生效”的假象。
- 清理方式：替换为 DI/装配容器，或改为按模块文件哈希/启动时间自动失效；至少把魔法数字集中成常量并加注释。
- 状态：已完成（E-108）。新增 `src/platform/runtime/module-runtime.ts`，各 runtime 以模块作用域 `Symbol` 作为代际标识，模块被重编译即自动重建单例，开发期不再依赖手工版本号；agent/agent-development/agent-memory/enterprise-governance/enterprise-intelligence/governance-workspace/integration/management-intelligence/management-loop/pi-agent/task-command/workspace-bootstrap 全部切换。

### 4. 双仓储切换过粗

- 现象：`process.env.DATABASE_URL` 存在即 Postgres、否则 InMemory，导致两套行为并存。
- 证据：演示数据在内存仓储、正式数据在 Postgres，需手写种子脚本迁移（`scripts/seed-development-data.*`）。
- 风险：中。涉及仓储装配与测试夹具，改动需全量回归。
- 清理方式：统一“种子即事实”，演示数据做成可重复执行的迁移/种子；运行时装配改为显式配置（如 `DATA_MODE=memory|postgres`），避免靠环境变量存在性隐式切换。

### 5. 错误映射巨型 if/else

- 现象：`src/platform/http/api-response.ts` 硬编码上百个错误码分支。
- 证据：文件内连续多条 `includes(code)` 判断。
- 风险：低-中。新增错误需改公共文件，容易漏。
- 清理方式：改成“错误码 → 状态/文案”的注册表（Map 或表驱动），公共文件只保留兜底。
- 状态：已完成（E-106）。`api-response.ts` 改为有序 `errorRules` 表驱动，状态码/文案/顺序与原实现逐一对应；`tests/unit/api-response.test.ts` 通过。

### 6. OfficeShell 巨型三元路由

- 现象：`components/office-shell.tsx` 用一层层三元表达式分派视图。
- 证据：`active === "project-people" ? ... : active === "command" ? ...` 嵌套链。
- 风险：低。每次加模块都要改这个链。
- 清理方式：抽成 `viewRegistry: Record<viewId, Component>`，路由分支只做查表。
- 状态：已完成（E-106）。`office-shell.tsx` 用 `viewRenderers` 查表替代嵌套三元，新增视图只需注册一条；`renderView()` 统一兜底到 `ModuleBoundaryView`。

### 7. 范围混杂（Pi 平台 vs 办公平台）

- 现象：pi-agent（M21~M34：Runner、沙盒、MCP、发布治理）作为独立产品体量被放进 office 单体。
- 证据：`src/modules/pi-agent` 与 `.project-to-act` 中 M21~M34 的 Gate 记录。
- 风险：高。拆分会是长期工程，需要明确边界与部署策略。
- 清理方式：不急于拆代码；先在文档明确“办公控制面”与“Pi 运行时”的进程/部署边界，后续按部署单元分离。
- 状态：部分完成（E-108）。Agent 工具改为按意图注入（默认办公核心工具，企业微信仅在提及渠道时注入）；左侧导航的“更多模块”折叠已按用户要求撤销，恢复完整导航。Pi 运行时的进程/部署边界仍待后续拆。

### 8. 台账过程过重

- 现象：每次 UI 改动都要求 E 编号、文件哈希、验收段落。
- 证据：`.project-to-act/*.md` 体积大、条目多，普通改动也要维护四份文档。
- 风险：低。但会拖慢迭代并可能变成“文档表演”。
- 清理方式：区分“功能级证据”与“小改动”；小改动只更新 FEATURES/PROGRESS，重大变更才写 VERSIONS/ACCEPTANCE。

## 二、建议清理顺序

| 顺序 | 清理项 | 收益 | 风险 |
|---|---|---|---|
| 1 | 共享前端 board 客户端（#1） | 立刻消掉三份重复代码，后续改接口只动一处 | 低（已完成） |
| 2 | OfficeShell 视图注册表（#6） | 加模块不再改长三元链 | 低（已完成） |
| 3 | 错误码注册表（#5） | 公共文件不再膨胀 | 低-中（已完成） |
| 4 | runtime 装配清理（#3） | 消除“改代码不生效”类假象 | 低-中（已完成） |
| 5 | 拆细粒度只读接口（#2） | board 不再膨胀，权限面更清晰 | 中（已完成） |
| 6 | 统一种子/数据模式（#4） | 双轨不一致的根因消除 | 中 |
| 7 | 工具按意图注入（#7） | prompt 更小 | 中（已完成；导航折叠已按用户要求撤销） |

## 三、原则

- 先消除重复和“魔法”，再动接口；先加共享层，再拆老接口。
- 每个清理步骤独立可回退，不改变现有 RLS/审计/权限语义。
- 清理过程同步维护 `.project-to-act` 台账（按功能级证据规则）。
