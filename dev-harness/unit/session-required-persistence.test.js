'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-required-save-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const { loadServerInternals } = require('../lib/server-internals');
const s = loadServerInternals(['createSession', 'loadSession', 'saveSession', 'deleteSession', 'recordSessionExecutionOwner', 'sessionWriteChains', 'runSessionTurn', 'stopSession', 'activeChildren', 'TOOL_RESULT_DISPLAY_CAP'], { withEval: true });
after(() => fs.rmSync(home, { recursive: true, force: true }));
const refused = reason => error => error.code === 'SESSION_SAVE_NOT_COMMITTED' && error.reason === reason;

test('required persistence commits the exact pending tool identity and model arguments', async () => {
  const session = await s.createSession({ title: 'strict intent', cwd: home });
  session.providerHistory.push({ role: 'assistant', content: '', tool_calls: [{ id: 'intent1', type: 'function',
    function: { name: 'tool_invoke_exec', arguments: JSON.stringify({ name: 'ai_computer_control__macro_run', arguments: { steps: [] } }) } }] });
  await s.saveSession(session, { requirePersisted: true });
  assert.deepEqual((await s.loadSession(session.id)).providerHistory, session.providerHistory);
});

test('required persistence rejects a deleted session while legacy saves remain discarded', async () => {
  const session = await s.createSession({ title: 'deleted intent', cwd: home });
  await s.deleteSession(session.id);
  await assert.rejects(s.saveSession(session, { requirePersisted: true }), refused('deleted'));
  await s.saveSession(session);
  assert.equal(await s.loadSession(session.id), null);
});

test('required persistence rejects an older rewind generation without changing the current body', async () => {
  const session = await s.createSession({ title: 'rewound intent', cwd: home });
  const old = structuredClone(session);
  session.providerHistory = [{ role: 'user', content: 'new rewind' }];
  await s.saveSession(session, { rewindBump: true });
  old.providerHistory = [{ role: 'assistant', content: 'obsolete' }];
  await assert.rejects(s.saveSession(old, { requirePersisted: true }), refused('stale'));
  assert.deepEqual((await s.loadSession(session.id)).providerHistory, session.providerHistory);
});

test('required persistence rejects a newer committed turn before accepting old tool intent', async () => {
  const session = await s.createSession({ title: 'replaced turn', cwd: home });
  const old = structuredClone(session); old.turnSeq = 1;
  session.turnSeq = 2; await s.saveSession(session);
  await assert.rejects(s.saveSession(old, { dropIfTurnSuperseded: true, requirePersisted: true }), refused('turn_superseded'));
  assert.equal((await s.loadSession(session.id)).turnSeq, 2);
});

test('required persistence checks owner replacement inside the queued write', async () => {
  const session = await s.createSession({ title: 'queued intent owner', cwd: home });
  const first = { driverRunId: 'first' }, next = { driverRunId: 'next' };
  s.recordSessionExecutionOwner(session.id, first);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  s.sessionWriteChains.set(session.id, blocked);
  const map = s.sessionWriteChains, set = map.set;
  let reached; const enqueued = new Promise(resolve => { reached = resolve; });
  map.set = function(key, value) { const result = set.call(this, key, value); if (key === session.id && value !== blocked) reached(); return result; };
  const save = s.saveSession(session, { executionOwner: first, requirePersisted: true });
  let timer;
  try { await Promise.race([enqueued, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Save did not enqueue')), 3000); })]); }
  finally { map.set = set; clearTimeout(timer); }
  s.recordSessionExecutionOwner(session.id, next); release();
  await assert.rejects(save, refused('execution_superseded'));
});

async function configuredProvider(handler) {
  const { startFakeProvider } = require('../lib/fake-openai-provider');
  const fake = await startFakeProvider({ handler });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: 14, engineMode: 'interactive',
    permissionMode: 'bypass', defaultWorkspace: home, providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat',
      baseUrl: fake.url, apiKey: 'synthetic-key', model: 'fake-model' }], activeProvider: 'fake', allowCommandTools: true,
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false,
    stewardEnabledV1: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] }));
  return fake;
}

test('failed intent head commit prevents the real file effect instead of dispatching without history', async () => {
  const { textFrames, toolCallFrames } = require('../lib/fake-openai-provider');
  const file = path.join(home, 'must-not-write.txt'); let sent = false;
  const fake = await configuredProvider(req => {
    if (sent || !req.tools?.some(tool => tool.function?.name === 'tool_invoke_edit')) return textFrames('done');
    sent = true; return toolCallFrames('tool_invoke_edit', { name: 'file_write', arguments: { path: file, content: 'forbidden effect' } }, 'fail_commit');
  });
  const session = await s.createSession({ title: 'fail before effect', cwd: home });
  const restore = s.__eval(`(() => { const original = atomicWriteJson; let fired = false;
    atomicWriteJson = async function(file, value, opts) {
      const head = file.endsWith(${JSON.stringify(session.id + '.json')}) ? (typeof value === 'string' ? JSON.parse(value) : value) : {};
      if (!fired && head.providerHistoryCount >= 2) {
        fired = true; throw Object.assign(new Error('synthetic intent head write failure'), { code: 'EIO' });
      }
      return original(file, value, opts);
    }; return () => { atomicWriteJson = original; return fired; }; })()`);
  let fired;
  try {
    const events = [];
    await s.runSessionTurn({ sessionId: session.id, message: 'commit before effect', cwd: home, source: 'http', onEvent(event) { events.push(event); } });
    assert.equal(events.find(event => event.type === 'result')?.ok, false);
    assert.equal(fs.existsSync(file), false);
    const got = await s.loadSession(session.id);
    const record = got.providerHistory.find(row => row.role === 'tool');
    assert.equal(JSON.parse(record.content).outcome, 'not_dispatched');
  } finally { fired = restore(); await fake.close(); }
  assert.equal(fired, true, 'the real storage commit was actually refused');
});

test('Stop after first parallel read retains the already returned second result', async () => {
  const { textFrames, toolCallFrames } = require('../lib/fake-openai-provider');
  const files = ['parallel-first.txt', 'parallel-second.txt'].map(name => path.join(home, name));
  fs.writeFileSync(files[0], 'FIRST_KNOWN_RESULT'); fs.writeFileSync(files[1], 'SECOND_KNOWN_RESULT');
  let sent = false;
  const fake = await configuredProvider(req => {
    if (sent || !req.tools?.some(tool => tool.function?.name === 'file_read')) return textFrames('done');
    sent = true; return toolCallFrames(files.map((file, index) => ({ name: 'file_read', args: { path: file }, id: 'parallel_' + index })));
  });
  const session = await s.createSession({ title: 'parallel returned prefix', cwd: home }); let stopped = false;
  try {
    await s.runSessionTurn({ sessionId: session.id, message: 'read files', cwd: home, source: 'http', onEvent(event) {
      if (!stopped && event.type === 'tool_result' && event.id === 'parallel_0') { stopped = true; s.stopSession(session.id); }
    } });
    assert.equal(stopped, true);
    const history = (await s.loadSession(session.id)).providerHistory;
    const second = JSON.parse(history.find(row => row.role === 'tool' && row.tool_call_id === 'parallel_1').content);
    assert.ok(JSON.stringify(second).includes('SECOND_KNOWN_RESULT'));
    assert.notEqual(second.outcome, 'not_dispatched');
    assert.ok(!String(second.error || '').includes('未执行'));
  } finally { await fake.close(); }
});

test('a failed prefix-result commit stops the second actual file effect', async () => {
  const { textFrames, toolCallFrames } = require('../lib/fake-openai-provider');
  const first = path.join(home, 'prefix-real.txt'), second = path.join(home, 'suffix-forbidden.txt'); let sent = false;
  const fake = await configuredProvider(req => {
    if (sent || !req.tools?.some(tool => tool.function?.name === 'tool_invoke_edit')) return textFrames('done');
    sent = true; return toolCallFrames([first, second].map((file, index) => ({ name: 'tool_invoke_edit',
      args: { name: 'file_write', arguments: { path: file, content: 'actual effect' } }, id: 'write_' + index })));
  });
  const session = await s.createSession({ title: 'prefix commit barrier', cwd: home });
  const restore = s.__eval(`(() => { const original = atomicWriteJson; let fired = false;
    atomicWriteJson = async function(file, value, opts) {
      const head = file.endsWith(${JSON.stringify(session.id + '.json')}) ? (typeof value === 'string' ? JSON.parse(value) : value) : {};
      if (!fired && head.providerHistoryCount === 3) { fired = true; throw new Error('synthetic prefix result commit failure'); }
      return original(file, value, opts);
    }; return () => { atomicWriteJson = original; return fired; }; })()`);
  let fired;
  try {
    await s.runSessionTurn({ sessionId: session.id, message: 'write prefix and suffix', cwd: home, source: 'http', onEvent() {} });
    assert.equal(fs.readFileSync(first, 'utf8'), 'actual effect');
    assert.equal(fs.existsSync(second), false);
    const history = (await s.loadSession(session.id)).providerHistory;
    assert.equal(JSON.parse(history.find(row => row.role === 'tool' && row.tool_call_id === 'write_0').content).ok, true);
    assert.equal(JSON.parse(history.find(row => row.role === 'tool' && row.tool_call_id === 'write_1').content).outcome, 'not_dispatched');
  } finally { fired = restore(); await fake.close(); }
  assert.equal(fired, true);
});

test('steered parallel image result keeps bounded display and a real saved attachment', async () => {
  const { textFrames, toolCallFrames } = require('../lib/fake-openai-provider');
  const first = path.join(home, 'image-prefix.txt'), image = path.join(home, 'parallel-image.png');
  fs.writeFileSync(first, 'image-prefix');
  fs.copyFileSync(path.join(__dirname, '../visual-baselines/workbench-shell-v2-light.png'), image);
  const base64 = fs.readFileSync(image).toString('base64'); assert.ok(base64.length > s.TOOL_RESULT_DISPLAY_CAP);
  let sent = false;
  const fake = await configuredProvider(req => {
    if (sent || !req.tools?.some(tool => tool.function?.name === 'file_read')) return textFrames('done');
    sent = true; return toolCallFrames([{ name: 'file_read', args: { path: first }, id: 'image_0' },
      { name: 'file_read', args: { path: image, as: 'image' }, id: 'image_1' }]);
  });
  const session = await s.createSession({ title: 'parallel bounded image', cwd: home }); const events = []; let steered = false;
  try {
    await s.runSessionTurn({ sessionId: session.id, message: 'read image and text', cwd: home, source: 'http', onEvent(event) {
      events.push(event);
      if (!steered && event.type === 'tool_result' && event.id === 'image_0') {
        steered = true; s.activeChildren.get(session.id).steerQueue.push('continue without another image read');
      }
    } });
    assert.equal(steered, true);
    const shown = events.find(event => event.type === 'tool_result' && event.id === 'image_1');
    assert.equal(shown.isError, false);
    assert.ok(JSON.stringify(shown.content).length <= s.TOOL_RESULT_DISPLAY_CAP);
    assert.ok(!JSON.stringify(shown.content).includes(base64));
    const attachments = shown.content.imageAttachments;
    assert.ok(attachments?.length > 0);
    assert.deepEqual(fs.readFileSync(path.join(home, 'uploads', attachments[0].id, attachments[0].name)), fs.readFileSync(image));
    const stored = await s.loadSession(session.id);
    assert.ok(!JSON.stringify(stored.messages).includes(base64));
    assert.ok(!JSON.stringify(stored.providerHistory).includes(base64));
  } finally { await fake.close(); }
});
