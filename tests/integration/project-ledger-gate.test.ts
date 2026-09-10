// Requirements: MR-011（工程协作事实源）——project-to-act 台账必须随每次交付写入
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(".");
const CHECK_SCRIPT = path.join(REPO_ROOT, ".ai-team/check.mjs");
const LEDGER_ERROR = ".project-to-act/PROJECT_PROGRESS.md";

/** 按真实门禁方式运行校验脚本（与 AGENTS.md 中的命令一致）。 */
function runGate(root: string, base: string) {
  const result = spawnSync(process.execPath, [CHECK_SCRIPT, "--root", root, "--base", base], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("project-to-act ledger gate", () => {
  let root = "";

  function git(...args: string[]) {
    return execFileSync("git", ["-c", "user.email=test@nexus.local", "-c", "user.name=ledger-test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
  }

  async function append(relativePath: string, line: string) {
    const absolute = path.join(root, relativePath);
    await writeFile(absolute, `${await readFile(absolute, "utf8")}\n${line}\n`, "utf8");
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nexus-ledger-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    // 复用真实协作文件，让校验器其它规则均通过，只观察台账规则。
    await cp(path.join(REPO_ROOT, "AGENTS.md"), path.join(root, "AGENTS.md"));
    await cp(path.join(REPO_ROOT, ".ai-team"), path.join(root, ".ai-team"), { recursive: true });
    await cp(path.join(REPO_ROOT, ".project-to-act"), path.join(root, ".project-to-act"), { recursive: true });
    await writeFile(path.join(root, "src/feature.ts"), "export const feature = 1;\n", "utf8");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });

  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("blocks a batch that changes code without recording it in the ledger", async () => {
    const base = git("rev-parse", "HEAD").trim();
    await writeFile(path.join(root, "src/feature.ts"), "export const feature = 2;\n", "utf8");
    await append(".ai-team/TASK.md", "<!-- batch placeholder -->");
    git("add", "-A");
    git("commit", "-q", "-m", "code only");

    const gate = runGate(root, base);
    expect(gate.status).toBe(1);
    expect(gate.output).toContain(LEDGER_ERROR);
    expect(gate.output).toContain("Result: blocked");
  });

  it("accepts a batch that records the same change in the ledger", async () => {
    const base = git("rev-parse", "HEAD").trim();
    await writeFile(path.join(root, "src/feature.ts"), "export const feature = 3;\n", "utf8");
    await append(".ai-team/TASK.md", "<!-- batch placeholder -->");
    await append(".project-to-act/PROJECT_PROGRESS.md", "- 2026-09-10：ledger gate self test (E-999). Verified by check.mjs.");
    git("add", "-A");
    git("commit", "-q", "-m", "code with ledger");

    const gate = runGate(root, base);
    expect(gate.status).toBe(0);
    expect(gate.output).not.toContain(LEDGER_ERROR);
    expect(gate.output).toContain("Result: valid");
  });
});
