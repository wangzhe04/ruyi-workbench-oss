// E2E (v0.8-S0): usage accumulation across a multi-call turn. The fake provider's file_read flow makes
// TWO API calls in one turn (call 1 requests file_read; call 2 echoes the result), each reporting the
// same usage frame. Asserts the `usage` event's input_tokens equals the SUM of both prompt_tokens and
// that calls === 2 (old behavior was last-write-wins → would have reported a single call's tokens).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-usage-accum-e2e');
const TOOLFILE = path.join(HOME, 'read-me.txt');

// Expected values derived from fake-openai.js usageFrame(): prompt_tokens 42, completion_tokens 15 per
// call; the file_read flow emits exactly 2 usage frames per turn.
const PER_CALL_PROMPT = 42, PER_CALL_COMPLETION = 15, CALLS = 2;
const EXPECT_INPUT = PER_CALL_PROMPT * CALLS;   // 84
const EXPECT_OUTPUT = PER_CALL_COMPLETION * CALLS; // 30

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(TOOLFILE, 'usage accumulation fixture');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '0.7.0', permissionMode: 'bypass',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
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
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_PATH: TOOLFILE }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    ok(h && h.version === require(require('path').resolve(__dirname,'..','ruyi-workbench','package.json')).version, 'version === package.json (got ' + (h && h.version) + ')'); // 第23波: 动态读

    const events = await postStream(WB_PORT, { message: '请读取文件并回显', cwd: HOME });
    const toolUse = events.find(e => e.type === 'tool_use' && e.name === 'file_read');
    ok(!!toolUse, 'file_read tool_use emitted (confirms 2-call flow)');
    const usage = events.find(e => e.type === 'usage');
    ok(!!usage, 'usage event emitted');
    const inTok = usage && usage.usage && usage.usage.input_tokens;
    const outTok = usage && usage.usage && usage.usage.output_tokens;
    ok(inTok === EXPECT_INPUT, 'usage.input_tokens === sum of both calls (' + EXPECT_INPUT + '), got ' + inTok);
    ok(outTok === EXPECT_OUTPUT, 'usage.output_tokens === sum of both calls (' + EXPECT_OUTPUT + '), got ' + outTok);
    ok(usage && usage.calls === CALLS, 'usage.calls === ' + CALLS + ' (got ' + (usage && usage.calls) + ')');
    const result = events.find(e => e.type === 'result');
    ok(result && result.ok === true, 'result ok=true');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nUSAGE-ACCUM E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
