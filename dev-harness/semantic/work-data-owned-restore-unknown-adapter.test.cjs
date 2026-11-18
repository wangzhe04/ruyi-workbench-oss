'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{createFixture}=require('../lib/work-data-production-host-fixture');
test('actual 13aq restore adapter latches wrapped barrier unknown before source keepers release',async()=>{
 const f=createFixture(),owner=await f.lease([f.paths.base,f.paths.backup]),native=Object.assign(Error('pending'),{code:'native.pending',helperMayStillRun:true}),wrapped=Object.assign(Error('restore failed'),{code:'work_data_full.restore_failed',cause:native,helperMayStillRun:true,ownershipRetained:true,operationMayHaveExecuted:true});
 f.nativeBindings.fullSnapshot.create=()=>({restore:async()=>{throw wrapped;}});
 await assert.rejects(f.native.fullSnapshot(f.paths.base,owner,value=>value===owner).restore({target:f.paths.backup,targetOwnership:owner}),e=>e===wrapped||e.cause===wrapped);
 assert.equal(f.native.helperMayStillRun(),true);assert.ok(f.servers.every(server=>server.closeCalls===0));await assert.rejects(owner.release());
});
