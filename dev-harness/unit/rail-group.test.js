// Unit：左栏「这一件落在哪一组」（steward-board.js 的 railGroupFor，纯函数、零 DOM）。
//
// 走查 #4 收尾：今天停下、没做完的那些（失败／断开／被叫停，聚合态 stopped）以前和做完的一起落在
// 「今天收工」—— 组名说的是「做完了」，用户看一眼就放心走了。现在单列「今天没做完」，排在收工之前；
// 更早停下的仍归「更早」（那时效已过，不必再顶在上面）。
'use strict';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { describe, it } = require('node:test');

const MODULE_PATH = path.resolve(__dirname, '../../ruyi-workbench/app/public/js/steward-board.js');
let modulePromise = null;
const loadModule = () => (modulePromise ||= import(pathToFileURL(MODULE_PATH).href));

const now = new Date(2026, 8, 26, 15, 0, 0);
const today = new Date(2026, 8, 26, 9, 30, 0).toISOString();
const lastWeek = new Date(2026, 8, 19, 9, 30, 0).toISOString();

describe('railGroupFor —— 今天停下的不再算「今天收工」', () => {
  it('今天、且有线程最后一回合失败／中断 → 今天没做完；今天 done / quick_ask / 闲置 stopped → 今天收工', async () => {
    const { railGroupFor } = await loadModule();
    assert.equal(railGroupFor('stopped', today, now, true), 'unfinished');
    // 聚合态 stopped 还包着聊完了的普通聊天（quick_ask 按聚合规则落到 stopped）与闲置线程 —— 不是没做完
    // （Windows CI 的 one-workbench-frame G3 抓到：修前「今天跑完的 C」被分进了「今天没做完」）。
    assert.equal(railGroupFor('stopped', today, now, false), 'doneToday');
    assert.equal(railGroupFor('stopped', today, now), 'doneToday');
    assert.equal(railGroupFor('done', today, now), 'doneToday');
    assert.equal(railGroupFor('quick_ask', today, now), 'doneToday');
  });
  it('更早停下的与更早做完的一样归「更早」', async () => {
    const { railGroupFor } = await loadModule();
    assert.equal(railGroupFor('stopped', lastWeek, now, true), 'earlier');
    assert.equal(railGroupFor('done', lastWeek, now), 'earlier');
  });
  it('在动的三态不看时间', async () => {
    const { railGroupFor } = await loadModule();
    assert.equal(railGroupFor('needs_you', lastWeek, now), 'needs_you');
    assert.equal(railGroupFor('running', lastWeek, now), 'running');
    assert.equal(railGroupFor('dispatching', lastWeek, now), 'queued');
  });
  it('走查 U2：一件里全是用户新开、还没开口的空线程 → 「新开的」，不进「排队」', async () => {
    const { railGroupFor } = await loadModule();
    assert.equal(railGroupFor('dispatching', today, now, false, true), 'fresh');
    assert.equal(railGroupFor('dispatching', today, now, false, false), 'queued');
    assert.equal(railGroupFor('running', today, now, false, true), 'running');
  });
  it('threadIsBlank 只认卡片硬事实：出身 user、无账本、没跑过、没在跑、没被仲裁器扣着', async () => {
    const { threadIsBlank } = await import(pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/thread-facts.js')).href);
    const blank = { origin: 'user', status: 'none', turnSeq: 0, runCount: 0, activeTurn: false, lastTurn: null, wait: null };
    assert.equal(threadIsBlank(blank), true);
    assert.equal(threadIsBlank({ ...blank, wait: { reason: 'user' } }), true);
    assert.equal(threadIsBlank({ ...blank, origin: 'steward' }), false, '管家交办的线程照旧是「交办中／排队」');
    assert.equal(threadIsBlank({ ...blank, status: 'active' }), false, '有账本 = 立了单');
    assert.equal(threadIsBlank({ ...blank, turnSeq: 1 }), false);
    assert.equal(threadIsBlank({ ...blank, activeTurn: true }), false);
    assert.equal(threadIsBlank({ ...blank, wait: { reason: 'slot' } }), false, '仲裁器扣着 = 真在排队');
    assert.equal(threadIsBlank(null), false);
  });
  it('threadLastTurnFailed 只认卡片上的最后一回合事实', async () => {
    const { threadLastTurnFailed } = await import(pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/thread-facts.js')).href);
    assert.equal(threadLastTurnFailed({ lastTurn: { ok: false } }), true);
    assert.equal(threadLastTurnFailed({ lastTurn: { ok: true, aborted: true } }), true);
    assert.equal(threadLastTurnFailed({ lastTurn: { ok: true } }), false);
    assert.equal(threadLastTurnFailed({}), false);
    assert.equal(threadLastTurnFailed(null), false);
  });
  it('组的顺序：没做完排在收工之前，每组都有文案', async () => {
    const { RAIL_GROUP_KEYS } = await loadModule();
    assert.deepEqual([...RAIL_GROUP_KEYS], ['needs_you', 'running', 'queued', 'fresh', 'unfinished', 'doneToday', 'earlier']);
    const zh = require('../../ruyi-workbench/app/public/locales/zh-CN.json');
    const en = require('../../ruyi-workbench/app/public/locales/en-US.json');
    assert.equal(zh['rail.group.unfinished'], '今天没做完');
    assert.ok(en['rail.group.unfinished'] && !/session|chat/i.test(en['rail.group.unfinished']));
    for (const key of RAIL_GROUP_KEYS) assert.ok(key === 'needs_you' || zh[`rail.group.${key}`], `rail.group.${key} 缺中文`);
    assert.ok(zh['rail.group.fresh'] && en['rail.group.fresh'] && zh['mission.state.blank'] && en['mission.state.blank']);
  });
});
