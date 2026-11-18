// Semantic memory headers: automatic recall only reranks existing candidates;
// explicit list(query) may discover additional eligible headers after admission.
const MemorySemanticRecall = (() => {
  function deferredRecall(status, method) {
    return ['loading','overloaded','timeout','partial','unavailable','truncated'].includes(status)
      ? { reason:status, method } : null;
  }
  function create(host) {
    const searchProgress = new Map();
    let progressGeneration = 0;
    function legacyPage(registry, offset) {
      const fragments = [];
      let end = offset, skipped = 0;
      for (;end < registry.length && end - offset < 64;end++) {
        const entry = registry[end];
        const text = host.searchText ? host.searchText(entry) : host.text(entry);
        if (typeof text !== 'string' || !text.length || text.length > 4096) { skipped++; continue; }
        const windows = [];
        for (let start = 0;start < text.length;) {
          let end = Math.min(text.length, start + 96);
          if (end < text.length && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
          windows.push({entry, start, end, text:text.slice(start,end)});
          if (end === text.length) break;
          start = end - 16;
          if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--;
        }
        if (fragments.length + windows.length > 128) break;
        fragments.push(...windows);
      }
      return { fragments, end, skipped };
    }
    async function searchLegacy(registry, query, limit, context, lexical, result) {
      const key = context.progressKey, prior = key && searchProgress.get(key);
      const generation = progressGeneration;
      const offset = prior?.offset || 0;
      const {fragments, end, skipped} = legacyPage(registry, offset);
      const scored = fragments.length ? await host.score(query, fragments.map(row=>row.text), {
        scopeId:context.scopeId, signal:context.signal, deadline:context.deadline, deadlineMs:1000,
        maxEncodeDocuments:128, purpose:'search', beforeEncode:()=>context.check?.('finish'),
        identities:fragments.map(row=>[host.key(row.entry),row.entry.memoryVersion||'',row.start,row.end]),
      }) : {status:'ready', scores:[], admission:prior?.policyId ? {policyId:prior.policyId, accepted:[]} : null, coverage:{cached:0,complete:true}, modelFingerprint:prior?.modelFingerprint};
      await context.check?.('finish');
      if(!['ready','partial','disabled','unavailable','loading','timeout','overloaded','truncated'].includes(scored?.status)) throw Error('memory_semantic.score_failed');
      const modelFingerprint = scored.modelFingerprint || prior?.modelFingerprint;
      const sameModel = scored.status !== 'disabled' && generation === progressGeneration && (!prior || prior.modelFingerprint === modelFingerprint);
      const admission = scored.admission;
      const admissionEvaluated = Array.isArray(admission?.accepted) && admission.accepted.length === fragments.length;
      const hits = new Map(sameModel ? prior?.hits : null);
      if (admissionEvaluated && sameModel && ['ready','partial'].includes(scored.status)) {
        fragments.forEach((row,index)=>{
          const score = scored.scores?.[index], key = host.key(row.entry);
          if (admission.accepted[index] !== true || !Number.isFinite(score) || score <= (hits.get(key) ?? -Infinity)) return;
          hits.set(key, score);
        });
      }
      const batchComplete = !fragments.length || admissionEvaluated && scored.coverage?.complete === true && ['ready','partial'].includes(scored.status);
      const nextOffset = sameModel ? (batchComplete ? end : offset) : 0;
      const unavailableHeaders = sameModel ? (prior?.skipped || 0) + (batchComplete ? skipped : 0) : 0;
      const encoded = sameModel ? (prior?.encoded || 0) + (scored.coverage?.cached || 0) : 0;
      const policyId = sameModel ? admission?.policyId || prior?.policyId : undefined;
      const complete = nextOffset === registry.length && unavailableHeaders === 0 && !!policyId;
      const eligible = new Map(registry.map(entry=>[host.key(entry),entry]));
      const lexicalKeys = new Set(lexical.filter(row=>row.shared>0).map(row=>host.key(row.entry)));
      const accepted = [...hits].filter(([key])=>eligible.has(key)&&!lexicalKeys.has(key)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,50);
      if(key && searchProgress.get(key) === prior) {
        searchProgress.delete(key);
        if (sameModel && policyId && modelFingerprint) {
          searchProgress.set(key, {offset:nextOffset, hits:accepted, skipped:unavailableHeaders, encoded:batchComplete ? encoded : prior?.encoded||0, policyId, modelFingerprint});
          if (searchProgress.size > 32) searchProgress.delete(searchProgress.keys().next().value);
        }
      }
      const added = accepted.map(([id,semanticScore])=>({entry:eligible.get(id),shared:0,semanticOnly:true,semanticScore}));
      const addedKeys = new Set(accepted.map(([id])=>id));
      const status = scored.status !== 'ready' ? scored.status
        : fragments.length && !admissionEvaluated ? 'admission-unavailable'
          : key && !complete ? 'partial' : 'ready';
      const rows = [...lexical.filter(row=>row.shared>0),...added,...lexical.filter(row=>!row.shared&&!addedKeys.has(host.key(row.entry)))].slice(0,limit);
      return result(rows,status,{modelFingerprint,admissionPolicy:policyId,semanticOnlyMatches:rows.filter(row=>row.semanticOnly).length,
        coverage:{source:'memory-metadata',bodyIndexed:false,selection:key?'bounded-eligible-header-batches':'first-64-eligible-headers',headerLimit:64,fragmentLimit:128,
          candidateHeaders:registry.length,selectedHeaders:end-offset,fragments:fragments.length,omittedHeaders:registry.length-nextOffset+unavailableHeaders,
          examinedHeaders:nextOffset-unavailableHeaders,headerComplete:nextOffset===registry.length&&unavailableHeaders===0,
          encodedFragments:encoded,admissionEvaluated:admissionEvaluated||!!prior?.policyId,complete,
          ...(key && !complete && nextOffset<registry.length && scored.status!=='disabled' ? {canContinue:true,continuation:'repeat-same-query-and-scope'} : {})}});
    }
    async function rank(registry, query, limit, config, context = {}) {
      const baseline = host.fallback(registry, query, limit, config);
      await context.check?.('start');
      const state = async status => {
        await context.check?.('finish');
        const deferred = deferredRecall(status, 'existing-recall');
        return { ...baseline, semantic: { status, mode: 'rerank-only', automaticCandidates: false, ...(deferred ? { fallback:deferred } : {}) } };
      };
      if (config?.semanticRetrievalV1 === false || !host.enabled(config)) return state('disabled');
      const lexical = new Set(host.lexical(registry, query).filter(row => row.shared > 0).map(row => host.key(row.entry)));
      const positions = [];
      baseline.entries.forEach((entry, index) => { const key = host.key(entry); if (lexical.has(key) && !baseline.fillKeys.has(key)) positions.push(index); });
      if (positions.length < 2) return state('not-needed');
      if (positions.length > 16) return state('budget');
      if (host.budgetSafe && !host.budgetSafe(baseline.entries, config)) return state('budget');
      const selected = positions.map(index => baseline.entries[index]);
      // Headers only. This bounded prefix is a reranking hint, never a claim that
      // the memory body or the full metadata has been indexed or read.
      const texts = selected.map(entry => host.text(entry).slice(0, 96));
      const result = await host.score(query, texts, {
        scopeId: context.scopeId, signal: context.signal, deadlineMs: 250, maxEncodeDocuments: 16,
        identities: selected.map(entry => [host.key(entry), entry.memoryVersion || '']), purpose: 'rerank', beforeEncode: () => context.check?.('finish'),
      });
      if (!['ready', 'partial', 'disabled', 'unavailable', 'loading', 'timeout', 'overloaded', 'truncated'].includes(result?.status)) throw Error('memory_semantic.score_failed');
      if (result.status !== 'ready' || result.scores?.length !== selected.length || !result.scores.every(Number.isFinite)) return state(result.status);
      await context.check?.('finish');
      const ordered = selected.map((entry, index) => ({ entry, score: result.scores[index], index })).sort((a, b) => b.score - a.score || a.index - b.index);
      const entries = baseline.entries.slice();
      positions.forEach((position, index) => { entries[position] = ordered[index].entry; });
      return { entries, baselineEntries: baseline.entries, rankingKeys: selected.map(entry => host.key(entry)), fillKeys: baseline.fillKeys,
        semantic: { status: 'reranked', mode: 'rerank-only', automaticCandidates: false, modelFingerprint: result.modelFingerprint, candidateCount: selected.length } };
    }
    async function search(registry, query, limit, config, context = {}) {
      const lexical=host.lexical(registry,query),baseline=lexical.slice(0,limit);
      const result=(rows,status,extra={})=>{
        const deferred = deferredRecall(status, rows.some(row=>row.semanticOnly) ? 'keywords-and-admitted-semantic' : 'keywords');
        return {entries:rows.map(row=>row.entry),matched:rows.filter(row=>row.shared>0||row.semanticOnly).map(row=>row.entry),
        matches:new Map(rows.map(row=>[host.key(row.entry),{kind:row.semanticOnly?'semantic':row.shared>0?'lexical':'rule-fill',...(row.shared>0?{lexicalScore:row.score}:{}),...(Number.isFinite(row.semanticScore)?{semanticScore:row.semanticScore}:{})}])),
        semantic:{status,mode:'explicit-header-search',automaticCandidates:false,scoreKind:'cosine',answerability:'not-assessed',...(deferred ? { fallback:deferred } : {}),...extra}};
      };
      const fallback=async status=>{await context.check?.('finish');return result(baseline,status);};
      await context.check?.('start');
      if(config?.semanticRetrievalV1===false||!host.enabled(config))return fallback('disabled');
      if(!query||query.length>256||!registry.length)return fallback('not-needed');
      const useGemma=typeof SemanticAdmissionRequest!=='undefined'&&typeof SemanticRuntimeTransportProof!=='undefined'&&SemanticRuntimeTransportProof.method()!==null;
      if(!useGemma)return searchLegacy(registry,query,limit,context,lexical,result);
      // Full selected metadata is split before encoding; neither memory bodies
      // nor text-bearing identities enter this path. Coverage is explicit.
      const fragments=[],selected=registry.slice(0,64);let omittedHeaders=registry.length-selected.length,fragmentChars=0;
      for(const entry of selected){
        const text=host.searchText?host.searchText(entry):host.text(entry);if(typeof text!=='string'||text.length>4096){omittedHeaders++;continue;}
        let complete=true;
        for(let start=0;start<text.length;){
          let end=Math.min(text.length,start+96);if(end<text.length&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;
          if(fragments.length>=128||fragmentChars+end-start>16384){complete=false;break;}
          fragments.push({entry,start,end,text:text.slice(start,end)});fragmentChars+=end-start;
          if(end===text.length)break;start=end-16;if(text.charCodeAt(start)>=0xdc00&&text.charCodeAt(start)<=0xdfff)start--;
        }
        if(!complete)omittedHeaders++;
      }
      const coverage={source:'memory-metadata',bodyIndexed:false,selection:'first-64-eligible-headers',headerLimit:64,fragmentLimit:128,
        candidateHeaders:registry.length,selectedHeaders:selected.length,fragments:fragments.length,omittedHeaders,headerComplete:omittedHeaders===0,
        encodedFragments:0,admissionEvaluated:false,complete:false};
      if(!fragments.length){await context.check?.('finish');return result(baseline,'budget',{coverage});}
      {
        const deadline=Math.min(Date.now()+1000,Number.isFinite(context.deadline)?context.deadline:Infinity),scopeId=context.scopeId,request=SemanticAdmissionRequest.create({query,scopeId,identify:SemanticRetrieval.structuredIds,normalize:text=>text.normalize('NFKC').toLowerCase(),terms:retrievalTerms,maxRows:128}),fields=new Map(),owners=new Map();
        try{
          for(const entry of selected){const text=host.searchText?host.searchText(entry):host.text(entry);if(typeof text!=='string'||text.length>4096)continue;const key=host.key(entry),revision=String(entry.memoryVersion||''),identity={sourceId:JSON.stringify([scopeId,key]),field:'memory.metadata',revision,epoch:scopeId,sourceRevision:crypto.createHash('sha256').update(text).digest('hex')},field=request.addField({identity,text},{kind:'raw-metadata-v1',order:[key]});fields.set(key,field);owners.set(identity.sourceId,entry);}
          const input=request.inputs(),scored=await host.score(query,input.docs,{scopeId,signal:context.signal,deadline,maxEncodeDocuments:128,identities:input.identities,policyContext:input.policyContext,purpose:'search',beforeEncode:()=>context.check?.('finish')});await context.check?.('finish');
          const known=SemanticRetrieval.hasScoreEvidence(scored);if(!known&&['ready','partial'].includes(scored.status)&&scored.modelFingerprint===SemanticAdmissionRequest.CONTRACT.modelFingerprint)throw Error('semantic.score_evidence_invalid');
          const decision=await request.evaluate(known?scored:null,{poolComplete:coverage.headerComplete&&!input.truncated,lexicalFields:lexical.filter(row=>row.shared>0&&fields.has(host.key(row.entry))).map(row=>fields.get(host.key(row.entry))),deadline,signal:context.signal,beforeVerify:()=>context.check?.('finish'),verifyField:async snapshot=>{await context.check?.('finish');const entry=owners.get(snapshot.identity.sourceId);if(!entry)return null;return {identity:snapshot.identity,text:host.searchText?host.searchText(entry):host.text(entry)};}}),d=request.read();
          const kept=lexical.filter(row=>row.shared>0&&d.weakAccepted.get(fields.get(host.key(row.entry)))===true),lexicalKeys=new Set(kept.map(row=>host.key(row.entry))),added=[];
          for(let n=0;n<d.semanticAccepted.length;n++){if(d.semanticAccepted[n]!==true)continue;const field=request.fieldAt(n),entry=selected.find(item=>fields.get(host.key(item))===field);if(!entry||lexicalKeys.has(host.key(entry)))continue;added.push({entry,shared:0,semanticOnly:true,semanticScore:scored.scores[n]});}
          added.sort((a,b)=>b.semanticScore-a.semanticScore||host.key(a.entry).localeCompare(host.key(b.entry)));const addedKeys=new Set(added.map(row=>host.key(row.entry))),rows=[...kept,...added,...lexical.filter(row=>!row.shared&&!addedKeys.has(host.key(row.entry)))].slice(0,limit);
          await context.check?.('finish');request.read();return result(rows,decision.complete?'ready':'partial',{modelFingerprint:scored.modelFingerprint,admissionPolicy:decision.policyId,semanticOnlyMatches:rows.filter(row=>row.semanticOnly).length,coverage:{...coverage,encodedFragments:scored.coverage?.cached||0,admissionEvaluated:true,complete:decision.complete}});
        }finally{request.dispose();}
      }
    }
    return Object.freeze({ rank, search, clear:()=>{progressGeneration++;searchProgress.clear();} });
  }
  return Object.freeze({ create });
})();

let memorySemanticRetrieval = null;
const memorySemanticRecall = MemorySemanticRecall.create({
  fallback: (registry, query, limit, config) => rankMemoriesForRecallDetailed(registry, query, limit, config),
  lexical: (registry, query) => rankRelevantMemoriesScored(registry, query),
  enabled: config => memoryVectorRecallEnabled(config),
  budgetSafe: (entries, config) => memorySemanticBudgetSafe(entries, config),
  key: entry => memoryRetrievalKey(entry), text: entry => memoryRetrievalText(entry),
  searchText: entry => memoryExplicitRetrievalText(entry),
  descriptor:()=>SemanticRuntimeHooks.descriptor(),
  score: (query, texts, options) => {
    if (!memorySemanticRetrieval) {
      memorySemanticRetrieval = SemanticRetrieval.create(SemanticRuntimeHooks);
      SemanticRuntimeHooks.registerCache?.(memorySemanticRecall.clear);
    }
    return memorySemanticRetrieval.score(query, texts, options);
  },
});
Object.assign(MemorySemanticHooks, { rank: (...args) => memorySemanticRecall.rank(...args), search: (...args) => memorySemanticRecall.search(...args), clear: () => { memorySemanticRecall.clear(); memorySemanticRetrieval?.clear(); } });
if(typeof SemanticPolicyConsumers!=='undefined')SemanticPolicyConsumers.add('memory');
