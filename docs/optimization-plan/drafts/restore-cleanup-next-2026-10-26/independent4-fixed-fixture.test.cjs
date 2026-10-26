'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root='C:/Users/87179/Documents/Claude Code/ruyi-workbench-oss',runtime='C:/Users/87179/AppData/Local/Temp/ruyi-review-target-20261026-3b768956/support-review/fixed-src';
const {functionBlock}=require(p.join(root,'dev-harness/lib/source-slice.js'));
const text=file=>fs.readFileSync(p.join(runtime,file),'utf8'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(Error(code),{code});};
const loadStore=(bridge)=>vm.runInNewContext(functionBlock(text('01p-work-data-store.js'),'capturedCleanupFailure')+'\n'+functionBlock(text('01p-work-data-store.js'),'withCapturedFile')+';withCapturedFile;',{Hooks:{capturedFiles:Object.freeze(bridge)},Buffer,fail});
test('store release is still attempted when actual captured-buffer detachment makes zeroing fail',async()=>{
 let released=0,moved;const bytes=Buffer.alloc(8192,31),token={release(){released++;}};
 const run=loadStore({assert:()=>true,verify:async()=>true,read:async()=>bytes});let caught;
 try{await run({capturedFile:token},'synthetic',async raw=>{moved=structuredClone(raw.buffer,{transfer:[raw.buffer]});throw false;});}catch(e){caught=e;}finally{if(moved)Buffer.from(moved).fill(0);}
 a.equal(caught.errors[0],false);a.equal(caught.errors[1].name,'TypeError');a.equal(released,1,'lease release must not be skipped when memory cleanup fails');
});
test('store detached result cleanup cannot replace a false verification primary',async()=>{
 let verifies=0,released=0,moved;const bytes=Buffer.alloc(8192,31),token={release(){released++;}};
 const run=loadStore({assert:()=>true,verify:async()=>{if(++verifies===2)throw false;return true;},read:async()=>bytes});let caught;
 try{await run({capturedFile:token},'synthetic',async()=>{const output=Buffer.alloc(8192,21);moved=structuredClone(output.buffer,{transfer:[output.buffer]});return output;});}catch(e){caught=e;}finally{if(moved)Buffer.from(moved).fill(0);}
 a.equal(released,1);a.equal(caught?.errors?.[0],false,'primary false must survive cleanup of failed owned result');a.equal(caught?.errors?.at(-1)?.name,'TypeError');
});
test('preserved census releases second native result after first release rejects false',async()=>{
 let firstReleases=0,secondReleases=0;const bytes=Buffer.alloc(8192,42),first={rows:[{rel:'',dir:true,id:'000000010000000000000001',streams:[]},{rel:'a',dir:false,id:'000000010000000000000002',data:bytes,streams:[{name:'',hash:sha(bytes)}]}],used:8192,nativeSha256:'fixed',release(){firstReleases++;throw false;}},second={nativeSha256:'fixed',release(){secondReleases++;}};
 let n=0;const context={admitted:async()=>{},realDirectory:async()=>{},parse:value=>value,capturePreserved:async()=>++n===1?first:second,cryptoApi:crypto,pathApi:p,fsApi:{lstat:async file=>({dev:1n,ino:file.endsWith(p.sep+'a')?2n:1n,nlink:1n,size:8192n,isSymbolicLink:()=>false,isDirectory:()=>!file.endsWith(p.sep+'a'),isFile:()=>file.endsWith(p.sep+'a')}),realpath:async file=>file},samePath:(a,b)=>a===b,identity:s=>s.dev+':'+s.ino,Buffer,fail};
 const census=vm.runInNewContext(functionBlock(text('01aa-work-data-tree.js'),'capturedCleanupFailure')+'\n'+functionBlock(functionBlock(text('01aa-work-data-tree.js'),'createPreserved'),'census')+';census;',context);let thrown;try{await census(p.resolve('synthetic-root'),true);}catch(e){thrown=e;}
 a.equal(Array.isArray(thrown?.errors)?thrown.errors[0]:thrown,false);a.equal(firstReleases,1);a.equal(secondReleases,1,'second captured native bytes must still be released after first cleanup rejects');
});
test('restored fingerprint must retain false verification primary when captured release rejects null',async()=>{
 const owner={roots:[p.resolve('synthetic-root')]};let released=0;const captured={release(){released++;throw null;}};
 const restoredTreeFor=async()=>({capture:async()=>captured,verify:async()=>{throw false;},fingerprint:()=>{throw Error('unreachable');}});
 const context={restoredTreeFor,admission:async()=>{},keyOfPath:p.resolve,fail,Object};
 const fn=vm.runInNewContext(functionBlock(text('01ab-work-data-full-snapshot.js'),'capturedCleanupFailure')+'\n'+functionBlock(text('01ab-work-data-full-snapshot.js'),'restoredFingerprint')+';restoredFingerprint;',context);let error;try{await fn(owner.roots[0],owner,()=>true);}catch(e){error=e;}
 a.equal(released,1);a.equal(error?.errors?.[0],false,'original false verification reason must remain first');a.equal(error?.errors?.[1],null,'release null remains second cause');
});
