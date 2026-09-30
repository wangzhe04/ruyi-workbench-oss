'use strict';
// N9:planParallelReadIsland(09-workflow.js)—— 混批里哪些只读调用可以提前并发。纯函数,源码切片抽出来直接跑。
// 语义约束(这是「并发但顺序语义不变」的证明点):
//   · 岛 = 排在【第一个阻塞调用之前】的安全只读(其后的读要看见前面编辑的结果,不能提前);
//   · 中性调用(todo_write / tool_search / list_tools / tool_load / 参数坏了会被直接拒绝的)不关门;
//   · 岛不足 2 个 → [](单个只读无并发收益,走原串行路径)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { constBlock, functionBlock } = require('../lib/source-slice');

const src = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/09-workflow.js'), 'utf8');
const plan = new Function(`${constBlock(src, 'PARALLEL_READ_NEUTRAL')}\n${functionBlock(src, 'planParallelReadIsland')}\nreturn planParallelReadIsland;`)();

const READS = new Set(['file_read', 'web_fetch', 'file_search', 'glob']);
const isSafe = tc => Boolean(tc && READS.has(tc.name) && !tc.bad);
const isRefused = tc => Boolean(tc && tc.bad);
const c = (name, id, extra = {}) => ({ name, id, ...extra });
const ids = calls => calls.map(x => x.id).join(',');

test('N9 整批全是安全只读:岛 = 整批(与修前等价)', () => {
  const b = [c('file_read', 'a'), c('web_fetch', 'b'), c('glob', 'c')];
  assert.equal(ids(plan(b, isSafe, isRefused)), 'a,b,c');
});

test('N9 todo_write / tool_search 不再把批拆成串行', () => {
  assert.equal(ids(plan([c('web_fetch', 'a'), c('web_fetch', 'b'), c('web_fetch', 'c'), c('todo_write', 't')], isSafe, isRefused)), 'a,b,c');
  assert.equal(ids(plan([c('todo_write', 't'), c('file_read', 'a'), c('tool_search', 's'), c('file_read', 'b')], isSafe, isRefused)), 'a,b');
});

test('N9 阻塞调用(编辑/执行/桥接/控制面)关门:其后的读不入岛', () => {
  const b = [c('file_read', 'a'), c('file_read', 'b'), c('file_edit', 'e'), c('file_read', 'c')];
  assert.equal(ids(plan(b, isSafe, isRefused)), 'a,b', 'c 必须排在编辑之后读,不能提前并发');
  assert.equal(ids(plan([c('file_read', 'a'), c('request_user_input', 'q'), c('file_read', 'b')], isSafe, isRefused)), '', '交互类是阻塞调用,岛只剩 1 个 → 空');
  assert.equal(ids(plan([c('file_edit', 'e'), c('file_read', 'a'), c('file_read', 'b')], isSafe, isRefused)), '', '第一个就是编辑 → 空岛');
});

test('N9 岛不足 2 个一律返回 [](保持原串行路径)', () => {
  assert.deepEqual(plan([c('file_read', 'a')], isSafe, isRefused), []);
  assert.deepEqual(plan([c('file_read', 'a'), c('file_edit', 'e'), c('file_read', 'b')], isSafe, isRefused), []);
  assert.deepEqual(plan([], isSafe, isRefused), []);
  assert.deepEqual(plan(null, isSafe, isRefused), []);
});

test('N9 参数坏了、串行路径会直接拒绝的调用是中性的(不预执行也不关门)', () => {
  const b = [c('file_read', 'a'), c('file_read', 'bad', { bad: true }), c('file_read', 'b')];
  assert.equal(ids(plan(b, isSafe, isRefused)), 'a,b');
});

test('N9 顺序保持:岛里的调用按原顺序出现', () => {
  const b = [c('glob', '1'), c('todo_write', 't'), c('file_read', '2'), c('web_fetch', '3'), c('file_write', 'w'), c('file_read', '4')];
  assert.equal(ids(plan(b, isSafe, isRefused)), '1,2,3');
});
