'use strict';
// Actual snapshot/recovery/control/tree owners and real temporary files. Native
// protection, flush, new-process verification and migration are explicit seams;
// these tests do not establish native or process integration.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'),draft=path.join(repo,'output/semantic-gemma-q4-backup-diagnostic-v1/source-input/src');
const {fixture}=require(path.join(repo,'dev-harness/lib/work-data-full-snapshot-fixture'));
// The cold operation under test is the retained research copy unless overridden. Its rehearsal
// location is a property of THAT source: 151 阶段 3A moved it beside the data root (W7).
const coldSource=process.env.RUYI_COLD_OPERATIONS_SOURCE||path.join(draft,'13ak-work-data-cold-operations.js');
const rehearsalFor=(f,backupDirectory,id)=>{let text='';try{text=fs.readFileSync(coldSource,'utf8');}catch{}
 return text.includes('REHEARSAL_PREFIX')?path.join(path.dirname(f.base),'.ruyi-work-data-rehearsal-'+id):path.join(backupDirectory,'.ruyi-work-data-verify-'+id);};
const password='synthetic operation password only',hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function setup(t,options={}){
 const f=await fixture(t,{source:name=>{const file=path.join(repo,'output/semantic-gemma-q4-backup-diagnostic-v1/source-input/src',name),text=fs.readFileSync(file,'utf8');return name==='01ab-work-data-full-snapshot.js'?require('../semantic/work-data-owned-restore-integration-research.cjs').transform(text).source:text;}});f.context.ResearchRestoreUnknown=require('../semantic/work-data-owned-restore-unknown.cjs');await f.write('config.json','{ "workDataEncryptionV1": false, "label":"SYNTHETIC_PRIVATE" }');
 await f.write('uploads/payload.bin',Buffer.from([0,255,99]));await fsp.mkdir(path.join(f.base,'uploads/empty'));
 // Seam over the module's own io: only the backup package open/write is faulted,
 // so every other read stays the real filesystem owner.
 if(options.statfs||options.backupOpenFails||options.backupWriteFails)f.context.require=name=>{
  if(name!=='node:fs/promises')return require(name);
  const api=options.statfs?{...fsp,statfs:options.statfs}:{...fsp};
  if(!options.backupOpenFails&&!options.backupWriteFails)return api;
  return {...api,open:async(file,flags,mode)=>{
   const target=String(file),isPackage=flags==='wx'&&target.endsWith('.ruyi-backup');
   if(isPackage&&options.backupOpenFails)throw Object.assign(Error('simulated backup open refusal'),{code:'EACCES'});
   const handle=await api.open(file,flags,mode);
   if(isPackage&&options.backupWriteFails)return {writeFile:async()=>{throw Object.assign(Error('simulated backup write refusal'),{code:'EIO'});},sync:()=>handle.sync(),close:()=>handle.close()};
   return handle;
  }};
 };
 f.context.VERSION='3.0.1';f.context.ExternalBotCredentials=f.api.ExternalBotCredentials;
 vm.runInContext(fs.readFileSync(path.join(draft,'13aj-work-data-control.js'),'utf8')+'\n'+fs.readFileSync(path.join(draft,'01ae-work-data-maintenance-result.js'),'utf8')+'\n'+fs.readFileSync(coldSource,'utf8'),f.context);
 const api=vm.runInContext('({WorkDataColdOperations,WorkDataTree,WorkDataRecovery,WorkDataManifest})',f.context);
 const events=[],owners=[],sourceOwner={roots:[f.base]},backupDirectory=path.join(f.root,'backups');await fsp.mkdir(backupDirectory);
 let backupFlushes=0;
 const context={id:'a'.repeat(48),base:f.base,operation:'export',password,expectedAuthority:{generation:0,id:null,mode:'plain',sha256:null},paths:{backupDirectory,targetDirectory:null,uploadFile:null,uploadSha256:null},ownership:sourceOwner,assertExclusive:owner=>owner===sourceOwner};
 let x;
 const host={
  async acquire(roots){const owner={roots,released:false,async release(){assert.equal(owner.released,false);owner.released=true;events.push('release:'+path.basename(roots[0]));}};owners.push(owner);events.push('acquire:'+path.basename(roots[0]));return owner;},
  async flush(roots){events.push('flush:'+path.basename(roots[0]));
   if(options.failResultFlush&&path.basename(roots[0])==='.work-data'&&(await fsp.readdir(roots[0])).some(name=>name.startsWith('.maintenance-result-v1.stage-')))throw Error('simulated result flush refusal');
   // Opt-in: refuse the first durability flush of the backup directory only, after
   // the package bytes are already on disk.
   if(options.failBackupFlush&&path.basename(roots[0])==='backups'&&++backupFlushes===1)throw Error('simulated backup flush refusal');},
  async verifyFresh(value){events.push('fresh');assert.ok(owners.every(owner=>owner.released));const own={roots:[value.target]};
   const full=f.api.WorkDataFullSnapshot.create({base:value.target,ownership:own,assertExclusive:owner=>owner===own,protector:f.a,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)});
   const sealed=await full.seal({password:value.password,appVersion:'3.0.1',generation:value.generation??0});assert.ok(sealed.files>=2);
   if(options.verifyFresh)await options.verifyFresh({f,context,events,value});return options.freshResult??true;},
  async verifyDisposableNativeTree(value){events.push('native-tree');assert.ok(owners.some(owner=>!owner.released&&owner===value.ownership));return options.nativeResult??true;},
  async captureRehearsal({target,ownership,assertExclusive}){const tree=api.WorkDataTree.create(),captured=await tree.capture(target);assert.equal(assertExclusive(ownership),true);return {...captured,async verify(owner){assert.equal(assertExclusive(owner),true);await tree.verify(captured);if(options.rehearsalVerify) return options.rehearsalVerify();return true;},release(){events.push('rehearsal-release');captured.release();if(options.rehearsalRelease) return options.rehearsalRelease();}};},
  fullSnapshot(base,ownership,assertExclusive,{onNativeCause}){events.push('snapshot-host');if(options.snapshotFactory)return options.snapshotFactory({base,ownership,assertExclusive,onNativeCause,f});const protector={supported:()=>f.context.LocalSecretCrypto.supported(),async run(...args){try{return await f.context.LocalSecretCrypto.run(...args);}catch(cause){onNativeCause(cause);throw cause;}}};return f.api.WorkDataFullSnapshot.create({base,ownership,assertExclusive,protector,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts)});},
  migrationFactory(args){events.push('migration');if(typeof options.migration!=='function')throw Error('migration must not run for these operations');return options.migration(x,args);},
  progress(value){events.push(value.phase);},helperMayStillRun:()=>options.helperMayStillRun===true,
 };
 const operation=api.WorkDataColdOperations.create(host);
 x={f,api,host,context,operation,events,owners,backupDirectory,rehearsal:rehearsalFor(f,backupDirectory,context.id),backupFile:path.join(backupDirectory,'ruyi-work-data-'+context.id+'.ruyi-backup')};
 return x;
}
// Bounded handoff capability as 13ai issues it. `finish` observes the real files at
// the instant it is called, so ordering claims are evidence rather than narration.
function withClaim(x,options={}){
 const events=[],observed={};
 const resultFile=path.join(x.f.base,'.work-data','maintenance-result-v1.json'),intentFile=path.join(x.f.base,'.work-data','maintenance-v1.json');
 const api={
  async finish(){events.push('finish');observed.finish={result:fs.existsSync(resultFile),intent:fs.existsSync(intentFile)};
   if(options.failFinish)throw Error('synthetic claim finish refusal');},
  async abandon(){events.push('abandon');observed.abandon={backups:(await fsp.readdir(x.backupDirectory)).length};
   if(options.failAbandon)throw Error('synthetic claim abandon refusal');},
 };
 x.claim={events,observed};
 x.context.claim=Object.freeze({finish:()=>api.finish(),abandon:()=>api.abandon()});
 return x;
}
// The worker validates and pins its upload before invoking cold operations.
// This fixture captures that already-validated DTO once from the real held file;
// later substitution must not refresh it. The worker/broker boundary is tested separately.
async function bindRestoreUpload(x,paths){
 assert.equal(x.context.upload,undefined,'fixture handoff can only be issued once');
 const named=await fsp.lstat(paths.uploadFile,{bigint:true}),handle=await fsp.open(paths.uploadFile,'r');
 let first,bytes;try{first=await handle.stat({bigint:true});assert.equal(first.isFile(),true);assert.equal(named.isSymbolicLink(),false);assert.equal(first.nlink,1n);bytes=await handle.readFile();const after=await handle.stat({bigint:true}),last=await fsp.lstat(paths.uploadFile,{bigint:true});for(const key of ['dev','ino','size','nlink','mtimeNs','ctimeNs']){assert.equal(named[key],first[key]);assert.equal(after[key],first[key]);assert.equal(last[key],first[key]);}assert.equal(bytes.length,Number(first.size));assert.equal(hash(bytes),paths.uploadSha256);}finally{await handle.close();}
 x.context.upload=Object.freeze({bytes:bytes.length,identity:Object.freeze({dev:String(first.dev),ino:String(first.ino)})});
 return paths;
}


test('actual 13ak retains rehearsal owner when nested restore barrier is uncertain',async t=>{const raw=Object.assign(Error('pending'),{code:'native.pending',helperMayStillRun:true}),wrapper=Object.assign(Error('wrapped'),{cause:raw});let calls=0;const x=await setup(t,{snapshotFactory:({base,ownership,assertExclusive,f})=>f.api.WorkDataFullSnapshot.create({base,ownership,assertExclusive,protector:f.a,externalOwner:opts=>f.api.ExternalBotCredentials.create(opts),ownedRestoreFlush:async()=>{calls++;throw wrapper;}})});let error;try{await x.operation.execute(x.context);}catch(e){error=e;}assert.equal(calls,1);assert.equal(error.code,'work_data_setup.preparation_failed');assert.equal(error.helperMayStillRun,true);assert.equal(error.cause.code,'work_data_full.restore_failed');assert.equal(error.cause.cause,wrapper);assert.equal(error.cause.cause.cause,raw);assert.equal(x.owners.length,1);assert.equal(x.owners[0].released,false);assert.equal(fs.existsSync(x.rehearsal),true);});
