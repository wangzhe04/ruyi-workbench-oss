'use strict';
// ROOT-RUN SERIAL ONLY. Actual generated runtime, CurrentUser DPAPI and native
// NTFS capsule bridge. Generation readActive receipts below are a controlled
// owner-host seam; this is not the complete server/desktop root-switch pipeline.
const path=require('node:path'),repo=process.env.MIGRATION_REPO||path.resolve(__dirname,'..');
require(path.join(repo,'dev-harness/lib/self-isolate-home'));
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {releaseEnvironment}=require(path.join(repo,'dev-harness/lib/release-checks'));
const {basicMetadata,setShortName}=require(path.join(repo,'dev-harness/lib/skill-capsule-native-fixture'));
const t=require(path.join(repo,'dev-harness/lib/harness')).createRunner('MIGRATION BACKUP REPRESENTATION');
const names=['flushWorkbenchLogs','readConfig','writeConfig','workDataKeys','WorkDataKeys','DurableJsonStore','LocalSecretCrypto','paths','WorkDataStore','MigrationHooks','migrationCopySkills','migrationLogs',
 'migrationUndoSkillCopy','migrationCapsuleRead','migrationCapsuleDescriptor','migrationCapsuleCapturePreserved','skillImportRecordStore','migrationReadBackupHistory'];
const runtimes=[];
// server-internals captures the generated-server override at require time. Load
// it only after replacing the complete environment, including removed keys.
const isolate=(home,data)=>{const isolated=releaseEnvironment(home,data);for(const key of Object.keys(process.env))if(!Object.hasOwn(isolated,key))delete process.env[key];Object.assign(process.env,isolated);};
const load=()=>{assert.equal(process.env.RUYI_TEST_SERVER_JS,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);const {loadServerInternals}=require(path.join(repo,'dev-harness/lib/server-internals'));const api=loadServerInternals(names);runtimes.push(api);return api;};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),id=file=>fs.statSync(file,{bigint:true}).ino.toString();
const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const toggle=async(api,enabled)=>{const config=await api.readConfig();config.workDataEncryptionV1=enabled;await api.writeConfig(config);};
const select=(candidate,generation)=>{const raw=JSON.stringify({schema:1,id:candidate.id,generation,mode:candidate.mode,activeRoot:'generations/'+candidate.id});return{...candidate,generation,proof:{raw,sha256:hash(raw)}};};
const metadata=(root,snapshot)=>basicMetadata(root,snapshot.entries.map(row=>row.rel));
function checkMetadata(root,snapshot,security){
 const actual=metadata(root,snapshot);for(const row of actual){const expected=snapshot.entries.find(x=>x.rel===row.rel);assert.ok(expected);assert.equal(row.attrs,expected.attrs,row.rel+' attrs');assert.deepEqual(row.times,[...expected.times],row.rel+' all four Basic times');assert.equal(row.shortName,expected.shortName,row.rel+' alias');assert.equal(row.sddl,security.find(x=>x.rel===row.rel).sddl,row.rel+' readable owner/group/DACL');}
}
function checkObjects(root,snapshot){
 const seen=[];const walk=rel=>{const file=path.join(root,rel),stat=fs.statSync(file,{bigint:true}),expected=snapshot.entries.find(x=>x.rel===rel.replace(/\\/g,'/'));assert.ok(expected,'no unknown entry '+rel);assert.equal(stat.ino.toString(16).padStart(16,'0'),expected.id.slice(8),rel+' original inode');seen.push(expected.rel);if(stat.isDirectory())for(const child of fs.readdirSync(file))walk(path.join(rel,child));};walk('');assert.equal(seen.length,snapshot.entries.length);
 for(const entry of snapshot.entries)for(const stream of entry.streams){const file=path.join(root,entry.rel)+stream.name;assert.deepEqual(fs.readFileSync(file),Buffer.from(stream.data,'base64'),entry.rel+' '+stream.name+' DATA');}
}
const descriptor=(backup,stamp,skillId,keys)=>({backup,stamp,id:skillId,scopeId:'skill-backups:'+stamp,recordId:'skill-backup:'+(process.platform==='win32'?skillId.toLowerCase():skillId),archiveKeys:keys,intentKeys:keys});
async function flush(){for(const api of runtimes)await api.flushWorkbenchLogs({allowFailure:true});}
function clear(){for(const api of runtimes)api.workDataKeys.clear();}
async function cold(payload){
 isolate(payload.home,payload.data);const api=load(),owner=api.MigrationHooks.createBackupOwner({base:payload.data,readActive:async()=>payload.selected,sourceKeys:api.WorkDataStore.requireKeys()});
 try{await owner.activate();let copies=0;const copy=fsp.copyFile;fsp.copyFile=async(...args)=>{copies++;return copy(...args);};try{await api.MigrationHooks.recover();const repeated=await api.migrationUndoSkillCopy(payload.receipt);assert.equal(repeated.outcome,'restored-previous');}finally{fsp.copyFile=copy;}
  checkMetadata(payload.live,payload.snapshot,payload.security);checkObjects(payload.live,payload.snapshot);assert.equal(id(payload.backup),payload.historyId);assert.equal((await api.migrationReadBackupHistory(payload.backup)).historyOnly,true);assert.equal(copies,0,'new process never replays copy');console.log('COLD NODE HISTORY PASS');
 }finally{await flush();clear();}
}
(async()=>{
 if(process.platform!=='win32'){console.log('SKIP actual Windows NTFS/CurrentUser DPAPI representation lifecycle');return;}
 if(process.argv.includes('--cold')){await cold(JSON.parse(fs.readFileSync(0,'utf8')));return;}
 const temp=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(temp,'ruyi-skill-representation-native-')),home=path.join(root,'home'),data=path.join(root,'data');isolate(home,data);
 let failed=false;
 try{
  const api=load(),skillId='Tool_One',live=path.join(data,'skills',skillId),external=revision=>write(path.join(home,'.codex','skills',skillId,'SKILL.md'),'---\nname: '+skillId+'\ndescription: Owned synthetic native fixture\n---\n\nSYNTH_CAPSULE '+revision+'\n');
  await toggle(api,false);external(1);assert.equal((await api.migrationCopySkills({keys:['codex:'+skillId]})).copied,1);
  write(path.join(live,'original-directory','private.bin'),Buffer.from([0,255,13,10,128,42]));write(path.join(live,'original-directory','private.bin')+':original-ads','OWNED FILE ADS');write(live+':original-directory-ads','OWNED DIRECTORY ADS');write(path.join(live,'original-directory','long-empty-alias-file.txt'),'EMPTY ALIAS DATA');
  setShortName(live,'OLDROOT');setShortName(path.join(live,'original-directory'),'OLDDIR');setShortName(path.join(live,'original-directory','private.bin'),'OLDBIN.BIN');setShortName(path.join(live,'original-directory','long-empty-alias-file.txt'),'');fs.chmodSync(path.join(live,'original-directory','private.bin'),0o444);
  const originalId=id(live);external(2);const copied=await api.migrationCopySkills({keys:['codex:'+skillId],overwrite:true});assert.equal(copied.copied,1);const log=(await api.migrationLogs()).find(x=>x.id===copied.id);assert.ok(log);const receipt=log.files.find(x=>x.kind==='skill-copy');assert.ok(receipt);const legacyBackup=receipt.backup;assert.equal(id(legacyBackup),originalId);assert.equal(fs.existsSync(path.join(data,'work-data-key-v1.json')),false,'ordinary OFF copy never creates a key');
  const before=await api.migrationCapsuleCapturePreserved(legacyBackup,'1'.repeat(64)),security=metadata(legacyBackup,before);assert.equal(before.entries.find(x=>x.rel==='original-directory/private.bin').attrs&1,1);assert.equal(before.entries.find(x=>x.rel==='original-directory/long-empty-alias-file.txt').shortName,'');
  const configBeforeStage=fs.readFileSync(api.paths.config),keyFile=path.join(data,'work-data-key-v1.json'),staged=await api.workDataKeys.stageNew();
  try{
   assert.equal(fs.existsSync(keyFile),false,'stageNew alone never publishes active key state');assert.equal((await api.readConfig()).workDataEncryptionV1,false,'key staging leaves active policy OFF');assert.deepEqual(fs.readFileSync(api.paths.config),configBeforeStage);
   assert.equal(api.WorkDataKeys.validate(staged.header),true);assert.deepEqual(Object.keys(staged.header).sort(),['instanceId','protectedKey','schema']);assert.match(staged.header.instanceId,/^[a-f0-9]{32}$/);
   const wrapped=Buffer.from(staged.header.protectedKey,'base64');let independent;
   try{assert.ok(wrapped.length>32,'staged DPAPI header stores protected bytes');assert.notDeepEqual(wrapped,staged.lease.key);independent=await api.LocalSecretCrypto.run('unprotect',wrapped,Buffer.from('ruyi.work-data.v1:'+staged.header.instanceId));assert.deepEqual(independent,staged.lease.key,'independent actual DPAPI unprotect authenticates the staged header');}finally{wrapped.fill(0);independent?.fill(0);}
   // Match the private 02-session-store owner exactly; use its real validated,
   // strict DurableJsonStore writer rather than fs.writeFile or ensure while OFF.
   const stateOwner=api.DurableJsonStore.create({id:'work-data-key-v1',file:()=>keyFile,schemaVersion:api.WorkDataKeys.SCHEMA,defaultValue:api.WorkDataKeys.empty,cache:false,strictRead:true,quarantine:false,validate:api.WorkDataKeys.validate});
   await stateOwner.write(staged.header);assert.deepEqual(await stateOwner.read(),staged.header);assert.deepEqual(JSON.parse(fs.readFileSync(keyFile,'utf8')),staged.header);assert.deepEqual(fs.readFileSync(api.paths.config),configBeforeStage);
   const published=await api.workDataKeys.snapshot();try{assert.equal(published.instanceId,staged.header.instanceId);assert.deepEqual(published.key,staged.lease.key);}finally{published.release();}
  }finally{staged.lease.release();}
  assert.equal((await api.readConfig()).workDataEncryptionV1,false,'explicit private key publication leaves the active flag OFF');
  const keys=api.WorkDataStore.requireKeys();let selected={id:null,root:data,generation:0,proof:{raw:null,sha256:null}};const owner=api.MigrationHooks.createBackupOwner({base:data,readActive:async()=>selected,sourceKeys:keys});
  const candidate=mode=>{const value={id:crypto.randomBytes(24).toString('hex'),mode};value.root=path.join(data,'.work-data','generations',value.id);fs.mkdirSync(value.root,{recursive:true});return value;};
  async function shadow(source,next,encrypted){const target=path.join(next.root,'skills',skillId);fs.mkdirSync(path.dirname(target),{recursive:true});await fsp.cp(source,target,{recursive:true});const logical=await api.skillImportRecordStore(source,skillId).read();if(encrypted)await api.skillImportRecordStore(target,skillId,true).write(logical);else fs.writeFileSync(path.join(target,'.ruyi-import.json'),logical);return target;}

  const abandoned=candidate('encrypted'),token=await owner.prepare({expected:selected,candidate:abandoned});await owner.prepareRepresentation(token,{mode:'encrypted'});const stable=path.join(token.root,copied.id,skillId),record=await api.migrationCapsuleRead(descriptor(stable,copied.id,skillId,keys));assert.equal(record.intent.conversion.eligibility,'eligible');assert.equal(record.snapshot.entries[0].id,before.entries[0].id);for(const carrier of ['archive','intent']){const text=fs.readFileSync(path.join(stable,carrier),'utf8');assert.equal(JSON.parse(text.split('\n')[0]).workData,3);assert.equal(text.includes('SYNTH_CAPSULE'),false);}
  await delay(24000);assert.equal((await owner.recoverRepresentation()).phase,'canceled');await owner.recover();assert.equal((await api.readConfig()).workDataEncryptionV1,false,'cancellation preserves the original OFF active policy');checkMetadata(legacyBackup,before,security);checkObjects(legacyBackup,before);t.ok(true,'plain to sealed cancellation after delayed alias window restores original IDs/DATA/ADS/readonly/Basic four times/readable SDDL');

  const encrypted=candidate('encrypted'),first=await owner.prepare({expected:selected,candidate:encrypted});const g1Live=await shadow(live,encrypted,true);await owner.prepareRepresentation(first,{mode:'encrypted'});assert.equal((await owner.prepareBindings(first)).ready,true);assert.equal((await api.readConfig()).workDataEncryptionV1,false,'all shadow preparation completes while active policy remains OFF');selected=select(encrypted,1);await toggle(api,true);await owner.activate();const ref=owner.ref(copied.id,skillId,first.storeId),backup=await owner.resolve(ref),committed=await api.migrationCapsuleRead(api.migrationCapsuleDescriptor(backup));assert.equal(committed.intent.generationId,encrypted.id);assert.notEqual(id(g1Live),originalId);t.ok(true,'plain to sealed commit publishes authenticated current-generation intent and retains native originals in the stable capsule');

  const wrapperId=id(backup),archive=fs.readFileSync(path.join(backup,'archive')),originalIntent=fs.readFileSync(path.join(backup,'intent')),plainCandidate=candidate('plain'),second=await owner.prepare({expected:selected,candidate:plainCandidate});await owner.prepareRepresentation(second,{mode:'plain'});checkMetadata(backup,committed.snapshot,security);assert.equal(id(backup),originalId);assert.equal(JSON.parse(fs.readFileSync(path.join(backup,'.ruyi-import.json'),'utf8')).workData,undefined);await owner.recoverRepresentation();assert.equal(id(backup),wrapperId);assert.deepEqual(fs.readFileSync(path.join(backup,'archive')),archive);assert.deepEqual(fs.readFileSync(path.join(backup,'intent')),originalIntent);await owner.activate();t.ok(true,'sealed to plain cancellation restores the exact old wrapper identity and raw sealed carriers');

  const next=await owner.prepare({expected:selected,candidate:plainCandidate}),g2Live=await shadow(g1Live,plainCandidate,false);await owner.prepareRepresentation(next,{mode:'plain'});checkMetadata(backup,committed.snapshot,security);const undoSnapshot=await api.migrationCapsuleCapturePreserved(backup,'3'.repeat(64));assert.equal((await owner.prepareBindings(next)).ready,true);selected=select(plainCandidate,2);await toggle(api,false);await owner.activate();await delay(24000);
  const undoReceipt={...receipt,backupRef:ref};const undone=await api.migrationUndoSkillCopy(undoReceipt);assert.equal(undone.outcome,'restored-previous');checkMetadata(g2Live,undoSnapshot,security);checkObjects(g2Live,undoSnapshot);assert.equal(id(g2Live),originalId);const history=await api.migrationReadBackupHistory(backup);assert.equal(history.mode,'plain');assert.equal(history.phase,'complete');assert.equal(history.historyOnly,true);assert.notEqual(id(backup),originalId);t.ok(true,'encrypted to plain commit and actual business undo publish original objects at the candidate live root and typed terminal history');

  // Preserve final Basic values after the intentionally observable data checks.
  const finalSnapshot=await api.migrationCapsuleCapturePreserved(g2Live,'4'.repeat(64));await flush();clear();const payload={home,data,selected,receipt:undoReceipt,live:g2Live,backup,historyId:id(backup),snapshot:finalSnapshot,security};
  const restarted=cp.spawnSync(process.execPath,[__filename,'--cold'],{env:{...releaseEnvironment(home,data),MIGRATION_REPO:repo},input:JSON.stringify(payload),encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(restarted.status,0,(restarted.stderr||'')+(restarted.stdout||''));assert.match(restarted.stdout,/COLD NODE HISTORY PASS/);assert.equal(id(g2Live),originalId);t.ok(true,'fresh Node DPAPI owner authenticates receipts and repeats terminal undo/recover without copying, recreating originals or changing history identity');
 }catch(error){failed=true;throw error;}finally{await flush();clear();if(!failed){assert.equal(path.dirname(root),temp);assert.ok(path.basename(root).startsWith('ruyi-skill-representation-native-'));const writable=async directory=>{for(const name of await fsp.readdir(directory)){const file=path.join(directory,name),stat=await fsp.lstat(file);assert.equal(stat.isSymbolicLink(),false,'no unknown link in owned cleanup');if(stat.isDirectory())await writable(file);else await fsp.chmod(file,0o666);}};await writable(root);await fsp.rm(root,{recursive:true,force:true});}else console.error('Retained owned native fixture '+root);}
})().catch(error=>{t.fail(error?.stack||String(error));}).finally(()=>t.done({exit:true}));
