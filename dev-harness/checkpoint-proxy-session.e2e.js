'use strict';
require('./lib/self-isolate-home');
// Offline ordinary provider turns -> proxy -> fake image writers. Verifies the journal context,
// not PNG encoding/native capture (covered by opt-in macos-native-entry.e2e.js).
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('CHECKPOINT PROXY SESSION');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-proxy-journal-'));
const work = path.join(root, 'work'), data = path.join(root, 'data');
const wb = path.resolve(__dirname, '../ruyi-workbench');
let server, provider, port, token = '', active, cleanupSafe = true;
const diagnostics = [];
async function until(read, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Timed out: ' + label);
}
async function api(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  if (!response.ok || value.ok === false) throw new Error(route + ': ' + JSON.stringify(value));
  return value;
}
(async () => {
  try {
    fs.mkdirSync(work); fs.mkdirSync(data);
    provider = await startFakeProvider({ handler(req) {
      if (!active || active.sent || !req.tools.some(tool => tool.function?.name === 'tool_invoke_exec')) return textFrames('done');
      active.sent = true;
      return toolCallFrames('tool_invoke_exec', { name: 'fake__' + active.tool, arguments: active.args }, 'call_image');
    } });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: require('../ruyi-workbench/app/server').CONFIG_SCHEMA,
      permissionMode: 'bypass', defaultWorkspace: work, stewardThreadBriefV1: false,
      providers: [{ id: 'fake', type: 'openai-compat', apiStyle: 'chat', baseUrl: provider.url, apiKey: 'synthetic', model: 'fake-model' }], activeProvider: 'fake',
      allowDesktopTools: true, bridgeExternalToolsToProvider: true, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: false, desktopMcp: { enabled: false, autodetect: false },
      externalMcpServers: [{ id: 'fake', enabled: true, command: process.execPath, args: [path.join(__dirname, 'fake-mcp.js')] }] }));
    port = await getFreePort();
    const env = { ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data };
    delete env.WCW_SESSION_ID; // The provider context must work without the CLI environment fallback.
    server = cp.spawn(process.execPath, [path.join(wb, 'app/server.js'), 'serve', '--port', String(port)], { env, cwd: wb, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', value => diagnostics.push(String(value))); server.stderr.on('data', value => diagnostics.push(String(value)));
    await until(async () => {
      try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'))); if (runtime.pid !== server.pid || !runtime.token) return false;
        token = runtime.token; port = runtime.port; return (await api('GET', '/health')).ok; } catch { return false; }
    }, 'owned service');
    for (const tool of ['window_screenshot', 'get_clipboard_image']) for (const overwrite of [false, true]) {
      const label = tool + '-' + overwrite, output = path.join(work, label + '.png');
      const before = Buffer.from('original before image\0\xff', 'latin1');
      if (overwrite) fs.writeFileSync(output, before);
      const created = await api('POST', '/api/sessions', { title: label, cwd: work });
      const sessionId = created.session.id;
      active = { tool, args: tool === 'window_screenshot' ? { title_substring: 'owned fixture', output_path: output } : { save_path: output } };
      const response = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token },
        body: JSON.stringify({ sessionId, message: label, cwd: work }), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('turn failed ' + response.status);
      const events = (await response.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const expected = Buffer.from(tool === 'window_screenshot' ? 'FAKE_WINDOW_PNG' : 'FAKE_CLIP_PNG');
      t.ok(events.some(event => event.type === 'tool_result' && event.id === 'call_image' && event.isError !== true)
        && fs.existsSync(output) && fs.readFileSync(output).equals(expected), label + ' proxy actually writes the fixture file');
      const summary = events.find(event => event.type === 'turn_summary');
      const journal = await api('GET', '/api/checkpoints?sessionId=' + sessionId);
      const entry = journal.entries?.find(row => row.path === output);
      t.ok(entry?.op === (overwrite ? 'modify' : 'create') && entry.turnSeq === summary?.turnSeq && Number.isInteger(entry?.turnSeq)
        && entry.turnSeq > 0 && !entry.skipped && (!overwrite || entry.bytes === before.length), label + ' journals the actual session and turn before dispatch');
      if (!entry) continue; // Retain all failing cases; rollback cannot run without an entry.
      const rollback = await api('POST', '/api/checkpoints/rollback', { sessionId, turnSeq: entry.turnSeq });
      t.ok(rollback.ok && (overwrite ? fs.readFileSync(output).equals(before) : !fs.existsSync(output)), label + ' rollback restores the exact prior state');
    }
  } catch (error) { t.fail(error.stack || String(error)); diagnostics.forEach(value => console.log(value.replaceAll(token || '[no-token]', '[fixture token]'))); }
  finally {
    if (server) {
      const table = snapshotProcessTable();
      const tree = table && ownDescendants(table, server.pid);
      const observed = tree?.root ? [tree.root, ...tree.descendants] : null;
      const receipt = killOwnTree(server);
      console.log('Owned cleanup receipt: ' + JSON.stringify({ receipt, observed }, (_key, value) => typeof value === 'bigint' ? String(value) : value));
      try {
        if (!observed || receipt.incomplete || receipt.skipped) throw new Error('Incomplete owned-tree cleanup');
        await until(() => server.exitCode !== null || server.signalCode !== null, 'service cleanup');
        await until(() => { const current = snapshotProcessTable(); return current && observed.every(row => !current.some(live => live.pid === row.pid && live.created === row.created)); }, 'observed owned process identities exited');
        t.ok(true, 'service cleanup confirms all observed owned process identities exited');
      } catch (error) { cleanupSafe = false; t.fail(error.message); }
    }
    if (provider) await provider.close();
    if (cleanupSafe) fs.rmSync(root, { recursive: true, force: true });
    else console.log('Retained incomplete cleanup evidence: ' + root);
    t.done();
  }
})();
