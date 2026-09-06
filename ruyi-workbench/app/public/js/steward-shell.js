'use strict';

// 第117波 117a：管家壳（第三种壳模式 steward）的模式与容器骨架。
//
// 范式与 preview-shell.js 一致：一个注入依赖的工厂、一份冻结导出、零 innerHTML、零默认后台税。
// 边界（117a 只做这些）：
//   · 只负责「能不能进管家壳」与「进不去时怎么体面地回经典」，不做 avatar／对话／递话／抽屉／看板（117b–h）。
//   · 不发任何请求（注入的 `api` 在 117a 全程未被调用，留作 117c 起的接线口），不起任何 timer
//     （本文件零轮询、零延时回调，静态锁按源码里不出现那两个计时 API 来判）——「开关关时零后台活动」是 27 号文 §3.4 的红线。
//   · `data-shell-mode` 是唯一状态源；本文件写它的地方只有 recoverStewardShell 这一处 fail-closed 回退，
//     正常进入由 preview-shell.js 的 applyShellMode 单点写入。
//
// fail-closed 三分支（recoverStewardShell）：
//   ① 管家开关关（`state.config.stewardEnabledV1 !== true`）；
//   ② 容器或四个空位缺失（骨架没上线／被裁剪的离线包）；
//   ③ 模块依赖缺失（组合根没把 applyShellMode／t 注进来）。
// `canEnterSteward()` 只看 ①②（③ 在依赖缺失时根本走不到准入判断，见工厂开头的早退）。

export const STEWARD_SHELL_SLOT_IDS = Object.freeze([
  'stewardHeader',
  'stewardFeed',
  'stewardComposer',
  'stewardStatus',
]);

// 骨架齐备 = 同级容器在，且四个空位都在。纯 DOM 判定，无副作用，测试与 UI 共用同一口径。
export function stewardShellDomReady(doc = globalThis.document) {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  if (!doc.getElementById('stewardShell')) return false;
  return STEWARD_SHELL_SLOT_IDS.every(id => Boolean(doc.getElementById(id)));
}

// 管家开关：读的是 GET /api/status 回来的 config（provider-settings.refreshStatus 落进 state.config）。
// 后端零改动 —— `stewardEnabledV1` 本来就在 maskProviders(config) 的输出里。
export function stewardEnabledInConfig(config) {
  return Boolean(config) && config.stewardEnabledV1 === true;
}

export function createStewardShellDomain({
  // api / closeSettings / now 在 117a 全程未被调用：按 preview-shell 的注入形状先把口子留好，
  // 117c 起的管家对话（取数、切壳后关设置、消息时间戳）直接接在这三个上，不必再动组合根。
  api = async () => null,
  state = null,
  t = key => key,
  applyShellMode = null,
  closeSettings = () => {},
  now = () => new Date(),
} = {}) {
  const byId = id => (globalThis.document ? globalThis.document.getElementById(id) : null);
  const setStatusText = key => {
    const node = byId('stewardStatus');
    if (node) node.textContent = t(key);
  };
  const setStoredMode = mode => {
    try { localStorage.setItem('wcw.shellMode', mode); } catch { /* local preference may be unavailable */ }
  };
  const storedMode = () => {
    try { return localStorage.getItem('wcw.shellMode') || ''; }
    catch { return ''; }
  };
  const syncModeSelector = mode => {
    const select = byId('cfgShellMode');
    if (select) select.value = mode;
  };

  // ③ 模块依赖缺失：没有 applyShellMode 就没有单一写入点，此时唯一安全的动作是把壳钉死在经典。
  const dependenciesReady = typeof applyShellMode === 'function' && typeof t === 'function';

  function recoverStewardShell({ persist = true } = {}) {
    try { globalThis.document?.documentElement?.setAttribute('data-shell-mode', 'classic'); } catch { /* pre-DOM failure */ }
    if (persist) setStoredMode('classic');
    try { syncModeSelector('classic'); } catch { /* pre-DOM failure */ }
    try {
      if (!dependenciesReady) setStatusText('stewardShell.recovery.dependency'); // ③
      else if (!stewardShellDomReady()) setStatusText('stewardShell.recovery.missingShell'); // ②
      else setStatusText('stewardShell.recovery.disabled'); // ①
    } catch { /* pre-DOM failure */ }
    return 'classic';
  }

  if (!dependenciesReady) {
    recoverStewardShell();
    return Object.freeze({
      bindStewardShell: () => 'classic',
      canEnterSteward: () => false,
      isStewardMode: () => false,
      recoverStewardShell,
      syncStewardShellAvailability: () => 'classic',
    });
  }

  function isStewardMode() {
    return globalThis.document?.documentElement?.getAttribute('data-shell-mode') === 'steward';
  }

  // 准入只看 ①②（27 号文 117a 设计）：开关开着、骨架齐备，才允许进管家壳。
  function canEnterSteward() {
    return stewardEnabledInConfig(state && state.config) && stewardShellDomReady();
  }

  // 设置页第三项的可选性随管家开关走：关时置灰并把「先打开管家」那句提示显出来。
  function syncSettingOption() {
    const enabled = stewardEnabledInConfig(state && state.config);
    const option = byId('cfgShellMode')?.querySelector('option[value="steward"]');
    if (option) option.disabled = !enabled;
    const hint = byId('stewardShellModeHint');
    if (hint) hint.hidden = enabled;
    return enabled;
  }

  // 组合根在 refreshStatus() 之后调用一次：config 到达前谁也不知道开关开没开，所以 bind 期的
  // 准入判断一律不落盘（persist:false，只把画面钉在经典）；真正把本机偏好改回 classic 的是这里。
  function syncStewardShellAvailability() {
    syncSettingOption();
    if (canEnterSteward()) {
      if (storedMode() === 'steward' && !isStewardMode()) return applyShellMode('steward', { persist: false, focus: false });
      return isStewardMode() ? 'steward' : 'classic';
    }
    if (isStewardMode() || storedMode() === 'steward') return recoverStewardShell();
    return 'classic';
  }

  function bindStewardShell() {
    const classic = byId('stewardClassicBtn');
    if (classic) classic.onclick = () => applyShellMode('classic');
    syncSettingOption();
    // 117a 无状态、无订阅、无 timer：绑定完就结束。
    return isStewardMode() ? 'steward' : 'classic';
  }

  return Object.freeze({
    bindStewardShell,
    canEnterSteward,
    isStewardMode,
    recoverStewardShell,
    syncStewardShellAvailability,
  });
}
