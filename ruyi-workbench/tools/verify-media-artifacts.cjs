'use strict';
// Offline inventory admission only. A successful receipt cannot authorize a media payload or launch.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{verifyArtifactFiles}=require('./media-runtime-lock.cjs');
const LOCKS=Object.freeze({runtime:Object.freeze({file:'media-runtime-dependencies.json',sha256:'4e84862cf50907c84b14a55dcabcc347ae3a52e78a88031b7ecb878565d6735f',count:4987}),sources:Object.freeze({file:'media-runtime-sources.json',sha256:'96b07893303e89c9ba668247aa9fb95a15d879c7fd741e674dbfc8491d11fd29',count:1})});
const failure=(code,cause)=>Object.assign(new Error(code,cause===undefined?undefined:{cause}),{code,retry:false});
function groupRows(supplied){
 const names=new Set(),groups=[];let rows=[],bytes=0,total=0;
 for(const value of supplied){
  const row=Object.freeze({path:value?.path,bytes:value?.bytes,sha256:value?.sha256});
  if(typeof row.path!=='string'||row.path.length>4096||row.path.includes('\\')||row.path.includes(':')||row.path.includes('\0')||row.path.split('/').some(s=>!s||s==='.'||s==='..')||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>128*1024*1024||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))throw failure('media.artifact_shape');
  // This frozen distribution targets Windows: aliases are rejected across every group before I/O.
  const key=row.path.toLowerCase();if(names.has(key))throw failure('media.artifact_duplicate');names.add(key);
  if(rows.length===512||bytes+row.bytes>256*1024*1024){groups.push(Object.freeze({rows:Object.freeze(rows),bytes}));rows=[];bytes=0;}
  rows.push(row);bytes+=row.bytes;total+=row.bytes;
 }
 if(rows.length)groups.push(Object.freeze({rows:Object.freeze(rows),bytes}));
 return Object.freeze({groups:Object.freeze(groups),count:supplied.length,bytes:total});
}
function readLock(selected){
 let bytes;try{bytes=fs.readFileSync(path.join(__dirname,'../resources',selected.file));}catch(cause){throw failure(cause?.code==='ENOENT'?'media.component_missing':'media.lock_unavailable',cause);}
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==selected.sha256)throw failure('media.lock_changed');
 let lock;try{lock=JSON.parse(bytes.toString('utf8'));}catch(cause){throw failure('media.lock_invalid',cause);}
 if(lock?.schema!==1||!Array.isArray(lock.artifacts)||lock.artifacts.length!==selected.count)throw failure('media.lock_invalid');
 return groupRows(lock.artifacts);
}
function receipt(value,group){
 if(value?.ok!==true||value.artifacts!==group.rows.length||value.verifiedBytes!==group.bytes||value.installsPerformed!==false||value.mediaEgressEnabled!==false)throw failure('media.artifact_receipt');
}
async function verifyMediaArtifacts(runtimeRoot,sourceRoot,options={}){
 if(typeof runtimeRoot!=='string'||typeof sourceRoot!=='string'||!path.isAbsolute(runtimeRoot)||!path.isAbsolute(sourceRoot))throw failure('media.artifact_shape');
 if(!options||typeof options!=='object'||Array.isArray(options))throw failure('media.artifact_shape');
 const signal=options.signal;if(signal!==undefined&&!(signal instanceof AbortSignal))throw failure('media.artifact_shape');
 const checkCancelled=()=>{if(signal?.aborted)throw failure('media.artifact_cancelled');};
 // Both immutable inventories are captured before the first asynchronous file verification.
 const runtime=readLock(LOCKS.runtime),sources=readLock(LOCKS.sources);
 checkCancelled();for(const group of sources.groups){const proof=await verifyArtifactFiles(sourceRoot,group.rows);checkCancelled();receipt(proof,group);}
 for(const group of runtime.groups){checkCancelled();const proof=await verifyArtifactFiles(runtimeRoot,group.rows);checkCancelled();receipt(proof,group);}
 return Object.freeze({schema:1,verificationKind:'offline-artifact-inventory',dependencyFilesVerified:true,pythonVersion:'3.12.10',runtimeArtifacts:runtime.count,verifiedRuntimeBytes:runtime.bytes,sourceArchiveVerified:true,verifiedSourceBytes:sources.bytes,installsPerformed:false,mediaProcessingEnabled:false,mediaEgressEnabled:false});
}
module.exports=Object.freeze({verifyMediaArtifacts});
if(require.main===module)verifyMediaArtifacts(...process.argv.slice(2)).then(value=>console.log(JSON.stringify(value)),error=>{console.error(typeof error?.code==='string'?error.code:'media.artifact_failed');process.exitCode=1;});
