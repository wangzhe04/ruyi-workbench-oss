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

export function createAppFrame({
  applyShellMode = () => 'classic',
  documentRef = globalThis.document,
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
    const mode = applyShellMode(next);
    syncLensSeg();
    return mode;
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

  function bindAppFrame() {
    const document_ = doc();
    if (!document_) return '';
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

    // 视角由别处切走时（设置里的「启动默认视角」、fail-closed 回退、「在工作台打开」）钮跟着对一次。
    if (globalThis.MutationObserver && document_.documentElement) {
      new MutationObserver(syncLensSeg)
        .observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    return syncLensSeg();
  }

  return Object.freeze({
    bindAppFrame,
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
