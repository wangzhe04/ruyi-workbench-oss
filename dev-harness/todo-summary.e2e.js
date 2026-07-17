(async () => {
// E2E (v0.8-S3): todo_write + turn_summary on the provider engine (fake-openai, offline).
//  Turn 1 (FAKE_TOOL_SEQUENCE = [todo_write{3 items, 1 done}, file_write{path,content}, powershell_run{echo x}]):
//    ① the stream carries a `todo` event whose items.length === 3;
//    ② the turn ends with a `turn_summary`: filesChanged contains the written path, commands === 1
//       (only powershell_run — todo_write/file_write are NOT commands), turnSeq is a number;
//    ③ GET the session: session.todos.length === 3 and the last assistant message carries turnSummary.
//  Turn 2 (no tools): the collapsing turn_summary has filesChanged empty + commands 0 (reassurance-line data).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-todo-summary-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
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
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const target = path.join(HOME, 'made.txt');
  writeConfig(HOME, FAKE_PORT);
  const seq = JSON.stringify([
    { name: 'todo_write', args: { items: [
      { text: '读取需求', status: 'done' },
      { text: '写文件', status: 'in_progress' },
      { text: '收尾', status: 'pending' },
    ] } },
    { name: 'file_write', args: { path: target, content: 'hello turn summary' } },
    { name: 'powershell_run', args: { command: 'echo x' } },
  ]);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);

    // Create a session so we can inspect its persisted todos + turnSummary afterward.
    const created = await postJson(WB_PORT, '/api/sessions', { title: 'todo test', cwd: HOME });
    const sid = created.session && created.session.id;
    ok(!!sid, 'session created');

    // ---- Turn 1: sequence todo_write -> file_write -> powershell_run ----
    const ev1 = await postStream(WB_PORT, { sessionId: sid, message: '开工', cwd: HOME });
    const todoEvents = ev1.filter(e => e.type === 'todo');
    ok(todoEvents.length >= 1, 'turn1: a `todo` event was streamed (got ' + todoEvents.length + ')');
    ok(todoEvents.some(e => Array.isArray(e.items) && e.items.length === 3), 'turn1: todo event items.length === 3');

    const ts1 = ev1.find(e => e.type === 'turn_summary');
    ok(!!ts1, 'turn1: turn_summary emitted');
    ok(ts1 && typeof ts1.turnSeq === 'number', 'turn1: turn_summary.turnSeq is a number (got ' + (ts1 && ts1.turnSeq) + ')');
    ok(ts1 && Array.isArray(ts1.filesChanged) && ts1.filesChanged.some(f => f && f.path === target), 'turn1: filesChanged contains the written path');
    ok(ts1 && ts1.commands === 1, 'turn1: commands === 1 (only powershell_run) (got ' + (ts1 && ts1.commands) + ')');
    // v0.9-S4 (C4): artifacts is now POPULATED — a journal `create` (the new made.txt) becomes one artifact.
    ok(ts1 && Array.isArray(ts1.artifacts) && ts1.artifacts.length === 1 && ts1.artifacts[0].path === target && ts1.artifacts[0].kind === 'txt', 'turn1: artifacts has the created made.txt (kind txt) — v0.9-S4');
    // v0.8-S4a: file_write is now journaled → its filesChanged entry is revertible:true (was false in S3).
    ok(ts1 && ts1.filesChanged.some(f => f.path === target && f.revertible === true), 'turn1: journaled file_write is revertible:true (S4a)');
    ok(ts1 && ts1.filesChanged.find(f => f.path === target).op === 'create', 'turn1: journaled file_write op === create (S4a)');

    // ---- GET session: persisted todos + assistant message turnSummary ----
    const got = await getJson(WB_PORT, '/api/sessions/' + sid);
    const s = got.session;
    ok(s && Array.isArray(s.todos) && s.todos.length === 3, 'session.todos length === 3 (got ' + (s && s.todos && s.todos.length) + ')');
    const lastAssistant = s && [...s.messages].reverse().find(m => m && m.role === 'assistant');
    ok(lastAssistant && lastAssistant.turnSummary && Array.isArray(lastAssistant.turnSummary.filesChanged), 'last assistant message carries turnSummary');
    ok(lastAssistant && lastAssistant.turnSummary && lastAssistant.turnSummary.commands === 1, 'persisted turnSummary.commands === 1');

    // ---- Turn 2: no tools (sequence exhausted → echo finish, zero tool rounds) ----
    const ev2 = await postStream(WB_PORT, { sessionId: sid, message: '再来一句', cwd: HOME });
    const ts2 = ev2.find(e => e.type === 'turn_summary');
    ok(!!ts2, 'turn2: turn_summary emitted');
    ok(ts2 && Array.isArray(ts2.filesChanged) && ts2.filesChanged.length === 0, 'turn2: filesChanged empty (reassurance-line data)');
    ok(ts2 && ts2.commands === 0, 'turn2: commands === 0 (got ' + (ts2 && ts2.commands) + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nTODO-SUMMARY E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
