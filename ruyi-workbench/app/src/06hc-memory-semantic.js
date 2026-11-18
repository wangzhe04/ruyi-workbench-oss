// Semantic memory headers: automatic recall only reranks existing candidates;
// explicit list(query) may discover additional eligible headers after admission.
const MemorySemanticRecall = (() => {
  function create(host) {
    async function rank(registry, query, limit, config, context = {}) {
      const baseline = host.fallback(registry, query, limit, config);
      await context.check?.('start');
      const state = async status => { await context.check?.('finish'); return { ...baseline, semantic: { status, mode: 'rerank-only', automaticCandidates: false } }; };
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
      const result=(rows,status,extra={})=>({entries:rows.map(row=>row.entry),matched:rows.filter(row=>row.shared>0||row.semanticOnly).map(row=>row.entry),
        matches:new Map(rows.map(row=>[host.key(row.entry),{kind:row.semanticOnly?'semantic':row.shared>0?'lexical':'rule-fill',...(row.shared>0?{lexicalScore:row.score}:{}),...(Number.isFinite(row.semanticScore)?{semanticScore:row.semanticScore}:{})}])),
        semantic:{status,mode:'explicit-header-search',automaticCandidates:false,...extra}});
      const fallback=async status=>{await context.check?.('finish');return result(baseline,status);};
      await context.check?.('start');
      if(config?.semanticRetrievalV1===false||!host.enabled(config))return fallback('disabled');
      if(!query||query.length>256||!registry.length)return fallback('not-needed');
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
      if(typeof SemanticAdmissionRequest!=='undefined'&&typeof SemanticRuntimeTransportProof!=='undefined'&&SemanticRuntimeTransportProof.method()!==null){
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
      const scored=await host.score(query,fragments.map(row=>row.text),{scopeId:context.scopeId,signal:context.signal,deadlineMs:1000,maxEncodeDocuments:128,purpose:'search',
        identities:fragments.map(row=>[host.key(row.entry),row.entry.memoryVersion||'',row.start,row.end]),beforeEncode:()=>context.check?.('finish')});
      await context.check?.('finish');
      if(!['ready','partial','disabled','unavailable','loading','timeout','overloaded','truncated'].includes(scored?.status))throw Error('memory_semantic.score_failed');
      const admissionEvaluated=!!scored.admission&&Array.isArray(scored.admission.accepted)&&scored.admission.accepted.length===fragments.length;
      const finalCoverage={...coverage,encodedFragments:scored.coverage?.cached??0,admissionEvaluated,
        complete:coverage.headerComplete&&scored.coverage?.complete===true&&admissionEvaluated&&['ready','partial'].includes(scored.status)};
      if(!['ready','partial'].includes(scored.status))return result(baseline,scored.status,{coverage:finalCoverage});
      if(!admissionEvaluated)return result(baseline,'admission-unavailable',{coverage:finalCoverage});
      const accepted=new Map();
      fragments.forEach((row,index)=>{const score=scored.scores?.[index];if(scored.admission.accepted[index]!==true||!Number.isFinite(score))return;const key=host.key(row.entry),prior=accepted.get(key);if(!prior||score>prior.semanticScore)accepted.set(key,{entry:row.entry,shared:0,semanticOnly:true,semanticScore:score});});
      const lexicalKeys=new Set(lexical.filter(row=>row.shared>0).map(row=>host.key(row.entry)));
      const added=[...accepted.values()].filter(row=>!lexicalKeys.has(host.key(row.entry))).sort((a,b)=>b.semanticScore-a.semanticScore||host.key(a.entry).localeCompare(host.key(b.entry)));
      const additions=new Set(added.map(row=>host.key(row.entry)));
      const rows=[...lexical.filter(row=>row.shared>0),...added,...lexical.filter(row=>!row.shared&&!additions.has(host.key(row.entry)))].slice(0,limit);
      return result(rows,scored.status,{modelFingerprint:scored.modelFingerprint,admissionPolicy:scored.admission.policyId,semanticOnlyMatches:rows.filter(row=>row.semanticOnly).length,
        coverage:finalCoverage});
    }
    return Object.freeze({ rank, search });
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
    if (!memorySemanticRetrieval) memorySemanticRetrieval = SemanticRetrieval.create(SemanticRuntimeHooks);
    return memorySemanticRetrieval.score(query, texts, options);
  },
});
Object.assign(MemorySemanticHooks, { rank: (...args) => memorySemanticRecall.rank(...args), search: (...args) => memorySemanticRecall.search(...args), clear: () => memorySemanticRetrieval?.clear() });
if(typeof SemanticPolicyConsumers!=='undefined')SemanticPolicyConsumers.add('memory');
