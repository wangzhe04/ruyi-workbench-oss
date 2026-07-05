// LIVE E2E: real workbench (runOpenAiTurn) -> real DeepSeek API. Key via argv; temp config wiped after.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const KEY = process.argv[2];
const MODEL = process.argv[3] || 'deepseek-v4-pro';
const WB_PORT = 8795;
const HOME = path.join(os.tmpdir(), 'wcw-deepseek-e2e');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '0.5.0', permissionMode: 'bypass',
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
    ok(!!h, 'workbench listening on :' + WB_PORT);
    console.log('--- sending real prompt to ' + MODEL + ' ---');
    const events = await postStream(WB_PORT, { message: '用一句中文介绍你自己，并说出你的模型名。' });
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    const think = events.filter(e => e.type === 'thinking_delta').map(e => e.text).join('');
    const usage = events.find(e => e.type === 'usage');
    const result = events.find(e => e.type === 'result');
    const errEvt = events.find(e => e.type === 'error') || (result && result.error ? result : null);
    ok(text.length > 0, 'real assistant text: ' + JSON.stringify(text.slice(0, 60)));
    ok(think.length > 0, 'real reasoning streamed (' + think.length + ' chars): ' + JSON.stringify(think.slice(0, 40)));
    ok(usage && usage.contextTokens > 0, 'usage.contextTokens=' + (usage && usage.contextTokens));
    ok(result && result.ok === true, 'result ok=true' + (errEvt ? ' ERR=' + JSON.stringify(errEvt.error) : ''));
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true }); // wipe temp config (contains the key)
    console.log('\nDEEPSEEK-LIVE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
