# omp-config

个人 Oh My Pi (omp) 配置仓库 — 跨机器同步配置、技能和工具。

## 目录结构

```
omp-config/
├── agent/                    # → ~/.omp/agent/
│   ├── config.yml            # 全局配置（modelRoles, memory, TUI）
│   ├── models.yml            # 模型提供商 → 需填入 API Key
│   ├── lsp.json              # LSP 服务器 → 需修改路径
│   ├── cost.json             # 费用配置（人民币计价）
│   └── settings.json         # 持久化设置 → 需修改路径
├── scripts/                  # → ~/.omp/
│   └── omp-cny-patch.mjs     # 状态栏人民币计价补丁
├── skills/                   # → ~/.omp/agent/skills/
│   ├── domain-modeling/      # 领域建模 + ADR/术语表
│   ├── grill-with-docs/      # 追问 + 写文档
│   ├── grilling/             # 追问增强
│   ├── grill-me/             # 追问基础
│   ├── docx/                 # Word 文档操作
│   ├── pptx/                 # PPT 演示文稿
│   ├── xlsx/                 # Excel 表格操作
│   └── pdf/                  # PDF 文档操作
└── README.md
```

## 在新机器上安装

### 前置条件

- 已安装 `omp`（`bun install -g @oh-my-pi/pi-coding-agent`）
- 已安装 `bun`
- 已安装语言服务器（gopls、pylsp 等）

### 步骤

```powershell
# 1. 克隆仓库
cd ~
git clone git@github.com:mr-money/omp-config.git

# 2. 部署配置文件
cp ~/omp-config/agent/config.yml    ~/.omp/agent/
cp ~/omp-config/agent/models.yml    ~/.omp/agent/
cp ~/omp-config/agent/lsp.json      ~/.omp/agent/
cp ~/omp-config/agent/cost.json     ~/.omp/agent/
cp ~/omp-config/agent/settings.json ~/.omp/agent/

# 3. 部署补丁脚本
cp ~/omp-config/scripts/omp-cny-patch.mjs ~/.omp/

# 4. 部署技能
cp -r ~/omp-config/skills/* ~/.omp/agent/skills/

# 5. 安装插件
omp plugin install pi-cny-cost

# 6. 激活补丁
bun ~/.omp/omp-cny-patch.mjs --setup
```

### 必须修改的配置

| 文件 | 字段 | 说明 |
|------|------|------|
| `~/.omp/agent/models.yml` | `apiKey` | 替换为你的火山引擎 API Key |
| `~/.omp/agent/lsp.json` | `command` | 改为本机 gopls/pylsp 实际路径 |
| `~/.omp/agent/config.yml` | `shellPath` | 改为本机 Shell 路径，如 `D:\PowerShell\7\pwsh.exe` |
| `~/.omp/agent/settings.json` | `shellPath` | 同上 |

### 验证

```powershell
# 启动 omp，检查状态栏显示 ¥ 符号
omp

# 检查补丁日志
cat ~/.omp/logs/omp-cny-patch.log
```

## 配置说明

### 模型提供商 (`models.yml`)

使用火山引擎大模型 API：
- **deepseek-v4-flash-ga-260731** — 默认模型（1M 上下文）
- **glm-5.2** — 计划/小型模型（1M 上下文）
- **doubao-seed-2.1-turbo** — 慢速/顾问/视觉模型

### 费用 (`cost.json`)

人民币计价，预设汇率 7.25：
- DeepSeek V4 Flash: 输入 ¥1/1M tokens, 输出 ¥2/1M tokens
- DeepSeek V4 Pro: 输入 ¥3/1M tokens, 输出 ¥6/1M tokens

### 价格补丁 (`omp-cny-patch.mjs`)

每次启动自动运行 `--check`，检测到 omp 升级后自动重新打补丁。升级后首次启动自动重打，无需手动干预。

工作原理：
- 在 `dist/cli.js` 中定位 `id:"cost"` 状态段
- 注入 CNY 计算函数，读取 `cost.json` 获取价格配置
- 用 `omp.cmd` 包装器替代原始入口，每次启动先跑补丁

### 技能

来自 [anthropics/skills](https://github.com/anthropics/skills) 开源仓库：
- **grill-me/grilling/grill-with-docs/domain-modeling** — 追问与领域建模
- **docx/pptx/xlsx/pdf** — 文档创建与编辑（文档操作技能）

## 更新

```powershell
# 拉取最新配置
cd ~/omp-config && git pull
# 重新部署
cp ~/omp-config/agent/*.yml ~/.omp/agent/
cp ~/omp-config/agent/*.json ~/.omp/agent/
cp ~/omp-config/scripts/omp-cny-patch.mjs ~/.omp/
cp -r ~/omp-config/skills/* ~/.omp/agent/skills/