# omp-config

个人 Oh My Pi (omp) 配置仓库 — 跨机器同步配置、技能和工具。

## 三层同步模型

| 层级 | 路径 | 角色 |
|------|------|------|
| 运行层 | `~/.omp`（各机器本地） | omp 实际读取的配置；机器本地项（`shellPath`、`setupVersion`）只存在于这一层 |
| 仓库层 | 本仓库克隆 | 同步中转，模型定义（`models.yml`）与技能以此为源 |
| 真源层 | GitHub `origin/master` | 跨机器共同真源，所有机器从这里 pull |

配置同步全流程可视化：[docs/omp-config-sync.html](docs/omp-config-sync.html)（archify 生成，源文件 `docs/omp-config-sync.workflow.json`）

```mermaid
flowchart LR
    GH["GitHub（真源）"] -- "git pull" --> Repo["仓库克隆"]
    Repo -- "setup.ps1（部署）" --> Live["~/.omp（运行层）"]
    Live -- "sync-from-live.ps1（提升）" --> Repo
    Repo -- "git push" --> GH
```

- **拉方向**（部署）：`git pull` → `setup.ps1`。覆盖式部署，密钥按 provider 保留本地已填值。
- **推方向**（提升）：`sync-from-live.ps1`。把运行层的配置改动提升回仓库并 push，`shellPath`/`setupVersion` 自动剥离，真实 apiKey 永不入仓（详见文末「反向同步」）。
- **分工**：`models.yml` 模型定义与计价、`skills/`、`lsp.json`、`mcp.json`、`agents/` 以仓库为源（推方向不回写）；`config.yml`、`settings.json` 等其余配置双向流动。

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
├── scripts/
│   └── bench-speed.ts        # 模型输出速度测试（仓库内 `bun` 运行，读 ~/.omp/agent/models.yml）
├── skills/                   # → ~/.omp/agent/skills/
├── setup.ps1                 # 一键部署脚本（仓库 → ~/.omp，Windows / PowerShell，纯配置无补丁）
├── sync-from-live.ps1        # 反向同步脚本（~/.omp → 仓库，密钥不入仓）
└── README.md
```

## 在新机器上安装

> **PowerShell**：`setup.ps1` 同时支持 Windows PowerShell 5.1 与 PowerShell 7+（脚本已带 UTF-8 BOM，中文注释/输出在两种环境下均解析正常；终端若显示中文乱码仅影响显示，不影响执行）。

- `setup.ps1` 会自动安装/升级 bun 全局包到推荐的 **OMP 18.8.3**（版本不同即重装）。支持自定义 `BUN_INSTALL`（`setup.ps1` / `doctor.ps1` 同一约定）。
- 已安装 `bun`
- 已安装语言服务器（gopls、pylsp 等）

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
1. 校验 bun / omp 已安装
2. 升级 omp 到推荐版本（`$RecommendedOmpVersion`，非匹配即重装）、复制 `agent/` → `~/.omp/agent/`、`skills/` → `~/.omp/agent/skills/`
3. 探测本机 pwsh / gopls / python / codebase-memory-mcp 路径，写回对应配置
4. 注入 API Key：**不再交互输入**——仅从环境变量（`OMP_AGENT_PLAN_KEY`/`ZHIPU_API_KEY`）读取，设了就写入对应 provider；未设置则保留 `<...>` 占位符。重部署时**按 provider 保留本地已填的真实 key**（通用扫描全部 provider，非硬编码），结尾列出仍为占位符的 provider 与文件路径，提示手动编辑
5. 完成（本分支不部署任何 bundle 补丁，omp 保持原样）

只读健康检查：`.\doctor.ps1`。它检查 Bun、OMP/bundle 版本、四个配置文件（`config.yml` / `models.yml` / `lsp.json` / `mcp.json`）存在性及 gopls/python/codebase-memory-mcp 是否可用（工具按 PATH 判定），不会自动修复。注意它只查部署健康，不查 live 与仓库之间的内容漂移——漂移用 `.\sync-from-live.ps1` 的预检查看（无差异时会明确输出"无需同步"）。

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
| `~/.omp/agent/config.yml` | `retry.fallbackChains` | 直接复制 | 联网搜索失败回退链，25 项按序（见「联网搜索」） |
| `~/.omp/agent/config.yml` | `commands` | 直接复制 | 命令来源开关：`enableClaudeUser`（`~/.claude/commands/`）、`enableOpencodeProject`（`.opencode/commands/`） |

### 验证

```powershell
# 启动 omp，状态栏显示：品牌 · 模型+思考档 · plan模式 · 路径 · git分支 · 上下文% ｜ 会话名（无 cost 段）
omp
```

### 状态栏 (`config.yml` → `statusLine`)

```yaml
statusLine:
  preset: custom
  leftSegments: [pi, vim, model, mode, collab, path, git, pr, context_pct]
  rightSegments: [session_name]
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
- **`llmMode: smol`**：事实抽取/整理走 `tiny`→`smol` 角色（doubao-seed-2.0-mini），免费额度内。
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

### 模型提供商 (`models.yml`)

火山引擎（方舟，coding plan 订阅制）——**当前已停用**：
- `volcengine-coding` provider 在 `models.yml` 中**整块注释保留**（订阅到期/未续费，实测报 `does not have a valid CodingPlan subscription`）；对应角色已改走其他 provider
- 保留块内的模型定义（glm-5.3 / glm-5-3-flash / doubao-seed-2.0-mini / doubao-seed-evolving / deepseek-v4-1-flash-260910）供日后恢复订阅时启用

火山方舟 Agent Plan（`agent-plan` provider，订阅制，OpenAI 兼容）：
- **deepseek-v4.1-flash** — Agent Plan 通道 DeepSeek V4.1 Flash（1M 上下文，多模态文本+图像，393K 输出，`reasoning`；实测 TTFT ~1.4-1.9s、~155-180 tok/s，小输入正常，大输入警惕 TTFT 挂起）
- **glm-5-3-flash** — Agent Plan 通道 GLM 5.3 Flash（多模态文本+图像，1M 上下文；实测 TTFT ~1.2s、~71 tok/s，与 coding plan 同名模型互为备用）
- 与 coding plan 共用方舟 API Key，`baseUrl: https://ark.cn-beijing.volces.com/api/plan/v3`；仓库中占位脱敏，部署后本地填入
- ⚠️ 实测该端点对 deepseek 存在**服务端间歇性 TTFT 挂起**（约 50% 概率 >60s 零字节，输入 ≥~5K tokens 时出现，小输入秒回；doubao 同端点正常）。配置无法修复——omp 卡 "working" 时 esc 重试即可；持续出现持 request id 找火山报障

图片生成 Skill（`~/.omp/agent/skills/byted-ark-seedream-skill/`）：豆包 Seedream 生图（Agent Plan 专属版），支持文生图/图生图/连贯组图/联网搜索；API Key 走 `~/.omp/agent/.env` 的 `ARK_SEEDREAM_API_KEY`，图片默认存启动目录 `Seedream-Images/`（已加入 `.gitignore`）。

智谱 GLM（`zhipu` provider，智谱开放平台，OpenAI 兼容）：
- **glm-5.3-flash** — `Zhipu` 角色备用；多模态（文本+图像），1M 上下文，131K 输出上限，`reasoning`（思考档位 `low/high/max`，默认 `max`）
- `baseUrl: https://open.bigmodel.cn/api/paas/v4`，请求自动落到 `/chat/completions`；`open.bigmodel.cn` 主机会被自动识别为智谱，走 `zai` thinking 方言（`thinking.type: enabled` + `reasoning_effort`，工具调用时自动开启 `tool_stream`）
- 价格（元/百万 tokens）：输入 **0.8**、输出 **2.8**、缓存命中 **0.23**、缓存写入 **0.8**。`models.yml` `cost` 块**直接写人民币价**（本分支状态栏不显示 cost，此价格供 API 记账/其他工具使用）。

Command Code（`commandcode` provider，omp **内置**，订阅制网关）：
- 默认主通道：`default` / `plan` / `slow` / `smol` / `tiny` / `commit` / `vision` 角色均指向此 provider 的模型
- **无需 `apiKey`/`baseUrl`**：由 omp 内置定义，登录凭证存于 omp 凭据库（`agent.db`）
- `models.yml` 只用 `modelOverrides` 覆盖两个模型：`inclusionai/ling-3.1-flash:free`（上下文/输出上限）与 36 个支持视觉的模型的 `input` 能力（见「视觉能力配置」）
- 计费与额度由订阅计划决定；`MODEL_NOT_IN_PLAN`（403）表示当前订阅未包含该模型

> **DeepSeek 官方通道（`deepseek` provider）**：`config.yml` 的 `smol` 与 `DeepSeek` 角色指向**官方 DeepSeek API**。该 provider（`api.deepseek.com`）由 **omp 内置**，`models.yml` 中仅需一个 `deepseek:` 块写 `modelOverrides` 覆盖内置美元价为本项目的人民币价（见 `agent/models.yml`）。使用前只需在 omp 设置（`/models`）中为 `deepseek` 填入官方 API Key 即可启用。`deepseek-flash` 由官方 `/v1/models` 动态发现，价格靠 `modelOverrides` 固定，官方降价时改 `models.yml` 即可。

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
        cost:                      # ⑪ 计价（**人民币/百万 tokens**）：直接写厂商人民币价，状态栏原样显示
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
- **计价说明**：模型未写 `cost` 视为免费；写了 `cost` 按元/百万 tokens 记账。本分支状态栏无 cost 段，`cost` 块只作记账真源（`cny-patch-tiers` 分支会把它显示成 ¥）。
- **验证**：`omp models ls` 应能看到新 provider 与模型；若有 `models.yml validation failed` 报错，说明字段名或取值不合法（对照上面模板检查）。
- **占位符约定**：仓库中 `apiKey` 一律用 `<XXX_API_KEY>` 占位脱敏；**setup 不再交互填 key**——部署时按 provider 保留本地已填的真实 key，未填项在结尾列出并提示手动编辑 `~/.omp/agent/models.yml`。已知 provider（Agent Plan/智谱）可选设环境变量（`OMP_AGENT_PLAN_KEY`/`ZHIPU_API_KEY`）自动注入；新增 provider 若要环境变量注入，需在 `setup.ps1` 的 `$envVarByProvider` 登记其环境变量名。

> **内置 provider 覆盖**：omp 内置 provider（`deepseek`、`anthropic`、`openai` 等）不写 `baseUrl`/`models` 也能在 `providers:` 下建块，只写 `modelOverrides` 即可覆盖内置模型的任意字段（`cost`/`contextWindow` 等）——`cost` 未覆盖的字段逐项回退内置价。

### 模型输出速度测试 (`scripts/bench-speed.ts`)

仓库内用 bun 运行，读**部署后**的 `~/.omp/agent/models.yml`（真实 key 在这里），对每个 provider 的每个模型顺序发一次流式请求，测输出速度。

```powershell
bun scripts/bench-speed.ts                 # 测全部
bun scripts/bench-speed.ts --only glm      # 只测 id 含 "glm" 的模型
bun scripts/bench-speed.ts --list          # 只列待测清单，不发请求
```

指标：

- **TTFT(ms)** — 请求发出到**首个增量 chunk**（含网络 + 排队 + 模型首 token）。基线必须在 `fetch` 之前取：部分网关把响应头憋到首 token 才发，`fetch` 返回后取基线会得到恒为 0 的假值。
- **tok/s** — `usage.completion_tokens ÷ (末 chunk − 首 chunk)`。无 usage 时按增量 chunk 数近似并标 `(approx)`。
- **生成(s) / 总(s)** — 纯生成时长 / 整个请求墙钟（`总 ≥ TTFT + 生成`，可用来自查数据一致性）。
- 只测速度，**不测成本**。

**成本控制**：固定短 prompt（"用一句话介绍你自己。"）+ 输出硬顶 `max_tokens: 128` + 每模型仅 1 次、顺序执行、测速失败不重试（并发会互相干扰测速数字，重试烧双倍钱）。全量一轮约几千 token。占位符 `<...>` 的 provider 整组跳过（`SKIP`）。

**厂商差异（脚本已自动处理，状态列有标注）**：

| 现象 | 处理 |
|------|------|
| doubao-seed 系**不尊重** `max_tokens`（实测一次输出 871 token，思考 token 不计入上限） | 检测 `completion_tokens` 超限后改用标准字段 `max_completion_tokens` 重试 → `(cap via max_completion_tokens)`；仍超限标 `(cap ignored)` |
| 厂商"关思考"参数被拒（400） | 去掉扩展参数降级重试 → `(extras off)` |
| 部分网关**整段一次性返回**（单增量 chunk），生成时长为 0 | tok/s 退化为用 TTFT 作分母的**下界估计** → `(single-chunk, rate~lower bound)`；此时真实瓶颈看 TTFT |
| 部分厂商思考增量在 `delta.reasoning`（非 `reasoning_content`） | 增量检测同时认三个字段，否则 TTFT 会虚高成"思考结束后首个正文 token" |
| 智谱 **GLM-5.3 起强制思考**，`thinking: {type: disabled}` 直接报错 | 改用 `reasoning_effort: low` 降档；更早的 GLM 仍用 `thinking.disabled` |

**实测参考**（历史一轮全量，仅供横向比较；TTFT 受网络与厂商排队影响波动较大）：

| provider | model | TTFT(ms) | tok/s |
|----------|-------|---------:|------:|
| volcengine-coding ³ | glm-5.3 | 5191 | 33.8 |
| volcengine-coding ³ | glm-5-3-flash | 4940 | 23.1 |
| volcengine-coding ³ | doubao-seed-2.0-mini | 521 | 91.7 |
| volcengine-coding ³ | doubao-seed-evolving | 857 | 30.0 |
| volcengine-coding ³ | deepseek-v4-1-flash-260910 | 444 ² | 85.9 ² |
| agent-plan | deepseek-v4.1-flash | 1381 | 177.5 |
| agent-plan | glm-5-3-flash | 1185 | 71.2 |
| zhipu | glm-5.3-flash | 750 | 30.0 |

¹ 单 chunk 一次性返回，tok/s 为下界；真实瓶颈是 TTFT。
² 方舟 v4.1 模型暂未接入 coding plan（实测 `UnsupportedModel`），该行沿用 v4 旧版实测值（TTFT ~444ms、~86 tok/s），待开通后重测更新。agent-plan 两行为 2026-09-18 实测（小输入；大输入警惕该端点 TTFT 挂起）。
³ `volcengine-coding` 订阅已停用（见「模型提供商」），保留为历史参考；当前主通道为 `commandcode`。

> 本分支（master）为**纯净配置**：不部署任何 bundle 补丁，状态栏不显示 cost（见「状态栏」一节）。需要人民币 cost 显示时，切到 `cny-patch-tiers` 分支部署（含 `scripts/omp-cny-patch.mjs` 三态补丁：coding plan / free / ¥）。

`setup.ps1` 幂等：重复运行覆盖最新配置、保留已填 API Key。注意：部署会以仓库版本覆盖 live `config.yml`（仅 `shellPath` 由探测回写保护）——若你在 omp 里改过配置，先跑 `.\sync-from-live.ps1` 提升再部署，否则改动会被回退。

## 反向同步（`~/.omp` → 仓库 → GitHub）

在 omp 里改了角色/配置（`/models` 等）后，把改动提升回仓库，供其他机器部署：

```powershell
.\sync-from-live.ps1            # 预检漂移 → 确认 → 同步 → commit → push
.\sync-from-live.ps1 -NoPush    # 只 commit 不 push（网络不便时）
.\sync-from-live.ps1 -Yes       # 跳过确认
```

行为细节：

| 文件 | 处理 |
|------|------|
| `config.yml` | 复制后**剥离 `shellPath` / `setupVersion`**（机器本地状态，按设计不入仓） |
| `settings.json` | 直接覆盖入库 |
| `models.yml` | **不覆盖**模型定义（仓库为源）；只做密钥防线检查——仓库中出现非 `<...>` 占位符的真实 apiKey 立即中止提交，live 中已填的真实 key 一律不入仓 |
| `lsp.json` / `skills/` | 跳过（部署方向才探测覆盖） |

- 仓库有未提交改动时拒绝运行（推方向起点必须干净），避免把无关内容混进同步提交
- 剥离机器本地项后无实际差异则跳过提交（幂等）
- commit message 固定格式 `sync: promote live config changes (<日期>)`

## 日常同步节奏（推荐）

```powershell
# 改配置后（omp 内 /models 等）
.\sync-from-live.ps1          # 提升 + push，GitHub 立即拥有最新配置

# 到另一台机器
git pull; .\setup.ps1         # 拉取 + 部署

# 不确定哪边新？
.\sync-from-live.ps1          # 无差异会明确说"无需同步"；有差异列出摘要再决定
```

多台机器同时改过的收敛方式：先 `git pull --rebase`（收别人的），再 `.\sync-from-live.ps1`（推自己的），冲突只在仓库层出现，手工解一次即可。
