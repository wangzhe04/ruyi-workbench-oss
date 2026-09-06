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
    const src13h = fs.readFileSync(path.join(WB, 'app', 'src', '13h-steward-runner.js'), 'utf8');
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
