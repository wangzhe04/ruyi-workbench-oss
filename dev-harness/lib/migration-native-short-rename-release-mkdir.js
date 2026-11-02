'use strict';
// One synchronous original releaseEnvironment call only. Never await or peel a denial wrapper.
function withReleaseMkdir(fs,admit,invoke,remember,retainUnknown){
  const same=(a,b)=>a&&b&&a.value===b.value&&a.writable===b.writable&&a.enumerable===b.enumerable&&a.configurable===b.configurable&&Object.hasOwn(a,'value')&&Object.hasOwn(b,'value');
  let original,installed,primary,hasPrimary=false,value,uncertainty=null,critical=false,restored=false;
  const first=error=>{if(!hasPrimary){hasPrimary=true;primary=error;try{remember(error);}catch(cause){unknown('remember_failed',cause);}}};
  const unknown=(reason,cause)=>{if(reason!=='post_guard')critical=true;uncertainty ||= Object.assign(Error('n1.release_env_mkdir_'+reason,{cause}),{code:'n1.release_env_mkdir_uncertain',reason,retry:false,ownershipRetained:true});try{retainUnknown('n1.release_env_mkdir_uncertain');}catch(error){critical=true;uncertainty.retainError ||= error;}};
  const uncertain=()=>Object.assign(new AggregateError(hasPrimary?[primary,uncertainty]:[uncertainty],'n1.release_env_mkdir_uncertain',{cause:hasPrimary?primary:uncertainty}),{code:'n1.release_env_mkdir_uncertain',firstError:hasPrimary?primary:uncertainty,secondary:uncertainty,ownershipRetained:true,retry:false});
  const restore=installFailed=>{try{const current=Object.getOwnPropertyDescriptor(fs,'mkdirSync');if(installFailed&&same(current,original)){restored=true;return;}if(!same(current,installed)){unknown('replaced');return;}Object.defineProperty(fs,'mkdirSync',original);if(!same(Object.getOwnPropertyDescriptor(fs,'mkdirSync'),original))unknown('restore_unproven');else restored=true;}catch(cause){unknown('restore',cause);}};
  try{
    if(typeof admit!=='function'||typeof invoke!=='function'||typeof remember!=='function'||typeof retainUnknown!=='function')throw Error('invalid callbacks');
    original=Object.getOwnPropertyDescriptor(fs,'mkdirSync');
    if(!original||!Object.hasOwn(original,'value')||typeof original.value!=='function'||original.writable!==true)throw Error('unsupported descriptor');
    const wrapper=function(...args){
      try{admit();}catch(cause){first(cause);unknown('pre_guard',cause);throw cause;}let result,error,threw=false;
      try{result=Reflect.apply(original.value,this,args);}catch(cause){error=cause;threw=true;first(cause);}
      // Even an original error can coincide with deadline expiry. Preserve that exact error.
      try{admit();}catch(cause){if(!threw)first(cause);unknown('post_guard',cause);throw threw?error:cause;}
      if(!same(Object.getOwnPropertyDescriptor(fs,'mkdirSync'),installed)){unknown('replaced');throw uncertain();}
      if(threw)throw error;return result;
    };
    installed={...original,value:wrapper};Object.defineProperty(fs,'mkdirSync',installed);
    if(!same(Object.getOwnPropertyDescriptor(fs,'mkdirSync'),installed))throw Error('install not proven');
  }catch(cause){unknown('install',cause);if(installed)restore(true);throw uncertain();}
  try{admit();value=invoke();if(require('node:util').types.isPromise(value)){unknown('async_body');throw uncertain();}}
  catch(error){if(!hasPrimary){hasPrimary=true;primary=error;}}
  finally{
    restore(false);
  }
  if(uncertainty){
    // A pure deadline/post-guard failure does not replace an original mkdir error when restoration succeeded.
    if(!critical&&uncertainty.reason==='post_guard'&&!uncertainty.retainError&&restored)throw primary;
    throw uncertain();
  }
  if(hasPrimary)throw primary;return value;
}
module.exports={withReleaseMkdir};
