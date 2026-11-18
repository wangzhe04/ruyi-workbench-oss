'use strict';
// Real 13ak -> 01ab restore and fresh-process application reads. Only the OS
// protector/ownership/flush adapters are synthetic; records, backup, key recovery,
// HMAC owner proofs, session loading and observation tools are production code.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),Module=require('node:module'),assert=require('node:assert/strict');
const {constBlock}=require('./lib/source-slice'),{releaseEnvironment}=require('./lib/release-checks');
const app=path.resolve(__dirname,'../ruyi-workbench/app'),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const password='synthetic observation restore password only';
function protector(key){return{supported:()=>true,helperMayStillRun:()=>false,async run(op,bytes,entropy){
 if(op==='protect'){const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(entropy);return Buffer.concat([nonce,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);}
 const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(entropy);decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);
}};}
function application(native){
 const manifest=JSON.parse(fs.readFileSync(path.join(app,'src/manifest.json'),'utf8'));
 let source=manifest.modules.map(m=>fs.readFileSync(path.join(app,'src',typeof m==='string'?m:m.file),'utf8')).join('\n');
 const original=constBlock(source,'LocalSecretCrypto');assert.ok(original.startsWith('const LocalSecretCrypto ='));
 globalThis.__observationRestoreProtector=native;
 source=source.replace(original,'const LocalSecretCrypto = globalThis.__observationRestoreProtector;');
 const mod=new Module(path.join(app,'server.js'),module);mod.filename=path.join(app,'server.js');mod.paths=Module._nodeModulePaths(app);
 mod._compile(source+'\nmodule.exports.__test={PrivacyCore,PrivacyGateway,workDataKeys,runAutoCompaction,journalReadObservationOwners,journalJsonStore,WorkDataFullSnapshot,WorkDataColdOperations,WorkDataRecovery,WorkDataManifest,ExternalBotCredentials};',mod.filename);
 delete globalThis.__observationRestoreProtector;return mod.exports;
}
async function child(mode){
 const srv=application(protector(Buffer.from(process.env.RUYI_OBSERVATION_PROTECTOR,'hex'))),a=srv.__test;
 const vaultIdentity=async()=>{const snapshot=await a.PrivacyCore.configHooks.snapshotForWorkDataRecovery();assert.ok(snapshot);try{return{instanceId:snapshot.lease.instanceId,masterSha256:hash(snapshot.lease.key)};}finally{snapshot.lease.release();}};
 if(mode==='--seed'){
  const key=await a.workDataKeys.ensure();key.fill(0);
  await srv.mutateConfig(config=>Object.assign(config,{credentialEncryptionV1:true,privacyModeV1:'enhanced',privacyRulesV1:[{id:'restore-pin',kind:'literal',value:'3141',category:'INTERNAL'}]}));
  const session=await srv.createSession({title:'synthetic restore evidence',cwd:process.env.RUYI_HOME});session.turnSeq=7;session.messages=[{id:'restore-original',role:'user',turnSeq:1,content:'restore publicneedle 3141; exact receipt=7.'}];
  session.providerHistory=[{role:'user',content:'retained task'},{role:'assistant',content:'',tool_calls:[{id:'tool1',type:'function',function:{name:'file_read',arguments:'{}'}}]},{role:'tool',tool_call_id:'tool1',content:'restore cobalt '+ 'filler '.repeat(300)+'exact amount 3471.25 CNY '+'tail '.repeat(400)},{role:'assistant',content:'done'},...Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',content:'continuation'}))];
  await srv.saveSession(session);const history=session.providerHistory;
  const compact=await a.runAutoCompaction({history,privacyHistoryOwner:session,scope:'main',provider:{id:'p'},model:'m',sys:'',tools:[],config:{runtimeObservationReducerV1:true,runtimeObservationRecallV1:true},budget:1000,window:10000,watermark:0,snapshot:()=>srv.writeHistorySnapshot(session.id,session.turnSeq,history,true),onEvent:()=>{}});
  assert.equal(compact.compacted,true);const owner=await a.journalReadObservationOwners(session.id);assert.equal(owner.items.length,1);
  await srv.saveSession(session);
  const lease=await a.workDataKeys.snapshot();let identity;try{identity={instanceId:lease.instanceId,masterSha256:hash(lease.key)};}finally{lease.release();}
  const config=await srv.readConfig(),message=await a.PrivacyGateway.run(session.id,config,async()=>{const result=await srv.toolCall('observation_recall',{query:'publicneedle'},{session,sessionId:session.id,mainTurn:true}),hit=result.candidates.find(row=>row.kind==='message');assert.ok(hit?.messageRef.startsWith('message:v2:'));const model=await a.PrivacyGateway.modelToolResult(result);assert.ok(model.ok&&model.candidates.some(row=>row.snippet.includes('[[RUYI_PVT:')));return{ref:hit.messageRef,offset:hit.offset};});
  return{sessionId:session.id,createdAt:session.createdAt,message,vault:await vaultIdentity(),ownerSha256:hash(Buffer.from(JSON.stringify(owner))),...identity};
 }
 const sessionId=process.env.RUYI_OBSERVATION_SESSION;
 try{
  const session=await srv.loadSession(sessionId),owner=await a.journalReadObservationOwners(sessionId),lease=await a.workDataKeys.snapshot();let identity;
  try{identity={instanceId:lease.instanceId,masterSha256:hash(lease.key)};}finally{lease.release();}
  const config=await srv.readConfig(),reads=await a.PrivacyGateway.run(sessionId,config,async()=>{
   const ctx={session,sessionId,mainTurn:true},found=await srv.toolCall('observation_recall',{query:'3471.25'},ctx);assert.equal(found.ok,true);
   const hit=found.candidates.find(row=>row.rawRef?.startsWith('history:')&&row.snippet.includes('3471.25'));assert.ok(hit,JSON.stringify(found));
   const page=await srv.toolCall('observation_recall',{rawRef:hit.rawRef,offset:hit.offset,maxChars:1000},ctx);assert.equal(page.ok,true);assert.match(page.content,/3471\.25/);
   const original=await srv.toolCall('observation_recall',{messageRef:process.env.RUYI_OBSERVATION_MESSAGE_REF,offset:Number(process.env.RUYI_OBSERVATION_MESSAGE_OFFSET),maxChars:1000},ctx);assert.equal(original.ok,true);assert.match(original.content,/receipt=7/);assert.ok(!original.content.includes('3141'));const protectedPage=await a.PrivacyGateway.modelToolResult(original);assert.equal(protectedPage.ok,true);assert.ok(protectedPage.content.includes('[[RUYI_PVT:'));
   const ref=process.env.RUYI_OBSERVATION_MESSAGE_REF,prevGeneration=session.rewindGen;session.rewindGen=(Number(prevGeneration)||0)+1;let rewindRejected=false;try{await srv.toolCall('observation_recall',{messageRef:ref},ctx);}catch{rewindRejected=true;}finally{session.rewindGen=prevGeneration;}assert.equal(rewindRejected,true);
   const bodyPath=path.join(process.env.RUYI_HOME,'sessions',sessionId+'.messages.ndjson'),body=fs.readFileSync(bodyPath),tampered=Buffer.from(body);tampered[Math.floor(tampered.length/2)]^=1;fs.writeFileSync(bodyPath,tampered);let sourceRejected=false;try{await srv.toolCall('observation_recall',{messageRef:ref},ctx);}catch{sourceRejected=true;}finally{fs.writeFileSync(bodyPath,body);}assert.equal(sourceRejected,true);
   return{persistence:found.coverage.persistence,message:{readExact:true,projected:true,rewindRejected,sourceRejected}};
  });
  const other=await srv.createSession({title:'other restored session',cwd:process.env.RUYI_HOME});other.turnSeq=1;other.messages=[{role:'user',id:'other',turnSeq:1,content:'restore publicneedle 3141; exact receipt=7.'}];await srv.saveSession(other);let crossSessionRejected=false;await a.PrivacyGateway.run(other.id,config,async()=>{try{await srv.toolCall('observation_recall',{messageRef:process.env.RUYI_OBSERVATION_MESSAGE_REF},{session:other,sessionId:other.id,mainTurn:true});}catch{crossSessionRejected=true;}});assert.equal(crossSessionRejected,true);
  return{ok:true,createdAt:session.createdAt,crossSessionRejected,message:reads.message,vault:await vaultIdentity(),ownerSha256:hash(Buffer.from(JSON.stringify(owner))),persistence:reads.persistence,readExact:true,...identity};
 }catch(error){if(mode==='--wrong-protector')return{ok:false,code:error.code||error.message};throw error;}
}
async function main(){
 const temporaryParent=path.resolve(os.tmpdir()),originalEnv={...process.env};let receipt;
 const root=await fsp.mkdtemp(path.join(temporaryParent,'ruyi-observation-full-restore-')),base=path.join(root,'source'),target=path.join(root,'restored'),aKey=crypto.randomBytes(32),bKey=crypto.randomBytes(32),config={configSchema:9,permissionMode:'bypass',runtimeObservationReducerV1:true,runtimeObservationRecallV1:true,autoImportClaudeCodeMcp:false,workDataEncryptionV1:true};
 const childRun=(mode,data,key,sessionId,message)=>{
  const env={...releaseEnvironment(path.join(root,mode.slice(2)+'-home'),data),RUYI_DISABLE_SEMANTIC:'1',RUYI_OBSERVATION_PROTECTOR:key.toString('hex'),RUYI_OBSERVATION_SESSION:sessionId||'',RUYI_OBSERVATION_MESSAGE_REF:message?.ref||'',RUYI_OBSERVATION_MESSAGE_OFFSET:String(message?.offset||0)};
  const result=cp.spawnSync(process.execPath,[__filename,mode],{env,encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024});
  assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout.trim());
 };
 try{
  await fsp.mkdir(base);await fsp.writeFile(path.join(base,'config.json'),JSON.stringify(config));
  const seeded=childRun('--seed',base,aKey),initialHeader=await fsp.readFile(path.join(base,'work-data-key-v1.json'));
  const env=releaseEnvironment(path.join(root,'parent-home'),base);for(const key of Object.keys(process.env))if(!Object.hasOwn(env,key))delete process.env[key];Object.assign(process.env,env,{RUYI_DISABLE_SEMANTIC:'1'});
  const srv=application(protector(aKey)),api=srv.__test,sourceOwner={roots:[base]},owned=new Set([sourceOwner]);
  const sourceSnapshot=api.WorkDataFullSnapshot.create({base,ownership:sourceOwner,assertExclusive:owner=>owned.has(owner),protector:protector(aKey),externalOwner:options=>api.ExternalBotCredentials.create(options)});
  const sealed=await sourceSnapshot.seal({password,appVersion:'3.0.1',generation:0}),upload=path.join(root,'upload.ruyi-backup'),backups=path.join(root,'backups');
  await fsp.mkdir(backups);await fsp.writeFile(upload,sealed.serialized);const stat=await fsp.lstat(upload,{bigint:true}),phases=[];let verified=null,restores=0;
  const host={async acquire(roots){const owner={roots,async release(){assert.equal(owned.delete(owner),true);}};owned.add(owner);return owner;},async flush(){},helperMayStillRun:()=>false,progress:value=>phases.push(value.phase),
   fullSnapshot(base,ownership,assertExclusive){const real=api.WorkDataFullSnapshot.create({base,ownership,assertExclusive,protector:protector(bKey),externalOwner:options=>api.ExternalBotCredentials.create(options)});return{seal:real.seal,restore:async args=>{restores++;return real.restore(args);}};},
   async verifyFresh(value){assert.equal([...owned].some(owner=>owner.roots.includes(value.target)),false);verified=childRun('--verify',value.target,bKey,seeded.sessionId,seeded.message);return verified.ok===true;},
   async verifyDisposableNativeTree(){throw Error('restore must not enter disposable export cleanup');},async captureRehearsal(){throw Error('restore must not rehearse export');},migrationFactory(){throw Error('restore must preserve recovered master, not migrate');}
  };
  const result=await api.WorkDataColdOperations.create(host).execute({id:'a'.repeat(48),base,operation:'restore',password,ownership:sourceOwner,assertExclusive:owner=>owned.has(owner),expectedAuthority:{generation:0,id:null,mode:'encrypted',sha256:null},upload:{bytes:Number(stat.size),identity:{dev:String(stat.dev),ino:String(stat.ino)}},paths:{backupDirectory:backups,targetDirectory:target,uploadFile:upload,uploadSha256:hash(Buffer.from(sealed.serialized))}});
  assert.equal(result.state,'verified');assert.equal(result.activation,'separate-fresh-root');assert.equal(restores,1);assert.equal(owned.size,1);
  assert.equal(verified.createdAt,seeded.createdAt);assert.deepEqual(verified.vault,seeded.vault);assert.equal(verified.crossSessionRejected,true);assert.deepEqual(verified.message,{readExact:true,projected:true,rewindRejected:true,sourceRejected:true});assert.equal(verified.instanceId,seeded.instanceId);assert.equal(verified.masterSha256,seeded.masterSha256);assert.equal(verified.ownerSha256,seeded.ownerSha256);assert.equal(verified.persistence,'journal-owner');assert.equal(verified.readExact,true);
  assert.notDeepEqual(await fsp.readFile(path.join(target,'work-data-key-v1.json')),initialHeader);assert.deepEqual(await fsp.readFile(path.join(base,'work-data-key-v1.json')),initialHeader);
  for(const relative of ['sessions/'+seeded.sessionId+'.provider.ndjson','checkpoints/'+seeded.sessionId+'/observation-owners-v1.json'])assert.deepEqual(await fsp.readFile(path.join(target,relative)),await fsp.readFile(path.join(base,relative)));
  const restarted=childRun('--verify',target,bKey,seeded.sessionId,seeded.message);assert.deepEqual(restarted,verified);
  const wrong=childRun('--wrong-protector',target,aKey,seeded.sessionId);assert.equal(wrong.ok,false);assert.match(wrong.code,/work_data/);
  receipt={status:'PASS',productionPath:'13ak.WorkDataColdOperations.restore -> 01ab.WorkDataFullSnapshot.restore -> fresh application process',masterPreserved:true,instancePreserved:true,vaultMasterAndInstancePreserved:true,protectorChanged:true,ownerProofBytesPreserved:true,freshProcessQueryAndRead:true,preBackupMessageRefFreshProcessProtectedRead:true,restoredReferenceRejectsCrossSessionRewindSourceChange:true,secondRestartQueryAndRead:true,oldProtectorRefused:true,phases,adapters:'synthetic protector, ownership and flush; no OS-native metadata/DPAPI qualification'};
 }finally{aKey.fill(0);bKey.fill(0);for(const key of Object.keys(process.env))if(!Object.hasOwn(originalEnv,key))delete process.env[key];Object.assign(process.env,originalEnv);assert.equal(path.dirname(root),temporaryParent);await fsp.rm(root,{recursive:true,force:true});}
 console.log(JSON.stringify(receipt));
}
if(process.argv[2])child(process.argv[2]).then(result=>process.stdout.write(JSON.stringify(result))).catch(error=>{console.error(error);process.exitCode=1;});else main().catch(error=>{console.error(error);process.exitCode=1;});
