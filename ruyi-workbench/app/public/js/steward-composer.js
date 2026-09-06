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

export const STEWARD_PREROUTE_DEBOUNCE_MS = 150;   // §8.12 第 1 条：目标 ≤50ms 出判定，150ms 去抖不抢跑
export const STEWARD_PICKER_MAX = 8;               // 候选列表最多 8 条
export const STEWARD_RECENT_MAX = 8;               // 见过的线程做「最近线程」回忆池（零新增路由）

// kind → chip 文案键（§8.12 第 1 条五种形态；question／steward 都回落到「→ 如意」）。
const STEWARD_TARGET_KEYS = Object.freeze({
  thread: 'stewardShell.compose.targetThread',
  schedule: 'stewardShell.compose.targetSchedule',
  unsure: 'stewardShell.compose.targetUnsure',
  new: 'stewardShell.compose.targetNew',
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
  const doc = () => globalThis.document || null;
  const byId = id => (doc() ? doc().getElementById(id) : null);

  function el(tag, className, text) {
    const node = doc().createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  // 预判实况：kind ＋ 候选（hits）。手选（picked）优先于预判，直到本次发送完成。
  let routeKind = 'steward';
  let routeHits = [];
  let routeReason = '';
  let picked = null;             // { sessionId, title } —— 用户手选的目标
  const recent = [];             // 见过的线程回忆池（@ 列表里「最近线程」那一半）

  function rememberHits(hits) {
    for (const hit of (Array.isArray(hits) ? hits : [])) {
      if (!hit || !hit.sessionId) continue;
      const index = recent.findIndex(row => row.sessionId === hit.sessionId);
      if (index >= 0) recent.splice(index, 1);
      recent.unshift({ sessionId: String(hit.sessionId), title: String(hit.title || hit.sessionId) });
    }
    while (recent.length > STEWARD_RECENT_MAX) recent.pop();
  }

  function currentTarget() {
    if (picked) return picked;
    if (routeKind === 'thread' && routeHits.length) {
      return { sessionId: String(routeHits[0].sessionId), title: String(routeHits[0].title || routeHits[0].sessionId) };
    }
    return null;   // null = 递给如意
  }

  function renderChip() {
    const chip = byId('stewardTarget');
    if (!chip) return;
    const label = chip.querySelector('.steward-target-label');
    const clear = chip.querySelector('.steward-target-clear');
    const target = currentTarget();
    chip.classList.toggle('is-thread', Boolean(target));
    chip.classList.toggle('is-picked', Boolean(picked));
    if (clear) clear.hidden = !picked;
    if (!label) return;
    label.textContent = target
      ? t('stewardShell.compose.targetThread', { title: target.title })
      : t(stewardTargetKey(routeKind));
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
    if (!query) { routeKind = 'steward'; routeHits = []; routeReason = ''; renderChip(); return; }
    if (!isStewardMode()) return;
    if (!(state && state.config && state.config.stewardEnabledV1 === true)) return;
    const seq = ++prerouteSeq;
    let result = null;
    try { result = await api(`/api/steward/preroute?q=${encodeURIComponent(query)}`); }
    catch { return; }
    if (seq !== prerouteSeq) return;   // 过期响应：慢的那一次回来时新的判定已经在屏幕上了，丢弃
    if (!result || result.ok !== true) return;
    routeKind = String(result.kind || 'steward');
    routeHits = Array.isArray(result.hits) ? result.hits : [];
    routeReason = routeHits.length ? String(routeHits[0].reason || '') : '';
    rememberHits(routeHits);
    renderChip();
  }

  // ── 候选列表（点 chip／输入 @／Tab 循环共用同一份候选）────────────────────────
  function candidates() {
    const out = [];
    const seen = new Set();
    for (const hit of routeHits) {
      if (!hit || !hit.sessionId || seen.has(hit.sessionId)) continue;
      seen.add(hit.sessionId);
      out.push({ sessionId: String(hit.sessionId), title: String(hit.title || hit.sessionId) });
    }
    for (const row of recent) {
      if (seen.has(row.sessionId)) continue;
      seen.add(row.sessionId);
      out.push(row);
    }
    return out.slice(0, STEWARD_PICKER_MAX);
  }

  function closePicker() {
    const picker = byId('stewardTargetPicker');
    if (picker) picker.hidden = true;
    const chip = byId('stewardTarget');
    if (chip) chip.setAttribute('aria-expanded', 'false');
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
    if (chip) chip.setAttribute('aria-expanded', 'true');
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
  let sending = false;
  async function submit() {
    const input = byId('stewardComposerInput');
    if (!input || sending || !conversation) return;
    const text = String(input.value || '').trim();
    if (!text) return;
    const target = currentTarget();
    sending = true;
    input.value = '';
    input.placeholder = t('stewardShell.compose.placeholder');
    cancelPreroute();
    closePicker();
    try {
      // 目标是线程 → 直接递（不经管家回合）；如意／会问你／定时一律发给管家（§8.12 第 2、5 条：
      // 分不出高下时由管家出那句二选一；定时意图在 119 到位前由管家自答或另起一件）。
      if (target) await conversation.handOff({ sessionId: target.sessionId, title: target.title, message: text, reason: routeReason, hits: routeHits });
      else await conversation.sendToSteward(text);
    } finally {
      sending = false;
      picked = null;             // 手选只管这一次发送，之后自动回到「→ 如意」
      routeKind = 'steward';
      routeHits = [];
      routeReason = '';
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
      if (event.target === clear && picked) { picked = null; renderChip(); return; }
      const picker = byId('stewardTargetPicker');
      if (picker && !picker.hidden) closePicker(); else openPicker();
    });

    const picker = el('div', 'steward-target-picker');
    picker.id = 'stewardTargetPicker';
    picker.setAttribute('role', 'listbox');
    picker.setAttribute('aria-label', t('stewardShell.compose.pick'));
    picker.hidden = true;

    const plus = el('button', 'steward-plus', '+');
    plus.type = 'button';
    plus.id = 'stewardComposerPlus';
    plus.disabled = true;                                     // 附件／语音归后续波，本波只占位
    plus.title = t('stewardShell.compose.plus');
    plus.setAttribute('aria-label', t('stewardShell.compose.plus'));

    composer.insertBefore(chip, input);
    composer.insertBefore(picker, input);
    composer.insertBefore(plus, input.nextSibling);

    input.disabled = false;
    input.placeholder = t('stewardShell.compose.placeholder');
    input.addEventListener('input', () => {
      if (picked) return;                                     // 手选期间不再被预判改写
      const value = String(input.value || '');
      if (value.endsWith('@')) openPicker();
      schedulePreroute(value);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); return; }
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
    routeState: () => ({ kind: routeKind, hits: routeHits.slice(), picked: picked ? { ...picked } : null }),
  });
}
