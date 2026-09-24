'use strict';

import { createQuickSwitchChips, rerenderAllQuickSwitchChips, doc, byId, clear } from './steward-chips.js';
// 色号登记（同一条线程在对话流／左栏／焦点栏／线程头恒是同一个号）与五态判据都问【全仓那一份】要，
// 本文件一个字都不自己判：hue 在 steward-conversation.js，五态在 steward-drawer.js（33 号文 §4 收的那一处）。
import { stewardThreadHueFor, stewardThreadStateKey } from './steward-conversation.js';
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
  // 2026-09-24：「回到管家」—— 切回管家视角并把焦点落在这条线程上（实现住 steward-shell.js：
  // 切视角仍只经 applyShellMode 一处写）。不注入就不画这枚钮（没有去处的按钮是假按钮）。
  backToSteward = null,
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
    renderBackToSteward(band);
    return key;
  }

  // 2026-09-24（用户：「或许有按钮的话默认直接打开工作台里的对应线程也行」的回程）：管家条末尾那枚
  // 「回到管家」。它长在管家条里而不是顶栏 —— 顶栏分段钮是【全局视角开关】（切回管家不换焦点，
  // §2.7「每个视角记住自己的现场」，one-workbench-frame K6 钉着）；这一枚说的是「回管家，看这条」，
  // 两个语义两枚钮。零 innerHTML：一枚字形（lensSteward，avatar 的最简形）＋ 一句人话，建一次复用。
  function renderBackToSteward(band) {
    if (!band) return null;
    let button = band.querySelector('.th-back-steward');
    if (typeof backToSteward !== 'function') { if (button) button.remove(); return null; }
    if (!button) {
      const document_ = doc();
      if (!document_) return null;
      button = document_.createElement('button');
      button.type = 'button';
      button.className = 'th-back-steward';
      button.id = 'threadBackToStewardBtn';
      const glyph = icon('lensSteward', 13);
      if (glyph) button.appendChild(glyph);
      button.appendChild(document_.createElement('span'));
      button.onclick = () => { try { backToSteward(currentId()); } catch { /* 视角切不过去由 shell-mode 自己回退 */ } };
      band.appendChild(button);
    }
    const label = t('threadHead.backToSteward');
    const text = button.querySelector('span');
    if (text && text.textContent !== label) text.textContent = label;
    if (button.title !== label) { button.title = label; button.setAttribute('aria-label', label); }
    return button;
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

  function render() {
    if (!doc()) return '';
    const session = currentSession();
    const id = session ? String(session.id || '') : '';
    const row = rowOf(id);
    renderIdentity(row);
    renderStewardBand(row);
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
  });
}
