'use strict';

import './mission-state.js';
import { apiRaw } from './net.js';
import { elapsedLabel } from './preview-task-sheet.js';
import { dockToneForMissionState } from './preview-shell.js';
// 117u-G2 B3 →（117u-G3 搬家）：「这一行的权限与模型跟全局一样吗」这条判据 G2 是写在本模块闭包里的，
// G3 把它原样搬进 steward-chips.js 给【看板与线程详情栏】共用（抽屉不能反过来 import 看板，见那边的
// 注释）。所以这里接过来的是 chipsWorthPrinting 本身，而不再是 resolveEngineRoute —— 本模块自此
// 连「会话级 ＞ 全局回落」都不认识，更长不出第二套。
import { createQuickSwitchChips, doc, byId, el, clear, chipsWorthPrinting, writeNote } from './steward-chips.js';   // 117n-M1：DOM 基础件复用（doc/byId/el/clear 不再本地重复）；33 号文 §4：note 写手（写 #stewardBoardNote）也只有那一条
// F5a（27 号文 §11.13.1「F 追加」）：动作与五态的字形都取自 icons.js 那一张表。
// missionStateIcon 是【纯派生】（五态值 → 字形名），不是第二份五态枚举 —— 本模块仍然只把
// threadStateOf() 的返回值原样递进去，`needs_you`/`'stopped'` 的字面量计数一个没变（M6 锁）。
import { icon, missionStateIcon } from './icons.js';
import { stewardThreadRunAction, stewardThreadStop } from './steward-drawer.js';
// 33 号文 §4（「costText／acceptanceText／threadStateOf 三对收进 drawer 导出」）：这三条判据的正身
// 只在 steward-drawer.js 一份，本模块 import 过来用 —— 方向与上面那两个动作函数一致（看板 → 抽屉，
// 抽屉不反过来 import 看板），不成环。判据共享，**文案键各传各的**（看板递 stewardShell.board.*，
// 抽屉递 stewardShell.drawer.*），所以两面各说各的话、判据只有一处。
// 单开一条 import（而非并入上面那行）是刻意的：steward-board.static D4 逐字钉着上面那行的写法，
// 而 D4 要守的是「动作走抽屉同一段原语」这件事，不该为一次收编去动它（32 号文 §4 纪律 5）。
import { stewardThreadStateOf, stewardCostText, stewardAcceptanceText } from './steward-drawer.js';
// 117n-M1②（用户第六轮走查后走查「合并功能」）：failNote 原来只是 String(error.message || error)，
// 既不解结构化信封也不特判 steward.queued 的 wait.label —— 同一种排队失败，看板上的提示比抽屉里
// （steward-drawer.js:287 的 failNote）差。改成引用 steward-conversation.js 的权威实现，不再自己
// 写第二份弱化版。
// 117u-G2 B2（27 号文 §11.15.3「一枚线程卡，三种密度」）：色号问【全仓那一张登记表】要 ——
// G1 已经把它从对话流的实例闭包提到模块级（stewardThreadHueFor），所以同一条线程在对话流／
// 频道条／线程详情栏／看板上恒是同一个号、同一种色。本模块不自己算色、不自己记号、不新开第二张表。
import { stewardErrorCode, stewardErrorText, stewardQueuedWaitLabel, stewardThreadHueFor } from './steward-conversation.js';

// 第117波 117h：一行状态 → 看板 → 「现在这一件」（27 号文 §8.2 L1／§8.10 多线程看板与注意力预算）。
//
// 三件事，一个模块：
//   ① 一行状态 `#stewardStatusLine`：「N 个事项 · A 条在跑，B 条等你」，点开即看板（aria-expanded）；
//      一条线程都没有时说 §8.9 那句「还没有任务，直接说你想做什么」。
//   ② 看板 `#stewardBoard`：从状态行下拉的面板（role="region"，Esc 关）。顶部是并发上限就地可调、
//      在跑／排队计数、「全部暂停」「整体切到 2.0」；正文按【事项】分组，事项行给聚合态与验收 a/b，
//      线程行给五态点、耗时、快切 chip、单一的等待原因与悬停操作。
//   ③ 「现在这几件」`#stewardNow`：≥1000px 常驻右栏。焦点那一条的内容就是【同一个】线程抽屉以
//      docked 挂法挂进来（steward-drawer.js 的 setMount('docked') 把 #stewardDrawer 节点搬进
//      #stewardNowBody）—— 不存在第二份抽屉区块渲染。焦点线程由纯函数 focusThreadFor 决定，
//      用户显式选过就钉住。
//      F3（32 号文 §2.2「线程即频道」）：其余在办的线程按 GET /api/missions 的【服务端行序】
//      （117s-A 的 D1 已经在 13d 一处按「状态优先、其次 updatedAt」排好）在抽屉的上下叠成小行 ——
//      焦点行之前的进上面那条 stack，之后的进下面那条，于是抽屉就插在它自己那一格里，右栏行序与
//      看板、抽屉页签逐字节同源；本模块【不再排一次】，也【不复制】任何抽屉区块。
//
// 不另起判据（§8.10 逐条）：
//   · 事项聚合态【只读】行上的 `aggregateState`（116g 由 06i 的 aggregateMissionState 单点算出），
//     本模块不写「任一 needs_you 则…」这类字面判定；
//   · 线程五态经 mission-state.js 的 fromCard（全仓唯一判据，与抽屉、交办台逐字节同源）；
//   · 等待原因只有 `wait.label` 一处（116h 的 waitReasonFor 单点判定），本模块没有第二套等待文案；
//   · 权限／模型快切经 steward-chips.js 的同一个工厂（紧凑模式），本模块不自己 PATCH 会话。
//
// 刷新纪律（对 27 号文 §5 117h「刷新纪律」的一处收紧，见文件尾的说明）：本模块恰好一处 setInterval
// 与一处 clearInterval，唯一入口 syncPolling() 先判「看板打开 && 管家模式 && 页面可见」，任一为否
// 立刻停表；「现在这一件」的内容由抽屉自己那一份轮询刷新（同一份实现），行数据在进壳／开看板／
// 焦点事件／写动作／页面重新可见这五个确定性时刻各刷一次 —— 于是管家壳在看板关着时【不多】一条
// 后台计时器（§3.4 红线的延伸）。

export const STEWARD_BOARD_POLL_MS_MIN = 5000;
// 同 steward-drawer.js：setInterval 会比标称早几毫秒回来，不留容差就会整整推迟一拍。
const POLL_DUE_SLACK_MS = 250;
export const STEWARD_BOARD_POLL_MS_DEFAULT = 15000;
export const STEWARD_NOW_CLOSED_KEY = 'wcw.stewardNowClosed';
export const STEWARD_NOW_MIN_WIDTH = 1000;
// F3：右栏那两条「小行叠」的容器 id。它们【不在】 index.html 的静态骨架里（A5/A7 的纪律：
// #stewardNowBody 只是一个挂点），由本模块建出来并始终夹着抽屉那一份 —— 上面一条放焦点行之前的
// 线程，下面一条放之后的。做成导出的冻结常量而不是两个散落字面量，静态锁才钉得住。
export const STEWARD_NOW_STACK_IDS = Object.freeze({ before: 'stewardNowStackBefore', after: 'stewardNowStackAfter' });
// 与 01-config.js 的 stewardMaxParallelThreads 校验同一区间（[1,32]，默认 5）。
export const STEWARD_MAX_PARALLEL_MIN = 1;
export const STEWARD_MAX_PARALLEL_MAX = 32;
// 117m-A2（用户第六轮走查⑤⑥）：行上那枚 pill 按【哪一类待决】说话。四类的分量不一样：
// question 是「要你答一句」，permission 是「它停在那儿，要你按一下才敢动手」，plan／pool 是提案。
// 全说成同一句「它在问你」，用户就分不清「点进去要干什么」——真机上他看到「需要你 1」却什么都
// 点不开，正是因为 permission 这一类修前连 pill 都没有。
// 判据仍然【只有】行上的 asksYou.kind（06i 的单点算出，与抽屉同一份）；本模块不认识 intervention 的形状。
export const STEWARD_BOARD_ASKS_YOU_KEYS = Object.freeze({
  question: 'stewardShell.board.asksYou.question',
  permission: 'stewardShell.board.asksYou.permission',
  plan: 'stewardShell.board.asksYou.plan',
  pool: 'stewardShell.board.asksYou.pool',
  // 软问句（没有正式待决、只是最后一句以问号收尾）沿用 117l 那一句，逐字不变。
  soft: 'stewardShell.board.asksYou',
});
export const STEWARD_NEW_THREAD_EVENT = 'steward:new-thread';
export const STEWARD_FOCUS_THREAD_EVENT = 'steward:focus-thread';
export const STEWARD_OPEN_THREAD_EVENT = 'steward:open-thread';

// ── 焦点线程：等你 ＞ 在跑 ＞ 失败 ＞ 最近更新（§8.10／§5 117h 行）──────────────────
// 纯函数、零 DOM、零 import 依赖：dev-harness/unit/steward-focus-thread.test.js 直接 import 跑真值表。
// 入参是【已经带好五态】的行（五态由调用方经 mission-state.js 算出，本函数不认识卡片形状，也就
// 不可能在这里长出第二套五态判据）。
// 「失败」在五态里没有独立枚举 —— mission-state.js 的诚实说法是 `stopped`（已停工：活没在干），
// 所以第三优先级取 stopped，不自造一个 failed 态。
export function focusThreadFor(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(row => row && row.sessionId);
  if (!list.length) return null;
  const newest = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  const pick = state => list.filter(row => row.state === state).sort(newest)[0] || null;
  return pick('needs_you') || pick('running') || pick('stopped') || list.slice().sort(newest)[0] || null;
}

export function createStewardBoard({
  api = async () => null,
  state = null,
  t = key => key,
  isStewardMode = () => false,
  drawer = null,
  saveConfigPartial = async () => false,
  // 117g：「整体切到 2.0」与看板每行的「2.0」都走它（切经典壳＋选中会话＋顶部返回带）。
  openClassicWindow = async () => {},
  switchWholeShell = () => {},
  // 117g：行数据到手就通知返回带重画一次 —— 带上的「事项名」读的正是本模块取回来的这批行
  // （missionTitleOf）。不通知的话，进壳后立刻开 2.0 视窗会赶在第一趟取数之前，事项名那段空着。
  onRowsChanged = () => {},
} = {}) {
  let rows = [];                  // GET /api/missions 的线程行（卡片形状 + 116g/117h-0 的追加字段）
  let arbiter = null;               // GET /api/steward/arbiter 的只读状态
  let missionsEtag = '';            // 带 If-None-Match 走，没变就连解析都省了
  let pinnedId = '';                // 用户显式选过的线程（steward:open-thread / focus-thread / 看板行）
  // 117r-D2（用户第八轮走查①）：这一钉还没被【行】核实过。派进来一个焦点／打开事件时置位，
  // 焦点事件那一刷跑完就清（verifyPinnedRow 的 finally）—— 见 currentFocusId 的头注。
  let pinnedUnverified = false;
  let suppressCloseRecord = false;  // 程序性关抽屉（窄屏／切壳）不该被记成用户「关掉」了这一件
  // 117m-A2：状态行那一次 filter 顺手留下的名单（等你的线程 id）。它是「N 条等你」这枚按钮的去处，
  // 也是「把等你的行排到最前」的判据 —— 两处都读它，不再数第二遍，也不新开第二个计数源。
  let needsYouIds = [];
  let needsYouFirst = false;        // 从那枚按钮跳进来的这一程才排序；关看板即复位（后端行序不动）
  const chipsBySession = new Map(); // sessionId -> chips 控件（每行一份实例，读同一份数据）
  const sessionCache = new Map();   // sessionId -> 会话（chip 补齐或 PATCH 回来的那一份）

  // 117n-M1：el/clear 从 steward-chips.js import（六个消费方零本地重复定义）。
  function note(text) {
    writeNote('stewardBoardNote', text);
  }
  // 117n-M1②：与 steward-drawer.js:287 的 failNote 同一条纪律——稳定信封先经 stewardErrorCode 查
  // steward.queued，取得到 wait.label 就说「在等什么」；query 不到或不是这个码，落到一般失败文案，
  // 一律用 stewardErrorText 取值，绝不 String(error) 直落（结构化 error 对象此前会被拍扁成
  // "[object Object]"）。
  function failNote(error) {
    const code = stewardErrorCode(error);
    if (code === 'steward.queued') {
      const label = stewardQueuedWaitLabel(error);
      note(label ? t('stewardShell.chat.errQueued', { wait: label }) : t('stewardShell.chat.errQueuedPlain'));
      return;
    }
    note(t('stewardShell.board.failed', { error: stewardErrorText(error) || 'failed' }));
  }

  // ── 五态与聚合态：只读，不判 ────────────────────────────────────────────────────
  // 33 号文 §4：五态判据的正身已住 steward-drawer.js（本模块本来就 import 它的动作函数），这里只剩
  // 短名 —— 全仓判五态的地方仍然只有 mission-state.js 一处，看板与抽屉读的也是同一个函数。
  const threadStateOf = stewardThreadStateOf;
  // 本界面的那一套文案键（判据共享、措辞各说各的）。
  const COST_KEYS = Object.freeze({
    none: 'stewardShell.board.costNone',
    budget: 'stewardShell.board.costBudget',
    cost: 'stewardShell.board.cost',
  });
  const ACCEPTANCE_KEYS = Object.freeze({
    none: 'stewardShell.board.acceptanceNone',
    count: 'stewardShell.board.acceptance',
  });
  // 117q-B3b：五态人话统一走中性的 mission.state.*（原来那组仅抽屉专属命名的键已并入，
  // 与看板、抽屉、交办台三个壳共用同一组键，见 30 号文 §4.4），不再开第二套五态文案。
  function stateLabel(value) {
    return value ? t(`mission.state.${value}`) : '';
  }
  // 117n-M1③（用户「看板圆点看不出已完成」）：同一条线程收工之后，抽屉那颗点走六态原始 state
  // 直接判绿（steward-drawer.js:419／CSS 的 [data-state="done"]），看板这颗点却经
  // dockToneForMissionState 收成三档、done 落进 quiet 灰点 —— 用户扫看板看不出哪条线程真的完成了。
  // 传 settleDone:true 让看板这一处主动选出第四档 settled；不传参数的默认行为（交办台的 dock 座，
  // 见 preview-shell.js 的 renderDock）一个字不变。
  // 117u-G2 B2：tone 从 paintDot 里【提出来】成一个纯函数。理由是右栏那一面：小行那颗点自此
  // 归线程色（色 ≠ 态），但「展开还是折成一行」仍然只认这四档 tone —— 提出来之前要拿 tone 必须
  // 先 paintDot 造一颗点、从 dataset 上读回来再把点扔掉。两处调用问的仍是【同一处】判定：
  // dockToneForMissionState 在本模块全文仍然只被调用这一次。
  function toneOf(value) { return dockToneForMissionState(value, { settleDone: true }); }
  function paintDot(node, value) {
    node.dataset.state = value;
    node.dataset.tone = toneOf(value);
    return node;
  }

  // ── 117u-G2：三面共用的那枚线程卡（27 号文 §11.15.3）───────────────────────────
  // 骨架 = 3px 色条 ＋ 色点 ＋ 名 ＋ 五态药丸；长相住 steward-conversation.css 的
  // .steward-tcard-*（G1 提上去的那一份，对话流与线程详情栏用的是同一条声明块），本模块只挂类名。
  // 色条与色点【只说这是哪条线程】，一个状态字面量都不认 —— 状态由 statePill() 那枚药丸承担
  // （F1 立的「两套信号不混用」：修前看板那颗点既是身份又是状态，一个视觉信号说两件事）。
  function paintThreadCard(node, sessionId) {
    node.classList.add('steward-tcard');
    if (sessionId) node.dataset.threadHue = String(stewardThreadHueFor(sessionId));
    const bar = el('span', 'steward-tcard-bar');
    bar.setAttribute('aria-hidden', 'true');
    node.appendChild(bar);
    return node;
  }
  function threadDot() {
    const dot = el('span', 'steward-tcard-dot');
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  // 焦点线程的入参：把卡片行折成 { sessionId, state, updatedAt } —— 纯函数只认这三个字段。
  function threadViews() {
    return rows.map(row => ({
      sessionId: String(row.sessionId || ''),
      state: threadStateOf(row),
      updatedAt: String(row.updatedAt || ''),
    }));
  }

  // ── 取数 ────────────────────────────────────────────────────────────────────────
  async function loadMissions() {
    try {
      // 117q-B3a(P1-6):裸 fetch 换 apiRaw——304/etag 判断逻辑一个字不动，唯一变化是拿到 403 +
      // auth.token_invalid(后台进程重启后旧 token 失效)时会像其余 45+ 处 api() 调用点一样自愈：
      // 换新 token 重放一次，而不是直接放弃、空转到用户手动刷新页面。
      const headers = missionsEtag ? { 'if-none-match': missionsEtag } : {};
      const response = await apiRaw('/api/missions?limit=200', { headers });
      if (response.status === 304) return false;          // 没变：不重画，chip 菜单也就不会被打断
      if (!response.ok) return false;
      missionsEtag = response.headers.get('etag') || '';
      const payload = await response.json();
      rows = Array.isArray(payload && payload.missions) ? payload.missions : [];
      return true;
    } catch { return false; }
  }

  async function loadArbiter() {
    try {
      const response = await api('/api/steward/arbiter');
      arbiter = (response && response.ok === true) ? response : null;
    } catch { arbiter = null; }   // 开关关时后端给 409：仲裁面整块留空，不编数字
    return arbiter;
  }

  // ── ① 一行状态 ──────────────────────────────────────────────────────────────────
  // 117m-A2（用户第六轮走查⑤⑥「系统提示的需要我通知，在管家界面也点不开」）：那个数字要有【去处】。
  // 为什么做成挨着状态行的一枚兄弟按钮，而不是把状态行里「B 条等你」那几个字变成控件：
  // #stewardStatusLine 自己就是一个 <button>（steward-board.static A1 逐字钉着它），button 里再嵌
  // button 是非法 HTML、读屏也点不到；把整行改成 <div> 又会把「点开即看板」这条路一起改掉。
  // 没有人等你的时候整枚隐藏（[hidden] 一处驱动，样式层不管显隐）。
  function renderNeedsYouGo() {
    const button = byId('stewardStatusNeedsYouBtn');
    if (!button) return 0;
    const count = needsYouIds.length;
    button.hidden = count === 0;
    button.textContent = t('stewardShell.board.needsYouGo');
    const hint = t('stewardShell.board.needsYouGoHint', { n: count });
    button.title = hint;
    button.setAttribute('aria-label', hint);
    return count;
  }

  function renderStatusLine() {
    const line = byId('stewardStatusLine');
    if (!line) return '';
    const views = threadViews();
    if (!views.length) {
      needsYouIds = [];
      renderNeedsYouGo();
      line.textContent = t('stewardShell.board.statusEmpty');
      return line.textContent;
    }
    const missions = new Set(rows.map(row => String(row.missionId || row.sessionId))).size;
    const running = views.filter(view => view.state === 'running').length;
    // 计数与【名单】同一次 filter 算出来：右上那枚「去处理」要知道去哪一条，而计数源仍然只有这一处
    // （117l 的 needsYouCount 读的也是这条状态行的同一份事实，不新开第二个计数源）。
    const waiting = views.filter(view => view.state === 'needs_you');
    needsYouIds = waiting.map(view => String(view.sessionId));
    renderNeedsYouGo();
    line.textContent = t('stewardShell.board.statusLine', { missions, running, needsYou: waiting.length });
    return line.textContent;
  }

  // 「N 条等你」按下去：恰好 1 条就直接把那条线程的抽屉打开（问答卡在那儿，焦点也落进去）；
  // 多于 1 条就拉开看板，并把等你的那几行排到最前 —— 排的是这一次渲染用的副本，后端行序不动。
  function goToNeedsYou() {
    const ids = needsYouIds.slice();
    if (!ids.length) return '';
    if (ids.length === 1) {
      const id = openThread(ids[0]);
      // 抽屉在数据到齐的那一帧自己会把焦点送进问答卡（117l 的 focusAsk）。这里再点一次，是为了
      // 「右栏已经开着同一条线程」那种情况 —— 那时 openThread 不重走一遍加载，也就不会再聚焦。
      if (drawer && typeof drawer.focusAsk === 'function') drawer.focusAsk();
      return id;
    }
    needsYouFirst = true;
    setBoardOpen(true);
    renderBoard();
    return '';
  }

  // ── ② 看板顶部：并发上限就地可调 + 在跑／排队计数 ───────────────────────────────
  function renderArbiterFacts() {
    const input = byId('stewardBoardMax');
    if (input && doc().activeElement !== input) {
      const configured = Number(state && state.config && state.config.stewardMaxParallelThreads);
      const live = arbiter ? Number(arbiter.maxParallel) : NaN;
      const value = Number.isFinite(live) ? live : (Number.isFinite(configured) ? configured : 5);
      input.value = String(value);
    }
    const running = byId('stewardBoardRunning');
    const queued = byId('stewardBoardQueued');
    const runningCount = arbiter && Array.isArray(arbiter.running) ? arbiter.running.length : 0;
    const queuedCount = arbiter && Array.isArray(arbiter.queue) ? arbiter.queue.length : 0;
    if (running) running.textContent = t('stewardShell.board.running', { n: runningCount });
    if (queued) queued.textContent = t('stewardShell.board.queued', { n: queuedCount });
    syncPauseAll();
    return { runningCount, queuedCount };
  }

  // 117l-B2 ②（用户第五轮走查 2）：「全部暂停」只在【真有东西可暂停】时才是可点态。
  // 判据必须与 pauseAll 自己那一行 filter 逐字同源（row.lastRun.live && !paused）—— 借用上面那两枚
  // pill 的 arbiter.running 会撒谎：仲裁面数的是「占着并发位的线程」，而能被暂停的是「有活的 run」，
  // 两者在「只跑对话回合、没有 run」的线程上就对不上（pauseAll 自己也是这么说的：那些只能停止）。
  function syncPauseAll() {
    const button = byId('stewardBoardPauseAllBtn');
    if (!button) return false;
    const pausable = rows.some(row => row.lastRun && row.lastRun.live === true && row.lastRun.paused !== true);
    button.disabled = !pausable;
    return pausable;
  }

  async function saveMaxParallel(raw) {
    const value = Math.min(STEWARD_MAX_PARALLEL_MAX, Math.max(STEWARD_MAX_PARALLEL_MIN, Math.round(Number(raw) || 0)));
    if (!Number.isFinite(value)) return false;
    const saved = await saveConfigPartial({ stewardMaxParallelThreads: value });
    if (!saved) { note(t('stewardShell.board.maxParallelFailed')); return false; }
    // 116h 的 arbiterRefresh 让它即时生效（不需重启）；回读仲裁面确认，界面只说后端真答应了的数。
    await loadArbiter();
    renderArbiterFacts();
    note(t('stewardShell.board.maxParallelSaved', { n: value }));
    return true;
  }

  // ── ② 看板正文：按事项分组 ──────────────────────────────────────────────────────
  function groupRows() {
    const groups = new Map();
    for (const row of rows) {
      const missionId = String(row.missionId || row.sessionId || '');
      if (!groups.has(missionId)) {
        groups.set(missionId, {
          missionId,
          // 117h 第 0 步：事项标题／目标／验收项整表都由 GET /api/missions 的行直出，界面不再猜。
          title: String(row.missionTitle || row.title || t('stewardShell.drawer.missionUnfiled')),
          aggregateState: String(row.aggregateState || ''),
          threadCount: Number(row.threadCount) || 0,
          acceptance: row.acceptance || { done: 0, total: 0 },
          budget: row.budget || {},
          cost: row.cost || {},
          rows: [],
        });
      }
      groups.get(missionId).rows.push(row);
    }
    return [...groups.values()];
  }

  // 33 号文 §4：costText／acceptanceText 的正身已住 steward-drawer.js（判据一处），本模块调用点把
  // 自己那套键（COST_KEYS／ACCEPTANCE_KEYS）与 t 一起递进去 —— 措辞仍是看板原来那五条键，一个字没变。

  function chipsFor(sessionId) {
    let control = chipsBySession.get(sessionId);
    if (!control) {
      control = createQuickSwitchChips({
        api, t, state,
        compact: true,                                   // §8.10 线程行：权限＋模型，引擎收进模型菜单
        // 卡片行没有 permissionMode/engineRoute（GET /api/missions 返回的是任务卡，不是会话元数据）。
        // 打开菜单前按需补一次真会话，补到的那一份进缓存，下一次渲染就喂它。
        hydrate: async id => {
          try {
            const response = await api(`/api/sessions/${encodeURIComponent(id)}`);
            const session = (response && response.session) || null;
            if (session) sessionCache.set(id, session);
            return session;
          } catch { return null; }
        },
        onChanged: session => { if (session && session.id) sessionCache.set(String(session.id), session); },
      });
      chipsBySession.set(sessionId, control);
    }
    return control;
  }

  // chip 要的是【会话】而不是任务卡：先用补齐过的那一份，否则退到组合根已经持有的会话元数据
  // （state.sessions 里的 permissionMode 是权威字段，零新增请求），最后才退到只有 id 的空壳。
  function sessionForRow(row) {
    const id = String(row.sessionId || '');
    if (sessionCache.has(id)) return sessionCache.get(id);
    const metas = (state && Array.isArray(state.sessions)) ? state.sessions : [];
    return metas.find(meta => meta && String(meta.id) === id) || { id, title: row.title || '' };
  }

  // F5a：动作 = 图标 ＋ 原来那句人话（不做纯图标 —— 停止／回退这类动作不该让人靠猜）。
  // 字形名是第四个参数，缺席就还是纯文字按钮；文案与 dataset 一个字没动。
  // 「＋ 线程」【刻意不给】字形：那句文案本身就以「＋」开头，配上 plus 会变成「＋ ＋ 线程」
  // （第一版真是这么渲染的，看板截图当场看出来的）。文案里已经有的符号不再画第二遍。
  function boardButton(labelKey, handler, dataset, iconName) {
    const button = el('button', 'steward-board-btn', t(labelKey));
    button.type = 'button';
    if (dataset) Object.assign(button.dataset, dataset);
    if (iconName) {
      const glyph = icon(iconName, 12);
      if (glyph) button.insertBefore(glyph, button.firstChild);
    }
    button.onclick = handler;
    return button;
  }

  // 状态药丸：一枚字形 ＋ 原来那句人话。字形由五态值派生（icons.js 的 missionStateIcon），
  // 派生不出来就只有文字 —— 本模块不为「没有字形的那一态」编一个默认图标。
  // 117u-G2 B2：把五态值【原样】写在药丸上。修前这个事实只挂在那颗点的 data-state 上，而 B2 之后
  // 那颗点归线程色 —— 不写上来，「这一行现在是什么态」在 DOM 里就只剩一句人话（会随语言变）。
  // 与线程详情栏那枚药丸（G1 的 stateNode.dataset.state）是同一种写法，值仍然只来自 threadStateOf。
  // 刻意【不】跟着换皮：本行唯一带颜色的东西仍然是「它在问你」那一枚（I8 立的），五态药丸在看板上
  // 保持安静的中性皮 —— 换成共享基元那套语义色就是在一行里点起第二盏灯。
  function statePill(value) {
    const pill = el('span', 'steward-board-pill', stateLabel(value));
    if (value) pill.dataset.state = value;
    const glyph = missionStateIcon(value, 12);
    if (glyph) { pill.classList.add('has-icon'); pill.insertBefore(glyph, pill.firstChild); }
    return pill;
  }

  // 117u-G3：B3 那条判据（「这一行的权限与模型跟全局一样吗」）的正身已搬去 steward-chips.js —— 判据
  // 逐字未改，只是换了住处，好让线程详情栏也读同一份（§11.15.7）。本模块只负责把它要的三件东西递
  // 进去：这一行对应的会话、当前全局配置、以及 chips 自己画完的那个宿主（.is-pinned 从那里读）。
  // 那笔「会话元数据不带 engineRoute，所以模型这一半在看板上只会少说不会说错」的账，记在被搬去的
  // 那个函数头上（同一笔账只记一处）。

  // 事项级的两件事实（钱与验收）：13d 一处算好之后投影到它【每一条】线程行上，所以整件事
  // 只许印一次 —— 单线程事项印在那唯一一张卡的卡尾，多线程事项印在事项组的组尾。一个渲染器、
  // 两个落点（G1 那根色条「一份声明两个落点」的同一条道理），不是两份实现。
  function missionFacts(group) {
    const line = el('div', 'steward-board-facts');
    line.appendChild(el('span', 'steward-board-pill', stewardAcceptanceText(group, t, ACCEPTANCE_KEYS)));
    line.appendChild(el('span', 'steward-board-pill', stewardCostText(group, t, COST_KEYS)));
    return line;
  }

  // options.missionId：B5 那枚「＋ 线程」挂的事项（由 renderMissionGroup 递进来，本函数不自己
  // 再推一次分组键）；options.facts：单线程事项的钱与验收线（多线程时为 null，落在组尾）。
  function renderThreadRow(row, options = {}) {
    const sessionId = String(row.sessionId || '');
    const item = paintThreadCard(el('li', 'steward-board-thread'), sessionId);
    item.dataset.sessionId = sessionId;
    const threadState = threadStateOf(row);
    // 五态原样写在卡上。修前它挂在那颗点上（paintDot 的 node.dataset.state），B2 之后点归线程色、
    // 态归药丸，而药丸在「它在问你」那种行上是让位的（见下）—— 不写在卡上，这一行现在处于什么态
    // 在 DOM 里就只剩一句会随语言变的人话。样式层【不读】它（本层零 [data-state] 规则）：它是
    // 事实与调试用的，不是第二个视觉信号。值仍然只来自 threadStateOf，零新增字面量。
    if (threadState) item.dataset.state = threadState;

    const head = el('div', 'steward-board-thread-head');
    head.appendChild(threadDot());
    // 116-5b(§11.8.5):显示名由服务端一处算好(13d buildMissionCard 的 displayTitle,判据在 02 的
    // sessionDisplayTitle),看板只读结果 —— 与本行的 stateLabel / wait.label 同一条纪律。
    // 原话挂 hover(它没被改写,仍是权威);没有摘要时 displayTitle 逐字等于 title,不挂重复的提示。
    const title = el('button', 'steward-board-thread-title', String(row.displayTitle || row.title || sessionId));
    if (row.title && row.displayTitle && row.title !== row.displayTitle) title.title = String(row.title);
    title.type = 'button';
    title.onclick = () => focusThread(sessionId);
    head.appendChild(title);
    // 117r-D5：「速查」是这条线程【是什么】(kind)，不是它【在干什么】(state)。修前它霸占着状态位，
    // 于是一条速查线程无论在跑、在等你还是三小时前就跑完了都只会说「速查中」。判据搬回 kind 之后
    // 这个身份不能就此消失——它是有用的信息(管家自己开的临时线程，不是一件正经交办)，所以在行上
    // 与五态那颗点【并列】给一枚徽标，不替换它。文案复用既有键 mission.state.quick_ask，不新开键。
    // 判据仍然【只读】行上的 kind(13d buildMissionCard 如实取 sessionKind(head) 的那一个)，
    // 本模块不认识 stewardQuick / launchedBy 这些会话头字段，也就长不出第二套「它算不算速查」。
    if (String(row.kind || '') === 'quick_ask') {
      const badge = el('span', 'steward-board-pill', t('mission.state.quick_ask'));
      badge.dataset.kind = 'quick_ask';
      head.appendChild(badge);
    }
    // 117l D4（用户第四轮走查①）：线程真的在问你时，行上给一枚 pill —— 点它就是打开抽屉（那里有
    // 问答框）。判据【只读】行上的 asksYou（06i 的 stewardAsksYou 单点算出，与抽屉同一份），
    // 本模块不写第二套「它算不算在问你」。
    let asksPill = null;
    if (row.asksYou && typeof row.asksYou === 'object' && String(row.asksYou.kind || '')) {
      const kind = String(row.asksYou.kind);
      const pill = el('button', 'steward-board-pill is-asks-you',
        t(STEWARD_BOARD_ASKS_YOU_KEYS[kind] || STEWARD_BOARD_ASKS_YOU_KEYS.soft));
      pill.type = 'button';
      // 待决原话（06i 的 stewardPendingOneLine 出的那一句）挂 hover：pill 上只放「哪一类」，
      // 「具体是什么」在抽屉的问答卡里说全，行上不抢那句话的位置。
      if (row.asksYou.text) pill.title = String(row.asksYou.text);
      pill.dataset.asksYou = kind;
      pill.onclick = () => openThread(sessionId);
      head.appendChild(pill);
      asksPill = pill;
    }
    // B2：状态自此【只由药丸表达】（修前它靠那颗点的颜色说，同一个视觉信号既是身份又是状态）。
    // 真有人在问你时不印这枚：那枚「它在问你／它等你放行」说的是同一件事的更具体版本，两枚并排
    // 就是把一句话印两遍（§11.15.2 病 3 的同一个模具）。判据仍然只有 asksYou 那一个，零新增字面量。
    if (!asksPill) head.appendChild(statePill(threadState));
    const elapsed = elapsedLabel(row.updatedAt, new Date());
    // B4：标题右侧只留「最后动静」—— 钱与验收线搬去了卡尾，不再与线程名争重心。
    if (elapsed) head.appendChild(el('span', 'steward-board-meta', t('stewardShell.board.updated', { elapsed })));
    item.appendChild(head);

    const chipHost = el('div', 'steward-board-chips');
    const control = chipsFor(sessionId);
    control.mount(chipHost);
    control.setSession(sessionForRow(row));
    // B3：跟全局一样就不印（判据见 steward-chips.js 的 chipsWorthPrinting，看板与线程详情栏同一份）。
    // 控件本身照建不误 —— 下一拍它可能就该出场了，而 chipsFor 是每条会话一份的长命实例，不该因为
    // 这一拍没挂上去就被丢掉。
    if (chipsWorthPrinting(sessionForRow(row), (state && state.config) || {}, chipHost)) item.appendChild(chipHost);

    // B4 卡尾一行：等什么 · 钱与验收 · 次级动作。
    const tail = el('div', 'steward-board-tail');
    // 单一的等待原因（§8.10「排队可解释」）：`wait.label` 是全仓唯一判据的输出，本模块只渲染它这一处。
    // 117u-G2：没在等的时候【什么都不说】—— 修前这里回落成五态人话，B2 之后卡头那枚药丸已经把
    // 同一句话说过了，再印一遍就是病 3 那串等重灰字（空的时候由 :empty 收掉，不占位）。
    const wait = (row.wait && typeof row.wait === 'object') ? row.wait : null;
    const waitLine = el('p', 'steward-board-wait', wait ? String(wait.label || '') : '');
    if (wait && Number.isFinite(Number(wait.ahead)) && Number(wait.ahead) > 0) waitLine.dataset.ahead = String(wait.ahead);
    tail.appendChild(waitLine);
    if (options.facts) tail.appendChild(options.facts);

    const actions = el('div', 'steward-board-actions');
    // 116h 交付记录的登记项①在这里落地：等锁时占用者就在 wait.blockedBy 里，给一个「停掉占用者」。
    if (wait && String(wait.reason) === 'lock' && wait.blockedBy) {
      actions.appendChild(boardButton('stewardShell.board.stopBlocker',
        () => stopBlocker(String(wait.blockedBy)), { action: 'stop-blocker' }, 'stop'));
    }
    const lastRun = (row.lastRun && typeof row.lastRun === 'object') ? row.lastRun : null;
    if (lastRun && lastRun.live === true && lastRun.paused !== true) {
      actions.appendChild(boardButton('stewardShell.board.pause',
        () => runAction(sessionId, String(lastRun.id || ''), 'pause'), { action: 'pause' }, 'pause'));
    }
    if (lastRun && lastRun.live === true && lastRun.paused === true) {
      actions.appendChild(boardButton('stewardShell.board.resume',
        () => runAction(sessionId, String(lastRun.id || ''), 'resume'), { action: 'resume' }, 'resume'));
    }
    actions.appendChild(boardButton('stewardShell.board.prioritize', () => prioritize(sessionId), { action: 'prioritize' }, 'up'));
    // 「停止」这一枚停的是【这条线程】，所以是实心方块；管家本人的停机在头部，那一枚是电源符。
    actions.appendChild(boardButton('stewardShell.board.stop', () => stopThread(sessionId), { action: 'stop' }, 'stop'));
    actions.appendChild(boardButton('stewardShell.board.openThread', () => openThread(sessionId), { action: 'open' }, 'open'));
    actions.appendChild(boardButton('stewardShell.board.classicView', () => openClassic(sessionId), { action: 'classic' }, 'monitor'));
    // B5：「＋ 线程」从事项头右上角收进卡尾这一排次级动作 —— 它与「停止／优先／打开」同一档，
    // 不该是每张卡右上角唯一一枚常亮的按钮。挂哪一件由 renderMissionGroup 递进来（同一个分组键，
    // 本函数不自己再推一次）；没有事项可挂时落到空串，与空态那枚是同一条路（「另起一件」）。
    actions.appendChild(boardButton('stewardShell.board.newThread', () => newThread(String(options.missionId || '')), { newThread: '1' }));
    tail.appendChild(actions);
    item.appendChild(tail);
    return item;
  }

  // B1（27 号文 §11.15.2 病 2「看板把 mission 与 thread 各画一遍」）：事项只有一条线程时
  // 【不画事项层】—— 真机三条全是「1 事项 = 1 线程」，画了就是把同一个名字上下印两遍
  // （截图里「季度复盘 / 季度复盘」）。≥2 条才退成一行小标题「事项名 · N 条」＋缩进的线程卡组。
  // 判据只有一个：这一组里【真拿到了几条线程行】（group.rows）。刻意不用行上的 threadCount ——
  // 那是事项的线程总数，含本次 limit 没取回来的那些，用它当判据会在截断时画出一个只有一条卡的组头。
  function renderMissionGroup(group) {
    const section = el('section', 'steward-board-mission');
    section.dataset.missionId = group.missionId;
    const grouped = group.rows.length > 1;
    if (grouped) {
      section.classList.add('is-grouped');
      const head = el('header', 'steward-board-mission-head');
      // 事项聚合态【只读】行上的 aggregateState —— 本模块不写第二套聚合判据。
      // 这颗点仍按【态】上色：事项没有色号（色号是线程的身份）、也没有药丸，B2 那条「色 ≠ 态」
      // 约束的是线程卡上那两个信号，不是这一枚。
      head.appendChild(paintDot(el('span', 'steward-board-dot'), group.aggregateState));
      head.appendChild(el('strong', 'steward-board-mission-title', group.title));
      head.appendChild(el('span', 'steward-board-pill', t('stewardShell.board.threadCount', { n: group.threadCount || group.rows.length })));
      section.appendChild(head);
    }
    const list = el('ul', 'steward-board-threads');
    // B4：钱与验收是【事项】的事实，整件事只印一次 —— 单线程落在那张卡的卡尾，多线程落在组尾。
    for (const row of group.rows) {
      list.appendChild(renderThreadRow(row, {
        missionId: group.missionId,
        facts: grouped ? null : missionFacts(group),
      }));
    }
    section.appendChild(list);
    if (grouped) section.appendChild(missionFacts(group));
    return section;
  }

  function renderBoard() {
    renderStatusLine();
    renderArbiterFacts();
    const host = clear(byId('stewardBoardList'));
    if (!host) return 0;
    const groups = groupRows();
    // 117m-A2：从「N 条等你」跳过来时（多于 1 条那一支），把等你的行排到最前。排的是这一次渲染
    // 用的【副本】—— rows 本身与 GET /api/missions 的行序一个字节不动，看板关掉即复位。
    // sort 在现代 JS 里是稳定的，所以其余行的相对顺序不变。
    if (needsYouFirst && needsYouIds.length) {
      const waiting = new Set(needsYouIds);
      const waits = row => Number(waiting.has(String(row && row.sessionId)));
      for (const group of groups) group.rows = group.rows.slice().sort((a, b) => waits(b) - waits(a));
      groups.sort((a, b) => Number(a.rows.some(waits) ? 0 : 1) - Number(b.rows.some(waits) ? 0 : 1));
    }
    if (!groups.length) {
      // 117l-B2 ②（用户第五轮走查 2）：空态从「一句灰字」变成「一句话 ＋ 一个出口」。
      // 文案与「＋ 线程」都是既有的键，不新开第二套说法；按钮走的也是同一个 newThread。
      const empty = el('div', 'steward-board-empty');
      empty.appendChild(el('p', 'steward-board-empty-say', t('stewardShell.board.statusEmpty')));
      empty.appendChild(boardButton('stewardShell.board.newThread', () => newThread(''), { newThread: '1' }));
      host.appendChild(empty);
      return 0;
    }
    for (const group of groups) host.appendChild(renderMissionGroup(group));
    return groups.length;
  }

  // ── 行动作（全部经 steward-drawer.js 导出的那一段原语，不复制）─────────────────
  async function runAction(sessionId, runId, action) {
    const result = await stewardThreadRunAction({ api, sessionId, runId, action });
    if (!result || result.ok !== true) { failNote(result && result.error); return false; }
    note(t(action === 'pause' ? 'stewardShell.board.paused' : 'stewardShell.board.resumed'));
    await refreshBoard();
    return true;
  }

  async function stopThread(sessionId) {
    const stopped = await stewardThreadStop({ api, sessionId });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return false; }
    note(t('stewardShell.board.stopped'));
    await refreshBoard();
    return true;
  }

  // 116h 登记项①：停在「等你」的线程仍持着 cwd 写锁，会挡住同目录所有线程。看到就能一键停掉它。
  async function stopBlocker(blockedBy) {
    const blocker = rows.find(row => String(row.sessionId) === blockedBy) || null;
    const title = blocker ? String(blocker.title || blockedBy) : blockedBy;
    if (globalThis.confirm && !globalThis.confirm(t('stewardShell.board.stopBlockerConfirm', { title }))) return false;
    const stopped = await stewardThreadStop({ api, sessionId: blockedBy });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return false; }
    note(t('stewardShell.board.stopBlockerDone', { title }));
    await refreshBoard();
    return true;
  }

  async function prioritize(sessionId) {
    try {
      const result = await api('/api/steward/arbiter/prioritize', { method: 'POST', body: JSON.stringify({ sessionId }) });
      if (!result || result.ok !== true) { failNote((result && result.error) || 'prioritize_failed'); return false; }
      // 语义刻意做窄（116h）：只有【还在排队】的那一条能被提到队首；不在队列里不是错误，如实说。
      note(t(result.prioritized === true ? 'stewardShell.board.prioritized' : 'stewardShell.board.notQueued'));
    } catch (error) { failNote(error); return false; }
    await refreshBoard();
    return true;
  }

  // 批量只提供这一项（§8.10）：把每一条【还活着且没暂停】的班组回合逐条暂停。只有在跑的对话回合
  // （没有班组 run）暂停不了 —— 如实报数，不假装批量成功。
  async function pauseAll() {
    const pausable = rows.filter(row => row.lastRun && row.lastRun.live === true && row.lastRun.paused !== true);
    const turnsOnly = rows.filter(row => row.activeTurn === true && !(row.lastRun && row.lastRun.live === true));
    let done = 0;
    for (const row of pausable) {
      const result = await stewardThreadRunAction({ api, sessionId: String(row.sessionId), runId: String(row.lastRun.id || ''), action: 'pause' });
      if (result && result.ok === true) done += 1;
    }
    note(t('stewardShell.board.pauseAllDone', { done, turns: turnsOnly.length }));
    await refreshBoard();
    return done;
  }

  function newThread(missionId) {
    try {
      doc().dispatchEvent(new CustomEvent(STEWARD_NEW_THREAD_EVENT, { detail: { missionId, fromSessionId: '' } }));
    } catch { /* 无 CustomEvent 的宿主 */ }
    setBoardOpen(false);
    return missionId;
  }

  async function openClassic(sessionId) {
    setBoardOpen(false);
    try { await openClassicWindow(sessionId); } catch (error) { failNote(error); }
    return sessionId;
  }

  // 焦点线程：用户显式点过就【钉住】，之后的自动挑选不再把它换掉（换回自动要么关掉这一件、
  // 要么点别的线程）。宽屏常驻时抽屉就是右栏本身（同一个节点），窄屏才退回覆盖式打开。
  // 117s-B（用户第九轮走查①④）：本函数是全模块唯一的「有人【请求】聚焦这条线程」入口（焦点／
  // 打开事件、行标题、行上的「打开」四条路都经它），所以强刷那一刷只挂在这里 —— 判据与理由写在
  // syncNow 的头注里。
  function focusThread(sessionId) {
    pinnedId = String(sessionId || '');
    if (!syncNow({ focusRequest: true }) && drawer && typeof drawer.openThread === 'function') drawer.openThread(pinnedId);
    return pinnedId;
  }
  // 「打开」= 打开抽屉那一份并把看板收起来（不然它盖着自己要看的东西）。
  // 它同时把「关掉」过的偏好清掉：关掉的意思是「别自己占着右栏」，而不是「以后都别给我看」——
  // 用户显式点「打开」就是要看，这也是关掉之后把「现在这一件」请回来的那条路（否则没有回头路）。
  function openThread(sessionId) {
    setNowClosed(false);
    const id = focusThread(sessionId);
    setBoardOpen(false);
    return id;
  }

  // F3「就地回答」：等你的那条小行按下去 = 把这条线程变成【抽屉本体】，并把光标送进抽屉自己
  // 那个回答口 —— 有问答卡就是卡里的输入框（focusAsk，117m-A2 就有；「N 条等你」那条路也是这么
  // 点的），没有卡就落到底部「直接对这条线程说」（focusComposer）。于是答案仍然走抽屉那唯一一条
  // 递话路径（POST /api/steward/relay ／ /api/chat/answer），本模块一个字节的发送逻辑都没有，
  // 也就不可能长出第二条发送路径 —— 这是「就地回答」在零重复前提下的唯一诚实形状。
  function answerHere(sessionId) {
    const id = openThread(sessionId);
    if (drawer && typeof drawer.focusAsk === 'function' && drawer.focusAsk()) return id;
    if (drawer && typeof drawer.focusComposer === 'function') drawer.focusComposer();
    return id;
  }

  // ── ③ 「现在这几件」：≥1000px 常驻，焦点那条是同一个抽屉的 docked 挂法，其余叠成小行 ──────
  function nowClosed() {
    try { return localStorage.getItem(STEWARD_NOW_CLOSED_KEY) === '1'; }
    catch { return false; }
  }
  function setNowClosed(closed) {
    try {
      if (closed) localStorage.setItem(STEWARD_NOW_CLOSED_KEY, '1');
      else localStorage.removeItem(STEWARD_NOW_CLOSED_KEY);
    } catch { /* 本机偏好不可用时不影响本次会话 */ }
    return closed;
  }
  function wideEnough() {
    if (!globalThis.matchMedia) return true;
    return globalThis.matchMedia(`(min-width: ${STEWARD_NOW_MIN_WIDTH}px)`).matches;
  }

  // ── F3：右栏那两条「小行叠」──────────────────────────────────────────────────────
  // 容器按需建、始终夹着抽屉那一份。搬的永远只有【自己的】这两个节点：抽屉是 setMount('docked')
  // 挂进 #stewardNowBody 的，本模块一次都不碰它（E 组纪律：一份实现、两种挂法）。
  // 每一趟都重新摆一次位置，是因为抽屉可能在 overlay ↔ docked 之间来回搬（窄屏／关掉／切壳），
  // 回到 docked 时它被 appendChild 到末尾 —— 那时候只要把下面那条 stack 再 append 一次就复位了。
  function nowStack(which) {
    const id = STEWARD_NOW_STACK_IDS[which];
    let list = byId(id);
    if (!list) {
      list = el('ul', 'steward-now-stack');
      list.id = id;
      list.dataset.stack = which;
    }
    return list;
  }
  function placeNowStacks(before, after) {
    const body = byId('stewardNowBody');
    if (!body) return false;
    if (body.firstChild !== before) body.insertBefore(before, body.firstChild);
    if (body.lastChild !== after) body.appendChild(after);
    return true;
  }

  // 一条小行：色点＋名字＋状态药丸；在跑／等你的多一行「它刚说／它在问你」，已收工／已停工折成
  // 一行。「展开还是折成一行」的判据【只有一处】—— paintDot 出的 data-tone（dockToneForMissionState
  // 的四档，与看板行那颗点、交办台 dock 座同一份判据），所以本模块不因为多了这一面而多认一个
  // 五态字面量；那一行说什么也只读行上既有的两个事实：asksYou.text（06i 的 stewardPendingOneLine
  // 单点算出，与抽屉问答卡同源）与 lastSay（13d 投影出的 head.summary），本模块不编第三句。
  function renderNowThread(row) {
    const sessionId = String(row.sessionId || '');
    // D4（27 号文 §11.15.3）：小行＝同一枚线程卡的【最紧密度】（色条＋色点＋名＋药丸）。骨架与
    // 看板行、对话流、线程详情栏是同一份 .steward-tcard-* 声明，色号是同一张登记表发的号。
    const item = paintThreadCard(el('li', 'steward-now-thread'), sessionId);
    item.dataset.sessionId = sessionId;
    const threadState = threadStateOf(row);
    // 「展开还是折成一行」的判据【一个字没变】：还是那四档 tone（dockToneForMissionState 的表现，
    // 与看板行那颗点、交办台 dock 座同一份）。变的只是不必再造一颗点来读它 —— 见 toneOf 的头注。
    const tone = toneOf(threadState);
    item.dataset.tone = tone;
    const main = el('button', 'steward-now-thread-main');
    main.type = 'button';
    // 点任意一行 = 让它成为抽屉本体（focusThread 是本模块唯一的「有人请求聚焦」入口，
    // 强刷、回退、钉住三件事都在它里面，这里不另走一条）。
    main.onclick = () => focusThread(sessionId);
    const head = el('span', 'steward-now-thread-head');
    head.appendChild(threadDot());
    const titleText = String(row.displayTitle || row.title || sessionId);
    head.appendChild(el('span', 'steward-now-thread-title', titleText));
    head.appendChild(statePill(threadState));
    main.appendChild(head);
    main.title = titleText;
    const asks = (row.asksYou && typeof row.asksYou === 'object' && String(row.asksYou.kind || '')) ? row.asksYou : null;
    const say = String((asks && asks.text) || row.lastSay || '');
    if ((tone === 'attention' || tone === 'active') && say) {
      main.appendChild(el('span', 'steward-now-thread-say', say));
    }
    item.appendChild(main);
    // 就地回答只给【真有人在问你】的那一行（判据仍然只读行上的 asksYou，与看板行那枚 pill 同源）。
    // 焦点那条本来就没有小行 —— 它是抽屉本体，回答框在抽屉里开着。
    if (asks) {
      item.appendChild(boardButton('stewardShell.board.answerHere', () => answerHere(sessionId), { action: 'answer' }, 'send'));
    }
    return item;
  }

  // 头上那个数：右栏此刻叠着几条线程。文案复用既有的「N 条线程」，不新开第二套计数说法；
  // 节点由本模块建（index.html 的静态骨架一个 slot 都没加）。
  function renderNowCount(now, total) {
    const bar = now.querySelector('.steward-now-bar');
    if (!bar) return 0;
    let count = bar.querySelector('.steward-now-count');
    if (!count) {
      count = el('span', 'steward-now-count');
      const close = byId('stewardNowCloseBtn');
      if (close && close.parentNode === bar) bar.insertBefore(count, close);
      else bar.appendChild(count);
    }
    count.textContent = t('stewardShell.board.threadCount', { n: total });
    return total;
  }

  // 重画判据：行的「身份／五态／名字／那一句」有一处变了才重画 —— 否则用户正按着某一行时，
  // 每一拍都会把它连根拔掉（chip 菜单那条 304 纪律的同一条道理）。
  let nowSignature = '';
  function renderNow(focusId) {
    const now = byId('stewardNow');
    if (!now) return 0;
    const before = nowStack('before');
    const after = nowStack('after');
    placeNowStacks(before, after);
    renderNowCount(now, rows.length);
    now.dataset.focusId = String(focusId || '');
    const signature = JSON.stringify([String(focusId || ''), rows.map(row => [
      String(row.sessionId || ''), threadStateOf(row), String(row.displayTitle || row.title || ''),
      String((row.asksYou && row.asksYou.text) || row.lastSay || ''),
    ])]);
    if (signature === nowSignature) return rows.length;
    nowSignature = signature;
    clear(before);
    clear(after);
    // 行序【原样取服务端】：117s-A 的 D1 已经在 13d 一处排好（状态优先、其次 updatedAt），
    // 看板、抽屉页签、右栏三面消费同一份序 —— 这里再排一次就是第二份判据（也会与另外两面打架）。
    // 焦点那条不画小行：它就是下面／上面那一份抽屉本体。行里还没有它（管家刚开的新线程，见
    // currentFocusId 的头注）时 index 是 -1，其余线程整体落到抽屉【下面】，抽屉留在最上头。
    const index = rows.findIndex(row => String(row.sessionId || '') === String(focusId || ''));
    rows.forEach((row, at) => {
      if (at === index) return;
      (index >= 0 && at < index ? before : after).appendChild(renderNowThread(row));
    });
    return rows.length;
  }

  // 右栏收起时把小行也清掉（藏着的那一份不留旧行；抽屉那一份由 syncNow 自己 closeDrawer）。
  function clearNow() {
    const now = byId('stewardNow');
    const before = byId(STEWARD_NOW_STACK_IDS.before);
    const after = byId(STEWARD_NOW_STACK_IDS.after);
    if (before) clear(before);
    if (after) clear(after);
    if (now) now.dataset.focusId = '';
    nowSignature = '';
    return true;
  }

  function currentFocusId() {
    // 117r-D2（用户第八轮走查①）：「rows 里没有它」不等于它不存在，只等于【看板还没去问过】——
    // rows 是上一趟 GET /api/missions 的快照，管家刚建出来的那条线程一定不在里面。原来这道门
    // 会把刚钉上的新线程否掉、回落去自动挑【别的】那条，挑不出来还会把 #stewardNow 整块收起并
    // closeDrawer()，恰好把抽屉刚打开的那一份关掉。所以「还没被行核实」的那一小段无条件认这一钉；
    // 核实完（verifyPinnedRow 的 finally）立刻交回下面这道原判据，一个字不改。
    if (pinnedId && (pinnedUnverified || rows.some(row => String(row.sessionId) === pinnedId))) return pinnedId;
    const focus = focusThreadFor(threadViews());
    return focus ? String(focus.sessionId) : '';
  }

  // 117s-B（用户第九轮走查①「递话给已有线程也不会自动打开线程详情页」／④「给已收工的线程重新
  // 递话，『它刚说』更新不够及时」——同一个根）：本函数最后一行原来是
  //   `if (drawer.currentSessionId() !== focusId) drawer.openThread(focusId);`
  // ——【相等时什么都不做】。管家递话给一条抽屉正开着的线程时，steward:focus-thread 带的正是同一个
  // id：行刷了、钉子设了、抽屉却原样不动，屏幕上留着「已收工」与上一回合的「它刚说」，要等抽屉
  // 自己的空闲节拍（config.stewardPollMs，用户真机 15 s）才发现线程又活了。117r-D2 修的是另一半
  // （「行里还没有它」的新线程），这一半一直没人管。相等分支改成【强刷一次】：refreshOnce 是
  // 117m-A2 为「右栏已经开着这一条」这种情形留的既有 API，不新起取数路径、不加计时器
  // （F1 仍然只准本模块一处 setInterval／一处 clearInterval）。
  //
  // 为什么用 focusRequest 门着而不是无条件刷：syncNow 还被 refreshBoard 的每一拍、closeNow、
  // leaveSteward、断点变化各调一次。无条件强刷等于把抽屉的取数频率绑到看板节拍上，而且抽屉那边
  // refreshOnce 跑完会把节拍闸清零（117s-B 的另一半），于是空闲线程也会被永久按在 5 s 一拍上 ——
  // 那是另造一个毛病，不是这一条的修法。真正该刷的时刻只有一个：有人【请求聚焦】这条线程。
  function syncNow({ focusRequest = false } = {}) {
    const now = byId('stewardNow');
    if (!now || !drawer) return false;
    const focusId = currentFocusId();
    const show = isStewardMode() && wideEnough() && !nowClosed() && Boolean(focusId);
    now.hidden = !show;
    if (!show) {
      // 程序性收起（窄屏／切壳／没有可看的线程）不是用户「关掉」，不落本机偏好。
      suppressCloseRecord = true;
      try { if (drawer.mountMode() === 'docked') drawer.closeDrawer(); drawer.setMount('overlay'); }
      finally { suppressCloseRecord = false; }
      clearNow();
      return false;
    }
    drawer.setMount('docked');
    // F3：先把小行叠摆好（它要夹着刚挂进来的那一份抽屉），再决定抽屉自己开哪一条。
    renderNow(focusId);
    if (drawer.currentSessionId() !== focusId) drawer.openThread(focusId);
    // 不 await：syncNow 的返回值是【同步的】「右栏这一份接住了没有」，focusThread 的回退判据
    // （`if (!syncNow()) drawer.openThread(...)`）、closeNow、leaveSteward 与断点回调都拿它当同步
    // 布尔用；改成 async 会让那条回退恒真（Promise 是真值），宽屏没接住时就再也退不回覆盖式打开。
    // 失败自吞：一次强刷没成不该把右栏打回去，下一拍抽屉自己还会再判一次。
    else if (focusRequest && typeof drawer.refreshOnce === 'function') drawer.refreshOnce().catch(() => {});
    return true;
  }

  function closeNow() {
    setNowClosed(true);
    pinnedId = '';
    syncNow();
    return true;
  }

  // ── 看板开关 ────────────────────────────────────────────────────────────────────
  function isBoardOpen() {
    const board = byId('stewardBoard');
    return Boolean(board) && board.hidden === false;
  }
  function setBoardOpen(open) {
    const board = byId('stewardBoard');
    const line = byId('stewardStatusLine');
    if (!board) return false;
    board.hidden = !open;
    // 117m-A2：「等你的排最前」只活在【这一程】—— 看板一关就复位，下次点开还是后端那个行序。
    if (!open) needsYouFirst = false;
    if (line) line.setAttribute('aria-expanded', open ? 'true' : 'false');
    syncPolling();
    if (open) void refreshBoard();
    return open;
  }

  // ── 刷新与轮询 ──────────────────────────────────────────────────────────────────
  // 行没变（304）就不重画正文 —— 既省事，也不会在用户正开着某个 chip 菜单时把它连根拔掉。
  async function refreshBoard() {
    lastRefreshAt = Date.now();   // 117j W2-5：手动刷新也重置节拍，不让下一拍紧跟着再拉一次
    const changed = await loadMissions();
    await loadArbiter();
    if (changed) renderBoard();
    else { renderStatusLine(); renderArbiterFacts(); }
    syncNow();
    if (changed) { try { onRowsChanged(rows.length); } catch { /* 宿主重画失败不该把看板打回去 */ } }
    return rows.length;
  }

  // 117r-D2（用户第八轮走查①）：文件头那条刷新纪律列了五个确定性时刻，「焦点事件」这一刷
  // 【从来没有实现过】—— focusFrom 里一个 refresh 都没有。于是「刚开的线程」这个最需要刷新的
  // 时刻，恰恰是唯一没刷的。这里把它补上，并让「未核实」这个位是【有界的】：这一趟跑完（无论
  // 成败）就清位、再 syncNow 一次 —— 从这一刻起恢复原判据，行里真的没有它（线程被归档／删了）
  // 就正常回落自动挑选。不做「一钉就永久信任」：那样一条真的不存在的线程会把右栏永远占着。
  async function verifyPinnedRow() {
    try { await refreshBoard(); }
    finally { pinnedUnverified = false; syncNow(); }
  }

  function pollIntervalMs() {
    const raw = Number(state && state.config && state.config.stewardPollMs);
    return Number.isFinite(raw) && raw > 0 ? Math.max(STEWARD_BOARD_POLL_MS_MIN, raw) : STEWARD_BOARD_POLL_MS_DEFAULT;
  }

  // 117j W2-5（用户走查④，与抽屉同一条纪律）：表按下限（5s）走，真要不要拉由这一拍自己判 ——
  // 有线程在跑就每拍都拉（「跑完了」最多 5 秒就出现在看板与「现在这一件」上），空闲时仍按配置节拍。
  // 不动态换表的理由同抽屉：F1/F3 锁死了本模块只有一处 setInterval 与那一个 syncPolling 形状。
  let lastRefreshAt = 0;
  function anyThreadRunning() {
    return rows.some(row => row && row.activeTurn === true);
  }
  async function pollTick() {
    const due = anyThreadRunning() ? STEWARD_BOARD_POLL_MS_MIN : pollIntervalMs();
    if (Date.now() - lastRefreshAt < due - POLL_DUE_SLACK_MS) return;
    await refreshBoard();
  }

  let pollTimer = 0;
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  function startPolling() {
    if (pollTimer) return;
    // 表走下限，节拍由 pollTick 自己按「有没有在跑的线程」判（见那里的头注）。
    pollTimer = setInterval(() => { void pollTick(); }, STEWARD_BOARD_POLL_MS_MIN);
  }
  // 唯一入口：看板打开 且 还在管家模式 且 页面可见 —— 任一为否立刻停表（零后台活动）。
  function syncPolling() {
    if (isBoardOpen() && isStewardMode() && !(doc() && doc().hidden)) startPolling();
    else stopPolling();
  }

  // 切离管家模式：看板收起、右栏收起、计时器清干净（本机的「关掉」偏好不受影响）。
  function leaveSteward() {
    const board = byId('stewardBoard');
    if (board) board.hidden = true;
    const line = byId('stewardStatusLine');
    if (line) line.setAttribute('aria-expanded', 'false');
    needsYouFirst = false;
    pinnedId = '';
    syncNow();
    stopPolling();
    return true;
  }

  function bindStewardBoard() {
    const line = byId('stewardStatusLine');
    if (line) {
      line.setAttribute('aria-expanded', 'false');
      line.onclick = () => setBoardOpen(!isBoardOpen());
    }
    // 117m-A2：「N 条等你」的去处（恰好 1 条直接开那条线程，多于 1 条拉开看板并把它们排到最前）。
    const needsYouGo = byId('stewardStatusNeedsYouBtn');
    if (needsYouGo) { needsYouGo.hidden = true; needsYouGo.onclick = () => { goToNeedsYou(); }; }
    const max = byId('stewardBoardMax');
    if (max) max.onchange = () => { void saveMaxParallel(max.value); };
    const pause = byId('stewardBoardPauseAllBtn');
    if (pause) pause.onclick = () => { void pauseAll(); };
    const classic = byId('stewardBoardClassicBtn');
    if (classic) classic.onclick = () => { setBoardOpen(false); switchWholeShell(); };
    const close = byId('stewardNowCloseBtn');
    if (close) close.onclick = () => closeNow();

    if (drawer && typeof drawer.setOnClosed === 'function') {
      // 关掉 docked 那一份（×／Esc／「交回管家」）＝ 关掉「现在这一件」，回单列并记住。
      drawer.setOnClosed(mount => { if (mount === 'docked' && !suppressCloseRecord) closeNow(); });
    }

    const document_ = doc();
    if (document_) {
      // 117r-D2（用户第八轮走查①「管家新开线程不会自动打开线程详情页了」）：这里原来是本模块
      // focusThread() 的一份【弱化抄写】—— 只写 pinnedId ＋ syncNow，把「宽屏那一份没接住就退回
      // 覆盖式打开抽屉」那条回退整个丢了（同 117n-M1 的收编纪律：同一件事只留一处实现）。
      // 改成调那一份，并把派进来的这一钉先记成【未核实】，随即补上「焦点事件」这一刷。
      const focusFrom = event => {
        const id = event && event.detail && event.detail.sessionId;
        if (!id) return;
        pinnedUnverified = true;
        focusThread(id);
        void verifyPinnedRow();
      };
      document_.addEventListener(STEWARD_FOCUS_THREAD_EVENT, focusFrom);
      document_.addEventListener(STEWARD_OPEN_THREAD_EVENT, focusFrom);
      document_.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isBoardOpen()) { event.stopPropagation(); setBoardOpen(false); }
      });
      document_.addEventListener('visibilitychange', () => {
        syncPolling();
        if (isStewardMode() && !document_.hidden) void refreshBoard();
      });
    }
    if (globalThis.MutationObserver && document_ && document_.documentElement) {
      new MutationObserver(() => { if (isStewardMode()) void enterSteward(); else leaveSteward(); })
        .observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    if (globalThis.matchMedia) {
      try { globalThis.matchMedia(`(min-width: ${STEWARD_NOW_MIN_WIDTH}px)`).addEventListener('change', () => syncNow()); }
      catch { /* 老浏览器没有 addEventListener on MediaQueryList */ }
    }
    if (isStewardMode()) void enterSteward();
    return true;
  }

  // 进壳：刷一次行与仲裁面（一次性，不起计时器），状态行随即有真数字，「现在这一件」随即就位。
  async function enterSteward() {
    await refreshBoard();
    syncPolling();
    return rows.length;
  }

  return Object.freeze({
    bindStewardBoard,
    setBoardOpen,
    isBoardOpen,
    refreshBoard,
    enterSteward,
    closeNow,
    syncNow,
    // 117g：返回带要显示「事项名」，读的是本模块已经取回来的那一份行（不另发请求、不另存一份）。
    missionTitleFor: sessionId => {
      const row = rows.find(item => String(item.sessionId) === String(sessionId));
      return row ? String(row.missionTitle || row.title || '') : '';
    },
    focusThreadId: () => currentFocusId(),
    // 117j W2-4：壳层的状态轮询要按「有没有线程在跑」决定节拍。这个事实看板每一拍都已经算过
    // （行上的 activeTurn），开放一个只读句柄比让壳层再拉一次 /api/missions 便宜得多。
    hasRunningThread: () => anyThreadRunning(),
    // 117m-A3(A2 报回的洞①):头像的「等你」此前只由管家自己的 pendingCount 触发 ——
    // presence 里那个 needsYouCount 字段声明了、steward-presence.js:64 也读了,但【全仓没有一处写它】,
    // 于是线程级待决(用户⑤⑥ 那 14 条 permission)根本不进头像。这里开一个只读句柄,与
    // hasRunningThread 同一个先例:计数仍然只有 renderStatusLine 那一处算(needsYouIds 就是它的产物),
    // 不新开第二个计数源。
    needsYouCount: () => needsYouIds.length,
  });
}
