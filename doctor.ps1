$ErrorActionPreference = "SilentlyContinue"
$homeDir = $env:USERPROFILE
$ompHome = Join-Path $homeDir ".omp"
$bunInstall = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $homeDir ".bun" }
$bundle = Join-Path $bunInstall "install\global\node_modules\@oh-my-pi\pi-coding-agent\dist\cli.js"
$pkg = Split-Path (Split-Path $bundle)
function Check($name, $ok, $detail) { Write-Host ("{0,-12} {1} {2}" -f $name, $(if($ok){"OK"}else{"FAIL"}), $detail) -ForegroundColor $(if($ok){"Green"}else{"Red"}) }
$bun = Get-Command bun; Check "Bun" ($null -ne $bun) $(if($bun){& bun --version}else{"not found"})
$ver = $null; try {$ver=(Get-Content (Join-Path $pkg "package.json") -Raw|ConvertFrom-Json).version} catch {}
Check "OMP" (($ver -as [version]) -ge [version]"18.0.2") $(if($ver){$ver}else{"bundle/package missing"})
Check "bundle" (Test-Path $bundle) $bundle
foreach($f in @("config.yml","models.yml","lsp.json","mcp.json")){ $p=Join-Path $ompHome "agent\$f"; Check $f (Test-Path $p) $p }
foreach($tool in @("gopls","python")){ $c=Get-Command $tool; Check $tool ($null -ne $c) $(if($c){$c.Source}else{"not found"}) }
# codebase-memory-mcp：PATH 未刷新的会话里 Get-Command 找不到，回退到安装器默认落点
$cbm = Get-Command codebase-memory-mcp
if(-not $cbm){
    foreach($cand in @((Join-Path $env:LOCALAPPDATA "Programs\codebase-memory-mcp\codebase-memory-mcp.exe"), (Join-Path $homeDir ".local\bin\codebase-memory-mcp.exe"))){
        if(Test-Path $cand){ $cbm = [pscustomobject]@{ Source = $cand }; break }
    }
}
Check "mem-mcp-bin" ($null -ne $cbm) $(if($cbm){$cbm.Source}else{"not found (README: 代码知识图谱 MCP)"})
