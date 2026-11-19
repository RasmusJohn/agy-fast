# agy-fast one-command installer for Windows PowerShell
# Local usage:
#   .\install.ps1
#   .\install.ps1 --project C:\path\to\repo
#   .\install.ps1 doctor
#   .\install.ps1 uninstall
# Remote usage:
#   irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$defaultRepo = "https://github.com/INK-Q/agy-fast.git"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js >= 20 is required. Install Node.js first: https://nodejs.org/"
  exit 1
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
  Write-Error "Node.js >= 20 is required (found $(node -v))."
  exit 1
}

$subcommands = @("install", "uninstall", "status", "doctor", "-h", "--help")
$hasSubcmd = ($args.Count -gt 0) -and ($subcommands -contains $args[0])
$forwardArgs = if ($hasSubcmd) { $args } else { @("install") + $args }

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$localManifest = Join-Path $scriptDir "plugin.json"
$localInstaller = Join-Path $scriptDir "scripts\install.mjs"

if ((Test-Path $localManifest) -and (Test-Path $localInstaller)) {
  & node $localInstaller @forwardArgs
  exit $LASTEXITCODE
}

$defaultTarget = Join-Path $env:USERPROFILE ".gemini\config\plugins\agy-fast"
$installedInstaller = Join-Path $defaultTarget "scripts\install.mjs"
if ($hasSubcmd -and ($args[0] -ne "install") -and (Test-Path $installedInstaller)) {
  & node $installedInstaller @forwardArgs
  exit $LASTEXITCODE
}

$repoUrl = if ($env:AGY_FAST_REPO) { $env:AGY_FAST_REPO } else { $defaultRepo }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "git is required for remote installation."
  exit 1
}

$tmpClone = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-fast-install-" + [System.Guid]::NewGuid().ToString("N"))
try {
  Write-Host "Cloning agy-fast from $repoUrl..."
  & git clone --depth 1 $repoUrl $tmpClone
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  & node (Join-Path $tmpClone "scripts\install.mjs") @forwardArgs
  exit $LASTEXITCODE
} finally {
  if (Test-Path $tmpClone) {
    Remove-Item -Path $tmpClone -Recurse -Force -ErrorAction SilentlyContinue
  }
}
