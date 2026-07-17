// E2E (E1): PARALLEL tool_calls streamed WITHOUT `index`. Some vLLM/Ollama/self-hosted OpenAI-compat
// endpoints emit several concurrent tool_calls whose delta fragments omit the `index` field (and some repeat
// the id on every fragment while others send it once then bare continuations). The old parser defaulted every
// index-less fragment to acc[0], so the two calls' names merged ("file_readfile_read") and their JSON args
// concatenated into one unparseable blob. The fix aggregates by tool_call id. This test drives two parallel
// file_read calls over DISTINCT files and asserts each is parsed independently (correct, non-crossed paths).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-e1-noindex-e2e');
const FILE_A = path.join(HOME, 'alpha.txt'), FILE_B = path.join(HOME, 'beta.txt');
const MARK_A = 'ALPHA_CONTENT_11', MARK_B = 'BETA_CONTENT_22';

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(FILE_A, MARK_A);
fs.writeFileSync(FILE_B, MARK_B);
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
  const par = JSON.stringify([
    { name: 'file_read', args: { path: FILE_A } },
    { name: 'file_read', args: { path: FILE_B } },
  ]);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_PARALLEL_TOOLS_NOINDEX: par }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    const events = await postStream(WB_PORT, { message: '并行读两个文件', cwd: HOME });
    const toolUses = events.filter(e => e.type === 'tool_use');
    const toolResults = events.filter(e => e.type === 'tool_result');
    ok(toolUses.length === 2, 'exactly 2 tool_use events (merged=1 would be the串槽 bug) — got ' + toolUses.length);
    ok(toolUses.every(t => t.name === 'file_read'), 'both tool_use named file_read (not "file_readfile_read") — got ' + JSON.stringify(toolUses.map(t => t.name)));
    const paths = toolUses.map(t => t.input && t.input.path);
    ok(paths.includes(FILE_A) && paths.includes(FILE_B), 'the two calls carry the two DISTINCT paths (args not concatenated) — got ' + JSON.stringify(paths));
    ok(toolUses[0] && toolUses[1] && toolUses[0].id === 'call_1' && toolUses[1].id === 'call_2', 'ids call_1 & call_2 preserved as separate slots');
    ok(toolResults.length === 2 && toolResults.every(r => r.isError !== true), '2 tool_result, all ok (both parsed & executed) — got ' + toolResults.length);
    // The results echo each file's distinct content — proof the arguments were not crossed.
    const resultText = toolResults.map(r => JSON.stringify(r.result || r.content || r)).join(' ');
    ok(resultText.includes(MARK_A) && resultText.includes(MARK_B), 'tool results contain both files\' distinct content');
    const result = events.find(e => e.type === 'result');
    ok(result && result.ok === true, 'result ok=true');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nE1-PARALLEL-NOINDEX E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
