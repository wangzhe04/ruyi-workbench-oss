'use strict';
require('./lib/self-isolate-home');
// Serial Windows qualification: real cold export, preserved source snapshot,
// portable restore rehearsal and a fresh verifier process. The backup profile
// remains default DATA only; this is not metadata restore or full migration.
const fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createRunner}=require('./lib/harness'),{releaseEnvironment}=require('./lib/release-checks');
const {basicMetadata:readMetadata}=require('./lib/skill-capsule-native-fixture');
const runner=createRunner('WORK DATA COLD PRESERVED SNAPSHOT'),{ok}=runner;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Control/result writes legitimately change the source root. Only these
// immutable synthetic payload objects are preservation witnesses.
const payloadRows=value=>value.entries.filter(row=>row.rel==='data'||row.rel.startsWith('data/')).map(({opaque,...row})=>row).sort((a,b)=>a.rel.localeCompare(b.rel));
async function run(){
  if(process.platform!=='win32'){ok(true,'SKIP Windows NTFS cold snapshot qualification');return;}
  const env=releaseEnvironment(process.env.HOME,path.join(process.env.HOME,'cold-preserved-data'));
  for(const name of Object.keys(process.env))if(!Object.hasOwn(env,name))delete process.env[name];
  Object.assign(process.env,env);
  const api=require('./lib/server-internals').loadServerInternals(['ServerOwnership','WorkDataNativeAdapters','WorkDataColdOperations','WorkDataManifest','WorkDataRecovery','MigrationHooks','migrationCapsuleCapturePreserved','flushWorkbenchLogs']);
  await api.flushWorkbenchLogs({allowFailure:false});
  const temp=path.resolve(os.tmpdir()),root=await fsp.mkdtemp(path.join(temp,'ruyi-cold-preserved-')),base=path.join(root,'base'),backupDirectory=path.join(root,'backups'),payload=path.join(base,'data','payload.bin');
  const expected=Buffer.from([0,255,31,128,65,66,13,10]),ads=Buffer.from('SYNTHETIC public alternate stream');
  let owner,keeper,adapter,completed=false,firstFailure,metadataUnknown=false;
  const uncertain=()=>metadataUnknown||api.MigrationHooks.helperMayStillRun()!==false||adapter?.helperMayStillRun()===true;
  const unknownError=()=>Object.assign(Error('cold_preserved.owner_uncertain'),{code:'cold_preserved.owner_uncertain',helperMayStillRun:true});
  const basicMetadata=(...args)=>{
    if(uncertain())throw unknownError();
    try{return readMetadata(...args);}catch(error){metadataUnknown=true;throw error;}
  };
  try{
    await fsp.mkdir(path.join(base,'data','empty'),{recursive:true});await fsp.mkdir(backupDirectory);
    await fsp.writeFile(path.join(base,'config.json'),'{"workDataEncryptionV1":false}\r\n');
    await fsp.writeFile(payload,expected);await fsp.writeFile(payload+':public-ads',ads);await fsp.chmod(payload,0o444);
    owner=await api.ServerOwnership.acquire([base]);keeper=api.ServerOwnership.createSourceKeeper(owner,base);
    const exclusive=value=>value===owner&&keeper.assertExclusive(value);
    adapter=api.WorkDataNativeAdapters.create({verifierCommand:{command:process.execPath,args:[path.resolve(__dirname,'../ruyi-workbench/app/server.js'),'work-data-verify']}});
    const relatives=['data','data/empty','data/payload.bin'];
    const metadata=basicMetadata(base,relatives),before=await api.migrationCapsuleCapturePreserved(base,crypto.randomBytes(32).toString('hex'));
    const file=before.entries.find(row=>row.rel==='data/payload.bin');
    assert.equal(file.attrs&1,1);assert.equal(file.streams.length,2);
    assert.equal(file.streams.find(row=>row.name===':public-ads:$DATA').hash,hash(ads));
    ok(true,'genuine cold source owner protects readonly DATA, a real ADS and an empty directory');
    const phases=[],host=adapter.coldOperationHost(value=>phases.push(value.phase));
    const active=await api.WorkDataManifest.create({base}).readActive();
    const password='SYNTHETIC cold preserved package password',id=crypto.randomBytes(24).toString('hex');
    const result=await api.WorkDataColdOperations.create(host).execute({id,base,operation:'export',password,ownership:owner,assertExclusive:exclusive,
      expectedAuthority:{generation:active.generation,id:active.id,mode:'plain',sha256:active.proof.sha256},paths:{backupDirectory,targetDirectory:null,uploadFile:null,uploadSha256:null}});
    assert.equal(result.state,'verified');assert.equal(result.operation,'export');
    assert.deepEqual(phases,['snapshot','verify-backup']);
    assert.equal(result.profile.ordinaryFiles,'default-stream-bytes');assert.equal(result.profile.nativeMetadata,'not-captured');
    assert.equal(await fsp.stat(path.join(backupDirectory,'.ruyi-work-data-verify-'+id)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}),false);
    ok(true,'production cold export completes real restore rehearsal and fresh-process verification');
    const bytes=await fsp.readFile(result.backup.path);assert.equal(hash(bytes),result.backup.sha256);
    const opened=await api.WorkDataRecovery.open(bytes.toString('utf8'),password);
    try{
      assert.deepEqual(opened.snapshot.files.find(row=>row.path==='data/payload.bin').data,expected);
      assert.deepEqual([...opened.snapshot.directories].sort(),['data','data/empty']);
      assert.equal(opened.snapshot.auxiliaries.length,0);
    }finally{opened.release();}
    ok(true,'durable encrypted backup authenticates with exact default DATA and original profile');
    const after=await api.migrationCapsuleCapturePreserved(base,crypto.randomBytes(32).toString('hex'));
    assert.deepEqual(payloadRows(after),payloadRows(before));assert.deepEqual(basicMetadata(base,relatives),metadata);
    assert.equal(uncertain(),false);assert.equal(exclusive(owner),true);
    ok(true,'immutable payload IDs, DATA, ADS, readonly, aliases, four times and security remain unchanged');
    completed=true;
  }catch(error){firstFailure=error;throw error;}
  finally{
    if(uncertain()){
      completed=false;keeper?.retainUnknown(firstFailure);
      if(firstFailure===undefined)throw unknownError();
    }else{
      if(keeper){await keeper.releaseOwner(()=>!uncertain());assert.equal(api.ServerOwnership.owns(owner),false);}
      else if(owner)await owner.release();
      await api.flushWorkbenchLogs({allowFailure:false});
      if(uncertain()){completed=false;keeper?.retainUnknown(firstFailure);throw unknownError();}
      if(completed){
        assert.equal(path.dirname(path.resolve(root)),temp);assert.ok(path.basename(root).startsWith('ruyi-cold-preserved-'));
        assert.equal((await fsp.lstat(root)).isSymbolicLink(),false);
        if(uncertain()){keeper?.retainUnknown(firstFailure);throw unknownError();}
        await fsp.chmod(payload,0o600);
        if(uncertain()){keeper?.retainUnknown(firstFailure);throw unknownError();}
        await fsp.rm(root,{recursive:true,force:false});
        if(uncertain()){keeper?.retainUnknown(firstFailure);throw unknownError();}
        ok(true,'known-closed source owner releases once and its dedicated synthetic fixture is removed');
      }
    }
  }
}
run().catch(error=>{const code=typeof error?.code==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(error.code)?error.code:'qualification_failed';runner.fail(code);}).finally(()=>runner.done());
