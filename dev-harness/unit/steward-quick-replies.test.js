#!/usr/bin/env node
'use strict';

// 第117波 117d（27 号文 §8.13「你可以说」）：快捷回复来源的确定性优先级真值表。
// 与 dev-harness/unit/steward-presence.test.js 同款约定：ESM 模块经 data: URL 动态 import 到
// node:test，零磁盘、零 DOM、每条用例只构造字面量。
//
// 断的是这条优先级，一格都不许错位：
//   待决的选项（question 的候选答案 ＞ permission 的允许／拒绝）
//     ＞ 线程最后一句是问句（以 ？? 结尾）
//     ＞ 五态默认（stopped／done → 继续＋换个法子；running／dispatching → 先停一下；其余 → 继续）
// 另外：条数上限 3；question 无可用选项时【不是空手而归】，要落到下一优先级；纯函数（不改入参）。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'steward-drawer.js');
const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8');
let modulePromise;
function loadModule() {
  if (!modulePromise) {
    // steward-drawer.js 顶层 import 了 mission-state / net / preview-task-sheet / turn-activity /
    // steward-chips —— 直接 import 磁盘文件即可（它们都是浏览器无关的纯 ESM，模块顶层零 DOM 触碰）。
    modulePromise = import(require('node:url').pathToFileURL(MODULE_PATH).href);
  }
  return modulePromise;
}
// t 用恒等函数：真值表只关心「选了哪条键」，不关心中英文案。
const t = key => key;
const K = suffix => `stewardShell.drawer.reply.${suffix}`;

function questionPending(options) {
  return {
    id: 'iv_q1',
    type: 'question',
    sessionId: 'sess_a',
    questions: [{ id: 'framework', question: '接着用哪个？', answerMode: 'single', options }],
  };
}

describe('quickRepliesFor: 常量与形状', () => {
  it('上限常量是 3，且导出的区块顺序表是冻结的 11 项（区块顺序即契约）', async () => {
    const { STEWARD_QUICK_REPLIES_MAX, STEWARD_DRAWER_BLOCK_IDS } = await loadModule();
    assert.equal(STEWARD_QUICK_REPLIES_MAX, 3);
    assert.equal(STEWARD_DRAWER_BLOCK_IDS.length, 11);
    assert.equal(Object.isFrozen(STEWARD_DRAWER_BLOCK_IDS), true);
  });

  it('完全不传入参也不抛，落到「其余五态」的默认：继续', async () => {
    const { quickRepliesFor } = await loadModule();
    assert.deepEqual(quickRepliesFor().map(reply => reply.label), [K('continue')]);
    assert.deepEqual(quickRepliesFor({}).map(reply => reply.label), [K('continue')]);
  });

  it('纯函数：入参被冻结也照跑（不写回 pending / questions / options）', async () => {
    const { quickRepliesFor } = await loadModule();
    const options = Object.freeze([Object.freeze({ id: 'a', label: 'A' })]);
    const pending = Object.freeze(questionPending(options));
    Object.freeze(pending.questions);
    Object.freeze(pending.questions[0]);
    const input = Object.freeze({ pending, lastAssistantText: '随便一句。', state: 'running', t });
    assert.equal(quickRepliesFor(input).length, 1);
    assert.equal(quickRepliesFor(input).length, 1);   // 二次调用结果不漂移
  });
});

describe('quickRepliesFor: ① 待决优先（question）', () => {
  it('question 取前 3 个候选答案，label 缺失时回落 value（与 interaction-prompts.js 同口径）', async () => {
    const { quickRepliesFor } = await loadModule();
    const replies = quickRepliesFor({
      pending: questionPending([
        { id: 'react', label: 'React' },
        { id: 'vue', value: 'Vue' },        // 只有 value：走 opt.label || opt.value
        { id: 'svelte', label: 'Svelte' },
        { id: 'solid', label: 'Solid' },    // 第 4 条必须被截掉
      ]),
      lastAssistantText: '要不要继续？',      // 问句在场也不许抢在待决前面
      state: 'stopped',                      // 五态默认同理
      t,
    });
    assert.deepEqual(replies.map(reply => reply.label), ['React', 'Vue', 'Svelte']);
    assert.deepEqual(replies.map(reply => reply.kind), ['question', 'question', 'question']);
    assert.deepEqual(replies.map(reply => reply.optionId), ['react', 'vue', 'svelte']);
    assert.equal(replies[0].interventionId, 'iv_q1');
    assert.equal(replies[0].questionId, 'framework');
  });

  it('question 没有可用选项（空 options／缺 id／缺文案）时落到下一优先级，不是空手而归', async () => {
    const { quickRepliesFor } = await loadModule();
    const noOptions = quickRepliesFor({ pending: questionPending([]), lastAssistantText: '还继续吗？', state: 'done', t });
    assert.deepEqual(noOptions.map(reply => reply.label), [K('yes'), K('no')]);
    const brokenOptions = quickRepliesFor({
      pending: questionPending([{ label: '没有 id' }, { id: 'x' }]),
      lastAssistantText: '这句不是问句。',
      state: 'done',
      t,
    });
    assert.deepEqual(brokenOptions.map(reply => reply.label), [K('continue'), K('otherWay')]);
  });
});

describe('quickRepliesFor: ① 待决优先（permission）', () => {
  it('permission 给「允许」「拒绝」两条，并盖过问句与五态', async () => {
    const { quickRepliesFor } = await loadModule();
    const replies = quickRepliesFor({
      pending: { id: 'perm_1', type: 'permission', sessionId: 'sess_a', toolName: 'powershell_run' },
      lastAssistantText: '要我跑这条命令吗？',
      state: 'running',
      t,
    });
    assert.deepEqual(replies.map(reply => reply.label), [K('allow'), K('deny')]);
    assert.deepEqual(replies.map(reply => reply.behavior), ['allow', 'deny']);
    assert.equal(replies[0].interventionId, 'perm_1');
  });

  it('plan／pool／replan 这些本波不做快捷回复的类型，落到下一优先级', async () => {
    const { quickRepliesFor } = await loadModule();
    for (const type of ['plan', 'pool', 'replan']) {
      const replies = quickRepliesFor({ pending: { id: 'iv', type }, lastAssistantText: '走这个方案吗？', state: 'running', t });
      assert.deepEqual(replies.map(reply => reply.label), [K('yes'), K('no')], type);
    }
  });
});

describe('quickRepliesFor: ② 问句优先于五态', () => {
  it('中文问号与英文问号都算问句，给「好，就这样」「先不要」', async () => {
    const { quickRepliesFor } = await loadModule();
    for (const tail of ['要我接着做吗？', 'Shall I continue?']) {
      const replies = quickRepliesFor({ lastAssistantText: tail, state: 'running', t });
      assert.deepEqual(replies.map(reply => reply.label), [K('yes'), K('no')], tail);
      assert.deepEqual(replies.map(reply => reply.kind), ['say', 'say']);
    }
  });

  it('问号不在句尾就不算问句（「？」在中间只是转述），回落五态默认', async () => {
    const { quickRepliesFor } = await loadModule();
    const replies = quickRepliesFor({ lastAssistantText: '你问我要不要继续？我先把表做完。', state: 'running', t });
    assert.deepEqual(replies.map(reply => reply.label), [K('holdOn')]);
  });
});

describe('quickRepliesFor: ③ 五态默认', () => {
  const table = [
    ['stopped', ['continue', 'otherWay']],
    ['done', ['continue', 'otherWay']],
    ['running', ['holdOn']],
    ['dispatching', ['holdOn']],
    ['needs_you', ['continue']],       // 有待决时走 ①；这里是「需要你但没有待决」的兜底
    ['quick_ask', ['continue']],
    ['', ['continue']],
  ];
  for (const [state, expected] of table) {
    it(`五态 ${state || '(空)'} → ${expected.join('／')}`, async () => {
      const { quickRepliesFor } = await loadModule();
      const replies = quickRepliesFor({ lastAssistantText: '我把表做完了。', state, t });
      assert.deepEqual(replies.map(reply => reply.label), expected.map(K));
      assert.equal(replies.every(reply => reply.kind === 'say' && reply.text === reply.label), true);
      assert.equal(replies.length <= 3, true);
    });
  }
});

describe('lastSaySentences: 「它刚说」取原话前 ≤3 句', () => {
  it('按 。！？.!? 切句，取前三句，原话不改写', async () => {
    const { lastSaySentences } = await loadModule();
    assert.equal(lastSaySentences('一。二！三？四。'), '一。二！三？');
    assert.equal(lastSaySentences('One. Two! Three? Four.'), 'One. Two! Three?');
  });
  it('不足三句就整段返回；没有句末标点也不截断；空串回空串', async () => {
    const { lastSaySentences } = await loadModule();
    assert.equal(lastSaySentences('只有一句话'), '只有一句话');
    assert.equal(lastSaySentences('两句。第二句'), '两句。第二句');
    assert.equal(lastSaySentences(''), '');
    assert.equal(lastSaySentences(null), '');
  });
  it('可自定句数上限（≥1）', async () => {
    const { lastSaySentences } = await loadModule();
    assert.equal(lastSaySentences('一。二。三。', 1), '一。');
    assert.equal(lastSaySentences('一。二。三。', 0), '一。');
  });
});
