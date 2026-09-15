// Unit: 第 116 波 116b(27 号文 §11.3) —— 管家收件箱的归一化 / 合并 / 去重纯函数。
// 覆盖:
//   ① STEWARD_SOURCE_EVENT_MAP 四张子表的形状:值只能是五类之一 / null / '@resolver';
//      五类白名单以外的 kind 一个都不许出现。
//   ② 三个源的归一化穷举:mission change 11 种 type、agent run 24 种 type、intervention 5 种 type,
//      (116-2b 各加两条停滞/预算 type:stalled/budget_tripped 与 run_stalled/run_budget_tripped),
//      逐个断言映射结果(期望值是照 116b 设计逐条抄写的字面量表,不是对生产实现分支的镜像重写)。
//   ③ 条件解析器:result(complete/stopped±错误)、run_end(succeeded/stopped/failed/partial)、
//      node_settled(failed/rejected/succeeded/skipped)。
//   ④ payload 纪律:摘要 ≤200 字加省略号、尖括号中和、换行折叠;permission 待决绝不带 iv.input。
//   ⑤ 5 秒窗口合并:同 sessionId 同 kind 并成一条(count 累加、at 取最早、payload 取最新、
//      mergedSeqs 回填);跨 kind / 跨 session / 超窗不合并。
//   ⑥ 去重键:sessionId+kind+runId+seq;needs_you 的 seq 位是 interventionId;
//      stewardInboxRowDedupeKeys 能从合并行还原全部源键(重启后不重复入箱的地基)。
//
// 与既有 dev-harness/unit 件同款约定:require server.js 前先把 WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时
// 目录(该变量是系统级的,曾污染真实数据根);逐条打印 PASS/FAIL;process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-inbox-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const {
  STEWARD_EVENT_KINDS,
  STEWARD_SOURCE_EVENT_MAP,
  stewardNormalizeMissionChange,
  stewardNormalizeRunEvent,
  stewardNormalizePendingIntervention,
  stewardNormalizeBudgetExhausted,
  stewardMergeInboxEvents,
  stewardEventDedupeKey,
  stewardInboxRowDedupeKeys,
} = srv;

const KINDS = new Set(STEWARD_EVENT_KINDS);

/* ═══════════════ ① 映射表形状 ═══════════════ */

ok(Object.isFrozen(STEWARD_SOURCE_EVENT_MAP), '映射表冻结');
// 116-2b 增第五张 sseOnly(只走 SSE、故意不落持久日志的进度信号;登记为 null 只为留痕)。
const SUB_TABLES = ['missionChange', 'agentRun', 'intervention', 'projection', 'sseOnly'];
ok(SUB_TABLES.every(k => STEWARD_SOURCE_EVENT_MAP[k] && Object.isFrozen(STEWARD_SOURCE_EVENT_MAP[k])),
  '五张子表齐全且冻结: ' + SUB_TABLES.join('/'));
{
  const bad = [];
  for (const table of SUB_TABLES) {
    for (const [type, value] of Object.entries(STEWARD_SOURCE_EVENT_MAP[table])) {
      if (value === null) continue;
      if (typeof value === 'string' && value.startsWith('@')) continue;
      if (KINDS.has(value)) continue;
      bad.push(`${table}.${type}=${JSON.stringify(value)}`);
    }
  }
  ok(bad.length === 0, '表值只允许 五类/null/@resolver' + (bad.length ? ' :: ' + bad.join(', ') : ''));
}

/* ═══════════════ ② Mission Change Ledger 11 种 type 穷举 ═══════════════ */

const AT = '2026-09-05T10:00:00.000Z';
const mc = (type, detail, cursor) => stewardNormalizeMissionChange({
  schemaVersion: 1, sessionId: 'session_a', missionId: 'session_a', seq: 7,
  type, occurredAt: AT, cursor: cursor || {}, detail: detail || {},
});

// 期望表照 116b 设计逐条抄写(null = 丢弃)。
const MISSION_CHANGE_EXPECT = [
  ['mission_started', {}, null],
  ['progress', {}, null],
  ['failure', { errorClass: 'tool_error' }, 'failed'],
  ['budget', { cost: 0.5 }, null],
  ['intervention_pending', { interventionType: 'permission' }, null],
  ['intervention_resolved', { status: 'allowed' }, null],
  ['result', { status: 'complete' }, 'done'],
  ['rewind', {}, null],
  ['run_deleted', {}, null],
  // 116-2b:两个新 type。'budget'(上面那条)仍是心跳,'budget_tripped' 才是真触顶 —— 一起断言
  // 才能看住「新 type 没有把既有 type 的语义顺手改掉」。
  ['stalled', { reason: 'loop_recovery', tool: 'file_read', count: 2 }, 'stalled'],
  ['budget_tripped', { axis: 'turn_tokens', spent: 9000, budget: 8000 }, 'budget'],
  // 116g:线程加入/移出事项、事项合并/拆分。归属变更不是五类信号(用户自己刚做完这个动作),
  // 登记为 null = 显式丢弃,不是漏登。
  ['mission_membership', { action: 'attach', missionId: 'mission_x' }, null],
];
for (const [type, detail, expected] of MISSION_CHANGE_EXPECT) {
  const evt = mc(type, detail);
  ok((evt && evt.kind) === expected || (evt === null && expected === null),
    `missionChange ${type} -> ${expected === null ? '丢弃' : expected}`);
}
ok(Object.keys(STEWARD_SOURCE_EVENT_MAP.missionChange).length === MISSION_CHANGE_EXPECT.length,
  `missionChange 子表恰 ${MISSION_CHANGE_EXPECT.length} 条(与穷举表等长)`);

// 条件解析器 @missionResult
ok(mc('result', { status: 'complete' }).kind === 'done', 'result complete -> done');
ok(mc('result', { status: 'stopped' }).kind === 'done', 'result stopped 无错误 -> done(用户主动收工)');
ok(mc('result', { status: 'stopped', errorClass: 'tool_error' }).kind === 'failed', 'result stopped 带 errorClass -> failed');
ok(mc('result', { status: 'stopped', failed: 2 }).kind === 'failed', 'result stopped 带 failed 计数 -> failed');
ok(mc('result', { status: '' }) === null, 'result 无 status -> 丢弃');

// 归一化字段
{
  const evt = mc('failure', { errorClass: 'network_down' }, { turnSeq: 3, engine: 'openai' });
  ok(evt.sessionId === 'session_a' && evt.missionId === 'session_a' && evt.runId === '', 'missionChange 归一化带 sessionId/missionId/空 runId');
  ok(evt.seq === 7 && evt.at === AT, 'missionChange seq/at 取源记录');
  ok(evt.payload.errorClass === 'network_down' && evt.payload.turnSeq === 3 && evt.payload.engine === 'openai', 'missionChange payload 带 errorClass/turnSeq/engine');
}
ok(stewardNormalizeMissionChange({ type: 'failure', seq: 0 }) === null, 'missionChange seq<1 -> 丢弃');
ok(stewardNormalizeMissionChange(null) === null, 'missionChange null 入参 -> 丢弃');
ok(mc('未登记的新类型', {}) === null, 'missionChange 未登记 type -> 丢弃(表查询默认 null)');

/* ═══════════════ ③ agent run 22 种 type 穷举 ═══════════════ */

const ar = (type, data, extra) => stewardNormalizeRunEvent('session_b', 'session_b', 'run_1',
  { seq: 12, ts: AT, runId: 'run_1', type, data: data || {}, ...(extra || {}) });

const AGENT_RUN_EXPECT = [
  ['run_created', {}, null],
  ['run_end', { status: 'succeeded' }, 'done'],
  ['run_paused', { reason: 'user' }, null],
  ['run_resumed', {}, null],
  ['run_resume_requested', {}, null],
  ['run_resume_deferred', { tier: 'manual' }, 'stalled'],
  ['run_auto_resume', {}, null],
  ['run_interrupted', {}, 'stalled'],
  ['run_stop_requested', {}, null],
  ['run_pool', {}, null],
  ['run_replan', {}, null],
  ['node_start', {}, null],
  ['node_progress', { text: 'x' }, null],
  ['node_wait', {}, null],
  ['node_settled', { status: 'failed' }, 'failed'],
  ['node_requeued', {}, null],
  ['node_wrapup_requested', {}, null],
  ['node_wrapup_forced', {}, null],
  ['node_idle_aborted', {}, 'stalled'],
  ['node_no_progress_aborted', {}, 'stalled'],
  ['persistence_degraded', { consecutiveFailures: 3 }, 'failed'],
  ['persistence_recovered', {}, null],
  // 116-2b:两个新 run 事件 type。
  ['run_stalled', { reason: 'subagent_no_progress', count: 3 }, 'stalled'],
  ['run_budget_tripped', { reason: 'tool_iteration_budget', limit: 40 }, 'budget'],
];
for (const [type, data, expected] of AGENT_RUN_EXPECT) {
  const evt = ar(type, data);
  ok((evt && evt.kind) === expected || (evt === null && expected === null),
    `agentRun ${type} -> ${expected === null ? '丢弃' : expected}`);
}
ok(Object.keys(STEWARD_SOURCE_EVENT_MAP.agentRun).length === AGENT_RUN_EXPECT.length,
  `agentRun 子表恰 ${AGENT_RUN_EXPECT.length} 条(与穷举表等长)`);

// 条件解析器 @runEnd / @nodeSettled
ok(ar('run_end', { status: 'stopped' }).kind === 'done', 'run_end stopped -> done');
ok(ar('run_end', { status: 'failed' }).kind === 'failed', 'run_end failed -> failed');
ok(ar('run_end', { status: 'partial' }).kind === 'failed', 'run_end partial -> failed');
ok(ar('run_end', { status: 'running' }) === null, 'run_end 非终态 status -> 丢弃');
ok(ar('node_settled', { status: 'rejected' }).kind === 'failed', 'node_settled rejected -> failed');
ok(ar('node_settled', { status: 'succeeded' }) === null, 'node_settled succeeded -> 丢弃');
ok(ar('node_settled', { status: 'skipped' }) === null, 'node_settled skipped -> 丢弃');

// payload 纪律:node_progress 的 data.text 永不入箱(高频且可能含工具输出片段)。
{
  const evt = ar('node_settled', { status: 'failed', errorClass: 'tool_error', text: '不该出现的正文' }, { nodeId: 'n1' });
  ok(evt.runId === 'run_1' && evt.payload.nodeId === 'n1' && evt.payload.errorClass === 'tool_error', 'agentRun payload 带 runId/nodeId/errorClass');
  ok(!('text' in evt.payload), 'agentRun payload 不带 data.text(不带工具输出全文)');
  ok(evt.seq === 12 && evt.at === AT, 'agentRun seq/at 取源事件');
}
ok(stewardNormalizeRunEvent('s', 's', 'r', { seq: 0, type: 'run_end', data: { status: 'failed' } }) === null, 'agentRun seq<1 -> 丢弃');

/* ═══════════════ ④ Intervention 5 种 type + 预算 ═══════════════ */

const iv = (type, extra) => stewardNormalizePendingIntervention('session_c', 'session_c',
  { id: 'iv_1', type, status: 'pending', requestedAt: AT, ...(extra || {}) });

const INTERVENTION_EXPECT = [
  ['permission', { toolName: 'file_write', tier: 'edit' }, 'needs_you'],
  ['question', { questionSummary: '选哪个框架?' }, 'needs_you'],
  ['plan', { planSummary: '三步计划' }, 'needs_you'],
  ['pool', { task: '补一个测试', runId: 'run_9' }, 'needs_you'],
  ['replan', { summary: '重规划提案' }, null],
];
for (const [type, extra, expected] of INTERVENTION_EXPECT) {
  const evt = iv(type, extra);
  ok((evt && evt.kind) === expected || (evt === null && expected === null),
    `intervention ${type} -> ${expected === null ? '丢弃' : expected}`);
}
ok(Object.keys(STEWARD_SOURCE_EVENT_MAP.intervention).length === INTERVENTION_EXPECT.length,
  `intervention 子表恰 ${INTERVENTION_EXPECT.length} 条(与穷举表等长)`);
ok(iv('permission', { status: 'allowed' }) === null || stewardNormalizePendingIntervention('s', 's', { id: 'x', type: 'permission', status: 'allowed' }) === null,
  '非 pending 的 Intervention -> 丢弃');
{
  const evt = iv('permission', { toolName: 'file_write', tier: 'edit', input: { path: 'C:/secret.txt', content: '机密正文' } });
  ok(evt.seq === 'iv_1', 'needs_you 的 seq 位 = interventionId');
  ok(evt.payload.interventionId === 'iv_1' && evt.payload.interventionType === 'permission', 'needs_you payload 带 interventionId/type');
  ok(!('input' in evt.payload) && !JSON.stringify(evt.payload).includes('机密正文'), 'needs_you payload 绝不带 iv.input(工具输入/输出全文)');
  ok(evt.payload.summary.includes('file_write'), 'permission 摘要含工具名');
}
{
  const long = 'x'.repeat(400);
  const evt = iv('question', { questionSummary: '<b>' + long + '</b>\n第二行' });
  ok(evt.payload.summary.length === 201 && evt.payload.summary.endsWith('…'), '摘要 200 字截断 + 省略号(实测长度 ' + evt.payload.summary.length + ')');
  ok(!evt.payload.summary.includes('<') && !evt.payload.summary.includes('>'), '摘要尖括号中和');
}
{
  const evt = iv('pool', { task: '第一行\n第二行' });
  ok(!evt.payload.summary.includes('\n'), '摘要换行折叠为空格');
}
// 预算触顶(投影派生,一次性)
{
  const card = { updatedAt: AT, mission: { budgetExhausted: true, updatedAt: AT, budget: { maxAutoTurns: 5, maxTokens: 100 }, spent: { autoTurns: 5, tokens: 99 } } };
  const evt = stewardNormalizeBudgetExhausted('session_d', 'session_d', card);
  ok(evt && evt.kind === 'budget' && evt.seq === 'exhausted', 'budgetExhausted -> budget(seq 位 = exhausted,每个事项一次性)');
  ok(evt.payload.autoTurns === 5 && evt.payload.maxAutoTurns === 5, 'budget payload 带用量/上限');
  ok(stewardNormalizeBudgetExhausted('s', 's', { mission: { budgetExhausted: false } }) === null, '未触顶 -> 丢弃');
  ok(stewardNormalizeBudgetExhausted('s', 's', null) === null, '无 card -> 丢弃');
}

/* ═══════════════ ⑤ 5 秒窗口合并 ═══════════════ */

const t = ms => new Date(Date.parse('2026-09-05T10:00:00.000Z') + ms).toISOString();
const ev = (sessionId, kind, seq, atMs, payload) => ({ kind, sessionId, missionId: sessionId, runId: '', seq, at: t(atMs), payload: payload || { n: seq } });

{
  const merged = stewardMergeInboxEvents([
    ev('s1', 'failed', 1, 0, { n: 1 }),
    ev('s1', 'failed', 2, 1000, { n: 2 }),
    ev('s1', 'failed', 3, 4999, { n: 3 }),
  ], 5000);
  ok(merged.length === 1, '同 session 同 kind 窗口内合并为一条');
  ok(merged[0].count === 3, 'count 累加为 3');
  ok(merged[0].at === t(0), 'at 保留最早');
  ok(merged[0].payload.n === 3, 'payload 取最新');
  ok(merged[0].seq === 3, 'seq 取最新');
  ok(JSON.stringify(merged[0].payload.mergedSeqs) === '[1,2,3]', 'mergedSeqs 回填全部源 seq');
}
{
  const merged = stewardMergeInboxEvents([ev('s1', 'failed', 1, 0), ev('s1', 'failed', 2, 5001)], 5000);
  ok(merged.length === 2, '超出 5 秒窗口不合并');
}
{
  const merged = stewardMergeInboxEvents([ev('s1', 'failed', 1, 0), ev('s1', 'done', 2, 100)], 5000);
  ok(merged.length === 2, '同 session 不同 kind 不合并');
}
{
  const merged = stewardMergeInboxEvents([ev('s1', 'failed', 1, 0), ev('s2', 'failed', 2, 100)], 5000);
  ok(merged.length === 2, '不同 session 同 kind 不合并');
}
{
  const merged = stewardMergeInboxEvents([ev('s1', 'failed', 1, 0)], 5000);
  ok(merged.length === 1 && merged[0].count === 1 && !('mergedSeqs' in merged[0].payload), '单条不写 mergedSeqs');
}
{
  const merged = stewardMergeInboxEvents([
    { kind: 'heartbeat', sessionId: 's1', seq: 1, at: t(0), payload: {} },
    ev('s1', 'needs_you', 'iv_1', 0),
  ], 5000);
  ok(merged.length === 1 && merged[0].kind === 'needs_you', '五类白名单以外的 kind 进不了合并输出');
}
{
  const merged = stewardMergeInboxEvents([ev('s1', 'failed', 2, 3000), ev('s1', 'failed', 1, 0)], 5000);
  ok(merged[0].at === t(0) && merged[0].seq === 2, '乱序输入按 at 排序后再合并');
}
ok(stewardMergeInboxEvents(null, 5000).length === 0, '非数组入参 -> 空数组');

/* ═══════════════ ⑥ 去重键 ═══════════════ */

{
  const a = stewardEventDedupeKey({ sessionId: 's1', kind: 'failed', runId: '', seq: 3 });
  const b = stewardEventDedupeKey({ sessionId: 's1', kind: 'failed', runId: '', seq: 3 });
  const c = stewardEventDedupeKey({ sessionId: 's1', kind: 'failed', runId: 'run_1', seq: 3 });
  const d = stewardEventDedupeKey({ sessionId: 's1', kind: 'done', runId: '', seq: 3 });
  const e = stewardEventDedupeKey({ sessionId: 's2', kind: 'failed', runId: '', seq: 3 });
  ok(a === b, '同 sessionId+kind+runId+seq -> 同键');
  ok(new Set([a, c, d, e]).size === 4, 'runId/kind/sessionId 任一不同 -> 不同键');
}
{
  const key = stewardEventDedupeKey({ sessionId: 's1', kind: 'needs_you', runId: '', seq: 'iv_9' });
  ok(key === stewardEventDedupeKey({ sessionId: 's1', kind: 'needs_you', runId: '', seq: 'iv_9' }), 'needs_you 用 interventionId 作 seq 位仍稳定');
}
{
  const merged = stewardMergeInboxEvents([ev('s1', 'failed', 1, 0), ev('s1', 'failed', 2, 100), ev('s1', 'failed', 3, 200)], 5000)[0];
  const row = { inboxSeq: 1, ...merged };
  const keys = stewardInboxRowDedupeKeys(row);
  ok(keys.length === 3, '合并行能还原 3 个源去重键(重启后不重复入箱)');
  ok(keys.includes(stewardEventDedupeKey({ sessionId: 's1', kind: 'failed', runId: '', seq: 1 })), '还原的键含被并掉的第一条');
  ok(stewardInboxRowDedupeKeys(null).length === 0, '坏行 -> 零键');
}

// ── 125-P0/P1:两个新判据的真值表 ──────────────────────────────────────────────────────────
// P0「被停下来的目标」:只读既有落盘事实(班组 status / 会话头那条账),且账要盖得住当前回合。
{
  const t = srv.stewardStoppedTarget;
  ok(t(null, { status: 'stopped' }) === 'run', 'P0 班组终态 stopped -> run');
  ok(t(null, { status: 'failed' }) === '', 'P0 班组是自己挂的(failed)-> 不算被停');
  ok(t({ turnSeq: 3, stewardLastTurn: { seq: 3, aborted: true } }, null) === 'thread', 'P0 末回合被停且账盖得住 -> thread');
  ok(t({ turnSeq: 3, stewardLastTurn: { seq: 3, ok: false, aborted: false } }, null) === '',
    'P0 末回合是自己挂的(ok:false 但没 aborted)-> 不算被停,照旧可自理重试');
  ok(t({ turnSeq: 5, stewardLastTurn: { seq: 2, aborted: true } }, null) === '',
    'P0 账过期(seq 2 < turnSeq 5)-> 不算数;否则被停过一次的线程会被永久挡住');
  ok(t({ turnSeq: 0, stewardLastTurn: { seq: 0, aborted: true } }, null) === 'thread', 'P0 零回合边界:账与回合都为 0 仍算盖得住');
  ok(t(null, null) === '' && t({}, {}) === '' && t(undefined, undefined) === '', 'P0 没有事实就不拦(空入参一律 \'\')');
  ok(t({ turnSeq: 1, stewardLastTurn: { seq: 1, aborted: true } }, { status: 'failed' }) === 'thread',
    'P0 两面各说各话时:班组没被停、线程被停 -> 仍然算被停(任一面成立即拦)');
}
// P1「失败说得出原因」:取话口只有一处,查的是 06 那张既有 ERROR_CLASSES;查不到如实说未知。
{
  const e = srv.stewardFailureExplain;
  ok(e('idle_timeout') === srv.ERROR_CLASSES.idle_timeout.zh + ' · 下一步:' + srv.ERROR_CLASSES.idle_timeout.next,
    'P1 表里有的类:人话 + 下一步,逐字来自 ERROR_CLASSES(不是第二份文案)');
  ok(e('') === '' && e(null) === '' && e(undefined) === '', 'P1 没带类别 -> 空串(调用方据此整段不出现)');
  ok(e('totally_made_up') === '未知类别(totally_made_up)',
    'P1 表里没有的类:如实说未知并带上原词 —— 不许编一个听起来像那么回事的原因');
  for (const cls of ['timeout', 'network', 'subagent_failed']) {
    ok(/下一步:/.test(e(cls)), `P1 ${cls}(classifyNodeErrorText 的默认出口,最常见的那几类)已在表里`);
  }
  ok(Object.keys(srv.ERROR_CLASSES).length >= 32, `P1 表补全后不少于 32 条(实得 ${Object.keys(srv.ERROR_CLASSES).length})`);
}

console.log(fail === 0 ? 'STEWARD INBOX CORE UNIT: ALL PASS' : `STEWARD INBOX CORE UNIT: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
