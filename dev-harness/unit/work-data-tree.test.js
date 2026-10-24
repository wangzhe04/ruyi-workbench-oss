'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {test}=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/01aa-work-data-tree.js'),'utf8');
const api=vm.runInNewContext(source+'\nWorkDataTree;',{Buffer,process,require});
async function fixture(work){const parent=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'ruyi-tree-case-'));try{await work(root);}finally{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('ruyi-tree-case-'));fs.rmSync(root,{recursive:true,force:true});}}
const code=suffix=>error=>error.code==='work_data_tree.'+suffix;
test('complete census preserves binary, empty directories, retained files and exact CRLF without filtering or writes',()=>fixture(async root=>{
  fs.mkdirSync(path.join(root,'nested','empty'),{recursive:true});fs.writeFileSync(path.join(root,'nested','bytes.bin'),Buffer.from([0,255,1,128]));fs.writeFileSync(path.join(root,'bad.corrupt'),'not json\r\n秘密');
  const store=api.create(),snapshot=await store.capture(root);try{assert.deepEqual([...snapshot.directories],['nested','nested/empty']);assert.deepEqual([...snapshot.files].map(row=>row.path),['bad.corrupt','nested/bytes.bin']);assert.ok(snapshot.files[1].data.equals(Buffer.from([0,255,1,128])));assert.equal(snapshot.files[0].data.toString(),'not json\r\n秘密');const proof=await store.verify(snapshot);assert.equal(proof.files,2);assert.equal(proof.domainValidation,'host-owner-required');assert.equal(proof.nativeMetadata,'host-owner-required');}finally{snapshot.release();snapshot.release();assert.ok(snapshot.files.every(row=>row.data.every(byte=>byte===0)));}await assert.rejects(store.verify(snapshot),code('snapshot_unavailable'));
}));
test('a same-size rewrite is caught by full hash even after mtime is restored',()=>fixture(async root=>{
 const file=path.join(root,'one');fs.writeFileSync(file,'old');const old=fs.statSync(file),store=api.create(),snapshot=await store.capture(root);try{fs.writeFileSync(file,'new');fs.utimesSync(file,old.atime,old.mtime);await assert.rejects(store.verify(snapshot),code('source_changed'));assert.equal(fs.readFileSync(file,'utf8'),'new');}finally{snapshot.release();}
}));
test('replacement objects with identical bytes cannot reuse a captured proof',()=>fixture(async root=>{
 const file=path.join(root,'one');fs.writeFileSync(file,'same');const store=api.create(),snapshot=await store.capture(root);try{fs.renameSync(file,path.join(root,'saved'));fs.writeFileSync(file,'same');fs.rmSync(path.join(root,'saved'));await assert.rejects(store.verify(snapshot),code('source_changed'));}finally{snapshot.release();}
}));
test('new files, missing files and empty-directory changes invalidate the complete namespace',()=>fixture(async root=>{
 const file=path.join(root,'one');fs.writeFileSync(file,'one');const store=api.create();for(const change of [()=>fs.writeFileSync(path.join(root,'two'),'two'),()=>fs.unlinkSync(file),()=>fs.mkdirSync(path.join(root,'empty'))]){if(!fs.existsSync(file))fs.writeFileSync(file,'one');const snapshot=await store.capture(root);try{change();await assert.rejects(store.verify(snapshot),code('source_changed'));}finally{snapshot.release();}}
}));
test('changed owned buffers and foreign snapshots never pass verification',()=>fixture(async root=>{
 fs.writeFileSync(path.join(root,'one'),'one');const store=api.create(),snapshot=await store.capture(root);try{await assert.rejects(api.create().verify(snapshot),code('snapshot_unavailable'));snapshot.files[0].data[0]^=1;await assert.rejects(store.verify(snapshot),code('snapshot_changed'));}finally{snapshot.release();}
}));
test('engineering budgets fail without removing or rewriting any source',()=>fixture(async root=>{
 fs.writeFileSync(path.join(root,'one'),'two bytes');await assert.rejects(api.create({bytes:1}).capture(root),code('engineering_limit'));assert.equal(fs.readFileSync(path.join(root,'one'),'utf8'),'two bytes');
 fs.writeFileSync(path.join(root,'two'),'');await assert.rejects(api.create({files:1}).capture(root),code('engineering_limit'));
}));
test('hardlinks and directory aliases refuse instead of silently changing their object semantics',()=>fixture(async root=>{
 fs.writeFileSync(path.join(root,'one'),'content');fs.linkSync(path.join(root,'one'),path.join(root,'two'));await assert.rejects(api.create().capture(root),code('file_capability'));fs.unlinkSync(path.join(root,'two'));fs.mkdirSync(path.join(root,'ordinary'));fs.symlinkSync(path.join(root,'ordinary'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir');await assert.rejects(api.create().capture(root),code('path_alias'));assert.equal(fs.readFileSync(path.join(root,'one'),'utf8'),'content');
}));
test('failure after the first complete file zeroes all previously retained owned buffers',()=>fixture(async root=>{
 fs.writeFileSync(path.join(root,'a'),'secret');fs.writeFileSync(path.join(root,'b'),'overflow');const held=[],original=Buffer.concat;
 const facade=Object.create(Buffer);facade.from=Buffer.from;facade.alloc=Buffer.alloc;facade.concat=(parts,length)=>{const value=original(parts,length);held.push(value);return value;};
 const probed=vm.runInNewContext(source+'\nWorkDataTree;',{Buffer:facade,process,require});await assert.rejects(probed.create({bytes:6}).capture(root),code('engineering_limit'));assert.ok(held.length>=1);assert.ok(held.every(bytes=>bytes.every(byte=>byte===0)));assert.equal(fs.readFileSync(path.join(root,'a'),'utf8'),'secret');
}));
