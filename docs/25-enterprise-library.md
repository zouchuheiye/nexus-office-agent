# 25 企业信息库与治理页面

本文回答一个具体问题：**企业的各种信息（协议、标准、制度、表单、证照、会议纪要、审批结论）到底存在哪里、谁能看到、怎么改。**
它也记录 E-162 的页面结构调整（此前「智能审批」和「知识与会议」渲染的是同一个组件）。

## 1. 三个页面各管什么

| 导航 | 页面 | 负责 | 不负责 |
|---|---|---|---|
| 智能审批 | 审批工作台 | 待我审批、运行中流程、Agent 预审、审批纪律 | 不展示会议与文件 |
| 会议纪要 | 会议确认闭环 | 会议列表、纪要确认、决定与行动项沉淀、会议准备包 | 不做审批决定、不管文件 |
| 企业信息库 | 信息库 | 文件上传/下载/版本、制度文本发布、分类与筛选、权限感知检索 | 不做审批、不做会议确认 |

三页此前是**同一个组件**（`governance-center-view.tsx`，只切换一行标题），所以看起来一模一样；现在拆成
`components/approval-workbench-view.tsx`、`components/meeting-center-view.tsx`、`components/library-center-view.tsx`，
导航名与页面标题也对齐了（原来导航"知识与会议"点进去标题是"企业知识与依据"）。

## 2. 信息存放总览

| 信息 | 存放位置 | 写入方 | 可见性 |
|---|---|---|---|
| 制度、标准条文（文本知识） | `documents`（`kind='text'`）+ `document_versions.content` + `knowledge_items`（切块） | 企业信息库「发布文本」、`POST /knowledge/documents` | 密级 + 人/角色/项目/部门/岗位 |
| 协议、合同、表单、证照、扫描件（文件） | `documents`（`kind='file'`）+ `document_versions`（文件名/MIME/大小/sha256/`storage_ref`）；**字节在对象存储** | 企业信息库「上传文件」、`POST /knowledge/documents/files` | 同上（`confidential`/`restricted` 必须命中适用范围之一） |
| 会议纪要与决定 | `meeting_records`（草稿/确认纪要 jsonb、确认人、沉淀状态）；确认后写入管理闭环的决定与行动项 | 会议页「确认纪要并沉淀」 | 参会人/确认人；沉淀后的决定按项目权限 |
| 审批实例与决定 | `process_definitions` / `process_definition_versions`（节点 jsonb）/ `process_instances`（表单快照）/ `approvals`（审批人/期限/委托/升级） | 经营控制页提交、审批页决定 | 发起人、当前审批人、管理员 |
| 组织与人员 | `users` / `memberships` / `org_units` / `positions` | 组织与人才页、Agent 入职登记 | 在职目录对全员；离职名单仅管理员 |
| 任务管理 | `work_missions` / `work_packages` / 子任务 / `work_task_events`（append-only）/ 交接 / 通知 | 工作对话、任务栏、Agent | 负责人/发布人/交接对手方 |
| 任务证据（附件元数据） | `work_artifacts` / `work_artifact_versions`（文件名/MIME/sha256/可选 `storage_ref`） | 任务举证 | 任务参与者 |
| 审计 | `audit_events`（不可改写） | 全部写操作（原子审计触发器） | 管理员/合规 |

**文件字节在哪里**：`FileObjectStore` 抽象 + 本地磁盘实现（`NEXUS_FILE_STORAGE_ROOT`，开发默认 `.nexus-files/`），
按内容寻址存成 `<root>/<tenantId>/<sha256[0:2]>/<sha256[2:4]>/<sha256>`。生产未配置根目录时**失败关闭**
（`FILE_STORAGE_NOT_CONFIGURED`），不允许悄悄写容器临时目录。换 S3/MinIO 只需再实现一个 `FileObjectStore`。

## 3. 企业信息库的条目模型

- **分类（第一层目录）**：制度办法 / 标准规范 / 协议 / 合同 / 模板 / 表单 / 证照 / 记录归档 / 其他。
- **密级**：公开 / 内部 / 机密 / 受限。公开与内部对全员可读；机密与受限必须命中适用范围之一。
- **适用范围**：指定成员、角色、项目、**部门**、**岗位**。适用范围是对"实习协议只对实习生、某标准只对某部门生效"的
  直接表达；部门/岗位判据由请求侧按当前主体解析，解析不到即视为不匹配（失败关闭）。
- **版本与生命周期**：每次上传/发布生成新版本，记录 `supersedes_version`；生效期/失效期决定它是否"当前有效"；
  列表与检索默认只看有效版本，历史版本仍可下载（合规需要）。
- **摘要**：一句话说明"这是什么、给谁看"，是列表页的主要阅读内容。
- **Agent 检索**：文本条目默认允许切块进权限感知检索；**文件条目不进检索**（没有正文可切块），
  因此文件内容不会因为"上传了"就进入模型上下文。

## 4. 边界与硬约束

- **上传约束**：单文件 ≤ 25MB（`DEFAULT_FILE_LIMITS`），MIME 白名单（PDF/Office/图片/文本/zip）；超限 413、类型不允许 422。
- **父子一致性**：文本条目与文件条目的版本不能互相追加（`DOCUMENT_KIND_MISMATCH`）。
- **写权限**：只有条目 Owner 或 `document:admin` 能追加版本；普通同事即使有 `document:update` 也不能改别人的条目。
- **越权与不存在同响应**：读取、详情与下载在无权时统一 `404`，不泄露"存在但你没权限"。
- **下载不缓存**：`cache-control: private, no-store`，每次请求都重新过权限；响应带 `x-content-digest` 供客户端校验。
- **完整性**：读取时校验 sha256（内容寻址），字节被改动会以 `FILE_OBJECT_CORRUPTED` 拒绝返回。
- **不留坏数据**：上传先写对象存储再写库；写库失败即删除刚存的对象，避免"有版本没字节"。
- **没有硬删除**：条目通过新版本、归档或失效期演进；审计历史不可改写（`audit_events`）。

## 5. 后续（按批次）

1. **文件与人绑定**：员工档案里直接看到他的协议、转正材料与到期日（需要"文件—人员"关联与档案页）。
2. **到期提醒**：`expires_at` 已落库，接入常驻调度即可做"协议到期/续签/签收"提醒。
3. **模板与生成**：协议模板 → 填字段 → 生成待签文件 → 签署/回收状态。
4. **文件内容进检索**：为 PDF/Word 做文本抽取后写入 `knowledge_items`，让"标准里的某一条"也能被 Agent 引用。
5. **安全加固**：上传病毒扫描、缩略图预览、下载短时授权链接（当前每请求重过权限）。

（判定与接口的权威描述见 [docs/03](./03-domain-and-data-model.md) §7、[docs/08](./08-api-and-event-contracts.md) §2、
生产存储配置见 [docs/11](./11-production-deployment.md) §4.1。）
