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
$serverJson = $mcpConfig.mcpServers.'win-claude-workbench' | ConvertTo-Json -Depth 20 -Compress

if ($ClaudePath) {
  Write-Host "Registering MCP server with Claude CLI..."
  # Native exe non-zero exits do NOT throw, so check $LASTEXITCODE (try/catch only catches launch failure).
  try {
    & $ClaudePath mcp add-json win-claude-workbench $serverJson -s $Scope
    if ($LASTEXITCODE -ne 0) { Write-Warning "claude mcp add-json failed (exit $LASTEXITCODE). Manually import: $mcpConfigPath" }
  } catch {
    Write-Warning "claude mcp add-json could not run. You can manually import: $mcpConfigPath"
  }

  if (-not $SkipPluginMarketplace) {
    $marketplaceRoot = Join-Path $root "resources\plugins\win-workbench-offline"
    if (Test-Path (Join-Path $marketplaceRoot ".claude-plugin\marketplace.json")) {
      Write-Host "Registering offline plugin marketplace..."
      try {
        & $ClaudePath plugin marketplace add $marketplaceRoot --scope $Scope
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "plugin marketplace add failed (exit $LASTEXITCODE); skipping install. Claude CLI may not support plugins yet."
        } else {
          & $ClaudePath plugin install offline-toolkit@win-workbench-offline --scope $Scope
          if ($LASTEXITCODE -ne 0) { Write-Warning "plugin install failed (exit $LASTEXITCODE)." }
        }
      } catch {
        Write-Warning "Plugin marketplace/install could not run. Claude CLI may not support plugins yet, or policy may block local marketplaces."
      }
    }
  }
}

$seed = Join-Path $root "resources\plugins"
if ($SetUserPluginSeedEnv) {
  [Environment]::SetEnvironmentVariable("CLAUDE_CODE_PLUGIN_SEED_DIR", $seed, "User")
  Write-Host "Set user CLAUDE_CODE_PLUGIN_SEED_DIR=$seed"
}

Write-Host ""
Write-Host "Done."
if ($useNode) {
  Write-Host "UI: run Start-Workbench.cmd  (or `"$nodeExe`" `"$serverJs`" serve --open)"
} else {
  Write-Host "UI: run `"$WorkbenchExe`" serve --open  (or Start-Workbench.cmd)"
}
Write-Host "MCP config: $mcpConfigPath"
Write-Host "Offline plugin seed: $seed"
