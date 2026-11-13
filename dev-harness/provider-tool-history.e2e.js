'use strict';
require('./lib/self-isolate-home');
// Real isolated service + disk + file_write, offline provider, no desktop input or MCP process.
// Root-only crash after a completed write and while request_user_input is pending; GET-only restart.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('PROVIDER TOOL HISTORY');
const workbench = path.resolve(__dirname, '../ruyi-workbench');
const targetServer = process.env.RUYI_TEST_SERVER_JS || path.join(workbench, 'app/server.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-history-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const evidence = process.env.RUYI_TOOL_HISTORY_EVIDENCE;
const turns = [], snapshots = [], cleanups = [], observed = new Map();
let server, fake, port, token, current, retained = false;
const alive = child => child && child.exitCode === null && child.signalCode === null;
function check(value, label) { t.ok(value, label); if (!value) throw new Error('Stopped after: ' + label); }
async function until(read, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out: ' + label);
}
function tree(child) {
  const table = snapshotProcessTable(), owned = table && ownDescendants(table, child.pid);
  if (!alive(child) || !owned?.root || owned.root.ppid !== process.pid) throw new Error('Owned process birth unavailable');
  const rows = [owned.root, ...owned.descendants];
  for (const row of rows) observed.set(row.pid + '/' + row.created, row);
  return rows;
}
async function gone(rows) {
  if (!rows.length) throw new Error('Empty exit proof');
  await until(() => { const table = snapshotProcessTable(); return table && rows.every(prior => !table.some(row => row.pid === prior.pid && row.created === prior.created)); }, 'observed identities gone');
}
async function request(method, route, body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-wcw-token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  return { status: r.status, json: await r.json() };
}
function disk(id, label) {
  const directory = path.join(data, 'sessions');
  const head = JSON.parse(fs.readFileSync(path.join(directory, id + '.json')));
  const rows = suffix => fs.readFileSync(path.join(directory, id + suffix), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const provider = rows('.provider.ndjson'), messages = rows('.messages.ndjson');
  const value = { label, id, head, provider, messages }; snapshots.push(value);
  if (evidence) for (const suffix of ['.json', '.provider.ndjson', '.messages.ndjson']) {
    const target = path.join(evidence, label, id + suffix); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(directory, id + suffix), target);
  }
  return value;
}
async function start(mode) {
  if (alive(server)) throw new Error('Previous service still live');
  const env = { ...fixtureChildEnv(), TMPDIR: root, HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'h'),
    APPDATA: path.join(root, 'a'), LOCALAPPDATA: path.join(root, 'l'), WCW_DATA_DIR: path.join(root, 'acc'), WCW_SESSION_ID: '' };
  for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
  const config = { configSchema: 14, engineMode: 'interactive', permissionMode: mode, permissionTimeoutMs: 15000,
    defaultWorkspace: work, providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: fake.url,
      apiKey: 'synthetic-history-key', model: 'fake-model' }], activeProvider: 'fake', allowCommandTools: true,
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
    schedulerEnabledV1: false, stewardEnabledV1: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [targetServer, 'serve', '--port', String(port)], {
    cwd: workbench, env: { ...process.env, ...env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data }, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError; server.on('error', error => { spawnError = error; }); server.stdout.resume(); server.stderr.resume();
  const birth = tree(server)[0];
  await until(async () => {
    if (spawnError) throw spawnError;
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token) return false;
      port = runtime.port; token = runtime.token; return (await request('GET', '/health')).status === 200;
    } catch { return false; }
  }, 'service health');
  return birth;
}
async function stop() {
  if (!alive(server)) return;
  const rows = tree(server), receipt = killOwnTree(server); cleanups.push(receipt);
  if (receipt.incomplete || receipt.skipped) throw new Error('Incomplete service cleanup');
  await gone(rows); await until(() => !alive(server), 'service exit');
}
async function begin(label, calls) {
  const created = await request('POST', '/api/sessions', { title: label, cwd: work });
  const id = created.json.session?.id; if (!id) throw new Error('Actual session missing');
  const turn = { label, id, calls, events: [] }; turns.push(turn); current = turn;
  turn.task = (async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wcw-token': token }, body: JSON.stringify({ sessionId: id, message: label, cwd: work }), signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error('Actual stream failed');
    let buffer = ''; const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true }); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) turn.events.push(JSON.parse(line));
      }
    }
  })().then(() => ({ closed: true }), error => ({ error: error.message }));
  return turn;
}
const write = (file, content, id = 'call_1') => ({ name: 'tool_invoke_edit', args: { name: 'file_write', arguments: { path: file, content } }, id });
const wait = { name: 'request_user_input', args: { questions: [{ question: 'Offline pending barrier', options: ['a', 'b'] }] }, id: 'call_2' };
(async () => {
  try {
    fake = await startFakeProvider({ handler(req) {
      if (!current || current.sent || !req.tools?.some(tool => tool.function?.name === 'tool_invoke_edit')) return textFrames('fixture complete');
      if (!JSON.stringify(req.messages.filter(row => row.role === 'user').at(-1)?.content).includes(current.label)) return textFrames('metadata');
      current.sent = true; return toolCallFrames(current.calls);
    } });
    await start('bypass');
    const file = path.join(work, 'owned.txt');
    const first = await begin('HISTORY_CRASH_AFTER_PREFIX', [write(file, 'completed prefix'), wait]);
    await until(() => first.events.some(row => row.type === 'ask_user'), 'real pending question');
    check(fs.readFileSync(file, 'utf8') === 'completed prefix', 'actual file effect completes before the pending second call');
    const before = disk(first.id, 'before-kill');
    const batch = before.provider.find(row => row.role === 'assistant' && row.tool_calls?.length === 2);
    check(batch?.tool_calls[0].id === 'call_1' && batch.tool_calls[1].id === 'call_2'
      && JSON.parse(batch.tool_calls[0].function.arguments).arguments.content === 'completed prefix', 'pending batch call IDs and requested model arguments are committed before whole-batch completion');
    const prefix = before.provider.find(row => row.role === 'tool' && row.tool_call_id === 'call_1');
    check(prefix && JSON.parse(prefix.content).ok === true && !before.provider.some(row => row.role === 'tool' && row.tool_call_id === 'call_2')
      && before.head.providerHistoryCount === before.provider.length, 'completed prefix result is committed while second call still has no result');
    const rows = tree(server), birth = rows[0];
    const currentBirth = snapshotProcessTable()?.find(row => row.pid === birth.pid && row.created === birth.created);
    if (!currentBirth || !alive(server)) throw new Error('Root birth changed before deliberate fault');
    process.kill(server.pid, 'SIGKILL'); await until(() => !alive(server), 'root-only fault'); await gone(rows);
    first.streamEnd = await first.task; check(server.signalCode === 'SIGKILL', 'only original owned service root receives deliberate SIGKILL');
    const after = disk(first.id, 'after-kill');
    check(JSON.stringify(after.provider) === JSON.stringify(before.provider), 'committed invocation and prefix survive actual process death');
    const count = fake.requests.length; current = null;
    await start('bypass');
    const restored = await request('GET', '/api/sessions/' + first.id);
    check(restored.json.resumable?.dangling === true && restored.json.resumable.kind === 'tool_calls' && restored.json.execution === null,
      'GET-only cold restart identifies missing tool results rather than a user-only unfinished turn');
    check(fake.requests.length === count && fs.readFileSync(file, 'utf8') === 'completed prefix', 'GET-only restart requests no model and does not replay completed effect');
    disk(first.id, 'after-restart');
    await stop(); await start('default');
    const deniedFile = path.join(work, 'denied.txt');
    const denied = await begin('HISTORY_DENIED_INTENT', [write(deniedFile, 'must not write')]);
    const permission = await until(() => denied.events.find(row => row.type === 'permission_request'), 'actual pending permission');
    const pending = disk(denied.id, 'pending-permission');
    check(pending.provider.some(row => row.role === 'assistant' && row.tool_calls?.length === 1) && !fs.existsSync(deniedFile),
      'default-mode pending approval already has durable tool intent with no effect');
    const decision = await request('POST', '/api/missions/' + denied.id + '/interventions/' + permission.requestId + '/decision', {
      expectedVersion: 0, idempotencyKey: 'deny-history', action: 'deny' });
    check(decision.status === 200 && decision.json.status === 'denied', 'actual default permission is denied');
    await denied.task;
    const done = disk(denied.id, 'denied-complete');
    const answer = done.provider.find(row => row.role === 'tool');
    check(answer && JSON.parse(answer.content).ok === false && !fs.existsSync(deniedFile), 'denied result persists without executing its file effect');
  } catch (error) { retained = true; t.fail(error.stack || String(error)); }
  finally {
    try { await stop(); } catch (error) { retained = true; t.fail(error.message); }
    if (fake) await fake.close();
    try { await gone([...observed.values()]); t.ok(true, 'all observed service birth identities exit'); }
    catch (error) { retained = true; t.fail(error.message); }
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ targetServer,
      serverSha256: crypto.createHash('sha256').update(fs.readFileSync(targetServer)).digest('hex'), turns: turns.map(({ task: _task, ...turn }) => turn), snapshots, cleanups,
      observed: [...observed.values()].map(row => ({ ...row, created: String(row.created) })), retainedRoot: retained ? root : null,
      scope: 'Offline real file effect/pending control call, actual root-only process death and GET-only restart. No desktop input or ACC dispatch/wait-entry/terminal receipt acceptance.' }, null, 2) + '\n'); }
    if (!retained) fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
