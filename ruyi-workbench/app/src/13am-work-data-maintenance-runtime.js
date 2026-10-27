// Process composition only. Native operations/result writers have their own
// reviewed owners. No cold command calls normal serve in its own process.
const WorkDataMaintenanceRuntime = ((io,p,c) => {
  const ID=/^[a-f0-9]{48}$/,NONCE=/^[a-f0-9]{64}$/;
  const fail=suffix=>Object.assign(Error('work_data_setup.'+suffix),{code:'work_data_setup.'+suffix,statusCode:409,retry:false});
  const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
  const fold=value=>process.platform==='win32'?value.toLowerCase():value;
  const full=actual=>({generation:actual?.generation,id:actual?.id,mode:actual?.mode,sha256:actual?.sha256===undefined?actual?.proof?.sha256:actual.sha256});
  const authority=value=>keys(value)==='generation,id,mode,sha256'&&Number.isSafeInteger(value.generation)&&value.generation>=0&&['plain','encrypted'].includes(value.mode)
    &&(value.generation===0?value.id===null&&value.sha256===null:ID.test(value.id||'')&&NONCE.test(value.sha256||''));
  const same=(a,b)=>authority(a)&&authority(b)&&a.generation===b.generation&&a.id===b.id&&a.mode===b.mode&&a.sha256===b.sha256;
  const listener=value=>keys(value)==='host,port'&&['127.0.0.1','::1','localhost'].includes(value.host)&&Number.isInteger(value.port)&&value.port>0&&value.port<=65535;
  const safeCode=error=>/^work_data(?:_[a-z0-9]+)*\.[a-z0-9_.-]{1,96}$/.test(String(error?.code||''))?error.code:'work_data_setup.worker_failed_after_handoff';
  // 13av reports absent/inert/complete/pending. Anything else refuses the boot.
  const verdict=value=>['absent','inert','complete','pending'].includes(value)?value:['absent','inert','complete','pending'].includes(value?.verdict)?value.verdict:null;
  // A retirement receipt is data, never a boolean promotion: it must carry the
  // drained/retired phase and, when counted, prove every producer is at zero.
  const retiredReceipt=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||value.phase!=='retired')return false;
    for(const name of ['admitted','writers','dirty'])if(value[name]!==undefined&&value[name]!==0)return false;
    if(value.busy!==undefined){if(!value.busy||typeof value.busy!=='object'||Array.isArray(value.busy))return false;for(const count of Object.values(value.busy))if(count!==0)return false;}
    return true;
  };
  function create(host,shared) {
    const proc=host?.process;
    if(!proc||!Number.isSafeInteger(proc.pid)||proc.pid<1||!host.workerApi||!host.httpApi||!host.resultApi||!host.controlApi
      ||['create','spawnCold','processChannel','waitForProcessExit'].some(name=>typeof host.workerApi[name]!=='function')
      ||[host.httpApi,host.resultApi,host.controlApi].some(api=>typeof api.create!=='function')
      ||['base','canonical','acquire','readAuthority','operations','adaptersReady','stopUncommitted','exit','isRetired','helperMayStillRun','command','assertOwnership','withColdSource','withWarmSource'].some(name=>typeof host[name]!=='function')
      ||!host.workerHooks||typeof host.workerHooks!=='object')throw fail('runtime_host_invalid');
    let warm=null,worker=null,coldStarted=false,successorStarted=false,helperUncertain=false;
    // The successor slot and its strict-port ticket belong to the process, not to one
    // runtime instance: preparation happens before configure, completion after it.
    const slot=shared||{successor:null,strictOptions:new WeakSet()};
    const successorInput=()=>slot.successor?slot.successor.input:null;
    // The handoff claim is the only durable evidence that a committed job exists.
    // Production hosts must supply it; a legacy harness must say so explicitly.
    const claimValue=()=>{const value=host.claim;return value===undefined||value===null?null:value;};
    const claimShape=value=>!!value&&typeof value==='object'&&['inspect','write','remove','classify'].every(name=>typeof value[name]==='function');
    const requireClaim=()=>{const value=claimValue();
      if(value){if(!claimShape(value))throw fail('runtime_host_invalid');return value;}
      if(host.legacyNoClaim===true)return null;throw fail('claim_unavailable');};
    const retired=()=>{const read=host.retiredReceipt;if(typeof read!=='function')return false;try{return retiredReceipt(read());}catch{return false;}};
    function latch(error) {
      const seen=new Set();let value=error,depth=0;
      while(value&&(typeof value==='object'||typeof value==='function')){
        if(depth++>=12||seen.has(value)){helperUncertain=true;break;}
        seen.add(value);try{if(value.helperMayStillRun===true)helperUncertain=true;value=value.cause;}catch{helperUncertain=true;break;}
      }
      return error;
    }
    const helpers=()=>{try{
      if(host.helperMayStillRun()!==false)helperUncertain=true;
      if(typeof LocalSecretCrypto!=='undefined'){const inspect=LocalSecretCrypto.helperMayStillRun;if(inspect!==undefined&&(typeof inspect!=='function'||inspect.call(LocalSecretCrypto)!==false))helperUncertain=true;}
      if(typeof MigrationHooks!=='undefined'){const inspect=MigrationHooks.helperMayStillRun;if(inspect!==undefined&&(typeof inspect!=='function'||inspect.call(MigrationHooks)!==false))helperUncertain=true;}
      return helperUncertain;
    }catch{helperUncertain=true;return true;}};
    const guardNative=async work=>{try{return await work();}catch(error){latch(error);throw error;}};
    const ready=()=>{try{return host.adaptersReady()===true&&!helpers();}catch{return false;}};
    const ownership=(owner,base)=>{try{return ServerOwnership.owns(owner,base)&&host.assertOwnership(owner,base)===true;}catch{return false;}};
    const command=mode=>{const value=host.command(mode);if(!value||typeof value.command!=='string'||!Array.isArray(value.args)||!value.args.every(arg=>typeof arg==='string'))throw fail('command_invalid');return value;};
    const actualListener=(server,expected)=>{
      const bound=server?.address?.();if(!listener(expected)||!server?.listening||!bound||typeof bound!=='object'||!['127.0.0.1','::1'].includes(bound.address)||bound.port!==expected.port
        ||expected.host!=='localhost'&&expected.host!==bound.address)throw fail('listener_changed');
      return {host:expected.host,port:bound.port};
    };
    async function inspectBoot({base,ownership:owner}) {
      base=await host.canonical(base);if(!ownership(owner,base))throw fail('ownership_required');
      let stat;try{stat=await io.lstat(base);}catch(error){if(error.code==='ENOENT'&&!successorInput())return true;throw error;}
      if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('boot_control_unavailable');
      const control=p.join(base,'.work-data');
      try {
        const stat=await io.lstat(control);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('boot_control_unavailable');
        const names=await io.readdir(control),allowed=new Set(['active-v1.json','generations','skill-backups','maintenance-v1.json','maintenance-result-v1.json']);
        if(names.some(name=>!allowed.has(fold(name))))throw fail('boot_control_pending');
      }catch(error){if(error.code!=='ENOENT')throw error;}
      const ownerCheck=async candidate=>candidate===owner&&ownership(owner,base);
      const controls=host.controlApi.create({base,ownership:owner,assertExclusive:ownerCheck,assertDurableBackup:async()=>false,flush:async()=>{throw fail('readonly_boot');}});
      // An unfinished intent always wins; C10/C11 stay intent_pending and their
      // files are never rewritten or removed by ordinary boot.
      if((await controls.inspect()).pending)throw fail('intent_pending');
      const resultReader=host.resultApi.create({base,ownership:owner,assertExclusive:ownerCheck,readAuthority:()=>host.readAuthority(base)});
      // Ordinary boot only looks at the record's presence: a stale receipt must not
      // read a backup or fail startup. The successor additionally verifies it.
      const observedResult=await resultReader.inspect(),expected=successorInput();
      const result=expected?await resultReader.read():null;
      if(expected&&(!result||result.id!==expected.id||!same(result.authority,expected.expectedAuthority)))throw fail('successor_result_changed');
      // No intent: only the TEMP handoff record may be classified and, when inert or
      // complete, cleaned. Base files are never repaired here.
      // The claim owner compares this digest with its own id/operation, so a stale
      // result from another job can never complete a new handoff. A present record
      // that cannot be summarized refuses the boot instead of degrading to "none".
      const digest=observedResult?.present?{id:observedResult.value?.id,operation:observedResult.value?.operation}:null;
      if(digest&&(typeof digest.id!=='string'||!ID.test(digest.id)||!['enable','disable','export','restore'].includes(digest.operation)))throw fail('boot_control_pending');
      const claims=claimValue();
      if(claims){
        if(!claimShape(claims))throw fail('runtime_host_invalid');
        const outcome=verdict(await claims.classify({base,hasIntent:false,hasResult:digest}));
        if(outcome==='pending')throw fail('handoff_pending');
        if(outcome!=='absent'&&outcome!=='inert'&&outcome!=='complete')throw fail('boot_control_pending');
        if(outcome!=='absent'){const observed=await claims.inspect({base});if(observed?.present)await claims.remove(observed.receipt);}
      }
      return true;
    }
    const readWarmResult=captured=>{
      const ownerCheck=async owner=>warm===captured&&owner===captured.ownership&&ownership(owner,captured.base)&&captured.server.listening;
      return host.resultApi.create({base:captured.base,ownership:captured.ownership,assertExclusive:ownerCheck,readAuthority:()=>host.readAuthority(captured.base)}).read();
    };
    async function captureServe(context) {
      if(coldStarted||warm)throw fail('runtime_already_bound');
      const owner=context.ownership,server=context.server,original=context.base,expected={...context.listener};
      const base=await host.canonical(original),capturedListener=actualListener(server,expected);
      if(!ownership(owner,base))throw fail('ownership_required');
      const captured={base,ownership:owner,server,listener:capturedListener};
      warm=captured;
      const readResult=()=>readWarmResult(captured);
      // Optional trusted host dependency; callability is interface validation,
      // not source authority. The provider must validate this exact candidate
      // host, genuine owner and base before returning its scoped callback.
      const bindResult=host.bindCapturedResult;
      if(bindResult===undefined)host.workerHooks.readResult=readResult;
      else{
        if(typeof bindResult!=='function')throw fail('runtime_host_invalid');
        const capturedRead=bindResult(host,base,owner,readResult);
        if(typeof capturedRead!=='function')throw fail('runtime_host_invalid');
        host.workerHooks.readResult=capturedRead;
      }
      return ready();
    }
    function activateServe() {
      const captured=warm;if(!captured||coldStarted||worker)throw fail('runtime_not_captured');
      const base=captured.base;actualListener(captured.server,captured.listener);
      if(!ready())return false; // Missing native/result/successor adapters do not advertise a worker.
      // No warm child may commit without a durable claim writer. A legacy harness
      // must state that absence explicitly instead of silently degrading.
      const claims=requireClaim();
      worker=host.workerApi.create({pid:proc.pid,env:proc.env,setTimeout,clearTimeout,base:async()=>base,listener:()=>actualListener(captured.server,captured.listener),
        spawn:env=>host.workerApi.spawnCold(command('work-data-maintenance'),env),stopUncommitted:host.stopUncommitted,uploads:host.uploads,claim:claims,
        exitParent:async()=>{if(!retired()||warm!==captured||!ownership(captured.ownership,base))throw fail('handoff_not_retired');actualListener(captured.server,captured.listener);if(helpers())throw Object.assign(fail('native_helper_uncertain'),{helperMayStillRun:true});
          // The same real receipt must still hold at the exit boundary; a boolean
          // promotion or a single early read is not admissible evidence.
          if(!retired())throw fail('handoff_not_retired');await host.exit(0);},
      });
      host.workerHooks.start=async request=>host.withWarmSource(request,async()=>{if(!ready()||warm!==captured)throw fail('worker_unavailable');actualListener(captured.server,captured.listener);return worker.start(request);});
      return true;
    }
    function execute(context) { return host.withColdSource(context,()=>executeBody(context)); }
    async function executeBody(context) {
      // No base mutation may start unless a durable claim writer exists. The bound
      // finish/abandon capability itself is built by 13ai for this exact attempt and
      // travels through the context into 13ak; this layer never re-derives it.
      requireClaim();
      let current=full(await host.readAuthority(context.base));if(!same(current,context.expectedAuthority))throw fail('authority_changed');
      const job={id:context.id,operation:context.operation,state:'handoff',createdAt:Date.now(),phase:'takeover'},base=context.base;
      const http=host.httpApi.create({id:context.id,port:context.serve.port,bindHost:context.serve.host,
        assertColdOwner:()=>context.assertExclusive(context.ownership)===true,readStatus:()=>({authority:current,job})});
      const hold=async error=>{
        latch(error);context.password=null;job.state=error?.operationMayHaveExecuted===true||helpers()?'uncertain':'failed';job.error=safeCode(error);
        current=null;try{const actual=full(await host.readAuthority(base));if(authority(actual))current=actual;}catch{ /* Do not report the pre-operation authority after a failed operation. */ }
        const seen=new Set();let value=error;for(let depth=0;depth<12&&value&&typeof value==='object'&&!seen.has(value);depth++){
          seen.add(value);try{if(typeof value.backupPath==='string'&&value.backupPath.length<=4096&&!/[\0\r\n]/.test(value.backupPath))job.backupPath=value.backupPath;value=value.cause;}catch{break;}
        }
        // Returning would run 13ai's ownership finally. Keep both the actual owner
        // and read-only listener alive until an explicit future recovery owner acts.
        await new Promise(()=>{});
      };
      try {
        await http.listen();
        const ops=host.operations({guardNative,helperMayStillRun:helpers,progress:async update=>{
          if(update?.id!==context.id||update.operation!==context.operation||typeof update.phase!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(update.phase))throw fail('progress_invalid');job.phase=update.phase;
        }});
        if(!ops||typeof ops.execute!=='function')throw fail('operations_unavailable');
        const result=await ops.execute(context);context.password=null;
        if(helpers())throw Object.assign(fail('native_helper_uncertain'),{helperMayStillRun:true});
        if(!result||result.id!==context.id||result.operation!==context.operation||!['published','verified'].includes(result.state)
          ||fold(await host.canonical(result.restartRoot))!==fold(await host.canonical(base)))throw fail('result_invalid');
        current=full(await host.readAuthority(base));if(!authority(current))throw fail('authority_invalid');
        const record=await host.resultApi.create({base,ownership:context.ownership,assertExclusive:context.assertExclusive,readAuthority:()=>host.readAuthority(base)}).read();
        if(!record||record.id!==context.id||record.operation!==context.operation||record.state!==result.state||!same(record.authority,current))throw fail('result_unverified');
        job.phase='restart';if(result.backup?.path)job.backupPath=result.backup.path;
        await http.close();return Object.freeze({id:context.id,operation:context.operation,base,listener:{...context.serve},expectedAuthority:current,backupPath:record.backup.path});
      }catch(error){return hold(error);}
    }
    async function launchSuccessor(result) {
      const spec=command('work-data-successor'),nonce=c.randomBytes(32).toString('hex');
      const common=host.workerApi.create({env:proc.env});
      const child=host.workerApi.spawnCold(spec,common.environment(result.base));
      const input={schema:1,id:result.id,parentPid:proc.pid,nonce,base:result.base,serve:result.listener,expectedAuthority:result.expectedAuthority};
      const readyMessage=new Promise((resolve,reject)=>{
        const cleanup=()=>{child.removeListener('message',message);child.removeListener('error',failed);child.removeListener('exit',exited);};
        const failed=()=>{cleanup();reject(fail('successor_launch_failed'));},exited=()=>{cleanup();reject(fail('successor_exited'));};
        const message=value=>{if(keys(value)!=='authority,host,id,kind,nonce,pid,port,schema'||value.schema!==1||value.kind!=='serve-ready'||value.id!==input.id||value.nonce!==nonce)return;
          if(value.pid!==child.pid||value.pid===proc.pid||value.port!==input.serve.port||value.host!==input.serve.host||!same(value.authority,input.expectedAuthority)){cleanup();reject(fail('successor_identity_invalid'));return;}
          cleanup();resolve(value);
        };
        child.on('message',message);child.once('error',failed);child.once('exit',exited);child.stdin.once('error',failed);
      });
      const bytes=Buffer.from(JSON.stringify(input));child.stdin.end(bytes,()=>bytes.fill(0));
      await readyMessage;return child;
    }
    async function holdAfterSuccessorFailure(result,error) {
      latch(error);let owner,http;
      try {
        owner=await host.acquire([result.base]);
        let current=null;try{const actual=full(await host.readAuthority(result.base));if(authority(actual))current=actual;}catch{ /* The expected authority is not a fresh observation. */ }
        const job={id:result.id,operation:result.operation,state:'uncertain',createdAt:Date.now(),phase:'restart',error:safeCode(error),backupPath:result.backupPath};
        http=host.httpApi.create({id:result.id,port:result.listener.port,bindHost:result.listener.host,assertColdOwner:()=>ownership(owner,result.base),readStatus:()=>({authority:current,job})});
        await http.listen();
      }catch{ /* Another exact owner/listener may already hold the successor. Never kill or retry it. */ }
      await new Promise(()=>{});
    }
    async function onOwnedFailure({error,ownership:owner,assertExclusive,base,input}) {
      latch(error);let current=null;
      try {const actual=full(await host.readAuthority(base));if(authority(actual))current=actual;}catch{ /* No expected-authority fallback. Status remains typed unavailable. */ }
      const job={id:input.id,operation:input.operation,state:'uncertain',createdAt:Date.now(),phase:'preflight',error:safeCode(error)};
      const http=host.httpApi.create({id:input.id,port:input.serve.port,bindHost:input.serve.host,assertColdOwner:()=>assertExclusive(owner)===true,
        readStatus:()=>({authority:current,job})});
      try {await http.listen();}catch{ /* The real source owner remains held even if progress cannot bind. */ }
      await new Promise(()=>{});
    }
    async function runCold(channel=host.workerApi.processChannel(proc)) {
      if(warm||coldStarted||successorStarted||!ready())throw fail('worker_unavailable');
      const claims=requireClaim();coldStarted=true;
      const cold=host.workerApi.create({pid:proc.pid,env:proc.env,setTimeout,clearTimeout,base:host.base,canonical:host.canonical,acquire:host.acquire,
        waitParentExit:host.workerApi.waitForProcessExit,readAuthority:host.readAuthority,execute,onOwnedFailure,helperMayStillRun:helpers,claim:claims});
      const result=await cold.runCold(channel);if(result?.phase==='cancelled')return result;
      // 13ai has now released its exact source owner. Its finally must finish
      // before a genuinely new normal-serve process can acquire the same base.
      try{const child=await launchSuccessor(result);child.unref();await host.exit(0);return child;}catch(error){return holdAfterSuccessorFailure(result,error);}
    }
    // Successor handoff is two phases so that the normal serve composition owns
    // acquire/inspect/bind/configure/inner/inbox/activate exactly once:
    //   prepare  - strict IPC input and its single strict-port options object
    //   complete - re-verify warm capture/readiness/root/port/authority/result,
    //              then publish serve-ready and drop the parent channel
    async function prepareSuccessor(channel=host.workerApi.processChannel(proc),{base}={}) {
      if(warm||coldStarted||successorStarted||slot.successor)throw fail('successor_unavailable');
      if(!channel||typeof channel.parentConnected!=='function'||typeof channel.readInput!=='function'||typeof channel.parentPid!=='function'
        ||channel.parentConnected()!==true)throw fail('successor_unavailable');
      if(typeof base!=='string'||!p.isAbsolute(base))throw fail('successor_input_invalid');
      const bytes=await channel.readInput(16384);let input;
      try{const raw=bytes.toString('utf8');if(!Buffer.from(raw).equals(bytes))throw fail('successor_input_invalid');input=JSON.parse(raw);}catch{throw fail('successor_input_invalid');}finally{bytes.fill(0);}
      if(keys(input)!=='base,expectedAuthority,id,nonce,parentPid,schema,serve'||input.schema!==1||!ID.test(input.id||'')||!NONCE.test(input.nonce||'')
        ||input.parentPid!==channel.parentPid()||input.parentPid===proc.pid||typeof input.base!=='string'||!p.isAbsolute(input.base)||!listener(input.serve)||!authority(input.expectedAuthority)
        ||fold(await host.canonical(input.base))!==fold(await host.canonical(base)))throw fail('successor_input_invalid');
      successorStarted=true;
      // This exact object identity is the only strict same-port ticket; a clone or
      // user-shaped {host,port} never reaches the listener.
      const options={host:input.serve.host,port:String(input.serve.port)};slot.strictOptions.add(options);
      slot.successor=Object.freeze({channel,input,options,phase:'prepared'});
      return options;
    }
    async function completeSuccessor() {
      const pending=slot.successor;if(!pending||pending.phase!=='prepared')throw fail('successor_not_prepared');
      const input=pending.input,channel=pending.channel;
      const stop=error=>{slot.successor=Object.freeze({...pending,phase:'failed'});throw error;};
      let captured;
      try {
        if(typeof channel.send!=='function')return stop(fail('successor_unavailable'));
        if(!warm)return stop(fail('successor_not_captured'));
        captured=warm;
        if(fold(captured.base)!==fold(await host.canonical(input.base)))return stop(fail('successor_not_captured'));
        actualListener(captured.server,input.serve);
        if(warm!==captured||!ready())return stop(fail('worker_unavailable'));
        const read=host.workerHooks?.readResult;
        const record=typeof read==='function'?await read():await readWarmResult(captured);
        if(!record||record.id!==input.id)return stop(fail('successor_result_unreadable'));
        if(!same(record.authority,input.expectedAuthority))return stop(fail('successor_result_changed'));
        const actual=full(await host.readAuthority(input.base));if(!same(actual,input.expectedAuthority))return stop(fail('successor_authority_changed'));
        await channel.send({schema:1,kind:'serve-ready',id:input.id,nonce:input.nonce,pid:proc.pid,port:input.serve.port,host:input.serve.host,authority:actual});
      } catch(error) { slot.successor=Object.freeze({...pending,phase:'failed'});throw error; }
      slot.successor=Object.freeze({...pending,phase:'complete'});
      if(typeof proc.disconnect==='function'&&proc.connected)proc.disconnect();
      return captured.server;
    }
    // Legacy composition kept for harnesses that still inject their own fresh
    // normal-serve entry; production uses 13au's startSuccessorMaintenance.
    async function runSuccessor(channel=host.workerApi.processChannel(proc)) {
      if(typeof host.startFreshServe!=='function')throw fail('successor_unavailable');
      const options=await prepareSuccessor(channel,{base:await host.base()});
      await host.startFreshServe(options);
      return completeSuccessor();
    }
    return Object.freeze({captureServe,activateServe,inspectBoot,runCold,runSuccessor,prepareSuccessor,completeSuccessor,workerReady:ready,
      strictSamePort:options=>slot.strictOptions.has(options),guardNative,helperMayStillRun:helpers});
  }
  return Object.freeze({create});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'));

// Only reviewed production adapters may configure the process runtime. Missing
// adapters leave the UI capability unavailable, while readonly startup guards
// still reject unfinished intent/result/control state before any warm binding.
if(typeof WorkDataMaintenanceRuntimeHooks!=='undefined'){
  let bound=null;
  const unavailable=()=>{throw Object.assign(Error('work_data_setup.worker_unavailable'),{code:'work_data_setup.worker_unavailable',retry:false});};
  // One successor slot and one strict-port ticket registry for this process. The
  // prepare phase runs before configure, the completion phase after it, and the
  // listener must still see the same registered options object.
  const slot={successor:null,strictOptions:new WeakSet()};
  // 13au installs the production claim API on this hooks object before the first
  // boot inspection, so the readonly pre-configure gate can classify handoffs too.
  const claimApi=()=>{const value=WorkDataMaintenanceRuntimeHooks.claim;
    return value&&typeof value==='object'&&['inspect','write','remove','classify'].every(name=>typeof value[name]==='function')?value:null;};
  // Readonly process composition used before configureServe: it may canonicalize,
  // inspect and classify, but it can never acquire, configure, mutate or exit.
  const readonly=(base)=>{
    const claim=claimApi();
    return WorkDataMaintenanceRuntime.create({process,workerHooks:{},workerApi:WorkDataMaintenanceWorker,httpApi:WorkDataMaintenanceHttp,resultApi:WorkDataMaintenanceResult,controlApi:WorkDataMaintenanceControl,
      base:async()=>base,canonical:ServerOwnership.canonicalRoot,acquire:ServerOwnership.acquire,readAuthority:requested=>WorkDataManifest.create({base:requested}).readActive(),
      assertOwnership:(owner,value)=>ServerOwnership.owns(owner,value),withColdSource:unavailable,withWarmSource:unavailable,adaptersReady:()=>false,helperMayStillRun:()=>false,
      isRetired:()=>false,operations:unavailable,stopUncommitted:unavailable,exit:unavailable,command:unavailable,
      ...(claim?{claim}:{legacyNoClaim:true})},slot);
  };
  Object.assign(WorkDataMaintenanceRuntimeHooks,{
    configure:host=>{if(bound)throw Object.assign(Error('work_data_setup.runtime_already_configured'),{code:'work_data_setup.runtime_already_configured'});bound=WorkDataMaintenanceRuntime.create(host,slot);return bound;},
    inspectBoot:context=>bound?bound.inspectBoot(context):readonly(context.base).inspectBoot(context),
    captureServe:context=>bound?bound.captureServe(context):false,
    activateServe:()=>bound?bound.activateServe():false,
    workerReady:()=>bound?bound.workerReady():false,
    // The prepared ticket lives in the shared slot, so it stays strict across the
    // pre-configure prepare and the configured listener.
    strictSamePort:options=>slot.strictOptions.has(options),
    prepareSuccessor:async(channel,options)=>{
      if(bound)return bound.prepareSuccessor(channel,options);
      if(!options||typeof options.base!=='string')throw Object.assign(Error('work_data_setup.successor_input_invalid'),{code:'work_data_setup.successor_input_invalid',retry:false});
      return readonly(options.base).prepareSuccessor(channel,options);
    },
    completeSuccessor:async()=>bound?bound.completeSuccessor():unavailable(),
    runCold:()=>bound?bound.runCold():unavailable(),runSuccessor:()=>bound?bound.runSuccessor():unavailable(),
  });
}
