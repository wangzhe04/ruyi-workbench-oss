(async () => {
// E2E (v1.0-S6): provider 端点故障转移 (B) + 搜索后端新枚举 tavily/bocha (A). 零依赖、离线、node 直跑。
//
// Boundary asserted (B):
//   ① 主端点 = 无人监听的死端口, extraBaseUrls=[活 fake-openai] → 一回合成功产出 assistant 文本 +
//      事件流有 `failover` (from=死端点, to=活端点, reason 含 connect)。
//   ② 粘住: 同 provider 再发一回合 → 活 fake 的命中计数增加且无新 failover 事件 (直接走活端点)。
//   ③ 401 不切换: 主端点 = 返回 401 的假服, extraBaseUrls=[活 fake] → 回合失败, 事件流无 failover,
//      错误归因为鉴权类 (result.errorClass 非 network_down; httpError 文本含 401)。
//   ④ 流中死亡不切换: fake 输出半截 SSE 后断连 → 无 failover 事件 (走既有错误路径)。
//   ⑤ (A) searchBackend 新枚举 tavily/bocha: POST config 往返存续 + webSearch 经 baseUrl 覆写指向本地假搜索服
//      → 解析出结果 (两后端各一例, 假服返回官方形状 JSON); 非法 type 仍清洗为 none。
//
// 末行判定固定为 `FAILOVER E2E: ALL PASS`。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
// Port map (distinct segment, avoid collisions with other e2e):
//   9031 live fake-openai (backup endpoint) · 9032 workbench · 9033 401-endpoint fake · 9034 die-midstream fake
//   9035 fake tavily/bocha search server · 9039 the DEAD (unlistened) primary port for ①.
const FAKE_LIVE = await getFreePort(), WB_PORT = await getFreePort(), FAKE_401 = await getFreePort(), FAKE_DIE = await getFreePort(), SEARCH_PORT = await getFreePort(), DEAD_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-failover-e2e');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
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
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function fakeCount(port) { return getJson(port, '/__count', {}).then(j => (j && j.count) || 0).catch(() => 0); }

// A tiny 401-returning "OpenAI" endpoint (no streaming) — the auth-error primary for ③. Kept as a plain http
// server (independent of fake-openai) so the boundary is unambiguous: it ALWAYS 401s /chat/completions.
function start401(port) {
  const srv = http.createServer((req, res) => {
    if ((req.url || '').includes('/chat/completions')) {
      let b = ''; req.on('data', c => (b += c)); req.on('end', () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'auth', code: 401 } })); });
      return;
    }
    res.writeHead(404); res.end('no');
  });
  return new Promise(resolve => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

// A local fake tavily/bocha search server returning the OFFICIAL response shapes (for ⑤). One server serves
// both: /search → tavily {results:[{title,url,content}]}; /v1/web-search → bocha {data:{webPages:{value:[…]}}}.
function startFakeSearch(port) {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      let q = ''; try { q = (JSON.parse(b) || {}).query || ''; } catch { /* ignore */ }
      if ((req.url || '').includes('/v1/web-search')) { // bocha
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 200, data: { webPages: { value: [
          { name: '博查结果 ' + q, url: 'https://cn.example.com/bocha1', snippet: '中文摘要 ' + q },
          { name: '博查结果二', url: 'https://cn.example.com/bocha2', snippet: '第二条' },
        ] } } }));
        return;
      }
      if ((req.url || '').includes('/search')) { // tavily
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [
          { title: 'Tavily 结果 ' + q, url: 'https://ex.com/tav1', content: 'content about ' + q },
          { title: 'Tavily Two', url: 'https://ex.com/tav2', content: 'second content' },
        ] }));
        return;
      }
      res.writeHead(404); res.end('no');
    });
  });
  return new Promise(resolve => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

// Write a config with ONE provider whose extraBaseUrls we control. permissionMode bypass so tools (none used
// here) never prompt. No desktop MCP.
function writeConfig(home, provider, extra) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(Object.assign({
    configSchema: 8, version: '1.0.0', permissionMode: 'bypass', toolLoadingMode: 'full',
    providers: [provider],
    activeProvider: provider.id,
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }, extra || {}), null, 2));
}

function spawnWB() {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  return wb;
}
async function waitWB() { let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); } return h; }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // UNIT (A + B cleansing) — direct module functions, no server.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  const mod = require(path.join(WB, 'app', 'server.js'));
  // (A) normalizeConfig accepts+cleanses tavily/bocha type and extraBaseUrls.
  {
    const { config: c1 } = mod.normalizeConfig({ searchBackend: { type: 'tavily', baseUrl: 'http://x', apiKey: 'k' } });
    ok(c1.searchBackend.type === 'tavily', '(A) normalizeConfig keeps type=tavily');
    const { config: c2 } = mod.normalizeConfig({ searchBackend: { type: 'bocha', baseUrl: '', apiKey: 'k' } });
    ok(c2.searchBackend.type === 'bocha', '(A) normalizeConfig keeps type=bocha');
    const { config: c3 } = mod.normalizeConfig({ searchBackend: { type: 'not-a-real-backend' } });
    // v1.1-W1a (T3): the safe fallback for an unknown/illegal type is now 'builtin' (the zero-config default),
    // not 'none' — so a corrupt type still leaves search working out of the box. (Was: → 'none'.)
    ok(c3.searchBackend.type === 'builtin', '(A) illegal search type cleansed → builtin (zero-config default)');
    const appVersion = require(path.join(WB, 'package.json')).version;
    ok(c3.configSchema === 8 && c3.version === appVersion, `(A) configSchema 8 / version stamped to app VERSION (${appVersion})`);
  }
  // (B) extraBaseUrls cleansing via normalizeConfig (sanitizeProvider is not exported; normalizeConfig calls it).
  {
    const { config } = mod.normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://main.example.com', apiKey: 'k', model: 'm',
      extraBaseUrls: ['https://b1.com', ' https://b2.com ', 'https://main.example.com', 'https://b1.com', '', 'https://b3.com', 'https://b4.com', 123] }] });
    const e = config.providers[0].extraBaseUrls;
    ok(Array.isArray(e) && e.length === 3, '(B) extraBaseUrls capped to 3 (' + JSON.stringify(e) + ')');
    ok(e[0] === 'https://b1.com' && e[1] === 'https://b2.com' && e[2] === 'https://b3.com', '(B) extraBaseUrls trimmed+deduped, order kept, b4 dropped by cap');
    ok(!e.includes('https://main.example.com'), '(B) entry equal to main baseUrl dropped');
    const { config: c0 } = mod.normalizeConfig({ providers: [{ id: 'q', baseUrl: 'https://m.com', apiKey: 'k', model: 'm' }] });
    ok(Array.isArray(c0.providers[0].extraBaseUrls) && c0.providers[0].extraBaseUrls.length === 0, '(B) absent extraBaseUrls → [] (behavior = 现状)');
  }
  // (A) webSearch tavily + bocha parse against local fake search server (baseUrl override → TRUSTED, not SSRF).
  const searchSrv = await startFakeSearch(SEARCH_PORT);
  try {
    const tav = await mod.webSearch({ query: 'quantum', maxResults: 5 }, { searchBackend: { type: 'tavily', baseUrl: 'http://127.0.0.1:' + SEARCH_PORT, apiKey: 'tk' } });
    ok(tav.ok === true && tav.backend === 'tavily' && tav.results.length === 2, '(A) webSearch tavily → 2 results parsed');
    ok(/Tavily 结果 quantum/.test(tav.results[0].title) && tav.results[0].url && typeof tav.results[0].snippet === 'string', '(A) tavily result {title,url,snippet} parsed from results[].{title,url,content}');
    const boc = await mod.webSearch({ query: '中文', maxResults: 5 }, { searchBackend: { type: 'bocha', baseUrl: 'http://127.0.0.1:' + SEARCH_PORT, apiKey: 'bk' } });
    ok(boc.ok === true && boc.backend === 'bocha' && boc.results.length === 2, '(A) webSearch bocha → 2 results parsed');
    ok(/博查结果 中文/.test(boc.results[0].title) && boc.results[0].url && typeof boc.results[0].snippet === 'string', '(A) bocha result {title,url,snippet} parsed from data.webPages.value[].{name,url,snippet}');
    // Defensive: a bocha body missing data.webPages → empty list, never crash.
    const empty = await mod.webSearch({ query: 'x' }, { searchBackend: { type: 'bocha', baseUrl: 'http://127.0.0.1:' + SEARCH_PORT + '/missing-shape', apiKey: 'k' } });
    ok(empty.ok === true && Array.isArray(empty.results), '(A) bocha defensive parse never crashes on unexpected shape');
  } catch (e) { console.log('ERROR(unit search) ' + (e && e.stack || e)); fail++; }
  finally { try { searchSrv.close(); } catch { /* ignore */ } }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // LIVE ① + ② — failover to a backup endpoint + session-sticky.
  // primary = DEAD_PORT (nobody listening) → ECONNREFUSED; backup = live fake-openai on FAKE_LIVE.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  let live = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_LIVE)], { windowsHide: true, env: { ...process.env } });
  live.stdout.on('data', () => {});
  writeConfig(HOME, { id: 'fo', label: 'Failover', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + DEAD_PORT, extraBaseUrls: ['http://127.0.0.1:' + FAKE_LIVE], apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] });
  let wb = spawnWB();
  try {
    ok(!!(await waitWB()), 'workbench listening on :' + WB_PORT);
    const countBefore = await fakeCount(FAKE_LIVE);

    // ① primary dead → fail over to live backup; assistant text produced; failover event present.
    const ev1 = await postStream(WB_PORT, { message: 'hello failover' });
    const result1 = ev1.find(e => e.type === 'result');
    ok(result1 && result1.ok === true, '① turn ok (backup endpoint served the reply)');
    const assistantText1 = ev1.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    ok(/Hello, world/.test(assistantText1), '① assistant text streamed from backup (' + JSON.stringify(assistantText1.slice(0, 40)) + ')');
    const fo1 = ev1.filter(e => e.type === 'failover');
    ok(fo1.length === 1, '① exactly one failover event emitted');
    ok(fo1[0] && fo1[0].from === 'http://127.0.0.1:' + DEAD_PORT + '/v1' && fo1[0].to === 'http://127.0.0.1:' + FAKE_LIVE + '/v1', '① failover from=死端点(/v1) to=活端点(/v1)');
    ok(fo1[0] && /connect/.test(String(fo1[0].reason || '')), '① failover reason contains connect (' + (fo1[0] && fo1[0].reason) + ')');
    const countAfter1 = await fakeCount(FAKE_LIVE);
    ok(countAfter1 > countBefore, '① live backup received the request (count ' + countBefore + '→' + countAfter1 + ')');

    // ② sticky: a SECOND turn on the SAME provider goes straight to the backup — no NEW failover event; the
    // backup's request count increments again (proving it was hit directly, not via a re-walk from the dead primary).
    const ev2 = await postStream(WB_PORT, { message: 'second turn' });
    const result2 = ev2.find(e => e.type === 'result');
    ok(result2 && result2.ok === true, '② second turn ok');
    const fo2 = ev2.filter(e => e.type === 'failover');
    ok(fo2.length === 0, '② NO failover event on the second turn (stuck to the backup)');
    const countAfter2 = await fakeCount(FAKE_LIVE);
    ok(countAfter2 > countAfter1, '② backup hit AGAIN directly (count ' + countAfter1 + '→' + countAfter2 + ')');
  } catch (e) { console.log('ERROR(live ①②) ' + (e && e.stack || e)); fail++; }
  finally { killp(wb); killp(live); await sleep(300); }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // LIVE ③ — 401 primary must NOT fail over. primary = 401 server; backup = live fake-openai.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const srv401 = await start401(FAKE_401);
  let live3 = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_LIVE)], { windowsHide: true, env: { ...process.env } });
  live3.stdout.on('data', () => {});
  writeConfig(HOME, { id: 'fo', label: 'Failover', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_401, extraBaseUrls: ['http://127.0.0.1:' + FAKE_LIVE], apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] });
  wb = spawnWB();
  try {
    ok(!!(await waitWB()), '(③) workbench listening');
    const backupBefore = await fakeCount(FAKE_LIVE);
    const ev3 = await postStream(WB_PORT, { message: 'auth please' });
    const result3 = ev3.find(e => e.type === 'result');
    ok(result3 && result3.ok === false, '③ turn FAILED (401 is a hard auth error, not retried elsewhere)');
    const fo3 = ev3.filter(e => e.type === 'failover');
    ok(fo3.length === 0, '③ NO failover event on a 401 (auth error → 不切换)');
    const backupAfter = await fakeCount(FAKE_LIVE);
    ok(backupAfter === backupBefore, '③ backup endpoint was NEVER hit (count unchanged ' + backupBefore + ')');
    // Attribution: the error is auth/HTTP-class, NOT network_down (a failover-eligible transport class).
    ok(result3 && result3.errorClass !== 'network_down', '③ errorClass is not network_down (' + (result3 && result3.errorClass) + ')');
    const errText = ev3.filter(e => e.type === 'assistant_delta').map(e => e.text).join('') + ' ' + (result3 && result3.error || '');
    ok(/401/.test(errText), '③ error surface names the 401 status (归因保留)');
  } catch (e) { console.log('ERROR(live ③) ' + (e && e.stack || e)); fail++; }
  finally { killp(wb); killp(live3); try { srv401.close(); } catch { /* ignore */ } await sleep(300); }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // LIVE ④ — death AFTER the stream started must NOT fail over (防重放). primary = die-midstream fake; a live
  // backup is configured but must never be reached.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  let dieSrv = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_DIE)], { windowsHide: true, env: { ...process.env, FAKE_DIE_MIDSTREAM: '1' } });
  dieSrv.stdout.on('data', () => {});
  let live4 = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_LIVE)], { windowsHide: true, env: { ...process.env } });
  live4.stdout.on('data', () => {});
  writeConfig(HOME, { id: 'fo', label: 'Failover', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_DIE, extraBaseUrls: ['http://127.0.0.1:' + FAKE_LIVE], apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] });
  wb = spawnWB();
  try {
    ok(!!(await waitWB()), '(④) workbench listening');
    const backupBefore = await fakeCount(FAKE_LIVE);
    const ev4 = await postStream(WB_PORT, { message: 'mid-stream death' });
    const result4 = ev4.find(e => e.type === 'result');
    ok(!!result4, '④ turn produced a terminal result');
    const fo4 = ev4.filter(e => e.type === 'failover');
    ok(fo4.length === 0, '④ NO failover event when the stream died AFTER first byte (防重放)');
    const backupAfter = await fakeCount(FAKE_LIVE);
    ok(backupAfter === backupBefore, '④ backup endpoint was NEVER hit on a mid-stream death (count unchanged ' + backupBefore + ')');
  } catch (e) { console.log('ERROR(live ④) ' + (e && e.stack || e)); fail++; }
  finally { killp(wb); killp(dieSrv); killp(live4); await sleep(300); }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // LIVE ⑤ — searchBackend tavily/bocha round-trip over the wire (POST config → GET status), + a webSearch
  // through a provider turn with baseUrl覆写 pointing at the local fake search server.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const searchSrv2 = await startFakeSearch(SEARCH_PORT);
  // fake-openai drives a single web_search tool call, then echoes its result → the tool actually runs.
  let live5 = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_LIVE)], { windowsHide: true, env: { ...process.env, FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'web_search', args: { query: '今日头条', maxResults: 3 } }]) } });
  live5.stdout.on('data', () => {});
  writeConfig(HOME, { id: 'fo', label: 'Failover', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_LIVE, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
    { searchBackend: { type: 'tavily', baseUrl: 'http://127.0.0.1:' + SEARCH_PORT, apiKey: 'tav-secret-123456' } });
  wb = spawnWB();
  try {
    ok(!!(await waitWB()), '(⑤) workbench listening');
    const token = await getToken(WB_PORT);
    ok(!!token, '⑤ got UI token');
    // Round-trip: POST a bocha searchBackend, read it back; then POST tavily. Both must persist their type.
    const saveB = await postJson(WB_PORT, '/api/config', { searchBackend: { type: 'bocha', baseUrl: 'http://127.0.0.1:' + SEARCH_PORT, apiKey: 'boc-secret-654321' } }, { 'x-wcw-token': token });
    ok(saveB.status === 200 && saveB.body && saveB.body.config.searchBackend.type === 'bocha', '⑤ POST config type=bocha persisted');
    const st1 = await getJson(WB_PORT, '/api/status');
    ok(st1.config.searchBackend.type === 'bocha', '⑤ GET status reflects type=bocha');
    ok(st1.config.searchBackend.apiKey === '••••4321', '⑤ bocha apiKey masked over the wire (••••4321)');
    // v1.1-W1a (T3): illegal type is cleansed to 'builtin' (zero-config default) on save, not 'none'.
    const saveBad = await postJson(WB_PORT, '/api/config', { searchBackend: { type: 'not-real', baseUrl: '', apiKey: '' } }, { 'x-wcw-token': token });
    ok(saveBad.body && saveBad.body.config.searchBackend.type === 'builtin', '⑤ illegal search type → builtin on save (zero-config default)');
    // Put tavily back (pointing at the fake search server) and run a provider turn that calls web_search.
    await postJson(WB_PORT, '/api/config', { searchBackend: { type: 'tavily', baseUrl: 'http://127.0.0.1:' + SEARCH_PORT, apiKey: 'tav-secret-123456' } }, { 'x-wcw-token': token });
    const st2 = await getJson(WB_PORT, '/api/status');
    ok(st2.config.searchBackend.type === 'tavily', '⑤ tavily type persisted after re-save');
    const ev5 = await postStream(WB_PORT, { message: '搜一下今天的新闻' });
    const result5 = ev5.find(e => e.type === 'result');
    ok(result5 && result5.ok === true, '⑤ provider turn ok after web_search (tavily) tool call');
    const toolResults = ev5.filter(e => e.type === 'tool_result');
    ok(toolResults.length >= 1, '⑤ a web_search tool_result was emitted');
    const trBlob = JSON.stringify(toolResults);
    ok(/Tavily 结果 今日头条|ex\.com\/tav1/.test(trBlob), '⑤ tavily results parsed + flowed into the tool_result');
  } catch (e) { console.log('ERROR(live ⑤) ' + (e && e.stack || e)); fail++; }
  finally { killp(wb); killp(live5); try { searchSrv2.close(); } catch { /* ignore */ } await sleep(300); }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nFAILOVER E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
