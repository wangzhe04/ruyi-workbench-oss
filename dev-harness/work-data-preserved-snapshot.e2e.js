'use strict';
require('./lib/self-isolate-home');
// Serial Windows qualification of the production snapshot adapter's read path.
// The backup still promises default DATA only. Source metadata preservation is
// not an ADS/Basic/security restore capability, nor a nonempty migration claim.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createRunner}=require('./lib/harness'),{releaseEnvironment}=require('./lib/release-checks');
const {basicMetadata:readMetadata}=require('./lib/skill-capsule-native-fixture');
const runner=createRunner('WORK DATA PRESERVED SNAPSHOT'),{ok}=runner;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const publicNative=value=>value.entries.map(({opaque,...row})=>row).sort((a,b)=>a.rel.localeCompare(b.rel));
async function run(){
  if(process.platform!=='win32'){ok(true,'SKIP Windows NTFS production snapshot qualification');return;}
  const env=releaseEnvironment(process.env.HOME,path.join(process.env.HOME,'preserved-snapshot-data'));
  for(const name of Object.keys(process.env))if(!Object.hasOwn(env,name))delete process.env[name];
  Object.assign(process.env,env);
  const api=require('./lib/server-internals').loadServerInternals(['ServerOwnership','WorkDataNativeAdapters','WorkDataRecovery','MigrationHooks','migrationCapsuleCapturePreserved','flushWorkbenchLogs']);
  await api.flushWorkbenchLogs({allowFailure:false});
  const temp=path.resolve(os.tmpdir()),root=await fsp.mkdtemp(path.join(temp,'ruyi-preserved-snapshot-')),base=path.join(root,'base'),payload=path.join(base,'data','payload.bin');
  const expected=Buffer.from([0,255,31,128,65,66,13,10]),ads=Buffer.from('SYNTHETIC public alternate stream');
  let owner,keeper,adapter,completed=false,firstFailure,metadataUnknown=false;
  const uncertain=()=>metadataUnknown||api.MigrationHooks.helperMayStillRun()!==false||adapter?.helperMayStillRun()===true;
  const unknownError=()=>Object.assign(Error('preserved_snapshot.owner_uncertain'),{code:'preserved_snapshot.owner_uncertain',helperMayStillRun:true});
  const basicMetadata=(...args)=>{
    if(uncertain())throw unknownError();
    try{return readMetadata(...args);}catch(error){metadataUnknown=true;throw error;}
  };
  try{
    await fsp.mkdir(path.join(base,'data','empty'),{recursive:true});
    await fsp.writeFile(path.join(base,'config.json'),'{"workDataEncryptionV1":false}\r\n');
    await fsp.writeFile(payload,expected);await fsp.writeFile(payload+':public-ads',ads);await fsp.chmod(payload,0o444);
    owner=await api.ServerOwnership.acquire([base]);keeper=api.ServerOwnership.createSourceKeeper(owner,base);
    const exclusive=value=>value===owner&&keeper.assertExclusive(value);
    adapter=api.WorkDataNativeAdapters.create();
    const relatives=['','config.json','data','data/empty','data/payload.bin'];
    const metadata=basicMetadata(base,relatives),before=await api.migrationCapsuleCapturePreserved(base,crypto.randomBytes(32).toString('hex'));
    const file=before.entries.find(row=>row.rel==='data/payload.bin');
    assert.equal(file.attrs&1,1);assert.equal(file.streams.length,2);
    assert.equal(file.streams.find(row=>row.name===':public-ads:$DATA').hash,hash(ads));
    ok(true,'genuine owner protects a nonempty readonly source with a real NTFS alternate stream');
    const password='SYNTHETIC preserved snapshot package password';
    const sealed=await adapter.fullSnapshot(base,owner,exclusive).seal({password,appVersion:'3.0.1',generation:0});
    assert.equal(sealed.sourceProof.nativeMetadata,'preserved-reader-closed');
    assert.match(sealed.sourceProof.nativeSha256,/^[a-f0-9]{64}$/);
    assert.equal(sealed.files,2);assert.equal(sealed.directories,2);
    assert.equal(sealed.profile.ordinaryFiles,'default-stream-bytes');assert.equal(sealed.profile.nativeMetadata,'not-captured');
    ok(true,'production snapshot selects the closed preserved reader while retaining its original backup profile');
    const opened=await api.WorkDataRecovery.open(sealed.serialized,password);
    try{
      assert.deepEqual(opened.snapshot.files.find(row=>row.path==='data/payload.bin').data,expected);
      assert.deepEqual([...opened.snapshot.directories].sort(),['data','data/empty']);
      assert.equal(opened.snapshot.auxiliaries.length,0);
    }finally{opened.release();}
    ok(true,'real encrypted recovery package contains exact default DATA and empty-directory names');
    const after=await api.migrationCapsuleCapturePreserved(base,crypto.randomBytes(32).toString('hex'));
    assert.deepEqual(publicNative(after),publicNative(before));assert.deepEqual(basicMetadata(base,relatives),metadata);
    assert.equal(uncertain(),false);assert.equal(exclusive(owner),true);
    ok(true,'source IDs, DATA, ADS, readonly, aliases, four Basic times and owner/group/DACL remain unchanged');
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
        assert.equal(path.dirname(path.resolve(root)),temp);assert.ok(path.basename(root).startsWith('ruyi-preserved-snapshot-'));
        assert.equal((await fsp.lstat(root)).isSymbolicLink(),false);
        if(uncertain()){completed=false;keeper?.retainUnknown(firstFailure);throw unknownError();}
        await fsp.chmod(payload,0o600);
        if(uncertain()){completed=false;keeper?.retainUnknown(firstFailure);throw unknownError();}
        await fsp.rm(root,{recursive:true,force:false});
        if(uncertain()){completed=false;keeper?.retainUnknown(firstFailure);throw unknownError();}
        ok(true,'genuine source owner closes once and the dedicated synthetic fixture is removed');
      }
    }
  }
}
run().catch(error=>{const code=typeof error?.code==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(error.code)?error.code:'qualification_failed';runner.fail(code);}).finally(()=>runner.done());
