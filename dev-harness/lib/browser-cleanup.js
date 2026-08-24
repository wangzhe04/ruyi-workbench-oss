'use strict';

const cp = require('child_process');

// Chromium may leave breakaway utility processes behind after taskkill /T. Those processes keep the
// temporary profile locked and, across the full suite, eventually prevent new Node/Edge processes from
// starting. Match only Ruyi-owned test profiles; never touch a user's normal browser profile.
function stopRuyiTestBrowsers(profileDir = '') {
  if (process.platform !== 'win32') return 0;
  const script = [
    "$needle=[Environment]::GetEnvironmentVariable('RUYI_TEST_BROWSER_PROFILE')",
    '$count=0',
    'for($pass=0;$pass -lt 3;$pass++){',
    "  $items=@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object {",
    '    if(-not $_.CommandLine){ return $false }',
    "    if($needle){ return $_.CommandLine.Contains($needle) }",
    "    return $_.CommandLine -match '--user-data-dir=.*[\\\\/](?:ruyi-|wcw-)'",
    '  })',
    '  if(-not $items.Count){ break }',
    '  $count += $items.Count',
    '  $items | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '  Start-Sleep -Milliseconds 100',
    '}',
    'Write-Output $count',
  ].join(';');
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, RUYI_TEST_BROWSER_PROFILE: String(profileDir || '') },
  });
  const count = Number.parseInt(String(result.stdout || '').trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

module.exports = { stopRuyiTestBrowsers };
