# 配置同步（scripts/config-sync.ts + sync-from-live.ps1 + setup.ps1）

## 受管范围
- 固定文件：`agent/{config.yml,settings.json,models.yml,lsp.json,mcp.json,RULES.md}`（仓库相对路径；`RULES.md` 按文本同步）
- 目录（递归）：`agent/agents/**`、`skills/**`
- 本机侧映射：`agent/*` → `~/.omp/agent/*`；`skills/*` → `~/.omp/agent/skills/*`（helper `sideAbs()`）

日常部署是单向的：先从 GitHub 拉取到本地仓库，再运行 `setup.ps1`，以本地仓库的受管内容为准。本机漂移不阻止部署；仓库没有的本机受管技能和子代理文件先备份再删除。会话数据库、凭据库、`.env`、缓存和其他非受管数据不属于删除范围。`sync-from-live.ps1` 仅在有意将本机改动导出到仓库时使用，不是部署前提。

## 默认浏览器
- `agent/RULES.md` 将浏览器操作默认交给 Ego Lite 的 `ego-browser` 技能；静态网页读取不受影响。部署时该文件会覆盖本机规则，原文件先备份；有意发布本机修改时使用 `sync-from-live.ps1 -Export`。
- `skills/ego-browser/SKILL.md` recommends ego-browser for browser tasks; it is deployed from `skills/**`. Keep `skills.includeSkills` unset so this preference does not filter other skills from OMP discovery.
- `browser.relay: true` retains OMP's native browser relay as an available capability; it does not automatically route browser tasks to ego-browser.
- The skill lives at `skills/ego-browser/` and `setup.ps1` deploys it under `~/.omp/agent/skills/ego-browser/`; ego lite itself and its local browser profile/login must be installed on each computer separately.

## 命令
- `.\sync-from-live.ps1` / `-Check`：只读检查（退出 0=无变化，2=有可导出变化，1=错误）
- `.\sync-from-live.ps1 -Export`：写入仓库（占位符脱敏、原子写、回滚、记录基线；不 commit/push）
- `.\setup.ps1 -Check`：部署预检（校验仓库边界和受管路径，不备份、不安装、不复制、不删除）
- `.\setup.ps1`：仓库边界校验 → 备份将被覆盖或删除的本机受管文件 → 安装 omp → 按仓库部署受管文件并删除仓库没有的本机受管技能和子代理文件 → deploy-models → set-shell → LSP/MCP 探测 → record-state；不因本机漂移拒绝
- helper 直接调用：`bun scripts/config-sync.ts <check|export|guard-deploy|record-state|deploy-models|set-shell> --repo <abs> --home <abs>`；`guard-deploy --json` 返回待部署文件、待删除文件、待删除空目录和备份目录，实际部署使用 `--backup`，预检不使用

## 安全边界
- 仓库仍须通过秘密和可移植性校验：真实 apiKey 不入仓，路径须可跨机器使用；导出时新 provider 用 `<PROVIDER_NAME_API_KEY>` 占位符
- 受管路径上的符号链接或目录链接会拒绝部署，避免跟随链接操作非受管位置
- 仓库文件需要取代本机目录时，仅删除必要的空目录；目录含非受管内容则拒绝，避免删除这些内容
- 基线：`~/.omp/config-sync/state.json` = `{version:1, files:{rel:sha256}}`（脱敏归一化哈希，无正文无秘密）；用于同步记录，不作为拒绝本机漂移的条件
- 备份：`~/.omp/config-sync/backups/<ts>-<pid>/`（icacls 私有 ACL；win: 当前用户 SID + SYSTEM）；部署前备份将被覆盖或删除的受管文件，备份文件名将路径分隔符替换为 `__`
- 导出/部署错误输出只含相对路径与字段路径；helper 用户可见消息一律 ASCII（避免 PS5.1 控制台 CJK 乱码）
- deploy-models：仓库为源；同 provider 本机真实 key 优先保留；`agent-plan`←`OMP_AGENT_PLAN_KEY`、`zhipu`←`ZHIPU_API_KEY`；`volcengine-coding` 留 `<VOLCENGINE_CODING_API_KEY>` 占位符，需在新机器本地填写；其他未映射 provider 保持占位符。本机独有 provider 不作为部署依据
- set-shell：`--shell <pwsh>` 写入 shellPath；缺省删除（omp 回退默认）；LSP/MCP 命令也按本机探测结果适配

## 每台机器仍需配置
仓库不携带所有机器依赖或登录状态。按需安装语言服务器、MCP 二进制、浏览器等，并配置本地浏览器 profile、API Key 和 OAuth 等登录凭据；setup 只能探测和适配已安装的机器路径。

## 测试
`bun test ./scripts/config-sync.test.ts` — 端到端测试使用临时仓库和临时 USERPROFILE，不触碰真实 `~/.omp`。

## 日常次序（多机）
1. 从 GitHub 拉取：`git pull`，然后可选 `setup.ps1 -Check` 预检，再运行 `setup.ps1`；本机漂移无需先导出。
2. 若有意发布本机改动：`sync-from-live.ps1 -Check` → `-Export` → 人工审查 → 只 stage 受管配置 → commit。
3. 发布时 `git pull --rebase` → 解冲突 → push；另一台机器再拉取并部署。

## 已知取舍
- models.yml 结构化重写会丢弃 YAML 注释（Bun.YAML.stringify）；语义未变的文件不重写
- 结构化序列化会剥离行尾空白（Bun 1.3.x 的 `Bun.YAML.stringify` 会给带块级子项的键加尾随空格），导出/部署不再产生纯空白 churn；比较按解析值哈希，不受空白影响
- `pelican_bike.html` 等未跟踪文件与同步无关，永不触碰
