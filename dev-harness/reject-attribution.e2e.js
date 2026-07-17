// E2E for v0.9-S0 400 归因收紧 (§0.9-S0): openAiStreamOnce must attribute a tools-bearing 400 to
// tools-rejected FIRST — even when the error wording ALSO matches the stream_options sniff
// (/not\s*support/i etc.). The v0.8 收官遗留 bug: a provider that said "tools are not supported here"
// tripped the stream_options regex, so the workbench stripped stream_options and RETRIED WITH TOOLS,
// looping on the same 400. The fix routes it to the tools-rejected retry (retry once WITHOUT tools).
//
// Ports 8993 (fake-openai) + 8994 (workbench). Uses FAKE_REJECT_TOOLS + FAKE_REJECT_TOOLS_WORDING to
// inject the misjudged wording, and FAKE_CAPTURE_DIR to prove the retry request carried no `tools`.
//
// Scenarios:
//   ①  FAKE_REJECT_TOOLS_WORDING='tools are not supported here' (the OLD misjudged shape — hits BOTH the
//      tool/function sniff AND the stream_options sniff) → the turn still completes ok:true, the stream
//      notes "tools rejected", and the 2nd captured request has NO tools field (retry dropped tools).
//   ②  DEFAULT wording (no override) → same tools-rejected behavior (regression of the existing shape).
//   ③  No-tools request path unaffected: a source-level assertion that the stream_options branch is still
//      guarded to fire only when the request is NOT a tools/function 400 (the `requestHasTools` guard
//      leaves the stream_options retry intact for tool-less requests). The live no-tools 400 is not
//      reproducible offline (the fake only rejects tools-bearing requests), so §0.9-S0 permits
//      code-review coverage here — this asserts the exact guard text.
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
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
function readCaptures(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^req-\d+\.json$/.test(f)).sort()
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}
function seedConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }] }],
    activeProvider: 'fake',
  }, null, 2));
}

// One scenario: spin a fake (reject flag + optional wording override + capture dir) + a fresh WB, run one
// turn, and assert the tools-rejected retry fired and the retry request carried no tools.
async function runRejectScenario({ label, wording, ok }) {
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  const HOME = path.join(os.tmpdir(), 'wcw-reject-attr-e2e-' + label.replace(/[^a-z0-9]/gi, ''));
  const CAP_DIR = path.join(HOME, 'captures');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  seedConfig(HOME, FAKE_PORT);
  const fakeEnv = { ...process.env, FAKE_REJECT_TOOLS: '1', FAKE_CAPTURE_DIR: CAP_DIR };
  if (wording) fakeEnv.FAKE_REJECT_TOOLS_WORDING = wording;
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true, env: fakeEnv });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, '(' + label + ') workbench listening');
    const events = await postStream(WB_PORT, { message: 'hello there' });
    const meta = events.find(e => e.type === 'meta');
    ok(meta && meta.tools > 0, '(' + label + ') meta reports tools>0 (tools offered before rejection)');
    const result = events.find(e => e.type === 'result');
    ok(result && result.ok === true, '(' + label + ') turn completes ok:true after tools-rejected retry');
    const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    ok(text.trim().length > 0, '(' + label + ') streamed a reply on the retry ("' + text.slice(0, 24).replace(/\n/g, ' ') + '")');
    const stderrTexts = events.filter(e => e.type === 'stderr').map(e => e.text).join(' | ');
    ok(/tools rejected/i.test(stderrTexts), '(' + label + ') tools-rejected retry note observed (NOT a stream_options loop)');
    const caps = readCaptures(CAP_DIR);
    ok(caps.length >= 2, '(' + label + ') ≥2 requests captured (rejected + retry) (' + caps.length + ')');
    const first = caps[0], second = caps[caps.length - 1];
    ok(Array.isArray(first.tools) && first.tools.length > 0, '(' + label + ') FIRST request carried tools (the one that was rejected)');
    ok(!second.tools || second.tools.length === 0, '(' + label + ') retry request carried NO tools field (tools-rejected branch, not a WITH-tools retry)');
    // Key regression proof: the fake rejected EXACTLY once. If the workbench had misrouted this to the
    // stream_options path it would have retried WITH tools and hit a SECOND 400 (rejectedOnce is one-shot,
    // so a 2nd tools request would stream normally — but then `hadNoTools` would be false). The no-tools
    // retry is the only shape that both completes ok AND drops tools.
  } finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ① OLD misjudged wording: "tools are not supported here" matches BOTH sniffs. Must still → tools-rejected.
  await runRejectScenario({ label: 'old-wording', wording: 'tools are not supported here', ok });

  // ② DEFAULT wording (no override) — regression of the existing tools-rejected shape.
  await runRejectScenario({ label: 'default-wording', wording: '', ok });

  // ③ No-tools path unaffected — source-level guard assertion (§0.9-S0 allows code-review coverage; a
  // no-tools 400 is not reproducible offline). Assert the fix keeps the stream_options retry reachable
  // ONLY when the 400 is not a tools/function rejection, guarded by `requestHasTools`.
  {
    const src = fs.readFileSync(path.join(WB, 'app', 'server.js'), 'utf8');
    // String.raw keeps the single backslash in `not\s*support` exact (a regex literal here is brittle).
    ok(src.includes('const requestHasTools = Array.isArray(body.tools) && body.tools.length > 0;'),
      '(no-tools) requestHasTools guard present (tools-first branch cannot fire for tool-less requests)');
    ok(src.includes('if (requestHasTools && toolsSemantics) {'),
      '(no-tools) tools-rejected priority is gated on requestHasTools (no-tools 400 skips it)');
    ok(src.includes(String.raw`if (body.stream_options && /stream_options|unsupported|unknown|invalid|not\s*support/i.test(t)) {`),
      '(no-tools) stream_options retry branch preserved (still reachable for non-tools 400s)');
  }

  console.log('\nREJECT-ATTRIBUTION E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
