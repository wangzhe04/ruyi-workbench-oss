'use strict';
// The test owns this child and its synthetic data root. Inject a lost response
// around the real manifest publisher, with no substituted native operations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {loadServerInternals} = require('./server-internals');
const api = loadServerInternals([
  'ServerOwnership','WorkDataManifest','WorkDataColdOperations',
  'WorkDataVerifierEntry','WorkDataHandoffClaim','WorkDataRuntimeHost','MigrationHooks','flushWorkbenchLogs',
]);

async function main() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = await api.ServerOwnership.canonicalRoot(process.env.RUYI_HOME);
  assert.match(path.basename(path.dirname(base)), /^ruyi-production-maintenance-/);
  assert.equal(path.basename(base), 'main-data');
  if (request.action === 'recover') {
    const result = await api.WorkDataRuntimeHost.create().recoverPreparedTransition({base});
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const {fault, parentPid, password} = request;
  assert.ok(['before-publish','after-publish'].includes(fault));
  assert.throws(() => process.kill(parentPid, 0), {code:'ESRCH'});
  const backupDirectory = path.join(path.dirname(base), 'main-backups');
  const native = api.WorkDataVerifierEntry.createVerifier({entry:path.resolve(__dirname,'../../ruyi-workbench/app/server.js')});
  const manifest = api.WorkDataManifest.create({base});
  const active = await manifest.readActive();
  assert.equal(active.mode, 'encrypted');
  const owner = await api.ServerOwnership.acquire([base],{preserveRuntime:true});
  const exclusive = candidate => candidate === owner && api.ServerOwnership.owns(candidate, base);
  const claims = api.WorkDataHandoffClaim.create({temp:os.tmpdir(),flush:directories=>native.flush(directories)});
  const id = crypto.randomBytes(24).toString('hex');
  const {dev,ino} = await fsp.lstat(base,{bigint:true});
  const createdAt = new Date().toISOString();
  const claim = {schema:1,base,baseIdentity:{dev:String(dev),ino:String(ino)},id,nonce:crypto.randomBytes(32).toString('hex'),
    parentPid,childPid:process.pid,operation:'disable',serve:{host:'127.0.0.1',port:request.port},createdAt,updatedAt:createdAt};
  const originalPublisher = api.WorkDataManifest.Hooks.publish;
  let injected = false;
  try {
    let receipt;
    for (const phase of ['armed','committed','owned']) receipt = await claims.write({...claim,phase},receipt);
    assert.equal((await claims.inspect({base})).value.phase,'owned');
    if (fault === 'after-publish') api.WorkDataManifest.Hooks.publish = async value => {
      await originalPublisher(value);
      injected = true;
      throw Object.assign(Error('synthetic native acknowledgement lost'), {code:'fixture.publish_ack_lost'});
    };
    const host = native.coldOperationHost(()=>{});
    const operation = api.WorkDataColdOperations.create({
      ...host,
      migrationFactory(options) {
        const actual = host.migrationFactory(options);
        if (fault === 'after-publish') return actual;
        return {...actual,publish:async()=>{
          injected = true;
          throw Object.assign(Error('synthetic stop before publication'), {code:'fixture.precommit'});
        }};
      },
    });
    try {
      await operation.execute({id,base,operation:'disable',password,ownership:owner,assertExclusive:exclusive,
        expectedAuthority:{id:active.id,generation:active.generation,mode:active.mode,sha256:active.proof.sha256},
        paths:{backupDirectory,targetDirectory:null,uploadFile:null,uploadSha256:null}});
      assert.fail('the injected failure did not reach the caller');
    } catch(error) {
      if(!injected||error.code!=='work_data_setup.transition_requires_recovery'||error.sourceIntentRetained!==true)throw error;
    }
    const pointer = await manifest.readActive();
    assert.equal(pointer.generation,active.generation+(fault==='after-publish'?1:0));
    process.stdout.write(JSON.stringify({injected:true,fault,id,pid:process.pid,authoritySha256:pointer.proof.sha256}) + '\n');
  } finally {
    api.WorkDataManifest.Hooks.publish = originalPublisher;
    if (native.helperMayStillRun()===false && api.MigrationHooks.helperMayStillRun()===false) await owner.release();
  }
}

main().catch(error=>{
  const codes = [];
  for(let cause=error;cause&&codes.length<8;cause=cause.cause) {
    codes.push(typeof cause.code==='string'&&/^[a-z0-9_.-]{1,128}$/i.test(cause.code)?cause.code:'fixture.failure');
  }
  process.stderr.write(JSON.stringify({codes}) + '\n');
  process.exitCode = 1;
}).finally(()=>api.flushWorkbenchLogs({allowFailure:true}));
