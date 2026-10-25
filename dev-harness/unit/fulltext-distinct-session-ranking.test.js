'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('../lib/fulltext-consumer-fixture.js');
test('session result limit counts distinct sessions despite many equal-scored chunks in one session',async t=>{
 const f=await fixture();t.after(()=>f.close());
 await f.put('A_dense',[{role:'user',id:'dense_message',turnSeq:1,content:'ranking needle '.repeat(6000)}],{head:{title:'dense source'}});
 await f.put('B_sparse',[{role:'user',id:'sparse_message',turnSeq:1,content:'one ranking needle match'}],{head:{title:'sparse source'}});
 const value=await f.ui('ranking needle',null,()=>f.hooks.search('ranking needle',2));
 fs.writeFileSync(require('node:path').join(f.directory,'distinct-session-ranking-observation.json'),JSON.stringify(value,null,2)+'\n');
 assert.equal(value.coverage.complete,true);
 assert.deepEqual(Array.from(value.results,row=>row.id).sort(),['A_dense','B_sparse']);
});
