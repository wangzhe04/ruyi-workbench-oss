// LIVE-ish E2E (fully OFFLINE): real workbench (runOpenAiTurn) -> LOCAL fake Responses-API endpoint.
// Proves the v1.7 Responses-API protocol path end-to-end WITHOUT a real key:
//   * provider apiStyle:'responses' → engine POSTs /v1/responses with {instructions, input, tools};
//   * SSE events response.reasoning_text.delta / response.output_text.delta stream into
//     thinking_delta / assistant_delta (no `data: [DONE]` — response.completed terminates);
//   * a function_call (file_read) is offered, its arguments stream in via
//     response.function_call_arguments.delta, the tool runs, function_call_output is fed back
//     into the NEXT request's `input` items, and the final answer references the tool result;
//   * thinking-mode reasoning_text is also fed back as a `reasoning` input item before the function call;
//     omitting it would reproduce DeepSeek's real HTTP 400 on the second tool-loop request;
//   * response.completed usage (input_tokens/output_tokens/details.cached_tokens) reaches the usage event.
// Run: node dev-harness/responses-fake.e2e.js
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePorts } = require('./free-port.js');

(async () => {
const SECRET = 'RESP_SECRET_7712';
const [FP, WB_PORT] = await getFreePorts(2);
const HOME = path.join(os.tmpdir(), 'wcw-responses-e2e');
const WORK = path.join(HOME, 'work');
const FILE = path.join(WORK, 'secret.txt');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(FILE, 'The secret marker is ' + SECRET + '.', 'utf8');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '0.5.0', permissionMode: 'bypass', defaultWorkspace: WORK,
  providers: [{ id: 'fake-resp', label: 'Fake Responses', type: 'openai-compat', apiStyle: 'responses',
    baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'deepseek-v4-flash',
    models: [{ id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' }], reasoning: true }],
  activeProvider: 'fake-resp',
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

// ── Fake /v1/responses server (OpenAI Responses-API event shape, DeepSeek-compatible) ──────────────
let servedBodies = []; // every /v1/responses request body (for assertions)
let servedPaths = [];  // every /v1/responses request PATH (v1.7-对抗轮: 断言 responses 走无 /v1 的官方 SDK 路径)
// 对抗轮(P1-2): PARALLEL=1 时首个请求发【两个并行的 function_call】且事件序刻意交错
// (added₁, added₂, delta₁, delta₂) —— 旧实现按 curSlot 路由会把 call₁ 参数写进 call₂;修复后必须按 item_id 精确路由。
const PARALLEL = process.env.PARALLEL === '1';
const server = http.createServer((req, res) => {
  const url = req.url || '';
  if (req.method === 'GET' && url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }] }));
  }
  if (req.method !== 'POST' || !url.includes('/responses')) { res.writeHead(404); return res.end(); }
  servedPaths.push(url.split('?')[0]);
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch { /* ignore */ }
    servedBodies.push(body);
    const inputs = Array.isArray(body.input) ? body.input : [];
    const hasToolOutput = inputs.some(i => i && i.type === 'function_call_output');
    const hasReasoningReplay = inputs.some(i => i && i.type === 'reasoning' && Array.isArray(i.content)
      && i.content.some(part => part && part.type === 'reasoning_text' && typeof part.text === 'string' && part.text.length > 0));
    if (hasToolOutput && !hasReasoningReplay) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'The `reasoning_text` in the thinking mode must be passed back to the API.' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sse = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    let seq = 0;
    sse({ type: 'response.created', sequence_number: seq++, response: { id: 'resp_fake', status: 'in_progress', output: [] } });
    if (!hasToolOutput) {
      if (PARALLEL) {
        // 对抗轮(P1-2): TWO parallel function_calls, INTERLEAVED events (added₁, added₂, delta₁, delta₂…).
        // args are split so the old curSlot routing would mis-attach call₁'s args to call₂'s slot.
        sse({ type: 'response.reasoning_text.delta', sequence_number: seq++, output_index: 0, item_id: 'rsn_1', delta: '我需要并行读取文件并列出目录。' });
        const spec = [
          { id: 'fc_p1', callId: 'call_par_1', name: 'file_read', args: { path: FILE } },
          { id: 'fc_p2', callId: 'call_par_2', name: 'file_list', args: { path: WORK } },
        ];
        sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: spec[0].id, type: 'function_call', call_id: spec[0].callId, name: spec[0].name, arguments: '' } });
        sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: spec[1].id, type: 'function_call', call_id: spec[1].callId, name: spec[1].name, arguments: '' } });
        for (const s of spec) {
          const argsFull = JSON.stringify(s.args);
          const half = Math.ceil(argsFull.length / 2);
          sse({ type: 'response.function_call_arguments.delta', sequence_number: seq++, output_index: 0, item_id: s.id, delta: argsFull.slice(0, half) });
          sse({ type: 'response.function_call_arguments.delta', sequence_number: seq++, output_index: 0, item_id: s.id, delta: argsFull.slice(half) });
        }
        for (const s of spec) {
          sse({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { id: s.id, type: 'function_call', call_id: s.callId, name: s.name, arguments: JSON.stringify(s.args) } });
        }
      } else {
        // First call: reasoning then a streamed function_call (file_read on the secret file).
        sse({ type: 'response.reasoning_text.delta', sequence_number: seq++, output_index: 0, item_id: 'rsn_1', delta: '我需要读取文件来找到密标记。' });
        sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_resp_1', name: 'file_read', arguments: '' } });
        const argsFull = JSON.stringify({ path: FILE });
        const half = Math.ceil(argsFull.length / 2);
        sse({ type: 'response.function_call_arguments.delta', sequence_number: seq++, output_index: 0, item_id: 'fc_1', delta: argsFull.slice(0, half) });
        sse({ type: 'response.function_call_arguments.delta', sequence_number: seq++, output_index: 0, item_id: 'fc_1', delta: argsFull.slice(half) });
        sse({ type: 'response.function_call_arguments.done', sequence_number: seq++, output_index: 0, item_id: 'fc_1' });
        sse({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_resp_1', name: 'file_read', arguments: argsFull } });
      }
      sse({ type: 'response.completed', sequence_number: seq++, response: {
        id: 'resp_fake', status: 'completed', output: [],
        usage: { input_tokens: 110, output_tokens: 25, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 8 } },
      } });
    } else {
      // Follow-up: the function_call_output(s) are in `input` → stream the final answer referencing the tool results.
      const outputs = inputs.filter(i => i && i.type === 'function_call_output');
      const echoed = outputs.map(o => String((o && o.output) || '')).join(' | ');
      sse({ type: 'response.output_item.added', sequence_number: seq++, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      const out = '工具返回了内容。密标记是 ' + (echoed.includes(SECRET) ? SECRET : '???') + '，报告完毕。' + (PARALLEL ? ' 工具数=' + outputs.length : '');
      for (const piece of out.match(/[\s\S]{1,8}/g) || [out]) {
        sse({ type: 'response.output_text.delta', sequence_number: seq++, output_index: 0, item_id: 'msg_1', delta: piece });
      }
      sse({ type: 'response.output_item.done', sequence_number: seq++, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      sse({ type: 'response.completed', sequence_number: seq++, response: {
        id: 'resp_fake', status: 'completed', output: [],
        usage: { input_tokens: 130, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 0 } },
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
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
  ok(!!h, 'workbench listening on :' + WB_PORT);
  const events = await postStream(WB_PORT, { message: `请用 file_read 读取 ${FILE.replace(/\\/g, '\\\\')}，然后告诉我里面的密标记字符串。` });
  const toolUses = events.filter(e => e.type === 'tool_use');
  const toolResults = events.filter(e => e.type === 'tool_result');
  const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
  const think = events.filter(e => e.type === 'thinking_delta').map(e => e.text).join('');
  const usage = events.find(e => e.type === 'usage');
  const result = events.find(e => e.type === 'result');
  console.log('--- tool_uses: ' + JSON.stringify(toolUses.map(t => t.name)));
  console.log('--- final text: ' + JSON.stringify(text.slice(0, 160)));
  console.log('--- reasoning chars: ' + think.length + ' :: ' + JSON.stringify(think.slice(0, 40)));
  console.log('--- usage: ' + JSON.stringify(usage));

  // Protocol-shape assertions on what was actually POSTed to /v1/responses.
  ok(servedBodies.length >= 1, 'engine POSTed to /responses (' + servedBodies.length + 'x)');
  // 对抗轮(open-risk):responses 端点必须走【原样 baseUrl + /responses】(无 /v1,与官方 OpenAI SDK 示例一致),
  // 而不是 chat 的 providerBaseWithV1 补 /v1。断言收到的路径形如 /responses 而非 /v1/responses。
  ok(servedPaths.length >= 1 && servedPaths.every(p => p.endsWith('/responses') && !p.includes('/v1/')), 'responses path has NO /v1 prefix (' + JSON.stringify(servedPaths) + ')');
  const first = servedBodies[0] || {};
  ok(typeof first.instructions === 'string' && first.instructions.length > 0, 'body carries instructions (system → instructions)');
  ok(Array.isArray(first.input), 'body carries input items');
  ok(first.stream === true, 'body stream:true');
  ok(!('messages' in first), 'body has NO chat `messages` key');
  ok(!('stream_options' in first), 'body has NO chat stream_options key');
  ok(Array.isArray(first.tools) && first.tools.length > 0, 'body carries tools');
  const flatTool = (first.tools || []).find(t => t && t.type === 'function');
  ok(flatTool && typeof flatTool.name === 'string' && !flatTool.function, 'tools are FLAT Responses shape (name at top level, no nested function)');
  // Follow-up request must feed the tool result back as a function_call_output item.
  const last = servedBodies[servedBodies.length - 1] || {};
  const reasoningReplay = Array.isArray(last.input) ? last.input.find(i => i && i.type === 'reasoning') : null;
  ok(reasoningReplay && Array.isArray(reasoningReplay.content)
    && reasoningReplay.content.some(part => part && part.type === 'reasoning_text' && part.text.includes('我需要')),
  'thinking-mode reasoning_text replayed as a Responses reasoning item');
  if (PARALLEL) {
    // 对抗轮(P1-2)并行场景:两个 function_call 都必须执行、参数各自精确路由(call_par_1→file_read FILE,
    // call_par_2→file_list WORK),且最终回答同时包含两个工具结果。
    const fcos = Array.isArray(last.input) ? last.input.filter(i => i && i.type === 'function_call_output') : [];
    ok(toolUses.some(t => t.name === 'file_read') && toolUses.some(t => t.name === 'file_list'), 'BOTH parallel function_calls surfaced as tool_use (file_read + file_list)');
    ok(fcos.length === 2 && fcos.some(f => f.call_id === 'call_par_1') && fcos.some(f => f.call_id === 'call_par_2'), 'BOTH parallel tool results fed back (call_par_1 + call_par_2)');
    ok(text.includes('工具数=2'), 'final answer references BOTH tool results (no mis-routing)');
    ok(toolResults.length === 2 && toolResults.every(r => r.isError !== true), 'both parallel tool_result(s) ok');
    ok(text.includes(SECRET), 'final answer contains the secret (parallel loop round-trip)');
  } else {
    const hasFco = Array.isArray(last.input) && last.input.some(i => i && i.type === 'function_call_output' && i.call_id === 'call_resp_1');
    ok(hasFco, 'tool result fed back as function_call_output item in next request');
    ok(toolUses.some(t => t.name === 'file_read'), 'function_call surfaced as tool_use (file_read)');
    ok(toolResults.length > 0 && toolResults.every(r => r.isError !== true), 'tool_result(s) ok');
    ok(text.includes(SECRET), 'final answer contains the secret (tool loop round-trip)');
  }
  ok(think.length > 0, 'reasoning streamed as thinking_delta');
  ok(usage && usage.usage && usage.usage.input_tokens > 0, 'usage.input_tokens > 0 (' + (usage && usage.usage && usage.usage.input_tokens) + ')');
  ok(usage && usage.usage && usage.usage.cached_input_tokens === 100, 'usage.cached_input_tokens = 100 (40+60 from both input_tokens_details.cached_tokens)');
  ok(result && result.ok === true, 'result ok=true');
} catch (e) { console.log('ERROR ' + e.message); fail++; }
finally {
  if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  await sleep(300);
  try { server.close(); } catch { /* ignore */ }
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nRESPONSES-FAKE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
