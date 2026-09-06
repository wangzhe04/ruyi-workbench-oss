'use strict';

import { derivePresence, presenceLabelKey } from './steward-presence.js';
import { createStewardConversation } from './steward-conversation.js';
import { createStewardComposer } from './steward-composer.js';
import { createStewardDrawer, STEWARD_NEW_THREAD_EVENT } from './steward-drawer.js';

// 第117波 117a/117b/117c：管家壳（第三种壳模式 steward）的模式与容器骨架 + avatar 状态派生
// + 对话区与递话（后两者的实现住 steward-conversation.js / steward-composer.js，本文件只做组装与
// 依赖注入 —— 组合根 app.js 因此净增 0 行，D45 余量未动）。
//
// 范式与 preview-shell.js 一致：一个注入依赖的工厂、一份冻结导出、零 innerHTML。
// 边界（117a 定的，117b 仍然遵守）：
//   · 只负责「能不能进管家壳」「进不去时怎么体面地回经典」「avatar 现在是什么态」，不做对话／递话／
//     抽屉／看板（117c–h）。
//   · `data-shell-mode` 是唯一状态源；本文件写它的地方只有 recoverStewardShell 这一处 fail-closed 回退，
//     正常进入由 preview-shell.js 的 applyShellMode 单点写入。
//
// fail-closed 三分支（recoverStewardShell）：
//   ① 管家开关关（`state.config.stewardEnabledV1 !== true`）；
//   ② 容器或四个空位缺失（骨架没上线／被裁剪的离线包）；
//   ③ 模块依赖缺失（组合根没把 applyShellMode／t 注进来）。
// `canEnterSteward()` 只看 ①②（③ 在依赖缺失时根本走不到准入判断，见工厂开头的早退）。
//
// 117b 新增的唯一后台活动——avatar 的 GET /api/steward/state 轮询——受严格的模式门控（27 号文 §3.4
// 红线「开关关时零后台活动」的延伸：这里收紧成「非管家模式时零后台活动」）：
//   · 本文件只有一处 setInterval（startPolling）与一处 clearInterval（stopPolling），两者只经
//     syncPolling() 调用，而 syncPolling() 的第一件事永远是 isStewardMode() 判定 —— 判定为否就
//     stopPolling()，不会有任何计时器存活。
//   · syncPolling() 的触发点：①MutationObserver 盯着 documentElement 的 data-shell-mode 属性
//     （谁改的都算——select、「回到经典」按钮、fail-closed 回退、未来任何新入口，零遗漏）；
//     ②document 的 visibilitychange（标签页隐藏即暂停，见回来即恢复，若仍在管家模式）；
//     ③bindStewardShell() 绑定完的那一刻（覆盖「页面直接以 data-shell-mode=steward 启动」这个
//     MutationObserver 观察不到的初始态）。
//   · MutationObserver 本身不是 setInterval/setTimeout，不在「零 timer」的字面禁令内，且哪怕它在非
//     管家模式下常驻，callback 触发时的第一动作也是关计时器，不产生任何轮询或请求。

export const STEWARD_SHELL_SLOT_IDS = Object.freeze([
  'stewardHeader',
  'stewardFeed',
  'stewardComposer',
  'stewardStatus',
]);

// 管家状态轮询周期：跟 01-config.js 的 stewardPollMs 校验同一 clamp 下限(5000)，上限交给后端
// (config 已经 clamp 过一次，这里只防「配置还没到达/被清空」时退回 15000 默认值)。
const STEWARD_POLL_MS_DEFAULT = 15000;
const STEWARD_POLL_MS_MIN = 5000;

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
  // 117d：抽屉的「2.0 视窗」要「切到经典壳并选中该会话」，openSession 是经典壳既有的那一个
  // （session-experience.js 导出，preview-shell 的 openSelectedInClassic 用的也是它）。
  openSession = async () => {},
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
      // 依赖缺失时壳整体 fail-closed 到经典，avatar 无处可画；derive 仍是纯函数原样导出
      // （§8.1 原则5「可退化」：调用方拿到的形状不变，只是永远读到 sleeping）。
      presence: Object.freeze({ derive: derivePresence, set: () => 'sleeping', current: () => 'sleeping' }),
      // 依赖缺失时抽屉也开不出来（它要 applyShellMode 才能切 2.0 视窗）：给一个同形的空壳，
      // 调用方（117h）拿到的键集不变，只是永远打不开。
      drawer: Object.freeze({ openThread: () => {}, closeDrawer: () => {}, isOpen: () => false }),
    });
  }

  function isStewardMode() {
    return globalThis.document?.documentElement?.getAttribute('data-shell-mode') === 'steward';
  }

  // 准入只看 ①②（27 号文 117a 设计）：开关开着、骨架齐备，才允许进管家壳。
  function canEnterSteward() {
    return stewardEnabledInConfig(state && state.config) && stewardShellDomReady();
  }

  // ── 117b：avatar 状态派生（§8.3）与状态轮询 ────────────────────────────────────
  const presenceInputs = {
    enabled: false, stopped: false, inflight: '', phase: 'idle', streaming: false,
    lastError: '', pendingCount: 0, needsYouCount: 0, typing: false,
  };
  let presenceState = derivePresence(presenceInputs);

  // data-state + 一次性类(.pulse/.shake) + aria-live 文字，三处一次写完。一次性类只在真正
  // 「切换到」那个状态的那一刻补上(entering 判定)，同一状态内的后续 setPresenceInputs(例如轮询
  // 又拿到一次 lastReply.error 相同的响应)不会打断正在播的动效。
  function renderPresence() {
    const next = derivePresence(presenceInputs);
    const entering = next !== presenceState;
    presenceState = next;
    const avatar = byId('stewardAvatar');
    if (avatar) {
      avatar.dataset.state = next;
      if (entering) {
        avatar.classList.remove('pulse', 'shake');
        if (next === 'waiting_you') { void avatar.offsetWidth; avatar.classList.add('pulse'); }
        else if (next === 'error') { void avatar.offsetWidth; avatar.classList.add('shake'); }
      }
    }
    const text = byId('stewardPresenceText');
    if (text) text.textContent = t(presenceLabelKey(next), { detail: '' });
    return next;
  }

  function setPresenceInputs(patch) {
    if (patch && typeof patch === 'object') Object.assign(presenceInputs, patch);
    return renderPresence();
  }

  // GET /api/steward/state 没有独立的 pending 字段(13h-steward-runner.js stewardRunnerState 只有
  // stopped/inflight/circuit/lastReply/queued/noProgress/arbiter)。117b 曾借 lastReply.acts 非空近似
  // 「有提议待批」；117c 改接真值 —— POST /api/steward/visit 回的 `pending[]` 就是仍待决的提议清单，
  // 由 steward-conversation.js 的 enterVisit() 直接写进 presence.pendingCount(每次进壳刷新一次)。
  // 轮询这一路因此【不再】碰 pendingCount，只管 stopped/inflight/lastError 三个真有的字段。
  function pollStewardState() {
    if (typeof api !== 'function') return;
    Promise.resolve(api('/api/steward/state')).then(response => {
      if (!response || typeof response !== 'object') return;
      const lastReply = (response.lastReply && typeof response.lastReply === 'object') ? response.lastReply : null;
      setPresenceInputs({
        stopped: response.stopped === true,
        inflight: typeof response.inflight === 'string' ? response.inflight : '',
        lastError: (lastReply && lastReply.error) ? String(lastReply.error) : '',
      });
    }).catch(() => { /* 状态面不因单次轮询失败整条消失，下一轮再试 */ });
  }

  function pollIntervalMs() {
    const raw = Number(state && state.config && state.config.stewardPollMs);
    return Number.isFinite(raw) && raw > 0 ? Math.max(STEWARD_POLL_MS_MIN, raw) : STEWARD_POLL_MS_DEFAULT;
  }

  let pollTimer = 0;
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  function startPolling() {
    if (pollTimer) return;
    pollStewardState();
    pollTimer = setInterval(pollStewardState, pollIntervalMs());
  }
  // 唯一入口：轮询该开该关只由这一个判定决定——管家模式 且 页面可见。本文件别处一律不直接调
  // startPolling/stopPolling，只调 syncPolling（源码正则锚，见 dev-harness/steward-avatar.static.e2e.js）。
  function syncPolling() {
    if (isStewardMode() && !(globalThis.document && globalThis.document.hidden)) startPolling();
    else stopPolling();
  }

  // typing 由输入框驱动 + 轮询/属性变化的两个触发点各接一次，绑定完立刻按当前实况刷一次
  // （覆盖「页面直接以 data-shell-mode=steward 启动」这个 MutationObserver 观察不到的初始态）。
  function bindPresence() {
    const input = byId('stewardComposerInput');
    if (input) {
      input.disabled = false; // 117b：可聚焦但仍不发送(发送归 117c)，仅用来测 listening 态
      const setTyping = () => setPresenceInputs({ typing: input.value.trim().length > 0 });
      input.addEventListener('input', setTyping);
      input.addEventListener('focus', setTyping);
      input.addEventListener('blur', () => setPresenceInputs({ typing: false }));
    }
    if (globalThis.MutationObserver && globalThis.document && globalThis.document.documentElement) {
      new MutationObserver(syncPolling)
        .observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    if (globalThis.document) globalThis.document.addEventListener('visibilitychange', syncPolling);
    renderPresence();
    syncPolling();
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
    // 117b：avatar 的 enabled 输入跟 config refresh 同一节拍——config 到达前一律 sleeping(fail-closed)。
    setPresenceInputs({ enabled: stewardEnabledInConfig(state && state.config) });
    // 117c：config 到达后补一次到访判定。页面【直接以 data-shell-mode=steward 启动】时属性从没变过，
    // MutationObserver 观察不到；而 bind 期 state.config 还是空的，enterVisit 必然早退。ensureVisit
    // 的一次性门（每次进壳只到访一次）保证这里的补调不会把正在进行的对话清屏重画。
    syncConversation();
    if (canEnterSteward()) {
      if (storedMode() === 'steward' && !isStewardMode()) return applyShellMode('steward', { persist: false, focus: false });
      return isStewardMode() ? 'steward' : 'classic';
    }
    if (isStewardMode() || storedMode() === 'steward') return recoverStewardShell();
    return 'classic';
  }

  // ── 117c：对话区与递话 ────────────────────────────────────────────────────────
  // 两个子域在本文件内组装并注入依赖(api/t/state/presence/isStewardMode)，组合根 app.js 一行不加。
  // 计时器分工(与 C2a「本文件恰好一处 setInterval」互不干扰)：撤回倒计时住 steward-conversation.js，
  // 预判去抖住 steward-composer.js，本文件仍然只有 avatar 状态轮询这一个 setInterval。
  const presenceApi = Object.freeze({ derive: derivePresence, set: setPresenceInputs, current: () => presenceState });
  const conversation = createStewardConversation({ api, state, t, presence: presenceApi, isStewardMode });
  const composer = createStewardComposer({ api, state, t, isStewardMode, conversation });
  // 117d：线程抽屉。它自己持有轮询与模式观察者（本文件的 C2a「恰好一处 setInterval」不受影响 ——
  // 抽屉那一处住在 steward-drawer.js 里，与 avatar 轮询各自独立门控）。
  const drawer = createStewardDrawer({ api, state, t, isStewardMode, applyShellMode, openSession });
  // 两个子域的唯一反向依赖：撤回／换一条之后打开输入区的候选列表。迟绑定（组合根先例
  // previewStreamSink），不让 conversation import composer。
  conversation.setPickTargetHandler(() => composer.openPicker());

  // 进壳即到访(§8.9「每次打开只汇报本次」)，出壳即收摊(清倒计时与去抖，零后台活动)。触发点与
  // syncPolling 同一路信号(data-shell-mode 的属性变化)，但各自独立观察 —— 轮询门控那一条的形状
  // 被静态锁逐字钉住，不能把两件事塞进同一个回调里。
  function syncConversation() {
    if (isStewardMode()) conversation.ensureVisit();
    else { conversation.resetConversation(); composer.resetComposer(); }
  }

  function bindStewardShell() {
    const classic = byId('stewardClassicBtn');
    if (classic) classic.onclick = () => applyShellMode('classic');
    syncSettingOption();
    bindPresence(); // 117b：avatar 的输入监听 + 模式/可见性观察者，见函数头注
    composer.bindStewardComposer();      // 117c：递送目标 chip / 候选列表 /「+」占位 / Enter 直接递
    drawer.bindStewardDrawer();          // 117d：线程抽屉（接 steward:open-thread / steward:focus-thread）
    // 117d 抽屉的「＋ 线程」→ 输入区 chip 变「→ 如意 · 在事项下新开」。抽屉不 import composer，
    // 靠这一条事件把两个子域接起来（与 setPickTargetHandler 的迟绑定同一纪律）。
    if (globalThis.document) {
      globalThis.document.addEventListener(STEWARD_NEW_THREAD_EVENT,
        event => composer.markNewInMission(event && event.detail && event.detail.missionId));
    }
    conversation.bindStewardConversation(); // 117c：头像菜单的「细节」开关 + 进壳时的首次到访
    if (globalThis.MutationObserver && globalThis.document && globalThis.document.documentElement) {
      new MutationObserver(syncConversation)
        .observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    return isStewardMode() ? 'steward' : 'classic';
  }

  return Object.freeze({
    bindStewardShell,
    canEnterSteward,
    isStewardMode,
    recoverStewardShell,
    syncStewardShellAvailability,
    // 117c/117h 复用：derive 是纯函数(可脱离本实例单独跑真值表)，set 驱动本实例的 DOM 渲染，
    // current 读当前已渲染的态(不重新派生，跟屏幕上看到的一致)。
    presence: presenceApi,
    conversation,
    composer,
    // 117d：117h「现在这一件」直接调 drawer.openThread(sessionId)，不再另起一份抽屉。
    drawer,
  });
}
