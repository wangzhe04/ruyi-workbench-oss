'use strict';
// Request-local proof reuse only. The original strict reuse predicate and final
// authority/source/index/privacy checks are unchanged. No cross-request cache.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function layout(directory){
  const prior=require('./scalar-producer-timing-layout.cjs').layout(directory);
  let source=fs.readFileSync(prior.modulePath,'utf8');const recipe=[];
  const one=(before,after)=>{if(source.split(before).length!==2)throw Error('Coverage capture boundary changed: '+before.slice(0,70));source=source.replace(before,after);recipe.push({before,after});};
  one('let ranked=[],scalarDecision=null;', 'const requestCoverageProofs=new Map();let ranked=[],scalarDecision=null;');
  one('else{complete++;attachmentSources+=value.attachments-(value.attachmentsIndexed||0);unverifiedMessages+=unsupported;}',
    'else{complete++;attachmentSources+=value.attachments-(value.attachmentsIndexed||0);unverifiedMessages+=unsupported;if(value.attachments===0&&options.capture instanceof Map)options.capture.set(sid,Object.freeze({generation:value.generation,epoch:proof.epoch,revision:proof.revision,sequence,unverified:unsupported}));}');
  one('{check:researchCheck,timeout:researchTimeout}));', '{check:researchCheck,timeout:researchTimeout,capture:requestCoverageProofs}));');
  one("{check,timeout:options.timeout}));", "{check,timeout:options.timeout,capture:requestCoverageProofs}));");
  one('coverageReuse=new Map(),retainedSources=new Set();', 'coverageReuse=new Map(requestCoverageProofs),retainedSources=new Set();');
  const modulePath=path.join(directory,'producer-coverage-reuse-'+hash(source)+'.cjs');
  if(fs.existsSync(modulePath)){if(hash(fs.readFileSync(modulePath))!==hash(source))throw Error('Coverage source differs.');}
  else fs.writeFileSync(modulePath,source,{flag:'wx'});
  return {...prior,modulePath,producer:{...prior.producer,transformedSha256:hash(source),coverageReuseRecipe:recipe},layoutScriptSha256:hash(fs.readFileSync(__filename))};
}
module.exports={layout};
