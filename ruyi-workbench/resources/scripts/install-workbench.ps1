param(
  [string]$WorkbenchExe = "",
  [string]$ClaudePath = "",
  [ValidateSet("user", "project", "local")]
  [string]$Scope = "user",
  [switch]$SkipPluginMarketplace,
  [switch]$SetUserPluginSeedEnv
)

$ErrorActionPreference = "Stop"

function Resolve-WorkbenchRoot {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}

# One command-line token under the MSVC / CommandLineToArgvW rules: wrap in quotes when needed, double the backslashes
# that precede a quote (or the closing quote), escape the quote itself.
function ConvertTo-CommandLineToken {
  param([string]$Value)
  if ($Value -ne '' -and $Value -notmatch '[\s"]') { return $Value }
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

# Runs a native program with exactly these argv items and returns its exit code (output goes to the console).
# `& $exe ... $json` cannot carry JSON on Windows PowerShell 5.1 (or 7.0-7.2): it does not escape embedded quotes and
# decides whether to wrap a value by counting every quote in it, so `claude mcp add-json ruyi <json>` received
# {command:C:\...} and failed. Building the command line here sidesteps PowerShell's argument rewriting.
function Invoke-NativeExact {
  param([string]$FilePath, [string[]]$ArgumentList)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (@($ArgumentList) | ForEach-Object { ConvertTo-CommandLineToken $_ }) -join ' '
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.WaitForExit()
  return $proc.ExitCode
}

function Find-Claude {
  param([string]$Preferred)
  if ($Preferred) { return $Preferred }
  $cmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command claude.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

$root = Resolve-WorkbenchRoot

# Prefer the node runtime + overlaid app\server.js so the generated MCP config points at the
# updated source (new MCP tools work without rebuilding the baked exe). Fall back to the exe.
$nodeExe   = Join-Path $root "runtime\node\node.exe"
$serverJs  = Join-Path $root "app\server.js"
$useNode   = (Test-Path $nodeExe) -and (Test-Path $serverJs)

if (-not $WorkbenchExe) {
  # v1.0-S9 exe 改名 Ruyi.exe;双名兼容——先探新名,再探旧名(存量部署仍名 WinClaudeWorkbench.exe)。
  foreach ($name in @("Ruyi.exe", "WinClaudeWorkbench.exe")) {
    $candidate = Join-Path $root $name
    if (Test-Path $candidate) { $WorkbenchExe = $candidate; break }
    $candidate = Join-Path $root "dist\$name"
    if (Test-Path $candidate) { $WorkbenchExe = $candidate; break }
  }
}

if (-not $useNode -and (-not $WorkbenchExe -or -not (Test-Path $WorkbenchExe))) {
  throw "Neither runtime\node\node.exe + app\server.js nor Ruyi.exe (legacy WinClaudeWorkbench.exe) was found. Run from the extracted package root."
}

$ClaudePath = Find-Claude $ClaudePath
if ($useNode) {
  Write-Host "Runner: node $serverJs (overlay source)"
} else {
  Write-Host "Runner: $WorkbenchExe (baked exe)"
}
Write-Host "Claude CLI: $(if ($ClaudePath) { $ClaudePath } else { '(not found)' })"

if ($useNode) {
  $mcpConfigPath = (& $nodeExe $serverJs mcp-config).Trim()
} else {
  $mcpConfigPath = (& $WorkbenchExe mcp-config).Trim()
}
if (-not (Test-Path $mcpConfigPath)) {
  throw "MCP config was not generated: $mcpConfigPath"
}

$mcpConfig = Get-Content -Raw $mcpConfigPath | ConvertFrom-Json
# 3.0: Ruyi's MCP server id is 'ruyi' (tools show up as mcp__ruyi__*); the pre-3.0 id 'win-claude-workbench' is removed first.
$serverJson = $mcpConfig.mcpServers.'ruyi' | ConvertTo-Json -Depth 20 -Compress

if ($ClaudePath) {
  Write-Host "Registering MCP server with Claude CLI..."
  # Native exe non-zero exits do NOT throw, so check $LASTEXITCODE (try/catch only catches launch failure).
  try {
    # Pre-3.0 id; absent on fresh installs. Remove it from every scope (the old node installer used local, this script
    # used $Scope). Each in its own try: with ErrorActionPreference=Stop a native stderr line can throw.
    foreach ($legacyScope in @('local', 'user', 'project')) {
      try { & $ClaudePath mcp remove win-claude-workbench -s $legacyScope *> $null } catch { }
    }
    $addExit = Invoke-NativeExact $ClaudePath @('mcp', 'add-json', 'ruyi', $serverJson, '-s', $Scope)
    if ($addExit -ne 0) { Write-Warning "claude mcp add-json failed (exit $addExit). Manually import: $mcpConfigPath" }
  } catch {
    Write-Warning "claude mcp add-json could not run. You can manually import: $mcpConfigPath"
  }

  if (-not $SkipPluginMarketplace) {
    $marketplaceRoot = Join-Path $root "resources\plugins\ruyi-offline"
    if (Test-Path (Join-Path $marketplaceRoot ".claude-plugin\marketplace.json")) {
      Write-Host "Registering offline plugin marketplace..."
      try {
        # 3.0: the marketplace was renamed win-workbench-offline -> ruyi-offline; drop the old registration first (ignore "not found").
        try { & $ClaudePath plugin uninstall offline-toolkit@win-workbench-offline --scope $Scope *> $null } catch { }
        try { & $ClaudePath plugin marketplace remove win-workbench-offline *> $null } catch { }
        & $ClaudePath plugin marketplace add $marketplaceRoot --scope $Scope
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "plugin marketplace add failed (exit $LASTEXITCODE); skipping install. Claude CLI may not support plugins yet."
        } else {
          & $ClaudePath plugin install offline-toolkit@ruyi-offline --scope $Scope
          if ($LASTEXITCODE -ne 0) { Write-Warning "plugin install failed (exit $LASTEXITCODE). See why with: `"$ClaudePath`" plugin validate `"$marketplaceRoot`"" }
        }
      } catch {
        Write-Warning "Plugin marketplace/install could not run. Claude CLI may not support plugins yet, or policy may block local marketplaces."
      }
    }
  }
}

# CLAUDE_CODE_PLUGIN_SEED_DIR expects a pre-populated Claude plugins directory (known_marketplaces.json, marketplaces/,
# cache/), not a marketplace source folder, so pointing it at resources\plugins never registered anything; the plugin is
# installed by `claude plugin marketplace add` + `plugin install` above. Older versions of this script set the variable
# to exactly this path: clear that stale value and leave anything else the user set alone.
$seed = Join-Path $root "resources\plugins"
if ([Environment]::GetEnvironmentVariable("CLAUDE_CODE_PLUGIN_SEED_DIR", "User") -eq $seed) {
  [Environment]::SetEnvironmentVariable("CLAUDE_CODE_PLUGIN_SEED_DIR", $null, "User")
  Write-Host "Cleared stale user CLAUDE_CODE_PLUGIN_SEED_DIR=$seed"
}
if ($SetUserPluginSeedEnv) {
  Write-Warning "-SetUserPluginSeedEnv is no longer used: the offline plugin is installed with 'claude plugin install' instead."
}

Write-Host ""
Write-Host "Done."
if ($useNode) {
  Write-Host "UI: run Start-Workbench.cmd  (or `"$nodeExe`" `"$serverJs`" serve --open)"
} else {
  Write-Host "UI: run `"$WorkbenchExe`" serve --open  (or Start-Workbench.cmd)"
}
Write-Host "MCP config: $mcpConfigPath"
Write-Host "Offline plugin marketplace: $(Join-Path $root 'resources\plugins\ruyi-offline')"
