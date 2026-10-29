// Explicit production host assembly. Loading this module only installs the
// maintenance-runtime hooks (no acquisition, configure, IO, ready or process
// startup); startServer calls acquireServe/configureServe explicitly.
const WorkDataRuntimeHost = ((p,util,clock,io,c) => {
  const retained=new Set(),capturedResultScopes=new WeakMap();
  const MODES=Object.freeze(['work-data-maintenance','work-data-successor']);
  const IMPLEMENTED=Object.freeze(['native-flush-adapter','full-snapshot-adapter','cold-verifier-protocol','genuine-source-keeper']);
  const STOP_TIMEOUT_MS=5000;
  const fail=(name,cause)=>Object.assign(Error('work_data_host.'+name),{code:'work_data_host.'+name,retry:false,...(cause===undefined?{}:{cause})});
  const fold=value=>process.platform==='win32'?value.toLowerCase():value;
  const inside=(root,target)=>{const rel=p.relative(fold(root),fold(target));return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);};
  const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&!util.types.isProxy(value);
  const read=(object,name)=>{try{return object===null||typeof object!=='object'?undefined:object[name];}catch{return undefined;}};
  const methods=(object,names)=>plain(object)&&names.every(name=>typeof read(object,name)==='function');
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  // One boot-preference owner for the whole process. 13aw currently precedes this
  // module, but installation stays idempotent and is retried at the first host binding
  // as defence against a future reordering, never depending on script order. The owner
  // is created with the user's home directory and the same native flush as the
  // claim/activation owners; an existing instance is never replaced and a missing
  // module leaves the capability unset (the post-ready preference write then stays
  // diagnosis only).
  function installRootPreference(){
    const hooks=typeof WorkDataMaintenanceRuntimeHooks==='undefined'?null:WorkDataMaintenanceRuntimeHooks;
    if(!hooks)return null;
    if(hooks.rootPreference)return hooks.rootPreference;
    const module=typeof WorkDataRootPreference!=='undefined'?WorkDataRootPreference:null;
    if(!module||typeof module.create!=='function'||typeof WorkDataVerifierEntry==='undefined')return null;
    const native=WorkDataVerifierEntry.createVerifier({proc:process}),home=require('node:os').homedir(),flush=directories=>native.flush(directories);
    const owner=module.create({home,flush});
    // 13aw validates its home directory and record codec at create time; an unusable
    // owner is never installed, and no second instance is ever minted.
    if(!owner||typeof owner!=='object'||Array.isArray(owner)||!['inspect','write','remove'].every(name=>typeof owner[name]==='function'))return null;
    // The store keeps its eight-key codec at module level. Publish that same judge on
    // the one installed owner so the runtime validates with the store's codec instead
    // of copying the record shape; an owner that already carries validate keeps it.
    const installed=typeof owner.validate==='function'?owner:typeof module.validate==='function'
      ?Object.freeze({inspect:observation=>owner.inspect(observation),write:(value,previous)=>owner.write(value,previous),
        remove:receipt=>owner.remove(receipt),validate:value=>module.validate(value)})
      :null;
    if(!installed)return null;
    hooks.rootPreference=installed;
    return installed;
  }
  function productionBindings(proc) {
    const native=WorkDataVerifierEntry.createVerifier({proc});
    return {ownership:ServerOwnership,native,uploads:WorkDataRestoreUploads,
      workerApi:WorkDataMaintenanceWorker,runtimeHooks:WorkDataMaintenanceRuntimeHooks,
      workerHooks:WorkDataMaintenanceWorkerHooks,httpApi:WorkDataMaintenanceHttp,resultApi:WorkDataMaintenanceResult,
      controlApi:WorkDataMaintenanceControl,coldOperations:WorkDataColdOperations,
      // Retirement evidence is the live maintenance drain record, never configure success.
      maintenance:typeof WorkDataMaintenanceHooks==='undefined'?null:WorkDataMaintenanceHooks,
      // The one claim instance installed on the runtime hooks by this module's tail.
      // Never mint a parallel owner here: an absent instance leaves the worker unready.
      claim:typeof WorkDataMaintenanceRuntimeHooks==='undefined'?null:WorkDataMaintenanceRuntimeHooks.claim||null,
      // The one fresh-root activation owner installed on the runtime hooks by this
      // module's tail. Reused as-is; an absent instance keeps the restore handoff closed.
      activation:typeof WorkDataMaintenanceRuntimeHooks==='undefined'?null:WorkDataMaintenanceRuntimeHooks.activation||null,
      // The one boot-preference owner for this process, installed on first use.
      rootPreference:installRootPreference(),
      command(mode){if(!MODES.includes(mode))throw fail('command_invalid');const original=WorkDataVerifierEntry.command({proc});return Object.freeze({command:original.command,args:Object.freeze([...original.args.slice(0,-1),mode])});}};
  }
  function create({proc=process,bindings=productionBindings(proc),stopUncommitted,exit}={}) {
    if(!proc||!Number.isSafeInteger(proc.pid)||proc.pid<1||!plain(bindings)||!bindings.native
      ||['sourceKeeper','readAuthority','coldOperationHost','helperMayStillRun','flush'].some(k=>typeof read(bindings.native,k)!=='function')
      ||!bindings.ownership||['acquire','canonicalRoot','isLease','owns','isSourceKeeper','createSourceKeeper'].some(k=>typeof read(bindings.ownership,k)!=='function')
      ||!bindings.uploads||['create','isBroker'].some(k=>typeof read(bindings.uploads,k)!=='function')
      ||!bindings.coldOperations||typeof read(bindings.coldOperations,'create')!=='function'||typeof read(bindings,'command')!=='function'
      ||stopUncommitted!==undefined&&typeof stopUncommitted!=='function'||exit!==undefined&&typeof exit!=='function')throw fail('bindings_invalid');
    const O=bindings.ownership,N=bindings.native,contexts=new Set(),byLease=new WeakMap(),jobs=new Set(),children=new Set();
    // Only children this factory actually spawned can be stopped. Membership is the
    // registered object identity: a clone or Proxy of a genuine child cannot borrow it.
    const workerApi=Object.freeze({
      create(options){return bindings.workerApi.create(options);},
      spawnCold(command,env){const child=bindings.workerApi.spawnCold(command,env);if(plain(child))children.add(child);return child;},
      processChannel(target){return bindings.workerApi.processChannel(target);},
      waitForProcessExit(pid,options){return bindings.workerApi.waitForProcessExit(pid,options);}});
    const stopAdapter=typeof stopUncommitted==='function'?stopUncommitted:null;
    const exitAdapter=typeof exit==='function'?exit:code=>proc.exit(code);
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
    // Every readiness/retirement read below is synchronous live state. Nothing here
    // performs IO, configure, migration or base/authority prefetch, and a successful
    // configure never promotes itself into readiness.
    function sourceHealthy(ctx){
      try{
        return !!ctx&&!ctx.finished&&!ctx.retained&&ctx.accepting===true
          &&O.isSourceKeeper(ctx.keeper,ctx.ownership,ctx.base)===true
          &&ctx.keeper.assertExclusive(ctx.ownership)===true
          &&ctx.roots.every(root=>O.owns(ctx.ownership,root));
      }catch{return false;}
    }
    function commandIdentity(){
      const executable=typeof proc.execPath==='string'&&p.isAbsolute(proc.execPath)?fold(proc.execPath):null;
      if(!executable)return null;
      // The verifier entry itself is re-derived from the current executable and
      // entry, never from a remembered configure result. A fixture without the
      // verifier module models the already-bound command through the adapter.
      let verifier=null;
      if(typeof WorkDataVerifierEntry!=='undefined'){
        try{verifier=WorkDataVerifierEntry.command({proc});}catch{return null;}
        if(!plain(verifier)||typeof verifier.command!=='string'||fold(verifier.command)!==executable
          ||!Array.isArray(verifier.args)||util.types.isProxy(verifier.args)||verifier.args.length<1
          ||verifier.args.length>2||verifier.args.some(arg=>typeof arg!=='string'))return null;
      }
      let shared=null,sharedCommand=null;
      for(const mode of MODES){
        let value;try{value=bindings.command(mode);}catch{return null;}
        if(!plain(value))return null;
        const command=read(value,'command'),args=read(value,'args');
        if(typeof command!=='string'||!p.isAbsolute(command)||fold(command)!==executable)return null;
        if(!Array.isArray(args)||util.types.isProxy(args)||args.length<1||args.length>2)return null;
        const vector=[];
        for(const arg of args){if(typeof arg!=='string')return null;vector.push(arg);}
        if(vector[vector.length-1]!==mode)return null;
        if(vector.length===2&&!p.isAbsolute(vector[0]))return null;
        if(shared===null){shared=vector;sharedCommand=command;}
        else if(shared.length!==vector.length||fold(command)!==fold(sharedCommand)
          ||vector.some((item,index)=>index<shared.length-1&&fold(item)!==fold(shared[index])))return null;
      }
      if(verifier!==null){
        const prefix=verifier.args.slice(0,-1);
        if(prefix.length!==shared.length-1||prefix.some((arg,index)=>fold(arg)!==fold(shared[index])))return null;
      }
      return Object.freeze({executable:proc.execPath,entry:shared.length===2?shared[0]:null,packaged:shared.length===1});
    }
    function driversReady(){
      const native=bindings.native;
      if(!methods(native,['sourceKeeper','readAuthority','coldOperationHost','helperMayStillRun','flush']))return false;
      const capabilities=read(native,'capabilities');
      if(!plain(capabilities))return false;
      const implemented=read(capabilities,'implemented');
      if(!Array.isArray(implemented)||util.types.isProxy(implemented)||IMPLEMENTED.some(name=>implemented.indexOf(name)<0))return false;
      if(read(capabilities,'verifierCommandBound')!==true)return false;
      if(!methods(bindings.resultApi,['create']))return false;
      if(!methods(bindings.controlApi,['create']))return false;
      if(!methods(bindings.workerApi,['create','spawnCold','processChannel','waitForProcessExit']))return false;
      if(!methods(bindings.claim,['inspect','write','remove','classify']))return false;
      if(!methods(bindings.uploads,['create','isBroker']))return false;
      return commandIdentity()!==null;
    }
    function adaptersReadyFor(role){
      try{
        if(!driversReady()||helperUnknown())return false;
        if(role==='warm')return installed===true&&sourceHealthy(warm);
        // Cold: adapters plus, once acquired, the same live keeper. No warm source
        // exists yet and the base is never read or canonicalized here.
        if(warm||warmOpening||installed)return false;
        return cold===null||sourceHealthy(cold);
      }catch{return false;}
    }
    function maintenanceSnapshot(){
      const source=bindings.maintenance;
      if(!methods(source,['status']))return null;
      let status;try{status=source.status();}catch{return null;}
      if(!plain(status))return null;
      const phase=read(status,'phase'),busy=read(status,'busy');
      const admitted=count(read(status,'admitted')),writers=count(read(status,'writers')),dirty=count(read(status,'dirty'));
      if(typeof phase!=='string'||!plain(busy)||admitted===null||writers===null||dirty===null)return null;
      const copy={};
      for(const name of Object.keys(busy)){const value=count(read(busy,name));if(value===null)return null;copy[name]=value;}
      return Object.freeze({phase,admitted,writers,dirty,busy:Object.freeze(copy)});
    }
    function retiredFor(role){
      try{
        if(role!=='warm')return null;
        if(installed!==true||!sourceHealthy(warm))return null;
        if(warm.inflight.size!==0)return null;
        // The committed handoff job is still registered in `jobs` while 13ai calls
        // exitParent; a retired receipt therefore never consults jobs.size.
        if(helperUnknown())return null;
        const status=maintenanceSnapshot();
        if(!status||status.phase!=='retired')return null;
        if(status.admitted!==0||status.writers!==0||status.dirty!==0||Object.values(status.busy).some(value=>value!==0))return null;
        return Object.freeze({phase:'retired',admitted:0,writers:0,dirty:0,busy:status.busy,inflight:0,installed:true,keeper:true,owner:true,helper:false});
      }catch{return null;}
    }
    function actualExit(child,ms){
      return new Promise(resolve=>{
        let settled=false,timer=null;
        const exited=()=>{const code=read(child,'exitCode'),signal=read(child,'signalCode');return code!==null&&code!==undefined||signal!==null&&signal!==undefined;};
        const finish=value=>{if(settled)return;settled=true;if(timer!==null){try{clock.clearTimeout(timer);}catch{}}try{child.removeListener('exit',onExit);child.removeListener('error',onError);}catch{}resolve(value);};
        const onExit=()=>finish('exit'),onError=()=>finish('error');
        if(exited())return resolve('exit');
        try{
          timer=clock.setTimeout(()=>finish('timeout'),ms);if(timer&&typeof timer.ref==='function')timer.ref();
          child.once('exit',onExit);child.once('error',onError);
        }catch{return finish('error');}
        if(exited())finish('exit');
      });
    }
    async function stopDefault(child){
      if(!children.has(child)||!plain(child))throw fail('child_unregistered');
      const pid=read(child,'pid');
      if(!Number.isSafeInteger(pid)||pid<1)throw fail('child_unregistered');
      // Disconnect only. An uncommitted child never acquired execution authority, so
      // killing or retrying it here would be a unilateral mutation; wait for its own
      // actual exit within a bound instead.
      try{if(read(child,'connected')===true&&typeof read(child,'disconnect')==='function')child.disconnect();}catch{ /* The exit observation below decides. */ }
      const reason=await actualExit(child,STOP_TIMEOUT_MS);
      if(reason!=='exit'){
        const error=fail(reason==='timeout'?'worker_stop_timeout':'worker_stop_unverified');
        retain(error);
        throw Object.assign(error,{pid,ownershipRetained:true,helperMayStillRun:true});
      }
      children.delete(child);
      return Object.freeze({pid,exited:true});
    }
    function exitReady(role,code){
      if(!Number.isSafeInteger(code)||code!==0)throw fail('exit_code_invalid');
      if(role==='warm'){
        if(installed!==true||!warm||warm.finished)throw fail('exit_not_retired');
        if(retiredFor('warm')===null)throw fail('exit_not_retired');
        return;
      }
      if(!cold||!cold.finished||O.owns(cold.ownership))throw fail('exit_not_finished');
      if(helperUnknown())throw retain(unknownCause);
    }
    async function exitNow(role,code){
      exitReady(role,code);
      if(helperUnknown())throw retain(unknownCause);
      // The final retired/helper/cold-finished rechecks above are synchronous with the
      // exit call: no acquire, release, configure or IO is interleaved.
      let cause;
      try{const pending=exitAdapter(code);if(pending&&typeof pending.then==='function')await pending;}catch(error){cause=error;}
      const returned=fail('process_exit_returned',cause);
      retain(returned);
      throw Object.assign(returned,{ownershipRetained:true,helperMayStillRun:true});
    }
    async function openWarm({base,uploadRoot,ownership}){
      if(warm||cold||installed||warmOpening||coldOpening||configuredRole==='cold')throw fail('warm_already_bound');warmOpening=true;
      try{base=fold(await canonical(base));uploadRoot=fold(await canonical(uploadRoot));
      if(inside(base,uploadRoot)||inside(uploadRoot,base))throw fail('upload_root_invalid');const ctx=openContext(ownership,base,[base,uploadRoot],'warm');warm=ctx;
      try{ctx.broker=await scoped(ctx,()=>bindings.uploads.create({base,root:uploadRoot,ownership,assertExclusive:value=>assertOwnership(value,base)&&O.owns(value,uploadRoot),flush:directories=>operation(ctx,()=>N.flush(directories))}));if(!bindings.uploads.isBroker(ctx.broker))throw retain(fail('broker_invalid'));ensure(ctx);}
      catch(error){throw unknown?error:retain(error);}
      const putUpload=bytes=>operation(ctx,()=>ctx.broker.put(bytes),{newAdmission:true,cleanFailure:true});
      const resolveUpload=(id,options)=>operation(ctx,()=>ctx.broker.resolveUpload(id,options),{newAdmission:true,cleanFailure:true});
      const readAuthority=()=>operation(ctx,()=>N.readAuthority(base),{newAdmission:true});
      const resultReader=()=>bindings.resultApi.create({base,ownership,assertExclusive:value=>assertOwnership(value,base),readAuthority:()=>N.readAuthority(base)}).read();
      const readResult=()=>operation(ctx,resultReader,{newAdmission:true});
      // Package transfer is a read of the one durable result: the requested id must
      // equal it, and the exact bytes about to be sent are re-verified on one opened
      // handle (size, dev/ino, sha256, before/after stat) before any response byte
      // exists. Untrusted data conditions never throw out of the admitted work, so a
      // missing or replaced backup stays a typed refusal instead of a source
      // uncertainty, and no partial response can be confused with success. The
      // durable result read and this final handle read deliberately verify the
      // whole package twice, bounded by WorkDataRecovery.LIMITS.serialized.
      const packageFailure=code=>Object.assign(Error(code),{code,apiCode:code,
        statusCode:code==='work_data_setup.package_not_found'?404:503,retry:false});
      const packageBudget=()=>{
        try{const limits=typeof WorkDataRecovery==='undefined'?null:WorkDataRecovery.LIMITS;
          return plain(limits)&&Number.isSafeInteger(limits.serialized)&&limits.serialized>0?limits.serialized:null;}catch{return null;}
      };
      const unavailable={ok:false,code:'work_data_setup.package_unavailable'};
      async function capturePackage(id){
        let bytes=null,handle=null,complete=false;
        try{
          const record=await resultReader();
          if(!record)return unavailable;
          if(record.id!==id)return {ok:false,code:'work_data_setup.package_not_found'};
          const backup=record.backup,maximum=packageBudget();
          if(!plain(backup)||!plain(backup.identity)||typeof backup.path!=='string'||!p.isAbsolute(backup.path)||p.resolve(backup.path)!==backup.path
            ||p.basename(backup.path)!=='ruyi-work-data-'+record.id+'.ruyi-backup'||inside(base,backup.path)
            ||typeof backup.sha256!=='string'||!/^[a-f0-9]{64}$/.test(backup.sha256)
            ||!Number.isSafeInteger(backup.bytes)||backup.bytes<1||maximum===null||backup.bytes>maximum
            ||typeof backup.identity.dev!=='string'||typeof backup.identity.ino!=='string')return unavailable;
          handle=await io.open(backup.path,'r');
          const before=await handle.stat({bigint:true});
          if(!before.isFile()||before.nlink!==1n||String(before.dev)!==backup.identity.dev
            ||String(before.ino)!==backup.identity.ino||Number(before.size)!==backup.bytes)return unavailable;
          const buffer=Buffer.alloc(backup.bytes);bytes=buffer;let used=0;
          while(used<backup.bytes){const part=await handle.read(buffer,used,backup.bytes-used,null);if(!part.bytesRead)break;used+=part.bytesRead;}
          if(used!==backup.bytes)return unavailable;
          const extra=Buffer.alloc(1);
          try{if((await handle.read(extra,0,1,null)).bytesRead!==0)return unavailable;}finally{extra.fill(0);}
          const after=await handle.stat({bigint:true});
          if(String(after.dev)!==backup.identity.dev||String(after.ino)!==backup.identity.ino||Number(after.size)!==backup.bytes
            ||after.nlink!==1n||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)return unavailable;
          const sha256=c.createHash('sha256').update(buffer).digest('hex');
          if(sha256!==backup.sha256)return unavailable;
          complete=true;
          return {ok:true,id:record.id,bytes:buffer,size:used,sha256};
        }catch{return unavailable;}
        finally{if(!complete&&bytes)bytes.fill(0);if(handle){try{await handle.close();}catch{ /* the verified bytes are already detached */ }}}
      }
      const downloadPackage=async id=>{
        if(typeof id!=='string'||!/^[a-f0-9]{48}$/.test(id))throw fail('package_id_invalid');
        let bytes=null;
        try{
          const outcome=await operation(ctx,async()=>{const captured=await capturePackage(id);if(Buffer.isBuffer(captured?.bytes))bytes=captured.bytes;return captured;},{newAdmission:true});
          if(!outcome||outcome.ok!==true||!Buffer.isBuffer(outcome.bytes))throw packageFailure(outcome?.code==='work_data_setup.package_not_found'
            ?'work_data_setup.package_not_found':'work_data_setup.package_unavailable');
          return Object.freeze({id:outcome.id,bytes:outcome.bytes,size:outcome.size,sha256:outcome.sha256});
        }catch(error){if(bytes)bytes.fill(0);throw error;}
      };
      async function close(){if(ctx.finished)return;if(unknown)throw retain(unknownCause);ctx.accepting=false;if(jobs.size)throw fail('job_active');await Promise.allSettled([...ctx.inflight]);ensure(ctx);try{await ctx.keeper.releaseChecked(assertFinishSafe);assertFinishSafe();ctx.finished=true;}catch(error){throw retain(error);}}
      ctx.api=Object.freeze({base,uploadRoot,ownership,putUpload,resolveUpload,readAuthority,readResult,downloadPackage,close,
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
    // The fresh-root activation owner is installed once on the process hooks. Each
    // role sees only the verbs it owns: cold writes and inspects the receipt, the
    // successor/warm inspects and consumes it by CAS. Plain warm serve has no write.
    const activationFor=role=>{
      const owner=plain(bindings)?read(bindings,'activation'):null;
      if(!plain(owner)||!methods(owner,['inspect','write','remove']))return null;
      return role==='cold'
        ? Object.freeze({inspect:observation=>owner.inspect(observation),write:(value,previous)=>owner.write(value,previous)})
        : Object.freeze({inspect:observation=>owner.inspect(observation),remove:receipt=>owner.remove(receipt)});
    };
    // The boot preference owner is installed once on the process hooks. A successor
    // reads, validates and writes the committed restored root; a cold worker may only
    // read it, and no runtime role may remove it (retiring a preference belongs to the
    // store owner). validate is the store's codec, never a local re-derivation.
    const rootPreferenceFor=role=>{
      const owner=plain(bindings)?read(bindings,'rootPreference'):null;
      if(!plain(owner)||!methods(owner,['inspect','write','remove','validate']))return null;
      return role==='cold'
        ? Object.freeze({inspect:observation=>owner.inspect(observation),validate:value=>owner.validate(value)})
        : Object.freeze({inspect:observation=>owner.inspect(observation),write:(value,previous)=>owner.write(value,previous),validate:value=>owner.validate(value)});
    };
    // A fresh, explicitly invoked doctor process owns this whole operation. Never
    // release the source to a second verifier process and reacquire it afterward.
    async function recoverSource({base}={}) {
      if(warm||cold||installed||warmOpening||coldOpening||configuredRole!==null)throw fail('source_recovery_requires_cold_process');
      if(!methods(bindings.claim,['inspect','recoverSource'])||typeof N.fullSnapshot!=='function')throw fail('source_recovery_unavailable');
      base=fold(await canonical(base));
      const owner=await coldAcquire([base],base),ctx=cold;
      const close=async()=>{ensure(ctx);ctx.accepting=false;await ctx.keeper.releaseOwner(assertFinishSafe);assertFinishSafe();ctx.finished=true;};
      let result,id,failed=false,primary;
      try{
        const first=await bindings.claim.inspect({base});
        if(!first?.present||first.value.phase!=='owned')throw fail('source_recovery_claim_required');
        id=first.value.id;
        const controls=bindings.controlApi.create({base,ownership:owner,assertExclusive:candidate=>candidate===owner&&assertOwnership(owner,base),assertDurableBackup:async()=>false,flush:async()=>{throw fail('source_recovery_readonly');}});
        const results=bindings.resultApi.create({base,ownership:owner,assertExclusive:candidate=>candidate===owner&&assertOwnership(owner,base),readAuthority:()=>N.readAuthority(base)});
        const authorityOf=actual=>{
          const value={generation:actual?.generation,id:actual?.id,mode:actual?.mode,sha256:actual?.proof?.sha256};
          if(!Number.isSafeInteger(value.generation)||value.generation<0||!['plain','encrypted'].includes(value.mode)
            ||(value.generation===0?value.id!==null||value.sha256!==null:!/^([a-f0-9]{48})$/.test(value.id||'')||!/^([a-f0-9]{64})$/.test(value.sha256||'')))throw fail('source_recovery_authority_invalid');
          return Object.freeze(value);
        };
        const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
        let authority=null;
        const inspect=async claim=>{
          ensure(ctx);
          const control=p.join(base,'.work-data');
          try{
            const stat=await io.lstat(control);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('source_recovery_control_invalid');
            const allowed=new Set(['active-v1.json','generations','skill-backups','maintenance-v1.json','maintenance-result-v1.json']);
            if((await io.readdir(control)).some(name=>!allowed.has(fold(name))))throw fail('source_recovery_stage_pending');
          }catch(error){if(error.code!=='ENOENT')throw error;}
          if((await controls.inspect()).pending)throw fail('source_recovery_intent_pending');
          const found=await results.inspect();
          // An existing record for this job belongs to completed recovery. Never
          // use source readability to bypass its backup/authority verification.
          if(found?.present&&found.value?.id===claim.id)throw fail('source_recovery_completed_result_present');
          const current=authorityOf(await N.readAuthority(base));
          if(authority&&!same(authority,current))throw fail('source_recovery_authority_changed');
          authority=current;
          ensure(ctx);return current;
        };
        result=await bindings.claim.recoverSource(first.receipt,async claim=>{
          const before=await inspect(claim);
          let password=c.randomBytes(32).toString('base64'),sealed;
          try{sealed=await N.fullSnapshot(base,owner,candidate=>candidate===owner&&assertOwnership(owner,base)).seal({password,appVersion:VERSION,generation:before.generation});}
          finally{password=null;}
          const after=await inspect(claim);
          if(!same(before,after))throw fail('source_recovery_authority_changed');
          ensure(ctx);
          const proof=sealed?.sourceProof;
          return {authority:after,sourceProof:{sha256:proof?.sha256,bytes:proof?.bytes,files:proof?.files,directories:proof?.directories}};
        });
        ensure(ctx);
      }catch(error){failed=true;primary=error;}
      if(failed){
        // 13aq observes both helperMayStillRun and ownershipRetained throughout
        // the same bounded cause/errors graph, including opaque getters/Proxies.
        // A clear-only cleanup failure may retain its owner without a live helper;
        // neither fact may be forgotten before this owner decides whether to close.
        try{if(N.helperMayStillRun(primary)!==false)throw primary;}catch(error){throw retain(error);}
        if(helperUnknown())throw retain(primary);
        try{await close();}catch(error){throw retain(new AggregateError([primary,error],'work_data_host.source_recovery_cleanup_failed',{cause:primary}));}
        throw primary;
      }
      try{await close();}catch(error){throw retain(error);}
      return Object.freeze({schema:1,kind:'owned-source-recovery',id,sourceReadable:true,maintenanceOutcome:'unknown',
        authority:result.authority,sourceProof:result.sourceProof,diagnostic:result.diagnostic});
    }
    // Explicit C11 only: revalidate an existing durable published result and
    // readable current source. This does not reconstruct 01ad's lost comparison
    // maps, replay maintenance, or supply the missing success evidence of C10.
    async function recoverCompletedIntent({base}={}) {
      if(warm||cold||installed||warmOpening||coldOpening||configuredRole!==null)throw fail('complete_recovery_requires_cold_process');
      if(!methods(bindings.claim,['inspect','recoverCompleted'])||typeof N.fullSnapshot!=='function')throw fail('complete_recovery_unavailable');
      base=fold(await canonical(base));
      const owner=await coldAcquire([base],base),ctx=cold;
      const close=async()=>{ensure(ctx);ctx.accepting=false;await ctx.keeper.releaseOwner(assertFinishSafe);assertFinishSafe();ctx.finished=true;};
      const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
      const sameAuthority=(a,b)=>['generation','id','mode','sha256'].every(key=>a?.[key]===b?.[key]);
      let failed=false,primary,selected,claim,pinned,profile;
      try {
        const exclusive=candidate=>candidate===owner&&assertOwnership(owner,base);
        const control=bindings.controlApi.create({base,ownership:owner,assertExclusive:exclusive,assertDurableBackup:async()=>false,flush:directories=>N.flush(directories)});
        if(!methods(control,['selectCompleteRecovery','recoverComplete','inspect']))throw fail('complete_recovery_unavailable');
        const results=bindings.resultApi.create({base,ownership:owner,assertExclusive:exclusive,readAuthority:()=>N.readAuthority(base)});
        selected=await control.selectCompleteRecovery();
        claim=await bindings.claim.inspect({base});
        const state=selected.state,expected=state.expectedAuthority,candidate=state.candidate;
        if(!claim?.present||claim.value.phase!=='owned'||claim.value.id!==state.id||claim.value.operation!==state.operation)throw fail('complete_recovery_claim_required');
        const stopped=()=>{
          const dead=pid=>{try{proc.kill(pid,0);return false;}catch(cause){return cause?.code==='ESRCH';}};
          if(!dead(claim.value.parentPid)||!dead(claim.value.childPid))throw fail('complete_recovery_process_pending');
          ensure(ctx);return true;
        };
        const currentClaim=async()=>{
          const found=await bindings.claim.inspect({base});
          if(!found?.present||!same(found.receipt,claim.receipt)||!same(found.value,claim.value))throw fail('complete_recovery_claim_changed');
          stopped();return true;
        };
        const directory=async target=>{
          const parsed=p.parse(target);let cursor=parsed.root,last;
          for(const part of ['',...target.slice(parsed.root.length).split(p.sep).filter(Boolean)]){
            if(part)cursor=p.join(cursor,part);const stat=await io.lstat(cursor,{bigint:true});
            if(!stat.isDirectory()||stat.isSymbolicLink()||fold(await io.realpath(cursor))!==fold(cursor))throw fail('complete_recovery_alias');last=identity(stat);
          }return last;
        };
        const capture=async(file,limit)=>{
          try {
          await directory(p.dirname(file));const before=await io.lstat(file,{bigint:true});
          if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(limit))throw fail('complete_recovery_file_invalid');
          const handle=await io.open(file,'r'),bytes=Buffer.alloc(limit+1);let used=0;
          try {
            const opened=await handle.stat({bigint:true});
            if(!opened.isFile()||opened.nlink!==1n||!same(identity(opened),identity(before))||opened.size!==before.size)throw fail('complete_recovery_file_changed');
            for(;;){const part=await handle.read(bytes,used,bytes.length-used,null);used+=part.bytesRead;if(used>limit)throw fail('complete_recovery_file_changed');if(!part.bytesRead)break;}
            const after=await handle.stat({bigint:true}),current=await io.lstat(file,{bigint:true});
            if(!current.isFile()||current.isSymbolicLink()||after.nlink!==1n||current.nlink!==1n
              ||!same(identity(after),identity(before))||!same(identity(current),identity(before))||after.size!==before.size||current.size!==before.size||used!==Number(before.size)
              ||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||current.mtimeNs!==after.mtimeNs||current.ctimeNs!==after.ctimeNs)throw fail('complete_recovery_file_changed');
            const data=Buffer.from(bytes.subarray(0,used));return{data,proof:{sha256:c.createHash('sha256').update(data).digest('hex'),bytes:used,identity:identity(current)}};
          }finally{bytes.fill(0);await handle.close();}
          }catch(cause){throw fail('complete_recovery_file_invalid',cause);}
        };
        const authorityOf=actual=>({generation:actual.generation,id:actual.id,mode:actual.mode,sha256:actual.proof?.sha256});
        const candidateRoot=p.join(base,'.work-data','generations',candidate.id),manifestFile=p.join(base,'.work-data','active-v1.json'),headerFile=p.join(candidateRoot,'work-data-key-v1.json');
        const evidence=async intentPresent=>{
          ensure(ctx);stopped();
          const controlRoot=p.join(base,'.work-data'),allowed=new Set(['active-v1.json','generations','skill-backups','maintenance-v1.json','maintenance-result-v1.json']);
          await directory(controlRoot);
          if((await io.readdir(controlRoot)).some(name=>!allowed.has(fold(name))))throw fail('complete_recovery_stage_pending');
          if(!intentPresent&&(await control.inspect()).pending)throw fail('complete_recovery_intent_returned');
          const actual=await N.readAuthority(base),authority=authorityOf(actual);
          if(authority.generation!==expected.generation+1||authority.id!==candidate.id||authority.mode!==candidate.mode||fold(actual.root)!==fold(candidateRoot))throw fail('complete_recovery_authority_mismatch');
          const record=await results.read();
          if(!record||record.id!==state.id||record.operation!==state.operation||record.state!=='published'
            ||!sameAuthority(record.sourceAuthority,expected)||!sameAuthority(record.authority,authority)
            ||record.backup.path!==state.backup.path||record.backup.sha256!==state.backup.sha256
            ||Date.parse(record.finishedAt)<Date.parse(state.createdAt)||Date.parse(record.finishedAt)<Date.parse(claim.value.updatedAt)
            ||inside(base,record.backup.path)||inside(p.dirname(record.backup.path),base)
            ||fold(await O.canonicalRoot(record.backup.path))!==fold(record.backup.path))throw fail('complete_recovery_result_mismatch');
          const manifest=await capture(manifestFile,4096);let header,parsed;
          try {
            header=await capture(headerFile,65536);
            const text=header.data.toString('utf8');if(!Buffer.from(text).equals(header.data))throw fail('complete_recovery_header_invalid');
            try{parsed=JSON.parse(text);}catch(cause){throw fail('complete_recovery_header_invalid',cause);}
            if(!WorkDataKeys.validate(parsed)||!parsed.instanceId||header.proof.sha256!==candidate.headerSha256||manifest.proof.sha256!==authority.sha256)throw fail('complete_recovery_header_invalid');
          }finally{header?.data.fill(0);manifest.data.fill(0);}
          const directories=[];
          for(const relative of ['', '.work-data','.work-data/generations','.work-data/generations/'+candidate.id])directories.push({path:relative,identity:await directory(p.join(base,...relative.split('/')))});
          const value={authority,resultProof:record.proof,manifest:manifest.proof,header:header.proof,directories};
          if(pinned&&!same(pinned,value))throw fail('complete_recovery_evidence_changed');pinned=value;
          await currentClaim();ensure(ctx);return value;
        };
        // C10, mismatched historical results and missing/bad backups stop here,
        // before any profile exemption or metadata retirement is attempted.
        await evidence(true);
        // The existing claim mutation gate spans both full profiles and intent
        // retirement. A final intent capture cannot race a managed claim write,
        // remove or recovery. Keep the original claim's own last CAS/PID/unlink.
        let profiles=0;
        await bindings.claim.recoverCompleted(claim.receipt,async original=>{
          if(!same(original,claim.value)||profiles>=2)throw fail('complete_recovery_claim_changed');
          const before=await evidence(true);let password=c.randomBytes(32).toString('base64'),sealed;
          try{sealed=await N.fullSnapshot(base,owner,exclusive,{controlRecoveryProof:selected}).seal({password,appVersion:VERSION,generation:before.authority.generation});}
          finally{password=null;}
          const after=await evidence(true);if(!same(before,after))throw fail('complete_recovery_evidence_changed');
          const proof=sealed?.sourceProof;
          if(!proof||!/^[a-f0-9]{64}$/.test(proof.sha256||'')||!['bytes','files','directories'].every(key=>Number.isSafeInteger(proof[key])&&proof[key]>=0))throw fail('complete_recovery_profile_invalid');
          for(const [relative,wanted]of [['.work-data/active-v1.json',after.manifest],['.work-data/generations/'+candidate.id+'/work-data-key-v1.json',after.header]]){
            const row=sealed.sourceFiles?.find(row=>fold(row.path)===fold(relative));
            if(!row||row.sha256!==wanted.sha256||row.identity!==wanted.identity.dev+':'+wanted.identity.ino)throw fail('complete_recovery_profile_invalid');
          }
          for(const wanted of after.directories){const row=sealed.sourceDirectories?.find(row=>fold(row.path)===fold(wanted.path));
            if(!row||row.identity!==wanted.identity.dev+':'+wanted.identity.ino)throw fail('complete_recovery_profile_invalid');}
          const current={sha256:proof.sha256,bytes:proof.bytes,files:proof.files,directories:proof.directories};
          if(profile&&!same(profile,current))throw fail('complete_recovery_source_changed');profile=current;
          profiles++;
          if(profiles===2){
            // Both complete source profiles were captured with the original
            // intent present. The control gate now rechecks the already-bound
            // result/backup/authority and exact intent, without a third seal.
            await control.recoverComplete(selected,async recovered=>{
              if(recovered!==selected.state)throw fail('complete_recovery_intent_changed');
              await evidence(true);return true;
            },stopped);
            await evidence(false);
          }
          return true;
        });
        if(profiles!==2)throw fail('complete_recovery_profile_invalid');
        ensure(ctx);
      }catch(cause){failed=true;primary=cause;}
      if(failed){
        try{if(N.helperMayStillRun(primary)!==false)throw primary;}catch(cause){throw retain(cause);}
        if(helperUnknown())throw retain(primary);
        try{await close();}catch(cause){throw retain(new AggregateError([primary,cause],'work_data_host.complete_recovery_cleanup_failed',{cause:primary}));}
        throw primary;
      }
      try{await close();}catch(cause){throw retain(cause);}
      return Object.freeze({schema:1,kind:'completed-intent-recovery',id:selected.state.id,completionEvidence:'existing-durable-result',
        intentRetired:true,claimRetired:true,currentSourceReadable:true,authority:pinned.authority,sourceProof:profile,sourceProofPhase:'before-intent-retirement'});
    }

    function runtimeHost({base,role}){
      if(!['warm','cold'].includes(role)||typeof base!=='string'||!p.isAbsolute(base))throw fail('runtime_options_invalid');base=fold(p.resolve(base));if(role==='warm'&&(!warm||warm.base!==base))throw fail('warm_source_required');if(role==='cold'&&(warm||warmOpening))throw fail('cold_source_required');
      if(configuredRole!==null&&(configuredRole!==role||configuredBase!==base))throw fail('runtime_already_bound');configuredRole=role;configuredBase=base;
      const host={process:proc,workerApi,httpApi:bindings.httpApi,resultApi:bindings.resultApi,controlApi:bindings.controlApi,workerHooks:bindings.workerHooks,
        get claim(){return bindings.claim;},
        activation:activationFor(role),
        rootPreference:rootPreferenceFor(role),
        base:async()=>base,canonical:O.canonicalRoot,acquire:roots=>coldAcquire(roots,base),assertOwnership,withColdSource,withWarmSource,bindCapturedResult,
        readAuthority:requested=>{const ctx=role==='warm'?warm:cold;if(!ctx||fold(requested)!==ctx.base)throw fail('source_required');return operation(ctx,()=>N.readAuthority(ctx.base),{newAdmission:role==='warm'});},
        operations:({progress})=>{if(typeof progress!=='function')throw fail('progress_invalid');return bindings.coldOperations.create(N.coldOperationHost(progress));},
        // Live reads only. A successful configure, an installed broker or a caller's
        // boolean cannot substitute for a missing adapter, an uncertain native helper
        // or a lost keeper/owner.
        adaptersReady:()=>adaptersReadyFor(role),retiredReceipt:()=>retiredFor(role),isRetired:()=>retiredFor(role)!==null,
        helperMayStillRun:helperUnknown,command:bindings.command,
        stopUncommitted:child=>stopAdapter===null?stopDefault(child):stopAdapter(child),
        exit:code=>exitNow(role,code),
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
      // packageTransfer is a separate, non-writable marker: a test or a future caller
      // that only assigns a downloadPackage function never gets the capability. The
      // advertised transfer is exactly what this install defined.
      const descriptors={putUpload:{value:warm.api.putUpload,writable:true,configurable:true,enumerable:true},resolveUpload:{value:warm.api.resolveUpload,writable:true,configurable:true,enumerable:true},readResult:{value:warm.api.readResult,writable:true,configurable:true,enumerable:true},
        downloadPackage:{value:warm.api.downloadPackage,writable:true,configurable:true,enumerable:true},packageTransfer:{value:true,writable:false,configurable:true,enumerable:false}};
      for(const name of Object.keys(descriptors)){const old=Object.getOwnPropertyDescriptor(hooks,name);if(old&&!old.configurable||!old&&!Object.isExtensible(hooks))throw fail('worker_hooks_invalid');}
      const host=runtimeHost({base:warm.base,role:'warm'});let runtime;try{runtime=bindings.runtimeHooks.configure(host);Object.defineProperties(hooks,descriptors);installed=true;}catch(error){throw retain(error);}ensure(warm);
      return Object.freeze({host,runtime,capabilities:Object.freeze({upload:true,worker:false,download:true,crashClaim:false,activation:false})});
    }
    return Object.freeze({openWarm,runtimeHost,installWarm,assertOwnership,recoverSource,recoverCompletedIntent,helperMayStillRun:helperUnknown,
      capabilities:Object.freeze({requiresCheckedSourceKeeper:true,sourceKeeperHost:true,uploadBrokerAssembly:true,coldOperationAssembly:true,worker:false,crashClaim:false,activation:false,productionReady:false})});
  }
  function bindCapturedResult(host,base,ownership,read){
    const bind=capturedResultScopes.get(host);
    // A legacy host retains Runtime's original default read contract. No
    // property of an unregistered host, Proxy or existing hook is consulted.
    return bind?bind(base,ownership,read):null;
  }
  function hooksOrGlobal(hooks){
    if(hooks!==undefined&&hooks!==null)return hooks;
    return typeof WorkDataMaintenanceRuntimeHooks==='undefined'?null:WorkDataMaintenanceRuntimeHooks;
  }
  // The cold child was spawned with RUYI_HOME pointing at its base. Reading it here is
  // a synchronous process-state read: no canonicalization, prefetch or base IO.
  function coldBase(proc){
    const env=plain(proc)?read(proc,'env'):null,value=plain(env)?read(env,'RUYI_HOME'):undefined;
    if(typeof value!=='string'||!p.isAbsolute(value)||p.resolve(value)!==value||/[\0\r\n]/.test(value))throw fail('cold_base_invalid');
    return p.resolve(value);
  }
  async function startColdMaintenance({proc=process,hooks,bindings}={}){
    const runtimeHooks=hooksOrGlobal(hooks);
    if(!methods(runtimeHooks,['configure','runCold']))throw fail('cold_hooks_invalid');
    if(!plain(proc)||!Number.isSafeInteger(proc.pid)||proc.pid<1)throw fail('process_invalid');
    const base=coldBase(proc);
    const factory=create({proc,bindings:bindings===undefined?productionBindings(proc):bindings});
    // A cold entry configures its own cold runtime host exactly once and never runs
    // the warm acquire/install path or prefetches the base before acquire.
    const host=factory.runtimeHost({base,role:'cold'});
    const configured=runtimeHooks.configure(host);
    if(configured===undefined||configured===null)throw fail('cold_configure_invalid');
    return runtimeHooks.runCold();
  }
  async function startSuccessorMaintenance({proc=process,hooks,startServe,bindings,channel}={}){
    const runtimeHooks=hooksOrGlobal(hooks);
    if(!methods(runtimeHooks,['prepareSuccessor','completeSuccessor']))throw fail('successor_hooks_invalid');
    if(typeof startServe!=='function')throw fail('successor_serve_invalid');
    if(!plain(proc)||!Number.isSafeInteger(proc.pid)||proc.pid<1)throw fail('process_invalid');
    const base=coldBase(proc);
    let pipe=channel;
    if(pipe===undefined||pipe===null){
      const workerApi=bindings===undefined?(typeof WorkDataMaintenanceWorker==='undefined'?null:WorkDataMaintenanceWorker):read(bindings,'workerApi');
      if(!methods(workerApi,['processChannel']))throw fail('successor_channel_invalid');
      pipe=workerApi.processChannel(proc);
    }
    // prepare rejects invalid input/parent/nonce/base/listener before any IO or
    // configure and registers the single strict options object used by startServe.
    const prepared=await runtimeHooks.prepareSuccessor(pipe,{base});
    const options=plain(prepared)&&Object.hasOwn(prepared,'options')?prepared.options:prepared;
    if(!plain(options))throw fail('successor_options_invalid');
    await startServe(options);
    // Only a serve that actually started may announce serve-ready/disconnect.
    return runtimeHooks.completeSuccessor();
  }
  return Object.freeze({create,bindCapturedResult,startColdMaintenance,startSuccessorMaintenance,installRootPreference});
})(require('node:path'),require('node:util'),require('node:timers'),require('node:fs/promises'),require('node:crypto'));

// Actual normal-serve wiring. Definition/configuration alone performs no IO.
// Only acquireServe allocates its own empty custody root and acquires the joint
// genuine owner before broker/configuration writes. Installing the warm snapshot
// descriptor does not install a worker capability: the install-time descriptor
// still declares worker:false, and live readiness reports worker availability
// separately.
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
        if(!installed||installed.capabilities?.upload!==true||installed.capabilities.worker!==false||installed.capabilities.download!==true||installed.capabilities.crashClaim!==false||installed.capabilities.activation!==false)throw fail('installed_capabilities_invalid');
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
  // One handoff claim instance for the whole process: the host, 13ai and 13am all
  // read and remove the same TEMP record, and the readonly boot gate classifies it
  // before configure. Installing it performs no IO and starts no process; an existing
  // instance is never replaced, and an absent claim/verifier module leaves it unset
  // (the worker then stays unready instead of inventing a parallel owner).
  try{
    if(!WorkDataMaintenanceRuntimeHooks.claim&&typeof WorkDataHandoffClaim!=='undefined'&&typeof WorkDataVerifierEntry!=='undefined'){
      const native=WorkDataVerifierEntry.createVerifier({proc:process});
      WorkDataMaintenanceRuntimeHooks.claim=WorkDataHandoffClaim.create({temp:require('node:os').tmpdir(),flush:directories=>native.flush(directories)});
    }
  }catch{ /* No synthetic claim: a missing adapter leaves the worker unready. */ }
  // One fresh-root activation owner for the whole process. It is carried by that same
  // claim instance (13av creates it with the same TEMP root and native flush), so this
  // tail installs that exact object instead of minting a parallel owner. An absent
  // claim/module leaves the capability unset, and a restore handoff then fails closed
  // instead of restarting the source root.
  try{
    if(!WorkDataMaintenanceRuntimeHooks.activation){
      const claim=WorkDataMaintenanceRuntimeHooks.claim,activation=claim&&typeof claim==='object'?claim.activation:null;
      if(activation&&typeof activation==='object')WorkDataMaintenanceRuntimeHooks.activation=activation;
    }
  }catch{ /* No synthetic activation: the restore handoff stays closed. */ }
  // One boot-preference owner for the whole process, created at this same install point
  // with the user's home directory and the same native flush as the claim/activation
  // owners. 13aw precedes this module today; the idempotent seam also retries at the
  // first host binding as defence against a future reordering. An existing instance is
  // never replaced and an absent module only turns the post-ready preference write into
  // diagnosis.
  try{WorkDataRuntimeHost.installRootPreference();}
  catch{ /* Retried at the first host binding; the preference write stays diagnostic. */ }
}
