'use strict';

import './mission-state.js';
import { apiRaw } from './net.js';
import { acceptanceRecorded, dockToneForMissionState, elapsedLabel, focusThreadFor, missionStateSettled, missionStateUnfinished, threadShownTitle } from './thread-facts.js';
// 117u-G2 B3 →（117u-G3 搬家）：「这一行的权限与模型跟全局一样吗」这条判据 G2 是写在本模块闭包里的，
// G3 把它原样搬进 steward-chips.js 给【看板与线程详情栏】共用（抽屉不能反过来 import 看板，见那边的
// 注释）。所以这里接过来的是 chipsWorthPrinting 本身，而不再是 resolveEngineRoute —— 本模块自此
// 连「会话级 ＞ 全局回落」都不认识，更长不出第二套。
import { createQuickSwitchChips, doc, byId, el, clear, chipsWorthPrinting, writeNote, STEWARD_POLL_MS_MIN, STEWARD_POLL_MS_DEFAULT, STEWARD_POLL_MS_CONNECTED, STEWARD_POLL_DUE_SLACK_MS } from './steward-chips.js';   // 117n-M1：DOM 基础件复用（doc/byId/el/clear 不再本地重复）；33 号文 §4：note 写手（写 #stewardBoardNote）与轮询常量也只有那一条；121-K2b：连接时的兜底节拍同源
// F5a（27 号文 §11.13.1「F 追加」）：动作与五态的字形都取自 icons.js 那一张表。
// missionStateIcon 是【纯派生】（五态值 → 字形名），不是第二份五态枚举 —— 本模块仍然只把
// threadStateOf() 的返回值原样递进去，`needs_you`/`'stopped'` 的字面量计数一个没变（M6 锁）。
import { icon, missionStateIcon } from './icons.js';
import { stewardThreadRunAction, stewardThreadStop } from './steward-drawer.js';
// 32 号文 §4（M2-b）：暂停／继续的判据（runCanPause/runCanResume + 批量名单 + 文案键）搬进叶子
// js/run-state.js —— 2.0 顶栏的 run 卡、本看板的行键与「全部暂停」、抽屉底部三处同一份。
import { runControlAction, runIsLive, runTextKeys, pausableRunsOf, hasPausableRun } from './run-state.js';
// 33 号文 §4（「costText／acceptanceText／threadStateOf 三对收进 drawer 导出」）：这三条判据的正身
// 只在 steward-drawer.js 一份，本模块 import 过来用 —— 方向与上面那两个动作函数一致（看板 → 抽屉，
// 抽屉不反过来 import 看板），不成环。判据共享，**文案键各传各的**（看板递 stewardShell.board.*，
// 抽屉递 stewardShell.drawer.*），所以两面各说各的话、判据只有一处。
// 单开一条 import（而非并入上面那行）是刻意的：steward-board.static D4 逐字钉着上面那行的写法，
// 而 D4 要守的是「动作走抽屉同一段原语」这件事，不该为一次收编去动它（32 号文 §4 纪律 5）。
// 121-K4（34 号文 §7.2「费用规则」）：stewardCostText 从这一行【删掉】—— 左栏（含看板密度）一律
// 不印钱，而「少调一个函数」是拦不住的；连文案键都不 import，本模块自此长不出第二处金额。
import { stewardThreadStateOf, stewardAcceptanceText } from './steward-drawer.js';
// 117n-M1②（用户第六轮走查后走查「合并功能」）：failNote 原来只是 String(error.message || error)，
// 既不解结构化信封也不特判 steward.queued 的 wait.label —— 同一种排队失败，看板上的提示比抽屉里
// （steward-drawer.js:287 的 failNote）差。改成引用 steward-conversation.js 的权威实现，不再自己
// 写第二份弱化版。
// 117u-G2 B2（27 号文 §11.15.3「一枚线程卡，三种密度」）：色号问【全仓那一张登记表】要 ——
// G1 已经把它从对话流的实例闭包提到模块级（stewardThreadHueFor），所以同一条线程在对话流／
// 频道条／线程详情栏／看板上恒是同一个号、同一种色。本模块不自己算色、不自己记号、不新开第二张表。
// 121-K6b（§5）：色号的键从 sessionId 换成 missionId 之后，「这条线程属于哪个任务」这件事必须
// 有人登记 —— 登记者只能是本模块（全仓唯一的 /api/missions 取数者），所以这一行多一个名字。
import { stewardErrorCode, stewardErrorText, stewardQueuedWaitLabel, stewardThreadHueFor,
  stewardRegisterThreadMission } from './steward-conversation.js';
// W4b（用户 2026-09-25「重新设计管家界面」）：左栏行右侧那句时间改说人话的「多久以前」（「刚刚」「3 分钟前」），
// 与焦点卡元信息一行、对话流卡头【同一个】实现（stewardAgoLabel → Intl.RelativeTimeFormat）——修前印的是
// elapsedLabel 的时长写法「0s 前有动静」。单开一条 import 行：上面那行被 steward-board.static 逐字钉着。
import { stewardAgoLabel } from './steward-conversation.js';
// 33 号文 §4（M3-a）：危险操作确认四套收一套。本看板的「停掉占用者」修前走原生 globalThis.confirm
// （全站唯一跳出式浮层：不跟主题、不跟语言、焦点不归壳管），现在走 js/confirm-panel.js 那一套。
// 单开一条 import 行是刻意的：steward-board.static D4 逐字钉着上面那两行 steward-drawer 导入的写法，
// 而 D4 要守的是「动作走抽屉同一段原语」这件事，不该为一次收编去动它（32 号文 §4 纪律 5）。
import { confirmDanger } from './confirm-panel.js';
// 121 走查1-②：行尾那枚「⋯」点开的是【同一份】动作表，开合走两壳共用的浮层原语（layer 模式：
// 不新建 .popover、不外挂 body，节点与挂载点都是行上现成的那两个）—— Esc／点外／同一时刻只允许
// 一张菜单／焦点归还锚点全部现成，不在本模块写第二套开合。chip 菜单走的也是它（steward-chips.js）。
import { popover, closePopover, popoverAnchor } from './popover.js';
// 121-K2b（34 号文 §6.2）：线上事件名的那一份登记表（与 13r 的显式登记一一对拍）。名字不在本文件
// 里各写一遍 —— 事件名 `thread.needs_you` 里那个词不是五态，不该进 B5／M6／N3 那本「五态字面量」账。
import { EVENT_STREAM_ROW_EVENTS, EVENT_STREAM_LIVE_EVENT } from './event-stream.js';

// 第117波 117h → 第121波 K4：一行状态 → 【左栏任务索引】 → 管家视角的右栏
// （34 号文 §2.2／§2.3／§2.6；原 27 号文 §8.2 L1／§8.10 的看板浮层已退役）。
//
// 三件事，一个模块：
//   ① 一行状态 `#stewardStatusLine` 与顶栏那枚全局胶囊 `#appStatusChip`：「N 在跑 · M 等你」。
//      计数只在 renderStatusLine 一处算（needsYouIds 是它的产物），点开＝把左栏滚到那一组；
//      一条线程都没有时说 §8.9 那句「还没有任务，直接说你想做什么」。
//   ② 左栏任务索引 `#railList`（§2.3）：**两视角共用的同一份 DOM**，常开，不再有「点开即看板」
//      这回事（那个浮层 #stewardBoard 与它的「开合」随 K4-2 退役 —— 一个要点开才新鲜的面本身
//      就是个错的形状，32 号文 §5 记过这笔账）。单位是【任务】：按 missionId 归组、按聚合五态分
//      五组（等你／在跑／排队／今天收工／更早），单线程任务就是一行、多线程任务折角展开。
//      行＝3px 色条（色号按任务）＋任务名＋聚合药丸＋来源图形＋速查徽标，第二行只在有话可说时出现。
//      「看板」密度（440px）多印一行事实：验收 a/b · 线程数 · 只在与全局不同时印权限 —— **不印费用**。
//   ③ 管家视角的右栏 `#stewardSide`：焦点那一条的内容就是【同一个】线程抽屉以 docked 挂法挂进来
//      （steward-drawer.js 的 setMount('docked') 把 #stewardDrawer 节点搬进 #stewardFocus）——
//      不存在第二份抽屉区块渲染。焦点线程由纯函数 focusThreadFor 决定，用户显式选过就钉住。
//      F3（32 号文 §2.2「线程即频道」）：其余在办的线程按 GET /api/missions 的【服务端行序】
//      （117s-A 的 D1 已经在 13d 一处按「状态优先、其次 updatedAt」排好）在抽屉的上下叠成小行 ——
//      焦点行之前的进上面那条 stack，之后的进下面那条，于是抽屉就插在它自己那一格里，右栏行序与
//      左栏、抽屉页签逐字节同源；本模块【不再排一次】，也【不复制】任何抽屉区块。
//
// 不另起判据（§2.3 逐条）：
//   · 任务聚合态【只读】行上的 `aggregateState`（116g 由 06i 的 aggregateMissionState 单点算出），
//     本模块不写「任一 needs_you 则…」这类字面判定；分组只是把那个态映到组名（railGroupFor，纯函数）；
//   · 线程五态经 mission-state.js 的 fromCard（全仓唯一判据，与抽屉逐字节同源）；
//   · 等待原因只有 `wait.label` 一处（116h 的 waitReasonFor 单点判定），本模块没有第二套等待文案；
//   · 「在跑时正在调什么」只读行上的 `liveTail`（13e 的叠加层，K2b 让它随推送实时），本模块不拼流；
//   · 「这条是不是速查」只读行上的 `quick`（K3 的身份格），不读 kind —— 那是档位不是身份；
//   · 「它从哪来」只读行上的 `origin`（K3 的 threadOriginOf 一处派生）；
//   · 权限／模型快切经 steward-chips.js 的同一个工厂（紧凑模式），本模块不自己 PATCH 会话。
//
// 刷新纪律：本模块恰好一处 setInterval 与一处 clearInterval，唯一入口 syncPolling() 先判
// 「管家模式 && 页面可见」，任一为否立刻停表。**工作台视角里左栏靠推送与动作刷新**（thread.* 五类
// 事件经 pushRefreshRows 落地；开／建／改名／删会话由 session-experience 调 renderRail）——
// 不为一份共用的左栏在工作台视角再开一条后台计时器（§3.4 红线的延伸）。

// 33 号文 §4「轮询常量收进叶子」：下限 5000／容差 250／默认 15000 这三个值原来与 steward-shell /
// steward-drawer 两处逐字相同，现在只有 steward-chips.js 一个来源。导出的本地名字没改 —— 锁钉的
// 是值（导出的 STEWARD_BOARD_POLL_MS_MIN 仍是 5000）与 pollTick／startPolling 的函数体。
export const STEWARD_BOARD_POLL_MS_MIN = STEWARD_POLL_MS_MIN;
// 同 steward-drawer.js：setInterval 会比标称早几毫秒回来，不留容差就会整整推迟一拍。
const POLL_DUE_SLACK_MS = STEWARD_POLL_DUE_SLACK_MS;
export const STEWARD_BOARD_POLL_MS_DEFAULT = STEWARD_POLL_MS_DEFAULT;
export const STEWARD_NOW_MIN_WIDTH = 1000;
// 2026-09-24（用户：「右边的线程永远收不起来」）：右栏【可收起】。三样事实，一处登记：
//   · 本机偏好键 —— 收起是用户的选择，要活过刷新（读写都包 try/catch，本机存储不可用时当没收起）；
//   · 窄条成立的最小宽度 —— 1181 是 css/layout.css §7.3「≤1180 右栏收成抽屉」那一档的对面：
//     抽屉带里右栏由顶栏那枚「右栏」钮开合，收起偏好在那一档【不作数】（两套开合不叠在一起）；
//   · 窄条上的两枚计数徽标读的仍是 renderStatusLine 那一次 filter 的产物（不新开第二个计数源）。
export const STEWARD_SIDE_COLLAPSED_KEY = 'wcw.stewardSideCollapsed';
export const STEWARD_SIDE_STRIP_MIN_WIDTH = 1181;
// F3：右栏那两条「小行叠」的容器 id。它们【不在】 index.html 的静态骨架里（A5/A7 的纪律：
// #stewardFocus 只是一个挂点），由本模块建出来并始终夹着抽屉那一份 —— 上面一条放焦点行之前的
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

// ── 121-K4 左栏：五组与「这一件该落在哪一组」（34 号文 §2.3）──────────────────────
// 顺序即屏幕上的顺序（最需要你的在最上面），别重排。
export const RAIL_GROUP_KEYS = Object.freeze(['needs_you', 'running', 'queued', 'unfinished', 'doneToday', 'earlier']);
// 等你那一行的问句在左栏只印前 22 字（§2.3 原话），全文在焦点栏／抽屉里。
export const RAIL_ASK_PREVIEW_CHARS = 22;

// 纯函数、零 DOM：一个任务落在哪一组。
// **它不是第二个状态机**：入参是【已经算好的】聚合态（06i 的 aggregateMissionState 一处算出，
// 经 13d 投影到行上的 aggregateState），本函数只回答「这个态 ＋ 这个时间 该排进哪一组」。
//   等你 = needs_you；在跑 = running；排队 = dispatching（还没有任何执行痕迹的那一档）；
//   其余（done / stopped / quick_ask）按【最后动静是不是今天】分「今天收工」与「更早」。
// 走查 #4 收尾：今天停下、没做完的那些（失败／断开／被叫停）单列「今天没做完」，排在收工之前 ——
// 以前它们混在「今天收工」里，用户以为做完了。仍不自造 failed 态：判据是 thread-facts 的
// missionStateUnfinished（同一个 stopped 折算），更早的照旧归「更早」。
export function railGroupFor(aggregateState, updatedAt, now = new Date()) {
  const state = String(aggregateState || '');
  if (state === 'needs_you') return 'needs_you';
  if (state === 'running') return 'running';
  if (state === 'dispatching') return 'queued';
  const at = updatedAt ? new Date(updatedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return 'earlier';
  const today = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const sameDay = at.getFullYear() === today.getFullYear()
    && at.getMonth() === today.getMonth()
    && at.getDate() === today.getDate();
  if (!sameDay) return 'earlier';
  return missionStateUnfinished(state) ? 'unfinished' : 'doneToday';
}

// ── 焦点线程：判据已搬到 thread-facts.js（124 还债④，40 号文 §8.5 ④）──────────
// 搬家的理由写在那边：服务端 13q 不再自己挑焦点，而管家对话（steward-conversation.js）跟看板
// 都要读同一份纯函数，它就得住在两边都够得着的叶子里。**导出名不改**：看板对外仍然
// 导出 focusThreadFor（steward-board.static C1/C3 与 focus-rail B1 钉的都是这个名字）。
export { focusThreadFor };

export function createStewardBoard({
  api = async () => null,
  state = null,
  t = key => key,
  isStewardMode = () => false,
  drawer = null,
  saveConfigPartial = async () => false,
  // 117g：行上的「在工作台打开」走它（切工作台视角＋选中会话）。
  // 121-K4：switchWholeShell（「整体切到 2.0」）那一路随看板浮层顶部那枚钮一起退役 —— 视角切换
  // 只在顶栏分段钮一处（§2.2），本模块因此不再需要它。
  // 121-K5：注入的实现从 steward-classic-window.js 的 openClassicWindow（带 sessionStorage 返回
  // 标记与一条返回带）换成 js/shell-mode.js 的 openInWorkbench（只有切视角 ＋ openSession 两步）。
  // 参数名不改：本模块问的仍然是「把这条线程在工作台打开」，谁来做是组合根的事。
  openClassicWindow = async () => {},
  // 121-K4（§2.3 点击语义）：工作台视角里点一行＝真的把中栏换成那条线程，所以本模块要认识
  // openSession（组合根那一个，与抽屉的「在工作台打开」同一份实现，不另起第二条路）。
  openSession = async () => {},
  // 121-K4：左栏搜索（Ctrl+K）的后端内容搜索结果快照（113b 那条路由与去抖仍住 session-experience，
  // 本模块只读它算好的 { query, results } —— 不发第二发请求，也不自己去抖）。
  searchState = () => null,
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
  // 2026-09-24 右栏可收起：用户的偏好（读一次本机存储）＋「收起期间管家聚焦过新线程」这一位。
  // 后者只让窄条亮一颗点 —— 收起是用户说的「别占我这块屏」，管家换焦点不许把它顶开。
  let sideCollapsedPref = readSideCollapsedPref();
  let sideFresh = false;
  let sideCounts = { running: 0, needsYou: 0 };   // 窄条徽标读的数，renderStatusLine 那一次 filter 的产物
  // 117m-A2：状态行那一次 filter 顺手留下的名单（等你的线程 id）。它是「N 条等你」这枚按钮的去处，
  // 也是「把等你的行排到最前」的判据 —— 两处都读它，不再数第二遍，也不新开第二个计数源。
  let needsYouIds = [];
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
  const ACCEPTANCE_KEYS = Object.freeze({
    none: 'stewardShell.board.acceptanceNone',
    count: 'stewardShell.board.acceptance',
    // 124 还债①：「压根没人记过」那一格的措辞（判据与抽屉共享，措辞各说各的）。
    unrecorded: 'stewardShell.board.acceptanceUnrecorded',
  });
  // 117q-B3b：五态人话统一走中性的 mission.state.*（原来那组仅抽屉专属命名的键已并入，
  // 与看板、抽屉、交办台三个壳共用同一组键，见 30 号文 §4.4），不再开第二套五态文案。
  function stateLabel(value) {
    return value ? t(`mission.state.${value}`) : '';
  }
  // 117n-M1③（用户「看板圆点看不出已完成」）：同一条线程收工之后，抽屉那颗点走六态原始 state
  // 直接判绿（steward-drawer.js:419／CSS 的 [data-state="done"]），看板这颗点却经
  // dockToneForMissionState 收成三档、done 落进 quiet 灰点 —— 用户扫看板看不出哪条线程真的完成了。
  // 传 settleDone:true 让看板这一处主动选出第四档 settled；不传参数的默认行为一个字不变
  // （121-K1 之前那个默认行为还有第二个见证者 —— 交办台的 dock 座，它已随交办台退役；
  // 现在由 steward-board.static 的 G9b 真值表首行直接钉住 done → quiet）。
  // 117u-G2 B2：tone 从 paintDot 里【提出来】成一个纯函数。理由是右栏那一面：小行那颗点自此
  // 归线程色（色 ≠ 态），但「展开还是折成一行」仍然只认这四档 tone —— 提出来之前要拿 tone 必须
  // 先 paintDot 造一颗点、从 dataset 上读回来再把点扔掉。两处调用问的仍是【同一处】判定：
  // dockToneForMissionState 在本模块全文仍然只被调用这一次。
  // 121-K1：它随交办台退役从 preview-shell.js 搬进叶子 thread-facts.js（与 elapsedLabel 同族的
  // 「五态显示事实」），只改 import 来源，调用一个字未变。
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
  // 121-K6b（§5）：第二个形参是【任务 id】。传不传都拿得到同一个号（登记表已经记下归属），
  // 传是为了任务行那一处 —— 它画的本来就是任务，不该借领头线程的身份去问号。
  function paintThreadCard(node, sessionId, missionId) {
    node.classList.add('steward-tcard');
    if (sessionId) node.dataset.threadHue = String(stewardThreadHueFor(sessionId, missionId));
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
  // 128f：取行也会【后发先至】—— 开关写完的那一发、在场回执那一发、推送那一发、兜底那一拍可能同时在飞，
  // 先发的晚到会把后发的新行与 ETag 盖回旧的。后发的那一发看到的服务端状态不会更旧（同一个 If-None-Match
  // 出发，它若 304 说明数据没变；若 200 则至少一样新），所以【只认最后发出的那一发】是安全的。
  // 被取代的那一发【等最后那一发落地再回】，不是立刻回 false：调用方紧接着就 render（setWatch 就是），立刻回的话
  // 画的是两发都还没落地时的旧行 —— thread-switch-race W2 构造出来过：开关刚点成「别盯了」，下一帧又被勾回去。
  let missionsLoadSeq = 0;
  let missionsLoadLatest = null;
  function loadMissions() {
    const seq = ++missionsLoadSeq;
    const run = loadMissionsOnce(seq);
    missionsLoadLatest = run;
    return run;
  }
  async function loadMissionsOnce(seq) {
    try {
      // 117q-B3a(P1-6):裸 fetch 换 apiRaw——304/etag 判断逻辑一个字不动，唯一变化是拿到 403 +
      // auth.token_invalid(后台进程重启后旧 token 失效)时会像其余 45+ 处 api() 调用点一样自愈：
      // 换新 token 重放一次，而不是直接放弃、空转到用户手动刷新页面。
      const headers = missionsEtag ? { 'if-none-match': missionsEtag } : {};
      const response = await apiRaw('/api/missions?limit=200', { headers });
      if (seq !== missionsLoadSeq) return missionsLoadLatest;   // 128f：已经有更晚发出的一发 —— 这一份不许写回，等它落地
      if (response.status === 304) return false;          // 没变：不重画，chip 菜单也就不会被打断
      if (!response.ok) return false;
      const payload = await response.json();
      if (seq !== missionsLoadSeq) return missionsLoadLatest;
      missionsEtag = response.headers.get('etag') || '';
      rows = Array.isArray(payload && payload.missions) ? payload.missions : [];
      const removal = removalOf();
      if (removal && removal.done.size) {
        const present = new Set(rows.map(row => String((row && row.sessionId) || '')));
        for (const id of [...removal.done]) if (!present.has(id)) removal.done.delete(id);
      }
      // 121-K6b（34 号文 §5「色号按任务」）：本模块是全仓唯一那个 /api/missions 取数者，所以
      // 「这条线程属于哪个任务、任务叫什么、这个任务有几条线程」这三件事只有它第一手知道。
      // 登记一次，四面（对话流卡头／焦点卡／左栏行／看板密度行）问同一张表拿同一个号，也拿到
      // 同一份「任务 › 线程」面包屑 —— 本模块自己【不算】色号、不存第二份任务名。
      for (const row of rows) {
        if (!row || !row.sessionId) continue;
        stewardRegisterThreadMission(String(row.sessionId), {
          missionId: String(row.missionId || ''),
          missionTitle: String(row.missionTitle || ''),
          threadCount: Number(row.threadCount) || 0,
        });
      }
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
      renderGlobalChip(0, 0);
      sideCounts = { running: 0, needsYou: 0 };
      renderSideStrip();
      line.textContent = t('stewardShell.board.statusEmpty');
      return line.textContent;
    }
    const running = views.filter(view => view.state === 'running').length;
    // 计数与【名单】同一次 filter 算出来：右上那枚「去处理」要知道去哪一条，而计数源仍然只有这一处
    // （117l 的 needsYouCount 与顶栏那枚全局胶囊读的都是这条状态行的同一份事实，不新开第二个计数源）。
    const waiting = views.filter(view => view.state === 'needs_you');
    needsYouIds = waiting.map(view => String(view.sessionId));
    renderNeedsYouGo();
    renderGlobalChip(running, waiting.length);
    sideCounts = { running, needsYou: waiting.length };   // 右栏窄条的徽标读同一次 filter 的结果
    renderSideStrip();
    // W4b（用户 2026-09-25 走查⑤「0 计数是噪声」）：一行状态只说【有】的那一档 —— 「2 条在跑 · 1 条等你」；
    // 都是 0 就整行空着（:empty 收掉，头部只剩 presence 那一句「空闲」）。任务总数不再印：左栏栏头
    // 那枚 #railCount 已经是它（同一件事不印两遍）。计数源仍然只有上面那一次 filter。
    const parts = [];
    if (running > 0) parts.push(t('stewardShell.board.statusRunning', { n: running }));
    if (waiting.length > 0) parts.push(t('stewardShell.board.statusNeedsYou', { n: waiting.length }));
    line.textContent = parts.join(' · ');
    return line.textContent;
  }

  // 「N 条等你」按下去：恰好 1 条就直接把那条线程的抽屉打开（问答卡在那儿，焦点也落进去）；
  // 多于 1 条就把左栏滚到「等你」那一组。
  // 121-K4：修前那一支是「拉开看板浮层 ＋ 把等你的行临时排到最前」。浮层退役、左栏常开之后，
  // 那两步都不需要了 —— 组头本来就把等你的那几件收在一起，滚过去就是全部。于是那个只活一程的
  // 临时排序（needsYouFirst）也随之删掉：后端行序自此是屏幕上唯一的行序。
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
    return jumpToGroup('needs_you');
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
    // 判据是 run-state.js 的那一份（与 pauseAll 自己用的名单同一个函数），不借 arbiter.running，也不就地写第二遍。
    const pausable = hasPausableRun(rows);
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

  // ── ① 左栏的登记表与小判据（§2.3）──────────────────────────────────────────────
  // 组头计数与「点开即滚到那一组」的去处都读这一张表，不在别处写第二份组名。
  const RAIL_GROUP_LABELS = Object.freeze({
    needs_you: 'rail.group.needsYou',
    running: 'rail.group.running',
    queued: 'rail.group.queued',
    unfinished: 'rail.group.unfinished',
    doneToday: 'rail.group.doneToday',
    earlier: 'rail.group.earlier',
  });
  // 「更早」默认折叠（§2.3）；其余四组默认展开。用户点过就记在这一程里（不落本机偏好）。
  const railGroupClosed = new Map([['earlier', true]]);
  const railTaskOpenById = new Map();   // missionId -> 用户显式点过的展开状态（没点过就按默认判）

  function railGroupOpen(key) {
    return railGroupClosed.get(key) !== true;
  }
  function railGroupHead(key, count, open) {
    const head = el('div', 'rail-gh');
    const toggle = el('button', 'rail-gh-toggle', t(RAIL_GROUP_LABELS[key] || key));
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.onclick = () => { railGroupClosed.set(key, open); renderRail(); };
    head.appendChild(toggle);
    const n = el('span', 'rail-gh-n num', String(count));
    // 组头计数只有两档颜色（§2.3「等你金色、在跑青花蓝」），其余安静 —— 样式层读这个属性。
    if (key === 'needs_you' || key === 'running') n.dataset.tone = key;
    head.appendChild(n);
    return head;
  }
  // 含等你／在跑的任务默认展开（§2.3）；用户显式点过就以他点的为准。
  function railTaskOpen(group) {
    const explicit = railTaskOpenById.get(group.missionId);
    if (explicit !== undefined) return explicit;
    const aggregate = String(group.aggregateState || '');
    return aggregate === 'needs_you' || aggregate === 'running';
  }
  function toggleTask(missionId, open) {
    railTaskOpenById.set(String(missionId || ''), Boolean(open));
    renderRail();
    return open;
  }

  // ── 121 走查1-②（用户 2026-09-13 走查第 2 条）：整行可点 ─────────────────────────────
  // §2.3 的点击语义写的是【行】—— 「单线程任务行→打开它；多线程任务行→展开／收起；线程行→
  // 打开它」。修前只有那枚 .steward-board-thread-title 按钮接 click，于是「必须点文字才能切」。
  // 这里给行本身接一发，命中【任何一个真控件】时让位（按钮／链接／输入／标签，含 chip、药丸、
  // 折角与行尾那枚「⋯」）—— 那些各自有各自的语义，行不该抢。
  // 键盘不另开一条路：行里那枚标题按钮本来就在 Tab 序里，Enter／Space 是它的原生行为，
  // 与这一发点击落到同一个 openRow／toggleTask（所以行不加 role="button"／tabindex —— 行里嵌着
  // 好几枚真按钮，给行套一个 role=button 是嵌套可交互元素，读屏反而更差）。
  const ROW_CONTROL_SELECTOR = 'button, a, input, select, textarea, label';
  function bindRowClick(item, run) {
    item.addEventListener('click', event => {
      const target = event && event.target;
      if (target && typeof target.closest === 'function' && target.closest(ROW_CONTROL_SELECTOR)) return;
      run();
    });
    return item;
  }

  // ── 121 走查1-②：行尾那一枚「⋯」──────────────────────────────────────────────────
  // 普通密度不再悬停就摊开八枚动作（那正是用户说的「显示的内容太多了」），置顶／重命名／删除
  // 与其余次级动作全部收进这一枚。**它点开的是同一个 .steward-board-actions 节点**（同一批按钮
  // 实例、同一批 handler）—— 本模块不写第二份动作表，动手的仍是 session-experience.js 那一处。
  // 开合走 popover 的 layer 模式：节点已经在行里，只切 [hidden] 与行上那个类名，位置由 CSS 定。
  function moreButton(item, actions) {
    const button = el('button', 'icon-btn steward-board-more');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const label = t('common.more');
    button.title = label;
    button.setAttribute('aria-label', label);
    const glyph = icon('more', 13);
    if (glyph) button.appendChild(glyph);
    button.onclick = () => {
      if (item.classList.contains('is-actions-open')) { closePopover(); return; }
      // popover(layer) 会把节点先清空再让 buildContent 填回去 —— 把原来那批按钮原样放回去，
      // 于是「同一份动作表」这件事在 DOM 层面也成立（不是重建一批同名按钮）。
      const kept = [...actions.children];
      popover(button, () => { for (const child of kept) actions.appendChild(child); return null; }, {
        layer: { mount: item, node: actions },
        onOpen: () => { item.classList.add('is-actions-open'); button.setAttribute('aria-expanded', 'true'); },
        onClose: () => { item.classList.remove('is-actions-open'); button.setAttribute('aria-expanded', 'false'); },
      });
    };
    return button;
  }

  // §2.3 来源图形：管家开的＝环（环心点）／我开的＝人形／定时＝钟；悬停才出字。
  // 判据【只读】行上的 origin（K3 的 threadOriginOf 一处派生，13e 投影到行上），本模块不猜。
  // 121-K8 会把 lensSteward／originUser／originSchedule 三枚字形补进 icons.js；本刀先用既有字形
  // 占位（target＝双环＋实心点，与 avatar 的最简形同义；agents＝人形；bell＝提醒物）。
  const RAIL_ORIGIN_ICONS = Object.freeze({ steward: 'originSteward', user: 'originUser', schedule: 'originSchedule' });
  const RAIL_ORIGIN_KEYS = Object.freeze({
    steward: 'rail.origin.steward',
    user: 'rail.origin.user',
    schedule: 'rail.origin.schedule',
  });
  function originMark(origin) {
    const key = String(origin || '');
    const name = RAIL_ORIGIN_ICONS[key];
    if (!name) return null;
    const mark = el('span', 'rail-origin');
    mark.dataset.origin = key;
    const glyph = icon(name, 12);
    if (glyph) mark.appendChild(glyph);
    // F5a 纪律：图标永远带可访问名，且不作为唯一信号 —— 悬停出字，读屏能问到。
    const label = t(RAIL_ORIGIN_KEYS[key]);
    mark.title = label;
    mark.setAttribute('aria-label', label);
    return mark;
  }

  // §2.3「第二行只在有话可说时出现」。两态两句，都【只读】行上已有的事实：
  //   在跑 → `工具 · N 秒前有输出`（row.liveTail：13e 的叠加层，K2b 让它随推送实时）
  //   等你 → 问句前 22 字（row.asksYou.text：06i 的 stewardPendingOneLine 单点算出）
  //   收工 → 不印（药丸已经说了；§2.3 原话）
  //   排队 → 这里【也不印】：等待原因由卡尾那一行 .steward-board-wait 渲染（116h 的 wait.label
  //     全仓只有那一处落点）。在这里再印一遍就是把同一句话印两遍，也会让「wait.label 只渲染一处」
  //     那条锁变成两处 —— §2.3 要的「第二行是等待原因」由那一行承担，不是再画一行。
  function railSubLine(row, state) {
    if (state === 'running') {
      // 137x（用户 2026-09-24 「工具显示会让线程变大变小」）：服务端在工具收尾那一刻把 tail.tool
      // 清成 ''（04-permission-runtime.js），若这里跟着回落成空串，paintRailLive 就会把这一行的
      // <p> 摘掉、下一次工具开始时再插回来 —— 行高跟着每一次 tool_use/tool_result 抖一次。改成
      // 有工具名给工具名、没有（刚起跑或两次工具之间的间隙）给中性占位，这一行只在【进/出运行态】
      // 各变一次高度，不再随每次工具调用增删。
      const tail = (row && row.liveTail && typeof row.liveTail === 'object') ? row.liveTail : null;
      const tool = String((tail && tail.tool) || '');
      if (!tool) return t('rail.liveRunning');
      const elapsed = elapsedLabel(String(tail.updatedAt || row.updatedAt || ''), new Date());
      return elapsed ? t('rail.liveTool', { tool, elapsed }) : tool;
    }
    if (state === 'needs_you') {
      const asks = (row && row.asksYou && typeof row.asksYou === 'object') ? row.asksYou : null;
      const text = String((asks && asks.text) || '').trim();
      if (!text) return '';
      return text.length > RAIL_ASK_PREVIEW_CHARS ? `${text.slice(0, RAIL_ASK_PREVIEW_CHARS)}…` : text;
    }
    return '';
  }

  // W4b：左栏行右侧那句时间。60 秒以内说「刚刚」（修前是「0s 前有动静」），其余走全仓唯一那份
  // 「多久以前」实现（stewardAgoLabel，与焦点卡元信息一行、对话流卡头同一句人话）；算不出来就不印。
  // 「刚刚」这一档的判据只有这 60 秒一条，与 stewardAgoParts 的秒档同一条界线。
  function railAgoLabel(iso) {
    const at = Date.parse(String(iso || ''));
    if (!Number.isFinite(at)) return '';
    if (Date.now() - at < 60000) return t('rail.justNow');
    const document_ = doc();
    return stewardAgoLabel(iso, (document_ && document_.documentElement && document_.documentElement.lang) || '');
  }

  // 搜索（Ctrl+K）：框还是 2.0 那一个（#sessionSearch），过滤在这里。
  // 两条路合一：①「后端内容搜索」命中的会话 id 集合（113b 那条路由与去抖仍住 session-experience，
  // 本模块只读它的结果快照）；② 没有后端命中时按标题子串过滤。判据只有这一处。
  function railFilter() {
    const input = byId('sessionSearch');
    const query = String((input && input.value) || '').trim().toLowerCase();
    if (!query) return null;
    const snapshot = searchState() || null;
    const hit = snapshot && Array.isArray(snapshot.results) && String(snapshot.query || '').toLowerCase() === query
      ? new Set(snapshot.results.map(item => String((item && item.id) || '')))
      : null;
    return { query, ids: hit };
  }
  function railRowMatches(row, filter) {
    if (!filter) return true;
    if (filter.ids) return filter.ids.has(String(row.sessionId || ''));
    const hay = [row.displayTitle, row.title, row.missionTitle, row.cwd]
      .map(value => String(value || '').toLowerCase());
    return hay.some(value => value.includes(filter.query));
  }

  // 选中谁：管家视角＝焦点线程（右栏那一份抽屉开着的那条），工作台视角＝当前会话。
  // 两视角同一份 DOM、两套「选中」的来源 —— 但都不是本模块新开的状态（前者是 currentFocusId，
  // 后者是组合根持有的 state.currentSession）。
  function railSelectedId() {
    if (isStewardMode()) return currentFocusId();
    const current = (state && state.currentSession) || null;
    return String((current && current.id) || '');
  }

  // §2.3「＋」两义：管家视角印「＋ 新任务」（让如意另起一件，不建会话），工作台视角印「＋ 新线程」
  // （立即开一条线程，走 2.0 那条 createSession）。按钮【是同一枚】（#newSessionBtn），
  // 接线住组合根（app.js 那一处判视角），本模块只管把它的字改对。
  // 121 走查1-③（用户 2026-09-13 走查第 3 条）：两义要【看得出来】。修前这里只换文案与 title ——
  // 同一枚主色实心钮、同一枚 plus 字形，两个视角看着就是同一个动作。现在同一处再写两样：
  //   · data-lens —— 底色由 css/layout.css 的 #newSessionBtn[data-lens="steward"] 切（管家那一枚
  //     是鎏金描边的次级钮：它不建任何东西，只是把话头交给如意）；
  //   · 字形 —— 管家那一枚是 lensSteward（环＋心点，就是 avatar 的最简形，§2.10.1），工作台仍是 plus。
  // 写在这一处而不是给 app-frame 加第二个观察者：视角一变本函数就跑（renderRail 每拍都调它），
  // 而「＋」的两义本来就归本模块（§2.3 那一条的落点）。
  const RAIL_PLUS_ICONS = Object.freeze({ steward: 'lensSteward', classic: 'plus' });
  function syncRailPlus() {
    const label = byId('newSessionBtnLabel');
    if (!label) return '';
    const lens = isStewardMode() ? 'steward' : 'classic';
    const key = lens === 'steward' ? 'rail.newTask' : 'rail.newThread';
    label.textContent = t(key);
    const button = byId('newSessionBtn');
    if (button) {
      const hint = t(lens === 'steward' ? 'rail.newTaskHint' : 'rail.newThreadHint');
      // 无障碍名就用看得见的那几个字（「新线程」／「另起一件」），说明放 title 当描述读出。修前 aria-label
      // 整个换成了说明句，用语音控制说「点新线程」点不到（WCAG 2.5.3 可见标签须在名字里）。
      button.title = hint;
      button.removeAttribute('aria-label');
      button.dataset.lens = lens;
      const wanted = RAIL_PLUS_ICONS[lens];
      if (button.dataset.icon !== wanted) {
        const old = button.querySelector('svg.ic');
        if (old) old.remove();
        const glyph = icon(wanted, 16);
        if (glyph) button.insertBefore(glyph, button.firstChild);
        button.dataset.icon = wanted;
        button.dataset.iconized = '1';   // hydrateIcons 幂等标记：别让它再补一枚进来
      }
    }
    return key;
  }

  // 顶栏那枚全局状态胶囊「N 在跑 · M 等你」（§2.2）。计数源仍然只有 renderStatusLine 那一处
  // （needsYouIds 就是它的产物）—— 本函数只画，不数。【不印】任务总数、不印费用、不印模型名。
  function renderGlobalChip(running, needsYou) {
    const chip = byId('appStatusChip');
    if (!chip) return '';
    const show = running > 0 || needsYou > 0;
    chip.hidden = !show;
    clear(chip);
    if (!show) return '';
    const runText = t('rail.chip.running', { n: running });
    const youText = t('rail.chip.needsYou', { n: needsYou });
    const runDot = el('span', 'd run');
    runDot.setAttribute('aria-hidden', 'true');
    const youDot = el('span', 'd you');
    youDot.setAttribute('aria-hidden', 'true');
    chip.appendChild(runDot);
    chip.appendChild(el('span', 'num', runText));
    chip.appendChild(youDot);
    chip.appendChild(el('span', 'num', youText));
    const label = `${runText} · ${youText}`;
    chip.title = label;
    chip.setAttribute('aria-label', label);
    return label;
  }

  // 点开胶囊／点一行状态 = 把左栏滚到最需要你的那一组（§2.2「点开＝左栏滚到该组」）。
  // 它不是第二个过滤器，也不换焦点：只是把视线送到该看的地方。
  function jumpToGroup(key) {
    const target = key || (needsYouIds.length ? 'needs_you' : 'running');
    railGroupClosed.set(target, false);
    renderRail();
    const section = doc() && doc().querySelector(`#railList .rail-group[data-group="${target}"]`);
    if (!section) return '';
    if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'nearest' });
    return target;
  }

  // ── ② 左栏正文：按任务归组（§2.3「单位是任务」）─────────────────────────────────
  // 归组键仍是 missionId（普通会话回落它自己的 sessionId）；聚合态【只读】行上的 aggregateState
  // （06i 的 aggregateMissionState 一处算出），本模块不写第二套聚合判据。
  // 128f-⑫（用户 2026-09-19「删除线程没有及时的界面反馈，要点别处才刷新消失」）：删除的即时反馈。
  // 删除的唯一动手处是 session-experience.js（removeSession／批量清理），它在 state.sessionRemoval 里记两件事：
  //   pending —— 请求在飞：这一行变灰、不接点击（renderThreadRow）；
  //   done    —— 服务端已经删了：这一行立刻不画，不等下一发 /api/missions 回来（冷的时候那一发要几百毫秒）。
  // done 里的 id 在【取回来的行里真的没有它了】时才清（loadMissionsOnce），所以它只是一段过渡，不是第二份行。
  function removalOf() {
    const removal = state && state.sessionRemoval;
    return removal && removal.pending instanceof Set && removal.done instanceof Set ? removal : null;
  }
  function groupRows() {
    const groups = new Map();
    const removal = removalOf();
    for (const row of rows) {
      if (removal && removal.done.has(String(row.sessionId || ''))) continue;
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
          // 121-K4：左栏行要的三样事实。来源与「最后动静」取【领头那一条】（行序由服务端排好，
          // 见 renderRail 的注）；这里不做任何排序，也不推第二套聚合。
          origin: '',
          updatedAt: '',
          rows: [],
        });
      }
      const group = groups.get(missionId);
      group.rows.push(row);
      const at = String(row.updatedAt || '');
      if (at > group.updatedAt) group.updatedAt = at;
      if (!group.origin) group.origin = String(row.origin || '');
    }
    return [...groups.values()];
  }

  // 33 号文 §4：acceptanceText 的正身已住 steward-drawer.js（判据一处），本模块调用点把自己那套键
  // （ACCEPTANCE_KEYS）与 t 一起递进去 —— 措辞仍是原来那两条键，一个字没变。

  // 128f-⑫ 续（action-feedback R6d 在负载下复现，用户侧就是「左栏行上的菜单点开就自己没了」）：左栏每次重画都把整行
  // DOM 换掉（chip 的 mount 会清空重建按钮与就地菜单），而推送让重画很频繁。点下行上的 chip 之后：先补读一次会话
  // （hydrate，在飞时左栏被重画 → 被点的按钮已经不在文档里，菜单开在拆掉的节点上）；菜单开着时再被重画 → 开着的菜单
  // 跟着整行没了。所以：行内有交互「活着」时（有 chip 正在补读、或者弹层正挂在左栏里的某个锚点上）重画先记一笔不画，
  // 菜单一收（chip 的 onMenuIdle）就补画一次。行上别的弹层（改名）收起之后由它自己那次动作的 syncRail 画。
  let railChipHydrating = 0;
  let railRenderDeferred = false;
  function railInteractionLive() {
    if (railChipHydrating > 0) return true;
    const anchor = popoverAnchor();
    const host = byId('railList');
    return Boolean(anchor && host && typeof host.contains === 'function' && host.contains(anchor));
  }
  function flushDeferredRailRender() {
    if (!railRenderDeferred || railInteractionLive()) return false;
    renderRail();
    return true;
  }
  function chipsFor(sessionId) {
    let control = chipsBySession.get(sessionId);
    if (!control) {
      control = createQuickSwitchChips({
        api, t, state,
        compact: true,                                   // §8.10 线程行：权限＋模型，引擎收进模型菜单
        // 卡片行没有 permissionMode/engineRoute（GET /api/missions 返回的是任务卡，不是会话元数据）。
        // 打开菜单前按需补一次真会话，补到的那一份进缓存，下一次渲染就喂它。
        hydrate: async id => {
          railChipHydrating += 1;   // 128f-⑫ 续：补读在飞 = 菜单在开的路上，左栏先别重画
          try {
            const response = await api(`/api/sessions/${encodeURIComponent(id)}`);
            const session = (response && response.session) || null;
            if (session) sessionCache.set(id, session);
            return session;
          } catch { return null; }
          finally { railChipHydrating = Math.max(0, railChipHydrating - 1); }
        },
        onChanged: session => { if (session && session.id) sessionCache.set(String(session.id), session); },
        onMenuIdle: () => { flushDeferredRailRender(); },
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

  // 任务级的事实（验收 a/b · 线程数）：13d 一处算好之后投影到它【每一条】线程行上，所以整件事
  // 只许印一次 —— 单线程任务印在那唯一一张卡的卡尾，多线程任务印在任务行的卡尾。一个渲染器、
  // 两个落点（G1 那根色条「一份声明两个落点」的同一条道理），不是两份实现。
  // 121-K4（34 号文 §7.2「费用规则」）：这一行【不再印钱】—— 金额只在「用量」页签、体检页与行动
  // 流水的单条明细里出现，左栏（含看板密度）一律不印。判据不是「少调一个函数」而是：本模块自此
  // 连费用文案的键都不认识（COST_KEYS 与 stewardCostText 的 import 一起删掉，长不出第二处）。
  // 只在【看板密度】出现（样式层一条规则），紧凑密度下左栏只留一行主信息。
  function missionFacts(group) {
    const line = el('div', 'steward-board-facts');
    // 没有验收项就【什么都不说】（§2.3「只在有话可说时出现」的同一条纪律）：K3 放宽索引口径之后
    // 左栏里大半是手工开的线程，逐行印一句「没有验收项」就是满栏等重灰字（§11.15.2 病 3）。
    // 判据仍然只有 stewardAcceptanceText 那一份（验收 a/b 的措辞与口径都在它那儿）。
    const acceptance = (group.acceptance && typeof group.acceptance === 'object') ? group.acceptance : {};
    // 124 还债①（40 号文 §8.5 ①；用户 2026-09-15 拍板「只在收工了却没人记过时印」）：
    // 「没有验收项」（记过、是空的）与「未记录验收」（压根没人记过）不是一回事 —— 抽屉早就分得开，
    // 看板修前分不开，因为列表行上只有容器那三个数。13d 现在把 ledger / tracked 两个组级事实一起
    // 投影下来，判据仍然只有 thread-facts.acceptanceRecorded 一处。
    // 两道门缺一不可：
    //   · tracked —— 这一组得是【一件活】（有事项容器，或组里有 mission 线程）。左栏自 121-K3
    //     放宽索引口径后大半是用户手工开的普通会话，它们恒落 stopped、也从来没有验收记录；
    //     不带这道门就是满栏等重灰字（§2.3「只在有话可说时出现」，正是 P1 当初刻意不碰看板的理由）。
    //   · 收工了才说 —— 还在跑／等你时说「未记录验收」没有意义（活还没干完，本来就没到验收的时候）；
    //     收工了却没人记过，才是 41 号方案 §9 J08「不声称完成全部验收」要挡的那一格。
    const settled = missionStateSettled(group.aggregateState);
    const unrecordedWorthSaying = acceptance.tracked === true && settled && !acceptanceRecorded(group);
    if (Number(acceptance.total) > 0 || unrecordedWorthSaying) {
      line.appendChild(el('span', 'steward-board-pill', stewardAcceptanceText(group, t, ACCEPTANCE_KEYS)));
    }
    const threads = group.rows.length > 1 ? (group.threadCount || group.rows.length) : 0;
    if (threads > 1) line.appendChild(el('span', 'steward-board-pill', t('stewardShell.board.threadCount', { n: threads })));
    return line;
  }

  // options.missionId：B5 那枚「＋ 线程」挂的任务（由 renderRail 递进来，本函数不自己再推一次
  // 分组键）；options.facts：单线程任务的验收线（多线程时为 null，落在任务行上）；
  // 121-K4 新增两个：
  //   options.hueKey —— 色号取哪一个键（缺省＝这条线程自己的 sessionId，与对话流／线程详情栏／
  //     右栏小行三面逐字同源）。左栏的任务行用它把色条对到【领头那条线程】上；把整张登记表改成
  //     按任务发号是 §2.3 的最终形态，但那要四面一起改，归 K6（见 railTaskRow 的头注）。
  //   options.selected —— 此刻选中的是哪一条（管家视角＝焦点线程，工作台视角＝当前会话）。
  function renderThreadRow(row, options = {}) {
    const sessionId = String(row.sessionId || '');
    const item = paintThreadCard(el('li', 'steward-board-thread'), String(options.hueKey || sessionId));
    item.dataset.sessionId = sessionId;
    if (options.selected && String(options.selected) === sessionId) item.classList.add('is-sel');
    const removal = removalOf();
    if (removal && removal.pending.has(sessionId)) { item.classList.add('is-removing'); item.setAttribute('aria-busy', 'true'); }
    const threadState = threadStateOf(row);
    // 五态原样写在卡上。修前它挂在那颗点上（paintDot 的 node.dataset.state），B2 之后点归线程色、
    // 态归药丸，而药丸在「它在问你」那种行上是让位的（见下）—— 不写在卡上，这一行现在处于什么态
    // 在 DOM 里就只剩一句会随语言变的人话。样式层【不读】它（本层零 [data-state] 规则）：它是
    // 事实与调试用的，不是第二个视觉信号。值仍然只来自 threadStateOf，零新增字面量。
    if (threadState) item.dataset.state = threadState;


    // 121 走查1-②：整行可点（线程行→打开它，§2.3 点击语义第一／第三条）。命中真控件时让位。
    bindRowClick(item, () => openRow(sessionId));

    const head = el('div', 'steward-board-thread-head');
    head.appendChild(threadDot());
    // 116-5b(§11.8.5):显示名由服务端一处算好(13d buildMissionCard 的 displayTitle,判据在 02 的
    // sessionDisplayTitle),看板只读结果 —— 与本行的 stateLabel / wait.label 同一条纪律。
    // 原话挂 hover(它没被改写,仍是权威);没有摘要时 displayTitle 逐字等于 title,不挂重复的提示。
    const title = el('button', 'steward-board-thread-title', threadShownTitle({ ...row, sessionId }, t('session.untitled')));
    if (row.title && row.displayTitle && row.title !== row.displayTitle) title.title = String(row.title);
    title.type = 'button';
    head.title = title.textContent;   // ≤980 图标栏只剩一颗色点、标题收起：悬停色点说得出是哪一条（走查 #18）
    // §2.3 点击语义：单线程任务行／线程行 → 打开它。管家视角＝换焦点（右栏那一份抽屉），
    // 工作台视角＝openSession（中栏那条对话）。两视角同一份 DOM、两种打开法，见 openRow。
    title.onclick = () => openRow(sessionId);
    head.appendChild(title);
    // 117r-D5：「速查」是这条线程【是什么】(kind)，不是它【在干什么】(state)。修前它霸占着状态位，
    // 于是一条速查线程无论在跑、在等你还是三小时前就跑完了都只会说「速查中」。判据搬回 kind 之后
    // 这个身份不能就此消失——它是有用的信息(管家自己开的临时线程，不是一件正经交办)，所以在行上
    // 与五态那颗点【并列】给一枚徽标，不替换它。文案复用既有键 mission.state.quick_ask，不新开键。
    // 判据仍然【只读】行上的 kind(13d buildMissionCard 如实取 sessionKind(head) 的那一个)，
    // 本模块不认识 stewardQuick / launchedBy 这些会话头字段，也就长不出第二套「它算不算速查」。
    // 121-K3 登记项②（34 号文 §13.5 末）：判据从 `kind === 'quick_ask'` 换成行上的身份格
    // `row.quick`。理由是 K3 放宽索引口径之后【普通会话也有卡片】，而 sessionKind() 对它们同样
    // 返回 'quick_ask'（第 70 波的那个值是【档位】不是【身份】）—— 读 kind 会给每一条手工开的
    // 会话贴一枚「速查」。`quick` 由 13d buildMissionCard 与 13j stewardQuickThread 同源算出，
    // 本模块仍然只读结果、不认识 stewardQuick / launchedBy 这些会话头字段。
    if (row.quick === true) {
      const badge = el('span', 'steward-board-pill', t('mission.state.quick_ask'));
      badge.dataset.kind = 'quick_ask';
      head.appendChild(badge);
    }
    // §2.3 来源图形：管家开的＝环（环心点）／我开的＝人形／定时＝钟，悬停才出字。
    const mark = originMark(row.origin);
    if (mark) head.appendChild(mark);
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
      pill.onclick = () => openRow(sessionId);
      head.appendChild(pill);
      asksPill = pill;
    }
    // B2：状态自此【只由药丸表达】（修前它靠那颗点的颜色说，同一个视觉信号既是身份又是状态）。
    // 真有人在问你时不印这枚：那枚「它在问你／它等你放行」说的是同一件事的更具体版本，两枚并排
    // 就是把一句话印两遍（§11.15.2 病 3 的同一个模具）。判据仍然只有 asksYou 那一个，零新增字面量。
    if (!asksPill) head.appendChild(statePill(threadState));
    // B4：标题右侧只留「最后动静」—— 钱与验收线搬去了卡尾，不再与线程名争重心。
    // W4b：只印相对时间本身（「刚刚」「3 分钟前」，与焦点卡同一句），整话「最后动静：…」退到悬停。
    const ago = railAgoLabel(row.updatedAt);
    if (ago) {
      const meta = el('span', 'steward-board-meta', ago);
      meta.title = t('stewardShell.board.updated', { elapsed: ago });
      head.appendChild(meta);
    }
    item.appendChild(head);

    // §2.3「第二行只在有话可说时出现」：在跑＝正在调什么（读 row.liveTail，K2b 已让它实时）、
    // 等你＝问句前 22 字、排队＝等待原因、收工【不印】（药丸已经说了）。
    // 每一格都是【只读】行上已有的事实：liveTail（13e 叠加层）／asksYou.text（06i 单点）／
    // wait.label（116h 单点）—— 本模块不生产任何一句新事实。
    const sub = railSubLine(row, threadState);
    if (sub) item.appendChild(el('p', 'steward-board-sub', sub));

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
    // 二选一由 run-state.js 的判据说（与 2.0 的 run 卡同一份）：'pause' | 'resume' | 都不出。
    const controlAction = runControlAction(lastRun);
    if (controlAction === 'pause') {
      actions.appendChild(boardButton(runTextKeys('v3').pause,
        () => runAction(sessionId, String(lastRun.id || ''), 'pause'), { action: 'pause' }, 'pause'));
    }
    if (controlAction === 'resume') {
      actions.appendChild(boardButton(runTextKeys('v3').resume,
        () => runAction(sessionId, String(lastRun.id || ''), 'resume'), { action: 'resume' }, 'resume'));
    }
    actions.appendChild(boardButton('stewardShell.board.prioritize', () => prioritize(sessionId), { action: 'prioritize' }, 'up'));
    // 「停止」这一枚停的是【这条线程】，所以是实心方块；管家本人的停机在头部，那一枚是电源符。
    actions.appendChild(boardButton('stewardShell.board.stop', () => stopThread(sessionId), { action: 'stop' }, 'stop'));
    // 2026-09-24（用户：「有按钮的话默认直接打开工作台里的对应线程」）：菜单里的「打开」＝在工作台
    // 打开这条线程（两视角同义，见 openInWorkbenchRow）。修前它与「在工作台打开」并排：一枚只换右栏
    // 焦点、一枚才真的去工作台，「打开」按下去像没反应。右栏预览由【点行本身】承担，不再占一枚按钮。
    actions.appendChild(boardButton('stewardShell.board.openThread', () => openInWorkbenchRow(sessionId), { action: 'open' }, 'lensWork'));
    // B5：「＋ 线程」从事项头右上角收进卡尾这一排次级动作 —— 它与「停止／优先／打开」同一档，
    // 不该是每张卡右上角唯一一枚常亮的按钮。挂哪一件由 renderMissionGroup 递进来（同一个分组键，
    // 本函数不自己再推一次）；没有事项可挂时落到空串，与空态那枚是同一条路（「另起一件」）。
    actions.appendChild(boardButton('stewardShell.board.newThread', () => newThread(String(options.missionId || '')), { newThread: '1' }));
    // 121-K4：2.0 会话项上那三枚（置顶／重命名／删除）跟着搬到这里 —— 左栏取代了会话列表，
    // 它们是那一栏【唯一】的入口，跟着列表一起消失就是丢功能（§8.3 那条「删掉就丢功能，必须归位」
    // 的同一条纪律）。本模块只画按钮、不动会话：真动作仍住 session-experience.js（patchSession /
    // openRenamePopover / removeSession 三份实现一个字没改），靠 data-session-action 一条委托接线。
    const meta = sessionForRow(row);
    const pinned = Boolean(meta && meta.pinned);
    actions.appendChild(boardButton(pinned ? 'session.unpin' : 'session.pin', () => {},
      { sessionAction: 'pin', sessionId, pinned: pinned ? '1' : '' }, 'pin'));
    actions.appendChild(boardButton('session.rename', () => {}, { sessionAction: 'rename', sessionId }, 'edit'));
    actions.appendChild(boardButton('session.delete', () => {}, { sessionAction: 'delete', sessionId }, 'trash'));
    tail.appendChild(actions);
    item.appendChild(tail);
    // 121 走查1-②：行尾那一枚「⋯」（普通密度唯一的动作入口；看板密度由 CSS 收掉，那里动作已铺开）。
    // 挂在卡头【最后】——「⋯」是这一行的收尾，不该排在名字与药丸中间。
    head.appendChild(moreButton(item, actions));
    return item;
  }

  // ── ② 左栏的行：任务行 ＋ 展开的线程行（§2.3）────────────────────────────────────
  // B1（27 号文 §11.15.2 病 2）的口径搬到左栏【并反过来】：任务是主，线程是展开项。
  //   · 一个任务只有一条线程时【就是一行】—— 不多画任何层级（那一行就是它的线程行）；
  //   · ≥2 条才画任务行（任务名 ＋ 小计数 ＋ 折角 ＋ 聚合药丸 ＋ 来源图形），点开是缩进的线程行。
  // 判据只有一个：这一组里【真拿到了几条线程行】（group.rows）。刻意不用行上的 threadCount ——
  // 那是任务的线程总数，含本次 limit 没取回来的那些，用它当判据会在截断时画出一个点不开的折角。
  function railTaskRow(group, selected) {
    // 色号：**按任务**（121-K6b／§5 落地）。stewardThreadHueFor 那张登记表的键已经从 sessionId
    // 换成 missionId，线程继承任务色 —— 所以这里直接把任务 id 递进去，不再借领头线程的身份问号。
    // K4 在这里留的那段「本刀不改它，归 K6」的注记到此关闭。
    const item = paintThreadCard(el('li', 'steward-board-thread rail-task'),
      String((group.rows[0] || {}).sessionId || group.missionId), String(group.missionId || ''));
    item.dataset.missionId = group.missionId;
    const aggregate = String(group.aggregateState || '');
    if (aggregate) item.dataset.state = aggregate;
    const lead = group.rows[0] || {};
    const open = railTaskOpen(group);
    if (open) item.classList.add('is-open');
    if (group.rows.some(row => String(row.sessionId || '') === String(selected || ''))) item.classList.add('is-sel');
    // 121 走查1-②：整行可点（多线程任务行→展开／收起，§2.3 点击语义第二条 —— 任务不是线程）。
    bindRowClick(item, () => toggleTask(group.missionId, !railTaskOpen(group)));

    const head = el('div', 'steward-board-thread-head');
    head.appendChild(threadDot());
    const title = el('button', 'steward-board-thread-title', group.title);
    title.type = 'button';
    head.title = String(group.title || '');   // 同上：图标栏里悬停色点说得出是哪一件任务
    // 多线程任务行：点它是【展开／收起】（§2.3 点击语义第二条），不是打开某一条 —— 任务不是线程。
    title.onclick = () => toggleTask(group.missionId, !open);
    head.appendChild(title);
    head.appendChild(el('span', 'rail-task-count num', String(group.threadCount || group.rows.length)));
    head.appendChild(statePill(aggregate));
    const mark = originMark(group.origin);
    if (mark) head.appendChild(mark);
    const chev = el('button', 'rail-chev');
    chev.type = 'button';
    chev.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chevLabel = t(open ? 'rail.collapse' : 'rail.expand');
    chev.title = chevLabel;
    chev.setAttribute('aria-label', chevLabel);
    const chevGlyph = icon('caret', 12);
    if (chevGlyph) chev.appendChild(chevGlyph);
    chev.onclick = () => toggleTask(group.missionId, !open);
    head.appendChild(chev);
    item.appendChild(head);

    // 任务行的第二行读【领头那一条】的事实（行序由服务端排好，领头就是最该看的那一条）。
    const sub = railSubLine(lead, aggregate);
    if (sub) item.appendChild(el('p', 'steward-board-sub', sub));

    const tail = el('div', 'steward-board-tail');
    tail.appendChild(missionFacts(group));
    const actions = el('div', 'steward-board-actions');
    // 任务级只有一枚动作：给它加一条兄弟线程（§2.3「给已有任务加兄弟线程走行悬停『＋ 线程』」）。
    // 线程级的暂停／继续／停止／插队／在工作台打开都在线程行上（展开后可见），不在任务行上重画。
    actions.appendChild(boardButton('stewardShell.board.newThread', () => newThread(group.missionId), { newThread: '1' }));
    tail.appendChild(actions);
    item.appendChild(tail);
    // 121 走查1-②：任务行同样只留一枚「⋯」—— 普通密度里那枚「＋ 线程」（§2.3 给已有任务加兄弟
    // 线程的唯一入口）就住在它点开的那份动作表里，不再是常悬的一排。
    head.appendChild(moreButton(item, actions));
    return item;
  }

  // 展开容器：`grid-template-rows: 0fr → 1fr` 的那一层（§2.9 表倒数第二行；内容高度未知也能顺）。
  function railThreadList(group, selected) {
    const wrap = el('div', `rail-threads${railTaskOpen(group) ? ' is-open' : ''}`);
    wrap.dataset.missionId = group.missionId;
    const inner = el('div', 'rail-threads-inner');
    const list = el('ul', 'steward-board-threads');
    for (const row of group.rows) {
      list.appendChild(renderThreadRow(row, {
        missionId: group.missionId,
        selected,
        facts: null,   // 验收 a/b 在任务行上印过了，整件事只印一次
      }));
    }
    inner.appendChild(list);
    wrap.appendChild(inner);
    return wrap;
  }

  // ── ② 左栏正文：五组 ＋ 计数 ＋ 搜索过滤（§2.3）──────────────────────────────────
  // 行序【原样取服务端】：13d 的 D1 已经按「状态优先、其次 updatedAt」排好，左栏、右栏小行与
  // 抽屉页签消费的是同一份序 —— 这里只把任务分进五组、组内按最后动静新的在前，不重排线程。
  // 128f：左栏上一次按哪一条画的选中（null＝还没画过）。syncNow 拿它与焦点对账，见那里的注释。
  let railRenderedSelected = null;
  function renderRail() {
    renderStatusLine();
    renderArbiterFacts();
    syncRailPlus();
    // 128f-⑫ 续：行内菜单开着（或在开的路上）时先不重画这一栏，记一笔；菜单一收就补（见 railInteractionLive 头注）。
    if (railInteractionLive()) { railRenderDeferred = true; return 0; }
    railRenderDeferred = false;
    const host = clear(byId('railList'));
    if (!host) return 0;
    railRenderedSelected = railSelectedId();
    const filter = railFilter();
    const groups = groupRows().filter(group => group.rows.some(row => railRowMatches(row, filter)));
    const railCount = byId('railCount');
    if (railCount) railCount.textContent = groups.length ? String(groups.length) : '';
    if (!groups.length) {
      // 117l-B2 ②（用户第五轮走查 2）：空态是「一句话 ＋ 一个出口」。搜索没命中时说的是另一句
      // （既有键 session.noMatch），不把「还没有任务」这句假话印给一个正在搜索的人。
      const empty = el('div', 'steward-board-empty');
      empty.appendChild(el('p', 'steward-board-empty-say', t(filter ? 'session.noMatch' : 'stewardShell.board.statusEmpty')));
      if (!filter) empty.appendChild(boardButton('stewardShell.board.newThread', () => newThread(''), { newThread: '1' }));
      host.appendChild(empty);
      return 0;
    }
    const selected = railSelectedId();
    const buckets = new Map(RAIL_GROUP_KEYS.map(key => [key, []]));
    const now = new Date();
    for (const group of groups) buckets.get(railGroupFor(group.aggregateState, group.updatedAt, now)).push(group);
    let printed = 0;
    for (const key of RAIL_GROUP_KEYS) {
      const list = buckets.get(key);
      if (!list.length) continue;
      list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const section = el('section', 'rail-group');
      section.dataset.group = key;
      const open = railGroupOpen(key);
      if (!open) section.classList.add('is-collapsed');
      section.appendChild(railGroupHead(key, list.length, open));
      const tasks = el('ul', 'rail-tasks');
      for (const group of list) {
        if (group.rows.length > 1) {
          tasks.appendChild(railTaskRow(group, selected));
          tasks.appendChild(railThreadList(group, selected));
        } else {
          // 单线程任务：那一行【就是】它的线程行（不画任务层）。验收 a/b 落在它的卡尾。
          tasks.appendChild(renderThreadRow(group.rows[0], {
            missionId: group.missionId,
            selected,
            facts: missionFacts(group),
          }));
        }
        printed += 1;
      }
      section.appendChild(tasks);
      host.appendChild(section);
    }
    return printed;
  }

  // ── 行动作（全部经 steward-drawer.js 导出的那一段原语，不复制）─────────────────
  // 128f-⑫（审计 B）：行上的动作动的若是焦点那一条，右栏那一份抽屉要跟着重读 —— syncNow 只在「换焦点」时才让它
  // 重读（focusRequest），焦点没换的话它还拿着动作之前的切片：班组段仍写「在跑」、排队仍是第几、被挡的那一句还在。
  function refreshDrawerIfFocused(...sessionIds) {
    if (!drawer || typeof drawer.refreshOnce !== 'function' || typeof drawer.currentSessionId !== 'function') return false;
    const focus = String(drawer.currentSessionId() || '');
    if (!focus || !sessionIds.map(String).includes(focus)) return false;
    drawer.refreshOnce().catch(() => { /* 一次补读没成不该把左栏打回去，推送与下一拍还会再来 */ });
    return true;
  }
  async function runAction(sessionId, runId, action) {
    const result = await stewardThreadRunAction({ api, sessionId, runId, action });
    if (!result || result.ok !== true) { failNote(result && result.error); return false; }
    note(t(action === 'pause' ? 'stewardShell.board.paused' : 'stewardShell.board.resumed'));
    await refreshBoard();
    refreshDrawerIfFocused(sessionId);
    return true;
  }

  async function stopThread(sessionId) {
    const stopped = await stewardThreadStop({ api, sessionId });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return false; }
    note(t('stewardShell.board.stopped'));
    await refreshBoard();
    refreshDrawerIfFocused(sessionId);
    return true;
  }

  // 116h 登记项①：停在「等你」的线程仍持着 cwd 写锁，会挡住同目录所有线程。看到就能一键停掉它。
  async function stopBlocker(blockedBy) {
    const blocker = rows.find(row => String(row.sessionId) === blockedBy) || null;
    const title = blocker ? String(blocker.title || blockedBy) : blockedBy;
    // 33 号文 §4（M3-a）：原生 confirm 退役 —— 停掉别人正在跑的回合是不可逆动作，确认件必须跟主题、
    // 跟语言、焦点归壳管（原生框三样都不跟）。同步变异步：没得到允许就不动手。
    if (!await confirmDanger({ name: 'stopBlocker', bodyParams: { title } })) return false;
    const stopped = await stewardThreadStop({ api, sessionId: blockedBy });
    if (!stopped || stopped.ok !== true) { failNote(stopped && stopped.error); return false; }
    note(t('stewardShell.board.stopBlockerDone', { title }));
    await refreshBoard();
    refreshDrawerIfFocused(blockedBy, currentFocusId());   // 被挡的那一条（通常就是焦点）写着「被谁挡着」
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
    refreshDrawerIfFocused(sessionId);
    return true;
  }

  // 批量只提供这一项（§8.10）：把每一条【还活着且没暂停】的班组回合逐条暂停。只有在跑的对话回合
  // （没有班组 run）暂停不了 —— 如实报数，不假装批量成功。
  async function pauseAll() {
    const pausable = pausableRunsOf(rows);
    const turnsOnly = rows.filter(row => row.activeTurn === true && !runIsLive(row.lastRun));
    let done = 0;
    for (const row of pausable) {
      const result = await stewardThreadRunAction({ api, sessionId: String(row.sessionId), runId: String(row.lastRun.id || ''), action: 'pause' });
      if (result && result.ok === true) done += 1;
    }
    note(t('stewardShell.board.pauseAllDone', { done, turns: turnsOnly.length }));
    await refreshBoard();
    refreshDrawerIfFocused(...pausable.map(row => String(row.sessionId)));
    return done;
  }

  function newThread(missionId) {
    try {
      doc().dispatchEvent(new CustomEvent(STEWARD_NEW_THREAD_EVENT, { detail: { missionId, fromSessionId: '' } }));
    } catch { /* 无 CustomEvent 的宿主 */ }
    return missionId;
  }

  async function openClassic(sessionId) {
    try { await openClassicWindow(sessionId); } catch (error) { failNote(error); }
    return sessionId;
  }
  // 行菜单里那枚「打开」：管家视角＝切到工作台并选中它（openInWorkbench 那一处实现），工作台视角＝
  // 与点行同一条 openSession。两个视角里「打开这条线程」都只有一个意思 —— 中栏变成它。
  function openInWorkbenchRow(sessionId) {
    const id = String(sessionId || '');
    if (!id) return '';
    if (isStewardMode()) { void openClassic(id); return id; }
    return openRow(id);
  }

  // §2.3 点击语义：打开【这一条线程】。两视角两种「打开」——
  //   管家视角 = 换焦点（右栏那一份抽屉开在它上面，中栏的对话流不动）；
  //   工作台视角 = openSession（中栏真的换成这条线程的对话）。
  // 这是「左栏是同一份 DOM、两视角各自的现场各自保持」那条原则（§2.1 第 11 条）的落点：
  // 本模块不在两视角之间同步选中项，各视角问自己的状态（见 railSelectedId）。
  function openRow(sessionId) {
    const id = String(sessionId || '');
    if (!id) return '';
    if (isStewardMode()) return openThread(id);
    Promise.resolve(openSession(id)).catch(() => { /* 打不开那条会话不该把左栏打回去 */ });
    renderRail();
    return id;
  }

  // 焦点线程：用户显式点过就【钉住】，之后的自动挑选不再把它换掉（换回自动要么关掉这一件、
  // 要么点别的线程）。宽屏常驻时抽屉就是右栏本身（同一个节点），窄屏才退回覆盖式打开。
  // 117s-B（用户第九轮走查①④）：本函数是全模块唯一的「有人【请求】聚焦这条线程」入口（焦点／
  // 打开事件、行标题、行上的「打开」四条路都经它），所以强刷那一刷只挂在这里 —— 判据与理由写在
  // syncNow 的头注里。
  function focusThread(sessionId) {
    pinnedId = String(sessionId || '');
    if (!syncNow({ focusRequest: true }) && drawer && typeof drawer.openThread === 'function') {
      // 2026-09-24：右栏是用户【收起】的 → 不强行展开、也不退回覆盖式抽屉 —— 只让窄条亮一颗点
      // （sideFresh），钉子照记：用户点开窄条时看到的就是这一条。窄屏（<1000）仍走覆盖式打开。
      if (sideCollapsedActive()) { sideFresh = true; renderSideStrip(); }
      else drawer.openThread(pinnedId);
    }
    return pinnedId;
  }
  // 「打开」= 把右栏那一份抽屉钉到这一条上。121-K4：修前它还要把看板浮层收起来（不然浮层盖着
  // 自己要看的东西）与清掉「关掉」偏好，两件事都随浮层右栏退役。
  // 2026-09-24：它是【用户明示要看这一条】的入口（点行、「去处理」、就地回答）—— 右栏收着就为他
  // 打开；管家自己换焦点走的是 focusThread（那一路不展开）。
  function openThread(sessionId) {
    if (sideCollapsedActive()) setSideCollapsed(false, { sync: false });   // 紧接着的 focusThread 会 syncNow
    return focusThread(sessionId);
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

  // ── ③ 管家视角的右栏：焦点那条是同一个抽屉的 docked 挂法，其余叠成小行 ──────────────
  // 121-K4（§2.6／§7.1）：右栏从 ≥1000px 才出现的 fixed 玻璃浮层「现在这几件」改成外框栅格里
  // 【常驻的一列】。随之退役的是那枚「关掉」与它记的本机偏好（wcw.stewardNowClosed）：
  // 常驻栏里没有那枚钮了，再读那个偏好就会让存量用户的右栏永远空着、且没有任何回头路
  // （原来的回头路是行上的「打开」→ setNowClosed(false)）。所以判据收成两条：管家视角 ＋ 够宽。
  function wideEnough() {
    if (!globalThis.matchMedia) return true;
    return globalThis.matchMedia(`(min-width: ${STEWARD_NOW_MIN_WIDTH}px)`).matches;
  }

  // ── 2026-09-24：右栏可收起（用户：「右边的线程永远收不起来」）─────────────────────────────
  // 三态，一处判：hidden（没有可看的：非管家视角／窄屏／没有焦点）· 收起（用户收的，只留 44px 窄条）·
  // 展开。收起是【本机偏好】，活过刷新；但只在窄条成立的那一档（≥1181，见 STEWARD_SIDE_STRIP_MIN_WIDTH）
  // 作数 —— 1000–1180 那一档右栏是顶栏「右栏」钮开合的滑出层，两套开合不叠在一起。
  function readSideCollapsedPref() {
    try { return globalThis.localStorage && globalThis.localStorage.getItem(STEWARD_SIDE_COLLAPSED_KEY) === '1'; }
    catch { return false; }
  }
  function stripAllowed() {
    if (!globalThis.matchMedia) return true;
    return globalThis.matchMedia(`(min-width: ${STEWARD_SIDE_STRIP_MIN_WIDTH}px)`).matches;
  }
  function sideCollapsed() {
    return sideCollapsedPref && stripAllowed();
  }
  // 「此刻右栏是用户收着的」：管家视角 ＋ 够宽 ＋ 偏好为收起。focusThread 与抽屉的事件门都问它。
  function sideCollapsedActive() {
    return isStewardMode() && wideEnough() && sideCollapsed();
  }
  // 唯一写口。展开那一下把「有新动静」的点擦掉；焦点管理：收起后开关钮随栏一起消失，焦点送到窄条上
  // （键盘用户不落到 body）；展开时 syncNow 会把抽屉开回焦点那一条，焦点由抽屉自己接（标题）。
  // sync:false 只给 openThread 用 —— 它紧接着就 focusThread（那一步自己 syncNow），先同步一次会把
  // 抽屉先开在旧焦点上再换成新焦点，闪一下。
  function setSideCollapsed(next, { persist = true, sync = true } = {}) {
    const collapsed = Boolean(next);
    sideCollapsedPref = collapsed;
    if (!collapsed) sideFresh = false;
    if (persist) {
      try { globalThis.localStorage && globalThis.localStorage.setItem(STEWARD_SIDE_COLLAPSED_KEY, collapsed ? '1' : '0'); }
      catch { /* 本机偏好不可用：这一程照样生效 */ }
    }
    if (!sync) return collapsed;
    const shown = syncNow({ focusRequest: !collapsed });
    if (collapsed) {
      const strip = byId('stewardSideStrip');
      if (strip && !strip.hidden && typeof strip.focus === 'function') strip.focus();
    } else if (!shown) {
      const toggle = byId('stewardSideToggleBtn');
      if (toggle && typeof toggle.focus === 'function') toggle.focus();
    }
    return collapsed;
  }
  // 窄条：一枚字形 ＋「N 在跑」「M 等你」两枚徽标（只在 >0 时出现）＋ 收起期间有新焦点时的一颗点。
  // 整条就是一枚按钮（点开＝展开），可访问名把数也念出来。签名没变就不重画（它每一拍都会被调到）。
  let sideStripSignature = '';
  function renderSideStrip() {
    const strip = byId('stewardSideStrip');
    const toggle = byId('stewardSideToggleBtn');
    const collapsed = sideCollapsed();
    if (toggle) {
      const label = t(collapsed ? 'stewardShell.side.expand' : 'stewardShell.side.collapse');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
    }
    if (!strip) return '';
    const parts = [];
    if (sideCounts.running > 0) parts.push(t('rail.chip.running', { n: sideCounts.running }));
    if (sideCounts.needsYou > 0) parts.push(t('rail.chip.needsYou', { n: sideCounts.needsYou }));
    if (sideFresh) parts.push(t('stewardShell.side.fresh'));
    const label = [t('stewardShell.side.expand'), ...parts].join(' · ');
    strip.title = label;
    strip.setAttribute('aria-label', label);
    strip.dataset.fresh = sideFresh ? '1' : '';
    const signature = JSON.stringify([sideCounts.running, sideCounts.needsYou, sideFresh]);
    if (signature === sideStripSignature) return label;
    sideStripSignature = signature;
    clear(strip);
    const glyph = icon('panelRight', 15);
    if (glyph) strip.appendChild(glyph);
    // 徽标的色档名沿用顶栏胶囊那两颗点的叫法（run／you，renderGlobalChip）：它们是【计数】的两档色，
    // 不是五态字面量 —— 本模块的五态字面量账（B5／M6／N3 锁）一个字不加。
    if (sideCounts.running > 0) {
      const badge = el('span', 'steward-side-strip-badge num', String(sideCounts.running));
      badge.dataset.tone = 'run';
      badge.setAttribute('aria-hidden', 'true');
      strip.appendChild(badge);
    }
    if (sideCounts.needsYou > 0) {
      const badge = el('span', 'steward-side-strip-badge num', String(sideCounts.needsYou));
      badge.dataset.tone = 'you';
      badge.setAttribute('aria-hidden', 'true');
      strip.appendChild(badge);
    }
    if (sideFresh) {
      const dot = el('span', 'steward-side-strip-new');
      dot.setAttribute('aria-hidden', 'true');
      strip.appendChild(dot);
    }
    return label;
  }

  // ── F3：右栏那两条「小行叠」──────────────────────────────────────────────────────
  // 容器按需建、始终夹着抽屉那一份。搬的永远只有【自己的】这两个节点：抽屉是 setMount('docked')
  // 挂进 #stewardFocus 的，本模块一次都不碰它（E 组纪律：一份实现、两种挂法）。
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
    const body = byId('stewardFocus');
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

  // 121-K4：右栏头上那个「N 条线程」的数随 .steward-now-bar 一起退役 —— 常驻右栏没有标题条，
  // 而那个数在顶栏的全局状态胶囊与左栏组头里已经各有一处（同一件事不印三遍）。焦点栏的头
  // 怎么写归 K6。

  // 重画判据：行的「身份／五态／名字／那一句」有一处变了才重画 —— 否则用户正按着某一行时，
  // 每一拍都会把它连根拔掉（chip 菜单那条 304 纪律的同一条道理）。
  // 121-K6b（34 号文 §2.6「其它在途：其余【非收工】线程的最紧密度行」）：焦点栏下面那一叠只留
  // 还在路上的线程。判据【不新增】—— 复用 paintDot 那四档 tone（dockToneForMissionState 一处算），
  // settled/quiet 两档就是「这件事此刻没在动」，与左栏「今天收工／更早」两组同一条界线。
  // 收工的线程没有消失：它们在左栏里，点一下就换成焦点。
  function inFlight(row) {
    const tone = toneOf(threadStateOf(row));
    return tone === 'attention' || tone === 'active';
  }

  let nowSignature = '';
  function renderNow(focusId) {
    const now = byId('stewardSide');
    if (!now) return 0;
    const before = nowStack('before');
    const after = nowStack('after');
    placeNowStacks(before, after);
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
      if (!inFlight(row)) return;   // 121-K6b：「其它【在途】」——收工的不占焦点栏（§2.6）
      (index >= 0 && at < index ? before : after).appendChild(renderNowThread(row));
    });
    return rows.length;
  }

  // 右栏收起时把小行也清掉（藏着的那一份不留旧行；抽屉那一份由 syncNow 自己 closeDrawer）。
  function clearNow() {
    const now = byId('stewardSide');
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
    const now = byId('stewardSide');
    if (!now || !drawer) return false;
    const focusId = currentFocusId();
    // 128f（b0f4b63 全量 walkthrough-round1 C2 查出，两次都红）：管家视角左栏的选中（.is-sel）＝焦点，而左栏只在【行变了】
    // 才重画 —— 点一行（focusThread）、进管家视角，焦点都换了、右栏跟着换了，左栏的高亮却停在上一次画的那一条（或一条都没有）。
    // 修前这件事靠「进管家视角后第一发取行恰好是 200」蒙着：在场一变 ETag 就变、那一发重画了左栏；在场回执那一发先把
    // 这个变化取走之后，后面都是 304，洞就露出来了。本函数是焦点落地的唯一一处，所以在这里对账：焦点与左栏上次画的选中
    // 不一样就重画左栏（工作台视角那一侧 openRow 本来就会重画）。
    if (isStewardMode() && railRenderedSelected !== null && focusId !== railRenderedSelected) renderRail();
    // 2026-09-24：三态。「有可看的」（管家视角 ＋ 够宽 ＋ 有焦点）之上再问一次用户偏好 ——
    // 收起时那一栏不 hidden（窄条要在），但抽屉那一份照「没接住」处理：关掉 docked、回 overlay 挂法，
    // 表也随之停（抽屉零后台活动的纪律不因为藏在 44px 后面就破例）。
    const canShow = isStewardMode() && wideEnough() && Boolean(focusId);
    const collapsed = canShow && sideCollapsed();
    const show = canShow && !collapsed;
    now.hidden = !canShow;
    if (collapsed) now.dataset.collapsed = '1'; else delete now.dataset.collapsed;
    const strip = byId('stewardSideStrip');
    if (strip) strip.hidden = !collapsed;
    renderSideStrip();
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

  // 组合根这一侧（工作台开／建／改名／删会话）重画左栏的口：先按手上的行画出来（立刻有反馈），
  // 在工作台视角再补一发 ETag 化的 /api/missions —— 那一侧没有兜底计时器（syncPolling 只在管家
  // 视角起表），用户的这一次动作就是行最该被复核的时刻。304 时 loadMissions 直接返回、不重画。
  // 128f-⑫：修前这里是 `if (!isStewardMode())` —— 理由是「管家视角有兜底计时器」。可那一拍是 15 s（配置默认），
  // 于是在管家视角里删掉一条线程，行要等十几秒、或者用户随手点了别处（换焦点那一刷）才消失（用户 2026-09-19 原话）。
  // 用户动作之后复核一次行，两个视角都要。304 时照旧不重画。
  function syncRail() {
    renderRail();
    void pushRefreshRows();
    return true;
  }

  // 抽屉那一份被就地关掉（×／Esc／「交回管家」）时：不再「把右栏收起来并记住」（那枚「关掉」
  // 与它的本机偏好随 #stewardNow 一起退役），只把用户钉的焦点松开，让焦点回到自动挑选。
  function closeNow() {
    // 121-K4-3（§2.7 第三条）：只有【在管家视角里】就地关掉焦点栏才算用户「松开这一钉」。
    // 出视角那一下也会走到这里 —— 抽屉自己的 data-shell-mode 观察者在离开管家视角时
    // closeDrawer()（steward-drawer.js:1413），而它那一关是 docked 的，于是 setOnClosed 那条
    // 回调照样落到本函数上（syncNow 里的 suppressCloseRecord 只压得住本模块自己关的那一次）。
    // 那不是用户在说「我不看这一条了」，所以不清钉子。判据用现成的 isStewardMode()，不加状态。
    // 本件 K6 第一轮红的真正病根就在这里（leaveSteward 里那句 pinnedId = '' 只是它的同伙）。
    if (!isStewardMode()) { syncNow(); return false; }
    // 2026-09-24（用户：「右边的线程永远收不起来」）：Esc／×／「交回管家」在常驻栏上＝【把右栏收起】
    // （记本机偏好，syncNow 不会再按自动挑选把它顶回来）。修前这里只松开钉子、随即被自动挑选
    // 换成另一条重新停靠 —— 用户看到的就是「关不掉」。窄条不成立的那一档（1000–1180 的抽屉带）
    // 保留旧语义：松开钉子，焦点回落自动挑选。
    if (stripAllowed()) { setSideCollapsed(true); return true; }
    pinnedId = '';
    syncNow();
    return true;
  }

  // ── 121-K4：看板开关（setBoardOpen／isBoardOpen）随浮层退役 ─────────────────────
  // 左栏常开，没有「开合」这回事了；那条 aria-expanded／aria-controls 的开关语义也一起收掉
  // （一行状态改成「滚到那一组」，见 jumpToGroup）。轮询的门控因此少了一个变量：syncPolling
  // 现在只看「管家模式 && 页面可见」，与 121-K2b 删掉「看板关着不刷」那道门是同一个方向。

  // ── 刷新与轮询 ──────────────────────────────────────────────────────────────────
  // 行没变（304）就不重画正文 —— 既省事，也不会在用户正开着某个 chip 菜单时把它连根拔掉。
  async function refreshBoard() {
    lastRefreshAt = Date.now();   // 117j W2-5：手动刷新也重置节拍，不让下一拍紧跟着再拉一次
    const changed = await loadMissions();
    await loadArbiter();
    if (changed) renderRail();
    else { renderStatusLine(); renderArbiterFacts(); }
    syncNow();
    if (changed) { try { onRowsChanged(rows.length); } catch { /* 宿主重画失败不该把看板打回去 */ } }
    return rows.length;
  }

  // 33 号文 §4「抽屉 /api/missions 改经看板 rows」：抽屉要新鲜的那一批时走这里。只刷行，并在行真的
  // 变了时重画本模块自己的正文；不碰仲裁面、不 syncNow —— 那一步见 currentFocusId 变了会去
  // openThread，等于让一次「读行」反过来驱动抽屉自己。行仍然只有 loadMissions 一处取、一处解析。
  async function refreshRows() {
    lastRefreshAt = Date.now();   // 与刷新按钮同一条节拍纪律：刚拉过就别让下一拍紧跟着再拉一次
    const changed = await loadMissions();
    if (changed) renderRail();
    // 128f：推送那一路（pushRefreshRows）只走到这里，修前行变了只重画左栏、不告诉宿主 —— 工作台线程头
    // （管家条三句话、面包屑、五态）读的也是这批行，于是它停在上一份上。与 refreshBoard 同一个出口。
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

  // ── 121-K2b：吃推送（§6.2／§6.3 的 a–e）────────────────────────────────────────
  // 分两类落地，因为两类事实的【权威源】不同：
  //   ① `thread.live` 是纯粹的透传事实（tool／iterations／updatedAt，服务端 04 的累加器原样送来），
  //      就地写进那一行的 liveTail —— 零请求。（左栏第二行把它画出来归 K4；本刀先让数据是新的。）
  //   ② 药丸（五态）**不就地编**：它由 mission-state.js 的 fromCard 从卡片证据派生，全仓只有那一份
  //      判据（steward-board.static B1 钉着）。把推送里的 state 字面量写进行上等于在客户端长出第二份
  //      派生结果，一旦 13r 与 13d 的入参哪天不同步，屏幕上就会有两个互相矛盾的药丸。所以这里做的是
  //      【把那一行重新问一次】：一发 ETag 化的 /api/missions（本机毫秒级），判据仍然只有一份。
  // 合并不用计时器（本模块零 setTimeout，F2 钉着）：在飞时只记一个「还要再来一趟」的位，
  // 与 13r 的 eventStreamEmitThreadState 同一条「串行 + 合并」纪律。
  let streamConnected = false;
  let pushBusy = false;
  let pushAgain = false;
  async function pushRefreshRows() {
    if (pushBusy) { pushAgain = true; return false; }
    pushBusy = true;
    // refreshRows 只刷行；紧跟一口 syncNow 是必需的 —— 焦点那一条（右栅「现在这一件」）由 focusThreadFor
    // 按行算，不跑它的话新起的那条线程永远不会成为焦点，§6.3 的指标 d（焦点栏当前动作行）
    // 就无从发生。轮询那一路（refreshBoard）本来就每一拍都跑 syncNow，这里只是把同一步补齐；
    // 仲裁面（/api/steward/arbiter）故意不跟 —— 推送不该换来第二发请求。
    try { await refreshRows(); syncNow(); } finally { pushBusy = false; }
    if (pushAgain) { pushAgain = false; return pushRefreshRows(); }
    return true;
  }
  function applyLivePush(data) {
    const sid = String((data && data.sessionId) || '');
    const row = sid ? rows.find(item => item && String(item.sessionId || '') === sid) : null;
    if (!row) return false;                       // 还没进过行：交给 thread.state／created 那一路重拉
    // 「这一回合的第一个字」：行上此前没有活文本，现在有了。这一刻右栏那一份抽屉手里的切片
    // 【一定是旧的】—— 它是在 thread.state 那一帧读的，那时回合刚起跑、一个字都还没有，所以它
    // 画的还是上一回合的「它刚说」。补一发 refreshOnce 让它换成「它正在说」（§2.6 在跑那一段的
    // 承诺，也是 §6.3 指标 d）。只在【从无到有】那一次补，不是每条 live 都补 —— thread.live
    // 每 500 ms 一条，每条跟一发请求正是 K2b 明确拒绝的那件事。
    const firstTick = !row.liveTail;
    row.liveTail = {
      tool: String((data && data.tool) || ''),
      updatedAt: String((data && data.updatedAt) || ''),
      iterations: Math.max(0, Number(data && data.iterations) || 0),
    };
    paintRailLive(row);
    if (firstTick && drawer && typeof drawer.refreshOnce === 'function' && currentFocusId() === sid) {
      drawer.refreshOnce().catch(() => { /* 一次补读没成不该把左栏打回去，下一拍还会再判 */ });
    }
    return true;
  }
  // thread.live 每条线程 ~500 ms 一发，而左栏【一直在屏幕上】—— 整栏重画一遍就是一次真实的
  // 重排（十来行 ＋ 每行一套 chip）。121-K4 实测过这个代价：改前每一发 live 都 renderRail()，
  // 两三条线程同时在跑时主线程被排满，右栏那一份抽屉连 3 s 的预算都吃不下
  // （steward-board.e2e R7「推送到了就自己发现」连红两轮）。看板时代没这个问题，是因为那块面板
  // 收着时 display:none，重画不产生布局。
  // 所以这一路【只改那一行的第二行】：一个 textContent，零布局风暴。行还没画出来（比如任务刚
  // 出现在推送里、整栏还没重画过）才回落整栏画一次。
  function paintRailLive(row) {
    const sid = String(row.sessionId || '');
    const host = doc() && doc().querySelector(`#railList .steward-board-thread[data-session-id="${sid}"]`);
    if (!host) { renderRail(); return true; }
    const text = railSubLine(row, threadStateOf(row));
    let line = host.querySelector('.steward-board-sub');
    if (!text) { if (line) line.remove(); return true; }
    if (!line) {
      line = el('p', 'steward-board-sub');
      const head = host.querySelector('.steward-board-thread-head');
      if (head && head.nextSibling) host.insertBefore(line, head.nextSibling);
      else host.appendChild(line);
    } else if (line.textContent !== text) {
      // 137x：换的是【工具名】（比如 file_read 换成 bash），不是「有没有这一行」——那一半已经在
      // railSubLine 里堵住了（在跑期间恒有文本）。直接 textContent 赋值观感生硬，加一次短促的透明度
      // 过渡代替硬切换；行高不受影响，css/views/steward-board.css 的 .steward-board-sub.is-updating。
      line.classList.add('is-updating');
      requestAnimationFrame(() => line.classList.remove('is-updating'));
    }
    line.textContent = text;
    return true;
  }
  function setEventStream(stream) {
    if (!stream || typeof stream.on !== 'function') return false;
    streamConnected = typeof stream.isConnected === 'function' ? stream.isConnected() === true : false;
    stream.on('connection', payload => { streamConnected = Boolean(payload && payload.connected); });
    // 128f-⑫（审计 F）：仲裁面那几个数（并发上限、在跑／排队）只在整份 refreshBoard 时重读 —— 推送那一路故意不跟
    // （见 pushRefreshRows 头注：推送不换第二发请求）。可「设置里改了并发上限」「焦点栏里停掉一条」这两个用户动作之后，
    // 左栏头上的数要等兜底那一拍（推送连着时 30 s）才对。这两处做完各发一帧【页内】广播，这里只重读仲裁面这一发。
    stream.on('steward.arbiter.changed', () => { void loadArbiter().then(() => { renderArbiterFacts(); }); });
    stream.on(EVENT_STREAM_LIVE_EVENT, data => { applyLivePush(data); });
    // 五类「行本身变了」的事件同一条落点。`thread.adopted{by:'user'}`（K3：用户刚按下「交给管家盯」）
    // 也在这里 —— 那一行的 watched 要立刻翻真，不能等兜底那一拍。
    for (const name of EVENT_STREAM_ROW_EVENTS) {
      stream.on(name, () => { void pushRefreshRows(); });
    }
    // 128f（workbench-thread-head E3 的偶发，负载复现取证：服务端那一行 seatedBy 早是 'user'，界面还说「如意盯着这条」）：
    // 行上的 seatedBy 是服务端按【在场】现算的，而在场只在事件流连上那一刻登记（换会话/换视角就是重连，去抖 300 ms）。
    // 在那之前取回来的行（比如刚打开这条线程就按了「交给管家盯」）说的是「没人坐着」，而工作台视角没有兜底节拍、
    // 在场变了服务端也不推 —— 那一句就一直错下去。presence.ack 是服务端「我已经记下你坐在哪」的回执：
    // 收到就补一发 ETag 化的行（在场进了 ETag，没变就是 304）。只管本页自己的在场；别的窗口换座不在此列。
    stream.on('presence.ack', () => { void pushRefreshRows(); });
    return true;
  }

  // 117j W2-5（用户走查④，与抽屉同一条纪律）：表按下限（5s）走，真要不要拉由这一拍自己判 ——
  // 有线程在跑就每拍都拉（「跑完了」最多 5 秒就出现在看板与「现在这一件」上），空闲时仍按配置节拍。
  // 不动态换表的理由同抽屉：F1/F3 锁死了本模块只有一处 setInterval 与那一个 syncPolling 形状。
  let lastRefreshAt = 0;
  function anyThreadRunning() {
    return rows.some(row => row && row.activeTurn === true);
  }
  // 121-K2b（§6.2「三条轮询保留为兜底」）：事件流连着时这一拍不再是「怎么发现事情变了」的路 ——
  // 行的变化由 thread.* 推送当场落地（见 bindEventStream），所以 due 统一 30 s，只当兜底心跳；
  // 断开时立刻回到今天那两档（有线程在跑 5 s，空闲 config.stewardPollMs）。表一个字没动（F1/F3）。
  async function pollTick() {
    const due = streamConnected ? STEWARD_POLL_MS_CONNECTED : (anyThreadRunning() ? STEWARD_BOARD_POLL_MS_MIN : pollIntervalMs());
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
  // 唯一入口：还在管家模式 且 页面可见 —— 任一为否立刻停表（零后台活动）。
  // 121-K2b（§6.2）：「看板关着不刷」那道门【删掉】了。它本来的道理是「看不见就别烧请求」，
  // 代价写在 32 号文 §5：看板一关，状态行那句「N 个事项 · A 条在跑，B 条等你」与「现在这一件」
  // 就停在关上的那一帧（两者都【一直可见】，不随看板收起）。K4 之后左栏永远开着，这道门连
  // 「看不见」这个前提都不成立了。烧的请求也回不来：连接正常时这一拍 30 s 才拉一次（pollTick）。
  function syncPolling() {
    if (isStewardMode() && !(doc() && doc().hidden)) startPolling();
    else stopPolling();
  }

  // 切到工作台视角：右栏收起、焦点松开、计时器清干净。
  // 121-K4：左栏【不清】—— 它是两视角共用的同一份 DOM，切过去之后要立刻按工作台的口径重画
  // （「＋」的字变成「新线程」、选中项从焦点线程换成当前会话）。行数据在这一侧由推送与
  // session-experience 的动作（开／建／改名／删）驱动，见 setEventStream 与 renderRail 的头注。
  function leaveSteward() {
    // 121-K4-3（§2.7 第三条「每个视角记住自己的现场 —— 管家：焦点线程、滚动」）：出管家视角
    // 【不再】把用户钉的焦点松开。修前这里第一行是 `pinnedId = ''`，于是「切到工作台看一眼再
    // 切回来」焦点会跳到自动挑选的那一条（本件 K6 第一轮实测：钉着 A，回来成了 B）——
    // 那正是 §2.7 要消掉的行为：两个视角各记自己的现场，互不清空。
    // 钉子该松开的两种情形各自已有归口，不在这里：用户就地关掉焦点栏走 closeNow()（那是显式的
    // 「松开」），而行里再也找不到它时 currentFocusId() 自己回落到自动挑选。
    syncNow();      // 仍要跑：show 的第一个条件就是 isStewardMode()，所以这一下把右栏收起
    stopPolling();
    renderRail();
    return true;
  }

  function bindStewardBoard() {
    // 一行状态：121-K4 起它不再是「点开即看板」的开关，而是「把左栏滚到最需要你的那一组」
    // （与顶栏那枚全局状态胶囊同一个去处）。
    const line = byId('stewardStatusLine');
    if (line) line.onclick = () => { jumpToGroup(''); };
    const chip = byId('appStatusChip');
    if (chip) chip.onclick = () => { jumpToGroup(''); };
    // 117m-A2：「N 条等你」的去处（恰好 1 条直接开那条线程，多于 1 条滚到「等你」那一组）。
    const needsYouGo = byId('stewardStatusNeedsYouBtn');
    if (needsYouGo) { needsYouGo.hidden = true; needsYouGo.onclick = () => { goToNeedsYou(); }; }
    const max = byId('stewardBoardMax');
    if (max) max.onchange = () => { void saveMaxParallel(max.value); };
    const pause = byId('stewardBoardPauseAllBtn');
    if (pause) pause.onclick = () => { void pauseAll(); };
    // 搜索（Ctrl+K）：框是 2.0 那一个，去抖与后端内容搜索仍住 session-experience.js；
    // 这里只在它变的时候把左栏重画一遍（过滤判据在 railFilter 一处）。
    const search = byId('sessionSearch');
    if (search) search.addEventListener('input', () => { renderRail(); });

    if (drawer && typeof drawer.setOnClosed === 'function') {
      // 关掉 docked 那一份（×／Esc／「交回管家」）＝ 松开用户钉的焦点（见 closeNow 的头注）。
      drawer.setOnClosed(mount => { if (mount === 'docked' && !suppressCloseRecord) closeNow(); });
    }
    if (drawer && typeof drawer.setOpenGate === 'function') {
      // 2026-09-24：右栏被用户收着时，抽屉自己那两条事件路（steward:open-thread／focus-thread）不许把
      // 它以覆盖式开出来 —— 那正是「收不起来」的另一半。判据只有 sideCollapsedActive 一处。
      drawer.setOpenGate(() => !sideCollapsedActive());
    }
    // 右栏自己的开关：展开态是栏头那枚钮，收起态整条窄条就是一枚钮。两个都只调唯一那个写口。
    const sideToggle = byId('stewardSideToggleBtn');
    if (sideToggle) sideToggle.onclick = () => { setSideCollapsed(!sideCollapsedPref); };
    const sideStrip = byId('stewardSideStrip');
    if (sideStrip) sideStrip.onclick = () => { setSideCollapsed(false); };
    if (drawer && typeof drawer.setMissionRows === 'function') {
      // 33 号文 §4：抽屉的事项行不再由它自己拉 —— 行是本模块取回来的，读快照与「刷一趟」都从这里
      // 出去（与上面 setOnClosed 同一条迟绑定纪律，不动被静态锁钉住的构造行）。
      drawer.setMissionRows({ rows: () => rows, refresh: refreshRows });
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
      document_.addEventListener('visibilitychange', () => {
        syncPolling();
        if (isStewardMode() && !document_.hidden) void refreshBoard();
      });
    }
    if (globalThis.MutationObserver && document_ && document_.documentElement) {
      // 121-K4-3：先【同步】按新视角把左栏重画一遍，再去走各视角自己那套异步。
      // 为什么必须同步：左栏里有三样东西是【按视角】变的 —— 「＋」的两义（新任务／新线程）、
      // 选中态（管家＝焦点线程，工作台＝当前会话）、行的点击语义。切到管家那一路原来只有
      // enterSteward()，而它第一件事是 await refreshBoard()（一发 GET /api/missions）——于是
      // 切过去那一瞬间左栏还写着「新线程」，要等一次网络往返才改口（本件 H0 第一轮实测到的就是
      // 这一帧）。出壳那一路 leaveSteward() 里本来就有 renderRail，这里多跑一次是幂等的
      // （纯重画，零请求）；放在前面是为了让两条路的【第一帧】都已经是对的。
      new MutationObserver(() => {
        renderRail();
        if (isStewardMode()) void enterSteward(); else leaveSteward();
      }).observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    if (globalThis.matchMedia) {
      try { globalThis.matchMedia(`(min-width: ${STEWARD_NOW_MIN_WIDTH}px)`).addEventListener('change', () => syncNow()); }
      catch { /* 老浏览器没有 addEventListener on MediaQueryList */ }
      // 收起偏好只在窄条成立的那一档作数：跨过 1181 那条线时重判一次（进抽屉带＝按展开画；回来＝照偏好收）。
      try { globalThis.matchMedia(`(min-width: ${STEWARD_SIDE_STRIP_MIN_WIDTH}px)`).addEventListener('change', () => syncNow()); }
      catch { /* 同上 */ }
    }
    // 进管家视角：刷行＋仲裁面并起表（enterSteward）。
    // 121-K4：**工作台视角也要刷一次行** —— 左栏是两视角共用的同一份 DOM，行是它的全部内容；
    // 不刷的话在工作台直接刷新页面会看到一条空的左栏（第一版实测就是这样）。只取这一次、不起表：
    // 之后的新鲜度由推送（thread.* 五类）与用户动作（开／建／改名／删 → syncRail）给。
    if (isStewardMode()) void enterSteward();
    else void refreshRows();
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
    setEventStream, // 121-K2b：组合根那一条推送（迟绑定，与 setOnClosed／setMissionRows 同纪律）
    // 121-K4：左栏是两视角共用的那一份 DOM，所以「重画左栏」要能从组合根这一侧叫得动
    // （工作台开／建／改名／删会话之后，session-experience 只调这一个口，不自己画行）。
    syncRail,
    renderRail,
    refreshBoard,
    enterSteward,
    closeNow,
    syncNow,
    // 2026-09-24：右栏收起／展开的唯一写口与只读判据（真夹具与组合根都不必碰 localStorage 或 DOM 属性）。
    setSideCollapsed,
    isSideCollapsed: () => sideCollapsed(),
    // 117g：返回带要显示「事项名」，读的是本模块已经取回来的那一份行（不另发请求、不另存一份）。
    // 121-K5：返回带退役，接手的是工作台线程头 —— 它要的不止事项名（还有线程数、来源、管家盯
    // 没盯、谁坐着），所以这个只读句柄整行奉上。仍然是【同一份行】：线程头因此零取数。
    missionRowFor: sessionId => rows.find(item => String(item.sessionId) === String(sessionId)) || null,
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
