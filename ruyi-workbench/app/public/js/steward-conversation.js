'use strict';

import { authHeaders } from './net.js';
import { apiErrorInfo } from './net.js';   // 117 走查：解开 api() 抛出的 JSON 信封（单独一行，J2 锁钉住上一行原样）
// 117j copy-P1-1：工具的人话表。前端【只有这一份】（行动流水与 ※ 浮层共用）。117n-M1 重钉：
// 原来从 steward-settings.js 复用，现在改从 steward-chips.js（它是本波把这张纯常量表搬去的
// 零 import 叶子）——settings.js 接下来要反过来 import 本文件的 stewardErrorText 等函数，
// 不先切断「conversation → settings」这条边就会造出循环 import。表本身一个字没变。
import { STEWARD_TOOL_LABEL_KEYS, stewardSayFromPartial } from './steward-chips.js';
// 117n-M1：DOM 基础件 doc/byId/el/button 也从 steward-chips.js 复用（六个消费方零本地重复定义）。
import { stewardEscapeStack, doc, byId, el, button } from './steward-chips.js';   // 117j UX-F4：※ 浮层与头像菜单进 Esc 栈

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
// 同形），api() 一次性 res.json() 吃不下流。读流部分照抄 chat-stream-runtime.js 的 reader 循环
// （decoder + 按行切 + 末尾残行补发），鉴权头复用 net.js 的 authHeaders()，不另起一套 token 读取。

export const STEWARD_ACTS_MAX = 3;                       // §8.4 纪律：一次回合按钮 ≤3 个
// 117l D3（用户第四轮走查⑥「要能让用户连续发消息」）：管家在跑时用户还能接着说，第二句立刻上屏、
// 标「排队中」、按序发。上限 5 条 —— 再多就不是「连着说两句」而是刷屏，超了在输入框旁如实说一句。
export const STEWARD_SEND_QUEUE_MAX = 5;
export const STEWARD_UNDO_WINDOW_MS = 10000;             // §8.12 第 3 条：10 秒撤回窄窗
export const STEWARD_DIGEST_MAX = 5;                     // §8.9：「你不在的时候」要点 ≤5 条
export const STEWARD_OPEN_THREAD_EVENT = 'steward:open-thread';   // 117d 抽屉接这一个
export const STEWARD_FOCUS_THREAD_EVENT = 'steward:focus-thread'; // 117h「现在这一件」接这一个
export const STEWARD_DETAILS_KEY = 'wcw.stewardDetails';
// 117l-B2 ③（用户第五轮走查 3「为啥点 Avatar，显示面板是在最上面」）：头像菜单与头像之间留的空隙，
// 也是「下方还放不放得下」那个判定的余量。一处常量，两处（定位与判定）读同一个数。
export const STEWARD_MENU_GAP = 8;
// 117e：头像菜单里「细节」之后的三项（人话键 → 设置页里要滚到的区块）。顺序即菜单顺序。
export const STEWARD_MENU_SECTIONS = Object.freeze([
  ['stewardShell.menu.settings', ''],
  ['stewardShell.menu.memory', 'memory'],
  ['stewardShell.menu.decisions', 'decisions'],
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

export const STEWARD_TITLE_MAX = 24;
export function stewardShortTitle(title, max = STEWARD_TITLE_MAX) {
  const text = String(title == null ? '' : title).trim();
  const limit = Number(max) > 0 ? Number(max) : STEWARD_TITLE_MAX;
  return [...text].length > limit ? [...text].slice(0, limit).join('') + '…' : text;
}

// 工具稳定信封 → i18n 人话键（§8.4 按钮落定：result.ok===false 时按 result.error 说人话，
// 按钮行保留可重试）。表外的一律落到 errGeneric 并把原始 error 原样带出去（诚实优先）。
const STEWARD_ACT_ERROR_KEYS = Object.freeze({
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
  // 117g：菜单末项「整体切到 2.0」——把整个界面切到经典壳（不是「按会话开一扇 2.0 视窗」，
  // 所以【不】留返回带）。同样只负责调用，切壳与返回标记住 steward-classic-window.js。
  switchWholeShell = null,
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
    return Boolean(last);
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
    trigger.title = t('stewardShell.chat.whyLabel');
    trigger.setAttribute('aria-label', t('stewardShell.chat.whyLabel'));
    const pop = el('div', 'steward-why-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('stewardShell.chat.whyLabel'));
    pop.hidden = true;
    if (!whyLines.length && !doneRows.length) pop.appendChild(el('p', 'steward-why-line', t('stewardShell.chat.whyEmpty')));
    if (whyLines.length) {
      pop.appendChild(el('h4', 'steward-why-h', t('stewardShell.chat.whyHeading')));
      for (const line of whyLines) pop.appendChild(el('p', 'steward-why-line', line));
    }
    if (doneRows.length) {
      pop.appendChild(el('h4', 'steward-why-h', t('stewardShell.chat.whyDone')));
      for (const line of doneRows) pop.appendChild(el('p', 'steward-why-line', line));
    }
    // 117j UX-F4：※ 浮层的 Esc 此前挂在浮层【自己】身上 —— 点开它焦点还在触发按钮上，
    // 键盘事件根本不经过浮层，于是那条监听形同虚设。改成开的时候进 Esc 栈（栈的监听在 document 上）。
    let releaseWhyEscape = null;
    const closeWhy = () => {
      if (pop.hidden) return false;
      pop.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      try { trigger.focus(); } catch { /* 宿主没有 focus 的环境 */ }
      if (releaseWhyEscape) { releaseWhyEscape(); releaseWhyEscape = null; }
      return true;
    };
    trigger.addEventListener('click', () => {
      if (!pop.hidden) { closeWhy(); return; }
      pop.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      releaseWhyEscape = stewardEscapeStack.push(closeWhy,
        node => Boolean(node && (pop.contains(node) || trigger.contains(node))));   // 117k：点别处收回
    });
    pop.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeWhy();   // 焦点真在浮层里时的近路（栈那一路同样能关）
    });
    sayNode.appendChild(trigger);
    return pop;
  }

  function appendSteward(say, why, doneLines, extraWhyLines) {
    const row = appendRow('ruyi');
    if (!row) return null;
    moveAvatarTo(row);   // W2-3：头像永远在【最新】一条管家的话旁边
    const sayNode = el('p', 'steward-say', String(say || ''));
    row.appendChild(sayNode);
    row.appendChild(attachWhy(sayNode, why, doneLines, extraWhyLines));
    const feed = feedEl();
    if (feed) feed.scrollTop = feed.scrollHeight;
    return row;
  }

  // 灰字回执：整行按钮换成一句话（§8.4「按钮落定后」列）。
  function settleRow(actsRow, text) {
    if (!actsRow || !actsRow.parentNode) return;
    const receipt = el('p', 'steward-receipt', text);
    actsRow.parentNode.replaceChild(receipt, actsRow);
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

  async function runAct(act, actsRow, btn, onSettled) {
    if (!act || typeof act !== 'object') return;
    if (act.kind === 'dismiss' && isChangeAct(act)) { focusComposerForChange(); return; }
    if (btn) btn.disabled = true;
    try {
      const response = await api('/api/steward/act', { method: 'POST', body: JSON.stringify({ act }) });
      const result = response && response.result;
      if (result && result.ok === false) {
        // 117l-B2 ⑤：查表那一步搬进 stewardActErrorMessage（多一条 steward.queued 要插 wait.label），
        // 表外仍然落到 errGeneric 并把原始 error 原样带出去。
        const message = stewardActErrorMessage(result.error, t)
          || t('stewardShell.chat.errGeneric', { error: stewardErrorText(result.error) });
        showActProblem(actsRow, message);
        if (btn) btn.disabled = false;   // 按钮行保留可重试
        return;
      }
      settleRow(actsRow, receiptFor(act));
      if (act.kind === 'open_thread' && act.sessionId) openThread(act.sessionId);
      if (typeof onSettled === 'function') onSettled(act, response);
    } catch (error) {
      showActProblem(actsRow, t('stewardShell.chat.errGeneric', { error: stewardErrorText(error) }));
      if (btn) btn.disabled = false;
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
    const providers = (state && state.config && Array.isArray(state.config.providers)) ? state.config.providers : [];
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
    if (act.kind === 'open_thread') return t('stewardShell.chat.opened', { title: stewardShortTitle(act.sessionTitle || act.label || act.sessionId) });
    if (act.kind === 'tool' && act.tool === 'steward_thread_continue') {
      return t('stewardShell.chat.handedOff', { title: stewardShortTitle((act.args && act.args.sessionId) || act.sessionId) });
    }
    return t('stewardShell.chat.actDone', { label: String(act.label || '') });
  }

  function openThread(sessionId) {
    const detail = { sessionId: String(sessionId || '') };
    try { doc().dispatchEvent(new CustomEvent(STEWARD_OPEN_THREAD_EVENT, { detail })); } catch { /* 无 CustomEvent 的宿主 */ }
  }
  function focusThread(sessionId) {
    const detail = { sessionId: String(sessionId || '') };
    try { doc().dispatchEvent(new CustomEvent(STEWARD_FOCUS_THREAD_EVENT, { detail })); } catch { /* 同上 */ }
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

  // 输入框旁那行小字（队列满时说「先等一等」）。它与抽屉的 note 是两处，各归各的区域。
  function composerNote(text) {
    const node = byId('stewardComposerNote');
    if (node) node.textContent = String(text || '');
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
      return null;
    }
    return runSend(message, opts, null);
  }

  async function runSend(message, opts, queuedRow) {
    composerNote('');
    if (!queuedRow) appendUser(message);
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
      sayNode.textContent = say;              // 整段重写：半截信封里的 say 是会长的
      const feed = feedEl();
      if (feed) feed.scrollTop = feed.scrollHeight;
    };
    try {
      // 117l D1：routeHint 是【提示】，与用户那句话分开走（用户消息逐字不动的纪律，见 §11.9 D1
      // 与 06b 的 routeHintBlock —— 服务端只信 sessionId，标题它自己重查）。没有 hint 时不带这个键。
      const hint = (opts && opts.routeHint && typeof opts.routeHint === 'object') ? opts.routeHint : null;
      const res = await fetch('/api/steward/message', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ message, ...(hint ? { routeHint: hint } : {}) }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) takeLine(line);
      }
      takeLine(buf);
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
    void sourceMessage;
    if (!row) return;
    const say = String(reply.say || '');
    if (sayNode) { if (say) sayNode.textContent = say; }
    else {
      const dots = row.querySelector('.steward-typing');
      if (dots) row.removeChild(dots);
      row.appendChild(el('p', 'steward-say', say));
    }
    const node = row.querySelector('.steward-say');
    if (node) row.appendChild(attachWhy(node, reply.why, actionWhyLines(reply.actions)));
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
    // W2-1：回合结束即展示管家刚开的那条线程（宽屏切「现在这一件」，窄屏开抽屉——两者都接
    // steward:focus-thread）。管家的话后面仍然保留「打开」按钮，只是不必再点了。
    const opened = executedThreadSessionId(reply.actions);
    if (opened) focusThread(opened);
  }

  // actions 已由后端执行或降级：不渲染为按钮，但把 executed 的回执放进 ※ 里（§8.4 表头脚注）。
  function actionWhyLines(actions) {
    const out = [];
    for (const row of (Array.isArray(actions) ? actions : [])) {
      if (!row || !row.tool) continue;
      const result = row.result;
      const okFlag = !(result && result.ok === false);
      out.push(t('stewardShell.chat.actionLine', {
        // 116-3 copy P1-1（§8.1 原则 7）：优先用后端给的人话标签（13h 的 stewardActLabel，与「行动流水」
        // 同一批口径）。117j 补上第二道：后端没给 label 时（116-3 之前落盘的历史回合就没有），
        // 回落到【前端那份 i18n 表】而不是工具 id —— 界面上永远不该出现 `steward_thread_continue`
        // 这种内部标识符。两道都落空（表外的新工具）才用 id，那是最后的诚实兜底。
        tool: toolLabelOf(row),
        state: okFlag ? t('stewardShell.chat.actionDone') : stewardErrorText(result && result.error),
      }));
    }
    return out;
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
  function startUndoCountdown(btn, onExpire) {
    stopUndoCountdown();
    let left = Math.round(STEWARD_UNDO_WINDOW_MS / 1000);
    btn.textContent = '';
    btn.setAttribute('aria-label', t('stewardShell.chat.undo'));
    const face = el('span', 'steward-undo-face');
    face.setAttribute('aria-hidden', 'true');
    face.textContent = t('stewardShell.chat.undoCountdown', { seconds: left });
    btn.appendChild(face);
    undoTimer = setInterval(() => {
      left -= 1;
      if (left > 0) { face.textContent = t('stewardShell.chat.undoCountdown', { seconds: left }); return; }
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
    settleRow(actsRow, filesReverted > 0 ? t('stewardShell.chat.undone') : t('stewardShell.chat.undoneFilesKept'));
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
      for (const item of items) list.appendChild(el('li', 'steward-digest-item', String((item && item.text) || '')));
      row.appendChild(list);
    }
    const acts = [];
    if (visit.focus && visit.focus.sessionId) {
      acts.push({
        kind: 'open_thread', sessionId: String(visit.focus.sessionId), primary: true,
        // UX-F5：按钮全文与线程名分开带 —— 回执读后者。
        sessionTitle: String(visit.focus.title || visit.focus.sessionId),
        label: t('stewardShell.chat.openFocus', { title: stewardShortTitle(visit.focus.title || visit.focus.sessionId) }),
      });
    }
    acts.push({ kind: 'dismiss', label: t('stewardShell.chat.gotIt') });
    renderActs(row, acts);
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
  }

  // 只渲染 at >= visit.startedAt 的回合（§8.9「上次对话不显示，已归档进行动流水」）。会话消息带
  // createdAt（02-session-store 的既有字段），助手消息上的 steward 字段是该回合的结构化回复。
  function renderHistorySince(messages, startedAt) {
    const cut = Date.parse(String(startedAt || ''));
    const floor = Number.isFinite(cut) ? cut : 0;
    let rendered = 0;
    for (const message of (Array.isArray(messages) ? messages : [])) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const at = Date.parse(String(message.createdAt || ''));
      if (Number.isFinite(at) && at < floor) continue;
      // 117j W2-4：记住「已经画到哪一条」的水位。ISO 8601 是定长 UTC 串，字典序即时间序。
      const stampAt = String(message.createdAt || '');
      if (stampAt && stampAt > lastRenderedAt) lastRenderedAt = stampAt;
      if (message.role === 'user') {
        // 收件箱触发的回合没有「用户的话」：那条 user 消息是系统事件，落盘在 meta.origin='inbox'
        // 上（09-workflow 的 messageMeta），不是用户本人说的，不该在对话流里冒充成用户气泡。
        if (message.meta && message.meta.origin === 'inbox') continue;
        appendUser(String(message.content || ''));
        rendered += 1;
        continue;
      }
      const stamp = (message.steward && typeof message.steward === 'object') ? message.steward : null;
      const row = appendSteward(String((stamp && stamp.say) || message.content || ''), stamp ? stamp.why : '',
        stamp ? actionWhyLines(stamp.actions) : []);
      if (stamp) renderActs(row, stamp.acts);
      rendered += 1;
    }
    return rendered;
  }

  // 117j W2-4（用户走查⑤「收件箱触发的回复不进对话流」）：线程跑完 → 收件箱唤醒管家 → 管家回了一句，
  // 而屏幕上一个字都不变 —— 那条回复只落在会话文件里，对话流却只在【进壳】那一刻渲染过一次历史。
  // 这里按 116-4 新加的 「?since=」 拉增量（整份拉一条长会话是几百 KB 的重复载荷），只画比已画过的
  // 最后一条更新的那些。去重口径是 createdAt：「?since=」 在服务端已按它过滤，这里只需记住水位。
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
      if (visit.newVisit === true) {
        const nothing = !pending.length && !visit.focus
          && !((visit.digest && Array.isArray(visit.digest.items) ? visit.digest.items : []).length);
        if (nothing) renderFirstRun();
        else { renderDigest(visit); renderPending(pending); }
        rendered = 1;
      } else {
        rendered = renderHistorySince(messages, visitStartedAt);
        if (!rendered) { renderDigest(visit); rendered = 1; }
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
      const toggle = button('steward-menu-item', t('stewardShell.chat.detailsToggle'), () => {
        setDetails(!detailsOn);
        toggle.setAttribute('aria-pressed', detailsOn ? 'true' : 'false');
      });
      toggle.setAttribute('aria-pressed', detailsOn ? 'true' : 'false');
      menu.appendChild(toggle);
      // 117e：§8.2「头像本身是管家的口袋」。三项都只是「打开设置的管家页签并滚到那一段」，
      // 注入缺席时（依赖没接上）整段不出现，菜单退回 117c 的只有「细节」。
      if (typeof openStewardPanel === 'function') {
        for (const [labelKey, section] of STEWARD_MENU_SECTIONS) {
          menu.appendChild(button('steward-menu-item', t(labelKey), () => {
            menu.hidden = true;
            avatar.setAttribute('aria-expanded', 'false');
            openStewardPanel(section);
          }));
        }
      }
      // 117g：菜单末项「整体切到 2.0」（§5 117g 行「整体切壳走设置或头像菜单」）。它排在
      // STEWARD_MENU_SECTIONS 之后、不进那张表 —— 那三项是「打开设置的某一段」，这一项是切壳。
      if (typeof switchWholeShell === 'function') {
        menu.appendChild(button('steward-menu-item', t('stewardShell.classicWindow.switchWhole'), () => {
          menu.hidden = true;
          avatar.setAttribute('aria-expanded', 'false');
          switchWholeShell();
        }));
      }
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
      let releaseMenuEscape = null;
      const closeMenu = () => {
        if (menu.hidden) return false;
        menu.hidden = true;
        avatar.setAttribute('aria-expanded', 'false');
        try { avatar.focus(); } catch { /* 宿主没有 focus 的环境 */ }
        if (releaseMenuEscape) { releaseMenuEscape(); releaseMenuEscape = null; }
        return true;
      };
      avatar.addEventListener('click', () => {
        if (!menu.hidden) { closeMenu(); return; }
        menu.hidden = false;
        placeMenu();   // 117l-B2 ③：先取消 hidden 再量，量的是头像【此刻】在哪
        avatar.setAttribute('aria-expanded', 'true');
        releaseMenuEscape = stewardEscapeStack.push(closeMenu,
          node => Boolean(node && (menu.contains(node) || avatar.contains(node))));   // 117k：点别处收回
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
