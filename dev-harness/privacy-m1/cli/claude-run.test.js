'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeMarker,sourceManifest}=require('./claude-run');
const {createDiagnosticObserver}=require('./claude-observer');
test('early runtime failure and marker never count as model/network success',()=>{
  for(const output of [[],[{kind:'claude-runtime-preload',runtime:'Bun',version:'synthetic'}]]){
    const summary=summarizeMarker({output,code:124,events:[{stage:'timeout'}]});assert.equal(summary.executedToPreload,output.length===1);assert.equal(summary.modelTransportEstablished,false);assert.equal(summary.networkProtectionEstablished,false);assert.equal(summary.cleanupVerified,false);
  }
});
test('source binding covers original preload, runner and native helper',()=>{const manifest=sourceManifest();assert.equal(manifest.sha256.length,64);for(const name of ['claude-run.js','claude-preload-marker.mjs','AppContainerHost.cs','../../lib/kill-own-tree.js'])assert(manifest.files.some(row=>row.path===name&&row.sha256.length===64));});
test('forged diagnostic strings, raw paths and arbitrary counts cannot persist',()=>{
  const observer=createDiagnosticObserver(),privateText='SYNTHETIC_PRIVATE_TEXT';
  observer.write(JSON.stringify({kind:'claude-fs-diagnostic',operation:privateText,pathClass:'C:\\private-review\\sentinel',pathSha256:'NOT_A_HASH',errorCode:privateText,version:privateText})+'\n');
  observer.write(JSON.stringify({kind:'claude-fs-diagnostic',operation:'event-loop-tick',phase:privateText,pathClass:privateText,pathSha256:'NOT_A_HASH',errorCode:privateText,runtime:privateText,version:privateText,counts:{[privateText]:123,stat:2}})+'\n');
  assert.equal(JSON.stringify(observer.events).includes(privateText),false);assert.equal(JSON.stringify(observer.events).includes('private-review'),false);assert.deepEqual(observer.events,[{operation:'event-loop-tick',errorCode:'unknown',counts:{stat:2}}]);assert.equal(observer.observed,false);
});
test('public fs audit wrapper preserves successful values and sync/callback/promise errors without emitting paths or contents',()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),{pathToFileURL}=require('node:url'),{childEnvironment,safeRemove}=require('./run');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-m1-cli-diagnostic-unit-')),fixture=path.join(root,'synthetic.txt'),secret='SYNTHETIC_PRIVATE_FILE_BYTES';fs.writeFileSync(fixture,secret);
  try{const script="const fs=require('node:fs');const file=process.env.RUYI_DIAGNOSTIC_TEST_FILE;const sync=fs.readFileSync(file,'utf8')==='SYNTHETIC_PRIVATE_FILE_BYTES';let syncError;try{fs.statSync(file+'.absent')}catch(e){syncError=e.code}fs.readFile(file+'.absent',async(error)=>{let promiseError;try{await fs.promises.stat(file+'.absent')}catch(e){promiseError=e.code}console.log(JSON.stringify({kind:'wrapper-contract',sync,syncError,callbackError:error.code,promiseError,native:fs.realpathSync.native(file)===file}));});";
    const output=cp.execFileSync(process.execPath,['--import',pathToFileURL(path.join(__dirname,'claude-diagnostic.mjs')).href,'--eval',script],{cwd:root,env:{...childEnvironment(root,root),RUYI_M1_PROJECTION:root,RUYI_DIAGNOSTIC_TEST_FILE:fixture},windowsHide:true,encoding:'utf8'});assert(!output.includes(root));assert(!output.includes(secret));const row=output.trim().split(/\r?\n/).map(line=>JSON.parse(line)).find(value=>value.kind==='wrapper-contract');assert.deepEqual(row,{kind:'wrapper-contract',sync:true,syncError:'ENOENT',callbackError:'ENOENT',promiseError:'ENOENT',native:true});
  }finally{safeRemove(root);}
});
