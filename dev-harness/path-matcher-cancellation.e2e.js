'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wt = require('worker_threads');
const { getEventListeners } = require('events');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('PATH MATCHER CANCELLATION');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-path-cancel-'));
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
process.env.RUYI_HOME = path.join(root, 'data');
const OriginalWorker = wt.Worker, workers = [];
let mode = 'normal', cancelOnHits;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (check()) return; await sleep(10); } throw new Error('fixture condition timed out'); }
(async () => {
  try {
    const S = loadServerInternals(['toolCall', 'walkFiles', 'createBoundedPathMatcher'], { withEval: true });
    wt.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args); this.cleanupMode = mode; this.online = false; this.exited = false; workers.push(this);
        this.once('online', () => { this.online = true; }); this.once('exit', () => { this.exited = true; });
        this.on('message', message => { if (message?.type === 'hits' && cancelOnHits) cancelOnHits.abort(); });
      }
      terminate() {
        if (this.cleanupMode === 'reject') return Promise.reject(new Error('fixture termination failure'));
        if (this.cleanupMode === 'hang') return new Promise(() => {});
        if (this.cleanupMode === 'reject-after-exit') return super.terminate().then(() => { throw new Error('fixture late failure'); });
        return super.terminate();
      }
    };
    fs.writeFileSync(path.join(workspace, 'alpha.txt'), 'fixture');
    const badName = 'a'.repeat(35) + '!'; fs.writeFileSync(path.join(workspace, badName), 'fixture');
    const context = { session: { id: 'path-cancel', cwd: workspace }, config: { defaultWorkspace: workspace, permissionMode: 'default' } };
    const call = (tool, args, signal) => S.toolCall(tool, { root: workspace, ...args }, { ...context, signal });
    const pre = new AbortController(); pre.abort(); const before = workers.length;
    t.ok((await call('file_list', {pattern:'^(a+)+$'}, pre.signal)).code === 'aborted' && workers.length === before, 'pre-cancelled file_list creates no path worker');
    const listed = await call('file_list', {pattern:'\\.(txt|md)$'});
    t.ok(listed.ok && listed.files.some(f => f.relativePath === 'alpha.txt') && workers.at(-1).exited, 'normal pattern listing confirms worker exit before returning');
    const controller = new AbortController(), activeBefore = workers.length;
    const pending = call('file_list', {pattern:'^(a+)+$'}, controller.signal);
    await until(() => workers.length > activeBefore); const active = workers.at(-1);
    await until(() => active.online); await sleep(50);
    t.ok(active.threadId !== -1, 'path matcher is active before cancellation');
    controller.abort(); const cancelled = await pending;
    t.ok(cancelled.code === 'aborted' && cancelled.files === undefined && active.threadId === -1 && getEventListeners(controller.signal,'abort').length === 0, 'file_list cancellation confirms exit, removes listeners and publishes no partial files');
    cancelOnHits = new AbortController();
    const partial = await call('file_list', {pattern:'\\.(txt|md)$'}, cancelOnHits.signal);
    t.ok(cancelOnHits.signal.aborted && partial.code === 'aborted' && partial.files === undefined && workers.at(-1).exited, 'cancellation when a batch has real hits suppresses partial file results');
    cancelOnHits = null;
    const timed = await call('file_list', {pattern:'^(a+)+$'});
    t.ok(timed.ok && timed.truncated && /time budget/.test(timed.patternNote) && workers.at(-1).exited, 'ordinary path regex timeout retains truncation semantics after confirmed exit');
    for (const failureMode of ['reject','hang']) {
      mode = failureMode; const abort = new AbortController(), start = workers.length;
      const pending = call('file_list', {pattern:'^(a+)+$'}, abort.signal);
      await until(() => workers.length > start); const worker = workers.at(-1);
      await until(() => worker.online); await sleep(50); abort.abort();
      const result = await pending;
      t.ok(!result.ok && result.code === 'worker_cleanup_incomplete' && result.cleanupIncomplete && result.files === undefined, failureMode + ' during worker termination reports incomplete cleanup');
      await OriginalWorker.prototype.terminate.call(worker);
    }
    mode = 'reject-after-exit';
    t.ok((await call('file_list', {pattern:'\\.(txt|md)$'})).ok && workers.at(-1).threadId === -1, 'confirmed exit remains usable despite a late termination rejection');
    mode = 'normal';
    const matcher = S.createBoundedPathMatcher('(txt|md)$', '', 1500);
    const first = await matcher.match(['alpha.txt']);
    t.ok(first.hits.length === 1, 'matcher returns normal batch hits before an idle failure');
    const idleWorker = workers.at(-1); idleWorker.emit('error', new Error('fixture between-batch error'));
    const failed = await matcher.match(['beta.md']);
    t.ok(failed.error.includes('between-batch') && !failed.cleanupIncomplete && idleWorker.threadId === -1, 'between-batch errors are handled and worker exit is confirmed');
    t.ok(matcher.close() === matcher.close(), 'close is idempotent and shares its confirmation promise');
    const exitMatcher = S.createBoundedPathMatcher('(txt|md)$', '', 1500);
    await exitMatcher.match(['alpha.txt']); const exitedWorker = workers.at(-1);
    await OriginalWorker.prototype.terminate.call(exitedWorker);
    const afterExit = await exitMatcher.match(['beta.md']);
    t.ok(!!afterExit.error && !afterExit.cleanupIncomplete && exitedWorker.threadId === -1, 'unexpected exit between batches cannot leave a later match pending');
    const direct = S.createBoundedPathMatcher('^(a+)+$', '', 1500);
    const directPending = direct.match([badName]); const directWorker = workers.at(-1);
    await until(() => directWorker.online); await sleep(50);
    const closed = direct.close(); const closedMatch = await directPending;
    t.ok(!!closedMatch.error && !(await closed).cleanupIncomplete && directWorker.threadId === -1, 'explicit close settles an in-flight match and confirms exit');
    const idleAbort = new AbortController(); const idle = S.createBoundedPathMatcher('(txt|md)$', '', 1500, idleAbort.signal);
    await idle.match(['alpha.txt']); idleAbort.abort(); const afterAbort = await idle.match(['beta.md']);
    t.ok(afterAbort.aborted && !afterAbort.cleanupIncomplete && getEventListeners(idleAbort.signal,'abort').length === 0, 'cancellation between batches closes the worker before another match');
    const startupBefore = workers.length;
    S.__eval('globalThis.__savedSearchIdentities=sensitiveFileIdentities; sensitiveFileIdentities=async()=>{throw new Error("fixture filesystem startup failure")};');
    let startupFailed = false;
    try { await S.walkFiles(workspace, { pattern:'(txt|md)$' }); } catch (error) { startupFailed = error.message.includes('startup failure'); }
    finally { S.__eval('sensitiveFileIdentities=globalThis.__savedSearchIdentities;delete globalThis.__savedSearchIdentities;'); }
    t.ok(startupFailed && workers.length === startupBefore, 'filesystem initialization failure occurs before allocating a path worker');
    for (const [tool,args] of [['glob',{pattern:'**/*.txt'}],['project_snapshot',{}]]) {
      const abort = new AbortController(); abort.abort();
      t.ok((await call(tool,args,abort.signal)).code === 'aborted', tool + ' honors cancellation at entry');
      const walking = new AbortController(), readdir = fs.promises.readdir;
      fs.promises.readdir = async function(...args) { const entries = await readdir.apply(this,args); if(path.resolve(String(args[0]))===fs.realpathSync(workspace))walking.abort();return entries; };
      try { t.ok((await call(tool,args,walking.signal)).code === 'aborted', tool + ' honors cancellation during directory traversal'); }
      finally { fs.promises.readdir = readdir; }
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    wt.Worker = OriginalWorker;
    for (const worker of workers) await OriginalWorker.prototype.terminate.call(worker).catch(() => {});
    delete global.__savedSearchIdentities;
    fs.rmSync(root,{recursive:true,force:true}); t.done();
  }
})();
