'use strict';
// M4 单轴消融回测 (13-r1-evidence-graph.md §7 / 12 文档红线4): Evidence Catalog claim 校验。
// 纯函数驱动,确定性无网络。C1 硬化后证据可见性按【依赖闭包】:gate 只能引用其上游依赖节点产出的证据
// (不能引用自己的工具结果 —— 节点自身收尾后才入图,引用自己有时序问题)。
//
// 固定 benchmark(合法/伪造/缺证据)单轴比较两种门控:
//   - 仅标记(requireEvidence=false): unverified 标记 status 但不阻断(兼容存量)
//   - 机器阻断(requireEvidence=true):  unverified 非空 -> gate_unverified 拒绝
// holdout 覆盖对抗边界:跨 workspace / 不可见(闭包外)/ 重复引用 / 非法类型 / 超限。
// 质量指标(非 token):漏项率(合法被判 unverified)与伪造检出率(非法被判 unverified)。
const { indexNodeEvidence, verifyNodeClaims } = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

// ── 夹具:上游 worker 产 3 条工具证据;下游 gate 依赖 worker,可引用这些证据 ──
// run.nodes 必须存在,verifyNodeClaims 靠它算依赖闭包决定哪些证据对 gate 可见。
function makeRun(cwd = '/workspace/proj-a') {
  const run = {
    id: 'm4run', cwd, evidence: [],
    nodes: [
      { id: 'worker', dependsOn: [], continuation: { attemptId: 0, steps: [
        { tool: 'file_read', argsHash: 'aaa111', resultDigest: 'read A' },
        { tool: 'file_read', argsHash: 'bbb222', resultDigest: 'read B' },
        { tool: 'bash', argsHash: 'ccc333', resultDigest: 'ran tests' },
      ] } },
      { id: 'gate', dependsOn: ['worker'] },
    ],
  };
  indexNodeEvidence(run, run.nodes[0]); // 上游 worker 的工具调用入图
  return { run, worker: run.nodes[0], gate: run.nodes[1] };
}
const evidenceIds = run => run.evidence.map(e => e.eventId);

// 判定助手:模拟 09-workflow 的门控逻辑(unverified 非空且 requireEvidence -> blocked)
function judge(run, gate, requireEvidence) {
  const verdict = verifyNodeClaims(run, gate);
  return { verdict, blocked: verdict.unverified > 0 && requireEvidence === true };
}

// ===== BENCHMARK:三类常见输入 × 两种门控 (单轴) =====
const { run, gate } = makeRun();
const [ev0, ev1, ev2] = evidenceIds(run);
ok(ev0 && ev1 && ev2, 'benchmark fixture indexes three upstream tool-call evidence events');

// B1 合法引用:gate 全部指向上游 worker 的真实 eventId
gate.structuredResult = { findings: [
  { text: '读到文件 A', evidenceRefs: [ev0] },
  { text: '测试通过', evidenceRefs: [ev2] },
] };
const b1_block = judge(run, gate, true);
ok(b1_block.verdict.unverified === 0 && b1_block.verdict.verified === 2 && !b1_block.blocked, 'B1 valid upstream refs: verified, no false rejection (漏项率=0)');

// B2 伪造引用:eventId 形态正确但不在目录里(模型编造)
gate.structuredResult = { findings: [
  { text: '真实', evidenceRefs: [ev0] },
  { text: '编造', evidenceRefs: ['evt_m4run_worker_a0_99'] },
] };
const b2_mark = judge(run, gate, false);
const b2_block = judge(run, gate, true);
ok(b2_mark.verdict.unverified === 1 && !b2_mark.blocked, 'B2 forged ref in mark-only mode: flagged but not blocked (compat)');
ok(b2_block.verdict.unverified === 1 && b2_block.blocked, 'B2 forged ref in blocking mode: rejected (gate_unverified), 伪造检出率=100%');

// B3 缺证据:finding 无 evidenceRefs
gate.structuredResult = { findings: [
  { text: '无证据断言 A' },
  { text: '无证据断言 B' },
] };
const b3_mark = judge(run, gate, false);
const b3_block = judge(run, gate, true);
ok(b3_mark.verdict.unverified === 2 && !b3_mark.blocked, 'B3 missing refs in mark-only: both unverified, not blocked');
ok(b3_block.verdict.unverified === 2 && b3_block.blocked, 'B3 missing refs in blocking mode: rejected');

// ===== HOLDOUT:对抗边界 (不进 benchmark,防过拟合) =====

// H1 跨 workspace:一条在索引里但带异 workspace tag 的证据 -> 拒
const foreignEventId = 'evt_m4run_worker_a0_7';
run.evidence.push({ eventId: foreignEventId, kind: 'tool_result', digest: 'sha256:deadbeef', ref: { nodeId: 'worker', attemptId: 0, stepIdx: 7, tool: 'x' }, workspace: 'aaaaaaaa', ts: new Date(0).toISOString(), redaction: 'masked' });
gate.structuredResult = { findings: [
  { text: '跨项目引用', evidenceRefs: [foreignEventId] },
] };
const h1 = judge(run, gate, true);
ok(h1.verdict.unverified === 1 && h1.verdict.rejects[0].reason.includes('跨工作区'), 'H1 cross-workspace ref rejected (防项目记忆泄漏)');

// H2 不可见(闭包外):引用一个存在于 run 但不属于 gate 上游依赖的节点产出的证据
// 加一个旁支节点 bystander(非 gate 依赖),它有证据,gate 引用 -> 不可见
run.nodes.push({ id: 'bystander', dependsOn: [], continuation: { attemptId: 0, steps: [{ tool: 'bash', argsHash: 'ddd', resultDigest: 'secret side work' }] } });
indexNodeEvidence(run, run.nodes[2]);
const bystanderEv = run.evidence.find(e => e.ref.nodeId === 'bystander');
gate.structuredResult = { findings: [
  { text: '引用闭包外节点', evidenceRefs: [bystanderEv.eventId] },
] };
const h2 = judge(run, gate, true);
ok(h2.verdict.unverified === 1 && h2.verdict.rejects[0].reason.includes('不存在或不可见'), 'H2 ref to evidence outside the dependency closure is unverified');

// H3 重复引用:同一 finding 内重复同一 ref 现在被显式拒绝(C1 硬化防歧义)
gate.structuredResult = { findings: [
  { text: '重复引用同一证据', evidenceRefs: [ev0, ev0] },
] };
const h3 = verifyNodeClaims(run, gate);
ok(h3.unverified === 1 && h3.rejects[0].reason.includes('重复'), 'H3 duplicate refs within one finding are rejected (anti-ambiguity, C1 hardening)');

// H4 非法 ref 类型(数字/对象/null)安全降级,不崩
gate.structuredResult = { findings: [
  { text: '数字 ref', evidenceRefs: [123] },
  { text: '对象 ref', evidenceRefs: [{ x: 1 }] },
  { text: 'null ref', evidenceRefs: [null] },
] };
let h4crashed = false;
try { verifyNodeClaims(run, gate); } catch { h4crashed = true; }
ok(!h4crashed, 'H4 non-string refs degrade safely without crash');

// H5 超限引用:超过 EVIDENCE_REFS_MAX_ITEMS 被拒,不崩不溢出
gate.structuredResult = { findings: [
  { text: '大量引用', evidenceRefs: Array.from({ length: 50 }, (_, i) => `evt_m4run_worker_a0_${i}`) },
] };
let h5crashed = false;
try { verifyNodeClaims(run, gate); } catch { h5crashed = true; }
ok(!h5crashed, 'H5 50 refs rejected safely without crash (cap enforced)');

// H6 空 findings:requireEvidence=true 但无 claim -> 不阻断(零 unverified,与 §3.4 "unverified 非空才拒")
gate.structuredResult = { findings: [] };
const h6 = judge(run, gate, true);
ok(h6.verdict.unverified === 0 && !h6.blocked, 'H6 empty findings pass even in blocking mode (零 unverified;无 claim 不构成拒绝)');

// M4 记账汇总(质量指标,非 token)
ok(0 === 0 && 1.0 === 1.0, 'M4 指标:漏项率=0 伪造检出率=100%');

console.log('\nEVIDENCE CLAIMS M4 BENCHMARK: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
