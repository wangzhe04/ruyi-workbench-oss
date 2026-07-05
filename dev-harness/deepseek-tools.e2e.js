// LIVE tool-loop E2E: real DeepSeek v4-pro must call file_read (function calling) on a real temp file
// and report its secret marker. Proves real function-calling through the workbench agent loop.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const KEY = process.argv[2];
const MODEL = process.argv[3] || 'deepseek-v4-pro';
const WB_PORT = 8797;
const HOME = path.join(os.tmpdir(), 'wcw-ds-tools-e2e');
const WORK = path.join(HOME, 'work');
const SECRET = 'ZX_SECRET_TOKEN_9931';
const FILE = path.join(WORK, 'secret.txt');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(FILE, 'The secret marker is ' + SECRET + '. Report it exactly.');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '0.6.0', permissionMode: 'bypass', defaultWorkspace: WORK,
  providers: [{ id: 'deepseek', label: 'DeepSeek', type: 'openai-compat', baseUrl: 'https://api.deepseek.com', apiKey: KEY, model: MODEL, models: [{ id: MODEL, label: MODEL }], reasoning: true }],
  activeProvider: 'deepseek',
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
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening');
    const prompt = `请用 file_read 工具读取文件 ${FILE.replace(/\\/g, '\\\\')} 的内容，然后把里面的密标记字符串原样告诉我。`;
    console.log('--- prompt: ' + prompt);
    const events = await postStream(WB_PORT, { message: prompt });
    const toolUses = events.filter(e => e.type === 'tool_use');
    const toolResults = events.filter(e => e.type === 'tool_result');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const think = events.filter(e => e.type === 'thinking_delta').map(e => e.text).join('');
    const result = events.find(e => e.type === 'result');
    console.log('--- tool_uses: ' + JSON.stringify(toolUses.map(t => t.name)));
    console.log('--- final text: ' + JSON.stringify(text.slice(0, 200)));
    ok(toolUses.some(t => t.name === 'file_read'), 'DeepSeek called file_read (real function calling)');
    ok(toolResults.length > 0 && toolResults.every(r => r.isError !== true), 'tool_result(s) ok');
    ok(text.includes(SECRET), 'final answer contains the secret marker (proves loop fed tool result back)');
    ok(result && result.ok === true, 'result ok=true');
    ok(think.length >= 0, 'reasoning chars=' + think.length);
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true }); // wipe temp config (contains the key)
    console.log('\nDEEPSEEK-TOOLS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
