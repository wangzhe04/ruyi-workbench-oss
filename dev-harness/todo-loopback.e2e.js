// E2E (v0.8-S3): todo_write loopback from the MCP child (Claude-engine path). The one-shot MCP child
// must NOT write session files (races the serve process). Instead todo_write detects isMcpChild and loops
// back to POST /api/todo, which persists session.todos in the serve process.
//  Part 1: serve up (temp HOME) → create a session → spawn `node app/server.js mcp` with env carrying
//    WCW_SESSION_ID/WCW_PORT/WCW_HOST/WCW_TOKEN (token scraped from index.html meta) → JSON-RPC tools/call
//    todo_write{2 items}. Assert the call returns ok:true; then GET /api/sessions/<id> and assert
//    session.todos.length === 2 (proving the loopback persisted through the serve process).
//  Part 2: a BARE mcp child (no WCW_* env) calling todo_write returns the guiding error (independent MCP
//    mode has no workbench session context).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-todo-loopback-e2e');
const WB_PORT = 8974;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
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
    ok(!!token, 'UI token scraped from index.html');

    const created = await postJson(WB_PORT, '/api/sessions', { title: 'loopback test', cwd: HOME });
    const sid = created.session && created.session.id;
    ok(!!sid, 'session created');

    // ---- Part 1: MCP child WITH the session env → loopback persists ----
    const mc = mcpChild({ WIN_CLAUDE_WORKBENCH_HOME: HOME, WCW_SESSION_ID: sid, WCW_PORT: String(WB_PORT), WCW_HOST: '127.0.0.1', WCW_TOKEN: token });
    kids.push(mc.child);
    const init = await mc.rpc('initialize', { protocolVersion: '2024-11-05' });
    ok(init.result && init.result.serverInfo && init.result.serverInfo.name === 'win-claude-workbench', 'child: initialize ok');
    const call = await mc.rpc('tools/call', { name: 'todo_write', arguments: { items: [ { text: '第一步', status: 'in_progress' }, { text: '第二步', status: 'pending' } ] } });
    const text = (call.result && call.result.content && call.result.content[0] && call.result.content[0].text) || '';
    let parsed = {}; try { parsed = JSON.parse(text); } catch { /* leave empty */ }
    ok(call.result && call.result.isError === false && parsed.ok === true, 'child: todo_write returns ok:true via loopback (got: ' + text.slice(0, 120) + ')');
    ok(parsed.count === 2, 'child: loopback reported count === 2 (got ' + parsed.count + ')');

    // GET session: the loopback should have persisted session.todos through the serve process.
    const got = await getJson(WB_PORT, '/api/sessions/' + sid);
    ok(got.session && Array.isArray(got.session.todos) && got.session.todos.length === 2, 'session.todos.length === 2 after loopback (got ' + (got.session && got.session.todos && got.session.todos.length) + ')');
    kill(mc.child);

    // ---- Part 2: BARE MCP child (no WCW_* env) → guiding error ----
    const bare = mcpChild({ WIN_CLAUDE_WORKBENCH_HOME: HOME, WCW_SESSION_ID: '', WCW_PORT: '', WCW_HOST: '', WCW_TOKEN: '' });
    kids.push(bare.child);
    await bare.rpc('initialize', { protocolVersion: '2024-11-05' });
    const call2 = await bare.rpc('tools/call', { name: 'todo_write', arguments: { items: [{ text: 'x', status: 'pending' }] } });
    const text2 = (call2.result && call2.result.content && call2.result.content[0] && call2.result.content[0].text) || '';
    let parsed2 = {}; try { parsed2 = JSON.parse(text2); } catch { /* leave empty */ }
    ok(call2.result && call2.result.isError === true && parsed2.ok === false, 'bare child: todo_write → isError:true, ok:false');
    ok(typeof parsed2.error === 'string' && parsed2.error.includes('工作台会话上下文'), 'bare child: guiding error mentions 工作台会话上下文 (got: ' + text2.slice(0, 120) + ')');
    kill(bare.child);
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of kids) kill(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nTODO-LOOPBACK E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
