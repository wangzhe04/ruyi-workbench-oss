'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
process.env.WCW_TEST_LOCAL_PROVIDER_ANCHOR = '1'; // 2026-10:本机假 provider 充当「网络在线」(06 networkAnchors 的测试后门,默认关;生产里本机/内网 provider 不再当联网锚点,见 unit/network-anchors.test.js)
// ─────────────────────────────────────────────────────────────────────────────
// responses-websearch-inline.e2e.js —— 服务端 web_search「同一发里跑完并作答」的形状(百炼 DashScope / OpenAI hosted web_search)
//
// 用户报告(Windows 真机,服务商「Qwen」= 百炼 /responses,qwen3.8-flash,开了 serverWebSearch):工具卡显示「web_search 服务端搜索 · 0.0s 完成」,
// 随后模型却说「web_search 后端这次返空(引擎异常)」,一路退回用 web_fetch 抓 bing 搜索页。
// 根因:04i 把【所有】Responses 服务端搜索都按 DeepSeek 的形状处理 —— DeepSeek 的 /responses 在 web_search_call 之后回复就结束,
// 要把搜索项回传给下一发才续写;而百炼 / OpenAI 的 hosted web_search 在【同一个 response】里搜完、紧跟着就把答案写在 message 里,
// 搜索项回传后不会恢复出任何结果。旧循环于是:① 不把这一发的正文写进历史(只有本地工具调用才推 assistant);② 回传一条没有结果的
// web_search_call 再请求一轮 —— 模型第二发看到的是一条空搜索项,只能认定「后端返空」。
//
// 本件(全离线:真实工作台 runOpenAiTurn → 本地假 /responses 端点)断言修后的行为:
//   A. 搜索项之后同一发里有正文 → 那段正文就是最终回答:只请求 1 次、不回传搜索项、答案写进 providerHistory;
//   B. 工具卡用解析出的真实检索词(action.query 单数)而不是占位词「服务端搜索」,来源(action.sources)带进结果卡;
//   C. 同会话下一回合:历史里带着上一回合的答案、请求里没有 web_search_call 残留;
//   D. DeepSeek 形状(搜索项后回复结束、正文要回传后才来)不受影响:仍回传、仍是两发(守住 responses-websearch-fake 的同一契约)。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createRunner } = require('./lib/harness');
const { startFakeProvider } = require('./lib/fake-openai-provider');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const t = createRunner('RESPONSES-WEBSEARCH-INLINE');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECRET = 'INLINE_SECRET_7741';

function getJson(port, p) {
  return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); });
}
function postStream(port, payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 60000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', () => resolve([])); req.on('timeout', () => { req.destroy(); resolve([]); });
    req.write(data); req.end();
  });
}

// 假 /responses 端点。shape:'inline' = 百炼形(搜索项 + 同发正文);'deepseek' = 搜索项后即结束,回传后才作答。
function responsesFallback(shape, bodies) {
  return (req, res) => {
    const url = req.url || '';
    if (req.method !== 'POST' || !url.includes('/responses')) { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch { /* ignore */ }
      bodies.push(body);
      const input = Array.isArray(body.input) ? body.input : [];
      const hasWsItem = input.some(i => i && i.type === 'web_search_call');
      const hostedTool = (Array.isArray(body.tools) ? body.tools : []).some(x => x && x.type === 'web_search');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const sse = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      sse({ type: 'response.created', response: { id: 'resp_x', status: 'in_progress', output: [] } });
      const answer = (text, id) => {
        sse({ type: 'response.output_item.added', output_index: 1, item: { id, type: 'message', role: 'assistant', content: [] } });
        for (const piece of text.match(/[\s\S]{1,6}/g) || [text]) sse({ type: 'response.output_text.delta', output_index: 1, item_id: id, delta: piece });
        sse({ type: 'response.output_item.done', output_index: 1, item: { id, type: 'message', role: 'assistant', content: [] } });
      };
      const done = () => sse({ type: 'response.completed', response: { id: 'resp_x', status: 'completed', output: [], usage: { input_tokens: 90, output_tokens: 20 } } });
      const lastUser = [...input].reverse().find(i => i && i.role === 'user');
      const wantsSearch = hostedTool && !hasWsItem && JSON.stringify(lastUser || '').includes('联网搜索');
      if (wantsSearch && shape === 'inline') {
        // 百炼形:搜索项(单数 action.query + action.sources)→ 同一发里紧跟答案。
        sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'ws_in_1', type: 'web_search_call', status: 'in_progress' } });
        sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'ws_in_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'qwen3.8 发布时间', sources: [{ type: 'url', url: 'https://a.example/1' }, { type: 'url', url: 'https://b.example/2' }] } } });
        answer('搜索结果显示:密标是 ' + SECRET + '。', 'msg_in_1');
        done();
      } else if (wantsSearch && shape === 'deepseek') {
        // DeepSeek 形:只有搜索项,回复到此结束;回传搜索项的下一发才作答。
        sse({ type: 'response.output_item.added', output_index: 0, item: { id: 'ws_ds_1', type: 'web_search_call', status: 'in_progress' } });
        sse({ type: 'response.output_item.done', output_index: 0, item: { id: 'ws_ds_1', type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['DeepSeek V4'] } } });
        done();
      } else {
        answer(hasWsItem ? '回传后作答:密标 DS_SECRET_5521。' : '第二回合收到。', 'msg_2');
        done();
      }
      res.end();
    });
  };
}

async function runShape(shape) {
  const bodies = [];
  const fake = await startFakeProvider({ models: ['qwen3.8-flash'], fallback: responsesFallback(shape, bodies) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rwsi-' + shape + '-'));
  const work = path.join(home, 'work'); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    stewardThreadBriefV1: false,
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: work,
    providers: [{ id: 'qwen-resp', label: 'Qwen', type: 'openai-compat', apiStyle: 'responses', serverWebSearch: true,
      baseUrl: fake.url, apiKey: 'k', model: 'qwen3.8-flash', models: [{ id: 'qwen3.8-flash', label: 'qwen3.8-flash' }] }],
    activeProvider: 'qwen-resp',
    searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
  }, null, 2));
  const wbPort = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    let h = null; for (let i = 0; i < 300 && !h; i++) { await sleep(150); h = await getJson(wbPort, '/health'); }
    ok(!!h, `[${shape}] workbench listening`);
    const events = await postStream(wbPort, { message: '请联网搜索 qwen3.8 的发布时间,并告诉我搜索结果里的密标。' });
    const sid = (events.find(e => e.type === 'session') || {}).session?.id;
    const toolUses = events.filter(e => e.type === 'tool_use' && e.name === 'web_search');
    const toolResults = events.filter(e => e.type === 'tool_result');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const result = events.find(e => e.type === 'result');
    const first = bodies[0] || {};
    ok(Array.isArray(first.tools) && first.tools.some(x => x && x.type === 'web_search'), `[${shape}] 服务商开了 serverWebSearch → 请求带 hosted {type:'web_search'}`);
    let turn2 = null;
    if (sid) { await sleep(200); turn2 = await getJson(wbPort, '/api/sessions/' + encodeURIComponent(sid)); }
    const ph = (turn2 && turn2.session && turn2.session.providerHistory) || [];
    return { events, toolUses, toolResults, text, result, bodies, sid, ph, wbPort };
  } finally {
    try { killOwnTree(wb); } catch { /* ignore */ }
    await fake.close();
    await sleep(200);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

(async () => {
  try {
    // ── A/B/C:百炼形 ─────────────────────────────────────────────────────────────────────────────
    console.log('=== inline shape (百炼 / OpenAI hosted web_search) ===');
    const a = await runShape('inline');
    ok(a.bodies.length === 1, 'A1 搜索与作答在同一发里 → 只请求 1 次,不为空搜索项再多请求一轮(实际 ' + a.bodies.length + ' 次)');
    ok(a.text.includes(SECRET), 'A2 那一发的正文就是最终回答(密标已显示给用户)');
    ok(a.result && a.result.ok === true, 'A3 回合 result ok:true');
    ok(!a.bodies.some(b => (Array.isArray(b.input) ? b.input : []).some(i => i && i.type === 'web_search_call')), 'A4 没有回传任何 web_search_call 项(这类端点回传了也恢复不出结果)');
    const lastAssistant = [...a.ph].reverse().find(m => m && m.role === 'assistant');
    ok(!!lastAssistant && String(lastAssistant.content || '').includes(SECRET), 'A5 答案写进了 providerHistory(修前纯服务端搜索的回复不进历史,下一发/下一回合模型看不到)');
    const use = a.toolUses[0];
    ok(!!use && use.input && use.input.query === 'qwen3.8 发布时间' && use.input.actionType === 'search', 'B1 工具卡用真实检索词(action.query),不是占位词「服务端搜索」(实际 ' + JSON.stringify(use && use.input && use.input.query) + ')');
    const res = use ? a.toolResults.find(r => r.id === use.id) : null;
    ok(!!res && res.content && res.content.serverSide === true && Array.isArray(res.content.sources) && res.content.sources.length === 2 && res.content.sources[0] === 'https://a.example/1',
      'B2 结果卡带来源 URL(action.sources)');
    ok(!!res && res.isError !== true, 'B3 结果卡不是错误');

    // ── C:同会话下一回合 ────────────────────────────────────────────────────────────────────────
    // (会话在上面已随 runShape 收掉;C 用同一形状再起一次,连发两回合)
    console.log('=== inline shape, second turn in the same session ===');
    {
      const bodies = [];
      const fake = await startFakeProvider({ models: ['qwen3.8-flash'], fallback: responsesFallback('inline', bodies) });
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rwsi-c-'));
      const work = path.join(home, 'work'); fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        stewardThreadBriefV1: false, configSchema: 6, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: work,
        providers: [{ id: 'qwen-resp', label: 'Qwen', type: 'openai-compat', apiStyle: 'responses', serverWebSearch: true, baseUrl: fake.url, apiKey: 'k', model: 'qwen3.8-flash', models: [{ id: 'qwen3.8-flash', label: 'qwen3.8-flash' }] }],
        activeProvider: 'qwen-resp', searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
      }, null, 2));
      const wbPort = await getFreePort();
      const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home }, windowsHide: true });
      wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
      try {
        let h = null; for (let i = 0; i < 300 && !h; i++) { await sleep(150); h = await getJson(wbPort, '/health'); }
        ok(!!h, '[inline/C] workbench listening');
        const e1 = await postStream(wbPort, { message: '请联网搜索 qwen3.8 的发布时间。' });
        const sid = (e1.find(e => e.type === 'session') || {}).session?.id;
        const n1 = bodies.length;
        const e2 = await postStream(wbPort, { sessionId: sid, message: '谢谢,上一条的密标是什么?' });
        const second = bodies[n1] || {};
        const inputText = JSON.stringify(second.input || []);
        ok(inputText.includes(SECRET), 'C1 下一回合的请求历史里带着上一回合的答案(密标)');
        ok(!(Array.isArray(second.input) ? second.input : []).some(i => i && i.type === 'web_search_call'), 'C2 下一回合请求里没有 web_search_call 残留');
        ok(e2.some(e => e.type === 'result' && e.ok === true), 'C3 第二回合 result ok:true');
      } finally {
        try { killOwnTree(wb); } catch { /* ignore */ }
        await fake.close(); await sleep(200);
        fs.rmSync(home, { recursive: true, force: true });
      }
    }

    // ── D:DeepSeek 形不变 ───────────────────────────────────────────────────────────────────────
    console.log('=== deepseek shape (search item, then the reply ends; answer comes after the echo) ===');
    const d = await runShape('deepseek');
    ok(d.bodies.length === 2, 'D1 DeepSeek 形仍是两发(回传搜索项后才作答;实际 ' + d.bodies.length + ' 次)');
    const echoed = (d.bodies[1] && Array.isArray(d.bodies[1].input) ? d.bodies[1].input : []).filter(i => i && i.type === 'web_search_call');
    ok(echoed.length === 1 && echoed[0].id === 'ws_ds_1', 'D2 DeepSeek 形仍回传搜索项原件');
    ok(d.text.includes('DS_SECRET_5521'), 'D3 回传后的作答显示给用户');
    const dUse = d.toolUses[0];
    ok(!!dUse && dUse.input && dUse.input.query === 'DeepSeek V4', 'D4 DeepSeek 的 action.queries 解析不变');
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    t.done({ exit: true });
  }
})();
