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

export function createAppFrame({
  applyShellMode = () => 'classic',
  documentRef = globalThis.document,
  // 组合根注入：两个视角此刻指的是【同一条线程】时返回它的 id，否则空串（见 markSharedThread）。
  sharedThreadId = () => '',
  // 128d（K6b）：「最后一次意图」—— 过渡在飞时属性还是旧值，切到另一边要按意图算（shell-mode.js intendedShellMode）。
  // 不注入就退回读属性（与改前逐字相同）。
  intendedMode = null,
} = {}) {
  const doc = () => documentRef || null;
  const byId = id => { try { return doc()?.getElementById(id) || null; } catch { return null; } };
  const frame = () => byId('appFrame');
  const currentMode = () => {
    try { return doc().documentElement.getAttribute('data-shell-mode') || ''; } catch { return ''; }
  };
  const nextFromMode = () => { try { return (typeof intendedMode === 'function' && intendedMode()) || currentMode(); } catch { return currentMode(); } };

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
    // 122-L1b（36 号文 §5.2 L1a 登记 → 本刀）：这里原先有一句 `if (next === currentMode()) return next;`
    // 的**同值早退**，是一条真产品债。现场：开机那两秒里画面按 fail-closed 停在工作台
    // （预绘写 steward → bindShellModeControl 那一判 config 还没到、canEnterSteward() 恒 false →
    // 回落 classic），用户此刻点分段钮「工作台」—— 值相同，于是这一下被整个吞掉：
    // applyShellMode 没跑、本机偏好没写；等 config 到了，syncStewardShellAvailability 看见
    // storedMode() 不是 classic，按默认落点把画面翻成管家。用户明明点过，还是被翻走了。
    // 修法：无条件往下走。同值那一路 applyShellMode 内部本来就走【同步支】（不进 View Transitions，
    // 不闪一下），而这是一次**显式选择**，本来就该持久化 —— 早退省下的那点开销换来的是一次失灵。
    // 钉在 walkthrough-round2 的 E 组（扣住 /api/status，扣住期间点「工作台」）。
    // 121-K5 复核（34 号文 §13.8）：分段钮是【全局视角开关】，不是退役的 steward-classic-window.js
    // 那枚「回到管家（看这条）」按钮——切回管家时【不】把焦点换成工作台此刻那条线程。§2.1 第 11 条
    // 「切回管家视角时对话流、焦点任务、滚动位置原样」与 §2.7 第三条「每个视角记住自己的现场」
    // 是这一处的口径；§2.7 第一条里「派 steward:focus-thread」说的是 backToSteward 那枚按钮的语义，
    // 按钮已随返回带退役。K4 的 one-workbench-frame K6 钉的就是这一条（K5 第一版在这里派过一发，
    // 全量逮到）。
    const mode = applyShellMode(next);
    syncLensSeg();
    return mode;
  }

  function toggleLens() {
    return setLens(nextFromMode() === 'steward' ? LENS_FORWARD : LENS_BACK);
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
  // 128d(48 号文 §1,keyboard-walkthrough K4／simple-mode S4f 查出):它自称 role="menu"(读屏据此进「菜单模式」、
  // 等方向键),修前却只认鼠标 —— 键盘打开后焦点留在齿轮钮上、方向键无反应;而且按下「设置」之后菜单还开在
  // 弹窗后面,于是下面那条 Esc(document 上、stopPropagation)先把这张看不见的菜单收了,弹窗要按第二下 Esc 才关。
  // 补的是 WAI-ARIA 菜单按钮模式的最小一组:键盘打开 → 焦点进第一项;↓/↑ 循环、Home/End 到头尾;Esc 收起并把
  // 焦点还给齿轮钮;Tab 离开即收起;按下一项即收起(带子浮层的两项除外 —— 它们的浮层以自己为锚点)。
  function gearItems() {
    const menu = byId('appGearMenu');
    if (!menu) return [];
    return [...menu.querySelectorAll('[role="menuitem"]')].filter(node => !node.disabled && !node.hidden && node.offsetParent !== null);
  }
  function focusGearItem(index) {
    const items = gearItems();
    if (!items.length) return false;
    items[((index % items.length) + items.length) % items.length].focus();
    return true;
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
    if (gear) {
      // click 的 detail 为 0 ＝ 由 Enter／空格触发(键盘);鼠标点开不挪焦点,与改前一致。
      gear.onclick = event => { const open = setGearOpen(!isGearOpen()); if (open && event && event.detail === 0) focusGearItem(0); };
      gear.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        setGearOpen(true);
        focusGearItem(event.key === 'ArrowDown' ? 0 : -1);
      });
    }
    const gearMenu = byId('appGearMenu');
    if (gearMenu) {
      gearMenu.addEventListener('keydown', event => {
        const at = gearItems().indexOf(document_.activeElement);
        if (event.key === 'ArrowDown') { event.preventDefault(); focusGearItem(at + 1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); focusGearItem(at < 0 ? -1 : at - 1); }
        else if (event.key === 'Home') { event.preventDefault(); focusGearItem(0); }
        else if (event.key === 'End') { event.preventDefault(); focusGearItem(-1); }
      });
      // Tab 在项间照走(walkthrough-round2 D6 更早钉下的「从齿轮钮起连按 Tab 走遍七项」);焦点【走出】菜单才收起
      // (回到齿轮钮不算走出)。128d 首版按 APG 做成「Tab 即收」,全量回归里 D6 红了 —— 让步给先拍板的那一条。
      // relatedTarget 为空(窗口失焦、点到不可聚焦处)不动:点空白处由外部点击那条逻辑收。
      gearMenu.addEventListener('focusout', event => {
        const to = event.relatedTarget;
        if (!to || !isGearOpen() || gearMenu.contains(to) || to === gear) return;
        setGearOpen(false);
      });
      gearMenu.addEventListener('click', event => {
        const item = event.target && event.target.closest ? event.target.closest('[role="menuitem"]') : null;
        if (item && !item.hasAttribute('aria-haspopup')) setGearOpen(false);
      });
    }
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
      if (event.key === 'Escape' && isGearOpen()) {
        event.stopPropagation();
        const menu = byId('appGearMenu');
        const inside = Boolean(menu) && menu.contains(document_.activeElement);
        setGearOpen(false);
        if (inside) byId('appGearBtn')?.focus();   // 焦点在菜单里时收起,不能让它跟着藏起来的项一起掉到 body 上
      }
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
    // 兜底（用户 2026-09-14 走查）：两边印的不是同一串字时不挂名。管家侧印的是服务端算好的
    // displayTitle（steward-drawer.js 的 renderHead），工作台侧印的是 session.title 原话
    // （session-experience.js 的 renderCurrentSession）—— 两串不同的字按「同一个东西」变形叠化，
    // 中途换人比不飞更糟；退回中栏整体的淡入淡出即可。
    const [from, to] = nodes;
    if (String(from.textContent || '').trim() !== String(to.textContent || '').trim()) return () => {};
    for (const node of nodes) node.style.viewTransitionName = 'thread-title';
    return () => { for (const node of nodes) node.style.viewTransitionName = ''; };
  }

  return Object.freeze({
    bindAppFrame,
    markSharedThread,
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
