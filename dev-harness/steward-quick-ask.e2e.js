require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 116 波 116-2e · 27 号文 §11.1 第 2 项「自答边界与速查线程」):速查线程的全生命周期。
//
// 速查线程 = 管家为了回答一个「要读文件/联网/动手才能答」的问题临时开的一条线程:
//   建(kind:'quick_ask',头上打 stewardQuick 标,不进任何事项)
//     -> 跑(经既有 stewardLaunchTurn,权限用新线程默认权限)
//     -> 收工(收件箱的 done 事件带 quick:true 与 answer;13h 在事件【进过】管家回合之后写 closedAt)
//     -> 消失(总览与 steward_threads_search 默认排除;includeClosed:true 可以要回来)。
//
// 结构:全程进程内(直调 TOOL_HANDLERS 与导出的收件箱/收工原语)+ 真 fake-openai 跑那一条线程回合。
//
// 覆盖:
//  (A) 建:kind === 'quick_ask'、stewardQuick 四个字段齐、closedAt 为 null、不写任何事项容器文件;
//      回合真的跑起来了(fake-openai 收到请求、会话里有助手回复)。
//  (B) 配额:每个管家回合最多 2 条,第三条 quota_exceeded;下一回合重置。
//  (C) 收件箱增强:速查会话的 done 行带 quick:true 与 answer(最后一句助手原话,≤1200);
//      普通线程的 done 行【不】带这两个字段。
//  (D) 收工:quickClose 写 closedAt(幂等);顺序纪律 —— 13h 在事件送进回合【之后】才收工。
//  (E) 排除:收工后 steward_threads_search 默认搜不到,includeClosed:true 能搜到;
//      经典壳的会话列表不受影响(它只是数据)。
//  (F) 边界:空问题 -> invalid_request;超长问题 -> invalid_request。
//  (G) 116-4 第四源 sessionTurns:速查线程跑完【真的】入箱(修前三源全挂在事项上,而速查线程没有
//      mission 容器 -> bumpMissionChangeSeq 直接 no-op -> 箱子永远是空的,管家永远不被唤醒);
//      done 行带 quick:true + answer;普通经典壳会话跑完【不】入箱;被管家递过话的普通会话入箱一条;
//      幂等(再跑两轮不重复);冷启动那一轮只建基线。
//  (H) 116-4 闭环:入箱 -> 管家收件箱回合 -> stewardQuick.closedAt 落盘(不再依赖一条永远不会来的 done 行)。
//  (I) 117p-S1:回合还在跑的时候轮询器就第一次看见这条线程(用户第七轮走查「2.0 回合已经跑完了,
//      管家没有收到体现也没收工」的真机时序)——箱子当轮 0 行、游标基线是「这一回合之前」的号;
//      回合真的跑完之后再 tick 一轮,箱子里正好一条 done。
//
// 判定行:`STEWARD QUICK ASK E2E: ALL PASS`。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-quick-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const PROVIDER_PORT = await getFreePort();
const ANSWER = '你那个仓库现在有三个分支：master、feature/steward、hotfix/eol。';
let providerHits = 0;
// 117p (I) 段用的闸:默认打开(不改变 (A)~(H) 任何一段的时序),(I) 段临时关上它,逼真机那种
// 「回合已起手、provider 还没回应」的窗口 —— provider 收到请求(providerHits 已 +1,严格晚于
// 09-workflow.js 的 turnSeq 落盘与 activeChildren 登记)之后、写第一帧之前卡住。
let gate = Promise.resolve();
const providerServer = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  providerHits += 1;
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  await gate;   // 默认 resolved 的闸;(I) 段临时换成未 resolve 的 promise
  if (body && body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ANSWER } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  frame({ choices: [{ index: 0, delta: { content: ANSWER } }] });
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  // 117w-W1 ②:本件有几处【省略 cwd】的 steward_quick_ask,而省略即在 Ruyi 根下派生子工作区。
  // 出厂根是 ~/Ruyi(真实主目录),不覆盖就会在跑测试的人的机器上真建目录。
  stewardWorkspaceRoot: path.join(HOME, 'Ruyi'),
  stewardEnabledV1: true, stewardPollMs: 120000, sessionSearchIndexV1: false,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const stewardCtx = (turn, extra) => ({
  session: { id: 'steward', kind: 'steward', providerHistory: Array.from({ length: turn || 0 }, () => ({ role: 'user' })) },
  sessionId: 'steward',
  ...(extra || {}),
});
const call = (name, args, ctx) => srv.toolCall(name, args, ctx || stewardCtx(0));
const headOf = id => JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', id + '.json'), 'utf8'));

const QUESTION = '我那个仓库现在有几个分支？';

try {
  /* ═════════ (A) 建 ═════════ */
  console.log('── (A) 建速查线程 ──');
  const before = providerHits;
  const created = await call('steward_quick_ask', { question: QUESTION, cwd: HOME }, stewardCtx(1));
  ok(created && created.ok === true, `A1 正向返回(got ${created && (created.error || 'ok')})`);
  const quickId = created.sessionId;
  ok(created.kind === 'quick_ask', "A2 返回 kind:'quick_ask'");
  ok(created.undoRef && created.undoRef.kind === 'thread_new' && created.undoRef.sessionId === quickId, 'A3 undoRef 指向新建的线程');
  // 117e 第 0 步(117d 登记项 ③):撤回锚点显式化,与 117d-0 给 thread_new / thread_continue 补的
  // 那个字段同口径 —— rewindSession 按「要删的那一回合的第一条用户消息」定位(09 的
  // plannedTurnSeq = turnSeq + 1),按 turnSeq 字面传会得 target turn not found。
  ok(created.undoRef && created.undoRef.rewindTargetTurnSeq === 1,
    `A3b undoRef 带显式撤回锚点 rewindTargetTurnSeq(新建会话 turnSeq=0 -> 1;got ${created.undoRef && created.undoRef.rewindTargetTurnSeq})`);
  {
    const head = headOf(quickId);
    ok(head.kind === 'quick_ask', "A4 会话头 kind === 'quick_ask'");
    const q = head.stewardQuick;
    ok(q && q.askedAt && q.question === QUESTION && q.stewardTurnKey && q.closedAt === null,
      `A5 头上打了 stewardQuick 标(askedAt/question/stewardTurnKey/closedAt:null;got ${JSON.stringify(q)})`);
    ok(!fs.existsSync(path.join(HOME, 'missions', head.missionId + '.json')), 'A6 不进任何事项(没有事项容器文件被建出来)');
  }
  // 回合是 fire-and-forget:等它收尾
  for (let i = 0; i < 80; i++) {
    const s = await srv.loadSession(quickId).catch(() => null);
    if (s && (s.messages || []).some(m => m.role === 'assistant' && String(m.content || '').includes('三个分支'))) break;
    await sleep(150);
  }
  ok(providerHits > before, 'A7 回合真的跑起来了(fake-openai 收到请求)');
  {
    const s = await srv.loadSession(quickId);
    ok((s.messages || []).some(m => m.role === 'user' && m.content === QUESTION), 'A8 用户那条消息就是问题原文');
    ok((s.messages || []).some(m => m.role === 'assistant' && String(m.content || '').includes('三个分支')), 'A9 线程给出了答案');
  }

  /* ═════════ (B) 每回合 2 条配额 ═════════ */
  console.log('── (B) 配额 ──');
  {
    const second = await call('steward_quick_ask', { question: '第二个问题？' }, stewardCtx(1));
    ok(second && second.ok === true, 'B1 同一回合第二条照常建');
    const third = await call('steward_quick_ask', { question: '第三个问题？' }, stewardCtx(1));
    ok(third && third.ok === false && third.error === 'quota_exceeded', `B2 同一回合第三条 -> quota_exceeded(got ${third && third.error})`);
    const nextTurn = await call('steward_quick_ask', { question: '下一回合的问题？' }, stewardCtx(2));
    ok(nextTurn && nextTurn.ok === true, 'B3 下一回合配额重置');
  }

  /* ═════════ (F) 边界 ═════════ */
  console.log('── (F) 边界 ──');
  {
    const empty = await call('steward_quick_ask', { question: '   ' }, stewardCtx(9));
    ok(empty && empty.error === 'invalid_request', 'F1 空问题 -> invalid_request');
    const huge = await call('steward_quick_ask', { question: 'x'.repeat(2000) }, stewardCtx(9));
    ok(huge && huge.error === 'invalid_request', 'F2 超长问题 -> invalid_request');
  }

  /* ═════════ (C) 收件箱增强 ═════════ */
  console.log('── (C) 收件箱增强 ──');
  // 造一条普通线程作为对照。
  const plainId = await (async () => {
    const s = await srv.createSession({ title: '普通线程', cwd: HOME });
    s.kind = 'mission';
    s.messages = [{ role: 'assistant', content: '普通线程的最后一句。', turnSeq: 1, createdAt: new Date().toISOString() }];
    await srv.saveSession(s);
    return s.id;
  })();
  {
    const rows = [
      { inboxSeq: 1, kind: 'done', sessionId: quickId, missionId: quickId, runId: '', seq: 1, at: new Date().toISOString(), payload: { source: 'missionChange', summary: '收工' } },
      { inboxSeq: 2, kind: 'done', sessionId: plainId, missionId: plainId, runId: '', seq: 1, at: new Date().toISOString(), payload: { source: 'missionChange', summary: '收工' } },
      { inboxSeq: 3, kind: 'failed', sessionId: quickId, missionId: quickId, runId: '', seq: 2, at: new Date().toISOString(), payload: { source: 'missionChange', summary: '出错' } },
    ];
    await srv.StewardHooks.enrichInboxRows(rows);
    ok(rows[0].payload.quick === true, 'C1 速查会话的 done 行带 quick:true');
    ok(String(rows[0].payload.answer || '').includes('三个分支'), 'C2 answer 是最后一句助手原话');
    ok(String(rows[0].payload.answer || '').length <= srv.STEWARD_QUICK_ANSWER_CHARS, `C3 answer ≤${srv.STEWARD_QUICK_ANSWER_CHARS} 字符`);
    ok(rows[0].payload.summary === '收工', 'C4 原有 payload 字段不被覆盖(只加不改)');
    ok(!('quick' in rows[1].payload) && !('answer' in rows[1].payload), 'C5 普通线程的 done 行不带 quick/answer');
    ok(!('quick' in rows[2].payload), 'C6 非 done 的行(failed)不加增强');
  }

  /* ═════════ (D) 收工 ═════════ */
  console.log('── (D) 收工 ──');
  {
    ok(headOf(quickId).stewardQuick.closedAt === null, 'D0 收工前 closedAt 仍是 null');
    const r = await srv.StewardHooks.quickClose(quickId);
    ok(r && r.ok === true && r.changed === true && r.closedAt, 'D1 quickClose 写 closedAt');
    ok(headOf(quickId).stewardQuick.closedAt === r.closedAt, 'D2 落在会话头上');
    ok(headOf(quickId).stewardQuick.question === QUESTION, 'D2b 其余 stewardQuick 字段原样保留');
    const again = await srv.StewardHooks.quickClose(quickId);
    ok(again && again.ok === true && again.changed === false, 'D3 幂等(已收工再调是无操作)');
    const plain = await srv.StewardHooks.quickClose(plainId);
    ok(plain && plain.ok === false && plain.error === 'not_found', 'D4 普通线程不能被「收工」(它不是速查)');
    // 顺序纪律:13h 在事件【进过】回合之后才收工 —— 源码单点锁。
    // 117 波 T2(32 号文 §5)重钉:13h 拆成六个文件(纯搬家),回合入口 stewardRunClaimedTurn ——
    // 也就是这两个标记所在的那个函数 —— 整体搬进了 13q-steward-runner-turn.js。钉的是【源码里这两件
    // 事的先后】,与它住哪个文件无关,故按 manifest 顺序整族拼起来读:同一函数内的先后关系原样保留。
    const src13h = ['13m-steward-runner-base.js', '13n-steward-arbiter.js', '13o-steward-runner-prompt.js',
      '13p-steward-runner-actions.js', '13q-steward-runner-turn.js', '13h-steward-runner.js']
      .map(f => fs.readFileSync(path.join(WB, 'app', 'src', f), 'utf8')).join('\n');
    const closeAt = src13h.indexOf('StewardHooks.quickClose(');
    const replyAt = src13h.indexOf('const finalText = await stewardLastAssistantContent();');
    ok(closeAt > replyAt && replyAt > 0, 'D5 源码顺序:收工在本回合拿到模型回复【之后】(先收工会让管家转述时线程凭空消失)');
  }

  /* ═════════ (E) 排除 ═════════ */
  console.log('── (E) 总览与搜索排除 ──');
  {
    const hidden = await call('steward_threads_search', { q: '分支' }, stewardCtx(5));
    ok(hidden && hidden.ok === true, 'E0 搜索可用');
    ok(!hidden.results.some(r => r.sessionId === quickId), 'E1 已收工的速查线程默认搜不到');
    const shown = await call('steward_threads_search', { q: '分支', includeClosed: true }, stewardCtx(5));
    ok(shown.results.some(r => r.sessionId === quickId), 'E2 includeClosed:true 能搜回来');
    // 还没收工的那两条速查线程仍然在(收工才消失,不是「速查一律不显示」)。
    const openQuick = await call('steward_threads_search', { q: '第二个问题' }, stewardCtx(5));
    ok(openQuick.results.length > 0, 'E3 未收工的速查线程照常出现');
    // 经典壳的会话列表不动:它只是数据。
    const metas = await srv.listSessions();
    ok(metas.some(m => m.id === quickId), 'E4 经典壳会话列表里仍然有它(收工只影响管家的注意力预算)');
  }
  /* ═════════ (G) 116-4 第四源 sessionTurns ═════════ */
  console.log('── (G) 第四源:线程跑完真的入箱 ──');
  // 128a:盘上是稀疏投影,当整份配置用之前先归一化(等于默认的键不落盘,直读会是 undefined)。
  const cfg = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;
  const inboxRows = async () => (await srv.StewardHooks.inboxRead({ since: 0, limit: 200 })).items;
  // 冷启动一轮:本次装载没有可用游标 -> 三源加第四源都只建基线,历史【不】倒灌进箱子。
  await srv.startStewardInbox(cfg);
  await sleep(400);
  {
    const rows = await inboxRows();
    ok(rows.length === 0, `G0 冷启动那一轮只建基线,箱子仍是空的(got ${rows.length} 行)`);
    ok(fs.existsSync(path.join(HOME, 'steward', 'cursor-v1.json')), 'G0b 游标已落盘(冷启动的基线本身必须存下来)');
    const cursor = JSON.parse(fs.readFileSync(path.join(HOME, 'steward', 'cursor-v1.json'), 'utf8'));
    ok(cursor.sources && cursor.sources.sessionTurns && typeof cursor.sources.sessionTurns === 'object',
      'G0c 游标里有第四源 sessionTurns 段(schema 号不变,老游标缺这段 = 每条会话都算首见)');
  }
  // 生产时序:管家在【开机建完基线之后】才开线程 —— 第四源正是为这条时序设计的。
  const g = await call('steward_quick_ask', { question: '第四源要问的问题？', cwd: HOME }, stewardCtx(7));
  ok(g && g.ok === true, 'G1 又开了一条速查线程');
  const gId = g.sessionId;
  // 117p(b):②之后,首见分支的 backfill 多了一条「stewardLastTurn 必须已落盘」的前提 ——
  // 只等「助手消息出现」不够(assistant 消息落盘早于 activeChildren 清场、更早于 13g 在 settle
  // 之后写 stewardLastTurn),这里补等同一件生产判据真正依赖的事实,去掉一处本来就存在的时序脆弱点。
  for (let i = 0; i < 120; i++) {
    const s2 = await srv.loadSession(gId).catch(() => null);
    if (s2 && (s2.messages || []).some(m => m.role === 'assistant')) {
      const h = headOf(gId);
      if (h.stewardLastTurn && Number(h.stewardLastTurn.seq) >= 1) break;
    }
    await sleep(150);
  }
  await sleep(600);
  await srv.startStewardInbox(cfg);   // 幂等 start = 补跑一轮
  await sleep(600);
  {
    const rows = await inboxRows();
    const mine = rows.filter(r => r.sessionId === gId);
    ok(mine.length === 1, `G2 速查线程跑完 -> 箱子里正好一条(got ${mine.length};修前恒为 0)`);
    const row = mine[0] || { payload: {} };
    ok(row.kind === 'done', `G3 kind === 'done'(got ${row.kind})`);
    ok(row.payload.source === 'session_turn', `G4 来源是第四源 session_turn(got ${row.payload.source})`);
    ok(row.payload.turnSeq === 1 && row.seq === 1, `G5 去重游标就是 turnSeq(got seq=${row.seq})`);
    ok(row.payload.launchedBy === 'steward', 'G6 会话头上有 launchedBy:steward(第四源的「管家关心」判据之一)');
    ok(row.payload.quick === true, 'G7 done 行带 quick:true');
    ok(String(row.payload.answer || '').includes('三个分支'), 'G8 done 行带 answer(13g 的 enrichInboxRows 补的)');
  }
  // 用户自己在经典壳里聊的普通会话:跑完【不】入箱 —— 他就坐在那条线程前面,不需要被通知一次。
  const plainRun = await (async () => {
    const sx = await srv.createSession({ title: '用户自己聊的线程', cwd: HOME });
    await srv.saveSession(sx);
    await srv.runSessionTurn({ sessionId: sx.id, message: '你好', cwd: HOME, onEvent: () => {} });
    return sx.id;
  })();
  await sleep(400);
  await srv.startStewardInbox(cfg);
  await sleep(600);
  {
    const rows = await inboxRows();
    ok(rows.filter(r => r.sessionId === plainRun).length === 0, 'G9 用户自己的普通会话跑完不入箱');
  }
  // 被管家递过话的普通会话:从此就是「管家关心的」,跑完入箱一条。
  {
    const relayed = await call('steward_thread_continue', { sessionId: plainRun, message: '再帮我看一眼' }, stewardCtx(8));
    ok(relayed && relayed.ok === true, `G10 递话成功(got ${relayed && (relayed.error || 'ok')})`);
    for (let i = 0; i < 120; i++) {
      const s2 = await srv.loadSession(plainRun).catch(() => null);
      if (s2 && (s2.messages || []).filter(m => m.role === 'assistant').length >= 2) break;
      await sleep(150);
    }
    await sleep(800);
    await srv.startStewardInbox(cfg);
    await sleep(600);
    const rows = await inboxRows();
    const mine = rows.filter(r => r.sessionId === plainRun);
    ok(mine.length === 1, `G11 被递过话的普通会话跑完入箱一条(got ${mine.length})`);
    ok(mine[0] && mine[0].payload.launchedBy === 'steward', 'G12 递话把 launchedBy 补写到了会话头上');
  }
  // 幂等:再连跑两轮,行数不变(去重键 = sid|kind|''|turnSeq)。
  {
    const before = (await inboxRows()).length;
    await srv.startStewardInbox(cfg); await sleep(300);
    await srv.startStewardInbox(cfg); await sleep(300);
    const after = await inboxRows();
    ok(after.length === before, `G13 再连跑两轮不重复(${before} -> ${after.length})`);
  }
  // 唤醒链诚实:state 要能分清「轮询活着」与「箱子真的收到过东西」。
  {
    const state = await srv.StewardHooks.inboxState(cfg);
    ok(!!state.lastTickAt, 'G14 state.lastTickAt 非空(轮询活着)');
    ok(!!state.lastInboxAt, 'G15 state.lastInboxAt 非空(箱子真的收到过东西 —— 修前这两件事分不开)');
    ok(Number(state.sourcesSeen && state.sourcesSeen.sessionTurns) >= 2, `G16 state.sourcesSeen.sessionTurns 计到了第四源的条数(got ${state.sourcesSeen && state.sourcesSeen.sessionTurns})`);
  }

  /* ═════════ (H) 116-4 闭环:入箱 -> 管家回合 -> 收工 ═════════ */
  console.log('── (H) 闭环:速查答完自动收工 ──');
  {
    // 上面那一轮 tick 已经把 done{quick:true} 交给 13h(它对速查答案不去抖,立刻起回合)。
    // 等管家回合把它读进去并收工。
    let closed = null;
    for (let i = 0; i < 80; i++) {
      const head = headOf(gId);
      if (head.stewardQuick && head.stewardQuick.closedAt) { closed = head.stewardQuick; break; }
      await sleep(200);
    }
    ok(!!closed, 'H1 速查线程被自动收工(closedAt 落盘)—— 修前它挂在一条永远不会来的 done 行上');
    ok(closed && Number.isFinite(Number(closed.closedTurnSeq)), 'H2 收工时记下了当时的回合数(用户续聊可自动重开)');
    const steward = await srv.loadSession('steward').catch(() => null);
    ok(steward && (steward.messages || []).some(m => m.role === 'assistant'), 'H3 管家会话里真的多了一个回合(收件箱触发)');
  }

  /* ═════════ (I) 117p-S1:回合还在跑的时候轮询器就第一次看见这条线程 ═════════ */
  // 复现用户第七轮走查那次真机时序:管家开的线程第一回合动辄几分钟,轮询 15 秒一轮,
  // 首见几乎必然撞上活回合。用上面新加的闸逼出这个窗口(默认打开,不影响 (A)~(H))。
  console.log('── (I) 117p-S1:首见即活回合,done 事件不能被永久吞掉 ──');
  {
    let releaseGate;
    gate = new Promise(r => { releaseGate = r; });
    const beforeI = providerHits;
    const created3 = await call('steward_quick_ask', { question: '第四源在活回合窗口要问的问题?', cwd: HOME }, stewardCtx(20));
    ok(created3 && created3.ok === true, `I1 建线程成功(got ${created3 && (created3.error || 'ok')})`);
    const iId = created3.sessionId;
    // 稳妥信号:provider 真的收到了这次请求。09-workflow.js 里 turnSeq 落盘(1292 一带的
    // saveSession)与 activeChildren.set(1381)都严格早于实际发出的那次网络请求(2033) ——
    // provider 收到请求就意味着两者都已经成立,而此刻闸关着,回合卡在等响应,activeChildren
    // 里仍然登记着这条会话。
    for (let i = 0; i < 80; i++) {
      if (providerHits > beforeI) break;
      await sleep(50);
    }
    ok(providerHits > beforeI, 'I2 回合真的起手了(provider 收到了这次请求;此刻闸关着,回合卡在等响应)');
    const headStarted = headOf(iId);
    ok(headStarted.turnSeq === 1, `I3 会话头上 turnSeq === 1(回合已起手;got ${headStarted.turnSeq})`);
    await srv.startStewardInbox(cfg);   // 轮询器此刻第一次看见这条线程 —— 回合还在跑
    await sleep(300);
    {
      const rows = await inboxRows();
      ok(rows.filter(r => r.sessionId === iId).length === 0,
        'I4 箱子里这条会话 0 行(修前:此刻会把正在跑的 turnSeq 记成基线,回合结束后再没人报)');
      const cursor = JSON.parse(fs.readFileSync(path.join(HOME, 'steward', 'cursor-v1.json'), 'utf8'));
      const entry = cursor.sources && cursor.sources.sessionTurns && cursor.sources.sessionTurns[iId];
      ok(entry && Number(entry.turnSeq) === 0,
        `I5 游标基线是「这一回合之前」的 0,不是正在跑的那个 1(修前这里是 1;got ${entry && entry.turnSeq})`);
    }
    releaseGate();   // 开闸,回合往下跑完
    for (let i = 0; i < 120; i++) {
      const s2 = await srv.loadSession(iId).catch(() => null);
      if (s2 && (s2.messages || []).some(m => m.role === 'assistant')) {
        const h = headOf(iId);
        if (h.stewardLastTurn && Number(h.stewardLastTurn.seq) >= 1) break;
      }
      await sleep(150);
    }
    await sleep(300);
    await srv.startStewardInbox(cfg);   // 再 tick 一轮:回合真的结束了
    await sleep(400);
    {
      const rows = await inboxRows();
      const mine = rows.filter(r => r.sessionId === iId);
      ok(mine.length === 1, `I6 回合真的跑完之后,箱子里正好一条(got ${mine.length};修前恒为 0)`);
      const row = mine[0] || { payload: {} };
      ok(row.kind === 'done', `I7 kind === 'done'(got ${row.kind})`);
      ok(row.seq === 1, `I8 seq === 1(去重游标就是 turnSeq;got ${row.seq})`);
      ok(row.payload.source === 'session_turn', `I9 来源是第四源 session_turn(got ${row.payload.source})`);
    }
  }
  srv.stopStewardInbox();
} catch (e) {
  console.log('ERROR ' + ((e && e.stack) || e));
  fail++;
} finally {
  try { providerServer.close(); } catch { /* ignore */ }
  await sleep(200);
}

console.log('');
if (fail) { console.log(`STEWARD QUICK ASK E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD QUICK ASK E2E: ALL PASS');
process.exit(0);
})();
