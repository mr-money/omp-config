# 反向同步入口：~/.omp（本机运行配置）→ 本仓库。
# 默认只读（-Check）；显式 -Export 才写入仓库。密钥永不入仓（真实 key 以 <...> 占位符落库）。
#
# 用法：
#   .\sync-from-live.ps1 -Check    # 只读检查（默认），列出可导出变化与仓库独有项；不写任何文件
#   .\sync-from-live.ps1 -Export   # 显式导出：写入仓库（含备份/原子写/回滚），并记录本机基线；不 commit、不 push
#
# 退出码：0=无可导出变化；2=存在可导出变化（仅 -Check）；1=错误或冲突。
# 发布由用户手工执行：git add（仅受管配置）→ commit → pull --rebase → push。
param(
    [switch]$Check,    # 只读检查（默认行为）
    [switch]$Export    # 显式导出写入仓库
)

$ErrorActionPreference = "Stop"

if ($Check -and $Export) {
    Write-Host "FAIL -Check 与 -Export 互斥" -ForegroundColor Red
    exit 1
}

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OmpHome = Join-Path $env:USERPROFILE ".omp"
$Helper = Join-Path $RepoRoot "scripts\config-sync.ts"

function Write-Fail { param($msg) Write-Host "    FAIL $msg" -ForegroundColor Red }

# 1. 前置：bun + helper 存在
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) { Write-Fail "未找到 bun，无法运行配置同步 helper"; exit 1 }
if (-not (Test-Path $Helper)) { Write-Fail "缺少 helper: $Helper"; exit 1 }

# 2. 调用 helper（PowerShell 必须显式传绝对路径，不从 cwd 猜）
& bun $Helper $(if ($Export) { "export" } else { "check" }) --repo $RepoRoot --home $OmpHome
$code = $LASTEXITCODE

# -Export 语义归一：helper 0=成功（含零变化）；2 仅是 -Check 的"有变化"信号
if ($Export -and $code -eq 2) { exit 0 }
exit $code
