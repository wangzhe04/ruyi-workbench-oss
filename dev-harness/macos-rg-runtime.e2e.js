'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('MACOS RG RUNTIME');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rg-runtime-'));
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
process.env.RUYI_HOME = path.join(root, 'data');
process.env.RUYI_RG_PATH = path.join(root, 'rg'); process.env.PATH = root;
const originalSpawn = cp.spawn, children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (check()) return; await sleep(20); } throw new Error('fixture condition timed out'); }
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS supervisor'); return; }
    const S = loadServerInternals(['toolCall', 'searchFileContent', 'ProcessRuntime', 'ProcessRuntimeHooks']);
    cp.spawn = function(...args) { const child = originalSpawn.apply(this, args); children.push(child); return child; };
    const target = path.join(workspace, '中文😀.txt'); fs.writeFileSync(target, 'needle 中文😀\n');
    const context = { session: { id: 'rg-runtime', cwd: workspace }, config: { defaultWorkspace: workspace, permissionMode: 'default' } };
    const call = (signal, pattern = 'needle') => S.toolCall('file_search', { root: workspace, pattern }, { ...context, signal });
    const write = source => fs.writeFileSync(process.env.RUYI_RG_PATH, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    const beat = path.join(root, 'heartbeat');
    const leaf = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),15000);`;
    const withLeaf = source => `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);${source}}},10);`;
    const version = 'if(process.argv.includes("--version")){console.log("ripgrep fixture");process.exit(0)}';
    const match = JSON.stringify({ type: 'match', data: { path: { text: target }, lines: { text: 'needle 中文😀\n' }, line_number: 1 } }) + '\n';
    const stopped = async () => { const size = fs.statSync(beat).size; await sleep(150); return size > 0 && fs.statSync(beat).size === size; };
    write(`if(process.argv.includes('--version')){${withLeaf('console.log("ripgrep fixture");process.exit(0)')}}else{process.stdout.write(${JSON.stringify(match)})}`);
    const pre = new AbortController(); pre.abort(); const before = children.length;
    t.ok((await call(pre.signal)).code === 'aborted' && children.length === before, 'pre-aborted cold search starts neither version probe nor search');
    const first = await call();
    t.ok(first.ok && first.engine === 'rg' && first.matches[0].text === 'needle 中文😀', 'file_search uses supervised version discovery and preserves Unicode results');
    t.ok(await stopped(), 'version probe cleans its writing descendant before search');
    fs.unlinkSync(beat);
    write(version + withLeaf(`const b=Buffer.from(${JSON.stringify(match)});const n=b.indexOf(Buffer.from('中'))+1;process.stdout.write(b.subarray(0,n));setTimeout(()=>{process.stdout.write(b.subarray(n));process.exit(0)},20);`));
    const normal = await call();
    t.ok(normal.ok && normal.matches[0].path === target && await stopped(), 'main rg search decodes split UTF-8 and confirms descendant cleanup');
    t.ok(children.some(child => { const handle = S.ProcessRuntime.handle(child); return handle && S.ProcessRuntime.owner(handle).kind === 'file-search' && S.ProcessRuntime.owner(handle).sessionId === 'rg-runtime'; }), 'search execution registers its tool session owner');
    write(version + 'process.exit(1)');
    t.ok((await call()).matches.length === 0, 'rg exit one remains a valid empty result');
    write(version + 'process.exit(2)');
    const fallback = await call();
    t.ok(fallback.ok && fallback.engine === 'js' && fallback.matches.length === 1, 'confirmed rg failure safely falls back to JS');
    for (const mode of ['abort', 'timeout', 'overflow']) {
      fs.unlinkSync(beat);
      write(version + withLeaf(mode === 'overflow' ? 'process.stdout.write(Buffer.alloc(32_000_001,120));setTimeout(()=>process.exit(0),15000);' : 'setTimeout(()=>process.exit(0),15000);'));
      const controller = new AbortController();
      const result = mode === 'timeout' ? S.searchFileContent(workspace, 'needle', { rgTimeoutMs: 500 }) : call(controller.signal);
      await until(() => fs.existsSync(beat)); if (mode === 'abort') controller.abort();
      const value = await result;
      t.ok((mode === 'abort' ? !value.ok && value.code === 'aborted' : value.engine === 'js') && await stopped(), mode + ' stops descendants before returning or safe fallback');
    }
    const gbk = path.join(workspace, 'legacy.txt'); fs.writeFileSync(gbk, Buffer.from([0xd6,0xd0,0xce,0xc4,10]));
    fs.unlinkSync(beat);
    write(version + `if(process.argv.includes('-l')){${withLeaf(`console.log(${JSON.stringify(gbk)});process.exit(0)`)}}else{process.exit(1)}`);
    const repaired = await call(undefined, '中文');
    t.ok(repaired.ok && repaired.matches.some(m => m.path === gbk && m.text === '中文') && await stopped(), 'high-byte supplementary search is supervised and preserves legacy encoding repair');
    const helperPath = S.ProcessRuntimeHooks.helperPath;
    try {
      S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
      const missing = await call();
      t.ok(missing.ok && missing.engine === 'js', 'missing helper starts no external execution and safely uses JS search');
      const helper = path.join(root, 'incomplete-helper');
      const capabilities = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
      const frames = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 }, { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      const fake = extra => '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilities))});process.exit(0)}${extra}require('fs').writeSync(3,${JSON.stringify(frames.map(f=>JSON.stringify(f)+'\n').join(''))});process.stdout.write(${JSON.stringify(match)});process.exit(0);`;
      fs.writeFileSync(helper, fake(''), { mode: 0o700 }); S.ProcessRuntimeHooks.helperPath = () => helper;
      const incomplete = await call();
      t.ok(!incomplete.ok && incomplete.code === 'process_cleanup_incomplete' && incomplete.cleanupIncomplete, 'valid matches cannot conceal unconfirmed cleanup or trigger JS fallback');
      const completeFrames = frames.map(event => event.event === 'cleanup' ? { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 } : event);
      fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilities))});process.exit(0)}const events=process.argv.includes('-l')?${JSON.stringify(frames)}:${JSON.stringify(completeFrames)};require('fs').writeSync(3,events.map(e=>JSON.stringify(e)+'\\n').join(''));process.stdout.write(${JSON.stringify(match)});`, { mode: 0o700 });
      const repairFailure = await call(undefined, '中文');
      t.ok(!repairFailure.ok && repairFailure.code === 'process_cleanup_incomplete', 'supplementary search cleanup uncertainty cannot be swallowed as optional repair failure');
      frames[1] = { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 };
      fs.writeFileSync(helper, fake("const leaf=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),2000)'],{stdio:['ignore','inherit','inherit']});leaf.unref();"), { mode: 0o700 });
      const retained = await call();
      t.ok(!retained.ok && retained.code === 'process_output_incomplete', 'retained pipes report bounded failure without JS fallback');
      await sleep(2100);
    } finally { S.ProcessRuntimeHooks.helperPath = helperPath; }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { cp.spawn = originalSpawn; for (const child of children) killOwnTree(child); fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
