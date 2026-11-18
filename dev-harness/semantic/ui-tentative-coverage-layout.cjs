'use strict';
// Private UI-only staged coverage. Original public index APIs remain fresh.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function layout(directory){
 const priorFile=require.resolve('./scalar-scan-stat-layout.cjs');if(hash(fs.readFileSync(priorFile))!=='19744d72115e6ca0b7545d3be831261f37f27ce823fc104e5354840ad3cf85a1')throw Error('Scan-stat layout pin changed');
 const prior=require(priorFile).layout(directory);let source=fs.readFileSync(prior.modulePath,'utf8'),consumer=prior.consumer.source;const recipe=[],consumerRecipe=[];
 const one=(before,after)=>{if(source.split(before).length!==2)throw Error('Staged source exact boundary: '+before.slice(0,80));source=source.replace(before,after);recipe.push({before,after});};
 const edit=(before,after)=>{if(consumer.split(before).length!==2)throw Error('Staged consumer exact boundary: '+before.slice(0,80));consumer=consumer.replace(before,after);consumerRecipe.push({before,after});};
 one('async function search(query,context,limit=20,options={}){',`const stagedContexts=new WeakMap();
    const stageCatalog=ids=>{if(!Array.isArray(ids)||ids.some(id=>!valid(id))||new Set(ids).size!==ids.length)throw fail('catalog_invalid');return JSON.stringify(ids.slice().sort());};
    const stageAssert=(attempt,states=['running'])=>{if(!attempt||stagedContexts.get(attempt.context)!==attempt||!states.includes(attempt.state)||host.researchCoverageContext?.(attempt.context)!==true)throw fail('staged_attempt_invalid');};
    const abortStage=context=>{const attempt=stagedContexts.get(context);if(attempt)attempt.state='aborted';};
    function search(query,context,limit=20,options={}){return searchImplementation(query,context,limit,options,null);}
    async function searchImplementation(query,context,limit=20,options={},stage=null){`);
 // Only this search's check is augmented; original source/cancel checks run first.
 const searchStart=source.indexOf('async function searchImplementation('),checkText="const check=typeof options.check==='function'?options.check:()=>{};check();",checkAt=source.indexOf(checkText,searchStart);
 if(checkAt<searchStart)throw Error('Search check not found');const checkAfter="const callerCheck=typeof options.check==='function'?options.check:()=>{};const check=()=>{callerCheck();if(stage)stageAssert(stage);};check();";source=source.slice(0,checkAt)+checkAfter+source.slice(checkAt+checkText.length);recipe.push({scope:'searchImplementation',before:checkText,after:checkAfter});
 one('const scanIndex=async sid=>{', "if(stage){stage.catalog=stageCatalog(catalog);stage.snapshots=manifests;}\n      const scanIndex=async sid=>{");
 one('const metadataRows=[];let metadataTruncated=false;', "if(stage)for(const [sid,value]of manifests)stage.expected.set(sid,digest(value));\n      const metadataRows=[];let metadataTruncated=false;");
 // rawCoverage receives its stage only from the private core's two internal calls.
 one('timeout:researchTimeout,capture:requestCoverageProofs,statCredentials:requestStatCredentials}', 'timeout:researchTimeout,capture:requestCoverageProofs,statCredentials:requestStatCredentials,stage}');
 one('timeout:options.timeout,capture:requestCoverageProofs,statCredentials:requestStatCredentials}', 'timeout:options.timeout,capture:requestCoverageProofs,statCredentials:requestStatCredentials,stage}');
 one('reuse:coverageReuse,observed:observedManifests,statCredentials:requestStatCredentials}', 'reuse:coverageReuse,observed:observedManifests,statCredentials:requestStatCredentials,stage}');
 const rawBefore='const catalog=await host.catalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail(\'catalog_invalid\');\n      let complete=0,pending=0,attachmentSources=0,unverifiedMessages=0;';
 const rawAfter=`const catalog=await host.catalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
      const stage=options.stage;if(stage){stageAssert(stage);if(stageCatalog(catalog)!==stage.catalog)stage.catalogMismatch=true;}
      const stageManifests=new Map();const rememberManifest=(sid,value)=>{if(!stage)return;const fingerprint=digest(value);if(stage.expected.has(sid)){if(stage.expected.get(sid)!==fingerprint)stage.manifestMismatch=true;}else stage.expected.set(sid,fingerprint);};
      const observedManifest=async(sid,sequence)=>{
        if(stage){const value=stage.snapshots?.get(sid),statKey=JSON.stringify([visibility.access.scopeId,sid]),stat=scanStats.get(statKey);
          if(value&&compatible(value)&&value.attachments===0&&stat&&stat.unverified===0&&stat.mode===statMode&&stat.generation===value.generation&&stat.epoch===value.epoch&&stat.revision===value.sourceRevision&&stat.sequence===sequence&&statWitness){
            const epoch=await host.epoch(sid);check();const credential=await validateWitness(stat.witness);check();stageAssert(stage);
            if(epoch===stat.epoch&&credential&&host.authorizedEpoch?.(sid,visibility.context,visibility.access)===value.epoch){
              if(host.assertScope(visibility.context,visibility.access)!==true||host.assertAuthorized(sid,visibility.context,visibility.access)!==true||host.sourceSequence(sid)!==sequence)throw fail('disclosure_changed');
              scanStats.delete(statKey);scanStats.set(statKey,stat);stageManifests.set(sid,stat);options.capture?.set(sid,stat);options.statCredentials?.add(stat.witness);rememberManifest(sid,value);researchTiming?.count('scanStats.hit');researchTiming?.count('stagedManifest.hit');return value;
            }if(!credential)clearScanStats();
          }
        }
        const value=await currentManifest(sid);check();rememberManifest(sid,value);return value;
      };
      let complete=0,pending=0,attachmentSources=0,unverifiedMessages=0;`;
 one(rawBefore,rawAfter);
 one("const sequence=host.sourceSequence(sid),value=await currentManifest(sid);check();options.observed?.set(sid,value?.generation||null);let reused=options.reuse?.get(sid);", "const sequence=host.sourceSequence(sid),value=await observedManifest(sid,sequence);check();options.observed?.set(sid,value?.generation||null);let reused=stageManifests.get(sid)||options.reuse?.get(sid);");
 // Reused staged values cannot make internal global coverage complete after a changed catalog.
 one("complete:pending===0&&attachmentSources===0&&unverifiedMessages===0,messages:","complete:pending===0&&attachmentSources===0&&unverifiedMessages===0&&!stage?.catalogMismatch,messages:");
 const save="searchProofs.set(result,{context,access,observedManifests,coverageSequences,selectedEpochs,metadataTotals,metadataEvidence,metadataTruncated,scalarDecision,statCredentials:requestStatCredentials});return result;";
 one(save,`const proof={context,access,observedManifests,coverageSequences,selectedEpochs,metadataTotals,metadataEvidence,metadataTruncated,scalarDecision,statCredentials:requestStatCredentials};
      if(stage){stageAssert(stage);const masked={...result,coverage:{...result.coverage,complete:false},...(result.semantic?{semantic:{...result.semantic,coverage:'partial'}}:{})};stage.result=masked;stage.coverage=result.coverage;stage.semanticCoverage=result.semantic?.coverage;proof.stage=stage;searchProofs.set(masked,proof);return masked;}
      searchProofs.set(result,proof);return result;`);
 one('async function revalidate(result,context,options={}){await validateStatProof(result,context);',`function revalidate(result,context,options={}){return revalidateImplementation(result,context,options,null);}
    async function revalidateImplementation(result,context,options={},stage=null){await validateStatProof(result,context);`);
 one("const check=typeof options.check==='function'?options.check:()=>{},rows=[...proof.observedManifests];let changed=0;",`if((proof.stage||null)!==stage)throw fail('staged_attempt_invalid');if(stage)stageAssert(stage);
      const check=typeof options.check==='function'?options.check:()=>{},rows=[...proof.observedManifests];let changed=0;
      if(stage){const catalog=await host.catalog();check();stageAssert(stage);if(stageCatalog(catalog)!==stage.catalog||stage.catalogMismatch||stage.manifestMismatch)changed++;}`);
 one("const current=await currentManifest(sid);check();return (current?.generation||null)!==generation;", "const current=await currentManifest(sid);check();if(stage&&stage.expected.has(sid)&&digest(current)!==stage.expected.get(sid))return true;return (current?.generation||null)!==generation;");
 one("check();if(host.assertScope(context,proof.access)!==true)throw fail('disclosure_changed');return {changed};", "check();if(host.assertScope(context,proof.access)!==true)throw fail('disclosure_changed');if(stage){stageAssert(stage);stage.state=changed?'rejected':'validated';}return {changed};");
 const exportsBefore='return Object.freeze({step,prepare,resetPreparation,search,revalidate,mutationState,coverage,restorePause,validateStatProof,researchReport:';
 one(exportsBefore,`if(typeof host.installResearchCoveragePort==='function')host.installResearchCoveragePort(Object.freeze({
      abort:abortStage,
      search:async(query,context,limit,options)=>{if(host.researchCoverageContext?.(context)!==true)throw fail('staged_context_invalid');abortStage(context);const stage={context,state:'running',expected:new Map(),catalog:null,snapshots:null,catalogMismatch:false};stagedContexts.set(context,stage);try{const result=await searchImplementation(query,context,limit,options,stage);options.check?.();stageAssert(stage);if(typeof ResearchObserveSearch==='function'){const value=ResearchObserveSearch(JSON.parse(JSON.stringify(result)),clone(searchProofs.get(result)?.scalarDecision?.report||null));if(value&&typeof value.then==='function')throw Error('research.observer_must_be_sync');}return result;}catch(error){stage.state='aborted';throw error;}},
      verify:async(result,context,options)=>{const stage=searchProofs.get(result)?.stage;stageAssert(stage);if(stage.result!==result||stage.context!==context)throw fail('staged_attempt_invalid');return revalidateImplementation(result,context,options,stage);},
      commit:(result,context)=>{const stage=searchProofs.get(result)?.stage;stageAssert(stage,['validated']);if(stage.result!==result||stage.context!==context)throw fail('staged_attempt_invalid');stage.state='committed';return {coverage:{...stage.coverage},semanticCoverage:stage.semanticCoverage};},
      assertPublished:(result,context)=>{const stage=searchProofs.get(result)?.stage;stageAssert(stage,['committed']);if(stage.result!==result||stage.context!==context)throw fail('staged_attempt_invalid');return true;}
    }));
    return Object.freeze({step,prepare,resetPreparation,search,revalidate,mutationState,coverage,restorePause,validateStatProof,researchReport:`);
 // Optional trusted callback is delivered only by the real consumer binding.
 for(const before of ["['authorizedEpoch','authorizedEmpty','restrictedCatalog'].includes(name)","['authorizedEpoch','authorizedEmpty','restrictedCatalog'].some(name=>"]){const after=before.replace("'restrictedCatalog'","'restrictedCatalog','installResearchCoveragePort','researchCoverageContext'");one(before,after);}
 one("...['authorizedEpoch','authorizedEmpty'].filter(name=>disclosure[name])", "...['authorizedEpoch','authorizedEmpty','installResearchCoveragePort','researchCoverageContext'].filter(name=>disclosure[name])");
 // Consumer: port/result provenance is private, UI only, never an options bit.
 edit('const index=host.bindIndex({scope:', "let stagedCoveragePort=null;const uiSearchResults=new WeakMap();\n    const index=host.bindIndex({installResearchCoveragePort:port=>{if(stagedCoveragePort)throw fail('staged_port_duplicate');stagedCoveragePort=port;},researchCoverageContext:token=>{const cap=current(token);return cap.kind==='ui'&&cap.config.sessionSearchIndexV1!==false&&cap.config.sessionSearchIndexPausedV1!==true;},scope:");
 edit("let proofResult=null;", "let proofResult=null,usingStaged=false,stagedPublication=null;");
 edit("cap.assert();const paused=cap.config.sessionSearchIndexPausedV1===true;", "cap.assert();const paused=cap.config.sessionSearchIndexPausedV1===true;usingStaged=!!stagedCoveragePort&&cap.kind==='ui'&&!paused;");
 const indexSearch="await index.search(q,token,limit,{check,deadline,timeout,metadataEntries,verifyMetadata})";if(consumer.split(indexSearch).length!==4)throw Error('Consumer search count changed');consumer=consumer.split(indexSearch).join("await (usingStaged?stagedCoveragePort:index).search(q,token,limit,{check,deadline,timeout,metadataEntries,verifyMetadata})");consumerRecipe.push({before:indexSearch,after:'UI private staged port, otherwise original index',count:3});
 edit("if(!incremental){await index.prepare", "if(!incremental){if(usingStaged)stagedCoveragePort.abort(token);await index.prepare");
 edit("else if(progress?.done){index.resetPreparation", "else if(progress?.done){if(usingStaged)stagedCoveragePort.abort(token);index.resetPreparation");
 edit('verified=await index.revalidate(proofResult,token,{check,timeout});check();', 'verified=await (usingStaged?stagedCoveragePort:{verify:index.revalidate}).verify(proofResult,token,{check,timeout});check();');
 edit('if(indexState&&!cap.indexState)cap.indexState=indexState;', "if(indexState&&!cap.indexState)cap.indexState=indexState;if(usingStaged){stagedPublication=stagedCoveragePort.commit(proofResult,token);cap.currentStagedResult=proofResult;}");
 edit('coverage:found.coverage,lexicalAdmission:{partial:lexicalPartial', 'coverage:stagedPublication?.coverage||found.coverage,lexicalAdmission:{partial:lexicalPartial');
 edit("...(found.semantic?{semantic:found.semantic}:{}),scope:{...scope(enabled),fullText:enabled&&found.coverage.complete}};", "...(found.semantic?{semantic:{...found.semantic,...(stagedPublication?{coverage:stagedPublication.semanticCoverage}:{})}}:{}),scope:{...scope(enabled),fullText:enabled&&(stagedPublication?.coverage||found.coverage).complete}};");
 edit("async function search(query,limit){const cap=current(),timeout=", "async function search(query,limit){const cap=current(),invocation=Object.freeze({});if(cap.kind==='ui'&&stagedCoveragePort){stagedCoveragePort.abort(local.getStore());cap.searchInvocation=invocation;cap.currentStagedResult=null;cap.hasUISearch=true;}const publish=value=>{if(cap.kind==='ui'&&stagedCoveragePort){if(cap.searchInvocation!==invocation)throw fail('staged_result_invalid');uiSearchResults.set(value,{cap,invocation,source:cap.currentStagedResult,used:false});}return value;};const timeout=");
 edit("const check=()=>{cap.assert();if(Date.now()>=deadline)throw timeout;};", "const check=()=>{cap.assert();if(cap.kind==='ui'&&stagedCoveragePort&&cap.searchInvocation!==invocation)throw fail('staged_result_invalid');if(Date.now()>=deadline)throw timeout;};");
 edit("try{return await searchOnce(query,limit,check,deadline,timeout);}catch(error){if(error===timeout){await final(cap);", "try{return publish(await searchOnce(query,limit,check,deadline,timeout));}catch(error){if(cap.kind==='ui'&&stagedCoveragePort&&cap.searchInvocation===invocation){stagedCoveragePort.abort(local.getStore());cap.currentStagedResult=null;}if(error===timeout){await final(cap);");
 edit("return{ok:true,query:String(query||'').trim(),results:[],indexed:0,partial:true,reason:'deadline'", "return publish({ok:true,query:String(query||'').trim(),results:[],indexed:0,partial:true,reason:'deadline'");
 edit("semantic:{status:'timeout',coverage:'partial'},scope:scope(enabled)};}if(error?.code", "semantic:{status:'timeout',coverage:'partial'},scope:scope(enabled)});}if(error?.code");
 edit("if(typeof index.validateStatProof==='function'){cap.statChecks", "if(proofResult&&typeof index.validateStatProof==='function'){cap.statChecks");
 // Any new asynchronous validation remains before the existing last source final.
 edit("assertIndexState(cap);\n      cap.emitted=true;", "assertIndexState(cap);\n      if(stagedCoveragePort&&cap.hasUISearch){const publication=uiSearchResults.get(value);if(!publication||publication.cap!==cap||publication.invocation!==cap.searchInvocation||publication.used)throw fail('staged_result_invalid');if(publication.source)stagedCoveragePort.assertPublished(publication.source,local.getStore());publication.used=true;}\n      cap.emitted=true;");
 const modulePath=path.join(directory,'producer-ui-staged-'+hash(source)+'.cjs');if(!fs.existsSync(modulePath))fs.writeFileSync(modulePath,source,{flag:'wx'});else if(hash(fs.readFileSync(modulePath))!==hash(source))throw Error('Staged source differs');
 return {...prior,modulePath,producer:{...prior.producer,transformedSha256:hash(source),tentativeRecipe:recipe},consumer:{...prior.consumer,source:consumer,transformedSha256:hash(consumer),tentativeRecipe:consumerRecipe},layoutScriptSha256:hash(fs.readFileSync(__filename)),scope:'UI only. Model/observation/public index APIs retain original fresh reads. Sequence memo not combined.'};
}
module.exports={layout};
