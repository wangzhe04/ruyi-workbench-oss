'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {fixture}=require('../lib/fulltext-owned-producer-fixture');

test('admission gates semantic-only results without removing lexical results',async t=>{
  const f=await fixture();t.after(()=>f.close());
  for(const [id,content] of [['A','needle exact evidence'],['B','unrelated subject'],['C','approved subject']])await f.put(id,[{role:'user',id:'m',turnSeq:1,content}]);
  let invalid=false,partial=false,seen=[];
  const semantic={score:async(_query,docs)=>{seen=Array.from(docs);return {status:'ready',scores:docs.map(()=>0.99),minScore:0.2,coverage:{cached:docs.length,total:docs.length,complete:!partial},admission:{policyId:'test-policy',status:partial?'partial':'evaluated',purpose:'search-relevance',answerability:'not-assessed',accepted:invalid?[]:docs.map(doc=>doc.toUpperCase().includes('APPROVED')?(partial?null:true):false)}};}};
  const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,resultUnit:'sessions',semantic});await index.step(16);
  const result=await index.search('needle',null,10),ids=result.results.map(hit=>hit.reference.sessionId);
  assert.ok(ids.includes('A'),'lexical result remains visible');assert.ok(ids.includes('C'),`accepted semantic candidate appears; docs=${JSON.stringify(seen)} ids=${JSON.stringify(ids)}`);assert.ok(!ids.includes('B'),'rejected semantic-only candidate stays out');assert.equal(result.semantic.admission.policyId,'test-policy');
  partial=true;const incomplete=await index.search('needle',null,10);assert.equal(incomplete.semantic.coverage,'partial');assert.equal(incomplete.semantic.admission.status,'partial');assert.deepEqual(Array.from(incomplete.results,hit=>hit.reference.sessionId),['A']);
  invalid=true;await assert.rejects(index.search('needle',null,10),{code:'session_fulltext.semantic_policy_invalid'});
});
