'use strict';

import { createQuickSwitchChips, doc, byId, el, clear } from './steward-chips.js';
// 色号登记（同一条线程在对话流／左栏／焦点栏／线程头恒是同一个号）与五态判据都问【全仓那一份】要，
// 本文件一个字都不自己判：hue 在 steward-conversation.js，五态在 steward-drawer.js（33 号文 §4 收的那一处）。
import { stewardThreadHueFor, stewardThreadStateKey } from './steward-conversation.js';
import { stewardThreadStateOf } from './steward-drawer.js';
import { icon } from './icons.js';

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

const SVG_NS = 'http://www.w3.org/2000/svg';

// 来源三值（§4.1）→ 图形。界面上只用图形，悬停才出字（§2.3）。字形表与文案键与左栏那一份
// 【逐字相同】（steward-board.js 的 RAIL_ORIGIN_ICONS／RAIL_ORIGIN_KEYS）：同一件事实在两面必须
// 长同一个样子，所以不另起第二套词表（K8 把三枚专用字形补进 icons.js 时两面一起换）。
export const THREAD_ORIGIN_ICONS = Object.freeze({ steward: 'target', user: 'agents', schedule: 'bell' });
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
} = {}) {
  const chips = createQuickSwitchChips({ api, t, state, modelMenuExtras, onChanged: () => render() });
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
  // 不复制那份 <defs>：渐变 id 在整篇文档里只能有一个，所以这里只画环／身／眼睛，fill 引用
  // 管家壳里那一份（css 的 fill: url("#stewardAvatarGrad") var(--accent) 自带回落，管家壳被裁掉
  // 的离线包里它就是一个纯色圆 —— 信息不少，只是没有渐变）。
  function buildAvatar() {
    const document_ = doc();
    if (!document_) return null;
    const svg = document_.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    const ring = document_.createElementNS(SVG_NS, 'circle');
    ring.setAttribute('class', 'sa-ring');
    ring.setAttribute('cx', '50'); ring.setAttribute('cy', '50'); ring.setAttribute('r', '44');
    const body = document_.createElementNS(SVG_NS, 'circle');
    body.setAttribute('class', 'sa-body');
    body.setAttribute('cx', '50'); body.setAttribute('cy', '50'); body.setAttribute('r', '31');
    const eyes = document_.createElementNS(SVG_NS, 'g');
    eyes.setAttribute('class', 'sa-eyes');
    for (const cx of ['41.5', '58.5']) {
      const eye = document_.createElementNS(SVG_NS, 'ellipse');
      eye.setAttribute('class', 'sa-eye');
      eye.setAttribute('cx', cx); eye.setAttribute('cy', '49');
      eye.setAttribute('rx', '3.1'); eye.setAttribute('ry', '5.2');
      eyes.appendChild(eye);
    }
    svg.append(ring, body, eyes);
    return svg;
  }

  // ── 管家条（§2.5／§4.4）────────────────────────────────────────────────────────
  async function setWatch(next) {
    const id = currentId();
    if (!id || watchBusy) return null;
    watchBusy = true;
    try {
      const response = await api(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ stewardWatch: next === true }),
      });
      if (!response || response.ok !== true) return null;
      if (state && state.currentSession && String(state.currentSession.id) === id) {
        state.currentSession = response.session || state.currentSession;
      }
      // 开关翻面要在同一拍看得见：管家条画的是【索引行】上的 watched，所以写完让左栏重取一发。
      try { await refreshRows(); } catch { /* 取不到就等下一拍推送（thread.state）来刷 */ }
      render();
      return response.session || null;
    } catch { return null; }
    finally { watchBusy = false; }
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

  function render() {
    if (!doc()) return '';
    const session = currentSession();
    const id = session ? String(session.id || '') : '';
    const row = rowOf(id);
    renderIdentity(row);
    renderStewardBand(row);
    if (id !== boundChipId) { boundChipId = id; chips.setSession(session); }
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
