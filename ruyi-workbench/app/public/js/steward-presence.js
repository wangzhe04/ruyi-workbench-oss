'use strict';

// 第117波 117b（27 号文 §8.3「avatar 状态与动效规格」）：管家 avatar 的状态纯投影。
//
// 与 mission-state.js / turn-activity.js 同一纪律：纯函数、零 DOM、零 import、零 t() 依赖，两处
// 消费者（steward-shell.js 的运行时渲染、dev-harness 的单元/静态测试）共用同一份真身。入参全部可选，
// 缺省字段一律按「没发生」处理，不抛异常、不改入参。
//
// 优先级（§8.3 表末段，逐字照做）：
//   sleeping（enabled !== true 或 stopped）覆盖一切
//   → 在途（streaming 或 inflight 非空：phase 为 calling_tool/orchestrating/waiting_resource/compacting
//     时是 working，否则 thinking）
//   → error（lastError 非空）
//   → waiting_you（pendingCount>0 || needsYouCount>0，与 mission-state.js 的 needs_you 同源语义）
//   → listening（typing）
//   → idle。
// 同一时刻只有一个状态；状态本身不带「已经播过一次性动效没有」的记忆——那是渲染层的职责
// （steward-shell.js 只在状态真正切换到 waiting_you/error 的那一刻才补一次 .pulse/.shake）。

export const STEWARD_PRESENCE_STATES = Object.freeze([
  'idle',
  'listening',
  'thinking',
  'working',
  'waiting_you',
  'error',
  'sleeping',
]);

// 在途回合里,这几个 turn-activity phase 说明管家/线程正在"动手"而不只是"在想"。
const STEWARD_PRESENCE_WORKING_PHASES = Object.freeze([
  'calling_tool',
  'orchestrating',
  'waiting_resource',
  'compacting',
]);

// derivePresence(input) -> 七态之一。input 的每个字段都可选：
//   enabled      boolean  管家总开关（config.stewardEnabledV1）
//   stopped      boolean  运行器已停机（GET /api/steward/state 的 stopped）
//   inflight     string   'user' | 'inbox' | ''（同上 state 的 inflight）
//   phase        string   本回合 turn-activity 的 phase（见 turn-activity.js TURN_ACTIVITY_PHASES）
//   streaming    boolean  本地正在消费 /api/steward/message 的 SSE 流
//   lastError    string|null  上一次动作失败原因（非空即 error）
//   pendingCount number   待批提议数（近似值：117b 用 lastReply.acts.length 顶替，117c 接真值）
//   needsYouCount number  需要你的线程数（mission-state.js 的 needs_you 聚合，117h 接入）
//   typing       boolean  输入框正在输入
export function derivePresence(input) {
  const src = (input && typeof input === 'object') ? input : {};

  if (src.enabled !== true || src.stopped === true) return 'sleeping';

  const inflight = typeof src.inflight === 'string' ? src.inflight : '';
  const streaming = src.streaming === true;
  if (streaming || inflight) {
    return STEWARD_PRESENCE_WORKING_PHASES.includes(src.phase) ? 'working' : 'thinking';
  }

  const lastError = typeof src.lastError === 'string' ? src.lastError : '';
  if (lastError) return 'error';

  const pendingCount = Number(src.pendingCount) || 0;
  const needsYouCount = Number(src.needsYouCount) || 0;
  if (pendingCount > 0 || needsYouCount > 0) return 'waiting_you';

  if (src.typing === true) return 'listening';

  return 'idle';
}

// presenceLabelKey(state) -> 'stewardShell.presence.<state>'。未知/缺省状态回落到 idle 的键
// （防御性：调用方永远拿得到一个存在的 i18n 键，而不是 'stewardShell.presence.undefined'）。
// ctx 预留给未来按状态定制键名（例如区分「等你确认哪一类」），117b 尚不需要，先占住形状。
export function presenceLabelKey(state, ctx) {
  void ctx; // 117b 未用；键固定为 stewardShell.presence.<state>，{detail} 插值由调用方经 t(key, {detail}) 注入
  const safe = STEWARD_PRESENCE_STATES.includes(state) ? state : 'idle';
  return `stewardShell.presence.${safe}`;
}
