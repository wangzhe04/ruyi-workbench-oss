'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {createFixture}=require('../lib/work-data-production-host-fixture');
const {transform}=require('./work-data-owned-restore-adapter-production-preview.cjs');
function fixture(){const original=fs.readFileSync;try{fs.readFileSync=function(name,...args){const out=original.call(this,name,...args);return typeof name==='string'&&name.endsWith('13aq-work-data-native-adapters.js')?transform(original.call(this,'output/semantic-gemma-q4-backup-diagnostic-v1/source-input/src/13aq-work-data-native-adapters.js','utf8')):out;};return createFixture();}finally{fs.readFileSync=original;}}
test('actual 13aq callback unknown latches before keeper release',async()=>{
 const f=fixture(),owner=await f.lease([f.paths.base,f.paths.backup]),native=Object.assign(Error('pending'),{code:'native.pending',helperMayStillRun:true}),wrapped=Object.assign(Error('restore failed'),{code:'work_data_full.restore_failed',cause:native,helperMayStillRun:true,ownershipRetained:true,operationMayHaveExecuted:true});
 f.nativeBindings.fullSnapshot.create=options=>({restore:async()=>{assert.equal(typeof options.ownedRestoreFlush,'function');throw wrapped;}});
 await assert.rejects(f.native.fullSnapshot(f.paths.base,owner,value=>value===owner).restore({target:f.paths.backup,targetOwnership:owner}),e=>e===wrapped||e.cause===wrapped);
 assert.equal(f.native.helperMayStillRun(),true);assert.ok(f.servers.every(server=>server.closeCalls===0));await assert.rejects(owner.release());
});

