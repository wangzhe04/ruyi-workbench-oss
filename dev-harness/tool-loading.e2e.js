// E2E: adaptive tool loading across OpenAI-compatible turns and Claude CLI's MCP child.
// Verifies pre-routing, incremental schema injection, compact discovery, and tier-safe proxying.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePorts } = require('./free-port');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), `ruyi-tool-loading-${process.pid}`);
const CAPTURE = path.join(HOME, 'capture');
const TOOL_FILE = path.join(HOME, 'adaptive.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => {
      let body = ''; res.on('data', c => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', chunk => {
        buf += chunk; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore diagnostics */ } }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.end(data);
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

function mcpSession(extraEnv) {
  const child = cp.spawn(process.execPath, [SERVER, 'mcp'], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME, ...extraEnv },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = ''; const pending = new Map();
  child.stdout.on('data', chunk => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n'); if (nl < 0) break;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const done = pending.get(msg.id); if (done) { pending.delete(msg.id); done(msg); }
    }
  });
  let seq = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 10000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { child, call };
}

(async () => {
  let fail = 0; const children = [];
  const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(CAPTURE, { recursive: true });
  fs.writeFileSync(TOOL_FILE, 'ADAPTIVE_TOOL_LOADING_OK');
  const [fakePort, wbPort] = await getFreePorts(2);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 8, version: '1.6.1', permissionMode: 'bypass', toolLoadingMode: 'auto',
    defaultWorkspace: HOME, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [], bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));

  try {
    const sequence = [
      { name: 'tool_search', args: { query: 'read workspace file' } },
      { name: 'tool_load', args: { packs: ['files_read'] } },
      { name: 'file_read', args: { path: TOOL_FILE } },
    ];
    const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_TOOL_SEQUENCE: JSON.stringify(sequence), FAKE_CAPTURE_DIR: CAPTURE }, windowsHide: true });
    const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    children.push(fake, wb);
    let live = null; for (let i = 0; i < 50 && !live; i++) { await sleep(120); live = await health(wbPort); }
    ok(!!live, 'provider workbench starts');
    const events = await postStream(wbPort, { message: 'Hello. Please answer briefly.' });
    const requests = fs.readdirSync(CAPTURE).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(CAPTURE, f), 'utf8')));
    const names = body => new Set((body.tools || []).map(t => t.function && t.function.name));
    ok(requests.length >= 4, 'four provider calls captured (search -> load -> concrete tool -> answer)');
    ok(names(requests[0]).has('tool_search') && names(requests[0]).has('tool_load'), 'simple request exposes compact discovery controls');
    ok(!names(requests[0]).has('file_read') && !names(requests[1]).has('file_read'), 'unrelated file schema absent before tool_load');
    ok(names(requests[2]).has('file_read') && names(requests[3]).has('file_read'), 'loaded file schema appears next iteration and remains stable');
    const meta = events.find(e => e.type === 'meta');
    ok(meta && meta.toolLoadingMode === 'auto' && meta.tools < meta.availableTools, 'meta reports reduced initial tool surface');
    ok(events.some(e => e.type === 'tool_catalog' && e.state === 'loaded'), 'tool_catalog loaded telemetry emitted');
    ok(events.some(e => e.type === 'tool_result' && JSON.stringify(e.content).includes('ADAPTIVE_TOOL_LOADING_OK')), 'concrete tool executes after loading');

    const compact = mcpSession({ WCW_TOOL_LOADING_MODE: 'auto', WCW_TOOL_PACKS: 'core', WCW_SESSION_ID: 'test' }); children.push(compact.child);
    await compact.call('initialize', { protocolVersion: '2024-11-05' });
    const list1 = await compact.call('tools/list');
    const listed1 = new Set((list1.result.tools || []).map(t => t.name));
    ok(listed1.has('tool_search') && listed1.has('tool_invoke_read') && !listed1.has('file_read'), 'Claude core route stays compact but keeps discovery proxies');
    const search = await compact.call('tools/call', { name: 'tool_search', arguments: { query: 'file_write' } });
    const searchText = JSON.parse(search.result.content[0].text);
    ok(searchText.matches.some(m => m.name === 'file_write' && m.tier === 'edit'), 'Claude discovery returns hidden tool and exact risk tier');
    const mismatch = await compact.call('tools/call', { name: 'tool_invoke_read', arguments: { name: 'file_write', arguments: { path: TOOL_FILE, content: 'bad' } } });
    const mismatchText = JSON.parse(mismatch.result.content[0].text);
    ok(mismatchText.ok === false && /tier mismatch/.test(mismatchText.error), 'Claude proxy rejects tier downgrade');

    const routed = mcpSession({ WCW_TOOL_LOADING_MODE: 'auto', WCW_TOOL_PACKS: 'core,files_read', WCW_SESSION_ID: 'test' }); children.push(routed.child);
    await routed.call('initialize', { protocolVersion: '2024-11-05' });
    const list2 = await routed.call('tools/list');
    ok((list2.result.tools || []).some(t => t.name === 'file_read'), 'Claude pre-router exposes likely concrete tools for the turn');
  } catch (e) {
    fail++; console.log('ERROR ' + (e && e.stack || e));
  } finally {
    children.reverse().forEach(killTree); await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(`\nTOOL-LOADING E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
    process.exitCode = fail ? 1 : 0;
  }
})();
