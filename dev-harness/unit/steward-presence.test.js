#!/usr/bin/env node
'use strict';

// 第117波 117b(27 号文 §8.3「avatar 状态与动效规格」)：avatar 状态纯投影 derivePresence() 的真值表。
// 与 dev-harness/unit/turn-activity.test.js 同款约定：ESM 模块经 data: URL 动态 import 到 node:test，
// 零磁盘、零 DOM、每条用例只构造字面量。
//
// 覆盖：
//   ① 每对相邻优先级至少一例(sleeping>在途>error>waiting_you>listening>idle)
//   ② sleeping 覆盖一切(哪怕同时具备其余五态的全部条件)
//   ③ phase -> working/thinking 的映射(四个 working phase 各一例 + 非 working phase 落 thinking)
//   ④ 缺省输入：derivePresence() 与 derivePresence({}) 均无 enabled:true -> 按 §8.3 字面(enabled!==true
//     即 sleeping)判为 sleeping；derivePresence({ enabled: true }) 其余全默认 -> idle(两者都是「缺省」，
//     取的锚点不同：前者是「完全不知道开关状态」的 fail-closed 缺省，后者是「开着但什么都没发生」的
//     业务缺省 —— 27 号文 §11.5 的 fail-closed 纪律与「缺省→idle」两个要求同时满足，不是二选一)
//   ⑤ 纯函数：不改入参(Object.freeze 入参对象，函数若尝试写入会抛)
//   ⑥ presenceLabelKey：七态各自键名、未知态回落 idle 键、不抛

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'steward-presence.js');
const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8');
let modulePromise;
function loadModule() {
  if (!modulePromise) {
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(moduleSource, 'utf8').toString('base64');
    modulePromise = import(dataUrl);
  }
  return modulePromise;
}

describe('steward-presence: 常量表', () => {
  it('STEWARD_PRESENCE_STATES 是冻结的七态，顺序即 §8.3 表的书写顺序', async () => {
    const { STEWARD_PRESENCE_STATES } = await loadModule();
    assert.deepEqual(STEWARD_PRESENCE_STATES, [
      'idle', 'listening', 'thinking', 'working', 'waiting_you', 'error', 'sleeping',
    ]);
    assert.equal(Object.isFrozen(STEWARD_PRESENCE_STATES), true);
  });
});

describe('steward-presence: derivePresence 缺省与 idle', () => {
  it('完全不传入参(fail-closed 缺省) -> sleeping：enabled 未知即不信任', async () => {
    const { derivePresence } = await loadModule();
    assert.equal(derivePresence(), 'sleeping');
    assert.equal(derivePresence({}), 'sleeping');
    assert.equal(derivePresence(undefined), 'sleeping');
    assert.equal(derivePresence(null), 'sleeping');
  });

  it('enabled:true，其余字段全部缺省(业务缺省) -> idle', async () => {
    const { derivePresence } = await loadModule();
    assert.equal(derivePresence({ enabled: true }), 'idle');
    assert.equal(derivePresence({ enabled: true, stopped: false, typing: false }), 'idle');
  });
});

describe('steward-presence: 优先级——每对相邻至少一例', () => {
  it('sleeping > 在途：enabled=false 时哪怕同时具备其余五态的全部条件，仍是 sleeping', async () => {
    const { derivePresence } = await loadModule();
    const everything = {
      enabled: false, stopped: true, streaming: true, phase: 'calling_tool',
      lastError: 'boom', pendingCount: 9, needsYouCount: 9, typing: true,
    };
    assert.equal(derivePresence(everything), 'sleeping');
    assert.equal(derivePresence({ ...everything, enabled: true, stopped: true }), 'sleeping',
      '停机(stopped)单独也覆盖一切，不需要 enabled 同时为 false');
  });

  it('在途(streaming/inflight) > error：即便 lastError 非空，只要在途就先报 working/thinking', async () => {
    const { derivePresence } = await loadModule();
    const base = { enabled: true, stopped: false, lastError: '端点连不上', pendingCount: 5, typing: true };
    assert.equal(derivePresence({ ...base, streaming: true }), 'thinking');
    assert.equal(derivePresence({ ...base, inflight: 'user' }), 'thinking');
    assert.equal(derivePresence({ ...base, inflight: 'inbox', phase: 'orchestrating' }), 'working');
  });

  it('error > waiting_you：lastError 非空时，哪怕 pendingCount/needsYouCount 都大于 0，仍是 error', async () => {
    const { derivePresence } = await loadModule();
    assert.equal(derivePresence({
      enabled: true, stopped: false, lastError: '权限被拒', pendingCount: 3, needsYouCount: 2, typing: true,
    }), 'error');
  });

  it('waiting_you > listening：pendingCount 或 needsYouCount 任一大于 0，哪怕 typing 也是 waiting_you', async () => {
    const { derivePresence } = await loadModule();
    assert.equal(derivePresence({ enabled: true, pendingCount: 1, typing: true }), 'waiting_you');
    assert.equal(derivePresence({ enabled: true, needsYouCount: 1, typing: true }), 'waiting_you');
    assert.equal(derivePresence({ enabled: true, pendingCount: 0, needsYouCount: 0, typing: true }), 'listening');
  });

  it('listening > idle：typing 时是 listening，不 typing 落回 idle', async () => {
    const { derivePresence } = await loadModule();
    assert.equal(derivePresence({ enabled: true, typing: true }), 'listening');
    assert.equal(derivePresence({ enabled: true, typing: false }), 'idle');
  });
});

describe('steward-presence: phase -> working/thinking 映射', () => {
  it('四个 working phase 各一例 -> working', async () => {
    const { derivePresence } = await loadModule();
    for (const phase of ['calling_tool', 'orchestrating', 'waiting_resource', 'compacting']) {
      assert.equal(derivePresence({ enabled: true, streaming: true, phase }), 'working', `phase=${phase}`);
    }
  });

  it('非 working phase(thinking/idle/waiting_you/缺省) 落 thinking', async () => {
    const { derivePresence } = await loadModule();
    for (const phase of ['thinking', 'idle', 'waiting_you', undefined, '', 'unknown_phase']) {
      assert.equal(derivePresence({ enabled: true, inflight: 'user', phase }), 'thinking', `phase=${String(phase)}`);
    }
  });
});

describe('steward-presence: 纯函数纪律', () => {
  it('不改入参：冻结的入参对象传入不抛，且值不变', async () => {
    const { derivePresence } = await loadModule();
    const input = Object.freeze({ enabled: true, typing: true });
    assert.doesNotThrow(() => derivePresence(input));
    assert.equal(derivePresence(input), 'listening');
    assert.deepEqual(input, { enabled: true, typing: true });
  });

  it('同一入参重复调用得到相同结果(无隐藏内部状态)', async () => {
    const { derivePresence } = await loadModule();
    const input = { enabled: true, pendingCount: 2 };
    assert.equal(derivePresence(input), derivePresence(input));
  });
});

describe('steward-presence: presenceLabelKey', () => {
  it('七态各自对应 stewardShell.presence.<state>', async () => {
    const { STEWARD_PRESENCE_STATES, presenceLabelKey } = await loadModule();
    for (const state of STEWARD_PRESENCE_STATES) {
      assert.equal(presenceLabelKey(state), `stewardShell.presence.${state}`);
    }
  });

  it('未知/缺省状态回落 idle 键，不抛', async () => {
    const { presenceLabelKey } = await loadModule();
    assert.equal(presenceLabelKey('not_a_real_state'), 'stewardShell.presence.idle');
    assert.equal(presenceLabelKey(undefined), 'stewardShell.presence.idle');
    assert.equal(presenceLabelKey(null), 'stewardShell.presence.idle');
  });
});
