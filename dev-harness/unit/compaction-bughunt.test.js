'use strict';
// 找 bug 波(Sonnet 复核)在上下文压缩上钉住的几条,每条先在修前的代码上复现过:
//   [C1] 第二次及以后的 L2 重播种不把上一次的「原始任务 + 旧摘要」整条再钉一遍(修前一层套一层越积越长);
//   [C2] 首问带图片(content 是 parts 数组)时,钉住的原始任务是文字,不是「[object Object]」;
//   [C6] 分段摘要失败时报真正的原因,不报被连带取消的那一块(「sibling chunk failed」)。
// L2 失败后的滞回水位见 compact-marker-merge.test.js(与同一套 vm 沙箱放在一起)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-compaction-bughunt-'));
process.env.RUYI_HOME = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { readServerSource } = require('../src-reader');
const { functionBlock } = require('../lib/source-slice');

const plan = (task, extra = {}) => ({ scope: 'main', trigger: 'auto', task, kept: [], recentFiles: [], ...extra });

test('[C1] 重复 L2 不嵌套旧摘要', () => {
  const first = srv.CompactionPlan.reseed(plan({ role: 'user', content: 'TASK0: build X' }), 'SUMMARY-1');
  assert.match(first[0].content, /^原始任务\(保持聚焦\):\nTASK0: build X\n\n【压缩摘要】\nSUMMARY-1$/);
  const second = srv.CompactionPlan.reseed(plan(first[0]), 'SUMMARY-2');
  const third = srv.CompactionPlan.reseed(plan(second[0]), 'SUMMARY-3');
  for (const [i, msg] of [second[0], third[0]].entries()) {
    assert.equal((msg.content.match(/原始任务/g) || []).length, 1, `第 ${i + 2} 次:原始任务只出现一次`);
    assert.equal((msg.content.match(/【压缩摘要/g) || []).length, 1, `第 ${i + 2} 次:只有最新的一份摘要`);
    assert.ok(msg.content.includes('TASK0: build X'), '原始任务正文还在');
  }
  assert.ok(third[0].content.endsWith('SUMMARY-3') && !third[0].content.includes('SUMMARY-1') && !third[0].content.includes('SUMMARY-2'));
  assert.ok(third[0].content.length <= first[0].content.length + 5, '长度不随压缩次数增长');
  // 强压的标题也认
  const forced = srv.CompactionPlan.reseed(plan({ role: 'user', content: 'T' }, { trigger: 'forced_400' }), 'S-F');
  const afterForced = srv.CompactionPlan.reseed(plan(forced[0]), 'S-2');
  assert.equal((afterForced[0].content.match(/【压缩摘要/g) || []).length, 1);
});

test('[C2] 带图片的首问钉成文字', () => {
  const task = { role: 'user', content: [{ type: 'text', text: '看看这张截图哪里报错' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] };
  const out = srv.CompactionPlan.reseed(plan(task), 'S');
  assert.ok(!out[0].content.includes('[object Object]'));
  assert.ok(out[0].content.includes('看看这张截图哪里报错') && out[0].content.includes('[图片]'));
});

test('[C6] 分段摘要取真实失败,不取被连带取消的那一块', () => {
  const src = functionBlock(readServerSource(), 'pickSummaryFailure');
  assert.ok(src.length > 50, '切到了 pickSummaryFailure');
  const pick = new Function(src + '\nreturn pickSummaryFailure;')();
  const cancelled = { ok: false, error: 'summary request cancelled (sibling chunk failed)', cancelledBySibling: true };
  const real = { ok: false, error: 'HTTP 400: REAL CAUSE' };
  assert.equal(pick([{ ok: true }, cancelled, real]), real, '块序在前的是被取消的那块,也要报真实原因');
  assert.equal(pick([undefined, cancelled]), cancelled, '全是连带取消时退回第一条');
  assert.equal(pick([{ ok: true }, undefined]), null);
});
