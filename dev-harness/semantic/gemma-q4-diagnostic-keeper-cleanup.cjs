'use strict';
// Only the held child handle is signalled; a creation mismatch or observation
// error never becomes permission to kill any other process.
async function closeKeeper({child,identity,closed,observe,absent,timeoutMs=10000}){
 const report={requested:false,closeObserved:false,identityAbsent:false,unknown:true};
 if(!child||!identity||child.pid!==identity.pid||typeof observe!=='function'||typeof absent!=='function')return {...report,reason:'ownership_missing'};
 try{
  const now=await observe(child.pid);if(!now||String(now.created)!==String(identity.created))return {...report,reason:'identity_changed'};
  // No asynchronous boundary separates this final identity observation and the
  // operation on the original ChildProcess handle.
  if(child.exitCode===null&&child.signalCode===null){report.requested=true;if(child.kill()!==true)return {...report,reason:'signal_refused'};}
  let timer;try{report.close=await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('close_timeout')),timeoutMs);})]);}finally{clearTimeout(timer);}
  report.closeObserved=true;report.identityAbsent=await absent(identity);report.unknown=!report.identityAbsent;
  if(report.unknown)report.reason='identity_still_present';return report;
 }catch{return {...report,reason:'observation_failed'};}
}
module.exports={closeKeeper};
