# 配置同步（scripts/config-sync.ts + sync-from-live.ps1 + setup.ps1）

## 受管范围
- 固定文件：`agent/{config.yml,settings.json,models.yml,lsp.json,mcp.json}`（仓库相对路径）
- 目录（递归）：`agent/agents/**`、`skills/**`
- 本机侧映射：`agent/*` → `~/.omp/agent/*`；`skills/*` → `~/.omp/agent/skills/*`（helper `sideAbs()`）

## 默认浏览器
- `agent/config.yml` pins `ego-browser` through `skills.includeSkills`, so OMP always loads its instructions and prefers ego-browser for browser tasks.
- `browser.relay: true` retains OMP's native browser relay as an available capability; it does not automatically route browser tasks to ego-browser.
- The skill lives at `skills/ego-browser/` and `setup.ps1` deploys it under `~/.omp/agent/skills/ego-browser/`; ego lite itself and its local browser profile/login must be installed on each computer separately.

## 命令
- `.\sync-from-live.ps1` / `-Check`：只读检查（退出 0=无变化，2=有可导出变化，1=错误）
- `.\sync-from-live.ps1 -Export`：写入仓库（占位符脱敏、原子写、回滚、记录基线；不 commit/push）
- `.\setup.ps1 -Check`：部署预检（只跑 guard，不安装不复制）
- `.\setup.ps1`：drift guard → 安装 omp → 逐条复制 guard files 清单 → deploy-models → set-shell → LSP/MCP 探测 → record-state
- helper 直接调用：`bun scripts/config-sync.ts <check|export|guard-deploy|record-state|deploy-models|set-shell> --repo <abs> --home <abs>`

## 安全边界
- 真实 apiKey 永不入仓：导出时新 provider 用 `<PROVIDER_NAME_API_KEY>` 占位符
- 基线：`~/.omp/config-sync/state.json` = `{version:1, files:{rel:sha256}}`（脱敏归一化哈希，无正文无秘密）
- 备份：`~/.omp/config-sync/backups/<ts>-<pid>/`（icacls 私有 ACL；win: 当前用户 SID + SYSTEM）
- 导出/部署错误输出只含相对路径与字段路径；helper 用户可见消息一律 ASCII（避免 PS5.1 控制台 CJK 乱码）
- deploy-models：仓库为源；同 provider 本机真实 key 优先保留；`agent-plan`←`OMP_AGENT_PLAN_KEY`、`zhipu`←`ZHIPU_API_KEY`；其他保持占位符。仓库缺定义但本机有真实 key 的 provider → 拒绝部署
- set-shell：`--shell <pwsh>` 写入 shellPath；缺省删除（omp 回退默认）

## 无基线部署守卫允许的机器差异（`withAllowedMachinePaths`，双向归一）
- models.yml provider apiKey（真实值 vs 占位符 → 哨兵）
- models.yml `modelOverrides.*.reasoning`（仓库独有声明，不回退本机）

## 测试
`bun test ./scripts/config-sync.test.ts` — 24 个端到端测试（临时仓库 + 临时 USERPROFILE，真实子进程执行 PS 入口与 helper；PS5.1 参数解析、回滚注入、漂移拒绝、结构化序列化尾随空白均覆盖）。

## 日常次序（多机）
1. 本机改配置后：`sync-from-live.ps1 -Check` → `-Export` → 人工审查 → 只 stage 受管配置 → commit
2. `git pull --rebase` → 解冲突 → push（发布由用户手工执行）
3. 另一台机器：先 `-Check`/`-Export` 收集本机漂移 → 拉取 → `setup.ps1 -Check` → `setup.ps1`

## 已知取舍
- models.yml 结构化重写会丢弃 YAML 注释（Bun.YAML.stringify）；语义未变的文件不重写
- 结构化序列化会剥离行尾空白（Bun 1.3.x 的 `Bun.YAML.stringify` 会给带块级子项的键加尾随空格），导出/部署不再产生纯空白 churn；比较按解析值哈希，不受空白影响
- `pelican_bike.html` 等未跟踪文件与同步无关，永不触碰
