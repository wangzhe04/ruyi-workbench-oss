'use strict';

import { createQuickSwitchChips, doc, byId } from './steward-chips.js';   // 117n-M1：DOM 基础件复用（doc/byId 不再本地重复）

// 第117波 117g：「2.0 视窗」与顶部返回带（27 号文 §5 117g 行 / §8.2 L2′ / §8.13 末条）。
//
// 「2.0 视窗」不是第二个壳，就是【经典壳按该会话打开】＋一条返回带：
//   openClassicWindow(sessionId) = 记一个本次标签页内的返回标记 → applyShellMode('classic')
//                                → 注入的 openSession(sessionId) → 返回带显出来。
// 返回带 `#stewardReturnBand` 的 DOM 静态写在 index.html 的 main.chat-pane 首位（默认 hidden），
// 逻辑仍住管家壳这一侧 —— 经典壳因此【零新增状态】：
//   · 本模块不发任何请求（无 api() 调用、无 fetch），只读注入的 `state` 与 chips 控件；
//   · 不缓存 session／mission 数据：会话名跟着经典壳当前会话走（观察 #sessionTitle 的文本变化，
//     它由 session-experience.js 的 renderCurrentSession 单点写入），事项名向 117h 看板要它已经
//     取回来的那一行（missionTitleOf），拿不到就整段不显示；
//   · 快切 chip 是 steward-chips.js 的同一个工厂（抽屉、看板行、这里三处同一份数据、同一条 PATCH），
//     改了立即生效，另外两处下次渲染即一致。
//
// 返回标记存 sessionStorage（活到标签页关闭）：刷新页面仍在 2.0 视窗里，带子还在。
// 只要壳模式回到 steward（「回到管家」、设置页选择器、头像菜单、fail-closed 回退，谁干的都算），
// 这趟视窗就结束 —— 标记清掉，再切回经典时不显示带子。「整体切到 2.0」因此天然不带返回带：
// 它是从管家壳直接切走，从来没设过标记。

export const STEWARD_RETURN_STORAGE_KEY = 'wcw.stewardReturn';
export const STEWARD_FOCUS_THREAD_EVENT = 'steward:focus-thread';

export function createStewardClassicWindow({
  api = async () => null,
  state = null,
  t = key => key,
  applyShellMode = null,
  openSession = async () => {},
  missionTitleOf = () => '',
} = {}) {
  // 117n-M1：doc/byId 从 steward-chips.js import（六个消费方零本地重复定义）。

  // chip 控件本体：构造时只把注入的 api 交给它（本模块自己一次都不调），写口仍然只有 chips 那一处。
  const chips = createQuickSwitchChips({ api, t, state, onChanged: () => renderBand() });
  // chip 已经绑到哪条会话上。renderBand 只在【换了会话】时才重新喂它 —— 在带上改完权限后，
  // chip 手里的那一份是 PATCH 响应（最新），而 state.currentSession 还是打开会话时取的那一份；
  // 无条件回喂会把刚改好的值又按回旧值。换会话时照常重喂。
  let boundChipId = '';

  function markedId() {
    try { return sessionStorage.getItem(STEWARD_RETURN_STORAGE_KEY) || ''; }
    catch { return ''; }
  }
  function setMark(sessionId) {
    try { sessionStorage.setItem(STEWARD_RETURN_STORAGE_KEY, String(sessionId || '')); }
    catch { /* 无 sessionStorage 时带子只在本次切换内有效 */ }
    return sessionId;
  }
  function clearMark() {
    try { sessionStorage.removeItem(STEWARD_RETURN_STORAGE_KEY); }
    catch { /* 同上 */ }
    return '';
  }

  function currentSession() {
    return (state && state.currentSession) || null;
  }

  // 带子只画三件事实：会话名（跟当前会话）、事项名（看板行上的 missionTitle）、同一组快切 chip。
  function renderBand() {
    const band = byId('stewardReturnBand');
    if (!band) return '';
    const marked = markedId();
    band.hidden = !marked;
    const session = currentSession();
    const sessionNode = byId('stewardReturnSession');
    const missionNode = byId('stewardReturnMission');
    if (!marked) { boundChipId = ''; chips.setSession(null); return ''; }
    if (sessionNode) sessionNode.textContent = session ? String(session.title || session.id || '') : '';
    const missionTitle = session ? String(missionTitleOf(session.id) || '') : '';
    if (missionNode) { missionNode.textContent = missionTitle; missionNode.hidden = !missionTitle; }
    const id = session ? String(session.id || '') : '';
    if (id !== boundChipId) { boundChipId = id; chips.setSession(session); }
    return id;
  }

  // 入口①：看板每行「2.0」、抽屉标题旁「2.0 视窗」「看全文」「看改动」—— 全都调这一个。
  async function openClassicWindow(sessionId) {
    const id = String(sessionId || '');
    if (!id) return '';
    setMark(id);
    if (typeof applyShellMode === 'function') applyShellMode('classic');
    try { await openSession(id); } catch { /* 会话打不开时带子仍在，名字跟着经典壳当前会话走 */ }
    renderBand();
    return id;
  }

  // 入口②：「整体切到 2.0」（看板顶部与头像菜单）—— 不设标记，所以经典壳里没有返回带。
  function switchWholeShell() {
    clearMark();
    if (typeof applyShellMode === 'function') applyShellMode('classic');
    renderBand();
    return 'classic';
  }

  // 入口③：带子上的「回到管家」—— 回管家壳，并让「现在这一件」切到刚看的那条线程。
  function backToSteward() {
    const id = markedId();
    if (typeof applyShellMode === 'function') applyShellMode('steward');
    if (id && doc()) {
      try { doc().dispatchEvent(new CustomEvent(STEWARD_FOCUS_THREAD_EVENT, { detail: { sessionId: id } })); }
      catch { /* 无 CustomEvent 的宿主 */ }
    }
    return id;
  }

  function bindStewardClassicWindow() {
    const back = byId('stewardReturnBtn');
    if (back) back.onclick = () => backToSteward();
    const host = byId('stewardReturnChips');
    if (host) chips.mount(host);

    const document_ = doc();
    // 会话名跟随经典壳当前会话：#sessionTitle 的文本由 renderCurrentSession 单点写入，观察它即可，
    // 不必也不该在这里缓存一份会话。
    const title = byId('sessionTitle');
    if (globalThis.MutationObserver && title) {
      new MutationObserver(() => renderBand())
        .observe(title, { childList: true, characterData: true, subtree: true });
    }
    // 117j classic-3（经典壳回归审查 P2「返回带残留」）：**离开经典壳的任何一条路**都结束这趟视窗。
    // 修前只认「切回管家」那一条，于是从 2.0 视窗切到【预览壳】时标记还留在 sessionStorage 里 ——
    // 等下次回到经典，带子又自己冒出来，而用户这一趟根本不是从管家进来的。
    // 置标的入口仍然只有 openClassicWindow 一个（switchWholeShell 明确清标，见它的头注）。
    if (globalThis.MutationObserver && document_ && document_.documentElement) {
      new MutationObserver(() => {
        if (document_.documentElement.getAttribute('data-shell-mode') !== 'classic') clearMark();
        renderBand();
      }).observe(document_.documentElement, { attributes: true, attributeFilter: ['data-shell-mode'] });
    }
    renderBand();   // 刷新后仍在 2.0 视窗里的话，带子跟着回来
    return true;
  }

  return Object.freeze({
    bindStewardClassicWindow,
    openClassicWindow,
    switchWholeShell,
    backToSteward,
    renderBand,
    isReturning: () => Boolean(markedId()),
    chips,
  });
}
