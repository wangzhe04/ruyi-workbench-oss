'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('MACOS DOCUMENT READER');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-document-reader-'));
process.env.RUYI_HOME = path.join(root, 'data');
const originalSpawn = cp.spawn;
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await sleep(20); }
  throw new Error('fixture condition timed out');
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS supervisor'); return; }
    const S = loadServerInternals(['toolCall', 'FileVisualIo', 'ProcessRuntime', 'ProcessRuntimeHooks'], { withEval: true });
    const runtime = S.ProcessRuntime;
    cp.spawn = function(...args) { const child = originalSpawn.apply(this, args); children.push(child); return child; };
    const python = path.join(root, '假 Python 😀');
    process.env.RUYI_BUNDLED_PYTHON = python;
    const file = path.join(root, '文档.pdf'); fs.writeFileSync(file, 'fixture');
    const context = { session: { id: 'document-reader', cwd: root }, config: { defaultWorkspace: root, permissionMode: 'default' } };
    const read = signal => S.toolCall('file_read', { path: file }, { ...context, signal });
    const write = source => fs.writeFileSync(python, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    const beat = path.join(root, 'heartbeat');
    const leaf = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),45000);`;
    const withLeaf = source => `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);${source}}},10);`;
    const stopped = async () => { const size = fs.statSync(beat).size; await sleep(150); return size > 0 && fs.statSync(beat).size === size; };
    write(withLeaf('const b=Buffer.from(JSON.stringify({ok:true,content:"文档😀"}));const n=b.indexOf(Buffer.from("文"))+1;process.stdout.write(b.subarray(0,n));setTimeout(()=>{process.stdout.write(b.subarray(n));process.exit(0)},20);'));
    const valid = await read();
    t.ok(valid.ok && valid.content === '文档😀' && valid.path === file && valid.size === 7, 'file_read preserves document metadata and split UTF-8');
    t.ok(!valid.cleanupIncomplete && await stopped(), 'successful document read confirms descendant cleanup');
    t.ok(children.some(child => { const handle = runtime.handle(child); return handle && runtime.owner(handle).kind === 'document-reader'; }), 'document execution registers runtime ownership');
    const savedPath = process.env.PATH;
    fs.writeFileSync(path.join(root, 'python'), '#!' + process.execPath + '\nconsole.log(JSON.stringify({ok:true,content:"fallback"}))', { mode: 0o700 });
    process.env.RUYI_BUNDLED_PYTHON = path.join(root, 'missing-python'); process.env.PATH = root;
    try { t.ok((await read()).content === 'fallback', 'missing Python candidate falls back only after confirmed cleanup'); }
    finally { process.env.RUYI_BUNDLED_PYTHON = python; process.env.PATH = savedPath; }
    write('process.stdout.write("invalid")');
    t.ok((await read()).code === 'document_read_failed', 'invalid reader JSON remains a failure');
    write('process.exit(7)');
    t.ok((await read()).code === 'document_read_failed', 'nonzero reader exit remains a failure');
    const pre = new AbortController(); pre.abort(); const before = children.length;
    t.ok((await read(pre.signal)).code === 'aborted' && children.length === before, 'pre-aborted read starts no process');
    for (const mode of ['abort', 'stdout', 'stderr', 'timeout']) {
      fs.unlinkSync(beat);
      write(withLeaf(mode === 'stdout' || mode === 'stderr' ? `process.${mode}.write(Buffer.alloc(16*1024*1024+1,120));setTimeout(()=>process.exit(0),45000);` : 'setTimeout(()=>process.exit(0),45000);'));
      const controller = new AbortController();
      const result = read(controller.signal);
      await until(() => fs.existsSync(beat));
      if (mode === 'abort') controller.abort();
      const value = await result;
      t.ok(!value.ok && value.code === (mode === 'abort' ? 'aborted' : 'document_read_failed') && !value.cleanupIncomplete && await stopped(), mode + ' stops the descendant and reports failure');
    }
    write('process.stdout.write(JSON.stringify({ok:true,content:"must-fail"}))');
    const helperPath = S.ProcessRuntimeHooks.helperPath;
    S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
    const marker = path.join(root, 'blocked-marker'); write(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
    try { t.ok(!(await read()).ok && !fs.existsSync(marker), 'missing supervisor refuses document execution'); }
    finally { S.ProcessRuntimeHooks.helperPath = helperPath; }
    const helper = path.join(root, 'incomplete-helper');
    const report = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
    const frames = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 },
      { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
    fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(report))});process.exit(0)}require('fs').writeSync(3,${JSON.stringify(frames.map(frame => JSON.stringify(frame) + '\n').join(''))});process.stdout.write(JSON.stringify({ok:true,content:'must-fail'}));`, { mode: 0o700 });
    S.ProcessRuntimeHooks.helperPath = () => helper;
    try {
      t.ok((await read()).code === 'process_cleanup_incomplete', 'valid JSON cannot hide unconfirmed cleanup');
      frames[1] = { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 };
      fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(report))});process.exit(0)}
const leaf=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),2000)'],{stdio:['ignore','inherit','inherit']});leaf.unref();
require('fs').writeSync(3,${JSON.stringify(frames.map(frame => JSON.stringify(frame) + '\n').join(''))});process.stdout.write(JSON.stringify({ok:true}));process.exit(0);`, { mode: 0o700 });
      const retained = await read();
      const last = children.filter(child => runtime.handle(child)).at(-1);
      t.ok(!retained.ok && last.stdout.destroyed && last.stderr.destroyed, 'retained output pipes fail within a bounded drain and release streams');
      await sleep(2100);
    }
    finally { S.ProcessRuntimeHooks.helperPath = helperPath; }

  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    cp.spawn = originalSpawn;
    for (const child of children) killOwnTree(child);
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
