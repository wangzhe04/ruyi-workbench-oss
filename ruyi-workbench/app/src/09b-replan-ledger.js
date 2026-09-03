// 09b-replan-ledger.js - 110-4a: 从 09-workflow.js 搬出的节点续点与重规划补丁账本(纯搬家,零行为变更)。
// ============================================================================
// 第25波 25.4(AUTONOMY-PLAN §4 Node Runtime):节点续点 —— 把本次 attempt 已完成的工具步骤折叠为轻量
// continuation(name+参数摘要 → 结果摘要),挂在 node 上随既有 1.5s 节流 flush 落盘。进程崩溃后,恢复重跑
// 用它在提示词里声明「这些副作用已生效勿重复」,而不是让 40 分钟的长节点从零重来。刻意【不】重放 subHistory
// (全量历史重放属后续波);这里只保证:①步骤清单可核对;②不可逆副作用不被盲目重放(红线)。
// steps 上限 40 条、参数/结果摘要各 ≤200/160 字符 —— 最坏 ~15KB,不吹爆 run JSON。
function recordNodeContinuation(node, evt) {
  if (!evt || (evt.type !== 'tool_use' && evt.type !== 'tool_result')) return;
  let c = node.continuation;
  if (!c || c.attemptId !== node.attempts) c = node.continuation = { attemptId: node.attempts, steps: [], pending: {}, updatedAt: '' };
  if (!c.pending || typeof c.pending !== 'object' || Array.isArray(c.pending)) c.pending = {};
  // 对抗轮修 P1: pending 按 evt.id 键控 —— Claude 引擎一条 assistant 消息里的【并行 tool_use】会连续到达
  // (tool_use A, tool_use B, tool_result A, tool_result B),单槽 pending 会把 A 的结果配到 B 的参数上,
  // 断点清单随之断言假事实(「B 已生效」实为 A)——直接违反"不可逆副作用不被盲目重放"红线。
  // 对抗轮修 P2(安全): argsPreview/resultDigest 扁平化空白(与 mail/pool 摘要同款纪律)—— 原始工具返回字节
  // 里的换行若原样进入【断点续跑】受信指令块,可伪造"额外已完成步骤"或续写指令(跨崩溃边界的注入放大)。
  const flat = s => String(s || '').replace(/\s+/g, ' ');
  const evtId = String(evt.id || '');
  if (evt.type === 'tool_use') {
    let argsStr = ''; try { argsStr = JSON.stringify(evt.input || {}); } catch { argsStr = ''; }
    c.pending[evtId] = {
      tool: flat(evt.name).slice(0, 80),
      argsHash: crypto.createHash('sha1').update(argsStr).digest('hex').slice(0, 12),
      argsPreview: flat(argsStr).slice(0, 200),
    };
    // 防泄压:极端情况下(只有 tool_use 没等到 result 的崩溃/异常流)pending 无界 —— 留最近 16 个。
    const keys = Object.keys(c.pending); if (keys.length > 16) delete c.pending[keys[0]];
  } else {
    const step = c.pending[evtId] || { tool: '?', argsHash: '', argsPreview: '' };
    delete c.pending[evtId];
    step.ok = evt.isError !== true;
    let digest = ''; try { digest = typeof evt.content === 'string' ? evt.content : JSON.stringify(evt.content); } catch { digest = ''; }
    step.resultDigest = flat(digest).slice(0, 160);
    c.steps.push(step);
    if (c.steps.length > 40) c.steps.splice(0, c.steps.length - 40);
  }
  c.updatedAt = nowIso();
}

// R5(16-r5-replan-ledger.md): 可审查重规划提案层 —— 数据契约 + 机器校验 + 生成助手。
// 所有自动化止于候选/提案:只生成 status='pending' 的 patch,绝不自动应用/改写图/越权。零迁移:
// 节点未声明 replan=true 时不生成;run.replanPatches 默认 []。审批/应用/回滚是后续切片。
const REPLAN_TRIGGER_TYPES = new Set(['node_failed', 'gate_rejected', 'evidence_gap', 'stall', 'resource_conflict']);
const REPLAN_CHANGE_OPS = new Set(['add_node', 'remove_node', 'rewire', 'change_tier', 'change_engine', 'change_role', 'inherit_evidence', 'drop_evidence']);
const REPLAN_PATCH_MAX = 8; // 每 run 提案上限(对齐 taskPool POOL_MAX_TOTAL,防提案洪水)

function validateReplanPatch(run, patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch 必须是对象' };
  const trig = patch.trigger;
  if (!trig || !REPLAN_TRIGGER_TYPES.has(trig.type)) return { ok: false, error: '非法或缺失触发类型' };
  const changes = Array.isArray(patch.changes) ? patch.changes : null;
  if (!changes) return { ok: false, error: 'changes 必须是数组(可为空,表示待补充)' };
  const nodes = Array.isArray(run && run.nodes) ? run.nodes : [];
  const nodeIds = new Set(nodes.map(n => n.id));
  const tierRank = { read: 0, edit: 1, exec: 2 };
  for (const c of changes) {
    if (!c || !REPLAN_CHANGE_OPS.has(c.op)) return { ok: false, error: `非法 op: ${c && c.op}` };
    const tgt = String(c.target || '');
    if (c.op === 'add_node') {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tgt)) return { ok: false, error: 'add_node 的 target 必须是合法 id' };
      if (nodeIds.has(tgt)) return { ok: false, error: `add_node 的 target 已存在: ${tgt}` };
    } else {
      if (!tgt || !nodeIds.has(tgt)) return { ok: false, error: `change target 不存在: ${tgt}` };
      if (c.op === 'change_tier') {
        const curNode = nodes.find(n => n.id === tgt);
        const cur = tierRank[curNode && curNode.toolTier] != null ? tierRank[curNode.toolTier] : 0;
        const next = tierRank[c.to];
        if (next == null || next > cur) return { ok: false, error: 'change_tier 不得抬高权限层级' };
      }
    }
  }
  return { ok: true };
}

function proposeReplanPatch(run, trigger, changes) {
  const patch = {
    id: makeId('replan'), runId: run && run.id, sessionId: run && run.sessionId,
    trigger: trigger && typeof trigger === 'object' ? trigger : { type: 'node_failed', nodeId: '', errorClass: '', detail: '' },
    changes: Array.isArray(changes) ? changes : [],
    expected: { costDelta: 0, riskLevel: 'low', rollbackPoint: '' },
    status: 'pending', createdAt: nowIso(), decidedAt: null, appliedAt: null,
  };
  const v = validateReplanPatch(run, patch);
  if (!v.ok) return { ok: false, error: v.error, patch };
  if (patch.changes.some(c => c.op === 'remove_node' || c.op === 'rewire' || c.op === 'change_tier')) patch.expected.riskLevel = 'medium';
  if (!Array.isArray(run.replanPatches)) run.replanPatches = [];
  if (run.replanPatches.length >= REPLAN_PATCH_MAX) return { ok: false, error: `重规划提案已达上限(${REPLAN_PATCH_MAX})`, patch };
  run.replanPatches.push(patch);
  return { ok: true, patch };
}

// R5(16-r5-replan-ledger.md §3.3): 应用/回滚引擎 —— 纯确定性图操作,不含审批(审批路由接 UI 是后续切片)。
// 本切片支持两个安全 op:change_tier(仅降级)与 add_node(补节点)。remove_node/rewire/change_engine/
// change_role/inherit_evidence/drop_evidence 涉及下游一致性/角色引擎解析/证据图变更,留后续切片。
// 应用前 snapshot run.nodes 到 replanBaseline(仅首次),回滚即恢复基线。机器校验复用 validateReplanPatch。
function applyReplanPatch(run, patchId) {
  try {
    if (!run || typeof run !== 'object') return { ok: false, error: 'run 无效' };
    const patches = Array.isArray(run.replanPatches) ? run.replanPatches : [];
    const patch = patches.find(p => p && String(p.id) === String(patchId || ''));
    if (!patch) return { ok: false, error: 'replan patch 不存在' };
    if (patch.status !== 'pending') return { ok: false, error: `patch 状态不是 pending(${patch.status})` };
    const v = validateReplanPatch(run, patch);
    if (!v.ok) return { ok: false, error: v.error };
    const nodes = Array.isArray(run.nodes) ? run.nodes : [];
    // 应用前基线快照:仅首次(多次 patch 共用同一 baseline,回滚回到最初图)。
    if (run.replanBaseline === null || run.replanBaseline === undefined) {
      run.replanBaseline = JSON.parse(JSON.stringify(nodes));
    }
    let applied = 0;
    for (const c of patch.changes) {
      if (c.op === 'change_tier') {
        const node = nodes.find(n => n.id === c.target);
        if (!node) return { ok: false, error: `change_tier target 不存在: ${c.target}` };
        const tierRank = { read: 0, edit: 1, exec: 2 };
        if (tierRank[c.to] == null) return { ok: false, error: 'change_tier 目标 tier 非法' };
        if (tierRank[c.to] > (tierRank[node.toolTier] || 0)) return { ok: false, error: 'change_tier 不得抬高权限层级' };
        node.toolTier = c.to;
        // 重跑该节点:回 queued 并清终态脏数据(与 25.4 重排语义一致)。仅当节点已终态时才重跑。
        if (node.status === 'failed' || node.status === 'rejected' || node.status === 'blocked') {
          node.status = 'queued'; node.error = ''; delete node.errorClass; node.completedAt = null;
        }
        applied += 1;
      } else if (c.op === 'add_node') {
        const id = String(c.target || '');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, error: 'add_node 的 target 必须是合法 id' };
        if (nodes.some(n => n.id === id)) return { ok: false, error: `add_node 的 target 已存在: ${id}` };
        const triggerNode = nodes.find(n => n.id === (patch.trigger && patch.trigger.nodeId)) || null;
        const task = String(c.to || '').trim();
        if (!task) return { ok: false, error: 'add_node 缺少 task(to 字段)' };
        let dependsOn = Array.isArray(c.from) ? c.from.map(String).filter(Boolean).slice(0, 16) : [];
        if (!dependsOn.length && triggerNode) dependsOn = [triggerNode.id];
        const ids = new Set(nodes.map(n => n.id));
        const missing = dependsOn.filter(d => !ids.has(d));
        if (missing.length) return { ok: false, error: `add_node 依赖不存在: ${missing.join(', ')}` };
        const node = {
          id, task: String(c.reason ? ('（重规划补节点：' + String(c.reason).slice(0, 120) + '）\n') : '') + task,
          roleId: '', roleLabel: '', roleSnapshot: null,
          dependsOn, resources: [], isolationMode: 'none',
          toolTier: 'read',
          engine: triggerNode && (triggerNode.engine === 'claude' || triggerNode.engine === 'openai') ? triggerNode.engine : 'openai',
          model: triggerNode ? triggerNode.model : '',
          maxIters: 100, outputSchema: null, gate: null, failurePolicy: 'continue', dependencyPolicy: 'all_success',
          degradedPolicy: 'accept', maxRetries: 0, retryFallback: 'block', minSuccessfulToolCalls: 0,
          condition: null, loop: null, position: null, status: 'queued', attempts: 0, loopIteration: 0,
          noProgressCount: 0, progressFingerprint: '', result: '', structuredResult: null, schemaErrors: [],
          confidence: null, error: '', startedAt: null, completedAt: null, waitingForResources: [], progressLog: [],
          fromReplan: true, replanSourcePatch: String(patch.id),
        };
        nodes.push(node);
        applied += 1;
      } else {
        return { ok: false, error: `本切片不支持 op: ${c.op}(后续切片实现)` };
      }
    }
    run.nodes = nodes;
    patch.status = 'applied'; patch.appliedAt = nowIso();
    return { ok: true, applied, patchId: patch.id };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function rollbackReplanPatch(run, patchId) {
  try {
    if (!run || typeof run !== 'object') return { ok: false, error: 'run 无效' };
    const patches = Array.isArray(run.replanPatches) ? run.replanPatches : [];
    const patch = patches.find(p => p && String(p.id) === String(patchId || ''));
    if (!patch) return { ok: false, error: 'replan patch 不存在' };
    if (patch.status !== 'applied') return { ok: false, error: `patch 状态不是 applied(${patch.status})` };
    if (run.replanBaseline === null || run.replanBaseline === undefined) return { ok: false, error: '无基线快照,无法回滚(基线缺失时禁止再回滚)' };
    run.nodes = JSON.parse(JSON.stringify(run.replanBaseline));
    patch.status = 'rolled_back'; patch.appliedAt = null;
    return { ok: true, patchId: patch.id };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}
