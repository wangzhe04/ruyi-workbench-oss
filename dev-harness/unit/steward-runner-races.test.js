'use strict';
// hunt2-steward:管家运行器 / 收件箱 / 到访的一组竞态与丢数据回归。真源码、临时 HOME、进程内假 provider。
//   [R1] 三句用户的话排在同一个在途回合后面:按到达顺序逐个跑完,零并跑、零 superseded(修前后两句一起冲出去,
//        后开的把先开的顶掉,一句话被吞)。
//   [R2] 回合已进 runSessionTurn(turnSettlers 已登记)、还没进 activeChildren 的窗口里:
//        递话通道判 queued(修前判 turn),别处来源的新回合 409 SESSION_TURN_BUSY_ELSEWHERE(修前起新回合、
//        把刚开跑的回合 superseded 掉)。
//   [R3] 端点回 500(runSessionTurn 外层 ok:true、内层 result.ok:false):用户回合回 steward.turn_failed
//        (修前 ok:true、say 为空);收件箱回合那一批事件回到队列,重试有界(同一条至多再试 3 次)。
//   [R4] 收件箱第四源:上一个管家回合留下的失败账(seq 落后于当前回合)不把后来的回合报成 failed。
//   [R6] 收件箱 start → stop → start 交错之后再 stop:不留下仍在跑的轮询 interval(修前漏一个)。
//   [R8] 到访摘要:离开期间攒下 >200 行收件箱,全部计入,水位推到最后一行(修前只数前 200 行、水位却跳到全箱最大)。
//   [R10] 总览按投影指纹复用会话头:没变的会话不重读;改过的会话照样读到新值。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames, usageFrame } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-races-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;

// 假 provider 的行为按测试切换:reply(结构化契约 JSON)/ fail(HTTP 500)。
let mode = 'reply';
let delayMs = 0;
let live = 0;
let maxLive = 0;
let fake = null;
let srv = null;
const reply = say => JSON.stringify({ say, why: 'w', acts: [], actions: [] });

before(async () => {
  fake = await startFakeProvider({
    handler(req) {
      if (mode === 'fail') return { status: 500, json: { error: { message: 'boom' } } };
      live += 1; maxLive = Math.max(maxLive, live);
      const last = [...req.messages].reverse().find(m => m && m.role === 'user');
      const text = String((last && last.content) || '');
      const tag = (/msg\d/.exec(text) || ['plain'])[0];
      const frames = [...textFrames(reply('答' + tag)), usageFrame({ prompt_tokens: 8, completion_tokens: 4 })];
      return new Promise(resolve => setTimeout(() => { live -= 1; resolve({ frames }); }, delayMs));
    },
  });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
    includeWorkbenchMcp: false, defaultWorkspace: root, recentWorkspaces: [], subagentMaxPerTurn: 0,
    // This in-process fixture only exercises the fake provider; auto-detecting an installed desktop
    // MCP leaves its stdio client alive after the assertions and prevents node:test from exiting.
    desktopMcp: { enabled: false, autodetect: false },
    killOnDisconnect: false, locale: 'zh-CN',
    stewardEnabledV1: true, stewardPollMs: 5000, stewardReadBudgetChars: 4000, stewardMaxTurnsPerHour: 500,
    stewardMaxCostPerDay: 0, stewardGlobalMaxTurnsPerHour: 2000, stewardProviderId: 'fake', stewardModel: 'm',
    stewardThreadBriefV1: false, stewardConversationRetention: 'forever',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }],
  }), 'utf8');
  srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
});

after(async () => {
  try { srv && srv.stopStewardInbox(); } catch { /* best-effort */ }
  try { await fake.close(); } catch { /* best-effort */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('[R1] 排队的用户回合按到达顺序逐个跑,不互相顶掉', async () => {
  mode = 'reply'; delayMs = 400; maxLive = 0;
  const say = i => srv.runStewardTurn({ trigger: 'user', message: 'msg' + i, onEvent: () => {} });
  const seen = fake.requests.length;
  const p1 = say(1);
  for (let i = 0; i < 200 && fake.requests.length === seen; i++) await sleep(10);   // 第一句已经在调模型
  const p2 = say(2);
  await sleep(100);                                                                   // 第二句已经排上队
  const p3 = say(3);
  const results = await Promise.all([p1, p2, p3]);
  delayMs = 0;
  for (const [i, r] of results.entries()) {
    assert.equal(r.ok, true, `第 ${i + 1} 句成功`);
    assert.equal(r.say, '答msg' + (i + 1), `第 ${i + 1} 句拿到的是它自己的回答`);
  }
  assert.equal(maxLive, 1, '同一时刻只有一个管家回合在调模型');
  const session = await srv.loadSession('steward');
  const users = session.messages.filter(m => m.role === 'user').map(m => String(m.content));
  assert.deepEqual(users.slice(-3), ['msg1', 'msg2', 'msg3'], '三句用户的话按说的顺序落盘,一句不少');
});

test('[R2] 回合起步窗口里:递话判 queued,别处来源的新回合 409', async () => {
  mode = 'reply'; delayMs = 300;
  const sess = await srv.createSession({ title: 'r2', cwd: root });
  let channelInWindow = '';
  let second = null;
  const first = srv.runSessionTurn({
    sessionId: sess.id, message: 'first', cwd: root, source: 'http',
    onEvent: evt => {
      if (evt && evt.type === 'session' && !second) {
        // 这一刻 turnSettlers 已登记、引擎还没开跑(activeChildren 里没有它)。
        channelInWindow = srv.StewardHooks.relayChannel(sess.id).channel;
        second = srv.runSessionTurn({ sessionId: sess.id, message: 'from-steward', cwd: root, source: 'steward', onEvent: () => {} })
          .then(r => ({ ran: true, r }), e => ({ ran: false, code: e && e.code }));
      }
    },
  });
  const r1 = await first;
  const r2 = await second;
  delayMs = 0;
  assert.equal(channelInWindow, 'queued', '起步窗口里递话通道判 queued(修前 turn)');
  assert.equal(r2.ran, false, '别处来源的新回合没有开跑');
  assert.equal(r2.code, 'SESSION_TURN_BUSY_ELSEWHERE');
  assert.equal(r1.ok, true);
  assert.equal(r1.stopped, false, '先开跑的回合没被 superseded');
  const fin = await srv.loadSession(sess.id);
  assert.deepEqual(fin.messages.filter(m => m.role === 'user').map(m => String(m.content)), ['first']);
});

test('[R3] 端点 500:回合如实失败;收件箱批次回到队列,重试有界', async () => {
  mode = 'fail';
  const user = await srv.runStewardTurn({ trigger: 'user', message: 'will fail', onEvent: () => {} });
  assert.equal(user.ok, false, '用户回合如实失败(修前 ok:true、say 为空)');
  assert.equal(user.error, 'steward.turn_failed');
  const cfg = await srv.readConfig();
  const ev = { kind: 'done', sessionId: 'sess_aaaaaaaaaaaaaaaa', missionId: 'sess_aaaaaaaaaaaaaaaa', runId: '', seq: 3, at: new Date().toISOString(), payload: { summary: '会话第 3 回合跑完了' }, inboxSeq: 1 };
  const queued = [];
  for (let i = 0; i < 4; i++) {
    const r = await srv.runStewardTurn({ trigger: 'inbox', events: [ev], onEvent: () => {} });
    assert.equal(r.ok, false);
    queued.push((await srv.StewardHooks.runnerState(cfg)).queued);
    srv.StewardHooks.stopRunner(); srv.StewardHooks.resumeRunner();   // 清队列,模拟排空器把它取走
  }
  assert.deepEqual(queued, [1, 1, 1, 0], '前三次失败都把这批事件放回队列,第四次放弃');
  mode = 'reply';
});

test('[R4] 收件箱第四源:过期的失败账不把后来的回合报成 failed', async () => {
  const cfg = await srv.readConfig();
  const x = await srv.createSession({ title: 'r4', cwd: root });
  x.launchedBy = 'steward'; x.stewardWatch = true; x.turnSeq = 2;
  x.stewardLastTurn = { seq: 1, ok: false, aborted: false, errorClass: 'idle_timeout', at: new Date().toISOString() };
  await srv.saveSession(x);
  await srv.startStewardInbox(cfg); srv.stopStewardInbox();   // 第一拍:建基线
  const y = await srv.loadSession(x.id);
  y.turnSeq = 3; y.messages.push({ role: 'user', content: 'hi', createdAt: new Date().toISOString() });
  await srv.saveSession(y);                                    // 用户自己跑的第 3 回合(不写成败账)
  await srv.startStewardInbox(cfg); srv.stopStewardInbox();
  const read = await srv.StewardHooks.inboxRead({ limit: 200 });
  const row = read.items.find(item => item.sessionId === x.id && item.seq === 3);
  assert.ok(row, '第 3 回合进了收件箱');
  assert.equal(row.kind, 'done', '修前被第 1 回合的失败账报成 failed');
});

test('[R6] start → stop → start 交错之后 stop:没有漏掉的轮询器', async () => {
  const cfg = await srv.readConfig();
  const liveIntervals = new Set();
  const origSet = global.setInterval;
  const origClear = global.clearInterval;
  global.setInterval = (fn, ms, ...rest) => { const h = origSet(fn, ms, ...rest); if (ms === 5000) liveIntervals.add(h); return h; };
  global.clearInterval = h => { liveIntervals.delete(h); return origClear(h); };
  try {
    const p1 = srv.startStewardInbox(cfg);
    srv.stopStewardInbox();
    const p2 = srv.startStewardInbox(cfg);
    await Promise.all([p1, p2]);
    assert.equal(liveIntervals.size, 1, '恢复之后恰好一个轮询器');
    srv.stopStewardInbox();
    assert.equal(liveIntervals.size, 0, '停机之后一个不剩(修前漏一个,永远停不下来)');
  } finally {
    for (const h of liveIntervals) origClear(h);
    global.setInterval = origSet;
    global.clearInterval = origClear;
  }
});

test('[R8] 到访摘要把 >200 行收件箱全部计入', async () => {
  const before = await srv.StewardHooks.inboxRead({ limit: 1 });
  const base = Number(before.inboxSeq) || 0;
  const at = new Date().toISOString();
  const lines = [];
  for (let i = 1; i <= 250; i++) {
    lines.push(JSON.stringify({ inboxSeq: base + i, kind: 'done', sessionId: 'sess_digest' + String(i).padStart(6, '0'), missionId: 'sess_digest' + String(i).padStart(6, '0'), runId: '', seq: 1, at, payload: { summary: 'x' }, count: 1 }));
  }
  fs.mkdirSync(path.join(root, 'steward'), { recursive: true });
  fs.appendFileSync(path.join(root, 'steward', 'inbox-v1.ndjson'), lines.join('\n') + '\n', 'utf8');
  const digest = await srv.stewardVisitDigest(base, 0);
  assert.equal(digest.counts.done, 250, '250 行都数进去了(修前 200)');
  assert.equal(digest.inboxSeq, base + 250, '水位推到最后一行');
});

test('[R10] 总览复用没变过的会话头,改过的照样读到新值', async () => {
  const fsp = require('fs/promises');
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const x = await srv.createSession({ title: 'r10-' + i, cwd: root });
    x.messages.push({ role: 'user', content: 'hi', createdAt: new Date().toISOString() });
    await srv.saveSession(x);
    ids.push(x.id);
  }
  await srv.stewardVisit({ force: true });
  const reads = [];
  const orig = fsp.readFile;
  fsp.readFile = function (file, ...rest) { reads.push(String(file)); return orig.call(this, file, ...rest); };
  try {
    await srv.stewardVisit({ force: true });
  } finally { fsp.readFile = orig; }
  const headReads = reads.filter(f => ids.some(id => f.endsWith(id + '.json'))).length;
  assert.ok(headReads <= ids.length, `第二次到访总览不再逐条重读会话头(读了 ${headReads} 次;修前每条两次)`);
  const y = await srv.loadSession(ids[0]);
  y.title = 'r10-renamed';
  await srv.saveSession(y);
  const v = await srv.stewardVisit({ force: true });
  assert.ok(v.threads.some(t => t.sessionId === ids[0] && t.title === 'r10-renamed'), '改过名的会话在总览里是新名字');
});
