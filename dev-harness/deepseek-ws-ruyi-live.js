// LIVE E2E: real workbench (runOpenAiTurn, apiStyle:'responses') -> real DeepSeek /responses,
// with the v1.8 web_search server-side tool mapping. The model must fire a web_search_call; Ruyi must
// surface tool_use('web_search') with a serverSide result (NO local execution) and still answer.
// Usage: node dev-harness/deepseek-ws-ruyi-live.js <DEEPSEEK_API_KEY> ["query"]
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const KEY = process.argv[2];
const QUERY = process.argv[3] || 'DeepSeek V4 最新模型 2026年8月';
if (!KEY) { console.error('Usage: node dev-harness/deepseek-ws-ruyi-live.js <DEEPSEEK_API_KEY> ["query"]'); process.exit(2); }
const MODEL = 'deepseek-v4-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const port = await getFreePort();
  const home = path.join(os.tmpdir(), 'wcw-ws-ruyi-live');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 4, version: '0.6.0', permissionMode: 'bypass', defaultWorkspace: home,
    providers: [{ id: 'deepseek', label: 'DeepSeek', type: 'openai-compat', apiStyle: 'responses',
      serverWebSearch: true, // v1.8.2: DeepSeek 预设声明支持服务端 web_search
      baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: MODEL, models: [{ id: MODEL, label: MODEL }], reasoning: true }],
    activeProvider: 'deepseek',
    searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' },
  }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); }
    ok(!!h, 'workbench listening');
    const started = Date.now();
    const { events } = await postStream(port, { message: `请联网搜索「${QUERY}」，基于搜索结果用中文简短回答，并明确说明你使用了联网搜索。` });
    const wallMs = Date.now() - started;
    const toolUses = events.filter(e => e.type === 'tool_use');
    const toolResults = events.filter(e => e.type === 'tool_result');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const result = events.find(e => e.type === 'result');
    const usage = events.filter(e => e.type === 'usage');
    console.log('--- tool_uses: ' + JSON.stringify(toolUses.map(t => ({ name: t.name, input: t.input }))));
    console.log('--- tool_results: ' + JSON.stringify(toolResults.map(r => ({ id: r.id, serverSide: r.content && r.content.serverSide, isError: r.isError }))));
    console.log('--- final text (前200字): ' + JSON.stringify(text.slice(0, 200)));
    console.log('--- 耗时: ' + wallMs + 'ms; usage 事件数: ' + usage.length);
    const wsUse = toolUses.find(t => t.name === 'web_search');
    ok(!!wsUse, '模型发起了服务端 web_search (tool_use web_search)');
    if (wsUse) {
      const wsResult = toolResults.find(r => r.id === wsUse.id);
      ok(!!wsResult && wsResult.content && wsResult.content.serverSide === true && wsResult.isError !== true, 'web_search 结果 serverSide=true 且未本地执行');
    }
    ok(text.length > 20, '模型给出了基于搜索的回答 (chars=' + text.length + ')');
    ok(result && result.ok === true, 'result ok=true');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(home, { recursive: true, force: true });
    console.log('\nDEEPSEEK-WS-RUYI-LIVE: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });

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
