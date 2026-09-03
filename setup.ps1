# 行为：检查/安装升级 OMP -> 复制配置 -> (可选)环境变量填 key -> 提示手动编辑 -> 跑 patch --setup

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$OmpHome = Join-Path $env:USERPROFILE ".omp"
$AgentDir = Join-Path $OmpHome "agent"
$PatchScript = Join-Path $OmpHome "omp-cny-patch.mjs"
$bunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
$OmpPkgDir = Join-Path $bunInstall "install\global\node_modules\@oh-my-pi\pi-coding-agent"
$OmpPkgBundle = Join-Path $OmpPkgDir "dist\cli.js"
$RecommendedOmpVersion = "18.0.11"

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

# 检查并确保 bun 全局 bundle；旧 native exe 不再作为 patch 目标
$ompExe = Join-Path $bunInstall "bin\omp.exe"
$ompLayout = "bundle"
$needInstall = $true
if (Test-Path (Join-Path $OmpPkgDir "package.json")) {
    try { $installed = (Get-Content (Join-Path $OmpPkgDir "package.json") -Raw | ConvertFrom-Json).version; $needInstall = ([version]$installed -lt [version]$RecommendedOmpVersion) } catch { $needInstall = $true }
}
if ($needInstall) {
    Write-Step "安装/升级 omp 到 $RecommendedOmpVersion"
    & bun install -g "@oh-my-pi/pi-coding-agent@$RecommendedOmpVersion"
    if ($LASTEXITCODE -ne 0) { Write-Fail "omp 安装/升级失败"; exit 1 }
}
if (-not (Test-Path $OmpPkgBundle)) { Write-Fail "升级后仍未找到 bundle: $OmpPkgBundle"; exit 1 }
$actual = (Get-Content (Join-Path $OmpPkgDir "package.json") -Raw | ConvertFrom-Json).version
if ([version]$actual -lt [version]"18.0.2") { Write-Fail "OMP 版本校验失败: $actual"; exit 1 }
Write-OK "omp bundle $actual"

# 2. 确保目录存在
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $AgentDir "skills") | Out-Null

# 3. 复制配置文件
Write-Step "复制 agent 配置"
$srcModels = Join-Path $RepoRoot "agent\models.yml"
$dstModels = Join-Path $AgentDir "models.yml"

# 从 models.yml 中提取所有 provider 块（2 空格缩进顶层键）中已填真实值（非占位符 <...>）的 apiKey。
# 返回 provider 名 -> key 的哈希，供重部署时回填保留；通用扫描，新增 provider 无需改此脚本。
function Get-ProviderApiKeys {
    param([string]$Content)
    $keys = @{}
    $blockMatches = [regex]::Matches($Content, "(?m)^  ([A-Za-z0-9_-]+):\r?\n(.*?)(?=^  [A-Za-z0-9_-]+:\s*$|\z)", [System.Text.RegularExpressions.RegexOptions]::Singleline)
    foreach ($m in $blockMatches) {
        $provider = $m.Groups[1].Value
        $km = [regex]::Match($m.Groups[2].Value, '(?m)^\s*apiKey:\s*(\S+)')
        if (-not $km.Success) { continue }
        $val = $km.Groups[1].Value
        if ($val -like '<*>*') { continue }   # 占位符 <...> 视为未填
        $keys[$provider] = $val
    }
    return $keys
}

# provider 名 -> 占位符（apiKey: <XXX> 形态）。用于环境变量注入与占位符盘点。
$script:ProviderPlaceholders = @{
    "volcengine-coding" = "<YOUR_API_KEY>"
    "amd"               = "<AMD_API_KEY>"
    "zhipu"             = "<ZHIPU_API_KEY>"
}

# 目标机已有真实 key（非占位）则提取保留，待复制后回填——
# 不能跳过整个文件，否则新模型定义（glm-5.3 / doubao-seed-2.0-mini / amd 等）永不部署
$existingKeys = @{}   # provider -> key
if ((Test-Path $dstModels) -and (Test-Path $srcModels)) {
    $dstContent = [System.IO.File]::ReadAllText($dstModels)
    $existingKeys = Get-ProviderApiKeys $dstContent
    foreach ($p in $existingKeys.Keys) {
        Write-OK "检测到 models.yml 已有 $p 的 apiKey，部署后回填保留"
    }
}

# 复制除 models.yml 外的所有 agent 文件
Get-ChildItem (Join-Path $RepoRoot "agent") -Exclude "models.yml" | ForEach-Object {
    Copy-Item -Force -Recurse $_.FullName -Destination $AgentDir
}
# models.yml 始终用仓库最新定义；若原有真实 key，复制后回填
Copy-Item -Force $srcModels -Destination $dstModels
if ($existingKeys.Count -gt 0) {
    $yml = [System.IO.File]::ReadAllText($dstModels)
    foreach ($p in $existingKeys.Keys) {
        $key = $existingKeys[$p]
        $placeholder = $script:ProviderPlaceholders[$p]
        if (-not $placeholder) {
            # 新 provider 仓库版还没定义占位符（理论少见）：按 provider 块内首个 apiKey 兜底替换
            $yml = [regex]::Replace($yml, "(?ms)(^  $([regex]::Escape($p)):\r?\n.*?apiKey:\s*)(\S+)",
                { param($m) if ($m.Groups[2].Value -like '<*>*') { $m.Groups[1].Value + $key } else { $m.Value } })
        } else {
            # 每个 provider 有唯一占位符，全局精确替换不会串 key；MatchEvaluator 插入字面值（防 key 含 $ 被当回引用）
            $yml = [regex]::Replace($yml, 'apiKey:\s*' + [regex]::Escape($placeholder),
                { param($m) "apiKey: $key" })
        }
    }
    Write-Utf8Text $dstModels $yml
    Write-OK "已回填各 provider apiKey 到最新 models.yml"
}
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

# 6. API Key：环境变量自动注入（OMP_API_KEY / AMD_API_KEY / ZHIPU_API_KEY），
#    不再交互输入。没填的保留占位符，结尾摘要会提示手动编辑。
Write-Step "配置 API Key（环境变量注入，无交互）"
$modelsYml = Join-Path $AgentDir "models.yml"
$envVarByProvider = @{ "volcengine-coding" = "OMP_API_KEY"; "amd" = "AMD_API_KEY"; "zhipu" = "ZHIPU_API_KEY" }
if (Test-Path $modelsYml) {
    $yml = [System.IO.File]::ReadAllText($modelsYml)

    foreach ($p in $script:ProviderPlaceholders.Keys) {
        $placeholder = $script:ProviderPlaceholders[$p]
        if ($yml -notmatch [regex]::Escape($placeholder)) {
            Write-OK "$p apiKey 已配置，跳过"
            continue
        }
        $envVar = $envVarByProvider[$p]
        $plain = $null
        if ($envVar -and -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($envVar))) {
            $plain = [Environment]::GetEnvironmentVariable($envVar).Trim()
        }
        if ([string]::IsNullOrWhiteSpace($plain)) {
            Write-Warn "$p 未填（占位符 $placeholder 保留）。可设环境变量 $envVar 自动注入，或手动编辑 models.yml"
        } else {
            # MatchEvaluator 委托插入字面 key（避免 $ 在替换模板中被当回引用）
            $yml = [regex]::Replace($yml, 'apiKey:\s*' + [regex]::Escape($placeholder),
                { param($m) "apiKey: $plain" })
            Write-OK "已从环境变量写入 $p 的 apiKey"
        }
    }

    Write-Utf8Text $modelsYml $yml
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
Write-Host "  omp 安装: $OmpPkgBundle (bundle)"
Write-Host ""
Write-Host "  启动: omp"
Write-Host "  回滚: bun $PatchScript --restore"
Write-Host ""

# 8.1 占位符盘点：提示哪些 provider 的 apiKey 还需手动填写
$unfilled = @()
if (Test-Path $modelsYml) {
    $finalYml = [System.IO.File]::ReadAllText($modelsYml)
    foreach ($p in $script:ProviderPlaceholders.Keys) {
        if ($finalYml -match ('apiKey:\s*' + [regex]::Escape($script:ProviderPlaceholders[$p]))) {
            $unfilled += $p
        }
    }
}
if ($unfilled.Count -gt 0) {
    Write-Host ""
    Write-Warn "以下 provider 的 apiKey 待填写（手动编辑即可，无需重跑本脚本）："
    foreach ($p in $unfilled) {
        Write-Host "    $p -> $($script:ProviderPlaceholders[$p])"
    }
    Write-Host "  文件: $modelsYml"
} else {
    Write-Host ""
    Write-OK "所有 provider 的 apiKey 已配置"
}
