'use strict';
// 管家收件箱轮询的「空转成本」(13i 的 stewardSaveCursor / stewardCollectSessionTurn / stewardInboxState)。
// 真源码、独立子进程、临时 HOME;成本用【计数器】断言(对 fs/promises 的 readFile/writeFile 计数),
// 不看墙钟 —— 慢机器上不会假红,修前的实现也确定会红。
//
// 背景:游标落盘要有容量上限(STEWARD_CURSOR_MAX_SESSIONS=500),修前 stewardSaveCursor 把这个上限
// 同样用在【进程内存】游标上 —— 第 501 个会话起每一拍都被裁掉、下一拍又算「首见」:整份会话头
// readFile + JSON.parse、开 .changes.ndjson、readdir agent-runs;cursor-v1.json(缩进 JSON)每拍
// 无条件重写;/api/steward/state 每次重读整份 inbox 只为数按类计数。
//   [T1] 会话数 > 500 时,无变化的第二/三拍【零】会话头读取、零 .changes.ndjson 打开、零游标写盘
//   [T2] 落盘游标仍按 500 封顶(重启后读回的语义不变)、写的是紧凑 JSON、内容结构完好
//   [T3] 有真变化(用户交接入箱)的那一拍照常写游标、照常入箱 —— 「不写」不是「写不出」
//   [S1] stewardInboxState 在 inbox 文件没变时不重读文件;追加(外部写、tick 写)之后的结果与
//        「独立按行解析整份文件」的参考值逐项相等;返回的 byKind 是拷贝,改它污染不了下一次
//   [S2] 读 inbox 撞上一次瞬时锁(EBUSY,Windows 杀软 / 索引器常见):那一次报零可以,但不许把「空箱子」记进备忘 ——
//        文件没再变,下一次也得读出真值(审查轮复现过:修前一直报零,直到文件下次变化)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-tick-cost-'));
const SESSION_COUNT = 620;   // > STEWARD_CURSOR_MAX_SESSIONS(500)
const PENDING_EVERY = 20;    // 每 20 个会话带一条待决 -> 31 条 needs_you,远低于单拍入箱上限 200(不触发结转)

fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: '', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000,
}, null, 2), 'utf8');

const childScript = path.join(HOME, 'tick-cost-child.js');
fs.writeFileSync(childScript, String.raw`
const fs = require('fs'), path = require('path');
const [, , server, home, countArg, pendingEveryArg] = process.argv;
const COUNT = Number(countArg), PENDING_EVERY = Number(pendingEveryArg);

// ── 造数:全是 3 天前动过的事项(不「近期」),每 PENDING_EVERY 个带一条待决 ──
const sessionsDir = path.join(home, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const old = new Date(Date.now() - 3 * 864e5).toISOString();
for (let i = 0; i < COUNT; i++) {
  const sid = 'sess_' + String(i).padStart(6, '0');
  fs.writeFileSync(path.join(sessionsDir, sid + '.json'), JSON.stringify({
    schemaVersion: 4, storageVersion: 2, id: sid, missionId: sid, kind: 'mission', title: 'M' + i, summary: '',
    cwd: home, pinned: false, createdAt: old, updatedAt: old, turnSeq: i % 7, messageCount: 0, providerHistoryCount: 0,
    mission: { goal: 'g' + i, createdAt: old, updatedAt: old, autoMode: 'off', changeSeq: i % 50,
      milestones: [{ id: 'm1', desc: 'x', status: 'pending', evidence: '', check: null }],
      budget: { maxAutoTurns: 10, maxTokens: 100000 }, spent: { autoTurns: 0, tokens: 0 },
      stall: { lastSignature: '', sameCount: 0 }, result: null },
  }));
  fs.writeFileSync(path.join(sessionsDir, sid + '.messages.ndjson'), '');
  fs.writeFileSync(path.join(sessionsDir, sid + '.provider.ndjson'), '');
  fs.writeFileSync(path.join(sessionsDir, sid + '.interventions.ndjson'), i % PENDING_EVERY === 0
    ? JSON.stringify({ id: 'iv_' + i, type: 'question', sessionId: sid, requestedAt: old, decidedAt: '', decidedBy: '',
        interventionVersion: 0, toolName: 'Bash', tier: 'exec', revertible: false, status: 'pending' }) + '\n'
    : '');
}

// ── 计数:只数与本件相关的四类 fs/promises 调用 ──
const fsp = require('fs/promises');
const counts = {};
const reset = () => { for (const k of Object.keys(counts)) delete counts[k]; };
const snap = () => ({ headRead: 0, changesOpen: 0, cursorWrite: 0, inboxRead: 0, ...counts });
for (const name of ['readFile', 'open', 'writeFile']) {
  const orig = fsp[name].bind(fsp);
  fsp[name] = function (p, ...rest) {
    const s = String(p);
    let cat = '';
    if (name === 'readFile' && /sessions[\\/]sess_\d+\.json$/.test(s)) cat = 'headRead';
    else if (/\.changes\.ndjson$/.test(s)) cat = 'changesOpen';
    else if (name === 'writeFile' && /cursor-v1\.json/.test(s)) cat = 'cursorWrite';
    else if ((name === 'readFile' || name === 'open') && /inbox-v1\.ndjson$/.test(s)) cat = 'inboxRead';
    if (cat) counts[cat] = (counts[cat] || 0) + 1;
    return orig(p, ...rest);
  };
}

const inboxFile = path.join(home, 'steward', 'inbox-v1.ndjson');
const cursorFile = path.join(home, 'steward', 'cursor-v1.json');
// 参考值:独立按行解析整份 inbox(不走 13i 的任何一个函数)
function reference() {
  const byKind = { needs_you: 0, failed: 0, done: 0, stalled: 0, budget: 0, adopted: 0, reminder: 0 };
  let inboxSeq = 0;
  let text = '';
  try { text = fs.readFileSync(inboxFile, 'utf8'); } catch { /* 无文件 = 空箱 */ }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || !Number.isSafeInteger(Number(row.inboxSeq)) || !Object.prototype.hasOwnProperty.call(byKind, row.kind)) continue;
    byKind[row.kind] += 1;
    inboxSeq = Math.max(inboxSeq, Number(row.inboxSeq));
  }
  return { byKind, inboxSeq };
}

(async () => {
  const srv = require(server);
  const cfg = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).config;
  const out = { ticks: [] };
  // 已在跑时再 start = 幂等地补一拍(见 startStewardInbox),用它当「手动 tick」。
  // 第 1 拍冷启动建基线 + 31 条待决入箱;第 2 拍让基线/首见的一切落定。
  await srv.startStewardInbox(cfg);
  await srv.startStewardInbox(cfg);
  for (let i = 0; i < 2; i++) { reset(); await srv.startStewardInbox(cfg); out.ticks.push(snap()); }   // 稳态两拍
  out.cursorText = fs.readFileSync(cursorFile, 'utf8');

  // [T3] 一次真变化:用户把线程交给管家 -> 下一拍入箱一行 adopted、inboxSeq 前进 -> 游标必须重写
  const seqBefore = reference().inboxSeq;
  srv.RUYI_EVENTS.emit('thread.adopted', { sessionId: 'sess_000001', by: 'user', note: 'tick-cost' });
  reset(); await srv.startStewardInbox(cfg); out.changeTick = snap();
  out.cursorAfterChange = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
  out.seqBefore = seqBefore; out.seqAfter = reference().inboxSeq;
  reset(); await srv.startStewardInbox(cfg); out.settleTick = snap();   // 变化之后又归于平静

  // [S1] state:第一次(文件自上次读之后被 tick 追加过)最多读一次,之后同一份文件零次读取
  reset();
  const s1 = await srv.StewardHooks.inboxState(cfg);
  const afterFirst = snap().inboxRead;
  const s2 = await srv.StewardHooks.inboxState(cfg);
  const s3 = await srv.StewardHooks.inboxState(cfg);
  const totalReads = snap().inboxRead;
  out.state = JSON.parse(JSON.stringify({ firstReads: afterFirst, totalReads, s1, s2, s3, ref: reference() }));   // 先序列化定格,下面要故意改 s3

  // 返回的 byKind 是拷贝:改它不该污染下一次
  s3.counts.byKind.needs_you = 99999;
  out.stateAfterMutation = await srv.StewardHooks.inboxState(cfg);

  // 外部追加(不经 13i 的写路径)两行 -> 结果必须跟上;文件大小变了备忘就失效
  fs.appendFileSync(inboxFile, [
    JSON.stringify({ inboxSeq: 90001, kind: 'failed', sessionId: 'sess_000002', missionId: 'sess_000002', runId: '', seq: 1, at: old, payload: {}, count: 1 }),
    JSON.stringify({ inboxSeq: 90002, kind: 'done', sessionId: 'sess_000003', missionId: 'sess_000003', runId: '', seq: 1, at: old, payload: {}, count: 1 }),
    JSON.stringify({ inboxSeq: 90003, kind: 'not_a_kind', sessionId: 'sess_000004', payload: {} }),   // 白名单外:读者一律跳过
    '{ 半行坏数据',
  ].join('\n') + '\n');
  reset();
  out.stateAfterAppend = await srv.StewardHooks.inboxState(cfg);
  out.stateAfterAppendReads = snap().inboxRead;
  out.stateAfterAppendRef = reference();

  srv.stopStewardInbox();
  process.stdout.write('RESULT ' + JSON.stringify(out) + '\n');
  process.exit(0);
})().catch(err => { console.error(err && err.stack || err); process.exit(1); });
`, 'utf8');

function runChild() {
  const res = cp.spawnSync(process.execPath, [childScript, SERVER, HOME, String(SESSION_COUNT), String(PENDING_EVERY)], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 240000,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, HOME, USERPROFILE: HOME },
  });
  assert.equal(res.status, 0, 'child 退出码 ' + res.status + '\n' + res.stderr);
  const line = String(res.stdout).split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, 'child 没有输出 RESULT\n' + res.stdout + res.stderr);
  return JSON.parse(line.slice('RESULT '.length));
}

const R = runChild();

test('[T1] 会话数 > 500:无变化的稳态拍零会话头读取、零 .changes.ndjson、零游标写盘', () => {
  assert.equal(R.ticks.length, 2);
  for (const [i, t] of R.ticks.entries()) {
    assert.equal(t.headRead, 0, `稳态第 ${i + 1} 拍还在重读会话头(修前 = ${SESSION_COUNT - 500} 次/拍):${JSON.stringify(t)}`);
    assert.equal(t.changesOpen, 0, `稳态第 ${i + 1} 拍还在开 .changes.ndjson:${JSON.stringify(t)}`);
    assert.equal(t.cursorWrite, 0, `稳态第 ${i + 1} 拍游标内容没变却重写了 cursor-v1.json:${JSON.stringify(t)}`);
    assert.equal(t.inboxRead, 0, `稳态第 ${i + 1} 拍读了 inbox:${JSON.stringify(t)}`);
  }
});

test('[T2] 落盘游标仍按 500 封顶、紧凑 JSON、结构完好', () => {
  const text = R.cursorText;
  assert.ok(!/\n/.test(text.trim()), '游标应写紧凑 JSON(单行),不是缩进 JSON');
  const cursor = JSON.parse(text);
  assert.equal(cursor.schema, 1);
  assert.ok(Number.isSafeInteger(cursor.inboxSeq) && cursor.inboxSeq >= 31, `inboxSeq=${cursor.inboxSeq}`);
  assert.equal(typeof cursor.updatedAt, 'string');
  assert.equal(Object.keys(cursor.sources.missionChanges).length, 500, '落盘的 missionChanges 应封顶在 500');
  assert.equal(Object.keys(cursor.sources.sessionTurns).length, 500, '落盘的 sessionTurns 应封顶在 500');
  assert.equal(cursor.sources.pendingIds.length, Math.ceil(SESSION_COUNT / PENDING_EVERY), '待决键全在');
  assert.ok(Array.isArray(cursor.sources.budgetSeen));
  for (const value of Object.values(cursor.sources.sessionTurns)) {
    assert.ok(Number.isSafeInteger(value.turnSeq) && typeof value.stamp === 'string');
  }
});

test('[T3] 真变化的那一拍照常写游标、照常入箱;之后归于平静又不写', () => {
  assert.equal(R.changeTick.cursorWrite, 1, `交接入箱后游标必须重写:${JSON.stringify(R.changeTick)}`);
  assert.equal(R.changeTick.headRead, 0);
  assert.ok(R.seqAfter > R.seqBefore, `adopted 行没入箱:${R.seqBefore} -> ${R.seqAfter}`);
  assert.equal(R.cursorAfterChange.inboxSeq, R.seqAfter, '游标里的 inboxSeq 跟上了新行');
  assert.equal(R.settleTick.cursorWrite, 0, '变化之后的空转拍不该再写');
  assert.equal(R.settleTick.headRead, 0);
});

test('[S1] stewardInboxState:文件没变不重读;追加之后与独立解析的参考值逐项相等', () => {
  const st = R.state;
  assert.ok(st.firstReads <= 1, `第一次最多读一遍文件,实际 ${st.firstReads}`);
  assert.equal(st.totalReads, st.firstReads, `文件没变的第 2/3 次调用还在重读 inbox(共 ${st.totalReads} 次)`);
  for (const s of [st.s1, st.s2, st.s3]) {
    assert.deepEqual(s.counts.byKind, st.ref.byKind, 'tick 写入之后的 byKind 与参考值不等');
    assert.equal(s.inboxSeq, st.ref.inboxSeq);
  }
  assert.ok(st.ref.byKind.needs_you >= 31 && st.ref.byKind.adopted === 1, JSON.stringify(st.ref));
  // 返回值是拷贝
  assert.deepEqual(R.stateAfterMutation.counts.byKind, st.ref.byKind, '改返回值污染了备忘');
  // 外部追加:failed +1、done +1,白名单外与坏行被跳过,inboxSeq 取到 90002(90003 是白名单外的行)
  assert.equal(R.stateAfterAppendReads, 1, '文件变了应恰好重算一次');
  assert.deepEqual(R.stateAfterAppend.counts.byKind, R.stateAfterAppendRef.byKind);
  assert.equal(R.stateAfterAppend.counts.byKind.failed, st.ref.byKind.failed + 1);
  assert.equal(R.stateAfterAppend.counts.byKind.done, st.ref.byKind.done + 1);
  assert.equal(R.stateAfterAppend.inboxSeq, 90002);
  assert.equal(R.stateAfterAppendRef.inboxSeq, 90002);
});

process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ } });

test('[S2] 读 inbox 撞上瞬时锁:不把空结果记进备忘,下一次读出真值', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-inbox-ebusy-'));
  try {
    const script = path.join(home, 'ebusy-child.js');
    fs.writeFileSync(script, String.raw`
const fs = require('fs'), path = require('path'), fsp = require('fs/promises');
const [, , server, home] = process.argv;
process.env.RUYI_HOME = home;
const srv = require(server);
(async () => {
  const dir = path.join(home, 'steward'); fs.mkdirSync(dir, { recursive: true });
  const rows = [1, 2, 3].map(i => JSON.stringify({ inboxSeq: i, kind: 'needs_you', sessionId: 'sess_x' + i, missionId: 'm', runId: '', seq: 1, at: new Date().toISOString(), payload: {}, count: 1 }));
  fs.writeFileSync(path.join(dir, 'inbox-v1.ndjson'), rows.join('\n') + '\n');
  const orig = fsp.readFile; let fail = 1;
  fsp.readFile = function (p, ...rest) {
    if (fail > 0 && /inbox-v1\.ndjson$/.test(String(p))) { fail -= 1; const e = new Error('EBUSY'); e.code = 'EBUSY'; return Promise.reject(e); }
    return orig.call(fsp, p, ...rest);
  };
  const cfg = { stewardEnabledV1: true };
  const first = await srv.StewardHooks.inboxState(cfg);
  fsp.readFile = orig;
  const second = await srv.StewardHooks.inboxState(cfg);
  process.stdout.write(JSON.stringify({ first: first.counts.byKind.needs_you, second: second.counts.byKind.needs_you }));
  process.exit(0);
})();
`);
    const out = JSON.parse(cp.execFileSync(process.execPath, [script, SERVER, home], { encoding: 'utf8', env: { ...process.env, RUYI_HOME: home } }));
    assert.equal(out.first, 0, '撞锁的那一次读不出东西(前提成立)');
    assert.equal(out.second, 3, '文件没变,下一次仍读出真值');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
