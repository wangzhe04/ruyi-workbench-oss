'use strict';
require('./lib/self-isolate-home');
// Real service/HTTP/stdio bridge/disk, synthetic MCP results and offline provider. No GUI.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('COMPOUND EFFECT AUDIT');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-effect-e2e-'));
const workbench = path.resolve(__dirname, '../ruyi-workbench'), data = path.join(root, 'data'), work = path.join(root, 'work');
const evidence = process.env.RUYI_EFFECT_EVIDENCE;
const targetServer = process.env.RUYI_TEST_SERVER_JS || path.join(workbench, 'app/server.js');
const callLog = path.join(root, 'calls.ndjson'), cases = [], cleanups = [];
let server, provider, current, port, token = '', retained = false;
const check = (value, label) => { t.ok(value, label); if (!value) throw new Error('Stopped at ' + label); };
async function until(read, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out: ' + label);
}
async function api(method, route, body) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const json = await r.json(); if (!r.ok) throw new Error('API failed ' + r.status + ': ' + JSON.stringify(json)); return json;
}
async function turn(mode, tool = 'macro_run', direct = false, decision = 'allow') {
  const spec = { mode, tool, direct, decision, label: 'EFFECT_' + cases.length + '_' + mode, events: [] };
  spec.id = (await api('POST', '/api/sessions', { title: spec.label, cwd: work })).session.id;
  current = spec; cases.push(spec);
  const r = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    body: JSON.stringify({ sessionId: spec.id, message: spec.label, cwd: work }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Stream failed ' + r.status);
  let buffer = ''; const decoder = new TextDecoder(), tasks = [];
  for await (const chunk of r.body) {
    buffer += decoder.decode(chunk, { stream: true }); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
      const row = JSON.parse(line); spec.events.push(row);
      if (row.type === 'permission_request') tasks.push(api('POST', '/api/missions/' + spec.id + '/interventions/' + row.requestId + '/decision', {
        expectedVersion: 0, idempotencyKey: spec.label, action: decision,
      }).then(reply => { if (reply.status !== (decision === 'deny' ? 'denied' : 'allowed')) throw new Error('Decision failed'); }));
    }
  }
  await Promise.all(tasks);
  await until(async () => { const view = await api('GET', '/api/sessions/' + spec.id); return view.execution === null && view.resumable?.live !== true; }, 'turn idle');
  spec.summary = spec.events.find(row => row.type === 'turn_summary');
  spec.persisted = fs.readFileSync(path.join(data, 'sessions', spec.id + '.messages.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  spec.snapshot = (await api('GET', '/api/missions/' + spec.id)).snapshot;
  return spec;
}
(async () => {
  try {
    const env = { ...fixtureChildEnv(), HOME: path.join(root, 'h'), USERPROFILE: path.join(root, 'h'), APPDATA: path.join(root, 'a'), LOCALAPPDATA: path.join(root, 'l'), TMPDIR: root };
    for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
    provider = await startFakeProvider({ handler(req) {
      if (!current || current.sent || !JSON.stringify(req.messages.filter(row => row.role === 'user').at(-1)?.content).includes(current.label)) return textFrames('fixture complete');
      current.sent = true;
      const name = 'effect_fixture__' + current.tool, args = { fixture_case: current.mode };
      return toolCallFrames(current.direct ? name : 'tool_invoke_exec', current.direct ? args : { name, arguments: args }, 'call_' + current.label);
    } });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, engineMode: 'interactive', permissionMode: 'default', permissionTimeoutMs: 15000,
      toolLoadingMode: 'full', defaultWorkspace: work, providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url, apiKey: 'synthetic', model: 'fake-model' }], activeProvider: 'fake',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false,
      desktopMcp: { enabled: false, autodetect: false }, bridgeExternalToolsToProvider: true,
      externalMcpServers: [{ id: 'effect_fixture', enabled: true, command: process.execPath, args: [path.join(__dirname, 'fixtures/effect-audit-mcp.js')], env: { ...env, RUYI_EFFECT_CALL_LOG: callLog } }] }));
    if (!snapshotProcessTable()?.some(row => row.pid === process.pid)) throw new Error('Build the owned-process helper before running this fixture');
    port = await getFreePort();
    server = cp.spawn(process.execPath, [targetServer, 'serve', '--port', String(port)], {
      cwd: workbench, env: { ...process.env, ...env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.resume(); server.stderr.resume();
    await until(async () => {
      try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'))); if (runtime.pid !== server.pid || !runtime.token) return false;
        port = runtime.port; token = runtime.token; return (await api('GET', '/health')).ok; } catch { return false; }
    }, 'owned service');
    for (const direct of [false, true]) {
      const spec = await turn('large', 'macro_run', direct);
      check(spec.summary?.irreversible?.length === 2 && spec.summary.irreversible.every(row => row.effectStatus === 'reported'), (direct ? 'direct' : 'proxy') + ' raw compound effects survive display shrinking');
      check(spec.summary.irreversible.every((row, i) => row.step === i && row.callId === 'call_' + spec.label && row.parentTool === 'effect_fixture__macro_run'), 'compound call and step attribution is exact');
      const saved = spec.persisted.find(row => row.turnSummary)?.turnSummary;
      check(JSON.stringify(saved?.irreversible) === JSON.stringify(spec.summary.irreversible), 'disk turn summary preserves projected ledger');
      check(JSON.stringify(spec.snapshot?.irreversible?.items?.map(({ turnSeq, ...row }) => row)) === JSON.stringify(saved.irreversible), 'mission API keeps effect status and attribution');
      const records = spec.persisted.flatMap(row => row.toolCalls || []);
      const record = records.find(row => row.name === (direct ? 'effect_fixture__macro_run' : 'tool_invoke_exec'));
      check(record?.irreversibleProjection?.items?.length === 2 && JSON.stringify(record.irreversibleProjection).length < 1500
        && !JSON.stringify(record.irreversibleProjection).includes('synthetic-private-padding'), 'bounded projection excludes original large private payload');
    }
    const deniedBefore = fs.readFileSync(callLog, 'utf8');
    const denied = await turn('denied', 'macro_run', false, 'deny');
    check(denied.summary?.irreversible?.length === 0 && fs.readFileSync(callLog, 'utf8') === deniedBefore, 'actual default-mode denial produces no MCP invocation or reported effects');
    const wait = await turn('wait'); check(wait.summary?.irreversible?.length === 0, 'returned read/wait-only macro has no irreversible effects');
    const partial = await turn('partial');
    check(partial.summary?.irreversible?.length === 2 && partial.summary.irreversible[0].effectStatus === 'reported' && partial.summary.irreversible[1].effectStatus === 'unknown'
      && partial.summary.irreversible[1].ok === false, 'returned success prefix and attempted error remain separately reported and unknown');
    const unknown = await turn('unknown');
    check(unknown.summary?.irreversible?.length === 1 && unknown.summary.irreversible[0].effectStatus === 'unknown' && unknown.snapshot?.irreversible?.items?.[0]?.ok === false,
      'unreturned compound result stays unknown through ordinary mission API');
    const leaf = await turn('leaf', 'input_sequence'); check(leaf.summary?.irreversible?.[0]?.name === 'effect_fixture__input_sequence' && leaf.summary.irreversible[0].effectStatus === 'reported', 'ordinary proxy direct leaf is classified');
  } catch (error) { retained = true; t.fail(error.stack || String(error)); }
  finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      try {
        const table = snapshotProcessTable(), tree = table && ownDescendants(table, server.pid);
        if (!tree?.root) throw new Error('Missing owned service identity');
        const rows = [tree.root, ...tree.descendants], receipt = killOwnTree(server); cleanups.push({ receipt, observed: rows.map(row => ({ ...row, created: String(row.created) })) });
        if (receipt.incomplete || receipt.skipped) throw new Error('Incomplete cleanup');
        await until(() => { const now = snapshotProcessTable(); return now && rows.every(prior => !now.some(row => row.pid === prior.pid && row.created === prior.created)); }, 'observed process identities exited');
        check(true, 'all observed owned service/MCP processes exited');
      } catch (error) { retained = true; t.fail(error.message); }
    }
    if (provider) await provider.close();
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ cases, cleanups, retained, calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8') : '' }, null, 2) + '\n'); }
    if (!retained) fs.rmSync(root, { recursive: true, force: true });
    else console.log('Retained failed fixture: ' + root);
    t.done();
  }
})();
