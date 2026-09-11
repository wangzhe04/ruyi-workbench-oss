'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// shell-mode.js — 视角模式的唯一登记表 + `data-shell-mode` 的唯一常规写者（121 波 K1，34 号文 §8.2）。
//
// 121 波之前这三样东西住在 js/preview-shell.js 里（SHELL_MODE_STORAGE_KEY:39 / SHELL_MODES:41 /
// normalizeShellMode:46 / applyShellMode:379 / recoverClassicShell:107），于是「管家壳能不能起来」
// 反过来依赖交办台那 3657 行。交办台退役（§8.1）后它们搬到这片叶子上：零 DOM 业务、零 i18n、
// 只认两件事 —— 现在是哪个视角、怎么体面地切过去。
//
// 一台两视（§2.7）：`data-shell-mode` 只剩两值。
//   · steward = 管家视角（默认；34 号文 §8.4 拍板③）
//   · classic = 工作台视角（原经典壳 .app-shell）
// 三个归一化口径【必须同构】，这也是 K1 收掉的那笔账（K0 交付时预绘落 steward、normalizeShellMode
// 落 classic，两边不同构，见 34 号文 §13.1 末尾）：
//   · 没存过偏好 / 存了未知值 / localStorage 抛异常 → steward
//   · 显式存了 classic → classic
//   · 老用户存的 'preview'（已退役的交办台）→ steward，并【就地改写本机偏好】，不留死值
// index.html 的预绘脚本是同一条规则的另一份实现（它必须在模块加载前跑，无法 import），
// dev-harness/steward-shell.static.e2e.js 的 A3 钉着两边同构。
//
// fail-closed 不在本文件：管家能不能进由 steward-shell.js 的 canEnterSteward() 判（开关
// stewardEnabledV1 + 骨架齐备），进不去时由它的 recoverStewardShell() 回经典。本文件只在
// applyShellMode 里问一次、拿到否定答复就把控制权交出去 —— 缺省注入即 fail-closed。
// ─────────────────────────────────────────────────────────────────────────────

export const SHELL_MODE_STORAGE_KEY = 'wcw.shellMode';
// 顺序即语义顺序（默认在前），别重排。
export const SHELL_MODES = Object.freeze(['steward', 'classic']);
// 退役模式 → 现在该落在哪个视角。读到它的人负责把本机偏好一并改写（见 readStoredShellMode）。
export const RETIRED_SHELL_MODES = Object.freeze({ preview: 'steward' });

export function normalizeShellMode(value) {
  const text = String(value == null ? '' : value);
  if (SHELL_MODES.includes(text)) return text;
  return RETIRED_SHELL_MODES[text] || 'steward';
}

// 读本机偏好。读到退役值/未知值时【就地改写】成归一化后的值：偏好里不留死值，
// 下游（steward-shell.js 的 storedMode()）因此永远只会见到 SHELL_MODES 里的两个字符串或空串。
export function readStoredShellMode(storage = globalThis.localStorage) {
  let raw = '';
  try { raw = storage?.getItem(SHELL_MODE_STORAGE_KEY) || ''; } catch { raw = ''; }
  const mode = normalizeShellMode(raw);
  if (raw && raw !== mode) {
    try { storage?.setItem(SHELL_MODE_STORAGE_KEY, mode); } catch { /* local preference may be unavailable */ }
  }
  return mode;
}

// 121-K4（34 号文 §2.9）：切视角要走 View Transitions。两条判据每次【现问】，不在模块加载时
// 缓存：`prefers-reduced-motion` 是用户随时能改的系统设置（e2e 也用 CDP 现场改它来验「零动画」），
// 缓存一次等于把第一帧的答案当永久答案。
export function prefersReducedMotion(win = globalThis) {
  try { return Boolean(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch { return false; }
}
export function viewTransitionsSupported(doc = globalThis.document) {
  return Boolean(doc && typeof doc.startViewTransition === 'function');
}

export function createShellModeController({
  // 117a 起的准入契约原样搬过来：缺省值即 fail-closed（准入恒 false，永远进不去管家视角）。
  canEnterSteward = () => false,
  recoverStewardShell = () => '',
  closeSettings = () => {},
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  // 121-K4（§2.9 表第五行）：共享元素变形要在【拍下旧帧之前】给两侧那两个节点起同一个名字，
  // 而「焦点线程是不是就是将要选中的那条线程」这件事本模块不认识（它住在管家域与组合根手里）。
  // 所以开一个钩子：返回一个清理函数，动画收尾时调它把名字摘掉。缺省是空操作 —— 不注入就只有
  // 中栏平移与右栏淡入淡出，不会有半个共享元素。
  markSharedThread = () => () => {},
} = {}) {
  const byId = id => {
    try { return documentRef?.getElementById(id) || null; } catch { return null; }
  };

  function syncModeControl(mode) {
    const select = byId('cfgShellMode');
    if (select) select.value = mode;
  }

  function setStoredShellMode(mode) {
    try { storage?.setItem(SHELL_MODE_STORAGE_KEY, mode); } catch { /* local preference may be unavailable */ }
  }

  function currentShellMode() {
    try { return documentRef.documentElement.getAttribute('data-shell-mode') || ''; }
    catch { return ''; }
  }

  // 121-K4（§2.9）：把「改属性」这一下包进 View Transitions。照抄原型 `transition(fn, dir)` 的逻辑
  // （docs/mockups/one-workbench-two-views.html:794）：
  //   · 不支持 startViewTransition、或 prefers-reduced-motion: reduce → 【即时切换、零动画】；
  //   · 方向写在 :root 的 data-vt 上（fwd＝管家→工作台向左进入，back＝工作台→管家向右退回），
  //     样式层只用它挑中栏那两条 keyframes；动画收尾即删（不留状态）。
  // 时长／缓动全部走 token，命名部件与关掉 root 默认交叉淡入都在 css/layout.css 一处。
  function runShellTransition(write, direction) {
    const root = (() => { try { return documentRef.documentElement; } catch { return null; } })();
    if (!root || !viewTransitionsSupported(documentRef) || prefersReducedMotion()) { write(); return false; }
    let cleanupShared = () => {};
    try { cleanupShared = markSharedThread() || (() => {}); } catch { cleanupShared = () => {}; }
    try { root.dataset.vt = direction; } catch { /* 属性写不上不影响切换本身 */ }
    const settle = () => {
      try { delete root.dataset.vt; } catch { /* ignore */ }
      try { cleanupShared(); } catch { /* ignore */ }
    };
    let transition = null;
    try { transition = documentRef.startViewTransition(write); }
    catch { write(); settle(); return false; }
    if (transition && transition.finished && typeof transition.finished.then === 'function') {
      transition.finished.then(settle, settle);
    } else settle();
    return true;
  }

  // 全仓写 data-shell-mode 的唯一常规入口（另外两处：index.html 预绘脚本、steward-shell.js 的
  // fail-closed 回退。静态锁 steward-shell.static.e2e.js A4 钉着这张写者表）。
  // 各视角的落焦锚点（管家 = 同级容器，工作台 = 会话标题）。设置弹窗那条路要落在别处
  // （工作台 = 输入框），所以锚点可以由调用方整张换掉 —— 换的是【表】，不是落焦的时机。
  const SHELL_FOCUS_ANCHORS = Object.freeze({ steward: 'stewardShell', classic: 'sessionTitle' });

  function applyShellMode(value, { persist = true, focus = true, focusAnchors = SHELL_FOCUS_ANCHORS } = {}) {
    const mode = normalizeShellMode(value);
    if (mode === 'steward' && !canEnterSteward()) return recoverStewardShell({ persist }) || 'classic';
    const write = () => {
      try { documentRef.documentElement.setAttribute('data-shell-mode', mode); } catch { /* pre-DOM failure */ }
      syncModeControl(mode);
      // 落焦【必须】排在写完属性之后：要落焦的那个容器是刚刚才变成可见的那一个。
      // 121-K4-3：修前这一下挂在 requestAnimationFrame 上，而 View Transitions 的 update 回调
      // 比【同一帧的 rAF 还晚】（规范里它发生在「更新渲染」那一步里），于是 focus() 那一刻目标
      // 容器还在 display:none 里 —— 一次白调，焦点留在 body（steward-shell.e2e 的 D3／D5 实测）。
      // 收进写回调之后，两条路（走动画与不走动画）的时序逐字相同：写属性 → 对控件 → 落焦。
      if (focus) {
        const anchor = mode === 'steward' ? focusAnchors.steward : focusAnchors.classic;
        try { byId(anchor)?.focus?.(); } catch { /* 宿主没有 focus 的环境 */ }
      }
    };
    // 真换了视角才走动画：同一个值再写一遍（bind 期对表、config 到达后的补判）不该闪一下。
    // 切换本身不触发任何数据拉取：需要重画的子域（管家壳/看板/抽屉）各自观察属性变化。
    if (mode === currentShellMode()) write();
    else runShellTransition(write, mode === 'steward' ? 'back' : 'fwd');
    if (persist) setStoredShellMode(mode);
    return mode;
  }

  // 依赖缺失（组合根没把管家壳接进来）时唯一安全的动作：把视角钉在工作台。
  // 它走的是 applyShellMode 自己那条路（mode !== 'steward'，不会递归回准入判定），
  // 所以本文件写 data-shell-mode 的地方【仍然只有一处】。
  function recoverClassicShell() {
    return applyShellMode('classic', { focus: false });
  }

  function bindShellModeControl() {
    const selector = byId('cfgShellMode');
    if (selector) {
      // 属性是唯一状态源：绑定时按当前实况对一次表，控件与画面不脱钩。
      let current = 'classic';
      try { current = documentRef.documentElement.getAttribute('data-shell-mode') || ''; } catch { current = ''; }
      syncModeControl(normalizeShellMode(current));
      selector.onchange = event => {
        // 121-K4-3：【先】关设置弹窗，【再】切视角。关弹窗本身会动焦点（它要把焦点交回触发它的
        // 那个控件），而落焦现在收在 applyShellMode 的写回调里 —— 次序反了的话，不走动画的那一路
        // （reduced-motion／不支持 VT）会被关弹窗把刚落好的焦点抢走。
        // 锚点表在这里整张换掉：设置里切过来，工作台那一侧该落在输入框（人刚说完「我要用经典」）。
        closeSettings();
        return applyShellMode(event.target.value, {
          focusAnchors: { steward: 'stewardShell', classic: 'promptInput' },
        });
      };
    }
    // 首屏：预绘脚本已经写下属性，这里按本机偏好再过一次准入。config 还没到时 canEnterSteward()
    // 恒 false，于是 fail-closed 到工作台；config 到达后由 steward-shell.js 的
    // syncStewardShellAvailability() 补判一次真正进哪个视角（34 号文 §13.1 记过这条时序）。
    // persist:false —— 这一拍的判定不许改写用户的本机偏好。
    return applyShellMode(readStoredShellMode(storage), { persist: false, focus: false });
  }

  return Object.freeze({
    applyShellMode,
    bindShellModeControl,
    recoverClassicShell,
    storedShellMode: () => readStoredShellMode(storage),
    syncModeControl,
  });
}
