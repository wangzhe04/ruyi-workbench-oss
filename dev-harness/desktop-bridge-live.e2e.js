(async () => {
// DECISIVE LIVE E2E: a provider model (fake-openai) calls a REAL ai-computer-control tool through the
// workbench's native MCP bridge. Proves model -> workbench -> McpStdioClient -> real python desktop MCP
// child -> real result -> fed back. Uses `diagnostics` (returns version + tool_count from the real server).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const REPO = [path.resolve(__dirname, '..', 'ai-computer-control'), path.resolve(__dirname, '..', 'mcp', 'ai-computer-control')]
  .find(p => fs.existsSync(p)) || path.resolve(__dirname, '..', 'mcp', 'ai-computer-control');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-desktop-bridge-e2e');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 5, version: '1.0.0', permissionMode: 'bypass',
  providers: [{ id: 'fakeprov', label: 'FakeProv', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  activeProvider: 'fakeprov',
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  externalMcpServers: [{ id: 'acc', label: 'Desktop', command: 'python', args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: REPO, env: { PYTHONPATH: path.join(REPO, 'src'), PYTHONUTF8: '1' }, enabled: true }],
  bridgeExternalToolsToProvider: true,
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

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_NAME: 'acc__diagnostics', FAKE_TOOL_ARGS: '{}' }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening');
    console.log('--- driving a provider turn that calls acc__diagnostics (real desktop MCP) ---');
    const events = await postStream(WB_PORT, { message: '请调用桌面诊断工具' });
    const meta = events.find(e => e.type === 'meta');
    const toolUse = events.find(e => e.type === 'tool_use' && e.name === 'acc__diagnostics');
    const toolResult = events.find(e => e.type === 'tool_result');
    const result = events.find(e => e.type === 'result');
    const resStr = toolResult ? JSON.stringify(toolResult.content) : '';
    console.log('--- meta.bridgedTools =', meta && meta.bridgedTools);
    console.log('--- tool_result.content (first 260):', resStr.slice(0, 260));
    ok(meta && meta.bridgedTools >= 80, 'bridge collected the real desktop tools (bridgedTools=' + (meta && meta.bridgedTools) + ')');
    ok(!!toolUse, 'model called bridged real tool acc__diagnostics');
    ok(toolResult && toolResult.isError !== true, 'tool_result not error');
    ok(/1\.8\.0/.test(resStr), 'real diagnostics version 1.8.0 came back through the bridge');
    ok(/83|tool_count/.test(resStr), 'real diagnostics tool_count present');
    ok(result && result.ok === true, 'turn result ok=true');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(400);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nDESKTOP-BRIDGE-LIVE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
