'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');

process.env.RUYI_HOME = path.join(os.tmpdir(), 'ruyi-c2-evidence-test-' + process.pid);
process.env.RUYI_NO_LISTEN = '1';
const api = require('../ruyi-workbench/app/server.js');

function gateRun(mode, field, values) {
  const run = {
    id: 'c2_' + mode,
    sessionId: 's_c2',
    workspaceHash: 'ws_c2',
    nodes: [{
      id: mode,
      status: 'succeeded',
      attempts: 1,
      dependsOn: [],
      gate: { mode },
      structuredResult: { [field]: values },
    }],
    evidence: [],
  };
  api.indexNodeEvidence(run, run.nodes[0]);
  return run;
}

const sensitiveGap = ['RAW', 'GAP', 'PAYLOAD', 'DO', 'NOT', 'STORE'].join('_');
const coverage = gateRun('coverage', 'unhandled', [sensitiveGap, 'item-b']);
assert.strictEqual(coverage.evidence.length, 2);
assert(coverage.evidence.every(e => e.kind === 'deterministic_gap'));
assert(coverage.evidence.every(e => e.ref.check === 'coverage_unhandled'));
assert(!JSON.stringify(coverage.evidence).includes(sensitiveGap));
const coverageCatalog = api.buildNodeEvidenceCatalog({ ...coverage, nodes: [...coverage.nodes, { id: 'down', dependsOn: ['coverage'] }] }, { id: 'down', dependsOn: ['coverage'] });
assert.strictEqual(coverageCatalog.entries.length, 2);
assert(coverageCatalog.entries.every(i => i.eventId.includes('_gap_coverage_unhandled_')));
const claimNode = {
  id: 'down',
  dependsOn: ['coverage'],
  structuredResult: { findings: [{ claim: 'coverage gap exists', evidenceRefs: [coverageCatalog.entries[0].eventId] }] },
};
const claimRun = { ...coverage, nodes: [...coverage.nodes, claimNode] };
const claimVerdict = api.verifyNodeClaims(claimRun, claimNode);
assert.strictEqual(claimVerdict.verified, 1, 'machine verification accepts visible deterministic gap evidence');
assert.strictEqual(claimNode.structuredResult.findings[0].status, 'verified');

const propagate = gateRun('propagate', 'unpropagated', ['ticket-1']);
assert.strictEqual(propagate.evidence.length, 1);
assert.strictEqual(propagate.evidence[0].ref.check, 'propagate_unpropagated');
assert(!JSON.stringify(propagate.evidence).includes('ticket-1'));
api.indexNodeEvidence(propagate, propagate.nodes[0]);
assert.strictEqual(propagate.evidence.length, 1, 'deterministic evidence indexing is idempotent');
api.purgeNodeEvidence(propagate, 'propagate');
assert.strictEqual(propagate.evidence.length, 0, 'retry purge removes deterministic evidence too');

console.log('C2 DETERMINISTIC EVIDENCE E2E: ALL PASS');
