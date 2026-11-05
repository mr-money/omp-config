@echo off
setlocal
for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$root=Join-Path $env:ProgramFiles 'Citro Labs\ego lite\Application'; $candidate=Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+(\.\d+){1,3}$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'ego-browser.exe')) } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1; if ($candidate) { Join-Path $candidate.FullName 'ego-browser.exe' }"`) do set "EGO_BROWSER=%%I"
if not defined EGO_BROWSER (
  echo ego-browser: no installed Ego Lite version found under Program Files 1>&2
  exit /b 9009
)
"%EGO_BROWSER%" %*
exit /b %ERRORLEVEL%
