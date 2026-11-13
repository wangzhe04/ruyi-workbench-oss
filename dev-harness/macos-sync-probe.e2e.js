'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS SYNC PROBE');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sync-probe-'));
process.env.RUYI_HOME = path.join(root, 'data');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS supervisor'); return; }
    const S = loadServerInternals(['spawnProbeSync', 'probeAgentCliLauncher', 'existsExecutable', 'probeDesktopPython', 'pickPython', 'desktopPythonCache', 'detectClaudePathUncached', 'probeRgInfoSync', 'ProcessRuntime', 'ProcessRuntimeHooks'], { withEval: true });
    const cli = path.join(root, '假 CLI 😀');
    const write = source => fs.writeFileSync(cli, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    const beat = path.join(root, 'heartbeat');
    const leaf = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),10000);`;
    const withLeaf = source => `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true});const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);${source}}},10);`;
    const stopped = async () => { const size = fs.statSync(beat).size; await sleep(150); return size > 0 && fs.statSync(beat).size === size; };
    write(withLeaf('process.exit(0)'));
    t.ok(S.probeAgentCliLauncher(cli) && await stopped(), 'sync launcher probe waits for detached descendant cleanup');
    write('console.log("中文😀");process.stderr.write("diagnostic");process.exit(7)');
    const nonzero = S.spawnProbeSync(cli, [], { encoding: 'utf8', timeout: 1000 });
    t.ok(nonzero.status === 7 && !nonzero.error && nonzero.stdout.trim() === '中文😀' && nonzero.stderr === 'diagnostic', 'sync wrapper preserves UTF-8 streams and numeric exit status');
    t.ok(S.existsExecutable(cli), 'legacy non-batch executable presence accepts a completed nonzero version exit');
    write('process.kill(process.pid,"SIGTERM")');
    const signal = S.spawnProbeSync(cli, [], { timeout: 1000 });
    t.ok(signal.status === null && signal.signal === 'SIGTERM' && !signal.error, 'target signal remains distinct from timeout');
    const missing = S.spawnProbeSync(path.join(root, 'missing'), [], { timeout: 1000 });
    t.ok(missing.error.code === 'ENOENT' && missing.status === null && !missing.cleanupIncomplete, 'missing executable preserves errno after cleanup confirmation');
    fs.unlinkSync(beat); write(withLeaf('setTimeout(()=>process.exit(0),10000);'));
    const timed = S.spawnProbeSync(cli, [], { stdio: 'ignore', timeout: 300 });
    t.ok(timed.error.code === 'ETIMEDOUT' && !timed.cleanupIncomplete && await stopped(), 'native timeout returns ETIMEDOUT only after complete synchronous cleanup');
    write('process.stdout.write(Buffer.alloc(513,120))');
    const overflow = S.spawnProbeSync(cli, [], { timeout: 1000, maxBuffer: 512 });
    t.ok(overflow.error.code === 'ENOBUFS' && !overflow.cleanupIncomplete, 'per-stream output budget is enforced after a fully captured small overflow');
    write('process.stdout.write(Buffer.alloc(200000,120));process.exit(0)');
    t.ok(S.spawnProbeSync(cli, [], { stdio: 'ignore', timeout: 1000 }).status === 0, 'ignored version output remains unbounded by capture budget');
    write('if(process.cwd()!==process.env.EXPECTED_CWD||process.env.FIXTURE_VALUE!=="中文😀")process.exit(9);console.log("__RUYI_ACC_FULL__")');
    const candidate = { command: cli, args: [], source: 'fixture' };
    const env = { EXPECTED_CWD: fs.realpathSync(root), FIXTURE_VALUE: '中文😀' };
    t.ok(S.probeDesktopPython(candidate, root, env) === 'full', 'sync Python import probe preserves cwd/env and Full classification');
    write('process.exit(0)');
    t.ok(S.probeDesktopPython(candidate, root, {}) === 'core', 'sync Python retains Core fallback classification');
    const marker = path.join(root, 'later-candidate');
    const second = path.join(root, 'second'); fs.writeFileSync(second, '#!' + process.execPath + '\nrequire("fs").writeFileSync(' + JSON.stringify(marker) + ',"bad");console.log("__RUYI_ACC_FULL__")', { mode: 0o700 });
    const helperPath = S.ProcessRuntimeHooks.helperPath;
    try {
      S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
      t.ok(S.spawnProbeSync(cli, [], { timeout: 1000 }).error.code === 'process_helper_missing', 'missing helper rejects before target execution');
      S.__eval('_rgProbe=undefined; rgProbeCandidates = () => [{command:' + JSON.stringify(cli) + ',source:"env"}]');
      t.ok(S.probeRgInfoSync() === null && S.__eval('_rgProbe') === undefined, 'missing supervisor does not permanently cache rg as absent');
      S.ProcessRuntimeHooks.helperPath = helperPath;
      t.ok(S.probeRgInfoSync()?.path === cli, 'restored supervisor permits cold rg discovery without restarting');

      const helper = path.join(root, 'fixture-helper');
      const capabilities = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, deadline: true, escapeCoverage: 'observed-only' };
      const frames = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 }, { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      const fake = (messages, extra = '', suffix = '') => fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilities))});process.exit(0)}${extra}require('fs').writeSync(3,${JSON.stringify(messages.map(f=>JSON.stringify(f)+'\n').join('')+suffix)});console.log('__RUYI_ACC_FULL__');process.exit(0);`, { mode: 0o700 });
      fake(frames); S.ProcessRuntimeHooks.helperPath = () => helper;
      t.ok(S.spawnProbeSync(cli, [], { timeout: 1000 }).status === 0, 'valid complete protocol is accepted before malformed variants');
      capabilities.deadline = false; fake(frames);
      t.ok(S.ProcessRuntime.helperCapability().ready && S.spawnProbeSync(cli, [], { timeout: 1000 }).error.code === 'process_helper_incompatible', 'older v2 helper remains async-ready but cannot run the new synchronous deadline entry');
      capabilities.deadline = true; fake(frames);

      const variants = [frames.slice(0,-1), [...frames, frames[0]], [frames[0], {event:'deadline',value:1,detail:0}, {event:'deadline',value:1,detail:0}, ...frames.slice(1)],
        [frames[0], {...frames[1],observed:2}, ...frames.slice(2)], [frames[0],frames[1],{...frames[2],value:7},frames[3]]];
      for (const messages of variants) {
        fake(messages); let error;
        try { S.spawnProbeSync(cli, [], { timeout: 1000 }); } catch (caught) { error = caught; }
        t.ok(error?.cleanupIncomplete && error.code === 'process_cleanup_incomplete', 'malformed, incomplete or contradictory protocol rejects success');
      }
      fake([frames[0], frames[1], {...frames[2], value: -1, detail: 0}, frames[3]]);
      t.ok((await S.ProcessRuntime.probe(cli, [], {}, 1000)).cleanupIncomplete, 'shared async parser also rejects an exit with neither status nor signal');
      fake([frames[0], {event:'deadline',value:1,detail:0}, ...frames.slice(1)]);
      t.ok((await S.ProcessRuntime.probe(cli, [], {}, 1000)).cleanupIncomplete, 'async mode rejects a deadline frame it did not enable');
      fake(frames, '', '\n'); let error;
      try { S.spawnProbeSync(cli, [], { timeout: 1000 }); } catch (caught) { error = caught; }
      t.ok(error?.cleanupIncomplete, 'trailing blank control frame is rejected consistently with async parser');
      fake(frames.slice(0,-1));
      S.__eval('claudeProbeCandidates = () => [{command:' + JSON.stringify(cli) + ',mustExist:false},{command:' + JSON.stringify(second) + ',mustExist:false}]');
      error = null; try { S.detectClaudePathUncached(); } catch (caught) { error = caught; }
      t.ok(error?.cleanupIncomplete && !fs.existsSync(marker), 'sync Claude candidate scan stops on cleanup uncertainty');
      error = null; try { S.pickPython(root, {}, { candidates: [candidate, {command:second,args:[],source:'second'}] }); } catch (caught) { error = caught; }
      t.ok(error?.cleanupIncomplete && !S.desktopPythonCache.has(root+'\n') && !fs.existsSync(marker), 'sync Python scan stops without caching or trying a later candidate');
      S.__eval('_rgProbe=undefined; rgProbeCandidates = () => [{command:' + JSON.stringify(cli) + ',source:"env"},{command:' + JSON.stringify(second) + ',source:"system"}]');
      error = null; try { S.probeRgInfoSync(); } catch (caught) { error = caught; }
      t.ok(error?.cleanupIncomplete && !fs.existsSync(marker), 'sync rg discovery stops on cleanup uncertainty');
      fake(frames, "const leaf=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),6500)'],{stdio:['ignore','inherit','inherit']});leaf.unref();");
      const began = Date.now(); error = null;
      try { S.spawnProbeSync(cli, [], { timeout: 50 }); } catch (caught) { error = caught; }
      t.ok(error?.cleanupIncomplete && Date.now()-began < 5500, 'outer sync safety deadline refuses retained output pipes within a bounded wait');
      await sleep(2700);
    } finally { S.ProcessRuntimeHooks.helperPath = helperPath; }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { fs.rmSync(root, {recursive:true,force:true}); t.done(); }
})();
