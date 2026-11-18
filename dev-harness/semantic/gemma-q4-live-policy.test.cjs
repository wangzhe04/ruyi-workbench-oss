'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createCoarsePolicy,CONTRACT}=require('./gemma-q4-live-policy.cjs');
const identify=vm.runInNewContext(fs.readFileSync('ruyi-workbench/app/src/06ha-semantic-retrieval.js','utf8')+'\nSemanticRetrieval.structuredIds;',{require,Date}),normalize=text=>text.normalize('NFKC').toUpperCase(),terms=text=>text.split(/\s+/);
async function evaluate({texts,scores,lexical=[],metadata=[],complete=true,query='orchid missing',hook=async()=>{}}){let guards=0;
  const policy=createCoarsePolicy({identify,normalize,terms}),rows=texts.map((text,index)=>({index,metadata:metadata.includes(index),fieldKey:'field-'+index,order:String(index)}));
  const value=await policy.evaluate({query,rows,lexical:lexical.map(index=>({key:rows[index].fieldKey,index})),scores,complete,scopeId:'synthetic',deadline:Date.now()+1000,
    resolve:async(index,whole)=>({identity:{sourceId:'source-'+index,field:'content',revision:'revision',start:0,end:texts[index].length},text:texts[index],fieldText:texts[index]}),beforeVerify:async event=>{guards++;await hook(event);}});return {value,guards};
}
test('frozen Gemma cosine policy is .40, not a probability bridge, with no scalar writes',async()=>{
  assert.equal(CONTRACT.threshold,.40);assert.equal(CONTRACT.verifier,null);assert.equal(CONTRACT.automatic,null);
  const {value,guards}=await evaluate({texts:['different evidence'],scores:[.40]});assert.equal(value.accepted[0],true);assert.equal(value.report.scalarPairs,0);assert.equal(value.report.coarseAdmissionWindows,1);assert.ok(guards>0);
});
test('globalK1 rejection never refills and strong is exempt only after cuttingK',async()=>{
  const rejected=await evaluate({texts:['different evidence','other evidence'],scores:[.39,.38]});assert.deepEqual(rejected.value.accepted,[false,false]);assert.deepEqual(rejected.value.report.globalSelectedIndices,[0]);
  const strong=await evaluate({texts:['orchid missing exact','other evidence'],scores:[.9,.8],lexical:[0]});assert.deepEqual(strong.value.accepted,[false,false]);assert.equal(strong.value.lexical.get('field-0'),true);assert.equal(strong.value.report.coarseAdmissionWindows,0);
});
test('weak fields use their own cosine independently of globalK1 and siblings',async()=>{
  const {value}=await evaluate({texts:['orchid weaker','unrelated top','orchid useful'],scores:[.39,.9,.41],lexical:[0,2]});assert.equal(value.accepted[1],true);assert.equal(value.lexical.get('field-0'),false);assert.equal(value.lexical.get('field-2'),true);
});
test('incomplete eligible pool cannot invent a weak best window or a confident negative',async()=>{
  const {value}=await evaluate({texts:['orchid candidate','unencoded source'],scores:[.7,null],lexical:[0],complete:false});assert.equal(value.complete,false);assert.equal(value.lexical.get('field-0'),null);assert.deepEqual(value.report.globalSelectedIndices,[]);
});
test('full structuredID eligibility precedesK and source guard errors retain identity',async()=>{
  const id=await evaluate({query:'decision OP-12',texts:['OP-123 wrong','OP-12 correct'],scores:[.99,.8],lexical:[1]});assert.deepEqual(id.value.report.globalSelectedIndices,[1]);assert.equal(id.value.lexical.get('field-1'),true);
  const error=Object.assign(new Error('denied'),{code:'EACCES'});await assert.rejects(evaluate({texts:['source'],scores:[.8],hook:async()=>{throw error;}}),e=>e===error);
});
