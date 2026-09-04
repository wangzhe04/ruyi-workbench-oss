'use strict';

// 112a/112c: 回合活动状态机(纯模块,零 import、零 DOM、零 t() 依赖)。
//
// 为什么存在:服务端在一个回合里会下发五十多种事件,但「模型现在到底在干什么」这个问题的答案
// 分散在其中十几种里 —— 经典壳把它拆成工具卡片计时、思考面板、步骤条、账本条、电量表五处各说一句,
// Preview 壳只挑「待决 > 班组单节点 > 最近一次 tool_use」拼一句。用户看到的是五个局部,没有一个整体。
// 本模块把事件流折叠成一个可回答三问的状态:【在干什么】phase+action、【干到哪】stepIndex+elapsed、
// 【在等什么】waitingReason。两壳共用同一个状态机,状态条与速报只是它的两种渲染。
//
// 纪律:
//   · 纯函数/纯状态,不碰 DOM、不发请求、不产生用户可见字符串(文案在 describeTurnActivity 里由调用方注入 t())。
//   · 只读事件,绝不回写:consume() 不改变任何服务端行为,关掉整个状态条也不影响回合。
//   · 不承诺 ETA(25 号 §2.3 明确不做)—— 只报已发生的事实:已运行多久、第几次工具调用、上次输出多久前。
//   · TURN_ACTIVITY_CONSUMED / TURN_ACTIVITY_IGNORED 两张表的并集必须等于服务端事件全集,
//     由 dev-harness/progress-events.static.e2e.js 机械对账;新增服务端事件而不登记 => 红。

// 阶段优先级从高到低。同一时刻可能有多个事实成立(例如既在等资源又有活动工具),
// 取用户最需要知道的那一个:要不要我动手 > 上下文在重建 > 卡在等资源 > 班组在跑 > 工具在跑 > 模型在想。
export const TURN_ACTIVITY_PHASES = Object.freeze([
  'waiting_you',
  'compacting',
  'waiting_resource',
  'orchestrating',
  'calling_tool',
  'thinking',
  'idle',
]);

// 状态机认领的事件(consume 的 switch 分支必须与本表逐项对应)。
export const TURN_ACTIVITY_CONSUMED = Object.freeze([
  'adaptive_tool_budget',
  'agent_resource',
  'agent_workflow',
  'ask_user',
  'assistant_delta',
  'budget_guard',
  'compact',
  'context_estimate',
  'error',
  'failover',
  'kimi_plan_decision',
  'kimi_plan_snapshot',
  'loop_recovery',
  'meta',
  'permission_decision',
  'permission_paused',
  'permission_request',
  'plan',
  'plan_decision',
  'process',
  'question_answer',
  'result',
  'resume_recovery',
  'subagent',
  'subagent_no_progress',
  'subagent_progress',
  'thinking_delta',
  'tool_budget',
  'tool_progress',
  'tool_result',
  'tool_use',
  'tool_use_update',
  'usage',
]);

// 状态机【故意不认领】的事件。不代表没人管:多数由两壳的既有渲染路径处理(消息体、原始镜头、
// 侧栏),它们是内容而不是过程状态。逐条豁免理由写在 dev-harness/progress-events.static.e2e.js,
// 那里还会检查「没被任何一壳处理」的条目是否确实登记了理由。
export const TURN_ACTIVITY_IGNORED = Object.freeze([
  'autonomy_grant',
  'autonomy_grant_consumed',
  'mission',
  'observation_reduced',
  'observation_reduction_shadow',
  'plan_note',
  'raw_line',
  'raw_stdout',
  'self_check',
  'session',
  'steered',
  'stderr',
  'subagent_mail_in',
  'subagent_mail_out',
  'subagent_pool_proposed',
  'subagent_steered',
  'subagent_usage',
  'todo',
  'tool_catalog',
  'tool_image',
  'turn_summary',
]);

// 与 preview-task-sheet.js 的 elapsedLabel 同一显示形状(12s / 3m 20s / 1h 05m),但吃毫秒而非日期,
// 且不跨壳 import(经典壳不依赖 Preview 模块)。两处若要改格式,一起改。
export function formatElapsedMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const NOTICE_LIMIT = 4;

function blankState() {
  return {
    turnActive: false,
    startedAt: 0,
    lastEventAt: 0,
    lastOutputAt: 0,
    toolCalls: 0,
    tools: new Map(),          // toolUseId -> { name, startedAt, elapsedMs, budget, deadlineMs, warnMs }
    pending: new Map(),        // key -> { kind, id, label }
    resourceWait: null,        // { resources: [], blockers: [], subagentId }
    compact: null,             // { phase, mode, elapsedMs }
    workflow: null,            // { id, state, nodeId, nodeCount, concurrency }
    subagents: new Map(),      // subagentId -> { task, state, note, stalledCount, budget }
    context: null,             // { tokens, window }
    notices: [],               // [{ key, severity, data }]
    ended: null,               // { ok, reason }
  };
}

// 通知是有界队列:同 key 覆盖(预算警告只留最新一条),超上限丢最旧,回合结束清空。
function pushNotice(state, key, severity, data) {
  const next = { key, severity, data: data || {} };
  const index = state.notices.findIndex(item => item.key === key);
  if (index >= 0) state.notices.splice(index, 1);
  state.notices.push(next);
  while (state.notices.length > NOTICE_LIMIT) state.notices.shift();
}

function setPending(state, key, kind, id, label) {
  state.pending.set(key, { kind, id: String(id || ''), label: String(label || '') });
}

function clearPending(state, key) {
  state.pending.delete(key);
}

export function createTurnActivity({ now = () => Date.now() } = {}) {
  let state = blankState();

  function beginTurn(at) {
    if (state.turnActive) return;
    const started = Number(at) || now();
    state = blankState();
    state.turnActive = true;
    state.startedAt = started;
    state.lastEventAt = started;
    state.lastOutputAt = started;
  }

  function endTurn(ended) {
    state.turnActive = false;
    state.tools.clear();
    state.resourceWait = null;
    state.compact = null;
    state.workflow = null;
    state.ended = ended || null;
    // 待决不随回合结束消失:回合可以在「等你拍板」上停住,状态条要继续说等什么。
  }

  function touchOutput(at) {
    state.lastOutputAt = Number(at) || now();
  }

  function consume(evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = String(evt.type || '');
    if (!type) return;
    const at = now();
    state.lastEventAt = at;

    switch (type) {
      case 'meta':
      case 'process':
        beginTurn(at);
        break;

      case 'assistant_delta':
      case 'thinking_delta':
        beginTurn(at);
        touchOutput(at);
        break;

      case 'tool_use': {
        beginTurn(at);
        touchOutput(at);
        if (evt.subagentId) break; // 班组内部的工具调用不计主线步数,由 orchestrating 概括
        state.toolCalls += 1;
        // 没有 id 就只计步数、不登记活动工具:tool_result 同样没 id，登了就注销不掉，
        // 阶段会一直卡在「正在调用工具」直到回合结束。两个引擎实际都带 id，这只是不给自己埋雷。
        const toolKey = String(evt.id || '');
        if (!toolKey) break;
        state.tools.set(toolKey, {
          name: String(evt.name || ''),
          startedAt: at,
          elapsedMs: 0,
          budget: '',
          deadlineMs: 0,
          warnMs: 0,
        });
        break;
      }

      case 'tool_use_update': {
        const card = state.tools.get(String(evt.id || ''));
        if (card && evt.name) card.name = String(evt.name);
        break;
      }

      case 'tool_progress': {
        // 112b: 长工具心跳。服务端已经在算 elapsedMs,客户端不再自算(自算会在标签页休眠后跳变)。
        const card = state.tools.get(String(evt.id || ''));
        if (!card) break;
        if (Number.isFinite(Number(evt.elapsedMs))) card.elapsedMs = Number(evt.elapsedMs);
        if (evt.state === 'budget_soft') { card.budget = 'soft'; card.warnMs = Number(evt.warnMs) || 0; }
        else if (evt.state === 'budget_hard') { card.budget = 'hard'; card.deadlineMs = Number(evt.deadlineMs) || 0; }
        break;
      }

      case 'tool_result':
        touchOutput(at);
        if (!evt.subagentId) state.tools.delete(String(evt.id || ''));
        break;

      case 'agent_resource': {
        // 112b: 等锁。waiting 带 blockers(谁占着),acquired/released 解除。
        if (evt.state === 'waiting') {
          state.resourceWait = {
            resources: Array.isArray(evt.resources) ? evt.resources.map(String) : [],
            blockers: Array.isArray(evt.blockers) ? evt.blockers.map(String) : [],
            subagentId: String(evt.subagentId || ''),
          };
        } else if (evt.state === 'acquired' || evt.state === 'released') {
          state.resourceWait = null;
        }
        break;
      }

      case 'budget_guard':
        // 112b: 回合 token 预算。warning 是提醒,tripped 是本回合已被拦住。
        pushNotice(state, 'budget_guard', evt.state === 'tripped' ? 'attention' : 'warn', {
          state: String(evt.state || ''),
          axis: String(evt.axis || ''),
          spent: Number(evt.spent) || 0,
          budget: Number(evt.budget) || 0,
        });
        break;

      case 'tool_budget':
        pushNotice(state, 'tool_budget', 'info', {
          state: String(evt.state || ''),
          from: Number(evt.from) || 0,
          to: Number(evt.to) || 0,
          hardLimit: Number(evt.hardLimit) || 0,
        });
        break;

      case 'loop_recovery':
        // 112b: 检测到同一工具打转并注入了纠偏。用户最该知道的是「它在原地绕,已经第几次了」。
        pushNotice(state, 'loop_recovery', 'warn', {
          scope: String(evt.scope || 'turn'),
          tool: String(evt.tool || ''),
          attempt: Number(evt.attempt) || 0,
          max: Number(evt.max) || 0,
          remaining: Number(evt.remaining) || 0,
        });
        break;

      case 'failover':
        pushNotice(state, 'failover', 'warn', { to: String(evt.to || '') });
        break;

      case 'resume_recovery':
        pushNotice(state, 'resume_recovery', 'info', { reason: String(evt.reason || '') });
        break;

      case 'subagent': {
        beginTurn(at);
        const id = String(evt.id || evt.subagentId || '');
        if (!id) break;
        const prior = state.subagents.get(id) || { task: '', state: '', note: '', stalledCount: 0, budget: null };
        prior.state = String(evt.state || '');
        if (evt.task) prior.task = String(evt.task);
        state.subagents.set(id, prior);
        break;
      }

      case 'subagent_progress': {
        const id = String(evt.subagentId || evt.id || '');
        const entry = state.subagents.get(id);
        if (!entry) break;
        entry.note = String(evt.note || '');
        entry.stalledCount = 0; // 有进展就把「原地不动」计数清零
        break;
      }

      case 'subagent_no_progress': {
        // 112b: 子代理连续若干轮没有任何工具调用/产出。这是最典型的「黑盒卡住」信号。
        const id = String(evt.subagentId || '');
        const entry = state.subagents.get(id);
        if (entry) entry.stalledCount = Number(evt.count) || 0;
        pushNotice(state, `subagent_no_progress:${id}`, 'warn', {
          subagentId: id,
          count: Number(evt.count) || 0,
        });
        break;
      }

      case 'adaptive_tool_budget': {
        // 112b: 子代理工具预算被自适应调整。不说的话用户只会看到「它怎么突然多干了几步」。
        const id = String(evt.subagentId || '');
        const entry = state.subagents.get(id);
        const budget = {
          previousLimit: Number(evt.previousLimit) || 0,
          nextLimit: Number(evt.nextLimit) || 0,
          hardLimit: Number(evt.hardLimit) || 0,
        };
        if (entry) entry.budget = budget;
        pushNotice(state, `adaptive_tool_budget:${id}`, 'info', { subagentId: id, ...budget });
        break;
      }

      case 'agent_workflow': {
        beginTurn(at);
        const workflowState = String(evt.state || '');
        if (workflowState === 'end') { state.workflow = null; break; }
        state.workflow = {
          id: String(evt.id || ''),
          state: workflowState,
          nodeId: String(evt.nodeId || (state.workflow && state.workflow.nodeId) || ''),
          nodeCount: Number(evt.nodeCount) || (state.workflow && state.workflow.nodeCount) || 0,
          concurrency: Number(evt.concurrency) || (state.workflow && state.workflow.concurrency) || 0,
        };
        break;
      }

      case 'compact': {
        const phase = String(evt.phase || (evt.afterTokens != null ? 'completed' : 'running'));
        if (phase === 'completed' || phase === 'failed') { state.compact = null; break; }
        state.compact = {
          phase,
          mode: String(evt.mode || ''),
          elapsedMs: Number(evt.elapsedMs) || 0,
        };
        break;
      }

      case 'ask_user':
        setPending(state, 'ask', 'ask', evt.questionId || evt.id, '');
        break;
      case 'question_answer':
        clearPending(state, 'ask');
        break;

      case 'permission_request':
        setPending(state, 'permission', 'permission', evt.requestId, evt.toolName);
        break;
      case 'permission_paused':
        setPending(state, 'permission', 'permission_paused', evt.requestId, evt.toolName);
        break;
      case 'permission_decision':
        clearPending(state, 'permission');
        break;

      case 'plan':
        setPending(state, 'plan', 'plan', evt.planId, '');
        break;
      case 'kimi_plan_snapshot':
        setPending(state, 'plan', 'plan', evt.planId, '');
        break;
      case 'plan_decision':
      case 'kimi_plan_decision':
        clearPending(state, 'plan');
        break;

      case 'usage':
      case 'context_estimate': {
        // 112b: Preview 壳的上下文电量数据源。经典壳自己有电量表,这里只是让两壳共用同一份事实。
        const tokens = Number(evt.contextTokens);
        const window = Number(evt.contextWindow);
        if (Number.isFinite(tokens) && tokens >= 0) {
          state.context = {
            tokens,
            window: Number.isFinite(window) && window > 0 ? window : (state.context && state.context.window) || 0,
            estimated: evt.estimated === true,
          };
        }
        break;
      }

      case 'result':
        endTurn({ ok: evt.ok !== false, reason: String(evt.reason || '') });
        break;

      case 'error':
        endTurn({ ok: false, reason: String(evt.code || evt.error || 'error') });
        break;

      default:
        break; // TURN_ACTIVITY_IGNORED:内容类事件由两壳既有渲染路径处理
    }
  }

  // 壳层在流开始/结束时调用(经典壳的 start/settled、Preview 壳的 envelope.type)。
  function start(at) { beginTurn(at); }
  function settle() { endTurn(state.ended); }
  function reset() { state = blankState(); }

  function snapshot(at) {
    const stamp = Number(at) || now();
    const tools = [...state.tools.values()];
    const activeTool = tools.length ? tools[tools.length - 1] : null;
    const pending = [...state.pending.values()];
    const subagents = [...state.subagents.entries()].map(([id, value]) => ({ id, ...value }));
    const runningSubagents = subagents.filter(item => item.state === 'start' || item.state === 'retry').length;

    let phase = 'idle';
    if (pending.length) phase = 'waiting_you';
    else if (state.compact) phase = 'compacting';
    else if (state.resourceWait) phase = 'waiting_resource';
    else if (state.turnActive && state.workflow) phase = 'orchestrating';
    else if (state.turnActive && activeTool) phase = 'calling_tool';
    else if (state.turnActive) phase = 'thinking';

    const toolElapsedMs = activeTool
      ? Math.max(activeTool.elapsedMs || 0, Math.max(0, stamp - activeTool.startedAt))
      : 0;

    return {
      phase,
      turnActive: state.turnActive,
      turnElapsedMs: state.turnActive ? Math.max(0, stamp - state.startedAt) : 0,
      sinceLastOutputMs: state.turnActive ? Math.max(0, stamp - state.lastOutputAt) : 0,
      toolCalls: state.toolCalls,
      stepIndex: state.toolCalls,
      tool: activeTool ? { name: activeTool.name, elapsedMs: toolElapsedMs, budget: activeTool.budget } : null,
      waiting: pending.length ? { ...pending[pending.length - 1] } : null,
      resourceWait: state.resourceWait ? { ...state.resourceWait } : null,
      compact: state.compact ? { ...state.compact } : null,
      workflow: state.workflow ? { ...state.workflow } : null,
      subagents,
      runningSubagents,
      context: state.context ? { ...state.context } : null,
      notices: state.notices.map(item => ({ ...item })),
      ended: state.ended ? { ...state.ended } : null,
    };
  }

  return { consume, snapshot, start, settle, reset };
}

// ── 渲染侧:结构化状态 -> 一行人话。文案键在四份 locale 里,t() 由调用方注入(与 health-i18n.js 同款)。
// 返回 { severity, label, action, parts, text, notices },两壳各自决定放在哪、怎么排版。
export function describeTurnActivity(snapshot, t) {
  const translate = typeof t === 'function' ? t : (key => key);
  if (!snapshot) return { severity: 'idle', label: '', action: '', parts: [], text: '', notices: [] };

  const phase = String(snapshot.phase || 'idle');
  const label = translate(`turnActivity.phase.${phase}`);
  const parts = [];
  let action = '';
  let severity = 'info';

  if (phase === 'waiting_you') {
    severity = 'attention';
    const waiting = snapshot.waiting || {};
    action = waiting.kind === 'permission' || waiting.kind === 'permission_paused'
      ? translate('turnActivity.waiting.permission', { p1: waiting.label || translate('turnActivity.waiting.someTool') })
      : waiting.kind === 'plan'
        ? translate('turnActivity.waiting.plan')
        : translate('turnActivity.waiting.question');
  } else if (phase === 'compacting') {
    action = translate(`turnActivity.compact.${snapshot.compact && snapshot.compact.phase === 'applied' ? 'applied' : 'running'}`);
  } else if (phase === 'waiting_resource') {
    severity = 'warn';
    const wait = snapshot.resourceWait || {};
    const resources = (wait.resources || []).join('、');
    const blockers = (wait.blockers || []).join('、');
    action = blockers
      ? translate('turnActivity.waiting.resourceBlocked', { p1: resources, p2: blockers })
      : translate('turnActivity.waiting.resource', { p1: resources });
  } else if (phase === 'orchestrating') {
    const workflow = snapshot.workflow || {};
    action = translate('turnActivity.orchestrating.detail', {
      p1: snapshot.runningSubagents || 0,
      p2: workflow.nodeCount || snapshot.subagents.length || 0,
    });
  } else if (phase === 'calling_tool') {
    const tool = snapshot.tool || {};
    action = translate('turnActivity.action.tool', { p1: tool.name || '' });
    if (tool.budget === 'soft') severity = 'warn';
    if (tool.budget === 'hard') severity = 'attention';
    const toolElapsed = formatElapsedMs(tool.elapsedMs);
    if (toolElapsed) parts.push(translate('turnActivity.part.toolElapsed', { p1: toolElapsed }));
  } else if (phase === 'thinking') {
    action = translate('turnActivity.action.thinking');
  } else {
    severity = 'idle';
  }

  if (snapshot.turnActive) {
    const turnElapsed = formatElapsedMs(snapshot.turnElapsedMs);
    if (turnElapsed) parts.push(translate('turnActivity.part.turnElapsed', { p1: turnElapsed }));
    if (snapshot.toolCalls > 0) parts.push(translate('turnActivity.part.step', { p1: snapshot.toolCalls }));
    // 「上次输出多久前」只在真的沉默了才说 —— 每秒都说一遍等于没说。
    if (snapshot.sinceLastOutputMs >= 10000) {
      parts.push(translate('turnActivity.part.silence', { p1: formatElapsedMs(snapshot.sinceLastOutputMs) }));
    }
  }

  const notices = (snapshot.notices || []).map(notice => ({
    severity: notice.severity,
    key: notice.key,
    text: describeTurnNotice(notice, translate),
  })).filter(notice => notice.text);

  // head = 「阶段 · 当前动作」,parts = 后续可省略的细节。窄屏只留 head 与第一段(390px 实测:
  // 整句会被省略号从中间截断,而「在干什么」恰恰在句首,细节在句尾 —— 分段才能按重要性丢)。
  const head = [label, action].filter(Boolean).join(' · ');
  return { severity, label, action, head, parts, text: [head, ...parts].filter(Boolean).join(' · '), notices };
}

export function describeTurnNotice(notice, t) {
  const translate = typeof t === 'function' ? t : (key => key);
  if (!notice || !notice.key) return '';
  const data = notice.data || {};
  const base = String(notice.key).split(':')[0];
  switch (base) {
    case 'budget_guard':
      return data.state === 'tripped'
        ? translate('turnActivity.notice.budgetTripped', { p1: data.spent, p2: data.budget })
        : translate('turnActivity.notice.budgetWarning', { p1: data.spent, p2: data.budget });
    case 'tool_budget':
      return translate('turnActivity.notice.toolBudget', { p1: data.from, p2: data.to });
    case 'loop_recovery':
      return translate('turnActivity.notice.loopRecovery', { p1: data.tool, p2: data.attempt, p3: data.max });
    case 'failover':
      return translate('turnActivity.notice.failover', { p1: data.to });
    case 'resume_recovery':
      return translate('turnActivity.notice.resumeRecovery');
    case 'subagent_no_progress':
      return translate('turnActivity.notice.subagentStalled', { p1: data.count });
    case 'adaptive_tool_budget':
      return translate('turnActivity.notice.adaptiveToolBudget', { p1: data.previousLimit, p2: data.nextLimit });
    default:
      return '';
  }
}
