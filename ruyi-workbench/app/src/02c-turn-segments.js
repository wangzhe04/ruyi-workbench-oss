// 02c-turn-segments.js - 110-3b: 从 02-session-store.js 搬出的回合分段构建器 createTurnSegmentBuilder(纯搬家,零行为变更)。
// 第54波 EC-D: one ordered narrative ledger for both Claude CLI and OpenAI-compatible turns. The ledger is
// additive: engines still persist content/thinking/toolCalls/turnSummary for old clients, while new clients
// use segments to reconstruct the actual text -> tool -> text sequence after a refresh. Tool payloads stay in
// toolCalls; a tool segment only stores its id/name/status/batch reference, avoiding a second copy of large
// inputs/results in the session JSON.
function createTurnSegmentBuilder() {
  const segments = [];
  const toolSegments = new Map();
  const subagentSegments = new Map();
  const permissionSegments = new Map();
  const questionSegments = new Map();
  const planSegments = new Map();
  const kimiPlanSnapshotSegments = new Map();
  const workflowSegments = new Map();
  const missionSegments = new Map();
  let segmentSeq = 0;
  let batchSeq = 0;
  let fallbackBatchId = '';
  let lastEventType = '';
  const nextId = () => `segment-${++segmentSeq}`;
  const createBatchId = engine => `${String(engine || 'turn')}-batch-${++batchSeq}`;
  const appendText = (type, text) => {
    const value = String(text || '');
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += value;
    else segments.push({ id: nextId(), type, text: value });
    fallbackBatchId = '';
    lastEventType = type;
  };
  const consume = evt => {
    if (!evt || typeof evt !== 'object') return;
    if (evt.type === 'assistant_delta') { appendText('text', evt.text); return; }
    if (evt.type === 'thinking_delta') { appendText('thinking', evt.text); return; }
    if (evt.type === 'tool_use' && !evt.subagentId) {
      const toolCallId = String(evt.id || '');
      if (!toolCallId || toolSegments.has(toolCallId)) return;
      if (lastEventType !== 'tool_use') fallbackBatchId = '';
      const batchId = String(evt.batchId || fallbackBatchId || createBatchId('turn'));
      fallbackBatchId = batchId;
      const segment = { id: nextId(), type: 'tool', toolCallId, name: String(evt.name || 'tool'), batchId, status: 'running' };
      segments.push(segment);
      toolSegments.set(toolCallId, segment);
      lastEventType = 'tool_use';
      return;
    }
    if (evt.type === 'tool_result' && !evt.subagentId) {
      const segment = toolSegments.get(String(evt.id || ''));
      if (segment) segment.status = evt.isError ? 'error' : 'done';
      fallbackBatchId = '';
      lastEventType = 'tool_result';
      return;
    }
    if (evt.type === 'subagent') {
      const key = String(evt.id || '');
      if (!key) return;
      if (evt.state === 'start' && !subagentSegments.has(key)) {
        const segment = { id: nextId(), type: 'subagent', toolCallId: key, status: 'running' };
        segments.push(segment); subagentSegments.set(key, segment);
      } else if (subagentSegments.has(key) && (evt.state === 'end' || evt.state === 'background')) {
        subagentSegments.get(key).status = evt.state === 'background' ? 'running' : (evt.ok === false ? 'error' : 'done');
      }
      fallbackBatchId = '';
      lastEventType = 'subagent';
      return;
    }
    if (evt.type === 'permission_request') {
      const requestId = String(evt.requestId || '');
      if (!requestId || permissionSegments.has(requestId)) return;
      const segment = {
        id: nextId(), type: 'permission', requestId,
        toolName: String(evt.toolName || 'tool'), tier: String(evt.tier || 'exec'),
        revertible: evt.revertible === true, status: 'pending',
      };
      segments.push(segment); permissionSegments.set(requestId, segment);
      fallbackBatchId = ''; lastEventType = 'permission';
      return;
    }
    if (evt.type === 'permission_paused' || evt.type === 'permission_decision') {
      const segment = permissionSegments.get(String(evt.requestId || ''));
      if (segment) {
        if (evt.type === 'permission_paused') segment.status = 'paused';
        else {
          segment.status = evt.behavior === 'allow' ? 'allowed' : 'denied';
          if (evt.message) segment.note = String(evt.message).slice(0, 500);
        }
      }
      fallbackBatchId = ''; lastEventType = evt.type;
      return;
    }
    if (evt.type === 'kimi_plan_snapshot') {
      const planId = String(evt.planId || '');
      if (!planId) return;
      let segment = kimiPlanSnapshotSegments.get(planId);
      if (!segment) {
        segment = {
          id: nextId(), type: 'plan', planId, markdown: String(evt.markdown || ''),
          status: evt.status === 'removed' ? 'removed' : 'snapshot', readOnly: true,
          source: 'kimi-acp', path: String(evt.path || ''),
        };
        segments.push(segment);
        kimiPlanSnapshotSegments.set(planId, segment);
      } else {
        if (Object.prototype.hasOwnProperty.call(evt, 'markdown')) segment.markdown = String(evt.markdown || '');
        segment.status = evt.status === 'removed' ? 'removed' : 'snapshot';
        if (Object.prototype.hasOwnProperty.call(evt, 'path')) segment.path = String(evt.path || '');
        segment.readOnly = true;
        segment.source = 'kimi-acp';
      }
      fallbackBatchId = ''; lastEventType = 'kimi_plan_snapshot';
      return;
    }
    if (evt.type === 'plan') {
      const markdown = String(evt.markdown || '');
      const last = segments[segments.length - 1];
      // Provider streaming already emitted the plan as assistant_delta. Replace that duplicate text block with
      // the semantic plan segment so static re-entry renders it once, as a decision point.
      if (last && last.type === 'text' && last.text.trim() === markdown.trim()) segments.pop();
      const segment = { id: nextId(), type: 'plan', planId: String(evt.planId || ''), markdown, status: 'pending' };
      segments.push(segment);
      if (segment.planId) planSegments.set(segment.planId, segment);
      fallbackBatchId = '';
      lastEventType = 'plan';
      return;
    }
    if (evt.type === 'plan_decision') {
      const segment = planSegments.get(String(evt.planId || ''));
      if (segment) {
        segment.status = evt.decision === 'approve' ? 'approved' : 'rejected';
        if (evt.note) segment.note = String(evt.note).slice(0, 2000);
      }
      fallbackBatchId = ''; lastEventType = 'plan_decision';
      return;
    }
    if (evt.type === 'plan_note') { appendText('note', evt.text); return; }
    if (evt.type === 'ask_user') {
      const segment = {
        id: nextId(), type: 'question', questionId: String(evt.questionId || evt.id || ''),
        questions: evt.questions || [], status: 'pending',
      };
      segments.push(segment);
      if (segment.questionId) questionSegments.set(segment.questionId, segment);
      fallbackBatchId = '';
      lastEventType = 'question';
      return;
    }
    if (evt.type === 'question_answer') {
      const segment = questionSegments.get(String(evt.questionId || evt.id || ''));
      if (segment) {
        segment.status = evt.ok === false ? 'cancelled' : 'answered';
        if (evt.summary) segment.answerSummary = String(evt.summary).slice(0, 500);
      }
      fallbackBatchId = ''; lastEventType = 'question_answer';
      return;
    }
    if (evt.type === 'agent_workflow') {
      const workflowId = String(evt.id || 'workflow');
      let segment = workflowSegments.get(workflowId);
      if (!segment) {
        segment = { id: nextId(), type: 'workflow', workflowId, status: 'running', state: String(evt.state || 'running'), eventCount: 0 };
        segments.push(segment); workflowSegments.set(workflowId, segment);
      }
      segment.eventCount += 1;
      segment.state = String(evt.state || segment.state || 'running');
      if (Number.isFinite(Number(evt.nodeCount))) segment.nodeCount = Number(evt.nodeCount);
      if (evt.nodeId != null) segment.lastNodeId = String(evt.nodeId);
      if (Number.isFinite(Number(evt.succeeded))) segment.succeeded = Number(evt.succeeded);
      if (Number.isFinite(Number(evt.failed))) segment.failed = Number(evt.failed);
      if (evt.state === 'end') segment.status = evt.status === 'completed' || Number(evt.failed) === 0 ? 'done' : 'error';
      else if (evt.state === 'run_paused' || evt.state === 'pool_waiting' || evt.state === 'node_wait') segment.status = 'paused';
      else segment.status = 'running';
      fallbackBatchId = ''; lastEventType = 'workflow';
      return;
    }
    if (evt.type === 'mission') {
      const mission = evt.mission && typeof evt.mission === 'object' ? evt.mission : {};
      const missionId = String(mission.id || mission.createdAt || 'active');
      let segment = missionSegments.get(missionId);
      if (!segment) {
        segment = { id: nextId(), type: 'mission', missionId, status: 'updated' };
        segments.push(segment); missionSegments.set(missionId, segment);
      }
      const milestones = Array.isArray(mission.milestones) ? mission.milestones : [];
      segment.goal = String(mission.goal || '').slice(0, 500);
      segment.completed = milestones.filter(item => item && item.status === 'done').length;
      segment.total = milestones.length;
      segment.state = String(evt.state || 'updated');
      segment.status = evt.state === 'complete' ? 'done'
        : (evt.state === 'stuck' || evt.state === 'budget_exhausted' ? 'error' : 'updated');
      if (evt.reason) segment.note = String(evt.reason).slice(0, 500);
      fallbackBatchId = ''; lastEventType = 'mission';
      return;
    }
    if (evt.type === 'steered') {
      // EC-D 56b: 插话作为 turn narrative 内的 segment 持久化(与 live 内嵌同源),刷新后静态渲染也内嵌在助手回合内,
      //   不再回退为独立 user 行(消除 live↔静态视觉差异)。位置由事件流顺序决定(注入时机点 = pre 文字之后/post 文字之前)。
      //   空文本守卫与 appendText 一致(API 层已拒空文本,此为防御性兜底,防空 steer 段渲染空 bubble)。
      const steerText = String(evt.text || '');
      if (!steerText.trim()) return;
      segments.push({ id: nextId(), type: 'steer', text: steerText });
      fallbackBatchId = ''; lastEventType = 'steer';
      return;
    }
    if (evt.type === 'result' && evt.ok === false && (evt.error || evt.reason)) {
      segments.push({
        id: nextId(), type: 'error',
        text: String(evt.error || evt.reason || '').slice(0, 4000),
        errorClass: String(evt.errorClass || ''),
      });
      fallbackBatchId = ''; lastEventType = 'error';
    }
  };
  const snapshot = () => segments
    .filter(segment => segment && (segment.type !== 'text' && segment.type !== 'thinking' && segment.type !== 'note' || String(segment.text || '').length))
    .map(segment => ({ ...segment }));
  // 47b/86 修复「工具超时但一直卡在运行中」:回合被 Stop/看门狗/异常中止时,正在执行的 tool/subagent/
  // workflow 段永远拿不到 tool_result/end 事件,会以 status:'running' 落盘并在刷新后永远显示「运行中」。
  // finalizeAll 在回合收尾 snapshot() 之前把这类悬空段诚实标终态 'cancelled'(前端 pill 词汇已有 cancelled),
  // 与 loadSession 的 healStalePendingSegments 同语义 -- 区别是这里在落盘前修,免去重进会话才修复的窗口。
  const finalizeAll = (reason) => {
    const note = String(reason || 'turn ended; in-flight tool was interrupted').slice(0, 200);
    let healed = 0;
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      if ((seg.type === 'tool' || seg.type === 'subagent') && seg.status === 'running') {
        seg.status = 'cancelled'; seg.note = note; healed += 1;
      } else if (seg.type === 'workflow' && (seg.status === 'running' || seg.status === 'paused')) {
        seg.status = 'cancelled'; seg.note = note; healed += 1;
      }
    }
    return healed;
  };
  return { consume, snapshot, createBatchId, finalizeAll };
}
