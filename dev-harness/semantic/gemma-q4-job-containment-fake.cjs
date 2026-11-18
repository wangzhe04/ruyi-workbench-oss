'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.argv[2];if(!root||!fs.existsSync(path.join(root,'OWNER.json')))throw Error('owned probe required');
if(process.argv[3]==='descendant'){setTimeout(()=>fs.writeFileSync(path.join(root,'grandchild-finished.json'),JSON.stringify({pid:process.pid}),{flag:'wx'}),1800);}
else if(process.argv[3]==='intermediate'){const c=cp.spawn(process.execPath,[__filename,root,'descendant'],{detached:true,stdio:'ignore',windowsHide:true});c.unref();fs.writeFileSync(path.join(root,'child.json'),JSON.stringify({pid:process.pid,grandchild:c.pid}),{flag:'wx'});}
else if(process.argv[3]==='controller'){const child=cp.spawn(process.execPath,[__filename,root,'intermediate'],{detached:true,stdio:'ignore',windowsHide:true});child.unref();for(let i=0;i<2;i++){const p=cp.spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});p.unref();}fs.writeFileSync(path.join(root,'controller.json'),JSON.stringify({pid:process.pid,intermediate:child.pid}),{flag:'wx'});}
else throw Error('unknown probe mode');
