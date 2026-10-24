'use strict';
// Actual filesystem renames and crypto codecs; native metadata/stream operations
// are explicitly simulated. No native helper, build or service process runs here.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {createBackupOwnerFixture}=require('./migration-backup-owner-fixture');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const id=file=>'00000001'+fs.statSync(file,{bigint:true}).ino.toString(16).padStart(16,'0');
function createRepresentationFixture(root){
 const state={events:[],cut:null},metadata=new Map(),streams=new Map();
 const event=name=>{state.events.push(name);if(state.cut===name){state.cut=null;throw Object.assign(new Error('simulated '+name),{code:'simulated.'+name});}};
 const info=async root=>({id:id(root),volume:'simulated-native-volume'});
 function walk(root,rel='',out=[]){const file=path.join(root,rel),stat=fs.lstatSync(file);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)throw Error('simulated unsupported');out.push({file,rel:rel.split(path.sep).join('/'),id:id(file),dir:stat.isDirectory()});if(stat.isDirectory())for(const child of fs.readdirSync(file).sort())walk(root,path.join(rel,child),out);return out;}
 const capture=async(root,revision)=>{event('capture');const entries=walk(root).map(row=>{
  if(!metadata.has(row.id))metadata.set(row.id,{attrs:row.dir?16:32,times:['1','2','3','4'],shortName:''});
  const data=row.dir?[]:[{name:'',data:fs.readFileSync(row.file)}];for(const [name,bytes]of streams.get(row.id)||[])data.push({name,data:bytes});
  return {rel:row.rel,id:row.id,dir:row.dir,opaque:hash(row.id),...metadata.get(row.id),streams:data.map(stream=>({name:stream.name,size:stream.data.length,hash:hash(stream.data),data:stream.data.toString('base64')}))};
 });return {schema:1,platform:'ntfs-objects-v1',revision,entries};};
 const collect=roots=>{const rows=roots.flatMap(root=>walk(root));assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);return rows;};
 function verify(rows,snapshot,alternate,exact){
  assert.equal(rows.length,snapshot.entries.length);const byId=new Map(snapshot.entries.map(row=>[row.id,row]));
  for(const row of rows){const expected=byId.get(row.id);assert.ok(expected,'unknown object retained');assert.equal(row.dir,expected.dir);
   const actual=row.dir?[]:[['',fs.readFileSync(row.file)]];for(const stream of streams.get(row.id)||[])actual.push(stream);
   for(const [name,data]of actual){const target=expected.streams.find(stream=>stream.name===name),other=alternate?.entries.find(entry=>entry.id===row.id)?.streams.find(stream=>stream.name===name);assert.ok(target,'unknown stream retained');const prefix=stream=>stream&&data.length<=stream.size&&Buffer.from(stream.data,'base64').subarray(0,data.length).equals(data);assert.ok(exact?data.length===target.size&&hash(data)===target.hash:prefix(target)||prefix(other),'changed content retained');}
  }
 }
 const move=async args=>{event('move-before');const before=await info(args.source);assert.equal(before.id,args.id);assert.equal(fs.existsSync(args.target),false);await fsp.rename(args.source,args.target);event('move-after');return info(args.target);};
 const seal=async({root,container,snapshot})=>{event('seal-before');const rows=walk(root);verify(rows,snapshot,null,true);for(const row of rows.sort((a,b)=>b.file.length-a.file.length)){
   if(!row.dir)fs.writeFileSync(row.file,Buffer.alloc(0));streams.set(row.id,new Map());await fsp.rename(row.file,path.join(container,snapshot.entries.find(entry=>entry.id===row.id).opaque));
  }event('seal-after');};
 const materialize=async({roots,snapshot,alternate,paths})=>{event('materialize-before');const rows=collect(roots);verify(rows,snapshot,alternate,false);
  const container=path.join(paths.capsule,'objects');for(const row of rows.sort((a,b)=>b.file.length-a.file.length)){const opaque=path.join(container,snapshot.entries.find(entry=>entry.id===row.id).opaque);if(path.resolve(row.file)!==path.resolve(opaque))await fsp.rename(row.file,opaque);row.file=opaque;}
  const base=snapshot.entries.find(entry=>entry.rel===''),restored=path.join(paths.restored,base.id);const original=rows.find(row=>row.id===base.id);await fsp.rename(original.file,restored);
  for(const entry of snapshot.entries.filter(entry=>entry.rel).sort((a,b)=>a.rel.length-b.rel.length)){const row=rows.find(row=>row.id===entry.id),file=path.join(restored,entry.rel);await fsp.rename(row.file,file);row.file=file;}
  for(const entry of snapshot.entries){const file=entry.rel?path.join(restored,entry.rel):restored;if(!entry.dir){const fd=fs.openSync(file,'r+');try{fs.ftruncateSync(fd,0);fs.writeFileSync(fd,Buffer.from(entry.streams.find(stream=>stream.name==='').data,'base64'));}finally{fs.closeSync(fd);}}streams.set(entry.id,new Map(entry.streams.filter(stream=>stream.name!=='').map(stream=>[stream.name,Buffer.from(stream.data,'base64')])));metadata.set(entry.id,{attrs:entry.attrs,times:entry.times,shortName:entry.shortName});}
  event('materialize-written');assert.equal(fs.existsSync(paths.backup),false);await fsp.rename(restored,paths.backup);event('materialize-after');
 };
 const native={info,capture,move,seal,materialize,flush:async()=>event('flush')};
 const f=createBackupOwnerFixture(root,{native});let selected=f.expected;
 Object.defineProperties(state,{enabled:{get:()=>f.state.enabled,set:value=>{f.state.enabled=value;}},acquires:{get:()=>f.state.acquires}});
 const vm=require('node:vm'),evaluate=name=>vm.runInNewContext(name,f.context);
 f.replace('migrationCapsuleCapture',capture);f.replace('migrationCapsuleCapturePreserved',capture);
 // Native-only seam. Codecs, intent state, fingerprint guards, binding lookup and
 // durable typed-history publication remain the actual source implementation.
 f.replace('migrationCapsuleRestore',async(descriptor,snapshot,intent,undo)=>{
  assert.equal(undo,true);const dest=path.join(selected.root,'skills',descriptor.id),retired=path.join(descriptor.backup,'retired');
  const restored=path.join(descriptor.backup,'restored');fs.mkdirSync(restored,{recursive:true});
  const roots=[];for(const root of [descriptor.plainRoot,path.join(restored,intent.oldRoot)].filter(Boolean))if(fs.existsSync(root)&&id(root)===intent.oldRoot)roots.push(root);
  for(const name of fs.readdirSync(path.join(descriptor.backup,'objects')))roots.push(path.join(descriptor.backup,'objects',name));
  const ready=path.join(descriptor.backup,'ready-original');
  await materialize({roots,snapshot,alternate:snapshot,paths:{capsule:descriptor.backup,restored,backup:ready}});
  const current=await capture(dest,intent.revision);assert.equal(evaluate('migrationCapsuleSame')(current,intent.newTree),true);
  await fsp.rename(dest,retired);await fsp.rename(ready,dest);intent.phase='complete';await f.api.migrationCapsuleWriteIntent(descriptor,intent);
  await evaluate('migrationCapsuleAssertTree')(retired,intent.newTree,intent.revision);await fsp.rm(retired,{recursive:true});
  await evaluate('migrationFinishPlainHistory')(descriptor,snapshot,intent);
 });
 f.replace('migrationCapsuleVerifyReady',async(descriptor,snapshot)=>{
  const rows=collect(fs.readdirSync(path.join(descriptor.backup,'objects')).map(name=>path.join(descriptor.backup,'objects',name)));
  assert.deepEqual(Array.from(rows,row=>row.id).sort(),Array.from(snapshot.entries,row=>row.id).sort());
  for(const row of rows){if(!row.dir)assert.equal(fs.statSync(row.file).size,0);assert.equal((streams.get(row.id)||new Map()).size,0);}
 });
 const owner=f.api.hooks.createBackupOwner({base:f.dir,readActive:async()=>selected,sourceKeys:f.fx.store.Hooks.keys,native});
 const select=(candidate,generation=1,mode='encrypted')=>{const raw=JSON.stringify({schema:1,id:candidate.id,generation,mode,activeRoot:'generations/'+candidate.id});selected={...candidate,generation,mode,proof:{raw,sha256:hash(raw)}};};
 const candidate=()=>{const value={id:crypto.randomBytes(24).toString('hex')};value.root=path.join(f.dir,'.work-data','generations',value.id);fs.mkdirSync(value.root,{recursive:true});return value;};
 async function plain(skillId='Tool_One'){
  f.state.enabled=false;const backup=f.backup(f.stamp,skillId),live=f.skill(skillId,{'SKILL.md':'REPLACEMENT'});fs.mkdirSync(path.join(backup,'sub'),{recursive:true});fs.writeFileSync(path.join(backup,'SKILL.md'),'ORIGINAL');fs.writeFileSync(path.join(backup,'sub','asset.bin'),Buffer.from([0,255,128,42]));
  const treeHash=await f.api.migrationTreeHash(await f.api.migrationSkillTree(live));const record={schema:1,source:'codex',sourcePath:'source private',plugin:'',importedAt:'then',sourceTreeHash:treeHash,copyTreeHash:treeHash};
  await f.api.writeSkillImportRecord(backup,record,skillId);await f.api.writeSkillImportRecord(live,record,skillId);
  fs.mkdirSync(path.join(f.dir,'migrations'),{recursive:true});fs.writeFileSync(path.join(f.dir,'migrations',f.stamp+'.json'),JSON.stringify({schema:1,id:f.stamp,files:[{file:live,kind:'skill-copy',backup,items:[{id:skillId,copyTreeHash:treeHash}]}]}));
  const snapshot=await capture(backup,'1'.repeat(64));return {backup,live,skillId,record,snapshot};
 }
 async function shadow(source,target,id,mode=true){const dest=path.join(target.root,'skills',id);fs.mkdirSync(path.dirname(dest),{recursive:true});await fsp.cp(source,dest,{recursive:true});const logical=await f.api.skillImportRecordStore(source,id).read();if(mode)await f.api.skillImportRecordStore(dest,id,true).write(logical);else fs.writeFileSync(path.join(dest,'.ruyi-import.json'),logical);return dest;}
 const readHistory=(backup,descriptor)=>require('node:vm').runInNewContext('migrationReadBackupHistory',f.context)(backup,descriptor);
 async function terminal(backup,live,phase='complete'){
  const descriptor=f.api.migrationCapsuleDescriptor(backup),record=await f.api.migrationCapsuleRead(descriptor),retired=path.join(f.dir,'fixture-retired-'+crypto.randomBytes(8).toString('hex'));
  await fsp.rename(live,retired);const restored=path.join(backup,'restored');fs.mkdirSync(restored,{recursive:true});
  await materialize({roots:fs.readdirSync(path.join(backup,'objects')).map(name=>path.join(backup,'objects',name)),snapshot:record.snapshot,alternate:record.snapshot,paths:{capsule:backup,restored,backup:live}});
  record.intent.phase=phase;await f.api.migrationCapsuleWriteIntent(descriptor,record.intent);return record;
 }
 return {...f,owner,native,state,metadata,streams,plain,shadow,select,newCandidate:candidate,readHistory,terminal,get selected(){return selected;},nativeId:id};
}
module.exports={createRepresentationFixture};
