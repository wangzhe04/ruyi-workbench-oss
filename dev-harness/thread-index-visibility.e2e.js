#!/usr/bin/env node
'use strict';

// E2E(第 121 波 K3 · 34 号文 §4.1/§4.2):任务索引口径 —— 来源三值、两个判据、窗口、liveTail 摘要。
//
// 修前的病根(§1.3,对着源码数过的):`/api/missions` 的行集是 `index.sessions.filter(row => row.card)`,
// 而卡片只在 `kind === 'mission' || stewardWatchedThread(...)` 时生成 —— 于是**用户自己在 2.0 里开的
// 普通会话永远没有卡片、永远不进 /api/missions、永远不上看板**。13e 的注释把这写成「刻意的,理由是
// 噪音」。K3 把一个判据拆成两个:watched(管家要不要动手)与 visible(要不要进索引),噪音改用窗口治。
//
// 本件证伪六条(每条都在文末 REVERSE VERIFICATION 里给了「拔掉哪一行 → 哪条断言变红」):
//   A 2.0 新开的普通会话出现在 /api/missions,且 origin==='user'、watched===false;
//   B 窗口生效:threadIndexRecent 钳到 10 时,15 条存量旧会话里只有最近的那几条进索引,最老的不进;
//   C stewardWatch:true 写口 —— 一条窗口外的旧线程被「交给管家盯」之后进索引,watched===true;
//   D stewardWatch:false 对【管家自己开的】线程同样生效(= 用户接手):写 false 之后它掉出索引;
//   E 收件箱第四源:watched 的线程回合结束后进箱;非 watched 的同款线程不进(过滤保留);
//   F liveTail 摘要:活回合期间非空、带得出工具名与迭代数,且【一个字正文都没有】(§6.1 红线)。
//
// 夹具:temp HOME + 假 OpenAI 兼容 provider(同 event-stream.e2e.js 那一套),不开浏览器。
// 判定行:`THREAD INDEX VISIBILITY E2E: ALL PASS`。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

// 窗口大小。10 是 01-config 的 THREAD_INDEX_RECENT_MIN —— 取下限是为了让「窗口外」这件事在
// 15 条存量会话上就成立,不必造几百条。
const RECENT = 10;
const OLD_COUNT = 15;
// 第一发模型调用流多长时间的 delta:要够我们在回合还没结束时轮到一次 /api/missions 看见 liveTail。
const STREAM_MS = 2500;

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 60000,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw);
    req.end();
  });
}

async function waitForHttp(port, method, pathname, predicate, token, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, method, pathname, null, token);
    if (result && predicate(result)) return result;
    await sleep(100);
  }
  return null;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// ── 假 provider:管家一句收;线程第一发慢慢说(攒 liveTail)再要一次 file_read;此后一句收工 ──
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
    const isSteward = /我是如意/.test(sys);
    const toolMsgs = messages.filter(m => m && m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
    const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

    if (isSteward) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }) }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    if (!toolMsgs.length) {
      const ticks = Math.max(6, Math.round(STREAM_MS / 300));
      for (let i = 0; i < ticks; i++) {
        sse({ choices: [{ index: 0, delta: { role: 'assistant', content: `第${i + 1}段:我在看这件事。` }, finish_reason: null }] });
        await sleep(300);
      }
      const args = JSON.stringify({ path: 'probe.txt' });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    // 工具跑完之后【继续慢慢说】几秒:F7 要在「iterations 已经 +1」且「回合还没结束」的窗口里
    // 轮到一次 /api/missions。修前这里一句话就收工,那个窗口只有几百毫秒 —— 轮询抓不住,断言会
    // 随机变红(而「跑几次没红」不是它不抖的证据,30 号文 §8.14)。
    for (let i = 0; i < 10; i++) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: `读完了,接着说第${i + 1}句。` }, finish_reason: null }] });
      await sleep(300);
    }
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '收工了,结论在这儿。' }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

// ── 存量旧会话的造法 ────────────────────────────────────────────────────────
// 全部是【用户自己在 2.0 里聊过的普通会话】:kind quick_ask、missionId === sessionId、
// 无 stewardQuick、无 launchedBy —— 修前这种会话恒无卡片,正是 §1.3 数过的那一类。
// updatedAt 一律落在很久以前(不落进「今天有动静」那条判据),mtime 显式拨老并且【逐条递增】:
// 「最近 N 条」这条判据排的就是它。
function oldId(i) { return 'sess_old_' + String(i).padStart(3, '0'); }
function seedOldSessions(home, extra) {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < OLD_COUNT; i++) {
    const sid = oldId(i);
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const head = {
      schemaVersion: 4, storageVersion: 2, id: sid, missionId: sid, kind: 'quick_ask',
      title: '旧的普通会话 ' + i, summary: '上次说到一半', cwd: ROOT, pinned: false,
      createdAt: stamp, updatedAt: stamp, turnSeq: 1, messageCount: 0, providerHistoryCount: 0,
      mission: null,
      ...((extra && extra[sid]) || {}),
    };
    const file = path.join(dir, sid + '.json');
    fs.writeFileSync(file, JSON.stringify(head), 'utf8');
    fs.writeFileSync(path.join(dir, sid + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(dir, sid + '.provider.ndjson'), '', 'utf8');
    // mtime 逐条递增(i 越大越新),全部在一年以前 —— 与 updatedAt 各管各的:
    // updatedAt 决定「今天有没有动静」,mtime 决定「最近 N 条」的排序。
    const when = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).getTime() / 1000;
    fs.utimesSync(file, when, when);
  }
}

function rowOf(missions, sessionId) {
  return (Array.isArray(missions) ? missions : []).find(row => row && row.sessionId === sessionId) || null;
}
async function readMissions(port, token) {
  const res = await request(port, 'GET', '/api/missions?limit=200', null, token);
  return (res && res.json && Array.isArray(res.json.missions)) ? res.json.missions : [];
}
async function waitForRow(port, token, sessionId, predicate, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const row = rowOf(await readMissions(port, token), sessionId);
    if (row && predicate(row)) return row;
    await sleep(250);
  }
  return rowOf(await readMissions(port, token), sessionId);
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-index-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'probe.txt'), 'probe body\n', 'utf8');
// 两条特殊的旧会话(都在窗口【之外】,保证它们出现/消失只可能是判据造成的,不是窗口):
//   · sess_old_000 —— 最老的一条普通会话,C 用它测「交给管家盯」;
//   · sess_old_001 —— 带 launchedBy:'steward'(修前判据下就是 watched),D 用它测写 false。
seedOldSessions(home, { [oldId(1)]: { launchedBy: 'steward' } });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9,
  version: '2.4.0',
  activeProvider: 'fake',
  engineMode: 'interactive',
  permissionMode: 'default',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: home,
  includeWorkbenchMcp: false,
  killOnDisconnect: false,
  subagentMaxPerTurn: 0,
  stewardEnabledV1: true,
  stewardPollMs: 5000,
  stewardVisitIdleMinutes: 60,
  stewardProviderId: 'fake',
  stewardModel: 'fake-model',
  stewardThreadBriefV1: false,
  stewardMaxTurnsPerHour: 500,
  stewardGlobalMaxTurnsPerHour: 2000,
  threadIndexRecent: RECENT,
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

let provider = null;
let server = null;
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', r => r.status === 200, undefined, 300)), 'A0 workbench started');
  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A0b runtime token 可读');

  /* ═════════ 配置:窗口进了 defaultConfig 与清洗块 ═════════ */
  const cfg = await request(appPort, 'GET', '/api/status', null, token);
  ok(Boolean(cfg && cfg.json && cfg.json.config && cfg.json.config.threadIndexRecent === RECENT),
    `A0c config.threadIndexRecent 落到 ${RECENT}(进了 defaultConfig 与清洗块;实得 ${cfg && cfg.json && cfg.json.config ? cfg.json.config.threadIndexRecent : 'n/a'})`);

  /* ═════════ B 窗口:15 条存量旧会话只进最近的那几条 ═════════ */
  // 服务起来时 sessions 目录里就这 15 条,窗口 10 -> old_005..old_014 进,old_000..old_004 不进。
  const boot = await readMissions(appPort, token);
  ok(Boolean(rowOf(boot, oldId(OLD_COUNT - 1))), `B1 窗口内最新的那条旧会话进索引(${oldId(OLD_COUNT - 1)})`);
  ok(!rowOf(boot, oldId(0)), `B2 窗口外最老的那条旧会话【不】进索引(${oldId(0)});修前这一类恒不进,修后也不该被窗口放进来`);
  const oldInIndex = boot.filter(row => row && /^sess_old_/.test(String(row.sessionId || ''))).length;
  // old_001 带 launchedBy:'steward' -> watched 恒真 -> 不受窗口约束,所以窗口内 10 条里多出它一条。
  ok(oldInIndex === RECENT + 1,
    `B3 旧会话进索引的条数 = 窗口 ${RECENT} + watched 的那 1 条 = ${RECENT + 1}(实得 ${oldInIndex})`);
  ok(Boolean(rowOf(boot, oldId(1))), `B4 窗口外但 launchedBy:'steward' 的旧线程照样在索引里(${oldId(1)},watched 那一条并集)`);
  const watchedRow = rowOf(boot, oldId(1));
  ok(Boolean(watchedRow && watchedRow.watched === true && watchedRow.origin === 'steward'),
    `B5 它的 watched===true、origin==='steward'(存量头上没有 origin 字段,读侧由 06i threadOriginOf 从 launchedBy 派生;实得 watched=${watchedRow && watchedRow.watched} origin=${watchedRow && watchedRow.origin})`);

  /* ═════════ A 2.0 新开的普通会话 ═════════ */
  const created = await request(appPort, 'POST', '/api/sessions', { title: '我自己在 2.0 里新开的线程' }, token);
  const plainId = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(plainId), `A1 POST /api/sessions 开出普通会话(${plainId || '失败'})`);
  if (!plainId) throw new Error('plain session fixture unavailable');
  ok(created.json.session.origin === 'user', `A2 会话头写下 origin:'user'(实得 ${created.json.session.origin})`);
  const plainRow = await waitForRow(appPort, token, plainId, () => true);
  ok(Boolean(plainRow), 'A3 【本刀要修的那一条】2.0 新开的普通会话出现在 GET /api/missions');
  ok(Boolean(plainRow && plainRow.origin === 'user'), `A4 行上 origin==='user'(实得 ${plainRow && plainRow.origin})`);
  ok(Boolean(plainRow && plainRow.watched === false), `A5 行上 watched===false(管家不盯它;实得 ${plainRow && plainRow.watched})`);
  ok(Boolean(plainRow && plainRow.liveTail === null), `A6 没有活回合时 liveTail===null(不编空壳;实得 ${JSON.stringify(plainRow && plainRow.liveTail)})`);
  ok(Boolean(plainRow && plainRow.seatedBy === null), `A7 没有在场连接时 seatedBy===null(实得 ${JSON.stringify(plainRow && plainRow.seatedBy)})`);

  /* ═════════ C stewardWatch:true 写口 ═════════ */
  const patched = await request(appPort, 'PATCH', `/api/sessions/${oldId(0)}`, { stewardWatch: true }, token);
  ok(Boolean(patched && patched.status === 200), `C1 PATCH /api/sessions/:id {stewardWatch:true} 200(实得 ${patched && patched.status})`);
  const adoptedRow = await waitForRow(appPort, token, oldId(0), row => row.watched === true);
  ok(Boolean(adoptedRow), `C2 窗口外的旧线程被「交给管家盯」之后进了索引(${oldId(0)})`);
  ok(Boolean(adoptedRow && adoptedRow.watched === true), `C3 它的 watched===true(实得 ${adoptedRow && adoptedRow.watched})`);
  ok(Boolean(adoptedRow && adoptedRow.origin === 'user'), `C4 交给管家盯【不】改出身:origin 仍是 'user'(实得 ${adoptedRow && adoptedRow.origin})`);
  // origin 不许经 PATCH 改 —— 白名单里根本没有它这一支。
  await request(appPort, 'PATCH', `/api/sessions/${oldId(0)}`, { origin: 'steward' }, token);
  const stillUser = await waitForRow(appPort, token, oldId(0), row => row.origin === 'user', 8);
  ok(Boolean(stillUser && stillUser.origin === 'user'),
    `C5 PATCH {origin:'steward'} 改不动出身(白名单里没有 origin 这一支;实得 ${stillUser && stillUser.origin})`);

  /* ═════════ D stewardWatch:false 对管家开的线程同样生效 ═════════ */
  const before = rowOf(await readMissions(appPort, token), oldId(1));
  ok(Boolean(before && before.watched === true), `D0 写 false 之前它是 watched(launchedBy:'steward' 那条判据;实得 ${before && before.watched})`);
  const released = await request(appPort, 'PATCH', `/api/sessions/${oldId(1)}`, { stewardWatch: false }, token);
  ok(Boolean(released && released.status === 200), `D1 PATCH {stewardWatch:false} 200(实得 ${released && released.status})`);
  const after = await waitForRow(appPort, token, oldId(1), row => row.watched === false);
  // 钉的是【判据】,不是「它从索引里消失」:PATCH 刚刚重写过这个会话文件,它的 mtime 因此变成此刻,
  // 于是它必然落在「最近 N 条」窗口里 —— 四条并集还有一条成立,行本来就该留着。
  // 「用户接手」要证明的是 watched 翻假(管家不再为它动手),不是「这条线程从界面上消失」。
  ok(Boolean(after && after.watched === false),
    `D2 用户接手:写 false 对【管家自己开的】线程同样生效,watched 翻假(${oldId(1)};实得 ${after && after.watched})`);
  ok(Boolean(after && after.origin === 'steward'),
    `D3 接手【不】改出身:它仍然是管家开的那条线程(origin==='steward';实得 ${after && after.origin})`);

  /* ═════════ F liveTail 摘要(管家开一条真线程,回合跑着时看) ═════════ */
  const madeRes = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_new', args: { title: '索引口径要看的线程', cwd: home, brief: { userText: '把这件事推进到底', goal: '给一句结论' } } },
  }, token);
  const liveId = madeRes && madeRes.json && madeRes.json.result && madeRes.json.result.sessionId;
  ok(Boolean(liveId), `F1 管家 steward_thread_new 开出线程(${liveId || '失败'})`);
  if (!liveId) throw new Error('steward thread fixture unavailable');
  const liveRow = await waitForRow(appPort, token, liveId, row => row.liveTail && row.liveTail.tool !== undefined, 80);
  ok(Boolean(liveRow && liveRow.origin === 'steward'), `F2 管家开的线程 origin==='steward'(createSession 显式写下;实得 ${liveRow && liveRow.origin})`);
  ok(Boolean(liveRow && liveRow.watched === true), `F3 它的 watched===true(实得 ${liveRow && liveRow.watched})`);
  ok(Boolean(liveRow && liveRow.liveTail && typeof liveRow.liveTail === 'object'),
    `F4 活回合期间 liveTail 非空(§4.2 行加 liveTail 摘要;实得 ${JSON.stringify(liveRow && liveRow.liveTail)})`);
  const tailKeys = liveRow && liveRow.liveTail ? Object.keys(liveRow.liveTail).sort() : [];
  ok(JSON.stringify(tailKeys) === JSON.stringify(['iterations', 'tool', 'updatedAt']),
    `F5 liveTail 摘要【只有】三个键 tool/updatedAt/iterations(§6.1 红线:不承载工具输出正文;实得 ${JSON.stringify(tailKeys)})`);
  ok(!('text' in (liveRow.liveTail || {})) && !('full' in (liveRow.liveTail || {})),
    'F6 摘要里没有 text、也没有 full(正文要走 GET /api/sessions/:id 的 liveTail,那里有自己的预算)');
  // iterations 只增不减(04 的 appendLiveTail:换一批工具才 +1),所以它是这份摘要里唯一
  // 【轮询抓得住】的工具证据 —— 而 tool 那一格在 tool_result 到达的那一刻就被清空(同一处代码),
  // 它的存活窗口是「工具真的在跑」的那几毫秒,拿 /api/missions 轮询去抓等于赌运气。
  // 瞬时工具名由 event-stream.e2e.js 的 B-d4 钉(SSE 在【值变化的那一刻】推送,不用轮询),
  // 本件只钉「摘要确实跟着回合走」+ 下面 S5 那条静态锁「tool 这一格取的是同一个累加器」。
  const iterRow = await waitForRow(appPort, token, liveId, row => row.liveTail && Number(row.liveTail.iterations) >= 1, 100);
  ok(Boolean(iterRow && iterRow.liveTail && Number(iterRow.liveTail.iterations) >= 1),
    `F7 摘要的 iterations 随工具调用前进(实得 iterations=${iterRow && iterRow.liveTail && iterRow.liveTail.iterations})`);
  ok(Boolean(iterRow && iterRow.liveTail && typeof iterRow.liveTail.tool === 'string'),
    `F8 摘要始终带着 tool 这一格(工具没在跑时是空串,不是缺键;实得 ${JSON.stringify(iterRow && iterRow.liveTail && iterRow.liveTail.tool)})`);

  /* ═════════ E 收件箱第四源:watched 过滤保留 ═════════ */
  // old_000 已经是 watched(C 那一步写的 true);old_002 是同款旧普通会话但没被交给管家。
  // 两条都把 turnSeq 往前推一格并把 updatedAt 拨到现在 = 「这条线程刚跑完一个回合」。
  // 先让收件箱看见它们一次(建基线),再推 —— 否则首见那一轮的基线纪律会把这一格吃掉。
  const bumpDir = path.join(home, 'sessions');
  // 直接改会话文件【不会】给投影索引打脏页(markPretenderIndexDirty 只长在应用自己的写口上),
  // 而收件箱第四源的第一道判据就是「索引行上的 sourceStamp 变没变」。所以改完必须再走一次应用的
  // 写口(PATCH 一个无害字段)把脏页打上 —— 否则这一格永远不会被看见,断言会假绿/假红。
  const bump = async (sid, seq) => {
    const file = path.join(bumpDir, sid + '.json');
    const head = JSON.parse(fs.readFileSync(file, 'utf8'));
    head.turnSeq = seq;
    head.updatedAt = new Date().toISOString();
    head.stewardLastTurn = { seq, ok: true, aborted: false, errorClass: '', at: head.updatedAt };
    fs.writeFileSync(file, JSON.stringify(head), 'utf8');
    await request(appPort, 'PATCH', `/api/sessions/${sid}`, { title: head.title + '(跑完一回合)' }, token);
  };
  // 基线:让 old_002 也先被索引看见(它在窗口外,但收件箱扫的是索引行 —— 所以先把它拉进窗口内
  // 的办法不可用;改用 stewardWatch 把 old_002 也拉进索引,再把 watched 撤掉,基线就建好了)。
  await request(appPort, 'PATCH', `/api/sessions/${oldId(2)}`, { stewardWatch: true }, token);
  await waitForRow(appPort, token, oldId(2), row => row.watched === true);
  await sleep(6500);                                    // 至少一拍 tick(stewardPollMs=5000)
  await request(appPort, 'PATCH', `/api/sessions/${oldId(2)}`, { stewardWatch: false }, token);
  await sleep(6500);                                    // 让基线那一拍落定
  await bump(oldId(0), 9);
  await bump(oldId(2), 9);
  let inboxRows = [];
  for (let i = 0; i < 40; i++) {
    const res = await request(appPort, 'GET', '/api/steward/inbox?limit=200', null, token);
    inboxRows = (res && res.json && Array.isArray(res.json.items)) ? res.json.items : [];
    if (inboxRows.some(r => r && r.sessionId === oldId(0) && r.kind === 'done')) break;
    await sleep(500);
  }
  ok(inboxRows.some(r => r && r.sessionId === oldId(0) && r.kind === 'done'),
    `E1 watched 的线程回合结束后进收件箱(${oldId(0)} 的 done)`);
  // 钉的是【第四源的 watched 过滤】,所以只看回合结束那两类(done/failed)。old_002 在建基线那一步
  // 被短暂地「交给管家盯」过一次,于是箱子里合法地有它一条 adopted —— 拿「这条会话一行都没有」
  // 当断言会把那一行也算成违规,那是钉错了东西。
  ok(!inboxRows.some(r => r && r.sessionId === oldId(2) && (r.kind === 'done' || r.kind === 'failed')),
    `E2 同款但没被交给管家的线程,回合结束【不】进收件箱(${oldId(2)};§4.2「回合结束的 watched 过滤保留」)`);
  // 用户按下「交给管家盯」那一下本身也要进箱(第六类 adopted,§4.4)。
  ok(inboxRows.some(r => r && r.sessionId === oldId(0) && r.kind === 'adopted'),
    `E3 「交给管家盯」写下的那一刻进箱成 adopted 行(${oldId(0)})`);
  const adoptedInbox = inboxRows.find(r => r && r.kind === 'adopted') || null;
  ok(Boolean(adoptedInbox && adoptedInbox.payload && adoptedInbox.payload.by === 'user'),
    `E4 adopted 行的载荷带 by:'user'(与 missionAttachThread 派的同名事件分开;实得 ${JSON.stringify(adoptedInbox && adoptedInbox.payload && adoptedInbox.payload.by)})`);

  /* ═════════ 静态锁:判据单点、schema 升号 ═════════ */
  const src = readServerSource();
  ok(/function threadVisible\(head, input\)/.test(src), 'S1 threadVisible 单点在编译产物里(定义在 06i)');
  ok(/function threadOriginOf\(head\)/.test(src), 'S2 threadOriginOf 单点在编译产物里(定义在 06i)');
  ok(/const PRETENDER_INDEX_SCHEMA = 6;/.test(src), 'S3 投影索引 schema 升到 6(卡片形状与产生条件都变了,必须强制重建)');
  ok(/if \(head\.stewardWatch === true\) return true;/.test(src) && /if \(head\.stewardWatch === false\) return false;/.test(src),
    'S4 stewardWatchedThread 的两条显式开关分支排在原三条判据之前');
  // 摘要的三个键取的是 04 那份 reg.liveTail(同一个累加器、同一份预算),不另攒一套。
  ok(/tool: String\(liveTailReg\.tool \|\| ''\),/.test(src)
    && /iterations: Math\.max\(0, Number\(liveTailReg\.iterations\) \|\| 0\),/.test(src),
    'S5 liveTail 摘要的 tool/iterations 直接取自活回合登记项的累加器(不另攒一套)');
} finally {
  killTree(server);
  try { if (provider) provider.close(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\nTHREAD INDEX VISIBILITY E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });

// ────────────────────────────────────────────────────────────────────────────
// REVERSE VERIFICATION(32 号文 §4 纪律 5:新加断言必须故意破坏一次,确认真红再还原)
//   1. A3/A4:把 13e-pretender-index.js 的 `const carded = kind === 'mission' || threadVisible(...)`
//      改回 `const carded = kind === 'mission' || stewardWatchedThread(head, sid, missionId);`
//      -> A3「2.0 新开的普通会话出现在 /api/missions」必须 FAIL(修前的行为)。
//   2. B2/B3:把 threadVisible 里 `if (src.recent === true) return true;` 改成 `return false`
//      的等价(或把 13e 传的 recent 恒喂 true)-> B2 或 B3 必须 FAIL(窗口失效)。
//   3. C2/C3:把 06i stewardWatchedThread 的 `if (head.stewardWatch === true) return true;` 删掉
//      -> C2/C3 必须 FAIL(写口不生效)。
//   4. D2:把 `if (head.stewardWatch === false) return false;` 删掉
//      -> D2 必须 FAIL(管家开的线程收不回来)。
//   5. F4–F8:把 overlayMissionCard 里的 `liveTail` 改成恒 null -> F4 必须 FAIL。
//      把摘要改成 `{ ...liveTailReg }`(带上正文)-> F5/F6 必须 FAIL。
//   6. E1/E2:把 13i stewardCollectSessionTurn 末尾的 `if (!watched || turnSeq <= baseline)` 里的
//      `!watched ||` 去掉 -> E2 必须 FAIL(过滤没了,不该进箱的进了箱)。
//   7. E3/E4:把 13i 的 `RUYI_EVENTS.subscribe` 那段交接订阅注释掉 -> E3 必须 FAIL。
// 每改一次都要 `node ruyi-workbench/app/build.js` 再单跑本件;跑完照原样改回来。
// ────────────────────────────────────────────────────────────────────────────
