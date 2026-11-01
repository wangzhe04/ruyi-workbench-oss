'use strict';
// Actual Windows production ServerHost + generated serve + its inherited Job.
// Default starts one synthetic active CLI, then closes through the private protocol.
// --idle omits that CLI. --window also exercises the actual ShellForm.Close path;
// it does not claim a mouse/titlebar, Privacy GUI or maintenance-operation journey.
// On any unknown/failure the detached owner and its scene are retained, never killed.
require('./lib/self-isolate-home.js');
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),cp=require('node:child_process'),http=require('node:http');
const {createRunner}=require('./lib/harness.js');
const {fixtureChildEnv}=require('./lib/fixture-home.js');
const runner=createRunner('DESKTOP LIFETIME'),root=p.resolve(__dirname,'..'),wb=p.join(root,'ruyi-workbench');
const args=process.argv.slice(2),flags=new Set(args);if(flags.size!==args.length||args.some(value=>!['--window','--idle','--hold-ui'].includes(value))||flags.has('--hold-ui')&&!flags.has('--window'))throw Error('Use --idle, --window, or --window --hold-ui');
const windowMode=flags.has('--window'),idle=flags.has('--idle'),holdUI=flags.has('--hold-ui');
if(process.platform!=='win32'){console.log('SKIP DESKTOP LIFETIME: Windows Job/Framework required');process.exitCode=0;}
else void main();
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
 const wait=async(predicate,ms,label)=>{const started=Date.now();while(!predicate()){if(observationFailure)throw observationFailure;if(Date.now()-started>=ms)throw Error(label+' timed out');if(terminal)throw Error(label+' observed early terminal');await new Promise(resolve=>setTimeout(resolve,25));}if(observationFailure)throw observationFailure;};
 try{
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
  runner.ok(events.findIndex(row=>row.phase==='assigned-before-resume')<events.findIndex(row=>row.phase==='resumed'),'actual Job assignment precedes production execution');
  const registered=events.find(row=>row.phase==='registered');runner.ok(registered?.pid>0&&registered.role==='serve'&&/^\d+$/.test(registered.created),'registered process has a kernel-bound creation identity');
  runner.ok(['created-suspended','assigned-before-resume','resumed'].every(phase=>events.some(row=>row.phase===phase&&row.pid===registered.pid&&row.created===registered.created)),'create, assignment, resume and private registration bind the same actual kernel process');
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
  child.stdin.end('close\n');
  await wait(()=>terminal!==null,70000,'normal close');
  checkpoint('events',events);checkpoint('terminal',{terminal,stdoutEOF,stderrEOF,chatClosed,pendingBytes:Buffer.byteLength(pending),stderrBytes:Buffer.byteLength(stderr),mode:windowMode?'window':'host'});
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
