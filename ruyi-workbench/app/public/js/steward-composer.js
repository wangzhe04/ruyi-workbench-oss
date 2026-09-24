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

import { stewardEscapeStack, doc, byId, el, isSubmitEnter } from './steward-chips.js';   // 117j UX-F3：候选列表走同一个 Esc 栈；117n-M1：DOM 基础件复用（doc/byId/el 不再本地重复）；33 号文 §4：回车发送的输入法守卫也只有那一条
// 32 号文 §4（M2）：候选列表的开合（Esc／点外／焦点归还／同一时刻只允许一个浮层）交给两壳共用的
// 浮层原语。它住在 js/popover.js，本模块只取那一套【开合】，把 3.0 自己的 .steward-target-picker
// 经 opts.layer 交给它 —— 容器、id、类名、role、[hidden] 与「就地在 .stewardComposer 里」一个字不改。
import { popover, closePopover, popoverAnchor } from './popover.js';
// F5a 收编（33 号文 §4「F5a 漏网图标」）：字形一律走全仓唯一那张 ICONS 表，本文件零 SVG path 字面量。
import { icon } from './icons.js';
// 117r-D3（用户第八轮走查②「关键词匹配……最好不要和输入框放同一行」「而且匹配的没法删掉/关掉」）：
// 线程标题截短复用【唯一那一份】实现（util.js 的 stewardShortTitle，STEWARD_TITLE_MAX=24），不在本文件里另起一份——
// 抽屉页签、灰字回执、2.0 的工具卡/工作流节点卡早就走这条口径，chip 是唯一漏掉的一处。
// 33 号文 §4：那份实现的落点从 steward-conversation.js 搬到 util.js（无状态格式化叶子），函数体逐字未改。
import { stewardShortTitle } from './util.js';
import { autoGrow, fmtBytes } from './util.js';   // 133e：输入框随内容长高（与工作台 #promptInput 同一个 autoGrow）；附件 pill 的体积
// 127-⑦（45 号文 §2-quinquies）：输入行里发送键前那枚麦克风。录音计时器、转写与回填全住 composer-voice.js ——
// 本文件「恰好一处 setTimeout、零 setInterval」的纪律（I3/I4）因此一个字不用动。
import { createComposerVoice } from './composer-voice.js';

// 121-K5（34 号文 §13.7 登记⑧）：F2 频道条那条 steward:pick-channel 的常量与监听器已删。
// K4-3 删掉了频道条与它【唯一】的生产者（steward-conversation.js 的 pickChannelTarget），此后
// 这条监听器永远不会被触发 —— 留着它不是「留了个接口」，是让后人以为手选态还有第二条来路。
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
  // 128h-J03:用户此刻看着的那条线程(右栏「现在这一件」)。预判拿它裁「继续那个」这种纯指代与并列;缺省没有焦点。
  focusThreadId = () => '',
} = {}) {
  // 117n-M1：doc/byId/el 从 steward-chips.js import（六个消费方零本地重复定义）。

  // 117i：输入框右侧两枚圆键的线条图标（原型 .ic）。
  // F5a 收编（33 号文 §4「F5a 漏网图标」）：本文件不再自带图标构造器、也不再存 path 字面量 —— 字形
  // 一律取自 icons.js 的 ICONS 表（全仓唯一词汇表；「零 innerHTML」那条纪律由它内部的
  // createElementNS 承担）。steward-icon 这个 class 仍由本文件打上：steward-conversation.css 那枚
  // 1em 尺寸规则按它命中（本轮不碰 CSS），字形尺寸/描边因此与收编前逐像素同。
  function paintGlyph(node, name) {
    const svg = icon(name, 16);
    if (!svg) return;                       // 未知名子只 console.warn，这里不塞空节点
    svg.classList.add('steward-icon');
    node.appendChild(svg);
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
  // 121-K5（34 号文 §13.7 登记⑧）：F2 频道条的那两支临时目标（channelPick / pickedBeforeChannel）
  // 随它一起退役 —— K4-3 删掉了频道条与它唯一的生产者 pickChannelTarget，此后这两支恒为 null，
  // 发完一句之后的那一行因此逐字回到修前的 `picked = null;`（当初的注释自己写明了这一点）。
  // 目标仍然只有 picked 一个（currentTarget() 一个字没改）。
  const recent = [];             // 见过的线程回忆池（@ 列表里「最近线程」那一半）
  // 127-⑦：麦克风只回填不发送 —— 它手里没有 submit，填完只派发 input（预判照常跟着走）。
  const voice = createComposerVoice({ state, t, id: 'stewardComposerVoice', input: () => byId('stewardComposerInput'), anchor: () => byId('stewardComposerSend') });

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
    // W4b（用户 2026-09-25 走查⑥「→如意 前缀 chip 含义不清」）：没有任何东西可说的那一态（不是手选、
    // 不是预判命中、也不是「另起一件／定时／会问你」那几种形态）就是【默认递给如意】——这时印一枚
    // 「→ 如意」等于把缺省值当信息印出来。收成一枚安静的「@」圆键（样式层按 .is-quiet 换皮：label 收起、
    // 「@」露出），它仍是同一枚按钮：点开候选、Tab 循环、输入 @ 三条路一个没动，aria-label 仍是「递给谁」。
    // label 的 textContent 照旧写「→ 如意」—— 读屏与既有断言读的是它，换皮不换字。
    chip.classList.toggle('is-quiet', !active && stewardTargetKey(routeKind) === 'stewardShell.compose.targetSteward');
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
    let focus = '';
    try { focus = String(focusThreadId() || ''); } catch { focus = ''; }
    const focusParam = focus ? `&focus=${encodeURIComponent(focus)}` : '';
    try { result = await api(`/api/steward/preroute?q=${encodeURIComponent(query)}${focusParam}`); }
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
  // 32 号文 §4（M2）：开合本身（Esc／点外／焦点归还／同一时刻只允许一个浮层）交给两壳共用的
  // js/popover.js。这里只留【3.0 自己的那一份事实】—— 列表是就地节点（.steward-target-picker 靠
  // .stewardComposer 定位、靠自己的 [hidden] 开合），所以走 opts.layer：不新建 .popover、不外挂
  // body、关闭只 hidden 不 remove。本函数仍是「关掉我这张列表」的唯一入口（submit／resetComposer／
  // 选项点击都调它），列表正开着（原语记的锚点就是那枚 chip）才动手，不会误关别人的浮层。
  // 焦点归还照旧：popover 归还给它收到的锚点，也就是那枚 chip。
  function closePicker() {
    if (popoverAnchor() !== byId('stewardTarget')) return false;
    closePopover();
    return true;
  }

  // 任何一条关闭路径（Esc／点外／自己 close／被下一个浮层顶掉）都到这里：摘 aria、注销 Esc 层。
  // 列表本身的 hidden 由 popover 按 layer 语义做（只藏不 remove），不必在这里再来一次。
  function forgetOpenPicker() {
    const chip = byId('stewardTarget');
    if (chip) chip.setAttribute('aria-expanded', 'false');
    if (releasePickerEscape) { releasePickerEscape(); releasePickerEscape = null; }
  }

  // 候选内容的写手：列表每次打开都由它重画一遍（原语在开之前会清空容器）。
  function fillPicker(picker) {
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
  }

  function openPicker() {
    const picker = byId('stewardTargetPicker');
    const chip = byId('stewardTarget');
    if (!picker || !chip) return;
    // 已经开着（比如话里连着打了个「@」）：只重画候选，不麻烦原语 —— 原语那一下是 toggle 语义，
    // 锚点相同就当成「再点一次」，会把列表关掉；而这里要的是「还在挑目标，候选刷新一遍」。
    if (popoverAnchor() === chip) { fillPicker(picker); return; }
    popover(chip, () => { fillPicker(picker); }, {
      layer: { mount: picker.parentNode, node: picker },
      onOpen: () => {
        chip.setAttribute('aria-expanded', 'true');
        chip.setAttribute('aria-controls', 'stewardTargetPicker');   // copy-P2-4
        // 117j UX-F3：管家壳的 Esc 只有 steward-shell.js 那一处监听（走 stewardEscapeStack），
        // 所以这张列表照旧要 push 自己那一个关闭器 + owns —— 改走 popover 之后这条接线【不能省】：
        // 少了它就「Esc 关不掉」，或者两路各关一层。
        releasePickerEscape = stewardEscapeStack.push(() => {
          if (popoverAnchor() !== chip) return false;
          closePicker();
          return true;
        // 117k：候选列表本来就有自己那条 document 监听（W2-2 加的），这里补上同款判据是为了
        // 让「所有浮层点别处就收回」这件事在【一个地方】说得清；两路都关是幂等的。
        }, node => {
          const own = byId('stewardTargetPicker');
          const trigger = byId('stewardTarget');
          return Boolean(node && ((own && own.contains(node)) || (trigger && trigger.contains(node))));
        });
      },
      onClose: forgetOpenPicker,
    });
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
    const files = attachments.splice(0, attachments.length);   // 133e：这一句带走托盘里全部附件，托盘随即清空
    renderTray();
    input.value = '';
    input.style.height = '';                                   // 133e：发完收回一行高
    input.placeholder = t('stewardShell.compose.placeholder');
    cancelPreroute();
    closePicker();
    try {
      // 117l D1：**手选的目标才直递**（那是用户明示，§8.12 第 4 条）；其余一律发给管家，预判只
      // 随 routeHint 走一趟提示（§11.9 D1「无论关键词匹配到什么，都要发给管家让它决定」）。
      // 133e：直递给线程那条路（handOff）不带附件 —— 递话走的是 relay，不是回合体；附件只在「对管家说」这条路上。
      if (target) await conversation.handOff({ sessionId: target.sessionId, title: target.title, message: text, reason: routeReason, hits: routeHits });
      else await conversation.sendToSteward(text, { routeHint: routeHintPayload(), ...(files.length ? { attachments: files } : {}) });
    } finally {
      // 手选只管这一次发送，之后自动回到「→ 如意」（§8.12 第 4 条）。
      picked = null;
      routeKind = 'steward';
      routeHits = [];
      routeReason = '';
      hintDismissed = false;     // 117r-D3 ③ 复位点之一：发完这一句，下一句的预判不该被上一句否掉的状态拦住
      renderChip();
    }
  }

  // ── 133e 附件托盘：与工作台 uploadFiles 同一条路（dataURL → /api/upload），记录形状同 04 makeAttachmentRecord ──
  const attachments = [];
  const STEWARD_ATTACH_MAX_BYTES = 90 * 1048576;
  const STEWARD_ATTACH_MAX = 12;
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
  }
  function renderTray() {
    const tray = byId('stewardAttachTray');
    if (!tray) return;
    tray.textContent = '';
    attachments.forEach((f, i) => {
      const pill = el('span', 'attachment-pill');
      pill.append(el('span', '', `${f.name} · ${fmtBytes(f.size)}`));
      const x = el('button', 'attach-x'); x.type = 'button'; x.appendChild(icon('close', 12));
      x.setAttribute('aria-label', t('chat.attachRemoveAria')); x.title = t('common.remove');
      x.onclick = () => { attachments.splice(i, 1); renderTray(); };
      pill.appendChild(x);
      tray.appendChild(pill);
    });
  }
  function note(text) { const n = byId('stewardComposerNote'); if (n) n.textContent = String(text || ''); }
  async function addFiles(files) {
    for (const file of files) {
      if (attachments.length >= STEWARD_ATTACH_MAX) { note(t('stewardShell.compose.attachMax', { n: STEWARD_ATTACH_MAX })); break; }
      if (file.size > STEWARD_ATTACH_MAX_BYTES) { note(t('toast.fileTooLarge', { p1: file.name })); continue; }
      try {
        const data = await fileToDataUrl(file);
        const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: file.name, data }) });
        if (res && res.file) { attachments.push(res.file); note(''); }
      } catch (e) { note(t('toast.uploadFail', { p1: String((e && e.message) || e) })); }
    }
    renderTray();
    const input = byId('stewardComposerInput'); if (input) input.focus();
  }

  // ── 装配：chip / picker / 「+」浮层 / 附件托盘，全部 createElement，零 innerHTML ─────────
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
    // W4b：默认态露出的那一枚「@」（is-quiet 时样式层显它、收 label）。纯装饰，可访问名在 chip 的 aria-label 上。
    const at = el('span', 'steward-target-at', '@');
    at.setAttribute('aria-hidden', 'true');
    chip.appendChild(at);
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

    // 133e（用户 2026-09-21「管家层这个加号点不了，修一下，最好复用线台类似的东西」）：「＋」不再是占位 ——
    // 与工作台 #composerMoreBtn 同款的小浮层（同一个 popover 原语、同一套 .composer-more-pop/.cm-item 样式），两项：
    //   · 添加文件：与工作台同一条路（本地读成 dataURL → POST /api/upload → 记录进附件托盘），发送时随这句话一起给
    //     /api/steward/message，服务端把它们原样交给管家回合（runSessionTurn 的 attachments，与工作台回合同一条管线）；
    //   · 另起一件：把 chip 摆成「→ 如意 · 另起一件」（就是抽屉「＋ 线程」那条路 markNewInMission('')）。
    // 技能库／压缩不进来：前者是 CLI 概念（管家线程只走 OpenAI 端点），后者管家会话自己有节流。
    const plus = el('button', 'steward-plus');
    plus.type = 'button';
    plus.id = 'stewardComposerPlus';
    plus.title = t('stewardShell.compose.plus');
    plus.setAttribute('aria-label', t('stewardShell.compose.plus'));
    plus.setAttribute('aria-haspopup', 'menu');
    paintGlyph(plus, 'plus');
    const fileInput = doc().createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.id = 'stewardComposerFile';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => { const files = [...(fileInput.files || [])]; fileInput.value = ''; void addFiles(files); });
    plus.addEventListener('click', () => {
      popover(plus, close => {
        const wrap = el('div', 'composer-more-pop');
        const attach = el('button', 'cm-item'); attach.type = 'button';
        attach.append(icon('paperclip', 16), doc().createTextNode(t('composer.attachFile')));
        attach.onclick = () => { close(); fileInput.click(); };
        const fresh = el('button', 'cm-item'); fresh.type = 'button';
        fresh.append(icon('plus', 16), doc().createTextNode(t('rail.newTask')));
        fresh.onclick = () => { close(); composerApi.markNewInMission(''); };   // 点击时 composerApi 早已建好（下面 return 的那份）
        wrap.append(attach, fresh);
        return wrap;
      }, { placement: 'top-start' });
    });

    // 117i：圆形发送键（原型 .send）。Enter 一直是主路径，这枚键只是把同一个 submit() 摆到
    // 手指够得着的地方 —— 触屏与「不知道按什么」的第一次都需要一个看得见的出口。
    const send = el('button', 'steward-send');
    send.type = 'button';
    send.id = 'stewardComposerSend';
    send.title = t('stewardShell.compose.send');
    send.setAttribute('aria-label', t('stewardShell.compose.send'));
    paintGlyph(send, 'send');   // 121-K8（§2.10.1 一套词汇表）：与工作台那枚发送同一个字形
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
    // 133e：附件托盘独占一行、在输入行上面（与工作台 #attachmentTray 同一套 pill 样式）；没附件时 :empty 收掉高度。
    const tray = el('div', 'attachment-tray steward-attach-tray');
    tray.id = 'stewardAttachTray';
    composer.insertBefore(tray, inputRow);
    composer.appendChild(fileInput);
    inputRow.appendChild(input);
    inputRow.appendChild(plus);
    inputRow.appendChild(send);
    voice.sync();   // 127-⑦：此刻 config 多半还没到，不建；到了由组合根的 syncComposerVoices() 再判

    input.disabled = false;
    input.placeholder = t('stewardShell.compose.placeholder');
    input.addEventListener('input', () => {
      autoGrow(input);                                        // 133e：多打几行就长高（上限在 CSS max-height），不再只见一行
      if (picked) return;                                     // 手选期间不再被预判改写
      const value = String(input.value || '');
      if (value.endsWith('@')) openPicker();
      schedulePreroute(value);
    });
    // 117j W2-2 那条「点列表【外】任意处收起」不再自己挂 document 监听（32 号文 §4 M2）：这件事现在
    // 归两处、共用本层下面 push 的那一份 owns 判据 —— popover 原语的捕获阶段 mousedown，以及
    // steward-shell.js 那处捕获阶段 click（stewardEscapeStack.handleOutsideClick）。两条都幂等，而且
    // 都天然满足 W2-2 那条次序要求：撤回之后的「换一条」在【别的按钮的 click 处理器里】打开列表，
    // 而那一刻（mousedown 已成过去、栈里还没有这一层）谁都还没动手，目标处理器随后才把它打开 ——
    // 不会刚开就被自己关掉（实测 G2a 曾经退化成 0 项，就是这个次序问题）。
    input.addEventListener('keydown', event => {
      // 33 号文 §4：回车发送的判据（Enter ＋ 非 Shift ＋ 非输入法组合中）全仓只有 steward-chips.js
      // 一份；这个监听器还兼管 Esc 与 Tab，所以读判据、不换整框接线。
      if (isSubmitEnter(event)) { event.preventDefault(); submit(); return; }
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
    voice.cancel();   // 127-⑦：离开管家壳时还在录的那一段直接丢弃（不转写、不回填）
    attachments.length = 0; renderTray();   // 133e：离开管家壳，托盘里没发出去的附件丢掉（已上传的文件留在 uploads 目录，与工作台同）
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

  const composerApi = Object.freeze({
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
  return composerApi;
}
