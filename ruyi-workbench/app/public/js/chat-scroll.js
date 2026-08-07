'use strict';

// EC-D 第57波：聊天区滚动状态的单一入口。
//
// 旧实现把 stickToBottom 与五个辅助函数散在 app.js 中，流式正文走粘性状态，
// 思考框却在事件到达时单独捕获 messagesAtBottom()。DOM 真正增长前后的亚毫秒
// 窗口会让两条路径得出不同结论。此控制器把「用户是否选择跟随最新」与 DOM
// 当前位置分开：只有真实 scroll 事件改变粘性；所有内容增长统一调用
// maybeScrollToBottom()。
export function createChatScrollController({
  getMessages,
  getJumpLatest,
  isStreaming,
  threshold = 120,
} = {}) {
  let stickToBottom = true;
  // 程序化 scrollTop 赋值会触发浏览器 scroll 事件。若让 syncStickToBottom 把这些"自身滚动回声"
  // 当成用户上滑来读布局，流式跟随时 stickToBottom 会被自己的滚动误置为 false（"跟随被杀、页面
  // 停在半途"）。写入后开一小段时间窗口：窗口内只跳过「scrollTop 恰等于程序化目标」的回声；
  // 任何偏离（哪怕 1px）都是用户滚动，立即放行走正常粘性判定 —— 这样小幅上滑永远不会被吞。
  let progScrollGuard = false;
  let progScrollTimer = 0;
  let lastProgTop = 0;

  const messagesBox = () => (typeof getMessages === 'function' ? getMessages() : null);
  const jumpButton = () => (typeof getJumpLatest === 'function' ? getJumpLatest() : null);
  let lastJumpShow = null; // P3: jump-latest 显隐去抖，状态未变时跳过 classList 操作（流式每帧不再抖动）

  function markProgrammaticScroll() {
    progScrollGuard = true;
    const box = messagesBox();
    if (box) lastProgTop = box.scrollTop; // 赋值后 scrollTop 已同步反映目标位置（含 clamp）
    if (progScrollTimer) clearTimeout(progScrollTimer);
    progScrollTimer = setTimeout(() => { progScrollTimer = 0; progScrollGuard = false; }, 120);
  }
  // 守卫依赖「程序化滚动无平滑中间帧」：.messages 不设 scroll-behavior:smooth（chat-primitives.css）。
  // 若未来为消息区启用 smooth，回声事件的 scrollTop 会在动画中间帧偏离目标值，需把本判定改回容忍带。

  function messagesAtBottom() {
    const box = messagesBox();
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
  }

  function updateJumpLatest() {
    const btn = jumpButton();
    if (!btn || !btn.classList) return;
    const show = Boolean(typeof isStreaming === 'function' && isStreaming()) && !messagesAtBottom();
    if (show !== lastJumpShow) { lastJumpShow = show; btn.classList.toggle('hidden', !show); }
  }

  // 内容增长的唯一入口：用户保持粘性时跟随；上滑阅读后只更新提示按钮。
  function maybeScrollToBottom() {
    const box = messagesBox();
    if (stickToBottom && box) { box.scrollTop = box.scrollHeight; markProgrammaticScroll(); }
    updateJumpLatest();
  }

  // 只由 #messages 的真实 scroll 事件调用。DOM 增长本身不应误判为用户上滑；
  // 程序化滚动窗口内的回声事件同样跳过（避免把自己的滚动误判成上滑）——
  // 但判定改为「scrollTop 恰等于程序化目标」才跳过：程序化回声必然停在目标值，
  // 而任何偏离都来自用户输入，立即放行。40px 容忍带会吞掉小幅上滑（已被对抗验证发现）。
  function syncStickToBottom() {
    if (progScrollGuard) {
      const box = messagesBox();
      if (box && box.scrollTop === lastProgTop) { updateJumpLatest(); return stickToBottom; }
    }
    stickToBottom = messagesAtBottom();
    updateJumpLatest();
    return stickToBottom;
  }

  // 新回合/切会话恢复跟随意图；是否立刻滚动由调用方按渲染时序决定。
  function resetStickyScroll() {
    stickToBottom = true;
    updateJumpLatest();
  }

  // 显式「回到最新」同时恢复粘性，后续流式输出继续跟随。
  function scrollMessagesToBottom() {
    stickToBottom = true;
    const box = messagesBox();
    if (box) { box.scrollTop = box.scrollHeight; markProgrammaticScroll(); }
    updateJumpLatest();
  }

  function isStickyScroll() {
    return stickToBottom;
  }

  return {
    isStickyScroll,
    maybeScrollToBottom,
    messagesAtBottom,
    resetStickyScroll,
    scrollMessagesToBottom,
    syncStickToBottom,
    updateJumpLatest,
  };
}
