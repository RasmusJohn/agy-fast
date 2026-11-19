# agy-fast one-command installer for Windows PowerShell
# Local usage:
#   .\install.ps1
#   .\install.ps1 --project C:\path\to\repo
#   .\install.ps1 doctor
#   .\install.ps1 uninstall
# Remote usage:
#   irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex

$__agyFastScriptPath = ""
if ($null -ne $MyInvocation.MyCommand -and $null -ne $MyInvocation.MyCommand.PSObject.Properties["Path"]) {
  $__agyFastScriptPath = [string]$MyInvocation.MyCommand.Path
}
$__agyFastScriptRoot = if ($null -ne $PSScriptRoot) { [string]$PSScriptRoot } else { "" }
$__agyFastIsFile = -not [string]::IsNullOrEmpty($__agyFastScriptPath)
$__agyFastAcceptArgs = $__agyFastIsFile -or ($MyInvocation.InvocationName -eq "&")
$__agyFastArgList = New-Object 'System.Collections.Generic.List[string]'
if ($__agyFastAcceptArgs -and $null -ne $args) {
  foreach ($__agyFastItem in $args) {
    if ($null -ne $__agyFastItem) {
      $__agyFastArgList.Add([string]$__agyFastItem)
    }
  }
}
[string[]]$__agyFastRawArgs = $__agyFastArgList.ToArray()
$__agyFastState = @{ ExitCode = 0 }

& {
  param(
    [string[]]$InputArgs = @(),
    [string]$ScriptRoot = "",
    [hashtable]$State
  )

  $ErrorActionPreference = "Stop"
  $defaultRepo = "https://github.com/INK-Q/agy-fast.git"

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js >= 20 is required. Install Node.js first: https://nodejs.org/"
    $State.ExitCode = 1
    return
  }

  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $nodeMajorRaw = (& node -p "process.versions.node.split('.')[0]" | Out-String).Trim()
    $nodeCheckExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $nodeMajor = 0
  if ($nodeCheckExit -ne 0 -or -not [int]::TryParse($nodeMajorRaw, [ref]$nodeMajor) -or $nodeMajor -lt 20) {
    $nodeVer = (& node -v 2>$null | Out-String).Trim()
    Write-Error "Node.js >= 20 is required (found $nodeVer)."
    $State.ExitCode = 1
    return
  }

  $subcommands = @("install", "uninstall", "status", "doctor", "-h", "--help")
  $hasSubcmd = ($InputArgs.Length -gt 0) -and ($subcommands -contains $InputArgs[0])

  $forwardList = New-Object 'System.Collections.Generic.List[string]'
  if (-not $hasSubcmd) {
    $forwardList.Add("install")
  }
  foreach ($a in $InputArgs) {
    $forwardList.Add([string]$a)
  }
  [string[]]$forwardArgs = $forwardList.ToArray()

  function Invoke-NodeInstaller {
    param(
      [string]$InstallerPath,
      [string[]]$ForwardArgs,
      [hashtable]$RunState
    )
    # Always build a >= 2 element [string[]] so Windows PowerShell 5.1 never
    # unwraps a 1-element array to a scalar [string] and splats it char-by-char
    # (e.g. "install" -> 'i' 'n' 's' 't' 'a' 'l' 'l').
    $argList = New-Object 'System.Collections.Generic.List[string]'
    $argList.Add($InstallerPath)
    foreach ($fa in $ForwardArgs) {
      $argList.Add([string]$fa)
    }
    [string[]]$nodeArgs = $argList.ToArray()

    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & node @nodeArgs
      $RunState.ExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedEap
    }
  }

  $scriptDir = if (-not [string]::IsNullOrEmpty($ScriptRoot)) { $ScriptRoot } else { (Get-Location).Path }
  $localManifest = Join-Path $scriptDir "plugin.json"
  $localInstaller = Join-Path $scriptDir "scripts\install.mjs"

  if ((Test-Path $localManifest) -and (Test-Path $localInstaller)) {
    Invoke-NodeInstaller -InstallerPath $localInstaller -ForwardArgs $forwardArgs -RunState $State
    return
  }

  $defaultTarget = Join-Path $env:USERPROFILE ".gemini\config\plugins\agy-fast"
  $installedInstaller = Join-Path $defaultTarget "scripts\install.mjs"
  if ($hasSubcmd -and ($InputArgs[0] -ne "install") -and (Test-Path $installedInstaller)) {
    Invoke-NodeInstaller -InstallerPath $installedInstaller -ForwardArgs $forwardArgs -RunState $State
    return
  }

  $repoUrl = if ($env:AGY_FAST_REPO) { $env:AGY_FAST_REPO } else { $defaultRepo }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git is required for remote installation."
    $State.ExitCode = 1
    return
  }

  $tmpClone = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-fast-install-" + [System.Guid]::NewGuid().ToString("N"))
  try {
    Write-Host "Cloning agy-fast from $repoUrl..."
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & git clone --depth 1 $repoUrl $tmpClone
      $gitExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedEap
    }
    if ($gitExit -ne 0) {
      Write-Error "git clone failed with exit code $gitExit."
      $State.ExitCode = $gitExit
      return
    }

    $clonedInstaller = Join-Path $tmpClone "scripts\install.mjs"
    Invoke-NodeInstaller -InstallerPath $clonedInstaller -ForwardArgs $forwardArgs -RunState $State
  } finally {
    if (Test-Path $tmpClone) {
      Remove-Item -Path $tmpClone -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
} -InputArgs $__agyFastRawArgs -ScriptRoot $__agyFastScriptRoot -State $__agyFastState

$__agyFastFinalExit = $__agyFastState.ExitCode
$__agyFastWasFile = $__agyFastIsFile
Remove-Variable -Name __agyFastScriptPath, __agyFastScriptRoot, __agyFastIsFile, __agyFastAcceptArgs, __agyFastArgList, __agyFastItem, __agyFastRawArgs, __agyFastState -ErrorAction SilentlyContinue
if ($__agyFastWasFile) {
  Remove-Variable -Name __agyFastWasFile -ErrorAction SilentlyContinue
  exit $__agyFastFinalExit
}
Remove-Variable -Name __agyFastFinalExit, __agyFastWasFile -ErrorAction SilentlyContinue

