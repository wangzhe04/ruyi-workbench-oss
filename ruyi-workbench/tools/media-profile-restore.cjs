'use strict';
// Copy orchestration for a separately assigned restoration operator. There is
// deliberately no filesystem adapter, CLI, server binding or owner factory here:
// Root/Terra must supply independently reviewed read-only sealed-source and new
// empty-target custodians. JSON metadata cannot instantiate either custodian.
const crypto=require('node:crypto'),path=require('node:path');
const MAP_SHA='392fef63b5aa087ad9ccdf018ed5b0635fcf361a15de9e2961c4422ba40a12b0';
const ID='m4-image-cpython312-candidate-v2';
const fail=(suffix,cause)=>Object.assign(new Error('media.profile_restore_'+suffix,cause?{cause}:undefined),{code:'media.profile_restore_'+suffix,retry:false});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fields=['dev','ino','size','mtimeNs','ctimeNs','nlink'];
const same=(a,b)=>fields.every(key=>a[key]===b[key]);
function rowsSnapshot(supplied){
  if(!Array.isArray(supplied)||!supplied.length||supplied.length>10000)throw fail('map_invalid');
  const rows=[],names=new Set(),count=supplied.length;let bytes=0;
  for(let index=0;index<count;index++){
    const item=supplied[index],row=Object.freeze({path:item?.path,source:item?.source,bytes:item?.bytes,sha256:item?.sha256});
    if(typeof row.path!=='string'||row.path.length>1024||/[^\x20-\x7e]|[<>:"\\|?*]/.test(row.path)||row.path.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      ||typeof row.source!=='string'||!path.isAbsolute(row.source)||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>134217728||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))throw fail('map_invalid');
    const key=row.path.toLowerCase();if(names.has(key))throw fail('map_alias');names.add(key);rows.push(row);bytes+=row.bytes;if(bytes>1073741824)throw fail('map_limit');
  }
  return{rows:Object.freeze(rows),bytes};
}
function custodian(value,kind){
  const methods=kind==='source'?['capture','assert','openPinned']:['beginEmpty','assert','openExclusive','finishReadback'];
  const output={};for(const name of methods){if(typeof value?.[name]!=='function')throw fail('custody_pending');output[name]=value[name].bind(value);}return Object.freeze(output);
}
async function copyOwnedRows(supplied,{sourceOwner,targetOwner,signal}={}){
  const inventory=rowsSnapshot(supplied),source=custodian(sourceOwner,'source'),target=custodian(targetOwner,'target');
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw fail('options_invalid');
  let sourceLease,targetLease,completed=0;
  const check=()=>{if(signal?.aborted)throw fail('cancelled');if(sourceLease!==undefined&&source.assert(sourceLease)!==true||targetLease!==undefined&&target.assert(targetLease)!==true)throw fail('owner_changed');};
  check();sourceLease=await source.capture(inventory.rows);if(!sourceLease||typeof sourceLease!=='object')throw fail('custody_pending');check();
  targetLease=await target.beginEmpty(inventory.rows);if(!targetLease||typeof targetLease!=='object')throw fail('custody_pending');check();
  for(const row of inventory.rows){
    let input,output,primary;const buffers=[];
    try{
      input=await source.openPinned(sourceLease,row);check();
      const before=await input.stat({bigint:true});check();
      if(!before.isFile()||before.nlink!==1n||!before.ino||before.size!==BigInt(row.bytes))throw fail('source_identity');
      const initial=Object.freeze(Object.fromEntries(fields.map(key=>[key,before[key]])));
      output=await target.openExclusive(targetLease,row);check();
      const targetBefore=await output.stat({bigint:true});check();
      if(!targetBefore.isFile()||targetBefore.nlink!==1n||!targetBefore.ino||targetBefore.size!==0n)throw fail('target_identity');
      const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(65536);buffers.push(buffer);let offset=0;
      for(;;){
        const read=await input.read(buffer,0,buffer.length,offset);check();
        if(!Number.isSafeInteger(read.bytesRead)||read.bytesRead<0||read.bytesRead>buffer.length)throw fail('read_invalid');
        if(!read.bytesRead)break;if(offset+read.bytesRead>row.bytes)throw fail('source_changed');digest.update(buffer.subarray(0,read.bytesRead));
        let written=0;while(written<read.bytesRead){const result=await output.write(buffer,written,read.bytesRead-written,offset+written);check();if(!Number.isSafeInteger(result.bytesWritten)||result.bytesWritten<1||result.bytesWritten>read.bytesRead-written)throw fail('write_failed');written+=result.bytesWritten;}
        offset+=read.bytesRead;
      }
      if(offset!==row.bytes||digest.digest('hex')!==row.sha256)throw fail('source_drift');
      await output.sync();check();
      const readback=crypto.createHash('sha256');let copied=0;
      for(;;){const result=await output.read(buffer,0,buffer.length,copied);check();if(!Number.isSafeInteger(result.bytesRead)||result.bytesRead<0||result.bytesRead>buffer.length)throw fail('read_invalid');if(!result.bytesRead)break;copied+=result.bytesRead;if(copied>row.bytes)throw fail('readback_drift');readback.update(buffer.subarray(0,result.bytesRead));}
      if(copied!==row.bytes||readback.digest('hex')!==row.sha256)throw fail('readback_drift');
      const after=await input.stat({bigint:true});check();if(!same(initial,after))throw fail('source_changed');
      const targetAfter=await output.stat({bigint:true});check();
      if(!targetAfter.isFile()||targetAfter.nlink!==1n||targetAfter.dev!==targetBefore.dev||targetAfter.ino!==targetBefore.ino||targetAfter.size!==BigInt(row.bytes))throw fail('target_changed');
      completed++;
    }catch(error){primary=error;throw error;}
    finally{
      for(const buffer of buffers)buffer.fill(0);
      const failures=[];for(const handle of [output,input])if(handle)try{await handle.close();}catch(error){failures.push(error);}
      if(failures.length)throw Object.assign(fail('cleanup_unknown',primary||failures[0]),{ownershipRetained:true,cleanupFailed:true});
    }
    check();
  }
  const receipt=await target.finishReadback(targetLease,inventory.rows);check();
  if(receipt?.files!==completed||receipt.bytes!==inventory.bytes||receipt.treeComplete!==true)throw fail('tree_receipt');
  return Object.freeze({schema:1,kind:'owned-copy-readback-observation',files:completed,bytes:inventory.bytes,
    directoryDurabilityProved:receipt.directoryDurabilityProved===true,namespaceLeaseProved:false,sourceArchiveAvailable:false,provenanceComplete:false,legalAcceptance:false,executionAuthorized:false,ready:false});
}
async function restoreMediaProfile({mapBytes,sourceOwner,targetOwner,signal}={}){
  if(!Buffer.isBuffer(mapBytes)||sha(mapBytes)!==MAP_SHA)throw fail('map_changed');
  const map=JSON.parse(mapBytes);
  if(map.profileId!==ID||map.copied!==false||map.ready!==false||map.executionAuthorized!==false||map.rows.length!==3251)throw fail('map_invalid');
  return copyOwnedRows(map.rows,{sourceOwner,targetOwner,signal});
}
module.exports=Object.freeze({copyOwnedRows,restoreMediaProfile});
