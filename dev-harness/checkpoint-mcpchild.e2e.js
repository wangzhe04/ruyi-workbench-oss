(async () => {
// E2E (v0.8-S4a): checkpoint journal written from the MCP CHILD (Claude-engine path). The one-shot MCP
// child does NOT write session files, but it MAY write the checkpoints dir (independent of session files,
// no race). It resolves turnSeq by reading the session file (read-only) via the injected WCW_SESSION_ID.
//  Part 1: serve up (temp HOME) → create a session (turnSeq baseline) → spawn `node app/server.js mcp`
//    with env carrying WCW_SESSION_ID (+ loopback port/token, as generateSessionMcpConfig injects) →
//    JSON-RPC file_write. Assert the serve-side GET /api/checkpoints now shows that path's entry (proving
//    the child wrote the journal into the shared checkpoints dir).
//  Part 2: a BARE mcp child (NO WCW_SESSION_ID) file_write still succeeds, but adds NO new journal entry
//    (no session context → journaling gracefully no-ops; the tool runs regardless).
// 手法 copied from todo-loopback (mcp child driver) + search-robust (token scrape).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-checkpoint-mcpchild-e2e');
const WB_PORT = await getFreePort();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
// Drive a `node app/server.js mcp` child over stdio JSON-RPC. `env` is merged over the process env.
function mcpChild(env) {
  const child = cp.spawn(process.execPath, [SERVER, 'mcp'], { env: { ...process.env, ...env }, windowsHide: true });
  child.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[mcp!] ' + l.trim())));
  const pending = new Map(); let buf = '', idc = 0;
  child.stdout.on('data', d => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* ignore */ } } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++idc; const t = setTimeout(() => { pending.delete(id); reject(new Error('rpc timeout: ' + method)); }, 10000); pending.set(id, m => { clearTimeout(t); resolve(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { child, rpc };
}
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function parseCall(call) { const t = (call.result && call.result.content && call.result.content[0] && call.result.content[0].text) || ''; try { return JSON.parse(t); } catch { return {}; } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 6, version: '1.0.0', permissionMode: 'bypass' }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  const kids = [wb];
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    const created = await postJson(WB_PORT, '/api/sessions', { title: 'mcp checkpoint test', cwd: HOME });
    const sid = created.session && created.session.id;
    ok(!!sid, 'session created');
    const baseline = created.session && created.session.turnSeq;
    ok(Number.isFinite(baseline), 'session turnSeq baseline captured (got ' + baseline + ')');

    // ---- Part 1: MCP child WITH the session env → file_write journals into the shared checkpoints dir ----
    const target = path.join(HOME, 'child-made.txt');
    const mc = mcpChild({ WIN_CLAUDE_WORKBENCH_HOME: HOME, WCW_SESSION_ID: sid, WCW_PORT: String(WB_PORT), WCW_HOST: '127.0.0.1', WCW_TOKEN: token });
    kids.push(mc.child);
    const init = await mc.rpc('initialize', { protocolVersion: '2024-11-05' });
    ok(init.result && init.result.serverInfo && init.result.serverInfo.name === 'win-claude-workbench', 'child: initialize ok');
    const call = await mc.rpc('tools/call', { name: 'file_write', arguments: { path: target, content: 'written by mcp child' } });
    const parsed = parseCall(call);
    ok(call.result && call.result.isError === false && parsed.ok === true, 'child: file_write ok (got: ' + JSON.stringify(parsed).slice(0, 120) + ')');
    ok(fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'written by mcp child', 'child: file actually written');
    kill(mc.child);

    // Serve-side GET /api/checkpoints must now show the child's entry (proving the child wrote the journal).
    const cp1 = await getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid, { 'x-wcw-token': token });
    ok(cp1.ok && Array.isArray(cp1.entries), 'serve: GET /api/checkpoints ok');
    const entry = cp1.entries.find(e => e.path === target);
    ok(!!entry, 'serve: journal has an entry for the child-written path (child wrote journal successfully)');
    ok(entry && entry.tool === 'file_write' && entry.op === 'create', 'serve: entry is file_write op:create (new file)');
    ok(entry && entry.turnSeq === baseline, 'serve: entry turnSeq === the session baseline the child read (got ' + (entry && entry.turnSeq) + ' vs ' + baseline + ')');
    const entryCountAfter1 = cp1.entries.length;

    // ---- Part 2: BARE MCP child (no WCW_SESSION_ID) → file_write succeeds but adds NO journal entry ----
    const bareTarget = path.join(HOME, 'bare-made.txt');
    const bare = mcpChild({ WIN_CLAUDE_WORKBENCH_HOME: HOME, WCW_SESSION_ID: '', WCW_PORT: '', WCW_HOST: '', WCW_TOKEN: '' });
    kids.push(bare.child);
    await bare.rpc('initialize', { protocolVersion: '2024-11-05' });
    const call2 = await bare.rpc('tools/call', { name: 'file_write', arguments: { path: bareTarget, content: 'bare child write' } });
    const parsed2 = parseCall(call2);
    ok(call2.result && call2.result.isError === false && parsed2.ok === true, 'bare child: file_write still succeeds (journal is a safety net, not a gate)');
    ok(fs.existsSync(bareTarget), 'bare child: file actually written');
    kill(bare.child);

    // The bare child had no session context → nothing new should be journaled for our session.
    const cp2 = await getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid, { 'x-wcw-token': token });
    ok(cp2.entries.length === entryCountAfter1, 'serve: bare-child write added NO new journal entry (graceful skip) (' + cp2.entries.length + ' vs ' + entryCountAfter1 + ')');
    ok(!cp2.entries.some(e => e.path === bareTarget), 'serve: no journal entry for the bare-child path');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of kids) kill(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCHECKPOINT-MCPCHILD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
