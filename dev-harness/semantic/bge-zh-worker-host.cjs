'use strict';
// Owned direct Node worker. No wrapper grandchildren or scalar service. Unknown
// exit stays in a shared asset-root registry and prevents subsequent launches.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const registry=new Map(),hash=value=>crypto.createHash('sha256').update(value).digest('hex'),fh=file=>hash(fs.readFileSync(file));
const unavailable=(reason,state=reason)=>({ok:false,available:false,reason,state});
const aborted=signal=>{if(signal?.aborted)throw signal.reason===undefined?Object.assign(Error('bge.aborted'),{code:'ABORT_ERR'}):signal.reason;};
function create({directory,enabled=async()=>true,spawn=cp.spawn,idleMs=60000,stopMs=5000,modelSpec=null}={}){
  const spec=modelSpec||{id:'bge-small-zh-v1.5',dimensions:512,pooling:'cls',normalize:true,maxTokens:512,prefix:{query:'为这个句子生成表示以用于检索相关文章：',document:''},searchThreshold:.53,lockSha256:'949a4a0423530264cd867be5b65cd076ee22b282592578acf2ce41193055deff',verifierFile:require.resolve('./bge-cn-worker-verify.cjs'),lockEnvironment:'RUYI_BGE_CN_LOCK',implementationTag:'original449f-CLS-L2-CN-query-prefix-physical1-cpu2-inter1'};
  directory=path.resolve(directory);const lockFile=path.join(directory,'asset-lock.json'),lockBytes=fs.readFileSync(lockFile),lock=JSON.parse(lockBytes),lockHash=hash(lockBytes),item=lock.model||lock.models?.find(item=>item.workerModel.id===spec.id),model=item?.workerModel;
  if(!model||model.id!==spec.id||model.dimensions!==spec.dimensions||model.pooling!==spec.pooling||model.normalize!==true||model.maxTokens!==spec.maxTokens||JSON.stringify(model.prefix)!==JSON.stringify(spec.prefix)||lockHash!==spec.lockSha256||!Number.isFinite(spec.searchThreshold)||spec.searchThreshold < -1||spec.searchThreshold>1||!['RUYI_BGE_CN_LOCK','RUYI_MINILM_FAMILY_LOCK'].includes(spec.lockEnvironment))throw Error('bge.asset_contract');
  const workerSha256=lock.workerSha256||lock.workerRecipe.transformedSha256,verifierFile=path.resolve(spec.verifierFile),implementation=hash(JSON.stringify([lockHash,fh(verifierFile),workerSha256,spec.implementationTag]));
  const workspaceOutput=path.resolve(__dirname,'../../output'),liveRoot=path.join(directory,'live-homes'),samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  const within=(root,target)=>{const relative=path.relative(root,target);return relative.length>0&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
  const marker=JSON.parse(fs.readFileSync(path.join(directory,'OWNER.json'),'utf8'));
  if(!within(workspaceOutput,directory)||!samePath(fs.realpathSync(directory),directory)||marker.synthetic!==true||!['bge-cn-existing-coarse-research','official-minilm-family-coarse-research'].includes(marker.owner))throw Error('bge.owner_directory');
  function cleanupHome(home){const absolute=path.resolve(home),relative=path.relative(liveRoot,absolute);if(!within(liveRoot,absolute)||!/^[a-f0-9]{24}$/.test(relative)||!samePath(absolute,home)||!samePath(fs.realpathSync(liveRoot),liveRoot)||!samePath(fs.realpathSync(absolute),absolute))throw Error('bge.cleanup_boundary');
    const stat=fs.lstatSync(absolute),owned=JSON.parse(fs.readFileSync(path.join(absolute,'OWNER.json'),'utf8'));if(!stat.isDirectory()||stat.isSymbolicLink()||owned.owner!=='bge-zh-worker-host'||owned.synthetic!==true)throw Error('bge.cleanup_owner');fs.rmSync(absolute,{recursive:true,force:true});}
  const expected=require('../../ruyi-workbench/semantic-runtime/protocol.cjs').modelFingerprint(model,lock.packageLockSha256,lock.runtimeInventorySha256,implementation);
  const rootKey=JSON.stringify([path.resolve(lock.runtimeRoot),path.resolve(item.modelDir),model.files.find(f=>f.path.endsWith('.onnx')).sha256]),namespace=hash(JSON.stringify([model.id,expected,model.dimensions,model.pooling,model.prefix]));
  const pending=new Map(),recent={query:16,document:12},metrics={starts:0,requests:0,queryTexts:0,documentTexts:0,kills:0,cleanupFailures:0,peakRssBytes:0,maxSampledRssBytes:0};
  let owner=null,starting=null,startError=null,serial=0,idleTimer=null,closed=false;
  const descriptor=()=>({available:owner?.state==='ready',state:owner?.state||'cold',modelId:model.id,modelNamespace:namespace,modelFingerprint:expected,dimensions:model.dimensions,pooling:model.pooling,prefix:{...model.prefix},maxTokens:model.maxTokens,recommendedChunkChars:96,retrievalThresholds:{search:spec.searchThreshold,automatic:null}});
  const clearIdle=()=>{clearTimeout(idleTimer);idleTimer=null;};
  const estimateEncodingBudget=(role,count)=>{if(!['query','document'].includes(role)||!Number.isSafeInteger(count)||count<0||count>16)throw TypeError('bge.invalid_estimate');return Math.min(60000,Math.max(32,Math.ceil(recent[role]*count*1.3+16)));};
  const identity=()=>owner?{pid:owner.child.pid,creationFileTime:owner.creationFileTime||null}:null;
  const current=(record,signal)=>{aborted(signal);if(owner!==record||registry.get(rootKey)!==record||record.state!=='ready')throw Error('bge.owner_changed');};
  function settle(id,value,error,failed=false){const row=pending.get(id);if(!row)return;pending.delete(id);clearTimeout(row.timer);row.signal?.removeEventListener('abort',row.abort);failed?row.reject(error):row.resolve(value);}
  function scheduleIdle(){clearIdle();if(owner?.state==='ready'&&!pending.size){idleTimer=setTimeout(()=>{void stop('idle');},idleMs);idleTimer.unref?.();}}
  async function stop(reason='stopped',excludeId=null){
    clearIdle();const record=owner;if(!record)return {ok:true,workerExited:true,cleanupStatus:'observed',state:reason};
    record.state='stopping';record.stopReason=reason;for(const id of [...pending.keys()])if(id!==excludeId)settle(id,unavailable(reason==='disabled'?'disabled':reason==='timeout'?'timeout':'unavailable'));
    try{record.child.stdin.end();}catch{}
    let timer;await Promise.race([record.exited,new Promise(resolve=>{timer=setTimeout(resolve,200);})]);clearTimeout(timer);
    if(!record.didClose){metrics.kills++;try{record.child.kill();}catch{}}
    await Promise.race([record.exited,new Promise(resolve=>{timer=setTimeout(resolve,stopMs);})]);clearTimeout(timer);
    if(!record.didClose){record.state='unknown';return {ok:false,workerExited:false,cleanupStatus:'unknown',state:reason,pid:record.child.pid};}
    return {ok:true,workerExited:true,cleanupStatus:'observed',state:reason,code:record.code,signal:record.exitSignal};
  }
  function launch(){
    if(starting)return starting;if(owner?.state==='ready')return Promise.resolve({ok:true,...descriptor()});
    const blocked=registry.get(rootKey);if(blocked)return Promise.resolve(unavailable(blocked.state==='unknown'?'unavailable':'overloaded',blocked.state));
    for(const binding of lock.sourceBindings)if(fh(binding.file)!==binding.sha256)throw Error('bge.source_integrity');
    if(fh(lockFile)!==lockHash||fh(path.join(directory,'worker.cjs'))!==workerSha256)throw Error('bge.worker_integrity');
    try{fs.mkdirSync(liveRoot);}catch(error){if(error.code!=='EEXIST')throw error;}if(!fs.lstatSync(liveRoot).isDirectory()||fs.lstatSync(liveRoot).isSymbolicLink()||!samePath(fs.realpathSync(liveRoot),liveRoot))throw Error('bge.live_root_alias');
    const home=path.join(liveRoot,crypto.randomBytes(12).toString('hex'));for(const child of ['temp','local','roaming'])fs.mkdirSync(path.join(home,child),{recursive:true});fs.writeFileSync(path.join(home,'OWNER.json'),JSON.stringify({owner:'bge-zh-worker-host',synthetic:true})+'\n',{flag:'wx'});
    const env={};for(const [key,value]of Object.entries(process.env))if(/^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key))env[key]=value;
    Object.assign(env,{HOME:home,USERPROFILE:home,TEMP:path.join(home,'temp'),TMP:path.join(home,'temp'),LOCALAPPDATA:path.join(home,'local'),APPDATA:path.join(home,'roaming'),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',[spec.lockEnvironment]:lockFile,[spec.lockEnvironment+'_SHA256']:lockHash});
    let child;try{child=spawn(process.execPath,[path.join(directory,'worker.cjs'),'--root',lock.runtimeRoot,'--model',model.id],{cwd:path.resolve(__dirname,'../..'),env,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(error){try{cleanupHome(home);}catch{metrics.cleanupFailures++;}throw error;}
    const record={child,state:'loading',home,didClose:false,creationFileTime:null};
    owner=record;registry.set(rootKey,record);metrics.starts++;clearIdle();let resolveExit,resolveReady,rejectReady;
    record.exited=new Promise(resolve=>resolveExit=resolve);const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    let buffer='',startupTimer=setTimeout(()=>{rejectReady(Error('bge.startup_timeout'));void stop('timeout');},20000);startupTimer.unref?.();
    child.once('close',(code,signal)=>{record.didClose=true;record.code=code;record.exitSignal=signal;record.state='closed';clearTimeout(startupTimer);resolveExit({workerExited:true,cleanupStatus:'observed',code,signal});if(record.stopReason)resolveReady(unavailable(record.stopReason==='timeout'?'timeout':'unavailable'));else rejectReady(Error('bge.startup_closed'));for(const id of [...pending.keys()])settle(id,unavailable(record.stopReason==='timeout'?'timeout':'unavailable'));if(registry.get(rootKey)===record)registry.delete(rootKey);if(owner===record)owner=null;try{cleanupHome(home);}catch{metrics.cleanupFailures++;}});
    child.once('error',error=>{rejectReady(error);void stop('unavailable');});child.stdin.on('error',()=>{void stop('unavailable');});child.stderr.on('data',()=>{});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{if(owner!==record)return;buffer+=chunk;if(Buffer.byteLength(buffer)>2*1024*1024){rejectReady(Error('bge.response_limit'));void stop('unavailable');return;}let end;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let value;try{value=JSON.parse(line);}catch{rejectReady(Error('bge.invalid_ndjson'));void stop('unavailable');return;}
        if(value.type==='ready'){if(value.ok!==true||value.modelId!==model.id||value.modelFingerprint!==expected||value.dimensions!==model.dimensions||value.limits?.maxTokens!==model.maxTokens){rejectReady(Error('bge.model_contract'));void stop('unavailable');return;}if(record.state!=='loading')continue;clearTimeout(startupTimer);record.state='ready';resolveReady({ok:true,...descriptor()});scheduleIdle();continue;}
        if(pending.has(value.requestId))settle(value.requestId,value);
      }
    });
    starting=ready.catch(async error=>{const hard=error?.message!=='bge.startup_timeout'&&error?.message!=='bge.startup_closed';if(hard)startError=error;await stop('unavailable');if(hard)throw error;return unavailable('unavailable');}).finally(()=>{starting=null;});return starting;
  }
  async function prepare(options={}){
    aborted(options.signal);const allowed=await enabled();aborted(options.signal);if(allowed!==true){await stop('disabled');aborted(options.signal);return unavailable('disabled');}if(startError)throw startError;
    const remaining=Math.min(Number.isFinite(options.deadline)?options.deadline-Date.now():20000,Number.isFinite(options.budgetMs)?Math.max(0,options.budgetMs):20000);if(remaining<=0)return unavailable('timeout');
    if(owner?.state==='unknown'||owner?.state==='stopping')return unavailable('unavailable',owner.state);if(closed)return unavailable('disabled');
    const ready=launch();if(owner?.state==='ready')return {ok:true,...descriptor()};
    return new Promise((resolve,reject)=>{let done=false;const finish=(value,error,failed=false)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);failed?reject(error):resolve(value);};
      const cancel=()=>{const reason=options.signal.reason===undefined?Object.assign(Error('bge.aborted'),{code:'ABORT_ERR'}):options.signal.reason;void stop('cancelled').then(()=>finish(null,reason,true));};
      const timer=setTimeout(()=>finish(unavailable('unavailable','loading')),Math.min(remaining,20000));options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)cancel();ready.then(value=>finish(value),error=>finish(null,error,true));});
  }
  async function encode(texts,options={}){
    if(!Array.isArray(texts)||!texts.length||texts.length>16||texts.some(text=>typeof text!=='string'||text.length>8192)||texts.reduce((sum,text)=>sum+text.length,0)>32768||!['query','document'].includes(options.role))throw TypeError('bge.invalid_input');
    const ready=await prepare(options);if(!ready.available)return ready;const record=owner;aborted(options.signal);const allowed=await enabled();aborted(options.signal);current(record,options.signal);if(allowed!==true){await stop('disabled');return unavailable('disabled');}if(options.beforeEncode)await options.beforeEncode();current(record,options.signal);
    if(pending.size)return unavailable('overloaded');const deadline=Math.min(Number.isFinite(options.deadline)?options.deadline:Infinity,Date.now()+(Number.isFinite(options.budgetMs)?Math.max(0,options.budgetMs):1000)),minimum=Math.max(estimateEncodingBudget(options.role,texts.length),Number(options.minimumBudgetMs)||0);
    if(deadline-Date.now()<minimum)return unavailable('timeout');clearIdle();const requestId='bge-live-'+(++serial),began=Date.now();
    try{
      const value=await new Promise((resolve,reject)=>{const abort=()=>{const reason=options.signal.reason===undefined?Error('bge.aborted'):options.signal.reason;void stop('cancelled',requestId).then(()=>settle(requestId,null,reason,true));},timer=setTimeout(()=>{void stop('timeout',requestId).then(()=>settle(requestId,unavailable('timeout')));},Math.max(1,deadline-Date.now()));
        pending.set(requestId,{resolve,reject,timer,signal:options.signal,abort});options.signal?.addEventListener('abort',abort,{once:true});
        if(options.signal?.aborted){abort();return;}current(record,options.signal);metrics.requests++;metrics[options.role==='query'?'queryTexts':'documentTexts']+=texts.length;record.child.stdin.write(JSON.stringify({requestId,op:'encode',role:options.role,texts,deadlineMs:deadline})+'\n');});
      aborted(options.signal);const stillEnabled=await enabled();aborted(options.signal);if(options.beforeEncode)await options.beforeEncode();aborted(options.signal);if(stillEnabled!==true){await stop('disabled');return unavailable('disabled');}
      if(value.ok!==true)return unavailable(value.reason==='timeout'||/deadline|timeout/i.test(value.error?.code||'')?'timeout':'unavailable');current(record,options.signal);
      if(value.modelFingerprint!==expected||value.dimensions!==model.dimensions||!Array.isArray(value.vectors)||value.vectors.length!==texts.length||value.vectors.some(v=>!Array.isArray(v)||v.length!==model.dimensions||!v.every(Number.isFinite)||Math.abs(Math.hypot(...v)-1)>1e-4)||!Array.isArray(value.truncated)||value.truncated.length!==texts.length)throw Error('bge.vector_contract');
      if(!Array.isArray(value.tokenCounts)||!Array.isArray(value.encodedTokenCounts)||value.tokenCounts.length!==texts.length||value.encodedTokenCounts.length!==texts.length||value.tokenCounts.some((count,n)=>!Number.isSafeInteger(count)||count<1||!Number.isSafeInteger(value.encodedTokenCounts[n])||value.encodedTokenCounts[n]<1||value.encodedTokenCounts[n]>model.maxTokens||value.truncated[n]!== (count>value.encodedTokenCounts[n])))throw Error('bge.token_contract');
      recent[options.role]=Math.max(4,recent[options.role]*.6+(Date.now()-began)/texts.length*.4);metrics.peakRssBytes=Math.max(metrics.peakRssBytes,value.metrics?.peakRssBytes||0);metrics.maxSampledRssBytes=Math.max(metrics.maxSampledRssBytes,value.metrics?.rssBytes||0);return value;
    }catch(error){await stop('encode-failed');throw error;}finally{scheduleIdle();}
  }
  return Object.freeze({prepare,encode,stop,descriptor,estimateEncodingBudget,identity,stats:()=>({...metrics,descriptor:descriptor(),pending:pending.size,ownership:owner?.state||'observed-none'}),shutdown:async()=>{closed=true;return stop('shutdown');}});
}
module.exports={create};
