'use strict';
const {
  parseStructuredAgentOutput, validateAgentJsonSchema, normalizeAgentGate,
  aggregateAgentVote, dedupeAgentFindings, QUALITY_GATE_OUTPUT_SCHEMA,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
const parsed = parseStructuredAgentOutput('```json\n{"verdict":"pass","confidence":0.9,"summary":"ok"}\n```');
ok(parsed.ok && parsed.value.confidence === 0.9, 'structured output parser accepts fenced JSON');
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
const deduped = dedupeAgentFindings(deps);
ok(deduped.findings.length === 1 && deduped.findings[0].confidence === 0.95 && deduped.findings[0].sources.length === 2, 'finding dedupe keeps strongest confidence and source provenance');
console.log('\nAGENT QUALITY GATES E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
