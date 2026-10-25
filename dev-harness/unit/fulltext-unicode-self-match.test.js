'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('../lib/fulltext-consumer-fixture.js');
test('an exact persisted Unicode query matches itself under the same normalization as its index source',async t=>{
 const f=await fixture();t.after(()=>f.close());
 await f.put('Greek',[{role:'user',id:'unicode_message',turnSeq:1,content:'ΤΕΛΙΚΟΣ'}],{head:{title:'Unicode source'}});
 const value=await f.ui('ΤΕΛΙΚΟΣ');
 fs.writeFileSync(require('node:path').join(f.directory,'unicode-self-match-observation.json'),JSON.stringify(value,null,2)+'\n');
 a.equal(value.coverage.complete,true);a.equal(value.results.length,1);a.equal(value.results[0].id,'Greek');
 a.equal('ΤΕΛΙΚΟΣ'.slice(value.results[0].reference.matchStart,value.results[0].reference.matchEnd),'ΤΕΛΙΚΟΣ');
});
