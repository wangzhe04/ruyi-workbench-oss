'use strict';
// Unit(150 号文 U2／U11):左栏线程搜索 —— 超时不清空已有结果、连续超时退避后停在「继续搜索」、说明按状态互斥只说一件事。
//
//   [P] 纯函数真值表(public/js/session-search-state.js,直接 import):并状态、续搜判据、说明的互斥选择;
//   [S] 真代码的状态机:把 session-experience.js 里【真的】 scheduleSessionSearch / renderSessions 切出来放进 vm,
//       api 与计时器换成桩(脚本化回包 + 手动推进的假时钟),逐步断言 —— 第一发有结果、之后连发超时空回包:
//       结果不被清空;等待 0.5 → 1 → 2 → 4 s;第 5 次超时停下、按钮露出;说明只有一句且不再自相矛盾;
//       按「继续搜索」续搜期间结果仍在;5xx 不清空并给人话;换查询词整份重置。
//   [L] 中英两份 locale 都有新键;英文说明不超过两行(按左栏 268 px、约 44 个字符一行估)。
//
// 反向验证:RUYI_TEST_SESSION_EXPERIENCE_JS 指到修前的 session-experience.js(git show 0aa09851:…),[S] 必须红。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { functionBlock, constBlock } = require('../lib/source-slice');

const publicRoot = path.resolve(__dirname, '../../ruyi-workbench/app/public');
const statePath = path.join(publicRoot, 'js/session-search-state.js');
const experiencePath = process.env.RUYI_TEST_SESSION_EXPERIENCE_JS
  ? path.resolve(process.env.RUYI_TEST_SESSION_EXPERIENCE_JS) : path.join(publicRoot, 'js/session-experience.js');
const locales = Object.fromEntries(['zh-CN', 'en-US'].map(name => [name, JSON.parse(fs.readFileSync(path.join(publicRoot, 'locales', name + '.json'), 'utf8'))]));
const loadState = () => import(pathToFileURL(statePath).href);

const hits = ids => ids.map(id => ({ id, title: 'T ' + id, snippet: 's ' + id }));
const pendingCoverage = (indexed, total = 100) => ({ phase: 'idle', complete: false, sessions: total, indexedSessions: indexed, pendingSessions: total - indexed });
const timeoutResponse = (prepared = 1) => ({ ok: true, query: 'ab', results: [], indexed: null, partial: true, reason: 'deadline',
  coverage: { phase: 'timeout', sessions: null, indexedSessions: null, pendingSessions: null, complete: false, preparedThisRequest: prepared },
  semantic: { status: 'timeout', coverage: 'partial' } });

test('[P] 并状态:超时空回包保留上一次的结果与覆盖率;换查询词重置;5xx 保留并记错误类别', async () => {
  const S = await loadState();
  const first = S.nextSessionSearchState(null, { ok: true, results: hits(['A', 'B']), coverage: pendingCoverage(10) }, 'ab');
  assert.deepEqual(first.results.map(r => r.id), ['A', 'B']);
  assert.equal(first.timeouts, 0);
  const t1 = S.nextSessionSearchState(first, timeoutResponse(), 'ab');
  assert.deepEqual(t1.results.map(r => r.id), ['A', 'B'], '超时空回包不清空');
  assert.equal(t1.coverage.indexedSessions, 10, '上一次覆盖率留着');
  assert.equal(t1.timedOut, true);
  assert.equal(t1.timeouts, 1);
  assert.equal(S.nextSessionSearchState(t1, timeoutResponse(), 'ab').timeouts, 2, '连续超时累计');
  const fresh = S.nextSessionSearchState(t1, timeoutResponse(), 'cd');
  assert.deepEqual(fresh.results, [], '换查询词不借旧结果');
  assert.equal(fresh.timeouts, 1);
  const withNew = S.nextSessionSearchState(t1, { ...timeoutResponse(), results: hits(['C']) }, 'ab');
  assert.deepEqual(withNew.results.map(r => r.id), ['C'], '超时但带结果:用新结果');
  const ok = S.nextSessionSearchState(t1, { ok: true, results: hits(['A']), coverage: pendingCoverage(20) }, 'ab');
  assert.equal(ok.timeouts, 0, '一发正常回包计数归零');
  assert.equal(S.sessionSearchTimedOut({ semantic: { status: 'timeout' } }), false, '只语义超时不算源级超时(1C 审查)');
  assert.equal(S.sessionSearchTimedOut({ reason: 'deadline' }), true, '源级截止算');
  assert.equal(S.sessionSearchTimedOut({ coverage: { phase: 'idle' } }), false);
  const failed = S.failedSessionSearchState(first, 'ab', Object.assign(Error('boom'), { status: 500 }));
  assert.deepEqual(failed.results.map(r => r.id), ['A', 'B'], '5xx 不清空');
  assert.equal(failed.error, 'server');
  assert.equal(failed.canResume, true);
  const failedEmpty = S.failedSessionSearchState(null, 'ab', Error('offline'));
  assert.equal(failedEmpty.results, null, '没有旧结果 → 回退标题过滤');
  assert.equal(failedEmpty.error, 'network');
});

test('[P] 续搜:超时退避 0.5/1/2/4 s,第 5 次停下并要求露出「继续搜索」;零进展超时直接停', async () => {
  const S = await loadState();
  const delays = [];
  for (let n = 1; n <= 4; n++) {
    const step = S.sessionSearchFollowUp({ response: timeoutResponse(1), previous: null, refreshAttempt: n, timeouts: n });
    assert.equal(step.next, true, `第 ${n} 次超时仍续搜`);
    delays.push(step.delayMs);
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000]);
  assert.deepEqual(S.sessionSearchFollowUp({ response: timeoutResponse(1), refreshAttempt: 5, timeouts: 5 }), { next: false, resume: true });
  assert.deepEqual(S.sessionSearchFollowUp({ response: timeoutResponse(0), refreshAttempt: 1, timeouts: 1 }), { next: false, resume: true }, '零进展超时不轮询');
  const normal = S.sessionSearchFollowUp({ response: { ok: true, results: [], coverage: pendingCoverage(20) }, previous: { coverage: pendingCoverage(10) }, refreshAttempt: 2, timeouts: 0 });
  assert.deepEqual(normal, { next: true, delayMs: 500 }, '非超时续搜节奏不变');
  assert.equal(S.sessionSearchFollowUp({ response: { ok: true, results: [], coverage: pendingCoverage(20) }, previous: { coverage: pendingCoverage(10) }, refreshAttempt: 127 }).next, false, '上限 127 不变');
  assert.deepEqual(S.sessionSearchFollowUp({ response: { ok: true, results: [], coverage: pendingCoverage(20) }, previous: { coverage: pendingCoverage(20) } }), { next: false, resume: true }, '无进展的部分覆盖停下可继续');
});

// 1C 审查:只有语义编码超时、关键词检索已完整时,这一发是权威结果 —— 不保留旧结果、不说「超时已暂停」。
test('[P] 只语义超时:覆盖完成的结果照收(含完整零命中),说明走语义回退而非「已暂停」', async () => {
  const S = await loadState();
  const complete = { phase: 'complete', complete: true, sessions: 100, indexedSessions: 100, pendingSessions: 0 };
  const prior = S.nextSessionSearchState(null, { ok: true, results: hits(['OLD']), coverage: pendingCoverage(10) }, 'ab');
  const semOnly = { ok: true, results: hits(['A']), coverage: complete, semantic: { status: 'timeout', coverage: 'partial' } };
  const a = S.nextSessionSearchState(prior, semOnly, 'ab');
  assert.equal(a.timedOut, false, '只语义超时不算整次超时');
  assert.deepEqual(a.results.map(r => r.id), ['A']);
  assert.ok(!S.sessionSearchNotices(a).some(item => item.key === 'session.searchTimeoutPaused'), '覆盖完成时不说「超时已暂停」');
  const zero = S.nextSessionSearchState(prior, { ...semOnly, results: [] }, 'ab');
  assert.deepEqual(zero.results, [], '完整零命中不被旧结果顶替');
  assert.equal(zero.coverage, complete, '采用本次权威覆盖率');
  assert.ok(!zero.kept);
});

test('[P] 说明:按状态互斥,只出一条主说明', async () => {
  const S = await loadState();
  const keys = state => S.sessionSearchNotices(state).map(item => item.key);
  assert.deepEqual(keys({ loading: true, results: hits(['A']), timedOut: true, coverage: pendingCoverage(10) }), ['session.searchPreparingCoverage'], '准备中(哪怕上一发超时),量得到进度就并进同一句');
  assert.deepEqual(S.sessionSearchNotices({ loading: true, results: hits(['A']), coverage: pendingCoverage(10) })[0].params, { indexed: 10, total: 100 });
  assert.deepEqual(keys({ loading: true, results: null }), ['session.searchPreparing'], '准备中、进度还量不到');
  assert.deepEqual(keys({ continuing: true, results: hits(['A']), coverage: pendingCoverage(16), semantic: { status: 'empty', coverage: 'partial' } }), ['session.searchPreparingCoverage'], '两发之间等下一发也是准备中(不跳到语义那一句)');
  assert.deepEqual(keys({ lexicalPreview: true, results: [] }), ['session.searchPreviewEmpty']);
  assert.deepEqual(keys({ results: hits(['A']), timedOut: true, canResume: true, coverage: pendingCoverage(10), semantic: { status: 'timeout' } }), ['session.searchTimeoutPaused'], '超时已暂停(带上次覆盖率)');
  assert.deepEqual(S.sessionSearchNotices({ results: hits(['A']), timedOut: true, canResume: true, coverage: pendingCoverage(10) })[0].params, { indexed: 10, total: 100 });
  assert.deepEqual(keys(timeoutResponse()), ['session.searchProgressUnavailable'], '超时且量不到进度');
  assert.deepEqual(keys({ results: [], canResume: true, coverage: pendingCoverage(30) }), ['session.searchPartialResumable'], '部分覆盖可继续');
  assert.deepEqual(keys({ results: [], coverage: { ...pendingCoverage(30), phase: 'paused' } }), ['session.searchIndexPaused']);
  assert.deepEqual(keys({ results: [], coverage: { phase: 'complete', complete: true, sessions: 5, indexedSessions: 5, attachments: { unverifiedFullText: 2 } } }),
    ['session.searchCoverage', 'session.searchUnverifiedAttachments'], '完成(附件待验证只在完成档附上)');
  assert.deepEqual(keys({ results: [], error: 'server' }), ['session.searchFailedEmpty']);
  assert.deepEqual(keys({ results: hits(['A']), error: 'server' }), ['session.searchFailed']);
  assert.deepEqual(keys({ results: hits(['A']), error: 'server', coverage: pendingCoverage(32, 207) }), ['session.searchFailedCoverage'], '出错时带上保留下来的覆盖率');
  assert.deepEqual(keys({ results: [], semantic: { status: 'loading' }, coverage: { phase: 'complete', complete: true, sessions: 5, indexedSessions: 5 } }), ['session.semanticLoading']);
  assert.deepEqual(keys({}), []);
});

test('[L] 新键中英齐全;英文说明不超过两行', async () => {
  const S = await loadState();
  const used = new Set();
  const samples = [{ loading: true }, { loading: true, coverage: pendingCoverage(9999, 99999) }, { lexicalPreview: true, results: [] }, timeoutResponse(), { timedOut: true, coverage: pendingCoverage(9999, 9999) },
    { canResume: true, coverage: pendingCoverage(9999, 99999) }, { coverage: { ...pendingCoverage(9999, 99999), phase: 'paused' } }, { error: 'server' }, { error: 'server', results: hits(['A']) }, { error: 'server', results: hits(['A']), coverage: pendingCoverage(9999, 99999) },
    { coverage: { phase: 'complete', complete: true, sessions: 99999, indexedSessions: 99999 } }];
  for (const sample of samples) for (const item of S.sessionSearchNotices(sample)) {
    used.add(item.key);
    for (const [name, strings] of Object.entries(locales)) assert.equal(typeof strings[item.key], 'string', `${name} 有 ${item.key}`);
    const text = locales['en-US'][item.key].replace(/\{\{(\w+)\}\}/g, (_, key) => String((item.params || {})[key]));
    assert.ok(text.length <= 88, `英文「${item.key}」≤ 两行(约 44 字符一行):实 ${text.length} 字`);
  }
  assert.ok(used.size >= 8);
});

// ── [S] 真代码状态机 ─────────────────────────────────────────────────────────────
async function harness() {
  const S = await loadState();
  const src = fs.readFileSync(experiencePath, 'utf8');
  const parts = ['sessionSearchQuery', 'cancelSessionSearch', 'scheduleSessionSearch', 'renderSessions'].map(name => functionBlock(src, name));
  const consts = ['SESSION_SEARCH_MIN_QUERY', 'SESSION_SEARCH_DEBOUNCE_MS'].map(name => constBlock(src, name));
  assert.ok(parts.every(Boolean) && consts.every(Boolean), '切到了 session-experience.js 的四个函数与两个常量');
  const nodes = { sessionSearch: { value: 'ab' }, sessionSearchCoverage: { textContent: '', hidden: true }, sessionSearchContinue: { hidden: true, onclick: null } };
  const timers = [];
  let clock = 0, timerSeq = 0;
  const script = [];
  const calls = [];
  const strings = locales['zh-CN'];
  const ctx = {
    ...S,
    $: id => nodes[id] || null,
    t: (key, params = {}) => String(strings[key] || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name])),
    api: async url => { calls.push({ url, at: clock }); const next = script.shift(); if (!next) throw Object.assign(Error('script exhausted'), { status: 599 }); if (next.throw) throw next.throw; return next; },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.push({ id, at: clock + ms, ms, fn }); return id; },
    clearTimeout: id => { const at = timers.findIndex(timer => timer.id === id); if (at >= 0) timers.splice(at, 1); },
    AbortController, encodeURIComponent, Number, Array, Object, JSON, Promise, String, Math, Set, Map, Error,
    railRenderer: null, syncOwnTurnLiveIndicator: () => {},
    sessionSearchState: { query: '', results: null, loading: false, failed: false },
    sessionSearchTimer: 0, sessionSearchSeq: 0, sessionSearchAbort: null,
  };
  vm.createContext(ctx);
  vm.runInContext(consts.join('\n').replace(/^const /gm, 'var ') + '\n' + parts.join('\n'), ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  // 推进到下一个计时器并跑完它引出的异步链;返回那个计时器的等待毫秒数。
  async function tick() {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const timer = timers.shift();
    if (!timer) return null;
    clock = timer.at;
    timer.fn();
    await flush();
    return timer.ms;
  }
  return { ctx, nodes, timers, script, calls, tick, flush, state: () => ctx.sessionSearchState };
}
const ids = state => (state.results || []).map(row => row.id);

test('[S] 真状态机:超时不清空、退避后停在「继续搜索」、说明单一;续搜与 5xx 不清空;换词重置', async () => {
  const h = await harness();
  h.script.push({ ok: true, query: 'ab', results: hits(['A', 'B']), coverage: pendingCoverage(10) });
  for (let n = 0; n < 5; n++) h.script.push(timeoutResponse(1));
  h.ctx.scheduleSessionSearch();
  assert.equal(await h.tick(), 200, '去抖 200 ms');
  assert.deepEqual(ids(h.state()), ['A', 'B'], '第一发结果到手');
  const waits = [];
  for (let n = 0; n < 12 && h.timers.length; n++) {
    const ms = await h.tick();
    if (ms !== 200) waits.push(ms);
    assert.deepEqual(ids(h.state()), ['A', 'B'], `第 ${n + 1} 次推进后结果仍在(超时空回包不覆盖)`);
  }
  assert.deepEqual(waits, [500, 500, 1000, 2000, 4000], '续搜间隔:常规 0.5 s,之后连续超时退避 0.5 → 1 → 2 → 4 s');
  assert.equal(h.calls.length, 6, '第 5 次超时后不再发请求(修前每 0.5 s 一发,最多 127 次)');
  assert.equal(h.timers.length, 0, '停下:没有在等的续搜');
  assert.equal(h.state().canResume, true);
  assert.equal(h.nodes.sessionSearchContinue.hidden, false, '「继续搜索」露出来');
  const notice = h.nodes.sessionSearchCoverage.textContent;
  assert.equal(notice, h.ctx.t('session.searchTimeoutPaused', { indexed: 10, total: 100 }), '说明只有一句「超时已暂停」,带上次覆盖率');
  assert.ok(!notice.includes(h.ctx.t('session.searchPreparing')), '不再与「先显示关键词结果」并存');

  // 按「继续搜索」:续搜期间结果仍在、按钮收起;这一发 5xx 也不清空,并给人话。
  h.script.push({ throw: Object.assign(Error('internal'), { status: 500 }) });
  h.nodes.sessionSearchContinue.onclick();
  assert.deepEqual(ids(h.state()), ['A', 'B'], '按下「继续搜索」那一刻结果仍在');
  assert.equal(h.nodes.sessionSearchContinue.hidden, true, '续搜在飞时按钮收起');
  await h.tick();
  assert.equal(h.calls.length, 7);
  assert.ok(!/preview=1/.test(h.calls[6].url), '继续搜索走非预览');
  assert.deepEqual(ids(h.state()), ['A', 'B'], '5xx 不清空已有结果');
  assert.equal(h.nodes.sessionSearchCoverage.textContent, h.ctx.t('session.searchFailedCoverage', { indexed: 10, total: 100 }), '5xx 给可理解的说明(带保留下来的覆盖率)');
  assert.equal(h.nodes.sessionSearchContinue.hidden, false, '5xx 之后可以重试');

  // 换查询词:整份重置(不借旧结果、不带旧计数)。
  h.nodes.sessionSearch.value = 'cd';
  h.script.push(timeoutResponse(0));
  h.ctx.scheduleSessionSearch();
  assert.equal(h.state().results, null, '新词起步没有旧结果');
  await h.tick();
  assert.deepEqual(ids(h.state()), [], '新词的超时空回包就是空');
  assert.equal(h.state().timeouts, 1, '新词的超时计数从 1 起');
  assert.equal(h.nodes.sessionSearchCoverage.textContent, h.ctx.t('session.searchProgressUnavailable'));
  assert.equal(h.nodes.sessionSearchContinue.hidden, false);
});
