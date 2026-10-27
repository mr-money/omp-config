# 行为：安装推荐版本 OMP -> 部署配置 -> (可选)环境变量填 key -> 提示手动编辑
#
# 安全流程：
#   1) guard-deploy：只读检查仓库边界，列出部署及删除清单；实际部署时备份本机受管文件
#   2) 安装/升级 omp（Bun）
#   3) 删除仓库中不存在的本机受管文件，再逐条复制仓库清单（models.yml 由 deploy-models 处理）
#   4) deploy-models：仓库为源写 models.yml，保留本机同 provider 真实 key / 注入 OMP_AGENT_PLAN_KEY / ZHIPU_API_KEY
#   5) set-shell：pwsh 探测，结构化写回 shellPath（无 pwsh 则删除）
#   6) record-state：部署成功后刷新本机基线（失败不刷新）
#
# .\setup.ps1 -Check 只做仓库校验和清单预检，不安装、不复制、不删除、不备份、不记基线。

param(
    [switch]$Check    # 只读部署预检：输出将允许/拒绝及原因
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OmpHome = Join-Path $env:USERPROFILE ".omp"
$AgentDir = Join-Path $OmpHome "agent"
$Helper = Join-Path $RepoRoot "scripts\config-sync.ts"

$bunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
$OmpPkgDir = Join-Path $bunInstall "install\global\node_modules\@oh-my-pi\pi-coding-agent"
$OmpPkgBundle = Join-Path $OmpPkgDir "dist\cli.js"
$RecommendedOmpVersion = "18.8.3"

function Write-Step { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "    FAIL $msg" -ForegroundColor Red }

# 1. 前置：bun + helper
Write-Step "校验前置依赖"
$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) { Write-Fail "未找到 bun。请先安装：irm bun.sh/install.ps1 | iex"; exit 1 }
Write-OK "bun $(& bun --version) @ $($bun.Source)"
if (-not (Test-Path $Helper)) { Write-Fail "缺少 helper: $Helper"; exit 1 }

# 2. 部署守卫（先于一切安装/目录创建/复制；预检不备份）
Write-Step "部署守卫（仓库边界 + 受管文件清单）"
$guardArgs = @("guard-deploy", "--repo", $RepoRoot, "--home", $OmpHome, "--json")
if (-not $Check) { $guardArgs += "--backup" }
$guardOutput = & bun $Helper @guardArgs
if ($LASTEXITCODE -ne 0) {
    Write-Fail "部署守卫未通过，本机受管文件未做任何修改"
    exit 1
}
$guardRaw = ([string]$guardOutput | ConvertFrom-Json)
$files = @($guardRaw.files)
$deletes = @($guardRaw.deletes)
$removeDirs = @($guardRaw.removeDirs)
if ($files.Count -eq 0) { Write-Fail "guard-deploy 返回空 files 清单"; exit 1 }
Write-OK "守卫通过：部署 $($files.Count) 项，删除 $($deletes.Count) 项"
if ($guardRaw.backupDir) { Write-OK "本机文件备份: $($guardRaw.backupDir)" }

if ($Check) {
    Write-Step "部署预检结果（-Check，未做任何修改）"
    Write-Host "  将部署 $($files.Count) 个受管文件："
    foreach ($f in $files) { Write-Host "    $f" }
    Write-Host "  将删除 $($deletes.Count) 个仓库中不存在的本机受管文件："
    foreach ($f in $deletes) { Write-Host "    $f" }
    if ($removeDirs.Count -gt 0) {
        Write-Host "  将删除被仓库文件取代的空目录："
        foreach ($d in $removeDirs) { Write-Host "    $d" }
    }
    Write-OK "预检通过，可执行 .\setup.ps1"
    exit 0
}

# ---- 以下为实际部署 ----

# 3. 检查并确保 bun 全局 bundle；非推荐版本即重装（幂等：已是该版本则跳过）。
$needInstall = $true
if (Test-Path (Join-Path $OmpPkgDir "package.json")) {
    try { $installed = (Get-Content (Join-Path $OmpPkgDir "package.json") -Raw | ConvertFrom-Json).version; $needInstall = ($installed -ne $RecommendedOmpVersion) } catch { $needInstall = $true }
}
if ($needInstall) {
    Write-Step "安装/升级 omp 到 $RecommendedOmpVersion"
    & bun install -g "@oh-my-pi/pi-coding-agent@$RecommendedOmpVersion"
    if ($LASTEXITCODE -ne 0) { Write-Fail "omp 安装/升级失败"; exit 1 }
    if (-not (Test-Path (Join-Path $OmpPkgDir "package.json"))) { Write-Fail "升级后未找到 omp 包: $OmpPkgDir"; exit 1 }
}
if (-not (Test-Path $OmpPkgBundle)) { Write-Fail "升级后仍未找到 bundle: $OmpPkgBundle"; exit 1 }
$actual = (Get-Content (Join-Path $OmpPkgDir "package.json") -Raw | ConvertFrom-Json).version
if ([version]$actual -lt [version]"18.0.2") { Write-Fail "OMP 版本校验失败: $actual"; exit 1 }
if ($actual -ne $RecommendedOmpVersion) { Write-Warn "omp 版本 $actual 与推荐版本 $RecommendedOmpVersion 不一致" }
Write-OK "omp bundle $actual"

# 4. 确保目录存在（仅受管文件的目标目录）
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AgentDir "skills") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AgentDir "agents") | Out-Null

# skills/* 对应 ~/.omp/agent/skills/*；agent/* 对应 ~/.omp/agent/*。
function Get-LivePath {
    param([string]$rel)
    if ($rel.StartsWith("skills/")) {
        return Join-Path $AgentDir ($rel -replace "/", "\")
    }
    return Join-Path $AgentDir ($rel.Substring("agent/".Length) -replace "/", "\")
}

# 只删除守卫列出的受管常规文件；其他文件和目录（包括数据库）保留。
Write-Step "删除仓库中不存在的本机受管文件"
foreach ($rel in $deletes) {
    [System.IO.File]::Delete((Get-LivePath $rel))
    Write-OK $rel
}
foreach ($rel in $removeDirs) {
    # 非递归删除：若目录中新出现任何内容则失败，不删除这些内容。
    [System.IO.Directory]::Delete((Get-LivePath $rel), $false)
    Write-OK "空目录 $rel"
}

# 5. 逐条复制受管文件（models.yml 交给 deploy-models；config.yml 先复制，shellPath 之后结构化写回）
Write-Step "复制受管文件（guard 清单逐条）"
foreach ($rel in $files) {
    if ($rel -eq "agent/models.yml") { continue }
    $src = Join-Path $RepoRoot ($rel -replace "/", "\")
    if (-not (Test-Path $src)) { Write-Fail "受管文件在仓库中缺失: $rel"; exit 1 }
    $dst = Get-LivePath $rel
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    Copy-Item -Force $src $dst
    Write-OK $rel
}

# 6. models.yml：仓库为源 + 本机 key 保留/环境变量注入（helper deploy-models）
Write-Step "部署 models.yml（保留本机 key / 环境变量注入）"
& bun $Helper deploy-models --repo $RepoRoot --home $OmpHome --output (Join-Path $AgentDir "models.yml")
if ($LASTEXITCODE -ne 0) { Write-Fail "models.yml 部署失败（本机文件已被 guard 备份）"; exit 1 }

# 7. shell 探测 + 结构化写回 config.yml（未发现 pwsh 则删除 shellPath）
Write-Step "探测 shell 路径"
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
& bun $Helper set-shell --repo $RepoRoot --home $OmpHome --file (Join-Path $AgentDir "config.yml") $(if ($pwsh) { @("--shell", $pwsh.Source) } else { @() })
if ($LASTEXITCODE -ne 0) { Write-Fail "shellPath 写回失败"; exit 1 }
if (-not $pwsh) { Write-Warn "未检测到 pwsh，config.yml 不设 shellPath（omp 回退到 cmd.exe）" }

# 8. LSP 探测（保留现有规则：裸名 -> PATH 绝对路径，不重序列化）
Write-Step "探测 LSP 工具"
$lspJson = Join-Path $AgentDir "lsp.json"
if (Test-Path $lspJson) {
    $raw = [System.IO.File]::ReadAllText($lspJson)
    $changed = $false

    $goplsCmd = Get-Command gopls -ErrorAction SilentlyContinue
    if ($goplsCmd -and $goplsCmd.Source -and $goplsCmd.Source -ne "gopls") {
        $jp = $goplsCmd.Source.Replace('\', '\\')
        if ($raw -match '"command":\s*"gopls"') {
            $raw = [regex]::Replace($raw, '("command":\s*)"gopls"', { param($m) "$($m.Groups[1].Value)`"$jp`"" })
            Write-OK "gopls: $($goplsCmd.Source)"
            $changed = $true
        }
    } else {
        Write-Warn "gopls 未在 PATH，保留裸名 'gopls'"
    }

    $pyCmd = Get-Command python -ErrorAction SilentlyContinue
    if ($pyCmd -and $pyCmd.Source -and $pyCmd.Source -ne "python") {
        $jp = $pyCmd.Source.Replace('\', '\\')
        if ($raw -match '"command":\s*"python"') {
            $raw = [regex]::Replace($raw, '("command":\s*)"python"', { param($m) "$($m.Groups[1].Value)`"$jp`"" })
            Write-OK "python: $($pyCmd.Source)"
            $changed = $true
        }
    } else {
        Write-Warn "python 未在 PATH，保留裸名 'python'"
    }

    if ($changed) {
        [System.IO.File]::WriteAllText($lspJson, $raw, [System.Text.UTF8Encoding]::new($false))
    }
}

# 9. MCP 探测（裸名 -> 绝对路径；无则保留裸名）
Write-Step "探测 codebase-memory-mcp"
$mcpJson = Join-Path $AgentDir "mcp.json"
if (Test-Path $mcpJson) {
    $raw = [System.IO.File]::ReadAllText($mcpJson)
    $cbmCmd = Get-Command codebase-memory-mcp -ErrorAction SilentlyContinue
    $cbmExe = $null
    if ($cbmCmd -and $cbmCmd.Source) { $cbmExe = $cbmCmd.Source }
    if (-not $cbmExe) {
        foreach ($cand in @(
            (Join-Path $env:LOCALAPPDATA "Programs\codebase-memory-mcp\codebase-memory-mcp.exe"),
            (Join-Path $env:USERPROFILE ".local\bin\codebase-memory-mcp.exe"))) {
            if (Test-Path $cand) { $cbmExe = $cand; break }
        }
    }
    if ($cbmExe) {
        $jp = $cbmExe.Replace('\', '\\')
        if ($raw -match '"command":\s*"codebase-memory-mcp"') {
            $raw = [regex]::Replace($raw, '("command":\s*)"codebase-memory-mcp"', { param($m) "$($m.Groups[1].Value)`"$jp`"" })
            [System.IO.File]::WriteAllText($mcpJson, $raw, [System.Text.UTF8Encoding]::new($false))
            Write-OK "mcp.json command -> $cbmExe"
        } else {
            Write-OK "mcp.json command 已指向具体路径，保留"
        }
    } else {
        Write-Warn "未检测到 codebase-memory-mcp，mcp.json 保留裸名（该 MCP 服务器将不可用，见 README 对应章节装二进制）"
    }
}

# 10. 部署成功：刷新本机基线
Write-Step "记录本机基线"
& bun $Helper record-state --repo $RepoRoot --home $OmpHome
if ($LASTEXITCODE -ne 0) { Write-Fail "基线记录失败（部署内容未回滚）"; exit 1 }

Write-Step "部署完成"
Write-Host ""
Write-Host "  omp 配置目录: $AgentDir"
Write-Host "  omp 安装: $OmpPkgBundle (bundle)"
Write-Host ""
Write-Host "  启动: omp"
Write-Host ""
