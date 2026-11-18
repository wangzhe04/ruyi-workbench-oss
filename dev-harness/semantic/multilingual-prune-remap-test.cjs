'use strict';
const assert=require('node:assert/strict'),{remap}=require('./multilingual-prune-remap.cjs');let map=[2,0,-1,1];assert.deepEqual([...remap([0n,1n,3n],map)],[2n,0n,1n]);for(const ids of [[2n],[-1n],[4n],[1n,2n],[1.5]])assert.throws(()=>remap(ids,map),e=>e.code==='UNSUPPORTED_TOKEN');console.log('fake remap retained, dropped, out-of-range and whole-request: PASS');
