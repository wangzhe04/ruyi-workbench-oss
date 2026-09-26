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
  it('今天 stopped → 今天没做完；今天 done / quick_ask → 今天收工', async () => {
    const { railGroupFor } = await loadModule();
    assert.equal(railGroupFor('stopped', today, now), 'unfinished');
    assert.equal(railGroupFor('done', today, now), 'doneToday');
    assert.equal(railGroupFor('quick_ask', today, now), 'doneToday');
  });
  it('更早停下的与更早做完的一样归「更早」', async () => {
    const { railGroupFor } = await loadModule();
    assert.equal(railGroupFor('stopped', lastWeek, now), 'earlier');
    assert.equal(railGroupFor('done', lastWeek, now), 'earlier');
  });
  it('在动的三态不看时间', async () => {
    const { railGroupFor } = await loadModule();
    assert.equal(railGroupFor('needs_you', lastWeek, now), 'needs_you');
    assert.equal(railGroupFor('running', lastWeek, now), 'running');
    assert.equal(railGroupFor('dispatching', lastWeek, now), 'queued');
  });
  it('组的顺序：没做完排在收工之前，每组都有文案', async () => {
    const { RAIL_GROUP_KEYS } = await loadModule();
    assert.deepEqual([...RAIL_GROUP_KEYS], ['needs_you', 'running', 'queued', 'unfinished', 'doneToday', 'earlier']);
    const zh = require('../../ruyi-workbench/app/public/locales/zh-CN.json');
    const en = require('../../ruyi-workbench/app/public/locales/en-US.json');
    assert.equal(zh['rail.group.unfinished'], '今天没做完');
    assert.ok(en['rail.group.unfinished'] && !/session|chat/i.test(en['rail.group.unfinished']));
  });
});
