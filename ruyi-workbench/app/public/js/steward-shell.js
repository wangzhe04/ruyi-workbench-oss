'use strict';

import { derivePresence, presenceLabelKey } from './steward-presence.js';
import { createStewardConversation } from './steward-conversation.js';
import { createStewardComposer } from './steward-composer.js';
import { createStewardDrawer, STEWARD_NEW_THREAD_EVENT } from './steward-drawer.js';
import { createStewardSettingsDomain } from './steward-settings.js';
import { createStewardBoard } from './steward-board.js';
import { createStewardClassicWindow } from './steward-classic-window.js';
import { stewardEscapeStack, byId, STEWARD_POLL_MS_MIN, STEWARD_POLL_MS_DEFAULT, STEWARD_POLL_MS_CONNECTED, STEWARD_POLL_DUE_SLACK_MS as POLL_DUE_SLACK_MS } from './steward-chips.js';   // 117j UX-F3：Esc 逐层的唯一监听点；33 号文 §4：轮询常量（下限/默认/容差）也只有那一份；121-K2b：事件流连着时的兜底节拍同源
// 33 号文 §4「`steward-shell.js:92,105,108`」：壳模式本机偏好只有一份定义，byId 只有
// steward-chips.js 那一份 —— 本文件两者都不再自带。121-K1（34 号文 §8.2）：那份定义随交办台退役
// 从 preview-shell.js 搬到叶子 js/shell-mode.js，本文件只改 import 来源，取法一个字未变。
import { SHELL_MODE_STORAGE_KEY } from './shell-mode.js';

// 第117波 117a/117b/117c：管家壳（管家视角 steward）的模式与容器骨架 + avatar 状态派生
// + 对话区与递话（后两者的实现住 steward-conversation.js / steward-composer.js，本文件只做组装与
// 依赖注入 —— 组合根 app.js 因此净增 0 行，D45 余量未动）。
//
// 范式：一个注入依赖的工厂、一份冻结导出、零 innerHTML。
// 边界（117a 定的，117b 仍然遵守）：
//   · 只负责「能不能进管家壳」「进不去时怎么体面地回经典」「avatar 现在是什么态」，不做对话／递话／
//     抽屉／看板（117c–h）。
//   · `data-shell-mode` 是唯一状态源；本文件写它的地方只有 recoverStewardShell 这一处 fail-closed 回退，
//     正常进入由 shell-mode.js 的 applyShellMode 单点写入。
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
// 33 号文 §4「轮询常量收进叶子」：这三个值原来与 steward-board / steward-drawer 两处逐字相同，
// 现在只有 steward-chips.js 一个来源，从上面那条已有的 import 取。本地名字一个没改 —— 锁钉的是
// startPolling／pollStewardTick 的函数体与 clamp 写法，这一项收的是值不是名字。

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
  // 117e：设置写口与「打开设置的某个页签」。前者是 provider-settings 既有的那一个（POST /api/config
  // 的唯一封装），后者让头像菜单三项与盾牌的二次确认能直达「管家」页签。
  saveConfigPartial = async () => false,
  openSettingsTab = () => {},
  // 117s-C（用户第九轮走查⑦）：全仓唯一那条 markdown＋净化路径（chat-render-primitives.js 的
  // renderMarkdownInto／highlightIn）。117c 那会儿本文件写着「组合根 app.js 一行不加」——那说的是
  // 117c 自己不需要新依赖；而经典壳六个消费面拿到渲染器【都】是在组合根注入的，管家壳要复用
  // 同一条净化通道就得走同一条路。本文件只做转注入（不 import 渲染器，D2 的 import 白名单不变）。
  renderMarkdownInto = null,
  highlightIn = null,
  // 121-K2b（34 号文 §6.2）：组合根那【一条】事件流。本文件用它三件事：①壳层状态轮询在连接时
  // 降到 30 s 兜底；②`steward.say` 到达就拉一次状态（avatar 与对话流的追加都挂在那一处，不新开
  // 第二条请求路）；③把同一条实例转给看板与抽屉（它们自己不建连接）。
  eventStream = null,
} = {}) {
  // 117n-M1：byId 从 steward-chips.js import（六个消费方零本地重复定义）；33 号文 §4 起本文件也收编 ——
  // 原来那一份 `globalThis.document ? globalThis.document.getElementById(id) : null` 与它逐字同义。
  const setStatusText = key => {
    const node = byId('stewardStatus');
    if (node) node.textContent = t(key);
  };
  // 117k（用户走查②）：恢复位只写不清 —— 开机 config 还没到时先 fail-closed 写了「管家还没打开，
  // 已回到经典布局」，等 config 到了、壳真的进了管家，那句话还挂在底部（实测 12 秒后仍在），
  // 而它是 role="status" aria-live，读屏也会念一遍。准入判定通过就把它擦掉。
  const clearStatusText = () => {
    const node = byId('stewardStatus');
    if (node && node.textContent) node.textContent = '';
  };
  const setStoredMode = mode => {
    try { localStorage.setItem(SHELL_MODE_STORAGE_KEY, mode); } catch { /* local preference may be unavailable */ }
  };
  const storedMode = () => {
    try { return localStorage.getItem(SHELL_MODE_STORAGE_KEY) || ''; }
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
      // 117e：同理给一个同形空壳 —— 组合根照常能调 fillStewardSettings()，只是什么也不做。
      fillStewardSettings: () => false,
      openStewardPanel: () => '',
      settings: Object.freeze({ fillStewardSettings: () => false, openPanel: () => '', setStopped: () => false, isStopped: () => true }),
      // 117g/117h：同理给同形空壳 —— 依赖缺失时壳整体钉在经典，看板与 2.0 视窗都无处可去。
      board: Object.freeze({ setBoardOpen: () => false, isBoardOpen: () => false, refreshBoard: async () => 0, closeNow: () => false }),
      classicWindow: Object.freeze({ openClassicWindow: async () => '', switchWholeShell: () => 'classic', isReturning: () => false }),
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
    // 117j W2-3：头部那枚 6px 状态点。头像跟着话走之后它是头部唯一的状态投影，读的仍是这一处
    // 算出来的 next —— 绝不另起一份判据（117b 的「三处一次写完」现在是四处，仍然只有一个真值）。
    const dot = byId('stewardPresenceDot');
    if (dot) dot.dataset.state = next;
    // 117j copy-P2-3：#stewardPresenceText 是 aria-live="polite" 的。轮询每一拍都会走到这里，
    // 而 textContent 只要被赋值（哪怕值一模一样）读屏就再念一遍 —— 空闲时它会每 5～15 秒念一次
    // 「空闲」。所以先比一次，真变了才写。
    const text = byId('stewardPresenceText');
    const label = t(presenceLabelKey(next), { detail: '' });
    if (text && text.textContent !== label) text.textContent = label;
    return next;
  }

  function setPresenceInputs(patch) {
    if (patch && typeof patch === 'object') Object.assign(presenceInputs, patch);
    return renderPresence();
  }

  // 117l-B2 ①（用户第五轮走查 1「线程返回信息给管家时，最好给 avatar 一个小动效」）：
  // 「点一下」是一次性视觉信号，不是第八个状态 —— 线程回报时管家多半仍是 idle，presenceInputs
  // 一个字都不该被它写脏（derivePresence 是纯投影，掺一个 nudge 字段进去就等于给它加了记忆）。
  // 所以另开这一个显式口子，与 renderPresence 里 .pulse/.shake 那套一次性类同一条纪律。
  // 【零计时器】：类由 animationend 自己摘 —— steward-avatar.css 保证 .is-nudged 一定有动画在播
  // （reduced-motion 下也留着光环，正是为了这个事件一定回来），本文件的 setInterval／setTimeout
  // 计数因此一个没变（steward-avatar.static F1 与 steward-shell.static C2a 都盯着）。
  function nudgeAvatar() {
    const avatar = byId('stewardAvatar');
    if (!avatar) return false;
    avatar.classList.remove('is-nudged');
    void avatar.offsetWidth;   // 强制重排：同一帧内摘了又加，不重排的话动画不会重放
    avatar.addEventListener('animationend', () => avatar.classList.remove('is-nudged'), { once: true });
    avatar.classList.add('is-nudged');
    return true;
  }

  // GET /api/steward/state 没有独立的 pending 字段(13h-steward-runner.js stewardRunnerState 只有
  // stopped/inflight/circuit/lastReply/queued/noProgress/arbiter)。117b 曾借 lastReply.acts 非空近似
  // 「有提议待批」；117c 改接真值 —— POST /api/steward/visit 回的 `pending[]` 就是仍待决的提议清单，
  // 由 steward-conversation.js 的 enterVisit() 直接写进 presence.pendingCount(每次进壳刷新一次)。
  // 轮询这一路因此【不再】碰 pendingCount，只管 stopped/inflight/lastError 三个真有的字段。
  // 117j W2-4：对话流已渲染到的最后一条 lastReply.at。空 = 还没轮询过一次（此时的 lastReply 属于
  // 进壳前，enterVisit 已经把它画进历史了，再追加一次就重了）。
  let lastReplyAt = '';
  let lastStateAt = 0;
  // 121-K2b：推送连着没有。断开时四处轮询各自回到今天的节奏（这就是「兜底」两个字的意思）。
  let streamConnected = false;

  // 节拍：壳可见【且】真有事情在跑时用 5 秒，否则仍按配置（默认 15 秒）。「有事情在跑」= 管家自己
  // 有在途回合，或看板那份行里有线程在跑 —— 后者看板每一拍都已经算过，这里只读它的句柄。
  // **后端的 stewardPollMs 下限一个字没动**：这是前端自己的节拍，不是配置。
  function boardNeedsYouCount() {
    try { return Number(board.needsYouCount()) || 0; } catch { return 0; }
  }
  function stewardPollFast() {
    if (!isStewardMode() || (globalThis.document && globalThis.document.hidden)) return false;
    if (presenceInputs.inflight) return true;
    try { return board.hasRunningThread() === true; } catch { return false; }
  }
  // 表按下限走，真要不要拉由这一拍自己判（与 steward-drawer.js／steward-board.js 逐字同一条纪律：
  // 动态换表会多一处 clearInterval 或多一个 start/stop 调用点，撞上 steward-avatar.static 的 F1/F3）。
  // 121-K2b：事件流连着的时候这条轮询只是【兜底心跳】—— 真正让 avatar 跟上的是 steward.say 推送
  // （见下面的 bindEventStream）。所以连接时 due 统一 30 s，断开时才回到今天那两档（5 s／配置）。
  // 表（setInterval 的周期）一个字没动，与 117j W2-4 同一条纪律：换表要么多一处 clearInterval、
  // 要么多一个 start/stop 调用点，两者都会撞上 steward-shell.static C2a／steward-avatar.static F1。
  function pollStewardTick() {
    const due = streamConnected ? STEWARD_POLL_MS_CONNECTED : (stewardPollFast() ? STEWARD_POLL_MS_MIN : pollIntervalMs());
    if (Date.now() - lastStateAt < due - POLL_DUE_SLACK_MS) return;
    pollStewardState();
  }

  function pollStewardState() {
    if (typeof api !== 'function') return;
    Promise.resolve(api('/api/steward/state')).then(response => {
      if (!response || typeof response !== 'object') return;
      lastStateAt = Date.now();   // 117j W2-4：节拍水位。落在这里而不是函数头 —— C3b 逐字钉住了函数头那两行。
      const lastReply = (response.lastReply && typeof response.lastReply === 'object') ? response.lastReply : null;
      setPresenceInputs({
        stopped: response.stopped === true,
        inflight: typeof response.inflight === 'string' ? response.inflight : '',
        lastError: (lastReply && lastReply.error) ? String(lastReply.error) : '',
        // 117m-A3:线程级「等你」进头像。读看板已经算好的那一份(它每一拍都在算 needs_you 行),
        // 与 hasRunningThread 同一个只读句柄先例 —— 不发第二条请求、不开第二个计数源。
        needsYouCount: boardNeedsYouCount(),
      });
      // 117e：头部常驻停机键与设置页的运行态读同一份真值，不各自再发一条请求。
      settings.setStopped(response.stopped === true);
      // 117j W2-4：收件箱唤醒管家跑完的那一回合要实时进对话流。只认 trigger==='inbox' ——
      // 用户自己发的那一条是 sendToSteward 当场画的，再追加一次就重了；首次轮询也跳过（那一条
      // 属于进壳之前，enterVisit 已经画过）。
      const at = String((lastReply && lastReply.at) || '');
      if (at && at !== lastReplyAt) {
        const firstSeen = !lastReplyAt;
        lastReplyAt = at;
        // 117l-B2 ①：nudge 与 appendSince 同一道判据、同一分支 —— 有「线程回来了」这件事的
        // 那一刻才播，且必须在追加之前发（头像随即被 moveAvatarTo 搬到新那一行，先播后搬，
        // 光环跟着头像走）。用户自己发的那条回复走的是 sendToSteward，压根不进这个分支。
        if (!firstSeen && isStewardMode() && lastReply.trigger === 'inbox') { nudgeAvatar(); void conversation.appendSince(''); }
      }
    }).catch(() => { lastStateAt = Date.now(); /* 状态面不因单次轮询失败整条消失，下一轮再试（失败也推水位，否则每一拍都重试） */ });
  }

  function pollIntervalMs() {
    const raw = Number(state && state.config && state.config.stewardPollMs);
    return Number.isFinite(raw) && raw > 0 ? Math.max(STEWARD_POLL_MS_MIN, raw) : STEWARD_POLL_MS_DEFAULT;
  }

  // 121-K2b（§6.2）：把那一条事件流接到壳层。**零新请求路**：`steward.say` 到达就走既有的
  // pollStewardState()（全文件唯一那处请求调用点，C3a/C3b 钉着），它自己会判「要不要 nudge、要不要
  // appendSince」—— 推送只是把「什么时候拉」从「每 5–15 秒猜一次」换成「它真说完了才拉」。
  // 连接状态只改 due（见 pollStewardTick），不改启停条件：syncPolling 的三重门控一个字没动。
  function bindEventStream() {
    if (!eventStream || typeof eventStream.on !== 'function') return false;
    eventStream.on('connection', payload => { streamConnected = Boolean(payload && payload.connected); });
    streamConnected = typeof eventStream.isConnected === 'function' ? eventStream.isConnected() === true : false;
    eventStream.on('steward.say', () => { if (isStewardMode()) pollStewardState(); });
    return true;
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
    pollTimer = setInterval(pollStewardTick, STEWARD_POLL_MS_MIN);
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
      clearStatusText();   // 117k：进得去就没有「回到经典」这回事，那句话不该再留在屏幕上
      // 121 波 K0（34 号文 §8.4 拍板③「默认入口改管家视角」）：判据从「存了 steward」放宽成
      // 「没存过显式的非管家偏好」——与 index.html 预绘脚本同一条规则（没存过／未知值 = steward）。
      // 【为什么落点在这里而不是预绘脚本】：预绘写下的属性会被 bind 期那句
      // applyShellMode(storedShellMode()) 再判一次（shell-mode.js 的 bindShellModeControl），
      // 而那一拍 state.config 还没到、canEnterSteward() 恒 false，所以首开进哪个视角【只能】由
      // config 到达后的这一处决定。只改预绘是空转（34 号文 §13.1 记过这次证伪）。
      // 121-K1：'preview' 这一档随交办台退役（§8.1）—— shell-mode.js 的 readStoredShellMode 读到
      // 老用户那份偏好时会就地改写成 'steward'，所以本条判据只剩 classic 一个值要认。下面
      // fail-closed 那支【不动】——它仍只认显式存了 steward 的人，于是管家关着的存量用户既不会被
      // 弹「已回到经典」的说明，也不会被写一条他没选过的本机偏好。
      const prefersClassic = storedMode() === 'classic';
      if (!prefersClassic && !isStewardMode()) return applyShellMode('steward', { persist: false, focus: false });
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
  const conversation = createStewardConversation({
    api, state, t, presence: presenceApi, isStewardMode,
    // 117e：头像菜单的「设置／记忆／行动流水」三项（117c 那里只有「细节」）。菜单只负责调用，
    // 页签切换、滚动与取数全在 steward-settings.js 里。
    openStewardPanel: section => settings.openPanel(section),
    // 117 走查（用户 2026-09-06）：主端点是命令行引擎时，对话区的「改用『某端点』」按钮经这里写
    // stewardProviderId（走设置域同一个 saveConfigPartial，对话区不碰 /api/config）。
    setStewardProvider: id => saveConfigPartial({ stewardProviderId: id }),
    // 117g：菜单末项「整体切到 2.0」——【不】设返回标记，所以经典壳里不出返回带（§5 117g 行）。
    switchWholeShell: () => classicWindow.switchWholeShell(),
    // 117s-H：交付卡的「看全文」直接跳 2.0 视窗（与抽屉那三处同一个入口，117g）。同样是迟绑定闭包：
    // classicWindow 在下面才建，调用时它早已就位；缺席时对话区回落既有的 steward:open-thread。
    openClassicWindow: sessionId => classicWindow.openClassicWindow(sessionId),
    // 117s-C：转注入渲染器。对话区自己不 import 它（A2 锁：本域内相对路径），缺席时回落纯文本。
    renderMarkdownInto, highlightIn,
  });
  const composer = createStewardComposer({ api, state, t, isStewardMode, conversation });
  // 117d：线程抽屉。它自己持有轮询与模式观察者（本文件的 C2a「恰好一处 setInterval」不受影响 ——
  // 抽屉那一处住在 steward-drawer.js 里，与 avatar 轮询各自独立门控）。
  const drawer = createStewardDrawer({ api, state, t, isStewardMode, applyShellMode, openSession });
  // 117e：设置页「管家」页签 + 头部的盾牌与停机键。它是【唯一】写全局 permissionMode 与管家配置的
  // 地方；四档表与全自动确认文案由它从 steward-chips.js import 复用，本文件不碰。
  // 117j UX-F1：总开关关掉的那一刻要立刻回经典。准入判定的单点就在本文件的
  // syncStewardShellAvailability（fail-closed 回退那一支也在它里面），设置域只负责在写完配置之后
  // 踢它一脚 —— 不给它第二份「能不能进管家壳」的判据。
  const settings = createStewardSettingsDomain({
    api, state, t, saveConfigPartial, openSettingsTab, presence: presenceApi,
    syncShellAvailability: () => syncStewardShellAvailability(),
  });
  // 117g：2.0 视窗与顶部返回带。它不发请求，只读 state 与 chips（返回带的 DOM 在经典壳里，逻辑住这边）。
  // 事项名向 117h 看板要它已经取回来的那一行 —— 迟绑定句柄（board 在它之后才构造）。
  let boardHandle = null;
  const classicWindow = createStewardClassicWindow({
    api, state, t, applyShellMode, openSession,
    missionTitleOf: sessionId => (boardHandle ? boardHandle.missionTitleFor(sessionId) : ''),
  });
  // 117h：一行状态 → 看板 → 「现在这一件」。「现在这一件」不另起抽屉，直接把 117d 那一份换成
  // docked 挂法（drawer.setMount），所以这里把 drawer 子域整个交给它。
  const board = createStewardBoard({
    api, state, t, isStewardMode, drawer, saveConfigPartial,
    openClassicWindow: sessionId => classicWindow.openClassicWindow(sessionId),
    switchWholeShell: () => classicWindow.switchWholeShell(),
    // 117g：看板拿到新的一批行就让返回带重画（事项名的唯一来源就是那批行）。
    onRowsChanged: () => classicWindow.renderBand(),
  });
  boardHandle = board;
  // 121-K2b：同一条事件流转给左栏与焦点栏。走 setter 而不是构造参数 —— 抽屉那一行构造被
  // steward-drawer.static I3 逐字钉着（新依赖一律迟绑定，与 setClassicWindow／setMissionRows 同纪律）。
  board.setEventStream(eventStream);
  drawer.setEventStream(eventStream);
  // 117g：抽屉的「2.0 视窗」「看全文」「看改动」改走统一入口（构造那一行被 steward-drawer.static I3
  // 逐字钉住，新依赖一律走 setter —— 与 conversation.setPickTargetHandler 同一条迟绑定纪律）。
  drawer.setClassicWindow(sessionId => classicWindow.openClassicWindow(sessionId));
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
    // 117j UX-F3/F4：Esc 逐层的【唯一】 keydown。**必须排在 composer/drawer/board 的绑定之前** ——
    // 抽屉与看板各自那处 document keydown 保留着（它们是最底层），而 DOM 的同型监听按注册顺序触发，
    // 所以这一处先跑：栈里有浮层／菜单就关栈顶并 stopPropagation（下面那两路收不到），
    // 栈空了才轮到它们关抽屉／看板。判据与关闭器都不在这里 —— 各模块只 push 自己的那一个。
    if (globalThis.document) {
      globalThis.document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !isStewardMode()) return;
        if (stewardEscapeStack.handleEscape()) event.stopPropagation();
      });
      // 117k（用户要求）：点界面别的地方，所有菜单／浮层自动收回。与 Esc 同一个栈、同一处监听，
      // 每一层自己说「哪些节点算我的」。**必须捕获阶段**：同一次点击里，另一颗键的处理器可能
      // 【正要】打开一个菜单（比如撤回到点后的「换一条」）——冒泡阶段跑到这里时它刚开、而目标
      // 又在它外面，就会刚开就被关掉。捕获阶段先于目标处理器：那一刻它还没开，我们直接略过。
      globalThis.document.addEventListener('click', event => {
        if (!isStewardMode()) return;
        stewardEscapeStack.handleOutsideClick(event && event.target);
      }, true);
    }
    // 121-K4（§2.2／§2.7）：输入区那枚「经典模式」退役 —— 视角切换只在顶栏分段钮一处
    // （js/app-frame.js 调同一个 applyShellMode，本文件因此不再有第二个切换入口）。
    syncSettingOption();
    bindEventStream(); // 121-K2b：推送订阅（连接状态 + steward.say）；连接本身由组合根 start()
    bindPresence(); // 117b：avatar 的输入监听 + 模式/可见性观察者，见函数头注
    composer.bindStewardComposer();      // 117c：递送目标 chip / 候选列表 /「+」占位 / Enter 直接递
    drawer.bindStewardDrawer();          // 117d：线程抽屉（接 steward:open-thread / steward:focus-thread）
    // 117d 抽屉的「＋ 线程」→ 输入区 chip 变「→ 如意 · 在事项下新开」。抽屉不 import composer，
    // 靠这一条事件把两个子域接起来（与 setPickTargetHandler 的迟绑定同一纪律）。
    if (globalThis.document) {
      globalThis.document.addEventListener(STEWARD_NEW_THREAD_EVENT,
        event => composer.markNewInMission(event && event.detail && event.detail.missionId));
    }
    settings.bindStewardSettings();       // 117e：设置页控件 + 头部盾牌与常驻停机键
    classicWindow.bindStewardClassicWindow(); // 117g：返回带（回到管家 / 会话名 / 事项名 / 同一组 chip）
    board.bindStewardBoard();             // 117h：一行状态 / 看板 / 「现在这一件」
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
    // 117e：组合根在 fillSettings() 里调 fillStewardSettings()（一行注入），面板本身归 settings。
    // 排在 drawer 之前，是为了让 117d 的 `steward-drawer.static I7`（锚「drawer 是导出对象的末项」）
    // 原样通过 —— 既有断言只加不改。
    settings,
    fillStewardSettings: () => settings.fillStewardSettings(),
    openStewardPanel: section => settings.openPanel(section),
    // 117g/117h：看板与 2.0 视窗子域（组合根一行不加；它们的依赖全在本文件内注入）。
    board,
    classicWindow,
    // 117d：117h「现在这一件」直接调 drawer.openThread(sessionId)，不再另起一份抽屉。
    drawer,
  });
}
