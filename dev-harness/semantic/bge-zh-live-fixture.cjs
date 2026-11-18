'use strict';
// Actual audited scan-stat owner/producer/public-consumer path; no scalarHost.
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {fixture:base}=require('./scalar-scan-stat-live-fixture.cjs'),{createCoarsePolicy}=require('./bge-zh-coarse-policy.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(options={}){
  if(options.scalarHost)throw Error('BGE coarse-only fixture forbids scalar host.');
  const f=await base(options),source=fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js','utf8');
  if(hash(source)!=='90a0191d29307ba1f5582f4073bb7a01dc311f5a72481bbc06b01ee3a084a15f'){await f.close();throw Error('Producer changed.');}
  const normalize=vm.runInNewContext(source.match(/^  const canonicalText=.*;$/m)[0]+'\n'+source.match(/^  const normalize=.*;$/m)[0]+'\nnormalize;');
  f.context.ResearchScalarComposite=createCoarsePolicy({identify:f.context.SemanticRetrieval.structuredIds,normalize,terms:f.api.terms});
  return f;
}
module.exports={fixture};
