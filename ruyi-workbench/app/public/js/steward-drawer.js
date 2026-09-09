'use strict';

import './mission-state.js';
// 117l D2：抽屉不再直调 fetch（原来那一处是 POST /api/chat/stream，已被 /api/steward/relay 取代），
// 所以 net.js 这边要的不再是 authHeaders 而是 apiErrorInfo —— relay 的失败是 409 的结构化信封
// （propose_required / steward.busy），直接 String() 会把整个 JSON 打进抽屉那行小字。
import { apiErrorInfo } from './net.js';
import { acceptanceItems, activeAcceptanceIndex, taskProgress, elapsedLabel } from './preview-task-sheet.js';
import { describeTurnActivity } from './turn-activity.js';
// 117u-G3（§11.15.7）：chipsWorthPrinting 是【看板与本文件共用】的那一份「跟全局一样吗」判据。
// 它住在 steward-chips.js 而不是看板里，正是因为本文件不能反向 import 看板（steward-board.js 已经
// import 本文件）—— 详见那边的函数头注释。本文件不自己比对任何会话字段。
import { createQuickSwitchChips, doc, byId, el, clear, chipsWorthPrinting } from './steward-chips.js';   // 117n-M1：DOM 基础件复用（doc/byId/el/clear 不再本地重复）
// F5a（27 号文 §11.13.1「F 追加」）：状态药丸里那枚字形。missionStateIcon 是【纯派生】
// （五态值 → 字形名），不是第二份五态枚举 —— 谁处在哪一态仍然只由 mission-state.js 判，
// 本文件也仍然一个五态字面量都没有（它只把 threadStateOf 的返回值原样递进去）。
import { missionStateIcon } from './icons.js';
// 117u-G1（27 号文 §11.15.3 D1「详情头换成同一枚卡头」）：线程卡的三样【共享事实】从对话区那一份
// 拿，不在本文件另起第二份 —— 色号登记（stewardThreadHueFor：同一条线程在对话流／频道条／抽屉／
// 看板恒是同一个号）、五态词表（stewardThreadStateKey：查得到就用共享那条键）、相对时间的人话
// （stewardAgoLabel：两处卡头说同一句「3 分钟前」）。依赖方向 board → drawer → conversation
// 是既有方向（steward-board.js 已经 import 这两个模块），不成环。
import { stewardThreadHueFor, stewardThreadStateKey, stewardAgoLabel } from './steward-conversation.js';

// 第117波 117d：线程抽屉（27 号文 §8.2 L2 / §8.13 逐条）。
//
// 它回答的是「用户不看 2.0 消息流也要知道线程在说什么、该对它说什么」。区块顺序是契约（骨架静态写在
// index.html 里，本文件只填内容），自上而下：
//   ① 事项行 ② 线程页签 ③ 线程头 ④ 快切 chip ⑤ 它刚说 ⑥ 你可以说 ⑦ 接力 ⑧ 三问 ⑨ 验收项 ⑩ 现场 ⑪ 底部
//
// 复用而不是复制（117d 门）：
//   · 验收项 → preview-task-sheet.js 的 acceptanceItems / activeAcceptanceIndex / taskProgress / elapsedLabel；
//   · 三问   → turn-activity.js 的 describeTurnActivity（本文件不定义同名函数）；
//   · 五态   → mission-state.js 的 fromCard（UMD，import 后挂在 globalThis.MissionState，与 preview-shell 同款）；
//   · 快切   → steward-chips.js 的 createQuickSwitchChips（117g 的 2.0 顶栏与 117h 的看板行 mount 同一个工厂）。
//     本文件【不自己实现权限档的 PATCH】——线程权限只有 steward-chips.js 一个写口。
//
// 轮询纪律（延续 117b 的 C2a，本文件自己那一份）：全文件恰好一处 setInterval（startPolling）与一处
// clearInterval（stopPolling），唯一入口 syncPolling() 先判「抽屉开着 && 管家模式 && 页面可见」，
// 任一为否即停。触发点：抽屉开关、data-shell-mode 的 MutationObserver、visibilitychange。
//
// 「不经管家」（§8.13）：你可以说与底部输入框直接对线程说话 —— 117l D2 起【一律走 POST
// /api/steward/relay】，四通道（在等回答→当答案／在等批准→不代答／在跑→插话／空闲→新回合）由
// 服务端一处判定（13h 的 stewardRelayChannelFor）。修前抽屉自己在 /api/steer 与 /api/chat/stream
// 之间猜：线程挂在 request_user_input 上等答案时它判成「不 live」→ 直打 /api/chat/stream，
// 09-workflow 的 `activeChildren.has → stopSession('superseded')` 于是把用户还没回答的那道提问
// 连回合一起杀了（§11.9.2 ①⑥ 的真机事故）。
//
// 117l D4 区块重排（用户第四轮走查①③）：③ 线程头之下多一张「它在问你」卡（问题原文＋选项按钮＋
// 自由回答框），接力／三问／验收项／现场四块折进默认收起的「更多」。

export const STEWARD_QUICK_REPLIES_MAX = 3;
export const STEWARD_DRAWER_POLL_MS_MIN = 5000;
// setInterval 会比标称早几毫秒回来，不留容差的话「到点该拉的那一拍」会被推迟整整一拍。
const POLL_DUE_SLACK_MS = 250;
export const STEWARD_DRAWER_POLL_MS_DEFAULT = 15000;
export const STEWARD_LAST_SAY_SENTENCES = 3;
export const STEWARD_NEW_THREAD_EVENT = 'steward:new-thread';
// 117h：抽屉的两种挂法（一份实现，不存在第二份抽屉区块渲染）。
//   overlay —— 用户主动打开的那一份：<1000px 全屏覆盖并补 aria-modal，≥1000px 右侧 390px 栏；
//   docked  —— 117h 的「现在这一件」：同一个 #stewardDrawer 节点被挪进 #stewardNowBody 常驻右栏。
// 挂法只影响「它挂在哪个父节点、要不要 aria-modal」，区块渲染与取数逐字节共用。
export const STEWARD_DRAWER_MOUNTS = Object.freeze(['overlay', 'docked']);
// 区块顺序即锁：静态件按这个数组在 index.html 里的出现顺序核对（改顺序＝改契约）。
export const STEWARD_DRAWER_BLOCK_IDS = Object.freeze([
  'stewardDrawerMission',
  'stewardDrawerTabs',
  'stewardDrawerHead',
  'stewardDrawerAsk',        // 117l D4：④「它在问你」（走查①：提问弹出来了却没有问答框）
  'stewardDrawerChips',
  'stewardDrawerLastSay',
  'stewardDrawerQuickReplies',
  'stewardDrawerMore',       // 117l D4：⑧「更多」容器（走查③：线程页太多太杂），下面四块住在它里面
  'stewardDrawerRelay',
  'stewardDrawerActivity',
  'stewardDrawerAcceptance',
  'stewardDrawerScene',
  'stewardDrawerFoot',
]);
// 折进「更多」的那四块（顺序即它们在 <details> 里的顺序）。静态锁按这张表核对「四块确实在容器内」。
export const STEWARD_DRAWER_MORE_BLOCK_IDS = Object.freeze([
  'stewardDrawerRelay',
  'stewardDrawerActivity',
  'stewardDrawerAcceptance',
  'stewardDrawerScene',
]);

// 「它刚说」= 最后一条助手消息的【原话】前 ≤3 句（§8.13：不是模型另写的摘要）。中英句末标点同表。
export function lastSaySentences(text, max = STEWARD_LAST_SAY_SENTENCES) {
  const clean = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!clean) return '';
  const parts = clean.match(/[^。！？.!?]+[。！？.!?]*/g) || [clean];
  return parts.slice(0, Math.max(1, max)).join('').trim();
}

// 117l D4（用户第四轮走查③「它刚说更新还是不够及时」）：在跑的回合里，要看的是【尾巴】。
// 服务端的 liveTail 本身就是一段被裁到 600 字的活文本（前面很可能被从中间切断），所以取【末尾】
// ≤3 句而不是开头 —— 与上面那个函数是一对，切句判据（同一张标点表）逐字共用。
export function liveTailSentences(text, max = STEWARD_LAST_SAY_SENTENCES) {
  const clean = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!clean) return '';
  const parts = clean.match(/[^。！？.!?]+[。！？.!?]*/g) || [clean];
  return parts.slice(-Math.max(1, max)).join('').trim();
}

// 「它在问你」（§11.9 D4）。三个来源，优先级固定：
//   ① 正式待决 question（机器可答：有 questionId，前端给选项按钮，答案走 /api/chat/answer）；
//   ② 线程行上的 asksYou（服务端 06i 的 stewardAsksYou 单点判定，看板行与抽屉同一份）；
//   ③ 客户端兜底：没有待决、回合不在跑、最后一条助手消息以问号收尾 → 取末段（≤300 字）。
// ③ 存在的理由：服务端那一路的 soft 判定吃的是总览行里被裁到 160 字的 head.summary，会漏报；
// 抽屉手上有完整的会话正文，所以在这里补一道（只可能补出更多，不会把 ① ② 判反）。
export const STEWARD_ASKS_YOU_CHARS = 300;
// 117m-A2（用户第六轮走查⑤⑥）：四类待决（§3.1 的 permission/question/plan/pool）都算「有人在等你」。
// 修前这里是一句 `if (pending) return null;` —— 只有 question 出得了卡片，于是挂着 permission 的
// 线程打开抽屉什么问答卡都没有，用户看见「需要你 1」却点不开任何东西。
// 顺序与服务端 06i 的 stewardAsksYouForThread 逐字同源（question > permission > plan > pool）。
// 人话【不在这里编】：permission／plan／pool 那一句一律来自服务端 06i 的 stewardPendingOneLine
// （经行上的 asksYou.text 送过来）；行还没到就先不摆那句话，绝不在前端另写一句。
export const STEWARD_ASK_PENDING_KINDS = Object.freeze(['question', 'permission', 'plan', 'pool']);
export function asksYouFrom({ pending = null, rowAsksYou = null, lastAssistantText = '', live = false } = {}) {
  if (pending && String(pending.type) === 'question') {
    const questions = (Array.isArray(pending.questions) ? pending.questions : [])
      .map(q => String((q && (q.question || q.title)) || '').trim()).filter(Boolean);
    return {
      kind: 'question',
      questionId: String(pending.id || ''),
      texts: questions.length ? questions : [String(pending.questionSummary || '').trim()].filter(Boolean),
    };
  }
  const row = (rowAsksYou && typeof rowAsksYou === 'object') ? rowAsksYou : null;
  const rowText = String((row && row.text) || '').trim();
  const type = String((pending && pending.type) || '');
  if (type === 'permission' || type === 'plan' || type === 'pool') {
    return {
      kind: type,
      interventionId: String(pending.id || ''),
      // 决策要打到【这条会话自己】的 id 上：待决本体在它自己那本旁路账里（13d 的 decideIntervention
      // 把「missionId 等于会话自身 id」显式认作合法别名，116g 之后容器 id 那一条反而读不到）。
      missionId: String(pending.sessionId || ''),
      interventionVersion: Math.max(0, Number(pending.interventionVersion) || 0),
      toolName: String(pending.toolName || ''),
      tier: String(pending.tier || ''),
      revertible: pending.revertible === true,
      texts: (row && String(row.kind) === type && rowText) ? [rowText] : [],
    };
  }
  if (pending) return null;                       // replan 等四类白名单之外的：本波不认领，交给 ⑥
  // 行上说「在问你」而本地待决清单还没到（两趟请求之间的那一帧）：照样把问题摆出来。没有本地
  // 待决就没有选项按钮，自由回答走递话单口 —— 服务端那一头照样判成 answer 通道，不会答错地方。
  if (row && String(row.kind) === 'question' && rowText) return { kind: 'question', questionId: '', texts: [rowText] };
  if (row && String(row.kind) === 'soft' && rowText) return { kind: 'soft', texts: [rowText] };
  if (live) return null;                          // 在跑就不算「在问你」（它还在说）
  const said = String(lastAssistantText || '').trim();
  if (!/[？?]$/.test(said)) return null;
  const tail = (said.split(/\n+/).pop() || said).split(/(?<=[。！;；])/).pop().trim() || said;
  return { kind: 'soft', texts: [tail.slice(0, STEWARD_ASKS_YOU_CHARS)] };
}

// 117l D4：活回合正在用的那个工具，界面上得说人话 —— 铁律「界面上永远不出现内部 id（含工具名）」。
// 这张表只覆盖线程侧最常见的那几个；表外的一律落到「一个工具」（诚实兜底，绝不把 Bash/Grep 这种
// 机器把手漏到用户面前）。管家侧的工具人话表在 steward-settings.js，两张表管的是两批工具，不重叠。
export const STEWARD_THREAD_TOOL_LABEL_KEYS = Object.freeze({
  Read: 'stewardShell.drawer.tool.read',
  Write: 'stewardShell.drawer.tool.write',
  Edit: 'stewardShell.drawer.tool.edit',
  Bash: 'stewardShell.drawer.tool.bash',
  Glob: 'stewardShell.drawer.tool.search',
  Grep: 'stewardShell.drawer.tool.search',
  Task: 'stewardShell.drawer.tool.subagent',
  WebSearch: 'stewardShell.drawer.tool.web',
  WebFetch: 'stewardShell.drawer.tool.web',
  TodoWrite: 'stewardShell.drawer.tool.todo',
  // 挂在提问上时 liveTail.tool 就是这个 —— 说「正在用一个工具」是假话，它在【等你】。
  request_user_input: 'stewardShell.drawer.tool.askYou',
});

// 「你可以说」的来源是【确定性优先级】，不是模型生成（§8.13）：
//   待决的选项（question 的候选答案 / permission 的允许·拒绝） > 最后一句是问句 > 五态默认。
// 纯函数、零 DOM、零 import 依赖 —— dev-harness/unit/steward-quick-replies.test.js 直接 import 跑真值表。
export function quickRepliesFor({ pending = null, lastAssistantText = '', state = '', t = key => key } = {}) {
  const label = key => String(t(key));
  const type = String((pending && pending.type) || '');
  if (type === 'question') {
    const questions = Array.isArray(pending.questions) ? pending.questions : [];
    const question = questions[0] || null;
    const options = (question && Array.isArray(question.options)) ? question.options : [];
    const replies = options.slice(0, STEWARD_QUICK_REPLIES_MAX)
      .map(option => ({
        kind: 'question',
        interventionId: String(pending.id || ''),
        questionId: String((question && question.id) || ''),
        optionId: String((option && option.id) || ''),
        // §「问句选项 opt.label || opt.value」——与 interaction-prompts.js 同一取值口径。
        label: String((option && (option.label || option.value)) || ''),
      }))
      .filter(reply => reply.optionId && reply.label);
    if (replies.length) return replies;
  }
  if (type === 'permission') {
    return [
      { kind: 'permission', interventionId: String(pending.id || ''), behavior: 'allow', label: label('stewardShell.drawer.reply.allow') },
      { kind: 'permission', interventionId: String(pending.id || ''), behavior: 'deny', label: label('stewardShell.drawer.reply.deny') },
    ];
  }
  const tail = String(lastAssistantText || '').trim();
  if (/[？?]$/.test(tail)) {
    return [
      { kind: 'say', text: label('stewardShell.drawer.reply.yes'), label: label('stewardShell.drawer.reply.yes') },
      { kind: 'say', text: label('stewardShell.drawer.reply.no'), label: label('stewardShell.drawer.reply.no') },
    ];
  }
  const say = key => ({ kind: 'say', text: label(key), label: label(key) });
  if (state === 'running' || state === 'dispatching') return [say('stewardShell.drawer.reply.holdOn')];
  if (state === 'stopped' || state === 'done') {
    return [say('stewardShell.drawer.reply.continue'), say('stewardShell.drawer.reply.otherWay')];
  }
  return [say('stewardShell.drawer.reply.continue')];
}

// ── 线程动作原语（117d 抽屉与 117h 看板行【共用同一段】，不复制）────────────────────
// 暂停／继续只对「还活着的那一条 run」有意义：快照里最后一条 live run 就是它（与抽屉底部按钮
// 二选一的判据同源）。看板行拿到的是 GET /api/missions/:id 的同一份快照，所以判据也是同一个。
export function pausableRunOf(snapshot) {
  const runs = (snapshot && Array.isArray(snapshot.runs)) ? snapshot.runs : [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (run && run.live === true) return run;
  }
  return null;
}
// 统一 Run 控制端点（pause／resume／retry_node…）。返回稳定信封，调用方自己说人话。
export async function stewardThreadRunAction({ api, sessionId, runId, action }) {
  if (typeof api !== 'function' || !sessionId || !runId) return { ok: false, error: 'not_found' };
  try {
    const result = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, {
      method: 'POST', body: JSON.stringify({ sessionId, action }),
    });
    return (result && result.ok === true) ? result : { ok: false, error: (result && result.error) || 'run_action_failed' };
  } catch (error) { return { ok: false, error }; }
}
// 停任何回合（含仲裁器队列里还没轮到的那一条：116h 的 cancelQueuedTurn 就挂在这条路由上）。
// 117h 的「停掉占用者」用的也是它 —— 等锁那一行点一下，停的就是 blockedBy 指的那条线程。
export async function stewardThreadStop({ api, sessionId }) {
  if (typeof api !== 'function' || !sessionId) return { ok: false, error: 'not_found' };
  try {
    const stopped = await api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId }) });
    return (stopped && stopped.ok === false) ? { ok: false, error: stopped.error || 'stop_failed' } : { ok: true };
  } catch (error) { return { ok: false, error }; }
}

export function createStewardDrawer({
  api = async () => null,
  state = null,
  t = key => key,
  isStewardMode = () => false,
  applyShellMode = null,
  openSession = async () => {},
} = {}) {
  let sessionId = '';
  let session = null;             // GET /api/sessions/:id 的 session
  let resumable = null;           // 同一响应的 resumable（live 判定：在途才走插话通道）
  // 117l D4：同一响应【条件】带出来的活回合尾巴（回合一结束这个键就不在了）。零新请求。
  let liveTail = null;            // { text, tool, updatedAt } | null
  // 116-5b：同一响应信封里的显示名（人起的 > 生成的 > 原话，判据在服务端 02 的 sessionDisplayTitle）。
  let displayTitle = '';
  let missionRows = [];           // GET /api/missions 里与本线程同事项的行（线程行）
  let missionRow = null;          // 其中本线程自己那一行
  let snapshot = null;            // GET /api/missions/:id 的 snapshot（验收项与控制面）
  let pendingForThread = null;    // GET /api/interventions 里本线程最早的一条未决
  // 117g/117h 的三条迟绑定接线（与 117c 的 setPickTargetHandler 同一纪律：不让抽屉 import 那两个
  // 模块，也不动 steward-shell.js 里被静态锁逐字钉住的那一行构造调用）。
  let mountMode = 'overlay';      // 'overlay' | 'docked'（见 STEWARD_DRAWER_MOUNTS）
  let onClosed = () => {};        // 117h：关抽屉时告诉「现在这一件」它被关掉了
  let openClassicWindow = null;   // 117g：统一的「2.0 视窗」入口（切经典壳＋选中会话＋顶部返回带）

  const chips = createQuickSwitchChips({
    api, t, state,
    // chip 改完立即回填：PATCH 的响应已经把新 session 交回来了，这里只需把抽屉其它面刷新一遍。
    onChanged: next => { session = next || session; renderAll(); },
  });

  // 117n-M1：el/clear 从 steward-chips.js import（六个消费方零本地重复定义）。
  function note(text) {
    const target = byId('stewardDrawerNote');
    if (target) target.textContent = String(text || '');
  }
  function failNote(error) {
    const info = apiErrorInfo(error);
    // 117l-B2 ⑤：递话单口（POST /api/steward/relay）在目标线程还排队时回 409 `steward.queued`。
    // 与对话流那一头【同两个键】说同一句人话（stewardShell.chat.errQueued / …Plain），
    // 而不是把服务端那句原文塞进「没做成：…」的模板里 —— 后者读起来像出了故障，其实只是还没轮到它。
    // 判据只看稳定码与 wait.label，一个字都不自己编（label 由服务端一处算，与看板行逐字同源）。
    const code = String((info && info.code) || '');
    if (code === 'steward.queued') {
      const wait = (info && info.params && info.params.wait) || null;
      const label = (wait && typeof wait === 'object' && wait.label) ? String(wait.label) : '';
      note(label ? t('stewardShell.chat.errQueued', { wait: label }) : t('stewardShell.chat.errQueuedPlain'));
      return;
    }
    const message = String((info && info.message) || (error && error.message) || error || 'failed');
    note(t('stewardShell.drawer.failed', { error: message }));
  }

  // ── 五态：只经 mission-state.js（全仓唯一判据），人话走 i18n（LABELS 是中文单语） ──────
  function threadStateOf(card) {
    const missionState = globalThis.MissionState;
    if (!card || !missionState || typeof missionState.fromCard !== 'function') return '';
    return String(missionState.fromCard(card).state || '');
  }
  // 117q-B3b：五态人话统一走中性的 mission.state.*（原 stewardShell.drawer.state.* 已并入，
  // 与看板、交办台三个壳共用同一组键，见 30 号文 §4.4），不再开第二套五态文案。
  // 117u-G1：先查【共享的那一份词表】（steward-conversation.js 的 STEWARD_THREAD_STATE_KEYS，
  // 对话流卡头查的就是它）——重合的那几档从此保证同词，改名它三面一起变。查不到才回落中性模板：
  // 抽屉的态来自 mission-state.js 的六个值，比共享表多 dispatching／quick_ask 两档，回落是为了
  // 不把它们说丢。两条路都不在本文件里写任何一个五态字面量。
  function stateLabel(value) {
    if (!value) return '';
    return t(stewardThreadStateKey(value) || `mission.state.${value}`);
  }

  function isLive() {
    if (resumable && resumable.live === true) return true;
    return Boolean(missionRow) && threadStateOf(missionRow) === 'running';
  }

  // 工具名 → 人话（表外落到「一个工具」）。表住模块顶层，本函数只做查表。
  function threadToolLabel(tool) {
    const key = STEWARD_THREAD_TOOL_LABEL_KEYS[String(tool || '')];
    return key ? t(key) : t('stewardShell.drawer.tool.other');
  }

  // ── 取数 ────────────────────────────────────────────────────────────────────
  async function loadThreadSlice() {
    if (!sessionId) return;
    const id = sessionId;
    const [sessionRes, interventionsRes] = await Promise.all([
      api(`/api/sessions/${encodeURIComponent(id)}`).catch(() => null),
      api('/api/interventions?limit=100').catch(() => null),
    ]);
    if (id !== sessionId) return;                    // 期间用户切了线程，这一趟作废
    if (sessionRes && sessionRes.ok !== false && sessionRes.session) {
      session = sessionRes.session;
      resumable = sessionRes.resumable || null;
      displayTitle = String(sessionRes.displayTitle || '');
      // 117l D4：只在【真有活回合】时下发，所以「键不在」本身就是「回合结束了」的信号 ——
      // 抽屉据此把「它正在说」换回「它刚说」。不落盘、不进任何投影。
      liveTail = (sessionRes.liveTail && typeof sessionRes.liveTail === 'object') ? sessionRes.liveTail : null;
    }
    const list = (interventionsRes && Array.isArray(interventionsRes.pending)) ? interventionsRes.pending : [];
    // 117m-A2：按【与服务端同一条】优先级挑那一条待决（question > permission > plan > pool）。
    // 修前取的是 /api/interventions 按 requestedAt 排好的第一条 —— 同一条线程既挂着 question 又挂着
    // permission 时，抽屉会挑先来的那条、看板行挑优先级最高的那条，两边各说各的。
    // 四类之外（replan）仍回落到「最早的那一条」，三问那一路的既有行为一个字不变。
    const mine = list.filter(item => item && String(item.sessionId) === id);
    pendingForThread = STEWARD_ASK_PENDING_KINDS
      .map(type => mine.find(item => String(item.type) === type) || null)
      .find(Boolean) || mine[0] || null;
  }

  async function loadMissionSlice() {
    if (!sessionId) return;
    const id = sessionId;
    const [missionsRes, snapshotRes] = await Promise.all([
      api('/api/missions?limit=200').catch(() => null),
      api(`/api/missions/${encodeURIComponent(id)}`).catch(() => null),
    ]);
    if (id !== sessionId) return;
    const rows = (missionsRes && Array.isArray(missionsRes.missions)) ? missionsRes.missions : [];
    missionRow = rows.find(row => row && String(row.sessionId) === id) || null;
    const missionId = String((missionRow && missionRow.missionId) || (session && session.missionId) || '');
    missionRows = missionId ? rows.filter(row => row && String(row.missionId) === missionId) : (missionRow ? [missionRow] : []);
    snapshot = (snapshotRes && snapshotRes.snapshot) || null;
  }

  // ── ① 事项行 ────────────────────────────────────────────────────────────────
  function renderMission() {
    const titleNode = byId('stewardDrawerMissionTitle');
    const acceptanceNode = byId('stewardDrawerMissionAcceptance');
    const costNode = byId('stewardDrawerMissionCost');
    if (!titleNode || !acceptanceNode || !costNode) return;
    // 117k（用户走查④）：事项【容器】的标题现在就在行里 —— 116-5b 给 GET /api/missions 的每一行
    // 加了 missionTitle（显式容器＝用户起的名，派生事项＝那条线程的显示名）。此前这里的回落
    // 注释还停在「容器标题不在行里」的旧世界，于是显式事项的行显示的是【本线程的整句原话】，
    // 而同一块面板下面的页签写着生成名 —— 一块面板三个名字指同一件事。按确定性顺序回落：
    //   ① 行里的 missionTitle（116-5b 的权威口径）；
    //   ② 「自成事项」那条线程（sessionId === missionId）的显示名 → 原话；
    //   ③ 一条行都没有（线程还没进投影）：读取中说「读取中…」，读完了才说「未归事项」。
    const missionId = String((missionRow && missionRow.missionId) || '');
    const root = missionRows.find(row => String(row.sessionId) === missionId) || missionRow || null;
    const rootName = root ? String(root.missionTitle || root.displayTitle || root.title || missionId) : '';
    titleNode.textContent = rootName || (loading ? t('stewardShell.drawer.loading') : t('stewardShell.drawer.missionUnfiled'));
    const acceptance = (missionRow && missionRow.acceptance) || null;
    const total = Math.max(0, Number(acceptance && acceptance.total) || 0);
    acceptanceNode.textContent = total
      ? t('stewardShell.drawer.acceptanceCount', { done: Math.max(0, Number(acceptance.done) || 0), total })
      : t('stewardShell.drawer.acceptanceNone');
    costNode.textContent = costText();
  }

  function costText() {
    const costs = (missionRow && missionRow.cost && missionRow.cost.costsByCurrency) || {};
    const spent = Object.entries(costs)
      .filter(([, amount]) => Number.isFinite(Number(amount)))
      .map(([currency, amount]) => `${currency} ${Number(amount).toFixed(4)}`)
      .join(' · ');
    if (!spent) return t('stewardShell.drawer.costNone');
    const budget = (missionRow && missionRow.budget) || {};
    const maxCost = Number(budget.maxCost);
    if (Number.isFinite(maxCost) && maxCost > 0) {
      return t('stewardShell.drawer.costBudget', { cost: spent, budget: `${String(budget.currency || '')} ${maxCost}`.trim() });
    }
    return t('stewardShell.drawer.cost', { cost: spent });
  }

  // ── ② 线程页签 ──────────────────────────────────────────────────────────────
  function renderTabs() {
    const host = clear(byId('stewardDrawerTabs'));
    if (!host) return;
    for (const row of missionRows) {
      const tab = el('button', 'steward-drawer-tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      const selected = String(row.sessionId) === sessionId;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.dataset.sessionId = String(row.sessionId);
      const dot = el('span', 'steward-drawer-dot');
      dot.dataset.state = threadStateOf(row);
      // 116-5b:页签/标题/接力清单三处都读服务端算好的 displayTitle(缺席时逐字回落原话)。
      tab.append(dot, el('span', 'steward-drawer-tab-title', String(row.displayTitle || row.title || row.sessionId)));
      if (row.title && row.displayTitle && row.title !== row.displayTitle) tab.title = String(row.title);
      tab.onclick = () => { if (!selected) openThread(String(row.sessionId)); };
      // 117j copy-P3-4：正经 tablist 的键盘规矩 —— ←/→ 在页签间走，Home/End 跳首尾，环绕。
      // 页签本身已经是 role="tab"（A7 锁），此前却只能用 Tab 一个一个跳过去。
      tab.onkeydown = event => {
        const keys = { ArrowLeft: -1, ArrowRight: 1 };
        const tabs = [...host.querySelectorAll('[role="tab"]')];
        const here = tabs.indexOf(tab);
        if (here < 0 || tabs.length < 2) return;
        let next = -1;
        if (Object.prototype.hasOwnProperty.call(keys, event.key)) next = (here + keys[event.key] + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        if (next < 0) return;
        event.preventDefault();
        const target = tabs[next];
        try { target.focus(); } catch { /* 宿主没有 focus 的环境 */ }
        const sid = target.dataset.sessionId;
        if (sid && sid !== sessionId) openThread(String(sid));
      };
      host.appendChild(tab);
    }
    // 「＋ 线程」：创建本身仍经管家（委托书表单归 117e），这里只派事件 + 把输入区 chip 置为
    // 「在事项下新开」，让用户下一句话直接落到这个事项里。
    const add = el('button', 'steward-drawer-tab', t('stewardShell.drawer.newThread'));
    add.type = 'button';
    add.dataset.newThread = '1';
    add.title = t('stewardShell.drawer.newThreadHint');
    add.onclick = () => {
      const missionId = String((missionRow && missionRow.missionId) || '');
      try {
        doc().dispatchEvent(new CustomEvent(STEWARD_NEW_THREAD_EVENT, { detail: { missionId, fromSessionId: sessionId } }));
      } catch { /* 无 CustomEvent 的宿主 */ }
    };
    host.appendChild(add);
  }

  // ── ③ 线程头 = 那枚共用的线程卡头（117u-G1 / 27 号文 §11.15.3 D1）────────────────────
  // 色条 ＋ 色点 ＋ 线程名 ＋ 五态药丸 ＋ 最后动静 ＋「2.0 视窗」。骨架的长相住在
  // steward-conversation.css 的 .steward-tcard-* 那一组 —— 对话流的卡头与本处是【同一份声明】，
  // 本文件只挂类名与事实：一条样式不写、一个颜色不算、一个五态字面量不认。
  //
  // 色条与色点是纯装饰节点（aria-hidden），index.html 的静态骨架里没有它们的槽 —— 建一次就够：
  // renderHead 每一拍都跑，反复建会把用户正按着的东西连根拔掉（chip 菜单那条 304 纪律的同一条
  // 道理）。「等待原因」那一行挪到卡头【之后】：它 flex-basis:100% 会强制换行，排在「2.0 视窗」
  // 前面的话，那枚按钮就被挤下去、卡头就不再是一行。
  function ensureHeadParts(head) {
    let bar = head.querySelector('.steward-tcard-bar');
    if (!bar) {
      bar = el('span', 'steward-tcard-bar');
      bar.setAttribute('aria-hidden', 'true');
      head.insertBefore(bar, head.firstChild);
    }
    let dot = head.querySelector('.steward-tcard-dot');
    if (!dot) {
      dot = el('span', 'steward-tcard-dot');
      dot.setAttribute('aria-hidden', 'true');
      head.insertBefore(dot, bar.nextSibling);
    }
    let meta = head.querySelector('.steward-tcard-meta');
    if (!meta) {
      meta = el('span', 'steward-tcard-meta');
      const state = byId('stewardDrawerState');
      if (state && state.parentNode === head) head.insertBefore(meta, state.nextSibling);
      else head.appendChild(meta);
    }
    const wait = byId('stewardDrawerWait');
    if (wait && wait.parentNode === head && head.lastElementChild !== wait) head.appendChild(wait);
    return meta;
  }

  // 「最后动静」= 相对时间，与对话流卡头【同一个】实现（stewardAgoLabel，人话交给平台的
  // Intl.RelativeTimeFormat）。锚点沿用本文件既有那一处判据（missionRow.updatedAt ＞
  // session.updatedAt —— settledHead 读的就是这两个），算不出来整段不说，不猜。
  function lastTouchLabel() {
    const touched = String((missionRow && missionRow.updatedAt) || (session && session.updatedAt) || '');
    if (!touched) return '';
    const page = doc() && doc().documentElement ? doc().documentElement.lang : '';
    return stewardAgoLabel(touched, page);
  }

  function renderHead() {
    const headNode = byId('stewardDrawerHead');
    const titleNode = byId('stewardDrawerTitle');
    const stateNode = byId('stewardDrawerState');
    const waitNode = byId('stewardDrawerWait');
    let metaNode = null;
    if (headNode) {
      headNode.classList.add('steward-tcard');
      // 色号问【全仓那一张登记表】要（steward-conversation.js 的 stewardThreadHueFor）：本文件
      // 不自己算、也不自己记，所以同一条线程在这里与在对话流／频道条／看板上恒是同一色。
      if (sessionId) headNode.dataset.threadHue = String(stewardThreadHueFor(sessionId));
      else headNode.removeAttribute('data-thread-hue');
      metaNode = ensureHeadParts(headNode);
    }
    if (titleNode) titleNode.classList.add('steward-tcard-name');
    if (stateNode) stateNode.classList.add('steward-tcard-state');
    const classicNode = byId('stewardDrawerClassicBtn');
    if (classicNode) classicNode.classList.add('steward-tcard-act');
    if (metaNode) {
      const ago = lastTouchLabel();
      metaNode.textContent = ago;
      metaNode.hidden = !ago;
    }
    // 116-5b:显示名优先(GET /api/sessions/:id 的信封带出的那一个,判据在 02 的 sessionDisplayTitle);
    // 拿不到就退回今天的两级回落。原话挂 hover。
    if (titleNode) {
      const name = String(displayTitle || (session && session.title) || (missionRow && missionRow.displayTitle) || (missionRow && missionRow.title) || '');
      // 117k：读到之前不拿内部 id 冒充名字（用户看得见 sess_xxxxxxxx 是纯泄漏）。
      titleNode.textContent = name || (loading ? t('stewardShell.drawer.loading') : sessionId);
      const raw = String((session && session.title) || (missionRow && missionRow.title) || '');
      // 117u-G1：卡头是一行，长名字会被省略号截住 —— 所以没有「原话」可挂时改挂显示名本身，
      // 而不是把 title 摘掉：截断了却连 hover 都看不到全名，是把信息弄丢。
      if (raw && raw !== titleNode.textContent) titleNode.title = raw;
      else if (titleNode.textContent) titleNode.title = titleNode.textContent;
      else titleNode.removeAttribute('title');
    }
    // F5a：状态药丸 = 一枚字形 ＋ 原来那句人话。文字一个字没动（textContent 仍逐字等于
    // stateLabel(...)，既有断言读的就是它），图标只是让扫一眼就分得出在跑／等你／已收工。
    if (stateNode) {
      const stateValue = threadStateOf(missionRow);
      clear(stateNode);
      // 117u-G1：药丸的【色】由共享基元按 data-state 说（.steward-tcard-state[data-state=…]，
      // 与对话流卡头同一张表）。这里只把 threadStateOf 的返回值原样写上去 —— 仍然不认字面量。
      if (stateValue) stateNode.dataset.state = stateValue; else delete stateNode.dataset.state;
      const glyph = missionStateIcon(stateValue, 12);
      if (glyph) stateNode.appendChild(glyph);
      stateNode.appendChild(doc().createTextNode(stateLabel(stateValue)));
    }
    if (!waitNode) return;
    const wait = (missionRow && missionRow.wait) || null;
    const label = wait ? String(wait.label || '') : '';
    waitNode.textContent = label;
    waitNode.hidden = !label;
  }

  // ── ⑤ 它刚说 ────────────────────────────────────────────────────────────────
  function lastAssistantText() {
    const messages = (session && Array.isArray(session.messages)) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.role === 'assistant' && String(message.content || '').trim()) return String(message.content);
    }
    return '';
  }

  // 117l D4（用户第四轮走查③「它刚说更新还是不够及时」）：回合跑起来之后，落盘的助手消息几分钟
  // 都不会变（活回合的文本只在发起那条 /api/chat/stream 连接上流，管家派出去的回合谁也看不见）。
  // 现在在跑时改标题为「它正在说」并显示服务端 liveTail 的【末尾】≤3 句；回合一结束 liveTail 这个键
  // 就不在了，标题与内容自动换回「它刚说」＋落盘原话的【开头】≤3 句。
  function renderLastSay() {
    const head = byId('stewardDrawerLastSayHead');
    const quote = byId('stewardDrawerLastSayText');
    if (!quote) return;
    const tailText = String((liveTail && liveTail.text) || '').trim();
    // 判据【只看 liveTail 在不在】，不叠 isLive()：服务端只在真有活回合时才下发这个键，它比
    // isLive() 准 —— 后者拿不到 resumable.live（GET /api/sessions/:id 的 live 分支根本不回这个字段）
    // 就回落到「事项行的五态是不是 running」，而挂在提问上的回合五态是 needs_you，于是恒判成不在跑。
    const streaming = Boolean(liveTail) && Boolean(tailText);
    if (streaming) {
      if (head) head.textContent = t('stewardShell.drawer.liveSay');
      const tool = String((liveTail && liveTail.tool) || '').trim();
      quote.textContent = liveTailSentences(tailText)
        + (tool ? t('stewardShell.drawer.usingTool', { tool: threadToolLabel(tool) }) : '');
      return;
    }
    if (head) head.textContent = t('stewardShell.drawer.lastSay');
    // ④ 已经把这句问话原文摆出来了就不再重复一遍（走查③「太多太杂」：一屏两遍同一句话）。
    const ask = asksYouNow();
    const said = lastSaySentences(lastAssistantText());
    if (ask && ask.kind === 'soft' && said && ask.texts.some(text => said.indexOf(text) >= 0 || text.indexOf(said) >= 0)) {
      quote.textContent = t('stewardShell.drawer.lastSayInAsk');
      return;
    }
    // 117k：还没读到就说「它还没说过话」是假话（多数时候它刚说过）。
    quote.textContent = said || (loading ? t('stewardShell.drawer.loading') : t('stewardShell.drawer.lastSayEmpty'));
  }

  // ── ④ 它在问你（117l D4）────────────────────────────────────────────────────
  function asksYouNow() {
    return asksYouFrom({
      pending: pendingForThread,
      rowAsksYou: missionRow && missionRow.asksYou,
      lastAssistantText: lastAssistantText(),
      live: isLive(),
    });
  }

  // 待决 question 的选项按钮：与 ⑥「你可以说」【同一份】判据（quickRepliesFor），只是摆在卡片里。
  // 不另写一遍「从 questions[0].options 里取 label||value」—— 那会长出第二套取值口径。
  // 117m-A2：permission 走的也是 quickRepliesFor 的【既有】那一支（它第 164 行本来就出「允许／拒绝」，
  // 修前只是没人把它摆进卡里）；plan／pool 那两枚「批准／驳回」在这里补形状，走的仍是既有的统一
  // 决策契约端点（见 runQuickReply），不新起路径。
  function askOptionReplies() {
    const type = String((pendingForThread && pendingForThread.type) || '');
    if (type === 'question' || type === 'permission') {
      return quickRepliesFor({ pending: pendingForThread, t }).filter(reply => reply.kind === type);
    }
    if (type !== 'plan' && type !== 'pool') return [];
    const base = {
      kind: type,
      interventionId: String(pendingForThread.id || ''),
      missionId: String(pendingForThread.sessionId || ''),
      interventionVersion: Math.max(0, Number(pendingForThread.interventionVersion) || 0),
    };
    return [
      { ...base, action: 'approve', label: t('stewardShell.drawer.reply.approve') },
      { ...base, action: 'reject', label: t('stewardShell.drawer.reply.rejectProposal') },
    ];
  }

  // 117m-A2：卡片标题按【哪一类在等你】说话（question／soft 逐字沿用 117l 那一句）。
  const ASK_HEAD_KEYS = Object.freeze({
    question: 'stewardShell.drawer.asksYou',
    soft: 'stewardShell.drawer.asksYou',
    permission: 'stewardShell.drawer.asksYouPermission',
    plan: 'stewardShell.drawer.asksYouApprove',
    pool: 'stewardShell.drawer.asksYouApprove',
  });
  // 权限档说人话（read/edit/exec 是内部分级，界面上不出现这三个词）。表外一律按 exec 说 ——
  // fail-closed：说重了顶多让人多看一眼，说轻了就是骗人放行。
  const ASK_TIER_KEYS = Object.freeze({
    read: 'stewardShell.drawer.askTier.read',
    edit: 'stewardShell.drawer.askTier.edit',
    exec: 'stewardShell.drawer.askTier.exec',
  });

  function renderAsk() {
    const section = byId('stewardDrawerAsk');
    const list = clear(byId('stewardDrawerAskText'));
    const options = clear(byId('stewardDrawerAskOptions'));
    if (!section || !list || !options) return;
    const ask = asksYouNow();
    section.hidden = !ask;
    const meta = clear(byId('stewardDrawerAskMeta'));
    const answer = byId('stewardDrawerAskAnswer');
    const head = byId('stewardDrawerAskHead');
    if (!ask) return;
    const kind = String(ask.kind || '');
    if (head) head.textContent = t(ASK_HEAD_KEYS[kind] || ASK_HEAD_KEYS.soft);
    for (const text of ask.texts) list.appendChild(el('li', 'steward-drawer-ask-line', text));
    // permission 多两行：「这一步要动：⟨工具人话⟩（⟨档⟩）」＋ 一枚能不能撤回的徽章。
    // 徽章只说【真的知道】的事：revertible 为真才说「可以撤回」，否则如实说「无法自动撤销」——
    // 两句都由服务端那一位落盘的事实决定（07 的 toolIsRevertible），不许编第三种说法。
    if (meta && kind === 'permission') {
      meta.appendChild(el('li', 'steward-drawer-ask-meta-line', t('stewardShell.drawer.askScope', {
        tool: threadToolLabel(ask.toolName),
        tier: t(ASK_TIER_KEYS[String(ask.tier || '')] || ASK_TIER_KEYS.exec),
      })));
      const badge = el('li', 'steward-drawer-ask-meta-line',
        t(ask.revertible === true ? 'stewardShell.drawer.askRevertible' : 'stewardShell.drawer.askIrreversible'));
      badge.dataset.revertible = ask.revertible === true ? '1' : '0';
      meta.appendChild(badge);
    }
    if (meta) meta.hidden = !meta.firstChild;
    // 自由输入只对「答一句话」有意义。permission／plan／pool 是按一下的事，留着输入框只会让人
    // 以为要打完字才算数（真机上那两枚「允许／拒绝」就是这么被当成背景的）。
    if (answer) answer.hidden = kind === 'permission' || kind === 'plan' || kind === 'pool';
    for (const reply of askOptionReplies()) {
      const button = el('button', 'steward-drawer-reply', reply.label);
      button.type = 'button';
      button.dataset.replyKind = reply.kind;
      button.onclick = () => runQuickReply(reply);
      options.appendChild(button);
    }
  }

  // 卡片里的自由回答。正式待决 question 走 /api/chat/answer（content ＋ otherText，与选项按钮
  // 同一条路）；其余（软问句、或行上说在问你而本地待决还没到）走递话单口 /api/steward/relay。
  async function submitAsk() {
    const input = byId('stewardDrawerAskInput');
    const text = input ? String(input.value || '').trim() : '';
    if (!text || !sessionId) return;
    const ask = asksYouNow();
    if (!ask) return;
    if (input) input.value = '';
    if (ask.kind === 'question' && pendingForThread && String(pendingForThread.type) === 'question') {
      const first = (Array.isArray(pendingForThread.questions) ? pendingForThread.questions : [])[0] || null;
      try {
        const answered = await api('/api/chat/answer', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            questionId: String(pendingForThread.id || ''),
            answers: [{ questionId: String((first && first.id) || ''), selectedOptionIds: [], otherText: text }],
            content: text,
          }),
        });
        if (!answered || answered.ok !== true) { failNote((answered && answered.error) || 'answer_failed'); return; }
        note(t('stewardShell.drawer.answered'));
      } catch (error) { failNote(error); return; }
    } else if (!(await sayToThread(text))) return;
    await refreshOnce();
    lastPollAt = 0;   // 与 runQuickReply 同一条：把节拍闸清零，让已经在跑的那张表下一拍真去拉
  }

  // 「打开线程回答」按下去该发生的事（走查①）：抽屉开出来之后，焦点落在问答框里。
  // 117m-A2（走查⑤⑥「点不开」）：焦点落在【第一个可操作控件】上，并把卡片滚进视野 ——
  // permission／plan／pool 没有输入框（renderAsk 把它整块隐藏了），能操作的是那两枚按钮；
  // 只认输入框的话，从「N 条等你」跳过来会一个焦点都不落，人还是找不到要点哪儿。
  // 不加任何计时器（本件契约是抽屉零 setTimeout）：renderAll 已经把卡片画完了才轮到这里。
  function focusAsk() {
    const section = byId('stewardDrawerAsk');
    if (!section || section.hidden) return false;
    try { if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'nearest' }); }
    catch { /* 老浏览器不支持 options 形参，滚不动不影响下面的聚焦 */ }
    const input = byId('stewardDrawerAskInput');
    const answer = byId('stewardDrawerAskAnswer');
    const target = (input && !(answer && answer.hidden))
      ? input
      : (byId('stewardDrawerAskOptions') || section).querySelector('.steward-drawer-reply');
    if (!target || typeof target.focus !== 'function') return false;
    try { target.focus(); } catch { return false; }
    return true;
  }

  // F3（32 号文 §2.2「现在这几件」）：右栏小行上的「就地回答」把光标交回抽屉自己的输入口。
  // 与 focusAsk 的分工：真有人在问你时那一份优先（问答卡才是正式答复口，答案走 /api/chat/answer），
  // 没有卡就落到这里 —— 底部「直接对这条线程说」，话仍然走 sayToThread 那唯一一处
  // POST /api/steward/relay。看板因此不需要认识任何输入框 id，右栏也就长不出第二个输入框、
  // 第二条发送路径（这是「就地回答」零重复的唯一形状）。
  function focusComposer() {
    const input = byId('stewardDrawerInput');
    if (!input || typeof input.focus !== 'function') return false;
    try { input.focus(); } catch { return false; }
    return true;
  }

  // ── ⑥ 你可以说 ──────────────────────────────────────────────────────────────
  function renderQuickReplies() {
    const section = byId('stewardDrawerQuickReplies');
    const host = clear(byId('stewardDrawerQuickRepliesRow'));
    if (!host) return;
    // 117l D4：④ 已经把同一批选项按钮摆出来时，本区整块隐藏 —— 两排一模一样的按钮只会让人犹豫
    // 该点哪一排（走查③「太多太杂」）。判据就是 askOptionReplies 有没有东西，不另起一套。
    if (section) section.hidden = askOptionReplies().length > 0;
    const replies = quickRepliesFor({
      pending: pendingForThread,
      // 问句判定看的是【整条原话】的收尾，不是「它刚说」那 ≤3 句的截断 —— 把问句截掉再判，
      // 就会把「它在问你」误报成「它没在问」。
      lastAssistantText: lastAssistantText(),
      state: threadStateOf(missionRow),
      t,
    }).slice(0, STEWARD_QUICK_REPLIES_MAX);
    for (const reply of replies) {
      const button = el('button', 'steward-drawer-reply', reply.label);
      button.type = 'button';
      button.dataset.replyKind = reply.kind;
      button.onclick = () => runQuickReply(reply);
      host.appendChild(button);
    }
  }

  // ── ⑦ 接力关系（本波只列同事项其它线程；真正的接力图归 120） ────────────────
  function renderRelay() {
    const section = byId('stewardDrawerRelay');
    const list = clear(byId('stewardDrawerRelayList'));
    if (!section || !list) return;
    const others = missionRows.filter(row => String(row.sessionId) !== sessionId);
    section.hidden = others.length === 0;
    for (const row of others) {
      const item = el('li');
      const dot = el('span', 'steward-drawer-dot');
      dot.dataset.state = threadStateOf(row);
      item.append(dot, doc().createTextNode(` ${String(row.displayTitle || row.title || row.sessionId)} · ${stateLabel(threadStateOf(row))}`));
      list.appendChild(item);
    }
  }

  // ── ⑧ 三问 ──────────────────────────────────────────────────────────────────
  // 没有「拿 turnActivity 快照」的 HTTP 面：预览壳那一份是它自己的事件流喂出来的累加器
  // （preview-shell.js 的 turnActivity.consume(event)），抽屉这一路只轮询，拿不到那条流。
  // 所以这里【只用权威字段】拼一个最小快照喂给同一个 describeTurnActivity：真有未决就是 waiting_you，
  // 真在等锁/等并发位/等预算（116h 的 wait）就是 waiting_resource，其余一律 idle → 显示「暂无」。
  // 绝不因为「线程在跑」就编一个 thinking（§8.1 原则 2：不知道就说不知道）。
  function activitySnapshot() {
    const wait = (missionRow && missionRow.wait) || null;
    const reason = String((wait && wait.reason) || '');
    if (pendingForThread) {
      return { phase: 'waiting_you', waiting: { kind: String(pendingForThread.type || ''), label: String(pendingForThread.toolName || '') }, turnActive: false, notices: [] };
    }
    if (reason && reason !== 'user') {
      const blockedBy = wait && wait.blockedBy ? [String(wait.blockedBy)] : [];
      return { phase: 'waiting_resource', resourceWait: { resources: [String(wait.label || reason)], blockers: blockedBy }, turnActive: false, notices: [] };
    }
    return null;
  }

  // 117j W2-5 末条：普通会话没有事项／验收／未决，三问此前一律三个「暂无」——可那是「不知道」，
  // 而我们其实知道两件事：**它已经收工了**、**从建到现在多久**。只在真的不在跑、且确实跑过至少
  // 一个回合时才说这一句；有未决或在等资源时让上面那条 view 说话（它更具体）。仍然绝不因为
  // 「线程在跑」就编一个 thinking（§8.1 原则 2：不知道就说不知道）。
  function settledHead() {
    if (isLive() || pendingForThread) return '';
    if (!(Number(session && session.turnSeq) > 0)) return '';   // 一回合都没跑过,说「收工」是撒谎
    // 117l D4（用户第四轮走查③）：修前这里算的是【从建会话】到现在，于是真机上出现「收工 · 用时
    // 770h 35m」—— 那不是它干了 770 小时，那是这条会话建了一个月。改说「最近动过 X 前」，锚点换成
    // updatedAt（同一处 elapsedLabel，判据不复制）。拿不到 updatedAt 就不说 —— 不猜。
    const touched = String((missionRow && missionRow.updatedAt) || (session && session.updatedAt) || '');
    const elapsed = touched ? elapsedLabel(touched, new Date()) : '';
    return elapsed ? t('stewardShell.drawer.settledSince', { elapsed }) : '';
  }

  function renderActivity() {
    const doing = byId('stewardDrawerActivityDoing');
    const progress = byId('stewardDrawerActivityProgress');
    const waiting = byId('stewardDrawerActivityWaiting');
    const view = describeTurnActivity(activitySnapshot(), t);
    if (doing) doing.textContent = (view && view.head) || settledHead() || t('stewardShell.drawer.none');
    if (progress) progress.textContent = progressText();
    if (waiting) {
      const wait = (missionRow && missionRow.wait) || null;
      waiting.textContent = (wait && wait.label) || (view && view.action) || t('stewardShell.drawer.none');
    }
  }

  // 「干到哪」只报可核验的事实：验收 a/b（taskProgress）＋ 从建线程到现在的耗时（elapsedLabel）。
  function progressText() {
    const parts = [];
    const bar = taskProgress(null, snapshot);
    if (bar.total > 0) parts.push(t('stewardShell.drawer.acceptanceCount', { done: bar.done, total: bar.total }));
    const started = (snapshot && snapshot.createdAt) || (session && session.createdAt) || '';
    const elapsed = started ? elapsedLabel(started, new Date()) : '';
    if (elapsed) parts.push(elapsed);
    return parts.length ? parts.join(' · ') : t('stewardShell.drawer.none');
  }

  // ── ⑨ 验收项 ────────────────────────────────────────────────────────────────
  function renderAcceptance() {
    const list = clear(byId('stewardDrawerAcceptanceList'));
    if (!list) return;
    const items = acceptanceItems(snapshot);
    const active = activeAcceptanceIndex(items);
    if (!items.length) {
      const empty = el('li', 'steward-drawer-scene-empty', t('stewardShell.drawer.acceptanceEmpty'));
      list.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const row = el('li', index === active ? 'is-active' : '', item.desc);
      row.dataset.status = item.status;
      if (index === active) row.title = t('stewardShell.drawer.acceptanceActive');
      list.appendChild(row);
    });
  }

  // ── ⑪ 底部按钮态：暂停／继续按五态二选一显示 ────────────────────────────────
  // 判据住在模块顶层的 pausableRunOf（117h 看板行复用同一段），这里只喂本抽屉的快照。
  function pausableRun() { return pausableRunOf(snapshot); }

  function renderFoot() {
    const pause = byId('stewardDrawerPauseBtn');
    const resume = byId('stewardDrawerResumeBtn');
    const run = pausableRun();
    const paused = Boolean(run && run.paused === true);
    if (pause) pause.hidden = !run || paused;
    if (resume) resume.hidden = !run || !paused;
  }

  // ── ⑤ 快切 chip 行：跟全局一样就不印 ────────────────────────────────────────
  // 117u-G3（27 号文 §11.15.7；用户 2026-09-09「这个也不印默认值吧」）：G2 已经让【看板】的权限与
  // 模型只在与全局不同时才出现，详情栏这一行却照旧印「权限 跟随全局 · 模型 ⟨全局默认⟩」。口径自此
  // 统一 —— 病 3 对三面同时成立，用的是【同一份】判据（steward-chips.js 的 chipsWorthPrinting），
  // 本文件不写第二条。
  //
  // 顺序是要紧的：先 setSession（chips 的 render() 在这一步才把 .is-pinned 画上去），再问判据 ——
  // 判据的权限那一半读的正是 chips 自己的这个输出，问早了它读到的是上一拍的皮。
  //
  // 收的是【这一拍不值得印】，不是控件：chips 实例一直挂在宿主里（不 unmount、不清空），下一拍
  // 判据一翻脸它就原样出现，用户按了一半的菜单也不会被连根拔掉（chip 菜单那条 304 纪律）。
  // 如实记一处代价：跟随全局时这一行在详情栏里也看不见了，于是「给这条线程单独定一档」在管家壳里
  // 只剩卡头那枚「2.0 视窗」一条路（§8.6 三处同一控件的第三处，本来就在那儿）。这是 §11.15.7
  // 明写的取舍，不是漏做；要收回来只需把下面这一行的 hidden 恒置 false。
  function renderChips() {
    chips.setSession(session);
    const host = byId('stewardDrawerChips');
    if (!host) return;
    host.hidden = !chipsWorthPrinting(session, (state && state.config) || {}, host);
  }

  function renderAll() {
    renderChips();
    renderMission();
    renderTabs();
    renderHead();
    renderAsk();
    renderLastSay();
    renderQuickReplies();
    renderRelay();
    renderActivity();
    renderAcceptance();
    renderFoot();
  }

  // ── 直连发话（§8.13「不经管家」）────────────────────────────────────────────
  // 117l D2：**单口 POST /api/steward/relay**，通道由服务端一处判（answer > permission > steer > turn）。
  // 修前抽屉自己猜：`isLive()` 假就直打 /api/chat/stream —— 而线程挂在 request_user_input 上等答案时
  // 恰恰不 live，于是 09-workflow 的 `activeChildren.has → stopSession('superseded')` 把用户还没回答
  // 的那道提问连回合一起杀了（真机 10:32:34 的 turn_kill，§11.9.2）。抽屉不再渲染流：relay 是一次
  // 普通 JSON 往返，正文仍由 2.0 视窗与经典流负责呈现。
  const RELAY_NOTE_KEYS = Object.freeze({
    answer: 'stewardShell.drawer.relayAnswered',
    steer: 'stewardShell.drawer.steered',
    turn: 'stewardShell.drawer.sent',
  });
  async function sayToThread(text) {
    const message = String(text || '').trim();
    if (!message || !sessionId) return false;
    try {
      const relayed = await api('/api/steward/relay', { method: 'POST', body: JSON.stringify({ sessionId, message }) });
      if (!relayed || relayed.ok === false) { failNote((relayed && relayed.error) || 'relay_failed'); return false; }
      note(t(RELAY_NOTE_KEYS[String(relayed.channel || '')] || 'stewardShell.drawer.sent'));
      return true;
    } catch (error) { failNote(error); return false; }
  }

  async function runQuickReply(reply) {
    if (!reply) return;
    try {
      if (reply.kind === 'permission') {
        const decided = await api('/api/permission/decision', {
          method: 'POST',
          body: JSON.stringify({ requestId: reply.interventionId, behavior: reply.behavior }),
        });
        if (!decided || decided.ok !== true) { failNote((decided && decided.error) || 'decision_failed'); return; }
        note(t('stewardShell.drawer.answered'));
      } else if (reply.kind === 'question') {
        const answered = await api('/api/chat/answer', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            questionId: reply.interventionId,
            answers: [{ questionId: reply.questionId, selectedOptionIds: [reply.optionId], otherText: '' }],
            content: reply.label,
          }),
        });
        if (!answered || answered.ok !== true) { failNote((answered && answered.error) || 'answer_failed'); return; }
        note(t('stewardShell.drawer.answered'));
      } else if (reply.kind === 'plan' || reply.kind === 'pool') {
        // 117m-A2：这两类走【既有】的统一决策契约端点（75b 立的那一条，交办台的收件箱抽屉走的
        // 就是它）。不新起路径，也不各自去找 /api/plan/decision 与 /api/agent-runs/:id 那两个
        // 老适配器 —— 那会长出第三、第四条决策路径。
        // 路径上的 missionId 用【这条会话自己的 id】：待决本体在它自己那本旁路账里（13d 的
        // decideIntervention 把「等于会话自身 id」显式认作合法别名）。
        const decided = await api(`/api/missions/${encodeURIComponent(reply.missionId)}/interventions/${encodeURIComponent(reply.interventionId)}/decision`, {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: Math.max(0, Number(reply.interventionVersion) || 0),
            idempotencyKey: `drawer-${reply.interventionId}-${reply.action}`,
            action: reply.action,
          }),
        });
        if (!decided || decided.ok !== true) { failNote((decided && decided.error) || 'decision_failed'); return; }
        note(t('stewardShell.drawer.answered'));
      } else if (!(await sayToThread(reply.text))) return;
    } catch (error) { failNote(error); return; }
    await refreshOnce();
    // 117k（用户走查⑥）：答完的那一瞬服务端往往还没把待决清掉（回合要先接住答案），于是
    // 「等你(1 条待决)」与那两枚候选答案还挂在屏幕上，看起来像没答进去。**不加新计时器**（本件
    // 的契约是抽屉零 setTimeout，见 steward-drawer.static C2）：把节拍闸清零，让【已经在跑】的
    // 那张表下一拍（答完线程回到 live，就是 5s 下限那一档）真的去拉一次。
    // 117s-B 起 refreshOnce 自己也这么做（每一次强刷都是「刚有事发生」），这一行于是成了同义重复；
    // 留着不删是因为 117k 的这条保证不该挂在别人的实现细节上 —— 谁将来改 refreshOnce 都不会把
    // 「答完待决那一拍必须真去拉」一起改没。
    lastPollAt = 0;
  }

  // ── ③/⑩ 2.0 视窗：切到经典壳并选中该会话（顶部返回带归 117g） ────────────────
  // 117g 起，「2.0 视窗」「看全文」「看改动」三处统一调 openClassicWindow(sessionId)：切经典壳 +
  // 选中该会话 + 显示顶部返回带。注入缺席时退回 117d 的两步做法（切壳 + 选中，只是没有返回带）。
  async function openClassicView() {
    const id = sessionId;
    closeDrawer();
    if (typeof openClassicWindow === 'function') { try { await openClassicWindow(id); } catch (error) { failNote(error); } return; }
    if (typeof applyShellMode === 'function') applyShellMode('classic');
    if (id) { try { await openSession(id); } catch (error) { failNote(error); } }
  }

  // ── ⑪ 整单回退：退到本线程【第一条用户消息】那一回合之前 ─────────────────────
  // 口径与 117d 第 0 步同款：rewindSession 按「要删掉的那一回合的第一条用户消息」定位，所以
  // targetTurnSeq 取 messages 里第一条 user 消息自己的 turnSeq（S4b 起每条新用户消息都打了戳），
  // 没有戳的老会话回落 1（第一回合）。
  function firstUserTurnSeq() {
    const messages = (session && Array.isArray(session.messages)) ? session.messages : [];
    for (const message of messages) {
      if (!message || message.role !== 'user') continue;
      const seq = Number(message.turnSeq);
      return Number.isFinite(seq) && seq > 0 ? seq : 1;
    }
    return 0;
  }

  async function rewindAll() {
    const target = firstUserTurnSeq();
    if (!target) { note(t('stewardShell.drawer.rewindNoTarget')); return; }
    if (globalThis.confirm && !globalThis.confirm(t('stewardShell.drawer.rewindConfirm'))) return;
    try {
      await api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId }) });
      const rewound = await api('/api/session/rewind', {
        method: 'POST',
        body: JSON.stringify({ sessionId, targetTurnSeq: target, rollbackFiles: true }),
      });
      if (!rewound || rewound.ok === false) { failNote((rewound && rewound.error) || 'rewind_failed'); return; }
      note(t('stewardShell.drawer.rewindDone'));
    } catch (error) { failNote(error); return; }
    await refreshOnce();
  }

  async function runAction(action) {
    const run = pausableRun();
    if (!run) { note(t('stewardShell.drawer.noPausableRun')); return; }
    const result = await stewardThreadRunAction({ api, sessionId, runId: run.id, action });
    if (!result || result.ok !== true) { failNote(result && result.error); return; }
    await refreshOnce();
  }

  async function stopThread() {
    const stopped = await stewardThreadStop({ api, sessionId });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return; }
    await refreshOnce();
  }

  // ── 刷新与轮询 ──────────────────────────────────────────────────────────────
  async function refreshOnce() {
    lastPollAt = Date.now();   // 这一趟在飞的时候别让轮询那一拍再来一趟（同一份切片拉两遍）
    await loadThreadSlice();
    await loadMissionSlice();
    renderAll();
    // 117s-B（用户第九轮走查④「给已收工的线程重新递话，『它刚说』更新不够及时」）：修前这里【只有】
    // 开头那一行 `lastPollAt = Date.now()` —— 一次强刷把【下一拍】又推后整整一个节拍。而强刷发生的
    // 时刻恰恰是「刚有事发生」的时刻（管家递话进来、答完待决、任一写动作），线程往往【正要】活过来：
    // 这一趟读到的还是「已收工」，然后自己把下一次复核推到 config.stewardPollMs 之后（用户真机 15 s）。
    // 跑完归零 = 把节拍闸打开，下一拍（表恒走 5 s 下限）照常自己判「该不该拉」。不加计时器、不换表、
    // 轮询表里的数一个没动。代价有界且只多一拍：那一拍跑完就把 lastPollAt 记回当下，若线程仍然空闲
    // 就立刻回到配置节拍。
    lastPollAt = 0;
  }

  // 轮询只刷新「本线程切片」这两面（§117d 刷新纪律逐字）：会话原文与未决清单。事项聚合与验收快照
  // 在打开、切线程、任一写动作之后各刷一次 —— 它们不会因为等待而秒变。
  //
  // 117j W2-5（用户走查④「抽屉里线程跑完显示不及时」）：**表按下限（5s）走，真要不要拉由这一拍
  // 自己判** —— 有在跑的回合就每一拍都拉（回合结束最多 5 秒就看得见），空闲时仍按配置的节拍
  // （默认 15s），请求数与今天一样。之所以不「动态换表」：C1/C3b 锁死了本模块只有一处 setInterval／
  // 一处 clearInterval、start/stop 只有那几个调用点，换表要么多一处 clearInterval 要么多一个调用点，
  // 两者都会撞上既有断言（本片纪律：断言只加不改）。
  let lastPollAt = 0;
  async function pollSlice() {
    const now = Date.now();
    const wasLive = isLive();
    const due = wasLive ? STEWARD_DRAWER_POLL_MS_MIN : pollIntervalMs();
    if (now - lastPollAt < due - POLL_DUE_SLACK_MS) return;
    lastPollAt = now;
    await loadThreadSlice();
    // 回合刚结束（live 真 -> 假）：当拍把事项行与快照一并重拉，不等下一次写动作 —— 五态、验收进度、
    // 「已收工」这三样只有事项面知道，而「跑完了」恰恰是用户最想立刻看见的那一刻。
    // 117s-B（用户第九轮走查①④）：把【假 -> 真】那一边补上，与上面那句对称 —— 管家把一条已收工的
    // 线程重新递话点着时，「它在跑」这件事同样只有事项面知道（状态行取 threadStateOf(missionRow)）。
    // 不补的话这一拍手里明明已经拿到「它又活了」（resumable.live 翻真、标题换成「它正在说」），
    // 状态行却仍写着「已收工」，要等下一次写动作或切线程才纠回来。两个方向合成一条判据：live 变了
    // 就重拉，没变就一个请求都不多发。
    const nowLive = isLive();
    if (wasLive !== nowLive) await loadMissionSlice();
    renderAll();
  }

  function pollIntervalMs() {
    const raw = Number(state && state.config && state.config.stewardPollMs);
    return Number.isFinite(raw) && raw > 0 ? Math.max(STEWARD_DRAWER_POLL_MS_MIN, raw) : STEWARD_DRAWER_POLL_MS_DEFAULT;
  }

  let pollTimer = 0;
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = 0;
  }
  function startPolling() {
    if (pollTimer) return;
    // 表走下限，节拍由 pollSlice 自己按「有没有在跑的回合」判（见那里的头注）。
    pollTimer = setInterval(pollSlice, STEWARD_DRAWER_POLL_MS_MIN);
  }
  // 唯一入口：抽屉开着 且 还在管家模式 且 页面可见 —— 任一为否立刻停表（零后台活动）。
  function syncPolling() {
    if (isOpen() && isStewardMode() && !(doc() && doc().hidden)) startPolling();
    else stopPolling();
  }

  // ── 开关 ────────────────────────────────────────────────────────────────────
  function isOpen() {
    const drawer = byId('stewardDrawer');
    return Boolean(drawer) && drawer.hidden === false;
  }

  function applyModal() {
    const drawer = byId('stewardDrawer');
    if (!drawer) return;
    const narrow = Boolean(globalThis.matchMedia) && !globalThis.matchMedia('(min-width: 1000px)').matches;
    // docked（「现在这一件」）永远是常驻栏，不是模态 —— 它只在 ≥1000px 存在，窄屏一律回 overlay。
    if (narrow && mountMode !== 'docked') drawer.setAttribute('aria-modal', 'true');
    else drawer.removeAttribute('aria-modal');
  }

  // 117h：换挂法 = 把【同一个】 #stewardDrawer 节点搬到另一个父节点下，并打上 data-mount 供样式层
  // 改定位（docked 交给 #stewardNow 那条常驻右栏，overlay 回到管家壳自己）。区块渲染一个字节不改。
  function setMount(mode) {
    const next = mode === 'docked' ? 'docked' : 'overlay';
    const drawer = byId('stewardDrawer');
    if (!drawer) return mountMode;
    mountMode = next;
    drawer.dataset.mount = next;
    const host = next === 'docked' ? byId('stewardNowBody') : byId('stewardShell');
    if (host && drawer.parentNode !== host) host.appendChild(drawer);
    applyModal();
    return mountMode;
  }

  // 117k（用户走查⑤）：第一帧的「读取中」闸。openThread 先画一帧再去拉数据，那一帧手里
  // 什么都没有 —— 标题回落成内部 id（sess_xxxxxxxx）、事项行说「未归事项」、「它刚说」说
  // 「它还没说过话。」。三句都不是真的，只是还没读到。读到之前一律说「读取中…」。
  let loading = false;
  async function openThread(nextId) {
    const id = String(nextId || '');
    if (!id) return;
    const drawer = byId('stewardDrawer');
    const shell = byId('stewardShell');
    if (!drawer) return;
    sessionId = id;
    loading = true;
    session = null; resumable = null; snapshot = null; pendingForThread = null;
    liveTail = null;     // 117l D4：切线程要一起清，否则新线程第一帧还挂着上一条的活回合尾巴
    displayTitle = '';   // 116-5b:切线程要一起清,否则新线程头一帧还挂着上一条的名字
    missionRow = null; missionRows = [];
    drawer.hidden = false;
    if (shell) shell.dataset.drawer = 'open';
    applyModal();
    note('');
    renderAll();
    syncPolling();
    const title = byId('stewardDrawerTitle');
    if (title && typeof title.focus === 'function') { title.tabIndex = -1; title.focus(); }
    // 117l D4（用户第四轮走查①）：数据到齐、「读取中」闸落下的【那一帧】，如果「它在问你」真的
    // 在，焦点就落进那个回答框 —— 这才是「打开线程回答」按下去该发生的事（open_thread act →
    // steward:focus-thread → 抽屉）。闸落之前不抢焦点：那时候还不知道它到底有没有在问你。
    try { await refreshOnce(); } finally {
      if (sessionId === id) { loading = false; renderAll(); focusAsk(); }
    }
  }

  // 「交回管家」＝关抽屉、焦点回输入框、输入区 chip 恢复「→ 如意」（composer.resetComposer 由宿主接）。
  function closeDrawer({ focusComposer = false } = {}) {
    const drawer = byId('stewardDrawer');
    const shell = byId('stewardShell');
    const wasOpen = isOpen();
    if (drawer) { drawer.hidden = true; drawer.removeAttribute('aria-modal'); }
    if (shell) delete shell.dataset.drawer;
    chips.closeMenu();
    sessionId = '';
    stopPolling();
    // 117h：docked 那一份被关掉 = 用户「关掉」了「现在这一件」（Esc 与 × 也算），本机偏好由
    // steward-board.js 记；抽屉自己不认识 localStorage。
    if (wasOpen) { try { onClosed(mountMode); } catch { /* 宿主收摊失败不该把抽屉留在半开 */ } }
    if (!focusComposer) return;
    const input = byId('stewardComposerInput');
    if (input && typeof input.focus === 'function') input.focus();
  }

  // ── ⑪ 底部动作分级（117u-G1 / 27 号文 §11.15.3 D3；病 5「四个动作等宽等重」）──────────
  // 修前六枚按钮一样重：破坏性最强的「整单回退」和最常用的「发给它」并排、同宽同色。分三档：
  //   主 = 发给它（唯一那枚金色，与问答卡的主动作同一个类 .is-primary）；
  //   次 = 暂停／继续／停止（默认那身皮，不动）；
  //   破坏性的「整单回退」「交回管家」收进一枚默认收起的「更多」。
  // 【一个字都不改】：两枚按钮连同 id、data-icon、内层 span 的 data-i18n 原样搬进 <details>——
  // 可访问名与既有接线（on('stewardDrawerRewindBtn'…) 按 id 查）逐字不变，静态锁 L1/L3 读的是
  // index.html 的静态标记，也一个字节没动。「更多」那句人话复用 body 那枚折叠已经在用的键，
  // 零新增 i18n 键。搬一次就够（bindStewardDrawer 全程只跑一次，这里再加一道幂等守卫）。
  const STEWARD_DRAWER_FOOT_MORE_IDS = Object.freeze(['stewardDrawerRewindBtn', 'stewardDrawerHandBackBtn']);
  function gradeFootActions() {
    const send = byId('stewardDrawerSendBtn');
    if (send) send.classList.add('is-primary');
    const buttons = STEWARD_DRAWER_FOOT_MORE_IDS.map(byId).filter(Boolean);
    const row = buttons.length ? buttons[0].parentNode : null;
    if (!row || !row.classList || !row.classList.contains('steward-drawer-foot-actions')) return null;
    if (row.querySelector('.steward-drawer-foot-more')) return null;
    const more = el('details', 'steward-drawer-foot-more');
    const summary = el('summary', 'steward-drawer-more-summary', t('stewardShell.drawer.more'));
    // 挂上 data-i18n，切语言时 applyTranslations 会把它一起重写（body 那枚折叠的 summary 就是
    // 这么挂的）—— 动态建的节点少这一句，换成英文界面之后它会一直留着中文。
    summary.dataset.i18n = 'stewardShell.drawer.more';
    more.appendChild(summary);
    for (const button of buttons) more.appendChild(button);
    row.appendChild(more);
    return more;
  }

  function bindStewardDrawer() {
    const chipsHost = byId('stewardDrawerChips');
    if (chipsHost) chips.mount(chipsHost);
    gradeFootActions();

    const on = (id, handler) => { const node = byId(id); if (node) node.onclick = handler; };
    on('stewardDrawerCloseBtn', () => closeDrawer());
    on('stewardDrawerHandBackBtn', () => closeDrawer({ focusComposer: true }));
    on('stewardDrawerClassicBtn', () => { openClassicView(); });
    on('stewardDrawerFullTextBtn', () => { openClassicView(); });
    on('stewardDrawerChangesBtn', () => { openClassicView(); });
    on('stewardDrawerSendBtn', () => { submitDirect(); });
    on('stewardDrawerAskSendBtn', () => { submitAsk(); });
    on('stewardDrawerPauseBtn', () => { runAction('pause'); });
    on('stewardDrawerResumeBtn', () => { runAction('resume'); });
    on('stewardDrawerStopBtn', () => { stopThread(); });
    on('stewardDrawerRewindBtn', () => { rewindAll(); });

    const input = byId('stewardDrawerInput');
    if (input) {
      input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        submitDirect();
      });
    }
    // 117l D4：问答框的 Enter 与底部输入框同一套规矩（Shift+Enter 换行、输入法组合中不发）。
    const askInput = byId('stewardDrawerAskInput');
    if (askInput) {
      askInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        submitAsk();
      });
    }

    const document_ = doc();
    if (document_) {
      document_.addEventListener('steward:open-thread', event => { openThread(event && event.detail && event.detail.sessionId); });
      document_.addEventListener('steward:focus-thread', event => { openThread(event && event.detail && event.detail.sessionId); });
      document_.addEventListener('keydown', event => {
        if (event.key === 'Escape' && isOpen()) { event.stopPropagation(); closeDrawer({ focusComposer: true }); }
      });
      document_.addEventListener('visibilitychange', syncPolling);
    }
    // 切离管家模式即收摊（谁改的 data-shell-mode 都算）。与 steward-shell.js 的对话观察者各自独立：
    // 那一条的形状被 117c 的静态锁逐字钉住，不能把两件事塞进同一个回调里。
    if (globalThis.MutationObserver && document_ && document_.documentElement) {
      new MutationObserver(() => { if (!isStewardMode()) closeDrawer(); else syncPolling(); })
        .observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    if (globalThis.matchMedia) {
      try { globalThis.matchMedia('(min-width: 1000px)').addEventListener('change', applyModal); }
      catch { /* 老浏览器没有 addEventListener on MediaQueryList */ }
    }
    return true;
  }

  async function submitDirect() {
    const input = byId('stewardDrawerInput');
    const text = input ? String(input.value || '').trim() : '';
    if (!text) return;
    if (input) input.value = '';
    if (await sayToThread(text)) await refreshOnce();
  }

  return Object.freeze({
    bindStewardDrawer,
    openThread,
    closeDrawer,
    isOpen,
    // 117h「现在这一件」与 117g 顶栏复用：当前线程与 chip 控件本体（同一份数据，不复制状态）。
    currentSessionId: () => sessionId,
    // 117g/117h：三条迟绑定接线 + 挂法开关（构造调用那一行被 steward-drawer.static I3 逐字钉住，
    // 新依赖一律走 setter，不加构造参数）。
    setClassicWindow: handler => { openClassicWindow = typeof handler === 'function' ? handler : null; },
    setOnClosed: handler => { onClosed = typeof handler === 'function' ? handler : () => {}; },
    setMount,
    mountMode: () => mountMode,
    // 117m-A2：「N 条等你」恰好 1 条时的直达。抽屉自己在数据到齐那一帧已经聚过一次焦
    // （openThread 末尾），这个句柄补的是「右栏已经开着同一条线程」那种不重走加载的情况。
    focusAsk,
    // F3「就地回答」：没有问答卡时的落点（底部「直接对这条线程说」）。看板拿到的是这个句柄，
    // 而不是输入框本身 —— 输入框与发送逻辑都只在抽屉里有一份。
    focusComposer,
    refreshOnce,
    chips,
  });
}
