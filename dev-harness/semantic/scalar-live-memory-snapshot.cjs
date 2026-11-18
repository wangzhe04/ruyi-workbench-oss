'use strict';
const cp = require('node:child_process'), path = require('node:path'), fs = require('node:fs'), { promisify } = require('node:util');
function aggregate(snapshot, expected) {
  const roles = ['coarse', 'scalar'], rows = Array.isArray(snapshot.rows) ? snapshot.rows : [snapshot.rows];
  const complete = rows.length === 2 && new Set(rows.map(row => row.role)).size === 2 && expected.coarse?.pid !== expected.scalar?.pid && roles.every(role => { const identity = expected[role], row = rows.find(item => item.role === role);
    return identity && row && row.alive === true && row.pid === identity.pid && /^\d+$/.test(String(row.creationFileTime))
      && (!identity.creationFileTime || String(identity.creationFileTime) === String(row.creationFileTime))
      && [row.workingSetBytes, row.privateBytes].every(value => Number.isSafeInteger(value) && value >= 0); });
  return { ...snapshot, complete, ...(complete ? { combinedWorkingSetBytes: rows.reduce((sum, row) => sum + row.workingSetBytes, 0), combinedPrivateBytes: rows.reduce((sum, row) => sum + row.privateBytes, 0) } : {}) };
}
async function snapshot(expected, directory) {
  for (const identity of Object.values(expected)) if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || identity.pid > 0xffffffff
    || identity.creationFileTime !== null && !/^\d+$/.test(String(identity.creationFileTime))) throw TypeError('Memory snapshot requires both owned PID identities.');
  fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'OWNER.json'), JSON.stringify({ owner: 'scalar-live-memory-snapshot', synthetic: true }) + '\n');
  for (const name of ['local', 'roaming', 'temp']) fs.mkdirSync(path.join(directory, name), { recursive: true });
  const encoded = Buffer.from(JSON.stringify(expected)).toString('base64');
  const script = `$ErrorActionPreference='Stop';$wanted=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;$begin=[DateTime]::UtcNow.ToString('o');$rows=@();foreach($role in @('coarse','scalar')){$identity=$wanted.$role;try{$process=[Diagnostics.Process]::GetProcessById([int]$identity.pid);$process.Refresh();$rows+=@{role=$role;alive=$true;pid=$process.Id;creationFileTime=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();workingSetBytes=$process.WorkingSet64;privateBytes=$process.PrivateMemorySize64}}catch{$rows+=@{role=$role;alive=$false;pid=[int]$identity.pid}}};@{beginUtc=$begin;endUtc=[DateTime]::UtcNow.ToString('o');rows=$rows}|ConvertTo-Json -Depth 5 -Compress`;
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
    PATH: path.join(process.env.SystemRoot, 'System32'), HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, 'roaming'), LOCALAPPDATA: path.join(directory, 'local'), TEMP: path.join(directory, 'temp'), TMP: path.join(directory, 'temp') };
  const result = await promisify(cp.execFile)(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { env, cwd: directory, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  return aggregate(JSON.parse(result.stdout.replace(/^\uFEFF/, '')), expected);
}
module.exports = { snapshot, aggregate };
