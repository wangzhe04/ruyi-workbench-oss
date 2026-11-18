'use strict';
// Exact06hb/worker transport, with research-only observed Node ownership.
// No third-party runtime is loaded in the controller. No process at create().
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),cp=require('node:child_process');
const repo=path.resolve(__dirname,'../..'),runtime=path.join(repo,'ruyi-workbench/semantic-runtime'),sourceFile=path.join(repo,'ruyi-workbench/app/src/06hb-semantic-runtime.js');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex'),fh=f=>hash(fs.readFileSync(f)),MODEL='paraphrase-multilingual-MiniLM-L12-v2';
const pins=Object.freeze({'06hb-semantic-runtime.js':'6af2d65e71e693f4835fd642651140f8f553c3d8b7732c90145e590d812229d6','worker.cjs':'449f5d04f6df98ae76f0e76e18563b98603489bc3a8040d05ccdd4404cae983c','protocol.cjs':'29bb6e178fe6a486f1cc608b60acce78b0f0b6f3e051ddf853d0bc5529c84ff2','verify.cjs':'7de5806708065f60bc66f1400990196cef2b8f062d606df1eb11539d5570131e','models.lock.json':'cec30d0f6ee26ac65170c2cfac03534d533686c52b5b1015e570298224536c43','runtime-assets.win32-x64.lock.json':'34c44dfe5a716d29a50921a8fd9c1668ace43674ce7c992cebb3a021b1cfb8a8','package-lock.json':'7d2162ccf860001e3096f0be18c7a2e0d2ec1886c3438fea84fe05615263f229','package.json':'af17b21b0e75ea19f97c33b09d1f29af3df236a2297a573d990be2094576435a'});
for(const[name,sha]of Object.entries(pins))if(fh(name.startsWith('06hb')?sourceFile:path.join(runtime,name))!==sha)throw Error('minilm.source_pin_changed:'+name);
const model=JSON.parse(fs.readFileSync(path.join(runtime,'models.lock.json'))).models.find(x=>x.id===MODEL),inventory=JSON.parse(fs.readFileSync(path.join(runtime,'runtime-assets.win32-x64.lock.json')));
if(model.dimensions!==384||model.pooling!=='mean'||model.maxTokens!==128||model.prefix.query!==''||model.prefix.document!=='')throw Error('minilm.contract_changed');
const implementationHash=hash(JSON.stringify({files:['worker.cjs','protocol.cjs','verify.cjs'].map(name=>pins[name]),runtimeOptions:{disableArena:false}}));
const expectedFingerprint=require(path.join(runtime,'protocol.cjs')).modelFingerprint(model,pins['package-lock.json'],pins['runtime-assets.win32-x64.lock.json'],implementationHash);
const original=fs.readFileSync(sourceFile,'utf8'),boundary='\nlet semanticRuntimeClient = null;';if(original.split(boundary).length!==2)throw Error('minilm.client_boundary_changed');
const Type=vm.runInNewContext(original.split(boundary)[0]+'\nSemanticRuntimeClient;', {Buffer,Date,setTimeout,clearTimeout});
const owners=new Map();const abort=options=>{if(options.signal?.aborted)throw options.signal.reason===undefined?Object.assign(Error('semantic.aborted'),{name:'AbortError'}):options.signal.reason;};
function create(options={}){
 const root=path.resolve(options.root||path.join(repo,'output/semantic-runtime-win32-x64')),command=path.resolve(options.nodePath||process.execPath),worker=path.join(runtime,'worker.cjs'),key=JSON.stringify([root.toLowerCase(),command.toLowerCase(),worker.toLowerCase()]);
 const records=new Set(),token={},counts={starts:0,encodeRequests:0,completed:0};let hasHardError=false,hardError,cleanupStatus='observed';
 const preserve=error=>{hasHardError=true;hardError=error;},liveRecords=()=>[...(owners.get(key)||[])].filter(x=>!x.closed);
 const unavailable=state=>({ok:false,available:false,reason:'unavailable',state});
 const env={};for(const[k,v]of Object.entries(process.env))if(/^(SystemRoot|WINDIR|TEMP|TMP|PATH|PATHEXT|COMSPEC|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(k))env[k]=v;
 env.HF_HUB_OFFLINE='1';env.TRANSFORMERS_OFFLINE='1';
 const settings={command,args:[worker,'--root',root,'--model',MODEL],cwd:repo,env};
 const client=Type.create({enabled:options.enabled||(()=>true),settings:()=>settings,startupMs:20000,idleMs:60000,
  spawn(...args){if(liveRecords().length)throw Error('minilm.worker_exit_unconfirmed');let child;try{child=(options.spawn||cp.spawn)(...args);}catch(error){preserve(error);throw error;}
   const record={child,token,closed:false,exited:null};record.exited=new Promise(resolve=>{record.resolve=resolve;});records.add(record);if(!owners.has(key))owners.set(key,new Set());owners.get(key).add(record);counts.starts++;cleanupStatus='pending';
   child.once('close',(code,signal)=>{record.closed=true;record.outcome={code,signal};owners.get(key)?.delete(record);if(!owners.get(key)?.size)owners.delete(key);record.resolve(record.outcome);if([...records].every(x=>x.closed))cleanupStatus='observed';});
   const transportError=error=>{if(['EACCES','EPERM'].includes(error?.code))preserve(error);};child.on('error',transportError);child.stdin.on('error',transportError);return child;
  }});
 function check(options){abort(options);if(hasHardError)throw hardError;}
 function blocked(){return liveRecords().some(x=>x.token!==token)||([...records].some(x=>!x.closed)&&!['loading','ready'].includes(client.descriptor().state));}
 async function prepare(opts={}){check(opts);if(blocked())return unavailable('worker-exit-unconfirmed');let result;try{result=await client.prepare(opts);}catch(error){check(opts);throw error;}check(opts);
  if(result.available===true&&(result.modelFingerprint!==expectedFingerprint||result.modelId!==MODEL||result.dimensions!==384)){await stop('descriptor-mismatch');return unavailable('descriptor-mismatch');}return result;}
 async function encode(texts,opts={}){check(opts);if(typeof opts.beforeEncode!=='function')throw TypeError('minilm.source_guard_required');const ready=await prepare(opts);if(ready.available!==true)return ready;counts.encodeRequests++;
  let result;try{result=await client.encode(texts,{...opts,beforeEncode:async()=>{check(opts);await opts.beforeEncode();check(opts);}});}catch(error){check(opts);throw error;}check(opts);if(result.ok&&(result.modelFingerprint!==expectedFingerprint||result.vectors.some(v=>v.length!==384))){await stop('descriptor-mismatch');return unavailable('descriptor-mismatch');}if(result.ok)counts.completed+=result.vectors.length;return result;}
 async function stop(reason='research-stop'){client.stop(reason);const pending=[...records].filter(x=>!x.closed);let timer;const wait=Math.max(1,Math.min(10000,options.cleanupWaitMs||5000));try{await Promise.race([Promise.all(pending.map(x=>x.exited)),new Promise(resolve=>{timer=setTimeout(resolve,wait);})]);}finally{clearTimeout(timer);}const exited=[...records].every(x=>x.closed);cleanupStatus=exited?'observed':'unknown';return {ok:exited,state:reason,workerExited:exited,cleanupStatus};}
 function identity(){const own=[...records].findLast(x=>!x.closed&&Number.isSafeInteger(x.child.pid));return own?{pid:own.child.pid,creationFileTime:null}:null;}
 const bindings=[{file:__filename,sha256:fh(__filename)},...Object.entries(pins).map(([name,sha256])=>({file:name.startsWith('06hb')?sourceFile:path.join(runtime,name),sha256})),{file:command,sha256:'63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088'},{file:path.join(root,'package-lock.json'),sha256:pins['package-lock.json']},{file:path.join(root,'package.json'),sha256:pins['package.json']},...model.files.map(x=>({file:path.join(root,'models',MODEL,x.path),sha256:x.sha256})),...inventory.files.map(x=>({file:path.join(root,'node_modules',x.path),sha256:x.sha256}))];
 return Object.freeze({prepare,encode,stop,identity,descriptor:client.descriptor,stats:()=>({...counts,state:client.descriptor().state,processAlive:[...records].some(x=>!x.closed),pid:identity()?.pid??null,cleanupStatus}),bindings,settings:()=>({...settings,args:settings.args.slice(),env:{...settings.env}}),expectedFingerprint,contract:Object.freeze({modelId:MODEL,dimensions:384,pooling:'mean',normalize:'L2',maxTokens:128,queryPrefix:'',documentPrefix:'',physicalBatch:1,disableArena:false}),assetBytes:model.files.reduce((n,x)=>n+x.bytes,0)+inventory.files.reduce((n,x)=>n+x.bytes,0)});
}
module.exports={create,pins,expectedFingerprint};
