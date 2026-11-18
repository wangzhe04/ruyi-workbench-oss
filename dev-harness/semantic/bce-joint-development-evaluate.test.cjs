'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{bceReplay,chineseAxis}=require('./bce-joint-development-evaluate.cjs'),{pairKey,queryModelKey}=require('./minilm-reranker-joint-evaluate.cjs');
function context({strong=false,weak=false,unknown=false}={}){
  const q={id:'q',split:'train',kind:'ood',group:'negative-ood',relevant:[]},doc={id:'A',ordinal:0,text:'text'},p={queryId:'q',fixtureDocumentId:'A',start:0,end:4},k=pairKey(p),logit=-2.9;
  return {q,ctx:{documents:new Map([['A',doc]]),ranks:new Map([[queryModelKey('q','coarse'),[{id:'A',rank:1,cosine:.2}]]]),captures:new Map([['q',{hits:strong||weak?[{fixtureDocumentId:'A',strong,reference:{source:'content'}}]:[]}]]),pairs:new Map([[k,p]]),scores:new Map([['bce',new Map([[k,{status:unknown?'UNKNOWN_OVER_512':'SCORED',tokens:unknown?513:10,logit,score:1/(1+Math.exp(-logit)),inferenceMs:1}]])]]),lexicalFacts:()=>({exact:false,score:1})}};
}
test('BCE uses sigmoid relevance score rather than raw logit or inheritedQwen.95',()=>{
  const {q,ctx}=context(),replay=bceReplay().replay,base={k:1,coarseMinimum:null};assert.equal(replay(ctx,q,'coarse','bce',{...base,probabilityMinimum:.05}).top.length,1);assert.equal(replay(ctx,q,'coarse','bce',{...base,probabilityMinimum:.1}).top.length,0);
});
test('BCE weak work bypasses coarse threshold and unknown remains partial',()=>{
  const replay=bceReplay().replay,base={k:1,coarseMinimum:.48,probabilityMinimum:.05};let {q,ctx}=context({weak:true});const known=replay(ctx,q,'coarse','bce',base);assert.equal(known.requiredPairs,1);assert.equal(known.top[0].weakLexical,true);assert.equal(known.top[0].semantic,false);
  ({q,ctx}=context({weak:true,unknown:true}));const unknown=replay(ctx,q,'coarse','bce',base);assert.equal(unknown.complete,false);assert.equal(unknown.top.length,0);
});
test('Chinese-only OOD denominator cannot be diluted by English negatives',()=>{
  const full={coverage:{partial:0},quality:{groups:{'zh-zh':{count:9,recallAt5:1,mrr:1},'exact-entity':{count:18,recallAt5:1}}},entityMismatch:{count:18,conservativeFprUpperBound:0}};
  assert.equal(chineseAxis(full,{count:60,conservativeFprUpperBound:2/60}),true,'explicit mixed-OOD axis only');assert.equal(chineseAxis(full,{count:30,conservativeFprUpperBound:2/30}),false,'Chinese-only fails6.67percent');assert.equal(chineseAxis(full,{count:0,conservativeFprUpperBound:null}),false);
});
