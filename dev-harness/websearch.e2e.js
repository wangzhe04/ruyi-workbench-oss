// E2E (v0.9-S9, D6): web_search / web_fetch. SSRF防御 is the security核心 — asserted条条 as EXPORTED pure
// functions (deterministic, no real network). Ports 9015-9017 (9015 fake-openai, 9016 WB, 9017 fake searxng).
//
// Covers:
//   (unit) ssrfCheck: loopback/私网/link-local·metadata/*.local·*.internal/协议 all BLOCKED; a public host ALLOWED.
//   (unit) extractMainText: <script>/<style>/<head> stripped, <title> captured, block tags → paragraph newlines,
//          HTML entities decoded. (web_fetch itself can't hit 127.0.0.1 due to SSRF, so the extraction logic is
//          tested via the exported pure function per spec §5.b.)
//   (unit) cache: writeWebCache + readWebCache round-trip; webFetch on an SSRF-blocked url NEVER serves cache.
//   (a) LIVE fake searxng: config searchBackend{type:searxng, baseUrl:local JSON endpoint} → a provider turn
//       whose fake calls web_search → the tool result carries results[{title,url,snippet}] parsed from searxng.
//   (e) TOOL_REQUIRES filter: searchBackend.type='none' → buildOpenAiTools产物 has NO web_search AND the system
//       prompt names it 「当前不可用」; with searxng configured → web_search offered + the D6 proactive-search
//       line renders (FAKE_CAPTURE_DIR system断言).
//   (f) apiKey mask: searchBackend.apiKey='bing-secret-key-123456' → GET /api/status + POST /api/config responses
//       mask it to ••••3456; a masked round-trip SAVE does NOT wipe the real key on disk.
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = 9015, WB_PORT = 9016, SEARX_PORT = 9017;
const HOME = path.join(os.tmpdir(), 'wcw-websearch-e2e');

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
function readCaptures(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^req-\d+\.json$/.test(f)).sort()
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}
function systemOf(body) { const m = (body && Array.isArray(body.messages)) ? body.messages.find(x => x && x.role === 'system') : null; return m ? String(m.content || '') : ''; }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// A tiny local "searxng" JSON endpoint: GET /search?q=&format=json → {results:[{title,url,content}]}. It is
// 127.0.0.1, but web_search's backend baseUrl is TRUSTED → NOT SSRF-checked, so this is reachable by design.
function startFakeSearx(port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/search') {
      const q = u.searchParams.get('q') || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ query: q, results: [
        { title: 'Result One for ' + q, url: 'https://example.com/one', content: 'Snippet one about ' + q },
        { title: 'Result Two', url: 'https://example.com/two', content: 'Snippet two' },
      ] }));
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise(resolve => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

function writeConfig(home, extra) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(Object.assign({
    configSchema: 8, version: '1.0.0', permissionMode: 'bypass', toolLoadingMode: 'full',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }, extra || {}), null, 2));
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  // Isolate the module's dataRoot (paths.webcache) into the temp HOME BEFORE requiring server.js — the module
  // resolves WIN_CLAUDE_WORKBENCH_HOME at load. Otherwise the cache round-trip would touch the real data dir.
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  const mod = require(path.join(WB, 'app', 'server.js'));

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // UNIT — SSRF guard (the security核心). Each rejected class asserted个别; a public host allowed.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  ok(typeof mod.ssrfCheck === 'function', 'ssrfCheck exported');
  ok(mod.ssrfCheck('http://127.0.0.1:8080/').allowed === false, 'SSRF: 127.0.0.1 BLOCKED');
  ok(mod.ssrfCheck('http://169.254.169.254/').allowed === false, 'SSRF: 169.254.169.254 (cloud metadata) BLOCKED');
  ok(mod.ssrfCheck('http://10.0.0.1/').allowed === false, 'SSRF: 10.0.0.1 (private) BLOCKED');
  ok(mod.ssrfCheck('http://192.168.1.1').allowed === false, 'SSRF: 192.168.1.1 (private) BLOCKED');
  ok(mod.ssrfCheck('http://172.16.5.5/').allowed === false, 'SSRF: 172.16.5.5 (private) BLOCKED');
  ok(mod.ssrfCheck('http://localhost/').allowed === false, 'SSRF: localhost BLOCKED');
  ok(mod.ssrfCheck('http://[::1]/').allowed === false, 'SSRF: ::1 (ipv6 loopback) BLOCKED');
  ok(mod.ssrfCheck('http://svc.internal/').allowed === false, 'SSRF: *.internal BLOCKED');
  ok(mod.ssrfCheck('http://foo.local/').allowed === false, 'SSRF: *.local BLOCKED');
  ok(mod.ssrfCheck('file:///etc/passwd').allowed === false, 'SSRF: file:// protocol REJECTED');
  ok(/协议/.test(mod.ssrfCheck('file:///etc/passwd').reason || ''), 'SSRF: file:// reason mentions protocol');
  ok(mod.ssrfCheck('ftp://example.com/').allowed === false, 'SSRF: ftp:// protocol REJECTED');
  ok(mod.ssrfCheck('https://example.com/page').allowed === true, 'SSRF: public https host ALLOWED');
  ok(mod.ssrfCheck('http://8.8.8.8/').allowed === true, 'SSRF: public IPv4 8.8.8.8 ALLOWED');
  ok(mod.ssrfCheck('http://172.32.0.1/').allowed === true, 'SSRF: 172.32.x (outside 172.16-31) ALLOWED');
  ok(typeof mod.ssrfCheck('http://127.0.0.1/').host === 'string', 'SSRF: result carries blocked host string');

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // UNIT — extractMainText (剥标签/取标题/段落换行/实体解).
  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  ok(typeof mod.extractMainText === 'function', 'extractMainText exported');
  const html = '<html><head><title>My &amp; Title</title><style>.x{color:#f00}</style></head>'
    + '<body><script>var secret=42;alert(1);</script><h1>Heading</h1><p>Para one text.</p>'
    + '<p>Para&nbsp;two &lt;ok&gt;.</p></body></html>';
  const ex = mod.extractMainText(html);
  ok(/My & Title/.test(ex.title), 'extract: <title> captured + entity decoded (' + ex.title + ')');
  ok(!/var secret/.test(ex.text) && !/color:#f00/.test(ex.text), 'extract: <script>/<style> content stripped');
  ok(!/alert\(1\)/.test(ex.text), 'extract: script body fully removed');
  ok(/Para one text\.[\s\S]*Para two/.test(ex.text), 'extract: block tags → paragraph newlines preserved');
  ok(/Para two <ok>\./.test(ex.text), 'extract: &lt;/&gt;/&nbsp; entities decoded in body');
  ok(!/<\/?(p|h1|script|style|title)/.test(ex.text), 'extract: no HTML tags survive in text');

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // UNIT — cache round-trip + SSRF-blocked url never serves cache. Uses an isolated HOME so paths.webcache
  // is deterministic (module reads WIN_CLAUDE_WORKBENCH_HOME at load — set below via a child process check).
  // Here we exercise the pure read/write against a temp url and a hand-written cache file.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  ok(typeof mod.writeWebCache === 'function' && typeof mod.readWebCache === 'function' && typeof mod.webCachePath === 'function', 'cache fns exported');
  {
    const testUrl = 'https://example.com/cached-page';
    const cp2 = mod.webCachePath(testUrl);
    ok(typeof cp2 === 'string' && /webcache/.test(cp2) && /\.json$/.test(cp2), 'webCachePath → <...>/webcache/<sha256>.json');
    await mod.writeWebCache({ url: testUrl, title: 'Cached Title', text: 'cached body text', ts: '2026-01-01T00:00:00.000Z' });
    const back = await mod.readWebCache(testUrl);
    ok(back && back.title === 'Cached Title' && back.text === 'cached body text' && back.ts === '2026-01-01T00:00:00.000Z', 'cache read-back round-trips {url,title,text,ts}');
    // webFetch on an SSRF-blocked url must NOT fall back to any cache — even if a cache file existed.
    const blockedFetch = await mod.webFetch({ url: 'http://127.0.0.1:9999/x' });
    ok(blockedFetch.ok === false && !!blockedFetch.blocked, 'webFetch(127.0.0.1) → ok:false + blocked (SSRF), no cache leak');
    ok(!('fromCache' in blockedFetch) || blockedFetch.fromCache !== true, 'webFetch blocked result is NOT served fromCache');
  }
  // web_fetch offline-cache fallback: fetch a public-looking host that can't connect → falls back to cache.
  {
    const offUrl = 'https://offline.example.test/only-in-cache';
    await mod.writeWebCache({ url: offUrl, title: 'Offline Cached', text: 'served from cache offline', ts: '2026-02-02T00:00:00.000Z' });
    const r = await mod.webFetch({ url: offUrl });
    ok(r.ok === true && r.fromCache === true && /served from cache offline/.test(r.text), 'webFetch offline (unresolvable host) → fromCache:true from disk cache');
    ok(r.ts === '2026-02-02T00:00:00.000Z', 'webFetch fromCache carries stored ts for freshness judgement');
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // UNIT — webSearch backend分流 against a live local "searxng" JSON endpoint (baseUrl TRUSTED, not SSRF'd).
  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  const searx = await startFakeSearx(SEARX_PORT);
  try {
    const cfg = { searchBackend: { type: 'searxng', baseUrl: 'http://127.0.0.1:' + SEARX_PORT, apiKey: '' } };
    const sr = await mod.webSearch({ query: 'quantum widgets', maxResults: 5 }, cfg);
    ok(sr.ok === true && sr.backend === 'searxng', 'webSearch searxng ok + backend label');
    ok(Array.isArray(sr.results) && sr.results.length === 2, 'webSearch → 2 results parsed');
    ok(sr.results[0].title && sr.results[0].url && typeof sr.results[0].snippet === 'string', 'webSearch result has {title,url,snippet}');
    ok(/quantum widgets/.test(sr.results[0].title), 'webSearch echoed query reached the searxng endpoint');
    // type none → refuse cleanly.
    const none = await mod.webSearch({ query: 'x' }, { searchBackend: { type: 'none' } });
    ok(none.ok === false && /未配置/.test(none.error || ''), 'webSearch type=none → ok:false (未配置搜索后端)');
  } catch (e) { console.log('ERROR(unit searxng) ' + (e && e.stack || e)); fail++; }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // v1.1-W1a (T3) — builtin 免key HTML 搜索 + (T1) fetch 归因 + (T2) 多目标探测. Pure/local units, no real net.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════

  // (T3-a) Bing HTML parse via a fake "cn.bing" server (baseUrl override, admin-trusted 先例). Asserts
  // title/link/snippet extraction + HTML-entity decode (&amp; → &, &#174; → ®).
  const BING_PORT = 9018, BAIDU_PORT = 9019;
  const BING_HTML = '<html><body><ol id="b_results">'
    + '<li class="b_algo"><h2><a href="https://ex.example/a?x=1&amp;y=2">如意 &amp; 工作台 &#174;</a></h2>'
    + '<p class="b_lineclamp2">这是<strong>第一条</strong>摘要 &#169; 说明文字。</p></li>'
    + '<li class="b_algo"><div class="tpcn"><h2><a href="https://ex.example/b">第二条结果</a></h2></div>'
    + '<div class="b_caption"><p>第二条摘要。</p></div></li>'
    + '<li class="b_pag">这是分页噪声,应被忽略</li>'
    + '</ol></body></html>';
  const bingSrv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(BING_HTML); });
  await new Promise(r => bingSrv.listen(BING_PORT, '127.0.0.1', r));
  try {
    const cfg = { searchBackend: { type: 'builtin', baseUrl: 'http://127.0.0.1:' + BING_PORT, apiKey: '' } };
    const r = await mod.webSearch({ query: '如意工作台', maxResults: 5 }, cfg);
    ok(r.ok === true && r.backend === 'builtin' && r.engine === 'bing', 'builtin: bing branch ok + backend/engine labels');
    ok(Array.isArray(r.results) && r.results.length === 2, 'builtin: 2 b_algo blocks parsed (pagination noise skipped) (' + (r.results || []).length + ')');
    ok(r.results[0].title === '如意 & 工作台 ®', 'builtin: title HTML entities decoded (&amp;→&, &#174;→®) (' + r.results[0].title + ')');
    ok(r.results[0].url === 'https://ex.example/a?x=1&y=2', 'builtin: url captured + entity-decoded (' + r.results[0].url + ')');
    ok(/第一条.*摘要 © 说明/.test(r.results[0].snippet) && !/<strong>/.test(r.results[0].snippet), 'builtin: snippet tag-stripped + &#169;→© decoded (' + r.results[0].snippet + ')');
    ok(r.results[0].source === 'bing', 'builtin: result tagged source:bing');
    ok(r.results[1].title === '第二条结果' && r.results[1].url === 'https://ex.example/b', 'builtin: second block (nested div h2 + b_caption) parsed');
  } catch (e) { console.log('ERROR(builtin bing) ' + (e && e.stack || e)); fail++; }
  finally { try { bingSrv.close(); } catch { /* ignore */ } }

  // (T3-b) Fallback / empty handling. With a baseUrl override to a DEAD bing root, the 百度 fallback is
  // SKIPPED by design (the override owns the whole path) → ok:true, empty list, explanatory note.
  try {
    const r = await mod.webSearch({ query: 'x', maxResults: 3 }, { searchBackend: { type: 'builtin', baseUrl: 'http://127.0.0.1:1', apiKey: '' } });
    ok(r.ok === true && r.results.length === 0 && /跳过百度兜底/.test(r.note || ''), 'builtin: dead bing override → empty + skip-baidu note (not an error)');
  } catch (e) { console.log('ERROR(builtin fallback) ' + (e && e.stack || e)); fail++; }

  // (T3-b2) Baidu fallback ACTUALLY triggers when there is NO override and bing yields <1 result. We simulate
  // by pointing the (default, no-override) path... not possible without patching the real hosts. Instead we
  // exercise the 百度 PARSER directly on a fixture — proving the fallback's parse contract end-to-end. The live
  // Bing→百度 chain was verified manually (see report).
  {
    const BAIDU_HTML = '<div class="result c-container new-pmd" id="1"><h3 class="t"><a href="http://www.baidu.com/link?url=REDIR1">百度标题&#x4E00; &amp; 二</a></h3>'
      + '<div class="c-abstract">百度摘要&nbsp;正文内容。</div></div>'
      + '<div class="result c-container" id="2"><h3><a href="http://www.baidu.com/link?url=REDIR2">第二百度条</a></h3>'
      + '<span class="content-right_8Zs40">第二条百度摘要</span></div>';
    const parsed = mod.parseBaiduHtml(BAIDU_HTML, 5);
    ok(parsed.length === 2, 'builtin: parseBaiduHtml → 2 result c-container blocks (' + parsed.length + ')');
    ok(parsed[0].title === '百度标题一 & 二' && /link\?url=REDIR1/.test(parsed[0].url), 'builtin: baidu title decoded (&#x4E00;→一,&amp;→&) + redirect url 照收');
    ok(/百度摘要 正文/.test(parsed[0].snippet) && parsed[0].source === 'baidu', 'builtin: baidu snippet decoded + source:baidu');
    ok(parsed[1].title === '第二百度条', 'builtin: baidu second block parsed');
    // Defensive: garbage in → [] out, never throws.
    ok(mod.parseBingHtml('<html>no algo blocks</html>', 5).length === 0 && mod.parseBingHtml(null, 5).length === 0, 'builtin: parsers defensive (garbage/null → [])');
  }

  // (T3-c) MIGRATION 'none' → 'builtin' at the normalize layer (changed=true, persisted). And an absent
  // searchBackend → builtin default. A deliberate real backend is left untouched.
  {
    const m1 = mod.normalizeConfig({ configSchema: mod.CONFIG_SCHEMA, searchBackend: { type: 'none', baseUrl: '', apiKey: '' } });
    ok(m1.config.searchBackend.type === 'builtin', 'migrate: stored none → builtin');
    ok(m1.changed === true, 'migrate: none→builtin records changed=true (persists to disk)');
    const m2 = mod.normalizeConfig({ configSchema: mod.CONFIG_SCHEMA });
    ok(m2.config.searchBackend.type === 'builtin', 'migrate: absent searchBackend → builtin default');
    const m3 = mod.normalizeConfig({ configSchema: mod.CONFIG_SCHEMA, searchBackend: { type: 'searxng', baseUrl: 'http://x', apiKey: '' } });
    ok(m3.config.searchBackend.type === 'searxng', 'migrate: a real backend (searxng) is NOT touched');
  }

  // (T3-d) capability: builtin counts as a configured searchBackend (needs only network).
  {
    const capsOnline = { network: { online: true } };
    ok(mod.toolRequirementsMet('web_search', capsOnline, false, { searchBackend: { type: 'builtin' } }).met === true, 'capability: web_search MET with builtin + online');
    ok(mod.toolRequirementsMet('web_search', capsOnline, false, { searchBackend: { type: 'none' } }).met === false, 'capability: web_search UNMET with none (disabled)');
    ok(mod.toolRequirementsMet('web_search', { network: { online: false } }, false, { searchBackend: { type: 'builtin' } }).met === false, 'capability: builtin still UNMET when offline (network required)');
  }

  // (T1) failClass classification + 人话 mapping — NEVER blindly "离线".
  {
    ok(mod.classifyFetchError({ code: 'ENOTFOUND' }) === 'dns', 'T1: ENOTFOUND → dns');
    ok(mod.classifyFetchError({ code: 'ECONNRESET' }) === 'reset' && mod.classifyFetchError({ message: 'aborted' }) === 'reset', 'T1: ECONNRESET/aborted → reset');
    ok(mod.classifyFetchError({ code: 'ECONNREFUSED' }) === 'connect', 'T1: ECONNREFUSED → connect');
    ok(mod.classifyFetchError({ message: 'unable to verify the first certificate' }) === 'tls', 'T1: cert error → tls');
    ok(mod.classifyFetchError({ message: 'timeout after 10000ms' }) === 'timeout', 'T1: timeout → timeout');
    const m403 = mod.webFetchFailMessage({ failClass: 'http', statusCode: 403 });
    ok(/反爬/.test(m403.error) && /web_search/.test(m403.hint), 'T1: HTTP 403 → 反爬 message + web_search hint');
    ok(/反爬|中断/.test(mod.webFetchFailMessage({ failClass: 'reset' }).error), 'T1: reset → 中断/反爬 message');
    ok(/解析失败/.test(mod.webFetchFailMessage({ failClass: 'dns' }).error) && !/离线/.test(mod.webFetchFailMessage({ failClass: 'dns' }).error), 'T1: dns message says 解析失败, NOT 离线');
  }

  // (T2) probeAny semantics: one live + one dead → true; all dead → false; empty → null.
  {
    const liveSrv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise(r => liveSrv.listen(0, '127.0.0.1', r));
    const liveUrl = 'http://127.0.0.1:' + liveSrv.address().port + '/';
    try {
      ok(await mod.probeAny([liveUrl, 'http://127.0.0.1:1/'], 2000) === true, 'T2: probeAny(one live, one dead) → true (any-success)');
      ok(await mod.probeAny(['http://127.0.0.1:1/', 'http://127.0.0.1:2/'], 1500) === false, 'T2: probeAny(all dead) → false');
      ok(await mod.probeAny([], 500) === null, 'T2: probeAny([]) → null (nothing to probe)');
      // networkAnchors: explicit capabilityProbeUrl is the SOLE target (air-gapped override).
      ok(JSON.stringify(mod.networkAnchors({ capabilityProbeUrl: 'http://probe.test/h' })) === JSON.stringify(['http://probe.test/h']), 'T2: capabilityProbeUrl set → sole probe target');
      const def = mod.networkAnchors({});
      ok(def.includes('https://www.baidu.com') && def.includes('https://cn.bing.com'), 'T2: default anchors include baidu + cn.bing');
    } catch (e) { console.log('ERROR(probeAny) ' + (e && e.stack || e)); fail++; }
    finally { try { liveSrv.close(); } catch { /* ignore */ } }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // UNIT — mask/unmask covers BOTH providers[].apiKey AND searchBackend.apiKey (shared helper).
  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const cfg = { providers: [{ id: 'p', apiKey: 'provider-secret-9999' }], searchBackend: { type: 'bing', baseUrl: '', apiKey: 'bing-secret-key-123456' } };
    const masked = mod.maskSecrets(cfg);
    ok(masked.providers[0].apiKey === '••••9999' && masked.providers[0].hasKey === true, 'maskSecrets: providers[].apiKey → ••••9999');
    ok(masked.searchBackend.apiKey === '••••3456' && masked.searchBackend.hasKey === true, 'maskSecrets: searchBackend.apiKey → ••••3456');
    // Round-trip a masked save: restore both from `current`.
    const restored = mod.unmaskSecrets({ providers: [{ id: 'p', apiKey: '••••9999' }], searchBackend: { type: 'bing', apiKey: '••••3456' } }, cfg);
    ok(restored.providers[0].apiKey === 'provider-secret-9999', 'unmaskSecrets: masked providers key restored from disk');
    ok(restored.searchBackend.apiKey === 'bing-secret-key-123456', 'unmaskSecrets: masked searchBackend key restored from disk');
    // A genuinely new plaintext key passes through untouched.
    const fresh = mod.unmaskSecrets({ searchBackend: { type: 'brave', apiKey: 'brand-new-key' } }, cfg);
    ok(fresh.searchBackend.apiKey === 'brand-new-key', 'unmaskSecrets: a new plaintext searchBackend key passes through');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // LIVE — TOOL_REQUIRES filter + D6 render + mask over the wire + web_search through a provider turn.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const CAP_DIR = path.join(HOME, 'captures');
  // Scenario 1 (v1.1-W1a T3): a stored 'none' MIGRATES to 'builtin' on load (zero-config default), so
  // web_search is now OFFERED (builtin + online provider) and the D6 proactive-search line renders. This is
  // the 开箱即用 contract: an install that never picked a backend can still search. (Was: 'none' → filtered.)
  writeConfig(HOME, { searchBackend: { type: 'none', baseUrl: '', apiKey: '' } });

  const fake1 = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true, env: { ...process.env, FAKE_CAPTURE_DIR: CAP_DIR } });
  fake1.stdout.on('data', () => {});
  let wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // (e-1) v1.1-W1a: stored 'none' → migrated to 'builtin' → web_search OFFERED + D6 line renders.
    const ev1 = await postStream(WB_PORT, { message: 'hello' });
    ok(!!ev1.find(e => e.type === 'result'), '(migrate) turn completed');
    const capsNone = readCaptures(CAP_DIR);
    ok(capsNone.length >= 1, '(migrate) request captured');
    const names1 = (capsNone[0].tools || []).map(t => t.function && t.function.name);
    ok(names1.includes('web_search'), '(migrate) web_search OFFERED (none→builtin migration + online)');
    const sys1 = systemOf(capsNone[0]);
    ok(!/当前不可用：.*web_search/.test(sys1), '(migrate) web_search NOT 「当前不可用」 (builtin satisfies searchBackend)');
    ok(/主动使用 web_search/.test(sys1), '(migrate) D6 proactive-search line renders (web_search offered + online)');
    // On-disk config: the migration was persisted (changed=true → written back as 'builtin').
    const onDiskMig = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(onDiskMig.searchBackend.type === 'builtin', '(migrate) on-disk searchBackend.type folded none→builtin + persisted');

    // (f) apiKey mask over the wire — save a searchBackend with a secret, then read it back masked.
    const token = await getToken(WB_PORT);
    ok(!!token, 'got UI token for config POST');
    const saveResp = await postJson(WB_PORT, '/api/config', { searchBackend: { type: 'bing', baseUrl: '', apiKey: 'bing-secret-key-123456' } }, { 'x-wcw-token': token });
    ok(saveResp.status === 200 && saveResp.body && saveResp.body.ok, 'POST /api/config saved searchBackend');
    ok(saveResp.body.config.searchBackend.apiKey === '••••3456', 'POST /api/config response masks searchBackend.apiKey (••••3456)');
    const status = await getJson(WB_PORT, '/api/status');
    ok(status.config.searchBackend.apiKey === '••••3456', 'GET /api/status masks searchBackend.apiKey (••••3456)');
    // The REAL key is on disk (never wiped, never masked in the file).
    const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(onDisk.searchBackend.apiKey === 'bing-secret-key-123456', 'on-disk config keeps the REAL searchBackend key');
    // Round-trip: POST the masked value straight back (as the UI would) → disk key survives.
    await postJson(WB_PORT, '/api/config', { searchBackend: { type: 'bing', baseUrl: '', apiKey: '••••3456' } }, { 'x-wcw-token': token });
    const onDisk2 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(onDisk2.searchBackend.apiKey === 'bing-secret-key-123456', 'masked round-trip SAVE does NOT wipe the real key');
  } catch (e) { console.log('ERROR(live none) ' + (e && e.stack || e)); fail++; }
  finally { killp(wb); killp(fake1); await sleep(300); }

  // Scenario 2: searxng configured → web_search offered + D6 line renders + a turn calls web_search live.
  fs.rmSync(CAP_DIR, { recursive: true, force: true });
  writeConfig(HOME, { searchBackend: { type: 'searxng', baseUrl: 'http://127.0.0.1:' + SEARX_PORT, apiKey: '' } });
  const fake2 = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true,
    env: { ...process.env, FAKE_CAPTURE_DIR: CAP_DIR, FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'web_search', args: { query: 'latest news', maxResults: 3 } }]) },
  });
  fake2.stdout.on('data', () => {});
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb2] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb2!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, '(searxng) workbench listening');
    const ev2 = await postStream(WB_PORT, { message: '今天有什么新闻' });
    const result = ev2.find(e => e.type === 'result');
    ok(result && result.ok === true, '(searxng) turn ok after web_search tool call');
    const capsX = readCaptures(CAP_DIR);
    ok(capsX.length >= 1, '(searxng) request captured');
    const names2 = (capsX[0].tools || []).map(t => t.function && t.function.name);
    ok(names2.includes('web_search'), '(searxng) web_search OFFERED (network+searchBackend satisfied)');
    ok(names2.includes('web_fetch'), '(searxng) web_fetch OFFERED (network satisfied)');
    const sys2 = systemOf(capsX[0]);
    ok(/主动使用 web_search/.test(sys2), '(searxng) D6 proactive-search instruction rendered when web_search offered + online');
    // The tool actually ran → a tool_result event carrying the searxng results reached the model.
    const toolResults = ev2.filter(e => e.type === 'tool_result' || e.type === 'tool_use');
    ok(toolResults.length >= 1, '(searxng) a web_search tool event was emitted (' + toolResults.length + ')');
    // The SECOND captured request (echo) should carry the tool result content in history.
    const laterBody = JSON.stringify(capsX[capsX.length - 1] || {});
    ok(/Result One for latest news|example\.com\/one/.test(laterBody), '(searxng) searxng results flowed back into provider history');
  } catch (e) { console.log('ERROR(live searxng) ' + (e && e.stack || e)); fail++; }
  finally { killp(wb); killp(fake2); await sleep(300); }

  try { searx.close(); } catch { /* ignore */ }
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nWEBSEARCH E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
