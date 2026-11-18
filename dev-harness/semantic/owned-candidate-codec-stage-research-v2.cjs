'use strict';
// Research-only two-stage codec writer. Actual native attestation is injected;
// this module alone is not a complete candidate capability.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const held=new Set();
function create({assertAuthoritySync,attest,assertAttestationSync}) {
 if([assertAuthoritySync,attest,assertAttestationSync].some(x=>typeof x!=='function'))throw Error('stage.arguments');
 function guard(){if(assertAuthoritySync()!==true)throw Error('stage.authority');}
 function same(a,b){return a.dev===b.dev&&a.ino===b.ino;}
 async function open(stage) {
  guard();const fd=await fs.open(stage,'wx+',0o600);held.add(fd);
  let state='open',created,expected,stageProof;
  async function safe(fn){try{return await fn();}catch(cause){state='failed';throw Object.assign(Error('stage.retained',{cause}),{code:'stage.retained',fdRetained:held.has(fd),ownershipUnknown:true,operationMayHaveExecuted:true,retry:false});}}
  await safe(async()=>{created=await fd.stat({bigint:true});guard();if(!created.isFile()||created.nlink!==1n)throw Error('stage.identity');});
  return Object.freeze({
   async write(value,opts={}){return safe(async()=>{
    if(state!=='open')throw Error('stage.state');state='writing';guard();let payload;
    if(opts.stream===true){if(typeof value!=='function')throw Error('stage.stream');payload=value();if(!payload||typeof payload[Symbol.asyncIterator]!=='function')throw Error('stage.stream');}
    else payload=typeof value==='string'?value:JSON.stringify(value,null,2);
    await fd.writeFile(payload,{encoding:'utf8'});state='written';
   });},
   async seal(){return safe(async()=>{
    if(state!=='written')throw Error('stage.state');state='sealing';guard();await fd.sync();
    const before=await fd.stat({bigint:true}),named=await fs.lstat(stage,{bigint:true});
    if(!same(created,before)||!same(created,named)||before.nlink!==1n)throw Error('stage.identity');
    const digest=crypto.createHash('sha256'),scratch=Buffer.alloc(65536);let offset=0;
    try{for(;;){const part=await fd.read(scratch,0,scratch.length,offset);if(!part.bytesRead)break;digest.update(scratch.subarray(0,part.bytesRead));offset+=part.bytesRead;}}finally{scratch.fill(0);}
    const after=await fd.stat({bigint:true});if(!same(created,after)||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||BigInt(offset)!==after.size)throw Error('stage.changed');
    expected=Object.freeze({dev:created.dev,ino:created.ino,hash:digest.digest('hex')});guard();await fd.close();held.delete(fd);
    stageProof=await attest({file:stage,expected});guard();if(assertAttestationSync(stageProof,stage,expected)!==true)throw Error('stage.attestation');
    state='sealed';return stageProof;
   });},
   async publish(output){return safe(async()=>{
    if(state!=='sealed'||path.dirname(stage)!==path.dirname(output))throw Error('stage.state');state='publishing';guard();
    if(assertAttestationSync(stageProof,stage,expected)!==true)throw Error('stage.attestation');
    // Native implementation must compare every prior metadata field and stream
    // under its own held handles; brand checks alone cannot establish freshness.
    const rechecked=await attest({file:stage,expected,previous:stageProof,requireSame:true});
    guard();if(assertAttestationSync(rechecked,stage,expected)!==true)throw Error('stage.attestation');
    const before=await fs.lstat(stage,{bigint:true});if(!same(expected,before)||before.nlink!==1n)throw Error('stage.identity');
    guard();await fs.link(stage,output);
    const linked=await fs.lstat(output,{bigint:true}),again=await fs.lstat(stage,{bigint:true});
    if(!same(expected,linked)||!same(expected,again)||linked.nlink!==2n)throw Error('stage.identity');
    guard();await fs.unlink(stage);
    const proof=await attest({file:output,expected});guard();if(assertAttestationSync(proof,output,expected)!==true)throw Error('stage.attestation');
    state='published';return proof;
   });}
  });
 }
 return Object.freeze({open,stats:()=>Object.freeze({held:held.size})});
}
module.exports={create};
