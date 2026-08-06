'use strict';

// EC-D 第60波：Workbench DAG 领域（视图状态、原生 Claude Agent 投影、画布与右板）。
import { state } from './state.js';
import { $, el, fmtTokens, toast } from './util.js';
import { t } from './i18n.js';

export function createWorkbenchDomain({
  agentRunActive = new Set(),
  poolGraceHintMs = 60000,
  getActiveTurn = () => null,
  agentRunStatusLabel = status => String(status || ''),
  poolStatusLabel = status => String(status || ''),
  poolDecide = async () => {},
  nodeDisplayStatus = node => String(node && node.status || ''),
  agentStatusIcon = () => '○',
  fmtDuration = value => String(value || 0),
  runElapsedMs = () => 0,
  agentEngineBadge = () => null,
  agentRunAction = async () => {},
  steerAgentNode = async () => {},
  openToolPane = () => {},
  switchTab = () => {},
  syncAgentRunsPolling = () => {},
  scheduleRender = () => {},
} = {}) {
  const AGENT_RUN_ACTIVE = agentRunActive;
  const POOL_GRACE_HINT_MS = poolGraceHintMs;

/* ============================================================
   UI v3 P3a「工作台」全宽只读画布视图(设计稿 docs/UI-DESIGN-P3-WORKBENCH.md §5;视觉基线
   docs/mockups/p3-workbench-r2.html + R2-NOTES)。P3a 只读范围:
     · 主视图状态机 switchMainView(data-main-view=chat|canvas,localStorage 记忆)
     · 顶部 run chips(复用 /api/agent-runs 轮询数据;live 脉动点 + 待批准池徽标)
     · 只读 DAG 画布:零依赖分层布局(layoutWorkbenchDAG 纯函数,记忆化 DFS + 环保护)
       + SVG 三次贝塞尔连线(源状态着色 + r2 userSpaceOnUse 方向渐变 + 源实点/靶空环端口)
       + 节点卡 220×88(状态徽标/引擎徽标/模型/活动行/迭代条·门 verdict,渗透语言与 P2 同族)
     · 底部用量迷你条(累计 tokens/成本/时长,大数字仪表;点击跳右栏用量页)
     · 空态引导卡 + 节点点击跳右栏监控卡高亮。交互(右板/插话/审批/缩放)留 P3b。
   所有不可信文本走 el()/textContent,绝不 innerHTML(XSS 纪律)。
   ============================================================ */
// 画布布局常量(§5.2 伪码)。V_GAP 取伪码值 64(r2 建议 72 属「需评审」项,未落地伪码,故不采,见交付报告)。
const WB_NODE_W = 220, WB_NODE_H = 88, WB_H_GAP = 48, WB_V_GAP = 64, WB_PAD = 32;

// 纯函数:零依赖分层布局。输入 nodes 数组(含 id / dependsOn),输出 {id:{x,y,cx,layer}}。
// 记忆化 DFS 拓扑分层(层号 = 1 + max(依赖层号),无依赖 = 0)+ 环保护(成环回退层 0,防御编辑器已禁的环);
// 层内按 nodes 原序均布、居中对称(稳定不抖动);只认存在的依赖(忽略悬空/自指)。复杂度 O(V+E)。
function layoutWorkbenchDAG(nodes) {
  const list = Array.isArray(nodes) ? nodes.filter(n => n && n.id != null) : [];
  const byId = new Map(list.map(n => [n.id, n]));
  const layer = new Map();
  function computeLayer(id, visiting) {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return 0;                     // 环保护:成环节点回退层 0
    visiting.add(id);
    const node = byId.get(id);
    const deps = (node && Array.isArray(node.dependsOn) ? node.dependsOn : []).filter(d => byId.has(d) && d !== id);
    const L = deps.length ? 1 + Math.max(...deps.map(d => computeLayer(d, visiting))) : 0;
    visiting.delete(id);
    layer.set(id, L);
    return L;
  }
  for (const n of list) computeLayer(n.id, new Set());
  // 层内分组(保持原序 → 稳定不抖动)。
  const byLayer = new Map();
  for (const n of list) { const L = layer.get(n.id); if (!byLayer.has(L)) byLayer.set(L, []); byLayer.get(L).push(n); }
  let maxWidth = 0;
  for (const arr of byLayer.values()) { const w = arr.length * WB_NODE_W + (arr.length - 1) * WB_H_GAP; if (w > maxWidth) maxWidth = w; }
  const centerX = WB_PAD + maxWidth / 2;
  const pos = {};
  for (const L of [...byLayer.keys()].sort((a, b) => a - b)) {
    const arr = byLayer.get(L); const n = arr.length;
    const rowW = n * WB_NODE_W + (n - 1) * WB_H_GAP;
    const x0 = centerX - rowW / 2;
    const y = WB_PAD + L * (WB_NODE_H + WB_V_GAP);
    for (let i = 0; i < n; i++) { const x = x0 + i * (WB_NODE_W + WB_H_GAP); pos[arr[i].id] = { x, y, cx: x + WB_NODE_W / 2, layer: L }; }
  }
  return pos;
}
// preview/调试可及(同 window.state 兼容层):供 eval 单测直接调分层函数断言层号/坐标。
try { window.layoutWorkbenchDAG = layoutWorkbenchDAG; } catch { /* ignore */ }

// P3a 视图状态(§5.3)。selectedRunId 决定画布画哪个 run;lastRuns 缓存最近一次轮询数据供切视图即时重绘;
// posCache 按 run 记忆布局(拓扑签名不变则复用坐标 → 状态/进度变化时节点不抖动)。
// v3 P3b 追加交互态:zoom(画布缩放挡位)/panelOpen(右板三段折叠记忆,轮询重绘不丢)/sideOpen(窄屏抽屉开合)。
const wbState = { view: 'chat', selectedRunId: null, selectedNodeId: null, persistedRuns: [], lastRuns: [], posCache: {}, zoom: 1, panelOpen: { detail: true, pool: true, mail: true }, detailExpand: { task: false, result: false }, sideOpen: false };
try { window.wbState = wbState; } catch { /* ignore */ } // preview/调试可及(同 window.state 兼容层)
// Claude CLI's native Agent calls are not workbench-managed workflow runs, but the parent stream exposes
// an honest parent→child relationship and lifecycle. Keep a small read-only in-memory projection so they
// are visible in the DAG without pretending that Ruyi controls their internal nodes or dependencies.
const nativeClaudeDagRuns = new Map(); // sessionId -> run[] (latest first, max 8)
function wbNativeClaudeSessionRuns(sessionId) {
  if (!sessionId) return [];
  if (!nativeClaudeDagRuns.has(sessionId)) nativeClaudeDagRuns.set(sessionId, []);
  return nativeClaudeDagRuns.get(sessionId);
}
function wbNativeClaudeHydratedRuns(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  const runs = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const records = message && Array.isArray(message.nativeAgents) ? message.nativeAgents : [];
    if (!records.length) continue;
    let parentTask = t('workflow.nativeClaude.parentTask');
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j] && messages[j].role === 'user') { parentTask = messages[j].content || parentTask; break; }
    }
    const turnSeq = Number(message.turnSeq) || 0;
    const createdAt = records.map(r => r && r.startedAt).find(Boolean) || message.createdAt || new Date().toISOString();
    const completedAt = records.map(r => r && r.completedAt).filter(Boolean).sort().pop() || message.createdAt || createdAt;
    const nodes = [{
      id: 'claude-parent',
      roleId: 'claude-parent',
      roleLabel: t('workflow.nativeClaude.parentRole'),
      task: parentTask,
      result: message.content || '',
      engine: 'claude',
      status: message.source === 'aborted' ? 'interrupted' : 'succeeded',
      startedAt: createdAt,
      completedAt,
      dependsOn: [],
      progressLog: [{ at: completedAt, text: message.source === 'aborted' ? t('workflow.nativeClaude.parentFailed') : t('workflow.nativeClaude.parentCompleted') }],
    }];
    for (const record of records) {
      if (!record || !record.toolUseId) continue;
      const status = record.ok === true ? 'succeeded' : (record.interrupted || record.status === 'interrupted' ? 'interrupted' : 'failed');
      nodes.push({
        id: String(record.toolUseId),
        roleId: record.roleId || 'general-purpose',
        roleLabel: record.roleLabel || record.roleId || t('workflow.nativeClaude.childRole'),
        task: record.task || '',
        result: record.result || '',
        error: record.ok === true ? '' : (record.result || t('workflow.nativeClaude.failed')),
        engine: 'claude',
        status,
        startedAt: record.startedAt || createdAt,
        completedAt: record.completedAt || completedAt,
        dependsOn: ['claude-parent'],
        progressLog: [{ at: record.completedAt || completedAt, text: status === 'succeeded' ? t('workflow.nativeClaude.completed') : (status === 'interrupted' ? t('workflow.nativeClaude.interrupted') : t('workflow.nativeClaude.failed')) }],
      });
    }
    const failed = nodes.some(n => n.status === 'failed' || n.status === 'interrupted');
    if (failed) nodes[0].status = message.source === 'aborted' ? 'interrupted' : 'failed';
    runs.push({
      id: `claude-native-history-${session.id}-${turnSeq || i}`,
      title: t('workflow.nativeClaude.runTitle'),
      turnSeq,
      status: failed ? (message.source === 'aborted' ? 'interrupted' : 'failed') : 'succeeded',
      live: false,
      nativeClaude: true,
      readOnly: true,
      createdAt,
      completedAt,
      updatedAt: completedAt,
      taskPool: [],
      messages: [],
      nodes,
    });
  }
  return runs.reverse().slice(0, 8);
}
function wbNativeClaudeMergedRuns(persisted) {
  const sid = state.currentSession && state.currentSession.id;
  const observed = wbNativeClaudeSessionRuns(sid);
  const observedTurns = new Set(observed.map(r => Number(r.turnSeq) || 0).filter(Boolean));
  const history = wbNativeClaudeHydratedRuns(state.currentSession).filter(r => !r.turnSeq || !observedTurns.has(r.turnSeq));
  return [...observed, ...history, ...(Array.isArray(persisted) ? persisted : [])];
}
function wbNativeClaudeProgress(node, text, at) {
  if (!node || !text) return;
  if (!Array.isArray(node.progressLog)) node.progressLog = [];
  const last = node.progressLog[node.progressLog.length - 1];
  if (!last || last.text !== text) node.progressLog.push({ at: at || new Date().toISOString(), text });
  if (node.progressLog.length > 24) node.progressLog = node.progressLog.slice(-24);
}
function wbNativeClaudeEnsureRun(sessionId) {
  const turn = getActiveTurn(sessionId);
  if (!turn) return null;
  const runs = wbNativeClaudeSessionRuns(sessionId);
  let run = turn.nativeDagRunId && runs.find(r => r.id === turn.nativeDagRunId);
  if (run) return run;
  const startedAt = new Date(turn.startedAt || Date.now()).toISOString();
  const runId = `claude-native-${sessionId}-${turn.startedAt || Date.now()}`;
  run = {
    id: runId,
    title: t('workflow.nativeClaude.runTitle'),
    status: 'running',
    live: true,
    nativeClaude: true,
    readOnly: true,
    turnSeq: Number(state.currentSession && state.currentSession.turnSeq) || 0,
    createdAt: startedAt,
    updatedAt: startedAt,
    taskPool: [],
    messages: [],
    nodes: [{
      id: 'claude-parent',
      roleId: 'claude-parent',
      roleLabel: t('workflow.nativeClaude.parentRole'),
      task: turn.message || t('workflow.nativeClaude.parentTask'),
      engine: 'claude',
      status: 'running',
      startedAt,
      dependsOn: [],
      progressLog: [{ at: startedAt, text: t('workflow.nativeClaude.parentStarted') }],
    }],
  };
  turn.nativeDagRunId = runId;
  runs.unshift(run);
  if (runs.length > 8) runs.splice(8);
  return run;
}
function wbNativeClaudeRefresh() {
  const merged = wbNativeClaudeMergedRuns(wbState.persistedRuns);
  wbState.lastRuns = merged;
  wbUpdateActivityDot(merged);
  if (wbState.view === 'canvas') renderWorkbench(merged);
}
function wbNativeClaudeOnSubagent(evt, sessionId) {
  if (!evt || evt.native !== true || evt.engine !== 'claude' || !sessionId) return;
  const run = wbNativeClaudeEnsureRun(sessionId);
  if (!run) return;
  const nodeId = String(evt.id || evt.subagentId || '');
  if (!nodeId) return;
  let node = run.nodes.find(n => n.id === nodeId);
  if (evt.state === 'start' && !node) {
    const at = new Date().toISOString();
    node = {
      id: nodeId,
      roleId: evt.roleId || 'general-purpose',
      roleLabel: evt.roleLabel || evt.roleId || t('workflow.nativeClaude.childRole'),
      task: evt.task || '',
      engine: 'claude',
      model: evt.model || '',
      status: 'running',
      startedAt: at,
      dependsOn: ['claude-parent'],
      progressLog: [{ at, text: t('workflow.nativeClaude.childStarted') }],
    };
    run.nodes.push(node);
  }
  if (!node) return;
  const at = new Date().toISOString();
  if (evt.type === 'subagent_progress' || evt.state === 'background') {
    node.status = 'running';
    wbNativeClaudeProgress(node, evt.note || (evt.state === 'background' ? t('workflow.nativeClaude.background') : t('workflow.nativeClaude.running')), at);
  } else if (evt.state === 'end') {
    node.status = evt.ok === true ? 'succeeded' : (evt.interrupted || evt.status === 'interrupted' ? 'interrupted' : 'failed');
    node.completedAt = at;
    node.result = evt.result || '';
    if (evt.ok !== true) node.error = evt.result || t('workflow.nativeClaude.failed');
    wbNativeClaudeProgress(node, evt.ok === true ? t('workflow.nativeClaude.completed') : (node.status === 'interrupted' ? t('workflow.nativeClaude.interrupted') : t('workflow.nativeClaude.failed')), at);
  }
  run.updatedAt = at;
  wbNativeClaudeRefresh();
}
function wbNativeClaudeFinalize(sessionId, resultEvt) {
  const turn = getActiveTurn(sessionId);
  if (!turn || !turn.nativeDagRunId) return;
  const run = wbNativeClaudeSessionRuns(sessionId).find(r => r.id === turn.nativeDagRunId);
  if (!run || !run.live) return;
  const at = new Date().toISOString();
  for (const node of run.nodes.slice(1)) {
    if (node.status === 'running' || node.status === 'waiting_resource') {
      node.status = 'interrupted';
      node.completedAt = at;
      node.error = t('workflow.nativeClaude.interrupted');
      wbNativeClaudeProgress(node, t('workflow.nativeClaude.interrupted'), at);
    }
  }
  const parent = run.nodes.find(n => n.id === 'claude-parent');
  const childFailed = run.nodes.slice(1).some(n => n.status === 'failed' || n.status === 'interrupted');
  const ok = resultEvt && resultEvt.ok === true && !childFailed;
  if (parent) {
    parent.status = ok ? 'succeeded' : (resultEvt && resultEvt.aborted ? 'interrupted' : 'failed');
    parent.completedAt = at;
    parent.result = turn.live && turn.live.bufferText || '';
    wbNativeClaudeProgress(parent, ok ? t('workflow.nativeClaude.parentCompleted') : t('workflow.nativeClaude.parentFailed'), at);
  }
  run.status = ok ? 'succeeded' : (resultEvt && resultEvt.aborted ? 'interrupted' : 'failed');
  run.live = false;
  run.completedAt = at;
  run.updatedAt = at;
  wbNativeClaudeRefresh();
}
// v3 P3b 缩放挡位(§5.4:0.75/1/1.25;画布只读，整容器 CSS transform:scale，坐标系不变，无指针耦合)。
const WB_ZOOM_GEARS = [0.75, 1, 1.25];
// 窄屏(<1180)右板走抽屉:点节点/手动开合从右滑出;≤760 全宽浮层。matchMedia 判定，SSR/无 window 时防御回退。
function wbIsNarrow() { try { return window.matchMedia('(max-width: 1180px)').matches; } catch { return false; } }
const WB_SVGNS = 'http://www.w3.org/2000/svg';
function wbSvg(tag, attrs) { const e = document.createElementNS(WB_SVGNS, tag); if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
// run 友好名:runs 目前不持久化 title(见 server.js run 对象),回退占位 + 由 id chip 承载唯一标识。
function wbRunName(run) {
  if (run && run.kind === 'spawn_agent') return t('workflow.spawnAgent.runTitle');
  return (run && (run.title || run.workflowTitle || run.label)) || t('workflow.tabTitle');
}
// 首个活动 run(无则首个)作为默认选中。
function wbPickDefaultRun(runs) {
  const arr = Array.isArray(runs) ? runs : [];
  const active = arr.find(r => AGENT_RUN_ACTIVE.has(r.status));
  return (active || arr[0] || {}).id || null;
}
// 拓扑签名(id + dependsOn)—— 不变则复用缓存坐标,防轮询重排时节点抖动。
function wbTopoSig(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map(n => `${n.id}<${(Array.isArray(n.dependsOn) ? n.dependsOn : []).join('|')}`).join(';');
}
function wbLayoutFor(run) {
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const sig = wbTopoSig(nodes);
  const cached = wbState.posCache[run.id];
  if (cached && cached.sig === sig) return cached.pos;   // 拓扑未变 → 复用位置(id 记忆,防抖动)
  const pos = layoutWorkbenchDAG(nodes);
  wbState.posCache[run.id] = { sig, pos };
  return pos;
}
// 对抗轮 P2: 通用焦点跨重建保留——重建前记 activeElement 的 data-fk 身份键,重建后按键回焦(容器内查找)。
// 覆盖节点卡/审批钮/重试钮/缩放钮/发送钮;插话输入框的值+光标另有专门保留(见 renderWorkbenchSide)。
function wbCaptureFocus(container) {
  const ae = document.activeElement;
  return (ae && container && container.contains(ae) && ae.dataset && ae.dataset.fk) ? ae.dataset.fk : null;
}
function wbRestoreFocus(container, fk) {
  if (!fk || !container) return;
  const t = container.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
  if (t && !t.disabled) { try { t.focus({ preventScroll: true }); } catch { /* ignore */ } }
}
// 主视图状态机:切 data-main-view + tab 激活态 + localStorage 记忆;进画布启轮询并即时重绘,离开按需停轮询。
function switchMainView(v) {
  v = (v === 'canvas') ? 'canvas' : 'chat';
  wbState.view = v;
  const pane = document.querySelector('.chat-pane');
  if (pane) pane.setAttribute('data-main-view', v);
  document.querySelectorAll('.wb-mainview-tabs .wb-mv-tab').forEach(b => {
    const on = b.dataset.mainView === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  try { localStorage.setItem('wcw.mainView', v); } catch { /* ignore */ }
  if (v === 'canvas') {
    if (!wbState.selectedRunId) wbState.selectedRunId = wbPickDefaultRun(wbState.lastRuns);
    renderWorkbench(wbState.lastRuns, true);   // 显式切视图强制重绘(签名跳过仅作用于轮询路径)
  } else {
    const turn = state.currentSession && getActiveTurn(state.currentSession.id);
    if (turn && turn.live) scheduleRender(turn.live);
  }
  syncAgentRunsPolling(); // 复用 agent-runs 轮询:画布态需要它,离开则按监控页签是否激活决定停/留
}
function restoreMainView() {
  let v = 'chat'; try { v = localStorage.getItem('wcw.mainView') || 'chat'; } catch { /* ignore */ }
  switchMainView(v === 'canvas' ? 'canvas' : 'chat');
}
// 主 Tab「工作台」在有活动 run 时亮点标(每次轮询刷新调用)。
function wbUpdateActivityDot(runs) {
  const tab = $('mainViewTabCanvas'); if (!tab) return;
  tab.classList.toggle('has-activity', (Array.isArray(runs) ? runs : []).some(r => AGENT_RUN_ACTIVE.has(r.status)));
}
// 画布数据入口(loadAgentRuns 每轮调用):缓存 runs、刷新亮点标,画布态则重绘。
function wbOnRuns(runs) {
  wbState.persistedRuns = Array.isArray(runs) ? runs : [];
  wbState.lastRuns = wbNativeClaudeMergedRuns(wbState.persistedRuns);
  // 对抗轮 P3: posCache 只增不减——按当前 runs 清理已消失的 run,删除记录/切会话后不再缓慢累积。
  for (const k of Object.keys(wbState.posCache)) if (!wbState.lastRuns.some(r => r.id === k)) delete wbState.posCache[k];
  wbUpdateActivityDot(wbState.lastRuns);
  if (wbState.view === 'canvas') renderWorkbench(wbState.lastRuns);
}
// 渲染分派:校正选中 run → runbar + 画布 + 右板 + 用量条;无 run → 空态。
function renderWorkbench(runs, force) {
  const arr = Array.isArray(runs) ? runs : [];
  let run = arr.find(r => r.id === wbState.selectedRunId);
  if (!run) {
    wbState.selectedRunId = wbPickDefaultRun(arr); run = arr.find(r => r.id === wbState.selectedRunId);
    // 对抗轮 P3: 自动重挑 run 后清空选中节点/展开态——不同 run 的同名节点(plan/exec/review 模板族)会被误携带。
    wbState.selectedNodeId = null; wbState.detailExpand = { task: false, result: false };
  }
  // 选中节点若已不在当前 run(切 run/节点被移除)则清空,避免右板串到别的 run 的节点。
  if (run && wbState.selectedNodeId && !(Array.isArray(run.nodes) ? run.nodes : []).some(n => n.id === wbState.selectedNodeId)) wbState.selectedNodeId = null;
  // 对抗轮 P2(系统性根因): 数据+选中态签名未变 → 整轮跳过重建。2s 轮询的静止期(等审批/暂停/已结束)不再冲刷
  // 焦点/滚动/文本选区/悬停高亮;live 期数据帧帧在变仍会重建,由各处保留逻辑兜底。
  const sig = `${wbState.selectedRunId}|${wbState.selectedNodeId}|${JSON.stringify(arr)}`;
  if (!force && sig === wbState.renderSig) return;
  wbState.renderSig = sig;
  renderWorkbenchRunbar(arr, wbState.selectedRunId);
  if (!run) { renderWorkbenchEmpty(); return; }
  renderWorkbenchCanvas(run);
  renderWorkbenchSide(run);
  renderWorkbenchUsage(run);
}
// 当前选中 run(供缩放/适应视图重绘时取数)。
function wbCurrentRun() { return (Array.isArray(wbState.lastRuns) ? wbState.lastRuns : []).find(r => r.id === wbState.selectedRunId) || null; }
// ① Run 选择器 chips。状态点(live 脉动)+ id + 状态词 +(完成 ✦)+ 待批准池徽标;点击切画布。
function renderWorkbenchRunbar(runs, selectedRunId) {
  const bar = $('wbRunbar'); if (!bar) return;
  bar.textContent = '';
  if (!runs.length) return;
  const label = el('span', 'wb-rb-label'); label.appendChild(el('span', 'wb-rb-cloud')); label.appendChild(document.createTextNode(t('common.run')));
  bar.appendChild(label);
  for (const run of runs) {
    const st = AGENT_RUN_ACTIVE.has(run.status) ? 'running' : (run.status === 'succeeded' ? 'succeeded' : ((run.status === 'failed' || run.status === 'rejected') ? 'failed' : 'other'));
    const on = run.id === selectedRunId;
    const chip = el('button', `wb-chip wb-st-${st}${on ? ' active' : ''}`);
    chip.setAttribute('role', 'tab'); chip.setAttribute('aria-selected', on ? 'true' : 'false');
    chip.appendChild(el('span', 'wb-rc-dot'));
    chip.appendChild(document.createTextNode(wbRunName(run) + ' '));
    chip.appendChild(el('span', 'wb-rc-id', run.id));
    if (run.status === 'succeeded') chip.appendChild(el('span', 'wb-rc-gold', '✦'));
    chip.appendChild(el('span', 'wb-rc-st', agentRunStatusLabel(run.status)));
    const proposed = Array.isArray(run.taskPool) ? run.taskPool.filter(p => p && p.status === 'proposed') : [];
    if (proposed.length) chip.appendChild(el('span', 'wb-rc-pool num', t('workflow.runbar.pendingApproval', { n: proposed.length })));
    chip.onclick = () => { wbState.selectedRunId = run.id; wbState.selectedNodeId = null; renderWorkbench(wbState.lastRuns); };
    bar.appendChild(chip);
  }
}
// 边着色分类(按源节点显示状态)。
function wbEdgeKind(srcDisp) {
  if (srcDisp === 'running') return 'run';
  if (srcDisp === 'rejected') return 'reject';
  if (srcDisp === 'waiting_resource' || srcDisp === 'blocked' || srcDisp === 'paused') return 'wait';
  if (srcDisp === 'failed') return 'fail';
  if (srcDisp === 'succeeded' || srcDisp === 'degraded') return 'done';
  return 'idle';
}
function wbEdgeColor(kind) {
  return kind === 'run' ? 'var(--accent)' : (kind === 'reject' || kind === 'wait') ? 'var(--warn)' : kind === 'fail' ? 'var(--danger)' : kind === 'done' ? 'var(--ok)' : 'var(--line-2)';
}
// ② 只读画布:分层布局 → 缩放容器 .wb-canvas-inner(节点 + SVG 同容器整体 CSS transform:scale，坐标系不变，
//    点击命中随视觉变换，无编辑器那种指针坐标耦合)。外层 .wb-canvas 尺寸 = 内容 × zoom，撑出正确滚动区。
//    轮询重绘保留滚动位置(避免 2s 一跳)+ 右下缩放胶囊(0.75/1/1.25 挡 + 适应视图)+ 泳道层淡标签(§5.4)。
function renderWorkbenchCanvas(run) {
  const wrap = $('wbCanvasWrap'); if (!wrap) return;
  const fk = wbCaptureFocus(wrap.parentElement || wrap);   // 对抗轮 P2: 节点卡/缩放钮键盘焦点跨重建保留
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const pos = wbLayoutFor(run);
  let maxRight = 0, maxBottom = 0;
  for (const n of nodes) { const p = pos[n.id]; if (!p) continue; maxRight = Math.max(maxRight, p.x + WB_NODE_W); maxBottom = Math.max(maxBottom, p.y + WB_NODE_H); }
  const W = Math.max(WB_NODE_W + WB_PAD * 2, maxRight + WB_PAD);
  const H = Math.max(WB_NODE_H + WB_PAD * 2, maxBottom + WB_PAD);
  const z = wbState.zoom || 1;
  const prevSL = wrap.scrollLeft, prevST = wrap.scrollTop;   // 保留滚动位置，轮询重绘不跳
  wrap.textContent = '';
  const canvas = el('div', 'wb-canvas'); canvas.style.width = `${(W * z).toFixed(0)}px`; canvas.style.height = `${(H * z).toFixed(0)}px`;
  const inner = el('div', 'wb-canvas-inner'); inner.style.width = `${W}px`; inner.style.height = `${H}px`; inner.style.transform = `scale(${z})`;
  inner.appendChild(wbBuildEdges(run, nodes, pos, W, H));
  wbBuildLayerTags(nodes, pos).forEach(t => inner.appendChild(t));
  for (const node of nodes) { const p = pos[node.id]; if (p) inner.appendChild(wbBuildNode(run, node, p)); }
  canvas.appendChild(inner);
  wrap.appendChild(canvas);
  wrap.scrollLeft = prevSL; wrap.scrollTop = prevST;
  // 缩放胶囊挂到非滚动的 .wb-main(而非滚动的画布容器)→ 滚动画布时胶囊固定在右下不跟着跑。单实例:先移除旧的。
  const main = wrap.parentElement;
  if (main) { const old = main.querySelector(':scope > .wb-cvtools'); if (old) old.remove(); main.appendChild(wbBuildZoomCapsule()); }
  wbRestoreFocus(wrap.parentElement || wrap, fk);
  // 对抗轮 P3: 悬停依赖链高亮跨重建重放——鼠标未动不会重触 mouseenter,原先高亮 ≤2s 无声熄灭。
  const hov = wrap.querySelector('.wb-node:hover');
  if (hov && hov.dataset.nodeId) wbHighlightChain(hov.dataset.nodeId, true);
}
// 泳道层淡标签(§5.4):每层一个「第 N 层」淡 pill，落在该层行上缘的空隙带(gap/pad 区)，左对齐 —— 节点行居中
// 排布、左侧留白，标签置于行**上方**空隙 → 垂直方向与节点不同带，避开重叠;随内容一起缩放(在 .wb-canvas-inner 内)。
function wbBuildLayerTags(nodes, pos) {
  const layers = new Map();   // layer -> 该层最小 y(行上缘)
  for (const n of nodes) { const p = pos[n.id]; if (!p) continue; if (!layers.has(p.layer) || p.y < layers.get(p.layer)) layers.set(p.layer, p.y); }
  const out = [];
  for (const [L, y] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = el('div', 'wb-layer-tag num', t('workflow.canvas.layerTag', { L: L }));
    tag.style.left = '8px'; tag.style.top = `${Math.max(2, y - 22)}px`;   // 行上缘上方空隙带
    tag.setAttribute('aria-hidden', 'true');
    out.push(tag);
  }
  return out;
}
// 右下缩放胶囊(§5.4):− / 读数 / ＋ / 适应视图。挡位循环 0.75/1/1.25;适应视图取能容下的最大挡并居中滚动。
function wbBuildZoomCapsule() {
  const z = wbState.zoom || 1;
  const cap = el('div', 'wb-cvtools'); cap.setAttribute('role', 'group'); cap.setAttribute('aria-label', t('workflow.canvas.zoom'));
  const idx = WB_ZOOM_GEARS.indexOf(z);
  const minus = el('button', 'wb-cv-btn', '−'); minus.title = t('workflow.canvas.zoomOut'); minus.setAttribute('aria-label', '缩小'); minus.dataset.fk = 'zoom:minus';
  minus.disabled = idx <= 0; minus.onclick = () => wbSetZoom(WB_ZOOM_GEARS[Math.max(0, (idx < 0 ? 1 : idx) - 1)]);
  const read = el('span', 'wb-cv-zoom num', `${Math.round(z * 100)}%`);
  const plus = el('button', 'wb-cv-btn', '＋'); plus.title = t('workflow.canvas.zoomIn'); plus.setAttribute('aria-label', '放大'); plus.dataset.fk = 'zoom:plus';
  plus.disabled = idx >= WB_ZOOM_GEARS.length - 1; plus.onclick = () => wbSetZoom(WB_ZOOM_GEARS[Math.min(WB_ZOOM_GEARS.length - 1, (idx < 0 ? 1 : idx) + 1)]);
  const fit = el('button', 'wb-cv-btn wb-cv-fit', '⤢'); fit.title = t('workflow.canvas.fitView'); fit.setAttribute('aria-label', t('workflow.canvas.fitView')); fit.dataset.fk = 'zoom:fit';
  fit.onclick = () => wbFitView();
  cap.append(minus, read, plus, fit);
  return cap;
}
// 设挡位并重绘(挡位吸附到 WB_ZOOM_GEARS 之一)。
function wbSetZoom(z) {
  const snap = WB_ZOOM_GEARS.reduce((a, g) => Math.abs(g - z) < Math.abs(a - z) ? g : a, WB_ZOOM_GEARS[1]);
  wbState.zoom = snap;
  const run = wbCurrentRun(); if (run) renderWorkbenchCanvas(run);
}
// 适应视图:按画布包围盒挑能容下宽度的最大挡位，重绘后水平居中滚动(纵向 DAG 顶对齐)。
function wbFitView() {
  const wrap = $('wbCanvasWrap'); const run = wbCurrentRun(); if (!wrap || !run) return;
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const pos = wbLayoutFor(run);
  let maxRight = 0; for (const n of nodes) { const p = pos[n.id]; if (p) maxRight = Math.max(maxRight, p.x + WB_NODE_W); }
  const W = Math.max(WB_NODE_W + WB_PAD * 2, maxRight + WB_PAD);
  const avail = Math.max(0, wrap.clientWidth - 24);
  const ratio = avail / W;
  let gear = WB_ZOOM_GEARS[0];
  for (const g of WB_ZOOM_GEARS) if (g <= ratio) gear = g;     // 能容下的最大挡；都容不下则最小挡 0.75
  wbState.zoom = gear;
  renderWorkbenchCanvas(run);
  wrap.scrollLeft = Math.max(0, (W * gear - wrap.clientWidth) / 2);   // 水平居中
  wrap.scrollTop = 0;
}
// SVG 边层:每条边一个 userSpaceOnUse 方向渐变(源色 → --line-2 沿依赖方向衰减)+ 源实点/靶空环端口。
function wbBuildEdges(run, nodes, pos, W, H) {
  const svg = wbSvg('svg', { class: 'wb-edges', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  const defs = wbSvg('defs'); svg.appendChild(defs);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ports = [];
  let gi = 0;
  for (const node of nodes) {
    const to = pos[node.id]; if (!to) continue;
    for (const depId of (Array.isArray(node.dependsOn) ? node.dependsOn : [])) {
      const from = pos[depId]; const src = byId.get(depId); if (!from || !src) continue;
      const fx = from.cx, fy = from.y + WB_NODE_H, tx = to.cx, ty = to.y;       // 源底缘中点 → 靶顶缘中点
      const dy = (ty - fy) * 0.5;                                               // 控制点落中垂线(§5.2)
      const d = `M${fx.toFixed(1)},${fy.toFixed(1)} C${fx.toFixed(1)},${(fy + dy).toFixed(1)} ${tx.toFixed(1)},${(ty - dy).toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}`;
      const kind = wbEdgeKind(nodeDisplayStatus(src));
      const gid = `wbg-${run.id}-${gi++}`;
      const grad = wbSvg('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: fx.toFixed(1), y1: fy.toFixed(1), x2: tx.toFixed(1), y2: ty.toFixed(1) });
      const near = wbSvg('stop', { offset: '0' }); near.setAttribute('style', `stop-color:${wbEdgeColor(kind)}`);
      const far = wbSvg('stop', { offset: '1' }); far.setAttribute('style', 'stop-color:var(--line-2)');
      grad.append(near, far); defs.appendChild(grad);
      svg.appendChild(wbSvg('path', { class: `wb-edge wb-e-${kind}`, d, stroke: `url(#${gid})`, 'data-from': depId, 'data-to': node.id }));
      ports.push(['src', fx, fy, kind], ['dst', tx, ty, kind]);
    }
  }
  for (const [k, x, y, kind] of ports) {
    if (k === 'src') { const c = wbSvg('circle', { class: 'wb-port src', cx: x.toFixed(1), cy: y.toFixed(1), r: '2.6' }); c.setAttribute('style', `fill:${wbEdgeColor(kind)}`); svg.appendChild(c); }
    else svg.appendChild(wbSvg('circle', { class: 'wb-port dst', cx: x.toFixed(1), cy: y.toFixed(1), r: '3.2' }));
  }
  return svg;
}
// 节点卡 220×88(渗透语言,与 P2 监控卡同族;运行态脉动 + glow)。字段全复用 renderAgentRuns 同源纯函数。
function wbBuildNode(run, node, p) {
  const disp = nodeDisplayStatus(node);
  const card = el('div', `wb-node wb-st-${disp}${node.id === wbState.selectedNodeId ? ' selected' : ''}`);
  card.dataset.runId = run.id; card.dataset.nodeId = node.id; card.dataset.fk = `n:${node.id}`;
  card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
  card.setAttribute('role', 'button'); card.tabIndex = 0;
  card.setAttribute('aria-label', `节点 ${node.id} · ${agentRunStatusLabel(disp)}(点击定位到监控卡)`);
  // 头:状态徽标 + 标题(id·角色) + 引擎徽标
  const hd = el('div', 'wb-node-hd');
  hd.appendChild(el('span', 'wb-badge', agentStatusIcon(disp)));
  const title = el('span', 'wb-node-title');
  const idb = el('b'); idb.textContent = node.id; title.appendChild(idb);
  if (node.roleLabel || node.roleId) title.appendChild(el('span', 'role', ` · ${node.roleLabel || node.roleId}`));
  hd.appendChild(title);
  const eng = agentEngineBadge(node.engine); if (eng) { eng.classList.add('wb-eng-inline'); hd.appendChild(eng); }
  card.appendChild(hd);
  // 模型名(muted;无则省)
  if (node.model) card.appendChild(el('div', 'wb-node-model', node.model));
  // 活动行:progressLog 末条(运行/等待态显,succeeded/skipped 不显)
  const plog = Array.isArray(node.progressLog) ? node.progressLog : [];
  const last = plog.length ? plog[plog.length - 1] : null;
  const activeState = node.status === 'running' || node.status === 'waiting_resource';
  if (last && last.text && node.status !== 'succeeded' && node.status !== 'skipped') {
    const act = el('div', `wb-node-act${(disp === 'rejected' || disp === 'waiting_resource' || disp === 'failed') ? ' warn' : ''}`);
    if (activeState) act.appendChild(el('span', 'wb-act-dot', '◐'));
    act.appendChild(el('span', 'wb-act-text', last.text));
    card.appendChild(act);
  }
  // 底行(择一):门 verdict + 置信度 / 迭代·循环条 / 依赖·状态词
  const foot = el('div', 'wb-node-foot');
  const verdict = node.gateVerdict || (node.structuredResult && node.structuredResult.verdict);
  let budgetLabel = '', budgetCur = 0, budgetMax = 0;
  if (node.loop) { budgetLabel = t('workflow.budget.loop'); budgetCur = node.loopIteration || 0; budgetMax = node.loop.maxIterations || 0; }
  else if (Number.isFinite(Number(node.maxIters))) { budgetLabel = t('workflow.budget.iter'); budgetCur = Number(node.iters) || 0; budgetMax = Number(node.maxIters) || 0; }
  if (verdict) {
    const v = String(verdict).toLowerCase();
    foot.appendChild(el('span', `wb-verdict ${v === 'pass' ? 'pass' : 'fail'}`, `判定 ${verdict}`));
    if (node.confidence != null && Number.isFinite(Number(node.confidence))) foot.appendChild(el('span', 'wb-foot-label num', `置信度 ${(Number(node.confidence) * 100).toFixed(0)}%`));
  } else if (budgetMax > 0) {
    const bar = el('div', 'wb-bar'); const i = el('i'); i.style.width = `${Math.max(0, Math.min(100, Math.round((budgetCur / budgetMax) * 100)))}%`; bar.appendChild(i); foot.appendChild(bar);
    foot.appendChild(el('span', 'wb-foot-label num', `${budgetLabel} ${budgetCur}/${budgetMax}`));
  } else {
    const deps = Array.isArray(node.dependsOn) && node.dependsOn.length ? `← 依赖 ${node.dependsOn.join(', ')}` : agentRunStatusLabel(disp);
    foot.appendChild(el('span', 'wb-foot-label', deps));
  }
  card.appendChild(foot);
  // 点击/回车 → 填右板段1「选中节点详情」(P3b:不再 switchTab 跳右栏)。悬停 → 高亮其入/出边(§2.3 依赖链)。
  const go = () => wbFocusRunNode(run.id, node.id);
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  card.addEventListener('mouseenter', () => wbHighlightChain(node.id, true));
  card.addEventListener('mouseleave', () => wbHighlightChain(node.id, false));
  return card;
}
// 悬停依赖链高亮(§2.3):点亮与该节点相连的入/出边(data-from|data-to 命中),其余边降透明度;移出复原。
function wbHighlightChain(nodeId, on) {
  const edges = document.querySelectorAll('#wbCanvasWrap .wb-edge');
  edges.forEach(e => {
    if (!on) { e.classList.remove('lit', 'dim'); return; }
    const hit = e.getAttribute('data-from') === nodeId || e.getAttribute('data-to') === nodeId;
    e.classList.toggle('lit', hit); e.classList.toggle('dim', !hit);
  });
}
// P3b 节点点击:画布内标选中 + 填充右板段1(选中节点详情),不再跳右栏 agent-runs(取代 P3a 的 switchTab)。
// 窄屏(<1180)则同时把右板抽屉滑出;详情段滚入视野。
function wbFocusRunNode(runId, nodeId) {
  if (wbState.selectedNodeId !== nodeId) wbState.detailExpand = { task: false, result: false };   // 对抗轮 P3: 重复点同一节点不重置展开态
  wbState.selectedNodeId = nodeId;
  wbState.panelOpen.detail = true;
  document.querySelectorAll('#wbCanvasWrap .wb-node.selected').forEach(n => n.classList.remove('selected'));
  const card = document.querySelector(`#wbCanvasWrap .wb-node[data-node-id="${CSS.escape(nodeId)}"]`);
  if (card) card.classList.add('selected');
  const run = wbCurrentRun();
  if (run) renderWorkbenchSide(run);
  if (wbIsNarrow()) wbOpenSide(true);
  const sec = document.querySelector('#wbSide .wb-sec[data-sec="detail"]');
  if (sec) sec.scrollIntoView({ block: 'nearest' });
}
// 窄屏右板抽屉开合:切 .wb-view 上的状态类 + backdrop 显隐(≥1180 常驻，此开关无副作用)。
function wbOpenSide(open) {
  wbState.sideOpen = !!open;
  const view = $('workbenchView'); if (view) view.classList.toggle('wb-side-open', !!open);
}
// ④ 底部用量迷你条:本 run 累计 tokens/成本/时长(大数字仪表)。字段缺失显「—」(防御,后端并行落地中)。
function wbRunMetrics(run) {
  const u = (run && (run.usage || run.usageTotals)) || null;
  const tok = (u && (Number(u.input_tokens || 0) + Number(u.output_tokens || 0))) || Number((run && run.totalTokens) || 0) || 0;
  const cost = Number(run && run.costUsd != null ? run.costUsd : run && run.totalCostUsd != null ? run.totalCostUsd : (u && u.costUsd) || 0) || 0;
  return { tok, cost, elapsed: runElapsedMs(run) };
}
function renderWorkbenchUsage(run) {
  const host = $('wbUsage'); if (!host) return;
  host.textContent = '';
  const m = wbRunMetrics(run);
  const runLbl = el('span', 'wb-usage-run');
  if (run.live) runLbl.appendChild(el('span', 'wb-usage-dot'));
  runLbl.appendChild(document.createTextNode(wbRunName(run) + ' '));
  runLbl.appendChild(el('span', 'wb-rc-id', run.id));
  host.appendChild(runLbl);
  const metrics = el('div', 'wb-usage-metrics');
  const um = (big, unit, lbl) => { const box = el('div', 'wb-um'); const b = el('b', 'num', big); if (unit) b.appendChild(el('span', 'wb-um-u', unit)); box.appendChild(b); box.appendChild(el('span', 'wb-um-lbl', lbl)); return box; };
  metrics.appendChild(um(m.tok ? fmtTokens(m.tok) : '—', m.tok ? 'tok' : '', t('workflow.usage.tokens')));
  metrics.appendChild(el('div', 'wb-um-sep'));
  metrics.appendChild(um(m.cost ? `$${m.cost.toFixed(m.cost < 1 ? 4 : 2)}` : '—', '', t('workflow.usage.cost')));
  metrics.appendChild(el('div', 'wb-um-sep'));
  metrics.appendChild(um(m.elapsed ? fmtDuration(m.elapsed) : '—', '', run.live ? t('workflow.usage.running') : t('workflow.usage.elapsed')));
  host.appendChild(metrics);
  const link = el('button', 'wb-usage-link', t('workflow.usage.viewDashboard'));
  link.setAttribute('aria-label', t('workflow.usage.viewDashboardAria'));
  link.onclick = () => { openToolPane(); switchTab('usage'); };
  host.appendChild(link);
}
// ⑤ 空态:无 run → 画布区居中引导卡(云纹水印 + 「去对话交办任务」/「从模板运行」);同时清空 chips/用量条/右板。
function renderWorkbenchEmpty() {
  const runbar = $('wbRunbar'); if (runbar) runbar.textContent = '';
  const usage = $('wbUsage'); if (usage) usage.textContent = '';
  const side = $('wbSide'); if (side) side.textContent = '';   // 右板清空 → .wb-main :has(:empty) 收单列，无空右条
  wbOpenSide(false);
  const wrap = $('wbCanvasWrap'); if (!wrap) return;
  // 对抗轮 P3: 清残留缩放胶囊(挂在 .wb-main 上,空态下按钮无效还悬浮在引导卡上)。
  const tools = wrap.parentElement && wrap.parentElement.querySelector(':scope > .wb-cvtools'); if (tools) tools.remove();
  wrap.textContent = '';
  const box = el('div', 'wb-empty');
  box.appendChild(el('div', 'wb-empty-cloud'));
  box.appendChild(el('div', 'wb-empty-title', t('workflow.empty.title')));
  box.appendChild(el('div', 'wb-empty-sub', t('workflow.empty.subtitle')));
  const acts = el('div', 'wb-empty-acts');
  const goChat = el('button', 'wb-empty-btn primary', t('workflow.empty.goChat'));
  goChat.onclick = () => { switchMainView('chat'); const pi = $('promptInput'); if (pi) pi.focus(); };
  const goTpl = el('button', 'wb-empty-btn', t('workflow.empty.runTemplate'));
  goTpl.onclick = () => { openToolPane(); switchTab('agent-runs'); };
  acts.append(goChat, goTpl);
  box.appendChild(acts);
  wrap.appendChild(box);
}

/* ============================================================
   UI v3 P3b「工作台」交互完整版:右侧三段折叠板(选中节点详情 / 任务池审批 / 邮箱消息流)+ 节点插话 +
   缩放/适应视图/泳道层标 + 响应式抽屉。设计稿 §5.4 / §6#5-#8/#10 + 视觉基线 p3-workbench-r2.html 右三段板。
   数据 100% 复用轮询下发的 run.nodes/taskPool/messages;动作复用 steer_node / retry_node / pool_approve|reject。
   所有不可信文本走 el()/textContent(XSS 纪律,绝不 innerHTML)。轮询 2s 重绘:段折叠态记忆于 wbState.panelOpen、
   插话输入焦点+文本跨重绘保留(防打字被冲掉)。
   ============================================================ */
// ③ 右侧三段折叠板渲染。轮询每 2s 调用 → 重建;段开合读 wbState.panelOpen(记忆),插话输入焦点/值跨重绘保留。
function renderWorkbenchSide(run) {
  const host = $('wbSide'); if (!host) return;
  // 保留插话框焦点 + 文本 + 光标(2s 轮询重绘不打断打字)。
  const ae = document.activeElement;
  const keepSteer = ae && ae.id === 'wbSteerInput';
  const steerVal = keepSteer ? ae.value : null;
  const caret = keepSteer ? ae.selectionStart : null;
  const fk = wbCaptureFocus(host);                                        // 对抗轮 P2: 审批/重试/关闭钮焦点跨重建保留
  const prevScroll = host.scrollTop;                                      // 对抗轮 P2: 右板滚动跨重建保留(对照画布 prevSL/prevST)
  const preScrolls = [...host.querySelectorAll('.wb-det-pre')].map(p => p.scrollTop);   // 任务全文/结果 <pre> 内部滚动
  host.textContent = '';
  // 窄屏抽屉的关闭按钮(≥1180 由 CSS 隐藏;抽屉态点它或点 backdrop 关闭)。
  const close = el('button', 'wb-side-close', t('workflow.canvas.collapsePanel')); close.setAttribute('aria-label', t('workflow.collapseContextPanel')); close.dataset.fk = 'side:close'; close.onclick = () => wbOpenSide(false); host.appendChild(close);
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const sel = wbState.selectedNodeId ? nodes.find(n => n.id === wbState.selectedNodeId) : null;
  const proposed = (Array.isArray(run.taskPool) ? run.taskPool : []).filter(p => p && p.status === 'proposed');
  const mails = Array.isArray(run.messages) ? run.messages : [];
  host.appendChild(wbSection('detail', t('workflow.side.selectedNodeDetail'), sel ? { text: sel.id } : null, wbNodeDetailBody(run, sel)));
  host.appendChild(wbSection('pool', t('workflow.section.pool'), proposed.length ? { text: t('workflow.section.pendingCount', { count: proposed.length }), warn: true } : ((run.taskPool || []).length ? { text: String((run.taskPool || []).length) } : null), wbPoolBody(run)));
  host.appendChild(wbSection('mail', t('workflow.section.mail'), mails.length ? { text: String(mails.length) } : null, wbMailBody(run)));
  if (keepSteer) {
    const inp = $('wbSteerInput');
    if (inp && !inp.disabled) { inp.value = steerVal; inp.focus(); try { inp.setSelectionRange(caret, caret); } catch { /* ignore */ } }
    // 对抗轮 P2: run finalize/节点终局的轮询边界会移除或禁用插话框——打了一半的文本不再静默蒸发,弹一次可见提示。
    else if (steerVal && steerVal.trim()) toast(t("toast.steerUnsendable", { p1: steerVal.trim().slice(0, 80) }), 'err');
  }
  else wbRestoreFocus(host, fk);
  host.scrollTop = prevScroll;
  [...host.querySelectorAll('.wb-det-pre')].forEach((p, i) => { if (preScrolls[i]) p.scrollTop = preScrolls[i]; });
}
// 折叠段外壳:头(caret + 标题 + 计数徽标)+ 体。头点击切 wbState.panelOpen[key] 并就地开合(不整板重绘,防抖动)。
function wbSection(key, title, count, bodyNode) {
  const open = wbState.panelOpen[key] !== false;
  const sec = el('section', `wb-sec${open ? ' open' : ''}`); sec.dataset.sec = key;
  const hd = el('button', 'wb-sec-hd'); hd.setAttribute('aria-expanded', open ? 'true' : 'false');
  hd.appendChild(el('span', 'wb-sec-caret', '▸'));
  hd.appendChild(el('span', 'wb-sec-title', title));
  if (count && count.text) hd.appendChild(el('span', `wb-sec-count num${count.warn ? ' warn' : ''}`, count.text));
  hd.onclick = () => { const nowOpen = !sec.classList.contains('open'); wbState.panelOpen[key] = nowOpen; sec.classList.toggle('open', nowOpen); hd.setAttribute('aria-expanded', nowOpen ? 'true' : 'false'); };
  sec.appendChild(hd);
  const body = el('div', 'wb-sec-body'); if (bodyNode) body.appendChild(bodyNode);
  sec.appendChild(body);
  return sec;
}
// 段1 体:选中节点详情(id/角色/引擎/模型/状态/计时/迭代·门 verdict+置信度环/进度时间线/task 全文/结果·错误)
//   + 插话框(资格判定,§6#6)+ 重试入口(非 live)。无选中 → 占位提示。
function wbNodeDetailBody(run, node) {
  if (!node) { const ph = el('div', 'wb-det-empty', t('workflow.detail.placeholder')); return ph; }
  const disp = nodeDisplayStatus(node);
  const box = el('div', 'wb-det');
  // 头:标题(角色/id) + 引擎徽标 + 模型 chip
  const top = el('div', 'wb-det-top');
  top.appendChild(el('span', 'wb-det-title', node.roleLabel || node.roleId || node.id));
  const eng = agentEngineBadge(node.engine); if (eng) { eng.classList.add('wb-eng-inline'); top.appendChild(eng); }
  if (node.model) top.appendChild(el('span', 'wb-det-model num', node.model));
  box.appendChild(top);
  // 状态行 + 计时
  const strow = el('div', 'wb-det-row');
  strow.appendChild(el('span', 'wb-det-k', t('workflow.detail.status')));
  strow.appendChild(el('span', `wb-det-chip wb-st-${disp}`, agentRunStatusLabel(disp)));
  if (node.startedAt) { const st = Date.parse(node.startedAt); if (Number.isFinite(st)) { const active = node.status === 'running' || node.status === 'waiting_resource'; const end = node.completedAt ? Date.parse(node.completedAt) : Date.now(); const dur = fmtDuration(end - st); if (dur) strow.appendChild(el('span', 'wb-det-time num', t(active ? 'workflow.detail.timerRunning' : 'workflow.detail.timerElapsed', { dur }))); } }
  box.appendChild(strow);
  // 迭代/循环预算条
  let budgetLabel = '', budgetCur = 0, budgetMax = 0;
  if (node.loop) { budgetLabel = t('workflow.budget.loop'); budgetCur = node.loopIteration || 0; budgetMax = node.loop.maxIterations || 0; }
  else if (Number.isFinite(Number(node.maxIters))) { budgetLabel = t('workflow.budget.iter'); budgetCur = Number(node.iters) || 0; budgetMax = Number(node.maxIters) || 0; }
  if (budgetMax > 0) {
    const row = el('div', 'wb-det-row'); row.appendChild(el('span', 'wb-det-k', budgetLabel));
    const bar = el('div', 'wb-det-bar'); const i = el('i'); i.style.width = `${Math.max(0, Math.min(100, Math.round((budgetCur / budgetMax) * 100)))}%`; bar.appendChild(i); row.appendChild(bar);
    row.appendChild(el('span', 'wb-det-num num', `${budgetCur}/${budgetMax}`)); box.appendChild(row);
  }
  // 门 verdict + 置信度环
  const verdict = node.gateVerdict || (node.structuredResult && node.structuredResult.verdict);
  const hasConf = node.confidence != null && Number.isFinite(Number(node.confidence));
  if (verdict || hasConf) {
    const row = el('div', 'wb-det-row'); row.appendChild(el('span', 'wb-det-k', t('workflow.detail.gateLabel')));
    if (hasConf) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(node.confidence) * 100)));
      const pass = !verdict || String(verdict).toLowerCase() === 'pass';
      const ring = el('div', 'wb-det-ring'); ring.style.setProperty('--deg', `${(pct / 100 * 360).toFixed(1)}deg`); ring.style.setProperty('--ring-col', pass ? 'var(--ok)' : 'var(--warn)');
      ring.appendChild(el('span', 'num', `${pct}%`)); row.appendChild(ring);
    }
    if (verdict) row.appendChild(el('span', `wb-det-verdict ${String(verdict).toLowerCase() === 'pass' ? 'pass' : 'fail'}`, t('workflow.detail.verdict', { verdict })));
    box.appendChild(row);
  }
  // 进度时间线(全量 progressLog;末条 live 高亮)
  const plog = Array.isArray(node.progressLog) ? node.progressLog : [];
  if (plog.length) {
    const tl = el('div', 'wb-det-timeline');
    const active = node.status === 'running' || node.status === 'waiting_resource';
    plog.slice(-16).forEach((it, idx, a) => {
      const isLast = idx === a.length - 1;
      const cls = `wb-tl-item${node.status === 'succeeded' || node.status === 'skipped' ? ' done' : (isLast && active ? ' live' : (isLast ? '' : ' done'))}`;
      const item = el('div', cls);
      if (it.at) { const t = new Date(it.at); if (!isNaN(t)) item.appendChild(el('span', 'wb-tl-t num', t.toLocaleTimeString())); }
      item.appendChild(document.createTextNode(it.text || '')); tl.appendChild(item);
    });
    box.appendChild(tl);
  }
  // task 全文
  if (node.task) { const tw = el('details', 'wb-det-task'); tw.appendChild(el('summary', 'wb-det-task-sum', t('workflow.detail.task'))); tw.appendChild(el('pre', 'wb-det-pre', node.task)); tw.open = !!wbState.detailExpand.task; tw.addEventListener('toggle', () => { wbState.detailExpand.task = tw.open; }); box.appendChild(tw); }
  // 插话框(§6#6):live run + 资格判定;不符合显禁用 + 原因(与后端 409 文案一致)。
  box.appendChild(wbSteerBox(run, node));
  // 操作区:非 live 显重试入口(retry_node);失败/判否有错误显查看错误。
  if (!run.live && !run.nativeClaude) {
    const acts = el('div', 'wb-det-actions');
    const retry = el('button', 'wb-btn', t('workflow.node.retry')); retry.dataset.fk = `retry:${node.id}`; retry.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: false });
    const cascade = el('button', 'wb-btn', t('workflow.node.retryCascade')); cascade.dataset.fk = `cascade:${node.id}`; cascade.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: true });
    acts.append(retry, cascade);
    if ((disp === 'failed' || disp === 'rejected') && (node.error || (Array.isArray(node.schemaErrors) && node.schemaErrors.length))) {
      const view = el('button', 'wb-btn', t('workflow.node.viewError')); view.onclick = () => { const err = box.querySelector('.wb-det-error'); if (err) err.scrollIntoView({ block: 'nearest' }); };
      acts.appendChild(view);
    }
    box.appendChild(acts);
  }
  // 结果 / 错误全文
  if (node.result) { const rw = el('details', 'wb-det-result'); rw.appendChild(el('summary', 'wb-det-task-sum', t('workflow.node.viewResult'))); rw.appendChild(el('pre', 'wb-det-pre', node.result)); rw.open = !!wbState.detailExpand.result; rw.addEventListener('toggle', () => { wbState.detailExpand.result = rw.open; }); box.appendChild(rw); }
  if (Array.isArray(node.schemaErrors) && node.schemaErrors.length) box.appendChild(el('pre', 'wb-det-pre wb-det-error', `Schema: ${node.schemaErrors.join('; ')}`));
  if (node.error) box.appendChild(el('pre', 'wb-det-pre wb-det-error', node.error));
  return box;
}
// 插话资格判定(§6#6):镜像后端 nodeDeliveryEligibility + run.live 要求。返回 {ok, reason, msg}。
// 47a Phase C-A:claude_engine 不再整段禁用 —— 改延迟语义(deferred),标签/placeholder 明示「节点结束后生效」;
// 其余禁用文案与 服务端 steer_node 409 返回逐字一致(deterministic_gate / terminal),非 live 则整段不出插话框。
function wbSteerEligibility(run, node) {
  if (run && run.nativeClaude) return { ok: false, reason: 'native_read_only', msg: t('workflow.nativeClaude.readOnly') };
  if (!run.live) return { ok: false, reason: 'not_live', msg: '' };
  if (node.gate && ['vote', 'dedupe'].includes(node.gate.mode)) return { ok: false, reason: 'deterministic_gate', msg: t('workflow.steerBox.noDeterministic') };
  if (!['running', 'queued', 'waiting_resource'].includes(node.status)) return { ok: false, reason: 'terminal', msg: t('workflow.steerBox.noTerminal') };
  if ((node.engine || 'openai') === 'claude') return { ok: true, reason: 'deferred', msg: '' };
  return { ok: true, reason: 'ok', msg: '' };
}
// 插话框:资格命中显输入 + 发送(复用 steer_node action，内联提交不弹 prompt);不命中显禁用输入 + 原因(与 409 一致);
// 非 live run 不出插话框(返回空文档片段)。
function wbSteerBox(run, node) {
  const elig = wbSteerEligibility(run, node);
  if (elig.reason === 'not_live') return el('span', 'wb-steer-none');
  if (elig.reason === 'native_read_only') return el('div', 'wb-steer-why', elig.msg);
  const deferred = elig.reason === 'deferred';
  const wrap = el('div', 'wb-steer');
  wrap.appendChild(el('div', 'wb-steer-label', elig.ok ? (deferred ? t('workflow.steerBox.deferredLabel') : t('workflow.steerBox.liveLabel')) : t('workflow.steerBox.disabledLabel')));
  const boxrow = el('div', 'wb-steer-box');
  const input = el('input', 'wb-steer-input'); input.id = 'wbSteerInput'; input.type = 'text';
  input.placeholder = elig.ok ? t('workflow.steerBox.placeholder', { node: node.id }) : elig.msg;
  const send = el('button', 'wb-btn primary', t('chat.send')); send.dataset.fk = 'steer:send';
  if (!elig.ok) { input.disabled = true; send.disabled = true; input.title = elig.msg; }
  else {
    // 对抗轮 P2: 先清空防连击重复发送;失败(409/断网)回填并聚焦——聚焦令 keepSteer 在下一轮重建中保住文本。
    const submit = async () => {
      const t2 = (input.value || '').trim(); if (!t2) return;
      input.value = '';
      const ok = await steerAgentNode(run.id, node.id, node.status, t2, node.engine);
      if (ok === false) { const inp = $('wbSteerInput'); if (inp && !inp.disabled) { inp.value = t; inp.focus(); } else toast(t('workflow.steerBox.unsent', { text: t2.slice(0, 80) }), 'err'); }
    };
    send.onclick = submit;
    // 对抗轮 P2: isComposing 守卫——中文输入法选字回车不再把半截拼音直接发出去(与主 composer 同款守卫)。
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
  }
  boxrow.append(input, send); wrap.appendChild(boxrow);
  if (!elig.ok) wrap.appendChild(el('div', 'wb-steer-why', elig.msg));   // 禁用原因(与后端 409 文案一致)
  return wrap;
}
// 段2 体:任务池审批(§6#7)。proposed 项 → 三行人话卡(谁提议/做什么/预计消耗)+ 同意添加/不用了(pool_approve|reject)。
//   waiting_pool 宽限窗倒计时细进度条。已决项 → 紧凑状态行。空池 → 占位。
function wbPoolBody(run) {
  const pool = Array.isArray(run.taskPool) ? run.taskPool : [];
  if (!pool.length) return el('div', 'wb-det-empty', t('workflow.pool.empty'));
  const box = el('div', 'wb-pool');
  if (run.status === 'waiting_pool' && run.live) {
    const remainMs = run.poolGraceUntil ? Math.max(0, Number(run.poolGraceUntil) - Date.now()) : 0;
    const grace = el('div', 'wb-pool-grace'); const bar = el('div', 'wb-pool-grace-bar'); const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, Math.round((remainMs / POOL_GRACE_HINT_MS) * 100)))}%`; bar.appendChild(fill); grace.appendChild(bar);
    grace.appendChild(el('span', 'wb-pool-grace-label num', t('workflow.pool.graceLeft', { secs: Math.round(remainMs / 1000) }))); box.appendChild(grace);
  }
  for (const item of pool) {
    if (item.status === 'proposed') {
      const whoNode = (run.nodes || []).find(n => n.id === item.proposedBy);
      const whoLabel = whoNode ? (whoNode.roleLabel || whoNode.id) : (item.proposedBy || t('workflow.pool.unknownNode'));
      const card = el('div', 'wb-pool-card');
      const who = el('div', 'wb-pool-line'); who.appendChild(el('span', 'k', t('workflow.pool.who'))); who.appendChild(document.createTextNode(whoLabel)); card.appendChild(who);
      const what = el('div', 'wb-pool-line'); what.appendChild(el('span', 'k', t('workflow.pool.what'))); what.appendChild(document.createTextNode(String(item.task || '').trim())); card.appendChild(what);
      card.appendChild(el('div', 'wb-pool-line muted num', t('workflow.pool.cost', { iters: item.maxIters || 100 })));
      if (run.live) {
        const acts = el('div', 'wb-pool-actions');
        const yes = el('button', 'wb-btn primary', t('workflow.pool.approve')); yes.setAttribute('aria-label', t('workflow.pool.approveAria')); yes.dataset.fk = `pool:${item.id}:y`; yes.onclick = () => poolDecide(run.id, item.id, true);
        const no = el('button', 'wb-btn', t('workflow.pool.reject')); no.setAttribute('aria-label', t('workflow.pool.rejectAria')); no.dataset.fk = `pool:${item.id}:n`; no.onclick = () => poolDecide(run.id, item.id, false);
        acts.append(yes, no); card.appendChild(acts);
      }
      box.appendChild(card);
    } else {
      box.appendChild(el('div', 'wb-pool-decided', `${poolStatusLabel(item.status)}${item.resultNodeId ? ' · ' + t('workflow.pool.node', { id: item.resultNodeId }) : ''}：${String(item.task || '').replace(/s+/g, ' ').slice(0, 40)}`));
    }
  }
  return box;
}
// 段3 体:邮箱消息流(§6#8)。run.messages 时间线,每条 sender → target · 摘要 + 送达/未送达状态。只读。空 → 占位。
function wbMailBody(run) {
  const mails = Array.isArray(run.messages) ? run.messages : [];
  if (!mails.length) return el('div', 'wb-det-empty', t('workflow.mail.empty'));
  const box = el('div', 'wb-mail');
  for (const m of mails) {
    const item = el('div', `wb-mail-item${m.dropped ? ' dropped' : ''}`);
    item.appendChild(el('div', 'wb-mail-ico', '✉'));
    const body = el('div', 'wb-mail-body');
    const route = el('div', 'wb-mail-route num'); route.appendChild(document.createTextNode(m.sender || '?')); route.appendChild(el('span', 'wb-mail-arw', '→')); route.appendChild(document.createTextNode(m.target || '?')); body.appendChild(route);
    body.appendChild(el('div', 'wb-mail-text', String(m.text || '')));
    const meta = el('div', 'wb-mail-meta num');
    if (m.dropped) { meta.appendChild(document.createTextNode(m.createdAt ? new Date(m.createdAt).toLocaleTimeString() : '')); meta.appendChild(el('span', 'wb-mail-badge', t('workflow.mail.dropped'))); }
    else if (m.deliveredAt) meta.appendChild(document.createTextNode(t('workflow.mail.delivered', { time: new Date(m.deliveredAt).toLocaleTimeString() })));
    else meta.appendChild(document.createTextNode(t('workflow.mail.pending')));
    body.appendChild(meta); item.appendChild(body); box.appendChild(item);
  }
  return box;
}

  function isWorkbenchCanvasView() {
    return wbState.view === 'canvas';
  }

  function markWorkbenchConnectionLost() {
    if (!isWorkbenchCanvasView()) return;
    const usage = $('wbUsage');
    if (usage) usage.textContent = t('workflow.connectionLost');
    wbState.renderSig = null;
  }

  function bindWorkbench() {
    document.querySelectorAll('.wb-mainview-tabs .wb-mv-tab').forEach(button => {
      button.onclick = () => switchMainView(button.dataset.mainView);
    });
    const backdrop = $('wbSideBackdrop');
    if (backdrop) backdrop.onclick = () => wbOpenSide(false);
  }

  return Object.freeze({
    bindWorkbench,
    isWorkbenchCanvasView,
    markWorkbenchConnectionLost,
    restoreMainView,
    wbNativeClaudeFinalize,
    wbNativeClaudeOnSubagent,
    wbOnRuns,
  });
}
