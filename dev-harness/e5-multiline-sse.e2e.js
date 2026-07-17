// E2E (E5): SSE events whose JSON payload is spread across MULTIPLE `data:` lines within one event. Per the
// WHATWG SSE spec, consecutive `data:` field lines of one event concatenate (joined by '\n') into a single
// payload before parsing; intranet proxies / self-hosted gateways sometimes re-frame streams this way. The old
// parser split on every '\n' and JSON.parsed each `data:` line alone, so each partial line failed to parse and
// the WHOLE frame was dropped. The fixed parser reassembles the event. This test runs plain chat + a tool loop
// against a fake that emits every frame as multi-line data, asserting content/reasoning arrive intact.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-e5-multiline-e2e');
const TOOLFILE = path.join(HOME, 'read-me.txt');
const MARKER = 'MULTILINE_SSE_TOOL_OK_88';

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(TOOLFILE, MARKER);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: true }],
  activeProvider: 'fake',
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
  // FAKE_MULTILINE_DATA re-frames EVERY streamed frame as multi-line `data:` lines. FAKE_TOOL_PATH also drives
  // a tool loop so the multi-line reassembly is exercised on tool_call fragments too, not just plain text.
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_MULTILINE_DATA: '1', FAKE_TOOL_PATH: TOOLFILE }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // Tool-loop turn: first request streams a multi-line tool_call, second echoes the tool result — both must
    // reassemble losslessly.
    const events = await postStream(WB_PORT, { message: '读取文件并回显', cwd: HOME });
    const toolUse = events.find(e => e.type === 'tool_use' && e.name === 'file_read');
    ok(!!toolUse, 'multi-line tool_call reassembled — file_read tool_use emitted');
    ok(toolUse && toolUse.input && toolUse.input.path === TOOLFILE, 'tool_call arguments intact across the multi-line split (path correct)');
    const toolResult = events.find(e => e.type === 'tool_result');
    ok(toolResult && toolResult.isError !== true, 'tool_result ok');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    ok(text.includes(MARKER), 'final answer (multi-line frames) echoes real file content intact — ' + JSON.stringify(text.slice(0, 60)));
    const usage = events.find(e => e.type === 'usage');
    ok(usage && usage.contextTokens === 57 && !usage.estimated, 'real usage frame (multi-line) parsed: contextTokens=57, not estimated');
    const result = events.find(e => e.type === 'result');
    ok(result && result.ok === true, 'result ok=true');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nE5-MULTILINE-SSE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
