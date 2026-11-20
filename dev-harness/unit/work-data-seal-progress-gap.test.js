'use strict';
// 151 阶段 3D v3(审查 R2-1):独立校验子进程只在进程内进展计数前进时才发心跳(13aq),所以 seal/verify 路径上的
// 逐文件循环都必须推进计数,否则合法的长校验会被父进程判停滞超时。真实 01aa/01ab/01t(full-snapshot 夹具)
// + 一个逐项推进计数的合成原生普查模型(对应生产里原生助手每秒一行的心跳)。
//   - 确定性判据:capture 结束到收尾复核开始之间(analyze、recovery.seal、源身份采集),计数至少前进 3N 次
//     (v2 这一段只有普查解析那 N 次);
//   - 时间判据:整个 seal 最长「无进展」间隔有界(剩下的只是 JSON/加密这类单次同步调用)。
const {test}=require('node:test'),assert=require('node:assert/strict'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fixture,password}=require('../lib/work-data-full-snapshot-fixture');

function progressingModel(tree,calls){
 return async(root,revision)=>{
  calls.push({startProgress:tree.progressCount()});
  const entries=[];
  async function visit(rel){
   tree.noteProgress();
   const file=path.join(root,...rel.split('/').filter(Boolean)),stat=await fsp.lstat(file,{bigint:true}),dir=stat.isDirectory(),data=dir?null:await fsp.readFile(file);
   entries.push({rel,dir,id:stat.dev.toString(16).padStart(8,'0')+stat.ino.toString(16).padStart(16,'0'),opaque:'a'.repeat(64),attrs:dir?16:32,times:['1','2','3','4'],shortName:'',
    streams:dir?[]:[{name:'',size:data.length,hash:crypto.createHash('sha256').update(data).digest('hex'),data:data.toString('base64')}]});
   if(dir)for(const name of(await fsp.readdir(file)).sort())await visit(rel?rel+'/'+name:name);
  }
  await visit('');calls.at(-1).endProgress=tree.progressCount();
  return{schema:1,platform:'ntfs-objects-v1',revision,entries};
 };
}

test('seal advances the progress count per file between capture and the closing verification, and its progress-free gaps stay bounded',{timeout:600000},async t=>{
 const N=Number(process.env.RUYI_GAP_N||2000);
 const f=await fixture(t,{apiNames:['WorkDataTree']}),ownership={roots:[f.base]},exclusive=value=>value===ownership,tree=f.api.WorkDataTree,calls=[];
 await f.write('config.json',JSON.stringify({workDataEncryptionV1:false}));
 for(let i=0;i<N;i++)await f.write('sessions/sess_gap_'+i+'.json',JSON.stringify({id:'sess_gap_'+i,messages:[{role:'user',content:'x'.repeat(300)}]}));
 const manifest=f.api.WorkDataManifest.create({base:f.base});
 const owner=f.api.WorkDataFullSnapshot.create({base:f.base,ownership,assertExclusive:exclusive,assertExclusiveSync:exclusive,protector:f.a,externalOwner:f.api.ExternalBotCredentials.create,
  preservedRead:{profile:'bounded-native-v1',capturePreserved:progressingModel(tree,calls)},readCapturedAuthority:captured=>manifest.readCaptured(captured)});
 let last=tree.progressCount(),lastAt=performance.now(),maxGap=0;
 const watch=setInterval(()=>{const now=tree.progressCount(),at=performance.now();if(now!==last){maxGap=Math.max(maxGap,at-lastAt);last=now;lastAt=at;}},5);
 const started=performance.now();
 try{await owner.seal({password,appVersion:'3.0.1',generation:null});}finally{clearInterval(watch);}
 maxGap=Math.max(maxGap,performance.now()-lastAt);
 assert.equal(calls.length,4,'capture (two readings) and one closing verification (two readings)');
 const between=calls[2].startProgress-calls[1].endProgress;
 console.log('# N',N,'seal ms',Math.round(performance.now()-started),'progress between capture and verify',between,'longest progress-free gap ms',Math.round(maxGap));
 assert.ok(between>=3*N,'analyze, package sealing and source identities each advance the count per file: '+between+' < '+3*N);
 assert.ok(maxGap<3000,'longest progress-free gap '+Math.round(maxGap)+' ms');
});
