'use strict';

import { createQuickSwitchChips, rerenderAllQuickSwitchChips, doc, byId, el, clear, resolveEngineRoute } from './steward-chips.js';
// 色号登记（同一条线程在对话流／左栏／焦点栏／线程头恒是同一个号）与五态判据都问【全仓那一份】要，
// 本文件一个字都不自己判：hue 在 steward-conversation.js，五态在 steward-drawer.js（33 号文 §4 收的那一处）。
import { stewardThreadHueFor, stewardThreadStateKey, stewardAgoLabel } from './steward-conversation.js';
import { stewardThreadStateOf } from './steward-drawer.js';
import { icon } from './icons.js';
// 121 走查1-⑤：工作台里「改好了」这句回执的落点。管家两处宿主写 #stewardDrawerNote（那块面
// 在工作台视角是 display:none 的），工作台这一侧走全站那一份 toast —— 与退役前 2.0 模型弹层
// 的收尾（navigation-controls.js setEngineModel 末尾那一发 toast）是同一个位置、同一种材质。
import { toast } from './util.js';

// ─────────────────────────────────────────────────────────────────────────────
// thread-head.js — 工作台视角的线程头（121 波 K5，34 号文 §2.5／§3／§4.4）。
//
// 它替掉的是三样东西：117g 的「2.0 视窗」返回带（#stewardReturnBand ＋ steward-classic-window.js）、
// 顶栏那枚 #modelChip 与它的弹层、顶栏那枚 #permChip 与隐藏的 #permSelect。收掉它们的理由是
// §2.1 第 10 条「一份数据一处控件」：同一条线程的权限／模型／引擎在任一视角只画一次。修前那三枚
// 里有两枚写回语义还不一样（2.0 那枚切模型顺带改全局默认），33 号文 §0 记的就是这笔账。
//
// 本模块【不发任何取数请求】：
//   · 会话事实读组合根手里的 state.currentSession（#sessionTitle 由 session-experience.js 单点写，
//     本模块观察它的文本变化来知道「换了一条线程」—— 与退役的 classic-window 同一个手法）；
//   · 任务名／线程数／来源／管家盯没盯／谁坐着，全部向左栏已经取回来的那一行要（missionRowOf，
//     由 steward-shell.js 迟绑定到 board.missionRowFor）——不另发第二发 /api/missions；
//   · 权限／模型／引擎的控件与写口是 steward-chips.js 那一份工厂（唯一写口 PATCH /api/sessions/:id）；
//   · 本模块自己只有【一条】写：管家条那枚开关的 PATCH {stewardWatch}（§4.4 的交接）。
//
// 零计时器、零 innerHTML、零 sessionStorage。
// ─────────────────────────────────────────────────────────────────────────────

// 来源三值（§4.1）→ 图形。界面上只用图形，悬停才出字（§2.3）。字形表与文案键与左栏那一份
// 【逐字相同】（steward-board.js 的 RAIL_ORIGIN_ICONS／RAIL_ORIGIN_KEYS）：同一件事实在两面必须
// 长同一个样子，所以不另起第二套词表（K8 把三枚专用字形补进 icons.js 时两面一起换）。
export const THREAD_ORIGIN_ICONS = Object.freeze({ steward: 'originSteward', user: 'originUser', schedule: 'originSchedule' });
export const THREAD_ORIGIN_KEYS = Object.freeze({
  steward: 'rail.origin.steward',
  user: 'rail.origin.user',
  schedule: 'rail.origin.schedule',
});

// 管家条的三句话（§2.5／§4.5）。判据只有两个布尔：管家盯没盯（row.watched）、用户此刻坐没坐在
// 这条线程上（row.seatedBy === 'user'）。第三句不是新状态，是「盯着」的一个诚实补充：按 §2.1
// 第 12 条，你坐着的时候它看得见但不动手。
export function stewardBandKey(watched, seatedByUser) {
  if (!watched) return 'threadHead.steward.seeing';
  return seatedByUser ? 'threadHead.steward.watchingSeated' : 'threadHead.steward.watching';
}

// ── 124-P2 委托书（40 号文 §2 ②）────────────────────────────────────────────────
// **先说一处仓里已有的同名陷阱**：会话头上有【两个】叫 brief 的东西，它们不是一回事 ——
//   · `session.brief`      ＝ 委托书（13k steward_thread_new 落的，本节要画的就是它）；
//   · `session.threadBrief`＝ 116-5b 的线程自动摘要 `{title, gist}`（「自动给每条线程起名字」，
//     设置键 settings.steward.threadBrief，静态锁 dev-harness/thread-brief.static.e2e.js）。
// 02 的 sessionBriefOf() 两个都认（先 threadBrief 后 brief），所以名字上再多一处含糊都是债。
// 本带因此在界面侧一律叫 **commission**（#threadCommission / .thread-commission /
// threadCommission.* / thread-commission.static.e2e.js），只有读那个字段时才写 `session.brief`。
//
// 事实源【只有一处】：`session.brief` —— 管家 steward_thread_new 那一刻落盘的那份
// （13k:631 `session.brief = {schema, by:'steward', createdAt, userText, supplement, truncated, …}`，
// 经 GET /api/sessions/:id 原样随会话头下发，13d 那一行 `json({ok:true, session, …})`）。
// 三条纪律：
//   ① **零请求**（本模块的头注红线）：brief 就在 state.currentSession 上，不为它多发一发；
//   ② **零二次解析**：`supplement` 是 06i buildStewardBrief 拼好的多段人话（「目标：」「验收项：」…），
//      界面【原样印】。在前端拿正则把它拆回字段，就是第二份解析器 —— 本仓已经在「线程/会话」那条
//      正则上记过这笔账（steward-conversation.js 的 STEWARD_INBOX_* 头注）；那边是【读历史】不得不认，
//      这边没有任何不得不：拼它的人就在仓里，改了措辞两边一起改才是对的做法，而不是让界面去猜。
//   ③ **没有 brief 的线程整条带不出现**（用户自己在工作台开的线程本来就没有委托书，画一条空的
//      「暂无委托书」＝ 满栏等重灰字，§2.3「只在有话可说时出现」）。
export function threadCommissionOf(session) {
  const brief = (session && session.brief && typeof session.brief === 'object') ? session.brief : null;
  const userText = String((brief && brief.userText) || '').trim();
  if (!userText) return null;
  return {
    userText,
    supplement: String((brief && brief.supplement) || ''),
    // 132a：13k 落盘的分字段版本（goal/acceptance/context/preferences/constraints）；老线程没有 → null，带回落到 supplement 原样。
    fields: (brief && brief.fields && typeof brief.fields === 'object') ? brief.fields : null,
    createdAt: String((brief && brief.createdAt) || ''),
    by: String((brief && brief.by) || ''),
  };
}
// 132a：带里画哪几段、各叫什么。顺序即阅读顺序：验收怎么算 → 参考什么 → 偏好 → 约束。
export const THREAD_COMMISSION_SECTIONS = Object.freeze([
  ['acceptance', 'threadCommission.acceptance'],
  ['context', 'threadCommission.context'],
  ['preferences', 'threadCommission.preferences'],
  ['constraints', 'threadCommission.constraints'],
]);

// 折叠态那一行的摘录：原话折成一行再按字符（不是 UTF-16 码元 —— 别把一个 emoji 劈成两半）截断。
// 判据与 02 的 sessionFirstUserExcerpt 同形，但**不是**同一件事：那边是「这条线程叫什么」，
// 这边是「委托书第一眼说什么」，两者的长度与回落各归各家，所以不去借那一份。
export const THREAD_COMMISSION_GIST_CHARS = 42;
export function threadCommissionGist(userText, max = THREAD_COMMISSION_GIST_CHARS) {
  const line = String(userText == null ? '' : userText).replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : line;
}

export function createThreadHead({
  api = async () => null,
  t = key => key,
  state = null,
  // 左栏已经取回来的那一行（GET /api/missions）。拿不到就当没有：面包屑不出、管家条按「没盯」画。
  missionRowOf = () => null,
  // 交接写完之后让左栏重新取一发行（开关翻面要在同一拍看得见）。
  refreshRows = async () => {},
  // 如意此刻是什么态（七态，steward-presence.js 的纯投影）。小 avatar 与管家壳那张脸同一个事实源。
  presenceState = () => 'idle',
  // 121-K5（§3.1）：2.0 模型弹层独有的三件事（强度／删自定义模型／刷新与管理服务商）挂到
  // chips 模型菜单的尾部。实现住 navigation-controls.js（它们动的是全局配置），这里只转交。
  modelMenuExtras = null,
  // 121 走查1-⑤（用户 2026-09-13 走查第 5 条）：这条线程的权限／模型／引擎【真的改了】之后，
  // 经典壳那一侧还有一批读面在看 state.currentSession.engineRoute（空态「当前引擎：…」那一行、
  // #statusLine 的 title、上下文电量、composer 的引擎相关按钮）。它们的重画口都在组合根，
  // 所以这里只发一声，具体刷什么由组合根说（app.js 注入）。不传就是空操作。
  onSessionMetaChanged = () => {},
  // 124-P2（§2 ②「原件可跳」）：委托书那枚「看原件」的落点。实现住 session-experience.js
  // （长会话默认只画尾窗，第一条消息可能根本不在 DOM 里，要先走它那条「指定回落」把窗口全展开），
  // 所以这里只转交。不传就是空操作 —— 拿不到落点时按钮不出现，而不是画一枚点了没反应的。
  revealOriginal = null,
  // 132a：这条线程上管家补充现在开着没 —— 按钮的字「看原件」／「收起原件」按它写。拿不到就恒写「看原件」。
  originalOpen = null,
} = {}) {
  // 121 走查1-⑤：PATCH 回来的那一份是这条线程【最新】的会话头，而组合根手里那份还是打开线程
  // 时取的 —— 修前谁也没把它对上，于是「切了没生效」：后端与 chip 都是新的，中栏与状态行是旧的
  // （真浏览器实测 walkthrough-round1.browser 的 F3/F5/F6）。退役前 2.0 那条路（navigation-controls.js
  // 的 setEngineModel）本来就有这一步 `state.currentSession.engineRoute = engineRoute`，K5 把控件
  // 换成 chips 工厂时漏了它。**只回填这一次真会改的两样**，不整份替换 —— 组合根手里那份带着
  // messages 等现场，整份换会把它们冲掉。
  function adoptSession(next) {
    if (!next || !state) return null;
    const current = state.currentSession;
    if (!current || String(current.id || '') !== String(next.id || '')) return null;
    if ('engineRoute' in next) current.engineRoute = next.engineRoute;
    if ('permissionMode' in next) current.permissionMode = next.permissionMode;
    return current;
  }
  const chips = createQuickSwitchChips({
    api, t, state, modelMenuExtras,
    noteSink: text => toast(text, 'ok'),
    onChanged: session => {
      adoptSession(session);
      render();
      try { onSessionMetaChanged(session); } catch { /* 宿主刷新失败不该把 chip 打回旧值 */ }
    },
  });
  // chip 已经绑在哪条会话上。只在【换了会话】时重喂 —— 在 chip 上改完档之后，chip 手里那一份是
  // PATCH 响应（最新），而 state.currentSession 还是打开会话时取的那一份；无条件回喂会把刚改好的
  // 值按回旧值（117g 踩过一次，判据原样搬过来）。
  let boundChipId = '';
  let watchBusy = false;

  function currentSession() {
    return (state && state.currentSession) || null;
  }
  function currentId() {
    const session = currentSession();
    return session ? String(session.id || '') : '';
  }

  function rowOf(sessionId) {
    if (!sessionId) return null;
    try { return missionRowOf(sessionId) || null; } catch { return null; }
  }

  // ── 小 avatar（§2.5）：与管家壳那张脸【同一套类名、同一个 data-state】───────────────
  // 121-K8(§13.8 K6 ④／§13.12 K8 ④「avatar 的第二份 SVG」):这里原来手建环／主体／一对眼睛,
  // 与 index.html 里 #stewardAvatar 的内联 SVG 是同一张脸的【两份标记】—— 谁改了一处,另一处
  // 就悄悄变成另一张脸。现在收成一处:形状的唯一定义仍是 index.html 那一份,本函数只克隆它。
  //   · 为什么不是 <symbol> + <use>:七态是 `.steward-avatar[data-state=x] .sa-ring{…}` 这样
  //     从祖先选进去的规则,而 <use> 的内容在影子树里,文档 CSS 选不中 —— 换成 use 会当场丢七态。
  //   · <defs> 必须摘掉:里面那条渐变的 id 是文档级唯一,克隆一份就撞 id;.sa-body 的
  //     fill:url(#stewardAvatarGrad) 引的仍然是原件那一份,所以摘掉之后颜色照旧。
  function buildAvatar() {
    const document_ = doc();
    if (!document_) return null;
    const source = document_.querySelector('#stewardAvatar > svg');
    if (!source) return null;
    const svg = source.cloneNode(true);
    svg.removeAttribute('id');
    svg.querySelectorAll('defs').forEach(node => node.remove());
    return svg;
  }

  // ── 管家条（§2.5／§4.4）────────────────────────────────────────────────────────
  // 121-K6a（§4.4「委托一句」）：打开开关那一刻，composer 里有没有没发出去的草稿——有就当一句委托
  // 随同一发 PATCH 带走（读 #promptInput，与 wcw.draft 那份持久化同一个元素）；带走之后清空，
  // 不留在输入框里变成「发了一半的话」。关开关（next!==true）不读、不清——那不是交接动作。
  function takeComposerDraftNote() {
    const document_ = doc();
    const input = document_ ? document_.getElementById('promptInput') : null;
    const value = input && typeof input.value === 'string' ? input.value.trim() : '';
    if (!value) return { note: '', clear: () => {} };
    return {
      note: value.slice(0, 200),
      clear: () => {
        input.value = '';
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 缺 Event 构造器的环境不致命 */ }
        try { globalThis.localStorage?.removeItem('wcw.draft'); } catch { /* 本机偏好不可用不影响本次交接 */ }
      },
    };
  }

  // 128f（workbench-thread-head E4c 负载复现，E4C-DIAG：第二下点击零 PATCH、开关弹回「没盯」）：修前「忙」一直占到
  // 写完之后那一发【读】（重取行）也回来 —— 负载下那一发要几秒，这几秒里再点一下被静默吞掉，原生复选框自己翻了面、
  // 随后那次 render 又把它翻回去，用户看到的是「点了没反应」。「忙」只挡并发的【写】：PATCH 一回来就放开；
  // 被挡下或写失败的那一下立刻按行重画，开关不许停在一个没发生的状态上。
  async function setWatch(next) {
    const id = currentId();
    if (!id || watchBusy) { render(); return null; }
    const turningOn = next === true;
    const draft = turningOn ? takeComposerDraftNote() : { note: '', clear: () => {} };
    watchBusy = true;
    let response = null;
    try {
      response = await api(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ stewardWatch: turningOn, ...(turningOn && draft.note ? { stewardWatchNote: draft.note } : {}) }),
      });
    } catch { response = null; }
    finally { watchBusy = false; }
    if (!response || response.ok !== true) { render(); return null; }
    if (turningOn && draft.note) draft.clear();
    if (state && state.currentSession && String(state.currentSession.id) === id) {
      state.currentSession = response.session || state.currentSession;
    }
    // 开关翻面要在同一拍看得见：管家条画的是【索引行】上的 watched，所以写完让左栏重取一发。
    try { await refreshRows(); } catch { /* 取不到就等下一拍推送（thread.state）来刷 */ }
    render();
    return response.session || null;
  }

  function renderStewardBand(row) {
    const band = byId('threadStewardBand');
    if (!band) return '';
    const id = currentId();
    band.hidden = !id;
    if (!id) return '';
    const watched = Boolean(row && row.watched === true);
    const seated = Boolean(row && String(row.seatedBy || '') === 'user');
    const key = stewardBandKey(watched, seated);
    const avatarHost = byId('threadStewardAvatar');
    if (avatarHost) {
      avatarHost.classList.add('steward-avatar');
      avatarHost.dataset.state = String(presenceState() || 'idle');
      if (!avatarHost.firstChild) {
        const svg = buildAvatar();
        if (svg) avatarHost.appendChild(svg);
      }
    }
    const text = byId('threadStewardText');
    if (text) text.textContent = t(key);
    const toggle = byId('threadStewardWatch');
    if (toggle) {
      toggle.checked = watched;
      toggle.disabled = false;
      if (!toggle.dataset.bound) {
        toggle.dataset.bound = '1';
        toggle.onchange = () => { void setWatch(toggle.checked === true); };
      }
    }
    band.dataset.watched = watched ? '1' : '0';
    return key;
  }

  // ── 第一行：色条 ＋「任务 › 线程」＋ 五态 ＋ 来源 ──────────────────────────────
  function renderIdentity(row) {
    const head = byId('threadHead');
    const id = currentId();
    if (head) {
      if (id) head.dataset.threadHue = String(stewardThreadHueFor(id));
      else delete head.dataset.threadHue;
    }
    // 面包屑只在【多线程任务】时出现（§2.5：单线程任务只印一个名）。线程数读索引行上的
    // threadCount —— 左栏按 missionId 归组用的就是这一份事实，不在这里数第二遍。
    const mission = byId('threadMission');
    if (mission) {
      const title = row ? String(row.missionTitle || '') : '';
      const many = Boolean(row) && Number(row.threadCount || 0) > 1 && Boolean(title);
      mission.textContent = many ? title : '';
      mission.hidden = !many;
    }
    const pill = byId('threadState');
    if (pill) {
      // 五态人话查【全仓那一张词表】（117u-G1 的 STEWARD_THREAD_STATE_KEYS ＋ stewardThreadStateKey）：
      // 本仓已经四次栽在「第二份枚举」上，所以这里既不自己拼键名也不抄一张表。
      const value = row ? String(stewardThreadStateOf(row) || '') : '';
      const stateKey = stewardThreadStateKey(value);
      pill.textContent = stateKey ? t(stateKey) : '';
      pill.dataset.state = value;
      pill.hidden = !value;
    }
    const origin = byId('threadOrigin');
    if (origin) {
      const value = row ? String(row.origin || '') : '';
      const name = THREAD_ORIGIN_ICONS[value] || '';
      clear(origin);
      origin.hidden = !name;
      if (name) {
        // F5a 纪律：图标永远带可访问名，且不作为唯一信号 —— 悬停出字，读屏能问到。
        origin.title = t(THREAD_ORIGIN_KEYS[value]);
        origin.setAttribute('aria-label', origin.title);
        const glyph = icon(name, 13);
        if (glyph) origin.appendChild(glyph);
      }
    }
    return id;
  }

  // ── 委托书带（§2 ②）：线程头【下面第一条】系统消息 ────────────────────────────
  // iso → 人话走 stewardAgoLabel（全仓那一个出口，与抽屉卡头、124-P1 的验收徽标同一句话）；
  // 算不出来就整格不说，不吐一串 ISO 给人读。
  function commissionWhenLabel(iso) {
    const at = String(iso || '');
    if (!at) return '';
    const page = doc() && doc().documentElement ? doc().documentElement.lang : '';
    return stewardAgoLabel(at, page);
  }

  // 「谁在跑」：只在这条线程【真有自己的】 engineRoute 时才印模型 —— 那正是管家按档位派模型时
  // stewardApplyThreadTier 写下的那一笔（13q）。跟随全局时不印（§11.15.2 病 3：印默认值＝没印，
  // 墨量却与正文争重心），只说「如意管家交办」。生效路由查 steward-chips 那一份 resolveEngineRoute
  // —— 全仓唯一那条「会话级 ＞ 全局回落」，这里不再判第二遍。
  function commissionRunnerText(session, brief) {
    const by = brief.by === 'steward' ? t('threadCommission.bySteward') : '';
    const pinned = session && session.engineRoute && typeof session.engineRoute === 'object';
    const model = pinned ? String(resolveEngineRoute(session, (state && state.config) || null).model || '') : '';
    if (by && model) return t('threadCommission.runnerModel', { by, model });
    if (by) return t('threadCommission.runner', { by });
    return model ? t('threadCommission.runnerModelOnly', { model }) : '';
  }

  function collapseCommission() {
    const body = byId('threadCommissionBody');
    const toggle = byId('threadCommissionToggle');
    const band = byId('threadCommission');
    if (body) body.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (band) band.dataset.open = '0';
  }

  function renderCommission(session, switched) {
    const band = byId('threadCommission');
    if (!band) return '';
    if (switched) collapseCommission();
    const brief = threadCommissionOf(session);
    band.hidden = !brief;
    if (!brief) return '';
    const gist = byId('threadCommissionGist');
    if (gist) gist.textContent = threadCommissionGist(brief.userText);
    const when = byId('threadCommissionWhen');
    if (when) {
      const label = commissionWhenLabel(brief.createdAt);
      when.textContent = label ? t('threadCommission.startedAt', { when: label }) : '';
      when.hidden = !label;
    }
    const goal = byId('threadCommissionGoal');
    if (goal) goal.textContent = brief.userText;                 // 用户原话【逐字】，零改写
    // 132a：有分字段（13k 落盘的 brief.fields）就按字段画列表；老线程没有它就回落到 <pre> 原样（零二次解析，两条路都不拆人话）。
    const sections = byId('threadCommissionSections');
    const fields = brief.fields;
    const sectionRows = fields ? THREAD_COMMISSION_SECTIONS.map(([key, labelKey]) => [labelKey, Array.isArray(fields[key]) ? fields[key].map(x => String(x || '')).filter(Boolean) : []]).filter(([, rows]) => rows.length) : [];
    if (sections) {
      clear(sections);
      for (const [labelKey, rows] of sectionRows) {
        const field = doc().createElement('div'); field.className = 'tc-field tc-section';
        const label = doc().createElement('span'); label.className = 'tc-field-label'; label.textContent = t(labelKey);
        const list = doc().createElement('ul'); list.className = 'tc-list';
        for (const text of rows) { const li = doc().createElement('li'); li.textContent = text; list.appendChild(li); }
        field.append(label, list);
        sections.appendChild(field);
      }
      sections.hidden = !sectionRows.length;
    }
    const supplementField = byId('threadCommissionSupplementField');
    const supplement = byId('threadCommissionSupplement');
    if (supplement) supplement.textContent = brief.supplement;   // 管家补充【原样】，零二次解析
    if (supplementField) supplementField.hidden = Boolean(sectionRows.length) || !brief.supplement.trim();
    const count = byId('threadCommissionCount');
    if (count) {
      const n = fields && Array.isArray(fields.acceptance) ? fields.acceptance.length : 0;
      count.textContent = n ? t('threadCommission.count', { count: n }) : '';
      count.hidden = !n;
    }
    const runner = byId('threadCommissionRunner');
    if (runner) {
      const text = commissionRunnerText(session, brief);
      runner.textContent = text;
      runner.hidden = !text;
    }
    const original = byId('threadCommissionOriginal');
    if (original) {
      original.hidden = typeof revealOriginal !== 'function';
      const syncOriginal = () => {
        const open = typeof originalOpen === 'function' && originalOpen(session ? session.id : '') === true;
        original.textContent = t(open ? 'threadCommission.originalHide' : 'threadCommission.original');
        original.setAttribute('aria-pressed', open ? 'true' : 'false');
      };
      syncOriginal();
      if (!original.dataset.bound) {
        original.dataset.bound = '1';
        original.onclick = () => { try { revealOriginal(); } catch { /* 跳不过去不该把这一带打回不可用 */ } syncOriginal(); };
        // 用户直接点气泡里那个折叠块的 summary 时，按钮的字也要跟着变（session-experience 派 ruyi:original-toggled）。
        const messages = byId('messages');
        if (messages) messages.addEventListener('ruyi:original-toggled', syncOriginal);
      }
    }
    const toggle = byId('threadCommissionToggle');
    const body = byId('threadCommissionBody');
    if (toggle && body && !toggle.dataset.bound) {
      toggle.dataset.bound = '1';
      toggle.onclick = () => {
        const open = body.hidden;
        body.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        band.dataset.open = open ? '1' : '0';
      };
    }
    return brief.userText;
  }

  function render() {
    if (!doc()) return '';
    const session = currentSession();
    const id = session ? String(session.id || '') : '';
    const row = rowOf(id);
    renderIdentity(row);
    renderStewardBand(row);
    // 换了线程就把委托书收回折叠态：展开与否是【这一条】线程的读法，不该跟着人跑到下一条上去
    // （chip 那一行同款判据，共用 boundChipId 这一个「换没换会话」的事实，不另记第二个游标）。
    renderCommission(session, id !== boundChipId);
    if (id !== boundChipId) { boundChipId = id; chips.setSession(session); }
    // 128f-⑫（审计 C）：没换会话时修前 chip 一笔都不重画 —— 可 chip 上「跟随全局」那一档显示的是全局默认，设置页存完、
    // 引导向导存完（组合根 onEngineConfigChanged → 本函数）它就该换字。所有实例一起按当前配置重画（纯文本，零请求）。
    else rerenderAllQuickSwitchChips();
    return id;
  }

  function bindThreadHead() {
    const host = byId('threadChips');
    if (host) chips.mount(host);
    // 换会话的信号：#sessionTitle 的文本由 session-experience.js 的 renderCurrentSession 单点写入，
    // 观察它即可 —— 不必也不该在这里缓存第二份会话，更不必给组合根加第二条接线（117g 的先例）。
    const title = byId('sessionTitle');
    if (globalThis.MutationObserver && title) {
      new MutationObserver(() => render())
        .observe(title, { childList: true, characterData: true, subtree: true });
    }
    render();
    return true;
  }

  return Object.freeze({
    bindThreadHead,
    render,
    chips,
    // 只读句柄：当前这条线程的管家条说的是哪一句（真夹具按它断言三态，不去猜文案）。
    bandKey: () => {
      const row = rowOf(currentId());
      return stewardBandKey(Boolean(row && row.watched === true), Boolean(row && String(row.seatedBy || '') === 'user'));
    },
    // 124-P2 只读句柄：这条线程有没有委托书、原话是哪一句（真夹具按它断言，不去猜版面文案）。
    brief: () => threadCommissionOf(currentSession()),
  });
}
