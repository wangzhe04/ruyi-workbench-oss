'use strict';
// v2.6.2 压缩标记合并/零收益门槛/重入滞回/token 读数尾零 —— 全部离线单测(不依赖模型)。
// 背景真机数据:sess_fe3de15dfc3b8354 在 337 行里堆了 251 条 🗜 标记(163 条连着重复);
// sess_3739c44a43ccb2cb 连续 26 条夹着 0 条对话,后半段全是「蒸发 1 条:106K→约106K」的空转。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-compact-marker-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const { readServerSource } = require('../src-reader');
const source = readServerSource();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const { fmtTokensServer: f, upsertCompactMarker, openCompactMarker, COMPACT_MARKER_MIN_SAVED_TOKENS } = srv;

test('token 读数只剥小数尾零,整百整千整数不得错报 10 倍', () => {
  assert.equal(f(110000), '110K');   // 旧实现输出 11K
  assert.equal(f(100000), '100K');   // 旧实现输出 1K
  assert.equal(f(120000), '120K');
  assert.equal(f(105000), '105K');
  assert.equal(f(99950), '100K');    // 取整后整百同样不可剥
  assert.equal(f(1100000), '1.1M');
  assert.equal(f(10e6), '10M');      // 旧实现输出 1M
  // 小数截尾语义保持
  assert.equal(f(82500), '82.5K');
  assert.equal(f(82000), '82K');
  assert.equal(f(995), '995');
});

function msg(i, role, extra = {}) { return { id: `m${i}`, role, ...extra }; }

test('同一压缩集原位合并:行数不增,起点保留,计数累计', () => {
  const session = { messages: [msg(0, 'user', { content: '跑任务' })] };
  const m1 = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 70, saved: 28000, beforeTokens: 105000, afterTokens: 76800 });
  assert.equal(session.messages.length, 2);
  assert.ok(m1.compactMeta.passes === 1);
  const m2 = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 16, saved: 4000, beforeTokens: 108000, afterTokens: 92000 });
  const m3 = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 15, saved: 5000, beforeTokens: 106000, afterTokens: 91600 });
  assert.equal(m1, m2); assert.equal(m2, m3);
  assert.equal(session.messages.length, 2, '三次触发仍只有一行标记');
  assert.deepEqual(m3.compactMeta, { passes: 3, evaporated: 101, reseeded: false, beforeTokens: 105000, afterTokens: 91600 });
  assert.match(m3.content, /🗜 自动压缩 ×3/);
  assert.match(m3.content, /蒸发旧工具结果 101 条＋摘要重播种|蒸发旧工具结果 101 条/);
  assert.match(m3.content, /105K→约 91\.6K（估算）/);
});

test('对话行闭环压缩集:user/assistant 之后才允许开新行', () => {
  const session = { messages: [msg(0, 'user', { content: 'x' })] };
  const m1 = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 30, saved: 25000, beforeTokens: 90000, afterTokens: 60000 });
  session.messages.push(msg(2, 'assistant', { content: '回答' }));
  session.messages.push(msg(3, 'user', { content: '继续' }));
  const m2 = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 5, saved: 9000, beforeTokens: 95000, afterTokens: 70000 });
  assert.notEqual(m1, m2);
  assert.equal(session.messages.filter(m => m.source === 'compact').length, 2);
  assert.equal(m1.compactMeta.passes, 1);
  assert.equal(m2.compactMeta.beforeTokens, 95000, '新集以自身起点为准');
});

test('stderr 等噪声行不打断连续性;kind 隔离 auto 与 kimi', () => {
  const session = { messages: [] };
  const m1 = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 3, saved: 3000, beforeTokens: 80000, afterTokens: 70000 });
  session.messages.push({ role: 'system', content: '{"level":"warn"}', source: 'stderr' });
  const m2 = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 1, saved: 1500, beforeTokens: 70000, afterTokens: 68000 });
  assert.equal(m1, m2, '噪声行透明,可并入');
  const k1 = upsertCompactMarker(session, { kind: 'kimi', label: 'Kimi 自动压缩', approx: false, accuracy: '原生会话实测', beforeTokens: 66000, afterTokens: 31000 });
  assert.notEqual(k1, m2, '不同 kind 各开各行');
  assert.match(k1.content, /66K→31K（原生会话实测）/);
  assert.doesNotMatch(k1.content, /约/);
});

test('零收益 pass 不造新行,但可并入已有行审计', () => {
  const session = { messages: [] };
  const r = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 1, saved: 300, beforeTokens: 106000, afterTokens: 105700 });
  assert.equal(r, null, '「蒸发 1 条:106K→106K」不再出现在消息流');
  assert.equal(session.messages.length, 0);
  upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 40, saved: 20000, beforeTokens: 106000, afterTokens: 80000 });
  const linesBefore = session.messages.length;
  const merged = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 1, saved: COMPACT_MARKER_MIN_SAVED_TOKENS - 1, beforeTokens: 80000, afterTokens: 80001 });
  assert.ok(merged, '已有开放行时低收益 pass 并入计数');
  assert.equal(linesBefore, session.messages.length);
  assert.equal(merged.compactMeta.evaporated, 41);
});

test('摘要重播种豁免门槛并可与其余操作并为一行;旧格式标记永不误改', () => {
  const session = { messages: [{ role: 'system', content: '🗜 自动压缩（蒸发旧工具结果 5 条）：90K→约 70K（估算）', createdAt: 'legacy', source: 'compact' }] };
  const legacyTail = session.messages[0];
  const created = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', reseeded: true, beforeTokens: 70000, afterTokens: 31000 });
  assert.notEqual(created, legacyTail, '无 compactMeta 的历史行不可并入(数字重建不了)');
  assert.equal(legacyTail.content, '🗜 自动压缩（蒸发旧工具结果 5 条）：90K→约 70K（估算）', '旧行原样保留');
  assert.match(created.content, /自动压缩（摘要重播种）：70K→约 31K（估算）/);
  const again = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', reseeded: true, beforeTokens: 60000, afterTokens: 30000 });
  assert.equal(created, again, 'reseeded 重复触发同样并入一行');
  assert.match(again.content, /×2/);
});

test('openCompactMarker 只认尾部未闭环行', () => {
  const session = { messages: [] };
  const mk = upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated: 9, saved: 3000, beforeTokens: 90000, afterTokens: 80000 });
  assert.equal(openCompactMarker(session, 'auto'), mk);
  session.messages.push(msg(9, 'user'));
  assert.equal(openCompactMarker(session, 'auto'), null);
});

// ── 滞回水位:贴线抖动时的每迭代空转必须被水位挡住 ────────────────────────────────
function extract(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `extract ${name}`);
  return match[0];
}
function autoCompactHarness(estimates) {
  const events = [], saves = [], snapshots = [];
  const ctx = {
    providerConversationContextWindow: () => 131072,
    CompactionPlan: {
      create: ({ config }) => ({ window: 131072, budget: (Number(config && config.autoCompactThreshold) || 0.8) * 131072 }),
      reseed: () => [],
    },
    calibratedEstimate: () => estimates.shift() ?? estimates.at(-1),
    writeHistorySnapshot: async (...a) => { snapshots.push(a); return 'raw'; },
    evaporateHistory: history => {
      let n = 0;
      // 蒸发后的占位保持"长内容",模拟真实追加节奏 —— 短占位会让同一会话的后续 pass 无料可蒸。
      for (let i = 0; i < Math.min(3, history.length); i++) if (String(history[i].content || '').length > 10) { history[i].content = '[已蒸发] ' + '长'.repeat(40); n++; }
      return n;
    },
    providerSummaryCall: async () => ({ ok: false, error: 'summary offline' }), // L2 恒败:L1 保持 + 不中断
    resolveCompactionProvider: () => ({ provider: null, model: '', isDefault: true }),
    recordCompactUsage: () => {},
    recentTurnsBoundary: () => 0,
    estimateHistoryTokens: () => 12345,
    saveSession: async s => saves.push(s),
    logEvent: () => {},
    fmtTokensServer: f,
    upsertCompactMarker, openCompactMarker, COMPACT_MARKER_MIN_SAVED_TOKENS,
    nowIso: () => new Date().toISOString(),
  };
  const run = vm.runInNewContext(`${extract('maybeAutoCompact')}\nmaybeAutoCompact`, ctx);
  const provider = { id: 'p', model: 'm' };
  const config = { autoCompactThreshold: 0.8 };
  const turn = (session, sys = 'sys') => run(session, provider, sys, config, e => events.push(e), 'm', []);
  return { turn, events, saves, snapshots };
}
const historyOf = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '长'.repeat(40) }));

test('滞回水位:压完后小幅回升直接跳过,显著越过水位才再武装', async () => {
  const budget = 0.8 * 131072; // 104857.6
  const session = { id: 's', messages: historyOf(6), providerHistory: historyOf(6) };
  const h = autoCompactHarness([budget + 500, budget - 2000]); // 触发蒸发 → 压后低于预算
  assert.equal(await h.turn(session), true);
  assert.equal(session.autoCompactWatermark, budget - 2000);
  assert.equal(h.events.filter(e => e.type === 'compact').length, 1);
  const marks = session.messages.filter(m => m.source === 'compact');
  assert.equal(marks.length, 1);

  // 下一次迭代:估算仅回升到预算上方一点,但仍低于 水位+margin(max(2000, 2%窗口)=2621)
  const h2 = autoCompactHarness([session.autoCompactWatermark + 2620]);
  assert.equal(await h2.turn(session), false, '贴线抖动被水位拦截,零副作用');
  assert.equal(h2.events.length, 0);
  assert.equal(h2.snapshots.length, 0);

  // 明显越过水位 → 再触发
  const h3 = autoCompactHarness([session.autoCompactWatermark + 2621 + 900, session.autoCompactWatermark - 1500]);
  assert.equal(await h3.turn(session), true);
});

test('L2 失败保持 L1 结果并入同一行并落水位;压缩集跨触发合并计数', async () => {
  const budget = 0.8 * 131072;
  const session = { id: 's', messages: historyOf(6), providerHistory: historyOf(6) };
  const h = autoCompactHarness([budget + 400, budget - 2600, budget - 2400]);
  assert.equal(await h.turn(session), true); // L1 成功 → still over budget → L2 failed → keep L1
  assert.equal(session.messages.filter(m => m.source === 'compact').length, 1);
  assert.ok(Number.isFinite(session.autoCompactWatermark));
  const wm = session.autoCompactWatermark;

  const h2 = autoCompactHarness([wm + 5000, wm - 1000]); // 越过水位再次触发
  assert.equal(await h2.turn(session), true);
  assert.equal(session.messages.filter(m => m.source === 'compact').length, 1, '两次触发行数不变');
  assert.equal(session.messages.find(m => m.source === 'compact').compactMeta.passes, 2);
});
