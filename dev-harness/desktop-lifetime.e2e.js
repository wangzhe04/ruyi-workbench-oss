'use strict';
// Actual Windows production ServerHost + generated serve + its inherited Job.
// Default starts one synthetic active CLI, then closes through the private protocol.
// --idle omits that CLI. --window also exercises the actual ShellForm.Close path;
// it does not claim a mouse/titlebar, Privacy GUI or maintenance-operation journey.
// --idle --semantic verifies an explicitly selected local EmbeddingGemma 2.
// --owner-exit tests abrupt termination of this fixture's console owner.
// On any unknown/failure the detached owner and its scene are retained, never killed.
require('./lib/self-isolate-home.js');
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http');
const execFile=require('node:util').promisify(cp.execFile);
const {createRunner}=require('./lib/harness.js');
const {fixtureChildEnv}=require('./lib/fixture-home.js');
const {fixedSpawnCommandLine}=require('./lib/work-data-production-upload-process.js');
const runner=createRunner('DESKTOP LIFETIME'),root=p.resolve(__dirname,'..'),wb=p.join(root,'ruyi-workbench');
const args=process.argv.slice(2),flags=new Set(args);
const windowMode=flags.has('--window'),idle=flags.has('--idle'),holdUI=flags.has('--hold-ui'),semantic=flags.has('--semantic'),ownerExit=flags.has('--owner-exit');
if(flags.size!==args.length||args.some(value=>!['--window','--idle','--hold-ui','--semantic','--owner-exit'].includes(value))
 ||holdUI&&!windowMode||semantic&&(!idle||windowMode)||ownerExit&&!semantic)throw Error('Use --idle --semantic [--owner-exit], --idle, --window, or --window --hold-ui');
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
function getStatus(url,token){
 return new Promise((resolve,reject)=>{
  const request=http.get(new URL('/api/status',url),{agent:false,headers:{'x-wcw-token':token}},response=>{
   let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});
   response.once('end',()=>{try{if(response.statusCode!==200)throw Error('status HTTP '+response.statusCode);resolve(JSON.parse(body).semanticRuntime);}catch(error){reject(error);}});
   response.once('error',reject);
  });
  request.once('error',reject);request.setTimeout(5000,()=>request.destroy(Error('status timeout')));
 });
}
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
    RUYI_SEMANTIC_GEMMA2_LOCK_SHA256:require('node:crypto').createHash('sha256').update(lock).digest('hex')});
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
  let originals;
  const residentHomes=()=>fs.readdirSync(p.join(profile,'resident-homes'));
  if(semantic){
   if(!assignedBeforeResume||!sameJobIdentity)throw Error('original serve Job identity missing');
   const runtime=JSON.parse(fs.readFileSync(p.join(data,'runtime.json'),'utf8')),url=events.find(row=>row.phase==='ready').url;
   await wait(async()=>{
    const status=await getStatus(url,runtime.token);
    if(status?.state!=='loading'&&status?.state!=='ready')throw Error('semantic runtime '+JSON.stringify(status));
    return status.state==='ready';
   },30000,'real semantic startup warmup');
   const commandLine=fixedSpawnCommandLine(model.node.file,[model.workerFile]).toLowerCase();
   const rows=await processRows([registered.pid],registered.pid);
   const serve=rows.find(row=>row.pid===registered.pid);
   const workers=rows.filter(row=>row.parent===registered.pid&&row.image?.toLowerCase()===model.node.file.toLowerCase()
    &&row.commandLine?.toLowerCase()===commandLine);
   if(workers.length!==1||serve?.nativeCreated!==registered.created||serve.parent!==child.pid
    ||![serve,...workers].every(row=>/^\d+$/.test(row.created)))throw Error('owned serve and real worker identity missing');
   const homeCount=residentHomes().length;
   if(homeCount!==1)throw Error('expected one private semantic resident home');
   originals=[serve,...workers].map(({pid,parent,created,image})=>({pid,parent,created,image}));
   checkpoint('semantic-before',{state:'ready',ownerPid:child.pid,serve:originals[0],serveNativeCreated:serve.nativeCreated,worker:originals[1],homeCount});
   runner.ok(true,'startup warms one real Gemma 2 worker bound to the actual serve process');
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
    ||events.some(row=>['uncertain','retained','unexpected-exit'].includes(row.phase)))throw Error('original fixture lifetime lost before owner exit');
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
   checkpoint('semantic-after',{mode:ownerExit?'owner-exit':'normal',originals,remaining,homeCount});
   runner.ok(true,'Windows no longer observes either original serve or semantic worker identity');
   if(!ownerExit)runner.ok(homeCount===0,'normal close removes this worker’s private resident home');
  }
  checkpoint('events',events);checkpoint('terminal',{terminal,stdoutEOF,stderrEOF,chatClosed,pendingBytes:Buffer.byteLength(pending),stderrBytes:Buffer.byteLength(stderr),mode:windowMode?'window':'host'});
  if(ownerExit){runner.ok(terminal.code===null&&terminal.signal==='SIGTERM'&&stdoutEOF&&stderrEOF&&pending==='','the original fixture owner was terminated and both streams reached EOF');return;}
  runner.ok(terminal.code===0&&terminal.signal===null&&stdoutEOF&&stderrEOF&&pending==='','probe naturally exits zero with both observed EOFs');
  runner.ok(idle||chatClosed,'the owned synthetic chat connection has actually closed');
  runner.ok(events.some(row=>row.phase==='finished')&&events.some(row=>row.phase==='channel-closed')&&events.some(row=>row.phase==='exited'),'normal close includes ACK, actual role exit and private channel close');
  runner.ok(events.some(row=>row.phase==='stdout-closed')&&events.some(row=>row.phase==='stderr-closed'),'original production stdout and stderr reach their terminal boundary');
  runner.ok(events.some(row=>row.phase==='normal-closed')&&events.some(row=>row.phase==='job-closed')&&events.some(row=>row.phase==='probe-complete'),'Job closes only after the normal-close proof');
  runner.ok(!events.some(row=>row.phase==='uncertain'||row.phase==='retained'||row.phase==='unexpected-exit'),'no uncertainty or retained role is reclassified as success');
 }catch(error){runner.fail(error.stack||String(error));checkpoint('failure',{message:String(error.message),events,terminal,stdoutEOF,stderrEOF,pendingBytes:Buffer.byteLength(pending),stderrBytes:Buffer.byteLength(stderr)});
  if(child&&!terminal){child.unref();for(const stream of [child.stdin,child.stdout,child.stderr])stream?.unref?.();}
 }finally{console.log('Desktop lifetime evidence: '+dir);runner.done();}
}
