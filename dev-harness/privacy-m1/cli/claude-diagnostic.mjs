// Original advisory instrumentation of public fs APIs. Arguments, return values,
// callbacks and exceptions are preserved. No path or file content is emitted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const cwd=process.cwd(),projection=process.env.RUYI_M1_PROJECTION,home=process.env.HOME;
const emit=value=>console.log(JSON.stringify({kind:'claude-fs-diagnostic',...value}));
function pathInfo(value){
  if(value instanceof URL)value=value.href;if(Buffer.isBuffer(value))value=value.toString('utf8');
  if(typeof value!=='string')return {pathClass:'nonpath'};
  const normalized=value.toLowerCase().replaceAll('/','\\'),under=root=>root&&(normalized===root.toLowerCase().replaceAll('/','\\')||normalized.startsWith(root.toLowerCase().replaceAll('/','\\')+'\\'));
  return {pathClass:under(home)?'fixture-home':under(projection)?'projection':under(process.env.SystemRoot)?'windows-resource':path.isAbsolute(value)?'outside-absolute':'relative',pathSha256:hash(value)};
}
let emitted=0,errorEmitted=0;const counts={};
function receipt(operation,value,error,phase){counts[operation]=(counts[operation]||0)+1;if(error?errorEmitted++<24:emitted++<96)emit({operation,phase,...pathInfo(value),ok:phase==='application-start'?null:!error,errorCode:error?String(error.code||error.name||'unknown').slice(0,64):null});}
emit({operation:'preload',runtime:typeof Bun==='object'?'Bun':'other',version:typeof Bun==='object'?Bun.version:null});
for(const [operation,value]of [['cwd-realpath',cwd],['entry-realpath',process.execPath]]){try{fs.realpathSync(value);receipt(operation,value,null,'own-preflight');}catch(error){receipt(operation,value,error,'own-preflight');}}
function instrument(target,name,mode){
  const original=target[name];if(typeof original!=='function')return;
  const wrapper=function(...args){const value=args[0];receipt(name,value,null,'application-start');
    if(mode==='callback'&&typeof args.at(-1)==='function'){const callback=args.at(-1);args[args.length-1]=function(...results){receipt(name,value,results[0],'application');return Reflect.apply(callback,this,results);};}
    try{const result=Reflect.apply(original,this,args);if(mode==='promise')return result.then(valueResult=>{receipt(name,value,null,'application');return valueResult;},error=>{receipt(name,value,error,'application');throw error;});if(mode==='sync')receipt(name,value,null,'application');return result;}
    catch(error){receipt(name,value,error,'application');throw error;}
  };
  Object.assign(wrapper,original);target[name]=wrapper;
  if(typeof original.native==='function'){const holder={native:original.native};instrument(holder,'native',mode);wrapper.native=holder.native;}
}
for(const name of ['access','stat','lstat','readdir','readFile','realpath','open','opendir']){instrument(fs,name+'Sync','sync');instrument(fs,name,'callback');instrument(fs.promises,name,'promise');}
setTimeout(()=>emit({operation:'event-loop-tick',counts}),1500).unref();
