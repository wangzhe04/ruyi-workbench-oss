'use strict';
// Owner state/codec fixture with explicitly simulated native identity/durability.
// Real native object fidelity belongs to the separately retained TEMP probes.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createMigrationSkillBackupFixture}=require('./migration-skill-backup-fixture');
const stamp='2026-10-24T00-00-00-000Z';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const nativeId=file=>'00000001'+fs.statSync(file,{bigint:true}).ino.toString(16).padStart(16,'0');
function createBackupOwnerFixture(root,overrides={}) {
 const skillId=overrides.skillId||'one';
 const f=createMigrationSkillBackupFixture(root,{nativeSourceTransform:overrides.sourceTransform});let selected={id:null,root:f.dir,generation:0,proof:{raw:null,sha256:null}};
 const expected=selected,candidate={id:crypto.randomBytes(24).toString('hex')};candidate.root=path.join(f.dir,'.work-data','generations',candidate.id);fs.mkdirSync(candidate.root,{recursive:true});
 const state={moves:0,failMove:null};
 const capture=async (file,revision)=>{const entries=[];const visit=rel=>{const absolute=path.join(file,rel),stat=fs.statSync(absolute),dir=stat.isDirectory();entries.push({rel:rel.split(path.sep).join('/'),id:nativeId(absolute),dir,streams:dir?[]:[{name:'',size:stat.size,hash:digest(fs.readFileSync(absolute))}]});if(dir)for(const name of fs.readdirSync(absolute).sort())visit(path.join(rel,name));};visit('');return {entries,revision};};
 const native={info:async root=>({id:nativeId(root),volume:'simulated-native-volume'}),capture,move:async args=>{state.moves++;if(state.failMove==='before')throw new Error('simulated failure before move');await fsp.rename(args.source,args.target);if(state.failMove==='after')throw new Error('simulated failure after move');return native.info(args.target);},...overrides.native};
 const owner=()=>f.api.hooks.createBackupOwner({base:f.dir,readActive:async()=>selected,sourceKeys:f.fx.store.Hooks.keys,native});
 const commit=()=>{const raw=JSON.stringify({schema:1,id:candidate.id,generation:1,mode:'encrypted',activeRoot:'generations/'+candidate.id});selected={...candidate,generation:1,proof:{raw,sha256:digest(raw)}};};
 const plain=()=>{const file=path.join(f.backup(stamp,skillId),'SKILL.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'RETAINED PRIVATE');return file;};
 const capsule=async()=>{const source=f.skill(skillId,{'SKILL.md':'# replacement\n'});await f.api.writeSkillImportRecord(source,{schema:1,source:'codex',sourcePath:'SOURCE PRIVATE',plugin:'',importedAt:'now',sourceTreeHash:'hash',copyTreeHash:'hash'},skillId);
  const live=await capture(source,'1'.repeat(64)),snapshot={schema:1,platform:'ntfs-objects-v1',revision:'1'.repeat(64),entries:[{rel:'',id:'00000001'+'e'.repeat(16),opaque:'a'.repeat(64),dir:true,attrs:16,times:['1','1','1','1'],shortName:'',streams:[]},{rel:'SKILL.md',id:'00000001'+'d'.repeat(16),opaque:'b'.repeat(64),dir:false,attrs:32,times:['1','1','1','1'],shortName:'',streams:[{name:'',size:8,hash:digest('ORIGINAL'),data:Buffer.from('ORIGINAL').toString('base64')}]}]};
  const backup=f.backup(stamp,skillId);fs.mkdirSync(path.join(backup,'objects'),{recursive:true});fs.writeFileSync(path.join(backup,'.ruyi-capsule-v1'),'{}');const descriptor=f.api.migrationCapsuleDescriptor(backup);await f.api.migrationCapsuleArchive(descriptor).write(require('node:zlib').gzipSync(Buffer.from(JSON.stringify(snapshot))));await f.api.migrationCapsuleWriteIntent(descriptor,{schema:1,id:skillId,stamp,revision:snapshot.revision,phase:'published',oldRoot:snapshot.entries[0].id,newTree:f.api.migrationCapsuleFingerprint(live),sourceStage:'.ruyi-copy-'+skillId+'-'+stamp});
  f.replace('migrationCapsuleVerifyReady',async()=>{}); // explicit native-only seam
  const target=path.join(candidate.root,'skills',skillId);fs.mkdirSync(path.dirname(target),{recursive:true});await fsp.cp(source,target,{recursive:true});const logical=await f.api.skillImportRecordStore(source).read();await f.api.skillImportRecordStore(target,skillId,true).write(logical);return {source,target,backup,descriptor,snapshot};};
 return {...f,owner,expected,candidate,commit,state,native,plain,capsule,stamp,nativeId};
}
module.exports={createBackupOwnerFixture,stamp,digest};
