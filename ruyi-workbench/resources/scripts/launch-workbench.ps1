param(
  [int]$Port = 8765,
  [string]$HostName = "127.0.0.1",
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path (Split-Path -Parent $PSCommandPath) "..\..")).Path
# v1.0-S9 exe 改名 Ruyi.exe;双名兼容探测——先探新名,再探旧名(存量部署仍名 WinClaudeWorkbench.exe)。
$exe = $null
foreach ($name in @("Ruyi.exe", "WinClaudeWorkbench.exe")) {
  $cand = Join-Path $root $name
  if (Test-Path $cand) { $exe = $cand; break }
  $cand = Join-Path $root "dist\$name"
  if (Test-Path $cand) { $exe = $cand; break }
}
if (-not $exe) {
  throw "Ruyi.exe (or legacy WinClaudeWorkbench.exe) not found under $root"
}

$args = @("serve", "--port", "$Port", "--host", $HostName)
if (-not $NoOpen) { $args += "--open" }
Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden
Write-Host "Started 如意 Ruyi at http://$HostName`:$Port/"
