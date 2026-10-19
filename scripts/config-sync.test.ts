/**
 * scripts/config-sync.test.ts — config-sync helper 与 PowerShell 入口的端到端测试。
 *
 * 每个 fixture：临时仓库（git init + 仅仓库级身份）+ 临时 USERPROFILE/.omp，
 * 复制真实 PowerShell 入口与 helper，通过子进程执行真实入口（不模拟解析/复制）。
 * 临时目录在 finally 中删除，只删测试自己创建的路径；绝不触碰真实 ~/.omp。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = resolveRepoRoot();
const TEMP_ROOT = mkdtempSync(join(tmpdir(), "config-sync-test-"));
const CLEANUPS: string[] = [];

afterAll(() => {
  for (const dir of CLEANUPS) rmSync(dir, { recursive: true, force: true });
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

function resolveRepoRoot(): string {
  // 本测试文件位于 <repo>/scripts/ 下
  return join(import.meta.dir, "..");
}

interface Fixture {
  root: string;
  repoDir: string;
  homeDir: string;
  ompDir: string;
  agentDir: string;
}

function makeFixture(name: string): Fixture {
  const root = join(TEMP_ROOT, name);
  const repoDir = join(root, "repo");
  const homeDir = join(root, "home");
  const ompDir = join(homeDir, ".omp");
  const agentDir = join(ompDir, "agent");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  // 复制真实入口与 helper（fixture 仓库自包含）
  cpSync(join(REPO, "scripts", "config-sync.ts"), join(repoDir, "scripts", "config-sync.ts"));
  cpSync(join(REPO, "sync-from-live.ps1"), join(repoDir, "sync-from-live.ps1"));
  cpSync(join(REPO, "setup.ps1"), join(repoDir, "setup.ps1"));

  // git init + 仅仓库级测试身份
  const git = (args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  git(["init"]);
  git(["config", "user.email", "test@example.invalid"]);
  git(["config", "user.name", "config-sync-test"]);
  git(["add", "-A"]);
  git(["commit", "-m", "fixture init"]);

  CLEANUPS.push(root);
  return { root, repoDir, homeDir, ompDir, agentDir };
}

function runInFixture(fx: Fixture, cmd: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(cmd, {
    cwd: fx.repoDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      USERPROFILE: fx.homeDir,
      HOME: fx.homeDir,
      ...env,
    },
  });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function helper(fx: Fixture, args: string[], env: Record<string, string> = {}) {
  return runInFixture(fx, ["bun", join(fx.repoDir, "scripts", "config-sync.ts"), ...args, "--repo", fx.repoDir, "--home", fx.ompDir], env);
}

function syncEntry(fx: Fixture, psArgs: string[], exe = "pwsh") {
  return runInFixture(fx, [exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(fx.repoDir, "sync-from-live.ps1"), ...psArgs]);
}

function setupEntry(fx: Fixture, psArgs: string[], exe = "pwsh") {
  return runInFixture(fx, [exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(fx.repoDir, "setup.ps1"), ...psArgs]);
}

function gitHead(fx: Fixture): string {
  return Bun.spawnSync(["git", "-C", fx.repoDir, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
}
function gitStatus(fx: Fixture): string {
  return Bun.spawnSync(["git", "-C", fx.repoDir, "status", "--porcelain"], { stdout: "pipe" }).stdout.toString();
}

const MINIMAL_CONFIG = "modelRoles:\n  smol: agent-plan/glm-5-3-flash\nhideThinkingBlock: true\n";
const MINIMAL_MODELS = `providers:
  agent-plan:
    baseUrl: https://ark.example/api/plan/v3
    api: openai-completions
    apiKey: <ARK_API_KEY>
    authHeader: true
    models:
      - id: glm-5-3-flash
        name: GLM Flash
        input: [text]
        contextWindow: 1024000
        maxTokens: 65536
`;
const MINIMAL_LSP = JSON.stringify({ servers: { gopls: { command: "gopls", fileTypes: [".go"], rootMarkers: ["."] } } }, null, 2) + "\n";

function writeLiveBase(fx: Fixture): void {
  writeFileSync(join(fx.agentDir, "config.yml"), MINIMAL_CONFIG);
  writeFileSync(join(fx.agentDir, "models.yml"), MINIMAL_MODELS.replace("<ARK_API_KEY>", "ark-live-secret-0001"));
  writeFileSync(join(fx.agentDir, "lsp.json"), MINIMAL_LSP);
  writeFileSync(join(fx.agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  writeFileSync(join(fx.agentDir, "settings.json"), "{}\n");
  writeFileSync(join(fx.agentDir, ".env"), "TAVILY_API_KEY=tvly-live-secret-0000000000000\n");
}

function writeRepoBase(fx: Fixture): void {
  const repoAgent = join(fx.repoDir, "agent");
  mkdirSync(repoAgent, { recursive: true });
  writeFileSync(join(repoAgent, "config.yml"), MINIMAL_CONFIG);
  writeFileSync(join(repoAgent, "models.yml"), MINIMAL_MODELS);
  writeFileSync(join(repoAgent, "lsp.json"), MINIMAL_LSP);
  writeFileSync(join(repoAgent, "mcp.json"), JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
  writeFileSync(join(repoAgent, "settings.json"), "{}\n");
  mkdirSync(join(fx.repoDir, "skills", "repo-only-skill"), { recursive: true });
  writeFileSync(join(fx.repoDir, "skills", "repo-only-skill", "SKILL.md"), "repo only\n");
  Bun.spawnSync(["git", "-C", fx.repoDir, "add", "-A"], { stdout: "pipe" });
  Bun.spawnSync(["git", "-C", fx.repoDir, "commit", "-m", "repo base"], { stdout: "pipe" });
}

// ---------- 行为 1：只改模型覆盖项/技能 -> -Check 退出 2，无任何写入 ----------

describe("check: live-only model override + skill detected, nothing written", () => {
  const fx = makeFixture("check-detects");
  writeRepoBase(fx);
  writeLiveBase(fx);
  // live 新增模型覆盖项与技能（repo 没有）
  const liveFull = MINIMAL_MODELS.replace(
    "providers:\n",
    `providers:
  deepseek:
    modelOverrides:
      deepseek-flash:
        cost:
          input: 2.0
`,
  ).replace("ark-live-secret-0001", "ark-live-secret-0001");
  writeFileSync(join(fx.agentDir, "models.yml"), liveFull);
  mkdirSync(join(fx.agentDir, "skills", "live-only-skill"), { recursive: true });
  writeFileSync(join(fx.agentDir, "skills", "live-only-skill", "SKILL.md"), "live only\n");

  const beforeHead = gitHead(fx);
  const beforeStatus = gitStatus(fx);
  const liveConfigHash = Bun.SHA256.hash(readFileSync(join(fx.agentDir, "config.yml"), "utf8"), "hex");

  const r = syncEntry(fx, []);
  test("exit 2 with two changes listed", () => {
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("agent/models.yml");
    expect(r.stdout).toContain("skills/live-only-skill/SKILL.md");
  });
  test("repo HEAD/index, live files, backup/state dirs untouched", () => {
    expect(gitHead(fx)).toBe(beforeHead);
    expect(gitStatus(fx)).toBe(beforeStatus);
    expect(Bun.SHA256.hash(readFileSync(join(fx.agentDir, "config.yml"), "utf8"), "hex")).toBe(liveConfigHash);
    expect(existsSync(join(fx.ompDir, "config-sync"))).toBe(false);
    expect(existsSync(join(fx.repoDir, "skills", "live-only-skill"))).toBe(false);
  });
});

// ---------- 行为 2：-Export 落库 + 保留 repo-only + 二轮 -Check 归零 ----------

describe("export: merges live into repo, keeps repo-only, second check clean", () => {
  const fx = makeFixture("export-merge");
  writeRepoBase(fx);
  writeLiveBase(fx);
  // live: provider apiKey 真实值（repo 是占位符）→ 语义同（占位归一），只有覆盖项变化
  writeFileSync(
    join(fx.agentDir, "models.yml"),
    `providers:
  agent-plan:
    baseUrl: https://ark.example/api/plan/v3
    api: openai-completions
    apiKey: ark-live-secret-0001
    authHeader: true
    models:
      - id: glm-5-3-flash
        name: GLM Flash
        input: [text]
        contextWindow: 1024000
        maxTokens: 65536
  deepseek:
    modelOverrides:
      deepseek-flash:
        cost:
          input: 2.0
`,
  );
  mkdirSync(join(fx.agentDir, "skills", "live-only-skill"), { recursive: true });
  writeFileSync(join(fx.agentDir, "skills", "live-only-skill", "SKILL.md"), "live only\n");
  // 未跟踪无关文件
  writeFileSync(join(fx.repoDir, "unrelated.html"), "<html></html>");

  const beforeHead = gitHead(fx);
  const r = syncEntry(fx, ["-Export"]);
  test("export exits 0 and writes merge", () => {
    expect(r.code).toBe(0);
    const merged = readFileSync(join(fx.repoDir, "agent", "models.yml"), "utf8");
    expect(merged).toContain("deepseek-flash");
    expect(merged).toContain("<ARK_API_KEY>"); // 占位符保留
    expect(merged).not.toContain("ark-live-secret-0001"); // 真实值不入仓
    expect(existsSync(join(fx.repoDir, "skills", "live-only-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(fx.repoDir, "skills", "repo-only-skill", "SKILL.md"))).toBe(true); // repo-only 保留
    expect(existsSync(join(fx.repoDir, "unrelated.html"))).toBe(true);
    expect(gitHead(fx)).toBe(beforeHead); // 不 commit
    expect(gitStatus(fx)).toContain("agent/models.yml");
  });
  test("exported YAML carries no trailing whitespace", () => {
    // Bun.YAML.stringify(Bun 1.3.x) 会给嵌套映射/序列的键加尾随空格（"key: "），
    // 结构化导出必须把它剥掉，否则每次导出都在仓库留下一片空白 churn。
    for (const rel of ["agent/config.yml", "agent/models.yml"]) {
      const text = readFileSync(join(fx.repoDir, ...rel.split("/")), "utf8");
      expect(text.split("\n").filter((line) => /[ \t]+$/.test(line))).toEqual([]);
    }
  });
  test("baseline recorded", () => {
    expect(existsSync(join(fx.ompDir, "config-sync", "state.json"))).toBe(true);
  });
  test("second -Check exits 0", () => {
    const r2 = syncEntry(fx, ["-Check"]);
    expect(r2.code).toBe(0);
  });
});

// ---------- 行为 3：机器路径差异不触发 check/guard；实际偏好变化触发 ----------

describe("machine-path differences are ignored; real preference changes are not", () => {
  const fx = makeFixture("machine-paths");
  writeRepoBase(fx);
  writeLiveBase(fx);
  // repo 也声明同样的服务器（裸名），live 用绝对路径 —— 纯机器路径差异
  writeFileSync(
    join(fx.repoDir, "agent", "mcp.json"),
    JSON.stringify({ mcpServers: { "codebase-memory-mcp": { command: "codebase-memory-mcp", args: [], type: "stdio" } } }, null, 2) + "\n",
  );
  Bun.spawnSync(["git", "-C", fx.repoDir, "add", "-A"], { stdout: "pipe" });
  Bun.spawnSync(["git", "-C", fx.repoDir, "commit", "-m", "repo mcp server"], { stdout: "pipe" });
  // live: LSP/MCP 绝对路径、不同 shellPath、不同 apiKey —— portable 语义相同
  writeFileSync(
    join(fx.agentDir, "lsp.json"),
    JSON.stringify({ servers: { gopls: { command: "C:/x/gopls.exe", fileTypes: [".go"], rootMarkers: ["."] } } }, null, 2) + "\n",
  );
  writeFileSync(
    join(fx.agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { "codebase-memory-mcp": { command: "C:/x/codebase-memory-mcp.exe", args: [], type: "stdio" } } }, null, 2) + "\n",
  );
  writeFileSync(join(fx.agentDir, "config.yml"), "modelRoles:\n  smol: agent-plan/glm-5-3-flash\nhideThinkingBlock: true\nshellPath: C:/x/pwsh.exe\n");
  writeFileSync(
    join(fx.agentDir, "models.yml"),
    MINIMAL_MODELS.replace("<ARK_API_KEY>", "ark-other-live-key-0002"),
  );

  test("check has no exportable changes", () => {
    const r = helper(fx, ["check"]);
    expect(r.code).toBe(0);
  });
  test("guard allowed with machine-path-only differences (no baseline yet)", () => {
    const r = helper(fx, ["guard-deploy"]);
    expect(r.code).toBe(0);
  });

  test("a real preference change triggers check exit 2 with file shown", () => {
    writeFileSync(join(fx.agentDir, "config.yml"), "modelRoles:\n  smol: zhipu/glm-5.3-flash\nhideThinkingBlock: true\n");
    const r = helper(fx, ["check"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("agent/config.yml");
  });
  test("changed shell path and key alone do not trigger guard after baseline", () => {
    // 重建基线（用当前合法内容），再只改 shellPath/apiKey
    writeFileSync(join(fx.agentDir, "config.yml"), "modelRoles:\n  smol: agent-plan/glm-5-3-flash\nhideThinkingBlock: true\nshellPath: C:/old/pwsh.exe\n");
    const rec = helper(fx, ["record-state"]);
    expect(rec.code).toBe(0);
    writeFileSync(join(fx.agentDir, "config.yml"), "modelRoles:\n  smol: agent-plan/glm-5-3-flash\nhideThinkingBlock: true\nshellPath: C:/new/pwsh.exe\n");
    writeFileSync(join(fx.agentDir, "models.yml"), MINIMAL_MODELS.replace("<ARK_API_KEY>", "ark-changed-key-0003"));
    const r = helper(fx, ["guard-deploy"]);
    expect(r.code).toBe(0);
  });
});

// ---------- 行为 4：秘密/语法错误/不可移植路径 -> export 整批拒绝，无写入 ----------

describe("export rejects secrets, broken YAML, non-portable paths in one batch", () => {
  function freshWithDirtyRepo(): Fixture {
    const fx = makeFixture(`reject-${Math.random().toString(36).slice(2, 6)}`);
    writeRepoBase(fx);
    writeLiveBase(fx);
    return fx;
  }
  function expectRejected(fx: Fixture, label: string) {
    const beforeHead = gitHead(fx);
    const beforeRepoModels = readFileSync(join(fx.repoDir, "agent", "models.yml"), "utf8");
    const r = syncEntry(fx, ["-Export"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain("tvly-live-secret-0000000000000");
    expect(r.stdout + r.stderr).not.toContain("ark-live-secret-0001");
    expect(gitHead(fx)).toBe(beforeHead);
    expect(readFileSync(join(fx.repoDir, "agent", "models.yml"), "utf8")).toBe(beforeRepoModels);
  }

  test("candidate skill text containing fixture model secret is rejected", () => {
    const fx = freshWithDirtyRepo();
    mkdirSync(join(fx.agentDir, "skills", "leaky"), { recursive: true });
    writeFileSync(join(fx.agentDir, "skills", "leaky", "SKILL.md"), "key=ark-live-secret-0001\n");
    expectRejected(fx, "skill secret");
  });
  test("MCP env containing actual TOKEN value is rejected", () => {
    const fx = freshWithDirtyRepo();
    writeFileSync(
      join(fx.agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { x: { command: "x", args: [], type: "stdio", env: { MYP_TOKEN: "tok-live-value-1234567890" } } } }, null, 2) + "\n",
    );
    expectRejected(fx, "mcp env token");
  });
  test("YAML syntax error is rejected", () => {
    const fx = freshWithDirtyRepo();
    writeFileSync(join(fx.agentDir, "models.yml"), "providers:\n  - broken: [unclosed\n");
    expectRejected(fx, "yaml error");
  });
  test("unknown server with non-portable absolute path is rejected", () => {
    const fx = freshWithDirtyRepo();
    writeFileSync(
      join(fx.agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { weird: { command: "C:/nonportable/weird-tool.exe", args: [], type: "stdio" } } }, null, 2) + "\n",
    );
    expectRejected(fx, "nonportable path");
  });
});

// ---------- 行为 5：dirty 仓库文件冲突拒绝；候选相同则允许 ----------

describe("dirty repo file conflicts", () => {
  test("export denied when dirty file would change; allowed when candidate equals worktree", () => {
    const fx = makeFixture("dirty-repo");
    writeRepoBase(fx);
    writeLiveBase(fx);
    // 制造 dirty：repo config.yml 未提交修改
    writeFileSync(join(fx.repoDir, "agent", "config.yml"), "modelRoles:\n  smol: agent-plan/glm-5-3-flash\nhideThinkingBlock: false\n");
    // live 与 HEAD 不同语义 -> 候选会覆盖 dirty 内容 -> 拒绝
    const r1 = syncEntry(fx, ["-Export"]);
    expect(r1.code).toBe(1);
    expect(r1.stdout + r1.stderr).toContain("agent/config.yml");
    // live 改成与 dirty 工作区相同 -> 允许
    writeFileSync(join(fx.agentDir, "config.yml"), "modelRoles:\n  smol: agent-plan/glm-5-3-flash\nhideThinkingBlock: false\n");
    const r2 = syncEntry(fx, ["-Export"]);
    expect(r2.code).toBe(0);
  });
});

// ---------- 行为 6：新机器/基线守卫/损坏 state ----------

describe("deploy guard baseline lifecycle", () => {
  test("new machine with no portable config: setup -Check allowed, creates no dirs", () => {
    const fx = makeFixture("new-machine");
    writeRepoBase(fx);
    // fixture 本身预建了空的 .omp/agent；断言 -Check 不写入任何状态/备份/配置
    const agentBefore = readdirSync(fx.agentDir);
    const r = setupEntry(fx, ["-Check"]);
    expect(r.code).toBe(0);
    expect(readdirSync(fx.agentDir)).toEqual(agentBefore);
    expect(existsSync(join(fx.ompDir, "config-sync"))).toBe(false);
  });

  test("live without baseline differing from repo: denied; after export: allowed; corrupt state: denied", () => {
    const fx = makeFixture("baseline-flow");
    writeRepoBase(fx);
    writeLiveBase(fx);
    // live 与 repo 不同（真实 key vs 占位符 = 允许的机器差异，这里改个真实偏好）
    writeFileSync(join(fx.agentDir, "config.yml"), "modelRoles:\n  smol: zhipu/glm-5.3-flash\nhideThinkingBlock: true\n");
    const denied = helper(fx, ["guard-deploy"]);
    expect(denied.code).toBe(1);
    // 导出后允许
    const exp = syncEntry(fx, ["-Export"]);
    expect(exp.code).toBe(0);
    const allowed = helper(fx, ["guard-deploy"]);
    expect(allowed.code).toBe(0);
    // 损坏 state
    writeFileSync(join(fx.ompDir, "config-sync", "state.json"), "{broken");
    const corrupt = helper(fx, ["guard-deploy"]);
    expect(corrupt.code).toBe(1);
    expect(corrupt.stderr).toContain("state.json");
  });

  test("baseline drift: live add/modify/delete denied; repo-side update allowed", () => {
    const fx = makeFixture("drift");
    writeRepoBase(fx);
    writeLiveBase(fx);
    // 本机先有一个可变更的技能文件
    mkdirSync(join(fx.agentDir, "skills", "live-only-skill"), { recursive: true });
    writeFileSync(join(fx.agentDir, "skills", "live-only-skill", "SKILL.md"), "live only\n");
    expect(syncEntry(fx, ["-Export"]).code).toBe(0);
    // 修改 repo（模拟 git pull 更新仓库）-> 允许
    writeFileSync(join(fx.repoDir, "agent", "settings.json"), "{}\n");
    Bun.spawnSync(["git", "-C", fx.repoDir, "add", "-A"], { stdout: "pipe" });
    Bun.spawnSync(["git", "-C", fx.repoDir, "commit", "-m", "repo update"], { stdout: "pipe" });
    const pullLike = helper(fx, ["guard-deploy"]);
    expect(pullLike.code).toBe(0);
    // 本机新增受管文件 -> 拒绝
    mkdirSync(join(fx.agentDir, "skills", "brand-new"), { recursive: true });
    writeFileSync(join(fx.agentDir, "skills", "brand-new", "SKILL.md"), "new\n");
    const added = helper(fx, ["guard-deploy"]);
    expect(added.code).toBe(1);
    expect(added.stderr).toContain("skills/brand-new/SKILL.md");
    rmSync(join(fx.agentDir, "skills", "brand-new"), { recursive: true, force: true });
    // 本机修改受管内容 -> 拒绝
    writeFileSync(join(fx.agentDir, "settings.json"), "{}\n");
    writeFileSync(join(fx.agentDir, "skills", "live-only-skill", "SKILL.md"), "live only v2\n");
    const modified = helper(fx, ["guard-deploy"]);
    expect(modified.code).toBe(1);
    // 本机删除受管文件 -> 拒绝
    writeFileSync(join(fx.agentDir, "skills", "live-only-skill", "SKILL.md"), "live only\n");
    rmSync(join(fx.agentDir, "settings.json"));
    const deleted = helper(fx, ["guard-deploy"]);
    expect(deleted.code).toBe(1);
    expect(deleted.stderr).toContain("agent/settings.json");
  });
});

// ---------- 行为 8：写入故障注入 -> 回滚 + 基线不变 ----------

describe("write failure injection: rollback and baseline untouched", () => {
  test("second-file write failure restores first file and keeps state", () => {
    const fx = makeFixture("rollback");
    writeRepoBase(fx);
    writeLiveBase(fx);
    expect(syncEntry(fx, ["-Export"]).code).toBe(0);
    const headBefore = gitHead(fx);
    const repoModelsBefore = readFileSync(join(fx.repoDir, "agent", "models.yml"), "utf8");
    const repoConfigBefore = readFileSync(join(fx.repoDir, "agent", "config.yml"), "utf8");

    // 现在让两个文件都产生变化，并注入写故障：把 repo config.yml 变成只读目录成员不可写。
    writeFileSync(join(fx.agentDir, "config.yml"), "modelRoles:\n  smol: zhipu/glm-5.3-flash\nhideThinkingBlock: true\n");
    mkdirSync(join(fx.agentDir, "skills", "second-skill"), { recursive: true });
    writeFileSync(join(fx.agentDir, "skills", "second-skill", "SKILL.md"), "second\n");
    // 注入：将 repo 侧第二个写入目标（skills/second-skill）所在目录替换为同名只读文件，触发写失败
    rmSync(join(fx.repoDir, "skills", "second-skill"), { recursive: true, force: true });
    writeFileSync(join(fx.repoDir, "skills", "second-skill"), "not a dir");

    const r = syncEntry(fx, ["-Export"]);
    expect(r.code).toBe(1);
    // 第一个文件（config.yml / models.yml）应已回滚为原内容
    expect(readFileSync(join(fx.repoDir, "agent", "models.yml"), "utf8")).toBe(repoModelsBefore);
    expect(readFileSync(join(fx.repoDir, "agent", "config.yml"), "utf8")).toBe(repoConfigBefore);
    expect(gitHead(fx)).toBe(headBefore);
    // 基线保持原样（仍是首轮导出的状态文件）
    expect(existsSync(join(fx.ompDir, "config-sync", "state.json"))).toBe(true);
  });
});

// ---------- 行为 9：PS5.1 参数解析 + PS7 退出码 ----------

describe("PowerShell 5.1 entry parsing", () => {
  test("sync-from-live -Check via powershell.exe exits 2 with changes", () => {
    const fx = makeFixture("ps51-sync");
    writeRepoBase(fx);
    writeLiveBase(fx);
    mkdirSync(join(fx.agentDir, "skills", "live-only-skill"), { recursive: true });
    writeFileSync(join(fx.agentDir, "skills", "live-only-skill", "SKILL.md"), "live only\n");
    const r = syncEntry(fx, ["-Check"], "powershell.exe");
    expect(r.code).toBe(2);
  });
  test("setup -Check via powershell.exe parses switch and exits 0 on new machine", () => {
    const fx = makeFixture("ps51-setup");
    writeRepoBase(fx);
    const r = setupEntry(fx, ["-Check"], "powershell.exe");
    expect(r.code).toBe(0);
  });
});

// ---------- deploy-models / set-shell 隔离烟测 ----------

describe("deploy-models and set-shell", () => {
  test("deploy-models keeps per-provider live keys and env-injects registered providers", () => {
    const fx = makeFixture("deploy-models");
    const repoAgent = join(fx.repoDir, "agent");
    mkdirSync(repoAgent, { recursive: true });
    writeFileSync(
      join(repoAgent, "models.yml"),
      `providers:
  agent-plan:
    baseUrl: https://ark.example/api/plan/v3
    api: openai-completions
    apiKey: <ARK_API_KEY>
    models:
      - id: glm-5-3-flash
        name: GLM Flash
        input: [text]
        contextWindow: 1024000
        maxTokens: 65536
  zhipu:
    baseUrl: https://zhipu.example/v4
    api: openai-completions
    apiKey: <ZHIPU_API_KEY>
    models:
      - id: glm-5.3-flash
        name: GLM 5.3 Flash
        input: [text]
        contextWindow: 1048576
        maxTokens: 131072
  volcengine-coding:
    baseUrl: https://ark.example/api/coding/v3
    api: openai-completions
    apiKey: <VOLCENGINE_CODING_API_KEY>
    models:
      - id: glm-5-3-flash
        name: GLM Coding
        input: [text]
        contextWindow: 1024000
        maxTokens: 65536
`,
    );
    Bun.spawnSync(["git", "-C", fx.repoDir, "add", "-A"], { stdout: "pipe" });
    Bun.spawnSync(["git", "-C", fx.repoDir, "commit", "-m", "models"], { stdout: "pipe" });
    // live：agent-plan 有真实 key（保留），volcengine-coding 无（占位符），zhipu 走环境变量
    writeFileSync(
      join(fx.agentDir, "models.yml"),
      `providers:
  agent-plan:
    baseUrl: https://ark.example/api/plan/v3
    api: openai-completions
    apiKey: ark-live-plan-key-0004
    models: []
`,
    );
    const out = join(fx.agentDir, "models.deployed.yml");
    const r = helper(fx, ["deploy-models", "--output", out], { ZHIPU_API_KEY: "zhipu-from-env-0005" });
    expect(r.code).toBe(0);
    const deployed = readFileSync(out, "utf8");
    expect(deployed).toContain("ark-live-plan-key-0004");
    expect(deployed).toContain("zhipu-from-env-0005");
    expect(deployed).toContain("<VOLCENGINE_CODING_API_KEY>");
    expect(deployed).toContain("glm-5-3-flash"); // 模型定义来自 repo
    expect(r.stdout).not.toContain("ark-live-plan-key-0004");
  });

  test("deploy-models denies orphan provider with real key", () => {
    const fx = makeFixture("orphan");
    writeRepoBase(fx);
    writeFileSync(
      join(fx.agentDir, "models.yml"),
      `providers:
  orphan-p:
    apiKey: ark-orphan-key-0006
`,
    );
    const r = helper(fx, ["deploy-models", "--output", join(fx.agentDir, "models.yml")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("orphan-p");
  });

  test("set-shell writes and deletes shellPath", () => {
    const fx = makeFixture("set-shell");
    writeRepoBase(fx);
    writeLiveBase(fx);
    const cfg = join(fx.agentDir, "config.yml");
    const w = helper(fx, ["set-shell", "--file", cfg, "--shell", "C:/x/pwsh.exe"]);
    expect(w.code).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain("shellPath: C:/x/pwsh.exe");
    const d = helper(fx, ["set-shell", "--file", cfg]);
    expect(d.code).toBe(0);
    expect(readFileSync(cfg, "utf8")).not.toContain("shellPath");
  });
});
