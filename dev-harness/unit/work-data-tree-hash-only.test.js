'use strict';
// 151 阶段 3D(150 号文 W11):只为复核的整根普查「只回哈希与元数据」。真实 01aa reader(server.js)+ 合成的成对原生
// 普查模型:capture(retain)照旧收内容;verify(不保留内容)向原生端请求 hashOnly,收到的流只有 name/size/hash。
// 原生指纹(nativeSha256)与带内容的读法逐字节相同;未请求时的无内容回复、大小不符都被拒。
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {loadServerInternals}=require('../lib/server-internals');
const parent=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'ruyi-tree-hash-only-'));
for(const name of ['home','data','appdata','local'])fs.mkdirSync(path.join(root,name));
Object.assign(process.env,{RUYI_HOME:path.join(root,'data'),WIN_CLAUDE_WORKBENCH_HOME:path.join(root,'data'),HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'local')});
after(()=>{assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});});
const {WorkDataTree}=loadServerInternals(['WorkDataTree']);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function reading(base,revision,{contentless=false,sizeFor}={}){
 const entries=[];
 async function visit(rel){
  const file=path.join(base,...rel.split('/').filter(Boolean)),stat=await io.lstat(file,{bigint:true}),dir=stat.isDirectory(),data=dir?null:await io.readFile(file);
  const size=dir?0:(sizeFor?.(rel)??data.length);
  const stream=dir?null:contentless?{name:'',size,hash:sha(data)}:{name:'',size,hash:sha(data),data:data.toString('base64')};
  entries.push({rel,dir,id:stat.dev.toString(16).padStart(8,'0')+stat.ino.toString(16).padStart(16,'0'),opaque:'a'.repeat(64),attrs:dir?16:32,times:['1','2','3','4'],shortName:'',streams:dir?[]:[stream]});
  if(dir)for(const name of(await io.readdir(file)).sort())await visit(rel?rel+'/'+name:name);
 }
 await visit('');return{schema:1,platform:'ntfs-objects-v1',revision,entries};
}
function pairedModel(base,state,options={}){
 return async(rootPath,revision,readback)=>{
  assert.ok(readback,'the production reader always asks for a paired census');
  const context=WorkDataTree.claimPreservedReadbackContext(readback,rootPath,revision);assert.ok(context);
  state.requests.push(context.hashOnly);
  const contentless=options.forceContentless??context.hashOnly;
  await readback.bind(await reading(base,revision,{...options,contentless}));
  return reading(base,readback.revision,{...options,contentless});
 };
}
function tree(base,capturePreserved){
 const ownership={roots:[base]};
 return WorkDataTree.createPreserved({capturePreserved,ownership,assertExclusive:async owner=>owner===ownership,assertExclusiveSync:owner=>owner===ownership});
}
async function sample(){
 const base=await io.mkdtemp(path.join(root,'tree-'));
 await io.mkdir(path.join(base,'sessions'));await io.writeFile(path.join(base,'sessions','a.json'),'{"id":"a","private":"HASH_ONLY_A"}');
 await io.writeFile(path.join(base,'sessions','b.json'),'B'.repeat(4096));await io.writeFile(path.join(base,'config.json'),'{}');
 return base;
}

test('capture keeps content; verify requests and accepts a hash-only reading with the identical fingerprint',async()=>{
 const base=await sample(),state={requests:[]},reader=tree(base,pairedModel(base,state));
 const captured=await reader.capture(base);
 assert.deepEqual(state.requests,[false],'the retaining capture asks for content');
 assert.equal(captured.files.find(row=>row.path==='sessions/a.json').data.toString(),'{"id":"a","private":"HASH_ONLY_A"}');
 const initial=reader.fingerprint(captured);
 const verified=await reader.verify(captured);
 assert.deepEqual(state.requests,[false,true],'the closing verification asks for hashes only');
 assert.equal(verified.sha256,initial.sha256);assert.equal(verified.nativeSha256,initial.nativeSha256,'no fingerprint drift between content and hash-only readings');
 captured.release();
});

test('a contentless reply that was not requested, or a size that disagrees with disk, is refused',async()=>{
 const base=await sample();
 const forced=tree(base,pairedModel(base,{requests:[]},{forceContentless:true}));
 await assert.rejects(forced.capture(base),error=>error.code==='work_data_tree.preserved_native_invalid');
 const okState={requests:[]},good=tree(base,pairedModel(base,okState)),captured=await good.capture(base);
 // The same reader instance whose closing reading reports a size that disagrees with disk.
 let lie=false;const state={requests:[]},model=pairedModel(base,state),sizeModel=pairedModel(base,state,{sizeFor:rel=>rel==='sessions/b.json'?4095:undefined});
 const reader=tree(base,(...args)=>lie?sizeModel(...args):model(...args)),mine=await reader.capture(base);lie=true;
 await assert.rejects(reader.verify(mine),error=>/work_data_tree\.(source_changed|preserved_native_invalid)/.test(error.code));
 mine.release();captured.release();
});
