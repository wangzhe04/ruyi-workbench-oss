'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {retainIssued,releaseOwner,stats}=require('./owned-candidate-issued-child-research.cjs');
test('spawn-before-return failure retains child and owner until observed close',()=>{
 const owner={},child=new EventEmitter();child.on('error',()=>{});
 const before=stats();retainIssued(child,owner);child.emit('error',Error('startup'));
 assert.equal(stats().issued,before.issued+1);assert.throws(()=>releaseOwner(owner,[]),/still_running/);
 child.emit('close',1);assert.equal(stats().issued,before.issued);releaseOwner(owner);assert.equal(stats().retainedOwners,before.retainedOwners);
});
