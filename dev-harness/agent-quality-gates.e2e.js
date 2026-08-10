'use strict';
const {
  parseStructuredAgentOutput, validateAgentJsonSchema, normalizeAgentGate,
  aggregateAgentVote, dedupeAgentFindings, QUALITY_GATE_OUTPUT_SCHEMA,
  normalizeWorkflowLoop, workflowProgressFingerprint, evaluateNodeToolEvidence,
  indexNodeEvidence, verifyNodeClaims, runWorkspaceHash,
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
const r1Run = { id: 'r1run', evidence: [], _evidenceSet: new Set() };
const r1Node = { id: 'r1n', continuation: { steps: [{ tool: 'file_read', argsHash: 'abc123', resultDigest: 'rd1' }, { tool: 'file_read', argsHash: 'def456', resultDigest: 'rd2' }] } };
indexNodeEvidence(r1Run, r1Node);
ok(r1Run.evidence.length === 2 && r1Run.evidence[0].eventId === 'evt_r1run_r1n_0' && r1Run.evidence[1].eventId === 'evt_r1run_r1n_1', 'R1: indexNodeEvidence mints stable eventIds (runId+nodeId+stepIdx)');
ok(r1Run.evidence[0].digest.startsWith('sha256:') && r1Run.evidence[0].workspace === r1Run.evidence[1].workspace, 'R1: evidence carries a redacted sha256 digest and a workspace tag');
indexNodeEvidence(r1Run, r1Node);
ok(r1Run.evidence.length === 2, 'R1: indexNodeEvidence is idempotent (re-indexing a node does not duplicate evidence)');
const r1Claim = { structuredResult: { findings: [
  { text: '由工具结果支撑', evidenceRefs: ['evt_r1run_r1n_0'] },
  { text: '引用不存在', evidenceRefs: ['evt_r1run_r1n_99'] },
  { text: '无证据断言' },
] } };
const r1v = verifyNodeClaims(r1Run, r1Claim);
ok(r1v.verified === 1 && r1v.unverified === 2, 'R1: verifyNodeClaims classifies verified (existing ref) vs unverified (missing ref / no refs)');
ok(r1Claim.structuredResult.findings[0].status === 'verified' && r1Claim.structuredResult.findings[2].status === 'unverified', 'R1: claim status set by machine verification, not model self-report');
const r1xB = verifyNodeClaims({ id: 'r1run', evidence: r1Run.evidence, _wsHash: 'DIFFERENT_WS' }, { structuredResult: { findings: [{ text: '跨工作区', evidenceRefs: ['evt_r1run_r1n_1'] }] } });
ok(r1xB.verified === 0 && r1xB.unverified === 1 && r1xB.rejects[0].reason.includes('跨工作区'), 'R1: cross-workspace evidenceRef rejected as unverified (prevents project-memory leakage)');
console.log('\nAGENT QUALITY GATES E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
