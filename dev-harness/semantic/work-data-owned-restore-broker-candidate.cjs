'use strict';
// Research-only broker lifetime owner. A possibly live helper and its broker
// remain strongly reachable; the owner permanently fences further requests.
const {isUnknown}=require('./work-data-owned-restore-unknown.cjs');
function create({start,helperUncertain}){
 if(typeof start!=='function'||typeof helperUncertain!=='function')throw Error('broker.host');
 const retained=new Set();let uncertain=false,busy=false;
 const unknown=()=>{try{return helperUncertain()!==false;}catch{return true;}};
 const safeCode=value=>{try{if(!value||typeof value!=='object')return null;const d=Object.getOwnPropertyDescriptor(value,'code');return d&&Object.hasOwn(d,'value')&&typeof d.value==='string'?d.value:null;}catch{return null;}};
 const fenced=cause=>Object.assign(Error('restore_flush.broker_uncertain'),{code:'restore_flush.broker_uncertain',cause,helperMayStillRun:true,ownershipRetained:true,operationMayHaveExecuted:true,retry:false});
 return Object.freeze({
  async run(work){
   if(uncertain||unknown()){uncertain=true;throw fenced(null);}if(busy)throw Object.assign(Error('restore_flush.busy'),{code:'restore_flush.busy'});if(typeof work!=='function')throw Error('broker.work');busy=true;let broker,failed=false,primary,result;
   try{
    try{broker=await start();}catch(error){if(isUnknown(error)||unknown()){uncertain=true;throw fenced(error);}throw error;}
    let closeDescriptor;try{if(broker&&!require('node:util').types.isProxy(broker))closeDescriptor=Object.getOwnPropertyDescriptor(broker,'close');}catch{}
    if(!closeDescriptor||!Object.hasOwn(closeDescriptor,'value')||typeof closeDescriptor.value!=='function'||unknown()){uncertain=true;if(broker)retained.add(broker);throw fenced(null);}
    try{result=await work(broker);}catch(error){failed=true;primary=error;}
    if((failed&&isUnknown(primary))||unknown()){uncertain=true;retained.add(broker);throw fenced(failed?primary:null);}
    let closeFailed=false,closeError;try{await Reflect.apply(closeDescriptor.value,broker,[]);}catch(error){closeFailed=true;closeError=error;}
    if((closeFailed&&isUnknown(closeError))||unknown()){uncertain=true;retained.add(broker);throw fenced(failed?primary:closeError);}
    // The existing broker repeats a proven command refusal at close. Preserve
    // the original failure; a different close failure remains a cleanup error.
    if(failed){if(closeFailed&&closeError!==primary&&(!safeCode(primary)||safeCode(closeError)!==safeCode(primary)))throw Object.assign(new AggregateError([primary,closeError],'restore_flush.close_failed',{cause:primary}),{code:'restore_flush.close_failed'});throw primary;}
    if(closeFailed)throw closeError;return result;
   }finally{busy=false;}
  },
  stats:()=>Object.freeze({uncertain,retained:retained.size,busy}),
  owns:value=>retained.has(value),
 });
}
module.exports={create};
