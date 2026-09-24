// 02c-turn-segments.js - 110-3b: 从 02-session-store.js 搬出的回合分段构建器 createTurnSegmentBuilder(纯搬家,零行为变更)。
// 第54波 EC-D: one ordered narrative ledger for both Claude CLI and OpenAI-compatible turns. The ledger is
// additive: engines still persist content/thinking/toolCalls/turnSummary for old clients, while new clients
// use segments to reconstruct the actual text -> tool -> text sequence after a refresh. Tool payloads stay in
// toolCalls; a tool segment only stores its id/name/status/batch reference, avoiding a second copy of large
// inputs/results in the session JSON.
// 117o-A7(用户第七轮走查,两张截图对照:「为啥这个查看全文,不能像 2.0 那样显示呢?第二张图是 2.0 的」):
// 这份账本【在途】也要能下发一份。117m-A5 只往前端送了一段拼好的纯文本(liveTail.full)＋工具名列表,
// 渲染层再怎么写也画不出思考块 / 过程记录 / 工具卡 —— 差距的根子是数据形状,不是渲染。
// liveSnapshot() 是 snapshot() 的【在途只读】版本:同一份 segments,加三重硬顶,并额外带一份
// toolCalls(只有 id/name/inputPreview/status)供前端复用经典壳的工具卡。
//   · 段数硬顶 LIVE_TURN_SEGMENTS_MAX;单段长文本硬顶 LIVE_TURN_SEGMENT_CHARS;
//     全部文本总预算 LIVE_TURN_TEXT_BUDGET(与 04 的 LIVE_FULL_CHARS 同量级);
//   · 超顶一律从【头部】丢弃并置 truncated:true —— 用户要看的是「它现在在说什么」,
//     砍掉的应该是最早那段;
//   · **工具结果一个字节都不出现在这里**。结果可能是整份文件、可能含密钥,而这条信封是
//     「看一眼它在干嘛」用的,不是审计面。回合一结束真消息落盘,经典壳照常拿到全部。
// snapshot()(落盘那一份)与本函数各走各的:落盘形状一个字节不变。
function createTurnSegmentBuilder() {
  // 这几个常量与这个小函数【故意留在函数体内】:dev-harness/turn-narrative.static.e2e.js 是把
  // createTurnSegmentBuilder 整段抠出来在 vm 沙箱里跑的,挂在模块顶层的东西那边一个也看不见。
  const LIVE_TURN_SEGMENTS_MAX = 200;
  // 单段硬顶与 04 的 LIVE_FULL_CHARS 取同一个数:一段大长文里前端能看到的量,两条路一致。
  const LIVE_TURN_SEGMENT_CHARS = 12000;
  // 总预算取它的两倍 —— 叙事里除了正文还有【思考】段(2.0 那张截图上就是「思考 · 3222 字」),
  // A5 的 full 只攒 assistant_delta,不含思考,所以这里的总量本来就该比它宽一档。
  const LIVE_TURN_TEXT_BUDGET = 24000;
  const LIVE_TURN_PREVIEW_CHARS = 200;
  // 只有这两个键装得下长文本;其余字段(status/name/planId…)都是短标量,不进预算。
  const LIVE_TURN_LONG_KEYS = ['text', 'markdown'];
  // 工具卡头一行的「参数摘要」挑哪个字段:与前端 chat-render-primitives.js 的 TC_ARG_KEYS 逐字对齐
  // (dev-harness/live-full-text.static.e2e.js 有一条断言把两份列表钉成必须【完全相等】,谁先漂谁当场红)。
  // 这里只做【传输上限】(200 字),真正上屏的中间省略仍由前端那一个 middleEllipsis 做 —— 截断口径只有一处。
  const LIVE_TURN_ARG_KEYS = ['path', 'url', 'command', 'pattern', 'root', 'query', 'title', 'text'];
  const liveTurnInputPreview = input => {
    if (!input || typeof input !== 'object') return '';
    for (const key of LIVE_TURN_ARG_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value.trim() !== '') {
        return value.replace(/\s+/g, ' ').trim().slice(0, LIVE_TURN_PREVIEW_CHARS);
      }
    }
    return '';
  };
  const segments = [];
  const toolSegments = new Map();
  // 117o-A7:工具参数摘要【与段分开存】—— 落盘的 snapshot() 一个字节都拿不到它(段上不加字段),
  // 只有在途的 liveSnapshot() 会去查。有界:条数与段数同顶,超顶丢最早的。
  const toolPreviews = new Map();
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
      // 117o-A7:参数摘要只进这张【旁挂】表,不进段 —— 落盘形状因此逐字节不变。
      toolPreviews.set(toolCallId, liveTurnInputPreview(evt.input));
      while (toolPreviews.size > LIVE_TURN_SEGMENTS_MAX) toolPreviews.delete(toolPreviews.keys().next().value);
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
        if (evt.background === true) segment.background = true; // 代理模式 v2:后台 run 的节点,回合收尾不标 cancelled
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
      if (evt.background === true) segment.background = true; // 代理模式 v2:后台 run 与父回合解耦
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
  const keepable = segment => segment
    && (segment.type !== 'text' && segment.type !== 'thinking' && segment.type !== 'note' || String(segment.text || '').length);
  const snapshot = () => segments
    .filter(keepable)
    .map(segment => ({ ...segment }));
  // 117o-A7:在途只读快照(见文件头注)。从【尾巴】往回收,收满三重硬顶就停,停下来时前面还有段
  // 就置 truncated:true —— 丢的一定是最早那段。返回的 toolCalls 只有四个键,**没有 result**。
  const liveSnapshot = () => {
    const kept = [];
    let budget = LIVE_TURN_TEXT_BUDGET;
    let truncated = false;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i];
      if (!keepable(segment)) continue;
      if (kept.length >= LIVE_TURN_SEGMENTS_MAX || budget <= 0) { truncated = true; break; }
      const copy = { ...segment };
      for (const key of LIVE_TURN_LONG_KEYS) {
        const value = typeof copy[key] === 'string' ? copy[key] : '';
        if (!value) continue;
        const room = Math.min(budget, LIVE_TURN_SEGMENT_CHARS);
        if (value.length > room) { copy[key] = value.slice(value.length - room); copy.truncated = true; truncated = true; }
        budget -= String(copy[key]).length;
      }
      kept.push(copy);
    }
    kept.reverse();
    const toolCalls = [];
    for (const segment of kept) {
      if (segment.type !== 'tool') continue;
      const toolCallId = String(segment.toolCallId || '');
      toolCalls.push({
        id: toolCallId,
        name: String(segment.name || 'tool'),
        inputPreview: String(toolPreviews.get(toolCallId) || ''),
        status: String(segment.status || ''),
      });
    }
    return { segments: kept, toolCalls, truncated };
  };
  // 47b/86 修复「工具超时但一直卡在运行中」:回合被 Stop/看门狗/异常中止时,正在执行的 tool/subagent/
  // workflow 段永远拿不到 tool_result/end 事件,会以 status:'running' 落盘并在刷新后永远显示「运行中」。
  // finalizeAll 在回合收尾 snapshot() 之前把这类悬空段诚实标终态 'cancelled'(前端 pill 词汇已有 cancelled),
  // 与 loadSession 的 healStalePendingSegments 同语义 -- 区别是这里在落盘前修,免去重进会话才修复的窗口。
  // 代理模式 v2:后台代理 run(segment.background)与父回合解耦 —— 回合结束它仍在跑,不能标 cancelled;改标 'background'
  // (静态重绘读作「后台运行」,真实终态看代理面板/后台任务条)。
  const finalizeAll = (reason) => {
    const note = String(reason || 'turn ended; in-flight tool was interrupted').slice(0, 200);
    let healed = 0;
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.background === true && (seg.type === 'subagent' || seg.type === 'workflow')) {
        if (seg.status === 'running' || seg.status === 'paused') seg.status = 'background';
        continue;
      }
      if ((seg.type === 'tool' || seg.type === 'subagent') && seg.status === 'running') {
        seg.status = 'cancelled'; seg.note = note; healed += 1;
      } else if (seg.type === 'workflow' && (seg.status === 'running' || seg.status === 'paused')) {
        seg.status = 'cancelled'; seg.note = note; healed += 1;
      }
    }
    return healed;
  };
  return { consume, snapshot, liveSnapshot, createBatchId, finalizeAll };
}
