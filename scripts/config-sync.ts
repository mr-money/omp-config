#!/usr/bin/env bun
/**
 * scripts/config-sync.ts — OMP 配置同步 helper（Bun 运行，无 npm 依赖）。
 *
 * 操作（--repo/--home 必填，绝对路径）：
 *   check         本机 → 仓库 只读差异检查（有可导出变化退出 2）
 *   export        本机 → 仓库 脱敏导出（含备份/原子写/回滚/基线记录）
 *   guard-deploy  仓库边界校验及只读部署清单（--backup 备份覆盖和删除项；--json 输出 {files,deletes,removeDirs,backupDir}）
 *   record-state  记录当前本机受管内容的脱敏归一化基线
 *   deploy-models 以仓库 models.yml 为源写目标 models.yml，保留本机同 provider 真实 key / 注入环境变量（--output）
 *   set-shell     结构化写回 config.yml 的 shellPath（--file <config.yml> [--shell <pwsh>]；缺 --shell 则删除）
 *
 * 安全边界：任何错误输出只含相对文件名与字段路径，绝不输出秘密正文；
 * 备份与状态写在 ${home}/config-sync/ 下，不进入仓库、不进入同步清单。
 * 退出码：0 成功；1 错误/拒绝；check 存在可导出变化时 2。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// ---------- 唯一对象守卫（单文件脚本 = 唯一定义点，导出复用） ----------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------- 常量 ----------

/** 受管固定文件（仓库相对路径）。 */
const MANAGED_FILES = ["agent/config.yml", "agent/settings.json", "agent/models.yml", "agent/lsp.json", "agent/mcp.json"];
/** 受管目录（递归）。 */
const MANAGED_DIRS = ["agent/agents", "skills"];
/** config.yml 剥离的机器本地项。 */
const CONFIG_STRIPPED_KEYS = ["shellPath", "setupVersion"];
/** 排除的目录名。 */
const EXCLUDED_DIR_NAMES: Record<string, true> = { ".git": true, node_modules: true, __pycache__: true, "config-sync": true };
/** 排除的文件后缀。 */
const EXCLUDED_FILE_SUFFIXES = [".pyc", ".db", ".db-wal", ".db-shm", ".log", ".bak", ".tmp"];
/** 秘密字段名（归一化小写、去 _ -）。 */
const SECRET_FIELD_NAMES: Record<string, true> = {
  apikey: true,
  accesstoken: true,
  refreshtoken: true,
  authorization: true,
  password: true,
  secret: true,
  token: true,
  cookie: true,
};
/** headers 容器内的别名（保留原大小写语义，比较用小写）。 */
const HEADER_SECRET_ALIASES: Record<string, true> = { authorization: true, "api-key": true };
/** env 值视为秘密候选的关键词。 */
const ENV_SECRET_WORDS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "COOKIE"];
/** 已知服务器的可移植命令映射（服务器名 -> 裸命令）。 */
const PORTABLE_COMMAND_BY_SERVER: Record<string, string> = {
  gopls: "gopls",
  pylsp: "python",
  "codebase-memory-mcp": "codebase-memory-mcp",
};
/** deploy-models 的环境变量注入映射。 */
const DEPLOY_ENV_BY_PROVIDER: Record<string, string> = { "agent-plan": "OMP_AGENT_PLAN_KEY", zhipu: "ZHIPU_API_KEY" };
/** 占位符形态。 */
const PLACEHOLDER_RE = /^<[^>]+>$/;
/** 通用秘密形态。 */
const SECRET_VALUE_RES = [/sk-[A-Za-z0-9_-]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
/** 哈希用的凭据哨兵值。 */
const SECRET_SENTINEL = "__CONFIG_SYNC_SECRET__";
/** providers.<name>.models 数组（按 id 合并）。 */
const PROVIDER_MODELS_PATH_RE = /^providers\/[^/]+\/models$/;

// ---------- 基础工具 ----------

function fail(msg: string): never {
  console.error(`[config-sync] ${msg}`);
  process.exit(1);
}

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** LF 统一 + 去 BOM（文本语义比较与哈希的唯一形态）。 */
function normalizeText(s: string): string {
  return s.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeKeyLower(s: string): string {
  return s.toLowerCase().replace(/[_-]/g, "");
}

/** 排序键的稳定序列化（哈希专用；数组保序）。 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}


function looksAbsoluteCommand(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\") || s.startsWith("/");
}

// ---------- 解析 ----------

function requireBunYaml(): void {
  if (typeof Bun === "undefined" || typeof Bun.YAML?.parse !== "function" || typeof Bun.YAML?.stringify !== "function") {
    fail(`Bun.YAML unavailable (Bun ${typeof Bun !== "undefined" ? Bun.version : "missing"}); upgrade Bun and retry`);
  }
}

/** YAML 解析：拒绝多文档与非对象根。 */
function parseYaml(text: string, file: string): Record<string, unknown> {
  requireBunYaml();
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    fail(`${file}: YAML parse failed (syntax error)`);
  }
  if (Array.isArray(parsed)) fail(`${file}: multi-document YAML rejected`);
  if (!isRecord(parsed)) fail(`${file}: YAML root must be an object`);
  return parsed;
}

function parseJson(text: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`${file}: JSON parse failed (syntax error)`);
  }
  if (!isRecord(parsed)) fail(`${file}: JSON root must be an object`);
  return parsed;
}

function isYamlRel(rel: string): boolean {
  return rel.endsWith(".yml") || rel.endsWith(".yaml");
}

/** 受管固定文件 => 结构化；其余（agents/**、skills/**）=> 文本。 */
function isStructuredRel(rel: string): boolean {
  return MANAGED_FILES.includes(rel);
}

// ---------- 路径映射 ----------

/**
 * 受管相对路径（agent/... 或 skills/...）到实际文件系统路径。
 * 仓库侧 base=repoRoot（受管路径与仓库布局一致）；
 * 本机侧 base=OmpHome（~/.omp）：受管 agent/* 位于 ~/.omp/agent/*，skills/* 位于 ~/.omp/agent/skills/*。
 */
function sideAbs(base: string, isLiveSide: boolean, rel: string): string {
  if (isLiveSide) {
    if (rel === "skills" || rel.startsWith("skills/")) return join(base, "agent", ...rel.split("/"));
  }
  return join(base, ...rel.split("/"));
}

// ---------- 文件发现 ----------

function isExcludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) return lower !== ".env.example";
  if (EXCLUDED_DIR_NAMES[name] === true) return true;
  return EXCLUDED_FILE_SUFFIXES.some((s) => lower.endsWith(s));
}

function walkDir(absDir: string, relPrefix: string, out: string[], skips: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    skips.push(relPrefix || absDir);
    return;
  }
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (EXCLUDED_DIR_NAMES[e.name] === true || (!e.isDirectory() && isExcludedFile(e.name))) continue;
    if (e.isSymbolicLink()) {
      skips.push(rel);
      continue;
    }
    if (e.isDirectory()) {
      if (EXCLUDED_DIR_NAMES[e.name] === true) continue;
      walkDir(join(absDir, e.name), rel, out, skips);
    } else if (e.isFile()) {
      if (isExcludedFile(e.name)) continue;
      out.push(rel);
    }
  }
}

/** 收集受管常规文件；任何链接或不可读取的路径记录到 skips，不沿链接遍历。 */
function collectManaged(base: string, isLiveSide: boolean, skips: string[]): string[] {
  const out: string[] = [];
  const inspect = (abs: string, rel: string, directory: boolean): boolean => {
    let stat: Stats;
    try {
      stat = lstatSync(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") skips.push(rel);
      return false;
    }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      skips.push(rel);
      return false;
    }
    return true;
  };
  // agent 是固定文件和本机两个受管目录的共同祖先。
  const agentSafe = inspect(join(base, "agent"), "agent", true);
  if (agentSafe) {
    for (const f of MANAGED_FILES) if (inspect(sideAbs(base, isLiveSide, f), f, false)) out.push(f);
  }
  for (const d of MANAGED_DIRS) {
    if ((isLiveSide || d.startsWith("agent/")) && !agentSafe) continue;
    const abs = sideAbs(base, isLiveSide, d);
    if (inspect(abs, d, true)) walkDir(abs, d, out, skips);
  }
  return out.sort();
}

// ---------- 秘密识别 ----------

interface SecretFinding {
  file: string;
  path: string;
}

function envKeyLooksSecret(name: string): boolean {
  return ENV_SECRET_WORDS.some((w) => name.toUpperCase().includes(w));
}

/** 结构化值中已配置（非空、非占位）的秘密字段。 */
function findSecretFields(value: unknown, file: string, path: string, out: SecretFinding[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findSecretFields(v, file, `${path}/${i}`, out));
    return;
  }
  if (!isRecord(value)) return;
  const segments = path.split("/");
  const inHeaders = segments.includes("headers");
  const inEnv = segments.length >= 2 && segments[segments.length - 1] === "env";
  for (const [k, v] of Object.entries(value)) {
    const childPath = `${path}/${k}`;
    let isSecret = false;
    if (inHeaders) isSecret = HEADER_SECRET_ALIASES[k.toLowerCase()] === true;
    else if (inEnv) isSecret = typeof v === "string" && envKeyLooksSecret(k);
    else isSecret = SECRET_FIELD_NAMES[normalizeKeyLower(k)] === true;
    if (isSecret && typeof v === "string" && v.trim().length > 0 && !PLACEHOLDER_RE.test(v.trim())) {
      out.push({ file, path: childPath });
      continue; // 命中字段后不再下钻
    }
    findSecretFields(v, file, childPath, out);
  }
}

/** 深拷贝并把所有已配置凭据值替换为固定哨兵（哈希/比较专用，不落盘）。 */
function sanitizeForHash(value: unknown, path: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => sanitizeForHash(v, `${path}/${i}`));
  if (!isRecord(value)) return value;
  const segments = path.split("/");
  const inHeaders = segments.includes("headers");
  const inEnv = segments.length >= 2 && segments[segments.length - 1] === "env";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const childPath = `${path}/${k}`;
    let isSecret = false;
    if (inHeaders) isSecret = HEADER_SECRET_ALIASES[k.toLowerCase()] === true;
    else if (inEnv) isSecret = typeof v === "string" && envKeyLooksSecret(k);
    else isSecret = SECRET_FIELD_NAMES[normalizeKeyLower(k)] === true;
    out[k] = isSecret && typeof v === "string" && v.trim().length > 0 ? SECRET_SENTINEL : sanitizeForHash(v, childPath);
  }
  return out;
}

/** 从本机收集已知秘密精确串（live models apiKey + agent/.env 值），绝不回显。 */
function collectKnownSecrets(home: string): string[] {
  const secrets: string[] = [];
  const modelsPath = join(home, "agent", "models.yml");
  if (existsSync(modelsPath)) {
    try {
      const parsed: unknown = Bun.YAML.parse(readFileSync(modelsPath, "utf8"));
      const providers = isRecord(parsed) ? parsed.providers : null;
      if (isRecord(providers)) {
        for (const v of Object.values(providers)) {
          if (isRecord(v) && typeof v.apiKey === "string") {
            const t = v.apiKey.trim();
            if (t.length >= 8 && !PLACEHOLDER_RE.test(t)) secrets.push(t);
          }
        }
      }
    } catch {
      /* 无法解析的本机内容不影响部署；原文件将被备份。 */
    }
  }
  const envPath = join(home, "agent", ".env");
  if (existsSync(envPath)) {
    for (const line of normalizeText(readFileSync(envPath, "utf8")).split("\n")) {
      const m = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      if (envKeyLooksSecret(m[1]) && m[2].trim().length >= 8) secrets.push(m[2].trim());
    }
  }
  return secrets;
}

/** 候选正文扫描：已知秘密精确匹配 + sk- 形态 + PEM 头。返回命中描述（不含值）。 */
function scanTextForSecrets(text: string, file: string, knownSecrets: string[]): string[] {
  const hits: string[] = [];
  for (const s of knownSecrets) {
    if (text.includes(s)) {
      hits.push(`${file}: exact match of a known live secret (redacted, value not shown)`);
      break;
    }
  }
  for (const re of SECRET_VALUE_RES) {
    if (re.test(text)) hits.push(`${file}: matches generic secret pattern ${re.source}`);
  }
  return hits;
}

// ---------- 服务器命令归一化 ----------

function resolveOnPath(command: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
  for (const dir of pathEnv.split(";")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate.toLowerCase();
    }
  }
  return null;
}

/**
 * 归一化 lsp/mcp 的服务器 command/args/env。
 * mode=export：已知服务器映射为裸名；未知服务器绝对路径仅当 PATH 同名命令解析到同一文件才裸名化，否则记入 blocks。
 * mode=repo：任何绝对路径都记入 blocks（仓库必须可移植）。
 */
function normalizeServerCommands(value: unknown, file: string, mode: "export" | "repo", blocks: string[]): unknown {
  if (!isRecord(value)) return value;
  const containerKey = value.servers !== undefined ? "servers" : value.mcpServers !== undefined ? "mcpServers" : null;
  if (!containerKey || !isRecord(value[containerKey])) return value;
  const out: Record<string, unknown> = { ...value, [containerKey]: { ...value[containerKey] } };
  for (const [name, server] of Object.entries(out[containerKey])) {
    if (!isRecord(server)) continue;
    const s: Record<string, unknown> = { ...server };
    if (typeof s.command === "string") {
      const cmd = s.command;
      if (looksAbsoluteCommand(cmd)) {
        const portable = PORTABLE_COMMAND_BY_SERVER[name];
        const bareName = basename(cmd).replace(/\.(exe|cmd|bat|com)$/i, "");
        if (portable && mode === "export") {
          s.command = portable;
        } else if (portable && mode === "repo") {
          blocks.push(`${file}: ${containerKey}.${name}.command must be a portable bare command (absolute path found)`);
        } else if (mode === "repo") {
          blocks.push(`${file}: ${containerKey}.${name}.command is a machine absolute path, not portable`);
        } else if (PORTABLE_COMMAND_BY_SERVER[bareName] !== undefined) {
          // 已知可移植命令（gopls/python/codebase-memory-mcp）：直接归一为裸名
          s.command = bareName;
        } else {
          const resolved = resolveOnPath(bareName);
          if (resolved !== null && resolved === cmd.toLowerCase()) s.command = bareName;
          else blocks.push(`${file}: ${containerKey}.${name}.command is an absolute path that cannot be safely normalized to a bare command`);
        }
      }
    }
    for (const field of ["args", "env"]) {
      const v = s[field];
      if (Array.isArray(v)) {
        if (v.some((x) => typeof x === "string" && looksAbsoluteCommand(x))) {
          blocks.push(`${file}: ${containerKey}.${name}.${field} contains a machine absolute path`);
        }
      } else if (isRecord(v)) {
        for (const [ek, ev] of Object.entries(v)) {
          if (typeof ev === "string" && looksAbsoluteCommand(ev)) {
            blocks.push(`${file}: ${containerKey}.${name}.${field}.${ek} contains a machine absolute path`);
          }
        }
      }
    }
    out[containerKey][name] = s;
  }
  return out;
}

// ---------- 深合并（live 覆盖 repo，仓库独有键保留） ----------

interface MergeIssue {
  file: string;
  path: string;
  reason: string;
}

function modelIdOf(item: unknown, file: string, path: string, issues: MergeIssue[]): string | null {
  if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
    issues.push({ file, path, reason: "model entry missing string id" });
    return null;
  }
  return item.id;
}

function mergeModelsArrays(repoArr: unknown[], liveArr: unknown[], file: string, path: string, issues: MergeIssue[]): unknown[] {
  const repoIds = new Set<string>();
  for (const it of repoArr) {
    const id = modelIdOf(it, file, path, issues);
    if (id === null) continue;
    if (repoIds.has(id)) issues.push({ file, path, reason: `duplicate repo model id: ${id}` });
    repoIds.add(id);
  }
  const out = [...repoArr];
  const indexOfId = new Map<string, number>();
  out.forEach((it, i) => {
    const id = isRecord(it) && typeof it.id === "string" ? it.id : null;
    if (id !== null && !indexOfId.has(id)) indexOfId.set(id, i);
  });
  const liveSeen = new Set<string>();
  for (const it of liveArr) {
    const id = modelIdOf(it, file, path, issues);
    if (id === null) continue;
    if (liveSeen.has(id)) issues.push({ file, path, reason: `duplicate live model id: ${id}` });
    liveSeen.add(id);
    const idx = indexOfId.get(id);
    if (idx === undefined) {
      indexOfId.set(id, out.length);
      out.push(it);
    } else {
      out[idx] = deepMerge(out[idx], it, `${path}/${id}`, file, issues);
    }
  }
  return out;
}

function deepMerge(repo: unknown, live: unknown, path: string, file: string, issues: MergeIssue[]): unknown {
  if (isRecord(repo) && isRecord(live)) {
    const out: Record<string, unknown> = { ...repo };
    for (const [k, lv] of Object.entries(live)) {
      out[k] = k in repo ? deepMerge(repo[k], lv, `${path}/${k}`, file, issues) : lv;
    }
    return out;
  }
  if (Array.isArray(repo) && Array.isArray(live)) {
    if (PROVIDER_MODELS_PATH_RE.test(path)) return mergeModelsArrays(repo, live, file, path, issues);
    return live; // 普通数组：本机覆盖
  }
  return live; // 标量/类型不一致：本机覆盖
}

// ---------- 结构化管线 ----------

function stripConfigKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out = { ...value };
  for (const k of CONFIG_STRIPPED_KEYS) delete out[k];
  return out;
}

function serializeStructured(rel: string, value: Record<string, unknown>): string {
  // Bun.YAML.stringify (Bun 1.3.x) 给每个带块级子项的键加尾随空格（`key: ` 后换行）。剥掉行尾空白，
  // 否则每次导出/部署都在仓库或本机留下纯空白 churn；结构化比较按解析值哈希，不受空白影响。
  const text = isYamlRel(rel)
    ? Bun.YAML.stringify(value, null, 2).replace(/[ \t]+$/gm, "")
    : JSON.stringify(value, null, 2) + "\n";
  return text.endsWith("\n") ? text : text + "\n";
}

/** 解析单侧内容并做机器差异归一化（config 剥离、命令裸名化）。 */
function loadNormalized(absPath: string, rel: string, mode: "export" | "repo", blocks: string[]): Record<string, unknown> | null {
  if (!existsSync(absPath)) return null;
  const text = normalizeText(readFileSync(absPath, "utf8"));
  const parsed = isYamlRel(rel) ? parseYaml(text, rel) : parseJson(text, rel);
  let value: Record<string, unknown> = parsed;
  if (rel === "agent/config.yml") value = stripConfigKeys(value);
  if (rel === "agent/lsp.json" || rel === "agent/mcp.json") value = normalizeServerCommands(value, rel, mode, blocks) as Record<string, unknown>;
  return value;
}

function structuredHash(value: Record<string, unknown>): string {
  return sha256(stableStringify(sanitizeForHash(value, "")));
}

// ---------- 导出候选 ----------

interface Candidate {
  rel: string;
  structured: boolean;
  /** 最终候选正文；live 缺失时为 null。 */
  content: string | null;
  /** 候选可移植哈希；live 缺失时为 null。 */
  hash: string | null;
  /** 仓库当前内容哈希；仓库缺失时为 null。 */
  repoHash: string | null;
  /** 本机是否存在该受管项。 */
  hasLive: boolean;
}

/** models.yml 导出专用：把本机真实 provider apiKey 换成仓库占位符（新 provider 生成 <NAME_API_KEY>）。 */
function placeholderizeLiveModels(live: Record<string, unknown>, repo: Record<string, unknown> | null): Record<string, unknown> {
  const out = structuredClone(live);
  const liveProviders = out.providers;
  const repoProviders = isRecord(repo?.providers) ? repo.providers : {};
  if (!isRecord(liveProviders)) return out;
  const next: Record<string, unknown> = {};
  for (const [name, provider] of Object.entries(liveProviders)) {
    if (!isRecord(provider) || typeof provider.apiKey !== "string" || PLACEHOLDER_RE.test(provider.apiKey.trim()) || provider.apiKey.trim().length === 0) {
      next[name] = provider;
      continue;
    }
    const repoProvider = repoProviders[name];
    const placeholder =
      isRecord(repoProvider) && typeof repoProvider.apiKey === "string" && repoProvider.apiKey.trim().length > 0
        ? repoProvider.apiKey.trim()
        : `<${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY>`;
    next[name] = { ...provider, apiKey: placeholder };
  }
  out.providers = next;
  return out;
}

/**
 * 构建全部导出候选。任何解析失败/秘密命中/不可移植路径直接 fail（整批拒绝）。
 * 返回候选列表 + 仓库独有清单 + 跳过的符号链接。
 */
function buildCandidates(repoRoot: string, home: string, requireLiveConfig: boolean): {
  candidates: Candidate[];
  repoOnly: string[];
  skips: string[];
} {
  const liveSkips: string[] = [];
  const repoSkips: string[] = [];
  const liveRels = collectManaged(home, true, liveSkips);
  const repoRels = collectManaged(repoRoot, false, repoSkips);

  if (requireLiveConfig && !existsSync(join(home, "agent", "config.yml"))) {
    fail("export requires live agent/config.yml to exist (guard against empty-init)");
  }
  for (const must of ["agent/config.yml", "agent/models.yml"]) {
    if (!existsSync(join(repoRoot, ...must.split("/")))) fail(`repo missing required file ${must}`);
  }

  const repoSet = new Set(repoRels);
  const liveSet = new Set(liveRels);
  const candidates: Candidate[] = [];

  for (const rel of Array.from(new Set([...liveRels, ...repoRels])).sort()) {
    const structured = isStructuredRel(rel);
    const liveAbs = sideAbs(home, true, rel);
    const repoAbs = sideAbs(repoRoot, false, rel);
    const hasLive = liveSet.has(rel);
    const hasRepo = repoSet.has(rel);

    let hash: string | null = null;
    let content: string | null = null;
    let repoHash: string | null = null;

    if (structured) {
      const exportBlocks: string[] = [];
      const liveVal = hasLive ? loadNormalized(liveAbs, rel, "export", exportBlocks) : null;
      const repoVal = hasRepo ? loadNormalized(repoAbs, rel, "repo", exportBlocks) : null;
      for (const b of exportBlocks) fail(b); // 仓库不可移植路径 / 本机无法归一化路径：整批拒绝
      let merged: Record<string, unknown> | null = null;
      if (liveVal && repoVal) {
        const issues: MergeIssue[] = [];
        const liveForMerge = rel === "agent/models.yml" ? placeholderizeLiveModels(liveVal, repoVal) : liveVal;
        merged = deepMerge(repoVal, liveForMerge, "", rel, issues);
        for (const iss of issues) fail(`${iss.file}: ${iss.path || "<根>"} ${iss.reason}`);
      } else merged = liveVal ?? repoVal;
      if (merged) {
        content = serializeStructured(rel, merged);
        hash = structuredHash(merged);
      }
      if (repoVal) repoHash = structuredHash(repoVal);
      // 结构化导出的秘密防线：合并结果中不允许出现已配置真实秘密
      const findings: SecretFinding[] = [];
      if (merged) findSecretFields(merged, rel, "", findings);
      if (findings.length > 0) fail(`${rel}: unredacted secret fields detected: ${findings.map((f) => f.path).join(", ")}`);
    } else {
      if (hasLive) {
        content = normalizeText(readFileSync(liveAbs, "utf8"));
        hash = sha256(content);
      }
      if (hasRepo) repoHash = sha256(normalizeText(readFileSync(repoAbs, "utf8")));
    }

    candidates.push({ rel, structured, content, hash, repoHash, hasLive });
  }
  // 仓库独有 = 候选中没有任何本机来源
  const repoOnly = candidates.filter((c) => !c.hasLive).map((c) => c.rel);
  return { candidates, repoOnly, skips: [...repoSkips, ...liveSkips] };
}

// ---------- Git 脏文件检查 ----------

function gitStatusDirty(repoRoot: string, rel: string): boolean {
  const r = Bun.spawnSync(["git", "-C", repoRoot, "status", "--porcelain", "--", rel], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return true; // 无 git/异常：保守视为待审冲突
  return r.stdout.toString().trim().length > 0;
}

// ---------- 备份与原子写 ----------

function currentWindowsSid(): string | null {
  if (process.platform !== "win32") return null;
  const r = Bun.spawnSync(["whoami", "/user"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  const m = /S-1-5-\d+(?:-\d+)+/.exec(r.stdout.toString());
  return m ? m[0] : null;
}

function createBackupDir(home: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(home, "config-sync", "backups", `${stamp}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const sid = currentWindowsSid();
    if (!sid) fail(`cannot resolve current user SID; aborting private backup dir: ${dir}`);
    const r = Bun.spawnSync(["icacls", dir, "/inheritance:r", "/grant:r", `*${sid}:F`, "*S-1-5-18:F"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) fail(`backup dir ACL grant failed (icacls exit ${r.exitCode}): ${dir}`);
  } else {
    const r = Bun.spawnSync(["chmod", "700", dir], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) fail(`backup dir permission grant failed (chmod): ${dir}`);
  }
  return dir;
}

function backupFlatName(rel: string): string {
  return rel.replace(/[\\/]/g, "__");
}

interface AppliedWrite {
  target: string;
  backupPath: string | null;
  created: boolean;
}

/** 逐文件原子替换：写临时文件 -> 复核原内容哈希 -> rename。失败回滚已替换文件。 */
function writeBatch(files: { targetAbs: string; rel: string; content: string; originalRaw: Buffer | null; backupDir: string | null }[]): void {
  const applied: AppliedWrite[] = [];
  const rollback = (msg: string): never => {
    const unrestored: string[] = [];
    for (const a of applied.reverse()) {
      try {
        if (a.created) unlinkSync(a.target);
        else if (a.backupPath) copyFileSync(a.backupPath, a.target);
      } catch {
        unrestored.push(a.target);
      }
    }
    fail(`${msg}${unrestored.length > 0 ? `; NOT auto-restored, restore manually from backup dir: ${unrestored.join(", ")}` : "; all replaced files rolled back"}`);
  };
  for (const f of files) {
    const targetDir = dirname(f.targetAbs);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const tmp = join(targetDir, `.${basename(f.targetAbs)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    let backupPath: string | null = null;
    if (f.originalRaw && f.backupDir) {
      backupPath = join(f.backupDir, backupFlatName(f.rel));
      writeFileSync(backupPath, f.originalRaw);
    }
    try {
      writeFileSync(tmp, f.content);
      if (f.originalRaw !== null) {
        const currentRaw = readFileSync(f.targetAbs);
        if (!currentRaw.equals(f.originalRaw)) {
          rmSync(tmp, { force: true });
          rollback(`pre-write check: ${f.rel} changed concurrently; batch aborted`);
        }
      }
      renameSync(tmp, f.targetAbs);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 忽略临时文件清理失败 */
      }
      rollback(`write failed for ${f.rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
    applied.push({ target: f.targetAbs, backupPath, created: f.originalRaw === null });
  }
}

// ---------- 基线状态 ----------

function statePath(home: string): string {
  return join(home, "config-sync", "state.json");
}

function liveManifest(home: string, skips: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of collectManaged(home, true, skips)) {
    const abs = sideAbs(home, true, rel);
    if (isStructuredRel(rel)) {
      const blocks: string[] = [];
      const value = loadNormalized(abs, rel, "export", blocks);
      if (value === null) continue;
      for (const b of blocks) fail(b);
      files[rel] = structuredHash(value);
    } else {
      files[rel] = sha256(normalizeText(readFileSync(abs, "utf8")));
    }
  }
  return files;
}

function writeState(home: string, files: Record<string, string>): void {
  const dir = join(home, "config-sync");
  mkdirSync(dir, { recursive: true });
  const target = statePath(home);
  const tmp = join(dir, `.state.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ version: 1, files }, null, 2) + "\n");
  renameSync(tmp, target);
}


// ---------- 差异摘要（脱敏） ----------

function diffPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= 20) return;
  if (isRecord(a) && isRecord(b)) {
    for (const k of Object.keys(b)) if (k in a) diffPaths(a[k], b[k], `${path}/${k}`, out);
      else out.push(`${path}/${k} (new)`);
    for (const k of Object.keys(a)) if (!(k in b)) out.push(`${path}/${k} (absent live-side)`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path} (${a.length} -> ${b.length} items)`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diffPaths(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (stableStringify(a) !== stableStringify(b)) out.push(path || "<根>");
}

// ---------- 操作实现 ----------

function opCheck(repoRoot: string, home: string): void {
  const { candidates, skips, repoOnly } = buildCandidates(repoRoot, home, false);
  const liveHasAny = candidates.some((c) => c.hash !== null);
  if (!liveHasAny) {
    console.log("no managed config on this machine; nothing to export (no writes)");
    for (const s of skips) console.log(`  skipped (symlink/junction): ${s}`);
    process.exit(0);
  }
  const knownSecrets = collectKnownSecrets(home);
  const changes: Candidate[] = [];
  for (const c of candidates) {
    if (c.hash === null) continue;
    if (c.hash !== c.repoHash) changes.push(c);
    // 候选正文秘密扫描（文本文件含本机真实值时整批拒绝）
    if (c.content !== null) {
      const hits = scanTextForSecrets(c.content, c.rel, knownSecrets);
      if (hits.length > 0) {
        for (const h of hits) console.error(`[config-sync] ${h}`);
        process.exit(1);
      }
    }
  }
  if (changes.length === 0) {
    console.log("no exportable semantic changes");
  } else {
    console.log(`${changes.length} exportable change(s):`);
    for (const c of changes) {
      console.log(`  ${c.hash !== null && c.repoHash === null ? "add" : "update"} ${c.rel}`);
      if (c.structured) {
        const repoVal = loadNormalized(sideAbs(repoRoot, false, c.rel), c.rel, "repo", []);
        const candVal = isYamlRel(c.rel) ? parseYaml(c.content!, c.rel) : parseJson(c.content!, c.rel);
        const paths: string[] = [];
        if (repoVal) diffPaths(repoVal, candVal, "", paths);
        for (const p of paths) console.log(`      ${p}`);
      }
    }
  }
  if (repoOnly.length > 0) {
    console.log(`repo-only (kept, not deleted): ${repoOnly.length} item(s)`);
    for (const r of repoOnly) console.log(`  repo-only ${r}`);
  }
  for (const s of skips) console.log(`  跳过（符号链接/联接）: ${s}`);
  process.exit(changes.length > 0 ? 2 : 0);
}

function opExport(repoRoot: string, home: string): void {
  const { candidates, skips } = buildCandidates(repoRoot, home, true);
  const knownSecrets = collectKnownSecrets(home);
  const pending: { c: Candidate; targetAbs: string; originalRaw: Buffer | null }[] = [];
  for (const c of candidates) {
    if (c.hash === null || c.content === null) continue;
    if (c.hash === c.repoHash) continue;
    const hits = scanTextForSecrets(c.content, c.rel, knownSecrets);
    if (hits.length > 0) {
      for (const h of hits) console.error(`[config-sync] ${h}`);
      fail("export 整批拒绝（候选正文命中秘密防线），仓库与本机均未修改");
    }
    const targetAbs = join(repoRoot, ...c.rel.split("/"));
    const originalRaw = existsSync(targetAbs) ? readFileSync(targetAbs) : null;
    if (originalRaw !== null && gitStatusDirty(repoRoot, c.rel)) {
      const worktreeHash = c.structured
        ? structuredHash(loadNormalized(targetAbs, c.rel, "repo", []))
        : sha256(normalizeText(readFileSync(targetAbs, "utf8")));
      if (worktreeHash !== c.hash) {
        fail(`${c.rel} has uncommitted changes and this export would change it again; review/commit/revert first (worktree content untouched)`);
      }
    }
    pending.push({ c, targetAbs, originalRaw });
  }

  const needsBackup = pending.filter((p) => p.originalRaw !== null);
  const backupDir = needsBackup.length > 0 ? createBackupDir(home) : null;
  let added = 0;
  let updated = 0;
  if (pending.length > 0) {
    writeBatch(
      pending.map((p) => ({
        targetAbs: p.targetAbs,
        rel: p.c.rel,
        content: p.c.content!,
        originalRaw: p.originalRaw,
        backupDir,
      })),
    );
    added = pending.filter((p) => p.originalRaw === null).length;
    updated = pending.length - added;
  }
  writeState(home, liveManifest(home, skips));
  console.log(`export done: added ${added}, updated ${updated}, unchanged ${candidates.filter((c) => c.hash !== null && c.hash === c.repoHash).length}`);
  for (const p of pending) console.log(`  wrote ${p.c.rel}`);
  if (backupDir) console.log(`  backup dir: ${backupDir}`);
  console.log("  recorded sanitized live baseline (config-sync/state.json); no commit, no push");
}


function opGuardDeploy(repoRoot: string, home: string, opts: { backup: boolean; json: boolean }): void {
  // 仓库与本机均不沿受管路径中的链接遍历。
  const repoSkips: string[] = [];
  const liveSkips: string[] = [];
  const repoRels = collectManaged(repoRoot, false, repoSkips);
  const liveRels = collectManaged(home, true, liveSkips);
  if (repoSkips.length || liveSkips.length) {
    fail(`deploy denied: unsafe or unreadable managed paths: ${[...repoSkips.map((p) => `repo:${p}`), ...liveSkips.map((p) => `live:${p}`)].join(", ")}`);
  }
  for (const must of ["agent/config.yml", "agent/models.yml"]) {
    if (!repoRels.includes(must)) fail(`deploy denied: repo missing required file ${must}`);
  }
  const knownSecrets = collectKnownSecrets(home);
  for (const rel of repoRels) {
    const abs = sideAbs(repoRoot, false, rel);
    const text = normalizeText(readFileSync(abs, "utf8"));
    if (isStructuredRel(rel)) {
      const blocks: string[] = [];
      const value = isYamlRel(rel) ? parseYaml(text, rel) : parseJson(text, rel);
      if (rel === "agent/models.yml" && !isRecord(value.providers)) fail("repo models.yml has no providers mapping");
      const checked = rel === "agent/lsp.json" || rel === "agent/mcp.json" ? (normalizeServerCommands(value, rel, "repo", blocks) as Record<string, unknown>) : value;
      for (const b of blocks) fail(`deploy denied: ${b}`);
      const findings: SecretFinding[] = [];
      findSecretFields(checked, rel, "", findings);
      if (findings.length > 0) fail(`deploy denied: ${rel} has unredacted secret fields: ${findings.map((f) => f.path).join(", ")}`);
      if (rel === "agent/config.yml") {
        const leaked = CONFIG_STRIPPED_KEYS.filter((k) => k in checked);
        if (leaked.length > 0) fail(`deploy denied: agent/config.yml must not contain machine-local keys ${leaked.join(", ")}`);
      }
    }
    const hits = scanTextForSecrets(text, rel, knownSecrets);
    if (hits.length > 0) {
      for (const h of hits) fail(`deploy denied: ${h}`);
    }
  }

  // 仓库清单决定覆盖与删除；不读取或比较本机基线。
  const files = repoRels;
  const repoSet = new Set(repoRels);
  const deletes = liveRels.filter((rel) => !repoSet.has(rel));
  // 仓库文件可能取代本机目录；只能清理包含待删除受管文件和普通空目录的树。
  const deleteSet = new Set(deletes);
  const removeDirs: string[] = [];
  const collectReplaceableDirs = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory() && EXCLUDED_DIR_NAMES[entry.name] !== true) {
        collectReplaceableDirs(join(abs, entry.name), childRel);
      } else if (!entry.isFile() || !deleteSet.has(childRel)) {
        fail(`deploy denied: non-managed content blocks repo file ${rel}: ${childRel}`);
      }
    }
    removeDirs.push(rel);
  };
  for (const rel of files) {
    const abs = sideAbs(home, true, rel);
    try {
      if (lstatSync(abs).isDirectory()) collectReplaceableDirs(abs, rel);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
  }
  let backupDir: string | null = null;
  if (opts.backup && liveRels.length > 0) {
    backupDir = createBackupDir(home);
    const used = new Set<string>();
    for (const rel of liveRels) {
      let name = backupFlatName(rel);
      while (used.has(name.toLowerCase())) name = `${name}.${sha256(rel)}`;
      used.add(name.toLowerCase());
      copyFileSync(sideAbs(home, true, rel), join(backupDir, name));
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ files, deletes, removeDirs, backupDir }));
  } else {
    console.log(`deploy guard passed: ${files.length} managed files to deploy, ${deletes.length} to delete`);
    if (backupDir) console.log(`  已备份将被覆盖或删除的本机文件到: ${backupDir}`);
  }
}

function opRecordState(repoRoot: string, home: string): void {
  const skips: string[] = [];
  writeState(home, liveManifest(home, skips));
  console.log("recorded sanitized live baseline (config-sync/state.json)");
}

function opDeployModels(repoRoot: string, home: string, output: string): void {
  const repoAbs = join(repoRoot, "agent", "models.yml");
  if (!existsSync(repoAbs)) fail("deploy denied: repo missing agent/models.yml");
  const repoVal = parseYaml(normalizeText(readFileSync(repoAbs, "utf8")), "agent/models.yml");
  if (!isRecord(repoVal.providers)) fail("repo models.yml has no providers mapping");

  const liveAbs = join(home, "agent", "models.yml");
  let liveProviders: Record<string, unknown> = {};
  if (existsSync(liveAbs)) {
    try {
      const liveVal: unknown = Bun.YAML.parse(normalizeText(readFileSync(liveAbs, "utf8")));
      if (isRecord(liveVal) && isRecord(liveVal.providers)) liveProviders = liveVal.providers;
      else console.error("[config-sync] live models.yml has no readable providers mapping; original is retained in backup");
    } catch {
      console.error("[config-sync] live models.yml cannot be parsed; original is retained in backup");
    }
  }

  const out = structuredClone(repoVal);
  const outProviders = out.providers as Record<string, unknown>;
  const unfilled: string[] = [];
  for (const [name, provider] of Object.entries(outProviders)) {
    if (!isRecord(provider)) continue;
    const current = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
    const liveProvider = liveProviders[name];
    const liveKey = isRecord(liveProvider) && typeof liveProvider.apiKey === "string" ? liveProvider.apiKey.trim() : "";
    let source: "live" | "env" | "placeholder" = "placeholder";
    let key = "";
    if (liveKey.length > 0 && !PLACEHOLDER_RE.test(liveKey)) {
      key = liveKey;
      source = "live";
    } else if (PLACEHOLDER_RE.test(current)) {
      const envName = DEPLOY_ENV_BY_PROVIDER[name];
      const envVal = envName ? (process.env[envName] ?? "").trim() : "";
      if (envName && envVal.length > 0) {
        key = envVal;
        source = "env";
      }
    }
    if (source === "placeholder") {
      if (PLACEHOLDER_RE.test(current)) unfilled.push(`${name} -> ${current}`);
      continue;
    }
    outProviders[name] = { ...provider, apiKey: key };
    console.log(`  provider ${name}: apiKey kept (source: ${source === "live" ? "live value" : `env ${DEPLOY_ENV_BY_PROVIDER[name]}`})`);
  }

  const content = serializeStructured("agent/models.yml", out);
  writeBatch([{ targetAbs: resolve(output), rel: "agent/models.yml", content, originalRaw: existsSync(output) ? readFileSync(output) : null, backupDir: null }]);
  console.log(`models.yml deployed: ${output}`);
  if (unfilled.length > 0) {
    console.log("providers still using placeholders (fill manually or set env):");
    for (const u of unfilled) console.log(`  ${u}`);
  } else {
    console.log("all provider apiKeys configured");
  }
}

function opSetShell(repoRoot: string, home: string, file: string, shell: string | null): void {
  void repoRoot;
  void home;
  const abs = resolve(file);
  if (!existsSync(abs)) fail(`set-shell: file not found: ${file}`);
  const parsed = parseYaml(normalizeText(readFileSync(abs, "utf8")), "config.yml");
  const changed =
    shell === null ? "shellPath" in parsed : parsed.shellPath !== shell;
  if (!changed) {
    console.log(`set-shell: no change (shellPath=${shell ?? "<delete>"})`);
    return;
  }
  if (shell === null) delete parsed.shellPath;
  else parsed.shellPath = shell;
  const content = serializeStructured("agent/config.yml", parsed);
  writeBatch([{ targetAbs: abs, rel: "agent/config.yml", content, originalRaw: readFileSync(abs), backupDir: null }]);
  console.log(shell === null ? "removed config.yml shellPath (omp falls back to default shell)" : `wrote config.yml shellPath: ${shell}`);
}

// ---------- CLI ----------

function parseArgs(argv: string[]): { op: string; opts: Record<string, string>; flags: Record<string, true> } {
  const [op, ...rest] = argv;
  if (!op) fail("missing operation. usage: bun scripts/config-sync.ts <check|export|guard-deploy|record-state|deploy-models|set-shell> --repo <abs> --home <abs>");
  const opts: Record<string, string> = {};
  const flags: Record<string, true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--backup" || a === "--json") flags[a.slice(2)] = true;
    else if (a.startsWith("--")) {
      const v = rest[++i];
      if (v === undefined) fail(`argument ${a} requires a value`);
      opts[a.slice(2)] = v;
    } else fail(`unknown argument: ${a}`);
  }
  if (!opts.repo || !opts.home) fail("--repo <absolute path> and --home <absolute path> are required");
  return { op, opts, flags };
}

function main(): void {
  const { op, opts, flags } = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(opts.repo);
  const home = resolve(opts.home);
  if (!existsSync(repoRoot)) fail(`repo path not found: ${opts.repo}`);
  switch (op) {
    case "check":
      return opCheck(repoRoot, home);
    case "export":
      return opExport(repoRoot, home);
    case "guard-deploy":
      return opGuardDeploy(repoRoot, home, { backup: flags.backup === true, json: flags.json === true });
    case "record-state":
      return opRecordState(repoRoot, home);
    case "deploy-models": {
      if (!opts.output) fail("deploy-models 需要 --output <目标 models.yml 路径>");
      return opDeployModels(repoRoot, home, opts.output);
    }
    case "set-shell": {
      if (!opts.file) fail("set-shell 需要 --file <config.yml 路径>");
      return opSetShell(repoRoot, home, opts.file, opts.shell ?? null);
    }
    default:
      fail(`unknown operation: ${op}`);
  }
}

if (import.meta.main) main();
