'use strict';
// Synthetic process-handshake markers only. A reader sees ENOENT until the
// complete, flushed and closed payload is atomically linked into its final name.
// linkSync never replaces an existing name. Production control files and backup
// packages must keep their own ownership and publication protocols.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const failures=new WeakMap();
const markerName=file=>typeof file==='string'&&/^(?:request|producer-(?:ready|owned|go|crash)|job-(?:target|release|hold))\.json$/.test(path.basename(file))?path.basename(file):null;
const code=error=>{try{return typeof error?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:null;}catch{return null;}};
function markerFailure(error){return error!==null&&(typeof error==='object'||typeof error==='function')?failures.get(error)||null:null;}
function publishJsonOnce(file,value,{io=fs,nonce=()=>crypto.randomBytes(16).toString('hex'),onFailure}={}){
 let stage='serialize',staging=null,fd=null,created=false,published=false,unlinkAttempted=false,failed=false,primary;
 const cleanup=[];
 try{
  if(!markerName(file)||!path.isAbsolute(file))throw TypeError('synthetic marker path invalid');
  const payload=Buffer.from(JSON.stringify(value),'utf8'),id=nonce();
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw TypeError('synthetic marker nonce invalid');
  staging=file+'.stage-'+id;
  stage='stage-open';fd=io.openSync(staging,'wx',0o600);created=true;
  stage='stage-write';io.writeFileSync(fd,payload);
  stage='stage-flush';io.fsyncSync(fd);
  stage='stage-close';const closing=fd;fd=null;io.closeSync(closing);
  stage='publish';io.linkSync(staging,file);published=true;
  stage='stage-unlink';unlinkAttempted=true;io.unlinkSync(staging);
 }catch(error){failed=true;primary=error;}
 // Each cleanup is attempted at most once. A failed close has an uncertain fd;
 // it was consumed above and must never be retried against a recycled number.
 if(fd!==null){const closing=fd;fd=null;try{io.closeSync(closing);}catch(error){cleanup.push({operation:'close',code:code(error)});}}
 if(created&&!unlinkAttempted){unlinkAttempted=true;try{io.unlinkSync(staging);}catch(error){cleanup.push({operation:'unlink',code:code(error)});}}
 if(failed){
  const diagnostic=Object.freeze({kind:'fixture-marker-publication',file:markerName(file),stage,published,code:code(primary),cleanup:Object.freeze(cleanup.map(row=>Object.freeze(row))),rawBodiesOmitted:true});
  if(primary!==null&&(typeof primary==='object'||typeof primary==='function'))failures.set(primary,diagnostic);
  try{onFailure?.(diagnostic);}catch{/* Preserve the original publication failure. */}
  throw primary;
 }
}
module.exports={publishJsonOnce,markerFailure};
