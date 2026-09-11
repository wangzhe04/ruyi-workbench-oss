'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// app-frame.js — 应用外框的框架件（121 波 K4，34 号文 §2.2／§2.3／§7.3）。
//
// 一台两视之后，「顶栏」与「左栏」不属于任何一个视角：它们是外框自己的一层。这片叶子只管
// 外框上那几个【框架动作】，一条数据都不取、一个请求都不发：
//   · 视角分段钮「管家 ｜ 工作台」与快捷键 Ctrl+`  → 调注进来的 applyShellMode（唯一写者仍是
//     js/shell-mode.js；本模块不写 data-shell-mode，只读它来对钮的样子）；
//   · 齿轮菜单的开合（就地浮层，[hidden] 驱动，与盾牌菜单同款）；
//   · 「右栏」钮（≤1180 右栏收成抽屉时才出现）写 .app-frame.side-open；
//   · 「看板」密度钮写 .app-frame.rail-board（左栏 268 → 440px；多出来的那行事实归 K4-2 渲染）；
//   · Ctrl+K 把焦点送进左栏搜索框。
//
// 为什么不做成 popover 原语：齿轮菜单里那几枚按钮（帮助／更多／能力矩阵）自己还要开各自的浮层，
// 而 popover 原语同一时刻只允许一个 —— 做成 popover 的话，点「帮助」会先把自己的锚点收掉，
// 那个菜单就会锚在 0,0。所以这里用与 #stewardShieldMenu 完全同款的就地 [hidden] 浮层。
//
// 组合根 app.js 只多两行（import ＋ bindAppFrame()）。
// ─────────────────────────────────────────────────────────────────────────────

// 视角的两值在 js/shell-mode.js 一处登记（SHELL_MODES）；本模块只认「分段钮上写的那个值」，
// 不复制那张表 —— 分段钮的 data-lens 就是它的全部判据。
export const LENS_FORWARD = 'classic';   // 前进方向（管家 → 工作台）：中栏向左进入
export const LENS_BACK = 'steward';      // 返回方向（工作台 → 管家）：中栏向右退回

// §2.7「视角切换不丢现场」的一半：两条对话流的滚动位置。
// 为什么需要这一层：非当前视角的容器是 display:none —— 浏览器会把它的 scrollTop 丢掉，
// 切回来就是滚到顶（实测两视角都这样）。而「切回管家视角时对话流滚动位置原样」是 §2.7 明写的。
// 做法：给两条滚动区各挂一个 passive 的 scroll 监听，随时记住最后的位置；视角属性一变就把
// 【此刻可见的】那一条恢复回去。记的是位置，不是快照 —— 内容重画过也不会错位到别人身上。
export const APP_FRAME_SCROLL_KEEPERS = Object.freeze(['stewardFeed', 'messages']);

// 121-K5（34 号文 §2.7）：退役的 js/steward-classic-window.js 里 backToSteward 的【后半】——
// 回到管家视角时，让焦点落在刚才在工作台看的那条线程上。它的前半（sessionStorage 返回标记与
// 那条返回带）随本刀整段删掉；后半搬到这里，因为分段钮才是用户真正按「回管家」的那一处。
// 常量与 steward-board.js:110／steward-conversation.js:57 那两份逐字相同（各持一份同名常量，
// 不为一个字符串在域之间多拉一条 import 边；是否还相同由静态锁看住）。
export const STEWARD_FOCUS_THREAD_EVENT = 'steward:focus-thread';

export function createAppFrame({
  applyShellMode = () => 'classic',
  documentRef = globalThis.document,
  // 组合根注入：两个视角此刻指的是【同一条线程】时返回它的 id，否则空串（见 markSharedThread）。
  sharedThreadId = () => '',
  // 组合根注入：工作台此刻打开的那条线程。切回管家时拿它派 steward:focus-thread（见上）。
  workbenchThreadId = () => '',
} = {}) {
  const doc = () => documentRef || null;
  const byId = id => { try { return doc()?.getElementById(id) || null; } catch { return null; } };
  const frame = () => byId('appFrame');
  const currentMode = () => {
    try { return doc().documentElement.getAttribute('data-shell-mode') || ''; } catch { return ''; }
  };

  // ── 视角分段钮 ──────────────────────────────────────────────────────────────
  // 钮的样子【只读】 data-shell-mode（属性是唯一状态源）：切换成功没成功由 applyShellMode 说，
  // 它 fail-closed 回工作台时，这里也跟着落在工作台 —— 不存在「钮显示管家、画面是工作台」。
  function syncLensSeg() {
    const mode = currentMode() === 'steward' ? 'steward' : 'classic';
    const seg = byId('lensSeg');
    if (!seg) return mode;
    seg.dataset.on = mode;
    for (const button of seg.querySelectorAll('[data-lens]')) {
      button.setAttribute('aria-pressed', button.dataset.lens === mode ? 'true' : 'false');
    }
    return mode;
  }

  function setLens(lens) {
    const next = lens === 'steward' ? 'steward' : 'classic';
    if (next === currentMode()) return next;
    // 121-K5：切回管家【之前】记下工作台此刻那条线程 —— 切过去之后 2.0 那一侧还在，但焦点栏
    // 要的是「你刚才在看哪一条」，所以在同一拍取。
    const back = next === 'steward' ? String(workbenchThreadId() || '') : '';
    const mode = applyShellMode(next);
    syncLensSeg();
    if (mode === 'steward' && back) focusThreadInSteward(back);
    return mode;
  }

  // 派一条 steward:focus-thread：左栏（steward-board.js:1503）与抽屉都接它，把焦点换成这一条。
  // 本模块只是【派】—— 谁是焦点、焦点栏画成什么样，全在管家域，外框一个字不判。
  function focusThreadInSteward(sessionId) {
    const document_ = doc();
    if (!document_ || !sessionId) return '';
    try { document_.dispatchEvent(new CustomEvent(STEWARD_FOCUS_THREAD_EVENT, { detail: { sessionId: String(sessionId) } })); }
    catch { return ''; }   // 无 CustomEvent 的宿主
    return String(sessionId);
  }

  function toggleLens() {
    return setLens(currentMode() === 'steward' ? LENS_FORWARD : LENS_BACK);
  }

  // ── 齿轮菜单 ────────────────────────────────────────────────────────────────
  function setGearOpen(open) {
    const menu = byId('appGearMenu');
    const button = byId('appGearBtn');
    if (!menu) return false;
    menu.hidden = !open;
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
    return open;
  }
  function isGearOpen() {
    const menu = byId('appGearMenu');
    return Boolean(menu) && menu.hidden === false;
  }

  // ── 右栏抽屉（≤1180）与左栏看板密度 ─────────────────────────────────────────
  function setSideOpen(open) {
    const host = frame();
    if (!host) return false;
    host.classList.toggle('side-open', open);
    const button = byId('appSideToggleBtn');
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
    return open;
  }
  function isSideOpen() {
    const host = frame();
    return Boolean(host) && host.classList.contains('side-open');
  }
  function setRailBoard(open) {
    const host = frame();
    if (!host) return false;
    host.classList.toggle('rail-board', open);
    const button = byId('railBoardBtn');
    if (button) button.setAttribute('aria-pressed', open ? 'true' : 'false');
    return open;
  }
  function isRailBoard() {
    const host = frame();
    return Boolean(host) && host.classList.contains('rail-board');
  }

  // ── §2.7 现场保持：两条对话流的滚动位置 ─────────────────────────────────────
  const scrollTops = new Map();
  function rememberScroll(id) {
    const node = byId(id);
    if (!node) return;
    node.addEventListener('scroll', () => { scrollTops.set(id, node.scrollTop); }, { passive: true });
  }
  function restoreScroll() {
    for (const id of APP_FRAME_SCROLL_KEEPERS) {
      const node = byId(id);
      if (!node || !scrollTops.has(id)) continue;
      // 只恢复看得见的那一条：display:none 的容器写 scrollTop 是白写（它没有滚动盒）。
      if (!node.offsetParent && node.scrollHeight <= node.clientHeight) continue;
      node.scrollTop = scrollTops.get(id);
    }
  }

  function bindAppFrame() {
    const document_ = doc();
    if (!document_) return '';
    for (const id of APP_FRAME_SCROLL_KEEPERS) rememberScroll(id);
    const seg = byId('lensSeg');
    if (seg) {
      for (const button of seg.querySelectorAll('[data-lens]')) {
        button.onclick = () => setLens(button.dataset.lens);
      }
    }
    const gear = byId('appGearBtn');
    if (gear) gear.onclick = () => setGearOpen(!isGearOpen());
    const side = byId('appSideToggleBtn');
    if (side) side.onclick = () => setSideOpen(!isSideOpen());
    const board = byId('railBoardBtn');
    if (board) board.onclick = () => setRailBoard(!isRailBoard());
    setGearOpen(false);

    // 点菜单【外】任意处收起（捕获阶段：同一次点击里另一枚按钮可能正要打开它自己的浮层）。
    document_.addEventListener('mousedown', event => {
      if (!isGearOpen()) return;
      const wrap = byId('appGearBtn')?.closest('.app-gear-wrap');
      const target = event && event.target;
      if (wrap && target && wrap.contains(target)) return;
      setGearOpen(false);
    }, true);

    document_.addEventListener('keydown', event => {
      if (!event) return;
      // Ctrl+`：切视角（§2.2）。两视角互为对方的目标，所以不需要记方向。
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === '`') {
        event.preventDefault();
        toggleLens();
        return;
      }
      // Ctrl+K：左栏搜索（§2.3）。搜索框就是 2.0 那一个（#sessionSearch），不是第二个控件。
      if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'k') {
        const input = byId('sessionSearch');
        if (input) { event.preventDefault(); input.focus(); input.select?.(); }
        return;
      }
      if (event.key === 'Escape' && isGearOpen()) { event.stopPropagation(); setGearOpen(false); }
    });

    // 视角由别处切走时（设置里的「启动默认视角」、fail-closed 回退、「在工作台打开」）钮跟着对一次，
    // 并把这一侧对话流的滚动位置恢复回去（§2.7）。两件事同一路信号，都是「只读属性、不写属性」。
    if (globalThis.MutationObserver && document_.documentElement) {
      new MutationObserver(() => { syncLensSeg(); restoreScroll(); })
        .observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    return syncLensSeg();
  }

  // §2.9 表第五行：共享元素变形【只在焦点线程＝将要选中的那条线程时】起名字。
  // 本模块不认识「谁是焦点」——那是管家域（focusThreadId）与组合根（state.currentSession）
  // 的事实，所以由组合根注入一个「这两边此刻指的是不是同一条线程」的判据（sharedThreadId）。
  // 名字挂在两侧那两个标题节点上：管家侧是焦点卡的标题（#stewardDrawerTitle），工作台侧是线程头
  // 的标题（#sessionTitle）。同一帧里只有一个视角在显示，所以两个名字各自唯一。
  function markSharedThread() {
    const shared = String(sharedThreadId() || '');
    if (!shared) return () => {};
    const nodes = ['stewardDrawerTitle', 'sessionTitle'].map(byId).filter(Boolean);
    if (nodes.length < 2) return () => {};
    for (const node of nodes) node.style.viewTransitionName = 'thread-title';
    return () => { for (const node of nodes) node.style.viewTransitionName = ''; };
  }

  return Object.freeze({
    bindAppFrame,
    markSharedThread,
    focusThreadInSteward,
    setLens,
    toggleLens,
    syncLensSeg,
    setGearOpen,
    isGearOpen,
    setSideOpen,
    isSideOpen,
    setRailBoard,
    isRailBoard,
  });
}
