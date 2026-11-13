const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const repo='/Users/jiming/Documents/ruyi-workbench-mac';
const {fixtureChildEnv}=require(path.join(repo,'dev-harness/lib/fixture-home'));
const {killOwnTree}=require(path.join(repo,'dev-harness/lib/kill-own-tree'));
const out=fs.mkdtempSync('/tmp/ruyi-mac-overall-');
fs.writeFileSync('/tmp/ruyi-mac-overall-current',out);
const report={candidate:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),node:process.version,arch:os.arch(),platform:os.platform(),started:new Date().toISOString(),scope:'Current Mac development environment, P0-P3; Windows excluded this round; existing real-account/login-Keychain and P4-P6 gates retained',checks:[]};
const node=(name,file,extra={})=>({name,command:process.execPath,args:[file],...extra});
const gates=[node('syntax','dev-harness/syntax-gate.js'),node('build','ruyi-workbench/app/build.js',{args:['ruyi-workbench/app/build.js','--check']}),node('fast','dev-harness/run-all.js',{args:['dev-harness/run-all.js','--fast'],timeout:600000})];
const p1=['macos-runtime-start','macos-process-runtime','macos-shell-runtime','macos-file-policy','macos-sync-supervisor','macos-git-runtime','macos-rg-runtime','macos-mcp-capabilities'].map(n=>node(n,'dev-harness/'+n+'.e2e.js'));
const p2=JSON.parse(fs.readFileSync(path.join(repo,'MACOS-PORTING/evidence/P2/final-acceptance/validation.json'))).checks.filter(x=>x.command&&x.command[1]?.endsWith('.e2e.js')).map(x=>node(x.name,x.command[1],{args:x.command.slice(1)}));
const p3=['macos-acc-shared','macos-office-artifacts','macos-browser-runtime','macos-platform-templates','macos-capability-popover.browser','playbooks','capabilities','acc-capability-gates','playbook-skill-tools','checkpoint-coverage'].map(n=>node(n,'dev-harness/'+n+'.e2e.js'));
const python=path.join(repo,'mcp/ai-computer-control/.venv/bin/python');
const py=['smoke_macos_shared','smoke_office_v2','smoke_office_read_v2','smoke_v192_chart_types','smoke_browser_runtime'].map(n=>({name:n,command:python,args:['-X','utf8','mcp/ai-computer-control/tests/'+n+'.py']}));
const steps=[...gates,...p1,...p2,...p3,...py];
const save=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2)+'\n');
console.log('OUTPUT='+out);save();
(async()=>{
 for(const step of steps){
  const fixture=fixtureChildEnv({perTest:true});
  const env={...fixture.env,DYLD_FRAMEWORK_PATH:'/Users/jiming/.local/esp-runtimes',DYLD_LIBRARY_PATH:'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib',ACC_TOOLSETS:'',WCW_DATA_DIR:path.join(fixture.home,'acc'),MPLCONFIGDIR:path.join(fixture.home,'mpl'),PYTHONUTF8:'1',RUYI_OFFICE_REQUIRED:'1',RUYI_BROWSER_REQUIRED:'1',RUYI_TEMPLATES_REQUIRED:'1',RUYI_BROWSER_CACHE_SOURCE:'/tmp/ruyi-p3-browser-required-cache',RUYI_OFFICE_ARTIFACT_DIR:path.join(out,'office'),RUYI_BROWSER_ARTIFACT_DIR:path.join(out,'browser'),RUYI_E2E_SCREENSHOT_DIR:path.join(out,'ui')};
  const start=Date.now(),log=fs.createWriteStream(path.join(out,step.name+'.txt'));
  console.log('START '+step.name);
  const child=cp.spawn(step.command,step.args,{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let tail='',timedOut=false;
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log.write(b);tail=(tail+b).slice(-1500)});
  const timer=setTimeout(()=>{timedOut=true;killOwnTree(child).catch(()=>{})},step.timeout||360000);
  const result=await new Promise(resolve=>{child.once('error',e=>resolve({exitCode:null,error:e.message}));child.once('close',(code,signal)=>resolve({exitCode:code,signal}))});
  clearTimeout(timer);await new Promise(resolve=>log.end(resolve));
  report.checks.push({name:step.name,command:[step.command,...step.args],...result,timedOut,seconds:Math.round((Date.now()-start)/100)/10,home:fixture.home,log:step.name+'.txt'});save();
  console.log((result.exitCode===0&&!timedOut?'PASS ':'FAIL ')+step.name+' '+report.checks.at(-1).seconds+'s');
  if(result.exitCode!==0||timedOut)console.log(tail);
  if(result.exitCode===0&&!timedOut)fs.rmSync(fixture.home,{recursive:true,force:true});
 }
 report.finished=new Date().toISOString();save();
 console.log('FINISHED '+report.checks.filter(x=>x.exitCode===0&&!x.timedOut).length+'/'+report.checks.length);
 process.exitCode=report.checks.some(x=>x.exitCode!==0||x.timedOut)?1:0;
})().catch(e=>{console.error(e);process.exitCode=1});
