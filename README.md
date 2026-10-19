# omp-config

个人 Oh My Pi (omp) 配置仓库 — 跨机器同步配置、技能和工具。

## 三层同步模型

| 层级 | 路径 | 角色 |
|------|------|------|
| 运行层 | `~/.omp`（各机器本地） | omp 实际读取的配置；机器本地项（`shellPath`、`setupVersion`）只存在于这一层 |
| 仓库层 | 本仓库克隆 | 同步中转，模型定义（`models.yml`）与技能以此为源 |
| 真源层 | GitHub `origin/master` | 跨机器共同真源，所有机器从这里 pull |

配置同步全流程可视化：[docs/omp-config-sync.html](docs/omp-config-sync.html)（源文件 `docs/omp-config-sync.workflow.json`）

```mermaid
flowchart LR
    GH["GitHub（真源）"] -- "git pull" --> Repo["仓库克隆"]
    Repo -- "setup.ps1（部署）" --> Live["~/.omp（运行层）"]
    Live -- "sync-from-live.ps1（提升）" --> Repo
    Repo -- "git push" --> GH
```

- **拉方向**（部署）：`git pull` → `setup.ps1`。先跑 drift guard（本机基线校验 + 仓库边界校验）再覆盖部署，密钥按 provider 保留本地已填值。
- **推方向**（提升）：`sync-from-live.ps1 -Check / -Export`。默认只读检查；显式 `-Export` 才把运行层改动写入仓库（不 commit、不 push），真实 apiKey 永不入仓（详见文末「反向同步」，安全细节见 `docs/config-sync.md`）。
- **分工**：`models.yml` 模型定义与计价、`skills/`、`lsp.json`、`mcp.json`、`agents/`、`config.yml`、`settings.json` 均受管双向流动（导出只增不删；仓库独有内容保留）。

## 分支

| 分支 | 角色 |
|------|------|
| `master` | **纯配置同步**（本仓库真源）：不含任何 bundle 补丁，状态栏不显示 cost |
| `bench-speed` | 在 `master` 之上保留模型输出速度测试（`scripts/bench-speed.ts` + README 测速章节） |
| `cny-patch-tiers` | 在 `master` 之上叠加人民币 cost 状态栏补丁（`scripts/omp-cny-patch.mjs` 三态：coding plan / free / ¥） |

## 目录结构

```
omp-config/
├── agent/                    # → ~/.omp/agent/
│   ├── agents/               # → ~/.omp/agent/agents/ 子代理定义（含 codebase-memory 三档）
│   ├── config.yml            # 全局配置（modelRoles, memory/mnemopi, TUI；shellPath 由 setup 探测）
│   ├── lsp.json              # LSP 服务器（默认 PATH 裸名，setup 探测覆盖）
│   ├── mcp.json              # MCP 服务器（默认 PATH 裸名，setup 探测覆盖）
│   ├── models.yml            # 模型提供商 + 人民币计价；apiKey 仓库留占位符，本地手动填（setup 不再交互）
│   └── settings.json         # 持久化设置
├── skills/                   # → ~/.omp/agent/skills/
├── docs/                     # 配置同步流程可视化（HTML + mermaid 源）
├── setup.ps1                 # 一键部署脚本（仓库 → ~/.omp，Windows / PowerShell，纯配置无补丁；含 drift guard）
├── sync-from-live.ps1        # 反向同步脚本（~/.omp → 仓库，默认只读，-Export 才写入；密钥不入仓）
├── scripts/
│   ├── config-sync.ts        # 配置同步 helper（Bun）：check/export/guard-deploy/record-state/deploy-models/set-shell
│   └── config-sync.test.ts   # 端到端测试（bun test，临时 fixture，不触碰真实 ~/.omp）
├── doctor.ps1                # 只读健康检查（不自动修复）
└── README.md
```

## 在新机器上安装

> **PowerShell**：`setup.ps1` 同时支持 Windows PowerShell 5.1 与 PowerShell 7+（脚本已带 UTF-8 BOM，中文注释/输出在两种环境下均解析正常；终端若显示中文乱码仅影响显示，不影响执行）。

前置条件：
- 已安装 [`bun`](https://bun.sh)：`setup.ps1` 用 `bun install -g` 安装/升级 omp
- 已安装语言服务器 `gopls`、`pylsp`（未装则保留裸名命令，仅对应语言无补全）

omp 由 `setup.ps1` 自动安装/升级到推荐版本 **18.8.3**（版本不符即重装）；支持自定义 `BUN_INSTALL`（`setup.ps1` / `doctor.ps1` 同一约定）。

### 步骤（一键部署）

```powershell
# 1. 克隆仓库
cd ~
git clone git@github.com:mr-money/omp-config.git

# 2. 一键部署（复制配置 + 探测路径 + 环境变量注入 key）
cd omp-config
.\setup.ps1
```

脚本流程（自动执行，无需手动抄步骤）：
1. 校验 bun 已安装（缺失即退出）
2. **drift guard**（先于一切写入）：本机基线校验（有基线时新增/修改/删除均拒绝）+ 仓库边界校验（占位符/秘密/可移植路径），拒绝时退出且本机零改动
3. 安装/升级 omp 到推荐版本（`$RecommendedOmpVersion`，非匹配即重装）、按 guard files 清单逐条复制受管文件（`agent/`、`agents/`、`skills/`）
4. `deploy-models`：仓库 models.yml 为源，按 provider 保留本机真实 key / 注入环境变量（`OMP_AGENT_PLAN_KEY`/`ZHIPU_API_KEY`），其余保留 `<...>` 占位符并提示手动编辑
5. `set-shell`：探测 pwsh，结构化写回 `shellPath`（无 pwsh 则删除）；探测 gopls/python/codebase-memory-mcp 路径写回 LSP/MCP 配置
6. 记录本机基线（`config-sync/state.json`）；失败不刷新、保留私有备份
7. 完成（不部署任何 bundle 补丁，omp 保持原样）

只读健康检查：`.\doctor.ps1`。它检查 Bun、OMP/bundle 版本、四个配置文件（`config.yml` / `models.yml` / `lsp.json` / `mcp.json`）存在性及 gopls/python/codebase-memory-mcp 是否可用（工具按 PATH 判定），不会自动修复。注意它只查部署健康，不查 live 与仓库之间的内容漂移——漂移用 `.\sync-from-live.ps1 -Check` 查看（无差异退出 0 并明确输出）。

### 配置项一览

| 文件 | 字段 | 部署方式 | 说明 |
|------|------|----------|------|
| `~/.omp/agent/models.yml` | `apiKey` | 环境变量注入 / 本地手动编辑 | 各 provider 的 key：Agent Plan `OMP_AGENT_PLAN_KEY`、智谱 `ZHIPU_API_KEY`。setup **不再交互**——设了环境变量就自动写入，没设则保留 `<...>` 占位符；重部署按 provider 保留本地已填真实 key，结尾列出未填项 |
| `~/.omp/agent/lsp.json` | `servers.*.command` | setup 探测覆盖 | 默认 PATH 裸名（`gopls` / `python -m pylsp`）；探测到绝对路径则写回 |
| `~/.omp/agent/mcp.json` | `mcpServers.*.command` | setup 探测覆盖 | 默认 PATH 裸名（`codebase-memory-mcp`）；探测到绝对路径则写回。二进制需每台机器单独装，见「代码知识图谱 MCP」一节 |
| `~/.omp/agent/agents/` | — | 直接复制 | 子代理定义（`codebase-memory` 三档）；omp 通过 `task` 的 `agent` 字段调用 |
| `~/.omp/agent/config.yml` | `shellPath` | setup 探测写入 | 检测到 pwsh 则自动写入；未检测到则省略（omp 回退到 cmd.exe） |
| `~/.omp/agent/config.yml` | `statusLine` | 直接复制 | 自定义状态栏：custom 段列表（无 cost 段）、git 只显分支名、path 缩写、模型名带思考档位 |
| `~/.omp/agent/settings.json` | — | 直接复制 | 不再单独设 shellPath，统一走 config.yml |
| `~/.omp/agent/config.yml` | `extendedContext` | 直接复制 | 当前为 `false`；`cycleOrder` 为 `default → smol → slow → tiny` |
| `~/.omp/agent/config.yml` | `defaultThinkingLevel` / `hideThinkingBlock` | 直接复制 | 默认思考档 `auto`；`hideThinkingBlock: true` 隐藏思考块 |
| `~/.omp/agent/config.yml` | `images.describeForTextModels` | 直接复制 | `true`：文本模型收到图片时委托 `vision` 角色描述（见「视觉能力配置」） |
| `~/.omp/agent/config.yml` | `retry.fallbackChains` | 直接复制 | 联网搜索失败回退链，25 项按序（见「联网搜索」） |
| `~/.omp/agent/config.yml` | `commands` | 直接复制 | 命令来源开关：`enableClaudeUser`（`~/.claude/commands/`）、`enableOpencodeProject`（`.opencode/commands/`） |

### 验证

```powershell
# 启动 omp，状态栏显示：品牌 · 模型+思考档 · plan模式 · 路径 · git分支 · 上下文% ｜ 会话名（无 cost 段）
omp
```

## 配置详解

以下各节说明部署到 `~/.omp` 的关键配置块。

### 状态栏 (`config.yml` → `statusLine`)

```yaml
statusLine:
  preset: custom
  leftSegments: [pi, vim, model, mode, collab, path, git, pr, context_pct]
  rightSegments: [session_name]
  separator: powerline-thin
  segmentOptions:
    git:
      showBranch: true         # 只显示分支名
      showStaged: false        # 隐藏 +N（已暂存）
      showUnstaged: false      # 隐藏 *N（未暂存）
      showUntracked: false     # 隐藏 ?N（未跟踪）
    path:
      abbreviate: true         # 长路径缩写
      maxLength: 40
      stripWorkPrefix: true
    model:
      showThinkingLevel: true  # 模型名旁显示思考档位
```

段列表不含 `cost`（不显示任何费用信息），git 段只显示分支名。

### 模型角色 (`config.yml` → `modelRoles`)

| 角色 | 模型 | 思考档位 | 用途 |
|------|------|----------|------|
| `default` | commandcode/deepseek/deepseek-v4.1-flash | `high` | 默认主模型，日常编码 |
| `plan` | commandcode/claude-sonnet-5-5 | `auto` | 任务规划阶段 |
| `slow` | commandcode/claude-sonnet-5-5 | `medium` | 深度推理 / 复杂问题 |
| `smol` | commandcode/xiaomi/mimo-v2.6-pro | — | 轻量快速任务 |
| `tiny` | commandcode/inclusionai/ling-3.1-flash:free | — | 轻量后台任务（会话标题 / 记忆抽取） |
| `commit` | commandcode/inclusionai/ling-3.1-flash:free | `auto` | 生成 commit message |
| `task` | commandcode/inclusionai/ling-3.1-flash:free | `auto` | 任务子代理（委派多步任务） |
| `advisor` | commandcode/z-ai/glm-5.3-flash | `high` | 顾问模式 |
| `vision` | commandcode/z-ai/glm-5.3-flash | `high` | 视觉 / 图片理解（见「视觉能力配置」） |
| `web` | web/tavily | — | 联网搜索主通道（失败回退链见「联网搜索」） |
| `DeepSeek` | deepseek/deepseek-flash | `auto` | 官方 DeepSeek API（omp 内置 provider，配 Key 后启用；备用，不在 `cycleOrder` 中） |
| `agent-plan` | agent-plan/deepseek-v4.1-flash | `high` | 火山方舟 Agent Plan 通道（订阅制，1M 上下文） |

**思考档位循环 (`cycleOrder`)**: `default` → `smol` → `slow` → `tiny`。

### 联网搜索 (`config.yml` → `modelRoles.web` + `retry.fallbackChains.web`)

- **主通道**：`web` 角色 = `web/tavily`。
- **失败回退链**（`retry.fallbackChains.web`，按序）：`web/perplexity` → `google-gemini-cli/gemini-2.5-flash` → `google-antigravity/gemini-2.5-flash` → `google/gemini-2.5-flash` → `anthropic/claude-haiku-4-5` → `openai-codex/gpt-5.6-luna` → `xai/grok-4.5` → `web/zai` → `web/exa` → `web/tinyfish` → `web/jina` → `web/kagi` → `web/firecrawl` → `web/brave` → `web/kimi` → `web/parallel` → `web/synthetic` → `web/searxng` → `web/startpage` → `web/duckduckgo` → `web/ecosia` → `web/google` → `web/mojeek` → `web/public` → `web/hosted`。
- 排序意图：先走托管搜索/通用模型（perplexity、gemini、haiku、grok），再走需要 key 或自建/公共实例的 `web/*` 提供方，最后兜底 `web/hosted`。
- 旧写法 `providers.webSearchOrder` 已被这套取代（omp bundle 里它只是 `providers.webSearch` 的遗留别名），本配置不再保留该键。

### 命令来源 (`config.yml` → `commands`)

| 键 | 值 | 含义（omp 内部标签） |
|----|----|----------------------|
| `enableClaudeUser` | `true` | Claude User Commands —— 从 `~/.claude/commands/` 读取命令（omp 默认 `false`，此处显式打开） |
| `enableOpencodeProject` | `true` | OpenCode Project Commands —— 从 `.opencode/commands/` 读取命令（omp 默认即 `true`） |

### 视觉能力配置 (`models.yml` → `commandcode.modelOverrides`)

`commandcode` 是 omp **内置 provider**。omp 内置目录把它的**全部 85 个模型都声明为 `input: [text]`**（`omp models commandcode` 显示 `images=no`），于是 `vision` 角色解析失败、图片在发送前被摘除。

实测（直连 `api.commandcode.ai`，用带随机 token / 随机图形数量的探针图判定，能读出才算支持）确认 **36 个模型支持图片输入**，其声明已在 `models.yml` 覆盖：

```yaml
providers:
  commandcode:
    modelOverrides:
      "z-ai/glm-5.3-flash":        # openai-completions 线
        input: [text, image]
        compat:
          stripImageInput: false   # 必须同时写，否则能力判定仍为 false
      "claude-sonnet-5-5":         # anthropic-messages 线
        input: [text, image]       # anthropic 线只需 input
```

要点：

- **两条协议线 URL 不同，但配置层无需区分**——omp 按每个模型自身的 `api` 字段选协议：`openai-completions` → `/v1/chat/completions` + `image_url` 内容块；`anthropic-messages` → `/v1/messages` + base64 image source。
- **openai 线的能力判定是 `input 含 image` **且** `compat.stripImageInput == false`**，所以 35 个 openai 线模型两项都写；唯一的 anthropic 线模型（`claude-sonnet-5-5`）只写 `input`。
- **回退链**：omp 视觉模型解析顺序为 `@vision → @default → 当前激活 → 第一个具备视觉的可用模型`。`vision` 角色指向 `commandcode/z-ai/glm-5.3-flash`，声明正确后 `@vision` 直接命中；文本主模型收到图片时（`images.describeForTextModels: true`）会委托该角色描述，或由模型自行 `read ?q=` 兜底。
- **未声明的模型**（订阅不含、或实测明确拒绝图片的）：保持 text-only；遇到图片会自动回退到 `glm-5.3-flash`。
- 覆盖清单 36 个：`MiniMaxAI/MiniMax-M3`、`Qwen/Qwen3.6-Plus`、`Qwen3.7-Flash/Plus`、`Qwen3.8-27B/Flash/Max/Max-0902/Omni-Flash`、`claude-sonnet-5-5`、`deepseek/deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash(-fast)`、`google/gemini-3.7-flash`、`gemini-3.8-flash`、`gpt-5.6-luna/sol`、`gpt-6-luna`、`mistral/mistral-large-4`、`moonshotai/Kimi-K2.5/K2.6/K2.7-Code(-Highspeed)/K3`、`stepfun/Step-3.5-Flash`、`Step-5-Preview`、`xai/grok-4.5/4.6/4.7`、`xiaomi/mimo-v2.5`、`mimo-v2.6-flash/pro/pro-ultraspeed`、`z-ai/glm-5.3-flash(x)`。

### 长期记忆 (`config.yml` → `memory` / `mnemopi`)

```yaml
memory:
  backend: mnemopi
mnemopi:
  scoping: per-project-tagged   # 写入项目库；召回时合并共享全局库
  embeddingVariant: multilingual # intfloat/multilingual-e5-large（本地 ONNX，中文语义召回）
  recallLimit: 10                # 每次召回最多注入的记忆条数（默认 8）
```

设计依据（源码验证，pi-mnemopi 18.x）：

- **`per-project-tagged` 优于 `per-project`**：写入项目隔离，召回还能带上全局记忆——跨项目通用经验（如方舟网关踩坑）仍可浮现。
- **不要开 `noEmbeddings: true`**：FTS5 默认 `unicode61` tokenizer 对中文按整句切分（无分词），关掉向量召回会让中文查询只能逐字命中；`multilingual` e5 本地推理无网络依赖、无费用，是中文召回主力。
- **`llmMode: smol`**：事实抽取/整理走轻量 `tiny`→`smol` 角色（commandcode 轻量模型），不占用主模型额度。
- **consolidation 需手动触发**：正常退出只做轻量 drain，working → episodic 晋级与图谱构建仅在 `/memory enqueue` 时发生（且只整理 >12h 的行）；重要会话结束前跑一次。
- **进阶开关保持关闭**：`polyphonicRecall` 的 graph voice 依赖 consolidation 产生的 `gists`/`graph_edges`（未触发时恒为空）；`proactiveLinking` 的实体抽取为英文偏置正则，中文收益微弱。

### 代码知识图谱 MCP（`codebase-memory-mcp`）

[DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)：把代码库索引成常驻知识图谱的 MCP 服务器（单文件静态二进制、零依赖，17 个工具：`search_graph` / `trace_path` / `get_code_snippet` / `get_architecture` / `query_graph` / `index_repository` / `check_index_coverage` 等）。本仓库同步它的 omp 侧三件套：

| 仓库路径 | 部署到 | 作用 |
|----------|--------|------|
| `agent/mcp.json` | `~/.omp/agent/mcp.json` | MCP 服务器声明（仓库存 PATH 裸名，setup 探测后写绝对路径） |
| `agent/agents/codebase-memory*.md` | `~/.omp/agent/agents/` | 三档子代理：`codebase-memory`（图验证）/ `codebase-memory-scout`（快速只读侧信道）/ `codebase-memory-auditor`（覆盖度审计），各带工具白名单与证据纪律 |
| `skills/codebase-memory/SKILL.md` | `~/.omp/agent/skills/codebase-memory/` | 触发词与工具用法矩阵（explore the codebase / who calls X / impact analysis / dead code …） |

**二进制与索引库不在仓库内**——每台机器各自安装、版本独立：

```powershell
# 装/升级（官方脚本，幂等）。--skip-config = 只装二进制 + 写 PATH，不碰任何 agent 配置
$d = "$env:TEMP\cbm-setup"; New-Item -ItemType Directory -Force $d | Out-Null
irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile "$d\install.ps1"
pwsh -File "$d\install.ps1" --skip-config
```

装完重启 omp 会话生效——MCP 服务器在**会话启动时**连接（实测新会话启动 2 秒内拉起进程），不是等你第一次查代码。索引库落在 `~/.cache/codebase-memory-mcp/`；共享 daemon 由首个会话拉起，最后一个客户端断开后退出。

`mcp.json` 里的裸名 `codebase-memory-mcp` 依赖安装器写入 PATH（只有新起的进程才看得到），setup 探测到可执行文件后会直接写成绝对路径，避免 PATH 未刷新的会话连不上。

**用法要点**（本机实测）：

- omp **不会**自动把 `grep`/`read` 换成图查询。它只做三件事：把服务器 `instructions` 注入系统提示（"Graph first: search_graph for symbols…"）、按触发词暴露 skill、提供三个带工具白名单的子代理。要必用就在提示里点名（"用 codebase-memory 查谁调用了 X"）或直接委派子代理。
- 查询必须给**精确项目名**（`project` 参数），默认取仓库目录名；名字不对返回空结果而不是报错。
- `auto_watch` / `watcher_enabled` 默认 `true`：已索引过的 git 仓库由 daemon 后台跟踪变更，无需手动重建索引（`.git`、`.gitignore` 内容不入图）。
- `auto_index` 默认 `false`：新仓库首次连接**不会**自动索引。想全自动：`codebase-memory-mcp config set auto_index true`；否则每个新仓库首次手动 `index_repository`。
- 非 git 目录默认不 watch，需要 `config set watch_non_git true`。
- 自带图 UI：`codebase-memory-mcp --ui=true --port=9749` → `http://127.0.0.1:9749`（默认已开，由 daemon 托管）。
- 卸载：`codebase-memory-mcp uninstall -y --delete-indexes`（连索引一起删）；omp 侧删掉 `mcp.json` 里的条目、`agent/agents/codebase-memory*.md`、`skills/codebase-memory/`。
- CBM 自带的 `install --clients=omp -y` 会重写 `~/.omp/agent/mcp.json`（写成它解析出的绝对路径），与本仓库 setup 探测的产物等价，两者可混用。

### 浏览器操控 (`skills/chrome-cdp-attach`)

驱动用户**已登录**的真实 Chrome（百度轻舸/投放后台、内部看板等），按 Profile 区分登录态，无逐次授权弹窗：

- 前置：`omp browser-relay install` 写出扩展 → 在 **Chrome** 的 `chrome://extensions` 开发者模式手动加载 `~/.omp/browser-relay/extension`（无法脚本化）→ `omp config set browser.relay true`（**仓库 `agent/config.yml` 已开启**）。扩展文件由 omp 版本生成，不入仓。
- 用法：`browser.open({ name, app: { relay: true, target: "<URL/标题子串>" } })`；不带 `target` 采用当前可见标签页，此时**再传 `url` 会把它导航走**。健康检查：`curl http://127.0.0.1:9224/json/version`（200=扩展在线，503=等服务/等扩展，连接被拒=relay 未起，下次浏览器调用自动拉起）。
- 硬规则：默认只读（不点保存/删除/发布、不 navigate 用户可见标签页、不读 Cookie/Token）；relay 会话就是用户真实浏览器，动作记在用户账号下。
- 备用路线（未装扩展时）：直连 CDP over WebSocket——Chrome 136+ 对默认 user-data-dir 加固后 `/json/version` 返回 404，裸 WS 握手仍可用，但每次连接需点一次「要允许远程调试吗」。

### 模型提供商 (`models.yml`)

火山方舟 Agent Plan（`agent-plan` provider，订阅制，OpenAI 兼容）：
- **deepseek-v4.1-flash** — Agent Plan 通道 DeepSeek V4.1 Flash（1M 上下文，多模态文本+图像，393K 输出，`reasoning`）
- **glm-5-3-flash** — Agent Plan 通道 GLM 5.3 Flash（多模态文本+图像，1M 上下文）
- **glm-5.3** — Agent Plan 通道 GLM-5.3（1M 上下文，text-only）
- `baseUrl: https://ark.cn-beijing.volces.com/api/plan/v3`；仓库中占位脱敏，部署后本地填入

图片生成 Skill（`~/.omp/agent/skills/byted-ark-seedream-skill/`）：豆包 Seedream 生图（Agent Plan 专属版），支持文生图/图生图/连贯组图/联网搜索；API Key 走 `~/.omp/agent/.env` 的 `ARK_SEEDREAM_API_KEY`，图片默认存启动目录 `Seedream-Images/`（已加入 `.gitignore`）。

智谱 GLM（`zhipu` provider，智谱开放平台，OpenAI 兼容）：
- **glm-5.3-flash** — `Zhipu` 角色备用；多模态（文本+图像），1M 上下文，131K 输出上限，`reasoning`（思考档位 `low/high/max`，默认 `max`）
- `baseUrl: https://open.bigmodel.cn/api/paas/v4`，请求自动落到 `/chat/completions`；`open.bigmodel.cn` 主机会被自动识别为智谱，走 `zai` thinking 方言（`thinking.type: enabled` + `reasoning_effort`，工具调用时自动开启 `tool_stream`）
- 价格（元/百万 tokens）：输入 **0.8**、输出 **2.8**、缓存命中 **0.23**、缓存写入 **0.8**。`models.yml` `cost` 块**直接写人民币价**（master 状态栏不显示 cost，此价格供 API 记账/其他工具使用）。

Command Code（`commandcode` provider，omp **内置**，订阅制网关）：
- 默认主通道：`default` / `plan` / `slow` / `smol` / `tiny` / `commit` / `task` / `advisor` / `vision` 角色均指向此 provider 的模型
- **无需 `apiKey`/`baseUrl`**：由 omp 内置定义，登录凭证存于 omp 凭据库（`agent.db`）
- `models.yml` 只用 `modelOverrides` 覆盖：`inclusionai/ling-3.1-flash:free` 的上下文/输出上限，以及 36 个支持视觉的模型的 `input` 能力（见「视觉能力配置」）
- 计费与额度由订阅计划决定；`MODEL_NOT_IN_PLAN`（403）表示当前订阅未包含该模型

> **DeepSeek 官方通道（`deepseek` provider）**：`config.yml` 的 `DeepSeek` 角色指向**官方 DeepSeek API**。该 provider（`api.deepseek.com`）由 **omp 内置**，`models.yml` 中仅需一个 `deepseek:` 块写 `modelOverrides` 覆盖内置美元价为本项目的人民币价（见 `agent/models.yml`）。使用前只需在 omp 设置（`/models`）中为 `deepseek` 填入官方 API Key 即可启用。`deepseek-flash` 由官方 `/v1/models` 动态发现，价格靠 `modelOverrides` 固定，官方降价时改 `models.yml` 即可。

### 新增模型提供商节点（`models.yml`）

在 `providers:` 下追加一个 provider 块即可（参考现有 `zhipu` / `agent-plan` 节点）。**无需阅读 omp 底层代码**，只需满足以下几点：

```yaml
providers:
  myprovider:                       # ① 唯一 provider 名（小写字母/数字/连字符）
    baseUrl: https://…/v1          # ② OpenAI 兼容端点基址（不含 /chat/completions，omp 自动拼接）
    api: openai-completions        # ③ 固定 openai-completions（绝大多数厂商都兼容）
    apiKey: <MY_API_KEY>           # ④ 占位符脱敏；本地手动编辑填入（setup 不再交互，见下"占位符约定"）
    authHeader: true               # ⑤ 固定 true（key 走 Authorization: Bearer）
    models:
      - id: my-model               # ⑥ 模型 ID（API 请求里的 model 字段，必须与厂商一致）
        name: 显示名
        input: [text, image]       # ⑦ 能力声明：支持图像就写 [text, image]，否则 [text]
        contextWindow: 1000000     # ⑧ 上下文窗口（token）
        maxTokens: 65536           # ⑨ 输出上限（token）
        reasoning: true            # ⑩ 思考模型才写 true（自动派生思考档位）
        cost:                      # ⑪ 计价（**人民币/百万 tokens**）：直接写厂商人民币价（cny-patch-tiers 状态栏会原样显示）
          input: 0.8               #    输入价（元/百万 tokens）
          output: 2.8              #    输出价
          cacheRead: 0.23          #    缓存命中价
          cacheWrite: 0.8          #    缓存写入价
        compat:                    # ⑫ 绝大多数情况照抄，不用改
          supportsDeveloperRole: false
          maxTokensField: max_tokens
```

要点：

- **思考档位自动派生**：`reasoning: true` 后 omp 按模型 ID 自动识别（如 GLM-5.3+/Kimi K3 得到 `low/high/max`、默认 `max`），**不要**手写 `thinking:` 块，除非默认档位不对。
- **多模态**：厂商支持图像就把 `input` 写 `[text, image]`，omp 会自动按 `image_url` 内容块发送。
- **计价说明**：模型未写 `cost` 视为免费；写了 `cost` 按元/百万 tokens 记账。master 状态栏无 cost 段，`cost` 块只作记账真源（`cny-patch-tiers` 分支会把它显示成 ¥）。
- **验证**：`omp models ls` 应能看到新 provider 与模型；若有 `models.yml validation failed` 报错，说明字段名或取值不合法（对照上面模板检查）。
- **占位符约定**：仓库中 `apiKey` 一律用 `<XXX_API_KEY>` 占位脱敏；**setup 不再交互填 key**——部署时按 provider 保留本地已填的真实 key，未填项在结尾列出并提示手动编辑 `~/.omp/agent/models.yml`。已知 provider（Agent Plan/智谱）可选设环境变量（`OMP_AGENT_PLAN_KEY`/`ZHIPU_API_KEY`）自动注入；新增 provider 若要环境变量注入，需在 `setup.ps1` 的 `$envVarByProvider` 登记其环境变量名。

> **内置 provider 覆盖**：omp 内置 provider（`deepseek`、`anthropic`、`openai` 等）不写 `baseUrl`/`models` 也能在 `providers:` 下建块，只写 `modelOverrides` 即可覆盖内置模型的任意字段（`cost`/`contextWindow` 等）——`cost` 未覆盖的字段逐项回退内置价。

`setup.ps1` 幂等：重复运行覆盖最新配置、保留已填 API Key。部署前先跑 drift guard：本机受管内容相对基线（`~/.omp/config-sync/state.json`）有新增/修改/删除时拒绝部署，防止用仓库版本悄悄回退你在 omp 里改过的配置——此时先 `.\sync-from-live.ps1 -Export` 收集再部署。新机器无基线且无受管配置时直接允许。

## 反向同步（`~/.omp` → 仓库，手工发布）

在 omp 里改了角色/配置（`/models` 等）后，把改动提升回仓库，供其他机器部署：

```powershell
.\sync-from-live.ps1           # 只读检查（默认）：列出可导出变化与仓库独有项；退出码 2=有变化
.\sync-from-live.ps1 -Export   # 显式导出：写入仓库（含备份/原子写/回滚），并记录本机基线
```

- **不自动 commit / push**。发布由你手工执行：`git add`（只 stage 受管配置）→ `commit` → `git pull --rebase` → `push`
- 受管范围：`agent/{config.yml,settings.json,models.yml,lsp.json,mcp.json}`、`agent/agents/**`、`skills/**`；`.env`、数据库、缓存、会话永不读取
- `config.yml` 剥离 `shellPath` / `setupVersion`（机器本地状态不入仓）
- 导出是**添加与更新、不传播删除**：仓库独有键/模型/技能保留；需要删除请在仓库显式修改
- 秘密防线：候选正文命中已知本机秘密/`sk-…`/PEM 形态，或 MCP env 出现 `*TOKEN*` 等实值 → 整批拒绝；错误输出只含文件与字段路径，绝不显示值
- 首次在无基线的机器上部署：本机所有受管内容须与仓库语义一致（apiKey 真实值 vs 占位符、仓库新增 `reasoning:` 声明属允许的机器差异）才放行

## 日常同步节奏（推荐）

```powershell
# 改配置后（omp 内 /models 等）
.\sync-from-live.ps1           # 检查 → 审查摘要
.\sync-from-live.ps1 -Export   # 收集进仓库
git add agent skills; git commit; git pull --rebase; git push

# 到另一台机器
git pull; .\setup.ps1 -Check; .\setup.ps1   # 拉取 + 预检 + 部署

# 不确定哪边新？
.\sync-from-live.ps1           # 无差异退出 0；有差异退出 2 并列出
```

多台机器同时改过的收敛方式：先 `git pull --rebase`（收别人的），再 `-Export`（推自己的），冲突只在仓库层出现，手工解一次即可。完整安全模型与命令参考：[docs/config-sync.md](docs/config-sync.md)。
