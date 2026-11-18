'use strict';
// Opt-in lifecycle experiment; no transport, model, cache or production
// registry is created here. Host callbacks remain the source of exit proof.
function createPairLifecycle({coarse,scalar,clearRepresentation,clearScalar,clock={},idleMs=60000}={}) {
  if(!coarse||!scalar||[coarse,scalar].some(host=>typeof host.prepare!=='function'||typeof host.stop!=='function')
    ||typeof clearRepresentation!=='function'||typeof clearScalar!=='function')throw TypeError('pair.invalid_hosts');
  if(!Number.isFinite(idleMs)||idleMs<1||idleMs>60000)throw TypeError('pair.invalid_idle');
  const now=clock.now||Date.now,set=clock.setTimeout||setTimeout,clear=clock.clearTimeout||clearTimeout;
  if([now,set,clear].some(fn=>typeof fn!=='function'))throw TypeError('pair.invalid_clock');
  let enabled=true,busy=0,generation=0,lastTouch=null,timer=null,stopping=null,disabling=null,fenced=false,lastStop=null;
  const failure=code=>Object.assign(Error(code),{code});
  const abort=signal=>{if(signal?.aborted)throw signal.reason===undefined?Object.assign(Error('pair.aborted'),{name:'AbortError'}):signal.reason;};
  const cancelTimer=()=>{if(timer!==null){clear(timer);timer=null;}};
  const observed=value=>value?.cleanupStatus==='observed'&&value.workerExited===true;
  function unavailable(){return !enabled?'pair.disabled':fenced?'pair.cleanup_unconfirmed':stopping||disabling?'pair.stopping':null;}
  async function stopAll(reason) {
    if(stopping)return stopping;
    cancelTimer();generation++;
    stopping=(async()=>{
      const outcomes=await Promise.allSettled([Promise.resolve().then(()=>coarse.stop(reason)),Promise.resolve().then(()=>scalar.stop(reason))]);
      const result=Object.fromEntries(['coarse','scalar'].map((name,n)=>[name,outcomes[n].status==='fulfilled'
        ?{status:'fulfilled',value:outcomes[n].value}:{status:'rejected',error:outcomes[n].reason}]));
      const allObserved=outcomes.every(item=>item.status==='fulfilled'&&observed(item.value));
      fenced=!allObserved;lastStop={reason,allObserved,workers:result};return lastStop;
    })();
    try{return await stopping;}finally{stopping=null;}
  }
  function arm() {
    cancelTimer();if(!enabled||fenced||stopping||disabling||busy||lastTouch===null)return;
    const remaining=Math.max(0,idleMs-(now()-lastTouch));
    timer=set(()=>{timer=null;if(!enabled||fenced||stopping||disabling||busy)return;
      if(now()-lastTouch<idleMs){arm();return;}void stopAll('idle');},remaining);
    timer?.unref?.();
  }
  function beginRequest({signal}={}) {
    abort(signal);const reason=unavailable();if(reason)throw failure(reason);
    const epoch=generation;busy++;lastTouch=now();cancelTimer();let released=false;
    function guard(){abort(signal);if(released||!enabled||epoch!==generation||fenced)throw failure('pair.request_invalidated');}
    async function guardSource(check){if(typeof check!=='function')throw TypeError('pair.guard_required');guard();await check();guard();}
    function touch(){guard();lastTouch=now();}
    function release(){if(released)return;released=true;busy--;lastTouch=now();arm();}
    return Object.freeze({guard,guardSource,touch,release});
  }
  async function withRequest(work,options={}) {
    if(typeof work!=='function')throw TypeError('pair.work_required');
    const lease=beginRequest(options);try{const value=await work(lease);lease.guard();return value;}finally{lease.release();}
  }
  async function prepare(role,options={}) {
    if(!['coarse','scalar'].includes(role))throw TypeError('pair.invalid_role');
    return withRequest(async lease=>{lease.guard();const value=await (role==='coarse'?coarse:scalar).prepare(options);lease.guard();return value;},options);
  }
  async function disable() {
    if(disabling)return disabling;
    enabled=false;generation++;cancelTimer();
    disabling=(async()=>{
      const [stopResult,representation,scalarCache]=await Promise.allSettled([
        stopAll('disabled'),Promise.resolve().then(()=>clearRepresentation()),Promise.resolve().then(()=>clearScalar()),
      ]);
      const outcomes={stop:stopResult,representation,scalar:scalarCache};
      return {ok:stopResult.status==='fulfilled'&&stopResult.value.allObserved&&representation.status==='fulfilled'&&scalarCache.status==='fulfilled',outcomes};
    })();
    try{return await disabling;}finally{disabling=null;}
  }
  function enable() {
    if(disabling||stopping)return {ok:false,reason:'stopping'};
    if(fenced)return {ok:false,reason:'cleanup-unconfirmed'};
    enabled=true;generation++;lastTouch=null;return {ok:true};
  }
  async function shutdown() {enabled=false;generation++;cancelTimer();if(disabling)await disabling;return stopAll('shutdown');}
  const stats=()=>({enabled,busy,generation,lastTouch,scheduled:timer!==null,stopping:!!stopping,disabling:!!disabling,
    cleanupStatus:fenced?'unknown':lastStop?.allObserved?'observed':'not-confirmed',workerExited:lastStop?.allObserved===true,lastStop});
  return Object.freeze({beginRequest,withRequest,prepare,disable,enable,shutdown,stats});
}
module.exports={createPairLifecycle};
