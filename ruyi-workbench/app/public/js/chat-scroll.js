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
  // 滚轮上滑后的「复粘宽限窗」：解除粘性后若还停在距底 <120px，scroll 事件的
  // messagesAtBottom() 会立刻把粘性置回 true，流式跟随又把用户拉回底部（小幅上滑
  // 永远滑不出去）。窗口内不因其「还没滚出阈值」而复粘；用户下滑或点「回到最新」
  // 立即清窗。resetStickyScroll/scrollMessagesToBottom 同样清窗。
  let wheelUpGuardUntil = 0;

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
    const atBottom = messagesAtBottom();
    stickToBottom = atBottom ? Date.now() >= wheelUpGuardUntil : false;
    updateJumpLatest();
    return stickToBottom;
  }

  // 新回合/切会话恢复跟随意图；是否立刻滚动由调用方按渲染时序决定。
  function resetStickyScroll() {
    wheelUpGuardUntil = 0;
    stickToBottom = true;
    updateJumpLatest();
  }

  // 滚轮上滑是明确的「读历史」意图：直接解除粘性并开宽限窗，不依赖 120px 阈值判定。
  // 否则贴底时单格滚轮（≈100px）不足阈值，会被流式跟随的下一帧拉回底部，
  // 表现为「弹回去、滑不动」。
  function releaseSticky() {
    wheelUpGuardUntil = Date.now() + 1200;
    stickToBottom = false;
    updateJumpLatest();
  }

  // 滚轮下滑（或任何明确的向下意图）立即关宽限窗：滚回底部附近即可复粘跟随。
  function allowRestick() {
    wheelUpGuardUntil = 0;
  }

  // 显式「回到最新」同时恢复粘性，后续流式输出继续跟随。
  function scrollMessagesToBottom() {
    wheelUpGuardUntil = 0;
    stickToBottom = true;
    const box = messagesBox();
    if (box) { box.scrollTop = box.scrollHeight; markProgrammaticScroll(); }
    updateJumpLatest();
  }

  function isStickyScroll() {
    return stickToBottom;
  }

  return {
    allowRestick,
    isStickyScroll,
    maybeScrollToBottom,
    messagesAtBottom,
    releaseSticky,
    resetStickyScroll,
    scrollMessagesToBottom,
    syncStickToBottom,
    updateJumpLatest,
  };
}

// 鼠标滚轮原生滚动是阶跃的（一格 ~100px 瞬移），rAF 指数逼近插值成丝滑 glide。
// 规则：
// - 只接管落在消息区内、非修饰键（Ctrl/Alt/Shift）的纵向滚轮；
// - 事件源到消息区路径上若有还能继续滚的内层可滚区（代码块/diff/思维链），
//   让位原生，不吞事件；
// - 上滑立即调 controller.releaseSticky（用户读历史意图），下滑调 allowRestick，
//   避免与流式跟随对抗；
// - 外部写入（粘性跟随/会话切换/回到底部）使 scrollTop 偏离动画轨迹时自动停手，
//   绝不与第二写入者打架；programmatic 跳转前调用返回的 stop() 打断在途动画即可。
export function enableSmoothWheelScroll(getBox, controller) {
  const box = () => (typeof getBox === 'function' ? getBox() : null);
  const ctrl = controller || {};
  let target = 0;
  let raf = 0;
  let active = false;
  let lastWritten = -1;

  function clampTop(v, b) {
    return Math.max(0, Math.min(v, Math.max(0, b.scrollHeight - b.clientHeight)));
  }
  function step() {
    raf = 0;
    const b = box();
    if (!b || !active) return;
    const cur = b.scrollTop;
    // 外部写入（跟随/切会话）已接管：停手，下次滚轮重新从当前位置起算。
    if (lastWritten >= 0 && Math.abs(cur - lastWritten) > 1) { active = false; lastWritten = -1; return; }
    const diff = target - cur;
    if (Math.abs(diff) < 0.5) {
      b.scrollTop = target; active = false; lastWritten = -1; return;
    }
    const next = cur + diff * 0.28; // 指数逼近 ≈ ease-out glide
    b.scrollTop = next;
    lastWritten = b.scrollTop; // clamp 后读回真实值
    raf = requestAnimationFrame(step);
  }

  function onWheel(e) {
    const b = box();
    if (!b || e.defaultPrevented || e.ctrlKey || e.altKey || e.shiftKey || e.deltaY === 0) return;
    // 从事件源向消息区回溯：路径上任何还能朝该方向滚的内层可滚区都让位原生。
    let t = e.target;
    while (t && t !== b && t !== document.body) {
      const cs = window.getComputedStyle(t);
      if (/(auto|scroll|hidden)/.test(cs.overflowY) && t.scrollHeight > t.clientHeight) {
        const canDown = t.scrollTop + t.clientHeight < t.scrollHeight - 1;
        const canUp = t.scrollTop > 0;
        if ((e.deltaY > 0 && canDown) || (e.deltaY < 0 && canUp)) return;
      }
      t = t.parentElement;
    }
    if (t !== b) return; // 事件不在消息区内（侧栏/预览等），不接管
    const max = Math.max(0, b.scrollHeight - b.clientHeight);
    if (max <= 0) return;
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 32;              // 行模式 → px（≈行高）
    else if (e.deltaMode === 2) d *= b.clientHeight; // 页模式
    const next = clampTop((active ? target : b.scrollTop) + d, b);
    if (next === b.scrollTop) return; // 已到边界继续顶：无位移可接管，让原生默认行为
    e.preventDefault();
    if (d < 0 && typeof ctrl.releaseSticky === 'function') ctrl.releaseSticky(); // 上滑=明确读历史意图
    if (d > 0 && typeof ctrl.allowRestick === 'function') ctrl.allowRestick(); // 下滑=愿意回到底部跟随
    target = next;
    if (!active) { active = true; lastWritten = -1; }
    if (!raf) raf = requestAnimationFrame(step);
  }
  document.addEventListener('wheel', onWheel, { passive: false });

  function stop() {
    active = false; lastWritten = -1;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function dispose() {
    stop();
    document.removeEventListener('wheel', onWheel);
  }
  return { stop, dispose };
}
