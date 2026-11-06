'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const wt = require('worker_threads');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { startFakeProvider, toolCallFrames, textFrames } = require('./lib/fake-openai-provider');
const t = createRunner('PROVIDER TOOL STOP');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-provider-stop-'));
process.env.RUYI_HOME = path.join(root, 'data'); fs.mkdirSync(process.env.RUYI_HOME);
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace);
const OriginalWorker = wt.Worker, originalRename = fsp.rename;
const workers = [], sessions = [], turns = [];
let fake, S, currentTool, stopWorker;
const handlers = new Map(), signals = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(10); }
  throw new Error('fixture condition timed out');
}
(async () => {
  try {
    S = loadServerInternals(['runOpenAiTurn', 'createSession', 'defaultConfig', 'stopSession', 'activeChildren',
      'TOOL_HANDLERS', 'withFileToolWriteLock', 'fileToolWriteChains', 'fileToolWriteLockKey', 'journalReadIndex', 'journalDir']);
    for (const name of ['file_list', 'file_write']) {
      const handler = S.TOOL_HANDLERS[name].handler; handlers.set(name, handler);
      S.TOOL_HANDLERS[name].handler = (args, ctx) => {
        signals.set(name, ctx.signal);
        return handler(args, ctx);
      };
    }
    fake = await startFakeProvider({ handler: ({ body }) => body.messages.some(message => message.role === 'tool')
      ? textFrames('done') : toolCallFrames(currentTool.name, currentTool.args, 'fixture-call') });
    const provider = { id: 'fixture', type: 'openai-compat', apiStyle: 'chat', baseUrl: fake.url, apiKey: 'fixture', model: 'fake-model' };
    const config = { ...S.defaultConfig(), defaultWorkspace: workspace, permissionMode: 'bypass',
      providers: [provider], activeProvider: provider.id, toolLoadingMode: 'full',
      includeWorkbenchMcp: false, enableMcpDropIn: false, autoImportClaudeCodeMcp: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], stewardEnabledV1: false, schedulerEnabledV1: false };
    fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify(config));
    const start = async tool => {
      currentTool = tool;
      const session = await S.createSession({ title: 'provider stop fixture', cwd: workspace }); sessions.push(session);
      const events = [];
      const turn = S.runOpenAiTurn({ session, message: 'Run the requested local fixture tool.', attachments: [], cwd: workspace,
        provider, config, onEvent: event => { events.push(event); } });
      turns.push(turn); turn.catch(() => {});
      return { session, events, turn };
    };
    wt.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args); workers.push(this);
        this.once('online', () => { if (stopWorker) stopWorker(this); });
      }
    };
    fs.writeFileSync(path.join(workspace, 'a'.repeat(35) + '!'), 'fixture');
    let workerStopped = false, activeWorker;
    const search = await start({ name: 'file_list', args: { root: workspace, pattern: '^(a+)+$' } });
    stopWorker = worker => {
      activeWorker = worker;
      workerStopped = S.stopSession(search.session.id);
    };
    await until(() => workerStopped);
    await search.turn;
    await until(() => activeWorker.threadId === -1);
    t.ok(search.events.some(event => event.type === 'tool_use' && event.name === 'file_list'), 'real Provider turn dispatches the path-search tool');
    t.ok(workerStopped && signals.get('file_list')?.aborted && activeWorker.threadId === -1, 'main-turn Stop reaches the real path worker and confirms its exit');
    t.ok(search.events.some(event => event.type === 'tool_result' && event.content?.aborted), 'stopped Provider turn retains a paired stopped tool result');
    stopWorker = null;

    const target = path.join(workspace, 'queued.txt'); fs.writeFileSync(target, 'original');
    let release;
    const held = S.withFileToolWriteLock([target], null, () => new Promise(resolve => { release = resolve; }));
    await until(() => release);
    const key = process.platform === 'darwin' ? 'darwin-file-writes' : S.fileToolWriteLockKey(target);
    const previous = S.fileToolWriteChains.get(key);
    let queued;
    try {
      queued = await start({ name: 'file_write', args: { path: target, content: 'changed' } });
      await until(() => S.fileToolWriteChains.get(key) !== previous);
      t.ok(S.activeChildren.get(queued.session.id)?.interruptToolWait === null, 'file tools retain their existing steer and time-budget interruption boundary');
      t.ok(S.stopSession(queued.session.id), 'normal Stop accepts the queued write turn');
    } finally { release(); await held; }
    await queued.turn;
    await until(() => !S.fileToolWriteChains.has(key));
    t.ok(signals.get('file_write')?.aborted && fs.readFileSync(target, 'utf8') === 'original' && (await S.journalReadIndex(queued.session.id)).length === 0,
      'main-turn Stop cancels a queued write before target or checkpoint mutation');

    const committed = path.join(workspace, 'committed.txt'); fs.writeFileSync(committed, 'before');
    let committing, commitStopped = false;
    fsp.rename = async (from, to) => {
      await originalRename(from, to);
      if (to === committed) commitStopped = S.stopSession(committing.session.id);
    };
    committing = await start({ name: 'file_write', args: { path: committed, content: 'after' } });
    await committing.turn;
    await until(() => S.fileToolWriteChains.size === 0);
    t.ok(commitStopped && fs.readFileSync(committed, 'utf8') === 'after', 'late Stop preserves an already committed write');
    const index = await S.journalReadIndex(committing.session.id);
    const entry = index.find(row => row.path === committed && row.tool === 'file_write');
    const before = entry && require('zlib').gunzipSync(fs.readFileSync(path.join(S.journalDir(committing.session.id), `${entry.turnSeq}-${entry.entrySeq}.gz`))).toString();
    t.ok(before === 'before', 'late Stop retains the committed write original-byte checkpoint');
    t.ok(fake.errors.length === 0, 'local Provider completed without fixture protocol errors');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    stopWorker = null; wt.Worker = OriginalWorker; fsp.rename = originalRename;
    if (S) for (const [name, handler] of handlers) S.TOOL_HANDLERS[name].handler = handler;
    if (S) for (const session of sessions) S.stopSession(session.id);
    await Promise.allSettled(workers.map(worker => worker.terminate()));
    if (fake) await fake.close();
    await Promise.allSettled(turns);
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
