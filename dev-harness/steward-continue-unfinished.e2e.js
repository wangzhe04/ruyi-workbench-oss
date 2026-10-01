require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(2026-10 用户真机截图 ·「像这种情况,管家要能自主让线程恢复啊」):线程回合收了、任务没做完 → 管家自己续一轮。
//
// 现场:线程「GPT6与Claude旗舰模型对比」计划 0/5、89 次工具调用后回合收了,线程头亮着「上次任务未完成 [继续]」,
// 管家那侧把它报成「已收工」,反过来问用户「要我拉出来报一报吗」。五态不看这件事(无账本线程:回合跑完且没失败 = done),
// 所以补的是自理动作 stewardAutoActions.continueUnfinished:收到「线程回合收工」(done · session_turn)时读线程现场,
// 没做完且该自己续的,就替用户点那一下「继续」。「没做完」的判据不另写:横幅同一份 detectDanglingTurn ＋ 计划条读的 session.todos。
//
// 覆盖:
//  (A) 真进程、真收件箱路径:线程勾了「交给管家盯」、智能自动档,假模型第一回合建 5 步计划只做 1 步就收 →
//      收件箱 done 事件 → 管家到访 → 自动递「请继续完成上一个未完成的任务。」→ 第二回合做完;
//      行动流水落一行 steward_thread_continue(basis.origin=steward-continue,reason 写明计划进度与第几次)。
//  (A2) 真收件箱 · 失败回合(2026-10 日志补充):用户自己发起的回合在第 3 次模型调用时断线(传输失败,回合 ok:false
//      errorClass:network_down),线程勾了「交给管家盯」。修前:用户发起的回合不写成败账 → 收件箱第四源按「账缺席 = done」
//      报收工 → 管家说「已收工」、「失败自动重试」等不到 failed 事件、五态读不到 lastTurnFailed。
//      现在:回合收尾落 stewardLastTurn{ok:false,errorClass} → 事件 failed → 自理「重试」递「继续」→ 第二回合恢复;
//      同一事件不走两条路(没有 continue 流水)。
//  (B) 进程内、逐条判据与闸(同一份 srv):
//      B1 计划全部做完 → 不续、不留话;     B2 最后一句在向用户提问(计划没做完)→ 不续;
//      B3 计划没做完、回合正常收 → 续一轮,续完做完了就不再续;
//      B4 回合被工具次数上限截断(横幅判据 dangling,没有计划)→ 续一轮,续完横幅判据翻回 false;
//      B5 一直被截断 → 最多连续续 STEWARD_CONTINUE_NOPLAN_MAX 次,之后停下(降级成提议 + 行动流水 steward_continue_stopped);
//      B6 有计划但续一轮计划纹丝不动 → 停(no_progress),落流水;
//      B7 开关关 → 只提议、零执行;          B8 线程「每步都问」档 → 只提议;
//      B9 小时回合数到顶 → 熔断,线程不动;   B10 管家总开关关 → 整个到访不跑。
//
// 判定行:`STEWARD CONTINUE UNFINISHED E2E: ALL PASS`。
(async () => {
'use strict';
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port.js');

const t = createRunner('STEWARD CONTINUE UNFINISHED');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-continue-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const decisionsFile = path.join(HOME, 'steward', 'decisions-v1.ndjson');
const CONTINUE_PROMPT = '请继续完成上一个未完成的任务。';

// ── 两个假 provider:线程用的(按 [Sx] 标记与阶段演剧本),管家用的(只会答一段结构化 JSON)────────────
const READ_TARGETS = Array.from({ length: 12 }, (_, i) => {
  const f = path.join(HOME, `read-me-${i}.txt`);
  fs.writeFileSync(f, 'fixture ' + i);
  return f;
});
const textOf = m => (typeof (m && m.content) === 'string' ? m.content : JSON.stringify((m && m.content) || ''));
const plan5 = done => Array.from({ length: 5 }, (_, i) => ({ id: `t${i + 1}`, text: `步骤${i + 1}`, status: i < done ? 'done' : 'pending' }));
let readSeq = 0;
function threadScript(req) {
  const msgs = req.messages || [];
  const marker = (msgs.map(textOf).join('\n').match(/\[(S\w+)\]/) || [])[1] || '';
  let lastUser = -1;
  msgs.forEach((m, i) => { if (m && m.role === 'user') lastUser = i; });
  const cont = lastUser >= 0 && textOf(msgs[lastUser]).includes('请继续完成上一个未完成的任务');
  const toolsAfter = msgs.slice(lastUser + 1).filter(m => m && m.role === 'tool').length;
  const readOne = () => toolCallFrames('file_read', { path: READ_TARGETS[(readSeq++) % READ_TARGETS.length] }, 'call_r' + readSeq);
  const planCall = done => toolCallFrames('todo_write', { items: plan5(done) }, 'call_p' + (++readSeq));
  const text = s => [...textFrames(s), usageFrame(8, 4)];
  switch (marker) {
    case 'S6': if (textOf(msgs[lastUser]).trim() === '继续') return text('恢复了,这次做完了。');   // 管家自理重试递的那句
               if (toolsAfter < 2) return readOne();
               req.res.socket.destroy();                                                                // 第 3 发起断线(传输失败)
               return undefined;
    case 'S0': return toolsAfter === 0 ? planCall(5) : text('五步都做完了。');                              // 计划全勾完
    case 'S1': if (!cont) return toolsAfter === 0 ? planCall(1) : text('先做完第一步,其余的下一回合接着做。');
               return toolsAfter === 0 ? planCall(5) : text('五步全部完成。');                            // 续一轮后做完
    case 'S2': return toolsAfter === 0 ? planCall(1) : text('第一步完成了。要我继续做剩下的吗?'.replace('?', '？')); // 最后一句在问用户
    case 'S3': if (cont) return text('好了,已经完成。');                                                   // 被截断,续一轮后收口
               return readOne();
    case 'S4': return readOne();                                                                          // 永远被截断
    case 'S5': if (!cont) return toolsAfter === 0 ? planCall(1) : text('做完了第一步。');
               return text('还在想,这一轮没有新进展。');                                                    // 计划纹丝不动
    default: return text('ok');
  }
}
const threadFake = await startFakeProvider({ handler: threadScript });
const stewardReplies = [];
const stewardFake = await startFakeProvider({
  handler(req) { stewardReplies.push(req); return JSON.stringify({ say: '我看了一眼。', why: '收件箱', acts: [], actions: [] }); },
});

function writeConfig(patch) {
  const config = {
    configSchema: 7, activeProvider: 'tools', engineMode: 'interactive',
    permissionMode: 'auto',               // 「智能自动」:线程自己的权限档,管家据此判能不能自己续
    permissionTimeoutMs: 30000, includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0, killOnDisconnect: false, autoImportClaudeCodeMcp: false,
    stewardEnabledV1: true, stewardPollMs: 5000,
    stewardMaxTurnsPerHour: 100, stewardMaxCostPerDay: 0, stewardThreadBriefV1: false,
    stewardProviderId: 'replies',
    stewardAutoActions: { retry: true, resume: null, relay: true, newThread: true, answer: false },   // 不写 continueUnfinished:验证缺省即开
    providers: [
      { id: 'tools', label: 'Tools', type: 'openai-compat', baseUrl: threadFake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
      { id: 'replies', label: 'Replies', type: 'openai-compat', baseUrl: stewardFake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
    ],
    ...patch,
  };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

const readDecisions = () => {
  try { return fs.readFileSync(decisionsFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};
async function waitFor(pred, ms, step) {
  const deadline = Date.now() + (ms || 15000);
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step || 100);
  }
}
const continueRows = sid => readDecisions().filter(r => r.tool === 'steward_thread_continue' && r.targetSessionId === sid && r.basis && r.basis.origin === 'steward-continue');
const stoppedRows = sid => readDecisions().filter(r => r.tool === 'steward_continue_stopped' && r.targetSessionId === sid);

let wb = null;
let failedHeadA2 = null;
function kill(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* already gone */ } } }

try {
  /* ═════════ (A) 真进程、真收件箱路径 ═════════ */
  console.log('── (A) 真收件箱:回合收了计划 1/5 → 管家自己续 → 做完 ──');
  writeConfig({});
  const WB_PORT = await getFreePort();
  const token = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } };
  const request = (method, urlPath, body) => new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: urlPath, method, headers: { 'x-wcw-token': token(), ...(payload ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', () => resolve({ status: 0, text: '', json: null }));
    if (payload) req.write(payload);
    req.end();
  });
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  ok(await waitFor(async () => (await request('GET', '/api/status')).status === 200, 20000, 150), 'A0 工作台起来了');
  await request('POST', '/api/steward/start', {});   // 冷启动先建基线:之后新写的回合才入箱

  const created = await request('POST', '/api/sessions', { title: '真收件箱线程', cwd: HOME });
  const sid = created.json && created.json.session && created.json.session.id;
  ok(!!sid, 'A1 建了线程');
  await request('PATCH', '/api/sessions/' + sid, { stewardWatch: true });   // 「交给管家盯」
  await request('POST', '/api/chat/stream', { sessionId: sid, message: '[S1] 做一份五步调研', cwd: HOME });
  const first = (await request('GET', '/api/sessions/' + sid)).json || {};
  const firstTodos = (first.session && first.session.todos) || [];
  ok(first.session && first.session.turnSeq === 1 && firstTodos.length === 5 && firstTodos.filter(x => x.status === 'done').length === 1,
    `A2 第一回合收了,计划只完成 1/5(turnSeq=${first.session && first.session.turnSeq},done=${firstTodos.filter(x => x.status === 'done').length})`);
  ok(first.resumable && first.resumable.dangling === false, 'A3 这一回合是正常收的(没有「上次任务未完成」横幅),没做完的只是计划');

  // 收件箱每 5 秒一拍 + 5 秒去抖;反复推一把,最多等 90 秒。
  const done = await waitFor(async () => {
    await request('POST', '/api/steward/start', {});
    const r = (await request('GET', '/api/sessions/' + sid)).json || {};
    const todos = (r.session && r.session.todos) || [];
    return r.session && r.session.turnSeq >= 2 && todos.length === 5 && todos.every(x => x.status === 'done') && !(r.resumable && r.resumable.live) ? r : null;
  }, 90000, 1500);
  ok(!!done, 'A4 管家自己续了一轮,第二回合把计划做完了(5/5)');
  const rows = continueRows(sid);
  ok(rows.length === 1, `A5 行动流水里恰有一行自动续跑(got ${rows.length})`);
  const row = rows[0] || {};
  ok(row.basis && row.basis.auto === true && /计划已完成 1\/5/.test(String(row.basis.reason || '')) && /第 1 次自动续跑/.test(String(row.basis.reason || '')),
    `A6 流水的 basis 写明理由与次数(reason=${row.basis && row.basis.reason})`);
  const threadReqs = threadFake.requests.filter(r => JSON.stringify(r.messages || []).includes('[S1]'));
  ok(threadReqs.some(r => { const ms = r.messages || []; const lastUser = [...ms].reverse().find(m => m.role === 'user'); return lastUser && textOf(lastUser).includes(CONTINUE_PROMPT); }),
    'A7 递给线程的就是前端「继续」横幅那一句');
  ok(stewardReplies.some(r => JSON.stringify(r.messages || []).includes('自动让它继续了一轮')),
    'A8 管家的回合层拿到「已经自动续了」的说明(它该如实讲给用户听,不再问「要不要我拉出来」)');
  // 续完做完了:不会再续(给一拍时间让可能的错误第二次续跑露出来)
  await sleep(7000);
  await request('POST', '/api/steward/start', {});
  await sleep(7000);
  ok(continueRows(sid).length === 1, 'A9 做完之后不再续');

  /* ── (A2) 失败回合:network_down ── */
  console.log('── (A2) 真收件箱:回合 network_down 失败 → 不是 done,管家自动重试 ──');
  const created2 = await request('POST', '/api/sessions', { title: '断线线程', cwd: HOME });
  const sid2 = created2.json && created2.json.session && created2.json.session.id;
  await request('PATCH', '/api/sessions/' + sid2, { stewardWatch: true });
  await request('POST', '/api/chat/stream', { sessionId: sid2, message: '[S6] 读几个文件再总结', cwd: HOME });
  const failedHead = await waitFor(async () => {
    const r = (await request('GET', '/api/sessions/' + sid2)).json || {};
    return r.session && r.session.turnSeq === 1 && r.session.stewardLastTurn ? r.session : null;
  }, 20000, 300);
  ok(failedHead && failedHead.stewardLastTurn.ok === false && failedHead.stewardLastTurn.aborted === false && failedHead.stewardLastTurn.seq === 1,
    `A2.1 用户发起的回合失败,会话头落了成败账(got ${JSON.stringify(failedHead && failedHead.stewardLastTurn)})`);
  ok(failedHead && failedHead.stewardLastTurn.errorClass === 'network_down', `A2.2 errorClass=network_down(got ${failedHead && failedHead.stewardLastTurn && failedHead.stewardLastTurn.errorClass})`);
  failedHeadA2 = failedHead;   // A2.3 的五态断言要进程内的 srv,等 (B) 起来再判
  const recovered = await waitFor(async () => {
    await request('POST', '/api/steward/start', {});
    const r = (await request('GET', '/api/sessions/' + sid2)).json || {};
    return r.session && r.session.turnSeq >= 2 && !(r.resumable && r.resumable.live) ? r : null;
  }, 90000, 1500);
  ok(!!recovered, 'A2.4 管家自动重试了一次,线程第二回合起来了');
  const retryRows = readDecisions().filter(r => r.tool === 'steward_thread_continue' && r.targetSessionId === sid2);
  ok(retryRows.length === 1 && retryRows[0].basis && retryRows[0].basis.origin === 'steward-retry' && retryRows[0].basis.auto === true,
    `A2.5 行动流水:一行自理重试(origin=steward-retry;got ${JSON.stringify(retryRows.map(r => r.basis && r.basis.origin))})`);
  ok(continueRows(sid2).length === 0, 'A2.6 同一事件只走一条路:没有「没做完就续」的流水');
  const rec = (await request('GET', '/api/sessions/' + sid2)).json || {};
  ok(rec.session && rec.session.stewardLastTurn && rec.session.stewardLastTurn.ok === true && rec.session.stewardLastTurn.seq >= 2, 'A2.7 重试回合成功,成败账翻成 ok:true');
} finally {
  kill(wb); wb = null;
}
await sleep(400);

/* ═════════════════════ (B) 进程内:判据与闸 ═════════════════════ */
console.log('── (B) 进程内:判据与闸 ──');
process.env.RUYI_HOME = HOME;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
writeConfig({});
const srv = require(SERVER);
{
  // A2.3 同一份会话头喂五态适配器(06i 与前端 mission-state.js 读同一个 lastTurn 证据,两张表由差分测试逐格比对)
  const st = failedHeadA2 ? srv.stewardThreadStateFromHead(failedHeadA2) : null;
  ok(st && st.state === 'stopped' && st.sources.lastTurnFailed === true, `A2.3 失败回合的线程五态不再是 done(got ${st && st.state},lastTurnFailed=${st && st.sources.lastTurnFailed})`);
}
let evtSeq = 70000;
const doneEvent = (sid, turnSeq) => ({ inboxSeq: ++evtSeq, kind: 'done', sessionId: sid, missionId: sid, seq: turnSeq, at: new Date().toISOString(), payload: { source: 'session_turn', turnSeq, summary: `会话第 ${turnSeq} 回合跑完了` }, count: 1 });
let threadN = 0;
async function mkThread(tag, opts) {
  const cwd = path.join(HOME, 'ws-' + (++threadN));
  fs.mkdirSync(cwd, { recursive: true });
  const session = await srv.createSession({ title: tag, cwd });
  if (opts && opts.mode) { session.permissionMode = opts.mode; await srv.saveSession(session); }
  await srv.updateSessionMeta(session.id, { stewardWatch: true });   // 交给管家盯(收件箱才会为它出 done 事件)
  return { sid: session.id, cwd };
}
async function runTurn(th, message) {
  await srv.runSessionTurn({ sessionId: th.sid, message, cwd: th.cwd, source: 'http', onEvent: () => {} });
  return srv.loadSession(th.sid);
}
const idle = sid => String((srv.StewardHooks.relayChannel(sid) || {}).channel || '') === 'turn';
async function waitTurn(sid, seq) {
  return waitFor(async () => { const s = await srv.loadSession(sid); return s && s.turnSeq >= seq && idle(sid) ? s : null; }, 20000);
}
const autoRow = r => ((r && r.actions) || []).find(a => a && a.auto === true && a.intent === 'continue') || null;
const visit = (sid, turnSeq) => srv.runStewardTurn({ trigger: 'inbox', events: [doneEvent(sid, turnSeq)] });
const todosOf = s => ((s && s.todos) || []);
const doneCount = s => todosOf(s).filter(x => x.status === 'done').length;

try {
  {
    // B1 计划全部做完:什么都不做、什么都不说。
    const th = await mkThread('B1 做完了');
    const s1 = await runTurn(th, '[S0] 做五步');
    ok(doneCount(s1) === 5 && srv.detectDanglingTurn(s1).dangling === false, 'B1.0 前置:5/5 且回合收口');
    const before = stewardReplies.length;
    const r = await visit(th.sid, 1);
    ok(r && r.ok === true && !autoRow(r) && !(r.acts || []).some(a => a.label === '继续'), 'B1 做完了的线程:不续、不出提议按钮');
    const fresh = stewardReplies.slice(before);
    const lastUserOf = req => { const u = [...(req.messages || [])].reverse().find(m => m && m.role === 'user'); return u ? textOf(u) : ''; };
    ok(fresh.length >= 1 && fresh.every(req => !lastUserOf(req).includes('没做完')), 'B1b 这一次到访的回合层里没有「没做完」的说明');
    ok(continueRows(th.sid).length === 0, 'B1c 零流水');
  }
  {
    // B2 最后一句在向用户提问:不是「没做完」,是「等你」。
    const th = await mkThread('B2 在问你');
    const s1 = await runTurn(th, '[S2] 做五步');
    ok(doneCount(s1) === 1 && /？$/.test(String(s1.messages[s1.messages.length - 1].content || '').trim()), 'B2.0 前置:计划 1/5,最后一句以问号收尾');
    const r = await visit(th.sid, 1);
    ok(r && r.ok === true && !autoRow(r), 'B2 最后一条在向用户提问 → 不自动续');
    ok(continueRows(th.sid).length === 0 && (await srv.loadSession(th.sid)).turnSeq === 1, 'B2b 线程没动');
  }
  {
    // B3 计划没做完、回合正常收:续一轮,续完做完就不再续。
    const th = await mkThread('B3 计划没做完');
    await runTurn(th, '[S1] 做五步');
    const r = await visit(th.sid, 1);
    const a = autoRow(r);
    ok(!!a && a.tool === 'steward_thread_continue' && a.args.message === CONTINUE_PROMPT && a.result && a.result.ok === true && a.label === '继续',
      `B3 计划 1/5、回合正常收 → 自动递「继续」(got ${a && JSON.stringify(a.result && (a.result.error || a.result.ok))})`);
    const s2 = await waitTurn(th.sid, 2);
    ok(!!s2 && doneCount(s2) === 5, 'B3b 第二回合做完了计划(5/5)');
    ok(continueRows(th.sid).length === 1 && /计划已完成 1\/5/.test(String(continueRows(th.sid)[0].basis.reason || '')), 'B3c 落了一行带理由的行动流水');
    const r2 = await visit(th.sid, 2);
    ok(r2 && r2.ok === true && !autoRow(r2) && (await srv.loadSession(th.sid)).turnSeq === 2, 'B3d 做完之后的下一次到访不再续(账清零)');
  }
  {
    // B4 回合被工具次数上限截断:「上次任务未完成」横幅判据(没有计划)。
    writeConfig({ openaiMaxToolIterations: 2 });
    const th = await mkThread('B4 被截断');
    const s1 = await runTurn(th, '[S3] 读几个文件');
    const d1 = srv.detectDanglingTurn(s1);
    ok(d1.dangling === true && d1.kind === 'tool_calls' && todosOf(s1).length === 0 && /已达工具调用上限/.test(String(s1.messages[s1.messages.length - 1].content || '')),
      `B4.0 前置:撞了工具次数上限,横幅判据 dangling(${JSON.stringify(d1)}),没有计划`);
    const r = await visit(th.sid, 1);
    const a = autoRow(r);
    ok(!!a && a.result && a.result.ok === true, `B4 同一份横幅判据 → 自动续一轮(got ${a && JSON.stringify(a.result && (a.result.error || a.result.ok))})`);
    const s2 = await waitTurn(th.sid, 2);
    ok(!!s2 && srv.detectDanglingTurn(s2).dangling === false, 'B4b 续完回合收口,横幅判据翻回 false');
    ok(/回合没有收口/.test(String((continueRows(th.sid)[0] || { basis: {} }).basis.reason || '')), 'B4c 流水的理由写的是「回合没有收口」');
    writeConfig({});
  }
  {
    // B5 一直被截断:最多连续续 2 次,第 3 次停下,降级成提议,并落一行「不再自动续」。
    writeConfig({ openaiMaxToolIterations: 2 });
    const th = await mkThread('B5 一直截断');
    await runTurn(th, '[S4] 读几个文件');
    const a1 = autoRow(await visit(th.sid, 1));
    ok(!!a1 && a1.result && a1.result.ok === true, 'B5.1 第 1 次自动续');
    await waitTurn(th.sid, 2);
    const a2 = autoRow(await visit(th.sid, 2));
    ok(!!a2 && a2.result && a2.result.ok === true && /第 2 次自动续跑/.test(String((continueRows(th.sid)[1] || { basis: {} }).basis.reason || '')), 'B5.2 第 2 次自动续(流水写着「第 2 次」)');
    await waitTurn(th.sid, 3);
    const r3 = await visit(th.sid, 3);
    const a3 = autoRow(r3);
    ok(!!a3 && a3.result && a3.result.error === 'propose_required' && /连续自动续跑 2 次/.test(String(a3.result.message || '')),
      `B5.3 第 3 次到顶 → 不再自动,降级成提议(got ${a3 && a3.result && a3.result.message})`);
    ok((r3.acts || []).some(a => a.label === '继续' && a.tool === 'steward_thread_continue'), 'B5.4 用户手里留着一枚「继续」按钮');
    await sleep(300);
    ok((await srv.loadSession(th.sid)).turnSeq === 3 && continueRows(th.sid).length === 2, 'B5.5 线程没再被续(turnSeq 仍是 3,只有两行续跑流水)');
    const stop = await waitFor(() => stoppedRows(th.sid)[0] || null, 3000);
    ok(stop && stop.args.reason === 'max' && stop.mayAct === 'propose' && stop.basis.origin === 'steward-continue',
      `B5.6 到顶这一次也记了流水(steward_continue_stopped,reason=${stop && stop.args && stop.args.reason})`);
    writeConfig({});
  }
  {
    // B6 有计划但续一轮计划纹丝不动:不再续。
    const th = await mkThread('B6 计划没进展');
    await runTurn(th, '[S5] 做五步');
    const a1 = autoRow(await visit(th.sid, 1));
    ok(!!a1 && a1.result && a1.result.ok === true, 'B6.1 第一次:计划 1/5 → 续');
    const s2 = await waitTurn(th.sid, 2);
    ok(doneCount(s2) === 1, 'B6.2 续了一轮,计划仍是 1/5');
    const r2 = await visit(th.sid, 2);
    const a2 = autoRow(r2);
    ok(!!a2 && a2.result && a2.result.error === 'propose_required' && /计划没有往前走/.test(String(a2.result.message || '')),
      `B6.3 计划没往前走 → 停(got ${a2 && a2.result && a2.result.message})`);
    await sleep(300);
    ok((await srv.loadSession(th.sid)).turnSeq === 2, 'B6.4 线程没再被续');
    const stop = await waitFor(() => stoppedRows(th.sid)[0] || null, 3000);
    ok(stop && stop.args.reason === 'no_progress' && stop.args.todosDone === 1 && stop.args.todosTotal === 5, `B6.5 记了流水 reason=no_progress(got ${stop && JSON.stringify(stop.args)})`);
  }
  {
    // B7 开关关:只提议。
    writeConfig({ stewardAutoActions: { retry: true, resume: null, relay: true, newThread: true, answer: false, continueUnfinished: false } });
    const th = await mkThread('B7 开关关');
    await runTurn(th, '[S1] 做五步');
    const r = await visit(th.sid, 1);
    const a = autoRow(r);
    ok(!!a && a.result && a.result.error === 'propose_required' && /没有勾选/.test(String(a.result.message || '')), `B7 开关关 → 只提议(got ${a && a.result && a.result.message})`);
    ok((r.acts || []).some(x => x.label === '继续'), 'B7b 手里留一枚「继续」按钮');
    await sleep(300);
    ok((await srv.loadSession(th.sid)).turnSeq === 1 && continueRows(th.sid).length === 0 && stoppedRows(th.sid).length === 0, 'B7c 零执行、零流水');
    writeConfig({});
  }
  {
    // B8 线程是「每步都问」档:只提议。
    const th = await mkThread('B8 每步都问', { mode: 'default' });
    await runTurn(th, '[S1] 做五步');
    const r = await visit(th.sid, 1);
    const a = autoRow(r);
    ok(!!a && a.result && a.result.error === 'propose_required' && /权限为/.test(String(a.result.message || '')), `B8 「每步都问」档 → 只提议(got ${a && a.result && a.result.message})`);
    await sleep(300);
    ok((await srv.loadSession(th.sid)).turnSeq === 1 && continueRows(th.sid).length === 0, 'B8b 零执行');
  }
  {
    // B9 每小时回合数到顶:整个收件箱到访被熔断,线程不动。
    const th = await mkThread('B9 小时窗');
    await runTurn(th, '[S1] 做五步');
    writeConfig({ stewardMaxTurnsPerHour: 1 });
    const r = await visit(th.sid, 1);
    ok(r && r.ok === false && r.circuit && r.circuit.kind === 'turns_per_hour', `B9 小时回合数到顶 → 熔断(got ${r && r.circuit && r.circuit.kind})`);
    await sleep(300);
    ok((await srv.loadSession(th.sid)).turnSeq === 1 && continueRows(th.sid).length === 0, 'B9b 线程没被续');
    writeConfig({});
  }
  {
    // B10 管家总开关关:到访不跑。
    const th = await mkThread('B10 管家关');
    await runTurn(th, '[S1] 做五步');
    writeConfig({ stewardEnabledV1: false });
    const r = await visit(th.sid, 1);
    ok(r && r.ok === false && r.error === 'steward.disabled', 'B10 管家总开关关 → 到访不跑');
    await sleep(300);
    ok((await srv.loadSession(th.sid)).turnSeq === 1 && continueRows(th.sid).length === 0, 'B10b 线程没被续');
    writeConfig({});
  }
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  kill(wb);
  await threadFake.close().catch(() => {});
  await stewardFake.close().catch(() => {});
}

t.done({ exit: true });
})();
