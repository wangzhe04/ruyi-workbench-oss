'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('MACOS PYTHON PROBE');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-python-probe-'));
process.env.RUYI_HOME = path.join(root, 'data');
const originalSpawn = cp.spawn, children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS supervisor'); return; }
    const S = loadServerInternals(['probeDesktopPythonAsync', 'pickPythonAsync', 'desktopPythonCache', 'ProcessRuntime', 'ProcessRuntimeHooks']);
    cp.spawn = function(...args) { const child = originalSpawn.apply(this, args); children.push(child); return child; };
    const python = path.join(root, '假 Python 😀');
    const candidate = { command: python, args: ['--fixture-prefix'], source: 'fixture' };
    const write = source => fs.writeFileSync(python, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    const probe = () => S.probeDesktopPythonAsync(candidate, root, { FIXTURE_VALUE: '中文😀', EXPECTED_CWD: fs.realpathSync(root) });
    const beat = path.join(root, 'heartbeat');
    const leaf = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),15000);`;
    const withLeaf = source => `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);${source}}},10);`;
    const stopped = async () => { const size = fs.statSync(beat).size; await sleep(150); return size > 0 && fs.statSync(beat).size === size; };
    write('if(process.cwd()!==process.env.EXPECTED_CWD||process.env.FIXTURE_VALUE!=="中文😀"||!process.argv.includes("--fixture-prefix")||!process.argv.includes("-c"))process.exit(9);' + withLeaf('process.stdout.write("__RUYI_");setTimeout(()=>{process.stdout.write("ACC_FULL__");process.exit(0)},20);'));
    const full = await S.ProcessRuntime.withOwner({ sessionId: 'python-owner' }, probe);
    t.ok(full === 'full' && await stopped(), 'Full import probe preserves argv/env/cwd and confirms descendant cleanup');
    t.ok(children.some(child => { const h = S.ProcessRuntime.handle(child); return h && S.ProcessRuntime.owner(h).kind === 'desktop-python-probe' && S.ProcessRuntime.owner(h).sessionId === 'python-owner'; }), 'Python import probe inherits caller identity');
    write('process.stderr.write("__RUYI_ACC_FULL__");');
    t.ok(await probe() === 'core', 'zero exit without stdout marker remains Core');
    write('process.stdout.write("__RUYI_ACC_FULL__");process.exit(7)');
    t.ok(await probe() === '', 'nonzero exit cannot advertise Full even with marker output');
    t.ok(await S.probeDesktopPythonAsync({ command: path.join(root, 'missing'), args: [] }, root, {}) === '', 'missing Python remains unavailable after confirmed startup failure');
    for (const mode of ['stdout', 'stderr', 'timeout']) {
      fs.unlinkSync(beat);
      write(withLeaf(mode === 'timeout' ? 'setTimeout(()=>process.exit(0),15000);' : `process.${mode}.write(Buffer.alloc(65537,120));setTimeout(()=>process.exit(0),15000);`));
      t.ok(await probe() === '' && await stopped(), mode + ' budget failure stops descendants before returning unavailable');
    }
    const second = path.join(root, 'second-python');
    fs.writeFileSync(second, '#!' + process.execPath + '\nconsole.log("__RUYI_ACC_FULL__")', { mode: 0o700 });
    write('process.exit(0)');
    const selected = await S.pickPythonAsync(root, {}, { noCache: true, candidates: [candidate, { command: second, args: [], source: 'second' }] });
    t.ok(selected.command === second && selected.capability === 'full', 'picker preserves Full preference over an earlier Core candidate');
    const helperPath = S.ProcessRuntimeHooks.helperPath;
    try {
      S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
      t.ok(await probe() === '', 'missing supervisor refuses import execution');
      const helper = path.join(root, 'incomplete-helper');
      const capabilities = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
      const frames = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 }, { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      const fake = extra => '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilities))});process.exit(0)}${extra}require('fs').writeSync(3,${JSON.stringify(frames.map(f=>JSON.stringify(f)+'\n').join(''))});process.stdout.write('__RUYI_ACC_FULL__');process.exit(0);`;
      fs.writeFileSync(helper, fake(''), { mode: 0o700 }); S.ProcessRuntimeHooks.helperPath = () => helper;
      let error;
      try { await probe(); } catch (caught) { error = caught; }
      t.ok(error?.code === 'process_cleanup_incomplete' && error.cleanupIncomplete, 'Full marker cannot conceal incomplete cleanup');
      const before = children.filter(c => S.ProcessRuntime.handle(c)).length;
      error = null;
      try { await S.pickPythonAsync(root, {}, { candidates: [candidate, { command: second, args: [], source: 'second' }] }); } catch (caught) { error = caught; }
      t.ok(error?.cleanupIncomplete && children.filter(c => S.ProcessRuntime.handle(c)).length === before + 1 && !S.desktopPythonCache.has(root + '\n'), 'picker stops before next candidate and cache write when cleanup is unconfirmed');
      const completeFrames = frames.map(event => event.event === 'cleanup' ? { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 } : event);
      fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilities))});process.exit(0)}const core=process.argv[3]===${JSON.stringify(python)};const events=core?${JSON.stringify(completeFrames)}:${JSON.stringify(frames)};require('fs').writeSync(3,events.map(e=>JSON.stringify(e)+'\\n').join(''));if(!core)process.stdout.write('__RUYI_ACC_FULL__');`, { mode: 0o700 });
      error = null;
      try { await S.pickPythonAsync(root, {}, { candidates: [candidate, { command: second, args: [], source: 'second' }] }); } catch (caught) { error = caught; }
      t.ok(error?.cleanupIncomplete && !S.desktopPythonCache.has(root + '\n'), 'later incomplete Full probe cannot fall back to an earlier Core or write cache');
      S.ProcessRuntimeHooks.helperPath = helperPath;
      const recovered = await S.pickPythonAsync(root, {}, { candidates: [candidate, { command: second, args: [], source: 'second' }] });
      t.ok(recovered.command === second && recovered.capability === 'full' && S.desktopPythonCache.has(root + '\n'), 'restored supervisor allows a fresh selection and caches only the confirmed result');
      S.ProcessRuntimeHooks.helperPath = () => helper;
      frames[1] = { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 };
      fs.writeFileSync(helper, fake("const leaf=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),2000)'],{stdio:['ignore','inherit','inherit']});leaf.unref();"), { mode: 0o700 });
      error = null;
      try { await probe(); } catch (caught) { error = caught; }
      t.ok(error?.code === 'process_output_incomplete', 'retained output pipes stop discovery with a bounded explicit failure');
      await sleep(2100);
    } finally { S.ProcessRuntimeHooks.helperPath = helperPath; }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { cp.spawn = originalSpawn; for (const child of children) killOwnTree(child); fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
