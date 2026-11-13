'use strict';
// Cross-platform MCP EOF regression. Real workbench stdio + a private Node-only bridge.
// No Python, model endpoint, browser, desktop interaction, or real user configuration.
require('./lib/self-isolate-home');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('MCP STDIO EOF');
const { ok } = t;
const server = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function check(condition, label) { if (!ok(condition, label)) throw new Error(label); }
async function until(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(30); }
  throw new Error('MCP EOF fixture timed out');
}

const bridgeSource = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const directory = process.env.MCP_EOF_FIXTURE;
fs.writeFileSync(path.join(directory, 'bridge.pid'), String(process.pid));
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
rl.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === 'initialize') return send(message.id, { protocolVersion: '2024-11-05',
    capabilities: { tools: {} }, serverInfo: { name: 'eof-fixture', version: '1' } });
  if (message.method === 'tools/list') return send(message.id, { tools: [{ name: 'review_echo',
    description: 'Private EOF fixture', inputSchema: { type: 'object', properties: { waitForRelease: { type: 'boolean' } } } }] });
  if (message.method !== 'tools/call') return send(message.id, {});
  const finish = () => send(message.id, { content: [{ type: 'text', text: JSON.stringify({ ok: true, marker: 'eof-complete' }) }] });
  if (!message.params?.arguments?.waitForRelease) return finish();
  fs.writeFileSync(path.join(directory, 'call-started'), 'started');
  const deadline = Date.now() + 15000;
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(directory, 'release'))) { clearInterval(timer); finish(); }
    else if (Date.now() > deadline) { clearInterval(timer); process.exitCode = 2; rl.close(); }
  }, 10);
});
`;

async function scenario(inFlight) {
  const fixture = fixtureChildEnv({ perTest: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-eof-'));
  const bridge = path.join(root, 'bridge.cjs');
  const observer = path.join(root, 'observe-input.cjs');
  const data = path.join(fixture.home, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(bridge, bridgeSource);
  fs.writeFileSync(observer, "process.stdin.once('end', () => require('node:fs').writeFileSync(require('node:path').join(process.env.MCP_EOF_FIXTURE, 'proxy-saw-eof'), 'observed'));\n");
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, permissionMode: 'bypass',
    includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, stewardEnabledV1: false, schedulerEnabledV1: false,
    enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false }, providers: [],
    externalMcpServers: [{ id: 'review', command: process.execPath, args: [bridge], env: { MCP_EOF_FIXTURE: root } }] }));
  const child = cp.spawn(process.execPath, ['--require', observer, server, 'mcp'], { cwd: root,
    env: { ...process.env, ...fixture.env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, MCP_EOF_FIXTURE: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let buffer = '', diagnostic = '', completed = false;
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const message = JSON.parse(line); if (message.id !== undefined) replies.set(message.id, message); } catch {}
    }
  });
  function send(id, method, params = {}) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
  const label = inFlight ? 'in-flight EOF' : 'idle EOF';
  try {
    send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof-regression', version: '1' } });
    await until(() => replies.has(1));
    check(Boolean(replies.get(1).result), label + ': actual workbench handshake succeeds');
    send(2, 'tools/call', { name: 'tool_search', arguments: { query: 'review_echo' } });
    await until(() => replies.has(2));
    check(JSON.stringify(replies.get(2).result).includes('review__review_echo'), label + ': real private bridge is discovered');
    const backendPID = Number(fs.readFileSync(path.join(root, 'bridge.pid'), 'utf8'));
    check(backendPID > 0 && alive(backendPID), label + ': bridge is actually alive before EOF');
    send(3, 'tools/call', { name: 'tool_invoke_exec', arguments: {
      name: 'review__review_echo', arguments: { waitForRelease: inFlight },
    } });
    if (inFlight) {
      await until(() => fs.existsSync(path.join(root, 'call-started')));
      check(!replies.has(3) && alive(backendPID), label + ': request is inside the bridge and has not completed');
      child.stdin.end();
      await until(() => fs.existsSync(path.join(root, 'proxy-saw-eof')));
      check(!replies.has(3) && alive(backendPID), label + ': proxy observes EOF before the held request is released');
      fs.writeFileSync(path.join(root, 'release'), 'release-after-eof');
      await until(() => replies.has(3));
    } else {
      await until(() => replies.has(3));
      child.stdin.end();
    }
    const reply = replies.get(3);
    check(reply.result?.isError === false && JSON.stringify(reply.result).includes('eof-complete'),
      label + ': completed tool result is delivered normally');
    await until(() => child.exitCode !== null || child.signalCode !== null);
    check(child.exitCode === 0 && child.signalCode === null, label + ': proxy exits naturally with code zero');
    await until(() => !alive(backendPID));
    check(!alive(backendPID), label + ': owned bridge exits after the proxy drains accepted requests');
    completed = true;
  } catch (error) {
    console.log('MCP EOF preserved fixture: ' + root);
    throw new Error(error.message + (diagnostic ? '\n' + diagnostic : ''));
  } finally {
    await killOwnTree(child);
    if (completed) { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(fixture.home, { recursive: true, force: true }); }
  }
}

(async () => {
  try { await scenario(false); await scenario(true); }
  catch (error) { t.fail(error.stack || String(error)); }
  t.done();
})();
