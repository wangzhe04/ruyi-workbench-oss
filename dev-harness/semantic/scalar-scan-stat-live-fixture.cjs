'use strict';
// Same audited source/credential/PG contract, detailed observation OFF by default.
// Only explicitly requested tests may install the existing phase observer.
const fs=require('node:fs'),crypto=require('node:crypto');
const basePath=require.resolve('./scalar-scan-stat-fixture.cjs'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
async function fixture(options={}){
  if(hash(fs.readFileSync(basePath))!=='becacd73dd0c6d80bb60f1d12589ade82be122e11d76032fa52fd3d240e2a767')throw Error('Audited scan-stat fixture changed.');
  const {producerTiming,...settings}=options,f=await require(basePath).fixture(settings);
  if(producerTiming!==undefined){if(!producerTiming||typeof producerTiming.measure!=='function'||typeof producerTiming.count!=='function'||typeof producerTiming.measureSync!=='function'){await f.close();throw TypeError('Invalid explicit test observer.');}f.context.ResearchProducerTiming=producerTiming;}
  return f;
}
module.exports={fixture};
