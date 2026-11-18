'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {replayQuery,metrics,evaluate,pairKey,queryModelKey}=require('./minilm-reranker-joint-evaluate.cjs');
function setup({strong=false,weak=false,cosine=.9,known=true,over=false}={}){
  const query={id:'q',text:'synthetic query',split:'train',kind:'positive',group:'zh-zh',relevant:['B']},documents=new Map(['A','B','C'].map((id,ordinal)=>[id,{id,ordinal,text:'source '+id}]));
  const raw=[...documents.values()].map((doc,index)=>({id:doc.id,rank:index+1,cosine:index===0?cosine:.8-index*.1})),pairs=new Map(),scores=new Map();
  for(const doc of documents.values()){const p={queryId:'q',fixtureDocumentId:doc.id,start:0,end:doc.text.length},key=pairKey(p);pairs.set(key,p);if(known)scores.set(key,{status:over?'UNKNOWN_OVER_512':'SCORED',tokens:over?513:20,logit:3,inferenceMs:1});}
  const hits=strong||weak?[{fixtureDocumentId:'A',strong,reference:{source:'content'}}]:[],ctx={queries:[query],documents,ranks:new Map([[queryModelKey('q','coarse'),raw]]),captures:new Map([['q',{hits}]]),pairs,scores:new Map([['cross',scores]]),lexicalFacts:()=>({exact:false,score:3}),coarseIds:['coarse'],verifierIds:['cross']};
  return {ctx,query,policy:{k:1,coarseMinimum:null,logitMinimum:0}};
}
test('chooseK before strong bypass; strong never receives semantic RRF or refill',()=>{
  const {ctx,query,policy}=setup({strong:true}),row=replayQuery(ctx,query,'coarse','cross',policy);assert.deepEqual(row.selectedRawIds,['A']);assert.equal(row.requiredPairs,0);assert.equal(row.top.length,1);assert.equal(row.top[0].semantic,false);assert.equal(row.top[0].rankScore,1/61);
});
test('coarse cosine gate cannot remove required weak lexical verification',()=>{
  const {ctx,query,policy}=setup({weak:true,cosine:.2}),row=replayQuery(ctx,query,'coarse','cross',{...policy,coarseMinimum:.34});assert.equal(row.requiredPairs,1);assert.equal(row.top[0].weakLexical,true);assert.equal(row.top[0].semantic,false);
});
test('same exact window semantic and weak roles share one real pair and add two RRF contributions',()=>{
  const {ctx,query,policy}=setup({weak:true}),row=replayQuery(ctx,query,'coarse','cross',policy);assert.equal(row.requiredPairs,1);assert.equal(row.top[0].rankScore,2/61);assert.equal(row.top[0].semantic,true);
});
test('unknown over512 and missing logits are withheld/partial, never counted true negatives',()=>{
  for(const options of [{over:true},{known:false}]){const {ctx,query,policy}=setup(options),row=replayQuery(ctx,{...query,kind:'ood'},'coarse','cross',policy),value=metrics([row]);assert.equal(row.complete,false);assert.equal(row.top.length,0);assert.equal(value.pureOod.count,1);assert.equal(value.pureOod.trueNegatives,0);assert.equal(value.pureOod.conservativeFprUpperBound,1);}
});
test('rejected pair is not replaced outsideK and scalar does not reorder accepted coarse results',()=>{
  const {ctx,query,policy}=setup();ctx.scores.get('cross').get(pairKey({queryId:'q',fixtureDocumentId:'A',start:0,end:8})).logit=-2;
  assert.equal(replayQuery(ctx,query,'coarse','cross',policy).top.length,0);
  ctx.scores.get('cross').get(pairKey({queryId:'q',fixtureDocumentId:'A',start:0,end:8})).logit=1;
  const row=replayQuery(ctx,query,'coarse','cross',{...policy,k:3});assert.deepEqual(row.top.map(x=>x.id),['A','B','C']);
});
test('missing public union field is an integrity error, not an implicit reject or sibling substitute',()=>{
  const {ctx,query,policy}=setup();ctx.pairs.clear();assert.throws(()=>replayQuery(ctx,query,'coarse','cross',policy),/missing prescribed pair/);
});
test('pure OOD FPR is not diluted by identifier mismatch denominator',()=>{
  const {ctx,query,policy}=setup(),ood=replayQuery(ctx,{...query,kind:'ood'},'coarse','cross',policy),id={...ood,kind:'entity-mismatch',top:[],admittedBeforeFinalCap:[]},value=metrics([ood,...Array(20).fill(id)]);assert.equal(value.pureOod.anyResultFpr,1);assert.equal(value.pureOod.count,1);assert.equal(value.entityMismatch.count,20);assert.equal(value.entityMismatch.anyResultFpr,0);
});
test('nine model combinations and88 predeclared operations are retained, even if models fail floors',()=>{
  const {ctx,query}=setup();ctx.coarseIds=['c1','c2','c3'];ctx.verifierIds=['r1','r2','r3'];const raw=ctx.ranks.get(queryModelKey('q','coarse')),scores=ctx.scores.get('cross');for(const id of ctx.coarseIds)ctx.ranks.set(queryModelKey('q',id),raw);for(const id of ctx.verifierIds)ctx.scores.set(id,scores);
  const protocol=require('./minilm-family-matrix-protocol.json'),result=evaluate(ctx,protocol);assert.equal(result.candidates.length,792);assert.equal(new Set(result.candidates.map(x=>[x.policy.coarseModel,x.policy.verifier].join(':'))).size,9);assert.equal(result.passing.length,0);
});
