'use strict';
// Research-only codec stage. Unlike the app's general atomic writer, this
// creates the inode it writes and holds that exact FD through publication.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const retainedHandles=new Set();
function create({assertAuthoritySync,attest,assertAttestationSync}) {
 if(typeof assertAuthoritySync!=='function'||typeof attest!=='function'||typeof assertAttestationSync!=='function')throw Error('stage.arguments');
 function guard(){if(assertAuthoritySync()!==true)throw Error('stage.authority');}
 function same(a,b){return a.dev===b.dev&&a.ino===b.ino;}
 async function open(stage) {
  guard(); const fd=await fs.open(stage,'wx+',0o600);retainedHandles.add(fd);
  try {
   const created=await fd.stat({bigint:true});guard();
   if(!created.isFile()||created.nlink!==1n)throw Error('stage.identity');
   let state='open';
   async function held(work){try{return await work();}catch(cause){state='failed';throw Object.assign(Error('stage.retained',{cause}),{code:'stage.retained',fdRetained:retainedHandles.has(fd),ownershipUnknown:true,operationMayHaveExecuted:true,retry:false});}}
   return Object.freeze({
    async write(value,opts={}) {
     return held(async()=>{
     if(state!=='open')throw Error('stage.state');state='writing';guard();
     let data;if(opts.stream===true){if(typeof value!=='function')throw Error('stage.stream');data=value();if(!data||typeof data[Symbol.asyncIterator]!=='function')throw Error('stage.stream');}
     else data=typeof value==='string'?value:JSON.stringify(value,null,2);
     await fd.writeFile(data,{encoding:'utf8'});await fd.sync();guard();
     const after=await fd.stat({bigint:true}),named=await fs.lstat(stage,{bigint:true});
     if(!same(created,after)||!same(created,named)||after.nlink!==1n)throw Error('stage.identity');
     state='written';
     });
    },
    async publish(output) {
     return held(async()=>{
     if(state!=='written'||path.dirname(stage)!==path.dirname(output))throw Error('stage.state');state='publishing';guard();
     const before=await fd.stat({bigint:true}),named=await fs.lstat(stage,{bigint:true});
     if(!same(created,before)||!same(created,named)||before.nlink!==1n)throw Error('stage.identity');
     guard();await fs.link(stage,output);
     const linked=await fs.lstat(output,{bigint:true}),held=await fd.stat({bigint:true});
     if(!same(created,linked)||!same(created,held)||held.nlink!==2n)throw Error('stage.identity');
     guard();await fs.unlink(stage);
     const final=await fd.stat({bigint:true}),namedFinal=await fs.lstat(output,{bigint:true});
     if(!same(created,final)||!same(created,namedFinal)||final.nlink!==1n)throw Error('stage.identity');
     const digest=crypto.createHash('sha256'),scratch=Buffer.alloc(65536);let offset=0;
     try{for(;;){const part=await fd.read(scratch,0,scratch.length,offset);if(!part.bytesRead)break;digest.update(scratch.subarray(0,part.bytesRead));offset+=part.bytesRead;}}finally{scratch.fill(0);}
     const hash=digest.digest('hex'),hashed=await fd.stat({bigint:true});
     if(!same(created,hashed)||hashed.size!==final.size||hashed.mtimeNs!==final.mtimeNs||hashed.ctimeNs!==final.ctimeNs||BigInt(offset)!==hashed.size)throw Error('stage.changed');
     await fd.sync();guard();
     const proof=await attest({fd,output,identity:{dev:created.dev,ino:created.ino},hash});
     guard();if(assertAttestationSync(proof,output)!==true)throw Error('stage.attestation');
     await fd.close();retainedHandles.delete(fd);state='published';return proof;
     });
    }
   });
  }catch(e){throw Object.assign(e,{fdRetained:retainedHandles.has(fd),ownershipUnknown:true,retry:false});}
 }
 return Object.freeze({open,stats:()=>({retained:retainedHandles.size})});
}
module.exports={create};
