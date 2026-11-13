'use strict';
require('./lib/self-isolate-home');
// P5-01 real LaunchServices App -> owned Node -> normal HTTP tool route -> native helper.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const {createRunner} = require('./lib/harness');
const {fixtureChildEnv} = require('./lib/fixture-home');
const {killOwnTree,snapshotProcessTable,ownDescendants} = require('./lib/kill-own-tree');
const {prepareMacHost} = require('./lib/macos-host-fixture');
const t = createRunner('MACOS CAPTURE HOST');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-p5-host-'));
const data=path.join(root,'data');fs.mkdirSync(data);
let launcher;
let owned;
let beforeApp=new Set();
const ownedTree=[];
function observeOwned(binary,report,nativePID) {
  const table=snapshotProcessTable();
  if(!table) throw new Error('Cannot observe the capture App process identities');
  // Native snapshots need not contain a process name. Observe new birth identities
  // before auto-quit, then bind them by exact executable and the unique report path.
  for(const row of table.filter(row=>row.pid===nativePID || !beforeApp.has(row.pid+'/'+row.created))) {
    const command=cp.spawnSync('/bin/ps',['-p',String(row.pid),'-o','command='],{encoding:'utf8',timeout:1000}).stdout;
    if(!command.startsWith(binary+' ') || !command.includes(' --acceptance-report '+report+' ')) continue;
    if(owned && (owned.pid!==row.pid || owned.created!==row.created)) throw new Error('Capture App identity changed');
    owned=row;
    for(const member of [row,...ownDescendants(table,row.pid).descendants]) {
      if(!ownedTree.some(prior=>prior.pid===member.pid && prior.created===member.created)) ownedTree.push(member);
    }
  }
}
function remainingOwned() {
  const current=snapshotProcessTable();
  if(!current) throw new Error('Cannot verify capture App cleanup');
  return current.filter(row=>ownedTree.some(prior=>prior.pid===row.pid && prior.created===row.created));
}
async function cleanupOwned() {
  for(const signal of ['SIGTERM','SIGKILL']) {
    const remaining=remainingOwned().sort((a,b)=>a.pid===owned?.pid?-1:b.pid===owned?.pid?1:0);
    for(const row of remaining) {
      if(snapshotProcessTable()?.some(current=>current.pid===row.pid && current.created===row.created)) {
        try {process.kill(row.pid,signal);} catch(error) {if(error.code!=='ESRCH') throw error;}
      }
    }
    try {await until(()=>remainingOwned().length===0,5000);return;}
    catch(error) {if(signal==='SIGKILL') throw error;}
  }
}
async function until(read,timeout=45000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error('App acceptance timed out');
}
(async()=>{
  try {
    if(process.platform!=='darwin') {console.log('SKIP native host needs macOS');return;}
    const runtime=prepareMacHost(root);
    const bundle=runtime.bundle;
    const binary=path.join(bundle,'Contents/MacOS/RuyiDesktop');
    const report=path.join(root,'report.json');
    const script=path.join(root,'script.js');
    const outputPath=path.join(root,'capture.png');
    const schema=require('../ruyi-workbench/app/server').CONFIG_SCHEMA;
    fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({configSchema:schema,permissionMode:'bypass',
      defaultWorkspace:root,workspaces:[{path:root}],allowDesktopTools:true,providers:[],
      schedulerEnabledV1:false,stewardEnabledV1:false,includeWorkbenchMcp:false,
      autoImportClaudeCodeMcp:false,enableMcpDropIn:false,desktopMcp:{enabled:false,autodetect:false},externalMcpServers:[]}));
    fs.writeFileSync(script,`const {api}=await import('/js/net.js');
const caps=await api('/api/capabilities');
const status=await api('/api/status');
const shot=await api('/api/tools/desktop_screenshot',{method:'POST',body:JSON.stringify({outputPath:${JSON.stringify(outputPath)}})});
const result=shot.result;
return {capture:caps.runtime?.capabilities?.['desktop.capture'],offered:status.tools.some(tool=>tool.name==='desktop_screenshot'),shot:{ok:result.ok,code:result.code,
width:result.width,height:result.height,scale:result.scale,scale_y:result.scale_y,coordinate_space:result.coordinate_space}};`);
    const env={...fixtureChildEnv(),RUYI_HOME:data,WIN_CLAUDE_WORKBENCH_HOME:data,RUYI_NODE_PATH:process.execPath};
    const launchEnv={HOME:env.HOME,USERPROFILE:env.USERPROFILE,LOCALAPPDATA:env.LOCALAPPDATA,APPDATA:env.APPDATA,
      RUYI_HOME:data,WIN_CLAUDE_WORKBENCH_HOME:data,RUYI_NODE_PATH:process.execPath};
    const beforeLaunch=snapshotProcessTable();
    if(!beforeLaunch) throw new Error('Cannot observe identities before capture App launch');
    beforeApp=new Set(beforeLaunch.map(row=>row.pid+'/'+row.created));
    launcher=cp.spawn('/usr/bin/open',['-n','-W','-a',bundle,
      ...Object.entries(launchEnv).flatMap(([key,value])=>['--env',key+'='+value]),
      '--args','--workbench-root',runtime.workbenchRoot,'--acceptance-report',report,'--acceptance-script',script,'--acceptance-auto-quit'],
      {env,cwd:root,stdio:['ignore','pipe','pipe']});
    launcher.stdout.resume();launcher.stderr.on('data',chunk=>console.log('INFO LaunchServices '+String(chunk).trim()));
    const result=await until(()=>{
      observeOwned(binary,report);
      if(fs.existsSync(report)) {
        const value=JSON.parse(fs.readFileSync(report,'utf8'));
        if(value.state==='failed') throw new Error(JSON.stringify(value));
        if(value.state==='ready') {observeOwned(binary,report,value.nativePID);return value;}
      }
      return null;
    });
    const extra=result.page.additional;
    t.ok(result.nativePID>0 && result.servicePID>0,'LaunchServices App owns the actual workbench Node service');
    t.ok(owned?.pid===result.nativePID && ownedTree.some(row=>row.pid===result.servicePID && row.ppid===owned.pid),
      'capture App birth and its actual Node child were observed for this exact report invocation');
    t.ok(extra.capture?.ready===true && extra.capture.authorization==='granted','App-launched helper has its own verified capture authorization');
    t.ok(extra.offered===extra.capture.ready,'App status directory and capability snapshot agree on capture readiness');
    t.ok(extra.shot.ok && extra.shot.coordinate_space==='macos_global_points' && fs.existsSync(outputPath),
      'normal App HTTP tool entry captures a real PNG');
    if(process.env.RUYI_P5_EVIDENCE) {
      fs.mkdirSync(process.env.RUYI_P5_EVIDENCE,{recursive:true});
      fs.copyFileSync(path.join(root,'runtime-source.json'),path.join(process.env.RUYI_P5_EVIDENCE,'runtime-source.json'));
      fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE,'host.json'),JSON.stringify({nativePID:result.nativePID,
        servicePID:result.servicePID,launch:'LaunchServices',bundle,bundled:runtime.bundled,
        workbenchRoot:runtime.workbenchRoot,serverSha256:runtime.serverSha256,
        observedProcesses:ownedTree.map(row=>({...row,created:String(row.created)})),...extra},null,2)+'\n');
    }
    await until(()=>launcher.exitCode!==null || launcher.signalCode!==null,10000);
    t.ok(launcher.exitCode===0,'LaunchServices waiter exits normally after App self-termination');
    await until(()=>remainingOwned().length===0,5000);
    t.ok(ownedTree.length>=2,'all observed capture App and service birth identities are absent after shutdown');
  } catch(error) {t.fail(error.stack || String(error));}
  finally {
    if(ownedTree.length) await cleanupOwned().catch(error=>t.fail(error.message));
    if(launcher && launcher.exitCode===null && launcher.signalCode===null) killOwnTree(launcher);
    if(t.failures===0) fs.rmSync(root,{recursive:true,force:true});
    else console.log('INFO Failed App fixture retained at '+root);
    t.done();
  }
})();
