'use strict';
// The launcher itself must be invoked using the frozen Node and an owned output.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {verify}=require('./controller.cjs');
function plan(file,pin,businessOnly=false){
 const contract=fs.realpathSync.native(file);
 const f=verify(contract,pin,businessOnly),root=f.output,ps=f.powershell,script=path.join(f.root,'keeper.candidate.ps1'),controller=path.join(f.root,'controller.cjs');
 if(path.resolve(process.execPath).toLowerCase()!==path.resolve(f.node).toLowerCase()||!path.isAbsolute(ps)||!f.bindings.some(x=>path.resolve(x.path).toLowerCase()===path.resolve(ps).toLowerCase())||!fs.existsSync(path.join(root,'OWNER.json')))throw Error('M5_LAUNCH_AUTHORITY');
 const row=f.bindings.find(x=>path.resolve(x.path).toLowerCase()===path.resolve(controller).toLowerCase());if(!row)throw Error('M5_CONTROLLER_PIN');
 const home=path.join(root,'launcher-home');for(const x of ['','tmp','local','roaming'])fs.mkdirSync(path.join(home,x),{recursive:true});
 const sys=path.join(f.systemRoot,'System32');return {file:ps,args:['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Root',root,'-Node',f.node,'-Script',controller,'-ControllerSha256',row.sha256,'-Contract',contract,'-ContractSha256',pin,...(businessOnly?['-BusinessOnly']:[])],options:{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{SystemRoot:f.systemRoot,WINDIR:f.systemRoot,SystemDrive:path.parse(f.systemRoot).root.replace(/[\\/]+$/,''),PATH:sys,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'tmp'),TMP:path.join(home,'tmp')}}};
}
function launch(file,pin,spawn=cp.spawn,businessOnly=false) {
 const p=plan(file,pin,businessOnly);
 fs.writeFileSync(path.join(p.options.cwd,'LAUNCH_CONSUMED'),JSON.stringify({freezeSha256:pin})+'\n',{flag:'wx'});
 const c=spawn(p.file,p.args,p.options);
 c.once('error',()=>{process.exitCode=1;});
 c.stdout.pipe(process.stdout);
 c.stderr.pipe(process.stderr);
 c.once('close',(code,signal)=>{
  fs.writeFileSync(path.join(p.options.cwd,'launcher-receipt.json'),JSON.stringify({pid:c.pid,code,signal,closeObserved:true})+'\n',{flag:'wx'});
  if(code!==0||signal)process.exitCode=1;
 });
 return c;
}
if(require.main===module){const [, ,file,pin]=process.argv;launch(file,pin);}
module.exports={plan,launch};
