'use strict';
require('./lib/self-isolate-home');
// P5-01 real LaunchServices App -> owned Node -> normal HTTP tool route -> native helper.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const {createRunner} = require('./lib/harness');
const {fixtureChildEnv} = require('./lib/fixture-home');
const {killOwnTree,snapshotProcessTable} = require('./lib/kill-own-tree');
const {prepareMacHost} = require('./lib/macos-host-fixture');
const t = createRunner('MACOS CAPTURE HOST');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-p5-host-'));
const data=path.join(root,'data');fs.mkdirSync(data);
let launcher;
let owned;
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
    launcher=cp.spawn('/usr/bin/open',['-n','-W','-a',bundle,
      ...Object.entries(launchEnv).flatMap(([key,value])=>['--env',key+'='+value]),
      '--args','--workbench-root',runtime.workbenchRoot,'--acceptance-report',report,'--acceptance-script',script,'--acceptance-auto-quit'],
      {env,cwd:root,stdio:['ignore','pipe','pipe']});
    launcher.stdout.resume();launcher.stderr.on('data',chunk=>console.log('INFO LaunchServices '+String(chunk).trim()));
    const result=await until(()=>{
      if(fs.existsSync(report)) {
        const value=JSON.parse(fs.readFileSync(report,'utf8'));
        if(value.state==='failed') throw new Error(JSON.stringify(value));
        if(value.state==='ready') return value;
      }
      const table=snapshotProcessTable();
      const matches=table?.filter(row=>row.name==='ruyidesktop') || [];
      for(const row of matches) {
        const command=cp.spawnSync('/bin/ps',['-p',String(row.pid),'-o','command='],{encoding:'utf8'}).stdout;
        if(String(command).startsWith(binary+' --acceptance-report '+report+' ')) owned=row;
      }
      return null;
    });
    const extra=result.page.additional;
    t.ok(result.nativePID>0 && result.servicePID>0,'LaunchServices App owns the actual workbench Node service');
    t.ok(extra.capture?.ready===true && extra.capture.authorization==='granted','App-launched helper has its own verified capture authorization');
    t.ok(extra.offered===extra.capture.ready,'App status directory and capability snapshot agree on capture readiness');
    t.ok(extra.shot.ok && extra.shot.coordinate_space==='macos_global_points' && fs.existsSync(outputPath),
      'normal App HTTP tool entry captures a real PNG');
    if(process.env.RUYI_P5_EVIDENCE) {
      fs.mkdirSync(process.env.RUYI_P5_EVIDENCE,{recursive:true});
      fs.copyFileSync(path.join(root,'runtime-source.json'),path.join(process.env.RUYI_P5_EVIDENCE,'runtime-source.json'));
      fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE,'host.json'),JSON.stringify({nativePID:result.nativePID,
        servicePID:result.servicePID,launch:'LaunchServices',...extra},null,2)+'\n');
    }
    await until(()=>launcher.exitCode!==null || launcher.signalCode!==null,10000);
    t.ok(launcher.exitCode===0,'LaunchServices waiter exits normally after App self-termination');
  } catch(error) {t.fail(error.stack || String(error));}
  finally {
    if(owned && snapshotProcessTable()?.some(row=>row.pid===owned.pid && row.created===owned.created)) {
      process.kill(owned.pid,'SIGTERM');
      await until(()=>!snapshotProcessTable()?.some(row=>row.pid===owned.pid && row.created===owned.created),5000).catch(error=>t.fail(error.message));
    }
    if(launcher && launcher.exitCode===null && launcher.signalCode===null) killOwnTree(launcher);
    if(t.failures===0) fs.rmSync(root,{recursive:true,force:true});
    else console.log('INFO Failed App fixture retained at '+root);
    t.done();
  }
})();
