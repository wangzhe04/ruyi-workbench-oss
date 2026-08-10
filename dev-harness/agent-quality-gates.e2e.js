'use strict';
const {
  parseStructuredAgentOutput, validateAgentJsonSchema, normalizeAgentGate,
  aggregateAgentVote, dedupeAgentFindings, aggregateCoverage, propagateAssignments, QUALITY_GATE_OUTPUT_SCHEMA,
  normalizeWorkflowLoop, workflowProgressFingerprint, evaluateNodeToolEvidence,
  indexNodeEvidence, verifyNodeClaims, purgeNodeEvidence, runWorkspaceHash,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
const parsed = parseStructuredAgentOutput('```json\n{"verdict":"pass","confidence":0.9,"summary":"ok"}\n```');
ok(parsed.ok && parsed.value.confidence === 0.9, 'structured output parser accepts fenced JSON');
const primitive = parseStructuredAgentOutput('127');
ok(primitive.ok && primitive.value === 127 && validateAgentJsonSchema(primitive.value, { type: 'integer' }).ok, 'structured output accepts an exact primitive JSON value');
ok(validateAgentJsonSchema(parsed.value, QUALITY_GATE_OUTPUT_SCHEMA).ok, 'quality output validates against JSON Schema');
const invalid = validateAgentJsonSchema({ verdict: 'maybe', confidence: 2 }, QUALITY_GATE_OUTPUT_SCHEMA);
ok(!invalid.ok && invalid.errors.length >= 2, 'schema validator reports enum/range/required failures');
// M3(09-m3-coverage-gate.md): coverage 可选字段 —— 不破坏存量 verify 节点,但带 coverage 时子字段必须齐全
const withCoverage = validateAgentJsonSchema({ verdict: 'pass', confidence: 0.9, summary: 'ok', coverage: { total: 2, handled: 1, unhandled: ['b.js'] } }, QUALITY_GATE_OUTPUT_SCHEMA);
ok(withCoverage.ok, 'quality output with optional coverage field validates');
const noCoverage = validateAgentJsonSchema({ verdict: 'pass', confidence: 0.9, summary: 'ok' }, QUALITY_GATE_OUTPUT_SCHEMA);
ok(noCoverage.ok, 'quality output without coverage still validates (legacy verify compat)');
const badCoverage = validateAgentJsonSchema({ verdict: 'pass', confidence: 0.9, summary: 'ok', coverage: { total: 2 } }, QUALITY_GATE_OUTPUT_SCHEMA);
ok(!badCoverage.ok, 'coverage without required subfields (total/handled/unhandled) is rejected');
ok(normalizeAgentGate(null, 'reviewer').mode === 'review' && normalizeAgentGate(null, 'verifier').mode === 'verify', 'Reviewer and Verifier automatically become quality gates');
const deps = [
  { id: 'a', structuredResult: { verdict: 'pass', confidence: 0.9, findings: [{ title: 'same bug', file: 'a.js', line: 3, confidence: 0.7 }] } },
  { id: 'b', structuredResult: { verdict: 'pass', confidence: 0.8, findings: [{ title: 'same bug', file: 'a.js', line: 3, confidence: 0.95 }] } },
];
const vote = aggregateAgentVote(deps, { threshold: 0.6, minApprovals: 2, minConfidence: 0.7 });
ok(vote.verdict === 'pass' && vote.approvals === 2 && vote.confidence > 0.8, 'vote gate applies approval and confidence thresholds');
const invalidVote = aggregateAgentVote([{ id: 'summary', structuredResult: { answer: 'correct but not a vote' } }], { threshold: 0.5, minApprovals: 1, minConfidence: 0.5 });
ok(invalidVote.verdict === 'invalid' && invalidVote.contractValid === false && invalidVote.invalidVotes[0].id === 'summary', 'vote gate rejects a malformed vote contract instead of reporting a false quality rejection');
const unchangedLowReject = aggregateAgentVote([{ id: 'yes', structuredResult: { verdict: 'pass', confidence: 0.9 } }, { id: 'no', structuredResult: { verdict: 'fail', confidence: 0.5 } }], { threshold: 0.6, minApprovals: 1, minConfidence: 0, abstainThreshold: 0 });
ok(unchangedLowReject.rejections === 1 && unchangedLowReject.score === 0.5 && unchangedLowReject.verdict === 'fail', 'M2: abstainThreshold=0 preserves low-confidence rejection behavior');
const demotedReject = aggregateAgentVote([{ id: 'yes', structuredResult: { verdict: 'pass', confidence: 0.9 } }, { id: 'no', structuredResult: { verdict: 'fail', confidence: 0.5 } }], { threshold: 0.6, minApprovals: 1, minConfidence: 0, abstainThreshold: 0.6 });
ok(demotedReject.verdict === 'pass' && demotedReject.rejections === 0 && demotedReject.abstentions === 1 && demotedReject.votes[1].abstained === true && demotedReject.votes[1].reason === 'low_confidence_demoted', 'M2: low-confidence rejection becomes an auditable abstention');
const normalizedM2 = normalizeAgentGate({ mode: 'coverage', abstainThreshold: 2, inputSet: ['a', 'a', '', 'b'], propagateKey: ' group ' });
ok(normalizedM2.mode === 'coverage' && normalizedM2.abstainThreshold === 1 && normalizedM2.inputSet.join(',') === 'a,b' && normalizedM2.propagateKey === 'group', 'M2: normalizeAgentGate preserves and bounds deterministic gate configuration');
const covered = aggregateCoverage([{ id: 'a', structuredResult: { handledItems: ['one'], findings: [{ evidenceRefs: ['two', 'two'] }] } }], { inputSet: ['one', 'two', 'three'] });
ok(covered.total === 3 && covered.handled === 2 && covered.unhandled.join(',') === 'three' && covered.coverageRatio === 2 / 3, 'M2: coverage computes deterministic unique handled and unhandled sets');
const emptyCoverage = aggregateCoverage([], { inputSet: [] });
ok(emptyCoverage.verdict === 'pass' && emptyCoverage.coverageRatio === 1, 'M2: empty coverage universe is vacuously complete');
const propagated = propagateAssignments([{ id: 'a', structuredResult: { items: [{ id: 'a', group: 'g', assignment: 'cat' }, { id: 'b', group: 'g' }], propagationEdges: [{ from: 'b', to: 'c' }] } }], { propagateKey: 'group' });
ok(propagated.verdict === 'pass' && propagated.assignments.a === 'cat' && propagated.assignments.b === 'cat' && propagated.assignments.c === 'cat', 'M2: propagate inherits by key then follows dependency edges');
const cyclic = propagateAssignments([{ id: 'a', structuredResult: { assignments: { a: 'x' }, propagationEdges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] } }], {});
ok(cyclic.verdict === 'invalid' && cyclic.cycle === true, 'M2: propagate detects dependency cycles');
const deduped = dedupeAgentFindings(deps);
ok(deduped.findings.length === 1 && deduped.findings[0].confidence === 0.95 && deduped.findings[0].sources.length === 2, 'finding dedupe keeps strongest confidence and source provenance');
const loop = normalizeWorkflowLoop({ maxIterations: 5, progressPath: 'state.remaining', noProgressLimit: 2 });
ok(loop.progressPath === 'state.remaining', 'loop normalization preserves a semantic progress path');
const fpA = workflowProgressFingerprint({ structuredResult: { prose: 'first wording', state: { remaining: 3 } } }, 'state.remaining');
const fpB = workflowProgressFingerprint({ structuredResult: { state: { remaining: 3 }, prose: 'different wording' } }, 'state.remaining');
ok(fpA === fpB, 'semantic loop fingerprint ignores unrelated prose changes');
const fpOrderA = workflowProgressFingerprint({ structuredResult: { b: 2, a: 1 } });
const fpOrderB = workflowProgressFingerprint({ structuredResult: { a: 1, b: 2 } });
ok(fpOrderA === fpOrderB, 'structured loop fingerprint is stable across JSON key order');
const evidence = evaluateNodeToolEvidence({ attempts: 1, minSuccessfulToolCalls: 2, continuation: { attemptId: 1, steps: [{ tool: 'powershell_run', ok: true }, { tool: 'file_read', ok: false }] } });
ok(evidence.ok === false && evidence.successful === 1 && evidence.required === 2, 'tool evidence counts only successful calls from the current attempt');
// R1(13-r1-evidence-graph.md): evidence 索引 + claim 引用校验四态。normalizeAgentGate 现透传 requireEvidence/
// allowPartialCoverage(此前被丢 -- M3 allowPartialCoverage=true 降级路径从未生效,R1 requireEvidence 门永不触发;已修)。
ok(normalizeAgentGate({ mode: 'review', requireEvidence: true, allowPartialCoverage: true }, 'reviewer').requireEvidence === true && normalizeAgentGate({ mode: 'review', requireEvidence: true, allowPartialCoverage: true }, 'reviewer').allowPartialCoverage === true, 'R1: normalizeAgentGate preserves requireEvidence/allowPartialCoverage (were dropped before fix)');
ok(normalizeAgentGate({ mode: 'review' }, 'reviewer').requireEvidence === false && normalizeAgentGate(null, 'reviewer').allowPartialCoverage === false, 'R1: gate switches default false (legacy nodes unchanged)');
const r1Run = { id: 'r1run', cwd: '/workspace/proj-a', evidence: [] };
const r1Node = { id: 'r1n', attempts: 0, continuation: { attemptId: 0, steps: [{ tool: 'file_read', argsHash: 'abc123', resultDigest: 'rd1' }, { tool: 'file_read', argsHash: 'def456', resultDigest: 'rd2' }] } };
indexNodeEvidence(r1Run, r1Node);
ok(r1Run.evidence.length === 2 && r1Run.evidence[0].eventId === 'evt_r1run_r1n_a0_0' && r1Run.evidence[1].eventId === 'evt_r1run_r1n_a0_1', 'R1: indexNodeEvidence mints stable eventIds (runId+nodeId+attemptId+stepIdx)');
ok(r1Run.evidence[0].digest.startsWith('sha256:') && r1Run.evidence[0].workspace === r1Run.evidence[1].workspace, 'R1: evidence carries a redacted sha256 digest and a workspace tag');
indexNodeEvidence(r1Run, r1Node);
ok(r1Run.evidence.length === 2, 'R1: indexNodeEvidence is idempotent (re-indexing a node does not duplicate evidence)');
const r1Claim = { structuredResult: { findings: [
  { text: '由工具结果支撑', evidenceRefs: ['evt_r1run_r1n_a0_0'] },
  { text: '引用不存在', evidenceRefs: ['evt_r1run_r1n_a0_99'] },
  { text: '无证据断言' },
] } };
const r1v = verifyNodeClaims(r1Run, r1Claim);
ok(r1v.verified === 1 && r1v.unverified === 2, 'R1: verifyNodeClaims classifies verified (existing ref) vs unverified (missing ref / no refs)');
ok(r1Claim.structuredResult.findings[0].status === 'verified' && r1Claim.structuredResult.findings[2].status === 'unverified', 'R1: claim status set by machine verification, not model self-report');
const r1xB = verifyNodeClaims({ id: 'r1run', cwd: '/workspace/proj-b', evidence: r1Run.evidence }, { structuredResult: { findings: [{ text: '跨工作区', evidenceRefs: ['evt_r1run_r1n_a0_1'] }] } });
ok(r1xB.verified === 0 && r1xB.unverified === 1 && r1xB.rejects[0].reason.includes('跨工作区'), 'R1: cross-workspace evidenceRef rejected as unverified (prevents project-memory leakage)');
// R1 对抗轮修复回归:去重集在模块级 WeakMap,不挂 run 上 —— 经 JSON 往返(resume 快照)后不再是 Set 也不崩,
// 且按 run.evidence 重建去重集,重 index 不重复。
const resumed = JSON.parse(JSON.stringify(r1Run));
ok(resumed._evidenceSet === undefined && Array.isArray(resumed.evidence) && resumed.evidence.length === 2, 'R1 hardening: dedup set is NOT serialized onto run (was a Set -> {} crash on resume)');
let crashed = false;
try { indexNodeEvidence(resumed, r1Node); } catch { crashed = true; }
ok(!crashed && resumed.evidence.length === 2, 'R1 hardening: indexNodeEvidence survives a JSON round-trip (resume) without crash or duplicate');
// R1 对抗轮修复:eventId 含 attemptId —— retry 新 attempt 从 step 0 重编号,旧 attempt 同 stepIdx 不撞 id。
const retryNode = { id: 'r1n', attempts: 1, continuation: { attemptId: 1, steps: [{ tool: 'file_write', argsHash: 'aaa', resultDigest: 'new' }] } };
indexNodeEvidence(r1Run, retryNode);
const retryEv = r1Run.evidence.find(e => e.eventId === 'evt_r1run_r1n_a1_0');
ok(retryEv && retryEv.ref.attemptId === 1, 'R1 hardening: eventId includes attemptId (retry step 0 does not collide with attempt 0)');
// R1 对抗轮修复:purgeNodeEvidence 清掉指定节点【所有 attempt】的旧证据。
purgeNodeEvidence(r1Run, 'r1n');
ok(r1Run.evidence.length === 0, 'R1 hardening: purgeNodeEvidence removes all attempts of a node evidence before retry');
console.log('\nAGENT QUALITY GATES E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
