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

  const messagesBox = () => (typeof getMessages === 'function' ? getMessages() : null);
  const jumpButton = () => (typeof getJumpLatest === 'function' ? getJumpLatest() : null);

  function messagesAtBottom() {
    const box = messagesBox();
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < threshold;
  }

  function updateJumpLatest() {
    const btn = jumpButton();
    if (!btn || !btn.classList) return;
    const show = Boolean(typeof isStreaming === 'function' && isStreaming()) && !messagesAtBottom();
    btn.classList.toggle('hidden', !show);
  }

  // 内容增长的唯一入口：用户保持粘性时跟随；上滑阅读后只更新提示按钮。
  function maybeScrollToBottom() {
    const box = messagesBox();
    if (stickToBottom && box) box.scrollTop = box.scrollHeight;
    updateJumpLatest();
  }

  // 只由 #messages 的真实 scroll 事件调用。DOM 增长本身不应误判为用户上滑。
  function syncStickToBottom() {
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
    if (box) box.scrollTop = box.scrollHeight;
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
