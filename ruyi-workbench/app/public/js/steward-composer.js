'use strict';

// 第117波 117c：管家输入区与递话（27 号文 §8.12「递话：输入即预判」逐条照做／§8.8 键盘与无障碍）。
//
// 把路由从「发出后再确认」改成「输入时就看得见」，像邮件的收件人栏：
//   ① 输入即预判：输入变化后 150ms 去抖调 GET /api/steward/preroute?q=，按 kind 更新左侧的递送目标
//      chip（请求带序号，过期响应一律丢弃——慢的那一次回来时不许覆盖新的判定）；
//   ② Enter 直接递：目标是线程时【不经管家回合】，直接 POST /api/steward/act 跑
//      steward_thread_continue；目标是如意（含 question／unsure／schedule）时走 /api/steward/message 流；
//   ③ 10 秒撤回、之后换一条：由 steward-conversation.js 的 handOff/undoHandOff 负责（回执与按钮住在
//      对话流里，不住输入区）；
//   ④ 用户随时可指定：点 chip 循环、Tab 循环、输入 @ 开候选列表；手选后 chip 实底带 ×，本次发送后
//      自动恢复「→ 如意」。
//
// 边界：零 innerHTML；预判只在管家模式且管家开关开时才发（非管家模式一律不请求，延续 117b 的门控
// 纪律）；本模块唯一的 timer 是去抖 setTimeout（一处 setTimeout ＋ 一处 clearTimeout，都锁在
// schedulePreroute/cancelPreroute 里）。

import { stewardEscapeStack, doc, byId, el } from './steward-chips.js';   // 117j UX-F3：候选列表走同一个 Esc 栈；117n-M1：DOM 基础件复用（doc/byId/el 不再本地重复）
// 117r-D3（用户第八轮走查②「关键词匹配……最好不要和输入框放同一行」「而且匹配的没法删掉/关掉」）：
// 线程标题截短复用 steward-conversation.js 的既有实现（STEWARD_TITLE_MAX=24），不在本文件里另起一份——
// 抽屉页签、灰字回执早就走这条口径，chip 是唯一漏掉的一处。
import { stewardShortTitle } from './steward-conversation.js';

export const STEWARD_PREROUTE_DEBOUNCE_MS = 150;   // §8.12 第 1 条：目标 ≤50ms 出判定，150ms 去抖不抢跑
export const STEWARD_PICKER_MAX = 8;               // 候选列表最多 8 条
export const STEWARD_RECENT_MAX = 8;               // 见过的线程做「最近线程」回忆池（零新增路由）

// kind → chip 文案键（§8.12 第 1 条五种形态；question／steward 都回落到「→ 如意」）。
const STEWARD_TARGET_KEYS = Object.freeze({
  thread: 'stewardShell.compose.targetThread',
  schedule: 'stewardShell.compose.targetSchedule',
  unsure: 'stewardShell.compose.targetUnsure',
  new: 'stewardShell.compose.targetNew',
  // 117d：抽屉「＋ 线程」按下后的形态 —— 目标仍是如意（创建经管家、委托书表单归 117e），
  // 但下一句话默认落在【当前事项】下，而不是另起一件。
  missionNew: 'stewardShell.compose.targetMissionNew',
  question: 'stewardShell.compose.targetSteward',
  steward: 'stewardShell.compose.targetSteward',
});

export function stewardTargetKey(kind) {
  return STEWARD_TARGET_KEYS[String(kind || '')] || 'stewardShell.compose.targetSteward';
}

export function createStewardComposer({
  api = async () => null,
  state = null,
  t = key => key,
  isStewardMode = () => false,
  conversation = null,
} = {}) {
  // 117n-M1：doc/byId/el 从 steward-chips.js import（六个消费方零本地重复定义）。

  // 117i：输入框右侧两枚圆键的线条图标（原型 .ic）。零 innerHTML —— SVG 也要 createElementNS，
  // 用 createElement('svg') 会造出一个 HTML 未知元素，画不出东西。
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(path) {
    const svg = doc().createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'steward-icon');
    svg.setAttribute('aria-hidden', 'true');
    const line = doc().createElementNS(SVG_NS, 'path');
    line.setAttribute('d', path);
    svg.appendChild(line);
    return svg;
  }

  // 预判实况：kind ＋ 候选（hits）。手选（picked）优先于预判，直到本次发送完成。
  let routeKind = 'steward';
  let routeHits = [];
  let routeReason = '';
  let picked = null;             // { sessionId, title } —— 用户手选的目标
  // 117r-D3 ③（用户第八轮走查②「匹配的没法删掉/关掉」）：用户点过 chip 的 × 把这次自动预判否掉之后
  // 置真——在它被复位之前，runPreroute() 拿到的响应不再写回 routeKind/routeHits/routeReason（也就不会
  // 再把 chip 从「→ 如意」翻回「像是接着『X』」）。复位三处：submit() 的 finally、resetComposer()、
  // 以及 runPreroute() 自己的空查询分支（= 输入框被清空）——见下方各处标了「117r-D3 ③」的行。
  let hintDismissed = false;
  const recent = [];             // 见过的线程回忆池（@ 列表里「最近线程」那一半）

  function rememberHits(hits) {
    for (const hit of (Array.isArray(hits) ? hits : [])) {
      if (!hit || !hit.sessionId) continue;
      const index = recent.findIndex(row => row.sessionId === hit.sessionId);
      if (index >= 0) recent.splice(index, 1);
      // 116-5b:候选列表显示的是服务端算好的 displayTitle(06i stewardPrerouteHit;判据在 02 的
      // sessionDisplayTitle)。缺席时逐字等于 title,老载荷零变化。
      recent.unshift({ sessionId: String(hit.sessionId), title: String(hit.displayTitle || hit.title || hit.sessionId) });
    }
    while (recent.length > STEWARD_RECENT_MAX) recent.pop();
  }

  // 117l D1（用户第四轮走查②「无论关键词匹配到什么，都要发给管家让它决定」）：
  // **只有 picked 才是目标**。自动预判从「目标」降级成「提示」—— 它进 routeHint 随请求走，由管家
  // 在回合里决定接着办／新开／直接答（服务端只信 sessionId，标题自己重查）。修前这里把 routeHits[0]
  // 当成目标返回，于是 submit() 走 handOff 直递：用户说「大A这周走势会怎么样」被「走势」命中美股那条
  // 线程，一句新话直接递进去，把那条线程正在等的提问 supersede 掉（§11.9.2 ①⑥ 同一起事故）。
  function currentTarget() {
    return picked;   // null = 递给如意（预判不再是目标，见 hintedThread）
  }

  // 预判命中的线程：只用来显示 chip 上那句「像是接着『X』」并组装 routeHint，永远不是递送目标。
  function hintedThread() {
    if (picked) return null;
    if (routeKind === 'thread' && routeHits.length) {
      // 117k（用户走查③）：与上面 recent／candidates 同一口径 —— 显示名优先。缺席时逐字等于 title。
      return { sessionId: String(routeHits[0].sessionId), title: String(routeHits[0].displayTitle || routeHits[0].title || routeHits[0].sessionId) };
    }
    return null;
  }

  // 随 POST /api/steward/message 一起走的提示（§11.9 D1）。前端给的文字一个字都不进提示词 ——
  // 服务端只认 sessionId，标题它自己重查；这里只带 sessionId 与命中理由，最多 3 条。
  function routeHintPayload() {
    return {
      kind: String(routeKind || 'steward'),
      hits: routeHits.slice(0, 3).map(hit => ({ sessionId: String((hit && hit.sessionId) || ''), reason: String((hit && hit.reason) || '') })),
      picked: null,
    };
  }

  function renderChip() {
    const chip = byId('stewardTarget');
    if (!chip) return;
    const label = chip.querySelector('.steward-target-label');
    const clear = chip.querySelector('.steward-target-clear');
    const target = currentTarget();
    const hint = hintedThread();
    // 117r-D3 ①（用户第八轮走查②「关键词匹配……会把输入框内容挤没」）：hintedThread() 返回的是
    // routeHits[0] 的原话，常常是用户说的一整句话——在它被塞进 chip 之前统一截短。hintedThread()
    // 每次调用都返回一个全新对象（不是共享状态），这里改它的 .title 不会影响别处。
    if (hint) hint.title = stewardShortTitle(hint.title);
    const active = Boolean(target || hint);   // 手选或自动命中，两者之一在，chip 上就有「东西可撤」
    chip.classList.toggle('is-thread', active);
    chip.classList.toggle('is-picked', Boolean(picked));
    // 117r-D3 ③（用户第八轮走查②「匹配的没法删掉/关掉」）：修前 × 只在【手选】时才出——自动预判命中
    // 的「像是接着『X』」没有任何关闭出口。判据从「只看 picked」改成「有没有东西可撤」（手选或自动命中）。
    if (clear) clear.hidden = !active;
    if (!label) return;
    // 同一条纪律的另一支：手选目标的标题也过 stewardShortTitle（这支不动 target/picked 本身——
    // picked 是持续状态，handOff() 会再读一次 title，不能在这里被悄悄改掉）。
    if (target) label.textContent = t('stewardShell.compose.targetThread', { title: stewardShortTitle(target.title) });
    else if (hint) label.textContent = t('stewardShell.compose.targetSteward.hint', { title: hint.title });
    else label.textContent = t(stewardTargetKey(routeKind));
  }

  // ── 输入即预判：去抖 ＋ 序号丢弃 ─────────────────────────────────────────────
  let debounceTimer = 0;
  let prerouteSeq = 0;
  function cancelPreroute() {
    if (!debounceTimer) return;
    clearTimeout(debounceTimer);
    debounceTimer = 0;
  }
  function schedulePreroute(text) {
    cancelPreroute();
    debounceTimer = setTimeout(() => { debounceTimer = 0; runPreroute(text); }, STEWARD_PREROUTE_DEBOUNCE_MS);
  }
  async function runPreroute(text) {
    const query = String(text || '').trim();
    // 117r-D3 ③ 复位点之一：输入框被清空 = 用户在打一句新的话，之前否掉的那次预判不该再拦后面的响应。
    if (!query) { routeKind = 'steward'; routeHits = []; routeReason = ''; hintDismissed = false; renderChip(); return; }
    if (!isStewardMode()) return;
    if (!(state && state.config && state.config.stewardEnabledV1 === true)) return;
    const seq = ++prerouteSeq;
    let result = null;
    try { result = await api(`/api/steward/preroute?q=${encodeURIComponent(query)}`); }
    catch { return; }
    if (seq !== prerouteSeq) return;   // 过期响应：慢的那一次回来时新的判定已经在屏幕上了，丢弃
    if (!result || result.ok !== true) return;
    // 117r-D3 ③：这一趟输入已经被用户点 × 否掉了——响应回来也不许再往 chip 上写，
    // 否则「关掉」只是骗人的动画，下一拍又自己变回去（用户第八轮走查②「匹配的没法删掉/关掉」）。
    if (hintDismissed) return;
    routeKind = String(result.kind || 'steward');
    routeHits = Array.isArray(result.hits) ? result.hits : [];
    routeReason = routeHits.length ? String(routeHits[0].reason || '') : '';
    rememberHits(routeHits);
    renderChip();
  }

  // ── 候选列表（点 chip／输入 @／Tab 循环共用同一份候选）────────────────────────
  // 117j W2-2：按 sessionId 去重（原有）之外再【按标题去重】—— 同一件事开过好几条线程时，
  // 候选列表里会出现三四行一模一样的字，用户没法选。同标题只留最先出现的那一条：预判命中排在
  // 回忆池前面，而预判本身已按「近期更新」加过权，所以留下的就是最近那一条。
  function candidates() {
    const out = [];
    const seen = new Set();
    const titles = new Set();
    const take = row => {
      if (!row || !row.sessionId || seen.has(row.sessionId)) return;
      const title = String(row.title || '').trim();
      if (title && titles.has(title)) { seen.add(row.sessionId); return; }
      seen.add(row.sessionId);
      if (title) titles.add(title);
      out.push({ sessionId: String(row.sessionId), title: title || String(row.sessionId) });
    };
    for (const hit of routeHits) {
      if (!hit || !hit.sessionId) continue;
      take({ sessionId: hit.sessionId, title: String(hit.displayTitle || hit.title || hit.sessionId) });
    }
    for (const row of recent) take(row);
    return out.slice(0, STEWARD_PICKER_MAX);
  }

  // 117j UX-F3：候选列表也进 Esc 栈。输入框那条 keydown 保留（焦点在里面时的近路），
  // 但焦点跑到别处（比如刚点完 chip）时，只有栈这一路收得到。
  let releasePickerEscape = null;
  function closePicker() {
    const picker = byId('stewardTargetPicker');
    if (picker) picker.hidden = true;
    const chip = byId('stewardTarget');
    if (chip) chip.setAttribute('aria-expanded', 'false');
    if (releasePickerEscape) { releasePickerEscape(); releasePickerEscape = null; }
  }

  function openPicker() {
    const picker = byId('stewardTargetPicker');
    if (!picker) return;
    while (picker.firstChild) picker.removeChild(picker.firstChild);
    const rows = candidates();
    const options = [{ sessionId: '', title: t('stewardShell.compose.targetSteward') }, ...rows];
    for (const row of options) {
      const option = el('button', 'steward-target-option', row.title);
      option.type = 'button';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(Boolean(picked && picked.sessionId === row.sessionId)));
      option.addEventListener('click', () => {
        picked = row.sessionId ? { sessionId: row.sessionId, title: row.title } : null;
        closePicker();
        renderChip();
        const input = byId('stewardComposerInput');
        if (input) input.focus();
      });
      picker.appendChild(option);
    }
    picker.hidden = false;
    const chip = byId('stewardTarget');
    if (chip) {
      chip.setAttribute('aria-expanded', 'true');
      chip.setAttribute('aria-controls', 'stewardTargetPicker');   // copy-P2-4
    }
    if (!releasePickerEscape) {
      releasePickerEscape = stewardEscapeStack.push(() => {
        const open = byId('stewardTargetPicker');
        if (!open || open.hidden) return false;
        closePicker();
        try { const back = byId('stewardTarget'); if (back) back.focus(); } catch { /* 宿主没有 focus */ }
        return true;
      // 117k：候选列表本来就有自己那条 document 监听（W2-2 加的），这里补上同款判据是为了
      // 让「所有浮层点别处就收回」这件事在【一个地方】说得清；两路都关是幂等的。
      }, node => {
        const own = byId('stewardTargetPicker');
        const trigger = byId('stewardTarget');
        return Boolean(node && ((own && own.contains(node)) || (trigger && trigger.contains(node))));
      });
    }
  }

  // Tab 在「如意 → 各候选线程」间循环（§8.8）。没有候选时不劫持 Tab，Shift+Tab 永远是正常的
  // 反向焦点移动 —— 键盘用户必须能离开输入框。
  function cycleTarget() {
    const rows = candidates();
    if (!rows.length) return false;
    const ring = [null, ...rows];
    const index = ring.findIndex(row => (row ? (picked && picked.sessionId === row.sessionId) : !picked));
    picked = ring[(index + 1) % ring.length];
    renderChip();
    return true;
  }

  // ── 发送 ────────────────────────────────────────────────────────────────────
  // 117l D3：这里【没有】「上一句还没发完就不许再发」的闸。修前那道 `sending` 守卫与
  // conversation 里的 `streaming` 守卫叠在一起，用户连着说两句时第二句被无声丢弃（走查⑥）。
  // 清空输入框仍然是发送的第一步 —— 它同时也是天然的重入保护：第二次 submit 拿到的是空串。
  async function submit() {
    const input = byId('stewardComposerInput');
    if (!input || !conversation) return;
    const text = String(input.value || '').trim();
    if (!text) return;
    const target = currentTarget();
    input.value = '';
    input.placeholder = t('stewardShell.compose.placeholder');
    cancelPreroute();
    closePicker();
    try {
      // 117l D1：**手选的目标才直递**（那是用户明示，§8.12 第 4 条）；其余一律发给管家，预判只
      // 随 routeHint 走一趟提示（§11.9 D1「无论关键词匹配到什么，都要发给管家让它决定」）。
      if (target) await conversation.handOff({ sessionId: target.sessionId, title: target.title, message: text, reason: routeReason, hits: routeHits });
      else await conversation.sendToSteward(text, { routeHint: routeHintPayload() });
    } finally {
      picked = null;             // 手选只管这一次发送，之后自动回到「→ 如意」
      routeKind = 'steward';
      routeHits = [];
      routeReason = '';
      hintDismissed = false;     // 117r-D3 ③ 复位点之一：发完这一句，下一句的预判不该被上一句否掉的状态拦住
      renderChip();
    }
  }

  // ── 装配：chip / picker / 「+」占位，全部 createElement，零 innerHTML ─────────
  function buildComposer() {
    const composer = byId('stewardComposer');
    const input = byId('stewardComposerInput');
    if (!composer || !input || byId('stewardTarget')) return false;

    const chip = el('button', 'steward-target');
    chip.type = 'button';
    chip.id = 'stewardTarget';
    chip.setAttribute('aria-haspopup', 'listbox');
    chip.setAttribute('aria-expanded', 'false');
    chip.setAttribute('aria-label', t('stewardShell.compose.targetLabel'));
    chip.appendChild(el('span', 'steward-target-label', t('stewardShell.compose.targetSteward')));
    const clear = el('span', 'steward-target-clear', '×');
    clear.hidden = true;
    chip.appendChild(clear);
    chip.addEventListener('click', event => {
      if (event.target === clear) {
        if (picked) { picked = null; renderChip(); return; }         // 手选：撤回到「未选」
        // 117r-D3 ③：自动预判也能撤——回到「→ 如意」，且这次否掉的判定不许随后续输入自己复活
        // （置 hintDismissed，三处复位见 runPreroute 的空查询分支 / resetComposer / submit 的 finally）。
        if (hintedThread()) {
          routeKind = 'steward';
          routeHits = [];
          routeReason = '';
          hintDismissed = true;
          renderChip();
        }
        return;
      }
      const picker = byId('stewardTargetPicker');
      if (picker && !picker.hidden) closePicker(); else openPicker();
    });

    const picker = el('div', 'steward-target-picker');
    picker.id = 'stewardTargetPicker';
    picker.setAttribute('role', 'listbox');
    picker.setAttribute('aria-label', t('stewardShell.compose.pick'));
    picker.hidden = true;

    const plus = el('button', 'steward-plus');
    plus.type = 'button';
    plus.id = 'stewardComposerPlus';
    plus.disabled = true;                                     // 附件／语音归后续波，本波只占位
    plus.title = t('stewardShell.compose.plus');
    plus.setAttribute('aria-label', t('stewardShell.compose.plus'));
    plus.appendChild(icon('M12 5v14M5 12h14'));

    // 117i：圆形发送键（原型 .send）。Enter 一直是主路径，这枚键只是把同一个 submit() 摆到
    // 手指够得着的地方 —— 触屏与「不知道按什么」的第一次都需要一个看得见的出口。
    const send = el('button', 'steward-send');
    send.type = 'button';
    send.id = 'stewardComposerSend';
    send.title = t('stewardShell.compose.send');
    send.setAttribute('aria-label', t('stewardShell.compose.send'));
    send.appendChild(icon('M5 12h14M13 6l6 6-6 6'));
    send.addEventListener('click', () => { submit(); });

    // 117r-D3 ②（用户第八轮走查②「最好不要和输入框放同一行，会把输入框内容挤没，要不放在输入框
    // 上面」）：chip 独占一行，挪到输入框上面；input/plus/send 三个一起挪进一个新的行容器
    // .steward-composer-row。picker 仍然是 .stewardComposer 的直接子节点、紧跟在 chip 后面——
    // 它是 position:absolute; bottom:100%（steward-conversation.css），锚点是 .steward-composer
    // 自己的 position:relative，不是 chip；新加的 inputRow【不】设 position，不会抢那个定位基准。
    const inputRow = el('div', 'steward-composer-row');
    composer.insertBefore(inputRow, input);
    composer.insertBefore(chip, inputRow);
    composer.insertBefore(picker, inputRow);
    inputRow.appendChild(input);
    inputRow.appendChild(plus);
    inputRow.appendChild(send);

    input.disabled = false;
    input.placeholder = t('stewardShell.compose.placeholder');
    input.addEventListener('input', () => {
      if (picked) return;                                     // 手选期间不再被预判改写
      const value = String(input.value || '');
      if (value.endsWith('@')) openPicker();
      schedulePreroute(value);
    });
    // 117j W2-2：点列表【外】任意处收起。挂在 document 上但只在真开着时才做事；chip 与列表
    // 自身的点击交给各自的处理器（chip 那一路是 toggle，列表那一路选完自己会 closePicker）。
    //
    // **必须用捕获阶段**：撤回之后的「换一条」是在【别的按钮的 click 处理器里】调 openPicker() 的
    // （conversation 的 pickTarget 回调）。冒泡阶段的话，那一次 click 走到 document 时列表刚被打开、
    // 而事件目标又在列表外面 —— 于是刚开就被自己关掉（实测 G2a「就地打开候选列表」变成 0 项）。
    // 捕获阶段先于目标处理器跑：那一刻列表还关着，直接早退，随后目标处理器才把它打开。
    if (doc()) {
      doc().addEventListener('click', event => {
        const open = byId('stewardTargetPicker');
        if (!open || open.hidden) return;
        const chip = byId('stewardTarget');
        const node = event && event.target;
        if (open.contains && node && open.contains(node)) return;
        if (chip && chip.contains && node && chip.contains(node)) return;
        closePicker();
      }, true);
    }
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); return; }
      if (event.key === 'Escape') { closePicker(); return; }
      if (event.key === 'Tab' && !event.shiftKey && cycleTarget()) event.preventDefault();
    });
    renderChip();
    return true;
  }

  // 离开管家壳：清去抖计时器并让过期响应作废（序号 +1），不留任何后台活动。
  function resetComposer() {
    cancelPreroute();
    prerouteSeq += 1;
    closePicker();
    picked = null;
    routeKind = 'steward';
    routeHits = [];
    routeReason = '';
    hintDismissed = false;   // 117r-D3 ③ 复位点之一：离开管家壳，否掉的状态不该带到下一次进壳
    renderChip();
  }

  function bindStewardComposer() {
    return buildComposer();
  }

  return Object.freeze({
    bindStewardComposer,
    resetComposer,
    submit,
    // 117c：撤回／换一条之后由对话流回调，把候选列表就地打开 ——「那递给谁？」问完就得让用户
    // 能立刻挑，而不是让他自己再去点 chip（§8.12 第 3 条「改递时同样先回退再递」）。
    openPicker: () => { openPicker(); const input = byId('stewardComposerInput'); if (input) input.focus(); },
    // 117d：抽屉的「＋ 线程」把输入区 chip 置为「→ 如意 · 在事项下新开」并记住目标事项。
    // 只改 chip 形态，不发请求 —— 真正的创建仍要用户说一句话、由管家的委托书完成。
    markNewInMission: missionId => {
      picked = null;
      // 117l-B2 ②：看板空态那枚「＋ 线程」没有事项可挂（一条线程都还没有），派来的 missionId 是空串。
      // 这种时候 chip 说「在事项下新开」是句假话 —— 没有那个「事项」。空 id 一律落到「另起一件」。
      routeKind = missionId ? 'missionNew' : 'new';
      routeHits = [];
      routeReason = String(missionId || '');
      renderChip();
      const input = byId('stewardComposerInput');
      if (input && typeof input.focus === 'function') input.focus();
      return routeReason;
    },
    routeState: () => ({ kind: routeKind, hits: routeHits.slice(), picked: picked ? { ...picked } : null }),
  });
}
