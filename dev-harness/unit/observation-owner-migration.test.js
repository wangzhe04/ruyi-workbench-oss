'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {fixture}=require('../lib/work-data-migration-host-fixture');
test('full snapshot and migration host retain the typed journal owner and its history',async t=>{
 const f=await fixture(t),history=[{role:'tool',content:'synthetic owner migration evidence'}],raw=JSON.stringify(history),digest=crypto.createHash('sha256').update(raw).digest('hex'),prefix='history:3:'+digest.slice(0,16);
 await f.write('config.json','{}');await f.write('sessions/sid.json',JSON.stringify({id:'sid',messages:[],providerHistory:history}));
 await f.write('checkpoints/sid/history-3-'+digest.slice(0,16)+'.json.gz',zlib.gzipSync(raw));
 await f.write('checkpoints/sid/observation-owners-v1.json',JSON.stringify({schema:1,sessionId:'sid',anchor:'a'.repeat(64),rewindGen:0,items:[{prefix,digest}],mac:'b'.repeat(64)}));
 const expected=await f.manifest.readActive(),backup=await f.backupFirst(),prepared=await f.host.prepare({...backup,expected,targetMode:'encrypted'});
 assert.ok(prepared.transformed.some(row=>row.family==='journal-observation-owners'));assert.ok(prepared.transformed.some(row=>row.family==='journal-history'));
 await f.host.publish(prepared);const proof=await f.host.verifyPublished(prepared);assert.equal(proof.readOnly,true);
});
