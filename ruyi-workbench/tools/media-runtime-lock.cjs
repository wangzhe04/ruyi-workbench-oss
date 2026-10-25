'use strict';
// Read-only offline-package admission. Does not install dependencies or enable media egress.
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
function failure(code){const e=new Error(code);e.code=code;e.retry=false;return e;}
async function verifyArtifactFilesUnchecked(root,artifacts){
 if(typeof root!=='string'||!path.isAbsolute(root)||!Array.isArray(artifacts)||artifacts.length<1||artifacts.length>512)throw failure('media.artifact_shape');
 const base=path.resolve(root),rows=[],names=new Set(),count=artifacts.length;let declared=0;
 for(let index=0;index<count;index++){
  const supplied=artifacts[index];if(!supplied||typeof supplied!=='object')throw failure('media.artifact_shape');
  // Capture primitive values once. Caller objects and arrays never survive an await.
  const item=Object.freeze({path:supplied.path,bytes:supplied.bytes,sha256:supplied.sha256});
  if(!item||typeof item.path!=='string'||item.path.length>4096||item.path.includes('\\')||item.path.includes(':')||item.path.includes('\0')||item.path.split('/').some(s=>!s||s==='.'||s==='..')||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>128*1024*1024||typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw failure('media.artifact_shape');
  const key=process.platform==='win32'?item.path.toLowerCase():item.path;if(names.has(key))throw failure('media.artifact_duplicate');names.add(key);declared+=item.bytes;if(declared>256*1024*1024)throw failure('media.artifact_limit');
  rows.push(item);
 }
 // lstat(base) alone does not expose a junction in a parent of base.
 const fold=value=>process.platform==='win32'?value.toLowerCase():value;
 const parsed=path.parse(base);let ancestor=parsed.root;
 for(const part of ['',...base.slice(parsed.root.length).split(path.sep).filter(Boolean)]){
  if(part)ancestor=path.join(ancestor,part);
  const stat=await fs.lstat(ancestor);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fold(await fs.realpath(ancestor))!==fold(ancestor))throw failure('media.artifact_root');
 }
 for(const item of rows){
  const bits=item.path.split('/');let current=base;
  for(let n=0;n<bits.length;n++){current=path.join(current,bits[n]);const st=await fs.lstat(current);if(st.isSymbolicLink()||n<bits.length-1&&!st.isDirectory()||n===bits.length-1&&!st.isFile())throw failure('media.artifact_kind');}
  const file=await fs.open(current,'r');try{
   const before=await file.stat({bigint:true});if(before.size!==BigInt(item.bytes)||!before.isFile())throw failure('media.artifact_changed');
   const hash=crypto.createHash('sha256'),buf=Buffer.alloc(65536);let bytes=0;
   while(true){const r=await file.read(buf,0,buf.length,null);if(!r.bytesRead)break;bytes+=r.bytesRead;if(bytes>item.bytes)throw failure('media.artifact_changed');hash.update(buf.subarray(0,r.bytesRead));}
   const after=await file.stat({bigint:true}),visible=await fs.lstat(current,{bigint:true});
   if(bytes!==item.bytes||hash.digest('hex')!==item.sha256||visible.isSymbolicLink()||[after,visible].some(st=>st.dev!==before.dev||st.ino!==before.ino||st.size!==before.size||st.mtimeNs!==before.mtimeNs||st.ctimeNs!==before.ctimeNs))throw failure('media.artifact_changed');
  }finally{await file.close();}
 }
 return Object.freeze({ok:true,artifacts:rows.length,verifiedBytes:declared,installsPerformed:false,mediaEgressEnabled:false});
}
async function verifyArtifactFiles(root,artifacts){
 try{return await verifyArtifactFilesUnchecked(root,artifacts);}catch(cause){
  if(typeof cause?.code==='string'&&cause.code.startsWith('media.'))throw cause;
  const error=failure(cause?.code==='ENOENT'?'media.component_missing':'media.artifact_unavailable');error.cause=cause;throw error;
 }
}
module.exports={verifyArtifactFiles};
if(require.main===module){(async()=>{const [root,lockfile]=process.argv.slice(2);const lock=JSON.parse(await fs.readFile(lockfile,'utf8'));console.log(JSON.stringify(await verifyArtifactFiles(root,lock.artifacts)));})().catch(e=>{console.error(e.code||'media.artifact_failed');process.exitCode=1});}
