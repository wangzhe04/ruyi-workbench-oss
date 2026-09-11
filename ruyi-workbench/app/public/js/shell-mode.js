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

export function createShellModeController({
  // 117a 起的准入契约原样搬过来：缺省值即 fail-closed（准入恒 false，永远进不去管家视角）。
  canEnterSteward = () => false,
  recoverStewardShell = () => '',
  closeSettings = () => {},
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
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

  // 全仓写 data-shell-mode 的唯一常规入口（另外两处：index.html 预绘脚本、steward-shell.js 的
  // fail-closed 回退。静态锁 steward-shell.static.e2e.js A4 钉着这张写者表）。
  function applyShellMode(value, { persist = true, focus = true } = {}) {
    const mode = normalizeShellMode(value);
    if (mode === 'steward' && !canEnterSteward()) return recoverStewardShell({ persist }) || 'classic';
    try { documentRef.documentElement.setAttribute('data-shell-mode', mode); } catch { /* pre-DOM failure */ }
    syncModeControl(mode);
    if (persist) setStoredShellMode(mode);
    // 各视角的落焦锚点（管家 = 同级容器，工作台 = 会话标题）。切换本身不触发任何数据拉取：
    // 需要重画的子域（管家壳/看板/抽屉/返回带）各自观察 data-shell-mode 的属性变化。
    if (focus && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => byId(mode === 'steward' ? 'stewardShell' : 'sessionTitle')?.focus?.());
    }
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
        const mode = applyShellMode(event.target.value, { focus: false });
        closeSettings();
        // 设置弹窗关掉之后落焦到各视角自己的活干处（管家 = 容器，工作台 = 输入框）。
        const anchorId = mode === 'steward' ? 'stewardShell' : 'promptInput';
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => byId(anchorId)?.focus?.());
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
