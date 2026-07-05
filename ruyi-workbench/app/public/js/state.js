// 如意 Ruyi — client state module (v1.3-FE1 前端模块化 Phase 1)。
//
// 纯搬家:此文件把原 app.js 顶部的 `state` 对象骨架与消息窗口化常量原样搬来,结构一字未改。
// app.js 通过 `import { state, MSG_WINDOW_* } from './js/state.js'` 取回同名绑定,全文件引用不变。
//
// 兼容层:此前 state 在经典脚本里是函数作用域顶层 const,浏览器控制台/preview 调试事实上可访问。
// 转为 ES Module 后模块作用域不再自动全局,故显式 `window.state = state` 挂回,保住调试/预览契约
// (dom-contract.e2e 的 ⑤ 断言此行存在)。

// 客户端运行时状态。字段与原 app.js 完全一致(仅搬家,不改结构/不改初值)。
export const state = {
  status: null,
  config: {},
  sessions: [],
  currentSession: null,
  attachments: [],
  streaming: false,
  rawEvents: [],          // {seq, line} for the debug panel
  paletteIndex: 0,
  shownUsage: null,       // last usage object reflected in the context meter
  resumable: null,        // v0.8-S0 A6: {dangling,kind} for the current session's resume banner
  playbooks: [],          // v0.9-S2: playbook cards for the empty state (built-in ∪ user, with availability)
  // v1.0-S7 (perf): message windowing. When a session has > MSG_WINDOW_THRESHOLD messages, renderCurrentSession
  // paints only the tail MSG_WINDOW_TAIL and shows a「加载更早的 N 条」button. msgWindowStart is the index of
  // the FIRST rendered message (0 = fully expanded). Reset to null on session open so each session starts
  // windowed. Small sessions keep it null → zero behavior change.
  msgWindowStart: null,
};

// v1.0-S7 (perf) windowing constants. Windowing engages ONLY when messages.length > MSG_WINDOW_THRESHOLD
// (small sessions render identically to before). Initial paint shows the last MSG_WINDOW_TAIL messages;
// each「加载更早」click reveals MSG_WINDOW_STEP more, repeatable until fully expanded.
export const MSG_WINDOW_THRESHOLD = 150;
export const MSG_WINDOW_TAIL = 120;
export const MSG_WINDOW_STEP = 120;

// 兼容层:保留 window.state(preview 控制台/调试历来可访问的全局符号)。见文件头说明。
window.state = state;
