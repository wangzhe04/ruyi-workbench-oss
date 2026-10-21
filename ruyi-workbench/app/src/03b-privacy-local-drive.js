// Host-only drive classification; no user path, directory or volume-content probes.
const PrivacyLocalDriveProbe = (() => {
  const driveChildProcess = require('node:child_process'), drivePath = require('node:path');
  const host = {};
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($null -ne ($line = [Console]::ReadLine())) {
  if ($line -notmatch '^[A-Z](,[A-Z]){0,25}$') { exit 23 }
  $rows = foreach ($letter in $line.Split(',')) {
    $drive = [IO.DriveInfo]::new($letter + ':\')
    $letter + ':' + [string]$drive.DriveType
  }
  [Console]::WriteLine(($rows -join '|'))
}
`;
  let child = null, active = null, queued = [], buffer = '', idle = null, exitHook = false;
  const error = kind => Object.assign(new Error('privacy.drive_probe_' + kind), { code: 'privacy.drive_probe_' + kind });
  function stopSync(reason = error('stopped'), terminate = true) {
    clearTimeout(idle); idle = null;
    const owned = child; child = null; buffer = '';
    const work = active ? [active, ...queued] : queued;
    active = null; queued = [];
    for (const job of work) { clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort); job.reject(reason); }
    if (owned) {
      for (const stream of [owned.stdin, owned.stdout, owned.stderr]) { try { stream?.destroy(); } catch { /* Continue retiring this owner. */ } }
      // This fixed DriveInfo-only script never spawns descendants. Use its live
      // ChildProcess handle, never a delayed tree kill against a reusable PID.
      if (terminate && owned.exitCode === null && owned.signalCode === null) {
        try { if (typeof host.stopChild === 'function') host.stopChild(owned); else owned.kill(); } catch { /* Fail closed without crashing the server. */ }
      }
    }
  }
  function start() {
    if (child) return;
    if (process.platform !== 'win32') throw error('unsupported');
    const root = process.env.SystemRoot;
    if (typeof root !== 'string' || !/^[A-Z]:\\[^\r\n]*$/i.test(root) || root.includes('..')) throw error('system_root');
    if (!exitHook) { process.once('exit', () => stopSync()); exitHook = true; }
    const executable = drivePath.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const owned = driveChildProcess.spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = owned;
    owned.stdout.setEncoding('utf8');
    owned.stdout.on('data', chunk => {
      if (child !== owned) return;
      buffer += chunk;
      if (buffer.length > 2048) return stopSync(error('protocol'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!active || buffer.length) return stopSync(error('protocol'));
      const expected = active.letters;
      const rows = line.split('|'), values = new Map();
      if (rows.length !== expected.length) return stopSync(error('protocol'));
      for (let i = 0; i < rows.length; i++) {
        const match = /^([A-Z]):(Unknown|NoRootDirectory|Removable|Fixed|Network|CDRom|Ram)$/.exec(rows[i]);
        if (!match || match[1] !== expected[i]) return stopSync(error('protocol'));
        values.set(match[1], match[2]);
      }
      const job = active; active = null;
      clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
      job.resolve(new Map(job.roots.map(root => [root, values.get(root[0].toUpperCase())])));
      pump();
    });
    owned.stderr.on('data', () => { if (child === owned) stopSync(error('stderr')); });
    owned.stdout.on('error', () => { if (child === owned) stopSync(error('read')); });
    owned.stderr.on('error', () => { if (child === owned) stopSync(error('read')); });
    owned.stdin.on('error', () => { if (child === owned) stopSync(error('write')); });
    owned.on('error', () => { if (child === owned) stopSync(error('spawn')); });
    owned.on('exit', () => { if (child === owned) stopSync(error('exit'), false); });
  }
  function pump() {
    clearTimeout(idle); idle = null;
    if (active) return;
    if (!queued.length) {
      if (child) {
        // A dormant classifier must not hold a CLI/test process open. The exit
        // hook retires this handle; active requests retain their deadline timer.
        for (const handle of [child, child.stdin, child.stdout, child.stderr]) handle?.unref?.();
        idle = setTimeout(() => stopSync(), 15000); idle.unref?.();
      }
      return;
    }
    active = queued.shift();
    try {
      start();
      for (const handle of [child, child.stdin, child.stdout, child.stderr]) handle?.ref?.();
      child.stdin.write(active.letters.join(',') + '\n');
    }
    catch { stopSync(error('unavailable')); }
  }
  function query(roots, signal) {
    if (!Array.isArray(roots) || roots.length > 26 || roots.some(root => typeof root !== 'string' || !/^[A-Z]:\\$/i.test(root))) return Promise.reject(error('roots'));
    if (signal?.aborted) return Promise.reject(error('cancelled'));
    if (!roots.length) return Promise.resolve(new Map());
    if (queued.length + (active ? 1 : 0) >= 8) return Promise.reject(error('busy'));
    return new Promise((resolve, reject) => {
      const job = { roots: [...roots], letters: [...new Set(roots.map(root => root[0].toUpperCase()))], signal, resolve, reject };
      job.abort = () => stopSync(error('cancelled'));
      job.timer = setTimeout(() => stopSync(error('timeout')), 5000);
      signal?.addEventListener('abort', job.abort, { once: true });
      queued.push(job); pump();
    });
  }
  return Object.freeze({ query, stopSync, setHost: hooks => Object.assign(host, hooks) });
})();
