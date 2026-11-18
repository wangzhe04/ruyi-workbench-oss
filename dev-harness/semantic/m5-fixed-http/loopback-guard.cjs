'use strict';
// Scoped to the frozen trusted Node harness. Not an OS sandbox.
const fs=require('node:fs'),net=require('node:net'),http=require('node:http'),https=require('node:https'),dns=require('node:dns'),cp=require('node:child_process'),path=require('node:path');
const denied=()=>{throw Object.assign(Error('loopback_guard.denied'),{code:'LOOPBACK_GUARD_DENIED'});};
function local(host){return typeof host==='string'&&['127.0.0.1','::1','[::1]','localhost'].includes(host.toLowerCase());}
function unsafeOptions(o){return !!o&&typeof o==='object'&&(['lookup','createConnection','connection','socket','dispatcher'].some(k=>k in o)||(o.agent!==undefined&&o.agent!==false));}
function socketTarget(args){let v=args[0];if(Array.isArray(v))v=v[0];if(v&&typeof v==='object'){if(v.path||v.socketPath||unsafeOptions(v))return false;return local(v.hostname||v.host||'localhost');}if(typeof v==='number')return local(typeof args[1]==='string'?args[1]:'localhost');return false;}
function requestTarget(args){let u,o;try{if(typeof args[0]==='string'||args[0] instanceof URL){u=new URL(args[0]);o=args[1]&&typeof args[1]==='object'?args[1]:{};return local(u.hostname)&&(!o.host||local(o.host))&&(!o.hostname||local(o.hostname))&&!o.socketPath&&!unsafeOptions(o);}o=args[0]||{};return !o.socketPath&&!unsafeOptions(o)&&local(o.hostname||o.host||'localhost');}catch{return false;}}
const rawConnect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){if(!socketTarget(a))denied();return Reflect.apply(rawConnect,this,a);};
for(const protocol of [http,https]){const original=protocol.request;protocol.request=function(...a){if(!requestTarget(a))denied();return Reflect.apply(original,this,a);};protocol.get=function(...a){const req=protocol.request(...a);req.end();return req;};}
const realFetch=globalThis.fetch;if(realFetch)globalThis.fetch=function(input,options){let u;try{u=new URL(typeof input==='string'||input instanceof URL?input:input.url);}catch{return denied();}if(!local(u.hostname)||unsafeOptions(options))return denied();return Reflect.apply(realFetch,this,[input,{...(options||{}),redirect:'error'}]);};
const lookup=dns.lookup;dns.lookup=function(host,...args){if(!local(host))denied();if(host.toLowerCase()==='localhost')host='127.0.0.1';return Reflect.apply(lookup,this,[host,...args]);};
const promiseLookup=dns.promises.lookup;dns.promises.lookup=function(host,...args){if(!local(host))return Promise.reject(Object.assign(Error('loopback_guard.denied'),{code:'LOOPBACK_GUARD_DENIED'}));return Reflect.apply(promiseLookup,this,[host.toLowerCase()==='localhost'?'127.0.0.1':host,...args]);};
// The fixed fixture needs only lookup on a literal loopback address. c-ares
// resolve/reverse may reach external DNS even for localhost, so never call it.
for(const k of Object.keys(dns)){if(/^resolve/i.test(k)||k==='reverse'||k==='lookupService')if(typeof dns[k]==='function')dns[k]=denied;}
for(const k of Object.keys(dns.promises)){if(/^resolve/i.test(k)||k==='reverse'||k==='lookupService')if(typeof dns.promises[k]==='function')dns.promises[k]=async()=>denied();}
dns.Resolver=function(){denied();};dns.promises.Resolver=function(){denied();};
function deniedSpawn(method,file,args){try{if(process.env.RUYI_M5_ROLE==='server'&&process.env.RUYI_M5_PROCESS_EVENTS){const name=typeof file==='string'?path.win32.basename(file).toLowerCase():'';const kind=name==='powershell.exe'?'powershell':name==='node.exe'?'node':'other';const encoded=Array.isArray(args)&&args.length===5&&args[3]==='-EncodedCommand'&&typeof args[4]==='string'&&args[4].length<=1048576?require('node:crypto').createHash('sha256').update(args[4]).digest('hex'):null;fs.appendFileSync(process.env.RUYI_M5_PROCESS_EVENTS+'.denied',JSON.stringify({schema:1,method,kind,argc:Array.isArray(args)?args.length:null,encodedSha256:encoded})+'\n');}}catch{}return denied();}
const issuedChildren=new WeakSet();
const spawn=cp.spawn;
const serverEnvironment=Object.freeze({...process.env});
const flushPolicy=require('./flush-policy.cjs');
function handleFlush(file,args,options) {
 const env=serverEnvironment, root=__dirname;
 if(env.RUYI_M5_FROZEN_ROOT!==root || env.RUYI_M5_PROCESS_EVENTS!==path.join(root,'case-output','guard-child-events.jsonl'))return deniedSpawn('spawn',file,args);
 const scope={root,env,cwd:process.cwd(),sourceSha256:env.RUYI_M5_FLUSH_SOURCE_SHA256,serverSha256:env.RUYI_M5_FLUSH_SERVER_SHA256,powershellSha256:env.RUYI_M5_FLUSH_POWERSHELL_SHA256};
 const plan=flushPolicy.admit(file,args,options,scope);
 if(!plan)return deniedSpawn('spawn',file,args);
 const child=Reflect.apply(spawn,cp,[file,[...args],plan.options]);
 const event=(kind,extra={})=>{
  if(!Number.isSafeInteger(child.pid))throw Error('M5_FLUSH_IDENTITY_UNAVAILABLE');
  fs.appendFileSync(path.join(root,'case-output','guard-flush-events.jsonl'),JSON.stringify({schema:1,kind,pid:child.pid,parentPid:process.pid,at:Date.now(),...extra})+'\n');
 };
 let inputAccepted=false;
 child.once('spawn',()=>event('spawn',{inputAccepted}));
 child.once('exit',(code,signal)=>event('exit',{code,signal}));
 child.once('close',(code,signal)=>event('close',{code,signal}));
 return flushPolicy.bindInput(child, plan.home, ()=>deniedSpawn('flush-input',file,args), ()=>{inputAccepted=true;});
}
cp.spawn=function(file,args,options={}){
 if(serverEnvironment.RUYI_M5_ROLE==='server')return handleFlush(file,args,options);
 const root=process.env.RUYI_M5_FROZEN_ROOT;const resolved=x=>path.resolve(x).toLowerCase();if(process.env.RUYI_M5_ROLE!=='fixture'||!root||path.resolve(file).toLowerCase()!==path.resolve(process.execPath).toLowerCase()||!Array.isArray(args)||args.length!==8||args[0]!=='--require'||resolved(args[1])!==resolved(path.join(root,'dev-harness/lib/external-channel-delivery-preload.js'))||args[2]!=='--require'||resolved(args[3])!==resolved(path.join(root,'dev-harness/lib/external-bots-c2/actual-fault-preload.cjs'))||args[4]!=='app/server.js'||args[5]!=='serve'||args[6]!=='--port'||!/^\d{1,5}$/.test(args[7])||Number(args[7])<1||Number(args[7])>65535||resolved(options.cwd||'')!==resolved(path.join(root,'ruyi-workbench')))deniedSpawn('spawn',file,args);const env={...(options.env||process.env),NODE_OPTIONS:'--require '+JSON.stringify(__filename),RUYI_M5_ROLE:'server'};const child=Reflect.apply(spawn,this,[file,args,{...options,env}]);issuedChildren.add(child);child.once('spawn',()=>{if(!Number.isSafeInteger(child.pid)||!process.env.RUYI_M5_PROCESS_EVENTS)throw Error('M5_CHILD_IDENTITY_UNAVAILABLE');fs.appendFileSync(process.env.RUYI_M5_PROCESS_EVENTS,JSON.stringify({schema:1,kind:'guard-issued-server',pid:child.pid,parentPid:process.pid,at:Date.now()})+'\n');});let exit=null,processError=false;child.on('error',()=>{processError=true;});child.once('exit',(code,signal)=>{exit={code,signal,at:Date.now()};});child.once('close',(code,signal)=>{if(!Number.isSafeInteger(child.pid)||!process.env.RUYI_M5_PROCESS_EVENTS)throw Error('M5_CHILD_CLOSE_IDENTITY_UNAVAILABLE');fs.appendFileSync(process.env.RUYI_M5_PROCESS_EVENTS,JSON.stringify({schema:1,kind:'guard-server-close',pid:child.pid,parentPid:process.pid,at:Date.now(),exit,close:{code,signal},processError})+'\n');});return child;};
for(const k of ['exec','execFile','execSync','execFileSync','spawnSync','fork'])cp[k]=function(file,args){return deniedSpawn(k,file,args);};
module.exports=Object.freeze({local,socketTarget,requestTarget,ownsChild:child=>!!child&&issuedChildren.has(child)});

require('node:tls').connect=denied;require('node:dgram').createSocket=denied;require('node:http2').connect=denied;
