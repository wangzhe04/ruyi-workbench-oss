'use strict';

import './mission-state.js';
// 117l D2：抽屉不再直调 fetch（原来那一处是 POST /api/chat/stream，已被 /api/steward/relay 取代），
// 所以 net.js 这边要的不再是 authHeaders 而是 apiErrorInfo —— relay 的失败是 409 的结构化信封
// （propose_required / steward.busy），直接 String() 会把整个 JSON 打进抽屉那行小字。
import { apiErrorInfo } from './net.js';
import { acceptanceItems, acceptanceRecorded, activeAcceptanceIndex, taskProgress, elapsedLabel, threadShownTitle } from './thread-facts.js';
import { describeTurnActivity } from './turn-activity.js';
// 121-K2b（34 号文 §6.2）：线上事件名的那一份登记表（与 13r 的显式登记一一对拍，不各写一遍）。
import { EVENT_STREAM_ROW_EVENTS, EVENT_STREAM_LIVE_EVENT } from './event-stream.js';
// 117u-G3（§11.15.7）：chipsWorthPrinting 是【看板与本文件共用】的那一份「跟全局一样吗」判据。
// 它住在 steward-chips.js 而不是看板里，正是因为本文件不能反向 import 看板（steward-board.js 已经
// import 本文件）—— 详见那边的函数头注释。本文件不自己比对任何会话字段。
import { createQuickSwitchChips, doc, byId, el, clear, chipsWorthPrinting, bindEnterToSubmit, writeNote, STEWARD_POLL_MS_MIN, STEWARD_POLL_MS_DEFAULT, STEWARD_POLL_MS_CONNECTED, STEWARD_POLL_DUE_SLACK_MS } from './steward-chips.js';   // 117n-M1：DOM 基础件复用（doc/byId/el/clear 不再本地重复）；33 号文 §4：回车发送的守卫、note 写手与轮询常量也只有那一条
// F5a（27 号文 §11.13.1「F 追加」）：状态药丸里那枚字形。missionStateIcon 是【纯派生】
// （五态值 → 字形名），不是第二份五态枚举 —— 谁处在哪一态仍然只由 mission-state.js 判，
// 本文件也仍然一个五态字面量都没有（它只把 threadStateOf 的返回值原样递进去）。
// 121-K6b（§2.6 元信息一行）：来源图形与左栏行同一批字形，所以这一行多取一个 icon()。
import { missionStateIcon, icon } from './icons.js';
// 117u-G1（27 号文 §11.15.3 D1「详情头换成同一枚卡头」）：线程卡的三样【共享事实】从对话区那一份
// 拿，不在本文件另起第二份 —— 色号登记（stewardThreadHueFor：同一条线程在对话流／频道条／抽屉／
// 看板恒是同一个号）、五态词表（stewardThreadStateKey：查得到就用共享那条键）、相对时间的人话
// （stewardAgoLabel：两处卡头说同一句「3 分钟前」）。依赖方向 board → drawer → conversation
// 是既有方向（steward-board.js 已经 import 这两个模块），不成环。
// 117v-V2（27 号文 §11.16.2 V2 行）：⑤「它刚说」的取段判据也从这里拿 —— stewardDeliverableText
// 是全仓【唯一】那一份「一条助手消息里哪一段才是交付」的判据（117v-V4 立、V4b 扩到 subagent）。
// 抽屉里不许再抄第二份 segments 遍历：同一件事只能有一处判据。这一行本来就 import 了本模块，
// 加个名字不新增任何模块依赖边、也不成环（conversation 不 import drawer）。
// 33 号文 §4「抽屉 failNote 对齐看板」：错误信封的三处判据（稳定码 / wait.label / 人话文本）同样
// 只留 conversation 那一份，抽屉不再自写弱化版 —— 同一条理由，同一行加三个名字。
import { stewardThreadHueFor, stewardThreadStateKey, stewardAgoLabel, stewardDeliverableText,
  stewardErrorCode, stewardErrorText, stewardQueuedWaitLabel } from './steward-conversation.js';
// 32 号文 §4（M2-b）：暂停／继续的判据（含 pausableRunOf）搬到叶子 js/run-state.js，2.0 的 run 卡
// 与 3.0 的看板行同一份。本文件原来那一处 export function pausableRunOf 就地改成 re-export ——
// 看板/抽屉的既有 import 面（`{ stewardThreadRunAction, stewardThreadStop }` + pausableRunOf）
// 一个字都不用动。
import { pausableRunOf, runControlAction, runTextKeys } from './run-state.js';
export { pausableRunOf };
// 33 号文 §4（M3-a）：危险操作确认四套收一套 —— 本抽屉「整单回退」修前走原生 globalThis.confirm
// （不跟主题、不跟语言、焦点不归壳管），现在走 js/confirm-panel.js 那一套（建在 js/modal.js 上，
// 与本文件底部的抽屉浮层共用同一份焦点陷阱/焦点归还语义）。
import { confirmDanger } from './confirm-panel.js';
// 121-K7（§2.6 末条「接下来：定时任务最近两条」）：读口与排序判据只有 js/rail-pocket.js 那一份
// —— 口袋上的那个计数与这里的两行读同一发 GET /api/scheduler/tasks、按同一条规则排序。抽屉
// 【不自己拼那条请求】，也不写第二份「哪两条才算接下来」（同一件事一处判据的老规矩）。
import { readScheduleTasks, upcomingSchedules, scheduleWhenLabel, UP_NEXT_LIMIT } from './rail-pocket.js';

// 第117波 117d：线程抽屉（27 号文 §8.2 L2 / §8.13 逐条）。
//
// 它回答的是「用户不看 2.0 消息流也要知道线程在说什么、该对它说什么」。区块顺序是契约（骨架静态写在
// index.html 里，本文件只填内容），自上而下：
//   ① 事项行 ② 线程页签 ③ 线程头 ④ 快切 chip ⑤ 它刚说 ⑥ 你可以说 ⑦ 接力 ⑧ 三问 ⑨ 验收项 ⑩ 现场 ⑪ 底部
//
// 复用而不是复制（117d 门）：
//   · 验收项 → thread-facts.js 的 acceptanceItems / activeAcceptanceIndex / taskProgress / elapsedLabel；
//   · 三问   → turn-activity.js 的 describeTurnActivity（本文件不定义同名函数）；
//   · 五态   → mission-state.js 的 fromCard（UMD，import 后挂在 globalThis.MissionState）；
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
// 33 号文 §4「轮询常量收进叶子」：下限 5000／容差 250／默认 15000 这三个值原来与 steward-shell /
// steward-board 两处逐字相同，现在只有 steward-chips.js 一个来源。导出的本地名字一个没改 ——
// 锁钉的是值（导出的 STEWARD_DRAWER_POLL_MS_MIN 仍是 5000）与 pollSlice 的函数体。
export const STEWARD_DRAWER_POLL_MS_MIN = STEWARD_POLL_MS_MIN;
// setInterval 会比标称早几毫秒回来，不留容差的话「到点该拉的那一拍」会被推迟整整一拍。
const POLL_DUE_SLACK_MS = STEWARD_POLL_DUE_SLACK_MS;
export const STEWARD_DRAWER_POLL_MS_DEFAULT = STEWARD_POLL_MS_DEFAULT;
export const STEWARD_LAST_SAY_SENTENCES = 3;
export const STEWARD_NEW_THREAD_EVENT = 'steward:new-thread';
// 117h：抽屉的两种挂法（一份实现，不存在第二份抽屉区块渲染）。
//   overlay —— 用户主动打开的那一份：<1000px 全屏覆盖并补 aria-modal，≥1000px 右侧 390px 栏；
//   docked  —— 117h 的「现在这一件」：同一个 #stewardDrawer 节点被挪进 #stewardFocus 常驻右栏。
// 挂法只影响「它挂在哪个父节点、要不要 aria-modal」，区块渲染与取数逐字节共用。
export const STEWARD_DRAWER_MOUNTS = Object.freeze(['overlay', 'docked']);
// 区块顺序即锁：静态件按这个数组在 index.html 里的出现顺序核对（改顺序＝改契约）。
// 121-K6b（§2.6）：卡头排到最前、元信息一行紧随其后（原来是「事项行 → 页签 → 线程头」）。
export const STEWARD_DRAWER_BLOCK_IDS = Object.freeze([
  'stewardDrawerHead',       // ① 卡头：色条 ＋「任务 › 线程」＋ 五态药丸
  'stewardDrawerMission',    // ② 元信息一行：来源图形 · 相对时间 · 验收 a/b（**不印费用**）
  'stewardDrawerTabs',
  'stewardDrawerAsk',        // 117l D4：④「它在问你」（走查①：提问弹出来了却没有问答框）
  'stewardDrawerChips',
  'stewardDrawerLastSay',
  'stewardDrawerQuickReplies',
  'stewardDrawerQueue',      // 121-K6b：⑧ 排队那一段（在等什么 ＋ 插队 ＋ 并发上限）
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

// 117v-V2（用户第十轮走查②；27 号文 §11.16.2 V2 行、§11.16.5 经主会话裁决后的那一版）：
// 收工态的「它刚说」修前取的是 content 的【开头】≤3 句。而线程模型习惯把过程叙述写在最前面
// （用户截图里的「我先联网核实最新数据」），content 又是本回合【所有】助手文字的拼接 ——
// 取开头于是必然取到开场白，不是结论。修法【不是】改成取尾巴（§11.16.1 ⑨ 那句是没有分段账本时
// 的粗糙近似），而是先把「交付」从「过程」里分出来，再在剩下的文本里取开头。
// 判据一个字不自己写：整段委托给 steward-conversation.js 的 stewardDeliverableText —— 那是全仓
// 唯一那一份，本文件因此【没有】第二份分段遍历（静态锁按这条扫）。它自带两条边界，这里一并继承：
// 老会话（账本缺席）回落到 content 整段、绝不返回空；以工具/子代理段收尾且没写收口话的那一条回空串。
// 选消息的规则照旧「从后往前第一条【取得出非空文字】的助手消息」，只是「非空」的口径从
// 「content 非空」换成「交付段非空」—— 取不出交付原文的那一条就跳过继续往前找，
// 与 stewardDeliverableFrom 的做法逐字同源。纯函数、零 DOM、零请求（Node 可直接 import 验行为）。
export function stewardLastDeliverable(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (!message || message.role !== 'assistant') continue;
    const text = stewardDeliverableText(message);
    if (text.trim()) return text;
  }
  return '';
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
// 32 号文 §4（M2-b）：pausableRunOf 的判据本体搬去 js/run-state.js（2.0 的 run 卡也在用同一条
// 「live && paused」判据），本文件顶部按原名字 re-export —— 名字与调用面不变，实现只有一份。
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

// 33 号文 §4「costText／acceptanceText／threadStateOf 三对收一处」：这三条判据此前看板与抽屉各一份、
// 逐字重复（40 余行两份）。现在只住本模块 —— 看板 import 得到（它本来就 import 本文件的
// stewardThreadRunAction／stewardThreadStop，方向不变、不成环）。人话的**文案键**仍按各界面自己的
// 那一套传进来（keys）：判据一处，两面各说各的话。keys 的形状固定为 { none, count }（金额那两档
// 已随 121-K6b 一起退役，本模块此后不印钱）。
export function stewardThreadStateOf(card) {
  const missionState = globalThis.MissionState;
  if (!card || !missionState || typeof missionState.fromCard !== 'function') return '';
  return String(missionState.fromCard(card).state || '');
}

// 121-K6b（34 号文 §7.2／§2.6，§13.11 登记的那笔债）：`stewardCostText` 与它印在元信息那一行的
// #stewardDrawerMissionCost 整段退役 —— 「管家视角、左栏、焦点栏、工作台线程头、口袋一律不印钱」，
// 金额只在右栏「用量」页签与体检里出现。删的是【本模块唯一那处金额渲染】，判据没有搬家、也没有
// 弱化版留下：那把「金额零命中」的静态锁自本刀起把 js/steward-drawer.js 也扫进来，反向塞一个金额就红。
// 看板早在 K4-2 就把那一族连 import 一起退役了，所以这个导出此刻零消费方。

export function stewardAcceptanceText(group, translate, keys) {
  const say = typeof translate === 'function' ? translate : key => key;
  const table = keys || {};
  const acceptance = (group && group.acceptance) || null;
  const total = Math.max(0, Number(acceptance && acceptance.total) || 0);
  // 124 还债①（40 号文 §8.5 ①）：一条验收项都没有时，**「记过、是空的」与「压根没人记过」不是
  // 一回事**。后者此前在看板上只能沉默（沉默会被读成「没进展」），抽屉里早就说得出来。
  // 判据只有 thread-facts 的 acceptanceRecorded 一处 —— 与抽屉那一行同一个函数，不在这里另推。
  // 调用方没给 `unrecorded` 这个键时行为逐字不变（既有调用面不受影响）。
  if (!total) return say((table.unrecorded && !acceptanceRecorded(group)) ? table.unrecorded : table.none);
  return say(table.count, { done: Math.max(0, Number(acceptance && acceptance.done) || 0), total });
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
  // 2026-09-24：宿主说「此刻别开」的门 —— 右栏被用户收起时，事件路（steward:open-thread／focus-thread）
  // 不许把抽屉以覆盖式开出来。缺省恒开；判据只住看板一处（sideCollapsedActive），这里只问。
  let openGate = () => true;
  let openClassicWindow = null;   // 117g/121-K5：统一的「在工作台打开」入口（切视角＋选中会话；返回带已退役）
  // 33 号文 §4「抽屉 /api/missions 改经看板 rows」：那一批 200 行不再由本模块自己拉。行的那位主人
  // 是看板（etag／304／解析全在它的 loadMissions 一处），本模块只读它刚取回来的快照，并能在需要
  // 新鲜时请它刷一趟。与上面三条同一纪律：不动被静态锁逐字钉住的构造调用，新依赖一律走 setter。
  let missionRowsFrom = null;     // { rows: () => rows, refresh: async () => n } | null

  const chips = createQuickSwitchChips({
    api, t, state,
    // chip 改完立即回填：PATCH 的响应已经把新 session 交回来了，这里只需把抽屉其它面刷新一遍。
    onChanged: next => { session = next || session; renderAll(); },
  });

  // 117n-M1：el/clear 从 steward-chips.js import（六个消费方零本地重复定义）。
  function note(text) {
    writeNote('stewardDrawerNote', text);
  }
  // 33 号文 §4「抽屉 failNote 对齐看板」：判据与看板那一条（steward-board.js 的 117n-M1② 版本）
  // 逐条同 —— 稳定码先经 stewardErrorCode 查 steward.queued，取 wait.label 说「在等什么」（与看板
  // 行、服务端一处算出的 label 逐字同源）；其余情形一律经 stewardErrorText 取值，绝不 String(error)
  // 直落（结构化信封会被拍扁成 "[object Object]"）—— 对齐之前这里正是那个弱化版。
  // apiErrorInfo 仍在：api() 抛的 Error 把整个 JSON 信封放在 message 里，先解成信封形状，
  // 随后三处判据读到的字段与看板逐个等价。
  // 128b(Brief §4.2 第 18 条):撤回相关的稳定码给人话 —— 修前两次撤回交错时,管家壳把原串 'rewind_superseded' 摆给用户。
  const STEWARD_DRAWER_SESSION_ERROR_KEYS = Object.freeze({
    'session.rewind_superseded': 'error.api.rewindSuperseded',
    'session.rewound_during_write': 'error.api.rewoundDuringWrite',
    'session.history_changed_during_compact': 'error.api.historyChangedDuringCompact',
  });
  function failNote(error) {
    const info = (error instanceof Error) ? apiErrorInfo(error) : error;
    const code = stewardErrorCode(info);
    if (STEWARD_DRAWER_SESSION_ERROR_KEYS[code]) { note(t(STEWARD_DRAWER_SESSION_ERROR_KEYS[code])); return; }
    if (code === 'steward.queued') {
      const label = stewardQueuedWaitLabel(info);
      note(label ? t('stewardShell.chat.errQueued', { wait: label }) : t('stewardShell.chat.errQueuedPlain'));
      return;
    }
    note(t('stewardShell.drawer.failed', { error: stewardErrorText(info) || 'failed' }));
  }

  // ── 五态：只经 mission-state.js（全仓唯一判据），人话走 i18n（LABELS 是中文单语） ──────
  // 33 号文 §4：判据本体已收进本模块导出的 stewardThreadStateOf（看板 import 同一份），这里只剩短名。
  const threadStateOf = stewardThreadStateOf;
  // 本界面的文案键（判据共享、措辞各说各的）。
  const ACCEPTANCE_KEYS = Object.freeze({
    none: 'stewardShell.drawer.acceptanceNone',
    count: 'stewardShell.drawer.acceptanceCount',
  });
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
    // 33 号文 §4：这一批行不经本模块 —— 先请看板（唯一取数者）刷一趟，再读它手里的快照；两句并行，
    // 不在老的两次请求之外多等一趟。没注入来源时（本模块单测／2.0 侧）手里没有那一批，按「一行都
    // 没有」判，不在本文件留第二处 /api/missions 取数。
    const source = missionRowsFrom;
    const [, snapshotRes] = await Promise.all([
      source ? Promise.resolve(source.refresh()).catch(() => 0) : null,
      api(`/api/missions/${encodeURIComponent(id)}`).catch(() => null),
    ]);
    if (id !== sessionId) return;
    const listed = source ? source.rows() : null;
    const rows = Array.isArray(listed) ? listed : [];
    missionRow = rows.find(row => row && String(row.sessionId) === id) || null;
    const missionId = String((missionRow && missionRow.missionId) || (session && session.missionId) || '');
    missionRows = missionId ? rows.filter(row => row && String(row.missionId) === missionId) : (missionRow ? [missionRow] : []);
    snapshot = (snapshotRes && snapshotRes.snapshot) || null;
  }

  // ── ② 元信息【一行】（§2.6）：来源图形 · 相对时间 · 验收 a/b ─────────────────────
  // 三样都只读【已经在手上】的事实：行上的 origin（K3 §4.1 的三值）、行/会话头的 updatedAt
  // （经 stewardAgoLabel，与对话流卡头同一句人话）、快照的验收计数。**不印费用**（§7.2）。
  // 任务名不在这里 —— 它在卡头的面包屑里，多线程任务才出现（同一件事不印两遍）。
  // 字形名与人话键与左栏行【逐字同一张表】（steward-board.js 的 RAIL_ORIGIN_ICONS／_KEYS，
  // 121-K3 §4.1 的三值）。抽屉不能 import 看板（方向反了会成环），所以这里是同一份表的第二处
  // 抄写 —— 静态锁按「两处逐字相同」核对，改一处就必须改两处（这是本仓允许的唯一一种复制：
  // 两个模块之间只有环这一条路时的常量表）。
  const ORIGIN_ICONS = Object.freeze({ steward: 'originSteward', user: 'originUser', schedule: 'originSchedule' });
  const ORIGIN_KEYS = Object.freeze({
    steward: 'rail.origin.steward',
    user: 'rail.origin.user',
    schedule: 'rail.origin.schedule',
  });
  function renderMeta() {
    const originNode = byId('stewardDrawerOrigin');
    const agoNode = byId('stewardDrawerAgo');
    const acceptanceNode = byId('stewardDrawerMissionAcceptance');
    if (originNode) {
      const origin = String((missionRow && missionRow.origin) || '');
      clear(originNode);
      const glyph = ORIGIN_ICONS[origin] ? icon(ORIGIN_ICONS[origin], 12) : null;
      if (glyph) {
        originNode.appendChild(glyph);
        originNode.dataset.origin = origin;
        const label = t(ORIGIN_KEYS[origin]);
        originNode.title = label;
        originNode.setAttribute('aria-label', label);
      }
      originNode.hidden = !glyph;
    }
    if (agoNode) {
      const ago = lastTouchLabel();
      agoNode.textContent = ago;
      agoNode.hidden = !ago;
    }
    // W4b（W7 的读模型字段，用户 2026-09-24「管家需要把工作区和任务联系起来」）：这条线程所属事项的
    // 工作区【名字】，安静地印在元信息一行里。只读行上的 missionWorkspace（13d 一处算出，
    // {path,name,ruyiOwned}）；如意自己开的目录（ruyiOwned）不印 —— 用户不该感知它自建的文件夹；
    // 【只印名字，不印路径】（路径进不了界面，与 §2.2 顶栏不印路径同一条纪律）。
    const workspaceNode = byId('stewardDrawerWorkspace');
    if (workspaceNode) {
      const workspace = (missionRow && missionRow.missionWorkspace && typeof missionRow.missionWorkspace === 'object')
        ? missionRow.missionWorkspace : null;
      const name = workspace && workspace.ruyiOwned !== true ? String(workspace.name || '').trim() : '';
      workspaceNode.textContent = name;
      workspaceNode.title = name ? t('stewardShell.drawer.workspace', { name }) : '';
      workspaceNode.hidden = !name;
    }
    if (!acceptanceNode) return;
    // W4b（走查④「信息层级重排」）：一条验收项都没有时【什么都不说】—— 左栏 K3 放宽口径之后大半是手工
    // 开的线程，每一条都印「没有验收项」就是一句没有信息量的话常驻在卡头下面（§2.3「只在有话可说时出现」，
    // 与左栏 missionFacts 同一条纪律）。判据仍只有 stewardAcceptanceText 那一份，这里只决定印不印。
    const acceptance = (missionRow && missionRow.acceptance && typeof missionRow.acceptance === 'object') ? missionRow.acceptance : null;
    const worthSaying = Number(acceptance && acceptance.total) > 0;
    acceptanceNode.textContent = worthSaying ? stewardAcceptanceText(missionRow, t, ACCEPTANCE_KEYS) : '';
    acceptanceNode.hidden = !worthSaying;
  }

  // 117k（用户走查④）：任务【容器】的名字就在行里 —— 116-5b 给 GET /api/missions 的每一行加了
  // missionTitle（显式容器＝用户起的名，派生任务＝那条线程的显示名）。按确定性顺序回落：
  //   ① 行里的 missionTitle（116-5b 的权威口径）；
  //   ② 「自成任务」那条线程（sessionId === missionId）的显示名 → 原话；
  //   ③ 一条行都没有（线程还没进投影）：回空串，面包屑整段不出（不猜一个名字）。
  function missionName() {
    const missionId = String((missionRow && missionRow.missionId) || '');
    if (!missionId) return '';
    const root = missionRows.find(row => String(row.sessionId) === missionId) || missionRow || null;
    return root ? String(root.missionTitle || root.displayTitle || root.title || '') : '';
  }

  // ── ③ 线程页签 ──────────────────────────────────────────────────────────────
  // 128f（48 号文；steward-drawer E1 跨两条线两次首跑红的真因）：页签换线程走全仓唯一的聚焦通道
  // steward:focus-thread —— 看板听它、把这一条钉成焦点（pinnedId），抽屉自己也听它（见 bindStewardDrawer）。
  // 修前这里直接 openThread：抽屉换了、看板不知道，宽屏下看板每一拍（轮询／每一条行推送／窗口切回来的
  // visibilitychange）的 syncNow 见「抽屉开的不是焦点线程」就 openThread(焦点)，把用户拽回原来那条
  // （E1d 钉：切走再切回窗口之后仍在 B）。没有 document／CustomEvent 的宿主退回直接打开。
  function switchToThread(id) {
    const document_ = doc();
    if (document_ && typeof document_.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      try { document_.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: id } })); return; }
      catch { /* 落到直接打开 */ }
    }
    openThread(id);
  }
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
      tab.append(dot, el('span', 'steward-drawer-tab-title', threadShownTitle(row, t('session.untitled'))));
      if (row.title && row.displayTitle && row.title !== row.displayTitle) tab.title = String(row.title);
      tab.onclick = () => { if (!selected) switchToThread(String(row.sessionId)); };
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
        if (sid && sid !== sessionId) switchToThread(String(sid));
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
    // W4b（用户 2026-09-25 走查④「标题下方的事项 chip 与标题重复」）：单线程任务的页签行【整行不印】——
    // 那唯一一枚页签与卡头的名字逐字相同，是把同一个名字印两遍。页签只在真有兄弟线程可切时出现；
    // 「＋ 线程」随行一起收起 —— 给已有任务加兄弟线程的入口仍在左栏行的「⋯」里（§2.3 那条）。
    // DOM 照建（[hidden] 只管显隐）：页签的 role／aria-selected 契约与既有断言读的是节点，不是像素。
    host.hidden = missionRows.length < 2;
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
  // 121-K6b（§2.6）：卡头收成「色条 ＋ 色点 ＋『任务 › 线程』＋ 五态药丸」四样。
  //   · 相对时间搬去 ② 元信息一行（`#stewardDrawerAgo`）—— 卡头不再自建 .steward-tcard-meta；
  //   · 「等待原因」那一行搬去 ⑧ 排队那一段（`#stewardDrawerWait`，静态骨架里已经在那儿了）。
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
    return head;
  }

  // 「最后动静」= 相对时间，与对话流卡头【同一个】实现（stewardAgoLabel，人话交给平台的
  // Intl.RelativeTimeFormat）。锚点沿用本文件既有那一处判据（missionRow.updatedAt ＞
  // session.updatedAt —— settledHead 读的就是这两个），算不出来整段不说，不猜。
  // iso → 人话「多久以前」的【唯一】出口（J8 锁数的就是它）：算不出来就返回空串，由调用方决定
  // 「整段不说」——不吐一串 ISO 给人读（124-P1 的验收徽标与这一行的「最近动过」共用它）。
  function agoLabel(iso) {
    const at = String(iso || '');
    if (!at) return '';
    // W4b（用户 2026-09-25 走查②「0 秒前说成刚刚」）：60 秒以内说「刚刚」，不让 Intl 吐「1秒钟前」——
    // 与左栏行的 railAgoLabel 同一条 60 秒界线、同一个键；其余仍走 stewardAgoLabel 那一份实现。
    const ms = Date.parse(at);
    if (Number.isFinite(ms) && Date.now() - ms < 60000) return t('rail.justNow');
    const page = doc() && doc().documentElement ? doc().documentElement.lang : '';
    return stewardAgoLabel(at, page);
  }
  function lastTouchLabel() {
    const touched = String((missionRow && missionRow.updatedAt) || (session && session.updatedAt) || '');
    if (!touched) return '';
    return agoLabel(touched);
  }

  function renderHead() {
    const headNode = byId('stewardDrawerHead');
    const titleNode = byId('stewardDrawerTitle');
    const stateNode = byId('stewardDrawerState');
    const crumbNode = byId('stewardDrawerCrumb');
    if (headNode) {
      headNode.classList.add('steward-tcard');
      // 色号问【全仓那一张登记表】要（steward-conversation.js 的 stewardThreadHueFor）：本文件
      // 不自己算、也不自己记，所以同一条线程在这里与在对话流／左栏／看板密度上恒是同一色。
      // 121-K6b（§5）：表的键已换成 missionId，手上有行就把任务 id 一并递进去（行还没到的那一帧
      // 退回 sessionId，登记那一刻归并，见那边的头注）。
      if (sessionId) headNode.dataset.threadHue = String(stewardThreadHueFor(sessionId, missionRow && missionRow.missionId));
      else headNode.removeAttribute('data-thread-hue');
      ensureHeadParts(headNode);
    }
    if (titleNode) titleNode.classList.add('steward-tcard-name');
    if (stateNode) stateNode.classList.add('steward-tcard-state');
    // 121-K6b（§2.6）：面包屑「任务 › 线程」——【只在多线程任务时出现】，判据与 K5 的工作台线程头
    // 逐字同源（row.threadCount > 1）。单线程任务的任务名逐字等于线程名，印两遍就是 §2.3 说的
    // 「把同一个名字印两遍」。
    if (crumbNode) {
      const many = Number((missionRow && missionRow.threadCount) || 0) > 1;
      const name = many ? missionName() : '';
      crumbNode.textContent = name;
      crumbNode.title = name;
      crumbNode.hidden = !name;
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
  }

  // ── ⑤ 它刚说 ────────────────────────────────────────────────────────────────
  // 【谁要什么就给什么】——117v-V2 把 ⑤ 换成交付段之后，本闭包里这个函数【不跟着改】，不是漏了：
  //   · lastAssistantText()（下面这个）= 最后一条非空助手消息的【整条 content】。
  //     实测有两个消费方，都在判「最后一句是不是问句」：④ asksYouFrom 的客户端兜底，
  //     以及 ⑦ quickRepliesFor 的「好，就这样／先不要」那一档。
  //   · ⑤「它刚说」改吃 stewardLastDeliverable(session.messages)（模块顶层那个导出纯函数）。
  // 为什么不让那两处问句判定也吃过滤结果（117v-V2 查到的事实）：
  //   ① 两处的判据都是 `/[？?]$/.test(整条原话)` —— 看的是【收尾】。content 是本回合全部
  //      text 段的拼接，交付段是它的【后缀】，所以只要交付段非空，两者末字符逐字相同，
  //      问句判定的答案一模一样，换不换都不影响；
  //   ② 唯一分岔在「这条消息以工具/子代理段收尾、后面一句收口的话都没有」——那时交付段是空串。
  //      让问句判定也吃过滤结果的话，选消息那一步就会【跳过这条、退到更早一条】，
  //      于是把一条早就过去了的问句当成「它现在在问你」端出来（陈旧误报）。
  //      而客户端兜底存在的理由恰恰是「【最后一句话】真是问句时补报一次」，退到更早一条就把它判坏了。
  // 所以：⑤ 吃过滤后的交付段（用户第十轮走查②「不要参杂线程推进的原文」），④⑦ 继续吃整条 content。
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
  // 121-K6b（§2.6／§5）：在跑那一段的【当前动作行】——「工具 · 第 N 次调用 · N 秒前有输出」。
  // 三样都读服务端 liveTail 上已有的字段（tool／iterations／updatedAt），一个数都不推算、不印百分比、
  // 不印 ETA、不印金额（§8.1 第 6 条）。缺哪一样就少说哪一样；三样全缺整行不出（不编）。
  // 纯拼字，DOM 只写一个 textContent。
  function actingLine() {
    if (!liveTail) return '';
    const parts = [];
    const tool = String(liveTail.tool || '').trim();
    if (tool) parts.push(threadToolLabel(tool));
    // 「第 N 次调用」= 服务端 liveTail.iterations（13d:285 与 13r 推帧里【同一个】数），
    // 不是前端自己数出来的次数。0 或缺席就不说这一节。
    const calls = Number(liveTail.iterations);
    if (Number.isFinite(calls) && calls > 0) parts.push(t('stewardShell.drawer.actingCalls', { n: calls }));
    const since = String(liveTail.updatedAt || '').trim();
    const at = since ? Date.parse(since) : NaN;
    if (Number.isFinite(at)) {
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      parts.push(t('stewardShell.drawer.actingSince', { n: seconds }));
    }
    return parts.join(' · ');
  }

  function renderActing(streaming) {
    const node = byId('stewardDrawerActing');
    if (!node) return '';
    const line = streaming ? actingLine() : '';
    node.textContent = line;
    node.hidden = !line;
    return line;
  }

  function renderLastSay() {
    const head = byId('stewardDrawerLastSayHead');
    const quote = byId('stewardDrawerLastSayText');
    if (!quote) { renderActing(false); return; }
    const tailText = String((liveTail && liveTail.text) || '').trim();
    // 判据【只看 liveTail 在不在】，不叠 isLive()：服务端只在真有活回合时才下发这个键，它比
    // isLive() 准 —— 后者拿不到 resumable.live（GET /api/sessions/:id 的 live 分支根本不回这个字段）
    // 就回落到「事项行的五态是不是 running」，而挂在提问上的回合五态是 needs_you，于是恒判成不在跑。
    const streaming = Boolean(liveTail) && Boolean(tailText);
    renderActing(streaming);
    if (streaming) {
      if (head) head.textContent = t('stewardShell.drawer.liveSay');
      // 121-K6b（§2.6）：正在用的那个工具从引文尾巴搬到【当前动作行】（renderActing）——
      // 引文只放它说的话，一句话里不掺一句状态。
      quote.textContent = liveTailSentences(tailText);
      return;
    }
    // §2.6 收工那一段说的是「它【最后】说」（与在跑那一段的「它正在说」成对）。
    if (head) head.textContent = t('stewardShell.drawer.lastSay');
    // ④ 已经把这句问话原文摆出来了就不再重复一遍（走查③「太多太杂」：一屏两遍同一句话）。
    const ask = asksYouNow();
    // 117v-V2：过滤之后【取头】才对 —— 交付段的第一句就是收口结论，而它的末尾往往是注意事项／
    // 风险提示／下一步建议（对话区那一份交付卡走的也是「从头显示、超 8 行折叠」，同一个方向）。
    // 取尾会把「顺便提醒你三件事」端上来当结论。活回合那一路仍取末尾（liveTailSentences，见上）：
    // 那段文本是被从中间切断的活文本，没有「开头就是结论」这个前提。
    const said = lastSaySentences(stewardLastDeliverable(session && session.messages));
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

  // ── ⑧ 排队那一段（121-K6b／§2.6／§8.10「排队必须可解释」）────────────────────────
  // 「在等什么」那一句【只读行上的 wait.label】—— 116h 在服务端一处算出（等你／等锁：被谁占着／
  // 等并发位：前面还有几条），左栏行、看板行与这里读的是同一个字段，本处不编第二句。
  // 两枚按钮走既有那两条路：插队 = POST /api/steward/arbiter/prioritize（116h 立的，语义刻意做窄：
  // 只有还在排队的那一条能被提到队首）；并发上限 = 把焦点送到左栏栏头那个输入框（那是全仓唯一
  // 一处并发上限控件，K4-2 从看板浮层搬过去的），不在焦点栏里另画第二个数字输入。
  function renderQueue(queued) {
    const section = byId('stewardDrawerQueue');
    const waitNode = byId('stewardDrawerWait');
    if (waitNode) {
      const wait = (missionRow && missionRow.wait) || null;
      const label = wait ? String(wait.label || '') : '';
      waitNode.textContent = label || (queued ? t('stewardShell.drawer.queueUnknown') : '');
      waitNode.hidden = !waitNode.textContent;
    }
    if (section) section.hidden = !queued;
  }

  // ── 按五态一段（121-K6b／§2.6）──────────────────────────────────────────────────
  // 这是【显隐】纪律，不是第二套区块，也不是第二套状态机：态由 mission-state.js 一处算出
  // （threadStateOf(missionRow)，本文件仍然一个五态字面量都不认 —— 下面这张表的键就是它的返回值），
  // 每一态该露哪几段写在这一张表里，一处可读、一处可改。
  //   等你   → ④ 它在问你（callout ＋ 候选答案 ＋ 直接回答框）；不出 ⑥（问句已经在 ④ 里）
  //   在跑   → ⑥「它正在说」（流式尾窗 ≤3 句）＋ 当前动作行 ＋ 底部「递给它一句」
  //   排队   → ⑧ 在等什么 ＋ 插队／并发上限
  //   收工   → ⑥「它最后说」＋ 底部「接着说」
  // ④ 自己那一道判据（asksYouNow 非空）比行上的态更准（它还看得到本地待决与软问句），所以
  // 「等你」这一段的显隐仍由 renderAsk 说了算；这里只负责另外三段与底部那句提示。
  const FOOT_LABEL_KEYS = Object.freeze({
    running: 'stewardShell.drawer.composerLabelLive',
    dispatching: 'stewardShell.drawer.composerLabelLive',
    done: 'stewardShell.drawer.composerLabelDone',
    stopped: 'stewardShell.drawer.composerLabelDone',
  });
  function renderStateSections() {
    const value = threadStateOf(missionRow);
    const ask = asksYouNow();
    const streaming = Boolean(liveTail) && Boolean(String(liveTail.text || '').trim());
    // 等你那一段【只出 ④】：问答卡里问题原文与回答口都有了，同一屏再挂一条「它刚说 · 它还没
    // 说过话。」是把一句没有信息量的话摆在最该动手的地方旁边（§2.6「按五态一段」）。
    // 在跑时不收：那时 ⑥ 印的是「它正在说」，与问答卡是两件事（挂在提问上的活回合两样都要）。
    const lastSaySection = byId('stewardDrawerLastSay');
    if (lastSaySection) lastSaySection.hidden = Boolean(ask) && !streaming;
    // 排队那一段的判据：行上的态是 dispatching（还没有任何执行痕迹的那一档，与左栏「排队」组
    // railGroupFor 逐字同源），或者服务端明说了它在等什么（wait.reason 非 'user'）。
    // 前面两态优先：有人在问你、或者它正在说，那就不是「在排队」那一段 —— 等你那一态服务端给的
    // wait.label 恰恰就是「等你(N 条待决)」，不挡住的话等你与排队会同时出两段（实测截图逮到）。
    const wait = (missionRow && missionRow.wait) || null;
    const reason = String((wait && wait.reason) || '');
    const queued = !ask && !streaming
      && (value === 'dispatching' || (Boolean(reason) && reason !== 'user'));
    renderQueue(queued);
    const label = byId('stewardDrawerComposerLabel');
    if (label) label.textContent = t(FOOT_LABEL_KEYS[value] || 'stewardShell.drawer.composerLabel');
    return { state: value, queued };
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
  // 没有「拿 turnActivity 快照」的 HTTP 面：经典壳那一份是 chat-stream-runtime 的事件流喂出来的
  // 累加器（121-K1 之前退役的交办台也各喂一份），抽屉这一路只轮询，拿不到那条流。
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
    // updatedAt。拿不到 updatedAt 就不说 —— 不猜。
    // 121-K6b（33 号文第 11 项／§5「『最后动静』统一用 stewardAgoLabel」）：这里原来借 elapsedLabel
    // 出一个【时长】（「3m 20s」）当「多久以前」用 —— 抽屉里因此有两种时间写法（卡头说「3 分钟前」，
    // 这一句说「3m 20s」）。收成一种：与 lastTouchLabel 同一处实现、同一句人话。
    // elapsedLabel 在本文件仍有一个诚实的消费方（progressText 里「从建线程到现在的耗时」——
    // 那真的是时长，不是「多久以前」），所以 import 不变。
    const ago = lastTouchLabel();
    return ago ? t('stewardShell.drawer.settledSince', { elapsed: ago }) : '';
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
    // 124-P1（41 号方案 §9 J15）：一条没有账本、也没有事项验收项的线程，此前这一行只剩耗时 ——
    // 问「做到哪了」得到的是沉默。沉默会被读成「没进展」，0/0 会被读成「一条都没做完」，
    // 而真相是【没人记过】。判据在 thread-facts.acceptanceRecorded（服务端 ledger 直出），不在这里猜。
    else if (!acceptanceRecorded(snapshot)) parts.push(t('stewardShell.drawer.acceptanceUnrecorded'));
    const started = (snapshot && snapshot.createdAt) || (session && session.createdAt) || '';
    const elapsed = started ? elapsedLabel(started, new Date()) : '';
    if (elapsed) parts.push(elapsed);
    return parts.length ? parts.join(' · ') : t('stewardShell.drawer.none');
  }

  // ── ⑨ 验收项 ────────────────────────────────────────────────────────────────
  // 124-P1：一条验收项旁边那枚来源徽标。四态【一个字都不在这里算】——provenance 与 checkState 由
  // 服务端投影给（02 的 buildMissionAcceptanceProjection 是全仓唯一判据），本函数只把它们翻成人话。
  // 「自报完成」那一档要分三种说法，因为它们对用户是三件事（41 号方案 §9 J08）：
  //   · 压根没有机器检查 → 「自报完成」；
  //   · 有机器检查、一次没跑过 → 「自报完成 · 机器检查没跑过」；
  //   · 有机器检查、最近一次没通过 → 「自报完成 · 机器检查没通过」（产物生成了但测试红／文件后来没了
  //     就是这一格，它此前与「机器检查通过」在界面上长得一模一样）。
  // 时间说的是人话:与「最后动静」同一个实现（stewardAgoLabel → Intl.RelativeTimeFormat），
  // 算不出来就整条不说（同 lastTouchLabel 那条纪律：不吐一串 ISO 给人读）。
  function checkedAgo(item) {
    return item ? agoLabel(item.checkedAt) : '';
  }
  function acceptanceSourceBadge(item) {
    if (!item || !item.provenance || item.provenance === 'open') return null;
    const ago = checkedAgo(item);
    if (item.provenance === 'machine') {
      return {
        label: t('stewardShell.drawer.provenanceMachine'),
        title: ago ? t('stewardShell.drawer.provenanceCheckedAt', { when: ago, detail: item.checkDetail || '' }) : '',
      };
    }
    if (item.provenance === 'human') return { label: t('stewardShell.drawer.provenanceHuman'), title: '' };
    if (item.checkState === 'never') return { label: t('stewardShell.drawer.provenanceSelfCheckNever'), title: '' };
    if (item.checkState === 'fail') {
      return {
        label: t('stewardShell.drawer.provenanceSelfCheckFailed'),
        title: ago ? t('stewardShell.drawer.provenanceCheckedAt', { when: ago, detail: item.checkDetail || '' }) : '',
      };
    }
    return { label: t('stewardShell.drawer.provenanceSelf'), title: '' };
  }

  function renderAcceptance() {
    const list = clear(byId('stewardDrawerAcceptanceList'));
    if (!list) return;
    const items = acceptanceItems(snapshot);
    const active = activeAcceptanceIndex(items);
    if (!items.length) {
      // 「还没写」（有账本，里程碑还没定）与「没记过」（压根没有账本，也没有事项验收项）是两回事：
      // 前者是任务单的正常中间态，后者是「这个问题在这条线程上答不出来」。
      const empty = el('li', 'steward-drawer-scene-empty',
        acceptanceRecorded(snapshot) ? t('stewardShell.drawer.acceptanceEmpty') : t('stewardShell.drawer.acceptanceUnrecorded'));
      list.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const row = el('li', index === active ? 'is-active' : '', item.desc);
      row.dataset.status = item.status;
      if (item.provenance) row.dataset.provenance = item.provenance;
      const badge = acceptanceSourceBadge(item);
      if (badge) {
        const tag = el('span', 'steward-acc-src', badge.label);
        if (badge.title) tag.title = badge.title;
        row.appendChild(tag);
      }
      if (index === active) row.title = t('stewardShell.drawer.acceptanceActive');
      list.appendChild(row);
    });
  }

  // ── ⑪ 底部按钮态：暂停／继续按五态二选一显示 ────────────────────────────────
  // 判据住在叶子 js/run-state.js（2.0 的 run 卡、3.0 的看板行与这里同一份），本处只喂本抽屉的快照。
  function pausableRun() { return pausableRunOf(snapshot); }

  function renderFoot(sections) {
    const pause = byId('stewardDrawerPauseBtn');
    const resume = byId('stewardDrawerResumeBtn');
    const action = runControlAction(pausableRun());
    if (pause) pause.hidden = action !== 'pause';
    if (resume) resume.hidden = action !== 'resume';
    // W4b（用户 2026-09-25 走查④；口味「不要虚假按钮」）：「停止」只在【真有东西可停】时出现 ——
    // 活回合在跑（isLive）、回合挂在提问/放行上（行上的 activeTurn）、或还在排队（renderStateSections
    // 算好的 queued，116h 的 cancelQueuedTurn 就挂在同一条 /api/stop 上）。已收工的线程上一枚「停止」
    // 是按下去什么都不会发生的按钮。判据全是现成的三个事实，不新认任何五态字面量。
    const stop = byId('stewardDrawerStopBtn');
    if (stop) {
      const queued = Boolean(sections && sections.queued);
      const activeTurn = Boolean(missionRow && missionRow.activeTurn === true);
      stop.hidden = !(isLive() || activeTurn || queued);
    }
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
  //
  // 117u-G3b（主会话裁决，§11.15.8）：G3 第一版把【整行】藏起来，与看板逐字同法。那是照着派单稿
  // 做的，而派单稿把两件不同的东西混成了一件 —— **看板那一行是「信息」，详情栏这一行是「控件」**：
  //   · 看板是清点密度，多行并列，「跟随全局」重复 N 遍是纯噪音 → 整条不印（G2/G3 的做法保留）；
  //   · 详情栏是工作密度，只有一条线程，这一行是「给这条线程单独定一档」在管家壳里的唯一入口
  //     （藏掉之后只剩卡头那枚「2.0 视窗」）。收掉入口不是用户要的，用户要的是「不印默认值」。
  // 所以本面只收【值】不收控件：chip 本来就是「键 ＋ 值」两个节点（steward-chips.js buildChip 的
  // .steward-chip-key ＋ .steward-chip-value），样式层把值那半藏掉即可 —— 零 JS 分支、不动 valueFor、
  // 不碰看板与 2.0 顶栏那两面，判据仍然只有 chipsWorthPrinting 那一份。
  // 要回到「整行都不印」只需把下面这行换成 host.hidden = !worth（CSS 那条 [hidden] 守卫仍在）。
  function renderChips() {
    chips.setSession(session);
    const host = byId('stewardDrawerChips');
    if (!host) return;
    host.classList.toggle('is-default', !chipsWorthPrinting(session, (state && state.config) || {}, host));
  }

  function renderAll() {
    renderChips();
    renderHead();
    renderMeta();
    renderTabs();
    renderAsk();
    renderLastSay();
    renderQuickReplies();
    const sections = renderStateSections();
    renderRelay();
    renderActivity();
    renderAcceptance();
    renderFoot(sections);   // W4b：「停止」的显隐要读它算好的 queued，不在 renderFoot 里再判一遍排队
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
  // 117g 起，「在工作台打开」「看全文」「看改动」三处统一调 openClassicWindow(sessionId)。
  // 121-K5：它现在就是 js/shell-mode.js 的 openInWorkbench —— 切视角 ＋ 选中该会话，返回带与那个
  // sessionStorage 返回标记整段退役。注入缺席时的回落（切视角 ＋ 选中）与它逐字同义，留着不动。
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
    // 33 号文 §4（M3-a）：原生 confirm 退役 —— 整单回退会撤销这期间改过的文件，不可逆，确认件必须
    // 跟主题、跟语言、焦点归壳管。同步变异步：没得到允许就不动手。
    if (!await confirmDanger({ name: 'rewindAll' })) return;
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
    // 判据（而不是那两枚键的可见性）决定这一步能不能做：跑不动的动作不发请求、如实说一句。
    if (!run || !runControlAction(run)) { note(t(runTextKeys('v3').noPausableRun)); return; }
    const result = await stewardThreadRunAction({ api, sessionId, runId: run.id, action });
    if (!result || result.ok !== true) { failNote(result && result.error); return; }
    await refreshOnce();
  }

  // 121-K6b（§2.6 排队那一段的两枚按钮）。
  // 插队走 116h 立的那条既有路由，语义刻意做窄：只有【还在排队】的那一条能被提到队首，不在队列
  // 里不是错误、如实说一句（与看板行那一枚 prioritize 的两句回执逐字同源）。
  async function prioritizeThread() {
    if (!sessionId) return false;
    try {
      const result = await api('/api/steward/arbiter/prioritize', { method: 'POST', body: JSON.stringify({ sessionId }) });
      if (!result || result.ok !== true) { failNote((result && result.error) || 'prioritize_failed'); return false; }
      note(t(result.prioritized === true ? 'stewardShell.board.prioritized' : 'stewardShell.board.notQueued'));
    } catch (error) { failNote(error); return false; }
    await refreshOnce();
    return true;
  }
  // 并发上限【不在本栏里再画一个数字框】：全仓唯一那一处控件在左栏栏头（K4-2 从看板浮层搬过去
  // 的 #stewardBoardMax）。这枚按钮只是把光标送过去 —— 一份数据一处控件（§2.1 第 10 条）。
  function focusMaxParallel() {
    const input = byId('stewardBoardMax');
    if (!input || typeof input.focus !== 'function') { note(t('stewardShell.drawer.maxParallelMissing')); return false; }
    try {
      if (typeof input.scrollIntoView === 'function') input.scrollIntoView({ block: 'nearest' });
      input.focus();
      if (typeof input.select === 'function') input.select();
    } catch { /* 宿主没有 focus/select 的环境 */ }
    return true;
  }

  async function stopThread() {
    const stopped = await stewardThreadStop({ api, sessionId });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return; }
    await refreshOnce();
    // 128f-⑫（审计 F）：停掉的若是一条还在排队的，左栏头上的「排队 N」要当场少一 —— 那个数读仲裁面，而排队中的回合
    // 被停一帧线程推送都没有（它根本没起跑）。页内广播给左栏（steward-board 订了它，只重读仲裁面这一发）。
    if (drawerEventStream && typeof drawerEventStream.publishLocal === 'function') drawerEventStream.publishLocal('steward.arbiter.changed', {});
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
  //
  // 121-K2b（§6.2「三条轮询保留为兜底」）：事件流连着时这一拍只是兜底心跳（due 统一 30 s）——
  // 该看见的东西由 thread.* 推送当场落地（见 bindEventStream）；断开时立刻回到上面那两档。
  let lastPollAt = 0;
  async function pollSlice() {
    const now = Date.now();
    const wasLive = isLive();
    const due = streamConnected ? STEWARD_POLL_MS_CONNECTED : (wasLive ? STEWARD_DRAWER_POLL_MS_MIN : pollIntervalMs());
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

  // ── 121-K2b：吃推送（§6.2；§6.3 的 b/c/d 三个指标落在这一栏上）────────────────────
  // 两步走，缺一不可：
  //   ① 【当场】把 thread.live 的三个值写进本地 liveTail 并重画 —— 「它正在说」那一行、当前工具名
  //      与轮次立刻变（§6.3 指标 d 要的就是这个「≤1 s」，一发请求都不用）。推送的 textTail 是 240 字
  //      上限（§6.1 载荷列），比服务端信封里那段 600 字短；屏幕上只显示末尾 ≤3 句（liveTailSentences），
  //      所以看得见的部分不受影响。
  //   ② 随后把那一趟切片【重问一次】（合并、串行）—— 待决清单、五态、验收快照都不在推送载荷里
  //      （§6.1 红线：这条线不承载正文与明细），它们的权威源仍然是 /api/sessions/:id 与事项切片。
  // 合并不用计时器（本模块零 setTimeout，C2 钉着）：在飞时只记一个「还要再来一趟」的位。
  let streamConnected = false;
  let drawerEventStream = null;   // 128f-⑫：setEventStream 记下来（stopThread 之后页内广播）
  let pushBusy = false;
  let pushAgain = false;
  async function pushRefreshSlice() {
    if (!sessionId) return false;
    if (pushBusy) { pushAgain = true; return false; }
    pushBusy = true;
    const id = sessionId;
    try {
      await loadThreadSlice();
      await loadMissionSlice();
      if (id === sessionId) renderAll();
    } finally { pushBusy = false; }
    if (pushAgain) { pushAgain = false; return pushRefreshSlice(); }
    return true;
  }
  function applyLivePush(data) {
    const sid = String((data && data.sessionId) || '');
    if (!sid || sid !== sessionId) return false;      // 别把 A 的活回合画到 B 上
    liveTail = {
      ...(liveTail && typeof liveTail === 'object' ? liveTail : {}),
      text: String((data && data.textTail) || ''),
      tool: String((data && data.tool) || ''),
      // 121-K6b：当前动作行的「第 N 次调用」读它。13r 推帧里本来就有这个数（13r:162），
      // 修前被这一段丢掉了，于是活回合期间那个数只能停在上一趟 HTTP 切片的值上。
      iterations: Math.max(0, Number(data && data.iterations) || 0),
      updatedAt: String((data && data.updatedAt) || ''),
    };
    renderAll();
    return true;
  }
  function setEventStream(stream) {
    if (!stream || typeof stream.on !== 'function') return false;
    drawerEventStream = stream;   // 128f-⑫：停掉一条之后页内广播用（见 stopThread）
    streamConnected = typeof stream.isConnected === 'function' ? stream.isConnected() === true : false;
    stream.on('connection', payload => { streamConnected = Boolean(payload && payload.connected); });
    // thread.live 【只】就地改，不顺手重问切片：它每 500 ms 一条（§6.1 节流列），每条都跟一发
    // /api/sessions/:id ＋事项切片的话，一个长回合期间就是持续两发请求在飞 —— 比今天的 5 s 一轮更重。
    // 回合起跑／收工／提问那三件事本来就各有一帧（thread.state／needs_you／done），重问跟着它们走。
    stream.on(EVENT_STREAM_LIVE_EVENT, data => { applyLivePush(data); });
    for (const name of EVENT_STREAM_ROW_EVENTS) {
      stream.on(name, data => {
        if (String((data && data.sessionId) || '') !== sessionId) return;
        void pushRefreshSlice();
      });
    }
    // 123-M2（37 号文 §3.6）：「接下来」那两行吃真数据之后要跟着定时任务表变。修前它只在
    // 【进管家视角】与【绑定】两个时刻各刷一次（K7 刻意不挂在 refreshOnce 上——那是 5–30 s 的
    // 轮询拍，挂上去等于给 /api/scheduler/tasks 新开一条轮询）。schedule.changed 是「有事发生了
    // 才刷」，**不是第二条计时器**：建/改/删/触发各一帧，帧里只有 taskId/phase/outcome。
    stream.on('schedule.changed', () => { void refreshUpNext(); });
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

  // 121-K6b（§2.6／§13.7 ③「抽屉内部『关掉』语义」）：docked 是【常驻焦点栏】，不存在「关」，
  // 也就不存在模态。所以两态收成一态 —— 只有 overlay（≤1000px 的抽屉态）才补 aria-modal。
  // 修前这里还判一次宽度：那是浮层时代留下的，docked 本来就只在宽屏成立（syncNow 的 wideEnough
  // 是唯一那道宽度门），再判一次是第二处判据。
  function applyModal() {
    const drawer = byId('stewardDrawer');
    if (!drawer) return;
    if (mountMode === 'docked') drawer.removeAttribute('aria-modal');
    else drawer.setAttribute('aria-modal', 'true');
  }

  // 117h：换挂法 = 把【同一个】 #stewardDrawer 节点搬到另一个父节点下，并打上 data-mount 供样式层
  // 改定位。121-K6b（§2.6／§13.7 ③）：docked 的挂点从 #stewardNowBody 改名成 #stewardFocus
  // —— 它是常驻【焦点栏】，浮层时代的「现在这几件」两刀之前就退役了。
  // overlay 只剩一种可达情形：窄到右栏摆不下（syncNow 的 wideEnough 那一道门），此时它是模态抽屉。
  // 区块渲染一个字节不改（一份实现、两种挂法仍然成立）。
  function setMount(mode) {
    const next = mode === 'docked' ? 'docked' : 'overlay';
    const drawer = byId('stewardDrawer');
    if (!drawer) return mountMode;
    mountMode = next;
    drawer.dataset.mount = next;
    const host = next === 'docked' ? byId('stewardFocus') : byId('stewardShell');
    if (host && drawer.parentNode !== host) host.appendChild(drawer);
    applyModal();
    return mountMode;
  }

  // 117k（用户走查⑤）：第一帧的「读取中」闸。openThread 先画一帧再去拉数据，那一帧手里
  // 什么都没有 —— 标题回落成内部 id（sess_xxxxxxxx）、事项行说「未归事项」、「它刚说」说
  // 「它还没说过话。」。三句都不是真的，只是还没读到。读到之前一律说「读取中…」。
  // 121-K6b（§13.7 登记 ⑨）：焦点栏常驻之后，openThread 每一次「换焦点」都会把光标从用户正在打字
  // 的地方抢走 —— 而换焦点的触发者【多数不是用户】：管家递话、推送来帧、自动挑选（syncNow 里那句
  // `if (drawer.currentSessionId() !== focusId) drawer.openThread(focusId)`）都会走到这里，用户正在
  // 管家输入框或 2.0 输入框里敲的字就此丢掉键位。
  // 判据做成【白名单】而不是「当前有没有焦点」：只有真正的输入落点（textarea／input／可编辑区）
  // 才算「用户正在打字」，页面上随便一枚按钮拿着焦点不该拦住移焦（那才是该被换掉的）。
  function userIsTyping() {
    const document_ = doc();
    const active = document_ && document_.activeElement;
    if (!active) return false;
    const tag = String(active.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return true;
    return active.isContentEditable === true;
  }
  // 焦点在【别的】开着的模态弹层里（设置页等，含其中的下拉／按钮）：自动打开抽屉同样不许把焦点拿走 ——
  // 慢机器上抽屉晚开，会把刚从左栏直达设置某一段的焦点（和滚动）拽到抽屉标题上。
  function focusInOtherDialog() {
    const document_ = doc();
    const active = document_ && document_.activeElement;
    if (!active || typeof active.closest !== 'function') return false;
    const dialog = active.closest('[role="dialog"][aria-modal="true"]');
    return Boolean(dialog) && !dialog.closest('#stewardDrawer');
  }

  let loading = false;
  // 128f-④（Brief §4.2 第 23 条「从工作台切回管家，焦点卡标题闪一下『读取中…』」）：抽屉离开管家视角即收摊，回来
  // openThread 把手上的一切清空、画「读取中」闸（117k）再整份重取 —— 同一条线程每切一次视角就闪一次，负载下闪得更久。
  // 117k 的闸防的是「还没读到就说假话」（标题回落成内部 id、「未归事项」「它还没说过话」）；而重开【同一条】时手上有
  // 它刚刚还是真的那一帧。所以：重开同一条（正开着的这一份，或收摊时记下、5 分钟内的那一份）先把上一帧画出来、
  // 不落闸，后台照常 refreshOnce 刷新；换到别的线程与头一次打开照旧落闸。活回合尾巴不带进记下的那一帧（它是瞬时的）。
  const STEWARD_DRAWER_FRAME_KEEP_MS = 5 * 60 * 1000;
  let lastFrame = null;
  function captureFrame() {
    if (!sessionId || !session) return null;
    return { sessionId, at: Date.now(), session, resumable, snapshot, pendingForThread, displayTitle, missionRow, missionRows };
  }
  // opts.focus：显式换焦点（用户点了行／页签／「打开」）时才移焦。缺省 'auto' = 只在用户没在打字时移。
  async function openThread(nextId, opts = {}) {
    const id = String(nextId || '');
    if (!id) return;
    const wantFocus = opts && opts.focus === true ? true : (opts && opts.focus === false ? false : !userIsTyping() && !focusInOtherDialog());
    const drawer = byId('stewardDrawer');
    const shell = byId('stewardShell');
    if (!drawer) return;
    const sameOpen = sessionId === id && !loading && Boolean(session);
    const keep = sameOpen ? captureFrame()
      : (lastFrame && lastFrame.sessionId === id && (Date.now() - lastFrame.at) < STEWARD_DRAWER_FRAME_KEEP_MS ? lastFrame : null);
    lastFrame = null;
    sessionId = id;
    if (keep) {
      ({ session, resumable, snapshot, pendingForThread, displayTitle, missionRow, missionRows } = keep);
      if (!sameOpen) liveTail = null;
      loading = false;
    } else {
      loading = true;
      session = null; resumable = null; snapshot = null; pendingForThread = null;
      liveTail = null;     // 117l D4：切线程要一起清，否则新线程第一帧还挂着上一条的活回合尾巴
      displayTitle = '';   // 116-5b:切线程要一起清,否则新线程头一帧还挂着上一条的名字
      missionRow = null; missionRows = [];
    }
    drawer.hidden = false;
    if (shell) shell.dataset.drawer = 'open';
    applyModal();
    note('');
    renderAll();
    syncPolling();
    const title = byId('stewardDrawerTitle');
    if (title) title.tabIndex = -1;
    if (wantFocus && title && typeof title.focus === 'function') title.focus();
    // 117l D4（用户第四轮走查①）：数据到齐、「读取中」闸落下的【那一帧】，如果「它在问你」真的
    // 在，焦点就落进那个回答框 —— 这才是「打开线程回答」按下去该发生的事（open_thread act →
    // steward:focus-thread → 抽屉）。闸落之前不抢焦点：那时候还不知道它到底有没有在问你。
    try { await refreshOnce(); } finally {
      if (sessionId === id) { loading = false; renderAll(); if (wantFocus) focusAsk(); }
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
    // 128f-④：记下收摊前这一帧，重开同一条时先画它（见 openThread 头注）。离开管家视角时收摊会连来两次（看板的
    // syncNow 一次、本模块的视角观察者一次），第二次手上已经没有线程了 —— 【不许】拿空值把刚记下的那一帧冲掉。
    { const frame = captureFrame(); if (frame) lastFrame = frame; }
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
    // 121-K6b（§2.6 动作行）：主动作是「在工作台打开」，不再是「发给它」——「主 ＝ 在工作台打开，
    // 次 ＝ 暂停／停止或继续，破坏性收进『更多』」是 §2.6 的原话。金色仍然只有一枚（同一个
    // .is-primary 类，全仓一处字面量）。
    const primary = byId('stewardDrawerClassicBtn');
    if (primary) primary.classList.add('is-primary');
    const send = byId('stewardDrawerSendBtn');
    if (send) send.classList.remove('is-primary');
    // W4b（用户 2026-09-25 走查④「底部输入框＋四个按钮，控件太多」）：「发给它」是那个输入框的发送键，
    // 不是动作行的一员 —— 把它搬到输入框【旁边】（同一枚节点，id／字形／内层 span 的 data-i18n 一个字节
    // 不动，既有接线按 id 查得到），动作行于是只剩「在工作台打开」一枚主动作 ＋ 按态出现的次动作 ＋「更多」。
    // 搬一次就够（幂等守卫）；样式层按 .steward-drawer-say 摆成「输入框 ＋ 圆键」一行。
    const input = byId('stewardDrawerInput');
    if (input && send && input.parentNode && !input.parentNode.classList.contains('steward-drawer-say')) {
      const say = el('div', 'steward-drawer-say');
      input.parentNode.insertBefore(say, input);
      say.appendChild(input);
      say.appendChild(send);
    }
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
    on('stewardDrawerJumpBtn', () => { prioritizeThread(); });
    on('stewardDrawerMaxBtn', () => { focusMaxParallel(); });

    // 33 号文 §4：回车发送（Enter ＋ 非 Shift ＋ 非输入法组合中）的判据收进了 steward-chips.js 的
    // bindEnterToSubmit —— 这两处与 composer 那处自此读同一个判据，不再各写一遍。
    bindEnterToSubmit(byId('stewardDrawerInput'), () => submitDirect());
    // 117l D4：问答框的 Enter 与底部输入框同一套规矩（Shift+Enter 换行、输入法组合中不发）。
    bindEnterToSubmit(byId('stewardDrawerAskInput'), () => submitAsk());

    const document_ = doc();
    if (document_) {
      // 2026-09-24：两条事件路先过 openGate —— 右栏收着时不开（看板那一侧只让窄条亮一颗点）。
      document_.addEventListener('steward:open-thread', event => { if (openGate()) openThread(event && event.detail && event.detail.sessionId); });
      document_.addEventListener('steward:focus-thread', event => { if (openGate()) openThread(event && event.detail && event.detail.sessionId); });
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
      // 121-K7：「接下来」只在【进管家视角】这个确定性时刻刷一次（与上面那条观察者各自独立 ——
      // 那一条的形状被 steward-drawer.static 逐字钉着）。**刻意不挂在 refreshOnce 上**：那一支是
      // 5–30 s 的轮询拍，挂上去就等于给 /api/scheduler/tasks 新开一条轮询（K2b／K4 的纪律：
      // 不加第二条计时器）。定时任务表变一次是用户自己动手的事，不需要秒级新鲜。
      new MutationObserver(() => { if (isStewardMode()) void refreshUpNext(); })
        .observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    void refreshUpNext();   // 121-K7：绑定即刷第一次（首屏就是管家视角时也看得见）
    if (globalThis.matchMedia) {
      try { globalThis.matchMedia('(min-width: 1000px)').addEventListener('change', applyModal); }
      catch { /* 老浏览器没有 addEventListener on MediaQueryList */ }
    }
    return true;
  }

  // ── 121-K7（34 号文 §2.6 末条）：「接下来」──────────────────────────────────────
  // 焦点栏最底下那一段（在「其它在途」之后，见 index.html 里 #stewardUpNext 的头注）：
  // 定时任务里【下次触发最近的两条】，每行印「名字 · 相对时间」。
  //   · 一条都没有（含后端还没落地那条路由 404 时）→ **整段不画**（§2.6 的原话就是那两条，
  //     没有第三种形态；空标题挂在右栏底下只是噪音）。
  //   · 判据与读口都在 js/rail-pocket.js 一处（口袋的计数与这两行同源）。
  //   · **不加计时器**：随焦点栏的 refreshOnce 一起刷（动作刷新），并在绑定时刷第一次。
  //   · 相对时间走 Intl.RelativeTimeFormat（scheduleWhenLabel），零新增时间文案键。
  function renderUpNext(tasks) {
    const section = byId('stewardUpNext');
    const list = byId('stewardUpNextList');
    if (!section || !list) return 0;
    const rows = upcomingSchedules(tasks, UP_NEXT_LIMIT, Date.now());
    clear(list);
    section.hidden = rows.length === 0;
    if (!rows.length) return 0;
    const document_ = doc();
    const lang = (document_ && document_.documentElement && document_.documentElement.lang) || '';
    for (const task of rows) {
      const item = el('li', 'steward-upnext-row');
      const glyph = icon('originSchedule', 13);
      if (glyph) item.appendChild(glyph);
      const when = scheduleWhenLabel(task.nextRunAt, lang);
      item.appendChild(el('span', 'steward-upnext-text',
        when ? t('stewardShell.drawer.upNextRow', { name: task.name, when }) : task.name));
      list.appendChild(item);
    }
    return rows.length;
  }
  // 串行合并：上一发还没回来就不再开第二发（焦点栏一拍里可能被推送连着推好几次）。
  let upNextInflight = null;
  function refreshUpNext() {
    if (upNextInflight) return upNextInflight;
    upNextInflight = readScheduleTasks(api)
      .then(tasks => renderUpNext(tasks))
      .finally(() => { upNextInflight = null; });
    return upNextInflight;
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
    // 2026-09-24：事件路的「此刻别开」门（右栏收起时）。同一条迟绑定纪律；判据住看板，这里只接。
    setOpenGate: handler => { openGate = typeof handler === 'function' ? handler : () => true; },
    setEventStream, // 121-K2b：组合根那一条推送（同一条迟绑定纪律）
    // 33 号文 §4：事项行的那批行由看板注入（它才是唯一取数者）。传进来的形状是
    // { rows, refresh } 两个函数；缺一个就当作没注入 —— 本模块宁可手里没有行，也不自留第二处取数。
    setMissionRows: source => {
      missionRowsFrom = source && typeof source.rows === 'function' && typeof source.refresh === 'function'
        ? source : null;
    },
    setMount,
    mountMode: () => mountMode,
    // 117m-A2：「N 条等你」恰好 1 条时的直达。抽屉自己在数据到齐那一帧已经聚过一次焦
    // （openThread 末尾），这个句柄补的是「右栏已经开着同一条线程」那种不重走加载的情况。
    focusAsk,
    // F3「就地回答」：没有问答卡时的落点（底部「直接对这条线程说」）。看板拿到的是这个句柄，
    // 而不是输入框本身 —— 输入框与发送逻辑都只在抽屉里有一份。
    focusComposer,
    refreshOnce,
    // 121-K7（§2.6 末条）：「接下来」那一段的刷新口。导出是为了让真夹具在造完定时任务之后有一个
    // 确定性的时刻可以问（它平时只在绑定与进管家视角时各刷一次，没有计时器）。
    refreshUpNext,
    chips,
  });
}
