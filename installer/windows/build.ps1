<#
  Builds the AgencyOS Windows installer on a Windows machine, the same way CI does.

  Needs: Node.js 22, Git, Inno Setup 6 (https://jrsoftware.org/isinfo.php). Run from the repository root:

      powershell -ExecutionPolicy Bypass -File installer\windows\build.ps1

  Output: installer\dist\out\AgencyOS-Setup-<version>.exe
  Takes 20-40 minutes the first time. Add -SkipBuild to reuse an earlier `pnpm run build`.
#>
param(
  [string]$Version = '',
  [switch]$SkipBuild,
  [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
if (-not $Version) { $Version = (Get-Content installer\VERSION).Trim() }

function Run($label, [scriptblock]$block) {
  Write-Host "`n== $label" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$label failed ($LASTEXITCODE)" }
}

Run 'Launcher and desktop tests' {
  node --test installer/launcher/test/*.test.mjs
  if ($LASTEXITCODE -eq 0) { node --test installer/desktop/test/policy.test.js }
}

if (-not $SkipBuild) {
  if (-not $SkipInstall) {
    Run 'Install dependencies' { corepack enable; corepack prepare pnpm@10.6.1 --activate; pnpm install --frozen-lockfile }
  }
  $env:AGENCYOS_STANDALONE = 'true'
  $env:STORAGE_PROVIDER = 'local'
  $env:NODE_OPTIONS = '--max-old-space-size=6144'
  Run 'Build the apps' { pnpm run build }
}

Run 'Stage the application' { node installer/build/stage-app.mjs --out installer/dist/stage --platform win32 --verify }
Run 'Stage the runtimes' { node installer/build/stage-runtime.mjs --out installer/dist/stage --version $Version }
Run 'Icons' { node installer/build/make-icons.mjs --out installer/desktop/assets }
Run 'Desktop shell' {
  npx --yes '@electron/packager@20.3.0' installer/desktop AgencyOS --platform=win32 --arch=x64 --electron-version=44.7.0 `
    --out=installer/dist/desktop --overwrite --asar --icon=installer/desktop/assets/icon.ico `
    "--app-version=$Version" "--build-version=$Version" "--win32metadata.CompanyName=NextGen OS" `
    --win32metadata.FileDescription=AgencyOS --win32metadata.ProductName=AgencyOS --win32metadata.OriginalFilename=AgencyOS.exe '--ignore=^/test'
  if ($LASTEXITCODE -eq 0) { Copy-Item "installer\dist\desktop\AgencyOS-win32-x64\*" installer\dist\stage -Recurse -Force }
}

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 was not found. Install it from https://jrsoftware.org/isdl.php' }
Run 'Compile the installer' {
  & $iscc /Qp "/DAppVersion=$Version" "/DNumericVersion=$Version.0" "/DStageDir=$root\installer\dist\stage" "/DOutDir=$root\installer\dist\out" "/DIconFile=$root\installer\desktop\assets\icon.ico" installer\windows\agencyos.iss
}
Get-ChildItem installer\dist\out\*.exe | ForEach-Object { Write-Host ("{0}  {1:N0} MB  sha256 {2}" -f $_.Name, ($_.Length / 1MB), (Get-FileHash $_.FullName -Algorithm SHA256).Hash) -ForegroundColor Green }
