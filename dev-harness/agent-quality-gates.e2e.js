'use strict';
const {
  parseStructuredAgentOutput, validateAgentJsonSchema, normalizeAgentGate,
  aggregateAgentVote, dedupeAgentFindings, QUALITY_GATE_OUTPUT_SCHEMA,
  normalizeWorkflowLoop, workflowProgressFingerprint, evaluateNodeToolEvidence,
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
console.log('\nAGENT QUALITY GATES E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
