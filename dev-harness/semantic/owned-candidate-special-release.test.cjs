'use strict';
// Runs from the owned special test tree. Hooks only force the check failure and
// expose the real captured object; release and Buffer wiping are product code.
const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../lib/work-data-migration-host-fixture');
for(const check of ['root','streams'])test('captured target is released and zeroed when '+check+' check fails',async t=>{
 const f=await fixture(t,{preserved:true,failTargetCheck:check});await f.write('config.json','{}');await f.write('sessions/one.json','{"id":"one"}');const expected=await f.manifest.readActive(),backup=await f.backupFirst();
 await assert.rejects(()=>f.host.prepare({...backup,expected,targetMode:'encrypted'}),e=>e.code==='test.target_check');
 const target=f.context.__testTarget,reader=f.context.__testTargetReader;assert.ok(target&&reader);assert.ok(target.files.length>0);for(const row of target.files){assert.ok(Buffer.isBuffer(row.data));assert.ok(row.data.every(value=>value===0));}
 await assert.rejects(()=>reader.verify(target),e=>e.code==='work_data_tree.snapshot_unavailable');
});
