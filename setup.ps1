# 前置：已安装 bun；已安装 omp 18.x（bun 全局包 `curl -fsSL https://omp.sh/install | sh`，或 18.0.1 原生 exe）
# 行为：探测本机路径 -> 复制配置 -> 填 API Key -> 跑 patch --setup

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OmpHome = Join-Path $env:USERPROFILE ".omp"
$AgentDir = Join-Path $OmpHome "agent"
$PatchScript = Join-Path $OmpHome "omp-cny-patch.mjs"
$OmpPkgBundle = Join-Path $env:USERPROFILE ".bun\install\global\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js"

function Write-Step { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-OK   { param($msg) Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "    FAIL $msg" -ForegroundColor Red }

# 写 UTF-8 无 BOM（PS5.1 的 Set-Content 默认用 Default 编码，会损坏中文/换行）
function Write-Utf8Text {
    param([string]$Path, [string]$Content)
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# 1. 前置校验
Write-Step "校验前置依赖"

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun) {
    Write-Fail "未找到 bun。请先安装：irm bun.sh/install.ps1 | iex"
    exit 1
}
Write-OK "bun $(& bun --version) @ $($bun.Source)"

# 检查 omp 安装布局（18.0.2+ 为 bun 全局包：omp.exe 是 8KB shim，bundle 在 dist/cli.js；18.0.1 为原生 exe）
$bunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
$ompExe = Join-Path $bunInstall "bin\omp.exe"
$ompLayout = $null
if (Test-Path $OmpPkgBundle) {
    $ompLayout = "bundle"
    Write-OK "omp 18.0.2+ bun 全局包: dist/cli.js 存在"
} elseif (Test-Path $ompExe) {
    $len = (Get-Item $ompExe).Length
    if ($len -gt 100000) {
        $ompLayout = "exe"
        Write-OK "omp 18.0.1 原生 exe: $ompExe ($len bytes)"
    } else {
        Write-Warn "omp.exe 是 8KB shim 但 bundle 缺失，patch 将无法应用"
    }
} else {
    $whereOmp = Get-Command omp -ErrorAction SilentlyContinue
    if ($whereOmp -and $whereOmp.Source -match "omp\.exe$") {
        $ompExe = $whereOmp.Source
        $len = (Get-Item $ompExe).Length
        if ($len -gt 100000) { $ompLayout = "exe"; Write-OK "omp 原生 exe: $ompExe" }
    }
}
if (-not $ompLayout) {
    Write-Fail "未找到 omp 安装（bundle $OmpPkgBundle 或原生 exe $ompExe 均缺失）"
    Write-Fail "请先安装 omp 18.x：curl -fsSL https://omp.sh/install | sh"
    exit 1
}
Write-OK "omp 布局: $ompLayout"

# 2. 确保目录存在
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AgentDir "skills") | Out-Null

# 3. 复制配置文件
Write-Step "复制 agent 配置"
$srcModels = Join-Path $RepoRoot "agent\models.yml"
$dstModels = Join-Path $AgentDir "models.yml"
# 若目标 models.yml 已有真实 apiKey（非占位），提取出来待复制后回填——
# 不能跳过整个文件，否则新模型定义（glm-5.3 / doubao-seed-2.0-mini 等）永不部署
$existingKey = $null
if ((Test-Path $dstModels) -and (Test-Path $srcModels)) {
    $dstContent = [System.IO.File]::ReadAllText($dstModels)
    if ($dstContent -notmatch 'apiKey:\s*<YOUR_API_KEY>') {
        $km = [regex]::Match($dstContent, '(?m)^\s*apiKey:\s*(\S+)')
        if ($km.Success) {
            $existingKey = $km.Groups[1].Value
            Write-OK "检测到 models.yml 已有 apiKey，部署后回填保留"
        }
    }
}

# 复制除 models.yml 外的所有 agent 文件
Get-ChildItem (Join-Path $RepoRoot "agent") -Exclude "models.yml" | ForEach-Object {
    Copy-Item -Force -Recurse $_.FullName -Destination $AgentDir
}
# models.yml 始终用仓库最新定义；若原有真实 key，复制后回填
Copy-Item -Force $srcModels -Destination $dstModels
if ($existingKey) {
    $yml = [System.IO.File]::ReadAllText($dstModels)
    $key = $existingKey
    # MatchEvaluator 插入字面值（防 key 含 $ 被当回引用）
    $yml = [regex]::Replace($yml, 'apiKey:\s*<YOUR_API_KEY>',
        { param($m) "apiKey: $key" })
    Write-Utf8Text $dstModels $yml
    Write-OK "已回填原 apiKey 到最新 models.yml"
}
Write-OK "agent/ -> ~/.omp/agent/"

Write-Step "复制 patch 脚本"
Copy-Item -Force (Join-Path $RepoRoot "scripts\omp-cny-patch.mjs") -Destination $PatchScript
Write-OK "scripts/omp-cny-patch.mjs -> ~/.omp/omp-cny-patch.mjs"

Write-Step "复制 skills"
$skillsSrc = Join-Path $RepoRoot "skills"
if (Test-Path $skillsSrc) {
    Copy-Item -Force -Recurse (Join-Path $skillsSrc "*") -Destination (Join-Path $AgentDir "skills")
    Write-OK "skills/ -> ~/.omp/agent/skills/"
}

# 4. 探测 shell 路径（pwsh 优先），写回 config.yml
Write-Step "探测 shell 路径"
$configYml = Join-Path $AgentDir "config.yml"
$shellPath = $null
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
if ($pwsh) {
    $shellPath = $pwsh.Source
}

if ($shellPath -and (Test-Path $configYml)) {
    $yml = [System.IO.File]::ReadAllText($configYml)
    $eol = if ($yml -match "\r\n") { "`r`n" } else { "`n" }
    if ($yml -match '(?m)^shellPath:.*$') {
        # MatchEvaluator 插入字面值（防路径含 $ 被当回引用）
        $sp = $shellPath
        $yml = [regex]::Replace($yml, '(?m)^shellPath:.*$', { param($m) "shellPath: $sp" })
        Write-OK "已更新 config.yml shellPath: $shellPath"
    } else {
        $yml = "shellPath: $shellPath$eol" + $yml
        Write-OK "已追加 config.yml shellPath: $shellPath"
    }
    Write-Utf8Text $configYml $yml
} elseif (-not $shellPath) {
    Write-Warn "未检测到 pwsh，config.yml 不设 shellPath（omp 回退到 cmd.exe）"
}

# 5. 探测 LSP 路径，正则替换 lsp.json 中 command 值（保留原格式，不重序列化）
Write-Step "探测 LSP 工具"
$lspJson = Join-Path $AgentDir "lsp.json"
if (Test-Path $lspJson) {
    $raw = [System.IO.File]::ReadAllText($lspJson)
    $changed = $false

    $goplsCmd = Get-Command gopls -ErrorAction SilentlyContinue
    if ($goplsCmd -and $goplsCmd.Source -and $goplsCmd.Source -ne "gopls") {
        # JSON 字符串转义 \ -> \\；MatchEvaluator 插入字面值防 $ 回引用
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
        Write-Utf8Text $lspJson $raw
    }
}

# 6. API Key 填入（环境变量 OMP_API_KEY 优先，否则交互输入）
Write-Step "配置 API Key"
$modelsYml = Join-Path $AgentDir "models.yml"
if (Test-Path $modelsYml) {
    $yml = [System.IO.File]::ReadAllText($modelsYml)
    if ($yml -match 'apiKey:\s*<YOUR_API_KEY>') {
        $plain = $null
        if (-not [string]::IsNullOrWhiteSpace($env:OMP_API_KEY)) {
            $plain = $env:OMP_API_KEY.Trim()
            Write-OK "从环境变量 OMP_API_KEY 读取"
        } elseif ([Environment]::UserInteractive) {
            $secure = Read-Host "输入火山方舟 API Key" -AsSecureString
            $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim()
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        } else {
            Write-Warn "非交互环境且 OMP_API_KEY 未设置，保留占位符"
        }

        if ([string]::IsNullOrWhiteSpace($plain)) {
            Write-Warn "API Key 为空，保留占位符"
        } else {
            # 用 MatchEvaluator 委托插入字面 key（避免 $ 在替换模板中被当回引用）
            $yml = [regex]::Replace($yml, 'apiKey:\s*<YOUR_API_KEY>',
                { param($m) "apiKey: $plain" })
            Write-Utf8Text $modelsYml $yml
            Write-OK "已写入 models.yml apiKey"
        }
    } else {
        Write-OK "models.yml apiKey 已配置，跳过"
    }
}

# 7. 跑 patch --setup
Write-Step "执行 omp 人民币化 patch --setup"
& bun $PatchScript --setup
if ($LASTEXITCODE -ne 0) {
    Write-Fail "patch --setup 失败，退出码 $LASTEXITCODE"
    exit 1
}
Write-OK "patch --setup 完成"

# 8. 摘要
Write-Step "部署完成"
Write-Host ""
Write-Host "  omp 配置目录: $AgentDir"
Write-Host "  patch 脚本:   $PatchScript"
Write-Host "  omp 安装: $($(if ($ompLayout -eq 'bundle') { $OmpPkgBundle } else { $ompExe })) ($ompLayout)"
Write-Host ""
Write-Host "  启动: omp"
Write-Host "  回滚: bun $PatchScript --restore"
Write-Host ""
