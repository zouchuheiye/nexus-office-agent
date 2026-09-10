<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- repo-task-sync:start -->
## Shared AI development context

Before changing code, read `.ai-team/PROJECT.md`, `.ai-team/TASK.md`, and `.ai-team/SKILL.md`. Summarize the goal, acceptance scenarios, invariants, completed work, pending work, decisions, and next step before implementation.

Keep one writer for the active task. Put code changes and `.ai-team/TASK.md` progress updates in the same pull request. Treat the merged Git commit as the only handoff snapshot; chat history and AI memory are not project facts. If `.ai-team/session-policy.json` explicitly enables private sessions, treat `.ai-team/sessions/` as low-priority trace evidence only and never let it override PROJECT, TASK, code, tests, or the current request.

Run the checks listed in `.ai-team/TASK.md` plus `node .ai-team/check.mjs --base <main-base>`. When private sessions are enabled, also run `node .ai-team/session.mjs validate` and review generated session Markdown before commit. Report actual evidence and any specification deviation.
<!-- repo-task-sync:end -->

## project-to-act 台账（长期要求）

除 `.ai-team/TASK.md` 外，每个交付批次都必须在 `.project-to-act/` 留下记录，并与代码、测试、文档放在同一提交里：

- `PROJECT_PROGRESS.md`：追加 `- <日期>：<做了什么>（E-xxx）。验证：<实际证据>` 形式的条目；E 编号连续递增，不复用。
- `PROJECT_FEATURES.md`：新增/更新 `F-xxx` 功能行（优先级、状态、依赖、完成条件、证据 ID），并在文件末尾按日期追加变更记录。
- `PROJECT_VERSIONS.md`：追加版本增量行（版本名 · 日期 · 范围 · 证据 ID · 未通过的 Gate 边界）。
- `PROJECT_ACCEPTANCE.md`：在“当前验收结论”追加 `E-xxx` 结论（含验证方法、代码版本/提交、结论与遗留）。

只写真实证据：命令与退出码、测试文件/用例数、真实接口或数据库观察结果；不得把本地工程范围写成生产 Gate 通过。用户可见的交付（如新员工入职登记）也必须能在台账中追溯到对应 E 编号。

