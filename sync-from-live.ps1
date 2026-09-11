# 同步方向：~/.omp（本机运行配置）→ 本仓库（经 git push 到 GitHub 线上）。
# 与 setup.ps1（仓库 → ~/.omp）构成对称闭环；密钥永不入仓（真实 key 反向回写为 <...> 占位符）。
#
# 同步内容：
#   config.yml     剥离机器本地项（shellPath / setupVersion）后入库
#   settings.json   直接覆盖入库
#   models.yml     不覆盖模型定义；仅把仓库占位符反视为"忽略"，live 中已填的真实 key 一律丢弃（不入仓）
#   lsp.json / skills/          跳过（仓库为源，部署方向才探测覆盖）
#
# 流程：预检漂移摘要 → 确认 → 复制 → models.yml 占位符校验 → git add/commit/push（-NoPush 跳过）
param(
    [switch]$NoPush,     # 只更新仓库并 commit，不执行 git push
    [switch]$Yes         # 跳过确认提示（CI / 无交互）
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OmpHome = Join-Path $env:USERPROFILE ".omp"
$AgentDir = Join-Path $OmpHome "agent"

function Write-Step { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "    FAIL $msg" -ForegroundColor Red }

# 写 UTF-8 无 BOM（与 setup.ps1 约定一致）
function Write-Utf8Text {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# 1. 前置校验
Write-Step "校验前置依赖"
foreach ($f in @("config.yml", "settings.json")) {
    $live = Join-Path $AgentDir $f
    if (-not (Test-Path $live)) { Write-Fail "live 缺少 $f：$live"; exit 1 }
}
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Write-Fail "未找到 git"; exit 1 }
Write-OK "git $($git.Version)"

# 仓库必须干净：推方向起点不能带未提交改动（避免把无关内容混进同步提交）
$dirty = git -C $RepoRoot status --porcelain
if ($dirty) {
    Write-Fail "仓库有未提交改动，先处理再同步："
    Write-Host $dirty
    exit 1
}

# 2. 漂移预检：与仓库现版本逐文件 diff，列出将要提升的差异
Write-Step "漂移预检（live → 仓库）"
$diffSummary = @()
$hasDrift = $false
foreach ($f in @("config.yml", "settings.json")) {
    $live = Join-Path $AgentDir $f
    $repo = Join-Path $RepoRoot "agent\$f"
    if (-not (Test-Path $repo)) { $hasDrift = $true; $diffSummary += "  $f : 仓库无此文件（新增）"; continue }

    $liveText = [System.IO.File]::ReadAllText($live)
    $repoText = [System.IO.File]::ReadAllText($repo)
    # config.yml：先剥离机器本地项再比较（这些项按设计不入仓）
    if ($f -eq "config.yml") {
        $liveText = [regex]::Replace($liveText, '(?m)^shellPath:.*\r?\n?', "")
        $liveText = [regex]::Replace($liveText, '(?m)^setupVersion:.*\r?\n?', "")
        $repoText = [regex]::Replace($repoText, '(?m)^setupVersion:.*\r?\n?', "")
    }
    $liveNorm = ($liveText -replace "`r`n", "`n").TrimEnd()
    $repoNorm = ($repoText -replace "`r`n", "`n").TrimEnd()
    if ($liveNorm -ne $repoNorm) {
        $hasDrift = $true
        $diffSummary += "  $f : 有差异"
    } else {
        $diffSummary += "  $f : 一致"
    }
}
$diffSummary | ForEach-Object { Write-Host $_ }
if (-not $hasDrift) {
    Write-OK "live 与仓库无语义差异，无需同步"
    exit 0
}

# 3. 确认
if (-not $Yes) {
    $answer = Read-Host "将以上差异提升进仓库$(if (-not $NoPush) { '并 push 到 GitHub' })，继续? (y/N)"
    if ($answer -notmatch '^[Yy]') { Write-Warn "已取消"; exit 0 }
}

# 4. 执行同步
Write-Step "同步 live 配置到仓库"

# config.yml：复制后剥离 shellPath / setupVersion（机器本地状态，不得入仓）
$cfgSrc = Join-Path $AgentDir "config.yml"
$cfgDst = Join-Path $RepoRoot "agent\config.yml"
$cfg = [System.IO.File]::ReadAllText($cfgSrc)
$cfg = [regex]::Replace($cfg, '(?m)^shellPath:.*\r?\n?', "")
$cfg = [regex]::Replace($cfg, '(?m)^setupVersion:.*\r?\n?', "")
Write-Utf8Text $cfgDst $cfg
Write-OK "agent/config.yml（已剥离 shellPath / setupVersion）"

# settings.json：直接覆盖
foreach ($f in @("settings.json")) {
    Copy-Item -Force (Join-Path $AgentDir $f) (Join-Path $RepoRoot "agent\$f")
    Write-OK "agent/$f"
}

# models.yml：密钥防线——live 的真实 key 一律不入仓。
# 仓库版模型定义保持为源（本次不覆盖），仅校验仓库当前内容无真实 key 泄漏。
$mRepo = Join-Path $RepoRoot "agent\models.yml"
if (Test-Path $mRepo) {
    $mText = [System.IO.File]::ReadAllText($mRepo)
    # 抽取所有 apiKey 值；合法入库形态只有 <...> 占位符
    $badKeys = [regex]::Matches($mText, '(?m)^\s*apiKey:\s*(\S+)') | Where-Object { $_.Groups[1].Value -notlike '<*>*' }
    if ($badKeys.Count -gt 0) {
        Write-Fail "仓库 models.yml 中发现疑似真实 apiKey（不入仓规则被破坏），中止提交："
        foreach ($b in $badKeys) { Write-Host "    $($b.Groups[1].Value)" }
        exit 1
    }
    Write-OK "models.yml 密钥防线检查通过（仓库保持占位符，live key 不入仓）"
}

# 5. git 提交
Write-Step "提交"
$changes = git -C $RepoRoot status --porcelain
if (-not $changes) {
    Write-OK "剥离机器本地项后无实际差异（live 与仓库仅 shellPath/setupVersion 不同）"
    exit 0
}
git -C $RepoRoot add agent/config.yml agent/settings.json
$stamp = Get-Date -Format "yyyy-MM-dd"
git -C $RepoRoot commit -m "sync: promote live config changes ($stamp)"
if ($LASTEXITCODE -ne 0) { Write-Fail "git commit 失败"; exit 1 }
Write-OK "commit: $(git -C $RepoRoot rev-parse --short HEAD)"

# 6. push
if ($NoPush) {
    Write-Warn "-NoPush：未执行 git push，请手动推送"
} else {
    git -C $RepoRoot push origin
    if ($LASTEXITCODE -ne 0) { Write-Fail "git push 失败（远程有新提交时先 git pull --rebase 再重试）"; exit 1 }
    Write-OK "已 push 到 origin"
}

Write-Step "同步完成"
Write-Host "  下次在其他机器部署：git pull && .\setup.ps1"
