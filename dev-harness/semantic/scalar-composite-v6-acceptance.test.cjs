'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {adaptFixture,qualify}=require('./scalar-composite-v6-acceptance.cjs');
test('partially exposed v6 cannot run as a new blind evaluation',()=>{
  assert.throws(()=>require('./scalar-composite-v6-acceptance.cjs').assertBlindInputEligibility(),/holdout_exposed_requires_new_fixture/);
  assert.ok(!Object.keys(require.cache).some(name=>name.endsWith('acceptance-v6-fixture.cjs')));
});
function report(){
  const groups=['zh-zh','en-zh','zh-en','en-en'];
  const rows=[...groups.flatMap(group=>Array.from({length:20},()=>({kind:'positive',group,rank:1,complete:true,results:[{}]}))),
    ...Array.from({length:80},()=>({kind:'ood',rank:0,complete:true,results:[]})),
    ...Array.from({length:16},()=>({kind:'missing-field',rank:1,complete:true,results:[{}]})),
    ...Array.from({length:8},()=>({kind:'exact',rank:1,complete:true,results:[{}]}))];
  return {rows,coverageComplete:true,bindingsStable:true,allWorkersObservedExited:true,
    metrics:{acceptance:{quality:{all:{mrr:1},groups:Object.fromEntries(groups.map(g=>[g,{recallAt5:1}]))},pureOod:{conservativeFprUpperBound:0}}}};
}
test('module import leaves the actual holdout unloaded',()=>{
  assert.ok(!Object.keys(require.cache).some(name=>name.endsWith('acceptance-v6-fixture.cjs')));
});
test('adapter keeps unsupported and exact questions separate from positives and pure OOD',()=>{
  const value=adaptFixture({documents:[{id:'source'}],queries:[{id:'p',text:'positive',relevant:['source'],group:'en-en'}],
    noAnswer:['unrelated'],unsupported:['missing attribute'],unsupportedLabels:[{related:['source']}],exact:[{id:'e',text:'exact',relevant:['source']}]});
  assert.deepEqual(value.queries.map(q=>q.kind),['positive','ood','missing-field','exact']);
  assert.deepEqual(value.queries[1].relevant,[]);assert.deepEqual(value.queries[2].relevant,['source']);
});
test('only the complete prescribed cohort can pass; partial OOD, missing cases and exact losses fail',()=>{
  assert.equal(qualify(report()).qualityGatePassed,true);
  for(const mutate of [r=>{r.rows[80].complete=false;},r=>{r.rows.pop();},r=>{r.rows.at(-1).rank=0;},
    r=>{r.allWorkersObservedExited=false;},r=>{r.bindingsStable=false;},r=>{r.rows[0].group='en-en';}]){
    const value=report();mutate(value);assert.equal(qualify(value).qualityGatePassed,false);
  }
});
test('raw-row recomputation rejects misleading summaries and real FPR regressions',()=>{
  for(const mutate of [m=>{m.pureOod.conservativeFprUpperBound=.0625;},m=>{m.quality.groups['zh-en'].recallAt5=.80;},
    m=>{m.quality.groups['en-zh'].recallAt5=.80;},m=>{m.quality.groups['zh-zh'].recallAt5=.85;},m=>{m.quality.all.mrr=.74;}]){
    const value=report();mutate(value.metrics.acceptance);assert.equal(qualify(value).qualityGatePassed,false);
  }
  const value=report();for(let n=80;n<85;n++)value.rows[n].results=[{}];
  const result=qualify(value);assert.equal(result.recomputedMetrics.pureOod.conservativeFprUpperBound,.0625);
  assert.equal(result.checks.pureOod,false);assert.equal(result.qualityGatePassed,false);
});
