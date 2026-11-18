'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {functionBlock}=require('../lib/source-slice'),source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/02-session-store.js'),'utf8');
function fixture(){
 const history=[{role:'tool',content:'independently committed original'}],digest=crypto.createHash('sha256').update(JSON.stringify(history)).digest('hex'),prefix='history:4:'+digest.slice(0,16),key=crypto.randomBytes(32),operation={enabled:true,credential:async()=>({key,instanceId:'a'.repeat(32)})},state={writes:0,checks:0,value:null,failAt:0,publishError:null};
 const context={require,Buffer,crypto,path,withJournalWriteLock:(_id,work)=>work(),withJournalArtifactOperation:work=>work(operation),journalArtifactFailure:code=>Object.assign(Error(code),{code:'work_data.journal_'+code}),journalReadHistory:async()=>history,journalReadObservationOwners:async()=>state.value,journalDir:()=>'/synthetic',fsp:{stat:async()=>({size:100}),unlink:async()=>{throw Error('blind rollback forbidden');}},journalBytesAdjust:()=>{},journalJsonStore:()=>({async write(text){state.writes++;state.value=JSON.parse(text);if(state.publishError)throw state.publishError;}})};
 const api=vm.runInNewContext(['journalObservationOwnersValid','journalObservationOwnerMac','journalRegisterObservationOwner'].map(name=>functionBlock(source,name)).join('\n')+'\n({journalRegisterObservationOwner,journalObservationOwnerMac});',context);
 const register=()=>api.journalRegisterObservationOwner('sid','b'.repeat(64),0,prefix,async()=>{state.checks++;if(state.checks===state.failAt)throw Object.assign(Error('execution cancelled'),{code:'permission.owner_cancelled'});});
 return{api,state,register,operation,digest};
}
test('cancellation at the final prepublication guard writes no owner proof',async()=>{
 const f=fixture();f.state.failAt=3;await assert.rejects(f.register(),{code:'permission.owner_cancelled'});assert.equal(f.state.writes,0);assert.equal(f.state.value,null);
});
test('postpublication cancellation leaves only an authenticated historical fact, never a successful turn receipt',async()=>{
 const f=fixture();f.state.failAt=4;await assert.rejects(f.register(),{code:'permission.owner_cancelled'});assert.equal(f.state.writes,1);assert.equal(f.state.value.items[0].digest,f.digest);
 const expected=await f.api.journalObservationOwnerMac(f.state.value,f.operation);assert.equal(f.state.value.mac,expected.toString('hex'));assert.equal(Object.hasOwn(f.state.value,'executionOwner'),false);assert.equal(Object.hasOwn(f.state.value,'turnCompleted'),false);
});
test('a write that publishes then reports failure is not blindly undone or reported successful',async()=>{
 const f=fixture();f.state.publishError=Object.assign(Error('publication acknowledgement failed'),{code:'EIO'});await assert.rejects(f.register(),{code:'EIO'});assert.equal(f.state.writes,1);assert.equal(f.state.value.items[0].digest,f.digest);assert.equal(f.state.checks,3);
});
