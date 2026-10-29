'use strict';
// Synthetic crash-window producer only. The completed result comes from a real
// maintenance round; this process reconstructs the remaining owned claim with
// the actual claim/native/OS-owner modules and dies without releasing its lease.
// It does not stand in for a production cold worker or perform maintenance.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const core = require('./work-data-production-upload-core');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFile(file, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw Error('synthetic producer command deadline');
    await pause(25);
  }
}
function write(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.argv.length, 3);
  const request = core.json(process.argv[2]);
  const context = vm.createContext({ require, Buffer, process, setTimeout, clearTimeout });
  for (const pin of request.sources) vm.runInContext(core.read(pin.file, pin).bytes.toString('utf8'), context, { filename: pin.file });
  const { ownership, claims, publisher } = vm.runInContext('({ownership:ServerOwnership,claims:WorkDataHandoffClaim,publisher:WorkDataNativePublish})', context);
  // Nothing owning data or starting a native helper happens before the caller
  // has assigned this exact creation identity to its kill-on-close outer Job.
  write(path.join(request.commands, 'producer-ready.json'), { schema: 1, pid: process.pid });
  await waitFile(path.join(request.commands, 'producer-go.json'), 60000);
  const base = await ownership.canonicalRoot(request.base);
  const lease = await ownership.acquire([base]);
  assert.equal(ownership.owns(lease, base), true);
  const flush = publisher.createFlush();
  const api = claims.create({ temp: request.temp, flush });
  assert.equal((await api.inspect({ base })).present, false);
  const stat = fs.lstatSync(base, { bigint: true }), finished = Date.parse(request.finishedAt);
  assert.equal(Number.isFinite(finished), true);
  const createdAt = new Date(finished - 2000).toISOString();
  const value = { schema: 1, base, baseIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
    id: request.id, nonce: crypto.randomBytes(32).toString('hex'), operation: request.operation,
    parentPid: request.parentPid, childPid: process.pid, phase: 'armed',
    serve: { host: '127.0.0.1', port: request.port }, createdAt, updatedAt: createdAt };
  let receipt = null;
  for (const [index, phase] of ['armed', 'committed', 'owned'].entries()) {
    receipt = await api.write({ ...value, phase, updatedAt: new Date(finished - 2000 + index * 1000).toISOString() }, receipt);
  }
  const found = await api.inspect({ base });
  assert.equal(found.present, true); assert.equal(found.value.phase, 'owned');
  assert.equal(ownership.owns(lease, base), true);
  write(path.join(request.commands, 'producer-owned.json'), { schema: 1, pid: process.pid, base, receipt,
    operation: request.operation, id: request.id, sourceOwnerHeld: true, realNativeFlush: true });
  await waitFile(path.join(request.commands, 'producer-crash.json'), 60000);
  assert.equal(ownership.owns(lease, base), true);
  // Deliberate process death, with no lease.release() or claim.remove(). The OS
  // releases the named-pipe owner. The test's Job covers every native descendant.
  process.exit(73);
}
if (require.main === module) main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'synthetic_producer_failed';
  try { process.stderr.write(code + '\n'); } catch {}
  // On uncertainty the outer Job retains ownership until its failure policy
  // closes it. Do not release a possibly live native helper's source owner.
  setInterval(() => {}, 1000);
});
