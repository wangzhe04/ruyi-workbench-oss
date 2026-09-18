#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// E2E(第 123 波 N2):新线程的默认引擎【不再写死跟全局】。
//
// 用户 2026-09-13 真机原话:「现在新开线程会默认开 Kimi code cli,我希望改成默认上一次用的
// 或者别的方式,不要设定死。」病根:02 createSession 的缺省只有
//   inferSessionEngineRoute({messages}) || sessionEngineRouteFromConfig(config)
// 后者 = 全局 activeProvider / agentCliType / model 三项设置(那台机器上 agentCliType 是 kimi)。
// 用户在线程头上换的引擎只活在那一条线程头上,下一条新线程照旧回到全局 —— 这就是「写死」。
//
// 本件按 API 级跑(不起浏览器),七条判据:
//   ① 还没有记录 → 新线程跟全局(kimi),零审计事件;
//   ② 线程头 PATCH engineRoute=X → 下一条新线程是 X(写入点①:applySessionMetaPatch);
//   ③ 工作台自己发起一回合(source 缺省 'http')跑在 Y 上 → 下一条新线程是 Y(写入点②:
//      10 runSessionTurn),且【建线程时带显式 engineRoute 本身不记】;
//   ④ 管家式 source:'steward' 的回合跑在 Z 上 → 下一条新线程【仍是 Y】(后台活动不算用户的
//      意思表示,记进去等于让管家悄悄改写用户的默认值);
//   ⑤ newThreadEngine 改 'global' → 回老行为(kimi);
//   ⑥ 改回 'last' 但把 Y 这个端点删了 → 回落全局,且审计里有 new_thread_engine_fallback;
//   ⑦ POST /api/sessions 带显式 engineRoute → 以显式为准(压过「上次用的」)。
//
// 反向验证(实测,见提交说明):
//   · 注掉 02 newSessionEngineRoute 里 ③ 那一层(lastUsedEngineRoute 分支)→ ② ③ 红;
//   · 注掉 10 里 `if (source === 'http')` 这道判据(改成无条件记)→ ④ 红。
//
// 判定行:`NEW THREAD ENGINE DEFAULT E2E: ALL PASS`。
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-newthread-engine-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();
const logsDir = path.join(HOME, 'logs');
const configPath = path.join(HOME, 'config.json');

// ── fake provider:三个 id(px/py/pz)共用这一个端点,回什么与 id 无关 ──────────────────────
// 管家会话(系统提示里带「我是如意」)恒回结构化契约 JSON,别的会话一句话就收。
const providerServer = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if ((req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[{"id":"fake-model"}]}');
  }
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
  const isSteward = /我是如意/.test(sys);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
  const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };
  const say = isSteward ? JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }) : '好的,记下了。';
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: say }, finish_reason: null }] });
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
  return done();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

const providerEntry = (id, label, model) => ({
  id, label, type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`,
  apiKey: 'k', model, models: [{ id: model, label: model }],
});
const PX = providerEntry('px', 'Endpoint X', 'model-x');
const PY = providerEntry('py', 'Endpoint Y', 'model-y');
const PZ = providerEntry('pz', 'Endpoint Z', 'model-z');

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  configSchema: 7,
  // 全局 = 那台真机上的形状:activeProvider 空 → 回落 Agent CLI,而 Agent CLI 是 kimi。
  activeProvider: '', agentCliType: 'kimi', model: '',
  engineMode: 'interactive', permissionMode: 'default',
  permissionTimeoutMs: 120000, questionTimeoutMs: 120000,
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
  subagentMaxPerTurn: 0, killOnDisconnect: false, locale: 'zh-CN',
  stewardEnabledV1: true, stewardPollMs: 120000, stewardReadBudgetChars: 4000,
  stewardMaxTurnsPerHour: 500, stewardMaxCostPerDay: 0,
  stewardGlobalMaxTurnsPerHour: 2000, stewardGlobalMaxCostPerDay: 0,
  stewardProviderId: 'px', stewardModel: 'model-x', stewardThreadBriefV1: false,
  providers: [PX, PY, PZ],
}, null, 2), 'utf8');

function request(method, p, body, headers) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method, timeout: 60000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) },
    }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let jsonBody = null; try { jsonBody = JSON.parse(b); } catch { jsonBody = null; } resolve({ status: res.statusCode, json: jsonBody, raw: b }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitUp() { // 30 号文 P1-31:健康门预算 300×120ms
  for (let i = 0; i < 300; i++) { const h = await request('GET', '/health'); if (h.status === 200) return true; await sleep(120); }
  return false;
}
async function tokenOf() {
  const html = await new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve(''));
  });
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}
function diskConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; }
}
function lastUsed() {
  const value = diskConfig().lastUsedEngineRoute;
  return (value && typeof value === 'object') ? value : null;
}
// 记账是旁路(不 await、不阻塞回合/PATCH),所以判「记住了没有」要等,不能读一次就下结论。
async function waitLastUsed(predicate, budgetMs = 12000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = lastUsed();
    if (predicate(value)) return value;
    if (Date.now() > deadline) return value;
    await sleep(120);
  }
}
const isOpenAi = (route, providerId) => Boolean(route && route.engine === 'openai' && route.providerId === providerId);
const isAgent = (route, cliType) => Boolean(route && route.engine === 'agent' && route.agentCliType === cliType);
function auditRows() {
  const out = [];
  for (const f of (fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [])) {
    if (!f.endsWith('.ndjson')) continue;
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}
const fallbackRows = () => auditRows().filter(r => r && r.kind === 'new_thread_engine_fallback');

let hdr = {};
let wb = null;
let wsSeq = 0;
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stdout.on('data', () => {});
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  ok(await waitUp(), '00 工作台启动');
  hdr = { 'x-wcw-token': await tokenOf() };

  const newThread = async (title, engineRoute) => {
    const cwd = path.join(HOME, 'ws', 'w' + (++wsSeq));
    fs.mkdirSync(cwd, { recursive: true });
    const created = await request('POST', '/api/sessions', { title, cwd, ...(engineRoute ? { engineRoute } : {}) }, hdr);
    return (created.json && created.json.session) || null;
  };
  const cwdOf = session => String((session && session.cwd) || HOME);
  const envelope = sid => request('GET', `/api/sessions/${encodeURIComponent(sid)}`, undefined, hdr);
  const waitIdle = async sid => {
    for (let i = 0; i < 600; i++) {
      const res = await envelope(sid);
      if (res.json && res.json.ok !== false && !(res.json.resumable && res.json.resumable.live === true)) return true;
      await sleep(100);
    }
    return false;
  };
  // 「工作台自己发起的一回合」——POST /api/chat/stream,source 恒为 'http'(10:2383 显式写死)。
  const classicTurn = session => new Promise(resolve => {
    const body = JSON.stringify({ sessionId: session.id, message: '你好', cwd: cwdOf(session) });
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...hdr },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.write(body); r.end();
  });

  // 管家会话必须先在(/api/steward/relay 要它)。它自己那一回合的 source 也是 'steward',
  // 所以它【不该】留下任何「上次用的」—— 下面 ①0 那条断言正是钉这一点。
  await request('POST', '/api/steward/message', { message: '现在什么情况' }, hdr);

  /* ═════════ ① 还没有记录:新线程跟全局(kimi) ═════════ */
  console.log('── ① 还没有记录 ──');
  {
    ok(lastUsed() === null, `①0 起点零记录(管家自己那一回合不算;got ${JSON.stringify(lastUsed())})`);
    const a = await newThread('A');
    ok(isAgent(a && a.engineRoute, 'kimi'), `①1 A 跟全局 = Agent CLI kimi(got ${JSON.stringify(a && a.engineRoute)})`);
    ok(fallbackRows().length === 0, `①2 「还没有上一次」不是回落,零 new_thread_engine_fallback(got ${fallbackRows().length})`);

    /* ═════════ ② 线程头换引擎 → 下一条新线程跟它 ═════════ */
    console.log('── ② 线程头 PATCH engineRoute ──');
    const patched = await request('POST', `/api/sessions/${encodeURIComponent(a.id)}`,
      { engineRoute: { engine: 'openai', providerId: 'px', model: 'model-x' } },
      { ...hdr, 'x-http-method': 'PATCH' });
    ok(patched.status === 200, `②1 PATCH 成功(got ${patched.status})`);
    ok(isOpenAi(await waitLastUsed(v => isOpenAi(v, 'px')), 'px'),
      `②2 「上次用的」记成了 X(got ${JSON.stringify(lastUsed())})`);
    const b = await newThread('B');
    ok(isOpenAi(b && b.engineRoute, 'px'), `②3 B = X,不再是全局的 kimi(got ${JSON.stringify(b && b.engineRoute)})`);
  }

  /* ═════════ ③ 工作台自己发起的一回合 → 下一条新线程跟它 ═════════ */
  console.log('── ③ 工作台发起的回合(source http) ──');
  {
    const c0 = await newThread('C0(显式 Y)', { engine: 'openai', providerId: 'py', model: 'model-y' });
    ok(isOpenAi(c0 && c0.engineRoute, 'py'), `③1 显式入参立刻生效(got ${JSON.stringify(c0 && c0.engineRoute)})`);
    await sleep(600);
    ok(isOpenAi(lastUsed(), 'px'),
      `③2 【建线程时带显式路由本身不记】—— 「上次用的」还是 X(got ${JSON.stringify(lastUsed())})`);
    ok(await classicTurn(c0), '③3 那一回合跑完');
    ok(await waitIdle(c0.id), '③4 会话回到空闲');
    ok(isOpenAi(await waitLastUsed(v => isOpenAi(v, 'py')), 'py'),
      `③5 「上次用的」被这一回合改成 Y(got ${JSON.stringify(lastUsed())})`);
    const c = await newThread('C');
    ok(isOpenAi(c && c.engineRoute, 'py'), `③6 C = Y(got ${JSON.stringify(c && c.engineRoute)})`);
  }

  /* ═════════ ④ 管家派出去的回合【不记】 ═════════ */
  console.log('── ④ source:steward 的回合 ──');
  {
    const d0 = await newThread('D0(显式 Z)', { engine: 'openai', providerId: 'pz', model: 'model-z' });
    ok(isOpenAi(d0 && d0.engineRoute, 'pz'), `④1 D0 钉在 Z 上(got ${JSON.stringify(d0 && d0.engineRoute)})`);
    // /api/steward/relay → 13h relayDeliver(空闲 → turn 通道)→ 13k stewardLaunchTurn({source:'steward'}),
    // 与真实管家派活逐字同一条路。
    const relayed = await request('POST', '/api/steward/relay', { sessionId: d0.id, message: '帮我把这件事做完' }, hdr);
    ok(!!(relayed.json && relayed.json.ok === true && relayed.json.channel === 'turn'),
      `④2 管家起了一个回合(channel=${relayed.json && relayed.json.channel} status=${relayed.status})`);
    ok(await waitIdle(d0.id), '④3 那个回合跑完');
    // 反向的等法:给记账留出与 ③ 同样的时间窗,窗口过完仍然是 Y 才算「真的没记」。
    const after = await waitLastUsed(v => isOpenAi(v, 'pz'), 3000);
    ok(isOpenAi(after, 'py'),
      `④4 「上次用的」【仍是 Y】—— 管家派的回合不算用户的意思表示(got ${JSON.stringify(after)})`);
    const d = await newThread('D');
    ok(isOpenAi(d && d.engineRoute, 'py'), `④5 D 仍是 Y,不是 Z(got ${JSON.stringify(d && d.engineRoute)})`);
  }

  /* ═════════ ⑤ newThreadEngine = 'global' → 回老行为 ═════════ */
  console.log('── ⑤ 改成跟随全局设置 ──');
  {
    const saved = await request('POST', '/api/config', { newThreadEngine: 'global' }, hdr);
    ok(saved.status === 200 && diskConfig().newThreadEngine === 'global',
      `⑤1 配置落盘(status=${saved.status} value=${diskConfig().newThreadEngine})`);
    const e = await newThread('E');
    ok(isAgent(e && e.engineRoute, 'kimi'), `⑤2 E 回到全局的 kimi(got ${JSON.stringify(e && e.engineRoute)})`);
    ok(isOpenAi(lastUsed(), 'py'), `⑤3 记录本身没被抹掉,只是不读它(got ${JSON.stringify(lastUsed())})`);
  }

  /* ═════════ ⑥ 改回 last,但那个端点已经不在了 → 回落 + 审计 ═════════ */
  console.log('── ⑥ 「上次用的」不可用时回落 ──');
  {
    const before = fallbackRows().length;
    const saved = await request('POST', '/api/config', { newThreadEngine: 'last', providers: [PX, PZ] }, hdr);
    ok(saved.status === 200, `⑥1 删掉 Y 这个端点(status=${saved.status})`);
    ok(!(diskConfig().providers || []).some(p => p && p.id === 'py'), '⑥2 config 里确实没有 py 了');
    const f = await newThread('F');
    ok(isAgent(f && f.engineRoute, 'kimi'),
      `⑥3 F 回落全局(不是拿一个已经不存在的端点开线程;got ${JSON.stringify(f && f.engineRoute)})`);
    const rows = fallbackRows();
    ok(rows.length === before + 1, `⑥4 审计里多出恰好一条 new_thread_engine_fallback(${before} → ${rows.length})`);
    const row = rows[rows.length - 1] || {};
    ok(row.sessionId === f.id && row.reason === 'provider_missing' && isOpenAi(row.last, 'py'),
      `⑥5 那条审计说清了「哪条线程、为什么、原来是谁」(got ${JSON.stringify({ sessionId: row.sessionId, reason: row.reason, last: row.last })})`);
  }

  /* ═════════ ⑦ 显式入参压过一切 ═════════ */
  console.log('── ⑦ POST /api/sessions 带显式 engineRoute ──');
  {
    // 此刻「上次用的」是不可用的 Y,全局是 kimi —— 两者都不是 X,显式那一份必须赢。
    const g = await newThread('G(显式 X)', { engine: 'openai', providerId: 'px', model: 'model-x' });
    ok(isOpenAi(g && g.engineRoute, 'px'), `⑦1 G = 显式给的 X(got ${JSON.stringify(g && g.engineRoute)})`);
    ok(String((g && g.engineRoute && g.engineRoute.model) || '') === 'model-x',
      `⑦2 显式那一份的 model 也照单收下(got ${JSON.stringify(g && g.engineRoute && g.engineRoute.model)})`);
  }

  /* ═════════ ⑧ 改全局也是一次显式选择(123-N2 合并复核) ═════════ */
  // 用户在设置里把全局引擎改成 X ——这一下必须成为「上次用的」;否则改完全局、新开一条线程,仍跟着
  // 改之前那一路走(agent-team-mode.e2e 合并后串行必红:切回 Claude 驱动后新会话仍走上一轮的 fake 端点)。
  console.log('── ⑧ POST /api/config 改 activeProvider ──');
  {
    const saved = await request('POST', '/api/config', { activeProvider: 'px' }, hdr);
    ok(saved.status === 200, `⑧1 把全局 activeProvider 改成 X(status=${saved.status})`);
    ok(await waitLastUsed(r => isOpenAi(r, 'px')), `⑧2 「上次用的」跟着变成 X(got ${JSON.stringify(lastUsed())})`);
    const h = await newThread('H(改全局之后)');
    ok(isOpenAi(h && h.engineRoute, 'px'), `⑧3 H = X(got ${JSON.stringify(h && h.engineRoute)})`);
    const back = await request('POST', '/api/config', { activeProvider: '' }, hdr);
    ok(back.status === 200 && await waitLastUsed(r => isAgent(r, 'kimi')),
      `⑧4 改回 Claude/Kimi 驱动同样被记住(got ${JSON.stringify(lastUsed())})`);
    const i2 = await newThread('I(改回全局之后)');
    ok(isAgent(i2 && i2.engineRoute, 'kimi'), `⑧5 I 跟着回到 kimi,不再是 X(got ${JSON.stringify(i2 && i2.engineRoute)})`);
  }
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  kill(wb);
  await new Promise(r => providerServer.close(r));
  await sleep(200);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* windows lock */ }
  console.log(`\nNEW THREAD ENGINE DEFAULT E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
