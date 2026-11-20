'use strict';
// 151 阶段 3D(150 号文 W11/W12):工作数据加密的规模实测量具。不是回归件(不进 run-all),手动跑:
//   node dev-harness/work-data-scale-bench.js --files 10 [--bytes 4096] [--ops enable,export,disable] [--json out.json]
// 用生产组合(WorkDataVerifierEntry.createVerifier().coldOperationHost → WorkDataColdOperations)在一个
// 自建的合成数据根上跑真实 DPAPI/NTFS 冷操作,报告每步耗时、阶段耗时、原生助手(PowerShell)与校验子进程
// 的启动次数与累计时长、本进程 RSS 峰值与子进程峰值工作集。
// 隔离:HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP 全部换到新建的临时根下;只在夹具里新建的 DPAPI 密钥;
// 只收自己 spawn 的进程(监视器在 finally 里按自己记录的 PID 结束)。不打印任何密钥、口令或文件内容。
const path = require('node:path'), fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto');
const { releaseEnvironment } = require('./lib/release-checks');
// Bind the server under test before the environment is isolated (RUYI_TEST_SERVER_JS measures a baseline build).
const { loadServerInternals } = require('./lib/server-internals'), testServer = process.env.RUYI_TEST_SERVER_JS;
if (process.env.RUYI_BENCH_TRACE) Error.stackTraceLimit = 60;

function arg(name, fallback) { const at = process.argv.indexOf('--' + name); return at > 0 ? process.argv[at + 1] : fallback; }
const FILES = Number(arg('files', '10')), TOTAL = Number(arg('bytes', String(FILES * 400))), OPS = arg('ops', 'enable,export,disable').split(',');
const OUT = arg('json', null), KEEP = process.argv.includes('--keep'), PREWARM = process.argv.includes('--prewarm');
if (!Number.isSafeInteger(FILES) || FILES < 1 || !Number.isSafeInteger(TOTAL) || TOTAL < 0) throw new Error('bad --files/--bytes');

const spawns = [], trace = [];
let currentPhase = 'init', benchBase = null;
const benchRelative = value => typeof value === 'string' && benchBase && value.toLowerCase().startsWith(benchBase.toLowerCase()) ? '<base>' + value.slice(benchBase.length) : typeof value === 'string' ? '<other>' + path.basename(value) : null;
const realSpawn = cp.spawn;
cp.spawn = function patched(command, args, options) {
  const child = realSpawn.apply(this, arguments);
  const env = options?.env || {};
  const kind = /powershell/i.test(String(command)) ? (Object.keys(env).some(k => /^RUYI_MANIFEST_PUBLISHER_SOURCE$/i.test(k)) ? 'ps-publisher'
    : Object.keys(env).some(k => /^RUYI_SKILL_CAPSULE_/i.test(k)) ? 'ps-broker' : 'ps-other') : /node|\.exe$/i.test(path.basename(String(command))) ? 'node' : 'other';
  // timings: one entry per native command, from the stdin write to its result line (a line with an ok field);
  // heartbeat/progress lines are not results. Gives the longest single native command (basis for the 13u ceiling).
  const row = { kind, start: performance.now(), end: null, pid: child.pid, cmds: [], timings: [], waiting: [] };
  spawns.push(row);
  if (kind !== 'node' && child.stdin) {
    const write = child.stdin.write, end = child.stdin.end;
    const note = chunk => { try { for (const line of String(chunk).split('\n')) { if (!line) continue; const v = JSON.parse(line); row.cmds.push(v.cmd || (v.flushDirectories ? 'flush' : 'publish')); row.waiting.push({ cmd: v.cmd || (v.flushDirectories ? 'flush' : 'publish'), at: performance.now() });
      if (process.env.RUYI_BENCH_TRACE && v.cmd && /census-first|capture-preserved$|capture$/.test(v.cmd)) trace.push({ phase: currentPhase, cmd: v.cmd, root: benchRelative(v.root), stack: new Error().stack.split('\n').slice(2, 40).map(s => s.trim()).filter(s => /server\.js/.test(s)).map(s => s.replace(/^at /, '').replace(/\(.*server\.js:(\d+):\d+\)/, '@$1')).slice(0, 12).join(' < ') }); } } catch { /* not JSON */ } };
    child.stdin.write = function (chunk) { note(chunk); return write.apply(this, arguments); };
    child.stdin.end = function (chunk) { if (chunk && typeof chunk !== 'function') note(chunk); return end.apply(this, arguments); };
  }
  if (kind !== 'node' && child.stdout) { let buffer = ''; child.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) { let v; try { v = JSON.parse(line); } catch { continue; } if (!v || typeof v.ok !== 'boolean' || !row.waiting.length) continue; const w = row.waiting.shift(); row.timings.push({ cmd: w.cmd, ms: Math.round(performance.now() - w.at) }); } }); }
  if (child.pid) monitorTrack(child.pid);
  child.once('close', () => { row.end = performance.now(); });
  return child;
};

// Peak working set of own children: one resident PowerShell monitor owned by this process.
let monitor = null, monitorBuffer = '';
const childPeaks = new Map();
function monitorStart() {
  const script = "$ErrorActionPreference='SilentlyContinue';$ids=New-Object System.Collections.Generic.HashSet[int];" +
    "$reader=[Console]::In;$task=$reader.ReadLineAsync();while($true){if($task.IsCompleted){$l=$task.Result;if($l -eq $null){break};[void]$ids.Add([int]$l);$task=$reader.ReadLineAsync()};" +
    "foreach($id in @($ids)){$p=Get-Process -Id $id;if($p){[Console]::Out.WriteLine(''+$id+' '+$p.PeakWorkingSet64)}else{[void]$ids.Remove($id)}};[Console]::Out.Flush();Start-Sleep -Milliseconds 300}";
  monitor = realSpawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  monitor.stdout.on('data', chunk => {
    monitorBuffer += chunk; const lines = monitorBuffer.split('\n'); monitorBuffer = lines.pop();
    for (const line of lines) { const [pid, peak] = line.trim().split(' ').map(Number); if (pid && peak) childPeaks.set(pid, Math.max(childPeaks.get(pid) || 0, peak)); }
  });
}
function monitorTrack(pid) { try { monitor?.stdin.write(pid + '\n'); } catch { /* best effort */ } }

let rssPeak = 0;
const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 100); rssTimer.unref();

async function makeRoot(base) {
  await fsp.mkdir(path.join(base, 'sessions'), { recursive: true });
  await fsp.writeFile(path.join(base, 'config.json'), '{"workDataEncryptionV1":false}');
  const per = Math.max(1, Math.floor(TOTAL / FILES));
  const chunk = crypto.randomBytes(Math.min(per, 1 << 20)).toString('base64').slice(0, Math.min(per, 1 << 20));
  for (let i = 0; i < FILES; i++) {
    // 前 10 个是会话(合法 JSON,领域校验会解析);其余放进 generated/ 下每 1000 个一个子目录。
    const session = i < 10, dir = session ? path.join(base, 'sessions') : path.join(base, 'generated', 'b' + Math.floor(i / 1000));
    if (!session && (i === 10 || i % 1000 === 0)) await fsp.mkdir(dir, { recursive: true });
    const head = JSON.stringify({ id: 'sess_' + i, private: 'SCALE_BENCH_PRIVATE_' + i, pad: '' });
    let pad = ''; while (pad.length < per - head.length) pad += chunk.slice(0, Math.min(chunk.length, per - head.length - pad.length));
    await fsp.writeFile(path.join(dir, (session ? 'sess_' : 'g_') + i + '.json'), JSON.stringify({ id: 'sess_' + i, private: 'SCALE_BENCH_PRIVATE_' + i, pad }));
  }
}

(async () => {
  if (process.platform !== 'win32') { console.log('SKIP Windows-only bench'); return; }
  const parent = path.resolve(process.env.RUYI_BENCH_PARENT || os.tmpdir());
  const root = await fsp.mkdtemp(path.join(parent, 'rb3d-')), base = path.join(root, 'data'), home = path.join(root, 'h'), backups = path.join(root, 'bk');
  await fsp.mkdir(backups); await fsp.mkdir(base); benchBase = base;
  const env = releaseEnvironment(home, base);
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
  monitorStart();
  const report = { files: FILES, bytes: TOTAL, ops: [], node: process.version };
  let owner, api;
  try {
    const t0 = performance.now(); await makeRoot(base); report.makeRootMs = Math.round(performance.now() - t0);
    // --prewarm:新建文件第一次被打开时实时防护会逐个扫描(实测 1 万个新文件的首次普查 147 s,再次 28 s)。
    // 真实数据根里的文件早已存在;预热只把这次一次性开销挪出计时(只读一遍,不改任何内容)。
    if (PREWARM) { const t1 = performance.now(); const walk = async dir => { for (const entry of await fsp.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else await fsp.readFile(file); } }; await walk(base); report.prewarmMs = Math.round(performance.now() - t1); }
    report.prewarm = PREWARM;
    const entry = testServer ? path.resolve(testServer) : path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
    api = loadServerInternals(['WorkDataVerifierEntry', 'WorkDataColdOperations', 'WorkDataManifest', 'ServerOwnership', 'flushWorkbenchLogs']);
    const native = api.WorkDataVerifierEntry.createVerifier({ packaged: false, entry });
    owner = await api.ServerOwnership.acquire([base]);
    const password = 'synthetic scale bench password only';
    for (const op of OPS) {
      const phases = []; let last = performance.now();
      const host = native.coldOperationHost(value => { const now = performance.now(); phases.push({ phase: value.phase, atMs: Math.round(now - start) }); last = now; currentPhase = op + ':' + value.phase; console.error('PHASE ' + op + ' ' + value.phase + ' +' + Math.round(now - start) + 'ms rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB'); });
      const operation = api.WorkDataColdOperations.create(host);
      const active = await api.WorkDataManifest.create({ base }).readActive();
      const before = spawns.length; rssPeak = process.memoryUsage().rss;
      const start = performance.now(); let state = null, error = null;
      try {
        const result = await operation.execute({ id: crypto.randomBytes(24).toString('hex'), base, operation: op, password, ownership: owner,
          assertExclusive: value => value === owner, expectedAuthority: { generation: active.generation, id: active.id, mode: active.mode, sha256: active.proof.sha256 },
          paths: { backupDirectory: backups, targetDirectory: null, uploadFile: null, uploadSha256: null } });
        state = result.state;
      } catch (cause) {
        const codes = []; const walk = (v, d) => { if (!v || d > 10 || typeof v !== 'object') return; if (v.code) codes.push(v.code + (v.limit ? '{' + v.limit.kind + '<=' + v.limit.maximum + '}' : '') + (v.timeout ? '{' + v.timeout.kind + ':' + v.timeout.command + '}' : '')); else if (v.message && d) codes.push('msg:' + String(v.message).slice(0, 120)); walk(v.cause, d + 1); if (Array.isArray(v.errors)) for (const e of v.errors.slice(0, 4)) walk(e, d + 1); };
        walk(cause, 0); error = codes; if (process.env.RUYI_BENCH_STACK) console.error(cause.stack);
      }
      const ms = Math.round(performance.now() - start);
      const mine = spawns.slice(before);
      const byKind = {};
      for (const row of mine) { const k = byKind[row.kind] ||= { count: 0, totalMs: 0, maxMs: 0, peakWorkingSet: 0, cmds: {} }; const d = (row.end ?? performance.now()) - row.start; k.count++; k.totalMs += Math.round(d); k.maxMs = Math.max(k.maxMs, Math.round(d)); k.peakWorkingSet = Math.max(k.peakWorkingSet, childPeaks.get(row.pid) || 0); for (const c of row.cmds) k.cmds[c] = (k.cmds[c] || 0) + 1; for (const t of row.timings) if (!k.maxCommand || t.ms > k.maxCommand.ms) k.maxCommand = t; }
      const row = { op, ms, state, error, phases, rssPeakMB: Math.round(rssPeak / 1048576), children: byKind };
      report.ops.push(row);
      console.log(JSON.stringify(row));
      if (error) break;
    }
  } finally {
    clearInterval(rssTimer);
    try { if (api) await api.flushWorkbenchLogs({ allowFailure: true }); } catch { /* best effort */ }
    try { if (owner) await owner.release(); } catch { /* retained */ }
    try { monitor?.stdin.end(); } catch { /* ignore */ }
    if (monitor && monitor.exitCode === null) { await new Promise(resolve => { const t = setTimeout(() => { try { monitor.kill(); } catch { /* own pid */ } resolve(); }, 3000); monitor.once('close', () => { clearTimeout(t); resolve(); }); }); }
    if (process.env.RUYI_BENCH_TRACE) for (const row of trace) console.log('TRACE ' + JSON.stringify(row));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
    if (!KEEP) { try { await fsp.rm(root, { recursive: true, force: true }); } catch (cause) { console.error('fixture retained ' + root + ' ' + cause.code); } } else console.error('fixture kept ' + root);
  }
})().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
