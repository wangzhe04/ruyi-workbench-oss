'use strict';

import { authHeaders, readNdjsonStream } from './net.js';
import { apiErrorInfo } from './net.js';   // 117 走查：解开 api() 抛出的 JSON 信封（单独一行，J2 锁钉住上一行原样）
// 117j copy-P1-1：工具的人话表。前端【只有这一份】（行动流水与 ※ 浮层共用）。117n-M1 重钉：
// 原来从 steward-settings.js 复用，现在改从 steward-chips.js（它是本波把这张纯常量表搬去的
// 零 import 叶子）——settings.js 接下来要反过来 import 本文件的 stewardErrorText 等函数，
// 不先切断「conversation → settings」这条边就会造出循环 import。表本身一个字没变。
import { STEWARD_TOOL_LABEL_KEYS, stewardSayFromPartial } from './steward-chips.js';
// 117n-M1：DOM 基础件 doc/byId/el/button 也从 steward-chips.js 复用（六个消费方零本地重复定义）。
import { stewardEscapeStack, doc, byId, el, button, writeNote } from './steward-chips.js';   // 117j UX-F4：※ 浮层与头像菜单进 Esc 栈；33 号文 §4：note 写手也只有那一条
// 32 号文 §4（M2）：※ 浮层与头像菜单的开合（Esc／点外／焦点归还锚点／同一时刻只允许一个浮层）交给
// 两壳共用的浮层原语。它住在 js/popover.js，本模块只取那一套【开合】，把 3.0 自己的 .steward-why-pop
// 与 .steward-menu 经 opts.layer 交给它 —— 容器、类名、role、[hidden] 与挂点一个字不改。
import { popover, closePopover, popoverAnchor } from './popover.js';
// F5b 撤回三态：到期那枚「⇄」与落定那枚「✓」都从【全仓唯一那张】图标词汇表取。F5a 立的规矩是
// 「SVG 路径只许住在 icons.js」——所以本文件一条 path 都不写，只按名字取件（steward-board /
// steward-drawer / steward-settings 三个消费方走的也是这条 import，不是第二份路径常量）。
import { icon } from './icons.js';
// 33 号文 §4：stewardShortTitle 与 STEWARD_TITLE_MAX 搬去 util.js（无状态格式化叶子）—— 两个壳
// 共用同一份截短口径，且 2.0 侧不必为了一个纯字符串函数 import 本模块（1481 行）。函数体逐字未改。
import { stewardShortTitle, chatProviders } from './util.js';   // chatProviders:兜底取端点时不把只做语音的服务商当对话端点
// 121-K6b（34 号文 §13.3 ①）：新任务的验收里程碑生产者。全仓只有这一份（thread-facts.js 是纯函数
// 叶子，零 DOM 零 fetch），本文件只在「这一回合真开出了一条新线程」那一刻调它一次。
import { dispatchAcceptanceMilestones, focusThreadFor } from './thread-facts.js';   // 124 还债④：焦点线程的判据与看板同一份（§8.5 ④）
// 107-S1 ④（46 号文 §5 ⑦b H1）：管家给的 confirm 族按钮（改设置／改技能／给线程开桌面）在 POST 之前
// 必须先得到用户明确的「是」。确认件走全仓那一份 confirmDanger（背影／Tab 焦点陷阱／焦点归还／Esc／
// 点背影都在它里面，33 号文 §4 的「四套收一套」），本文件不自己搭第二个模态。
import { confirmDanger } from './confirm-panel.js';

// 第117波 117c：管家对话区（27 号文 §8.4「话＋一行按钮」／§8.9「空状态与首次／每次打开」）。
//
// 这一层只有两种气泡：用户的话、管家的话。**没有卡片盒子**——依据、影响范围、来源全部收进句尾的
// 「※」浮层；默认不展示思维链与工具调用（头像菜单里的「细节」开关才展开本回合工具轨迹，状态记在
// 本机 localStorage，不同步服务端）。管家的话后面【可选】跟一行按钮（≤3 个，主动作只有一个）。
//
// 边界：
//   · 零 innerHTML／insertAdjacentHTML／document.write —— 全部 createElement + textContent；
//   · 后端零改动。到访、历史、递话、撤回全部走 116 已有的路由（/api/steward/{visit,message,act}、
//     /api/sessions/steward、/api/stop、/api/session/rewind）；
//   · 界面不出现「速问」「不立单」「已切到档位」这类系统标签（§8.1 原则 7，静态锁看住）；
//   · 本模块只在管家模式下活动：唯一的后台活动是本模块自己的撤回倒计时（一处 setInterval，见
//     startUndoCountdown/stopUndoCountdown），它只在【一次真实递话之后】起，10 秒到点自己清干净，
//     离开管家壳时 resetConversation() 也会清。117b 的 steward-shell.js 因此仍然「全文件恰好一处
//     setInterval」（C2a 原样通过）。
//
// 为什么 fetch 直调而不是注入的 api()：/api/steward/message 回的是 NDJSON 流（与 /api/chat/stream
// 同形），api() 一次性 res.json() 吃不下流。读流骨架（decoder + 按行切 + 末尾残行补发）自 33 号文 §4
// 起与 2.0 同宗同源：唯一一份在 net.js 的 readNdjsonStream（这里 import 它，不再「照抄」一份）。
// 鉴权头同样复用 net.js 的 authHeaders()，不另起一套 token 读取。

// §8.4 纪律原为「一次回合按钮 ≤3 个」；121-K6b 按 34 号文 §2.4 的【文字预算】收到 2
// （「按钮 ≤2（主动作金色）」）。收的是**渲染层**：提示词层不动，后端照旧可以给三枚，
// 多出来的那一枚在这里被切掉（renderActs 的 slice 是唯一的执行点）。
export const STEWARD_ACTS_MAX = 2;
// 117l D3（用户第四轮走查⑥「要能让用户连续发消息」）：管家在跑时用户还能接着说，第二句立刻上屏、
// 标「排队中」、按序发。上限 5 条 —— 再多就不是「连着说两句」而是刷屏，超了在输入框旁如实说一句。
export const STEWARD_SEND_QUEUE_MAX = 5;
export const STEWARD_UNDO_WINDOW_MS = 10000;             // §8.12 第 3 条：10 秒撤回窄窗
// F5b（32 号文 §2.2.2，用户对着「每秒把整段文字换成『撤回 9』『撤回 8』」确认了「对，就是这个」）：
// 剩余时间改画成一圈环，**文字恒是「撤回」**。计时器每秒只写这一个自定义属性（0–1 的比例），
// 环怎么画全在 CSS 里 —— 一个字都不重写，按钮宽度因此不跳。名字在 JS 与 CSS 各出现一次，
// 这里导出成常量，静态锁钉「两边是同一个名字」。
export const STEWARD_UNDO_RING_PROP = '--steward-undo-left';
// §8.9 原为「你不在的时候」要点 ≤5 条；121-K6b 按 §2.4 文字预算收到 3 条、每条 ≤20 字。
// 同上：只收渲染层。截断走下面那个纯函数（省略号是给人看的收尾标记，不是数据的一部分）。
export const STEWARD_DIGEST_MAX = 3;
export const STEWARD_DIGEST_ITEM_CHARS = 20;
// 纯函数、零 DOM：≤20 字原样，超了切到 19 字再补一个省略号（总长仍是 20）。
export function stewardDigestItemText(text, max = STEWARD_DIGEST_ITEM_CHARS) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const cap = Math.max(1, Number(max) || STEWARD_DIGEST_ITEM_CHARS);
  return clean.length <= cap ? clean : `${clean.slice(0, cap - 1)}…`;
}
// 122-L1b（36 号文 §2.13，34 号文 §13.14 遗留②）：管家视角的「开始引导」。
// 现状是「首跑那枚『开始引导』只画在工作台空态」，而新装默认落【管家视角】—— 新用户于是只能
// 齿轮 → 帮助 → 重新打开引导才找得到它。这枚 act 的 kind 只在前端流通（后端 13h 不认识它，
// 见 runAct 里那一段头注），文案复用既有的 onboarding.wizard.start，不新起 i18n 键。
export const STEWARD_ONBOARDING_ACT = 'onboarding';
// 「向导还没走完」的判据：只看 config.onboarding 这条记录本身（形状由 01-config 洗净：
// {completedAt, version, skipped}，没走过就是 null）。**不用** onboarding-wizard.js 的
// shouldShowOnboarding —— 那一个还要求「零线程且零工作区」，是给自动弹窗用的更严的门；
// 这里是一枚用户自己点的入口，只要没配完就该在。
export function stewardOnboardingPending(config) {
  const record = config && typeof config === 'object' ? config.onboarding : null;
  if (!record || typeof record !== 'object') return true;
  if (record.completedAt) return false;
  return record.skipped !== true;
}
// 体验走查 #1：管家此刻有没有一个能回话的模型。与服务端 13m stewardResolveRoute 同一判据的前端镜像：
// 显式挑了管家端点 → 它得在（对话）端点列表里；否则跟随主端点 → 主端点得是列表里的一个 OpenAI 兼容端点
// （不是命令行引擎、不是 'claude-cli' 哨兵）。纯函数：没有能用的模型时管家首页换成「先接一个模型」卡、
// 输入框置灰并说明原因 —— 修前能直接发话，第一句就失败，报的还是带配置键名的开发者语言。
export function stewardEngineReady(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const providers = chatProviders(cfg);
  const explicit = String(cfg.stewardProviderId || '').trim();
  if (explicit) return providers.some(p => p && p.id === explicit);
  const active = String(cfg.activeProvider || '').trim();
  return Boolean(active) && active !== 'claude-cli' && providers.some(p => p && p.id === active);
}
export const STEWARD_OPEN_THREAD_EVENT = 'steward:open-thread';   // 117d 抽屉接这一个
export const STEWARD_FOCUS_THREAD_EVENT = 'steward:focus-thread'; // 117h「现在这一件」接这一个
// 121-K4-3（34 号文 §2.4「频道条退役」）：F2 那条「只看 · 全部 · 各条线程 · 管家本人」的 chip 条
// 整段删除 —— 左栏就是索引，频道条是它的第二遍；它的「只看这条」语义由左栏点击换焦点承接
// （§12 末条：不再有第二个过滤器）。随它一起走的两个常量：STEWARD_PICK_CHANNEL_EVENT（它的唯一
// 生产者是 pickChannelTarget）与 STEWARD_CHANNEL_SELF（「管家本人」那一档）。
// 121-K5：输入区那一侧那份同名常量与它的监听器【也已清掉】（§13.7 登记⑧）—— 生产者一个都没有
// 的监听器不是接口，是让后人以为它还在工作的残留。
export const STEWARD_DETAILS_KEY = 'wcw.stewardDetails';
// 117l-B2 ③（用户第五轮走查 3「为啥点 Avatar，显示面板是在最上面」）：头像菜单与头像之间留的空隙，
// 也是「下方还放不放得下」那个判定的余量。一处常量，两处（定位与判定）读同一个数。
export const STEWARD_MENU_GAP = 8;
// 117e：头像菜单里「细节」之后的项（人话键 → 设置页里要滚到的区块）。顺序即菜单顺序。
// 121-K7（34 号文 §2.3 末段／§2.4／§9 K7 验收「头像菜单只剩『细节』『设置』」）：
// 「记得的关于你」与「行动流水」两项【搬进左栏栏底的口袋】（js/rail-pocket.js）—— §2.3 的原话是
// 「这四样今天藏在头像菜单里，用户找不到」。搬走不是删：口袋里那两枚按钮走的是同一个
// openStewardPanel('memory'／'decisions')，一个入口一处，不留第二份。
// 菜单剩下的两项就是「细节」（本模块自己的开关）与这里的「设置」。
export const STEWARD_MENU_SECTIONS = Object.freeze([
  ['stewardShell.menu.settings', ''],
]);
// 主动作的视觉档只有这一个类名，且只有一处字面量 —— §8.4「主动作只有一个（金色或主色），其余安静」
// 的机械保证：想再造一个「重点按钮」就必须先改这一行，静态锁看得见。
export const STEWARD_PRIMARY_CLASS = 'is-primary';
// 117 走查（用户 2026-09-06）：线程标题常常是用户说的一整句话。CSS 的一行省略号只救了按钮的
// 宽度，读屏念的 aria-label 与灰字回执还是整段。这里在【文案层】就截短，界面与读屏一个口径。
// 117j W2-1（用户 2026-09-06 第二轮走查①）：这三个工具【执行成功】就意味着「有一条线程现在该被看见」。
// 只认已执行的 actions，不认降级成按钮的 acts —— 后者还没发生，自动展示会抢在用户的判断前面。
export const STEWARD_THREAD_OPENING_TOOLS = Object.freeze(['steward_thread_new', 'steward_quick_ask', 'steward_thread_continue']);

// 本回合最后一条真开出来的线程 id（一回合最多动 3 条，取最后一条 = 事情发生的顺序里最新的那条）。
// 纯函数、零 DOM —— dev-harness/unit/steward-focus-thread.test.js 直接跑真值表。
export function executedThreadSessionId(actions) {
  let sessionId = '';
  for (const row of (Array.isArray(actions) ? actions : [])) {
    if (!row || !STEWARD_THREAD_OPENING_TOOLS.includes(String(row.tool || ''))) continue;
    const result = row.result;
    // ok !== true 一律不算：失败自不必说，propose_required（降级成按钮）也是「还没开」。
    if (!result || result.ok !== true) continue;
    const id = String(result.sessionId || (row.args && row.args.sessionId) || '');
    if (id) sessionId = id;
  }
  return sessionId;
}

// 117s-C（用户第九轮走查⑦「返回消息没有区分」）：收件箱触发的那条回复要标出【它在说哪条会话】。
// 落盘的 `message.steward.trigger` 只有 'user' / 'inbox' 两个字面量（13p stewardStampReply 盖的章
// 就这一个字段，见交付报告里的「发现」），来源会话的 id 与标题只存在于【那一回合的收件箱消息】里
// ——13p stewardEventLine 写的事件行 `会话「标题」(sess_…)`，随 meta.origin==='inbox' 一起落盘。
// 所以这里从那条消息的正文里【只取】第一条事件的会话身份：正则两支（有标题 / 只有 id），
// 取不到就回 null（宁可不加小头，也不编一个来源出来）。纯函数、零 DOM，静态锁直接跑真值表。
//
// 词统一（2026-09，locale 已把界面上的「线程」改叫「会话」）：两支正则都【同时认】老「线程」与新
// 「会话」。理由不是兼容洁癖 —— 这里是在读【已落盘的历史消息】，那些正文里逐字就是「线程」，只认新
// 词等于把老会话的来源小头静默丢掉（丢的是小头，不报错，所以必须靠这条注释留住原因）。同款先例：
// 下面 stewardTriggerInfo 对 trigger 的老字符串 / 新对象两种形状也是都认。
const STEWARD_INBOX_TITLED_RE = /(?:线程|会话)「([^」\n]{1,200})」\(([A-Za-z0-9_-]{1,64})\)/;
const STEWARD_INBOX_BARE_RE = /(?:线程|会话)\s+([A-Za-z0-9_-]{1,64})/;
export function stewardInboxSource(content) {
  const text = String(content == null ? '' : content);
  const titled = STEWARD_INBOX_TITLED_RE.exec(text);
  if (titled) return { sessionId: titled[2], title: titled[1] };
  const bare = STEWARD_INBOX_BARE_RE.exec(text);
  return bare ? { sessionId: bare[1], title: '' } : null;
}

// 117s-H2：同一条收件箱消息里还写着【第几回合】跑完了（13i stewardNormalizeSessionTurn 的
// payload.summary：「会话第 N 回合跑完了 / 失败」）。交付卡要拿它去 GET /api/sessions/<id> 里
// 挑对那一回合的助手话 —— 取不到就回 0，调用方退到「最后一条助手话」（宁可少一层精确，
// 也不去编一个回合号）。与 stewardInboxSource 分开两支：后者的返回形状被静态锁 O2/O3 逐字钉住。
// 【成对改】：这句摘要的生产者是 13i 的 stewardNormalizeSessionTurn，措辞从「线程第 N 回合」改成
// 「会话第 N 回合」时本条正则必须同刀改（那边改了这边不改 = 静默解析失败，会悄悄退到 0）。同样两支
// 都认：历史消息里落盘的是「线程第 N 回合」。
const STEWARD_INBOX_TURN_RE = /(?:线程|会话)第\s*(\d{1,9})\s*回合/;
export function stewardInboxTurnSeq(content) {
  const found = STEWARD_INBOX_TURN_RE.exec(String(content == null ? '' : content));
  const seq = found ? Number(found[1]) : 0;
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

// 117s-H4：`message.steward.trigger` 有两种形状，两种都要认 ——
//   · 老回合（H4 之前落盘的）：字符串 'user' / 'inbox'，来源线程与回合号都【不在】里面
//     （117s-C 就是因此才去抠中文事件行的）；
//   · 新回合（H4 之后 13h stewardStampReply 盖的）：对象 { kind, sessionId?, title?, turnSeq? }。
// 归一成同一个形状；对象里有 sessionId 就优先用它（回执是第一手，抠行法是回落）。
// 纯函数、零 DOM，静态锁直接跑真值表。
export function stewardTriggerInfo(stamp) {
  const raw = (stamp && typeof stamp === 'object') ? stamp.trigger : null;
  if (raw && typeof raw === 'object') {
    const seq = Number(raw.turnSeq);
    return {
      kind: String(raw.kind || ''),
      sessionId: String(raw.sessionId || ''),
      title: String(raw.title || ''),
      turnSeq: Number.isSafeInteger(seq) && seq > 0 ? seq : 0,
    };
  }
  if (stamp && stamp.trigger === 'inbox') {
    return { kind: 'inbox', sessionId: '', title: '', turnSeq: 0 };
  }
  return { kind: String(raw || ''), sessionId: '', title: '', turnSeq: 0 };
}

// 117v-V4 ③（用户第十轮再追加②「我看里面还参杂了一些线程推进的原文，也不要有」；27 号文
// §11.16.5 追加⑤）：一条助手消息的 `content` 是这一回合【所有】助手文字的拼接 —— 工具调用之间
// 那几句过程叙述（「我先联网核实最新数据」「搜索后端分词太差，我改用脚本直连…」）本来就在里面。
// 要把「交付」从「过程」里分出来【不需要正则、不需要猜哪句像过程】：仓里已经有一份精确的
// 有序叙事账本 —— 第 54 波 EC-D 的 segments（app/src/02c-turn-segments.js，落盘形状
// `{ id, type: 'text' | 'thinking' | 'tool' | … , text }`，每一条落盘的助手消息上都带着它），
// 而前端本来就在拉整份会话（GET /api/sessions/<id> 下发的就是 session.messages）——
// **所以这是纯前端改动：不动后端、不加路由、不多发一发请求。**
//
// 判据（精确，不是启发式）：
//   · 交付原文 ＝ 【最后一个 type:'tool' 段之后】的所有 type:'text' 段拼接；
//   · type:'thinking' 段一律不进交付（那是思考，不是交付）；
//   · 没有 tool 段时 ＝ 全部 text 段拼接。而 content 本来就是全部 assistant_delta 的拼接
//     （02c 的 appendText 把连续同型段合并，text 段的总和逐字就是 content），所以这一档与今天的
//     content 【逐字相等】—— 静态锁把这条等式钉住，谁把拼接口径改歪了当场红。
// 用户抱怨的那几行恰恰是【夹在工具调用之间】的 text 段，按这条判据自然落在「最后一个工具段之前」。
//
// 边界（写死在这里，不许再回落成别的样子）：
//   · segments 缺席／不是数组／是空数组（EC-D 之前落盘的老会话）→ 回落到 content 整段。
//     **绝不许因为拿不到 segments 就返回空** —— 那是把「读不到」演成「它没交付」。
//   · segments 在场、但最后一个工具段之后一个 text 段都没有（回合以工具调用收尾，没写收口的话）
//     → 这一条消息【没有交付原文】，回空串；由 stewardDeliverableFrom 跳过它继续往前找，
//     一条都找不到时调用方画那句「这一次没取到原文」＋「到 2.0 视窗看全文」。这一档【不】回落到
//     content：回落等于把用户刚说「不要有」的那几句过程叙述原样端回去。
// 纯函数、零 DOM、零请求。
export function stewardDeliverableText(message) {
  const content = String((message && message.content) == null ? '' : message.content);
  const segments = (message && Array.isArray(message.segments)) ? message.segments : null;
  if (!segments || !segments.length) return content;   // 老会话：账本缺席就回落整段
  // 117v-V4b（主会话裁决，§11.16.7）：边界从「最后一个 tool 段」扩到「最后一个 tool 或 subagent 段」。
  // V4 严格照原判据只认 tool，并如实把这个缺口登记成债 —— 它做对了（放宽判据是判断题，不该由执行者
  // 顺手改）。裁决理由：**会产生「过程叙述」的活动有两种**，自己调工具、以及派子代理去干；后者同样会
  // 在段与段之间留下「我先派个 agent 去查」这类叙述，而那正是本刀要挡在交付之外的东西。
  // **有意不扩到「所有非 text/thinking 段」**：mission / workflow 这类记账段有可能【尾随】在正文之后，
  // 那样一刀切会把真交付整个切掉、变成一句「这一次没取到原文」—— 把「读得到」演成「没交付」，
  // 比漏掉一句叙述坏得多。宁可判据窄一点、错在少挡，也不错在多挡。
  const ACTIVITY = ['tool', 'subagent'];
  let after = 0;                                       // 最后一个活动段【之后】的下标（没有就是 0）
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] && ACTIVITY.includes(segments[i].type)) after = i + 1;
  }
  let text = '';
  for (let i = after; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment && segment.type === 'text') text += String(segment.text == null ? '' : segment.text);
  }
  return text;
}

// 117s-H2：从 `GET /api/sessions/<id>` 的信封里挑出「这一回合交付的原文」。
// 判据：turnSeq 对得上的【最后一条】助手消息（09-workflow 落盘时每条助手消息都带 turnSeq）；
// 不知道回合号、或那一回合没有非空正文时退到整份会话的最后一条非空助手消息。
// 117v-V4 ③：每一条消息取哪一段文字，交给上面那个 stewardDeliverableText（判据只有那一处）。
// 一条都挑不出来就回 null —— 调用方据此画那句「这次没取到」的兜底，绝不留一个空盒子。
// 纯函数、零 DOM、零请求。
export function stewardDeliverableFrom(session, turnSeq) {
  const messages = (session && Array.isArray(session.messages)) ? session.messages : [];
  const want = Number(turnSeq) > 0 ? Number(turnSeq) : 0;
  let matched = null;
  let last = null;
  for (const message of messages) {
    if (!message || message.role !== 'assistant') continue;
    const text = stewardDeliverableText(message);
    if (!text.trim()) continue;
    const seq = Number(message.turnSeq) > 0 ? Number(message.turnSeq) : 0;
    last = { text, turnSeq: seq };
    if (want && seq === want) matched = last;
  }
  return matched || last;
}

// 交付原文超过这么多行就默认折叠（§11.13.3 H2「超 8 行折叠」）。真实版面若在这之内仍然溢出
// （一段长文本换行成十几行），另有一道实测兜底，见 fillDeliverable。
// F4 曾拿这个阈值也折管家自己那段话；117y-S3 把那一路撤了（用户：「显示完吧」），所以这个常量
// 今天【只服务交付卡】一个调用方 —— 名字里的 DELIVERABLE 现在名副其实。
export const STEWARD_DELIVERABLE_LINES = 8;

// ── F1 线程卡（27 号文 §11.13.1「线程即频道」；设计稿画板「宽屏 · 线程即频道」）────────────
// 连续几条【属于同一条线程】的管家消息合成一张卡：3px 色条 ＋ 一行卡头（线程名 · 五态药丸 ·
// 最后动静 · 模型 · 打开）。管家【本人】说的话（没有来源线程）不进卡、不画色条 —— 色条只表示
// 「这是哪条线程」，不表示状态（27 号文 §11.13 F 追加：两套信号不混用）。
//
// 四色按【首次询问顺序】分配并循环；同一条线程在整页生命期里恒用同一色（stewardThreadHues 那张
// 表只增不清 —— 进壳重画历史时顺序不变，颜色因此也不变）。取值不写在这里：色相/饱和度/明度全是
// steward-conversation.css 里的自定义属性（--thread-hue-1..4 ＋ --thread-sat/--thread-light），
// 本文件只负责把「第几号」写进 data-thread-hue，主题层可以整组覆盖。
export const STEWARD_THREAD_HUES = 4;
export function stewardThreadHue(order) {
  const n = Number(order);
  return (Number.isSafeInteger(n) && n >= 0 ? n % STEWARD_THREAD_HUES : 0) + 1;
}

// 117u-G1（27 号文 §11.15.2 病 1「同一条线程有三副面孔」）：这张【登记表】从
// createStewardConversation 的实例闭包提到模块级。修前它住在闭包里，抽屉与看板根本够不着，于是
// F1 自己立的「同一条线程在所有面恒用同一色」只在对话流与频道条兑现。提上来之后三面调同一个
// 函数、拿同一个号 —— 分配仍按【首次询问顺序】（谁先问谁先占号，不是「谁先在对话流出现」），
// 只增不清，同 id 恒同色。纯登记：不碰 DOM、不写颜色（颜色仍只由样式层那一条 hsl() 算）。
// stewardThreadHue(order) 那个纯函数与 STEWARD_THREAD_HUES 一个字没动，本函数只是给它记住顺序。
// 121-K6b（34 号文 §5「色号按任务」）：这张表的【键从 sessionId 换成 missionId】——「色号按任务
// 分配，线程继承任务色」。单线程任务的 missionId 逐字等于 sessionId（mission-state.js／K3 §4.1 的
// 口径），所以绝大多数行的号一个都没变；多线程任务的两条线程从此同色（靠线程名与色点区分，
// 不靠颜色，§5 原话）。
//   · 号的分配器换成一个显式计数器（原来读 Map.size）—— 下面的归并会删掉临时键，size 会倒退，
//     再拿它当序号就会发出重号。计数器只增不减，发号顺序与修前逐字相同（首次询问顺序）。
//   · 谁来登记「这条线程属于哪个任务」：steward-board.js 那一处 /api/missions 取数（全仓唯一的
//     行主人）。登记之前问到的号按 sessionId 临时发一个，登记那一刻【归并】到任务键上（见
//     stewardRegisterThreadMission），所以「先画后登记」也不会留下两个号。
const stewardThreadHues = new Map();
let stewardHueSeq = 0;
// sessionId -> { missionId, missionTitle, threadCount }。同一张登记表顺带把「任务 › 线程」面包屑
// 要的两件事记住：对话流的卡头够不着 /api/missions（它只读 GET /api/sessions/:id 那个信封），
// 而看板本来就 import 本模块 —— 一份登记，两处消费，不新开第二张表、不反向 import 看板。
const stewardThreadMissions = new Map();

function stewardHueNext() {
  const hue = stewardThreadHue(stewardHueSeq);
  stewardHueSeq += 1;
  return hue;
}

export function stewardThreadMissionOf(sessionId) {
  const id = String(sessionId || '');
  return (id && stewardThreadMissions.get(id)) || null;
}

// 登记一条线程的归属。归并规则（这是「先画后登记」不留双号的全部机关）：
//   ① 任务键已经有号 → 把这条线程临时占的那个号删掉，它此后读任务键；
//   ② 任务键还没有号、线程键有 → 把线程那个号【搬】到任务键上（任务色 = 领头线程色，与 K4 左栏
//      任务行今天的表现逐字一致），再删线程键。
// 两条都只搬不发新号，所以登记本身永远不会让任何一面变色（除了多线程任务的后来者跟上领头色）。
export function stewardRegisterThreadMission(sessionId, info) {
  const id = String(sessionId || '');
  if (!id) return null;
  const missionId = String((info && info.missionId) || '') || id;
  const next = {
    missionId,
    missionTitle: String((info && info.missionTitle) || ''),
    threadCount: Math.max(1, Number(info && info.threadCount) || 1),
  };
  stewardThreadMissions.set(id, next);
  if (missionId !== id && stewardThreadHues.has(id)) {
    if (!stewardThreadHues.has(missionId)) stewardThreadHues.set(missionId, stewardThreadHues.get(id));
    stewardThreadHues.delete(id);
  }
  return next;
}

// 色号：显式传 missionId 的（看板行手上就有）直接用，没传的问登记表，都没有就退回 sessionId
// （单线程任务本来就相等；行还没到的那一帧也只是暂时按自己的 id 发号，登记那一刻归并）。
export function stewardThreadHueFor(sessionId, missionId) {
  const id = String(sessionId || '');
  if (!id) return 0;
  const known = stewardThreadMissionOf(id);
  const key = String(missionId || (known && known.missionId) || '') || id;
  if (!stewardThreadHues.has(key)) stewardThreadHues.set(key, stewardHueNext());
  return stewardThreadHues.get(key);
}

// 卡头上的五态药丸用【全仓既有的那组人话键】，不新开一套词。
// 「排队」在 mission.state.* 里没有对应枚举（五态里没有它），复用管家壳自己那句「排队中」。
// 117u-G1：导出这一份 ＋ 一个纯派生（stewardThreadStateKey），三面共用 —— 本仓已经四次栽在
// 「第二份枚举」上，抽屉要药丸文案就来查这张表，不许自己再抄一张。
export const STEWARD_THREAD_STATE_KEYS = Object.freeze({
  needs_you: 'mission.state.needs_you',
  queued: 'stewardShell.chat.queued',
  running: 'mission.state.running',
  stopped: 'mission.state.stopped',
  done: 'mission.state.done',
});
// 查得到就回那一条键，查不到回空串（调用方据此决定「不出药丸」还是回落到自己的口径）——
// 绝不回一个猜出来的键。纯函数、零 DOM。
export function stewardThreadStateKey(state) {
  const key = String(state == null ? '' : state);
  return Object.prototype.hasOwnProperty.call(STEWARD_THREAD_STATE_KEYS, key) ? STEWARD_THREAD_STATE_KEYS[key] : '';
}

// 卡头要的四件事全部从【已经在取的那个信封】里读：GET /api/sessions/<id>（13d:343 那一条，
// 交付卡 117s-H2 已经在发它了，本刀零新增请求、零新增路由）。判据只取【权威字段】，取不到就
// 不说（§8.1 原则 2 诚实优先）：
//   · 线程名 = 信封上的 displayTitle（02 sessionDisplayTitle 一处判定，前端只读结果）；
//   · 五态   = relay.channel（13h stewardRelayChannelFor，全仓递话唯一那处判定，13d 投影到信封上）
//             ＞ resumable.live（抽屉 isLive() 读的就是它）＞ 会话头的 stewardLastTurn / turnSeq
//             （13d 投影卡片时读的也是这两个）。**这不是 mission-state.js 的五态判据**——那一支要
//             mission 账本与待决计数，只有 /api/missions 的卡片上才有，本模块够不着（J1 只许调
//             116 已有的那几条路由）。所以这里只在信封说得死的那几种情形上说话，其余一律不出药丸。
//   · 最后动静 = 会话头的 updatedAt；· 模型 = 会话头的 engineRoute.model，缺席时回落到最后一条
//     助手消息上的 model（02 inferSessionEngineRoute 用的是同两个来源）。
// 纯函数、零 DOM、零请求。
export function stewardThreadFacts(payload) {
  const envelope = (payload && typeof payload === 'object') ? payload : {};
  const session = (envelope.session && typeof envelope.session === 'object') ? envelope.session : {};
  const relay = (envelope.relay && typeof envelope.relay === 'object') ? envelope.relay : null;
  const channel = relay ? String(relay.channel || '') : '';
  const live = Boolean(envelope.resumable && envelope.resumable.live === true);
  const lastTurn = (session.stewardLastTurn && typeof session.stewardLastTurn === 'object') ? session.stewardLastTurn : null;
  const turnSeq = Number(session.turnSeq) > 0 ? Number(session.turnSeq) : 0;
  let state = '';
  if (channel === 'answer' || channel === 'permission') state = 'needs_you';
  else if (channel === 'queued') state = 'queued';
  else if (live || channel === 'steer') state = 'running';
  else if (lastTurn && lastTurn.ok === false) state = 'stopped';
  else if (turnSeq > 0) state = 'done';
  const route = (session.engineRoute && typeof session.engineRoute === 'object') ? session.engineRoute : null;
  let model = route ? String(route.model || '') : '';
  if (!model) {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0 && !model; i--) {
      const message = messages[i];
      if (message && message.role === 'assistant' && message.model) model = String(message.model);
    }
  }
  return {
    title: String(envelope.displayTitle || ''),
    state,
    stateKey: stewardThreadStateKey(state),
    updatedAt: String(session.updatedAt || ''),
    model,
  };
}

// 「最后动静」= 相对时间。**不自己写一套人话**：只算出 Intl.RelativeTimeFormat 要的
// (value, unit) 两个数，人话交给平台按 documentElement.lang 去说（skills-memory.js:659 用
// Intl.DateTimeFormat 是同一个先例）—— 于是零新增 i18n 键，也不去抄 thread-facts.js 的那一支
// 时长格式化（它出的是【时长】「3m 20s」，不是「3 分钟前」，两码事）。
// 拿不到时间、或时间在未来，一律回 null —— 不猜。纯函数、零 DOM。
export function stewardAgoParts(iso, nowMs) {
  const at = Date.parse(String(iso == null ? '' : iso));
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!Number.isFinite(at) || at > now + 60000) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return { value: -seconds, unit: 'second' };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: -minutes, unit: 'minute' };
  const hours = Math.round(minutes / 60);
  if (hours < 24) return { value: -hours, unit: 'hour' };
  return { value: -Math.round(hours / 24), unit: 'day' };
}

// 117u-G1：把「(value, unit) → 人话」这一步也提到模块级并导出，抽屉的卡头因此与对话流的卡头
// 说【同一句】「3 分钟前」，而不是各自 new 一个 Intl（那就是第二处实现）。算不出来一律回空串，
// 调用方据此整段不说 —— 与 stewardAgoParts 回 null 是同一条纪律。
export function stewardAgoLabel(iso, lang) {
  const parts = stewardAgoParts(iso, Date.now());
  if (!parts) return '';
  try {
    return new Intl.RelativeTimeFormat(String(lang || '') || undefined, { numeric: 'auto' }).format(parts.value, parts.unit);
  } catch { return ''; }   // 没有 Intl.RelativeTimeFormat 的宿主：不说，而不是吐一个英文串
}

// 33 号文 §4：STEWARD_TITLE_MAX / stewardShortTitle 已搬 util.js（无状态格式化叶子），本文件 import 使用。

// 124-P3（40 号文 §2 ③ A01）：**一条 action 的回执是哪一态。** 纯函数、零 DOM、零 i18n ——
// dev-harness/unit/steward-action-receipts.test.js 直接 import 跑真值表。
// 判据只看 `result`，`say` 里那句话一个字都不看（38 号文 §7 ④ 的裁决：下一档不是关键词表，
// 而是让「我做了什么」结构化到 actions 里再判）。第三态是本刀补出来的那一格，见下面调用点的头注。
export const STEWARD_RECEIPT_STATES = Object.freeze(['done', 'failed', 'no_receipt']);
export function stewardActionReceiptState(result) {
  if (result && result.ok === true) return 'done';
  if (result && result.ok === false) return 'failed';
  return 'no_receipt';
}

// 工具稳定信封 → i18n 人话键（§8.4 按钮落定：result.ok===false 时按 result.error 说人话，
// 按钮行保留可重试）。表外的一律落到 errGeneric 并把原始 error 原样带出去（诚实优先）。
const STEWARD_ACT_ERROR_KEYS = Object.freeze({
  invalid_request: 'stewardShell.chat.errInvalidAct',
  not_allowed: 'stewardShell.chat.errUnavailableAct',
  payload_forbidden_key: 'stewardShell.chat.errUnavailableAct',
  propose_required: 'stewardShell.chat.errProposeRequired',
  not_found: 'stewardShell.chat.errNotFound',
  'steward.busy': 'stewardShell.chat.errBusy',
  // 117l-B2 ⑤（A1-fix commit 56f8c2b 给递话加的第五条通道）：目标线程还排在仲裁器队列里
  // （等锁／等预算／等并发位）时递话 → 409 `steward.queued`。它【不是】 steward.busy ——
  // 「忙」是「在跑，这一步插不进去」，「排队」是「还没轮到它开跑」，用户该做的事也不同
  // （前者等它停，后者等它开跑）。表外落到 errGeneric 时用户看到的是后端那句原文，能懂但不成体系。
  'steward.queued': 'stewardShell.chat.errQueued',
  version_conflict: 'stewardShell.chat.errConflict',
});

// 117e 第 0 步（117d 登记项 ②）：后端的失败信封有两种形状 —— 域层的裸串 `error:'not_found'`，
// 和路由层 normalizeApiErrorPayload 归一出来的结构化对象 `error:{code,message,params}`（net.js 抛出的
// Error 也是第三种）。原来这两个函数一律 `String(error)`，结构化那一支于是在界面上显示成
// 「[object Object]」。现在分两条：
//   · stewardErrorCode(error) —— 取【机器码】去查人话表（对象走 code / error，不走 message）；
//   · stewardErrorText(error) —— 取【给人看的那一段】：message ‖ error ‖ code，一层对象再递归一次
//     （`{error:{code,message}}` 这种套娃形状同样能落到 message 上），到底也拿不出字符串就回空串。
// 铁律：任何 error 值进 i18n 之前都必须过这两个之一，全模块零 `String(<error 值>)`（静态锁看住）。
export function stewardErrorCode(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  // 117 走查（用户 2026-09-06）：api() 抛出的 Error 把整个 JSON 信封放在 message 里，此前直接落到
  // 对话流成了「没做成：{ "ok": false, … }」。Error 实例一律先经 net.js 的 apiErrorInfo 解开。
  if (error instanceof Error) return String(apiErrorInfo(error).code || '');
  if (typeof error === 'object') return String(error.code || (typeof error.error === 'string' ? error.error : '') || '');
  return String(error);
}

export function stewardErrorText(error) {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return String(apiErrorInfo(error).message || error.message || '');
  if (typeof error === 'object') {
    const raw = error.message || error.error || error.code;
    if (raw && typeof raw === 'object') return stewardErrorText(raw);
    return raw ? String(raw) : '';
  }
  return String(error);
}

export function stewardActErrorKey(error) {
  return STEWARD_ACT_ERROR_KEYS[stewardErrorCode(error)] || '';
}

// 117l-B2 ⑤：`steward.queued` 那条人话要说清「在等什么」。等待原因由服务端一处算出
// （`wait.label`，与看板行、抽屉、steward_thread_status 逐字同源），这里【只取不编】：
// 结构化信封的三种落点都找一遍（error.params.wait / error.wait / 再套一层的 error.error.*），
// 一个都取不到就回空串，由调用方落到不带括号的那一句 —— 宁可少说一句，不许编一个等待原因出来。
export function stewardQueuedWaitLabel(error) {
  if (error == null) return '';
  const info = (error instanceof Error) ? apiErrorInfo(error) : error;
  if (!info || typeof info !== 'object') return '';
  const nested = (info.error && typeof info.error === 'object') ? info.error : null;
  const wait = (info.params && info.params.wait)
    || info.wait
    || (nested && ((nested.params && nested.params.wait) || nested.wait))
    || null;
  return (wait && typeof wait === 'object' && wait.label) ? String(wait.label) : '';
}

// 稳定码 → 一句人话。除 `steward.queued` 之外都是「查表 + t(key)」；那一条要把 wait.label 插进去，
// 取不到就换成不带括号的那一句。表外一律回空串，由调用方落到 errGeneric（诚实优先：把原始 error
// 原样带出去）。抽屉那一头（POST /api/steward/relay 的 409）读的是同两个键，见 steward-drawer.js。
export function stewardActErrorMessage(error, translate) {
  const say = typeof translate === 'function' ? translate : (key => key);
  const key = stewardActErrorKey(error);
  if (!key) return '';
  if (key !== 'stewardShell.chat.errQueued') return say(key);
  const wait = stewardQueuedWaitLabel(error);
  return wait ? say(key, { wait }) : say('stewardShell.chat.errQueuedPlain');
}

// 流事件里算「在动手」的那几类（presence 的 phase 由它切到 calling_tool，§8.3 working 态）。
const STEWARD_TOOL_EVENT_TYPES = Object.freeze(['tool_use', 'tool_use_update', 'tool_progress', 'tool_result']);

export function createStewardConversation({
  api = async () => null,
  state = null,
  t = key => key,
  presence = null,
  // 117 走查：「改用『某端点』」按钮写 stewardProviderId 走这条注入回调（设置域的 saveConfigPartial），
  // 本模块因此不碰 /api/config（J1 锁：只调 116 已有路由）。缺席时按钮照样出现但会如实报「去设置」。
  setStewardProvider = null,
  isStewardMode = () => false,
  // 117e：头像菜单的「设置／记忆／行动流水」三项。本模块只负责【调用】——切页签、滚动、取数
  // 全在 steward-settings.js 里（对话区不认识设置页的任何 id，也不多一条 /api 路由）。
  openStewardPanel = null,
  // 121-K4（§2.2／§2.4）：头像菜单末项「整体切到 2.0」退役 —— 视角切换只在外框顶栏的分段钮
  // 一处（§2.4 原话「不再有『整体切到 2.0』『经典模式』两个钮」）。注入随之撤掉。
  // 117s-H2：交付卡上的「看全文」——与焦点栏标题旁那一枚走【同一个】入口：
  // openClassicWindow(sessionId)。121-K5：那个入口的正身是 js/shell-mode.js 的 openInWorkbench
  // （切视角 ＋ 打开该会话；117g 的返回标记与返回带整段退役）。抽屉拿到它是 steward-shell.js 的
  // drawer.setClassicWindow 那一行；本模块同样【只负责调用】，自己不 import 那两个模块
  // （不长出第二条切视角通道）。
  // **缺席时**（组合根还没接这根线，或 Node 里 await import 本模块）退到既有的
  // steward:open-thread —— 抽屉／「现在这一件」把那条线程打开，「看全文」就在它的标题旁边。
  openClassicWindow = null,
  // 117s-C（用户第九轮走查⑦「输出要支持 markdown、制图」）：管家的 say 用【全仓唯一】那条
  // markdown＋净化路径渲染 —— chat-render-primitives.js 的 renderMarkdownInto（trusted innerHTML
  // 只住在它里面）＋ highlightIn（代码高亮＋mermaid 懒加载，就是用户说的「制图显示」）。
  // 走【注入】不走 import：本模块因此仍然零 innerHTML、零新增 import（A1/A2 原样通过），
  // 且与经典壳六个消费面拿的是同一份渲染器（同一条净化口径，不长出第二个 markdown 通道）。
  // 缺席时全线回落 textContent —— 静态锁在 Node 里 await import 本模块（无 DOM、无渲染器），
  // 那条路必须照常走得通。
  renderMarkdownInto = null,
  highlightIn = null,
  // 122-L1b（36 号文 §2.13）：首跑向导。**走注入不走 import** —— 全仓唯一那个入口是
  // session-experience.js 的 openOnboardingWizard（工作台空态那枚「开始引导」点的也是它），
  // 由 steward-shell.js 从组合根手里转下来；本模块因此不新增一条 import（A2 锁：本域内相对路径）。
  // 缺席时那枚按钮照样不画（下面 onboardingActs 会一起判），Node 里 await import 本模块不受影响。
  openOnboardingWizard = null,
} = {}) {
  const feedEl = () => byId('stewardFeed');
  const setPresence = patch => { try { presence && presence.set && presence.set(patch); } catch { /* presence 是旁路 */ } };
  // 117n-M1：doc/byId/el/button 从 steward-chips.js import（六个消费方零本地重复定义）。

  // ── 细节开关（头像菜单内；本机偏好，不同步服务端）────────────────────────────
  let detailsOn = false;
  try { detailsOn = localStorage.getItem(STEWARD_DETAILS_KEY) === '1'; } catch { detailsOn = false; }
  function setDetails(on) {
    detailsOn = on === true;
    try { localStorage.setItem(STEWARD_DETAILS_KEY, detailsOn ? '1' : '0'); } catch { /* 本机偏好不可用时只影响本次 */ }
    const feed = feedEl();
    if (feed) for (const node of feed.querySelectorAll('.steward-tools')) node.hidden = !detailsOn;
    return detailsOn;
  }

  // ── 117j W2-3：头像跟着话走（用户 2026-09-06 第二轮走查③，推翻 2026-09-05 §8.x「固定顶部」）──
  // 搬的是【同一个】 #stewardAvatar 节点，不复制 SVG —— 所以 117b 那套 presence 渲染
  // （data-state ＋ .pulse/.shake ＋ aria-live 文字）一个字都不用改，它写的还是同一个元素。
  // 历史管家消息左边留一个静态小圆点：由 CSS 的 .steward-avslot:empty::before 画，零 DOM、零 SVG 复制。
  //
  // **搬走之前必须先送回头部**：feed 一清（clearFeed）或某一行被移除（流失败的两处 removeChild）时，
  // 头像若还在那一行里就会跟着被销毁 —— 之后 byId('stewardAvatar') 恒 null，presence 再也画不出来。
  // 这是本条改动唯一的真陷阱，所以 park 在三个销毁点各调一次。
  function parkAvatar() {
    const avatar = byId('stewardAvatar');
    const header = byId('stewardHeader');
    if (!avatar || !header || avatar.parentNode === header) return false;
    header.insertBefore(avatar, header.firstChild);
    return true;
  }
  function moveAvatarTo(row) {
    const avatar = byId('stewardAvatar');
    if (!avatar || !row) return false;
    const slot = row.querySelector('.steward-avslot');
    if (!slot || avatar.parentNode === slot) return false;
    slot.appendChild(avatar);
    markStale(row);
    return true;
  }

  // 117l-B2 ④（用户第五轮走查 4「Ruyi 说的话…尤其是边边那个点」的后半条）：只有【最新】那一条
  // 管家消息是「现在这一句」，更早的几条是历史。历史行加 .is-stale，样式层把它们那一行按钮降成
  // 幽灵档 —— 行为一个字不改（仍然可点、仍然走同一个 runAct），只是不再和最新一条抢眼。
  // 判据就是「头像在谁那儿」：头像永远被 moveAvatarTo 搬到最新一条管家的话上，所以这里一处维护。
  function markStale(current) {
    const feed = feedEl();
    if (!feed) return 0;
    let count = 0;
    for (const row of feed.querySelectorAll('.steward-msg-ruyi')) {
      const stale = row !== current;
      row.classList.toggle('is-stale', stale);
      if (stale) count += 1;
    }
    return count;
  }

  // ── 气泡 ──────────────────────────────────────────────────────────────────────
  // 117l-B2 ④：把连续同一发言者的行标成一「组」。判据只看【前一行】是谁说的 —— 对话流是追加式
  // 渲染，天然只需要知道前面那一行，不用回头重排整条流。
  //   .is-group-start  这一行是本组第一行（组与组之间留 --sp-3，组内只留 feed 的 --sp-1）
  //   .is-group-end    这一行【目前】是本组最后一行；下一行同角色时由那一行把上一行的这个类摘掉
  // 组的左侧那道淡竖线画在哪几行、哪一组不画（头像所在的最新组），全由样式层按这两个类判，
  // 本函数不掺第三种状态。
  function markGroup(row, kind) {
    const previous = row.previousElementSibling;
    const sameSpeaker = Boolean(previous && previous.classList
      && previous.classList.contains(`steward-msg-${kind}`));
    row.classList.add('is-group-end');
    if (sameSpeaker) previous.classList.remove('is-group-end');
    else row.classList.add('is-group-start');
    return row;
  }

  // 流失败时那一行会被就地移除（本模块有两处）。移掉的永远是【末尾】那一行，所以补一句：把
  // 现在的最后一行重新封成组尾 —— 不补的话上一行会保留「我后面还有同伴」的状态，左侧那道锚线
  // 会往下多探出一个 gap 的空档。
  function resealGroups() {
    const feed = feedEl();
    const last = feed ? feed.lastElementChild : null;
    if (last && last.classList) last.classList.add('is-group-end');
    // F1：线程卡的「这一段到此为止」是同一件事的另一层（色条要不要向下多探一个 gap 靠它判），
    // 所以同一处一起封口 —— 少封这一刀，被移除那一行留下的色条会往下探进空档里。
    if (last && last.classList && last.classList.contains('is-thread')) last.classList.add('is-thread-end');
    return Boolean(last);
  }

  // 117s-C：把【管家的】一句话画进一个节点。有渲染器就走 markdown（标题／粗体／列表／表格／
  // 代码围栏／mermaid 都在这一条路上），没有就 textContent —— 两条路都不在本模块里碰 innerHTML。
  //   · `md` 类名是【经典壳同一套排版规则】（chat-narrative.css 的 .md 一族）：复用规则本体，
  //     而不是把取值抄第二份，这就是 27 号文 §11.13 D5 说的「同源取值」；
  //   · highlight=false 用在流式那一路：say 每来一段就整段重写（renderMarkdown 有 LRU 缓存，
  //     重画便宜），但代码高亮＋mermaid 只在【终态】跑一次，不必每个分片都来一遍。
  // 用户气泡、※ 里的依据与行动行【不】走这里：它们是用户原话与机器回执，被 markdown 吃掉就变形了。
  //   · 117s-H2：交付卡的正文（线程自己产出的那段话）也走这一个口 —— 它同样是模型写的、同样
  //     不可信，必须过【同一条】净化器；本模块因此仍然只有这一处渲染入口，不长出第二套。
  function paintSay(node, text, { highlight = true } = {}) {
    if (!node) return node;
    const say = String(text == null ? '' : text);
    if (typeof renderMarkdownInto !== 'function') { node.textContent = say; return node; }
    try {
      renderMarkdownInto(node, say);
      if (node.classList) node.classList.add('md');
      if (highlight && typeof highlightIn === 'function') highlightIn(node);
    } catch { node.textContent = say; }   // 渲染器抛了也得把话说出来（诚实优先，§8.1 原则 2）
    return node;
  }

  // ── 折叠：一处实现，【只有交付卡一个调用方】（117s-H2）───────────────────────────────
  // 117s-H2 把折叠写在 fillDeliverable/deliverableActs 里；F4 曾把它抽出来给管家正文也用一次，
  // 117y-S3 又把管家正文那一路撤了（用户第十一轮拍板②）。抽出来的这份实现【原样留着】：判据
  // （行数 ＋ 一道实测溢出兜底）、类名（is-clamped）、按钮（.steward-deliverable-more，展开/
  // 收起两句话）全部仍然只有这一处，只是今天只有 fillDeliverable 在调它。
  // 折叠阈值仍是那个常量，样式层的高度仍是那个自定义属性（--steward-clamp-h）。
  function clampIfLong(node, text) {
    if (!node) return false;
    node.classList.add('is-clamped');
    const longEnough = String(text == null ? '' : text).split('\n').length > STEWARD_DELIVERABLE_LINES
      || (Number(node.scrollHeight) || 0) > (Number(node.clientHeight) || 0) + 2;
    if (!longEnough) node.classList.remove('is-clamped');
    return longEnough;
  }
  function collapseToggle(node) {
    const more = button('steward-deliverable-more', t('stewardShell.chat.deliverableExpand'), () => {
      const clamped = node.classList.toggle('is-clamped');
      more.textContent = t(clamped ? 'stewardShell.chat.deliverableExpand' : 'stewardShell.chat.deliverableCollapse');
      more.setAttribute('aria-expanded', clamped ? 'false' : 'true');
    });
    more.setAttribute('aria-expanded', 'false');
    return more;
  }

  // ── F4 回复定型（设计稿画板「一条回复的解剖」的 2 与 4）────────────────────────────────
  // ② 首句即结论 —— 提示词层（06b）本来就要求这么写，所以渲染层只做【呈现】：给正文的第一个
  //    段落加 .is-lead，样式层把它抬成一行醒目的引子。**一个字都不改、一块都不挪**：不切句、
  //    不拆文本节点、不重排 markdown 块（第一块本来就是标题时不加 —— 它已经够重了）。
  // ④ 【117y-S3 撤掉】原来「正文超 8 行折起来 ＋ 一枚展开按钮」这一路没了。用户第十一轮拍板②：
  //    「管家的话最好不要用展开的二级菜单了，显示完吧」。话本来就是完整的，折叠只是逼用户为
  //    看完它多点一次；「让它少说」是提示词的事（同波 S2 在 06b 加了那条规矩），不是运行期把
  //    已经说出口的话再藏起来。所以这个函数现在【只做首句抬引子】，连正文长度都不看了
  //    （text 参数因此去掉 —— 想把折叠加回来的人得先把它加回来，改不动是故意的）。
  //    **交付卡的折叠保留**：那是线程自己写的交付【原文】（117s-H2 实测量到 2687 字），整段
  //    摊开会把管家的按语挤出屏幕。折叠那一处实现（clampIfLong／collapseToggle）一个字没动，
  //    只是从两个调用方减到 fillDeliverable 一个。「用户说的『管家的话』不含交付卡」是主会话
  //    替用户做的判断，写在这里好让下一刀能看见并推翻它。
  function finishSay(row, node) {
    if (!row || !node) return null;
    const lead = node.firstElementChild;
    if (lead && lead.tagName === 'P') lead.classList.add('is-lead');
    return null;
  }

  function appendRow(kind) {
    const feed = feedEl();
    if (!feed) return null;
    const row = el('div', `steward-msg steward-msg-${kind}`);
    // 管家的每一行都留一个 36px 的槽：最新那一行装真头像。117l-B2 ④ 之前历史行的空槽由 CSS 的
    // :empty::before 画一个 8px 灰点 —— 十几轮之后左边就是一列点（用户第五轮走查 4 说的正是它）。
    // 现在空槽什么都不画，槽位（绝对定位的 36px）与行的 44px 左内边距原样保留，文字左缘不动。
    if (kind === 'ruyi') row.appendChild(el('span', 'steward-avslot'));
    feed.appendChild(row);
    markGroup(row, kind);
    feed.scrollTop = feed.scrollHeight;
    return row;
  }

  function appendUser(text) {
    const row = appendRow('user');
    if (!row) return null;
    row.appendChild(el('p', 'steward-say', String(text || '')));
    return row;
  }
  // 133e：这句话带的附件，名字列一行（真内容在管家回合里，与工作台的附件 pill 同一口径：只说带了什么）。
  // 单独一个函数、气泡正文那一行一字不动（用户原话仍是 textContent）。
  function appendAttachLine(row, attachments) {
    if (!row) return row;
    const names = (Array.isArray(attachments) ? attachments : []).map(a => String((a && a.name) || '')).filter(Boolean);
    if (names.length) row.appendChild(el('p', 'steward-attach-line', t('stewardShell.chat.attached', { names: names.join('、') })));
    return row;
  }

  // 「※」= 依据／影响范围／来源的浮层。默认收起；aria-expanded 跟着开合走，浮层本身是
  // role="dialog"（§8.4「依据收进句尾 ※」＋ §8.8 键盘可达）。
  // 117l D5（用户第四轮走查④「管家回复的※号没有正确的标明标题」）：浮层里原来是一串没头没尾的
  // 句子 —— 第一行是模型给的「依据」，后面几行是本回合【已经做掉】的动作回执，读者分不出哪句是哪。
  // 现在分两段各带一个小标题；两个小标题都只在对应内容非空时才渲染（没有的段落连标题一起不出现）。
  //   whyLines —— 依据（模型的 why ＋ 调用方补的同类说明，比如「其它候选：A、B」）
  //   doneLines —— 已办（actionWhyLines：本回合执行过的工具回执）
  function attachWhy(sayNode, why, doneLines, extraWhyLines) {
    const clean = list => (Array.isArray(list) ? list : []).map(line => String(line || '').trim()).filter(Boolean);
    const whyLines = clean([String(why || ''), ...(Array.isArray(extraWhyLines) ? extraWhyLines : [])]);
    const doneRows = clean(doneLines);
    const trigger = button('steward-why-btn', '※');
    trigger.setAttribute('aria-expanded', 'false');
    // §2.4 文字预算：屏幕上【只有一个 ※ 圆钮】（长相由 .steward-why-btn 那条 border-radius:50% 说），
    // 「依据与回执（N）」那几个字不上屏 —— N 进悬停文案与可访问名，读屏与鼠标都问得到，
    // 一屏的字却不多一个。浮层内容与 §8.4 的口径一个字没改。
    const whyCount = whyLines.length + doneRows.length;
    const whyLabel = whyCount
      ? t('stewardShell.chat.whyLabelCount', { label: t('stewardShell.chat.whyLabel'), n: whyCount })
      : t('stewardShell.chat.whyLabel');
    trigger.title = whyLabel;
    trigger.setAttribute('aria-label', whyLabel);
    const pop = el('div', 'steward-why-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('stewardShell.chat.whyLabel'));
    pop.hidden = true;
    // 浮层内容的写手。32 号文 §4（M2）：开合交给两壳共用的 js/popover.js 之后，layer 模式会在开之前
    // 清空容器，所以内容得「随叫随写」；建的时候先写一遍 —— 收着的浮层里也照样是那些行（真机 e2e 的
    // lastWhy 就是「不管开着还是收着都读」），之后每一次开再由原语写一遍。
    function fillWhy() {
      while (pop.firstChild) pop.removeChild(pop.firstChild);
      if (!whyLines.length && !doneRows.length) pop.appendChild(el('p', 'steward-why-line', t('stewardShell.chat.whyEmpty')));
      if (whyLines.length) {
        pop.appendChild(el('h4', 'steward-why-h', t('stewardShell.chat.whyHeading')));
        for (const line of whyLines) pop.appendChild(el('p', 'steward-why-line', line));
      }
      if (doneRows.length) {
        pop.appendChild(el('h4', 'steward-why-h', t('stewardShell.chat.whyDone')));
        for (const line of doneRows) pop.appendChild(el('p', 'steward-why-line', line));
      }
    }
    fillWhy();
    // 32 号文 §4（M2）：开合本身（Esc／点外／焦点归还锚点／同一时刻只允许一个浮层）交给两壳共用的
    // js/popover.js。※ 是【就地节点】（.steward-why-pop 靠 .steward-msg-ruyi 那套已定的 CSS、靠节点
    // 自己的 [hidden] 开合），所以传 opts.layer：不新建 .popover、不外挂 body、关闭只 [hidden] = true
    // 不 remove —— 容器、类名、role、aria 一个字不改。117j UX-F4 那条「点开后焦点还在触发按钮上，
    // 挂在浮层自己身上的 Esc 形同虚设」由原语的 document 捕获监听接管；锚点就是这枚 ※，所以三条关闭
    // 路径（Esc／点外／再点一次）焦点都照旧还给句尾那枚按钮，不在这里再来一次。
    let releaseWhyEscape = null;
    const closeWhy = () => {
      if (popoverAnchor() !== trigger) return false;   // 这一张 ※ 没开着（开着的是别人的浮层）
      closePopover();
      return true;
    };
    // 任何一条关闭路径（Esc／点外／自己关／被下一个浮层顶掉）都到这里：摘 aria、注销 Esc 层。
    const forgetOpenWhy = () => {
      trigger.setAttribute('aria-expanded', 'false');
      if (releaseWhyEscape) { releaseWhyEscape(); releaseWhyEscape = null; }
    };
    trigger.addEventListener('click', () => {
      const mount = pop.parentNode;   // 就地浮层：调用方把返回值挂进那一行之后才可能有人点它
      if (!mount) return;
      popover(trigger, () => { fillWhy(); }, {
        layer: { mount, node: pop },
        onOpen: () => {
          trigger.setAttribute('aria-expanded', 'true');
          // 117j UX-F4：管家壳的 Esc 只有 steward-shell.js 那一处监听（走 stewardEscapeStack），
          // 所以这张浮层照旧要 push 自己那一个关闭器 + owns —— 改走 popover 之后这条接线【不能省】：
          // 少了它就「Esc 关不掉」，或者两路各关一层。
          releaseWhyEscape = stewardEscapeStack.push(closeWhy,
            node => Boolean(node && (pop.contains(node) || trigger.contains(node))));   // 117k：点别处收回
        },
        onClose: forgetOpenWhy,
      });
    });
    // 117s-C：markdown 渲染之后 sayNode 里装的是块级元素，※ 直接挂在 sayNode 上会掉到新的一行。
    // 挂进最后那个 <p> 里（句尾原位，与纯文本时代逐像素一致）；最后一块不是段落（代码块、表格、
    // 图）时不硬塞，让它老老实实另起一行。
    const tail = sayNode.lastElementChild;
    if (tail && tail.tagName === 'P') tail.appendChild(trigger);
    else sayNode.appendChild(trigger);
    return pop;
  }

  function appendSteward(say, why, doneLines, extraWhyLines) {
    const row = appendRow('ruyi');
    if (!row) return null;
    moveAvatarTo(row);   // W2-3：头像永远在【最新】一条管家的话旁边
    const sayNode = el('p', 'steward-say', '');
    row.appendChild(sayNode);
    paintSay(sayNode, say);   // 117s-C：先渲染再挂 ※（renderMarkdownInto 会整段重写这个节点）
    finishSay(row, sayNode);   // F4：首句抬成引子（在挂 ※ 之前，※ 仍在句尾）；117y-S3 之后不再折叠
    row.appendChild(attachWhy(sayNode, why, doneLines, extraWhyLines));
    const feed = feedEl();
    if (feed) feed.scrollTop = feed.scrollHeight;
    return row;
  }

  // 灰字回执：整行按钮换成一句话（§8.4「按钮落定后」列）。
  // F5b：第三个可选参数是一枚字形名（撤回落定那一句用 done 的对勾 = 设计稿里的「✓ 已撤回」）。
  // 不传就还是原来那句纯灰字 —— 其余两个调用方（dismiss 回执、换 Provider 回执）一个字没动。
  // 图标插在文字【前面】且 icon() 自带 aria-hidden，所以这一行的 textContent 逐字不变。
  function settleRow(actsRow, text, glyph) {
    if (!actsRow || !actsRow.parentNode) return;
    const receipt = el('p', 'steward-receipt', text);
    const mark = glyph ? icon(glyph, 12) : null;
    if (mark) receipt.insertBefore(mark, receipt.firstChild);
    actsRow.parentNode.replaceChild(receipt, actsRow);
  }

  // 123-P1 ①（38 号文；用户 2026-09-14 真机取证）：契约不完整那一轮的**系统回执**。
  // 后端 13o/13q 判出「模型没给必填的 why」时在回执与落盘章上盖 contractIncomplete，这里把它
  // 说给用户听：那一轮它一个动作都没做，话里「我已经递过去了／按钮就在下面」全部不作数。
  // 形状用既有的 .steward-receipt（settleRow 那一族的同一件灰字），**不是按钮**——用户此刻没有
  // 任何可点的东西，给一枚按钮反而是第二次撒谎。与 settleRow 的区别只有一个：它替换的是一整行
  // 按钮，而这里压根没有按钮行可替换，所以是直接追加。
  function appendContractReceipt(row) {
    if (!row) return null;
    const receipt = el('p', 'steward-receipt', t('stewardShell.chat.contractIncomplete'));
    receipt.dataset.receipt = 'contract';   // 判据面：与「点完落定」那种回执分得开
    row.appendChild(receipt);
    return receipt;
  }

  // ── 一行按钮（≤3，主动作唯一）──────────────────────────────────────────────
  function renderActs(row, acts, onSettled) {
    const list = (Array.isArray(acts) ? acts : []).slice(0, STEWARD_ACTS_MAX);
    if (!row || !list.length) return null;
    const actsRow = el('div', 'steward-acts');
    let primaryTaken = false;
    for (const act of list) {
      const label = String((act && act.label) || t('stewardShell.acts.open'));
      const btn = button('steward-act', label, () => runAct(act, actsRow, btn, onSettled));
      // 主动作只有一个（后端已归一过 primary；这里再守一道，防手工构造的 acts 出现第二个金色按钮）。
      if (act && act.primary === true && !primaryTaken) { btn.classList.add(STEWARD_PRIMARY_CLASS); primaryTaken = true; }
      actsRow.appendChild(btn);
    }
    row.appendChild(actsRow);
    return actsRow;
  }

  // 「改一下」不出表单：只把焦点交回输入框并换 placeholder（§8.4 提议行末列）。
  function isChangeAct(act) {
    const label = String((act && act.label) || '');
    return label === t('stewardShell.acts.change') || label === '改一下' || label === 'Change it';
  }
  function focusComposerForChange() {
    const input = byId('stewardComposerInput');
    if (!input) return;
    input.placeholder = t('stewardShell.compose.placeholderChange');
    input.focus();
  }

  // 117v-V1 ②（用户第十轮走查②「在会话中点开这些线程后，那个按钮就失效了，但是从 2.0 返回又会
  // 出现」）：**导航不是表态**。「知道了」这类表态是一次性的 —— 点完落成灰字回执，再点一次没有
  // 意义；而「打开线程」没有任何副作用，从 2.0 视窗回来还要再点同一枚按钮，它本来就该反复点。
  // 判据钉在 kind 上而不是按钮文字上：后端 13h stewardRunAct 只认三种 kind，其中 dismiss 记一行
  // 日志、tool 真去执行工具，**只有 open_thread 是「只回 sessionId，切换由 UI 完成」的纯导航**
  // （那一段的头注原话）。所以这里只有它一条，不是一张会长的表。
  function isNavigationAct(act) {
    return Boolean(act) && act.kind === 'open_thread';
  }

  async function runAct(act, actsRow, btn, onSettled) {
    if (!act || typeof act !== 'object') return;
    if (act.kind === 'dismiss' && isChangeAct(act)) { focusComposerForChange(); return; }
    // 122-L1b（36 号文 §2.13）：STEWARD_ONBOARDING_ACT 是【纯前端】的一枚 —— 后端 13h stewardRunAct
    // 只认 open_thread／dismiss／tool 三种 kind，把它发过去只会换回一条 unknown_act。所以在这里就地
    // 落定：开向导（组合根注入的那一个，与工作台空态那枚「开始引导」是同一个入口），不发请求、
    // 不落回执 —— 向导自己就是回执，关掉之后按钮该还在（没配完就还该有）。
    if (act.kind === STEWARD_ONBOARDING_ACT) {
      try { openOnboardingWizard && openOnboardingWizard(stewardEngineReady(state && state.config) ? {} : { startStep: 'engine' }); } catch { /* 向导打不开不该掀翻对话流 */ }   // 还没接模型：直接从「用哪种引擎」那一步开始
      return;
    }
    // 107-S1 ④（46 号文 §5 ⑦b H1）：**confirm 族按下去之前先问一次**。判据是服务端挂的
    // act.confirmItems（13o／13p 由 06i stewardActConfirmSpec 派生，模型碰不到它）——
    // 不是按 label 文字、也不是按工具名在前端另立一张表。清单是纯文本，面板只 textContent。
    // 取消／✕／Esc／点背影一律回 false：**一个请求都不发**（这一枚按钮就是 confirm 档的钥匙）。
    // 先置灰再问：面板开着的时候这一枚不该还能再按出第二张面板；取消后恢复可点（用户可以再想想）。
    if (btn) btn.disabled = true;
    if (Array.isArray(act.confirmItems) && act.confirmItems.length) {
      const agreed = await confirmDanger({ name: 'stewardActConfirm', listItems: act.confirmItems });
      if (!agreed) { if (btn) btn.disabled = false; return; }
    }
    try {
      const response = await api('/api/steward/act', { method: 'POST', body: JSON.stringify({ act }) });
      const result = response && response.result;
      if (!response || response.ok !== true || (act.kind === 'tool' && (!result || typeof result.ok !== 'boolean'))) {
        showActProblem(actsRow, t('stewardShell.chat.actUnconfirmed'));
        // A lost receipt may follow a successful write: do not invite duplicates.
        // 导航（open_thread）不写任何东西，没有「重复执行」可言 —— 按 117v-V1 ② 保持可点，让用户再试一次。
        if (btn) { if (isNavigationAct(act)) btn.disabled = false; else { btn.disabled = true; btn.classList.remove(STEWARD_PRIMARY_CLASS); } }
        return;
      }
      if (result && result.ok === false) {
        // 117l-B2 ⑤：查表那一步搬进 stewardActErrorMessage（多一条 steward.queued 要插 wait.label），
        // 表外仍然落到 errGeneric 并把原始 error 原样带出去。
        const message = stewardActErrorMessage(result.error, t)
          || t('stewardShell.chat.errGeneric', { error: stewardErrorText(result.error) });
        showActProblem(actsRow, message);
        if (btn) {
          btn.disabled = ['invalid_request', 'not_allowed', 'not_found', 'payload_forbidden_key'].includes(result.error);
          if (btn.disabled) btn.classList.remove(STEWARD_PRIMARY_CLASS);
        }
        return;
      }
      // ② 纯导航：**不落回执、不消费按钮行**，把这一枚恢复成可点的（下次还要再点）。
      // 其余 kind 照旧一次性落定成灰字回执。
      actsRow?.parentNode?.querySelector('.steward-act-problem')?.remove();
      if (isNavigationAct(act)) {
        if (btn) btn.disabled = false;
        if (act.sessionId) openThread(act.sessionId);
      } else {
        settleRow(actsRow, receiptFor(act));
      }
      if (typeof onSettled === 'function') onSettled(act, response);
    } catch (error) {
      const info = apiErrorInfo(error);
      const code = stewardErrorCode(info || error);
      const invalid = ['invalid_request', 'not_allowed', 'not_found', 'payload_forbidden_key'].includes(code);
      showActProblem(actsRow, invalid ? stewardActErrorMessage(code, t) || t('stewardShell.chat.errUnavailableAct')
        : t('stewardShell.chat.actUnconfirmed'));
      if (btn) { if (isNavigationAct(act) && !invalid) btn.disabled = false; else { btn.disabled = true; btn.classList.remove(STEWARD_PRIMARY_CLASS); } }
    }
  }

  // 117 走查（用户 2026-09-06）：管家「跟随主端点」而主端点是命令行引擎时，每一句都被 409 挡回；
  // 之前把 JSON 信封原样打进对话流，用户以为管家坏了。现在识别这一个稳定码，给一句人话和两个按钮：
  // 「改用『某端点』」（取第一个 OpenAI 兼容 Provider，写 stewardProviderId 后重试）与「去设置」。
  function engineProblemInfo(error) {
    const info = apiErrorInfo(error);
    return (info && info.code === 'steward.unsupported_engine') ? info : null;
  }
  function firstOpenAiProvider() {
    const providers = chatProviders(state && state.config);   // 兜底取第一个【对话】端点:只做语音的服务商不算
    return providers.find(p => p && p.id && (!p.type || String(p.type).startsWith('openai'))) || null;
  }
  // 117j UX-F2：引擎问题不写死一句话。后端对这两种情形早就各给了各自的人话（13h stewardResolveRoute：
  // 「管家端点 X 不在 Provider 列表里，请到设置里改」／「管家本版只支持 OpenAI 兼容端点，当前主端点是 X」），
  // 而前端此前把它们统统折成同一句 engineUnsupported —— 用户看不出该去改哪一个。
  // 口径：**后端给了 message 就原文照登**（它比前端更知道是哪一种）；没给才按「管家端点配没配、配的那个
  // 在不在 Provider 列表里」二选一。
  function engineProblemSay(info) {
    const message = String((info && info.message) || '').trim();
    if (message) return message;
    const cfg = (state && state.config) || {};
    const configured = String(cfg.stewardProviderId || '').trim()
      || String((info && info.params && info.params.engine) || '').trim();
    const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
    const listed = Boolean(configured) && providers.some(p => p && p.id === configured);
    return (configured && !listed)
      ? t('stewardShell.chat.engineNotListed', { provider: configured })
      : t('stewardShell.chat.engineUnsupported');
  }

  function showEngineProblem(retry, info) {
    const row = appendSteward(engineProblemSay(info), '');
    if (!row) return;
    const actsRow = el('div', 'steward-acts');
    const candidate = firstOpenAiProvider();
    if (candidate) {
      const use = button('steward-act', t('stewardShell.chat.useProvider', { provider: candidate.id }), async () => {
        use.disabled = true;
        try {
          // 写配置走注入的回调（设置域的 saveConfigPartial），本模块不新增任何后端面（J1 锁）。
          const saved = typeof setStewardProvider === 'function' ? await setStewardProvider(candidate.id) : false;
          if (saved === false) throw new Error(t('stewardShell.chat.openSettings'));
          settleRow(actsRow, t('stewardShell.chat.providerSwitched', { provider: candidate.id }));
          if (typeof retry === 'function') await retry();
        } catch (error) {
          showActProblem(actsRow, t('stewardShell.chat.errGeneric', { error: stewardErrorText(error) }));
          use.disabled = false;
        }
      });
      // 117j copy-P3-3：主动作（真能把问题解决的那一个）用统一的金色主按钮类，不再两个按钮一样重。
      use.classList.add(STEWARD_PRIMARY_CLASS);
      actsRow.appendChild(use);
    }
    if (typeof openStewardPanel === 'function') {
      actsRow.appendChild(button('steward-act', t('stewardShell.chat.openSettings'), () => openStewardPanel('')));
    }
    row.appendChild(actsRow);
  }

  function showActProblem(actsRow, message) {
    if (!actsRow) return;
    let note = actsRow.parentNode && actsRow.parentNode.querySelector('.steward-act-problem');
    if (!note) {
      note = el('p', 'steward-act-problem');
      if (actsRow.parentNode) actsRow.parentNode.insertBefore(note, actsRow);
    }
    note.textContent = message;
  }

  function receiptFor(act) {
    if (!act) return t('stewardShell.chat.acked');
    if (act.kind === 'dismiss') return t('stewardShell.chat.acked');
    // 117j UX-F5：回执要说【线程的名字】，不是按钮上那句话。act.label 是「打开「X」」，直接套进
    // 「打开了…」就成了「打开了「打开「X」」」。构造 act 的两处（renderDigest / renderPending）现在
    // 顺手带上 sessionTitle，这里优先读它；老载荷没有就仍然回落到 label（不比修前更差）。
    // 117v-V1 ② 起【runAct 不再为 open_thread 要回执】（导航可反复点，见 isNavigationAct），
    // 所以这一支目前没有调用方。本函数是 act→回执文案的全表，缺一支比留一支更容易误导下一个人：
    // 哪天再有别的面要为「打开了哪条线程」写一句话，口径就在这里，不必重新想一遍。
    if (act.kind === 'open_thread') return t('stewardShell.chat.opened', { title: stewardShortTitle(act.sessionTitle || act.label || act.sessionId) });
    if (act.kind === 'tool' && act.tool === 'steward_thread_continue') {
      return t('stewardShell.chat.handedOff', { title: stewardShortTitle((act.args && act.args.sessionId) || act.sessionId) });
    }
    return t('stewardShell.chat.actDone', { label: String(act.label || '') });
  }

  // 2026-09-24（用户：「打开线程点击了会像没有反应一样……有按钮的话默认直接打开工作台里的对应线程」）：
  // 用户按下的「打开」＝去工作台看这条线程（组合根注入的 openInWorkbench：切视角 ＋ openSession）。
  // 修前它只派 steward:open-thread → 右栏换焦点；而管家回合一结束右栏早就停在这条上了（finishReply
  // 的 focusThread），再点一次屏幕上什么都不动。事件路仍在：注入缺席时回落它（右栏／覆盖式抽屉接）。
  // 管家【自己】换焦点走的仍是 focusThread（派 steward:focus-thread），不进工作台。
  function openThread(sessionId) {
    const id = String(sessionId || '');
    if (!id) return '';
    if (typeof openClassicWindow === 'function') {
      try { void openClassicWindow(id); return id; } catch { /* 掉到下面那条既有通道 */ }
    }
    try { doc().dispatchEvent(new CustomEvent(STEWARD_OPEN_THREAD_EVENT, { detail: { sessionId: id } })); } catch { /* 无 CustomEvent 的宿主 */ }
    return id;
  }
  function focusThread(sessionId) {
    const detail = { sessionId: String(sessionId || '') };
    try { doc().dispatchEvent(new CustomEvent(STEWARD_FOCUS_THREAD_EVENT, { detail })); } catch { /* 同上 */ }
  }

  // 117s-C（用户第九轮走查⑦「返回消息没有区分」）：收件箱触发的那一条回复，在话的【上面】加一枚
  // 「来自线程『X』」的小头 —— 用户自己问的那条什么都不加（不加噪音就是最好的区分）。
  // 点它 = steward:focus-thread，与「打开」按钮走同一个事件，不新增第二条聚焦通道。
  function attachSource(row, source) {
    if (!row || !source || !source.sessionId) return null;
    const label = t('stewardShell.chat.fromThread', { title: stewardShortTitle(source.title || source.sessionId) });
    const chip = button('steward-source', label, () => focusThread(source.sessionId));
    chip.setAttribute('aria-label', label);
    chip.dataset.sessionId = source.sessionId;
    const say = row.querySelector('.steward-say');
    if (say) row.insertBefore(chip, say);
    else row.appendChild(chip);
    return chip;
  }

  // ── F1 线程卡（27 号文 §11.13.1「线程即频道」）──────────────────────────────────────────
  // 「一张卡」不是一个新盒子：对话流仍然是一列平铺的 .steward-msg（§8.1「少一个盒子」，也是
  // 117s-H2 的交付卡定的调子）。合成靠三个类＋一个色号，和 117l-B2 ④ 的分组一模一样的追加式做法：
  //   .is-thread        这一行属于某条线程（画 3px 色条；管家本人的话没有这个类，也就没有色条）
  //   .is-thread-start  这一段的第一行 —— 卡头只长在它身上
  //   .is-thread-end    这一段【目前】的最后一行；下一行还是同一条线程时由那一行把它摘掉
  // 与既有分组规则的关系（本刀必须交代清楚的那一条）：**分组照旧，色条更强**。
  //   · 间距完全不动：组间 --sp-3 ＋ 组内 --sp-1 仍由 markGroup 的 is-group-start/end 说了算；
  //   · 那道淡竖线在 .is-thread 的行上【让位】给色条（样式层一条 content:none）—— 一行只能有
  //     一个锚：头像所在的最新那一组不画竖线是同一条道理（117l-B2 ④ 的原话「再来一道竖线就是
  //     两个锚」）。线程段永远落在同一个说话人的组【之内】，所以两者不会互相撕开。
  // 117u-G1：色号登记搬到模块级的 stewardThreadHueFor（见文件头那一段）——本闭包不再自持一张表，
  // 抽屉与看板问同一个函数拿同一个号，同一条线程三面同色。这里【只读不算】。
  function markThread(row, sessionId) {
    const id = String(sessionId || '');
    if (!row || !id) return null;
    row.dataset.thread = id;
    row.dataset.threadHue = String(stewardThreadHueFor(id));
    row.classList.add('is-thread');
    row.classList.add('is-thread-end');
    const previous = row.previousElementSibling;
    const sameThread = Boolean(previous && previous.classList && previous.classList.contains('is-thread')
      && previous.dataset && previous.dataset.thread === id);
    if (sameThread) previous.classList.remove('is-thread-end');
    else row.classList.add('is-thread-start');
    return row;
  }

  // 相对时间的人话交给平台（见 stewardAgoParts 的头注）：算不出来就整段不说。
  function agoLabel(iso) {
    return stewardAgoLabel(iso, doc() && doc().documentElement ? doc().documentElement.lang : '');
  }

  // 卡头（占位先上屏，事实随后填）。121-K6b 按 §2.4 文字预算收成五样，一样不多：
  //   色点 · 任务名（多线程任务时「任务 › 线程」）· 五态药丸 · 相对时间 · 一枚图标钮「在工作台打开」。
  // **去掉的是模型名**（原来「最后动静 · 模型」拼在一起）—— 那是配置，不是叙事（§2.4 原话）；
  // 它在工作台线程头的 chip 行里有唯一那一处，卡头不印第二遍。
  // 面包屑只在【多线程任务】时出现（与 K5 的工作台线程头同一条判据：row.threadCount > 1），
  // 事实来自 steward-board.js 登记的那张表 —— 本模块不发第二发 /api/missions。
  // 药丸、面包屑、相对时间默认 hidden —— 说不死的那几样宁可不出现，也不留空壳。
  function attachThreadHead(row, source) {
    if (!row || !row.classList.contains('is-thread-start')) return null;
    const head = el('div', 'steward-thread-head');
    head.appendChild(el('span', 'steward-thread-dot'));
    const crumb = el('span', 'steward-thread-crumb');
    crumb.hidden = true;
    head.appendChild(crumb);
    const name = el('span', 'steward-thread-name', stewardShortTitle(source.title || source.sessionId));
    head.appendChild(name);
    const state = el('span', 'steward-thread-state');
    state.hidden = true;
    head.appendChild(state);
    const meta = el('span', 'steward-thread-meta');
    meta.hidden = true;
    head.appendChild(meta);
    // §2.4：卡头那一枚是【图标钮「在工作台打开」】（悬停出字），走的是 K5 收成一处的
    // openInWorkbench（这里的 fullTextOf 就是它的调用点，注入缺席时回落到「打开焦点」）。
    const openLabel = t('stewardShell.chat.openInWorkbench');
    const open = button('steward-thread-open', '', () => fullTextOf(source.sessionId));
    open.appendChild(icon('lensWork', 13));
    open.title = openLabel;
    open.setAttribute('aria-label', openLabel);
    head.appendChild(open);
    const anchor = row.querySelector('.steward-source') || row.querySelector('.steward-say');
    if (anchor && anchor.parentNode === row) row.insertBefore(head, anchor);
    else row.appendChild(head);
    void fillThreadHead(head, { name, state, meta, crumb }, source)
      .catch(() => { /* 卡头绝不把异常丢回对话流 */ });
    return head;
  }

  async function fillThreadHead(head, parts, source) {
    let facts = null;
    try { const got = await loadDeliverable(source.sessionId, source.turnSeq); facts = stewardThreadFacts(got && got.envelope); }
    catch { facts = null; }   // 取不到信封就保持占位（名字来自事件行/回执），不编一个状态出来
    if (!head.isConnected && head.parentNode === null) return null;   // 这一行已经被清屏收走了
    if (!facts) return null;
    if (facts.title) parts.name.textContent = stewardShortTitle(facts.title);
    if (facts.stateKey) {
      parts.state.textContent = t(facts.stateKey);
      parts.state.dataset.state = facts.state;
      parts.state.hidden = false;
    }
    // §2.4：只剩相对时间一样（模型名已退出卡头，见 attachThreadHead 的头注）。
    const ago = agoLabel(facts.updatedAt);
    if (ago) { parts.meta.textContent = ago; parts.meta.hidden = false; }
    if (parts.crumb) {
      const known = stewardThreadMissionOf(source.sessionId);
      const many = Boolean(known) && Number(known.threadCount || 0) > 1 && Boolean(known.missionTitle);
      parts.crumb.textContent = many ? stewardShortTitle(known.missionTitle) : '';
      parts.crumb.hidden = !many;
    }
    return head;
  }

  function attachThreadCard(row, source) {
    if (!row || !source || !source.sessionId) return null;
    markThread(row, source.sessionId);
    // F2：过滤开着的时候新来一行，它的「上一行」可能是一行藏起来的别家线程 —— markThread 只看得见
    // 兄弟、看不见可见性，所以紧接着按【可见的上一行】重封一次段首段尾，卡头才长在对的那一行上。
    // 没开过滤时这一趟算出来与 markThread 逐字相同（同一条判据、同一组兄弟），是空转。
    resealThreads();
    const head = attachThreadHead(row, source);
    return head;
  }

  // ── 121-K4-3：F2 频道条整段退役（34 号文 §2.4／§12 末条）────────────────────────────
  // 原来这里是「只看 · 全部 · 各条线程 · 管家本人 …… 全部线程→看板」那一排 chip（约 160 行：
  // channelList／channelChip／paintChannels／syncChannels／toggleChannel／setChannel／applyChannel／
  // pickChannelTarget ＋ 它那两个模块级状态）。删的理由不是它写坏了（那三条纪律都守住了），而是
  // 它是【第二遍索引】：左栏常开、按任务归组、点一行就换焦点，「只看这条」在那儿是一次点击。
  // 一份数据一处控件（§2.1 第 10 条）。
  // 唯一留下来的是 resealThreads —— 它不属于频道条：线程卡的「一段连成一张卡」（is-thread-start/
  // -end）是【追加时看上一行】算出来的，appendThread 之后要按同一条规则重封一次。过滤那一层没了，
  // 它现在只是把那条规则原样跑一遍（同一组兄弟、同一条判据）。
  function resealThreads() {
    const feed = feedEl();
    if (!feed) return 0;
    let previous = null;
    let sealed = 0;
    for (const row of feed.querySelectorAll('.steward-msg')) {
      if (row.classList.contains('is-thread')) {
        const id = String(row.dataset.thread || '');
        const sameThread = Boolean(previous && previous.classList.contains('is-thread')
          && previous.dataset.thread === id);
        row.classList.add('is-thread-end');
        row.classList.toggle('is-thread-start', !sameThread);
        if (sameThread) previous.classList.remove('is-thread-end');
        sealed += 1;
      }
      previous = row;
    }
    return sealed;
  }

  // ── 117s-H2 交付卡（27 号文 §11.13.3 H2）────────────────────────────────────
  // 用户第三轮回话「线程的交付管家能不能看全」。摸底结论：管家【读了】、时机也对，但它转述的是
  // 二手货 —— say 硬切 600 字，2687 字的交付被压成 407 字。所以收件箱触发的那条回复不再只有
  // 「管家的话」：线程自己的交付原文嵌在同一张卡里，管家的话退成它【上面】的一两句按语。
  // 用户看的是原件，管家只加批注 ——「看不全」从此不依赖模型自觉。
  //
  // 数据：**零新增路由**。GET /api/sessions/<id> 是既有信封（13d:345 那一条：{ ok, session,
  // resumable, displayTitle, … }，session.messages 就是整份消息，不需要任何 ?full 参数），
  // 挑出该回合最后一条助手话（stewardDeliverableFrom）。三条纪律：
  //   · **懒**：只有收件箱触发的那一行才发这一发；用户自己问的那条一个请求都不多发；
  //   · **缓存**：按 sessionId|turnSeq 记在本实例里（同一条线程反复出现在对话流里只取一次），
  //     失败不进缓存，下次进壳还能再试；
  //   · **绝不把异常抛回对话流**：取不到就画一句兜底，永远不留一个空盒子。
  const deliverableCache = new Map();
  function loadDeliverable(sessionId, turnSeq) {
    const key = String(sessionId) + '|' + String(turnSeq || 0);
    if (deliverableCache.has(key)) return deliverableCache.get(key);
    // F1：卡头（线程名/五态/最后动静/模型）与交付原文来自【同一个信封】，所以这一处解出来的是
    // { envelope, deliverable } 两样 —— 两个消费方 await 的是同一个 promise，请求仍然只发一发。
    const task = (async () => {
      const payload = await api('/api/sessions/' + encodeURIComponent(sessionId));
      return { envelope: payload, deliverable: stewardDeliverableFrom(payload && payload.session, turnSeq) };
    })();
    deliverableCache.set(key, task);
    task.catch(() => { deliverableCache.delete(key); });   // 失败不留在缓存里（下次还能再试）
    return task;
  }

  // 「看全文」与卡头那枚图标钮：与「打开」同一个去处（openThread 里那一支 openClassicWindow，
  // 缺席时回落抽屉／「现在这一件」，「看全文」就在标题旁边）。
  function fullTextOf(sessionId) {
    const id = String(sessionId || '');
    if (!id) return '';
    openThread(id);
    return id;
  }

  async function fillDeliverable(block, head, body, source) {
    let found = null;
    let fetched = false;
    try { const got = await loadDeliverable(source.sessionId, source.turnSeq); found = got ? got.deliverable : null; fetched = true; }
    catch { found = null; }   // 取不到：画兜底一句，原件不在这儿，去 2.0 视窗看
    if (!block.isConnected && block.parentNode === null) return null;   // 这一行已经被清屏收走了
    // 2026-09-24（用户：「每次带上『它交付的原文』『这一次没取到原文』，体验很差」）：信封取到了、
    // 但这一回合没有可交付的正文（以工具调用收尾、还在等后台活儿）—— 那就是【没有交付】，不是
    // 「没取到」。整块撤掉，不再垫一句道歉；线程卡上的「打开」仍在。取不到信封才画兜底。
    if (fetched && (!found || !found.text.trim())) { block.remove(); return null; }
    const seq = (found && found.turnSeq) || source.turnSeq || 0;
    head.textContent = seq
      ? t('stewardShell.chat.deliverableHead', { seq })
      : t('stewardShell.chat.deliverableHeadPlain');
    if (!found || !found.text.trim()) {
      body.textContent = t('stewardShell.chat.deliverableMissing');
      block.appendChild(deliverableActs(body, source, false));
      return null;
    }
    paintSay(body, found.text);   // 与管家的话【同一条】渲染＋净化路径（highlightIn 只在这里跑一次）
    // 折叠：行数超顶就折（判据不依赖版面，Node/隐藏容器里也成立），另加一道真实溢出的兜底。
    // F4 之后这一段搬进 clampIfLong；117y-S3 撤掉管家正文那一路之后，这里是它【唯一】的调用方。
    const longEnough = clampIfLong(body, found.text);
    block.appendChild(deliverableActs(body, source, longEnough));
    return body;
  }

  function deliverableActs(body, source, collapsible) {
    const acts = el('div', 'steward-deliverable-acts');
    if (collapsible) acts.appendChild(collapseToggle(body));   // 117y-S3 之后这是折叠仅剩的一个调用方
    // 117v-V1 ⑨（用户第十轮走查⑨「管家的回复看全文是打开 2.0，看英伟达分析全文是打开线程，
    // 这个 UX 体验就很迷」）：这一枚与抽屉那一枚确实还是同一个动作（两边都调 openClassicWindow），
    // 但**同一屏上还有第二枚「看…全文」**——管家写的 open_thread act（琥珀色那一枚）点下去是
    // 打开线程，不是跳 2.0。两个去处共用一个泛泛的「看全文」，用户就只能靠猜。
    // 所以这一枚**自己一个键**，文案里把去处写出来（「到 2.0 视窗看全文」）；抽屉那一枚不动
    // （它旁边没有第二个「看全文」，那里的短词是对的）。原来那句「同一个词、同一个动作，所以
    // 共用同一个键」是本刀之前的注释：动作那半句今天仍然成立，**「共用一个词」这半句已经不成立**。
    acts.appendChild(button('steward-deliverable-full', t('stewardShell.chat.deliverableFull'),
      () => fullTextOf(source.sessionId)));
    return acts;
  }

  // 卡片就位（占位先上屏，正文随后填）：来源小头 → 管家的按语 → 交付卡 → ※ → 按钮行。
  // ※ 仍然挂在按语最后那一段的句尾（117s-C 的 S3c 钉着这条），浮层节点排在交付卡之后。
  function attachDeliverable(row, source) {
    if (!row || !source || !source.sessionId) return null;
    // 2026-09-24：只有「某一回合跑完了」这类事件才有交付可言。交接、待决、班组收工这些事件没有回合号，
    // 修前会退到「整条线程最后一条助手话」—— 把旧回合的话当成这一次的交付端上来，或者垫一句「没取到」。
    if (!(Number(source.turnSeq) > 0)) return null;
    const block = el('div', 'steward-deliverable');
    block.dataset.sessionId = source.sessionId;
    if (source.turnSeq) block.dataset.turnSeq = String(source.turnSeq);
    const head = el('p', 'steward-deliverable-head', t('stewardShell.chat.deliverableLoading'));
    const body = el('div', 'steward-deliverable-body');
    block.appendChild(head);
    block.appendChild(body);
    const say = row.querySelector('.steward-say');
    if (say && say.parentNode === row) row.insertBefore(block, say.nextSibling);
    else row.appendChild(block);
    void fillDeliverable(block, head, body, source).catch(() => { /* 交付卡绝不把异常丢回对话流 */ });
    return block;
  }

  // ── 「···」占位与流式文字 ────────────────────────────────────────────────────
  function appendTyping() {
    const row = appendRow('ruyi');
    if (!row) return null;
    moveAvatarTo(row);   // W2-3：「···」占位一出现，头像先搬过去（它就是这一回合管家所在的位置）
    const dots = el('div', 'steward-typing');
    dots.setAttribute('aria-label', t('stewardShell.chat.thinking'));
    for (let i = 0; i < 3; i++) dots.appendChild(el('span', 'steward-typing-dot', '·'));
    row.appendChild(dots);
    return row;
  }

  // 本回合工具轨迹：默认整段 hidden（不是不渲染——「细节」开关一开就得看得见，不必重跑回合）。
  function renderTools(row, tools) {
    if (!row || !tools.length) return;
    const box = el('details', 'steward-tools');
    box.hidden = !detailsOn;
    const summary = el('summary', 'steward-tools-summary', t('stewardShell.chat.tools', { count: tools.length }));
    box.appendChild(summary);
    const list = el('ul', 'steward-tools-list');
    for (const name of tools) list.appendChild(el('li', 'steward-tools-item', name));
    box.appendChild(list);
    row.appendChild(box);
  }

  // ── 发给如意：POST /api/steward/message 的 NDJSON 流 ─────────────────────────
  // 117l D3（用户第四轮走查⑥）：修前这里是 `if (!message || streaming) return null;` —— 管家还在流
  // 的时候用户再说一句，那句话【无声无息地消失】：不上屏、不排队、不报错，用户只看见自己敲的字被
  // 清空了。现在改成队列：第二句立刻上屏并标「排队中」，当前这条流收尾时按序发下一条。
  let streaming = false;
  const sendQueue = [];

  // 输入框旁那行小字（队列满时说「先等一等」）。它与抽屉的 note 落在两个不同的区域，但写法是
  // 同一份（33 号文 §4「note()×5 收一」）：写手只在 steward-chips.js 里定义一次。
  function composerNote(text) {
    writeNote('stewardComposerNote', text);
  }

  // 排队中的那一行：淡一点 ＋ 右下角一枚「排队中」小标。用真节点而不是 CSS ::after —— 生成内容
  // 在部分读屏里读不到，而这句话恰恰是「你的话没丢，只是还没轮到」的唯一凭据。
  function markQueued(row, on) {
    if (!row) return;
    row.classList.toggle('is-queued', on === true);
    const existing = row.querySelector('.steward-queued');
    if (on !== true) { if (existing && existing.parentNode) existing.parentNode.removeChild(existing); return; }
    if (existing) return;
    const tag = el('span', 'steward-queued', t('stewardShell.chat.queued'));
    tag.setAttribute('aria-label', t('stewardShell.chat.queued'));
    row.appendChild(tag);
  }

  function drainQueue() {
    const next = sendQueue.shift();
    if (!next) return;
    // 人已经走了（切壳／关管家）就别替他把排队的话发出去。resetConversation 那一头【不】动 ——
    // 它的函数体被 steward-conversation.static I7/I9 逐字钉着，而这道判据放在出口这里更准：
    // 离开壳时正在跑的那条流仍会走到 finally，于是清队列恰好发生在它收尾的那一刻。
    if (!isStewardMode()) {
      // 连同还排在后面的那几行一起摘掉「排队中」—— 它们永远不会被发出去了，留着那枚小标是撒谎。
      for (const row of [next, ...sendQueue]) markQueued(row.row, false);
      sendQueue.length = 0;
      return;
    }
    markQueued(next.row, false);
    void runSend(next.message, next.opts, next.row);
  }

  async function sendToSteward(text, opts = {}) {
    const message = String(text || '').trim();
    if (!message) return null;
    if (streaming) {
      if (sendQueue.length >= STEWARD_SEND_QUEUE_MAX) { composerNote(t('stewardShell.chat.queueFull')); return null; }
      const row = appendUser(message);
      markQueued(row, true);
      sendQueue.push({ message, opts: opts || {}, row });
      appendAttachLine(row, opts && opts.attachments);
      return null;
    }
    return runSend(message, opts, null);
  }

  async function runSend(message, opts, queuedRow) {
    composerNote('');
    if (!queuedRow) appendAttachLine(appendUser(message), opts && opts.attachments);
    streaming = true;
    setPresence({ streaming: true, phase: 'thinking' });
    const row = appendTyping();
    let sayNode = null;
    const tools = [];
    let reply = null;
    // 117o：攒的是【原始信封】，上屏的只有 say 的当前值（判据在 steward-chips 的 stewardSayFromPartial）。
    let rawEnvelope = '';
    const applyDelta = chunk => {
      if (!row) return;
      rawEnvelope += chunk;
      const say = stewardSayFromPartial(rawEnvelope);
      if (!say) return;                       // 还没吐到 say：停在「···」，不端半截 JSON 给用户
      if (!sayNode) {
        const dots = row.querySelector('.steward-typing');
        if (dots) row.removeChild(dots);
        sayNode = el('p', 'steward-say', '');
        row.appendChild(sayNode);
      }
      // 整段重写：半截信封里的 say 是会长的。117s-C：这里也走 markdown（分片渲染的结果就是
      // 用户边看边成形的标题与列表），但高亮／mermaid 留到 finishReply 的终态跑一次。
      paintSay(sayNode, say, { highlight: false });
      const feed = feedEl();
      if (feed) feed.scrollTop = feed.scrollHeight;
    };
    try {
      // 117l D1：routeHint 是【提示】，与用户那句话分开走（用户消息逐字不动的纪律，见 §11.9 D1
      // 与 06b 的 routeHintBlock —— 服务端只信 sessionId，标题它自己重查）。没有 hint 时不带这个键。
      const hint = (opts && opts.routeHint && typeof opts.routeHint === 'object') ? opts.routeHint : null;
      // 133e：附件（/api/upload 的记录）随这句话一起走，服务端交给管家回合（与工作台 /api/chat/stream 的 attachments 同一条管线）。
      const atts = (opts && Array.isArray(opts.attachments) && opts.attachments.length) ? opts.attachments : null;
      const res = await fetch('/api/steward/message', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ message, ...(hint ? { routeHint: hint } : {}), ...(atts ? { attachments: atts } : {}) }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const takeLine = line => {
        const trimmed = String(line || '').trim();
        if (!trimmed) return;
        let evt = null;
        try { evt = JSON.parse(trimmed); } catch { return; }
        if (!evt || typeof evt !== 'object') return;
        if (evt.type === 'assistant_delta') applyDelta(String(evt.text || ''));
        else if (STEWARD_TOOL_EVENT_TYPES.includes(evt.type)) {
          setPresence({ phase: 'calling_tool' });
          if (evt.type === 'tool_use') tools.push(String(evt.name || ''));
        } else if (evt.type === 'steward_reply') reply = evt;
      };
      // 读流骨架唯一一份在 net.js（33 号文 §4）；尾行由它按「非空白才补发」的规矩交给 takeLine
      // —— 与原来那个 takeLine(buf) 等价（空白尾行本来就被 takeLine 自己丢掉）。
      await readNdjsonStream(res.body, takeLine);
      if (!reply) throw new Error('stream ended without steward_reply');
      finishReply(row, sayNode, reply, tools, message);
      return reply;
    } catch (error) {
      parkAvatar();   // W2-3 陷阱：这一行马上要被移除，头像若还在里面会一起没
      if (row && row.parentNode) { row.parentNode.removeChild(row); resealGroups(); }
      // 引擎不支持（409 的 JSON 信封在 error.message 里）：一句人话＋「改用某端点／去设置」，改完自动重发。
      const engineInfo = engineProblemInfo(error);
      if (engineInfo) {
        showEngineProblem(() => sendToSteward(message, opts), engineInfo);
        return null;
      }
      const failRow = appendSteward(t('stewardShell.chat.streamFailed'), '');
      // 「重试」是【纯前端】的重发，不是一个 act —— 所以这一行按钮手工搭，不走 renderActs（那条路
      // 会把它当 act 送去 POST /api/steward/act，白白记一条 dismiss 日志）。
      if (failRow) {
        const retryRow = el('div', 'steward-acts');
        const retryBtn = button('steward-act', t('stewardShell.chat.retry'), () => {
          if (failRow.parentNode) failRow.parentNode.removeChild(failRow);
          sendToSteward(message, opts);
        });
        retryBtn.classList.add(STEWARD_PRIMARY_CLASS);
        retryRow.appendChild(retryBtn);
        failRow.appendChild(retryRow);
      }
      return null;
    } finally {
      streaming = false;
      setPresence({ streaming: false, phase: 'idle' });
      // 117l D3：这一条收尾了才轮到排队的下一条（按序发；不 await —— finally 里等下一条跑完
      // 会把本次调用方一直挂住）。队列空时 drainQueue 立刻返回，老路径逐字不变。
      drainQueue();
    }
  }

  function finishReply(row, sayNode, reply, tools, sourceMessage) {
    if (!row) return;
    // 123-N1 ①（34 号文；用户 2026-09-13 真机走查「同一段对话出现两遍」）：**用户自己发的回合
    // 也要推水位**。修前水位只在 renderHistorySince（进壳画历史）里推高，runSend → appendUser /
    // finishReply 这条路直接上屏、从不推水位 —— 于是下一条收件箱回合到达时，壳层调
    // appendSince(lastRenderedAt || visitStartedAt) 会从到访起点重拉，把屏上已有的回合再画一遍。
    // reply.createdAt 是 13q 回执新带的「这条助手消息落盘的时刻」，与 ?since= 同一把尺（服务端那边
    // 是【严格大于】，所以水位停在本回合末尾正好把两条消息一起盖住）。
    const stampedAt = String((reply && reply.createdAt) || '');
    if (stampedAt) {
      if (stampedAt > lastRenderedAt) lastRenderedAt = stampedAt;
      row.dataset.createdAt = stampedAt;   // ③ 的另一半：这一行也带上身份，回放那条路才认得出它
    } else {
      // 老回执（升级前的服务端）或读不到落盘时刻：退到「对齐一发」—— 只推水位，不画任何东西。
      void alignWatermark();
    }
    const say = String(reply.say || '');
    // 117s-C：终态这一次带高亮（代码块的 hljs ＋ mermaid 懒加载都在 highlightIn 里，只跑这一次）。
    if (sayNode) { if (say) paintSay(sayNode, say); }
    else {
      const dots = row.querySelector('.steward-typing');
      if (dots) row.removeChild(dots);
      const fresh = el('p', 'steward-say', '');
      row.appendChild(fresh);          // 先进文档再渲染：mermaid 懒加载量的是真实版面
      paintSay(fresh, say);
    }
    const node = row.querySelector('.steward-say');
    finishSay(row, node);   // F4：与 appendSteward 同一处定型（流式那一路只在终态跑这一次）
    if (node) row.appendChild(attachWhy(node, reply.why, actionWhyLines(reply.actions)));
    // 124-P3：回执上可见层。排在 ※ 之后、按钮行之前 —— 它说的是【已经发生的事】，
    // 按钮说的是【你还可以做的事】，先读完发生了什么再看还能做什么。
    appendActionReceipts(row, reply.actions);
    renderTools(row, tools);
    // 熔断或错误：只有话，没有按钮（后端已把人话放进 say；presence 走 error）。
    if (reply.circuit || reply.error) {
      setPresence({ lastError: stewardErrorText(reply.error) || String((reply.circuit && reply.circuit.kind) || 'circuit') });
      // 117 走查（用户 2026-09-06）：回合层的失败也走这条 200 流（say 为空、error 带稳定码），此前只画出
      // 一个空行和 ※。引擎不支持 → 换成人话＋「改用某端点／去设置」并可自动重发；其它错误至少把后端
      // 给的人话（message）放进 say，绝不留空行。
      if (stewardErrorCode(reply.error) === 'steward.unsupported_engine') {
        parkAvatar();   // W2-3 陷阱：同上
        if (row.parentNode) { row.parentNode.removeChild(row); resealGroups(); }
        // 回合层的失败走的是 200 流，不是抛出来的信封 —— 自己拼一个同形的 info 喂给同一处文案。
        showEngineProblem(() => sendToSteward(sourceMessage),
          { code: 'steward.unsupported_engine', params: {}, message: String(reply.message || '') });
        return;
      }
      if (!say && node) node.textContent = stewardErrorText(reply.message || reply.error) || t('stewardShell.chat.streamFailed');
      return;
    }
    setPresence({ lastError: '' });
    renderActs(row, reply.acts);
    // 123-P1 ①：live 那条路的灰字系统回执（回放那条路在 renderHistorySince 里，同一句话）。
    // 排在按钮之后：契约不完整时 acts 本来就是空的，万一模型给了 acts 又漏了 why，回执也该
    // 收在最后一行，而不是插在话与按钮中间。
    if (reply && reply.contractIncomplete === true) appendContractReceipt(row);
    // W2-1：回合结束即展示管家刚开的那条线程（宽屏切「现在这一件」，窄屏开抽屉——两者都接
    // steward:focus-thread）。管家的话后面仍然保留「打开」按钮，只是不必再点了。
    const opened = executedThreadSessionId(reply.actions);
    if (opened) {
      // 117v-V1 ③ 的另一半：「**当场**长出线程卡」说的就是这一轮 —— 用户问、管家开线程，人还看着
      // 屏幕。回放那条路（renderHistorySince）要等下一次进壳或下一条收件箱增量才走得到，只改那边
      // 等于「刷新一下才看得见」。同一条判据（executedThreadSessionId）、同一处挂法
      // （attachThreadCard 里 markThread → 卡头），不新造第二套。
      // 121-K4-3：频道条退役后，这一轮的可见回执是【左栏那一行】与对话流里这张卡。
      // 标题留空是诚实的：这一刻前端手上只有 id，线程的显示名由卡头自己去信封里取（fillThreadHead）。
      attachThreadCard(row, { sessionId: opened, title: '' });
      focusThread(opened);
      // 121-K6b（34 号文 §13.3 ①「里程碑不丢」）：`dispatchAcceptanceMilestones` 的接线点。
      // 它是【前端唯一】的验收里程碑生产者（thread-facts.js 的头注写着「真正的接线点是新任务」），
      // 121-K1 删交办台时把它唯一那个调用点（派单输入框）一起带走了，此后管家新开的线程账本恒空 ——
      // 抽屉的验收块与看板的验收计数对它们永远显示「没有验收项」。
      // 为什么落在这一处而不是别处：`executedThreadSessionId` 是全仓唯一那条「这一回合【真的】
      // 开出了一条新线程」的判据（它只认 ok===true 的 steward_thread_new / quick_ask /
      // thread_continue），而**用户那句原话**此刻就在手上（sourceMessage）—— 那正是
      // dispatchAcceptanceMilestones 要的入参。后端 13k stewardImplThreadNew 只写 kind='mission'、
      // 不建账本（本刀零后端，不去改它）。
      void ensureAcceptanceLedger(opened, sourceMessage);
    }
  }

  // 只在【账本真的空着】时才立一本（先 GET 再决定）：POST /api/mission {action:'start'} 是全量
  // 新建，撞上已有账本会把里程碑整表换掉 —— 管家自己后来 mission_update 写进去的进度不能被这一发
  // 抹掉。失败一律沉默：立不起账本不该在对话流里冒一句红字（用户没做错任何事，账本也不是他要的）。
  //
  // **写完要回读**（真机与 e2e 都逮到过的一个竞争，写在这里免得下一个人再花一小时）：管家开线程
  // 之后【立刻】就给它派了第一回合（13k stewardImplThreadNew 末尾的 stewardLaunchTurn）。我们这一发
  // 落盘时，那个回合往往还没进 activeChildren —— 于是 13-http-router 那段「把 mission 同步进在飞
  // 回合的内存副本」（C4/75a-3）够不着它，回合收尾时的 saveSession 用一份【建账本之前】读进内存的
  // session 把磁盘盖回去，账本整份消失。实测：同一件 e2e 两跑一红一绿。
  // 修法是【回读 ＋ 有界重试】而不是「等回合结束再写」：后者要为此新开一路轮询去问 resumable.live，
  // 而这件事本来就该由服务端把写口串起来（那是 src 的地界，本刀零后端 —— 登记成产品债）。
  // 三次、每次 1.2 s：足够跨过一个短回合的收尾，又不会在真的写不进去时无限打转。
  const ACCEPTANCE_LEDGER_TRIES = 3;
  const ACCEPTANCE_LEDGER_RETRY_MS = 1200;
  async function ensureAcceptanceLedger(sessionId, prompt) {
    const id = String(sessionId || '');
    const goal = String(prompt || '').trim();
    if (!id || !goal) return false;
    const read = async () => {
      const got = await api(`/api/mission?sessionId=${encodeURIComponent(id)}`);
      return (got && got.mission && Array.isArray(got.mission.milestones)) ? got.mission.milestones : [];
    };
    for (let attempt = 0; attempt < ACCEPTANCE_LEDGER_TRIES; attempt++) {
      try {
        if ((await read()).length) return attempt > 0;
        await api('/api/mission', {
          method: 'POST',
          body: JSON.stringify({ sessionId: id, action: 'start', goal, milestones: dispatchAcceptanceMilestones(goal) }),
        });
        if ((await read()).length) return true;
      } catch { return false; }
      await new Promise(resolve => setTimeout(resolve, ACCEPTANCE_LEDGER_RETRY_MS));
    }
    return false;
  }

  // actions 已由后端执行或降级：不渲染为按钮，但把 executed 的回执放进 ※ 里（§8.4 表头脚注）
  // **以及 124-P3 之后的那条可见灰字**（见下面 appendActionReceipts）。两处读的是同一份
  // actionReceipts()，不是两份判据。
  function actionWhyLines(actions) {
    return actionReceipts(actions).map(receipt => receipt.text);
  }

  // 124-P3（40 号文 §2 ③ A01「它说已安排／已发送，真发了吗？」）：**回执才算数。**
  //
  // 判据表（只看 `row.result`，`say` 里那句话一个字都不看 —— 38 号文 §7 ④ 已经裁决过：
  // 下一档不该是关键词表，而是让「我做了什么」结构化到 actions 里再判）：
  //   · `result.ok === true`  → done        「做成了」
  //   · `result.ok === false` → failed      那句错误人话（含 propose_required：降级成按钮＝还没做）
  //   · 其余（result 缺席／不是对象）→ no_receipt 「我发起了，但没拿到回执」
  //
  // **修前这里是两值的**：`okFlag = !(result && result.ok === false)` —— 第三格被算进了「做成了」。
  // 那正是 A01 要挡的那种谎：系统手上没有任何回执，牌子却替模型把话说圆了。
  // 第三格今天在【在途回合】里走不到（13p 的两处 executed.push 都保证给 row.result 赋值），
  // 它是给**回放**留的：落盘的章是历史数据，老回合／被截断的行都可能没有这个键，而回放那条路
  // 与 live 走同一个渲染入口。宁可在那一格说「没拿到回执」，也不许默认说成功。
  function actionReceipts(actions) {
    const out = [];
    for (const row of (Array.isArray(actions) ? actions : [])) {
      if (!row || !row.tool) continue;
      const state = stewardActionReceiptState(row.result);
      out.push({ state, text: receiptText(row, state) });
    }
    return out;
  }
  function receiptText(row, state) {
    const result = row.result;
    // 三态各自的那半句。failed 那一档仍然把后端的错误人话原样带出来（诚实优先，不归一成一句）。
    const stateText = state === 'done' ? t('stewardShell.chat.actionDone')
      : state === 'failed' ? stewardActErrorMessage(result && result.error, t) || stewardErrorText(result && result.error)
        : t('stewardShell.chat.actionNoReceipt');
    return t('stewardShell.chat.actionLine', {
      // 116-3 copy P1-1（§8.1 原则 7）：优先用后端给的人话标签（13h 的 stewardActLabel，与「行动流水」
      // 同一批口径）。117j 补上第二道：后端没给 label 时（116-3 之前落盘的历史回合就没有），
      // 回落到【前端那份 i18n 表】而不是工具 id —— 界面上永远不该出现 `steward_thread_continue`
      // 这种内部标识符。两道都落空（表外的新工具）才用 id，那是最后的诚实兜底。
      tool: toolLabelOf(row),
      state: stateText,
    });
  }

  // 124-P3：回执上【可见层】。修前它只住在 ※ 浮层里（默认收起），于是屏幕上唯一说「已经发给
  // 你同事了」的仍然是模型那句话 —— 系统手上明明有回执，却不肯把它说出口。
  // 形状沿用 123-P1 ① 那条 `.steward-receipt` 灰字（同一件材质、不是按钮：用户此刻没有可点的
  // 东西，给一枚按钮反而是第二次撒谎）。`data-receipt="action"` 与那条 `contract` 分得开，
  // `data-receipt-state` 让判据面能逐条读三态而不必去抠文案。
  // **零 actions 就一行都不画** —— 模型只说不做的那一轮，界面上不该有任何系统背书（§5 的 P3 判据）。
  function appendActionReceipts(row, actions) {
    const receipts = actionReceipts(actions);
    if (!row || !receipts.length) return 0;
    for (const receipt of receipts) {
      const line = el('p', 'steward-receipt', receipt.text);
      line.dataset.receipt = 'action';
      line.dataset.receiptState = receipt.state;
      row.appendChild(line);
    }
    return receipts.length;
  }

  // 117j copy-P1-1：一条 action 在 ※ 里该显示什么名字。后端标签 > 前端 i18n 表 > 工具 id。
  function toolLabelOf(row) {
    const backend = String((row && row.label) || '').trim();
    if (backend) return backend;
    const key = STEWARD_TOOL_LABEL_KEYS[String((row && row.tool) || '')];
    return key ? String(t(key)) : String((row && row.tool) || '');
  }

  // ── §8.12 递话：Enter 直接递给线程，不经管家回合 ─────────────────────────────
  // 「换一条」与撤回后的「那递给谁？」都要把候选列表就地打开，而候选列表住在输入区模块里。
  // 迟绑定一个回调（组合根在两个子域都建好之后注入），避免 conversation ↔ composer 互相 import。
  let pickTarget = () => {};
  function setPickTargetHandler(handler) { if (typeof handler === 'function') pickTarget = handler; }

  let undoTimer = 0;
  function stopUndoCountdown() {
    if (!undoTimer) return;
    clearInterval(undoTimer);
    undoTimer = 0;
  }
  // 唯一的 setInterval：撤回窄窗倒计时。只在一次真实递话之后起，倒计时归零即自清（见 tick 里的
  // stopUndoCountdown），离开管家壳时 resetConversation() 也会清 —— 不存在「没递话却在跑的计时器」。
  // 117j copy-P2-2：倒计时数字每秒变一次，而这枚按钮就在 #stewardFeed 里 —— 那是个
  // role="log" aria-live="polite" 的区。读屏于是把「撤回（9）」「撤回（8）」…一路念下去，
  // 把真正的新消息全淹掉。数字放进 aria-hidden 的 span，按钮自己的 aria-label 固定成「撤回」：
  // 看得见的仍然在跳，念出来的只有一句。
  //
  // F5b 改的是【看得见的那一半】：那个 span 不再放数字，而是一圈随秒消退的环。它每秒只被写一个
  // 0–1 的比例（STEWARD_UNDO_RING_PROP），环怎么画全在 CSS 里；按钮的文字自始至终是建它时那句
  // 「撤回」，一个字都没重写过 —— 位数从 10 变 9 时按钮宽度跳一下的毛病，根子就在那次重写。
  // 秒数仍然留给鼠标用户：写进这个 aria-hidden 元素的 title（整棵子树都不在无障碍树里，
  // 所以 copy-P2-2 那条「读屏不许每秒念一遍」的纪律照旧成立）。
  function paintUndoRing(face, left, total) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
    face.style.setProperty(STEWARD_UNDO_RING_PROP, String(ratio));
    face.title = t('stewardShell.chat.undoCountdown', { seconds: left });
  }
  function startUndoCountdown(btn, onExpire) {
    stopUndoCountdown();
    let left = Math.round(STEWARD_UNDO_WINDOW_MS / 1000);
    const total = left;
    btn.setAttribute('aria-label', t('stewardShell.chat.undo'));
    const face = el('span', 'steward-undo-face');
    face.setAttribute('aria-hidden', 'true');
    paintUndoRing(face, left, total);
    btn.insertBefore(face, btn.firstChild);
    undoTimer = setInterval(() => {
      left -= 1;
      if (left > 0) { paintUndoRing(face, left, total); return; }
      stopUndoCountdown();
      onExpire();
    }, 1000);
  }

  async function handOff({ sessionId, title, message, reason, hits }) {
    const sid = String(sessionId || '');
    const text = String(message || '').trim();
    if (!sid || !text) return null;
    appendUser(text);
    const act = { kind: 'tool', tool: 'steward_thread_continue', args: { sessionId: sid, message: text } };
    let response = null;
    try {
      response = await api('/api/steward/act', { method: 'POST', body: JSON.stringify({ act }) });
    } catch (error) {
      appendSteward(t('stewardShell.chat.errGeneric', { error: stewardErrorText(error) }), '');
      return null;
    }
    const result = response && response.result;
    if (result && result.ok === false) {
      const key = stewardActErrorKey(result.error);
      appendSteward(key ? t(key) : t('stewardShell.chat.errGeneric', { error: stewardErrorText(result.error) }), '');
      return null;
    }
    const label = stewardShortTitle(title || sid);
    const others = (Array.isArray(hits) ? hits : []).filter(hit => hit && hit.sessionId !== sid)
      // 116-5b:与输入区候选列表同一份数据、同一个显示名(hit.displayTitle,服务端算好)。
      .map(hit => stewardShortTitle(hit.displayTitle || hit.title || hit.sessionId));
    // 117j copy-P3-1：列表分隔符走 i18n —— 中文用「、」，英文得用「, 」，写死一个必然在另一种语言下别扭。
    // 「其它候选」是【依据】而不是【已办】：它说明「为什么递给了这一条」，所以走第 4 个参数
    // （117l D5 把 ※ 分成「依据／已办」两段之后，这一行如果留在第 3 个参数上会被扣上「已办」的帽子）。
    const row = appendSteward(t('stewardShell.chat.handedOff', { title: label }), String(reason || ''), [],
      others.length ? [t('stewardShell.chat.otherCandidates', { list: others.join(t('stewardShell.chat.listSeparator')) })] : []);
    focusThread(sid);
    const undoRef = (result && result.undoRef) || null;
    const actsRow = el('div', 'steward-acts');
    const undoBtn = button('steward-act', t('stewardShell.chat.undo'), () => {
      stopUndoCountdown();
      undoHandOff({ sessionId: sid, undoRef, actsRow });
    });
    actsRow.appendChild(undoBtn);
    if (row) row.appendChild(actsRow);
    // 10 秒到点：同一个按钮改称「换一条」。行为仍是「先回退再递」——点它 = 撤回 + 追问
    // 「那递给谁？」+ 就地打开候选列表（§8.12 第 3 条）。候选列表就是输入区 chip 的那一份
    // （预判 hits ＋ 本次见过的线程 ＋「→ 如意」），「在事项下新开／另起一件」两项随 117d 的
    // 事项视图一起到位。
    startUndoCountdown(undoBtn, () => {
      // 窄窗到点：整枚按钮换成「换一条」——文字与 aria-label 一起换（倒计时那个 span 随之被丢掉）。
      undoBtn.textContent = t('stewardShell.chat.switchTarget');
      undoBtn.setAttribute('aria-label', t('stewardShell.chat.switchTarget'));
      undoBtn.classList.add('steward-act-switch');
      // F5b：环没了、换上一枚「⇄」——【图标这一下变化】就是这次改口的过渡。改前是文字无声地换掉，
      // 用户根本注意不到按钮已经不是那个意思了。赋 textContent 顺手把环那个 span 也丢掉了，
      // 所以这里是从零重挂，不会出现「环 + 换一条」这种半截态。
      const switchMark = icon('swap', 12);   // F5b 收尾:换目标不是重试(见 icons.js 的 swap 头注)
      if (switchMark) undoBtn.insertBefore(switchMark, undoBtn.firstChild);
    });
    return { sessionId: sid, undoRef, row, actsRow };
  }

  // 撤回 = 先 stop 再 rewind（顺序不能反：还在跑的回合不停下来就回退，回退完它还会接着往回写）。
  async function undoHandOff({ sessionId, undoRef, actsRow }) {
    const sid = String(sessionId || '');
    let filesReverted = 0;
    try {
      await api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
      // 回退锚点：优先用后端 117d 第 0 步补出的 undoRef.rewindTargetTurnSeq（= 被递那一回合将拥有的
      // seq，与 09-workflow 的 plannedTurnSeq 同口径）。缺省才回落到「undoRef.turnSeq + 1」：turnSeq
      // 语义是递话【前】，而 rewindSession 按「要删掉的那一回合的第一条用户消息」定位，差一格直接传
      // 会得 'target turn not found in this session'（117c 交付记录登记项①）。
      const explicit = undoRef && Number(undoRef.rewindTargetTurnSeq);
      const before = undoRef && Number.isFinite(Number(undoRef.turnSeq)) ? Number(undoRef.turnSeq) : 0;
      const target = Number.isFinite(explicit) && explicit > 0 ? explicit : before + 1;
      const rewound = await api('/api/session/rewind', {
        method: 'POST',
        body: JSON.stringify({ sessionId: sid, targetTurnSeq: target, rollbackFiles: true }),
      });
      // 回退没成真就不许说「已撤回」（§8.1 原则 2 诚实优先）：按钮行留着，用户可以再点一次。
      if (!rewound || rewound.ok === false) {
        showActProblem(actsRow, t('stewardShell.chat.errGeneric', { error: stewardErrorText((rewound && rewound.error) || 'rewind_failed') }));
        return false;
      }
      filesReverted = Array.isArray(rewound.filesReverted) ? rewound.filesReverted.length : 0;
    } catch (error) {
      showActProblem(actsRow, t('stewardShell.chat.errGeneric', { error: stewardErrorText(error) }));
      return false;
    }
    // 引擎没有检查点时 rewind 只回消息不回文件——如实标注，不假装全撤了（§8.1 原则 2「诚实优先」）。
    // F5b 第三态：整行按钮退成一句安静的「✓ 已撤回」（设计稿「图标集」画板第二行末格）。
    settleRow(actsRow, filesReverted > 0 ? t('stewardShell.chat.undone') : t('stewardShell.chat.undoneFilesKept'), 'done');
    appendSteward(t('stewardShell.chat.whoInstead'), '');
    try { pickTarget(); } catch { /* 候选列表打不开不影响撤回本身已经完成 */ }
    return true;
  }

  // ── §8.9 每次打开只汇报本次 ─────────────────────────────────────────────────
  let visitBusy = false;
  let visitStartedAt = '';
  // 117j W2-4：对话流已经画到哪一条（createdAt 水位）。进壳渲染历史时一路推高，收件箱增量以它为界。
  let lastRenderedAt = '';

  function clearFeed() {
    const feed = feedEl();
    if (!feed) return;
    parkAvatar();   // W2-3 陷阱：不先送回头部，头像会跟着被清掉的那一行一起消失
    while (feed.firstChild) feed.removeChild(feed.firstChild);
  }

  // 124 还债④（40 号文 §8.5 ④）：问候语那枚「打开这一件」挑哪一条，与右栏「现在这一件」是**同一个
  // 问题**，所以走**同一份纯函数** —— thread-facts.js 的 focusThreadFor（等你 ＞ 在跑 ＞ 最近发生的
  // 那一件；unit 真值表 ＋ focus-rail B1 两道锁）。服务端 13q 修前自己也挑一条回在 `visit.focus` 里，
  // 且第三档与这边不一样（它的行序把 dispatching 顶在「其余」之前），现在它只投影 `visit.threads`。
  // 本文件恰有【一处】调用它：下面 renderDigest 与 enterVisit 的「什么都没有」判据都读这个出口。
  function visitFocusOf(visit) {
    return focusThreadFor(visit && Array.isArray(visit.threads) ? visit.threads : []);
  }

  function renderDigest(visit) {
    const items = (visit.digest && Array.isArray(visit.digest.items) ? visit.digest.items : []).slice(0, STEWARD_DIGEST_MAX);
    // 一句问候 ＋ 「你不在的这段时间里有 N 件事」（§8.9「每次打开」；确定性文案，不调模型）。
    // 两句各自一段：中英的句间分隔规矩不同（中文句号后不空格、英文要空一格），拼字符串必然在
    // 某一种语言下出错，交给排版而不是交给 i18n 值里的空白。
    const row = appendSteward(t('stewardShell.chat.greeting'), '');
    if (row) {
      row.appendChild(el('p', 'steward-say', items.length
        ? t('stewardShell.chat.digest', { count: items.length })
        : t('stewardShell.chat.digestNone')));
    }
    if (row && items.length) {
      const list = el('ul', 'steward-digest');
      // §2.4 文字预算：每条 ≤20 字（全文在左栏与焦点栏里，这里只是「有这几件」）。
      for (const item of items) {
        // 123-M2（37 号文 §3.5）：承诺三项带 {key, params} —— 它们是本波新加的行，从一开始就走目录。
        // 既有六类只有服务端拼好的 text（116f 起就是那样，本刀不动它们；那笔 i18n 债单独登记），
        // 所以这里是「有 key 用 key，没有就照旧」，不是两套渲染。
        const full = (item && item.key) ? t(item.key, item.params || {}) : String((item && item.text) || '');
        const line = el('li', 'steward-digest-item', stewardDigestItemText(full));
        if (full && line.textContent !== full) line.title = full;
        list.appendChild(line);
      }
      row.appendChild(list);
    }
    const acts = [];
    const focus = visitFocusOf(visit);
    if (focus && focus.sessionId) {
      acts.push({
        kind: 'open_thread', sessionId: String(focus.sessionId), primary: true,
        // UX-F5：按钮全文与线程名分开带 —— 回执读后者。
        sessionTitle: String(focus.title || focus.sessionId),
        label: t('stewardShell.chat.openFocus', { title: stewardShortTitle(focus.title || focus.sessionId) }),
      });
    }
    // 122-L1b（§2.13）：向导还没走完就在问候行下多一枚「开始引导」。位置在「知道了」之前
    // ——K6b 的 `.steward-acts ≤2` 预算由 renderActs 的 slice 执行，所以有焦点线程时被切掉的
    // 是最后那枚「知道了」（表态可以不点，配置没配完却是新用户此刻唯一该做的事）。
    for (const act of onboardingActs()) acts.push(act);
    acts.push({ kind: 'dismiss', label: t('stewardShell.chat.gotIt') });
    renderActs(row, acts);
  }

  // 「开始引导」那一枚（零到一枚）。两个入口共用同一份判据与同一份文案：
  // 号文只点了 renderDigest，但**真正的新用户走的是 renderFirstRun** —— 全新 HOME 第一次进壳时
  // 没有待决、没有焦点、摘要也是空的，enterVisit 的 `nothing` 分支画的是首跑那条自我介绍
  // （renderDigest 一次都不会跑）。只钉 renderDigest 等于这枚按钮对新装的人不存在，
  // 所以两处都挂（执行者证伪，见交付报告；32 号文 §4 纪律 1）。
  function onboardingActs() {
    if (typeof openOnboardingWizard !== 'function') return [];
    if (!stewardOnboardingPending(state && state.config)) return [];
    return [{ kind: STEWARD_ONBOARDING_ACT, label: t('onboarding.wizard.start') }];
  }

  function renderPending(pending) {
    for (const item of (Array.isArray(pending) ? pending : [])) {
      if (!item || !item.sessionId) continue;
      const row = appendSteward(String(item.summary || ''), t('stewardShell.chat.pendingWhy', { type: String(item.type || '') }));
      renderActs(row, [{
        kind: 'open_thread', sessionId: String(item.sessionId), primary: true,
        sessionTitle: String(item.title || item.sessionId),   // UX-F5：同上
        label: t('stewardShell.chat.openThread'),
      }, { kind: 'dismiss', label: t('stewardShell.chat.gotIt') }]);
    }
  }

  // 首次：一句自我介绍 ＋ 三个可点例子（点了即填入输入框，不自动发送，§8.9 第一条）。
  function renderFirstRun() {
    const row = appendSteward(t('stewardShell.chat.intro'), '');
    if (!row) return;
    const box = el('div', 'steward-examples');
    for (const key of ['stewardShell.chat.example1', 'stewardShell.chat.example2', 'stewardShell.chat.example3']) {
      const text = t(key);
      box.appendChild(button('steward-example', text, () => {
        const input = byId('stewardComposerInput');
        if (!input) return;
        input.value = text;
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }));
    }
    row.appendChild(box);
    // 122-L1b（§2.13）：全新一台机器第一次进管家壳走的就是这一支 —— 引导入口必须在这里，
    // 否则「新装默认落管家视角」的人一辈子看不见它（见 onboardingActs 的头注）。
    renderActs(row, onboardingActs());
  }

  // 只渲染 at >= visit.startedAt 的回合（§8.9「上次对话不显示，已归档进行动流水」）。会话消息带
  // createdAt（02-session-store 的既有字段），助手消息上的 steward 字段是该回合的结构化回复。
  function renderHistorySince(messages, startedAt) {
    const cut = Date.parse(String(startedAt || ''));
    const floor = Number.isFinite(cut) ? cut : 0;
    let rendered = 0;
    // 117s-C：上一条【收件箱】系统消息里写着这一回合是被哪条线程叫醒的（stewardEventLine 的
    // 「线程「X」(id)」）。它自己不上屏，但它的来源要跟着下一条管家回复走。
    let inboxSource = null;
    // 117s-H2：同一条消息里还写着「线程第 N 回合跑完了」——交付卡据此挑对那一回合的原文。
    let inboxTurnSeq = 0;
    for (const message of (Array.isArray(messages) ? messages : [])) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const at = Date.parse(String(message.createdAt || ''));
      if (Number.isFinite(at) && at < floor) continue;
      // 117j W2-4：记住「已经画到哪一条」的水位。ISO 8601 是定长 UTC 串，字典序即时间序。
      const stampAt = String(message.createdAt || '');
      if (stampAt && stampAt > lastRenderedAt) lastRenderedAt = stampAt;
      // 123-N1 ③ 防御：同一条消息（按 createdAt 认身份）在屏上只画一次。水位是【第一道】闸，
      // 这是第二道 —— 水位万一没推上去（老回执、对齐那一发也失败、两处增量抢跑），这里兜住，
      // 不至于整段历史再来一遍（用户 2026-09-13 看到的就是这个）。
      if (stampAt && feedHasCreatedAt(stampAt)) continue;
      if (message.role === 'user') {
        // 收件箱触发的回合没有「用户的话」：那条 user 消息是系统事件，落盘在 meta.origin='inbox'
        // 上（09-workflow 的 messageMeta），不是用户本人说的，不该在对话流里冒充成用户气泡。
        if (message.meta && message.meta.origin === 'inbox') {
          inboxSource = stewardInboxSource(String(message.content || ''));   // 117s-C：只取来源，正文照旧不上屏
          inboxTurnSeq = stewardInboxTurnSeq(String(message.content || ''));   // 117s-H2：顺手取回合号
          continue;
        }
        const userRow = appendUser(String(message.content || ''));
        if (userRow && stampAt) userRow.dataset.createdAt = stampAt;   // 123-N1 ③：给这一行盖上身份
        rendered += 1;
        continue;
      }
      const stamp = (message.steward && typeof message.steward === 'object') ? message.steward : null;
      const row = appendSteward(String((stamp && stamp.say) || message.content || ''), stamp ? stamp.why : '',
        stamp ? actionWhyLines(stamp.actions) : []);
      // 124-P3：回放这条路也要有可见回执 —— 刷新一次页面就看不见「它到底做成了没有」，
      // 等于兜底只兜了一半（与 123-P1 ① 那条 contractIncomplete 回执同一条纪律）。
      // 落盘的章正是第三态 no_receipt 的用武之地：老回合／被截断的行可能压根没有 result。
      if (stamp) appendActionReceipts(row, stamp.actions);
      if (row && stampAt) row.dataset.createdAt = stampAt;   // 123-N1 ③：给这一行盖上身份
      // 117s-C：只有 trigger==='inbox' 的回合才加小头。落盘的 stamp 里【没有】来源线程 id
      // （13h 只盖了 'user'/'inbox' 这一个字面量），所以来源取自上一条收件箱消息；它也没有时
      // 退到「本回合真开／真续的那条线程」（executedThreadSessionId）；两个都没有就不加。
      // 117s-H4：新回合的 stamp.trigger 是对象 { kind, sessionId?, title?, turnSeq? }，老回合是
      // 'user'/'inbox' 字符串；stewardTriggerInfo 把两种都归一（回执优先，抠行法留作老回合的回落）。
      const trigger = stewardTriggerInfo(stamp);
      // 117v-V1 ③（用户第十轮走查③「为啥最上面那不像设计图那样，一个一个小胶囊代表一个个线程」）：
      // executedThreadSessionId 认的是【这一回合真执行成功的开线程工具】，它对 inbox 与 user 两种
      // 回合一样成立 —— 117s-C 却把它连同线程卡一起关在 inbox 这一支里。于是「用户问一句、管家
      // 当场开了一条线程」那一轮长不出线程卡（121-K4-3 之前，线程卡还是频道条 chip 的唯一来源；
      // 频道条退役之后，它仍然是「这一轮到底开了哪条线程」在对话流里的唯一回执）。这里把它放出来：
      // 来源仍按「回执 > 收件箱事件行 > 本回合真开的那条」的老次序取，只是最后那一档不再限于 inbox。
      const executed = stamp ? executedThreadSessionId(stamp.actions) : '';
      const executedSource = executed ? { sessionId: executed, title: '' } : null;
      const opening = trigger.kind === 'inbox'
        ? ((trigger.sessionId ? { sessionId: trigger.sessionId, title: trigger.title } : null)
          || inboxSource || executedSource)
        : executedSource;
      if (opening) {
        attachSource(row, opening);
        // F1：线程卡。同一条线程连着的几条合成一张（色条＋卡头），管家本人的话不进这一支。
        // 排在交付卡【之前】：卡头要插在来源小头前面，而交付卡是插在话后面的，两者互不挤位。
        attachThreadCard(row, { ...opening, turnSeq: trigger.turnSeq || inboxTurnSeq });
        // 117s-H2 的交付卡【不】跟着放出来 —— 边界就钉在这一行：交付卡说的是「它交付的原文」，
        // 而管家刚开的那条线程这一回合还没跑完、根本没有交付，放出来只会给每一条用户回合垫一句
        // 「这一次没取到原文」。（顺带纠一处口径：它并不多发请求 —— 卡头与交付卡 await 的是
        // loadDeliverable 同一个被缓存的 promise，键是 sessionId|turnSeq，V9 钉着这件事。所以
        // 拦住它的理由是【没有可显示的东西】，不是省一发请求。）
        if (trigger.kind === 'inbox') attachDeliverable(row, { ...opening, turnSeq: trigger.turnSeq || inboxTurnSeq });
      }
      inboxSource = null;
      inboxTurnSeq = 0;
      // 123-P1 ②（38 号文；与 ① 同一次真机走查翻出来的伴生 bug，独立存在）：回放**只画导航类**。
      // 修前这里是 `renderActs(row, stamp.acts)` —— 落盘的 acts 整份重画。而落盘的章里【没有】
      // 「这一枚点过没有」的记录，于是「知道了」这类表态、以及 tool 那种一次性动作，用户点完
      // 已经落成灰字回执了，刷新一次页面或切一次视角，它们全部原样复活，看上去像从没点过。
      // 裁决出处是 117v-V1 ②（上面 isNavigationAct 的头注，用户第十轮走查②）：**导航不是表态**
      // —— open_thread 没有任何副作用、从 2.0 视窗回来还要再点同一枚，它本来就该反复点；
      // dismiss／tool 是一次性的，点完这一枚就该消失。同一条裁决在 runAct 里管「点完落不落回执」，
      // 在这里管「回放要不要重画」，判据是同一个 isNavigationAct，不新造第二张表。
      if (stamp) renderActs(row, (Array.isArray(stamp.acts) ? stamp.acts : []).filter(isNavigationAct));
      // 123-P1 ①：契约不完整那一轮的灰字系统回执，回放这条路也要有（live 在 finishReply 里）。
      // 用户刷新一次页面就看不见「这一轮它什么都没做」，等于兜底只兜了一半。
      if (stamp && stamp.contractIncomplete === true) appendContractReceipt(row);
      rendered += 1;
    }
    return rendered;
  }

  // 117j W2-4（用户走查⑤「收件箱触发的回复不进对话流」）：线程跑完 → 收件箱唤醒管家 → 管家回了一句，
  // 而屏幕上一个字都不变 —— 那条回复只落在会话文件里，对话流却只在【进壳】那一刻渲染过一次历史。
  // 这里按 116-4 新加的 「?since=」 拉增量（整份拉一条长会话是几百 KB 的重复载荷），只画比已画过的
  // 最后一条更新的那些。去重口径是 createdAt：「?since=」 在服务端已按它过滤，这里只需记住水位。
  // 123-N1 ③：这条 createdAt 的消息是不是【已经在屏上】。逐行比 dataset 而不是拼一条属性选择器
  // ——  createdAt 是从服务端来的字符串，拼进选择器就是一处 CSS 注入面；行数本来就有界，逐行比更便宜
  // 也更诚实。data-created-at 由 renderHistorySince 与 finishReply 两处唯一地盖上。
  function feedHasCreatedAt(stampAt) {
    const feed = feedEl();
    if (!feed || !stampAt) return false;
    for (const node of feed.querySelectorAll('.steward-msg')) {
      if (node.dataset && node.dataset.createdAt === stampAt) return true;
    }
    return false;
  }

  // 123-N1 ①的退路：回执没带 createdAt（老服务端、或落盘时刻读不到）时，拉一发与 appendSince
  // 【同一条】增量，但**只推水位不画**——本回合的话此刻就在屏上（finishReply 刚画完），再画一遍
  // 正是要治的那个病。失败一律沉默：对不齐水位最坏只是下一次增量多画一遍，而 ③ 那道防御还在。
  async function alignWatermark() {
    const since = String(lastRenderedAt || visitStartedAt || '');
    if (!since) return;
    let payload = null;
    try { payload = await api('/api/sessions/steward?since=' + encodeURIComponent(since)); } catch { return; }
    const messages = (payload && payload.session && Array.isArray(payload.session.messages)) ? payload.session.messages : [];
    for (const message of messages) {
      const stampAt = String((message && message.createdAt) || '');
      if (stampAt && stampAt > lastRenderedAt) lastRenderedAt = stampAt;
    }
  }

  async function appendSince(sinceIso) {
    const since = String(sinceIso || lastRenderedAt || visitStartedAt || '');
    if (!since) return 0;
    let payload = null;
    try { payload = await api('/api/sessions/steward?since=' + encodeURIComponent(since)); } catch { return 0; }
    const messages = (payload && payload.session && Array.isArray(payload.session.messages)) ? payload.session.messages : [];
    if (!messages.length) return 0;
    const rendered = renderHistorySince(messages, since);
    if (!rendered) return 0;
    // W2-1 同款：这一轮里管家自己开／续的线程，追加完就直接展示（收件箱回合尤其需要 ——
    // 用户根本没在跟管家说话，屏幕上得自己把结果摆出来）。
    let lastStamp = null;
    for (const message of messages) {
      if (message && message.role === 'assistant' && message.steward && typeof message.steward === 'object') lastStamp = message.steward;
    }
    const opened = lastStamp ? executedThreadSessionId(lastStamp.actions) : '';
    if (opened) focusThread(opened);
    return rendered;
  }

  async function enterVisit() {
    if (visitBusy) return null;
    if (!(state && state.config && state.config.stewardEnabledV1 === true)) return null;
    if (!syncEngineGate()) { renderEngineGate(); return null; }
    visitBusy = true;
    try {
      const visit = await api('/api/steward/visit', { method: 'POST', body: JSON.stringify({}) });
      if (!visit || visit.ok !== true) return null;
      visitStartedAt = String((visit.visit && visit.visit.startedAt) || '');
      const pending = Array.isArray(visit.pending) ? visit.pending : [];
      setPresence({ pendingCount: pending.length });
      // 117j classic-4：**新到访不必去拉历史**。管家会话是懒创建的，第一次进壳时它还没落盘，
      // 这一发必然 404 —— 每次进管家壳的控制台里都躺着一条红色请求，而下面那个 newVisit 分支
      // 压根不用 messages（它画的是问候语与摘要）。既省一次往返，也不再制造假故障。
      let history = null;
      if (visit.newVisit !== true) {
        try { history = await api('/api/sessions/steward'); } catch { history = null; }
      }
      const messages = (history && history.session && Array.isArray(history.session.messages)) ? history.session.messages : [];
      clearFeed();
      lastRenderedAt = '';   // 117j W2-4：整屏重画,水位跟着归零——下面的 renderHistorySince 会把它重新推上去
      let rendered = 0;
      const nothing = !pending.length && !visitFocusOf(visit)
        && !((visit.digest && Array.isArray(visit.digest.items) ? visit.digest.items : []).length);
      if (visit.newVisit === true) {
        if (nothing) renderFirstRun();
        else { renderDigest(visit); renderPending(pending); }
        rendered = 1;
      } else {
        rendered = renderHistorySince(messages, visitStartedAt);
        // 走查 #2：一条线程、一件事都没有（全新安装、走完向导回来）时不说「你回来了。没有新事」—— 那是对老用户说的；
        // 这里仍是首跑那条自我介绍 ＋ 示例 ＋ 引导入口。
        if (!rendered) { if (nothing) renderFirstRun(); else renderDigest(visit); rendered = 1; }
      }
      return visit;
    } catch (error) {
      // 引擎不支持是唯一要当场说清楚的失败（否则用户以为管家坏了）；其它失败保持沉默，下次进壳再试。
      const visitEngineInfo = engineProblemInfo(error);
      if (visitEngineInfo) {
        showEngineProblem(async () => { visitBusy = false; await enterVisit(); }, visitEngineInfo);
      }
      return null;   // 到访失败不该让管家壳白屏：状态区已有 117a 的兜底，下次进壳再试
    } finally {
      visitBusy = false;
    }
  }

  // 一次「进壳」只到访一次。config 每次刷新都会重跑准入判定（provider-settings 的 fillSettings →
  // syncStewardShellAvailability），若那条路径直接调 enterVisit()，正在进行的对话会被反复清屏重画。
  let entered = false;
  // 走查 #1：没有能回话的模型时，到访之前先挡一道 —— 画「先接一个模型」卡、输入框置灰说明原因（enterVisit 开头）。
  // 每次 config 刷新 steward-shell 的 syncConversation 都先调一次 syncEngineGate：接上了就把「已到访」复位，
  // 紧接着那一句 ensureVisit 重新到访（ensureVisit／resetConversation 两个函数体一字不动，I7／I9 锁）。
  let engineGated = false;
  function syncEngineGate() {
    // 服务端洗过的 config 恒带 providers 数组；没有这一项＝config 还没到（或宿主只给了一份最小 config）→ 不知道，就不挡
    // （挡错了比不挡更糟：输入框被锁死。真没模型时服务端那句兜底照样说人话）。
    const cfg = state && state.config;
    const ready = !(cfg && Array.isArray(cfg.providers)) || stewardEngineReady(cfg);
    const input = byId('stewardComposerInput');
    if (input) {
      input.disabled = !ready;
      input.placeholder = t(ready ? 'stewardShell.compose.placeholder' : 'stewardShell.compose.needModel');
    }
    const send = byId('stewardComposerSend');
    if (send) send.disabled = !ready;
    if (ready && engineGated) { engineGated = false; entered = false; }   // 接上了：下面那一拍重新到访
    return ready;
  }
  function renderEngineGate() {
    engineGated = true;
    clearFeed();
    // 已经有一个 OpenAI 兼容端点、只是主模型走命令行：沿用既有那一支（「让管家用 X」一键改）。
    if (firstOpenAiProvider()) {
      showEngineProblem(async () => { syncEngineGate(); await ensureVisit(); }, { message: t('stewardShell.chat.engineNeedsOpenAi') });
      return;
    }
    const row = appendSteward(t('stewardShell.chat.needModel'), '');
    if (!row) return;
    row.appendChild(el('p', 'steward-say', t('stewardShell.chat.needModelHow')));
    renderActs(row, [{ kind: STEWARD_ONBOARDING_ACT, label: t('stewardShell.chat.connectModel'), primary: true }]);
  }
  function ensureVisit() {
    if (entered) return null;
    entered = true;
    return enterVisit();
  }

  // 离开管家壳：清倒计时（唯一的后台活动）并把「已到访」复位——下次进壳重新汇报本次。
  function resetConversation() {
    entered = false;
    stopUndoCountdown();
  }

  function bindStewardConversation() {
    const avatar = byId('stewardAvatar');
    if (avatar) {
      const menu = el('div', 'steward-menu');
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-label', t('stewardShell.chat.detailsToggle'));
      menu.hidden = true;
      // 菜单内容的写手。32 号文 §4（M2）：开合交给两壳共用的 js/popover.js 之后，Layer 模式会在开
      // 之前清空容器，所以内容得是「随叫随写」的；建菜单时先写一遍（收着的时候那些项也在 DOM 里，
      // 与改之前一致），之后每一次开由原语再写一遍 —— 顺带让「细节」那一项的 aria-pressed 每次都按
      // 当时的 detailsOn 落笔。
      function fillMenu() {
        const toggle = button('steward-menu-item', t('stewardShell.chat.detailsToggle'), () => {
          setDetails(!detailsOn);
          toggle.setAttribute('aria-pressed', detailsOn ? 'true' : 'false');
        });
        toggle.setAttribute('aria-pressed', detailsOn ? 'true' : 'false');
        menu.appendChild(toggle);
        // 117e：这一项只是「打开设置的管家页签」。注入缺席时（依赖没接上）整段不出现，
        // 菜单退回 117c 的只有「细节」。
        // 121-K7：§8.2 那句「头像本身是管家的口袋」自此由【真的口袋】兑现 —— 左栏栏底那四枚
        // （js/rail-pocket.js）。头像菜单只剩「细节」「设置」两项（§2.4／§9 K7），
        // 表在 STEWARD_MENU_SECTIONS 一处，循环一个字不改。
        if (typeof openStewardPanel === 'function') {
          for (const [labelKey, section] of STEWARD_MENU_SECTIONS) {
            menu.appendChild(button('steward-menu-item', t(labelKey), () => {
              closeMenu();   // 32 号文 §4（M2）：关菜单只有这一个入口（hidden／aria／焦点／Esc 层一起收）
              openStewardPanel(section);
            }));
          }
        }
      }
      fillMenu();
      // 117l-B2 ③（用户第五轮走查 3「为啥点 Avatar，显示面板是在最上面，怎么也得要么在下面
      // 要么在上面吧」）：117k 把菜单锚在【顶栏】下沿（.steward-menu 的 top:100%/left:0），可
      // 117j W2-3 之后头像跟着最新一条管家的话走 —— 头像在屏幕下半截、菜单还钉在最上面。
      // 现在按【头像自己】的 rect 定位（见 placeMenu），position 因此从 absolute 改成 fixed。
      // 挂点必须是 #stewardShell 而不是 #stewardHeader／body：
      //   · #stewardStage（头栏的父节点）有 backdrop-filter ＋ overflow:hidden —— 前者会给 fixed
      //     后代造出新的包含块（定位就不再相对视口了），后者会把开在舞台外的菜单直接切掉；
      //   · body 上没有管家壳的主题上下文（玻璃令牌挂在壳上），挂过去颜色会不对。
      const menuHost = byId('stewardShell');
      if (menuHost) menuHost.appendChild(menu);
      const feedForMenu = byId('stewardFeed');
      // 开的时候量一次头像的 rect：下方放得下（视口底 − 头像底 ≥ 菜单高 + 空隙）就开在头像【下方】、
      // 左缘对齐头像；放不下就开在【上方】、底缘贴住头像顶。量之前菜单必须已经不是 hidden，
      // 否则 offsetHeight 恒 0（display:none 的元素没有盒子）。
      function placeMenu() {
        const rect = avatar.getBoundingClientRect();
        const viewport = globalThis.innerHeight
          || (doc() && doc().documentElement ? doc().documentElement.clientHeight : 0) || 0;
        const height = menu.offsetHeight || 0;
        const below = (viewport - rect.bottom) >= (height + STEWARD_MENU_GAP);
        menu.style.left = `${Math.round(rect.left)}px`;
        if (below) {
          menu.style.top = `${Math.round(rect.bottom + STEWARD_MENU_GAP)}px`;
          menu.style.bottom = 'auto';
        } else {
          menu.style.top = 'auto';
          menu.style.bottom = `${Math.round(viewport - rect.top + STEWARD_MENU_GAP)}px`;
        }
        menu.dataset.place = below ? 'below' : 'above';
        return menu.dataset.place;
      }
      // 117j copy-P2-5：头像菜单加 Esc（进栈）＋ aria-controls ＋ 关掉时焦点还给头像。
      menu.id = 'stewardAvatarMenu';
      avatar.setAttribute('aria-controls', menu.id);
      avatar.setAttribute('aria-haspopup', 'menu');
      // 32 号文 §4（M2）：开合本身（Esc／点外／焦点归还锚点／同一时刻只允许一个浮层）交给两壳共用的
      // js/popover.js。菜单是【就地节点】（.steward-menu 的 fixed 定位与 [hidden] 都住在
      // steward-conversation.css 里、挂点必须是 #stewardShell），所以传 opts.layer：不新建 .popover、
      // 不外挂 body、关闭只 [hidden] = true 不 remove —— 容器、id、类名、role 一个字不改。
      // 本函数仍是「关掉我这张菜单」的唯一入口（菜单项、视口变化都调它），而且只在自己那张真开着
      // （原语记的锚点就是头像）时才动手，不会误关别人的浮层。
      let releaseMenuEscape = null;
      const closeMenu = () => {
        if (popoverAnchor() !== avatar) return false;
        closePopover();
        return true;
      };
      // 任何一条关闭路径（Esc／点外／自己关／被下一个浮层顶掉）都到这里：摘 aria、注销 Esc 层。
      // 焦点归还由原语自己做（锚点就是头像，仍是「关掉时焦点还给触发它的控件」），不在这里再来一次。
      const forgetOpenMenu = () => {
        avatar.setAttribute('aria-expanded', 'false');
        if (releaseMenuEscape) { releaseMenuEscape(); releaseMenuEscape = null; }
      };
      avatar.addEventListener('click', () => {
        if (!menuHost) return;
        popover(avatar, () => { fillMenu(); }, {
          layer: { mount: menuHost, node: menu },
          onOpen: () => {
            placeMenu();   // 117l-B2 ③：先取消 hidden 再量，量的是头像【此刻】在哪
            avatar.setAttribute('aria-expanded', 'true');
            // 117j copy-P2-4/5：管家壳的 Esc 只有 steward-shell.js 那一处监听（走 stewardEscapeStack），
            // 所以菜单照旧要 push 自己那一个关闭器 + owns —— 改走 popover 之后这条接线【不能省】：
            // 少了它就「Esc 关不掉」，或者两路各关一层。
            releaseMenuEscape = stewardEscapeStack.push(closeMenu,
              node => Boolean(node && (menu.contains(node) || avatar.contains(node))));   // 117k：点别处收回
          },
          onClose: forgetOpenMenu,
        });
      });
      // 117l-B2 ③：菜单开着时窗口大小变了、或对话流滚了一下，头像就不在原地了 —— 直接关掉，
      // 不跟着重算（跟着算要么每帧量一次，要么就会飘在离头像很远的地方）。两个监听都先看
      // menu.hidden：关着的时候它们一件事都不做（与 steward-composer 的 B2b 同一条纪律）。
      const closeMenuOnViewportChange = () => { if (!menu.hidden) closeMenu(); };
      if (globalThis.addEventListener) globalThis.addEventListener('resize', closeMenuOnViewportChange);
      if (feedForMenu) feedForMenu.addEventListener('scroll', closeMenuOnViewportChange);
      avatar.setAttribute('aria-expanded', 'false');
    }
    if (isStewardMode()) ensureVisit();
    return true;
  }

  return Object.freeze({
    bindStewardConversation,
    setPickTargetHandler,
    enterVisit,
    ensureVisit,
    syncEngineGate,   // 走查 #1：config 每次刷新由 steward-shell 先调它，再调 ensureVisit
    resetConversation,
    sendToSteward,
    handOff,
    appendUser,
    appendSteward,
    renderActs,
    setDetails,
    // 117j W2-4：壳层的状态轮询发现 lastReply 变了且 trigger==='inbox' 时调它（对话流的写口只有
    // 本模块，壳层不碰 feed 的 DOM）。
    appendSince,
    detailsEnabled: () => detailsOn,
    visitStartedAt: () => visitStartedAt,
  });
}
