'use strict';
require('./lib/self-isolate-home');
// Native qualification of one ordinary text codec's actual source DATA reads.
// Mutable special-store phases, complete migration and other codecs are separate.
const fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createRunner}=require('./lib/harness'),{releaseEnvironment}=require('./lib/release-checks'),{basicMetadata}=require('./lib/skill-capsule-native-fixture');
const runner=createRunner('WORK DATA MIGRATION PRESERVED SOURCE'),{ok}=runner,hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const nativePublic=value=>value.entries.map(({opaque,...row})=>row).sort((a,b)=>a.rel.localeCompare(b.rel));
async function readCodecTargetText(api,file,descriptor,keys){
 return api.WorkDataStore.createText({...descriptor,file:()=>file,keys,enabled:()=>true,
  maxPlaintextBytes:4*1024*1024,writeJson:api.atomicWriteJson}).read();
}
// Preserve the first failure (including falsy values) through each cleanup.
// An uncertain cleanup forbids later disposal and retains the genuine keeper.
async function finishSourceFixture({complete,failed,primary,clear,unknown,retain,release,flush,remove}){
 const errors=[];let uncertain=false,retained=false;
 const isUnknown=()=>{try{return unknown()!==false;}catch(cause){errors.push(cause);uncertain=true;return true;}};
 const hold=()=>{if(retained)return;retained=true;try{retain(failed?primary:errors[0]);}catch(cause){errors.push(cause);uncertain=true;}};
 const attempt=async work=>{try{await work();}catch(cause){errors.push(cause);uncertain=true;}};
 try{const result=clear();if(result!==undefined)throw Error('key_clear_unproven');}catch(cause){errors.push(cause);uncertain=true;}
 if(uncertain||isUnknown())hold();else{await attempt(release);if(uncertain||isUnknown())hold();}
 if(!uncertain&&!isUnknown()){await attempt(flush);if(uncertain||isUnknown())hold();}
 if(complete&&!failed&&!uncertain&&!isUnknown()){await attempt(remove);if(uncertain||isUnknown())hold();}
 const held=uncertain||isUnknown();if(held)hold();
 if(errors.length)throw Object.assign(new AggregateError([...(failed?[primary]:[]),...errors],'migration_preserved.fixture_cleanup',{cause:failed?primary:errors[0]}),{helperMayStillRun:true,ownershipRetained:true});
 if(failed)throw primary;
 if(held)throw Object.assign(Error('migration_preserved.owner_uncertain'),{helperMayStillRun:true,ownershipRetained:true});
}
async function run(){
 if(process.platform!=='win32'){ok(true,'SKIP Windows NTFS source codec qualification');return;}
 const env=releaseEnvironment(process.env.HOME,path.join(process.env.HOME,'migration-preserved-data'));
 for(const name of Object.keys(process.env))if(!Object.hasOwn(env,name))delete process.env[name];Object.assign(process.env,env);
 const api=require('./lib/server-internals').loadServerInternals(['ServerOwnership','WorkDataTree','WorkDataMigrationCodecs','WorkDataKeys','WorkDataStore','WorkDataNativeAdapters','LocalSecretCrypto','MigrationHooks','migrationCapsuleCapturePreserved','atomicWriteJson','flushWorkbenchLogs']);
 await api.flushWorkbenchLogs({allowFailure:false});
 const temp=path.resolve(os.tmpdir()),root=await io.mkdtemp(path.join(temp,'ruyi-migration-preserved-source-')),source=path.join(root,'source'),target=path.join(root,'target'),relative='missions/one.json',file=path.join(source,'missions','one.json');
 let owner,keeper,keys,complete=false,failed=false,firstFailure,metadataUnknown=false,scopes=0,tokens=0,captures=0;
 const adapter=api.WorkDataNativeAdapters.create(),unknown=()=>metadataUnknown||adapter.helperMayStillRun()||api.MigrationHooks.helperMayStillRun()!==false;
 const uncertain=()=>Object.assign(Error('migration_preserved.owner_uncertain'),{helperMayStillRun:true});
 const metadata=(...args)=>{if(unknown())throw uncertain();try{return basicMetadata(...args);}catch(cause){metadataUnknown=true;throw cause;}};
 try{
  await io.mkdir(path.dirname(file),{recursive:true});await io.mkdir(target);
  const logical=JSON.stringify({id:'one',text:'中文😀'.repeat(3000)});await io.writeFile(file,logical);await io.writeFile(file+':synthetic-public-ads','SYNTHETIC alternate stream');await io.chmod(file,0o444);
  owner=await api.ServerOwnership.acquire([source,target]);keeper=api.ServerOwnership.createSourceKeeper(owner,source);const exclusive=value=>value===owner&&keeper.assertExclusive(value);
  const relatives=['','missions','missions/one.json'],beforeMetadata=metadata(source,relatives),before=await api.migrationCapsuleCapturePreserved(source,crypto.randomBytes(32).toString('hex'));
  const reader=api.WorkDataTree.createPreserved({ownership:owner,assertExclusive:exclusive,assertExclusiveSync:exclusive,capturePreserved:async(...args)=>{if(unknown())throw uncertain();captures++;return api.migrationCapsuleCapturePreserved(...args);}});
  const withSourceReadScope=async work=>{
   scopes++;const snapshot=await reader.capture(source);let failed=false,primary,result;
   try{result=await work(async requested=>{tokens++;return api.WorkDataTree.borrowCapturedFile(snapshot,requested,owner,{maxBytes:4*1024*1024});});await reader.verify(snapshot);}
   catch(cause){failed=true;primary=cause;}
   try{const closed=snapshot.release();if(closed!==undefined)throw uncertain();}catch(cleanup){metadataUnknown=true;throw Object.assign(new AggregateError([...(failed?[primary]:[]),cleanup],'source cleanup',{cause:failed?primary:cleanup}),{helperMayStillRun:true});}
   if(failed)throw primary;return result;
  };
  keys=api.WorkDataKeys.create({protector:api.LocalSecretCrypto,enabled:()=>true,store:{read:async()=>api.WorkDataKeys.empty()}});
  const staged=await keys.stageNew();staged.lease.release();keys.clear();keys=api.WorkDataKeys.create({protector:api.LocalSecretCrypto,enabled:()=>true,store:{read:async()=>staged.header}});
  const bridge=api.WorkDataMigrationCodecs.create({sourceRoot:source,targetRoot:target,sourceKeys:keys,targetKeys:keys,writeJson:api.atomicWriteJson,withSourceReadScope,maxPhysicalBytes:4*1024*1024,maxLogicalBytes:4*1024*1024});
  const result=await bridge.transform({relative,targetMode:'encrypted'});assert.equal(result.sourcePhysicalHash,hash(Buffer.from(logical)));assert.equal(result.logicalHash,hash(Buffer.from(logical)));assert.equal(scopes,2);assert.equal(tokens,2);assert.equal(captures,20);
  ok(true,'real text codec shares its physical decode read and uses two genuine grants in two closed preserved scopes');
  const bytes=await io.readFile(path.join(target,...relative.split('/')));assert.equal(bytes.includes(Buffer.from('中文😀')),false);assert.equal(hash(bytes),result.targetPhysicalHash);assert.equal(JSON.parse(bytes.toString('utf8').split('\n')[0]).workData,3);
  const descriptor=api.WorkDataMigrationCodecs.describe(relative);assert.equal(await readCodecTargetText(api,path.join(target,...relative.split('/')),descriptor,keys),logical);
  ok(true,'chunked target authenticates through its real owner and retains exact logical bytes');
  const after=await api.migrationCapsuleCapturePreserved(source,crypto.randomBytes(32).toString('hex'));assert.deepEqual(nativePublic(after),nativePublic(before));assert.deepEqual(metadata(source,relatives),beforeMetadata);assert.equal(unknown(),false);assert.equal(exclusive(owner),true);
  ok(true,'source DATA, identity, ADS, readonly, four Basic times and security metadata remain unchanged');complete=true;
 }catch(cause){failed=true;firstFailure=cause;}
 finally{
  await finishSourceFixture({complete,failed,primary:firstFailure,clear:()=>keys?.clear(),unknown,retain:cause=>{metadataUnknown=true;keeper?.retainUnknown(cause);},
   release:async()=>{if(keeper)await keeper.releaseOwner(()=>!unknown());else if(owner)await owner.release();},flush:()=>api.flushWorkbenchLogs({allowFailure:false}),
   remove:async()=>{assert.equal(path.dirname(root),temp);assert.ok(path.basename(root).startsWith('ruyi-migration-preserved-source-'));assert.equal((await io.lstat(root)).isSymbolicLink(),false);await io.chmod(file,0o600);if(unknown())throw uncertain();await io.rm(root,{recursive:true,force:false});if(unknown())throw uncertain();ok(true,'known successful synthetic fixture closes genuine ownership and removes its own files');}});
 }
}
run().catch(cause=>{const code=typeof cause?.code==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(cause.code)?cause.code:'qualification_failed';runner.fail(code);}).finally(()=>runner.done());
