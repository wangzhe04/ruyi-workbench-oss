'use strict';
require('./lib/self-isolate-home');
// Real serve OS ownership, real HTTP driver and real restart holds; unfinished receipt is
// deliberately seeded synthetic host state. No ACC/native input, delivery or effects qualification.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const t = createRunner('DESKTOP EXECUTION ROOT');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-execution-root-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const app = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const env = { ...fixtureChildEnv(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
  APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TMPDIR: root,
  RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data };
for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, env);
const { ServerOwnership, DesktopExecutionLedger } = require('./lib/server-internals').loadServerInternals(['ServerOwnership', 'DesktopExecutionLedger']);
let server, provider, token, port, output = '';
const observations = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(read, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(); }
  throw new Error('Timed out ' + label + '\n' + output.slice(-4000));
}
async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(route + ': ' + res.status + ' ' + await res.text());
  return res.json();
}
async function start() {
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [app, 'serve', '--port', String(port)], { env: { ...process.env, ...env }, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
  await until(async () => {
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token) return false;
      port = runtime.port; token = runtime.token;
      return (await api('/health')).ok;
    } catch { return false; }
  }, 'serve ready');
}
async function stop() {
  if (!server) return;
  const child = server, identity = snapshotProcessTable()?.find(row => row.pid === child.pid);
  if (!identity) throw new Error('Cannot establish owned service identity');
  killOwnTree(child);
  await until(() => {
    const rows = snapshotProcessTable();
    return rows && !rows.some(row => row.pid === identity.pid && row.created === identity.created);
  }, 'owned service exit');
  server = null;
}
async function turn(sessionId, message) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token }, body: JSON.stringify({ sessionId, message, cwd: work }),
    signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('turn HTTP ' + res.status);
  const events = (await res.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await api('/api/sessions/' + sessionId)).execution === null, 'driver finally');
  observations.push({ sessionId, message, events }); return events;
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac root execution activation'); return; }
    provider = await startFakeProvider({ handler: () => textFrames('ROOT_HEALTHY_REPLY') });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 9, permissionMode: 'bypass', defaultWorkspace: work,
      providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url, apiKey: 'synthetic-key', model: 'fake-model' }], activeProvider: 'fake',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], bridgeExternalToolsToProvider: false }));
    await start();
    const held = (await api('/api/sessions', { title: 'unfinished fixture', cwd: work })).session.id;
    const healthy = (await api('/api/sessions', { title: 'healthy fixture', cwd: work })).session.id;
    const file = path.join(data, 'desktop-executions-v1/state.json');
    t.ok(JSON.parse(fs.readFileSync(file)).entries.length === 0, 'actual serve initializes private root ledger before readiness');
    const inode = fs.statSync(file).ino;
    const second = cp.spawn(process.execPath, [app, 'serve', '--port', String(await getFreePort())], { env: { ...process.env, ...env }, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let refused = ''; second.stdout.on('data', chunk => { refused += chunk; }); second.stderr.on('data', chunk => { refused += chunk; });
    await until(() => second.exitCode !== null, 'duplicate serve refusal');
    t.ok(second.exitCode !== 0 && /DATA_ROOT_IN_USE|数据目录|already in use/i.test(refused) && fs.statSync(file).ino === inode,
      'duplicate serve cannot open, recover or replace actual owner ledger');
    await stop();
    const owner = await ServerOwnership.acquire([data]);
    try {
      const ledger = DesktopExecutionLedger.create({ directory: path.dirname(file), isOwner: () => owner.isHeld(), isTurnCurrent: () => true });
      await ledger.open();
      await ledger.prepare({ sessionId: held, turnSeq: 1, admissionId: 'a'.repeat(64), callIdHash: 'b'.repeat(64), toolName: 'wait', args: { seconds: 0 },
        client: { clientId: '1'.repeat(32), accWorkerId: '2'.repeat(32), accPid: 12345, contextRequired: true } });
      t.ok(JSON.parse(fs.readFileSync(file)).entries[0].phase === 'prepared', 'fixture leaves a durable unfinished preparation without dispatching any tool');
    } finally { await owner.release(); }
    await start();
    const recovered = JSON.parse(fs.readFileSync(file)).entries[0];
    t.ok(recovered.phase === 'unknown' && recovered.holdReason === 'host_restarted', 'real serve recovery durably holds old preparation before readiness');
    const before = provider.requests.length;
    for (const message of ['ROOT_HELD_FIRST', 'ROOT_HELD_NEW_REQUEST_ID']) {
      const events = await turn(held, message);
      t.ok(events.some(event => event.type === 'error' && /上次桌面操作/.test(event.error)) && !events.some(event => event.type === 'assistant_delta'),
        'actual driver refuses held session before model: ' + message);
    }
    t.ok(provider.requests.length === before, 'new HTTP requests and call IDs cannot invoke provider through unresolved history');
    const disk = await api('/api/sessions/' + held);
    t.ok(disk.session.turnSeq === 0 && !JSON.stringify(disk.session.providerHistory || []).includes('ROOT_HELD_'),
      'held driver never advances turn or repairs/injects provider history');
    const events = await turn(healthy, 'ROOT_HEALTHY_REQUEST');
    t.ok(!events.some(event => event.type === 'error') && JSON.stringify(events).includes('ROOT_HEALTHY_REPLY') && provider.requests.length > before,
      'unrelated healthy session still completes normal actual provider turn');
    t.ok(JSON.parse(fs.readFileSync(file)).entries.length === 1 && JSON.parse(fs.readFileSync(file)).entries[0].phase === 'unknown',
      'healthy traffic and repeated held attempts retain original uncertainty evidence');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    try { await stop(); } catch (error) { t.fail('cleanup ' + error.message); }
    if (provider) await provider.close();
    if (process.env.RUYI_ROOT_EXECUTION_EVIDENCE) fs.writeFileSync(process.env.RUYI_ROOT_EXECUTION_EVIDENCE,
      JSON.stringify({ scope: 'actual root startup and HTTP driver hold; synthetic unfinished preparation; no native/delivery qualification', root, observations, output }, null, 2));
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
