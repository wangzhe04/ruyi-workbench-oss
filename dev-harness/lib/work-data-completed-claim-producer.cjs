'use strict';
// Generic synthetic owned-claim crash-window producer. A completed-case caller
// binds id/operation/ownedAt to a real maintenance result; an unknown-case caller
// supplies a new random id and current time. Actual claim/native/OS-owner modules
// write the claim, then this process dies without releasing its lease. This is a
// constructed window, not an observed production cold crash or maintenance run.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const core = require('./work-data-production-upload-core');
const {publishJsonOnce,markerFailure}=require('./work-data-fixture-marker');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFile(file, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw Error('synthetic producer command deadline');
    await pause(25);
  }
}
function write(file, value) {
  publishJsonOnce(file,value);
}
async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.argv.length, 3);
  const request = core.json(process.argv[2]);
  const context = vm.createContext({ require, Buffer, process, setTimeout, clearTimeout });
  for (const pin of request.sources) vm.runInContext(core.read(pin.file, pin).bytes.toString('utf8'), context, { filename: pin.file });
  const { ownership, claims, publisher, controlApi, resultApi, manifestApi } = vm.runInContext('({ownership:ServerOwnership,claims:WorkDataHandoffClaim,publisher:WorkDataNativePublish,controlApi:WorkDataMaintenanceControl,resultApi:WorkDataMaintenanceResult,manifestApi:WorkDataManifest})', context);
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
  const stat = fs.lstatSync(base, { bigint: true }), ownedTime = Date.parse(request.ownedAt);
  assert.equal(Number.isFinite(ownedTime), true);
  const createdAt = new Date(ownedTime - 2000).toISOString();
  const value = { schema: 1, base, baseIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
    id: request.id, nonce: crypto.randomBytes(32).toString('hex'), operation: request.operation,
    parentPid: request.parentPid, childPid: process.pid, phase: 'armed',
    serve: { host: '127.0.0.1', port: request.port }, createdAt, updatedAt: createdAt };
  let receipt = null;
  for (const [index, phase] of ['armed', 'committed', 'owned'].entries()) {
    receipt = await api.write({ ...value, phase, updatedAt: new Date(ownedTime - 2000 + index * 1000).toISOString() }, receipt);
  }
  const found = await api.inspect({ base });
  assert.equal(found.present, true); assert.equal(found.value.phase, 'owned');
  assert.equal(ownership.owns(lease, base), true);
  let intentReceipt=null;
  if(request.completeIntent){
    // C11 constructs historical matching control metadata around an unchanged
    // real published result. It does not claim this producer ran that migration.
    const state=request.completeIntent;
    assert.equal(state.id,request.id);assert.equal(state.operation,request.operation);assert.equal(state.phase,'complete');
    assert.ok(['enable','disable'].includes(state.operation));assert.ok(Date.parse(state.createdAt)<=ownedTime);
    const results=resultApi.create({base,ownership:lease,assertExclusive:owner=>owner===lease&&ownership.owns(lease,base),readAuthority:()=>manifestApi.create({base}).readActive()});
    const verifyBackup=async backup=>{const result=await results.read();assert.ok(result&&result.id===request.id&&result.operation===request.operation&&result.state==='published');
      assert.equal(result.finishedAt,request.ownedAt);assert.deepEqual(JSON.parse(JSON.stringify(result.sourceAuthority)),state.expectedAuthority);
      return result.backup.path===backup.path&&result.backup.sha256===backup.sha256;};
    const control=controlApi.create({base,ownership:lease,assertExclusive:owner=>owner===lease&&ownership.owns(lease,base),assertDurableBackup:verifyBackup,flush});
    const initial={...state,phase:'prepared',candidate:null};intentReceipt=await control.write(initial);
    for(const phase of ['candidate','key-ready','published','complete'])intentReceipt=await control.write({...state,phase},intentReceipt);
    assert.equal((await control.inspect()).phase,'complete');
  }
  write(path.join(request.commands, 'producer-owned.json'), { schema: 1, pid: process.pid, base, receipt,
    operation: request.operation, id: request.id, sourceOwnerHeld: true, realNativeFlush: true,
    ...(intentReceipt?{completeIntentConstructed:true,intentReceipt}:{} ) });
  await waitFile(path.join(request.commands, 'producer-crash.json'), 60000);
  assert.equal(ownership.owns(lease, base), true);
  // Deliberate process death, with no lease.release() or claim.remove(). The OS
  // releases the named-pipe owner. The test's Job covers every native descendant.
  process.exit(73);
}
if (require.main === module) main().catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'synthetic_producer_failed';
  try { process.stderr.write(code + '\n'); } catch {}
  const marker=markerFailure(error);
  if(marker)try{process.stderr.write('SYNTHETIC-MARKER-DIAG '+JSON.stringify(marker)+'\n');}catch{}
  // On uncertainty the outer Job retains ownership until its failure policy
  // closes it. Do not release a possibly live native helper's source owner.
  setInterval(() => {}, 1000);
});
