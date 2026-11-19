'use strict';
// 150 W3 through the real Windows broker (13u C# helper compiled by PowerShell):
// a data-root census above the former 10,000-entry cap succeeds, and every
// over-budget refusal reaches Node as the one typed engineering limit
// (work_data_tree.preserved_native_engineering_limit {limit:{kind,maximum}})
// with the product areas counted so far, never a 'shape' or localized message.
// Synthetic roots only (sparse files keep the byte cases cheap); isolated homes.
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const win=process.platform==='win32';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-census-native-'));
for(const name of ['home','data','appdata','local'])fs.mkdirSync(path.join(root,name));
Object.assign(process.env,{RUYI_HOME:path.join(root,'data'),WIN_CLAUDE_WORKBENCH_HOME:path.join(root,'data'),HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),
 APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'local')});
after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
let api=null;
const load=()=>api||(api=require('../lib/server-internals').loadServerInternals(['migrationCapsuleCapturePreserved','migrationCapsuleBroker','WorkDataTree']));
const revision=()=>crypto.randomBytes(32).toString('hex');
const sparse=(file,size)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const handle=fs.openSync(file,'w');try{fs.ftruncateSync(handle,size);}finally{fs.closeSync(handle);}};
const settled=()=>assert.notEqual(load().migrationCapsuleBroker.helperMayStillRun,true,'the broker closed cleanly (no helper left running)');

test('a data-root census above 10,000 entries passes the real broker',{skip:!win},async()=>{
 const base=fs.mkdtempSync(path.join(root,'many-'));
 for(const area of ['sessions','webcache']){fs.mkdirSync(path.join(base,area));for(let i=0;i<5100;i++)fs.writeFileSync(path.join(base,area,String(i).padStart(5,'0')+'.json'),'');}
 const started=Date.now(),snapshot=await load().migrationCapsuleCapturePreserved(base,revision());
 const elapsed=Date.now()-started;
 assert.equal(snapshot.entries.length,10200+3,'root + 2 directories + 10,200 files');
 assert.ok(snapshot.entries.some(row=>row.rel==='webcache/05099.json'));
 console.log('# census of',snapshot.entries.length,'entries took',elapsed,'ms');
 settled();
});

test('over-budget data-root censuses stop with the typed limit and the areas counted so far',{skip:!win},async()=>{
 const tree=load().WorkDataTree,B=tree.NATIVE_BUDGET,capture=root=>load().migrationCapsuleCapturePreserved(root,revision());
 const typed=(kind,area)=>error=>{
  assert.equal(error.code,'work_data_tree.preserved_native_engineering_limit',String(error.code));
  assert.deepEqual({...error.limit},{kind,maximum:kind==='file-bytes'?B.fileBytes:B.bytes});
  assert.equal(error.retry,false);assert.equal(error.cause.code,'work_data_backup.census_'+(kind==='file-bytes'?'file':'bytes')+'_limit');
  const names=error.areas.map(row=>row.area);assert.ok(names.includes(area),names.join(','));
  assert.ok(!names.some(name=>name==='Private Folder'),'user-chosen names are reported as other');
  return true;
 };
 // One stream above the per-file cap (checked from its size before any read).
 const big=fs.mkdtempSync(path.join(root,'file-'));sparse(path.join(big,'uploads','att','video.bin'),B.fileBytes+1);fs.writeFileSync(path.join(big,'config.json'),'{}');
 await assert.rejects(capture(big),typed('file-bytes','uploads'));settled();
 // The production reader (01aa bounded-native-v1, paired first/final census) surfaces the same typed limit.
 const reader=tree.createPreserved({capturePreserved:load().migrationCapsuleCapturePreserved,ownership:{roots:[big]},assertExclusive:async()=>true,assertExclusiveSync:()=>true});
 await assert.rejects(reader.capture(big),typed('file-bytes','uploads'));settled();
 // The total budget across areas (each file below the per-file cap).
 const total=fs.mkdtempSync(path.join(root,'total-'));sparse(path.join(total,'Private Folder','a.bin'),70*1024*1024);sparse(path.join(total,'webcache','b.bin'),70*1024*1024);
 await assert.rejects(capture(total),error=>{typed('bytes','other')(error);return true;});settled();
 // A skill-backup store keeps the capsule caps and its own historical refusal.
 const capsule=fs.mkdtempSync(path.join(root,'capsule-')),store=path.join(capsule,'migrations','skill-backups','2026-01-01T00-00-00-000Z','one');
 sparse(path.join(store,'a.bin'),96000001);
 await assert.rejects(capture(store),error=>/^work_data_backup\./.test(String(error.code)));settled();
});
