'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('MACOS EXECUTABLE PROBE');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-exec-probe-'));
process.env.RUYI_HOME = path.join(root, 'data');
const originalSpawn = cp.spawn, children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS supervisor'); return; }
    const S = loadServerInternals(['spawnProbeAsync', 'probeAgentCliLauncherVerdictAsync', 'detectClaudePathUncachedAsync', 'agentCliProbeVerdict', 'ProcessRuntime', 'ProcessRuntimeHooks'], { withEval: true });
    cp.spawn = function(...args) { const child = originalSpawn.apply(this, args); children.push(child); return child; };
    const cli = path.join(root, '假 CLI 😀');
    const write = source => fs.writeFileSync(cli, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    const beat = path.join(root, 'heartbeat');
    const leaf = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),15000);`;
    const withLeaf = source => `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);${source}}},10);`;
    const stopped = async () => { const size = fs.statSync(beat).size; await sleep(150); return size > 0 && fs.statSync(beat).size === size; };
    write(withLeaf('process.exit(0)'));
    const verdict = await S.ProcessRuntime.withOwner({ sessionId: 'probe-owner' }, () => S.probeAgentCliLauncherVerdictAsync(cli));
    t.ok(verdict === 'ok' && await stopped(), 'normal CLI launcher verdict confirms descendant cleanup');
    t.ok(children.some(child => { const handle = S.ProcessRuntime.handle(child); return handle && S.ProcessRuntime.owner(handle).kind === 'executable-probe' && S.ProcessRuntime.owner(handle).sessionId === 'probe-owner'; }), 'probe inherits caller ownership');
    write('process.exit(7)');
    const nonzero = await S.spawnProbeAsync(cli, ['--version']);
    t.ok(nonzero.status === 7 && !nonzero.error && S.agentCliProbeVerdict(nonzero) === 'missing', 'nonzero exit keeps its original verdict and status');
    const missing = await S.spawnProbeAsync(path.join(root, 'missing-cli'), ['--version']);
    t.ok(missing.error.code === 'ENOENT' && missing.status === null && !missing.cleanupIncomplete, 'missing target preserves ENOENT with confirmed cleanup');
    write('process.kill(process.pid,"SIGTERM")');
    const signalled = await S.spawnProbeAsync(cli, ['--version']);
    t.ok(signalled.status === null && !signalled.error && S.agentCliProbeVerdict(signalled) === 'slow', 'target signal preserves null status and historical slow verdict');
    fs.unlinkSync(beat); write(withLeaf('setTimeout(()=>process.exit(0),15000);'));
    const slow = await S.spawnProbeAsync(cli, ['--version'], {}, 400);
    t.ok(slow.status === null && !slow.error && S.agentCliProbeVerdict(slow) === 'slow' && !slow.cleanupIncomplete && await stopped(), 'bounded timeout retains slow verdict only after cleanup confirmation');
    write('process.stdout.write(Buffer.alloc(1024*1024,120));process.stderr.write(Buffer.alloc(1024*1024,120));');
    t.ok((await S.probeAgentCliLauncherVerdictAsync(cli)) === 'ok', 'version output remains ignored without introducing an output budget failure');
    write('if(process.cwd()!==process.env.EXPECTED_CWD||process.env.FIXTURE_VALUE!=="中文😀")process.exit(9)');
    const env = await S.spawnProbeAsync(cli, [], { cwd: root, env: { ...process.env, EXPECTED_CWD: fs.realpathSync(root), FIXTURE_VALUE: '中文😀' } });
    t.ok(env.status === 0, 'probe preserves explicit cwd and environment');
    write('setTimeout(()=>process.exit(0),100)');
    t.ok((await S.spawnProbeAsync(cli, [], { timeout: 0 }, 1)).status === 0, 'zero timeout override disables the deadline');
    const invalid = await S.spawnProbeAsync(cli, [], {}, -1);
    t.ok(invalid.error.code === 'ERR_OUT_OF_RANGE' && invalid.status === null, 'invalid deadline is rejected before spawning');
    const helperPath = S.ProcessRuntimeHooks.helperPath;
    try {
      S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
      const absent = await S.spawnProbeAsync(cli, []);
      t.ok(absent.error.code === 'process_helper_missing' && S.agentCliProbeVerdict(absent) === 'missing', 'missing helper cannot advertise an executable as available or slow');
      const helper = path.join(root, 'incomplete-helper');
      const capabilities = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
      const frames = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 }, { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilities))});process.exit(0)}require('fs').writeSync(3,${JSON.stringify(frames.map(f=>JSON.stringify(f)+'\n').join(''))});`, { mode: 0o700 });
      S.ProcessRuntimeHooks.helperPath = () => helper;
      const incomplete = await S.spawnProbeAsync(cli, []);
      t.ok(incomplete.cleanupIncomplete && incomplete.error.code === 'process_cleanup_incomplete' && S.agentCliProbeVerdict(incomplete) === 'missing', 'unconfirmed cleanup cannot become an ok or slow verdict');
      let blocked = false;
      try { await S.probeAgentCliLauncherVerdictAsync(cli); } catch (error) { blocked = error.cleanupIncomplete; }
      t.ok(blocked, 'agent CLI discovery propagates cleanup uncertainty to stop candidate scanning');
      S.__eval('claudeProbeCandidates = () => [{command:' + JSON.stringify(cli) + ',mustExist:false},{command:' + JSON.stringify(cli) + ',mustExist:false}]');
      const before = children.filter(c => S.ProcessRuntime.handle(c)).length;
      blocked = false;
      try { await S.detectClaudePathUncachedAsync(); } catch (error) { blocked = error.cleanupIncomplete; }
      t.ok(blocked && children.filter(c => S.ProcessRuntime.handle(c)).length === before + 1, 'Claude discovery stops before its next candidate after incomplete cleanup');
    } finally { S.ProcessRuntimeHooks.helperPath = helperPath; }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { cp.spawn = originalSpawn; for (const child of children) killOwnTree(child); fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
