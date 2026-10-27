// Explicit production host assembly. Loading this module only installs the
// maintenance-runtime hooks (no acquisition, configure, IO, ready or process
// startup); startServer calls acquireServe/configureServe explicitly.
const WorkDataRuntimeHost = ((p,util,clock) => {
  const retained=new Set(),capturedResultScopes=new WeakMap();
  const fail=(name,cause)=>Object.assign(Error('work_data_host.'+name),{code:'work_data_host.'+name,retry:false,...(cause===undefined?{}:{cause})});
  const fold=value=>process.platform==='win32'?value.toLowerCase():value;
  const inside=(root,target)=>{const rel=p.relative(fold(root),fold(target));return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);};
  function productionBindings(proc) {
    return {ownership:ServerOwnership,native:WorkDataVerifierEntry.createVerifier({proc}),uploads:WorkDataRestoreUploads,
      workerApi:WorkDataMaintenanceWorker,runtimeHooks:WorkDataMaintenanceRuntimeHooks,
      workerHooks:WorkDataMaintenanceWorkerHooks,httpApi:WorkDataMaintenanceHttp,resultApi:WorkDataMaintenanceResult,
      controlApi:WorkDataMaintenanceControl,coldOperations:WorkDataColdOperations,
      command(mode){if(!['work-data-maintenance','work-data-successor'].includes(mode))throw fail('command_invalid');const original=WorkDataVerifierEntry.command({proc});return Object.freeze({command:original.command,args:Object.freeze([...original.args.slice(0,-1),mode])});}};
  }
  function create({proc=process,bindings=productionBindings(proc),stopUncommitted,exit}={}) {
    if(!proc||!Number.isSafeInteger(proc.pid)||proc.pid<1||!bindings||!bindings.native
      ||['sourceKeeper','readAuthority','coldOperationHost','helperMayStillRun','flush'].some(k=>typeof bindings.native[k]!=='function')
      ||!bindings.ownership||['acquire','canonicalRoot','isLease','owns','isSourceKeeper','createSourceKeeper'].some(k=>typeof bindings.ownership[k]!=='function')
      ||!bindings.uploads||['create','isBroker'].some(k=>typeof bindings.uploads[k]!=='function')
      ||!bindings.coldOperations||typeof bindings.coldOperations.create!=='function'||typeof bindings.command!=='function')throw fail('bindings_invalid');
    const O=bindings.ownership,N=bindings.native,contexts=new Set(),byLease=new WeakMap(),jobs=new Set();
    let warm=null,cold=null,warmOpening=false,coldOpening=false,configuredRole=null,configuredBase=null,unknown=false,unknownCause,unknownSet=false,holdTimer=null,installed=false;
    const retain=(cause)=>{
      unknown=true;if(!unknownSet){unknownSet=true;unknownCause=cause;}retained.add(contexts);
      // Revoke and retain genuine ownership before even the fallible extra timer.
      for(const ctx of contexts)if(!ctx.finished){ctx.retained=true;try{ctx.keeper.retainUnknown(cause);}catch{ /* No expired-pin fallback, owner reacquisition or invented OS exclusion. */ }}
      if(holdTimer===null){try{holdTimer=clock.setInterval(()=>{void contexts;},60000);if(holdTimer&&typeof holdTimer.ref==='function')holdTimer.ref();}catch(timerError){retained.add({contexts,cause,timerError});}}
      return Object.assign(fail('source_uncertain',cause),{helperMayStillRun:true,ownershipRetained:true,operationMayHaveExecuted:true});
    };
    function helperUnknown(){if(unknown)return true;try{if(N.helperMayStillRun()!==false){retain(undefined);return true;}return false;}catch(error){retain(error);return true;}}
    function assertFinishSafe(){if(helperUnknown())throw Object.assign(fail('source_uncertain',unknownCause),{helperMayStillRun:true,ownershipRetained:true});return true;}
    function ensure(ctx){
      if(!ctx||ctx.finished)throw fail('source_closed');
      if(helperUnknown())throw Object.assign(fail('source_uncertain',unknownCause),{helperMayStillRun:true,ownershipRetained:true});
      if(ctx.retained||!O.isSourceKeeper(ctx.keeper,ctx.ownership,ctx.base)
        ||!ctx.keeper.assertExclusive(ctx.ownership)||!ctx.roots.every(root=>O.owns(ctx.ownership,root)))throw retain(fail('source_owner_lost'));
      return true;
    }
    async function canonical(value){if(typeof value!=='string'||!p.isAbsolute(value)||p.resolve(value)!==value)throw fail('base_invalid');const base=await O.canonicalRoot(value);if(typeof base!=='string'||!p.isAbsolute(base)||p.resolve(base)!==base)throw fail('base_invalid');return base;}
    function contextFor(owner,base){const ctx=byLease.get(owner);return ctx&&ctx.base===fold(base)&&!ctx.finished?ctx:null;}
    function assertOwnership(owner,base){const ctx=contextFor(owner,base);if(!ctx)return false;try{return ensure(ctx)===true;}catch{return false;}}
    function openContext(ownership,base,roots,role){
      if(!O.isLease(ownership)||!roots.every(root=>O.owns(ownership,root)))throw fail('genuine_owner_required');
      if(helperUnknown()){retained.add(ownership);try{const keeper=O.createSourceKeeper(ownership,base),saved={ownership,base,roots,keeper,role,finished:false,retained:false,accepting:false,inflight:new Set()};contexts.add(saved);byLease.set(ownership,saved);}catch{}throw retain(unknownCause);}
      if(byLease.has(ownership))throw fail('owner_already_bound');let keeper;
      try{keeper=N.sourceKeeper({base,ownership});}catch(error){
        // A helper can become unknown after acquire. Keep the just-acquired real
        // owner pinned, even when the adapter correctly refuses a new use grant.
        if(O.owns(ownership,base)){try{keeper=O.createSourceKeeper(ownership,base);const saved={ownership,base,roots,keeper,role,finished:false,retained:false,accepting:false,inflight:new Set()};contexts.add(saved);byLease.set(ownership,saved);}catch{ /* Existing genuine lease stays referenced below. */ }}
        retained.add(ownership);throw retain(error);
      }
      if(!O.isSourceKeeper(keeper,ownership,base))throw retain(fail('keeper_invalid'));
      const ctx={ownership,base,roots:Object.freeze([...roots]),keeper,role,finished:false,retained:false,accepting:true,inflight:new Set()};contexts.add(ctx);byLease.set(ownership,ctx);
      if(typeof keeper.releaseChecked!=='function'||typeof keeper.releaseOwner!=='function')throw retain(fail('checked_keeper_required'));
      ensure(ctx);return ctx;
    }
    const cleanUploadError=error=>{try{if(!error||util.types.isProxy(error))return false;const d=Object.getOwnPropertyDescriptor(error,'code');return!!d&&Object.hasOwn(d,'value')&&/^(?:work_data_upload\.(?:sealed_required|capacity|grant_unavailable|grant_consumed)|work_data_recovery\.invalid)$/.test(d.value);}catch{return false;}};
    async function scoped(ctx,work,{newAdmission=false,cleanFailure=false}={}){
      ensure(ctx);if(!ctx.accepting&&newAdmission)throw fail('source_closing');let pin=null;
      if(newAdmission){pin=N.sourceKeeper({base:ctx.base,ownership:ctx.ownership});if(!O.isSourceKeeper(pin,ctx.ownership,ctx.base))throw retain(fail('keeper_invalid'));}
      let primary,failed=false;
      try{const value=await work();ensure(ctx);return value;}
      catch(error){failed=true;primary=error;if(helperUnknown()||!cleanFailure||!cleanUploadError(error))throw retain(error);throw error;}
      finally{if(pin){if(unknown){try{pin.retainUnknown(failed?primary:undefined);}catch{}}else{try{await pin.releaseChecked(assertFinishSafe);ensure(ctx);}catch(error){throw retain(failed?new AggregateError([primary,error],'Source scope cleanup failed.',{cause:primary}):error);}}}}
    }
    function operation(ctx,work,options){let pending;pending=scoped(ctx,work,options);ctx.inflight.add(pending);pending.then(()=>ctx.inflight.delete(pending),()=>ctx.inflight.delete(pending));return pending;}
    async function openWarm({base,uploadRoot,ownership}){
      if(warm||cold||installed||warmOpening||coldOpening||configuredRole==='cold')throw fail('warm_already_bound');warmOpening=true;
      try{base=fold(await canonical(base));uploadRoot=fold(await canonical(uploadRoot));
      if(inside(base,uploadRoot)||inside(uploadRoot,base))throw fail('upload_root_invalid');const ctx=openContext(ownership,base,[base,uploadRoot],'warm');warm=ctx;
      try{ctx.broker=await scoped(ctx,()=>bindings.uploads.create({base,root:uploadRoot,ownership,assertExclusive:value=>assertOwnership(value,base)&&O.owns(value,uploadRoot),flush:directories=>operation(ctx,()=>N.flush(directories))}));if(!bindings.uploads.isBroker(ctx.broker))throw retain(fail('broker_invalid'));ensure(ctx);}
      catch(error){throw unknown?error:retain(error);}
      const putUpload=bytes=>operation(ctx,()=>ctx.broker.put(bytes),{newAdmission:true,cleanFailure:true});
      const resolveUpload=(id,options)=>operation(ctx,()=>ctx.broker.resolveUpload(id,options),{newAdmission:true,cleanFailure:true});
      const readAuthority=()=>operation(ctx,()=>N.readAuthority(base),{newAdmission:true});
      const readResult=()=>operation(ctx,()=>bindings.resultApi.create({base,ownership,assertExclusive:value=>assertOwnership(value,base),readAuthority:()=>N.readAuthority(base)}).read(),{newAdmission:true});
      async function close(){if(ctx.finished)return;if(unknown)throw retain(unknownCause);ctx.accepting=false;if(jobs.size)throw fail('job_active');await Promise.allSettled([...ctx.inflight]);ensure(ctx);try{await ctx.keeper.releaseChecked(assertFinishSafe);assertFinishSafe();ctx.finished=true;}catch(error){throw retain(error);}}
      ctx.api=Object.freeze({base,uploadRoot,ownership,putUpload,resolveUpload,readAuthority,readResult,close,
        // Status is data, never a capability or substitute for a genuine keeper.
        status:()=>Object.freeze({sourceHeld:assertOwnership(ownership,base),uploadOwnerHeld:O.owns(ownership,uploadRoot),accepting:ctx.accepting&&!unknown&&!ctx.finished,workerReady:false,crashClaim:false,activation:false})});
      return ctx.api;}finally{warmOpening=false;}
    }
    async function coldAcquire(requested,expectedBase){
      if(helperUnknown())throw fail('native_helper_uncertain');if(warm||warmOpening||!Array.isArray(requested)||requested.length<1||requested.length>2||cold&&!cold.finished||coldOpening)throw fail('cold_owner_invalid');coldOpening=true;try{
      const roots=[];for(const value of requested)roots.push(fold(await canonical(value)));if(new Set(roots).size!==roots.length||roots.length===2&&(inside(roots[0],roots[1])||inside(roots[1],roots[0])))throw fail('cold_owner_invalid');
      if(roots[0]!==expectedBase)throw fail('cold_base_changed');const ownership=await O.acquire(roots);cold=openContext(ownership,roots[0],roots,'cold');return ownership;}finally{coldOpening=false;}
    }
    async function withColdSource(context,work){const ctx=contextFor(context?.ownership,context?.base);if(!ctx||ctx.role!=='cold'||typeof work!=='function')throw fail('cold_source_required');ensure(ctx);
      try{const value=await work();ensure(ctx);await ctx.keeper.releaseOwner(assertFinishSafe);assertFinishSafe();ctx.finished=true;return value;}catch(error){throw retain(error);}
    }
    async function withWarmSource(request,work){
      const ctx=warm;if(!ctx||!ctx.accepting||jobs.size||typeof work!=='function')throw fail('warm_job_unavailable');ensure(ctx);
      const pin=N.sourceKeeper({base:ctx.base,ownership:ctx.ownership});if(!O.isSourceKeeper(pin,ctx.ownership,ctx.base))throw retain(fail('keeper_invalid'));
      const job={pin,committed:false,finished:false};jobs.add(job);let handle;
      try{handle=await work();ensure(ctx);if(!handle||!handle.ready||typeof handle.ready.then!=='function'||typeof handle.cancel!=='function'||typeof handle.handoff!=='function')throw fail('worker_contract_invalid');}
      catch(error){throw retain(error);}
      const ready=Promise.resolve(handle.ready).then(value=>{ensure(ctx);return value;});void ready.catch(()=>{});
      return Object.freeze({ready,async cancel(){if(job.committed)throw fail('handoff_committed');if(job.finished)return;try{await handle.cancel();ensure(ctx);await pin.releaseChecked(assertFinishSafe);ensure(ctx);job.finished=true;jobs.delete(job);}catch(error){throw retain(error);}},async handoff(){if(job.finished||job.committed)throw fail('handoff_invalid');ensure(ctx);job.committed=true;try{await handle.handoff();}catch(error){throw retain(error);}throw retain(fail('parent_exit_returned'));}});
    }
    function runtimeHost({base,role}){
      if(!['warm','cold'].includes(role)||typeof base!=='string'||!p.isAbsolute(base))throw fail('runtime_options_invalid');base=fold(p.resolve(base));if(role==='warm'&&(!warm||warm.base!==base))throw fail('warm_source_required');if(role==='cold'&&(warm||warmOpening))throw fail('cold_source_required');
      if(configuredRole!==null&&(configuredRole!==role||configuredBase!==base))throw fail('runtime_already_bound');configuredRole=role;configuredBase=base;
      const host={process:proc,workerApi:bindings.workerApi,httpApi:bindings.httpApi,resultApi:bindings.resultApi,controlApi:bindings.controlApi,workerHooks:bindings.workerHooks,
        base:async()=>base,canonical:O.canonicalRoot,acquire:roots=>coldAcquire(roots,base),assertOwnership,withColdSource,withWarmSource,bindCapturedResult,
        readAuthority:requested=>{const ctx=role==='warm'?warm:cold;if(!ctx||fold(requested)!==ctx.base)throw fail('source_required');return operation(ctx,()=>N.readAuthority(ctx.base),{newAdmission:role==='warm'});},
        operations:({progress})=>{if(typeof progress!=='function')throw fail('progress_invalid');return bindings.coldOperations.create(N.coldOperationHost(progress));},
        // Missing crash recovery, activation and final source/IO gates cannot be
        // substituted with a caller-provided true or a successful configure.
        adaptersReady:()=>false,isRetired:()=>false,helperMayStillRun:helperUnknown,command:bindings.command,
        stopUncommitted:child=>{if(typeof stopUncommitted!=='function')throw fail('stop_adapter_unavailable');return stopUncommitted(child);},
        exit:async code=>{if(helperUnknown())throw retain(unknownCause);if(role==='warm'||code!==0||!cold||!cold.finished||O.owns(cold.ownership))throw fail('exit_adapter_unavailable');if(typeof exit!=='function')throw fail('exit_adapter_unavailable');await exit(code);throw retain(fail('process_exit_returned'));},
        ...(role==='warm'?{uploads:warm.broker}:{})};
      const registered=Object.freeze(host);
      // Only this exact private host identity can bind a capture reader. Neither
      // an existing hook nor a similarly shaped host conveys source authority.
      if(role==='warm')capturedResultScopes.set(registered,(capturedBase,owner,read)=>{
        if(typeof capturedBase!=='string'||fold(capturedBase)!==warm.base||owner!==warm.ownership||typeof read!=='function')throw fail('captured_source_required');
        ensure(warm);return ()=>operation(warm,read,{newAdmission:true});
      });
      return registered;
    }
    function installWarm(){
      if(installed||!warm||warm.finished)throw fail('runtime_already_installed');ensure(warm);const hooks=bindings.workerHooks;
      if(!hooks||util.types.isProxy(hooks)||Object.getPrototypeOf(hooks)!==Object.prototype||typeof bindings.runtimeHooks?.configure!=='function'
        ||Object.hasOwn(hooks,'start'))throw fail('worker_hooks_invalid');
      const descriptors={putUpload:{value:warm.api.putUpload,writable:true,configurable:true,enumerable:true},resolveUpload:{value:warm.api.resolveUpload,writable:true,configurable:true,enumerable:true},readResult:{value:warm.api.readResult,writable:true,configurable:true,enumerable:true}};
      for(const name of Object.keys(descriptors)){const old=Object.getOwnPropertyDescriptor(hooks,name);if(old&&!old.configurable||!old&&!Object.isExtensible(hooks))throw fail('worker_hooks_invalid');}
      const host=runtimeHost({base:warm.base,role:'warm'});let runtime;try{runtime=bindings.runtimeHooks.configure(host);Object.defineProperties(hooks,descriptors);installed=true;}catch(error){throw retain(error);}ensure(warm);
      return Object.freeze({host,runtime,capabilities:Object.freeze({upload:true,worker:false,download:false,crashClaim:false,activation:false})});
    }
    return Object.freeze({openWarm,runtimeHost,installWarm,assertOwnership,helperMayStillRun:helperUnknown,
      capabilities:Object.freeze({requiresCheckedSourceKeeper:true,sourceKeeperHost:true,uploadBrokerAssembly:true,coldOperationAssembly:true,worker:false,crashClaim:false,activation:false,productionReady:false})});
  }
  function bindCapturedResult(host,base,ownership,read){
    const bind=capturedResultScopes.get(host);
    // A legacy host retains Runtime's original default read contract. No
    // property of an unregistered host, Proxy or existing hook is consulted.
    return bind?bind(base,ownership,read):null;
  }
  return Object.freeze({create,bindCapturedResult});
})(require('node:path'),require('node:util'),require('node:timers'));

// Actual normal-serve wiring. Definition/configuration alone performs no IO.
// Only acquireServe allocates its own empty custody root and acquires the joint
// genuine owner before broker/configuration writes. No worker capability is set.
const WorkDataServeUploadBootstrap = ((io,p,osApi,clock) => {
  const retained=new Set(),fold=value=>process.platform==='win32'?value.toLowerCase():value;
  const fail=(name,cause)=>Object.assign(Error('work_data_bootstrap.'+name),{code:'work_data_bootstrap.'+name,retry:false,...(cause===undefined?{}:{cause})});
  const inside=(root,file)=>{const rel=p.relative(fold(root),fold(file));return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);};
  const identity=st=>({dev:String(st.dev),ino:String(st.ino)});
  async function directory(root){
    const full=p.resolve(root),parsed=p.parse(full);let cursor=parsed.root;const rows=[];
    for(const part of ['',...full.slice(cursor.length).split(p.sep).filter(Boolean)]){
      if(part)cursor=p.join(cursor,part);const st=await io.lstat(cursor,{bigint:true});
      if(!st.isDirectory()||st.isSymbolicLink()||st.reparsePoint===true||typeof st.reparseTag==='number'&&st.reparseTag!==0||fold(await io.realpath(cursor))!==fold(cursor))throw fail('upload_root_alias');
      rows.push({file:cursor,...identity(st)});
    }return rows;
  }
  function nativeHelperMayStillRun(){
    try{
      if(typeof LocalSecretCrypto!=='undefined'){const inspect=LocalSecretCrypto.helperMayStillRun;if(inspect!==undefined&&(typeof inspect!=='function'||inspect.call(LocalSecretCrypto)!==false))return true;}
      if(typeof MigrationHooks!=='undefined'){const inspect=MigrationHooks.helperMayStillRun;if(inspect!==undefined&&(typeof inspect!=='function'||inspect.call(MigrationHooks)!==false))return true;}
      return false;
    }catch{return true;}
  }
  function create({ownership=ServerOwnership,hostApi=WorkDataRuntimeHost,proc=process,temp=osApi.tmpdir(),inspectNative=nativeHelperMayStillRun}={}){
    if(!ownership||['acquire','canonicalRoot','isLease','owns','createSourceKeeper','isSourceKeeper'].some(k=>typeof ownership[k]!=='function')||typeof hostApi?.create!=='function'
      ||!proc||!Number.isSafeInteger(proc.pid)||proc.pid<1||typeof temp!=='string'||!p.isAbsolute(temp)||typeof inspectNative!=='function')throw fail('host_invalid');
    const issued=new WeakMap(),records=new Set();let opening=false,attempted=false,unknown=false,holdTimer=null;
    function retain(row,cause){unknown=true;if(row){row.uncertain=true;if(!row.failureSet){row.failureSet=true;row.failure=cause;}}retained.add({records,row,cause});
      if(holdTimer===null){try{holdTimer=clock.setInterval(()=>{void records;},60000);holdTimer?.ref?.();}catch(error){retained.add({records,row,cause,error});}}
      return Object.assign(fail('source_uncertain',cause),{helperMayStillRun:true,ownershipRetained:true,operationMayHaveExecuted:true});
    }
    function helperMayStillRun(){
      if(unknown)return true;
      try{if(inspectNative()!==false){retain(null,undefined);return true;}}catch(error){retain(null,error);return true;}
      for(const row of records){
        if(['acquired','warm','unavailable'].includes(row.phase)&&row.ownership){
          try{if(!row.originalRoots.every(root=>ownership.owns(row.ownership,root))||row.uploadRoot&&!ownership.owns(row.ownership,row.uploadRoot)
            ||row.phase==='acquired'&&!ownership.isSourceKeeper(row.bootPin,row.ownership,row.base)){retain(row,fail('serve_owner_changed'));return true;}}
          catch(error){retain(row,error);return true;}
        }
        if(row.factory){try{if(row.factory.helperMayStillRun()!==false){retain(row,undefined);return true;}}catch(error){retain(row,error);return true;}}
      }
      return false;
    }
    async function acquireServe({base,roots}={}){
      if(attempted||opening)throw fail('already_started');
      if(typeof base!=='string'||!p.isAbsolute(base)||!Array.isArray(roots)||!roots.length||roots.some(x=>typeof x!=='string'||!p.isAbsolute(x)))throw fail('roots_invalid');
      opening=true;attempted=true;let row;
      try{
        const canonicalBase=await ownership.canonicalRoot(base),originalRoots=[...new Set(await Promise.all(roots.map(x=>ownership.canonicalRoot(x))))];
        if(!originalRoots.some(x=>fold(x)===fold(canonicalBase)))throw fail('base_not_owned');
        const parent=await ownership.canonicalRoot(p.resolve(temp));
        row={base:canonicalBase,originalRoots,uploadRoot:null,parent,parentChain:null,rootChain:null,ownership:null,bootPin:null,phase:'allocating',factory:null,session:null,installed:false,uncertain:false,reason:null};records.add(row);
        // The current durable native flush adapter is Windows-only. An unusual
        // base containing the entire tool temp namespace cannot have disjoint
        // custody there. Both cases retain the existing unavailable capability.
        if(proc.platform!=='win32')row.reason='native_upload_adapter_unavailable';
        else if(originalRoots.some(root=>inside(root,parent)||inside(parent,root)&&fold(root)===fold(parent)))row.reason='disjoint_upload_root_unavailable';
        else{
          row.parentChain=await directory(parent);const root=await io.mkdtemp(p.join(parent,'ruyi-work-data-upload-'));
          if(JSON.stringify(await directory(parent))!==JSON.stringify(row.parentChain))throw fail('upload_parent_changed');
          row.uploadRoot=await ownership.canonicalRoot(root);row.rootChain=await directory(row.uploadRoot);
          if(p.dirname(row.uploadRoot)!==parent||!p.basename(row.uploadRoot).startsWith('ruyi-work-data-upload-')
            ||originalRoots.some(value=>inside(value,row.uploadRoot)||inside(row.uploadRoot,value))||(await io.readdir(row.uploadRoot)).length)throw fail('upload_root_not_fresh');
        }
        row.ownership=await ownership.acquire(row.uploadRoot?[...originalRoots,row.uploadRoot]:originalRoots);
        if(!ownership.isLease(row.ownership)||!originalRoots.every(root=>ownership.owns(row.ownership,root))||row.uploadRoot&&!ownership.owns(row.ownership,row.uploadRoot))throw retain(row,fail('genuine_owner_required'));
        row.bootPin=ownership.createSourceKeeper(row.ownership,row.base);row.phase='acquired';
        if(!ownership.isSourceKeeper(row.bootPin,row.ownership,row.base))throw retain(row,fail('genuine_owner_required'));
        issued.set(row.ownership,row);return row.ownership;
      }catch(error){
        if(error?.ownershipRetained===true||error?.helperMayStillRun===true||helperMayStillRun())throw retain(row,error);
        // Never remove or reuse an allocated root, and never repair another
        // owner's data after a rejected joint acquire. No broker was created.
        throw error;
      }finally{opening=false;}
    }
    async function configureServe({base,ownership:owner}={}){
      const row=issued.get(owner);if(!row||row.ownership!==owner||row.phase!=='acquired'||row.installed||row.factory)throw fail('serve_owner_unavailable');
      const canonical=await ownership.canonicalRoot(base);
      if(!row.originalRoots.some(value=>fold(value)===fold(canonical))||!ownership.isLease(owner)||!row.originalRoots.every(root=>ownership.owns(owner,root)))throw fail('serve_owner_changed');
      if(helperMayStillRun())throw retain(row,undefined);
      if(!row.uploadRoot){row.phase='unavailable';await row.bootPin.releaseChecked(()=>{if(helperMayStillRun())throw retain(row,undefined);return true;});row.bootPin=null;return false;}
      if(!ownership.owns(owner,row.uploadRoot)||JSON.stringify(await directory(row.uploadRoot))!==JSON.stringify(row.rootChain)||(await io.readdir(row.uploadRoot)).length)throw fail('upload_root_changed');
      row.factory=hostApi.create({proc});
      try{
        row.session=await row.factory.openWarm({base:canonical,uploadRoot:row.uploadRoot,ownership:owner});
        if(helperMayStillRun())throw retain(row,undefined);
        if(JSON.stringify(await directory(row.uploadRoot))!==JSON.stringify(row.rootChain))throw fail('upload_root_changed');
        const installed=row.factory.installWarm();
        if(!installed||installed.capabilities?.upload!==true||installed.capabilities.worker!==false||installed.capabilities.download!==false||installed.capabilities.crashClaim!==false||installed.capabilities.activation!==false)throw fail('installed_capabilities_invalid');
        if(helperMayStillRun())throw retain(row,undefined);
        // The configured host now holds its own checked source pin. Transfer
        // lifetime coverage without any unpinned await or owner-release window.
        row.phase='warm';await row.bootPin.releaseChecked(()=>{if(helperMayStillRun())throw retain(row,undefined);return true;});row.bootPin=null;
        if(helperMayStillRun())throw retain(row,undefined);row.installed=true;return true;
      }catch(error){if(helperMayStillRun()||error?.helperMayStillRun===true||error?.ownershipRetained===true)throw retain(row,error);throw error;}
    }
    async function abortUnconfigured({ownership:owner}={}){
      const row=issued.get(owner);if(!row||row.phase!=='acquired'||row.factory||row.installed)throw fail('abort_unavailable');
      if(helperMayStillRun())throw retain(row,undefined);
      row.phase='closing';
      try{
        await row.bootPin.releaseOwner(()=>{if(helperMayStillRun())throw retain(row,undefined);return true;});
        row.bootPin=null;row.phase='closed';if(helperMayStillRun())throw retain(row,undefined);return true;
      }catch(error){throw retain(row,error);}
    }
    function inspect(owner){const row=issued.get(owner);return row?Object.freeze({installed:row.installed,uploadRoot:row.uploadRoot,sourceHeld:ownership.owns(owner,row.base),uploadOwnerHeld:row.uploadRoot!==null&&ownership.owns(owner,row.uploadRoot),reason:row.reason,phase:row.phase,uncertain:unknown||row.uncertain,worker:false,crashClaim:false,activation:false}):null;}
    return Object.freeze({acquireServe,configureServe,abortUnconfigured,helperMayStillRun,inspect});
  }
  return Object.freeze({create});
})(require('node:fs/promises'),require('node:path'),require('node:os'),require('node:timers'));

if(typeof WorkDataMaintenanceRuntimeHooks!=='undefined'){
  const serveUploads=WorkDataServeUploadBootstrap.create();
  Object.assign(WorkDataMaintenanceRuntimeHooks,{acquireServe:serveUploads.acquireServe,configureServe:serveUploads.configureServe,abortUnconfiguredServe:serveUploads.abortUnconfigured,helperMayStillRun:serveUploads.helperMayStillRun});
}
