'use strict';
// Opt-in research launcher. This module never downloads or builds executables.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const hashFile=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function error(code){return Object.assign(Error(code),{code});}
function createJobLauncher({helperPath,sourcePath,helperSha256,sourceSha256,onCleanup}){
  if(process.platform!=='win32')throw Object.assign(error('JOB_UNSUPPORTED'),{nativeAvailability:true});
  if(!path.isAbsolute(helperPath||'')||!path.isAbsolute(sourcePath||''))throw error('JOB_ABSOLUTE_PATH_REQUIRED');
  if(!/^[a-f0-9]{64}$/.test(helperSha256||'')||!/^[a-f0-9]{64}$/.test(sourceSha256||''))throw error('JOB_PIN_REQUIRED');
  const fingerprint='sha256:'+crypto.createHash('sha256').update(JSON.stringify(['native-job-host-v1',helperSha256,sourceSha256])).digest('hex');
  return async function launchNative({command,args,spawnOptions={},signal,deadline,onOwned}){
    if(signal?.aborted)throw signal.reason||error('JOB_CANCELLED');
    if(!Number.isFinite(deadline)||Date.now()>=deadline)throw error('JOB_DEADLINE');
    if(typeof command!=='string'||!path.isAbsolute(command)||!Array.isArray(args)||args.some(x=>typeof x!=='string'))throw error('JOB_INVALID_REQUEST');
    for(const [file,expected]of [[helperPath,helperSha256],[sourcePath,sourceSha256]]){let stat;try{stat=fs.lstatSync(file);}catch(e){if(file===helperPath&&e.code==='ENOENT')throw Object.assign(error('JOB_UNAVAILABLE'),{nativeAvailability:true});throw e;}if(!stat.isFile()||stat.isSymbolicLink()||hashFile(file)!==expected)throw error('JOB_INTEGRITY');}
    if(signal?.aborted)throw signal.reason||error('JOB_CANCELLED');if(Date.now()>=deadline)throw error('JOB_DEADLINE');
    const child=cp.spawn(helperPath,[],{...spawnOptions,windowsHide:true,stdio:['pipe','pipe','pipe'],signal:undefined});
    let stdout='',settled=false,nativePid=null,creationFileTime=null,closed=false,nativeSpawnRequested=false;
    child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>{});
    const helperClosed=new Promise(resolve=>child.once('close',(code,signalCode)=>{closed=true;resolve({code,signal:signalCode});}));
    const exited=helperClosed.then(async result=>{if(nativePid!==null){if(hashFile(helperPath)!==helperSha256)throw error('JOB_INTEGRITY');const observer=cp.spawn(helperPath,['--wait',String(nativePid),creationFileTime],{...spawnOptions,cwd:path.dirname(path.resolve(helperPath)),windowsHide:true,stdio:'ignore',signal:undefined});const status=await new Promise((resolve,reject)=>{observer.once('error',reject);observer.once('close',code=>code===0?resolve(true):reject(error('JOB_WAIT_FAILED')));});if(!status)throw error('JOB_WAIT_FAILED');}const outcome={...result,cleanupStatus:nativePid!==null||!nativeSpawnRequested?'observed':'unknown',nativeSpawnRequested};if(typeof onCleanup==='function')try{onCleanup(outcome);}catch{}return outcome;}).catch(e=>{if(typeof onCleanup==='function')try{onCleanup({cleanupStatus:'unknown',nativeSpawnRequested});}catch{}throw e;});exited.catch(()=>{});
    let terminatePromise=null;
    async function terminate(){if(!terminatePromise)terminatePromise=(async()=>{if(!closed){try{child.stdin.end('stop\n');}catch{}const force=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},1500);force.unref();try{await exited;}finally{clearTimeout(force);}}else await exited;})();return terminatePromise;}
    const owner=Object.freeze({child,terminate,exited,fingerprint,getNativeIdentity:()=>Object.freeze({nativePid,creationFileTime}),get nativePid(){return nativePid;},get creationFileTime(){return creationFileTime;}});
    try{
      if(onOwned!==undefined){if(typeof onOwned!=='function')throw error('JOB_OWNER_CALLBACK_INVALID');const returned=onOwned(owner);if(returned&&typeof returned.then==='function'){Promise.resolve(returned).catch(()=>{});throw error('JOB_OWNER_CALLBACK_ASYNC');}}
      if(signal?.aborted)throw signal.reason||error('JOB_CANCELLED');if(terminatePromise||child.exitCode!==null||child.signalCode!==null)throw error('JOB_EXITED');
      const ready=await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>fail(error('JOB_DEADLINE')),Math.max(1,deadline-Date.now()));
        const aborted=()=>fail(signal.reason||error('JOB_CANCELLED'));
        const cleanup=()=>{clearTimeout(timeout);signal?.removeEventListener('abort',aborted);child.stdout.off('data',data);child.off('error',fail);child.off('close',closedBefore);};
        const fail=e=>{if(settled)return;settled=true;cleanup();reject(e);};
        const closedBefore=()=>fail(error('JOB_EXITED'));
        const data=chunk=>{stdout+=chunk.toString('utf8');if(stdout.length>4096)return fail(error('JOB_PROTOCOL'));const at=stdout.indexOf('\n');if(at<0)return;let value;try{value=JSON.parse(stdout.slice(0,at));}catch{return fail(error('JOB_PROTOCOL'));}if(value?.type!=='ready'||!Number.isSafeInteger(value.nativePid)||value.nativePid<=0||!/^\d{15,20}$/.test(value.creationFileTime||''))return fail(error('JOB_PROTOCOL'));if(settled)return;settled=true;cleanup();resolve(value);};
        child.once('error',fail);child.once('close',closedBefore);child.stdout.on('data',data);signal?.addEventListener('abort',aborted,{once:true});
        if(signal?.aborted)return aborted();
        try{nativeSpawnRequested=true;child.stdin.write(JSON.stringify({command,args})+'\n');}catch(e){fail(e);}
      });
      nativePid=ready.nativePid;creationFileTime=ready.creationFileTime;
      if(closed||child.exitCode!==null||child.signalCode!==null){await exited;throw error('JOB_EXITED');}
      // Consume any later bounded control output; it contains no child text.
      child.stdout.resume();
      if(signal?.aborted){await terminate();throw signal.reason||error('JOB_CANCELLED');}
      if(Date.now()>=deadline){await terminate();throw error('JOB_DEADLINE');}
      if(signal){const abortRunning=()=>{terminate().catch(()=>{});};signal.addEventListener('abort',abortRunning,{once:true});exited.then(()=>signal.removeEventListener('abort',abortRunning),()=>signal.removeEventListener('abort',abortRunning));if(signal.aborted)abortRunning();}
      return owner;
    }catch(e){try{await terminate();}catch{}throw e;}
  };
}
module.exports={createJobLauncher};
