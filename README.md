# omp-config

个人 Oh My Pi (omp) 配置仓库 — 跨机器同步配置、技能和工具。

## 目录结构

```
omp-config/
├── agent/                    # → ~/.omp/agent/
│   ├── config.yml            # 全局配置（modelRoles, memory, TUI；shellPath 由 setup 探测）
│   ├── models.yml            # 模型提供商 → setup 交互填入 API Key
│   ├── lsp.json              # LSP 服务器（默认 PATH 裸名，setup 探测覆盖）
│   ├── cost.json             # 费用配置（人民币计价）
│   └── settings.json         # 持久化设置
├── scripts/                  # → ~/.omp/
│   └── omp-cny-patch.mjs     # 状态栏人民币计价补丁
├── skills/                   # → ~/.omp/agent/skills/
├── setup.ps1                 # 一键部署脚本（Windows / PowerShell）
└── README.md
```

## 在新机器上安装

> **PowerShell**：`setup.ps1` 同时支持 Windows PowerShell 5.1 与 PowerShell 7+（脚本已带 UTF-8 BOM，中文注释/输出在两种环境下均解析正常；终端若显示中文乱码仅影响显示，不影响执行）。

- `setup.ps1` 会自动安装/升级 bun 全局包到推荐的 **OMP 18.0.3**；patch 最低支持 18.0.2，已验证 18.0.3。18.0.1 原生 exe 布局不再作为 patch 目标。
- 已安装 `bun`（patch 脚本用 bun 运行）
- 已安装语言服务器（gopls、pylsp 等）

### 步骤（一键部署）

```powershell
# 1. 克隆仓库
cd ~
git clone git@github.com:mr-money/omp-config.git

# 2. 一键部署（复制配置 + 探测路径 + 填 API Key + 激活补丁）
cd omp-config
.\setup.ps1
```

脚本流程（自动执行，无需手动抄步骤）：
1. 校验 bun / omp 已安装
2. 复制 `agent/` → `~/.omp/agent/`、`skills/` → `~/.omp/agent/skills/`、`scripts/omp-cny-patch.mjs` → `~/.omp/`
3. 探测本机 pwsh / gopls / python 路径，写回对应配置
4. 若 `models.yml` 仍是 `<YOUR_API_KEY>` 占位，交互提示输入
5. 执行 `bun ~/.omp/omp-cny-patch.mjs --setup` 激活人民币计价补丁（布局 B 下同时安装自愈 wrapper）

只读健康检查：`.\doctor.ps1`。它检查 Bun、OMP/bundle、配置文件、CNY patch、wrapper 及 gopls/python，不会自动修复。

### 配置项一览

| 文件 | 字段 | 部署方式 | 说明 |
|------|------|----------|------|
| `~/.omp/agent/models.yml` | `apiKey` | setup 交互填入 / `OMP_API_KEY` 环境变量 | 火山引擎 API Key；优先读环境变量，否则交互提示；已填则跳过 |
| `~/.omp/agent/lsp.json` | `servers.*.command` | setup 探测覆盖 | 默认 PATH 裸名（`gopls` / `python -m pylsp`）；探测到绝对路径则写回 |
| `~/.omp/agent/config.yml` | `shellPath` | setup 探测写入 | 检测到 pwsh 则自动写入；未检测到则省略（omp 回退到 cmd.exe） |
| `~/.omp/agent/config.yml` | `statusLine.segmentOptions.git` | 直接复制 | 隐藏状态栏 git 段（分支 / +N staged / *N unstaged / ?N untracked） |
| `~/.omp/agent/settings.json` | — | 直接复制 | 不再单独设 shellPath，统一走 config.yml |

### 验证

```powershell
# 启动 omp，检查状态栏显示 ¥ 符号 / coding plan（订阅制提供商）
omp
# 或直接执行 bundle（布局 B，不经过 wrapper）
bun "%USERPROFILE%\.bun\install\global\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js"
```

- **上下文段（context_pct）**：只显示用量百分比，取整右对齐固定 4 列（`  0%`..`100%`），无窗口总量、宽度恒定

```powershell
# 检查补丁日志
cat ~/.omp/logs/omp-cny-patch.log
```

## 配置说明
### 状态栏 Git 段 (`config.yml` → `statusLine`)

```yaml
statusLine:
  segmentOptions:
    git:
      showBranch: false        # 隐藏分支名
      showStaged: false        # 隐藏 +N（已暂存）
      showUnstaged: false      # 隐藏 *N（未暂存）
      showUntracked: false     # 隐藏 ?N（未跟踪）
```

四项全关后 git 段整段隐藏（不显示分支与文件计数），其余状态栏段（model / path / context / cost 等）不受影响。保持 `statusLine.preset` 默认值不变，仅通过 `segmentOptions` 覆盖。

### 模型角色 (`config.yml` → `modelRoles`)

| 角色 | 模型 | 思考档位 | 用途 |
|------|------|----------|------|
| `default` | glm-5-3-flash | — | 默认主模型，日常编码 |
| `plan` | GLM-5.3 | `high` | 任务规划阶段 |
| `slow` | GLM-5.3 | `max` | 深度推理 / 复杂问题 |
| `smol` | doubao-seed-2.0-mini | `minimal` | 轻量快速任务 |
| `advisor` | doubao-seed-evolving | `medium` | 顾问模式 |
| `designer` | doubao-seed-evolving | `medium` | UI/UX 设计任务 |
| `commit` | doubao-seed-2.0-mini | `off` | 生成 commit message |
| `tiny` | doubao-seed-2.0-mini | `off` | 极小任务（禁用思考） |
| `vision` | doubao-seed-2.0-mini | `medium` | 视觉/截图理解 |
| `DeepSeek` | deepseek-v4-flash | `high` | 官方 DeepSeek API（omp 内置 provider，配 Key 后启用；备用） |

**思考档位循环 (`cycleOrder`)**: `smol` → `default` → `slow` → `DeepSeek`，逐级升档。

### 模型提供商 (`models.yml`)

内置火山引擎大模型 API（方舟，coding plan 订阅制）：
- **glm-5-3-flash** — 默认模型（1M 上下文）
- **glm-5.3** — 规划 / 慢速深度推理（1M 上下文）
- **deepseek-v4-flash-ga-260731** — 备用默认（1M 上下文，原默认模型）
- **doubao-seed-2.0-mini** — 轻量 / 视觉 / commit 模型
- **doubao-seed-evolving** — 顾问 / 设计（advisor、designer 角色）（1M 上下文）

`apiKey` 部署时由 `setup.ps1` 交互填入（或通过 `OMP_API_KEY` 环境变量），仓库中保持 `<YOUR_API_KEY>` 占位脱敏。

> **DeepSeek 官方通道（`deepseek` provider）**：`config.yml` 的 `DeepSeek` 角色与 `cost.json` 定价指向**官方 DeepSeek API**。该 provider（`api.deepseek.com`）由 **omp 内置**，无需在 `models.yml` 配置——外部配置仅含火山 `volcengine-coding`。使用前只需在 omp 设置（`/models`）中为 `deepseek` 填入官方 API Key 即可启用。

### 费用 (`cost.json`)

- **`freeProviders: ["volcengine-coding"]`** — 火山引擎 coding plan 为订阅制，状态栏显示 `coding plan`，不计 token 费用、不显示顾问尾巴
- **DeepSeek 官方 API** — 按量付费，人民币计价（汇率 7.25）。18.x 原生按 provider 定价计算成本；补丁负责 `$`→`¥` 与 `×汇率`：
  - 定价来源：[DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（价格如有变动，以此页为准）
  - 覆盖模型：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4-pro`
  - V4 Flash / V4 Flash Vision（元/百万 tokens）：
    | 项目 | 空闲时段 | 高峰时段 |
    |------|---------|---------|
    | 输入（缓存命中） | 0.05 | 0.10 |
    | 输入（缓存未命中） | 1.5 | 3.0 |
    | 输出 | 4.5 | 9.0 |
  - V4 Pro（元/百万 tokens）：
    | 项目 | 空闲时段 | 高峰时段 |
    |------|---------|---------|
    | 输入（缓存命中） | 0.15 | 0.30 |
    | 输入（缓存未命中） | 4.5 | 9.0 |
    | 输出 | 13.5 | 27.0 |

  字段映射（`cost.json` 内每个模型为 `peak` / `offpeak` 两组）：
  - `input` / `cacheWrite` = 输入（缓存未命中）价格
  - `cacheRead` = 输入（缓存命中）价格
  - `output` = 输出价格

  > 该定价在使用 `deepseek` provider 时生效（omp 内置，baseUrl 已配置，仅需在 omp 设置中填入官方 API Key），用于覆盖 omp 内置的 USD 旧价。

补丁改写三处代码（仅支持 **omp 18.0.2+ bun 全局包**，18.0.1 原生 exe 布局不再支持）：

`omp.exe` 是 8KB bun shim，bundle 是普通 JS（`dist/cli.js`），可任意改长度。补丁在 bundle 头部注入运行时 helpers（`__cnyCfg`/`__cnyFmt`/`__cnyIsFree`），运行时读取 `~/.omp/agent/cost.json`，并字符串替换三处：

1. `xEs()`（费用格式化函数）：`$<USD>` → `¥<USD×汇率>`（汇率默认 7.25）
2. `id:"cost"` 状态段：注入 `freeProviders` 检查——当模型 provider 为订阅制（默认 `volcengine-coding`）时显示 `coding plan` 而非 token 价格，并隐藏顾问尾巴
3. `id:"context_pct"` 状态段：去掉 `xx.x%/window` 双数字（窗口总量），只留用量百分比，且取整右对齐为固定 4 列（`  0%`..`100%`）——上下文段宽度恒定不变

`cost.json` 是唯一配置源（运行时读取），缺文件时回退默认值（¥ / 7.25 / `["volcengine-coding"]`）。

>
**版本 manifest**：最低支持 `18.0.2`，推荐 `18.0.3`，当前已验证 `18.0.3`，patch 版本为 `2026.08.23.1`。低于最低版本时自动升级并重新读取 package.json；升级未达到最低版本会安全失败，不会继续留下半 patch。

**每次 `--check` 幂等**：已补丁则 no-op；`omp update` 重装后下次运行自动重打。首次补丁自动备份 `<target>.orig` 供 `--restore` 回滚。

**自愈 wrapper（`--setup`）**：`omp update` 每次都会重写 `dist/cli.js`（补丁丢失）并重建 `omp.exe` shim（会遮蔽 wrapper）。`--setup` 会把 bun 的 `omp.exe` shim 改名成 `omp.exe.bak`，安装 `~/.bun/bin/omp.cmd` 包装器——每次 `omp` 启动先跑 `--check`（自动重打补丁）再启动 bundle；`omp update` 命令结束时自动再跑一次 `--setup` 夺回 shim 并重打补丁，全程无需手动干预。回滚 `--restore` 会移除 wrapper 并还原 shim。

**兼容性（已验证）**：
- omp `18.0.3`（bun 全局包，plain-JS bundle）

工作原理：
- 定位 bundle：`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`
- 首次补丁备份 `<target>.orig`；替换用「暂存 `.cny` → 重命名换入」避免 Windows 对运行中文件的写入锁（EBUSY）
- 顾问段：仅计费（非 coding plan）提供商显示 `+ ¥x (adv)`；coding plan 提供商只显示 `coding plan`
- **峰谷定价已不再注入**：按 provider 定价计算 `usageStats.cost`，补丁只做 `×汇率` 与 ¥ 符号
- 升级后 `.orig` 自动刷新（避免 `--restore` 降级到旧版本 bundle）
- 回滚：`bun ~/.omp/omp-cny-patch.mjs --restore`（还原 `.orig`、移除 wrapper、还原 shim）

### 安装布局与单入口（当前状态）

当前机器使用 **omp 18.0.3 bun 全局包**，只有单一入口：

- `~/.bun/bin/omp.cmd` — 启动包装器：先跑 `bun ~/.omp/omp-cny-patch.mjs --check` 自愈补丁，再 `bun …\dist\cli.js` 启动；`omp update` 结束后自动重跑 `--setup` 夺回 shim
- `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` — 真实 bundle（已打补丁）
- `~/.bun/bin/omp.bunx` / `~/.bun/bin/omp.exe.bak` — bun 生成 shim（8–16KB，非独立程序；被 wrapper 改名暂存）

**无版本冲突**：PATH 仅含 `~/.bun/bin` 一处 omp 入口，`where omp` 只命中 `omp.cmd`，无独立原生 exe 可执行。`omp.exe` shim 在 `omp update` 时由 bun 重建，wrapper 的 update 钩子会立即夺回。

### 技能

来自 [anthropics/skills](https://github.com/anthropics/skills) 开源仓库：
- **grill-me/grilling/grill-with-docs/domain-modeling** — 追问与领域建模
- **docx/pptx/xlsx/pdf** — 文档创建与编辑（文档操作技能）

另含 **caveman**（极简沟通模式）— 源自 [juliusbrussee/caveman](https://github.com/JuliusBrussee/caveman)，随其余技能一同部署到 `~/.omp/agent/skills/`。omp 的 native 技能源（`~/.omp/agent/skills/`）优先级高于 codex 源（`~/.codex/skills/`），同名技能会优先从 native 加载。

## 更新

```powershell
# 拉取最新配置 + 重新部署（幂等）
cd ~/omp-config && git pull
.\setup.ps1
```

`setup.ps1` 幂等：重复运行覆盖最新配置、保留已填 API Key、patch 已应用则 no-op。
