# Ego Browser CLI setup on Windows

`setup.ps1` deploys OMP configuration and skills. It does **not** manage the Ego Lite executable, the user's PATH, or the Ego app's `active_version_dir` junction. Use this guide once per Windows machine to install a version-independent `ego-browser` command. The launcher source is `scripts/ego-browser.cmd`.

## Prerequisites

1. Install and open Ego Lite from <https://lite.ego.app/>; finish its first-run onboarding. This creates the browser profile and registers the app's own CLI path.
2. Clone or pull this repository on the machine.
3. Confirm the default install root exists:

```powershell
$applicationRoot = Join-Path $env:ProgramFiles 'Citro Labs\ego lite\Application'
Test-Path $applicationRoot
```

The launcher searches this stable application directory for numeric version folders containing `ego-browser.exe`; it does not pin a version or depend on `active_version_dir`.

## Install the launcher

Run from the repository root in PowerShell. This is idempotent: it overwrites only the launcher file and updates only the current user's PATH entries for the Ego launcher. It preserves unrelated PATH entries and removes the old per-version junction entry if present.

```powershell
$ErrorActionPreference = 'Stop'
$applicationRoot = Join-Path $env:ProgramFiles 'Citro Labs\ego lite\Application'
$source = Join-Path (Get-Location) 'scripts\ego-browser.cmd'

if (-not (Test-Path -LiteralPath $source)) {
    throw "Launcher source not found: $source; run this from the repository root."
}
if (-not (Test-Path -LiteralPath $applicationRoot)) {
    throw "Ego Lite Application directory not found: $applicationRoot; install Ego Lite first or adjust scripts/ego-browser.cmd for its install location."
}
$available = Get-ChildItem -LiteralPath $applicationRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+(\.\d+){1,3}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'ego-browser.exe')) }
if (-not $available) {
    throw "No Ego Lite version with ego-browser.exe found under $applicationRoot. Finish Ego Lite installation/onboarding first."
}

$egoHome = Join-Path $env:USERPROFILE '.local\share\ego'
$bin = Join-Path $egoHome 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $bin 'ego-browser.cmd') -Force

$oldJunction = Join-Path $egoHome 'active_version_dir'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
$kept = @($userPath | Where-Object {
    if (-not $_) { return }
    $entry = $_.Replace('/', '\').TrimEnd('\')
    ($entry -ine $oldJunction) -and ($entry -ine $bin)
})
[Environment]::SetEnvironmentVariable('Path', (@($bin) + $kept) -join ';', 'User')

# Use the updated PATH for verification in this PowerShell process too.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
Get-Command ego-browser | Format-List Name, Source, CommandType
ego-browser skill
ego-browser nodejs -e "console.log(1+1)"
```

Expected: `Get-Command` resolves to `~/.local/share/ego/bin/ego-browser.cmd`; `ego-browser skill` prints its usage guide; the final command prints `2`.

Restart OMP and existing terminals after setup so they inherit the updated PATH. Do **not** delete or manually maintain `active_version_dir`; the wrapper does not use it.

## How version selection works

Every invocation scans `%ProgramFiles%\Citro Labs\ego lite\Application`, filters to numeric version directories containing `ego-browser.exe`, selects the highest version, and forwards the original command-line arguments and exit code. New app versions work without editing this launcher or PATH. If Ego Lite is installed outside the default directory or changes its directory layout, update the `$root` expression in `scripts/ego-browser.cmd`, then rerun the install block.
