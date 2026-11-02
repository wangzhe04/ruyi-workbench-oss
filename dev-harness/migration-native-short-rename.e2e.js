'use strict';
const started=Number(process.hrtime.bigint()/1000000n);
// ROOT-RUN SERIAL ONLY. Focused B0 ABI qualification, not the unchanged full
// representation/DPAPI/cold journey. Every result/root stays for review.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),a=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const F=require('./lib/migration-native-short-rename-fixture'),{install}=require('./lib/migration-native-short-rename-observer'),{withReleaseMkdir}=require('./lib/migration-native-short-rename-release-mkdir'),{releaseEnvironment}=require('./lib/release-checks'),{basicMetadata}=require('./lib/skill-capsule-native-fixture'),t=require('./lib/harness').createRunner('MIGRATION NATIVE SHORT RENAME');
const now=()=>Number(process.hrtime.bigint()/1000000n),repo=path.resolve(__dirname,'..');
let api,owner,keeper,finalKeeper,captured,tap,seam,root,events=null,phase='entry',ownerReleased=false,tapRestored=false,releasing=false;
const state=new F.State(now,started,error=>{for(const pin of [keeper,finalKeeper])try{pin?.retainUnknown(error);}catch{/* private owner keeps its own uncertainty */}});
const admit=()=>{if(api?.migrationCapsuleBroker.helperMayStillRun===true)state.retain(F.error('short_rename.original_helper_unknown'));if(owner&&!releasing&&(!keeper?.assertExclusive(owner)||!finalKeeper?.assertExclusive(owner)))state.retain(F.error('short_rename.owner_unknown'));state.admit();};
const code=error=>{const value=error&&Object.getOwnPropertyDescriptor(error,'code')?.value;return typeof value==='string'&&/^[a-zA-Z0-9_.-]{1,128}$/.test(value)?value:'short_rename.assertion_or_failure';};
const emit=(type,data={})=>{if(events!==null)fs.writeSync(events,JSON.stringify({type,phase,elapsedMs:now()-started,...data})+'\n');};
const latch=error=>{state.retain(typeof error==='string'?F.error(error):error);process.exitCode=1;if(root)try{fs.writeFileSync(path.join(root,'UNKNOWN.json'),JSON.stringify({status:'PERMANENT_RED_UNKNOWN',code:code(state.first),elapsedMs:now()-started,lateSuccessCannotClear:true})+'\n',{flag:'wx'});}catch{/* first receipt remains; no observer callback throws */}};
const safe=()=>state.safe(tap?.allKnown()===true,api?.migrationCapsuleBroker.helperMayStillRun===true);
const timer=setTimeout(()=>latch(F.error('short_rename.deadline_unknown')),Math.max(1,state.deadline-now()));
async function group(label,work){admit();phase=label;emit('group-start',{commandIssueTimesObservable:false});admit();const result=await work();admit();a(tap.allKnown(),'all issued original helpers must have exact known close');emit('group-complete');admit();return result;}
async function commands(label,list){return group(label,async()=>{admit();const broker=await seam.factory();try{admit();for(const command of list){admit();await broker.command(command);admit();}}finally{await broker.close();}admit();});}
function applyEnvironment(env){for(const key of Object.keys(process.env))if(!Object.hasOwn(env,key))delete process.env[key];Object.assign(process.env,env);}
async function run(){
 try{
  admit();if(process.platform!=='win32'){console.log('SKIP actual Windows NTFS focused short-name ABI');return;}
  for(const key of Object.keys(process.env))if(/^(?:MIGRATION_REPO|RUYI_TEST_SERVER_JS|NODE_COMPILE_CACHE|NODE_V8_COVERAGE|NODE_REDIRECT_WARNINGS|NODE_EXTRA_CA_CERTS)$/i.test(key))throw F.error('short_rename.source_or_node_override');
  admit();root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-native-short-rename-'));admit();
  const env=withReleaseMkdir(fs,admit,()=>releaseEnvironment(path.join(root,'home'),path.join(root,'data')),e=>state.red(e),latch);admit();
  for(const key of Object.keys(env))if(key.toUpperCase()==='PSMODULEPATH')delete env[key];env.PSModulePath=path.resolve(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','Modules');applyEnvironment(env);admit();
  a.equal(process.env.RUYI_TEST_SERVER_JS,undefined);a.equal(process.env.NODE_OPTIONS,undefined);
  api=require('./lib/server-internals').loadServerInternals(['ServerOwnership','WorkDataTree','migrationCapsuleBroker','migrationCapsuleCapturePreserved','migrationCapsuleShape','flushWorkbenchLogs'],{withEval:true});admit();await api.flushWorkbenchLogs({allowFailure:false});admit();
  // The real deny event reads the committed audit policy. Initialize a fresh
  // installation through the product API before exercising that event; this
  // setup and its normal probes remain inside the same absolute Case120.
  await api.__eval('readConfig')();admit();
  const auditEnabled=await api.__eval('auditLogEnabled')();admit();a.equal(typeof auditEnabled,'boolean');
  const codeWrite=await api.__eval('guardFileToolPath')(path.join(root,'ruyi-native-code-aB12cD','capsule.dll'),{session:{cwd:root},config:{permissionMode:'bypass',defaultWorkspace:root}},{tool:'file_write',write:true});admit();a.equal(codeWrite.ok,false);a.equal(codeWrite.code,'autoexec-denied');
  await api.flushWorkbenchLogs({allowFailure:false});admit();
  const canonical=await api.ServerOwnership.canonicalRoot(root);admit();a.equal(canonical.toLowerCase(),root.toLowerCase());
  owner=await api.ServerOwnership.acquire([root]);
  // Late acquisition may only receive genuine pins and become permanently unknown.
  a.equal(api.ServerOwnership.isLease(owner),true);keeper=api.ServerOwnership.createSourceKeeper(owner,canonical);finalKeeper=api.ServerOwnership.createSourceKeeper(owner,canonical);admit();
  a(api.ServerOwnership.isSourceKeeper(keeper,owner,canonical));a(api.ServerOwnership.isSourceKeeper(finalKeeper,owner,canonical));
  const exclusive=value=>{admit();return keeper.assertExclusive(value)&&finalKeeper.assertExclusive(value);};a(exclusive(owner));
  const S=path.join(root,'S'),C=path.join(root,'capsule'),objects=path.join(C,'objects'),Q=path.join(root,'restored'),target=path.join(root,'target');
  for(const dir of [S,path.join(S,'D'),C,objects,Q]){admit();fs.mkdirSync(dir);admit();}
  for(const row of F.fixture())try{admit();fs.writeFileSync(path.join(S,...row.rel.split('/'))+(row.stream?':public-ads':''),row.data,{flag:'wx'});admit();}finally{row.data.fill(0);}
  admit();fs.chmodSync(path.join(S,'D','A'),0o444);admit();events=fs.openSync(path.join(root,'events.jsonl'),'wx');admit();
  const sourceText=api.__eval('MIGRATION_SKILL_CAPSULE_NATIVE');a.equal(F.sha(sourceText),'c9d7d11fa79a99ace71353a6fb3010eca69eedac855034e3b848a1e91e25e033');
  const common=(args,native=false)=>{admit();a.equal(args[0],native?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe');a.deepEqual(args[1].slice(0,4),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);a.equal(args[1].length,5);a.equal(args[2].windowsHide,true);a.equal(args[2].env.PSModulePath,env.PSModulePath);};
  tap=install(cp,{state,emit,latch,getPhase:()=>phase,now,beforeNative(args){common(args,true);a.deepEqual(args[2].stdio,['pipe','pipe','pipe']);a.equal(F.sha(Buffer.from(args[2].env.RUYI_SKILL_CAPSULE_SOURCE,'base64')),F.sha(sourceText));},beforeMetadata(args){common(args);a.equal(args[2].timeout,30000);a.equal(args[2].encoding,'utf8');a.equal(F.sha(Buffer.from(args[2].env.RUYI_NATIVE_FIXTURE_SOURCE,'base64')),'7d4f26d9888acebe7597ae528c5b69d4876407077a60e582c4fc2b37152ebbc0');}});
  let factories=0;seam=F.installAdmission(api,{admit,latch,afterFactory(broker){a.equal(Object.isFrozen(broker),true);a.deepEqual(Object.keys(broker).sort(),['close','command']);a.equal(tap.rows.length,++factories,'one real original child per original factory');}});
  const metadataCall=label=>group(label,async()=>basicMetadata(label==='metadata-before'?S:target,[...F.RELS]));
  // This is the immutable Basic4/security witness. No subsequent Node DATA read
  // or readdir of S/target is permitted; original native-preserved readers only.
  const baseline=await metadataCall('metadata-before');emit('immutable-baseline',{nodeDataReadAfterBaseline:false});admit();
  const tree=api.WorkDataTree.createPreserved({capturePreserved:api.migrationCapsuleCapturePreserved,ownership:owner,assertExclusive:exclusive,assertExclusiveSync:exclusive,limits:{bytes:65536,files:2,directories:1,pathLength:32}});
  captured=await group('initial-preserved',()=>tree.capture(S));const beforeProof=tree.fingerprint(captured),verified=await group('initial-verify',()=>tree.verify(captured));a.equal(verified.nativeSha256,beforeProof.nativeSha256);a.equal(verified.sha256,beforeProof.sha256);a.equal(verified.files,2);a.equal(verified.directories,1);a.equal(verified.bytes,65504);a.equal(captured.release(),undefined);captured=null;
  const revision=crypto.randomBytes(32).toString('hex'),N0=await group('N0',()=>api.migrationCapsuleCapturePreserved(S,revision));a(api.migrationCapsuleShape(N0));F.check(N0);F.metadata(baseline,N0);t.ok(true,'genuine owner and preserved four-object native baseline include readonly A and ADS');
  await commands('seal',[{cmd:'attach',roots:[S],snapshot:N0},{cmd:'seal-attached',container:objects},{cmd:'verify',cleared:true}]);t.ok(true,'original seal and exact cleared-object verification complete');
  const rootId=N0.entries.find(r=>r.rel==='').id;
  await commands('restore',[{cmd:'attach',roots:N0.entries.map(r=>path.join(objects,r.opaque)),snapshot:N0},{cmd:'publish-check',target},{cmd:'restore',target:path.join(Q,rootId),container:objects},{cmd:'publish',target,container:objects}]);t.ok(true,'original restore and publish exercise canonical D A B rename paths');
  const witness=await metadataCall('metadata-after');F.metadata(witness,N0,baseline);
  captured=await group('final-preserved',()=>tree.capture(target));const finalProof=tree.fingerprint(captured),finalVerified=await group('final-verify',()=>tree.verify(captured));a.equal(finalProof.sha256,finalVerified.sha256);a.equal(finalProof.nativeSha256,finalVerified.nativeSha256);a.equal(captured.release(),undefined);captured=null;
  const final=await group('final-native',()=>api.migrationCapsuleCapturePreserved(target,revision));F.check(final);F.same(final,N0);F.metadata(witness,final,baseline);t.ok(true,'all original IDs DATA ADS Basic4 including Access aliases readonly and readable security remain exact');
  a.equal(state.native,12);a.equal(state.metadata,2);a.equal(tap.allKnown(),true);safe();
  const cache=api.__eval('migrationCapsuleCode');await cache.idle();admit();const codeStats=cache.stats();a.equal(codeStats.disabled,false);a.equal(codeStats.pending,0);a.equal(codeStats.published,1);a(codeStats.loaded>0);a.equal(codeStats.compiled+codeStats.loaded,12);a.equal(codeStats.sourceChildren+codeStats.byteChildren,12);emit('native-code-cache',codeStats);admit();
  const restored=seam.restore();seam=null;a.equal(restored.sourceSha256,F.FACTORY_SHA);a.equal(restored.originalHelperUnknown,false);tap.restore();tapRestored=true;safe();releasing=true;
  await keeper.releaseChecked(safe);safe();await finalKeeper.releaseOwner(safe);safe();ownerReleased=true;
  emit('genuine-keepers-and-owner-released',{knownHelpers:state.native,metadata:state.metadata});safe();
  fs.writeFileSync(path.join(root,'RESULT.json'),JSON.stringify({status:'B0_ASSERTIONS_RELEASE_OBSERVED_PENDING_NATURAL_TERMINALS',elapsedMs:now()-started,wholeBudgetMs:120000,ownerReleased:true,unknown:false,counts:{capsules:state.native,metadata:state.metadata},codeCache:codeStats,baseline:F.publicSnapshot(N0),after:F.publicSnapshot(final),metadataBefore:baseline.map(({sddl,...row})=>({...row,sddlSha256:F.sha(sddl)})),metadataAfter:witness.map(({sddl,...row})=>({...row,sddlSha256:F.sha(sddl)})),rootsRetained:true,fullRepresentationPassed:false,primitive14Plus3Complete:false},null,2)+'\n',{flag:'wx'});safe();
  emit('result',{status:'B0_ASSERTIONS_RELEASE_OBSERVED_PENDING_NATURAL_TERMINALS'});fs.fsyncSync(events);safe();fs.closeSync(events);events=null;safe();t.ok(true,'every original helper close two keeper checks and owner release complete within the same120000 window');
 }catch(error){latch(error);t.fail(code(error));try{emit('first-red',{code:code(state.first),unknown:true,ownerReleased});if(root)fs.writeFileSync(path.join(root,'FIRST-RED.json'),JSON.stringify({status:'PERMANENT_RED_UNKNOWN',code:code(state.first),elapsedMs:now()-started,unknown:true,ownerReleased,rootsRetained:true,lateSuccessCannotClear:true},null,2)+'\n',{flag:'wx'});}catch{/* no replacement success receipt */}}
 finally{
  if(captured)try{a.equal(captured.release(),undefined);}catch(error){latch(error);t.fail(code(error));}
  if(seam)try{seam.restore();}catch(error){latch(error);t.fail(code(error));}
  if(tap&&!tapRestored)try{tap.restore();tapRestored=true;}catch(error){latch(error);t.fail(code(error));}
  clearTimeout(timer);if(root)console.error('Retained owned focused native fixture '+root);
  // Unknown keeps genuine original owner/keeper references; no forced exit,
  // kill, retry, clean-up, alternate root or later positive verdict.
 }
}
run().catch(error=>{latch(error);t.fail(code(error));}).finally(()=>{if(state.first&&t.failures===0)t.fail(code(state.first));t.done();});
