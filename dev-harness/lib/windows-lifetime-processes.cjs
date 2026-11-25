'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

// CIM timestamps are compared only to other CIM samples. Keep the exact
// kernel creation time separately for the registered server.
async function processRows(pids, childrenOf) {
  const filters = pids.map(pid => 'ProcessId=' + pid);
  if (childrenOf) filters.push('ParentProcessId=' + childrenOf);
  const command = [
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "$rows=@(Get-CimInstance Win32_Process -Filter '" + filters.join(' OR ') + "' | ForEach-Object {",
    " $row=@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$_.CreationDate.ToFileTimeUtc().ToString()}",
    ...(childrenOf ? [
      " $row.image=$_.ExecutablePath; $row.commandLine=$_.CommandLine",
      " if($row.pid -eq " + childrenOf + ") { $row.nativeCreated=(Get-Process -Id $row.pid).StartTime.ToFileTimeUtc().ToString() }"
    ] : []),
    " $row", "}); ConvertTo-Json -InputObject $rows -Compress"
  ].join('\n');
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  return JSON.parse(stdout);
}

const sameProcess = (row, identity) => row.pid === identity.pid && row.created === identity.created;
const processIdentity = ({ pid, parent, created, image }) => ({ pid, parent, created, image });

module.exports = { processRows, sameProcess, processIdentity };
