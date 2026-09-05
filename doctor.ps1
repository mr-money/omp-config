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
foreach($f in @("config.yml","models.yml","lsp.json","cost.json")){ $p=Join-Path $ompHome "agent\$f"; Check $f (Test-Path $p) $p }
$src=if(Test-Path $bundle){Get-Content $bundle -Raw}else{""}; Check "CNY patch" ($src -match '__CNY_PATCH_VERSION__="2026\.09\.05\.1"' -and $src -match '__cnyIsFree') "patch 2026.09.05.1 marker"
$wrapper=Join-Path $bunInstall "bin\omp.cmd"; Check "wrapper" (Test-Path $wrapper) $wrapper
foreach($tool in @("gopls","python")){ $c=Get-Command $tool; Check $tool ($null -ne $c) $(if($c){$c.Source}else{"not found"}) }
