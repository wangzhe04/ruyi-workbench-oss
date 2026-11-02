'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const wt = require('worker_threads');
const { getEventListeners } = require('events');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('SEARCH CANCELLATION');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-search-cancel-'));
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
process.env.RUYI_HOME = path.join(root, 'data');
process.env.PATH = root; process.env.RUYI_RG_PATH = path.join(root, 'rg');
const OriginalWorker = wt.Worker, originalSpawn = cp.spawn, workers = [], children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (check()) return; await sleep(10); } throw new Error('fixture condition timed out'); }
let mode = 'normal', abortOnMatch;
(async () => {
  try {
    const S = loadServerInternals(['toolCall', 'searchFileContent', 'regexScanFilesBounded', 'ProcessRuntime'], { withEval: true });
    S.__eval('globalThis.__searchOriginalProbe = hasRgAsync; hasRgAsync = async () => false;');
    cp.spawn = function(...args) { const child = originalSpawn.apply(this, args); children.push(child); return child; };
    wt.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args); this.cleanupMode = mode; this.exited = false; this.online = false; workers.push(this);
        this.once('online', () => { this.online = true; });
        this.once('exit', () => { this.exited = true; });
        this.on('message', m => { if (m?.type === 'match' && abortOnMatch) abortOnMatch.abort(); });
      }
      terminate() {
        if (this.cleanupMode === 'reject-after-exit') return super.terminate().then(() => { throw new Error('fixture late termination failure'); });
        if (this.cleanupMode === 'reject') return Promise.reject(new Error('fixture termination failure'));
        if (this.cleanupMode === 'hang') return new Promise(() => {});
        return super.terminate();
      }
    };
    const context = { session: { id: 'search-cancel', cwd: workspace }, config: { defaultWorkspace: workspace, permissionMode: 'default' } };
    const call = (tool, pattern, signal) => S.toolCall(tool, { root: workspace, ...(tool === 'file_search' ? { pattern } : { query: pattern }) }, { ...context, signal });
    const heavy = path.join(workspace, 'README.md'); fs.writeFileSync(heavy, 'a'.repeat(100000) + '!');
    const normal = path.join(workspace, 'normal.txt'); fs.writeFileSync(normal, 'needle\n');
    for (const tool of ['file_search', 'docs_search']) {
      const pre = new AbortController(); pre.abort(); const before = workers.length;
      const early = await call(tool, 'needle', pre.signal);
      t.ok(!early.ok && early.code === 'aborted' && workers.length === before, tool + ' pre-cancellation starts no worker');
      const controller = new AbortController();
      const pending = call(tool, '^(a+)+$', controller.signal);
      await until(() => workers.length > before); const worker = workers.at(-1);
      await until(() => worker.online); await sleep(50);
      t.ok(worker.threadId !== -1, tool + ' has a live worker before cancellation');
      controller.abort(); const result = await pending;
      t.ok(!result.ok && result.code === 'aborted' && worker.threadId === -1 && worker.exited && getEventListeners(controller.signal, 'abort').length === 0, tool + ' returns cancellation after worker exit without leaked listeners');
      t.ok(result.matches === undefined, tool + ' does not publish partial matches after cancellation');
    }
    fs.writeFileSync(heavy, 'needle\n'.repeat(10000));
    abortOnMatch = new AbortController();
    const partial = await call('file_search', 'needle', abortOnMatch.signal);
    t.ok(abortOnMatch.signal.aborted && partial.code === 'aborted' && partial.matches === undefined && workers.at(-1).exited, 'cancellation after a real match discards partial results and waits for exit');
    abortOnMatch = null;
    for (const failureMode of ['reject', 'hang']) {
      mode = failureMode; fs.writeFileSync(heavy, 'a'.repeat(100000) + '!');
      const controller = new AbortController(), before = workers.length;
      const pending = call('docs_search', '^(a+)+$', controller.signal);
      await until(() => workers.length > before); const worker = workers.at(-1);
      await until(() => worker.online); await sleep(50); controller.abort();
      const result = await pending;
      t.ok(!result.ok && result.code === 'worker_cleanup_incomplete' && result.cleanupIncomplete && workers.length === before + 1, failureMode + ' in termination confirmation cannot publish success or start literal retry');
      await OriginalWorker.prototype.terminate.call(worker);
    }
    mode = 'reject-after-exit';
    const exited = await call('docs_search', 'needle');
    t.ok(exited.ok && workers.at(-1).threadId === -1 && workers.at(-1).exited, 'termination rejection after confirmed thread exit does not fabricate cleanup uncertainty');
    mode = 'normal';
    fs.writeFileSync(heavy, 'a'.repeat(100000) + '!');
    const timed = await S.regexScanFilesBounded([{ path: heavy, relativePath: 'README.md' }], '^(a+)+$', 'g', { regexTimeoutMs: 100 });
    t.ok(timed.timedOut && !timed.cleanupIncomplete && workers.at(-1).exited, 'ordinary regex budget exhaustion retains timedOut semantics after worker exit');
    const healthy = await call('file_search', 'needle');
    t.ok(healthy.ok && healthy.matches.some(m => m.path === normal), 'uncancelled searches still return ordinary matches');
    const readdir = fs.promises.readdir; const walking = new AbortController(); const beforeWalk = workers.length;
    fs.promises.readdir = async function(...args) { const result = await readdir.apply(this, args); if (path.resolve(String(args[0])) === fs.realpathSync(workspace)) walking.abort(); return result; };
    try {
      const result = await call('file_search', 'needle', walking.signal);
      t.ok(result.code === 'aborted' && workers.length === beforeWalk, 'directory-walk cancellation stops before launching a scanner');
    } finally { fs.promises.readdir = readdir; }
    let rejectProbe;
    global.__searchPendingProbe = new Promise((_, reject) => { rejectProbe = reject; });
    global.__searchProbeWaiters = 0;
    S.__eval('hasRgAsync = () => { globalThis.__searchProbeWaiters++; return globalThis.__searchPendingProbe; };');
    const waiting = new AbortController();
    const waitResult = call('file_search', 'needle', waiting.signal);
    await until(() => global.__searchProbeWaiters > 0); waiting.abort();
    t.ok((await waitResult).code === 'aborted' && getEventListeners(waiting.signal, 'abort').length === 0, 'a search can stop waiting for a shared capability probe');
    const unhandled = []; const handler = error => unhandled.push(error); process.on('unhandledRejection', handler);
    try { rejectProbe(new Error('late shared probe failure')); await sleep(50); t.ok(!unhandled.length, 'late shared-probe rejection remains handled after waiter cancellation'); }
    finally { process.removeListener('unhandledRejection', handler); delete global.__searchPendingProbe; }
    S.__eval('hasRgAsync = globalThis.__searchOriginalProbe; delete globalThis.__searchOriginalProbe;');
    if (process.platform === 'darwin') {
      const ready = path.join(root, 'probe-ready'), finished = path.join(root, 'probe-finished'), calls = path.join(root, 'probe-calls');
      const match = JSON.stringify({ type: 'match', data: { path: { text: normal }, lines: { text: 'needle\n' }, line_number: 1 } }) + '\n';
      fs.writeFileSync(process.env.RUYI_RG_PATH, '#!' + process.execPath + '\n' + `const fs=require('fs');if(process.argv.includes('--version')){fs.appendFileSync(${JSON.stringify(calls)},'v');fs.writeFileSync(${JSON.stringify(ready)},'1');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(finished)},'1');process.exit(0)},500)}else{process.stdout.write(${JSON.stringify(match)})}`, { mode: 0o700 });
      S.__eval('_rgProbe=undefined; rgProbeCandidates = () => [{command:' + JSON.stringify(process.env.RUYI_RG_PATH) + ',source:"env"}]');
      const first = new AbortController();
      const a = call('file_search', 'needle', first.signal), b = call('file_search', 'needle');
      await until(() => fs.existsSync(ready)); first.abort();
      const cancelled = await a;
      t.ok(cancelled.code === 'aborted' && !fs.existsSync(finished), 'cancelled waiter returns while the real shared version probe is still running');
      const other = await b;
      t.ok(other.ok && other.engine === 'rg' && fs.readFileSync(calls, 'utf8') === 'v', 'another waiter completes using the same uncancelled probe');
      t.ok(children.some(child => { const handle = S.ProcessRuntime.handle(child); const owner = handle && S.ProcessRuntime.owner(handle); return owner?.kind === 'capability-probe' && owner.capabilityId === 'rg' && !owner.sessionId; }), 'shared discovery has service capability ownership rather than the cancelled session owner');
    } else console.log('SKIP real shared native-supervisor probe requires macOS');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    wt.Worker = OriginalWorker; cp.spawn = originalSpawn;
    for (const worker of workers) await OriginalWorker.prototype.terminate.call(worker).catch(() => {});
    for (const child of children) killOwnTree(child);
    delete global.__searchOriginalProbe; delete global.__searchPendingProbe; delete global.__searchProbeWaiters;
    fs.rmSync(root, {recursive:true,force:true}); t.done();
  }
})();
