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
  // 停在半途"）。写入后开一小段时间窗口：窗口内的回声事件跳过判定；但用户明显偏离程序化目标
  // （主动上滑 >40px）仍放行，保证连续流式期间真实上滑始终可逃逸。
  let progScrollGuard = false;
  let progScrollTimer = 0;
  let lastProgTop = 0;

  const messagesBox = () => (typeof getMessages === 'function' ? getMessages() : null);
  const jumpButton = () => (typeof getJumpLatest === 'function' ? getJumpLatest() : null);

  function markProgrammaticScroll() {
    progScrollGuard = true;
    const box = messagesBox();
    if (box) lastProgTop = box.scrollTop; // 赋值后 scrollTop 已同步反映目标位置
    if (progScrollTimer) clearTimeout(progScrollTimer);
    progScrollTimer = setTimeout(() => { progScrollTimer = 0; progScrollGuard = false; }, 120);
  }

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
    if (stickToBottom && box) { box.scrollTop = box.scrollHeight; markProgrammaticScroll(); }
    updateJumpLatest();
  }

  // 只由 #messages 的真实 scroll 事件调用。DOM 增长本身不应误判为用户上滑；
  // 程序化滚动窗口内的回声事件同样跳过（避免把自己的滚动误判成上滑），
  // 但用户主动偏离程序化目标（上滑）时立即放行，走正常粘性判定。
  function syncStickToBottom() {
    if (progScrollGuard) {
      const box = messagesBox();
      if (box && Math.abs(box.scrollTop - lastProgTop) < 40) { updateJumpLatest(); return stickToBottom; }
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
