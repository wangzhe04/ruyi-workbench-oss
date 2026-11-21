'use strict';
// Actual Windows production ServerHost + generated serve + its inherited Job.
// Default starts one synthetic active CLI, then closes through the private protocol.
// --idle omits that CLI. --window also exercises the actual ShellForm.Close path;
// That path does not claim a mouse/titlebar or Privacy GUI journey.
// --idle --semantic verifies an explicitly selected local EmbeddingGemma 2.
// --owner-exit tests abrupt termination of this fixture's console owner.
// --handoff requests a real export through the production maintenance API.
// On any unknown/failure the detached owner and its scene are retained, never killed.
require('./lib/self-isolate-home.js');
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const execFile=require('node:util').promisify(cp.execFile);
const {createRunner}=require('./lib/harness.js');
const {fixtureChildEnv}=require('./lib/fixture-home.js');
const {fixedSpawnCommandLine}=require('./lib/work-data-production-upload-process.js');
const runner=createRunner('DESKTOP LIFETIME'),root=p.resolve(__dirname,'..'),wb=p.join(root,'ruyi-workbench');
const args=process.argv.slice(2),flags=new Set(args);
const windowMode=flags.has('--window'),idle=flags.has('--idle'),holdUI=flags.has('--hold-ui'),semantic=flags.has('--semantic');
const ownerExit=flags.has('--owner-exit'),handoff=flags.has('--handoff');
if(flags.size!==args.length||args.some(value=>!['--window','--idle','--hold-ui','--semantic','--owner-exit','--handoff'].includes(value))
 ||holdUI&&!windowMode||semantic&&(!idle||windowMode)||(ownerExit||handoff)&&!semantic||ownerExit&&handoff)throw Error('Use --idle --semantic [--owner-exit | --handoff], --idle, --window, or --window --hold-ui');
if(process.platform!=='win32'){console.log('SKIP DESKTOP LIFETIME: Windows Job/Framework required');process.exitCode=0;}
else void main();
async function processRows(pids,childrenOf){
 const filters=pids.map(pid=>'ProcessId='+pid);
 if(childrenOf)filters.push('ParentProcessId='+childrenOf);
 const command=[
  "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$rows=@(Get-CimInstance Win32_Process -Filter '"+filters.join(' OR ')+"' | ForEach-Object {",
  " $row=@{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$_.CreationDate.ToFileTimeUtc().ToString()}",
  ...(childrenOf?[
   " $row.image=$_.ExecutablePath; $row.commandLine=$_.CommandLine",
   " if($row.pid -eq "+childrenOf+") { $row.nativeCreated=(Get-Process -Id $row.pid).StartTime.ToFileTimeUtc().ToString() }"
  ]:[]),
  " $row", "}); ConvertTo-Json -InputObject $rows -Compress"
 ].join('\n');
 const powershell=p.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 const result=await execFile(powershell,['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,encoding:'utf8'});
 return JSON.parse(result.stdout);
}
function requestJson(url,token,route,input){
 return new Promise((resolve,reject)=>{
  const headers={'x-wcw-token':token};
  const bytes=input===undefined?null:Buffer.from(JSON.stringify(input));
  if(bytes)Object.assign(headers,{'content-type':'application/json','content-length':bytes.length,origin:new URL(url).origin});
  const request=http.request(new URL(route,url),{method:bytes?'POST':'GET',agent:false,headers},response=>{
   let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});
   response.once('end',()=>{try{resolve({status:response.statusCode,value:JSON.parse(body)});}catch(error){reject(error);}});
   response.once('error',reject);
  });
  request.once('error',reject);request.setTimeout(5000,()=>request.destroy(Error(route+' timeout')));
  request.end(bytes);
 });
}
const sameProcess=(row,identity)=>row.pid===identity.pid&&row.created===identity.created;
const processIdentity=({pid,parent,created,image})=>({pid,parent,created,image});
const uncertain=row=>['uncertain','retained','unexpected-exit'].includes(row.phase);
async function main(){
 const dir=fs.mkdtempSync(p.join(os.tmpdir(),'ruyi-desktop-lifetime-')),data=p.join(dir,'data'),temp=p.join(dir,'temp');
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
 const exe=p.join(dir,'desktop-lifetime-probe.exe'),csc=p.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 let child,chat,chatClosed=false,terminal=null,stderr='',pending='',stdoutEOF=false,stderrEOF=false,observationFailure=null;const events=[];
 const checkpoint=(name,value)=>fs.writeFileSync(p.join(dir,name+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 const wait=async(predicate,ms,label,afterClose=false)=>{const started=Date.now();while(!await predicate()){if(observationFailure)throw observationFailure;if(Date.now()-started>=ms)throw Error(label+' timed out');if(terminal&&!afterClose)throw Error(label+' observed early terminal');await new Promise(resolve=>setTimeout(resolve,25));}if(observationFailure)throw observationFailure;};
 try{
  let model,profile;
  if(semantic){
   const configured=process.env.RUYI_TEST_GEMMA2_ROOT;
   if(!configured||!p.isAbsolute(configured))throw Error('RUYI_TEST_GEMMA2_ROOT must name the absolute verified profile directory');
   const lock=fs.readFileSync(p.join(configured,'asset-lock.json'));
   model=JSON.parse(lock);profile=p.join(dir,'semantic-profile');fs.mkdirSync(profile);
   fs.writeFileSync(p.join(profile,'asset-lock.json'),lock,{flag:'wx'});
   Object.assign(env,{RUYI_DISABLE_SEMANTIC:'0',RUYI_SEMANTIC_BACKEND:'gemma2',RUYI_SEMANTIC_GEMMA2_ROOT:profile,
    RUYI_SEMANTIC_GEMMA2_LOCK_SHA256:createHash('sha256').update(lock).digest('hex')});
  }
  cp.execFileSync(csc,['/nologo','/target:exe','/platform:x64','/codepage:65001','/main:RuyiDesktop.DesktopLifetimeProbe','/out:'+exe,
   '/r:System.dll','/r:System.Core.dll','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',
   p.join(wb,'desktop/RuyiDesktop.cs'),p.join(wb,'desktop/DesktopLifetimeHost.cs'),p.join(__dirname,'fixtures/desktop-lifetime-probe.cs')],{windowsHide:true,timeout:30000,stdio:'pipe'});
  if(windowMode)fs.copyFileSync(p.join(wb,'desktop/WebView2Loader.dll'),p.join(dir,'WebView2Loader.dll'));
  child=cp.spawn(exe,[wb,...(windowMode?['window']:[])],{env,cwd:wb,windowsHide:!windowMode,detached:true,stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{try{pending+=chunk;if(pending.length>65536)throw Error('acceptance frame budget');let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at).replace(/\r$/,'');pending=pending.slice(at+1);events.push(JSON.parse(line));}}catch(error){observationFailure=error;}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});child.stdout.on('end',()=>{stdoutEOF=true;});child.stderr.on('end',()=>{stderrEOF=true;});
  child.on('error',error=>{terminal={error:error.code||'ERROR'};});child.on('close',(code,signal)=>{terminal={code,signal};});
  await wait(()=>events.some(row=>row.phase==='ready')&&(!windowMode||events.some(row=>row.phase==='window-shown')),50000,'production ready');
  const registered=events.find(row=>row.phase==='registered');
  const registeredServe=Number.isSafeInteger(registered?.pid)&&registered.pid>0&&registered.role==='serve'&&/^\d+$/.test(registered.created);
  const assigned=events.findIndex(row=>row.phase==='assigned-before-resume');
  const assignedBeforeResume=assigned>=0&&assigned<events.findIndex(row=>row.phase==='resumed');
  const sameJobIdentity=registeredServe&&['created-suspended','assigned-before-resume','resumed'].every(phase=>
   events.some(row=>row.phase===phase&&row.pid===registered.pid&&row.created===registered.created));
  runner.ok(assignedBeforeResume,'actual Job assignment precedes production execution');
  runner.ok(registeredServe,'registered process has a kernel-bound creation identity');
  runner.ok(sameJobIdentity,'create, assignment, resume and private registration bind the same actual kernel process');
  let originals,closingRole=registered;
  const residentHomes=()=>fs.readdirSync(p.join(profile,'resident-homes'));
  async function warmModel(url,role,parentPid){
   assert.ok(Number.isSafeInteger(role?.pid)&&role.pid>0&&/^\d+$/.test(role.created),'registered model host identity missing');
   const runtime=JSON.parse(fs.readFileSync(p.join(data,'runtime.json'),'utf8'));
   assert.equal(runtime.pid,role.pid,'runtime belongs to the registered role');
   assert.equal(runtime.port,Number(new URL(url).port),'runtime uses the published port');
   await wait(async()=>{
    const response=await requestJson(url,runtime.token,'/api/status');
    assert.equal(response.status,200,'semantic status HTTP');
    const status=response.value.semanticRuntime;
    if(status?.state!=='loading'&&status?.state!=='ready')throw Error('semantic runtime '+JSON.stringify(status));
    return status.state==='ready';
   },30000,'real semantic startup warmup');
   const commandLine=fixedSpawnCommandLine(model.node.file,[model.workerFile]).toLowerCase();
   const rows=await processRows([role.pid],role.pid);
   const serve=rows.find(row=>row.pid===role.pid);
   const workers=rows.filter(row=>row.parent===role.pid&&row.image?.toLowerCase()===model.node.file.toLowerCase()
    &&row.commandLine?.toLowerCase()===commandLine);
   if(workers.length!==1||serve?.nativeCreated!==role.created||serve.parent!==parentPid
    ||![serve,...workers].every(row=>/^\d+$/.test(row.created)))throw Error('owned serve and real worker identity missing');
   const homes=residentHomes();
   assert.equal(homes.length,1,'expected one private semantic resident home');
   return {runtime,home:homes[0],identities:[serve,...workers].map(processIdentity)};
  }
  if(semantic){
   if(!assignedBeforeResume||!sameJobIdentity)throw Error('original serve Job identity missing');
   const url=events.find(row=>row.phase==='ready').url;
   const initial=await warmModel(url,registered,child.pid);
   originals=initial.identities;
   checkpoint('semantic-before',{state:'ready',ownerPid:child.pid,serve:originals[0],serveNativeCreated:registered.created,worker:originals[1],homeCount:1});
   runner.ok(true,'startup warms one real Gemma 2 worker bound to the actual serve process');
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
    await wait(()=>{
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
    await wait(()=>[registered,cold].every(role=>['exited','channel-closed'].every(phase=>
     events.some(row=>row.phase===phase&&row.role===role.role&&sameProcess(row,role)))),15000,'original serve and cold role exit');
    const previousRows=await processRows(originals.map(row=>row.pid));
    const remaining=originals.filter(original=>previousRows.some(row=>sameProcess(row,original)));
    const oldHomeRemoved=!residentHomes().includes(initial.home);
    checkpoint('handoff-retired',{oldProcesses:originals,remaining,oldHomeRemoved,cold,successor});
    assert.equal(remaining.length,0,'old serve and model are gone before closing the successor');
    assert.ok(oldHomeRemoved,'old resident home is gone before closing the successor');
    const next=await warmModel(successorUrl,successor,cold.pid);
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
    checkpoint('handoff-complete',{id,port:next.runtime.port,cold,successor,newProcesses:next.identities,result});
    runner.ok(true,'production maintenance transfers serve to cold and successor in the original Job and reports the submitted job outcome');
    runner.ok(true,'old model and resident home are gone while the same-port successor has a new ready model');
    originals=next.identities;
    closingRole=successor;
   }
  }
  if(!idle){
   const runtime=JSON.parse(fs.readFileSync(p.join(data,'runtime.json'),'utf8')),url=new URL(events.find(row=>row.phase==='ready').url),body=Buffer.from(JSON.stringify({message:'Synthetic lifetime stop; no external provider.',cwd:dir}));
   chat=http.request({hostname:url.hostname,port:url.port,path:'/api/chat/stream',method:'POST',agent:false,headers:{host:url.host,'content-type':'application/json','content-length':body.length,'x-wcw-token':runtime.token}},response=>response.resume());
   chat.on('error',()=>{});chat.once('close',()=>{chatClosed=true;});chat.end(body);await wait(()=>fs.existsSync(actorFile),30000,'synthetic CLI start');
   const actor=JSON.parse(fs.readFileSync(actorFile,'utf8'));runner.ok(actor.pid>0&&actor.parentPid===registered.pid&&!actor.capEnvPresent,'the actual synthetic CLI starts under this serve without inheriting the desktop capability');
  }
  if(holdUI){
   console.log('Manual Privacy/maintenance GUI entry: '+dir);console.log('Create '+p.join(dir,'close-ui')+' only after the GUI journey is recorded.');
   await wait(()=>fs.existsSync(p.join(dir,'close-ui')),900000,'manual GUI close gate');
  }
  if(ownerExit){
   if(observationFailure)throw observationFailure;
   if(terminal||child.exitCode!==null||child.signalCode!==null
    ||events.some(uncertain))throw Error('original fixture lifetime lost before owner exit');
   if(!child.kill())throw Error('could not terminate the original fixture owner');
  }else child.stdin.end('close\n');
  await wait(()=>terminal!==null,70000,ownerExit?'owner exit':'normal close');
  if(originals){
   let remaining;
   await wait(async()=>{
    const rows=await processRows(originals.map(row=>row.pid));
    remaining=originals.filter(original=>rows.some(row=>row.pid===original.pid&&row.created===original.created));
    return !remaining.length;
   },15000,'owned serve and semantic worker exit',true);
   const homeCount=residentHomes().length;
   checkpoint('semantic-after',{mode:ownerExit?'owner-exit':handoff?'handoff':'normal',originals,remaining,homeCount});
   runner.ok(true,'Windows no longer observes either closing serve or semantic worker identity');
   if(!ownerExit)runner.ok(homeCount===0,'normal close removes this worker’s private resident home');
  }
  checkpoint('events',events);checkpoint('terminal',{terminal,stdoutEOF,stderrEOF,chatClosed,pendingBytes:Buffer.byteLength(pending),stderrBytes:Buffer.byteLength(stderr),mode:windowMode?'window':'host'});
  if(ownerExit){runner.ok(terminal.code===null&&terminal.signal==='SIGTERM'&&stdoutEOF&&stderrEOF&&pending==='','the original fixture owner was terminated and both streams reached EOF');return;}
  runner.ok(terminal.code===0&&terminal.signal===null&&stdoutEOF&&stderrEOF&&pending==='','probe naturally exits zero with both observed EOFs');
  runner.ok(idle||chatClosed,'no synthetic chat connection remains open');
  runner.ok(['finished','channel-closed','exited'].every(phase=>events.some(row=>row.phase===phase&&sameProcess(row,closingRole))),'normal close includes ACK, actual role exit and private channel close');
  runner.ok(events.some(row=>row.phase==='stdout-closed')&&events.some(row=>row.phase==='stderr-closed'),'original production stdout and stderr reach their terminal boundary');
  runner.ok(events.some(row=>row.phase==='normal-closed')&&events.some(row=>row.phase==='job-closed')&&events.some(row=>row.phase==='probe-complete'),'Job closes only after the normal-close proof');
  runner.ok(!events.some(uncertain),'no uncertainty or retained role is reclassified as success');
 }catch(error){runner.fail(error.stack||String(error));checkpoint('failure',{message:String(error.message),events,terminal,stdoutEOF,stderrEOF,pendingBytes:Buffer.byteLength(pending),stderrBytes:Buffer.byteLength(stderr)});
  if(child&&!terminal){child.unref();for(const stream of [child.stdin,child.stdout,child.stderr])stream?.unref?.();}
 }finally{console.log('Desktop lifetime evidence: '+dir);runner.done();}
}
