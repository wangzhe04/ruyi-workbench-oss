'use strict';
// 151 阶段 3D(150 号文 W11):真实 Windows 刷盘助手常驻 —— 一个 PowerShell 进程只编译一次,连续 flush 复用它;
// 带类型的拒绝让助手先正常退出(nativeSettled),下一次 flush 换新助手。只用本测试自建的临时目录,隔离家目录。
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const win=process.platform==='win32';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-flush-resident-'));
for(const name of ['home','data','appdata','local'])fs.mkdirSync(path.join(root,name));
Object.assign(process.env,{RUYI_HOME:path.join(root,'data'),WIN_CLAUDE_WORKBENCH_HOME:path.join(root,'data'),HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),
 APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'local')});
after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
let api=null;
const load=()=>api||(api=require('../lib/server-internals').loadServerInternals(['WorkDataNativePublish']));

test('real resident flush helper: one compile serves many flushes; a refusal retires it after a clean exit',{skip:!win},async()=>{
 const publish=load().WorkDataNativePublish,flush=publish.createFlush(),base=fs.mkdtempSync(path.join(root,'tree-')),release=publish.holdResident();
 fs.mkdirSync(path.join(base,'a','b'),{recursive:true});
 const before=publish.flushStats();
 const started=Date.now();
 for(let i=0;i<4;i++){const result=await flush([base,path.join(base,'a'),path.join(base,'a','b')]);assert.equal(result.ok,true);assert.deepEqual([...result.directoryFlush],[0,0,0]);}
 const elapsed=Date.now()-started,after1=publish.flushStats();
 assert.equal(after1.spawned-before.spawned,1,'four flushes share one helper process');assert.equal(after1.commands-before.commands,4);
 console.log('# four resident flushes took',elapsed,'ms');
 const refused=await flush([path.join(base,'missing')]).then(()=>null,error=>error);
 assert.equal(refused.code,'work_data_manifest.flush_directory_unavailable');assert.equal(refused.nativeSettled,true);assert.notEqual(refused.helperMayStillRun,true);
 assert.equal(publish.classifyFlushFailure(refused),'refused');
 assert.equal((await flush([base])).ok,true);assert.equal(publish.flushStats().spawned-before.spawned,2,'a refused helper is not reused');
 release();
});

// v2(审查 L3):空闲的常驻助手不持有宿主的当前目录 —— 宿主曾在那个目录里起过助手,之后该目录仍能改名。
test('an idle resident helper does not pin the host working directory',{skip:!win},async()=>{
 const publish=load().WorkDataNativePublish,flush=publish.createFlush(),dir=fs.mkdtempSync(path.join(root,'cwd-')),moved=dir+'-moved',previous=process.cwd(),release=publish.holdResident();
 const before=publish.flushStats().spawned;
 // Retire any idle helper first so that this flush spawns a new one from the chosen cwd.
 await flush([path.join(dir,'missing-to-retire')]).catch(()=>{});
 process.chdir(dir);
 try{assert.equal((await flush([dir])).ok,true);}finally{process.chdir(previous);}
 assert.ok(publish.flushStats().spawned>before,'a helper was spawned while the host cwd was the test directory');
 try{fs.renameSync(dir,moved);assert.equal(fs.existsSync(moved),true,'renaming the former host cwd succeeds while the helper is idle and alive');}finally{release();}
});
