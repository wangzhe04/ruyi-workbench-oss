'use strict';
// Actual Windows production ServerHost + generated serve + its inherited Job.
// Default starts one synthetic active CLI, then closes through the private protocol.
// --desktop-app [--owner-exit] [--dual] explicitly opens complete, isolated production windows.
// --desktop-app --resources samples one ready window throughout a 65s+ idle period before closing it normally.
// --idle omits that CLI. --window also exercises the actual ShellForm.Close path;
// That path does not claim a mouse/titlebar or Privacy GUI journey.
// --idle --semantic verifies an explicitly selected local EmbeddingGemma 2.
// --owner-exit tests abrupt termination of this fixture's console owner.
// --handoff requests a real export; add --require-export to require a verified, downloadable package.
// --dual starts a second console owner with its own data root and the same model profile.
// --idle --nested-job / --outer-quota places only the fixture host in an extra Windows Job.
// --idle --inner-quota occupies the production Job before assigning a suspended entry sentinel.
// On any unknown/failure the detached owner and its scene are retained, never killed.
require('./lib/self-isolate-home.js');
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {createRunner}=require('./lib/harness.js');
const {fixtureChildEnv}=require('./lib/fixture-home.js');
const {fixedSpawnCommandLine}=require('./lib/work-data-production-upload-process.js');
const {processRows,sameProcess,processIdentity}=require('./lib/windows-lifetime-processes.cjs');
const {requestJson}=require('./lib/lifetime-loopback-json.cjs');
const runner=createRunner('DESKTOP LIFETIME'),root=p.resolve(__dirname,'..'),wb=p.join(root,'ruyi-workbench');
const args=process.argv.slice(2),flags=new Set(args);
const windowMode=flags.has('--window'),idle=flags.has('--idle'),holdUI=flags.has('--hold-ui'),semantic=flags.has('--semantic');
const ownerExit=flags.has('--owner-exit'),handoff=flags.has('--handoff'),dual=flags.has('--dual');
const requireExport=flags.has('--require-export');
const nestedJob=flags.has('--nested-job'),outerQuota=flags.has('--outer-quota'),innerQuota=flags.has('--inner-quota');
if(flags.has('--desktop-app')){
 const resources=flags.has('--resources');
 if(process.platform!=='win32'||flags.size!==args.length||resources&&(dual||ownerExit)||args.some(value=>!['--desktop-app','--dual','--owner-exit','--resources'].includes(value)))
  throw Error('Use --desktop-app [--owner-exit] [--dual] or --desktop-app --resources on Windows with RUYI_TEST_GEMMA2_ROOT');
 require('./lib/desktop-app-lifetime.cjs').run({workbench:wb,dual,ownerExit,resources})
  .then(()=>runner.ok(true,'production desktop window, service, model and WebView lifetime verified'))
  .catch(error=>runner.fail(error.stack)).finally(()=>runner.done());
}else{
 if(flags.size!==args.length||args.some(value=>!['--window','--idle','--hold-ui','--semantic','--owner-exit','--handoff','--require-export','--dual','--nested-job','--outer-quota','--inner-quota'].includes(value))
  ||requireExport&&(!handoff||process.platform!=='win32')
  ||innerQuota&&(!idle||flags.size!==2)
  ||(nestedJob||outerQuota)&&(!idle||windowMode||dual||ownerExit||handoff||nestedJob&&outerQuota)
  ||holdUI&&!windowMode||semantic&&(!idle||windowMode)||(ownerExit||handoff||dual)&&!semantic||handoff&&(ownerExit||dual))
  throw Error('Use --idle [--semantic] [--nested-job or --outer-quota], --idle --inner-quota, --idle --semantic [--dual] [--owner-exit], --idle --semantic --handoff [--require-export], --window, or --window --hold-ui');
 if(process.platform!=='win32'){console.log('SKIP DESKTOP LIFETIME: Windows Job/Framework required');process.exitCode=0;}
 else void main();
}
const uncertain=row=>['uncertain','retained','unexpected-exit'].includes(row.phase);
function prepareScene(dir){
 const data=p.join(dir,'data'),temp=p.join(dir,'temp');
 fs.mkdirSync(data);fs.mkdirSync(temp);
 const {env}=fixtureChildEnv({perTest:true});Object.assign(env,{RUYI_HOME:data,TEMP:temp,TMP:temp,WCW_TEST_NO_NET_ANCHORS:'1'});delete env.WIN_CLAUDE_WORKBENCH_HOME;delete env.RUYI_TEST_SERVER_JS;delete env.RUYI_DESKTOP_CONTROL_V1;
 for(const key of Object.keys(env))if(/^(?:ANTHROPIC_|OPENAI_|DEEPSEEK_|KIMI_|CLAUDE_|CODEX_|RUYI_(?:INTERNAL_|MAINTENANCE_|DESKTOP_))/.test(key.toUpperCase()))delete env[key];
 const actorFile=p.join(dir,'synthetic-cli.json'),fakeCLI=p.join(dir,'synthetic-cli.cjs');
 if(!idle){fs.writeFileSync(fakeCLI,["const fs=require('node:fs');",'const capEnvPresent=Object.keys(process.env).some(key=>key.toUpperCase()==="RUYI_DESKTOP_CONTROL_V1");',
  'fs.writeFileSync('+JSON.stringify(actorFile)+',JSON.stringify({pid:process.pid,parentPid:process.ppid,capEnvPresent}));',
  'if(capEnvPresent)process.exit(91);',"process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'synthetic-lifetime',tools:[],model:'synthetic'})+'\\n');",'process.stdin.resume();setInterval(()=>{},1000);'].join('\n'));
  env.WCW_FAKE_CLAUDE=fakeCLI;}
 fs.writeFileSync(p.join(data,'config.json'),JSON.stringify({configSchema:14,locale:'en-US',workDataEncryptionV1:false,permissionMode:'ask',engineMode:'print',claudePath:process.execPath,kimiPath:process.execPath,stewardEnabledV1:false,schedulerEnabledV1:false,
  autoImportClaudeCodeMcp:false,importAgentInstructions:false,includeWorkbenchMcp:false,enableMcpDropIn:false,desktopMcp:{enabled:false,autodetect:false},externalMcpServers:[],providers:[],defaultWorkspace:dir}));
 return {data,env,actorFile};
}
function startProbe(exe,scene,mode,base=wb){
 const child=cp.spawn(exe,[base,...(mode?[mode]:[])],{env:scene.env,cwd:base,windowsHide:mode!=='window',detached:true,stdio:['pipe','pipe','pipe']});
 const probe={child,data:scene.data,events:[],terminal:null,stderr:'',pending:'',stdoutEOF:false,stderrEOF:false,observationFailure:null};
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',chunk=>{
  try{
   probe.pending+=chunk;
   if(probe.pending.length>65536)throw Error('acceptance frame budget');
   let at;
   while((at=probe.pending.indexOf('\n'))>=0){
    const line=probe.pending.slice(0,at).replace(/\r$/,'');
    probe.pending=probe.pending.slice(at+1);
    probe.events.push(JSON.parse(line));
   }
  }catch(error){probe.observationFailure=error;}
 });
 child.stderr.on('data',chunk=>{probe.stderr=(probe.stderr+chunk).slice(-8192);});
 child.stdout.on('end',()=>{probe.stdoutEOF=true;});child.stderr.on('end',()=>{probe.stderrEOF=true;});
 child.on('error',error=>{probe.terminal={error:error.code||'ERROR'};});child.on('close',(code,signal)=>{probe.terminal={code,signal};});
 return probe;
}
async function waitFor(probe,predicate,ms,label,afterClose=false){
 const started=Date.now();
 while(!await predicate()){
  if(probe.observationFailure)throw probe.observationFailure;
  if(Date.now()-started>=ms)throw Error(label+' timed out');
  if(probe.terminal&&!afterClose)throw Error(label+' observed early terminal');
  await new Promise(resolve=>setTimeout(resolve,25));
 }
 if(probe.observationFailure)throw probe.observationFailure;
}
async function readyProbe(probe,visible=false){
 const {events}=probe;
 await waitFor(probe,()=>events.some(row=>row.phase==='ready')&&(!visible||events.some(row=>row.phase==='window-shown')),50000,'production ready');
 const registered=events.find(row=>row.phase==='registered');
 assert.ok(Number.isSafeInteger(registered?.pid)&&registered.pid>0&&registered.role==='serve'&&/^\d+$/.test(registered.created),'registered process has a kernel-bound creation identity');
 const assigned=events.findIndex(row=>row.phase==='assigned-before-resume');
 assert.ok(assigned>=0&&assigned<events.findIndex(row=>row.phase==='resumed'),'actual Job assignment precedes production execution');
 assert.ok(['created-suspended','assigned-before-resume','resumed'].every(phase=>events.some(row=>row.phase===phase&&sameProcess(row,registered))),
  'create, assignment, resume and private registration bind the same actual kernel process');
 return {registered,url:events.find(row=>row.phase==='ready').url};
}
function receipt(probe){
 const {terminal,stdoutEOF,stderrEOF,pending,stderr}=probe;
 return {terminal,stdoutEOF,stderrEOF,pendingBytes:Buffer.byteLength(pending),stderrBytes:Buffer.byteLength(stderr)};
}
function assertRunning(probe){
 const {child,events,terminal,observationFailure}=probe;
 if(observationFailure)throw observationFailure;
 assert.ok(!terminal&&child.exitCode===null&&child.signalCode===null&&!events.some(uncertain),'original fixture lifetime is still active');
}
function closeProbe(probe,abrupt){
 const {child}=probe;
 if(abrupt){
  assertRunning(probe);
  assert.ok(child.kill(),'terminate the original fixture owner');
 }else child.stdin.end('close\n');
 return waitFor(probe,()=>probe.terminal!==null,70000,abrupt?'owner exit':'normal close');
}
function assertClosed(probe,role,abrupt){
 const {events,terminal,stdoutEOF,stderrEOF,pending}=probe;
 assert.ok(stdoutEOF&&stderrEOF&&pending==='','probe streams reach both observed EOFs with complete frames');
 if(abrupt){
  assert.deepEqual(terminal,{code:null,signal:'SIGTERM'},'the original fixture owner was terminated');
  return;
 }
 assert.deepEqual(terminal,{code:0,signal:null},'probe naturally exits zero');
 assert.ok(['finished','channel-closed','exited'].every(phase=>events.some(row=>row.phase===phase&&sameProcess(row,role))),
  'normal close includes ACK, actual role exit and private channel close');
 assert.ok(['stdout-closed','stderr-closed','normal-closed','job-closed','probe-complete'].every(phase=>events.some(row=>row.phase===phase)),
  'original production streams end and the Job closes after the normal-close proof');
 assert.ok(!events.some(uncertain),'no uncertainty or retained role is reclassified as success');
}
async function exitedProcesses(probe,originals){
 let remaining;
 await waitFor(probe,async()=>{
  const rows=await processRows(originals.map(row=>row.pid));
  remaining=originals.filter(original=>rows.some(row=>sameProcess(row,original)));
  return !remaining.length;
 },15000,'owned serve and semantic worker exit',true);
 return remaining;
}
function assertOuterJob(probe,denied){
 const event=phase=>probe.events.find(row=>row.phase===phase);
 const owner=event('outer-owner'),created=event('created-suspended'),held=event('outer-serve'),drained=event('outer-drained');
 assert.ok(owner?.pid===probe.child.pid&&owner.member&&owner.processLimit===(denied?1:0),'the console owner enters the requested outer Job');
 assert.equal(drained?.active,1,'only the fixture owner remains before closing the outer handle');
 if(denied){
  assert.ok(!created&&!held&&drained.total===1&&drained.pid===0&&drained.code===null,'no service handle was returned by CreateProcess');
  return;
 }
 assert.ok(created&&held?.member&&sameProcess(held,created),'the original suspended serve inherited the outer Job');
 assert.ok(sameProcess(drained,held)&&drained.code===0&&drained.total>=2,'held original serve exited normally');
}
async function main(){
 const dir=fs.mkdtempSync(p.join(os.tmpdir(),'ruyi-desktop-lifetime-'));
 const scene=prepareScene(dir),{data,env,actorFile}=scene;
 const exe=p.join(dir,'desktop-lifetime-probe.exe'),csc=p.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 let primary,peer,chatClosed=false;
 const checkpoint=(name,value)=>fs.writeFileSync(p.join(dir,name+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 try{
  let model,profile,profileEnv;
  if(semantic){
   const configured=process.env.RUYI_TEST_GEMMA2_ROOT;
   if(!configured||!p.isAbsolute(configured))throw Error('RUYI_TEST_GEMMA2_ROOT must name the absolute verified profile directory');
   const lock=fs.readFileSync(p.join(configured,'asset-lock.json'));
   model=JSON.parse(lock);profile=p.join(dir,'semantic-profile');fs.mkdirSync(profile);
   fs.writeFileSync(p.join(profile,'asset-lock.json'),lock,{flag:'wx'});
   profileEnv={RUYI_DISABLE_SEMANTIC:'0',RUYI_SEMANTIC_BACKEND:'gemma2',RUYI_SEMANTIC_GEMMA2_ROOT:profile,
    RUYI_SEMANTIC_GEMMA2_LOCK_SHA256:createHash('sha256').update(lock).digest('hex')};
   Object.assign(env,profileEnv);
  }
  cp.execFileSync(csc,['/nologo','/target:exe','/platform:x64','/codepage:65001','/main:RuyiDesktop.'+(innerQuota?'DesktopInnerQuotaProbe':'DesktopLifetimeProbe'),'/out:'+exe,
   '/r:System.dll','/r:System.Core.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',
   p.join(wb,'desktop/RuyiDesktop.cs'),p.join(wb,'desktop/DesktopLifetimeHost.cs'),p.join(__dirname,'fixtures/desktop-lifetime-probe.cs'),p.join(__dirname,'fixtures/desktop-nested-job.cs'),
   ...(innerQuota?[p.join(__dirname,'fixtures/desktop-inner-quota.cs')]:[])],{windowsHide:true,timeout:30000,stdio:'pipe'});
  if(windowMode)fs.copyFileSync(p.join(wb,'desktop/WebView2Loader.dll'),p.join(dir,'WebView2Loader.dll'));
  const mode=windowMode?'window':outerQuota?'outer-quota':nestedJob?'nested-job':undefined;
  if(innerQuota){
   const app=p.join(dir,'app'),entered=p.join(dir,'server-entry-started');
   fs.mkdirSync(app);
   fs.writeFileSync(p.join(app,'server.js'),"require('node:fs').writeFileSync("+JSON.stringify(entered)+", 'entered');\n");
   primary=startProbe(exe,scene,undefined,dir);
   await waitFor(primary,()=>primary.terminal||primary.events.some(row=>row.phase==='retained'),30000,'inner Job refusal',true);
   checkpoint('events',primary.events);checkpoint('terminal',receipt(primary));
   assert.deepEqual(primary.terminal,{code:0,signal:null});
   assert.ok(primary.stdoutEOF&&primary.stderrEOF&&!primary.pending,'complete probe output');
   const rows=primary.events;
   assert.deepEqual(rows.map(row=>row.phase),['quota-occupied','created-suspended','original-held','assign-process-failed',
    'startup-cleaned','startup-error','original-exited','seat-exited','job-closed']);
   const [seat,created,held,denied,cleaned,error,exited,seatExited]=rows;
   assert.ok(seat.pid>0&&/^\d+$/.test(seat.created)&&seat.processLimit===1&&seat.member===true);
   assert.ok(created.pid>0&&created.pid!==seat.pid&&/^\d+$/.test(created.created)&&created.role==='serve');
   assert.ok([held,denied,cleaned,exited].every(row=>sameProcess(row,created)),'the same held kernel identity was denied and reaped');
   assert.ok(held.assigned===false&&held.threads===1&&held.wait==='Suspended','original primary thread was suspended before assignment');
   assert.equal(error.nativeCode,1816,'Win32 ERROR_NOT_ENOUGH_QUOTA');
   assert.ok(Number.isInteger(exited.code)&&sameProcess(seatExited,seat)&&seatExited.code===0,'held child exited and original seat drained');
   const files={privateEntryExecuted:fs.existsSync(entered),runtimePublished:fs.existsSync(p.join(data,'runtime.json'))};
   checkpoint('private-entry',files);
   assert.deepEqual(files,{privateEntryExecuted:false,runtimePublished:false},'private entry and service publication evidence');
   runner.ok(true,'full inner Job rejects the suspended child at assignment; the original handles prove both exits');
   return;
  }
  primary=startProbe(exe,scene,mode);
  const {child,events}=primary;
  if(outerQuota){
   await waitFor(primary,()=>primary.terminal||events.some(row=>row.phase==='ready'),65000,'restricted Job startup',true);
   if(!primary.terminal)await closeProbe(primary,false);
   checkpoint('events',events);checkpoint('terminal',receipt(primary));
   assert.deepEqual(primary.terminal,{code:0,signal:null});
   assert.ok(primary.stdoutEOF&&primary.stderrEOF&&!primary.pending,'complete probe output');
   assertOuterJob(primary,true);
   const creationFailure=events.findIndex(row=>row.phase==='create-process-failed');
   const quotaError=events.findIndex(row=>row.phase==='startup-denied'&&row.nativeCode===1816);
   assert.ok(creationFailure>=0&&quotaError>creationFailure,'CreateProcess failed before the host returned Win32 not enough quota');
   assert.ok(!events.some(row=>['assigned-before-resume','resumed','registered','ready'].includes(row.phase)||uncertain(row)),'no assignment, resume, fallback readiness or retained startup');
   assert.ok(events.some(row=>row.phase==='job-closed'),'the product closed its empty Job');
   assert.ok(!fs.existsSync(p.join(data,'runtime.json')),'the service never published a runtime');
   runner.ok(true,'outer Job process quota refuses serve creation; no service starts and only the original owner remains');
   return;
  }
  const {registered,url}=await readyProbe(primary,windowMode);
  runner.ok(true,'actual serve is assigned to its Job before resume and registered with the same kernel identity');
  let originals,initial,second,closingRole=registered,exportOutcome;
  const residentHomes=()=>fs.readdirSync(p.join(profile,'resident-homes'));
  async function observeModel(probe,url,role,parentPid,{otherHomes=[],waitForWarmup=true}={}){
   assert.ok(Number.isSafeInteger(role?.pid)&&role.pid>0&&/^\d+$/.test(role.created),'registered model host identity missing');
   const runtime=JSON.parse(fs.readFileSync(p.join(probe.data,'runtime.json'),'utf8'));
   assert.equal(runtime.pid,role.pid,'runtime belongs to the registered role');
   assert.equal(runtime.port,Number(new URL(url).port),'runtime uses the published port');
   const warmupMs=30000,deadline=Date.now()+warmupMs;
   const ready=async()=>{
    const timeoutMs=waitForWarmup?deadline-Date.now():undefined;
    if(waitForWarmup&&timeoutMs<=0)return false;
    const response=await requestJson(url,runtime.token,'/api/status',undefined,timeoutMs);
    assert.equal(response.status,200,'semantic status HTTP');
    const status=response.value.semanticRuntime;
    if(status?.state!=='loading'&&status?.state!=='ready')throw Error('semantic runtime '+JSON.stringify(status));
    return status.state==='ready'&&(!waitForWarmup||Date.now()<=deadline);
   };
   if(waitForWarmup)await waitFor(probe,ready,warmupMs,'real semantic startup warmup');
   else assert.ok(await ready(),'peer is ready on the first status sample after the other owner exits');
   const commandLine=fixedSpawnCommandLine(model.node.file,[model.workerFile]).toLowerCase();
   const rows=await processRows([role.pid],role.pid);
   const serve=rows.find(row=>row.pid===role.pid);
   const workers=rows.filter(row=>row.parent===role.pid&&row.image?.toLowerCase()===model.node.file.toLowerCase()
    &&row.commandLine?.toLowerCase()===commandLine);
   if(workers.length!==1||serve?.nativeCreated!==role.created||serve.parent!==parentPid
    ||![serve,...workers].every(row=>/^\d+$/.test(row.created)))throw Error('owned serve and real worker identity missing');
   const homes=residentHomes().filter(home=>!otherHomes.includes(home));
   assert.equal(homes.length,1,'expected one private semantic resident home for the registered model host');
   return {runtime,home:homes[0],identities:[serve,...workers].map(processIdentity)};
  }
  if(semantic){
   initial=await observeModel(primary,url,registered,child.pid);
   originals=initial.identities;
   checkpoint('semantic-before',{state:'ready',ownerPid:child.pid,serve:originals[0],serveNativeCreated:registered.created,worker:originals[1],homeCount:1});
   runner.ok(true,'startup warms one real Gemma 2 worker bound to the actual serve process');
   if(dual){
    const peerDir=p.join(dir,'peer');
    fs.mkdirSync(peerDir);
    const peerScene=prepareScene(peerDir);
    Object.assign(peerScene.env,profileEnv);
    peer=startProbe(exe,peerScene);
    const {registered:peerRole,url:peerUrl}=await readyProbe(peer);
    const peerModel=await observeModel(peer,peerUrl,peerRole,peer.child.pid,{otherHomes:[initial.home]});
    second={...peerModel,role:peerRole,url:peerUrl};
    assert.notEqual(second.runtime.port,initial.runtime.port,'both servers listen on different ports');
    assert.ok(second.runtime.token!==initial.runtime.token,'both servers use separate runtime tokens');
    assert.ok(residentHomes().includes(initial.home),'the first model home is still present after the peer starts');
    const identities=[...originals,...second.identities];
    const rows=await processRows(identities.map(row=>row.pid));
    assert.equal(new Set(identities.map(row=>row.pid)).size,4,'both servers have distinct process trees');
    assert.ok(identities.every(identity=>rows.some(row=>sameProcess(row,identity))),'both original servers and workers are alive together');
    const firstStatus=await requestJson(url,initial.runtime.token,'/api/status');
    assert.equal(firstStatus.status,200,'first model status while both servers are running');
    assert.equal(firstStatus.value.semanticRuntime?.state,'ready','first model is still ready');
    checkpoint('dual-before',{
     first:{ownerPid:child.pid,port:initial.runtime.port,identities:originals},
     second:{ownerPid:peer.child.pid,port:second.runtime.port,identities:second.identities},
     homeCount:2
    });
    runner.ok(true,'two ServerHost owners have registered separate Jobs, listeners and ready Gemma 2 workers on the same profile');
   }
   if(handoff){
    const backups=p.join(dir,'backups');
    fs.mkdirSync(backups);
    const status=await requestJson(url,initial.runtime.token,'/api/work-data/status');
    assert.equal(status.status,200,'initial maintenance status');
    assert.equal(status.value.capabilities?.worker,true,'real maintenance worker available');
    assert.equal(status.value.job,null,'no existing maintenance job');
    const submit=await requestJson(url,initial.runtime.token,'/api/work-data/jobs',{
     operation:'export',password:'synthetic SR6 export password',backupDirectory:backups,expectedAuthority:status.value.authority
    });
    assert.equal(submit.status,202,'export request: '+(submit.value.error?.code||'accepted'));
    const id=submit.value.job?.id;
    assert.match(id||'',/^[a-f0-9]{48}$/,'accepted export job identity');
    checkpoint('handoff-accepted',{id,operation:'export',port:initial.runtime.port,authority:status.value.authority});

    let successorUrl;
    await waitFor(primary,()=>{
     if(events.some(uncertain))throw Error('desktop host reported uncertainty during maintenance handoff');
     successorUrl=events.filter(row=>row.phase==='ready')[1]?.url;
     return Boolean(successorUrl);
    },140000,'maintenance successor ready');
    assert.equal(successorUrl,url,'successor publishes the exact original listener');
    const transfers=events.filter(row=>row.phase==='transferred');
    assert.deepEqual(transfers.map(row=>row.role),['cold','successor'],'serve transfers through cold to successor');
    const [cold,successor]=transfers;
    for(const role of transfers)assert.ok(events.some(row=>row.phase==='registered'&&row.role===role.role&&sameProcess(row,role)),
     role.role+' is registered in the same Job');
    await waitFor(primary,()=>[registered,cold].every(role=>['exited','channel-closed'].every(phase=>
     events.some(row=>row.phase===phase&&row.role===role.role&&sameProcess(row,role)))),15000,'original serve and cold role exit');
    const previousRows=await processRows(originals.map(row=>row.pid));
    const remaining=originals.filter(original=>previousRows.some(row=>sameProcess(row,original)));
    const oldHomeRemoved=!residentHomes().includes(initial.home);
    checkpoint('handoff-retired',{oldProcesses:originals,remaining,oldHomeRemoved,cold,successor});
    assert.equal(remaining.length,0,'old serve and model are gone before closing the successor');
    assert.ok(oldHomeRemoved,'old resident home is gone before closing the successor');
    const next=await observeModel(primary,successorUrl,successor,cold.pid);
    assert.ok(next.runtime.token!==initial.runtime.token,'successor uses a fresh runtime token');
    assert.ok(next.identities.every(identity=>!originals.some(original=>sameProcess(identity,original))),'successor serve and worker have new identities');
    const completed=await requestJson(successorUrl,next.runtime.token,'/api/work-data/status');
    assert.equal(completed.status,200,'successor maintenance status');
    assert.deepEqual(completed.value.authority,status.value.authority,'export retains the original authority');
    assert.equal(completed.value.job,null,'successor does not retain the warm job');
    let result;
    if(completed.value.lastResult){
     const {id:resultId,operation,state,backupState}=completed.value.lastResult;
     assert.deepEqual([resultId,operation,state,backupState],[id,'export','verified','present'],'successor reports this verified export');
     result={operation,state,backupState};
     if(requireExport){
      const {verifyExportPackage}=require('./lib/desktop-handoff-export.cjs');
      result.package=await verifyExportPackage({url:successorUrl,token:next.runtime.token,id,backups,data,
       sourceAuthority:status.value.authority,record:completed.value.lastResult});
     }
    }else{
     // The production recovery successor also proves the original root and
     // advertises the failed job by ID. Preserve the export failure separately.
     const recovered=await requestJson(successorUrl,next.runtime.token,'/api/work-data/jobs/'+id);
     assert.equal(recovered.status,200,'successor reports the export outcome');
     const {id:resultId,operation,state,recovered:isRecovered,operationMayHaveExecuted,error,reason}=recovered.value.job;
     assert.deepEqual([resultId,operation,state,isRecovered,operationMayHaveExecuted],[id,'export','failed',true,false],'successor reports this recovered export failure');
     result={operation,state,error,reason,recovered:isRecovered,operationMayHaveExecuted};
     console.log('Export recovered after '+error+' ('+reason+')');
    }
    exportOutcome=result;
    checkpoint('handoff-complete',{id,port:next.runtime.port,cold,successor,newProcesses:next.identities,result});
    runner.ok(true,'production maintenance transfers serve to cold and successor in the original Job and reports the submitted job outcome');
    runner.ok(true,'old model and resident home are gone while the same-port successor has a new ready model');
    originals=next.identities;
    closingRole=successor;
   }
  }
  if(!idle){
   const runtime=JSON.parse(fs.readFileSync(p.join(data,'runtime.json'),'utf8')),address=new URL(url),body=Buffer.from(JSON.stringify({message:'Synthetic lifetime stop; no external provider.',cwd:dir}));
   const chat=http.request({hostname:address.hostname,port:address.port,path:'/api/chat/stream',method:'POST',agent:false,headers:{host:address.host,'content-type':'application/json','content-length':body.length,'x-wcw-token':runtime.token}},response=>response.resume());
   chat.on('error',()=>{});chat.once('close',()=>{chatClosed=true;});chat.end(body);await waitFor(primary,()=>fs.existsSync(actorFile),30000,'synthetic CLI start');
   const actor=JSON.parse(fs.readFileSync(actorFile,'utf8'));runner.ok(actor.pid>0&&actor.parentPid===registered.pid&&!actor.capEnvPresent,'the actual synthetic CLI starts under this serve without inheriting the desktop capability');
  }
  if(holdUI){
   console.log('Manual Privacy/maintenance GUI entry: '+dir);console.log('Create '+p.join(dir,'close-ui')+' only after the GUI journey is recorded.');
   await waitFor(primary,()=>fs.existsSync(p.join(dir,'close-ui')),900000,'manual GUI close gate');
  }
  if(peer)assertRunning(peer);
  await closeProbe(primary,ownerExit);
  checkpoint('events',events);checkpoint('terminal',{...receipt(primary),chatClosed,mode:windowMode?'window':'host'});
  assertClosed(primary,closingRole,ownerExit);
  if(nestedJob){
   assertOuterJob(primary,false);
   runner.ok(true,'the real serve belongs to both Jobs, closes normally and leaves only the fixture owner in the outer Job');
  }
  runner.ok(true,ownerExit?'the original fixture owner was terminated and both streams reached EOF':'probe closes after ACK, stream EOF and Job drain');
  if(!idle)runner.ok(chatClosed,'no synthetic chat connection remains open');
  if(originals){
   const remaining=await exitedProcesses(primary,originals);
   const homeCount=residentHomes().length;
   checkpoint('semantic-after',{mode:ownerExit?'owner-exit':handoff?'handoff':'normal',originals,remaining,homeCount});
   runner.ok(true,'Windows no longer observes either closing serve or semantic worker identity');
   if(!ownerExit&&!dual)runner.ok(homeCount===0,'normal close removes this worker’s private resident home');
  }
  if(dual){
   const firstHomePresent=residentHomes().includes(initial.home);
   if(!ownerExit)assert.ok(!firstHomePresent,'normal close removes only the first model home');
   const residue=firstHomePresent?[initial.home]:[];
   const after=await observeModel(peer,second.url,second.role,peer.child.pid,{otherHomes:residue,waitForWarmup:false});
   assert.deepEqual(after.identities,second.identities,'peer keeps both original process identities');
   assert.ok(after.runtime.token===second.runtime.token,'peer keeps the original listener token');
   assert.equal(after.home,second.home,'peer keeps its original resident home');
   checkpoint('dual-peer-survives',{state:'ready',port:after.runtime.port,identities:after.identities,
    firstHomePresent,peerHomeUnchanged:true,firstExit:ownerExit?'owner-exit':'normal'});
   runner.ok(true,'closing the first owner leaves the second listener, original worker and resident home ready');

   await closeProbe(peer,false);
   checkpoint('peer-events',peer.events);checkpoint('peer-terminal',receipt(peer));
   assertClosed(peer,second.role,false);
   const remaining=await exitedProcesses(peer,second.identities);
   assert.deepEqual(residentHomes(),residue,'peer close removes only its own model home');
   checkpoint('dual-complete',{remaining,homeCount:residue.length});
   runner.ok(true,'the second owner independently drains its Job and removes its own model home');
  }
  if(requireExport){
   assert.equal(exportOutcome?.state,'verified','a verified export is required; successor reported '+JSON.stringify(exportOutcome));
   runner.ok(true,'verified export, durable record and downloaded package agree for this job after the host has closed');
  }
 }catch(error){
  runner.fail(error.stack||String(error));
  checkpoint('failure',{message:String(error.message),events:primary?.events,...(primary&&receipt(primary)),
   ...(peer&&{peer:{events:peer.events,...receipt(peer)}})});
  for(const probe of [primary,peer]){
   if(probe&&!probe.terminal){const {child}=probe;child.unref();for(const stream of [child.stdin,child.stdout,child.stderr])stream?.unref?.();}
  }
 }finally{console.log('Desktop lifetime evidence: '+dir);runner.done();}
}
