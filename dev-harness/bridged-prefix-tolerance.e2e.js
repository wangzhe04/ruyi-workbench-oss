// E2E (v1.4.1): 桥接工具「前缀容错路由」。部分 provider 模型(实测 qwen)会丢掉 `<serverId>__` 前缀,
// 直接调裸名 `excel_read` —— 旧代码命不中 bridgedRoute → 内建兜底报「Unknown tool: excel_read」。
// resolveBridge 宽容解析:精确前缀优先 / 内建名不被遮蔽 / 裸名唯一命中桥接则路由 / 歧义不猜。
//
// (A) 纯单元(无 spawn、无 python,恒跑):resolveBridge 五情形。
// (B) 实弹(best-effort,需真 ACC python):fake-openai 发【裸名 diagnostics】→ 经桥回真 ACC → 版本 1.8.0,
//     不再是「Unknown tool」。python/依赖缺失 → SKIP,不算失败。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const REPO = [path.resolve(__dirname, '..', 'ai-computer-control'), path.resolve(__dirname, '..', 'mcp', 'ai-computer-control')]
  .find(p => fs.existsSync(p)) || path.resolve(__dirname, '..', 'mcp', 'ai-computer-control');
const HERE = __dirname;
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const { resolveBridge, collectBridgedWriteTargets } = srv;

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────── (A) unit: resolveBridge ─────────────────
(function unit() {
  ok(typeof resolveBridge === 'function', '(A) resolveBridge exported');
  const route = {
    'ai_computer_control__excel_read': { serverId: 'ai-computer-control', toolName: 'excel_read' },
    'ai_computer_control__write_pptx': { serverId: 'ai-computer-control', toolName: 'write_pptx' },
    'ai_computer_control__file_read':  { serverId: 'ai-computer-control', toolName: 'file_read' }, // 与内建同名(测遮蔽)
  };
  // ① 精确前缀名
  ok(resolveBridge(route, 'ai_computer_control__excel_read')?.toolName === 'excel_read', '(A①) 精确前缀名命中');
  // ② 裸名唯一命中 → 容错路由(THE FIX)
  ok(resolveBridge(route, 'excel_read')?.toolName === 'excel_read', '(A②) 裸名 excel_read 容错路由到桥接工具');
  ok(resolveBridge(route, 'write_pptx')?.toolName === 'write_pptx', '(A②) 裸名 write_pptx 容错路由');
  // ③ 内建名不被桥接遮蔽:file_read 是内建 → 返回 null(走内建路径),即便桥接里有同名
  ok(resolveBridge(route, 'file_read') === null, '(A③) 内建名 file_read 不被桥接遮蔽(→null 走内建)');
  // ④ 歧义(两 server 同名 toolName)→ 不猜
  const amb = {
    'srvA__screenshot': { serverId: 'A', toolName: 'screenshot' },
    'srvB__screenshot': { serverId: 'B', toolName: 'screenshot' },
  };
  ok(resolveBridge(amb, 'screenshot') === null, '(A④) 裸名歧义(≥2 同名)→ 不猜返回 null');
  // ⑤ 未知裸名 → null
  ok(resolveBridge(route, 'totally_unknown_tool') === null, '(A⑤) 未知裸名 → null');
  ok(resolveBridge(route, '') === null && resolveBridge(null, 'x') === null, '(A⑤) 空输入安全 → null');
  // ⑥ 连带风险防回潮:前缀容错让主循环可能以【裸名】调 journalBridgedWrite(tc.name)。快照表按去前缀名查,
  //    裸名必须照样命中,否则裸名写操作不进检查点=不可撤销(信任层漏洞)。
  const abs = process.platform === 'win32' ? 'C:\\tmp\\x.xlsx' : '/tmp/x.xlsx';
  const bareTargets = collectBridgedWriteTargets('write_excel', { path: abs });        // 裸名
  const prefTargets = collectBridgedWriteTargets('ai_computer_control__write_excel', { path: abs }); // 前缀名
  ok(bareTargets.length === 1 && bareTargets[0].path === abs, '(A⑥) 裸名 write_excel 仍进快照表(检查点不漏)');
  ok(prefTargets.length === 1, '(A⑥) 前缀名 write_excel 快照表命中(行为不变)');
})();

// ───────────────── (B) live: bare `diagnostics` through the real ACC bridge ─────────────────
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postStream(port, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', () => resolve([])); req.write(data); req.end();
  });
}

(async () => {
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  const HOME = path.join(os.tmpdir(), 'wcw-prefix-tol-e2e');
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 5, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fakeprov', label: 'FakeProv', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fakeprov',
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [{ id: 'acc', label: 'Desktop', command: process.platform === 'win32' ? 'python' : 'python3', args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: REPO, env: { PYTHONPATH: path.join(REPO, 'src'), PYTHONUTF8: '1' }, enabled: true }],
    bridgeExternalToolsToProvider: true,
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_NAME: 'diagnostics', FAKE_TOOL_ARGS: '{}' }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    if (!h) { console.log('SKIP (B) workbench did not start'); }
    else {
      const events = await postStream(WB_PORT, { message: '请调用诊断工具' });
      const meta = events.find(e => e.type === 'meta');
      const toolUse = events.find(e => e.type === 'tool_use' && e.name === 'diagnostics');
      const toolResult = events.find(e => e.type === 'tool_result');
      const resStr = toolResult ? JSON.stringify(toolResult.content) : '';
      const bridged = meta && meta.bridgedTools;
      if (!(bridged >= 80)) { console.log('SKIP (B) real ACC not bridged (python/deps missing?) bridgedTools=' + bridged); }
      else {
        ok(!!toolUse, '(B) model emitted BARE `diagnostics` (no prefix)');
        ok(toolResult && toolResult.isError !== true, '(B) bare call NOT an error (was: Unknown tool)');
        ok(!/Unknown tool/i.test(resStr), '(B) result is not「Unknown tool」');
        // 第23波: ACC 版本动态读自其 server.py,不再硬编码(存量过期断言——ACC 已升 1.8.1)。
        const accVer = (() => { try { const m = fs.readFileSync(path.join(REPO, 'src', 'ai_computer_control', 'server.py'), 'utf8').match(/VERSION\s*=\s*["']([\d.]+)["']/); return m ? m[1] : ''; } catch { return ''; } })();
        ok(!!accVer && resStr.includes(accVer), '(B) bare `diagnostics` routed to real ACC → version ' + (accVer || '(ACC server.py 未读到版本)'));
      }
    }
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(400); fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nBRIDGED-PREFIX-TOLERANCE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
