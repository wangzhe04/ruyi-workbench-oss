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
 *   L ?view=live(经典壳看别处起的回合时每条 thread.live 推送一发):回合在跑 → 轻量信封(view:'live'、无历史、
 *     liveTail/resumable.live 与全量那份相同、字节数远小于全量);回合收尾后 → 落回整份会话(与不带参数的全量同形)。
 *   M ?fromIndex=N&prefixStamp=S(经典壳自己起的回合收尾时的增量取):回合起点的 session 事件带 messagesStamp;
 *     戳对得上 → 只回 messages[N..](messagesFrom/messageCount/messagesStamp,不带 providerHistory),其余与全量相同;
 *     前端 fetchSessionAfterTurn 拼出来的信封与全量(去掉 providerHistory)深相等;增量与全量 ETag 不同、各自 304;
 *     垃圾/过期参数 → 与无参全量逐字节相同的体。
 *   S 回合起点 session 事件的增量(发送体带 knownMessages:{count,stamp}):戳对得上 → 事件只带 messages[N..]
 *     (messagesFrom/messageCount/messagesStamp,无 providerHistory),拼回前缀后的整份戳等于事件给的新戳、会话头与全量事件相同;
 *     垃圾/过期 knownMessages → 与不带时同形的全量事件(带 providerHistory 与 messagesStamp)。
 *   R 历史改写:原地改写前缀(条数不变)、撤回截断、撤回后再补回条数 → 落回全量;账本合并与压缩(只往末尾追加)→ 增量照样对,
 *     且可以拿增量回的新戳链式接着增量。
 */
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const assert = require('assert');
const { pathToFileURL } = require('url');
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
      // R3 的压缩走非流式的一发摘要请求,摘要要过五节结构校验(同 provider-compact.e2e 的判据:按请求体里的提示词认它)。
      if (req.stream === false && JSON.stringify(req.messages || []).includes('结构化摘要')) {
        return textFrames('【目标】测试目标\n【已确认的决定】无\n【未完成事项】无\n【当前执行状态】已完成：无；正在进行：测试；阻塞：无；下一步：继续\n【关键文件与上下文】无');
      }
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
    const getLive = id => request(WP, 'GET', `/api/sessions/${encodeURIComponent(id)}?view=live`, { headers: auth });
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

    // ── L ?view=live:回合在跑时只回在跑部分 ─────────────────────────────────────
    const lite = await getLive(sid);
    const full = await get(sid);
    ok(lite.status === 200 && lite.json && lite.json.ok === true && lite.json.view === 'live', 'L1 回合在跑 → ?view=live 回轻量信封(view:\'live\')');
    ok(lite.json && lite.json.session && lite.json.session.id === sid && lite.json.session.messages === undefined && lite.json.session.providerHistory === undefined,
      'L2 轻量信封不带历史(session 只有标量,没有 messages / providerHistory)');
    ok(lite.json && lite.json.resumable && lite.json.resumable.live === true && full.json.resumable.live === true, 'L3 resumable.live === true(与全量那份一致)');
    ok(lite.json && JSON.stringify(lite.json.liveTail) === JSON.stringify(full.json.liveTail) && JSON.stringify(lite.json.liveTurn) === JSON.stringify(full.json.liveTurn),
      'L4 liveTail / liveTurn 与全量那份逐字相同');
    ok(lite.json && lite.json.session.messageCount === full.json.session.messages.length && lite.json.resumable.turnSeq === full.json.resumable.turnSeq,
      `L5 标量与全量那份对得上(messageCount ${lite.json && lite.json.session.messageCount} / ${full.json.session.messages.length})`);
    ok(lite.text.length * 2 < full.text.length, `L6 字节数远小于全量(${lite.text.length} / ${full.text.length})`);

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
    const liteEnded = await getLive(sid);
    ok(liteEnded.status === 200 && liteEnded.json.view === undefined && Array.isArray(liteEnded.json.session.messages)
      && liteEnded.json.session.messages.length === ended.json.session.messages.length && liteEnded.json.resumable.live !== true,
      'L7 回合收尾后 ?view=live 落回整份会话(前端「换上来」那一支拿的就是它)');
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

    // ── M 增量取 ?fromIndex=N&prefixStamp=S(经典壳自己起的回合收尾时用)────────────────────────────────
    // 底子来自回合起点那条 session 事件(带 messagesStamp);客户端逻辑用的是前端模块里【同一个】fetchSessionAfterTurn,
    // api 换成打真服务的那一发。每一种情形都断言「客户端拿到的信封 === 无参全量(去掉 providerHistory)」。
    const runtime = await import(pathToFileURL(path.join(WB, 'app', 'public', 'js', 'chat-stream-runtime.js')).href);
    const getPath = (route, extra = {}) => request(WP, 'GET', route, { headers: { ...auth, ...extra } });
    const deltaRoute = (id, from, stamp) => `/api/sessions/${encodeURIComponent(id)}?fromIndex=${encodeURIComponent(from)}&prefixStamp=${encodeURIComponent(stamp)}`;
    const startEvent = async (id, message) => {
      const streamed = await turn(id, message);
      return String(streamed.text || '').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(evt => evt && evt.type === 'session') || null;
    };
    // 回合收尾后还有几拍延后落盘(见 D9):等到连续两次无参 GET 同标签,再拿那一份当「全量真值」。
    const steadyFull = async id => {
      let body = null;
      await waitFor(async () => {
        const a = await get(id); const b = await get(id);
        if (a.status === 200 && a.headers.etag && a.headers.etag === b.headers.etag && a.text === b.text) { body = b; return true; }
        return null;
      }, 60, 100);
      return body;
    };
    const dropProviderHistory = envelope => {
      const { providerHistory: _ignored, ...session } = envelope.session;
      return { ...envelope, session };
    };
    const clientFetch = async (id, base) => {
      const paths = [];
      const api = async route => {
        paths.push(route);
        const r = await getPath(route);
        if (r.status !== 200) throw new Error(`HTTP ${r.status} ${route}`);
        return r.json;
      };
      const result = await runtime.fetchSessionAfterTurn(api, id, base);
      return { result, paths };
    };
    const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };

    const createdM = await request(WP, 'POST', '/api/sessions', { headers: auth, body: { title: 'delta', cwd: HOME } });
    const sidM = createdM.json.session.id;
    await turn(sidM, 'delta one');
    await turn(sidM, 'delta two');
    const start3 = await startEvent(sidM, 'delta three');
    const N = start3 && start3.session && Array.isArray(start3.session.messages) ? start3.session.messages.length : -1;
    ok(N >= 4 && /^m1\.\d+\.[0-9a-f]{40}$/.test(String(start3.messagesStamp || '')) && start3.messagesStamp.startsWith(`m1.${N}.`),
      `M1 回合起点的 session 事件带 messagesStamp(m1.<N>.<sha1>,N = 下发的条数 ${N})`);
    const fullM = await steadyFull(sidM);
    const deltaM = await getPath(deltaRoute(sidM, N, start3.messagesStamp));
    ok(deltaM.status === 200 && deltaM.json && deltaM.json.messagesFrom === N && deltaM.json.messageCount === fullM.json.session.messages.length
      && fullM.json.session.messages.length > N, `M2 前缀对得上 → 增量:messagesFrom=${deltaM.json && deltaM.json.messagesFrom}、messageCount=整份条数`);
    ok(same(deltaM.json.session.messages, fullM.json.session.messages.slice(N)), 'M3 增量的 messages 正是全量的 messages[N..]');
    ok(deltaM.json.session.providerHistory === undefined && Array.isArray(fullM.json.session.providerHistory), 'M4 增量不带 providerHistory(全量照旧带)');
    {
      const { messages: _m1, providerHistory: _p1, ...fullHead } = fullM.json.session;
      const { messages: _m2, ...deltaHead } = deltaM.json.session;
      ok(same(deltaHead, fullHead), 'M5 增量里会话头的其余字段与全量逐项相同(title/todos/mission/turnSeq/…)');
    }
    ok(same(deltaM.json.resumable, fullM.json.resumable) && deltaM.json.displayTitle === fullM.json.displayTitle, 'M6 信封上的 resumable / displayTitle 与全量相同');
    ok(deltaM.text.length < fullM.text.length, `M7 增量体比全量小(${deltaM.text.length} / ${fullM.text.length} 字节)`);
    runtime.rememberMessagesStamp(start3.session.messages, start3.messagesStamp);
    const spliced = await clientFetch(sidM, start3.session);
    ok(spliced.paths.length === 1 && spliced.paths[0].includes(`fromIndex=${N}&prefixStamp=`), `M8 客户端只发一发增量(${spliced.paths.join(' , ')})`);
    ok(same(spliced.result, dropProviderHistory(fullM.json)), 'M9 客户端拼出来的信封与全量(去掉 providerHistory)深相等');
    ok(spliced.result.session.messages !== start3.session.messages && start3.session.messages.length === N, 'M10 拼接出的是新数组,底子那份一条没多(不就地改共享数组)');
    // ETag:参数改变响应体,所以进标签。
    ok(deltaM.headers.etag && fullM.headers.etag && deltaM.headers.etag !== fullM.headers.etag, 'M11 同一状态下增量与全量的 ETag 不同');
    const delta304 = await getPath(deltaRoute(sidM, N, start3.messagesStamp), { 'if-none-match': deltaM.headers.etag });
    ok(delta304.status === 304, 'M12 增量带自己的标签再来 → 304');
    const crossed = await get(sidM, { 'if-none-match': deltaM.headers.etag });
    ok(crossed.status === 200 && crossed.text === fullM.text, 'M13 拿增量的标签去问无参全量 → 200 全量(不会错配成 304)');
    // 新整份戳可以接着用:从末尾增量 = 空尾巴。
    const chained = await getPath(deltaRoute(sidM, deltaM.json.messageCount, deltaM.json.messagesStamp));
    ok(chained.status === 200 && chained.json.messagesFrom === deltaM.json.messageCount && chained.json.session.messages.length === 0,
      'M14 增量回的 messagesStamp 就是整份的戳(从末尾接着增量 → 空尾巴)');
    // 垃圾 / 过期参数:一律回全量,且体与无参全量逐字节相同。
    const zeros = '0'.repeat(40);
    const flipped = start3.messagesStamp.slice(0, -1) + (start3.messagesStamp.endsWith('0') ? '1' : '0');
    const fallbacks = [
      ['fromIndex 非数字', deltaRoute(sidM, 'abc', start3.messagesStamp)],
      ['fromIndex 负数', deltaRoute(sidM, '-1', start3.messagesStamp)],
      ['fromIndex 小数', deltaRoute(sidM, '1.5', start3.messagesStamp)],
      ['fromIndex 超出条数', deltaRoute(sidM, 999999, `m1.999999.${zeros}`)],
      ['fromIndex 与戳的条数不符', deltaRoute(sidM, N - 1, start3.messagesStamp)],
      ['戳的哈希被改一位', deltaRoute(sidM, N, flipped)],
      ['戳的版本不认识', deltaRoute(sidM, N, start3.messagesStamp.replace(/^m1\./, 'm9.'))],
      ['戳为空', deltaRoute(sidM, N, '')],
      ['只有 fromIndex', `/api/sessions/${encodeURIComponent(sidM)}?fromIndex=${N}`],
      ['只有 prefixStamp', `/api/sessions/${encodeURIComponent(sidM)}?prefixStamp=${encodeURIComponent(start3.messagesStamp)}`],
    ];
    for (const [label, route] of fallbacks) {
      const r = await getPath(route);
      ok(r.status === 200 && r.json && r.json.messagesFrom === undefined && r.text === fullM.text, `M15 ${label} → 全量,体与无参全量逐字节相同`);
    }

    // ── R 历史被改写 → 自动落回全量;尾部追加(账本合并 / 压缩)→ 增量照样对 ──────────────────────────────
    // R1 原地改写第 0 条的正文(条数、id、角色都不变 —— 只比条数或 id 的戳会漏掉这一类:蒸发、惰性清理、编辑都是这个形状)。
    const bodyFile = path.join(HOME, 'sessions', sidM + '.messages.ndjson');
    const bodyLines = fs.readFileSync(bodyFile, 'utf8').split('\n');
    const first0 = JSON.parse(bodyLines[0]);
    bodyLines[0] = JSON.stringify({ ...first0, content: String(first0.content || '') + ' [rewritten in place]' });
    fs.writeFileSync(bodyFile, bodyLines.join('\n'), 'utf8');
    const fullR1 = await steadyFull(sidM);
    ok(fullR1.json.session.messages.length === fullM.json.session.messages.length && /rewritten in place/.test(fullR1.json.session.messages[0].content),
      'R1 前提:改写后条数不变、第 0 条是新内容');
    const r1 = await getPath(deltaRoute(sidM, N, start3.messagesStamp));
    ok(r1.status === 200 && r1.json.messagesFrom === undefined && r1.text === fullR1.text, 'R1 前缀被原地改写 → 旧戳对不上 → 全量(逐字节同无参)');
    const r1Client = await clientFetch(sidM, start3.session);
    ok(same(r1Client.result, fullR1.json) && /rewritten in place/.test(r1Client.result.session.messages[0].content), 'R1 客户端拿到的就是全量(改写后的第 0 条),不是拼上旧前缀');
    // R2 后台任务账本合并(loadSession 往末尾追加回执):增量里带着它,拼出来仍与全量相同。
    const start4 = await startEvent(sidM, 'delta four');
    ok(start4 && /rewritten in place/.test(start4.session.messages[0].content), 'R2 前提:新回合起点下发的底子里是改写后的第 0 条');
    await steadyFull(sidM);
    fs.writeFileSync(path.join(ledgerDir, sidM + '.json'), JSON.stringify([{
      id: 'job_delta_1', shellId: 'sh_d1', name: 'bg-delta', sessionId: sidM, status: 'succeeded', exitCode: 0,
      output: 'delta-ledger-output', completedAt: new Date().toISOString(),
    }]), 'utf8');
    const fullR2 = await steadyFull(sidM);
    runtime.rememberMessagesStamp(start4.session.messages, start4.messagesStamp);
    const r2Client = await clientFetch(sidM, start4.session);
    ok(r2Client.paths.length === 1 && r2Client.paths[0].includes('fromIndex='), 'R2 账本只往末尾追加 → 仍是一发增量');
    ok(same(r2Client.result, dropProviderHistory(fullR2.json)) && r2Client.result.session.messages.some(m => m && m.backgroundJobId === 'job_delta_1'),
      'R2 拼出来的信封与全量深相等,且带着合并进来的回执');
    // R3 压缩(providerHistory 整份换掉、messages 末尾追加一条「已压缩」):底子用 R2 拼出来的那一份(它记着增量回的新戳 = 链式)。
    const compacted = await request(WP, 'POST', '/api/provider/compact', { headers: auth, body: { sessionId: sidM } });
    ok(compacted.status === 200 && compacted.json && compacted.json.ok === true, `R3 前提:压缩成功(${compacted.status} ${compacted.json && compacted.json.error ? JSON.stringify(compacted.json.error) : ''})`);
    const fullR3 = await steadyFull(sidM);
    const r3Client = await clientFetch(sidM, r2Client.result.session);
    ok(r3Client.paths.length === 1 && r3Client.paths[0].includes(`fromIndex=${r2Client.result.session.messages.length}&`), 'R3 链式:拿 R2 增量回的戳接着增量');
    ok(same(r3Client.result, dropProviderHistory(fullR3.json)), 'R3 压缩后拼出来的信封与全量(去掉 providerHistory)深相等');
    {
      const tail = r3Client.result.session.messages[r3Client.result.session.messages.length - 1];
      ok(tail && tail.role === 'system' && /已压缩/.test(String(tail.content || '')), 'R3 「已压缩」那条系统消息是从增量尾巴里拼进来的');
    }
    // R4 撤回(截断):底子比现有条数长 → 全量;再跑回合把条数补回来(内容不同)→ 旧戳仍对不上 → 全量。
    const baseR4 = r3Client.result.session;
    const rewound = await request(WP, 'POST', '/api/session/rewind', { headers: auth, body: { sessionId: sidM, targetTurnSeq: 2 } });
    ok(rewound.status === 200 && rewound.json && rewound.json.ok === true, 'R4 前提:撤回到第 2 回合之前');
    const fullR4 = await steadyFull(sidM);
    ok(fullR4.json.session.messages.length < baseR4.messages.length, `R4 前提:撤回后条数变少(${fullR4.json.session.messages.length} < ${baseR4.messages.length})`);
    const r4Client = await clientFetch(sidM, baseR4);
    ok(r4Client.paths.length === 1 && same(r4Client.result, fullR4.json), 'R4 撤回后旧底子(N 超长)→ 服务端回全量,客户端原样收下');
    for (let i = 0; i < 6; i++) {
      const cur = await get(sidM);
      if (cur.json.session.messages.length >= baseR4.messages.length) break;
      await turn(sidM, 'after rewind ' + i);
    }
    const fullR4b = await steadyFull(sidM);
    ok(fullR4b.json.session.messages.length >= baseR4.messages.length, 'R4 前提:撤回后又跑回合,条数补回到不少于旧底子');
    const r4bRoute = runtime.sessionRefetchPath(sidM, baseR4);
    const r4b = await getPath(r4bRoute);
    ok(r4bRoute.includes(`fromIndex=${baseR4.messages.length}&`) && r4b.status === 200 && r4b.json.messagesFrom === undefined && r4b.text === fullR4b.text, 'R4 条数够了但前缀内容已变 → 旧戳对不上 → 全量');
    const r4bClient = await clientFetch(sidM, baseR4);
    ok(same(r4bClient.result, fullR4b.json), 'R4 客户端拿到的就是全量');

    // ── S 回合起点 session 事件的增量(发送体带 knownMessages)────────────────────────────────────────────
    // 真值:同一时刻服务端的整份 messages 的戳(测试端按 02 的口径 m1.<n>.<sha1(每条 JSON + '\n')> 自己算一遍)。
    const crypto = require('crypto');
    const stampOf = list => `m1.${list.length}.${list.reduce((h, m) => h.update(JSON.stringify(m) + '\n'), crypto.createHash('sha1')).digest('hex')}`;
    const turnWith = (id, message, extra) => request(WP, 'POST', '/api/chat/stream', { headers: auth, body: { sessionId: id, message, cwd: HOME, ...extra } });
    const startEventWith = async (id, message, extra) => String((await turnWith(id, message, extra)).text || '').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } }).find(evt => evt && evt.type === 'session') || null;
    const startS0 = await startEvent(sidM, 'start delta base');
    await steadyFull(sidM);
    const known = { count: startS0.session.messages.length, stamp: startS0.messagesStamp };
    // 底子是 startS0 那一刻的前 N 条;回合收尾后服务端又多了助手回复,所以这里用收尾后的整份当底子(与经典壳收尾后手上那份同形)。
    runtime.rememberMessagesStamp(startS0.session.messages, startS0.messagesStamp);
    const baseS = (await clientFetch(sidM, startS0.session)).result.session;
    const knownS = runtime.knownMessagesFor(baseS);
    ok(knownS && knownS.count === baseS.messages.length && knownS.count > known.count, `S0 前提:收尾拼出来的底子带着新戳(${knownS && knownS.count} 条)`);
    const startS1 = await startEventWith(sidM, 'start delta one', { knownMessages: knownS });
    // 起点事件发在「把这一回合的 user 消息写进 messages」之前,所以常见情形尾巴是空的 —— 整条事件只剩会话头。
    ok(startS1 && startS1.messagesFrom === knownS.count && Number.isInteger(startS1.messageCount) && startS1.messageCount >= knownS.count,
      `S1 带 knownMessages 且戳对得上 → 起点事件是增量(messagesFrom=${startS1 && startS1.messagesFrom}、messageCount=${startS1 && startS1.messageCount})`);
    ok(startS1 && startS1.session.providerHistory === undefined && startS1.session.messages.length === startS1.messageCount - knownS.count,
      'S2 增量事件不带 providerHistory,messages 只是尾巴');
    const splicedS1 = runtime.spliceSessionDelta(baseS.messages, startS1);
    ok(splicedS1 && stampOf(splicedS1.session.messages) === startS1.messagesStamp && startS1.messagesStamp.startsWith(`m1.${startS1.messageCount}.`),
      'S3 拼回前缀后整份的戳 = 事件给的新戳(与服务端那一刻的整份逐条相同)');
    ok(splicedS1 && runtime.knownMessagesFor(splicedS1.session)?.stamp === startS1.messagesStamp, 'S4 拼出来的新数组记着新戳(收尾那一发可以接着增量)');
    const fullS1 = await steadyFull(sidM);
    ok(splicedS1 && same(splicedS1.session.messages, fullS1.json.session.messages.slice(0, startS1.messageCount)), 'S5 拼出来的 messages 是回合收尾后全量的前缀');
    // 会话头:与不带 knownMessages 的全量起点事件对比(同一会话的下一回合;turnSeq/updatedAt 这类随回合变的字段除外)。
    const startS2full = await startEvent(sidM, 'start delta two');
    {
      const volatile = ['turnSeq', 'updatedAt', 'lastTurnAt', 'lastActivityAt', 'stewardTaint'];
      const pick = sess => Object.keys(sess).filter(k => !['messages', 'providerHistory', ...volatile].includes(k)).sort();
      ok(startS2full && same(pick(startS1.session), pick(startS2full.session)), `S6 增量事件的会话头键集与全量事件相同(除 messages/providerHistory)`);
      ok(startS2full && startS2full.messagesFrom === undefined && Array.isArray(startS2full.session.providerHistory) && /^m1\./.test(startS2full.messagesStamp || ''),
        'S7 不带 knownMessages → 修前那条全量事件(带 providerHistory 与 messagesStamp)');
    }
    await steadyFull(sidM);
    const fullNow = (await get(sidM)).json.session.messages;
    const goodNow = { count: fullNow.length, stamp: stampOf(fullNow) };
    const zerosS = '0'.repeat(40);
    const badKnown = [
      ['字符串', 'garbage'],
      ['count 非整数', { count: 1.5, stamp: goodNow.stamp }],
      ['count 为字符串垃圾', { count: 'abc', stamp: goodNow.stamp }],
      ['count 与戳条数不符', { count: goodNow.count - 1, stamp: goodNow.stamp }],
      ['戳哈希不对', { count: goodNow.count, stamp: `m1.${goodNow.count}.${zerosS}` }],
      ['count 超出条数', { count: 999999, stamp: `m1.999999.${zerosS}` }],
      ['缺 stamp', { count: goodNow.count }],
    ];
    for (const [label, bad] of badKnown) {
      await steadyFull(sidM);
      const evt = await startEventWith(sidM, 'bad known ' + label, { knownMessages: bad });
      ok(evt && evt.messagesFrom === undefined && Array.isArray(evt.session.providerHistory) && stampOf(evt.session.messages) === evt.messagesStamp,
        `S8 knownMessages ${label} → 全量事件(带 providerHistory,戳与整份相符)`);
    }
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    kill(wb);
    await fake.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  t.done();
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 2; });
