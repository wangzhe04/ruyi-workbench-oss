'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {create}=require('./owned-candidate-codec-stage-research.cjs');
test('stream is consumed once, exact creation inode becomes published file and is attested',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ruyi-stage-')),stage=path.join(dir,'stage'),out=path.join(dir,'out'),brand=new WeakSet();let calls=0,attested;
 const writer=create({assertAuthoritySync:()=>true,attest:async x=>{attested=x;const proof={};brand.add(proof);return proof;},assertAttestationSync:p=>brand.has(p)});
 try{const pending=await writer.open(stage),original=await fs.stat(stage,{bigint:true});await pending.write(async function*(){calls++;yield Buffer.from('abc');yield Buffer.from('def');},{stream:true});await pending.publish(out);const actual=await fs.stat(out,{bigint:true});assert.equal(calls,1);assert.equal(actual.ino,original.ino);assert.equal(actual.nlink,1n);assert.equal(attested.hash,crypto.createHash('sha256').update('abcdef').digest('hex'));assert.equal(await fs.readFile(out,'utf8'),'abcdef');assert.equal(writer.stats().retained,0);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('JSON serialization matches atomic writer and does not overwrite a preexisting stage',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ruyi-stage-')),stage=path.join(dir,'stage'),out=path.join(dir,'out'),brand=new WeakSet();
 const writer=create({assertAuthoritySync:()=>true,attest:async()=>{const p={};brand.add(p);return p;},assertAttestationSync:p=>brand.has(p)});
 try{const pending=await writer.open(stage);await assert.rejects(()=>writer.open(stage));await pending.write({ok:true});await pending.publish(out);assert.equal(await fs.readFile(out,'utf8'),JSON.stringify({ok:true},null,2));}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('raced published path is not overwritten and the actual FD stays retained',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ruyi-stage-retained-')),stage=path.join(dir,'stage'),out=path.join(dir,'out');
 const writer=create({assertAuthoritySync:()=>true,attest:async()=>({}),assertAttestationSync:()=>true}),before=writer.stats().retained;
 const pending=await writer.open(stage);await pending.write('candidate');await fs.writeFile(out,'external');
 await assert.rejects(()=>pending.publish(out),e=>e.code==='stage.retained'&&e.fdRetained===true&&e.ownershipUnknown===true);
 assert.equal(await fs.readFile(out,'utf8'),'external');assert.equal(writer.stats().retained,before+1);
 // The uncertain owned directory and FD deliberately remain retained.
});
