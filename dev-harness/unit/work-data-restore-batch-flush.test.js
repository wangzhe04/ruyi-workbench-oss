'use strict';
// 151 阶段 3D v2(审查 L4):01ab 恢复写文件的两条守卫,用真实 01ab(full-snapshot 夹具)+ 只在本测试里包一层的
// fs/promises 代理(按名字挂钩子,默认原样转发):
//   - 每批刷盘用 allSettled:一个文件刷盘失败时,同批其余句柄全部关闭后才把错误抛出;
//   - 每个文件写入前对直接父目录做一次 lstat 身份核对:证明之后被换掉的父目录按 target_alias 拒绝,不往新目录里写。
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {fixture,password}=require('../lib/work-data-full-snapshot-fixture');
const src=path.resolve(__dirname,'../../ruyi-workbench/app/src');
const TAIL="})(require('node:fs/promises'),require('node:path')";
const PROXY="})((()=>{const real=require('node:fs/promises');return new Proxy(real,{get(target,name){const value=target[name];const hook=globalThis.__restoreHooks&&globalThis.__restoreHooks[name];const bound=typeof value==='function'?value.bind(target):value;return hook?hook(bound):bound;}});})(),require('node:path')";
const source=name=>{const text=fs.readFileSync(path.join(src,name),'utf8');if(name!=='01ab-work-data-full-snapshot.js')return text;assert.equal(text.split(TAIL).length,2,'01ab module tail');return text.replace(TAIL,PROXY);};
const opaque=letter=>letter.repeat(32),revision='e'.repeat(32);
async function sealedRoot(t){
 const f=await fixture(t,{source});
 const files={[`uploads/${opaque('a')}/${revision}/part-000000.json`]:JSON.stringify({workData:2,envelope:{ciphertext:'A0'}}),
  [`uploads/${opaque('b')}/${revision}/part-000000.json`]:JSON.stringify({workData:2,envelope:{ciphertext:'B0'}}),
  [`uploads/${opaque('b')}/${revision}/part-000001.json`]:JSON.stringify({workData:2,envelope:{ciphertext:'B1'}}),
  [`uploads/${opaque('b')}/${revision}/part-000002.json`]:JSON.stringify({workData:2,envelope:{ciphertext:'B2'}})};
 for(const [relative,text] of Object.entries(files))await f.write(relative,text);
 const sealed=await f.owner().seal({password,appVersion:'3.0.1',generation:0});
 return {f,sealed};
}
const codes=error=>{const found=[];const seen=new Set();const walk=(value,depth)=>{if(!value||typeof value!=='object'||depth>12||seen.has(value))return;seen.add(value);if(typeof value.code==='string')found.push(value.code);walk(value.cause,depth+1);if(Array.isArray(value.errors))for(const item of value.errors)walk(item,depth+1);};walk(error,0);return found;};

test('a failed batch flush is thrown only after every handle of that batch has been closed',async t=>{
 const {f,sealed}=await sealedRoot(t),target=path.join(f.root,'restored-flush');
 let opened=0,closed=0,failedOne=false;
 f.context.__restoreHooks={open:open=>async(file,flags,...rest)=>{
  const handle=await open(file,flags,...rest);if(flags!=='r+')return handle;opened++;
  const first=!failedOne;failedOne=true;
  return new Proxy(handle,{get(target,name){
   if(name==='sync')return first?async()=>{throw Object.assign(Error('synthetic flush refusal'),{code:'EIO'});}:async()=>{await new Promise(resolve=>setTimeout(resolve,300));return target.sync();};
   if(name==='close')return async()=>{try{return await target.close();}finally{closed++;}};
   const value=target[name];return typeof value==='function'?value.bind(target):value;}});
 }};
 let atReject=null;
 await assert.rejects(f.owner().restore({serialized:sealed.serialized,password,target}).catch(error=>{atReject={opened,closed};throw error;}));
 assert.ok(atReject.opened>=2,'several files were in the same flush batch: '+JSON.stringify(atReject));
 assert.equal(atReject.closed,atReject.opened,'every handle of the failed batch was closed before the failure surfaced');
});

test('a parent directory replaced after its proof is refused as target_alias before the next write',async t=>{
 const {f,sealed}=await sealedRoot(t),target=path.join(f.root,'restored-alias');
 const parent=path.join(target,'uploads',opaque('b'),revision);let swapped=false,wroteAfterSwap=false;
 f.context.__restoreHooks={open:open=>async(file,flags,...rest)=>{
  if(swapped&&flags==='wx')wroteAfterSwap=true;
  const handle=await open(file,flags,...rest);
  if(flags!=='wx'||swapped||path.dirname(file).toLowerCase()!==parent.toLowerCase())return handle;
  return new Proxy(handle,{get(inner,name){
   if(name==='close')return async()=>{const result=await inner.close();swapped=true;await fsp.rename(parent,parent+'-old');await fsp.mkdir(parent);return result;};
   const value=inner[name];return typeof value==='function'?value.bind(inner):value;}});
 }};
 const error=await f.owner().restore({serialized:sealed.serialized,password,target}).then(()=>null,value=>value);
 assert.ok(error,'the swapped parent cannot complete a restore');assert.equal(swapped,true);
 assert.ok(codes(error).includes('work_data_full.target_alias'),'refused as an alias: '+codes(error).join(','));
 assert.equal(wroteAfterSwap,false,'no file was written into the replacement directory');
});
