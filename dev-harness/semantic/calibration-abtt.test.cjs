'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict'),{fitTransform,applyTransform}=require('./calibration-abtt.cjs');
const fingerprint='sha256:test-fixed-model',vectors=[[3,0,0],[-3,0,0],[0,2,0],[0,-2,0],[0,0,1],[0,0,-1]];
test('train-only orthogonal power iteration recovers known covariance and removes only selected axes',()=>{
 const matrix=fitTransform(vectors,fingerprint,2);assert.deepEqual(matrix.mean,[0,0,0]);assert.ok(Math.abs(matrix.diagnostics[0].eigenvalue-3)<1e-8);assert.ok(Math.abs(matrix.diagnostics[1].eigenvalue-4/3)<1e-8);
 const value=applyTransform([3,2,1],matrix,1,fingerprint);assert.ok(Math.abs(value[0])<1e-8);assert.ok(Math.abs(value[1]-2/Math.sqrt(5))<1e-8);assert.ok(Math.abs(value[2]-1/Math.sqrt(5))<1e-8);
 assert.ok(Math.abs(matrix.pcs[0].reduce((sum,x,i)=>sum+x*matrix.pcs[1][i],0))<1e-10);
});
test('matrix fit and serialized application are deterministic without label or later split inputs',()=>{
 const first=fitTransform(vectors,fingerprint,2),second=fitTransform(vectors.map(row=>row.slice()),fingerprint,2);assert.deepEqual(first,second);
 assert.deepEqual(applyTransform([3,2,1],first,1,fingerprint),applyTransform([3,2,1],JSON.parse(JSON.stringify(first)),1,fingerprint));
});
test('missing model, changed model, invalid vector, invalid component and degenerate projected vector fail closed',()=>{
 const matrix=fitTransform(vectors,fingerprint,2);for(const model of [null,'sha256:other'])assert.throws(()=>applyTransform([3,2,1],matrix,1,model),/model_unavailable/);
 for(const vector of [null,[1,2],[1,NaN,2]])assert.throws(()=>applyTransform(vector,matrix,1,fingerprint),/vector_missing_or_invalid/);
 assert.throws(()=>applyTransform([1,2,3],matrix,3,fingerprint),/components_invalid/);assert.throws(()=>applyTransform([0,0,0],matrix,0,fingerprint),/degenerate_vector/);
 assert.throws(()=>fitTransform(vectors,null,2),/model_unavailable/);
});
