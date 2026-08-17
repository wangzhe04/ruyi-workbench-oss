// E2E: 21-E5 meta-tool convergence — search hints (metaToolHintsV1), discoverySeq chain, todo dedupe.
// Drives a REAL workbench turn against the offline fake provider:
//   search → tool_load → file_read → todo_write → todo_write(same items, must be unchanged)
// Asserts: hint fields present only with the flag on; discoverySeq links the chain in the E0 ledger;
// the duplicate todo returns unchanged:true and persists deduped:true without breaking pairing.
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
          if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } }
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
function readLogs(home) {
  return fs.readdirSync(path.join(home, 'logs')).filter(f => /^workbench-.*\.ndjson$/.test(f))
    .flatMap(f => fs.readFileSync(path.join(home, 'logs', f), 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })).filter(Boolean);
}

async function runCase(hintsOn) {
  const HOME = path.join(os.tmpdir(), `ruyi-meta-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const [fakePort, wbPort] = await getFreePorts(2);
  const target = path.join(HOME, 'target.txt'); fs.writeFileSync(target, 'E5_TARGET');
  const todoItems = [{ text: '勘察代码' }, { text: '落地 E5' }];
  const sequence = [
    { name: 'tool_search', args: { query: 'read a workspace file' } },
    { name: 'tool_load', args: { packs: ['files_read'] } },
    { name: 'file_read', args: { path: target } },
    { name: 'todo_write', args: { items: todoItems } },
    { name: 'todo_write', args: { items: todoItems } },
  ];
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 10, version: '2.5.0', permissionMode: 'bypass', toolLoadingMode: 'auto',
    runtimeOptimizationShadowV1: true, runtimeToolRetrievalV1: false, runtimeFailureTelemetryV1: false,
    metaToolHintsV1: hintsOn,
    defaultWorkspace: HOME, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [], bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_TOOL_SEQUENCE: JSON.stringify(sequence) }, windowsHide: true });
  const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  let live = null; for (let i = 0; i < 50 && !live; i++) { await sleep(120); live = await health(wbPort); }
  const events = await postStream(wbPort, { message: 'Please discover tools, read the file, then write the todo list twice.' });
  await sleep(500);
  const rows = readLogs(HOME);
  const tools = rows.filter(r => r.kind === 'tool_call_completed');
  const searchResults = tools.filter(r => r.name === 'tool_search');
  const loads = tools.filter(r => r.name === 'tool_load');
  const reads = tools.filter(r => r.name === 'file_read');
  const todos = tools.filter(r => r.name === 'todo_write');
  const searchResult = events.find(e => e.type === 'tool_result' && e.content && e.content.query === 'read a workspace file');
  killTree(fake); killTree(wb); await sleep(150);
  fs.rmSync(HOME, { recursive: true, force: true });
  return { tools, searchResults, loads, reads, todos, hintsOn, searchResult };
}

(async () => {
  let fail = 0;
  const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
  try {
    const on = await runCase(true);
    ok(on.tools.length >= 5, 'hints-on: all five meta calls executed');
    ok(on.searchResults.length === 1 && on.loads.length === 1 && on.reads.length === 1 && on.todos.length === 2, 'hints-on: one search / one load / one read / two todos');
    // E5b hint 字段(开关开,模型可见的 tool_result)。message 含 read/file → files_read pack 预激活,
    // file_read 已 loaded(direct);结果里未激活的候选(如 file_edit)应提示 tool_load。
    const hintTop = on.searchResult && on.searchResult.content && on.searchResult.content.matches && on.searchResult.content.matches[0];
    ok(!!hintTop && (hintTop.callHint || hintTop.requiredArgs || hintTop.state), 'hints-on: search result carries hint fields');
    ok(hintTop && hintTop.requiredArgs && hintTop.requiredArgs.includes('path') && hintTop.argTypes && hintTop.argTypes.path === 'string', 'hints-on: file_read requiredArgs=[path] typed string');
    ok(hintTop && hintTop.callHint === 'direct' && hintTop.state === 'loaded', 'hints-on: pack-activated file_read hints direct/loaded');
    const allHints = on.searchResult && on.searchResult.content && on.searchResult.content.matches || [];
    ok(allHints.length > 0 && allHints.every(m => ['direct', 'tool_load', 'tool_invoke_read', 'tool_invoke_edit', 'tool_invoke_exec'].includes(m.callHint) && ['loaded', 'callable', 'blocked'].includes(m.state)), 'hints-on: every match carries a valid callHint/state');
    // E5a discoverySeq 链
    ok(on.searchResults[0].searchSeq >= 1, 'hints-on: tool_search carries searchSeq');
    ok(on.loads[0] && on.loads[0].discoverySeq === on.searchResults[0].searchSeq, 'hints-on: tool_load inherits discoverySeq from the search');
    ok(on.reads[0] && on.reads[0].discoverySeq === on.searchResults[0].searchSeq, 'hints-on: file_read inherits the same discoverySeq');
    // E5c todo 去重
    const [todo1, todo2] = on.todos;
    ok(todo2 && todo2.deduped === true && todo1 && todo1.deduped !== true, 'hints-on: duplicate todo flagged deduped in the ledger');
    ok(todo2 && todo2.status === 'completed' && todo2.assistantBatchId, 'hints-on: deduped todo still completes and pairs');

    const off = await runCase(false);
    const offTop = off.searchResult && off.searchResult.content && off.searchResult.content.matches && off.searchResult.content.matches[0];
    ok(offTop && !('callHint' in offTop) && !('requiredArgs' in offTop) && !('state' in offTop), 'hints-off: search result has NO hint fields (legacy shape preserved)');
    ok(off.todos.length === 2 && !off.todos.some(t => t.deduped), 'hints-off: duplicate todo NOT deduped (legacy full-write behavior)');
    // discoverySeq 观测不依赖 metaToolHintsV1(随 toolEconomicsShadowV1)
    ok(off.searchResults[0].searchSeq >= 1 && off.loads[0] && off.loads[0].discoverySeq === off.searchResults[0].searchSeq, 'hints-off: discoverySeq observation still works (E0 ledger)');
  } catch (e) {
    fail++; console.log('ERROR ' + (e && e.stack || e));
  }
  console.log(`\nMETA-TOOLS E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
})();
