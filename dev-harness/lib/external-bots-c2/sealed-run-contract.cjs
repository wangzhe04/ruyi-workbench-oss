'use strict';
// Physical assertions only. A matching header is never an authentication grant:
// callers must independently use the production strict snapshot reader.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
  && !value.startsWith('_') && !/^(?:index|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function assertRunCoordinates(sid, runId) {
  assert.ok(identity(sid) && identity(runId), 'bounded production session/run identities required');
}
function assertRunIdentity(run, sid, runId) {
  assertRunCoordinates(sid, runId);
  assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'production run snapshot unavailable');
  assert.equal(run.id, runId, 'snapshot run identity');
  assert.equal(run.sessionId, sid, 'snapshot session identity');
  assert.ok(Array.isArray(run.nodes), 'snapshot nodes unavailable');
}
function assertCompleteRun(expected, observed, sid, runId) {
  assertRunIdentity(expected, sid, runId); assertRunIdentity(observed, sid, runId);
  assert.notEqual(expected.live, true, 'HTTP must leave its live in-memory branch');
  assert.deepEqual(observed, expected, 'independent production disk reader and HTTP complete run disagree');
}
function inspectSealedRunBytes(bytes, { sid, runId, instanceId, forbidden } = {}) {
  assertRunCoordinates(sid, runId);
  assert.ok(typeof instanceId === 'string' && instanceId.length > 0);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024 * 1024);
  assert.ok(Array.isArray(forbidden) && forbidden.length > 0 && forbidden.every(value => typeof value === 'string' && value.length > 0));
  for (const text of forbidden) assert.equal(bytes.includes(text), false, 'source/proposal/result canary present in raw run snapshot');
  assert.ok(bytes.indexOf(10) >= 0 && bytes.indexOf(10) <= 16 * 1024 && bytes.at(-1) === 10, 'complete bounded chunks header and trailing newline required');
  const lines = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const header = lines[0];
  assert.equal(Object.keys(header).sort().join(','), 'format,instanceId,keyId,manifest,purpose,recordId,revision,schema,scopeId,seq,workData');
  assert.equal(header.workData, 3); assert.equal(header.format, 'chunks-v1');
  assert.equal(header.purpose, 'task'); assert.equal(header.instanceId, instanceId);
  assert.equal(header.schema, 1); assert.equal(header.scopeId, sid); assert.equal(header.recordId, 'agent-run:' + runId);
  assert.equal(header.seq, 1); assert.equal(header.keyId, 'work-data-v2.k1');
  assert.match(header.revision, /^[a-f0-9]{32}$/);
  const prefix = 'chunks:' + sha(JSON.stringify(['task', instanceId, 1, sid, 'agent-run:' + runId, 1])) + ':' + header.revision;
  function envelope(value, recordId, seq) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(Object.keys(value).sort().join(','), 'envelope,instanceId,keyId,purpose,recordId,schema,scopeId,seq,version');
    assert.equal(value.version, 2); assert.equal(value.keyId, header.keyId); assert.equal(value.instanceId, instanceId);
    assert.equal(value.purpose, 'task'); assert.equal(value.schema, 1); assert.equal(value.scopeId, sid);
    assert.equal(value.recordId, recordId); assert.equal(value.seq, seq);
    assert.ok(value.envelope && typeof value.envelope === 'object', 'encrypted envelope required');
  }
  envelope(header.manifest, prefix + ':m', 0);
  assert.ok(lines.length > 1, 'nonempty logical run requires encrypted chunks');
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    assert.equal(Object.keys(row).sort().join(','), 'e,i'); assert.equal(row.i, i - 1);
    envelope(row.e, prefix + ':c:' + row.i, row.i);
  }
  return { workData: 3, format: 'chunks-v1', purpose: 'task', schema: 1, scopeId: sid,
    recordId: 'agent-run:' + runId, instanceId, keyId: header.keyId, revision: header.revision,
    bytes: bytes.length, sha256: sha(bytes), encryptedChunks: lines.length - 1, forbiddenStrings: forbidden.length,
    authentication: 'separate production strict snapshot reader required; physical metadata is not admission' };
}
module.exports = { assertRunCoordinates, assertRunIdentity, assertCompleteRun, inspectSealedRunBytes };
