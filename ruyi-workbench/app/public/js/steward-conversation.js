'use strict';

import { authHeaders } from './net.js';
import { apiErrorInfo } from './net.js';   // 117 走查：解开 api() 抛出的 JSON 信封（单独一行，J2 锁钉住上一行原样）

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
export const STEWARD_UNDO_WINDOW_MS = 10000;             // §8.12 第 3 条：10 秒撤回窄窗
export const STEWARD_DIGEST_MAX = 5;                     // §8.9：「你不在的时候」要点 ≤5 条
export const STEWARD_OPEN_THREAD_EVENT = 'steward:open-thread';   // 117d 抽屉接这一个
export const STEWARD_FOCUS_THREAD_EVENT = 'steward:focus-thread'; // 117h「现在这一件」接这一个
export const STEWARD_DETAILS_KEY = 'wcw.stewardDetails';
// 117e：头像菜单里「细节」之后的三项（人话键 → 设置页里要滚到的区块）。顺序即菜单顺序。
export const STEWARD_MENU_SECTIONS = Object.freeze([
  ['stewardShell.menu.settings', ''],
  ['stewardShell.menu.memory', 'memory'],
  ['stewardShell.menu.decisions', 'decisions'],
]);
// 主动作的视觉档只有这一个类名，且只有一处字面量 —— §8.4「主动作只有一个（金色或主色），其余安静」
// 的机械保证：想再造一个「重点按钮」就必须先改这一行，静态锁看得见。
export const STEWARD_PRIMARY_CLASS = 'is-primary';

// 工具稳定信封 → i18n 人话键（§8.4 按钮落定：result.ok===false 时按 result.error 说人话，
// 按钮行保留可重试）。表外的一律落到 errGeneric 并把原始 error 原样带出去（诚实优先）。
const STEWARD_ACT_ERROR_KEYS = Object.freeze({
  propose_required: 'stewardShell.chat.errProposeRequired',
  not_found: 'stewardShell.chat.errNotFound',
  'steward.busy': 'stewardShell.chat.errBusy',
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
  const doc = () => globalThis.document || null;
  const byId = id => (doc() ? doc().getElementById(id) : null);
  const feedEl = () => byId('stewardFeed');
  const setPresence = patch => { try { presence && presence.set && presence.set(patch); } catch { /* presence 是旁路 */ } };

  // ── 零 innerHTML 的 DOM 小工具 ────────────────────────────────────────────────
  function el(tag, className, text) {
    const node = doc().createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }
  function button(className, text, onClick) {
    const node = el('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

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

  // ── 气泡 ──────────────────────────────────────────────────────────────────────
  function appendRow(kind) {
    const feed = feedEl();
    if (!feed) return null;
    const row = el('div', `steward-msg steward-msg-${kind}`);
    feed.appendChild(row);
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
  function attachWhy(sayNode, why, extraLines) {
    const lines = [String(why || '').trim(), ...(Array.isArray(extraLines) ? extraLines : [])]
      .map(line => String(line || '').trim()).filter(Boolean);
    const trigger = button('steward-why-btn', '※');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.title = t('stewardShell.chat.whyLabel');
    trigger.setAttribute('aria-label', t('stewardShell.chat.whyLabel'));
    const pop = el('div', 'steward-why-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('stewardShell.chat.whyLabel'));
    pop.hidden = true;
    if (!lines.length) pop.appendChild(el('p', 'steward-why-line', t('stewardShell.chat.whyEmpty')));
    else for (const line of lines) pop.appendChild(el('p', 'steward-why-line', line));
    trigger.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      trigger.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
    });
    pop.addEventListener('keydown', event => {
      if (event.key === 'Escape') { pop.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); }
    });
    sayNode.appendChild(trigger);
    return pop;
  }

  function appendSteward(say, why, extraWhyLines) {
    const row = appendRow('ruyi');
    if (!row) return null;
    const sayNode = el('p', 'steward-say', String(say || ''));
    row.appendChild(sayNode);
    row.appendChild(attachWhy(sayNode, why, extraWhyLines));
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
        const key = stewardActErrorKey(result.error);
        const message = key ? t(key) : t('stewardShell.chat.errGeneric', { error: stewardErrorText(result.error) });
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
  function showEngineProblem(retry) {
    const row = appendSteward(t('stewardShell.chat.engineUnsupported'), '');
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
    if (act.kind === 'open_thread') return t('stewardShell.chat.opened', { title: String(act.label || act.sessionId || '') });
    if (act.kind === 'tool' && act.tool === 'steward_thread_continue') {
      return t('stewardShell.chat.handedOff', { title: String((act.args && act.args.sessionId) || act.sessionId || '') });
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
  let streaming = false;
  async function sendToSteward(text) {
    const message = String(text || '').trim();
    if (!message || streaming) return null;
    appendUser(message);
    streaming = true;
    setPresence({ streaming: true, phase: 'thinking' });
    const row = appendTyping();
    let sayNode = null;
    const tools = [];
    let reply = null;
    const applyDelta = chunk => {
      if (!row) return;
      if (!sayNode) {
        const dots = row.querySelector('.steward-typing');
        if (dots) row.removeChild(dots);
        sayNode = el('p', 'steward-say', '');
        row.appendChild(sayNode);
      }
      sayNode.textContent += chunk;
      const feed = feedEl();
      if (feed) feed.scrollTop = feed.scrollHeight;
    };
    try {
      const res = await fetch('/api/steward/message', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ message }),
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
      if (row && row.parentNode) row.parentNode.removeChild(row);
      // 引擎不支持（409 的 JSON 信封在 error.message 里）：一句人话＋「改用某端点／去设置」，改完自动重发。
      if (engineProblemInfo(error)) {
        showEngineProblem(() => sendToSteward(message));
        return null;
      }
      const failRow = appendSteward(t('stewardShell.chat.streamFailed'), '');
      // 「重试」是【纯前端】的重发，不是一个 act —— 所以这一行按钮手工搭，不走 renderActs（那条路
      // 会把它当 act 送去 POST /api/steward/act，白白记一条 dismiss 日志）。
      if (failRow) {
        const retryRow = el('div', 'steward-acts');
        const retryBtn = button('steward-act', t('stewardShell.chat.retry'), () => {
          if (failRow.parentNode) failRow.parentNode.removeChild(failRow);
          sendToSteward(message);
        });
        retryBtn.classList.add(STEWARD_PRIMARY_CLASS);
        retryRow.appendChild(retryBtn);
        failRow.appendChild(retryRow);
      }
      return null;
    } finally {
      streaming = false;
      setPresence({ streaming: false, phase: 'idle' });
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
        if (row.parentNode) row.parentNode.removeChild(row);
        showEngineProblem(() => sendToSteward(sourceMessage));
        return;
      }
      if (!say && node) node.textContent = stewardErrorText(reply.message || reply.error) || t('stewardShell.chat.streamFailed');
      return;
    }
    setPresence({ lastError: '' });
    renderActs(row, reply.acts);
  }

  // actions 已由后端执行或降级：不渲染为按钮，但把 executed 的回执放进 ※ 里（§8.4 表头脚注）。
  function actionWhyLines(actions) {
    const out = [];
    for (const row of (Array.isArray(actions) ? actions : [])) {
      if (!row || !row.tool) continue;
      const result = row.result;
      const okFlag = !(result && result.ok === false);
      out.push(t('stewardShell.chat.actionLine', {
        tool: String(row.tool),
        state: okFlag ? t('stewardShell.chat.actionDone') : stewardErrorText(result && result.error),
      }));
    }
    return out;
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
  function startUndoCountdown(btn, onExpire) {
    stopUndoCountdown();
    let left = Math.round(STEWARD_UNDO_WINDOW_MS / 1000);
    btn.textContent = t('stewardShell.chat.undoCountdown', { seconds: left });
    undoTimer = setInterval(() => {
      left -= 1;
      if (left > 0) { btn.textContent = t('stewardShell.chat.undoCountdown', { seconds: left }); return; }
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
    const label = String(title || sid);
    const others = (Array.isArray(hits) ? hits : []).filter(hit => hit && hit.sessionId !== sid)
      .map(hit => String(hit.title || hit.sessionId || ''));
    const row = appendSteward(t('stewardShell.chat.handedOff', { title: label }), String(reason || ''),
      others.length ? [t('stewardShell.chat.otherCandidates', { list: others.join('、') })] : []);
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
      undoBtn.textContent = t('stewardShell.chat.switchTarget');
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

  function clearFeed() {
    const feed = feedEl();
    if (!feed) return;
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
        label: t('stewardShell.chat.openFocus', { title: String(visit.focus.title || visit.focus.sessionId) }),
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
      let history = null;
      try { history = await api('/api/sessions/steward'); } catch { history = null; }
      const messages = (history && history.session && Array.isArray(history.session.messages)) ? history.session.messages : [];
      clearFeed();
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
      if (engineProblemInfo(error)) {
        showEngineProblem(async () => { visitBusy = false; await enterVisit(); });
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
      const header = byId('stewardHeader');
      if (header) header.appendChild(menu);
      avatar.addEventListener('click', () => {
        menu.hidden = !menu.hidden;
        avatar.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
      });
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
    detailsEnabled: () => detailsOn,
    visitStartedAt: () => visitStartedAt,
  });
}
