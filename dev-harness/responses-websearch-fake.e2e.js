// LIVE-ish E2E (fully OFFLINE): real workbench (runOpenAiTurn) -> LOCAL fake Responses-API endpoint.
// Proves the v1.8 web_search server-side tool mapping end-to-end WITHOUT a real key:
//   * provider apiStyle:'responses' + a Ruyi `web_search` function tool in the tool set
//     → the request body carries tools:[{type:'web_search'}] (mapped, NOT flattened to a function);
//   * the fake server answers with a web_search_call output item → Ruyi surfaces it as
//     tool_use('web_search') with a serverSide tool_result (NO local execution), and echoes the raw
//     web_search_call item back into the NEXT request's `input` (verbatim, same id);
//   * the final answer references the search-result secret the fake server planted.
// Run: node dev-harness/responses-websearch-fake.e2e.js
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePorts } = require('./free-port.js');

(async () => {
const WS_SECRET = 'WS_SECRET_9981';
const [FP, WB_PORT] = await getFreePorts(2);
const HOME = path.join(os.tmpdir(), 'wcw-responses-ws-e2e');
const WORK = path.join(HOME, 'work');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
// Provider = responses; workspace contains a file so a function tool exists, but the KEY assertion is the
// web_search function tool getting mapped to {type:'web_search'} and never executed locally.
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '0.6.0', permissionMode: 'bypass', defaultWorkspace: WORK,
  providers: [{ id: 'fake-resp', label: 'Fake Responses', type: 'openai-compat', apiStyle: 'responses',
    baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'deepseek-v4-flash',
    models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }], reasoning: true }],
  activeProvider: 'fake-resp',
  // builtin backend configured so the web_search function tool passes the capability gate — but the fake
  // server never lets it fire locally: the model answers with web_search_call, which the workbench treats
  // as server-side (no local execution, no network).
  searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// ── Fake /v1/responses server: answers web_search_call the way DeepSeek does ─────────────────────────
let servedBodies = []; // every /responses request body (for assertions)
const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (req.method === 'GET' && url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }] }));
  }
  if (req.method !== 'POST' || !url.includes('/responses')) { res.writeHead(404); return res.end(); }
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch { /* ignore */ }
    servedBodies.push(body);
    const inputs = Array.isArray(body.input) ? body.input : [];
    const hasWsCall = inputs.some(i => i && i.type === 'web_search_call');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sse = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    let seq = 0;
    sse({ type: 'response.created', sequence_number: seq++, response: { id: 'resp_ws', status: 'in_progress', output: [] } });
    if (!hasWsCall) {
      // First call: model decides to search — emits a web_search_call output item (id ws_1).
      sse({ type: 'response.reasoning_text.delta', sequence_number: seq++, output_index: 0, item_id: 'rsn_1', delta: '我需要联网搜索。' });
      sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress', call_id: 'call_ws_1' } });
      sse({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'completed', call_id: 'call_ws_1', output: { query: 'DeepSeek V4', search_terms: ['DeepSeek V4'], results: [{ title: 'T', url: 'https://x', content: '搜索密标 ' + WS_SECRET }] } } });
      sse({ type: 'response.completed', sequence_number: seq++, response: {
        id: 'resp_ws', status: 'completed', output: [],
        usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 40 } },
      } });
    } else {
      // Follow-up: the web_search_call item was echoed back → answer, referencing the search result.
      sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      const out = '搜索结果确认：密标是 ' + WS_SECRET + '，服务端搜索已完成。';
      for (const piece of out.match(/[\s\S]{1,8}/g) || [out]) {
        sse({ type: 'response.output_text.delta', sequence_number: seq++, output_index: 0, item_id: 'msg_1', delta: piece });
      }
      sse({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      sse({ type: 'response.completed', sequence_number: seq++, response: {
        id: 'resp_ws', status: 'completed', output: [],
        usage: { input_tokens: 150, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } },
      } });
    }
    res.end();
  });
});

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
let wb = null;
try {
  await new Promise(r => server.listen(FP, '127.0.0.1', r));
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
  ok(!!h, 'workbench listening on :' + WB_PORT);
  const events = await postStream(WB_PORT, { message: '请联网搜索 DeepSeek V4 的最新消息，并告诉我搜索结果里的密标。' });
  const toolUses = events.filter(e => e.type === 'tool_use');
  const toolResults = events.filter(e => e.type === 'tool_result');
  const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
  const result = events.find(e => e.type === 'result');
  console.log('--- tool_uses: ' + JSON.stringify(toolUses.map(t => ({ name: t.name, input: t.input }))));
  console.log('--- tool_results: ' + JSON.stringify(toolResults.map(r => ({ name: r.name, serverSide: r.content && r.content.serverSide, isError: r.isError }))));
  console.log('--- final text: ' + JSON.stringify(text.slice(0, 120)));

  // Protocol-shape assertions.
  ok(servedBodies.length >= 2, 'engine POSTed to /responses twice (search → answer) — got ' + servedBodies.length);
  const first = servedBodies[0] || {};
  const wsTool = Array.isArray(first.tools) ? first.tools.find(t => t && (t.type === 'web_search' || (t.type === 'function' && (t.name === 'web_search' || (t.function && t.function.name === 'web_search'))))) : null;
  ok(wsTool && wsTool.type === 'web_search' && !wsTool.function && !wsTool.name, 'web_search tool MAPPED to flat {type:"web_search"} (not a function)');
  ok(!Array.isArray(first.tools) || !first.tools.some(t => t && t.type === 'function' && t.function && t.function.name === 'web_search'), 'no function-shaped web_search in tools');
  // Server-side surfacing: tool_use(web_search) + serverSide tool_result, NO local execution error.
  ok(toolUses.some(t => t.name === 'web_search'), 'web_search_call surfaced as tool_use (web_search)');
  const wsUse = toolUses.find(t => t.name === 'web_search');
  const wsResult = wsUse ? toolResults.find(r => r.id === wsUse.id) : null;
  ok(!!wsResult && wsResult.content && wsResult.content.serverSide === true && wsResult.isError !== true, 'web_search tool_result is serverSide & not an error (no local execution)');
  // Echo back: the next request's `input` carries the web_search_call item verbatim (same id), no function_call_output.
  const last = servedBodies[servedBodies.length - 1] || {};
  const wsItems = Array.isArray(last.input) ? last.input.filter(i => i && i.type === 'web_search_call') : [];
  ok(wsItems.length === 1 && wsItems[0].id === 'ws_1' && wsItems[0].status === 'completed', 'web_search_call echoed back verbatim (id ws_1) into next request input');
  ok(!Array.isArray(last.input) || !last.input.some(i => i && i.type === 'function_call_output'), 'no function_call_output pairing for server-side search');
  ok(text.includes(WS_SECRET), 'final answer contains the search-result secret (' + WS_SECRET + ')');
  ok(result && result.ok === true, 'result ok=true');
} catch (e) { console.log('ERROR ' + e.message); fail++; }
finally {
  if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  await sleep(300);
  try { server.close(); } catch { /* ignore */ }
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nRESPONSES-WEBSEARCH-FAKE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
