'use strict';
const assert=require('node:assert/strict'),{validate,guard,processIdentity}=require('./bge-minilm-mixed-collect.cjs');
const good={ok:true,modelFingerprint:'sha256:test',dimensions:2,vectors:[[1,0]],tokenCounts:[3],encodedTokenCounts:[3],truncated:[false]};
assert.equal(validate(good,2,'sha256:test',10),good);
for(const bad of [{...good,modelFingerprint:'sha256:other'},{...good,vectors:[[1,1]]},{...good,vectors:[[NaN,0]]},{...good,dimensions:3},{...good,truncated:[true]},{...good,tokenCounts:[11]},{...good,encodedTokenCounts:[11]},{...good,vectors:[]}])assert.throws(()=>validate(bad,2,'sha256:test',10));
assert.equal(guard().queries.length,32);(async()=>{assert.match(await processIdentity(process.pid),/^\d+$/);assert.equal(await processIdentity(2147483647),null);console.log('fake collection and identity contract: PASS');})().catch(e=>{console.error(e);process.exitCode=1;});
