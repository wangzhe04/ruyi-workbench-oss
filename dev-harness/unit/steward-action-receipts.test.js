#!/usr/bin/env node
'use strict';

// 第 124 波 P3（40 号文 §2 ③ A01「它说已安排／已发送，真发了吗？」）：**回执三态的真值表。**
//
// 被钉的是一句话：**一条 action 做没做成，只看 `result`，模型 `say` 里那句话一个字都不看。**
// 38 号文 §7 ④ 已经裁决过：下一档不该是关键词表（匹配「已经递了／按钮在下面」这类完成时陈述
// 既脆弱又要维护中英词表），而是让「我做了什么」结构化到 actions 里再判。
//
// 三态：
//   · result.ok === true  → 'done'
//   · result.ok === false → 'failed'（含 propose_required：被降级成按钮＝还没做）
//   · 其余                → 'no_receipt'「我发起了，但没拿到回执」
//
// **第三态是本刀补出来的那一格**。修前那一行是两值的：
//   `const okFlag = !(result && result.ok === false);`
// 于是「压根没有 result」被算进了「做成了」—— 系统手上没有任何回执，牌子却替模型把话说圆了，
// 那正是 A01 要挡的那种谎。在途回合今天走不到这一格（13p 两处 executed.push 都给 row.result
// 赋了值），它是给【回放】留的：落盘的章是历史数据，老回合／被截断的行都可能没有这个键，
// 而回放与 live 走同一个渲染入口。下面「历史章」那一组用例守的就是它。
//
// 与 steward-quick-replies / steward-focus-thread 两件同款约定：ESM 模块直接 import 磁盘文件到
// node:test，零磁盘写、零 DOM、每条用例只构造字面量。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'steward-conversation.js');
let modulePromise;
function loadModule() {
  // 这条链上的 state.js 会在模块顶层写一次 `window.state` 的兼容层 —— 给它一个 window 别名即可，
  // 不引入任何 DOM。测出来的仍是纯函数本身。
  if (!globalThis.window) globalThis.window = globalThis;
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE_PATH).href);
  return modulePromise;
}

describe('stewardActionReceiptState —— 回执三态', () => {
  it('三个态名就这三个，一个不多一个不少', async () => {
    const { STEWARD_RECEIPT_STATES } = await loadModule();
    assert.deepEqual([...STEWARD_RECEIPT_STATES], ['done', 'failed', 'no_receipt']);
  });

  it('真回执 ok:true → done', async () => {
    const { stewardActionReceiptState } = await loadModule();
    assert.equal(stewardActionReceiptState({ ok: true }), 'done');
    assert.equal(stewardActionReceiptState({ ok: true, sessionId: 'sess_x' }), 'done');
  });

  it('明确失败 ok:false → failed（含被降级成按钮的 propose_required）', async () => {
    const { stewardActionReceiptState } = await loadModule();
    assert.equal(stewardActionReceiptState({ ok: false, error: 'not_found' }), 'failed');
    assert.equal(stewardActionReceiptState({ ok: false, error: 'propose_required' }), 'failed');
  });

  // ── 本刀补出来的那一格：没有回执 ≠ 做成了 ──────────────────────────────────
  it('压根没有 result → no_receipt（修前这一格被算成 done）', async () => {
    const { stewardActionReceiptState } = await loadModule();
    assert.equal(stewardActionReceiptState(undefined), 'no_receipt');
    assert.equal(stewardActionReceiptState(null), 'no_receipt');
  });

  it('result 不是对象 / 没有 ok 键 → no_receipt（不猜，也不默认成功）', async () => {
    const { stewardActionReceiptState } = await loadModule();
    assert.equal(stewardActionReceiptState(''), 'no_receipt');
    assert.equal(stewardActionReceiptState('ok'), 'no_receipt');   // 字符串 'ok' 不是回执
    assert.equal(stewardActionReceiptState(0), 'no_receipt');
    assert.equal(stewardActionReceiptState({}), 'no_receipt');
    assert.equal(stewardActionReceiptState({ sessionId: 'sess_x' }), 'no_receipt');
  });

  it('ok 是真值但不是 true 也不算回执（严格 === true，不吃 1/"true"）', async () => {
    const { stewardActionReceiptState } = await loadModule();
    assert.equal(stewardActionReceiptState({ ok: 1 }), 'no_receipt');
    assert.equal(stewardActionReceiptState({ ok: 'true' }), 'no_receipt');
    // 反过来同样严格：ok 是假值但不是 false，不许被读成「明确失败」
    assert.equal(stewardActionReceiptState({ ok: 0 }), 'no_receipt');
    assert.equal(stewardActionReceiptState({ ok: null }), 'no_receipt');
  });

  it('历史章那一组：落盘的老行没有 result 键时，说的是「没拿到回执」而不是「做成了」', async () => {
    const { stewardActionReceiptState } = await loadModule();
    // 形状照抄 13p executed.push 的行，但把 result 整个摘掉（= 老回合／被截断的章）
    const legacyRow = { tool: 'steward_thread_continue', args: { sessionId: 'sess_x' }, label: '接着办' };
    assert.equal(stewardActionReceiptState(legacyRow.result), 'no_receipt');
  });

  it('纯函数：不改入参', async () => {
    const { stewardActionReceiptState } = await loadModule();
    const input = { ok: false, error: 'not_found' };
    const snapshot = JSON.stringify(input);
    stewardActionReceiptState(input);
    assert.equal(JSON.stringify(input), snapshot);
  });
});
