// LIVE probe: DeepSeek Responses API server-side `web_search` tool vs Ruyi's LOCAL web_search tool.
//
// Part A (server-side): POST https://api.deepseek.com/responses directly with tools:[{type:"web_search"}],
//   streaming — watch for web_search_call.in_progress/searching/completed events, the recovered search
//   results, final answer, and usage. (Bypasses Ruyi on purpose: Ruyi flattens its own web_search into a
//   function tool, so the server-side tool can never fire through the workbench engine.)
// Part B (local): real workbench + chat protocol + builtin web_search function tool, same query.
//
// Usage: node dev-harness/deepseek-ws-probe.js <API_KEY> ["query"]
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const KEY = process.argv[2];
const QUERY = process.argv[3] || 'DeepSeek v4 最新模型 2026年8月';
if (!KEY) { console.error('Usage: node dev-harness/deepseek-ws-probe.js <DEEPSEEK_API_KEY> ["query"]'); process.exit(2); }

const MODEL = 'deepseek-v4-flash';
const PRICING = { inputPerM: 1, outputPerM: 2, cachedInputPerM: 0.02 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Part A: server-side web_search via raw /responses ────────────────────────
async function partA() {
  console.log(`\n=== PART A: DeepSeek 服务端 web_search (raw /responses) ===`);
  console.log(`query: ${QUERY}`);
  const started = Date.now();
  const res = await fetch('https://api.deepseek.com/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      instructions: '你是一个联网助手。用户给你查询词时，先用 web_search 搜索，再基于搜索结果简洁回答。',
      input: QUERY,
      tools: [{ type: 'web_search' }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    console.log(`HTTP ${res.status}: ${t.slice(0, 400)}`);
    return { ok: false, error: `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', outputText = '', firstEventMs = null, firstTextMs = null;
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let e; try { e = JSON.parse(payload); } catch { continue; }
      if (firstEventMs === null) firstEventMs = Date.now() - started;
      events.push(e);
      if (e.type === 'response.output_text.delta' && e.delta) { if (firstTextMs === null) firstTextMs = Date.now() - started; outputText += e.delta; }
    }
  }
  const wallMs = Date.now() - started;
  const types = events.map(e => e.type);
  const wsEvents = events.filter(e => String(e.type).startsWith('response.web_search_call'));
  const wsItems = events.filter(e => e.type === 'response.output_item.done' && e.item && e.item.type === 'web_search_call');
  const completed = events.find(e => e.type === 'response.completed');
  const usage = (completed && completed.response && completed.response.usage) || {};
  const cost = ((Number(usage.input_tokens) || 0) - (Number((usage.input_tokens_details || {}).cached_tokens) || 0)) / 1e6 * PRICING.inputPerM
    + (Number((usage.input_tokens_details || {}).cached_tokens) || 0) / 1e6 * PRICING.cachedInputPerM
    + (Number(usage.output_tokens) || 0) / 1e6 * PRICING.outputPerM;

  console.log(`耗时: ${wallMs}ms (首事件 ${firstEventMs}ms, 首文本 ${firstTextMs}ms)`);
  console.log(`事件类型序列: ${[...new Set(types)].join(' | ')}`);
  console.log(`web_search_call 事件数: ${wsEvents.length}`);
  wsItems.forEach((it, i) => {
    const id = it.item && it.item.id;
    console.log(`  web_search_call item #${i}: id=${id}`);
  });
  console.log(`最终回答(前300字): ${JSON.stringify(outputText.slice(0, 300))}`);
  console.log(`usage: input=${usage.input_tokens} cached=${(usage.input_tokens_details || {}).cached_tokens} output=${usage.output_tokens} reasoning=${(usage.output_tokens_details || {}).reasoning_tokens}`);
  console.log(`估算成本: ¥${cost.toFixed(4)}`);
  return { ok: true, wallMs, firstTextMs, wsEvents: wsEvents.length, wsItems: wsItems.length, usage, outputText: outputText.slice(0, 300), types: [...new Set(types)] };
}

// ── Part B: Ruyi local web_search (builtin backend) via real workbench ───────
async function partB() {
  console.log(`\n=== PART B: Ruyi 本地 web_search (builtin 后端, 真实工作台引擎) ===`);
  const port = await getFreePort();
  const home = path.join(os.tmpdir(), 'wcw-ws-probe');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 4, version: '0.6.0', permissionMode: 'bypass', defaultWorkspace: home,
    providers: [{ id: 'deepseek', label: 'DeepSeek', type: 'openai-compat', apiStyle: 'chat',
      baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: MODEL, models: [{ id: MODEL, label: MODEL }], reasoning: true }],
    activeProvider: 'deepseek',
    // builtin = zero-config Bing CN scrape backend (default when absent).
    searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
  }, null, 2));

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); }
    if (!h) throw new Error('workbench not listening');
    const started = Date.now();
    const { events } = await postStream(port, { message: `请用 web_search 工具搜索「${QUERY}」，然后基于搜索结果用中文简短回答。` });
    const wallMs = Date.now() - started;
    const toolUses = events.filter(e => e.type === 'tool_use');
    const toolResults = events.filter(e => e.type === 'tool_result');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const usages = events.filter(e => e.type === 'usage');
    const usage = { input: 0, output: 0, cached: 0 };
    for (const u of usages) { const gu = (u && u.usage) || {}; usage.input += Number(gu.input_tokens || 0); usage.output += Number(gu.output_tokens || 0); usage.cached += Number(gu.cached_input_tokens || 0); }
    const cost = (usage.input - usage.cached) / 1e6 * PRICING.inputPerM + usage.cached / 1e6 * PRICING.cachedInputPerM + usage.output / 1e6 * PRICING.outputPerM;
    const wsResult = toolResults.find(r => r && r.name === 'web_search');
    const wsPayload = wsResult && wsResult.content;
    let parsed = null; try { parsed = typeof wsPayload === 'string' ? JSON.parse(wsPayload) : wsPayload; } catch { /* keep null */ }
    const hits = (parsed && Array.isArray(parsed.results)) ? parsed.results.length : 0;
    const firstHit = hits ? parsed.results[0] : null;
    console.log(`耗时: ${wallMs}ms`);
    console.log(`工具调用: ${JSON.stringify(toolUses.map(t => t.name))}`);
    console.log(`web_search 返回条数: ${hits}${firstHit ? ' (首条: ' + String(firstHit.title).slice(0, 60) + ')' : ''}`);
    console.log(`最终回答(前300字): ${JSON.stringify(text.slice(0, 300))}`);
    console.log(`usage: input=${usage.input} cached=${usage.cached} output=${usage.output}`);
    console.log(`估算成本: ¥${cost.toFixed(4)}`);
    return { ok: true, wallMs, hits, firstHit: firstHit ? String(firstHit.title).slice(0, 60) : null, usage, text: text.slice(0, 300) };
  } finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300); fs.rmSync(home, { recursive: true, force: true });
  }
}

function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve({ events }); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  const a = await partA().catch(e => ({ ok: false, error: e && e.message }));
  const b = await partB().catch(e => ({ ok: false, error: e && e.message }));
  const outDir = path.join(__dirname, 'ab-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = { model: MODEL, query: QUERY, at: new Date().toISOString(), pricing: PRICING, serverSide: a, localRuyi: b };
  fs.writeFileSync(path.join(outDir, `ws-probe-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nReport: ${path.join(outDir, `ws-probe-${stamp}.json`)}`);
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
