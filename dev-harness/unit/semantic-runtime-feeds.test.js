'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/semantic-runtime/worker.cjs'),'utf8');
const feeds=vm.runInNewContext(source.slice(source.indexOf('function modelFeeds('),source.indexOf('async function main('))+'\nmodelFeeds;', {BigInt64Array});
const ort={Tensor:class {constructor(type,data,dims){Object.assign(this,{type,data,dims});}}};
const ids={type:'int64',data:BigInt64Array.from([0n,12n,2n]),dims:[1,3]};
test('only explicitly required omitted token type IDs get single-segment zeros',()=>{
  const actual=feeds(ort,{inputNames:['input_ids','token_type_ids']},{input_ids:ids});
  assert.deepEqual(Array.from(actual.token_type_ids.data),[0n,0n,0n]);
  assert.equal(actual.token_type_ids.type,'int64');assert.equal(actual.token_type_ids.dims,ids.dims);
  assert.equal(actual.input_ids.data,ids.data);
  const without=feeds(ort,{inputNames:['input_ids']},{input_ids:ids});assert.equal(without.token_type_ids,undefined);
});
test('provided segment IDs pass through and unknown graph inputs remain fail closed',()=>{
  const supplied={...ids,data:BigInt64Array.from([0n,1n,1n])};
  assert.equal(feeds(ort,{inputNames:['token_type_ids']},{token_type_ids:supplied}).token_type_ids.data,supplied.data);
  assert.throws(()=>feeds(ort,{inputNames:['position_ids']},{input_ids:ids}),/MODEL_INPUT_MISSING/);
  assert.throws(()=>feeds(ort,{inputNames:['token_type_ids']},{input_ids:{...ids,type:'int32'}}),/MODEL_INPUT_MISSING/);
});
