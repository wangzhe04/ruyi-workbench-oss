// LIVE-ish E2E (fully OFFLINE): real workbench (runOpenAiTurn) -> LOCAL fake Responses-API endpoint.
// Two phases prove the v1.8.2 web_search server-side tool GATING end-to-end without a real key:
//   Phase A (provider.serverWebSearch:true, the DeepSeek preset):
//     * the request carries tools:[{type:'web_search'}] (mapped, NOT flattened to a function);
//     * the fake server answers with a web_search_call item → Ruyi surfaces tool_use('web_search') with a
//       serverSide tool_result (NO local execution), echoing the raw item back into the next request `input`;
//     * tool_use input carries the REAL search terms (parsed from action.queries — the DeepSeek shape);
//     * the final answer references the search-result secret the fake server planted.
//   Phase B (serverWebSearch unset = default false):
//     * web_search STAYS a local function tool (builtin backend fallback) — the request carries
//       {type:'function', name:'web_search', ...}, never {type:'web_search'};
//     * the fake server (no server-side web_search here) answers with plain text — no tool invoked.
// Run: node dev-harness/responses-websearch-fake.e2e.js
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePorts } = require('./free-port.js');

(async () => {
const WS_SECRET = 'WS_SECRET_9981';
const [FP] = await getFreePorts(1);
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

// ── Fake /responses server: server-side web_search when the request opts in, plain text otherwise ─────
let servedBodies = [];
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
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasServerWsTool = tools.some(t => t && t.type === 'web_search');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sse = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    let seq = 0;
    sse({ type: 'response.created', sequence_number: seq++, response: { id: 'resp_ws', status: 'in_progress', output: [] } });
    if (hasServerWsTool && !hasWsCall) {
      // Phase A first call: model decides to search — emits a web_search_call output item (id ws_1).
      // v1.8.1: item shaped like the REAL DeepSeek payload (query under `action.queries`, NO `output`
      // field, no `call_id`) — the old fake used the OpenAI-doc shape and masked the display bug.
      sse({ type: 'response.reasoning_text.delta', sequence_number: seq++, output_index: 0, item_id: 'rsn_1', delta: '我需要联网搜索。' });
      sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } });
      sse({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['DeepSeek V4', 'DeepSeek V4 发布'] } } });
      sse({ type: 'response.completed', sequence_number: seq++, response: {
        id: 'resp_ws', status: 'completed', output: [],
        usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 40 } },
      } });
    } else if (hasServerWsTool) {
      // Phase A follow-up: the web_search_call item was echoed back → answer, referencing the search result.
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
    } else {
      // Phase B: no server-side web_search opted in → web_search stays a LOCAL function tool; the fake
      // endpoint answers with plain text (the model has the local function available but need not call it).
      sse({ type: 'response.reasoning_text.delta', sequence_number: seq++, output_index: 0, item_id: 'rsn_1', delta: '本次不使用服务端搜索。' });
      sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      const out = '收到，未使用服务端搜索（本地 web_search 保底可用）。';
      for (const piece of out.match(/[\s\S]{1,8}/g) || [out]) {
        sse({ type: 'response.output_text.delta', sequence_number: seq++, output_index: 0, item_id: 'msg_1', delta: piece });
      }
      sse({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      sse({ type: 'response.completed', sequence_number: seq++, response: {
        id: 'resp_ws', status: 'completed', output: [],
        usage: { input_tokens: 100, output_tokens: 15, input_tokens_details: { cached_tokens: 30 } },
      } });
    }
    res.end();
  });
});

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const wbs = [];

async function runPhase(serverWebSearch, label) {
  const [port, wbPort] = await getFreePorts(2);
  const home = path.join(os.tmpdir(), `wcw-rws-${label}`);
  const work = path.join(home, 'work');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const provider = { id: 'fake-resp', label: 'Fake Responses', type: 'openai-compat', apiStyle: 'responses',
    baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'deepseek-v4-flash',
    models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }], reasoning: true };
  if (serverWebSearch) provider.serverWebSearch = true;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 4, version: '0.6.0', permissionMode: 'bypass', defaultWorkspace: work,
    providers: [provider],
    activeProvider: 'fake-resp',
    searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
  }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  wbs.push(wb);
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(wbPort); }
    ok(!!h, `[${label}] workbench listening`);
    servedBodies.length = 0;
    const events = await postStream(wbPort, { message: '请联网搜索 DeepSeek V4 的最新消息，并告诉我搜索结果里的密标。' });
    const toolUses = events.filter(e => e.type === 'tool_use');
    const toolResults = events.filter(e => e.type === 'tool_result');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const result = events.find(e => e.type === 'result');
    console.log(`--- [${label}] tool_uses: ` + JSON.stringify(toolUses.map(t => ({ name: t.name, input: t.input }))));
    console.log(`--- [${label}] final text: ` + JSON.stringify(text.slice(0, 80)));
    const first = servedBodies[0] || {};
    return { events, toolUses, toolResults, text, result, first, servedCount: servedBodies.length };
  } finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

try {
  await new Promise(r => server.listen(FP, '127.0.0.1', r));

  // ── Phase A: serverWebSearch:true → server-side tool ────────────────────────────────────────────
  console.log('\n=== Phase A: serverWebSearch:true (DeepSeek preset) → server-side web_search ===');
  const a = await runPhase(true, 'A');
  ok(a.first && Array.isArray(a.first.tools) && a.first.tools.some(t => t && t.type === 'web_search'), 'A: web_search tool MAPPED to flat {type:"web_search"}');
  ok(a.first && !a.first.tools.some(t => t && t.type === 'function' && (t.name === 'web_search' || (t.function && t.function.name === 'web_search'))), 'A: no function-shaped web_search in tools');
  ok(a.toolUses.some(t => t.name === 'web_search'), 'A: web_search_call surfaced as tool_use (web_search)');
  const aUse = a.toolUses.find(t => t.name === 'web_search');
  ok(!!aUse && aUse.input && typeof aUse.input.query === 'string' && aUse.input.query.includes('DeepSeek V4') && aUse.input.actionType === 'search',
    'A: tool_use input carries real search terms from action.queries (query=' + JSON.stringify(aUse && aUse.input && aUse.input.query) + ')');
  const aResult = aUse ? a.toolResults.find(r => r.id === aUse.id) : null;
  ok(!!aResult && aResult.content && aResult.content.serverSide === true && aResult.isError !== true, 'A: web_search tool_result is serverSide & not an error (no local execution)');
  const aLast = servedBodies[servedBodies.length - 1] || {};
  const aWsItems = Array.isArray(aLast.input) ? aLast.input.filter(i => i && i.type === 'web_search_call') : [];
  ok(aWsItems.length === 1 && aWsItems[0].id === 'ws_1', 'A: web_search_call echoed back verbatim (id ws_1) into next request input');
  ok(!Array.isArray(aLast.input) || !aLast.input.some(i => i && i.type === 'function_call_output'), 'A: no function_call_output pairing for server-side search');
  ok(a.text.includes(WS_SECRET), 'A: final answer contains the search-result secret');
  ok(a.result && a.result.ok === true, 'A: result ok=true');

  // ── Phase B: serverWebSearch unset (default false) → LOCAL function tool stays (fallback) ─────────
  console.log('\n=== Phase B: serverWebSearch unset (default false) → local web_search function fallback ===');
  servedBodies.length = 0;
  const b = await runPhase(false, 'B');
  const bWsTool = b.first && Array.isArray(b.first.tools) ? b.first.tools.find(t => t && t.type === 'function' && (t.name === 'web_search' || (t.function && t.function.name === 'web_search'))) : null;
  ok(!!bWsTool, 'B: web_search STAYS a local function tool ({type:"function", name:"web_search"})');
  ok(b.first && !b.first.tools.some(t => t && t.type === 'web_search'), 'B: NO {type:"web_search"} server-side tool sent');
  ok(b.toolUses.length === 0, 'B: no server-side web_search_call surfaced (endpoint ignored it)');
  ok(b.text.includes('本地 web_search 保底可用'), 'B: plain-text answer without server-side search');
  ok(b.result && b.result.ok === true, 'B: result ok=true');
} catch (e) { console.log('ERROR ' + e.message); fail++; }
finally {
  for (const wb of wbs) { if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
  await sleep(300);
  try { server.close(); } catch { /* ignore */ }
  console.log('\nRESPONSES-WEBSEARCH-FAKE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
