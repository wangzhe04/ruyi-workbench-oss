'use strict';
// New research contract: bounded raw scan statistics, never authorization,
// vectors, answers, text, or references. Exact owner epoch + actual decode-key
// witness are checked afresh. Historical producers remain byte-for-byte intact.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function layout(directory){
  const prior=require('./scalar-coverage-reuse-layout.cjs').layout(directory);let source=fs.readFileSync(prior.modulePath,'utf8');const recipe=[];
  const one=(before,after)=>{if(source.split(before).length!==2)throw Error('Scan-stat boundary changed: '+before.slice(0,65));source=source.replace(before,after);recipe.push({before,after});};
  one('const beginMutation=()=>{mutationSerial++;', "const scanStats=new Map();let scanStatsMode;const clearScanStats=()=>{scanStats.clear();researchTiming?.count('scanStats.clear');};\n    const beginMutation=()=>{clearScanStats();mutationSerial++;");
  one("const check=typeof options.check==='function'?options.check:()=>{};check();\n      const catalog=await host.catalog();", `const check=typeof options.check==='function'?options.check:()=>{};check();
      const statMode=await host.enabled();check();if(statMode!==scanStatsMode){clearScanStats();scanStatsMode=statMode;}
      const statWitness=typeof ResearchScanWitness!=='undefined'?ResearchScanWitness:null;
      const validateWitness=async token=>{try{return await statWitness.validate(token);}catch(error){clearScanStats();throw error;}};
      const catalog=await host.catalog();`);
  const before="const reused=options.reuse?.get(sid),authorized=visibility&&typeof host.authorizedEpoch==='function'?host.authorizedEpoch(sid,visibility.context,visibility.access):null;";
  one(before,`let reused=options.reuse?.get(sid);const statKey=visibility?JSON.stringify([visibility.access.scopeId,sid]):null,stat=statKey?scanStats.get(statKey):null;
      if(!reused&&stat&&statWitness&&value&&compatible(value)&&value.attachments===0&&stat.mode===statMode&&stat.generation===value.generation&&stat.epoch===value.epoch&&stat.revision===value.sourceRevision&&stat.sequence===sequence){
        const currentEpoch=await host.epoch(sid);check();const keyCurrent=await validateWitness(stat.witness);check();
        if(currentEpoch===stat.epoch&&keyCurrent){if(host.assertScope(visibility.context,visibility.access)!==true||host.assertAuthorized(sid,visibility.context,visibility.access)!==true||host.sourceSequence(sid)!==sequence)throw fail('disclosure_changed');
          scanStats.delete(statKey);scanStats.set(statKey,stat);reused=stat;options.capture?.set(sid,stat);options.statCredentials?.add(stat.witness);researchTiming?.count('scanStats.hit');
        }else{scanStats.delete(statKey);if(!keyCurrent)clearScanStats();reused=undefined;}
      }else if(!reused&&stat)scanStats.delete(statKey);
      const authorized=visibility&&typeof host.authorizedEpoch==='function'?host.authorizedEpoch(sid,visibility.context,visibility.access):null;`);
  const capture='if(value.attachments===0&&options.capture instanceof Map)options.capture.set(sid,Object.freeze({generation:value.generation,epoch:proof.epoch,revision:proof.revision,sequence,unverified:unsupported}));';
  one(capture,`${capture}
          if(value.attachments===0&&statKey&&statWitness){const token=statWitness.read(proof);if(token){const keyCurrent=await validateWitness(token);check();if(keyCurrent){const stat=Object.freeze({generation:value.generation,epoch:proof.epoch,revision:proof.revision,sequence,unverified:unsupported,mode:statMode,witness:token});scanStats.delete(statKey);scanStats.set(statKey,stat);while(scanStats.size>4096)scanStats.delete(scanStats.keys().next().value);options.statCredentials?.add(token);researchTiming?.count('scanStats.write');}else clearScanStats();}}
          `);
  one('const requestCoverageProofs=new Map();let ranked=', 'const requestCoverageProofs=new Map(),requestStatCredentials=new Set();let ranked=');
  one('timeout:researchTimeout,capture:requestCoverageProofs}', 'timeout:researchTimeout,capture:requestCoverageProofs,statCredentials:requestStatCredentials}');
  one('timeout:options.timeout,capture:requestCoverageProofs}', 'timeout:options.timeout,capture:requestCoverageProofs,statCredentials:requestStatCredentials}');
  one('reuse:coverageReuse,observed:observedManifests}', 'reuse:coverageReuse,observed:observedManifests,statCredentials:requestStatCredentials}');
  one('metadataTotals,metadataEvidence,metadataTruncated,scalarDecision});return result;', 'metadataTotals,metadataEvidence,metadataTruncated,scalarDecision,statCredentials:requestStatCredentials});return result;');
  one('for(const check of sourceChecks)if(!await check(true))', 'await validateStatCredentials(requestStatCredentials);check();for(const check of sourceChecks)if(!await check(true))');
  one('async function revalidate(result,context,options={}){', `async function validateStatCredentials(credentials){const witness=typeof ResearchScanWitness!=='undefined'?ResearchScanWitness:null;
      for(const token of credentials||[]){try{if(!witness||!await witness.validate(token)){clearScanStats();throw fail('key_changed');}}catch(error){clearScanStats();throw error;}}}
    async function validateStatProof(result,context){const proof=searchProofs.get(result);if(!proof||proof.context!==context)throw fail('disclosure_changed');await validateStatCredentials(proof.statCredentials);}
    async function revalidate(result,context,options={}){await validateStatProof(result,context);`);
  one('function resetPreparation(scopeId){preparationProgress.delete(scopeId);}', 'function resetPreparation(scopeId){clearScanStats();preparationProgress.delete(scopeId);}');
  one('async function restorePause(context){', 'async function restorePause(context){clearScanStats();');
  one('coverage,restorePause,researchReport:', 'coverage,restorePause,validateStatProof,researchReport:');
  one('search:async(...args)=>', 'validateStatProof:instance.validateStatProof,search:async(...args)=>');
  one('pause:()=>{paused=true;', 'pause:()=>{clearScanStats();paused=true;');
  const consumerRecipe=[];let consumer=prior.consumer.source;
  const edit=(before,after)=>{if(consumer.split(before).length!==2)throw Error('Stat final consumer boundary changed.');consumer=consumer.replace(before,after);consumerRecipe.push({before,after});};
  edit('await final(cap,false);check();', "if(typeof index.validateStatProof==='function'){cap.statChecks||=[];cap.statChecks.push(()=>index.validateStatProof(proofResult,token));}await final(cap,false);check();");
  edit('async function final(cap,completeAttachmentCheck=true) {', 'async function final(cap,completeAttachmentCheck=true) {\n      for(const guard of cap.statChecks||[])await guard();');
  edit('if(cap.attachmentChecks.length)await final(cap);','if(cap.attachmentChecks.length||cap.statChecks?.length)await final(cap);');
  const modulePath=path.join(directory,'producer-scan-stat-'+hash(source)+'.cjs');if(!fs.existsSync(modulePath))fs.writeFileSync(modulePath,source,{flag:'wx'});else if(hash(fs.readFileSync(modulePath))!==hash(source))throw Error('Stat producer differs.');
  return {...prior,modulePath,producer:{...prior.producer,transformedSha256:hash(source),scanStatRecipe:recipe},consumer:{...prior.consumer,source:consumer,transformedSha256:hash(consumer),statFinalRecipe:consumerRecipe},layoutScriptSha256:hash(fs.readFileSync(__filename))};
}
module.exports={layout};
