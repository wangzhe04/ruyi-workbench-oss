'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { LIMITS, validateRequest, modelFingerprint } = require('../../ruyi-workbench/semantic-runtime/protocol.cjs');
const { verify, verifyRuntimeAssets } = require('../../ruyi-workbench/semantic-runtime/verify.cjs');
const { killOwnTree } = require('../lib/kill-own-tree.js');
const { fixtureChildEnv } = require('../lib/fixture-home.js');
const runtime = path.resolve(__dirname, '../../ruyi-workbench/semantic-runtime');
const request = { requestId: 'test-1', op: 'encode', role: 'query', texts: ['数据备份'] };
test('semantic protocol rejects oversized, expired, malformed and empty inputs', () => {
  assert.equal(validateRequest(request), null);
  assert.equal(validateRequest({ ...request, role: 'system' }), 'INVALID_REQUEST');
  assert.equal(validateRequest({ ...request, requestId: 'contains\nnewline' }), 'INVALID_REQUEST_ID');
  assert.equal(validateRequest({ ...request, texts: [] }), 'BATCH_LIMIT');
  assert.equal(validateRequest({ ...request, texts: new Array(LIMITS.maxBatch + 1).fill('x') }), 'BATCH_LIMIT');
  assert.equal(validateRequest({ ...request, texts: [' '.repeat(3)] }), 'TEXT_LIMIT');
  assert.equal(validateRequest({ ...request, texts: ['x'.repeat(LIMITS.maxTextChars + 1)] }), 'TEXT_LIMIT');
  assert.equal(validateRequest({ ...request, deadlineMs: Date.now() - 1 }), 'DEADLINE_EXCEEDED');
});
test('fingerprint changes for each model, tokenizer, prefix, pooling, length, threshold or runtime change', () => {
  const model = { files: [{ path: 'tokenizer.json', sha256: 'a' }], pooling: 'mean', prefix: { query: 'query: ' }, maxTokens: 512 };
  const original = modelFingerprint(model, 'lock', 'runtime');
  for (const change of [{ files: [{ path: 'tokenizer.json', sha256: 'b' }] }, { pooling: 'cls' }, { prefix: { query: '' } }, { maxTokens: 128 }, { retrievalThresholds: { search: .22, automatic: null } }]) assert.notEqual(modelFingerprint({ ...model, ...change }, 'lock', 'runtime'), original);
  assert.notEqual(modelFingerprint(model, 'other-lock', 'runtime'), original);
  assert.notEqual(modelFingerprint(model, 'lock', 'other-runtime'), original);
});
async function workerSession(root, fn) {
  const fixture = fixtureChildEnv({ perTest: true }); const temp = fixture.home;
  const child = spawn(process.execPath, [path.join(runtime, 'worker.cjs'), '--root', root], { windowsHide: true, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const messages = []; const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); if (waiters.length) waiters.shift()(message); else messages.push(message); });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('WORKER_TIMEOUT')), 15000); waiters.push(message => { clearTimeout(timer); resolve(message); }); });
  try { await fn({ child, next, stderr: () => stderr }); }
  finally { await killOwnTree(child); assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(temp, { recursive: true, force: true }); }
}
test('missing model fails closed with a sanitized readiness error', async () => {
  await workerSession(path.join(os.tmpdir(), 'does-not-exist-ruyi-semantic-model'), async session => {
    const message = await session.next(); assert.equal(message.type, 'ready'); assert.equal(message.ok, false); assert.equal(message.error.code, 'RUNTIME_UNAVAILABLE'); assert.equal(session.stderr(), '');
  });
});
test('complete runtime inventory detects modified code and injected package resolution paths', { timeout: 30000 }, async t => {
  const root = process.env.RUYI_SEMANTIC_TEST_ROOT;
  if (!root) { t.skip('Requires the real offline dependency inventory.'); return; }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-semantic-inventory-'));
  try {
    fs.cpSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), { recursive: true });
    await verifyRuntimeAssets(temp);
    const extra = path.join(temp, 'node_modules', '@huggingface', 'node_modules', 'injected', 'package.json'); fs.mkdirSync(path.dirname(extra), { recursive: true }); fs.writeFileSync(extra, '{}');
    await assert.rejects(verifyRuntimeAssets(temp), /RUNTIME_INTEGRITY_FAILED/);
    fs.unlinkSync(extra);
    const critical = path.join(temp, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs');
    const fd = fs.openSync(critical, 'r+'); fs.writeSync(fd, Buffer.from('!'), 0, 1, 0); fs.closeSync(fd);
    await assert.rejects(verifyRuntimeAssets(temp), /RUNTIME_INTEGRITY_FAILED/);
  } finally { assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(temp, { recursive: true, force: true }); }
});
test('real local runtime: normalized semantic vectors, truncation, errors, no text logs and integrity', { timeout: 60000 }, async t => {
  const root = process.env.RUYI_SEMANTIC_TEST_ROOT;
  if (!root) { t.skip('Set RUYI_SEMANTIC_TEST_ROOT to an installed offline bundle; fake vectors never substitute.'); return; }
  await verify(path.resolve(root));
  await workerSession(path.resolve(root), async session => {
    const ready = await session.next(); assert.equal(ready.ok, true); assert.equal(ready.retrievalThresholds.automatic, null);
    const send = value => session.child.stdin.write(JSON.stringify(value) + '\n');
    send({ ...request, texts: ['出差报销需要提交收据', '出差费用如何报销', '火星上有没有生命'] });
    const response = await session.next(); assert.equal(response.ok, true); assert.equal(response.vectors.length, 3); assert.equal(response.modelFingerprint, ready.modelFingerprint);
    for (const vector of response.vectors) { assert.equal(vector.length, ready.dimensions); assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-5); }
    const cosine = (a, b) => a.reduce((n, value, i) => n + value * b[i], 0);
    assert.ok(cosine(response.vectors[0], response.vectors[1]) > cosine(response.vectors[0], response.vectors[2]));
    const invariantTexts = ['语义检索恢复历史', '员工出差费用报销', 'Password recovery instructions', '铁路运输改期', 'The quick brown fox jumps.', '架构评审的最新时间', '空气湿度传感器', 'A much longer sentence about encrypted offline document backups and verification.'];
    send({ ...request, requestId: 'batch-8', role: 'document', texts: invariantTexts }); const batchEight = await session.next(); assert.equal(batchEight.ok, true);
    send({ ...request, requestId: 'batch-4', role: 'document', texts: invariantTexts.slice(0, 4) }); const batchFour = await session.next(); assert.deepEqual(batchFour.vectors, batchEight.vectors.slice(0, 4));
    for (let i = 0; i < invariantTexts.length; i++) { send({ ...request, requestId: 'single-' + i, role: 'document', texts: [invariantTexts[i]] }); const single = await session.next(); assert.deepEqual(single.vectors[0], batchEight.vectors[i]); }
    send({ ...request, requestId: 'reverse-8', role: 'document', texts: invariantTexts.slice().reverse() }); const reversed = await session.next(); assert.deepEqual(reversed.vectors, batchEight.vectors.slice().reverse());
    send({ ...request, requestId: 'long', role: 'document', texts: ['数据备份和密码恢复。'.repeat(100)] });
    const long = await session.next(); assert.equal(long.ok, true); assert.equal(long.truncated[0], true); assert.ok(long.tokenCounts[0] > ready.limits.maxTokens); assert.ok(long.encodedTokenCounts[0] <= ready.limits.maxTokens);
    send({ ...request, requestId: 'expired', deadlineMs: Date.now() - 1 }); assert.equal((await session.next()).error.code, 'DEADLINE_EXCEEDED');
    session.child.stdin.write('x'.repeat(LIMITS.maxLineBytes + 1) + '\n'); assert.equal((await session.next()).error.code, 'LINE_LIMIT');
    send({ ...request, requestId: 'after-limit' }); assert.equal((await session.next()).ok, true);
    assert.equal(session.stderr(), '');
    session.child.stdin.end();
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('EOF_DID_NOT_EXIT')), 5000); session.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  });
});
