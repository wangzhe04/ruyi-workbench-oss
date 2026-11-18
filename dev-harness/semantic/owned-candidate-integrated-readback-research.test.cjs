'use strict';
// Real patched manifest + Tree with a modeled native reader. This is not an
// NTFS, process-lifecycle, or encrypted-enable test.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const base='output/semantic-owned-current-real-enable-v3/source-input/ruyi-workbench/app/src/';
const source=(file,transform)=>require('./owned-candidate-'+transform+'.cjs').transform(fs.readFileSync(base+file,'utf8')).source;
const {createPreservedReaderModel}=require('../lib/work-data-preserved-reader-model');
test('manifest-issued exact candidate crosses private paired readback; clones and changed baseline refuse',async()=>{
 const root=await io.mkdtemp(path.join(os.tmpdir(),'ruyi-boundary-integrated-'));await io.writeFile(path.join(root,'config.json'),'original');
 const ctx={require,Buffer,process};vm.createContext(ctx);vm.runInContext(source('01v-work-data-manifest.js','manifest-transform-research')+'\n'+source('01aa-work-data-tree.js','readback-transform-research'),ctx);
 const api=vm.runInContext('({manifest:WorkDataManifest,tree:WorkDataTree})',ctx),owner={roots:[root]},baseline={sourceFiles:[{path:'config.json'}],sourceDirectories:[{path:''}]};
 const digest=crypto.createHash('sha256').update(JSON.stringify(baseline)).digest('hex'),ids=async file=>{const s=await io.stat(file,{bigint:true});return s.dev.toString(16).padStart(8,'0')+s.ino.toString(16).padStart(16,'0');};
 const manifest=api.manifest.create({base:root,researchCandidateAllocator:async({candidate})=>{await io.mkdir(candidate.root);return {candidate,root:candidate.root,id:await ids(candidate.root),parents:[await ids(root),await ids(path.join(root,'.work-data')),await ids(path.join(root,'.work-data','generations'))],baselineSha256:digest};}});
 try{
  const candidate=await manifest.prepare({expected:await manifest.readActive(),mode:'encrypted'});await io.writeFile(path.join(candidate.root,'new-output'),'candidate');
  const model=createPreservedReaderModel(),seen=[];
  async function nativeCapture(file,revision,readback){const context=api.tree.claimPreservedReadbackContext(readback,file,revision);if(!context)throw Error('unissued');seen.push(context.candidateBoundary);const get=async rev=>{const snapshot=await model(file,rev),prefix=context.candidateBoundary?.rel;if(prefix)snapshot.entries=snapshot.entries.filter(row=>row.rel!==prefix&&!row.rel.startsWith(prefix+'/'));return snapshot;};await readback.bind(await get(revision));return get(readback.revision);}
  const reader=api.tree.createPreserved({capturePreserved:nativeCapture,ownership:owner,assertExclusive:o=>o===owner,assertExclusiveSync:o=>o===owner,candidateAuthority:(candidate,scope)=>{assert.equal(scope,root);return manifest.researchCandidateBoundary(candidate,baseline);}});
  const captured=await reader.capture(root,candidate);try{assert.ok(captured.files.some(row=>row.path==='config.json'));assert.ok(!captured.files.some(row=>row.path.endsWith('new-output')));assert.equal(seen.length,1);assert.equal(seen[0].id,await ids(candidate.root));}finally{captured.release();}
  await assert.rejects(()=>reader.capture(root,{...candidate}));
  assert.throws(()=>manifest.researchCandidateBoundary(candidate,{sourceFiles:[],sourceDirectories:[]}));
 }finally{await io.rm(root,{recursive:true,force:true});}
});
test('ordinary target native proof rejects an unplanned named stream',async()=>{
 const root=await io.mkdtemp(path.join(os.tmpdir(),'ruyi-target-stream-'));await io.writeFile(path.join(root,'config.json'),'original');
 const ctx={require,Buffer,process};vm.createContext(ctx);vm.runInContext(source('01aa-work-data-tree.js','readback-transform-research'),ctx);const tree=vm.runInContext('WorkDataTree',ctx),owner={roots:[root]},raw=createPreservedReaderModel();
 const reader=tree.createPreserved({ownership:owner,assertExclusive:o=>o===owner,capturePreserved:async(file,revision)=>{const snap=await raw(file,revision),bytes=Buffer.from('x');snap.entries.find(row=>row.rel==='config.json').streams.push({name:':foreign:$DATA',size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')});return snap;}});
 try{const target=await reader.capture(root);try{assert.throws(()=>reader.assertNoNamedStreams(target),e=>e.code==='work_data_tree.source_changed');}finally{target.release();}}finally{await io.rm(root,{recursive:true,force:true});}
});
test('target stream admission is rechecked when final native proof is refreshed',async()=>{
 const root=await io.mkdtemp(path.join(os.tmpdir(),'ruyi-target-stream-late-'));await io.writeFile(path.join(root,'config.json'),'original');
 const ctx={require,Buffer,process};vm.createContext(ctx);vm.runInContext(source('01aa-work-data-tree.js','readback-transform-research'),ctx);const tree=vm.runInContext('WorkDataTree',ctx),owner={roots:[root]},raw=createPreservedReaderModel();let inject=false;
 const reader=tree.createPreserved({ownership:owner,assertExclusive:o=>o===owner,capturePreserved:async(file,revision)=>{const snap=await raw(file,revision);if(inject){const bytes=Buffer.from('x');snap.entries.find(row=>row.rel==='config.json').streams.push({name:':foreign:$DATA',size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')});}return snap;}});
 try{const target=await reader.capture(root);try{reader.assertNoNamedStreams(target);inject=true;await reader.verify(target);assert.throws(()=>reader.assertNoNamedStreams(target),e=>e.code==='work_data_tree.source_changed');}finally{target.release();}}finally{await io.rm(root,{recursive:true,force:true});}
});
