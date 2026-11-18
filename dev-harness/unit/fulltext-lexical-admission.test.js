'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {fixture}=require('../lib/fulltext-owned-producer-fixture');
test('verified same-field strong lexical survives; fully scored weak evidence needs semantic admission',async t=>{
 const f=await fixture();t.after(()=>f.close());
 for(const [id,content] of [['Strong','cedar '+ 'filler '.repeat(800)+'violet'],['Phrase','cedar violet exact'],['Reject','cedar unrelated item'],['Accept','cedar approved item'],['Pending','cedar pending item']])await f.put(id,[{role:'user',id:'m',turnSeq:1,content}]);
 let mode='full';const semantic={score:async(_q,docs)=>({status:mode==='full'?'ready':'unavailable',scores:docs.map(x=>mode==='off'?null:x.includes('APPROVED')?.9:.2),minScore:.34,coverage:{cached:mode==='full'?docs.length:0,total:docs.length,complete:mode==='full'},admission:{policyId:'test-policy',status:mode==='full'?'evaluated':'partial',purpose:'search-relevance',accepted:docs.map(x=>mode==='off'||x.includes('PENDING')?null:x.includes('APPROVED'))}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);
 const value=await index.search('cedar violet',null,20),ids=value.results.map(x=>x.reference.sessionId);assert.ok(ids.includes('Strong'));assert.ok(ids.includes('Phrase'));assert.ok(ids.includes('Accept'));assert.ok(ids.includes('Pending'));assert.ok(!ids.includes('Reject'));assert.equal(value.lexicalAdmission.partial,true);
 mode='off';const fallback=await index.search('cedar violet',null,20);assert.ok(fallback.results.some(x=>x.reference.sessionId==='Reject'));assert.equal(fallback.lexicalAdmission.partial,true);
});

test('complete query terms across fragments require one verified original field',async t=>{
 const f=await fixture();t.after(()=>f.close());const filler=' x '.repeat(600);
 await f.put('All',[{role:'user',id:'m',turnSeq:1,content:'amber'+filler+'birch'+filler+'cobalt'+filler+'dahlia'}]);
 await f.put('Split',[{role:'user',id:'m',turnSeq:1,content:['amber birch','cobalt dahlia']}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(()=>.1),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(()=>false)}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);
 const value=await index.search('amber birch cobalt dahlia',null,20),ids=value.results.map(x=>x.reference.sessionId);assert.ok(ids.includes('All'));assert.ok(!ids.includes('Split'));
});

test('rejected weak source does not mask a strong field in the same session',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.put('Mix',[{role:'user',id:'weak',turnSeq:1,content:'cedar cedar cedar'},{role:'assistant',id:'strong',turnSeq:1,content:'cedar '+ 'filler '.repeat(800)+'violet'}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(()=>.1),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(()=>false)}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);const value=await index.search('cedar violet',null,20);assert.equal(value.results.length,1);assert.equal(value.results[0].reference.messageId,'strong');
});

test('user limit is applied after a larger complete semantic candidate pool',async t=>{
 const f=await fixture();t.after(()=>f.close());for(let i=0;i<12;i++)await f.put('Session'+i,[{role:'user',id:'m',content:'unrelated item '+i}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(()=>.9),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(()=>true)}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);const value=await index.search('unknown phrase',null,1);assert.equal(value.results.length,1);assert.equal(value.lexicalAdmission.truncated,false);assert.equal(value.lexicalAdmission.partial,false);
});

test('weak lexical field cannot borrow semantic admission from a different message',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.put('Mix',[{role:'user',id:'weak',turnSeq:1,content:'cedar unrelated'},{role:'assistant',id:'other',turnSeq:1,content:'approved independent material'}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(x=>x.includes('APPROVED')?.9:.1),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(x=>x.includes('APPROVED'))}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);const value=await index.search('cedar violet',null,20);assert.equal(value.results.length,1);assert.equal(value.results[0].reference.messageId,'other');
});

test('verified strong field cannot be displaced by rejected weak fields before user cap',async t=>{
 const f=await fixture();t.after(()=>f.close());for(let n=0;n<5;n++)await f.put('AWeak'+n,[{role:'user',id:'m',content:'cedar unrelated'}]);await f.put('ZStrong',[{role:'user',id:'m',content:'cedar '+ 'filler '.repeat(800)+'violet'}]);
 const semantic={score:async(_q,docs)=>({status:'ready',scores:docs.map(()=>.1),minScore:.34,coverage:{cached:docs.length,total:docs.length,complete:true},admission:{policyId:'test',status:'evaluated',purpose:'search-relevance',accepted:docs.map(()=>false)}})};
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);const value=await index.search('cedar violet',null,1);assert.equal(value.results.length,1);assert.equal(value.results[0].reference.sessionId,'ZStrong');
});

test('strong-term cross-window fallback does not duplicate phrase yet preserves separate occurrences',async t=>{
 const f=await fixture();t.after(()=>f.close());await f.put('Repeat',[{role:'user',id:'m',content:'cedar violet'+ ' filler'.repeat(900)+' cedar violet'}]);
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'references'});await index.step(16);const value=await index.search('cedar violet',null,20),starts=value.results.map(row=>row.reference.matchStart);assert.equal(starts.length,2);assert.equal(new Set(starts).size,2);
});
