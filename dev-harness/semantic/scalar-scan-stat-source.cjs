'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const ORIGINAL_SHA='233c2c11a493a96ad9576bf87c0888bd95f4a722b0503b16af362836d6c01573';
function transform(source){
  if(hash(source)!==ORIGINAL_SHA)throw Error('Frozen session source owner changed.');
  const before="result=Object.freeze({epoch:selected.epoch,revision:revision.digest('hex'),count,requiresEncryption});";
  const after=before+"\n      if(typeof ResearchScanWitness!=='undefined')leaseWitness=ResearchScanWitness.capture(requiresEncryption,credential);";
  if(source.split(before).length!==2)throw Error('Source scan lease witness boundary changed.');
  const marker='count=0,credential=null,handle=null,requiresEncryption=',start='count=0,credential=null,leaseWitness=null,handle=null,requiresEncryption=';
  const end='check();return result;\n  }\n  async function inspect(id)',finish="check();if(typeof ResearchScanWitness!=='undefined')ResearchScanWitness.publish(result,leaseWitness);return result;\n  }\n  async function inspect(id)";
  for(const text of [marker,end])if(source.split(text).length!==2)throw Error('Source witness publication boundary changed.');
  const derived=source.replace(before,after).replace(marker,start).replace(end,finish);
  return {source:derived,originalSha256:ORIGINAL_SHA,transformedSha256:hash(derived),recipe:[{before,after},{before:marker,after:start},{before:end,after:finish,
    purpose:'Capture exact decode lease before release; publish opaque proof only after all original owner/sequence/check/cleanup/release succeed. Public result shape unchanged.'}]};
}
module.exports={transform,ORIGINAL_SHA};
