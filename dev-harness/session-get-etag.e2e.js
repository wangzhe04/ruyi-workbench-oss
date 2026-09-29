'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
/*
 * GET /api/sessions/:id 的条件 GET(ETag / 304)—— perf:这条路由每 3 s(直播回合)/ 5–30 s(管家抽屉)被轮询,
 * 而服务端每次装载整份会话(头 + 两个正文 + 逐行 sha1;18 MB 会话 250–350 ms)。设计见 13d 的 sessionEnvelopeStamp /
 * sessionEnvelopeEtag。真服务 + 假 provider,断言的是【行为】:
 *   A 首发 200 带 ETag + cache-control:no-store,体里仍有 providerHistory(大量 e2e 与脚本从这里读它,不删);
 *   B 带 If-None-Match 再来:304、无体、ETag 不变(重复多次都是 304);
 *   C 追加消息(再跑一回合)→ 标签变、200,体里是新消息;之后新标签又是 304;
 *   D 直播态:回合在跑 → 标签变(活回合标志/liveTail 进标签);provider 吐出新文本 → 标签再变、体里 liveTail.full 是新文本;
 *     回合收尾 → 标签变、liveTail 键消失、消息追加;之后又稳定成 304;
 *   E 活回合中途 PATCH 权限档(只进内存覆盖表、延后落盘,头文件在回合期间不变):标签也必须变、体里是新档 ——
 *     这是「头哈希不变但响应变了」的那一类输入,不进标签就会拿 304 + 旧档;
 *   H 后台任务账本(loadSession 合并进 messages 的旁车文件)变了 → 标签变;
 *   F 304 不装载会话:盘上放一份假的残留快照(.prevbody,loadSession 装载时会顺手清掉),304 之后它还在,全量 200 之后它没了;
 *     头一变(PATCH 标题)→ 200 + 新标签;
 *   G 没有 If-None-Match / 标签对不上 → 与修前一样的 200 全量;不存在的会话仍是 404(不发 ETag)。
 */
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-etag-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const t = createRunner('SESSION GET ETAG');
const { ok } = t;

function request(port, method, route, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method, timeout: 20000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers },
    }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timeout ' + route)); });
    if (raw) req.write(raw);
    req.end();
  });
}
async function waitFor(fn, tries = 100, gap = 100) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await sleep(gap); }
  return null;
}
function kill(proc) { if (proc && proc.pid) try { killOwnTree(proc); } catch { /* already gone */ } }

(async () => {
  const WP = await getFreePort();
  // 假 provider:mode 'quick' = 立刻答一句;mode 'hold' = 自己接管 req(先不写任何帧,测试端决定何时吐字、何时收尾)。
  let mode = 'quick';
  let held = null;
  const arrived = [];
  const fake = await startFakeProvider({
    handler(req) {
      if (mode === 'hold') { held = req; req.open(); arrived.push(req.index); return undefined; }
      return textFrames('quick answer');
    },
  });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', defaultWorkspace: HOME, includeWorkbenchMcp: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME },
  });
  try {
    ok(!!(await waitFor(() => request(WP, 'GET', '/health').then(r => r.json).catch(() => null), 100, 120)), 'workbench starts');
    const html = (await request(WP, 'GET', '/')).text;
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const auth = { 'x-wcw-token': token };
    const get = (id, extra = {}) => request(WP, 'GET', `/api/sessions/${encodeURIComponent(id)}`, { headers: { ...auth, ...extra } });
    const patch = (id, body) => request(WP, 'POST', `/api/sessions/${encodeURIComponent(id)}`, { headers: { ...auth, 'x-http-method': 'PATCH' }, body });
    // 一个回合:发 /api/chat/stream,读到流结束(hold 模式下由测试端收尾 provider 才会结束)。
    const turn = (sessionId, message) => request(WP, 'POST', '/api/chat/stream', { headers: auth, body: { sessionId, message, cwd: HOME } });

    const created = await request(WP, 'POST', '/api/sessions', { headers: auth, body: { title: 'etag', cwd: HOME } });
    const sid = created.json.session.id;
    await turn(sid, 'hello');

    // ── A 首发 200 ─────────────────────────────────────────────────────────────
    const first = await get(sid);
    const etag1 = first.headers.etag;
    ok(first.status === 200 && /^W\/"session-[0-9a-f]+"$/.test(etag1 || ''), 'A1 首发 200 带 ETag(session-<hash> 弱标签)');
    ok(String(first.headers['cache-control'] || '') === 'no-store', 'A2 cache-control: no-store(浏览器不自己缓存,条件请求只由前端 net.js 显式带)');
    ok(first.json && first.json.ok === true && first.json.session && first.json.session.messages.length >= 2, 'A3 体里是完整会话(至少 user+assistant 两条)');
    ok(Array.isArray(first.json.session.providerHistory) && first.json.session.providerHistory.length >= 2, 'A4 providerHistory 仍在体里(不删,e2e/脚本在读)');
    ok(first.json.resumable && first.json.resumable.live !== true && typeof first.json.displayTitle === 'string', 'A5 信封其余键原样(resumable / displayTitle)');

    // ── B 304 ──────────────────────────────────────────────────────────────────
    const b1 = await get(sid, { 'if-none-match': etag1 });
    const b2 = await get(sid, { 'if-none-match': etag1 });
    ok(b1.status === 304 && b1.text === '' && b1.headers.etag === etag1, 'B1 带 If-None-Match 且没变 → 304、无体、ETag 不变');
    ok(b2.status === 304, 'B2 重复来仍是 304(稳定,不是一次性)');
    ok(String(b1.headers['cache-control'] || '') === 'no-store', 'B3 304 也带 no-store');
    const multi = await get(sid, { 'if-none-match': `W/"nope", ${etag1}` });
    ok(multi.status === 304, 'B4 If-None-Match 列表里含当前标签也算命中');

    // ── G 对不上 / 没带 / 不存在 ────────────────────────────────────────────────
    const wrong = await get(sid, { 'if-none-match': 'W/"session-0000"' });
    ok(wrong.status === 200 && wrong.headers.etag === etag1 && wrong.json.session.messages.length === first.json.session.messages.length, 'G1 标签对不上 → 200 全量,标签还是当前那个');
    const missing = await get('sess_doesnotexist');
    ok(missing.status === 404 && !missing.headers.etag, 'G2 不存在的会话仍是 404 且不发 ETag');

    // ── C 追加消息 ─────────────────────────────────────────────────────────────
    await turn(sid, 'second question');
    const afterAppend = await get(sid, { 'if-none-match': etag1 });
    const etag2 = afterAppend.headers.etag;
    ok(afterAppend.status === 200 && etag2 && etag2 !== etag1, 'C1 追加消息之后旧标签不再命中:200 + 新标签');
    ok(afterAppend.json.session.messages.length > first.json.session.messages.length, 'C2 体里是新消息');
    const c3 = await get(sid, { 'if-none-match': etag2 });
    ok(c3.status === 304, 'C3 新标签随即又是 304');

    // ── D 直播态 ───────────────────────────────────────────────────────────────
    mode = 'hold';
    const turnDone = turn(sid, 'third question, held');
    ok(!!(await waitFor(() => arrived.length > 0 ? true : null, 100, 100)), 'D0 回合在跑,provider 已收到请求(被我们扣住)');
    const live1 = await get(sid, { 'if-none-match': etag2 });
    const etagLive1 = live1.headers.etag;
    ok(live1.status === 200 && etagLive1 && etagLive1 !== etag2, 'D1 回合起跑后(活回合标志进标签):旧标签不再命中');
    ok(live1.json.resumable && live1.json.resumable.live === true, 'D2 体里 resumable.live === true');
    const live1b = await get(sid, { 'if-none-match': etagLive1 });
    ok(live1b.status === 304, 'D3 活态没变时(provider 还没吐字)同一标签仍是 304');

    for (const frame of textFrames('streaming-partial-text ', { finish: null })) held.sse(frame);
    const live2 = await waitFor(async () => {
      const r = await get(sid, { 'if-none-match': etagLive1 });
      return r.status === 200 && r.headers.etag !== etagLive1 ? r : null;
    }, 60, 100);
    ok(!!live2, 'D4 provider 吐出新文本 → liveTail 变了 → 标签变、200');
    ok(live2 && live2.json.liveTail && String(live2.json.liveTail.full || '').includes('streaming-partial-text'), 'D5 体里 liveTail.full 是新文本');

    // ── E 活回合中途改权限档:只进内存覆盖表,头文件不变,标签也必须变 ───────────────
    const headFile = path.join(HOME, 'sessions', sid + '.json');
    const headBefore = fs.readFileSync(headFile, 'utf8');
    const stableLive = live2 ? live2.headers.etag : '';
    const stableCheck = await get(sid, { 'if-none-match': stableLive });
    ok(stableCheck.status === 304, 'E0 前提:改档前这个活态标签是 304');
    const patched = await patch(sid, { permissionMode: 'plan' });
    ok(patched.status === 200, 'E1 活回合中途 PATCH permissionMode → 200');
    ok(fs.readFileSync(headFile, 'utf8') === headBefore, 'E2 前提成立:回合期间头文件没变(改档延后落盘,只在内存覆盖表里)');
    const afterPatch = await get(sid, { 'if-none-match': stableLive });
    ok(afterPatch.status === 200 && afterPatch.headers.etag !== stableLive, 'E3 头文件没变,但覆盖表变了 → 标签变(否则会拿 304 + 旧档)');
    ok(afterPatch.json.session.permissionMode === 'plan', 'E4 体里的会话权限档是新档(loadSession 把内存覆盖盖上去了)');

    // 收尾:回合结束 → 标签变、liveTail 键消失、消息追加
    for (const frame of textFrames('final-part', { finish: 'stop' })) held.sse(frame);
    held.end();
    await turnDone;
    mode = 'quick';
    const ended = await waitFor(async () => {
      const r = await get(sid, { 'if-none-match': afterPatch.headers.etag });
      return r.status === 200 && r.json && r.json.liveTail === undefined && r.json.resumable && r.json.resumable.live !== true ? r : null;
    }, 80, 100);
    ok(!!ended, 'D6 回合收尾 → 标签变、200、liveTail 键消失、resumable.live 不再是 true');
    ok(ended && ended.json.session.messages.length > afterAppend.json.session.messages.length, 'D7 体里是回合收尾落盘的新消息');
    ok(ended && ended.json.session.permissionMode === 'plan', 'D8 延后落盘的权限档随回合收尾落到了头上');
    // 回合收尾后还有延后落盘(权限档覆盖表清空、收尾窗口关闭)—— 标签会随之再动几次,这是「多刷新、不漏刷新」的方向。
    // 稳态 = 连续两次无条件 GET 拿到同一个标签;到了稳态,带这个标签的条件 GET 必须是 304(不是永远追不上的标签)。
    let settledEtag = '';
    await waitFor(async () => {
      const a = await get(sid); const b = await get(sid);
      if (a.headers.etag && a.headers.etag === b.headers.etag) { settledEtag = a.headers.etag; return true; }
      return null;
    }, 60, 100);
    const settled = settledEtag ? await get(sid, { 'if-none-match': settledEtag }) : null;
    ok(!!settled && settled.status === 304, 'D9 收尾后达到稳态:连续两次 GET 同一个标签,且带它的条件 GET 是 304');

    // ── H 后台任务账本:loadSession 会把 sessions/background-jobs/<id>.json 合并进 messages,账本变了标签必须变 ──────
    // (13d 里那条账本路径是照 11-native-tools 的 backgroundJobFile 约定手写的一份 —— 这一段钉住它不漂移。)
    const ledgerDir = path.join(HOME, 'sessions', 'background-jobs');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, sid + '.json'), JSON.stringify([{
      id: 'job_etag_1', shellId: 'sh_1', name: 'bg-probe', sessionId: sid, status: 'succeeded', exitCode: 0,
      output: 'ledger-output', completedAt: new Date().toISOString(),
    }]), 'utf8');
    const h1 = await get(sid, { 'if-none-match': settledEtag });
    ok(h1.status === 200 && h1.headers.etag !== settledEtag, 'H1 后台任务账本出现 → 标签变(头与正文都没动,只有账本变了)');
    ok(h1.json.session.messages.some(m => m.backgroundJobId === 'job_etag_1'), 'H2 体里带着合并进来的回执消息');
    let ledgerEtag = '';
    await waitFor(async () => {
      const a = await get(sid); const b = await get(sid);
      if (a.headers.etag && a.headers.etag === b.headers.etag) { ledgerEtag = a.headers.etag; return true; }
      return null;
    }, 60, 100);
    const h3 = ledgerEtag ? await get(sid, { 'if-none-match': ledgerEtag }) : null;
    ok(!!h3 && h3.status === 304, 'H3 账本稳定后同一标签又是 304');

    // ── F 304 不装载会话 ────────────────────────────────────────────────────────
    const stable = ledgerEtag || settledEtag || etag2;
    // 判据:loadSession 在读到完整可读的 v2 会话后会顺手清掉残留的 <id>.messages.ndjson.prevbody(慢路径崩溃留下的快照,见 02
    // loadSession 尾部的清理)。放一份假的残留在盘上:304 路径若装载了会话,它就没了;不装载,它原样还在。
    // (比「同大小改写正文再拨回 mtime」稳:后者要求亚毫秒精度的 utimes 往返,在不同文件系统上会抖。)
    const prevBody = path.join(HOME, 'sessions', sid + '.messages.ndjson.prevbody');
    fs.writeFileSync(prevBody, 'stale-prevbody-marker\n', 'utf8');
    const f1 = await get(sid, { 'if-none-match': stable });
    ok(f1.status === 304, 'F1 带当前标签 → 304');
    ok(fs.existsSync(prevBody), 'F2 304 之后残留快照原样还在 —— 304 路径没有装载会话(装载会清掉它)');
    const wrongTag = await get(sid, { 'if-none-match': 'W/"session-1111"' });
    ok(wrongTag.status === 200 && !fs.existsSync(prevBody), 'F3 标签对不上走全量:这一次装载了会话,顺手清掉了残留快照(对照:证明上一条的判据有效)');
    const renamed = await patch(sid, { title: 'etag-renamed' });
    ok(renamed.status === 200, 'F4 PATCH 标题 → 头变了');
    const f5 = await get(sid, { 'if-none-match': stable });
    ok(f5.status === 200 && f5.headers.etag !== stable, 'F5 头一变 → 200 + 新标签');
    ok(f5.json.session.title === 'etag-renamed', 'F6 体里是新标题');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    kill(wb);
    await fake.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  t.done();
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 2; });
