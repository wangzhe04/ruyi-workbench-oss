'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {create}=require('./owned-candidate-codec-stage-research-v2.cjs');
test('closed stage is attested before source scope, then final inode re-attested',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ruyi-stage-v2-')),stage=path.join(dir,'stage'),out=path.join(dir,'out'),brand=new WeakSet(),seen=[];
 const writer=create({assertAuthoritySync:()=>true,attest:async({file,expected})=>{const stat=await fs.stat(file,{bigint:true}),data=await fs.readFile(file);assert.equal(stat.ino,expected.ino);assert.equal(crypto.createHash('sha256').update(data).digest('hex'),expected.hash);const proof={};brand.add(proof);seen.push(path.basename(file));return proof;},assertAttestationSync:p=>brand.has(p)});
 try{const pending=await writer.open(stage);await pending.write(async function*(){yield Buffer.from('abcdef');},{stream:true});await pending.seal();assert.equal(writer.stats().held,0);assert.deepEqual(seen,['stage']);assert.equal(await fs.readFile(stage,'utf8'),'abcdef');await pending.publish(out);assert.deepEqual(seen,['stage','stage','out']);assert.equal(await fs.readFile(out,'utf8'),'abcdef');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('changed bytes after writer close reject before hard-link publication',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ruyi-stage-v2-race-')),stage=path.join(dir,'stage'),out=path.join(dir,'out'),brand=new WeakSet();
 const writer=create({assertAuthoritySync:()=>true,attest:async({file,expected})=>{const data=await fs.readFile(file);if(crypto.createHash('sha256').update(data).digest('hex')!==expected.hash)throw Error('changed');const proof={};brand.add(proof);return proof;},assertAttestationSync:p=>brand.has(p)});
 const pending=await writer.open(stage);await pending.write('original');await pending.seal();await fs.writeFile(stage,'external');
 await assert.rejects(()=>pending.publish(out),e=>e.code==='stage.retained');await assert.rejects(()=>fs.lstat(out),e=>e.code==='ENOENT');
 // Keep the failed candidate directory for explicit owner/fence handling.
});
