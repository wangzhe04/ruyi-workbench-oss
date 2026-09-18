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

// 107-F9b：只数、不杀。run-all 收工时报一句「本机还剩几个 Ruyi 测试 profile 的浏览器」—— 每件都按自己的
// 临时根收尸之后，这个数应当是 0；不是 0 就说明有夹具的 profile 没落在自己的根里（或它自己没收尸），
// 漏出来的会一路攒到下一轮 run-all 开头的全局收尸。判据与上面不传目录时的那条正则逐字相同。
function countRuyiTestBrowsers() {
  if (process.platform !== 'win32') return 0;
  const script = [
    "$items=@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object {",
    '  if(-not $_.CommandLine){ return $false }',
    "  return $_.CommandLine -match '--user-data-dir=.*[\\\\/](?:ruyi-|wcw-)'",
    '})',
    'Write-Output $items.Count',
  ].join(';');
  const result = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  const count = Number.parseInt(String(result.stdout || '').trim(), 10);
  return Number.isFinite(count) ? count : -1;
}

module.exports = { stopRuyiTestBrowsers, countRuyiTestBrowsers };
