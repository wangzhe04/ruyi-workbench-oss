// Both automatic and explicit recall use authenticated memory headers for Gemma admission.
const MemorySemanticRecall = (() => {
  function deferredRecall(status, method) {
    return ['loading','overloaded','timeout','partial','unavailable','truncated'].includes(status)
      ? { reason:status, method } : null;
  }
  // 非 ready 的 descriptor 归成重排回执的状态:停用 → disabled;失败/身份未知/正在停 → unavailable;其余(cold、loading、
  // warming、配置或模型切换后的空档)都是「还没好」→ loading。
  function descriptorStatus(descriptor) {
    const value = String(descriptor?.state || '');
    if (['disabled','shutdown'].includes(value)) return 'disabled';
    if (['failed','unknown','cleanup-failed','stopping','closing'].includes(value)) return 'unavailable';
    if (value === 'timeout') return 'timeout';
    return 'loading';
  }
  // 150 号文 S1:语义层的非守卫失败(运行时起不来、编解码契约等)退回关键词基线并标 unavailable;
  // 调用方的回验回调经 SemanticFailurePolicy.guard 包过,它抛的(撤权、stale、取消、privacy、work_data)照常上抛。
  // 单文件 vm 夹具里没有 00-boot 时整体保守:不包、不降级(行为同修前)。
  const failures = typeof SemanticFailurePolicy !== 'undefined' ? SemanticFailurePolicy : { guard: fn => fn, degradable: () => false };
  // 152 L1:发送前的自动召回从不无限等待。调用方给了期限就用它,没给就按默认软上限。
  const sendBudgetMs = () => typeof MEMORY_SEND_SEMANTIC_BUDGET_MS === 'number' ? MEMORY_SEND_SEMANTIC_BUDGET_MS : 400;
  const HEADER_SCOPE = 'memory-headers', AUTOMATIC_SEMANTIC_ADDITIONS = false;
  const sendDeadline = context => Number.isFinite(context?.deadline) ? context.deadline : Date.now() + sendBudgetMs();
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
    // 150 号文 S16:一次显式检索不再只翻一页。带 progressKey 时在同一个调用期限(1 s,或调用方更早的 deadline)内连续翻页:
    // 上一页完整编码并完成准入(续页偏移前进)且余量足够(见下),才进下一页;任何一页没做完/超时/忙/不可用就停在那里,
    // 进度照旧记在 searchProgress 里,下一次同查询从断点续。check('start') 仍只在 search 入口一次;每一页各自走 beforeEncode 与 finish 回验。
    async function searchLegacy(registry, query, limit, context, lexical, result) {
      if (!context.progressKey) return searchLegacyPage(registry, query, limit, context, lexical, result);
      const deadline = Math.min(Date.now() + 1000, Number.isFinite(context.deadline) ? context.deadline : Infinity);
      const paged = { ...context, deadline };
      const offsetOf = () => searchProgress.get(context.progressKey)?.offset || 0;
      const callStart = Date.now();
      let began = callStart, out = await searchLegacyPage(registry, query, limit, paged, lexical, result), offset = offsetOf();
      for (let pages = 1; pages < Math.ceil(registry.length / 64) + 1; pages++) {
        const coverage = out.semantic.coverage, spent = Date.now() - began;
        // 复核 F4:续页要留足余量 —— 剩余至少是上一页实际耗时的 2 倍、且不少于整个调用期限的一半;否则停在这里下次续。
        // 冷页比热页慢得多,余量不够时硬撞共享期限会触发 06hb 的硬超时 → markFaulted → 冷却翻倍,连累自动召回。
        if (out.semantic.status !== 'partial' || coverage.canContinue !== true || deadline - Date.now() < Math.max(100, 2 * spent, (deadline - callStart) / 2)) break;
        began = Date.now();
        out = await searchLegacyPage(registry, query, limit, paged, lexical, result);
        // 进度按续页偏移量算(整页都是超长头时 examinedHeaders 不涨,但偏移照样前进)。
        if (offsetOf() <= offset) break;
        offset = offsetOf();
      }
      return out;
    }
    async function searchLegacyPage(registry, query, limit, context, lexical, result) {
      const key = context.progressKey, prior = key && searchProgress.get(key);
      const generation = progressGeneration;
      const offset = prior?.offset || 0;
      const {fragments, end, skipped} = legacyPage(registry, offset);
      // 150 号文 S2/S16:本页开始编码之前与打分之后,回验带上本页要编码的全部条目(不止最后返回的那几条),宿主逐文件 stat 复核;
      // 批与批之间的回验只比令牌(进程内写、增删改名、配置、选择/权限变化照样逐批拦住),不再每批重 stat 64 个文件。
      const encoding = [...new Set(fragments.map(row => row.entry))];
      // 复核 F2:每一批文档编码之前(06ha 的 resolveTexts 钩子,≤4 条)只 stat 这一批的文件;批间的 beforeEncode 只比令牌。
      const resolveTexts = async batch => { await context.check?.('finish', [...new Set(batch.map(n => fragments[n].entry))]); return batch.map(n => fragments[n].text); };
      const scored = fragments.length ? await host.score(query, fragments.map(row=>row.text), {
        scopeId:context.scopeId, signal:context.signal, deadline:context.deadline, deadlineMs:1000,
        maxEncodeDocuments:128, purpose:'search', resolveTexts, beforeEncode:()=>context.check?.('finish'),
        identities:fragments.map(row=>[host.key(row.entry),row.entry.memoryVersion||'',row.start,row.end]),
      }) : {status:'ready', scores:[], admission:prior?.policyId ? {policyId:prior.policyId, accepted:[]} : null, coverage:{cached:0,complete:true}, modelFingerprint:prior?.modelFingerprint};
      await context.check?.('finish', encoding);
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
      const accepted = [...hits].filter(([key])=>eligible.has(key)&&!lexicalKeys.has(key)).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,128);
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
      if (limit > 0 && query && query.length <= 8192 && registry.length && config?.semanticRetrievalV1 !== false && host.enabled(config)
          && typeof SemanticAdmissionRequest !== 'undefined' && typeof SemanticRuntimeTransportProof !== 'undefined'
          && SemanticRuntimeTransportProof.method() !== null) {
        return search(registry, query, limit, config, context, baseline);
      }
      context = { ...context, check: failures.guard(context.check) };
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
      // prepare joins startup for a short window. A ready worker can then finish
      // the whole rerank; terminal states retain their normal recovery path.
      if (typeof host.descriptor === 'function') {
        let descriptor = null;
        try { descriptor = host.descriptor(); } catch { descriptor = null; }
        // 拿不到 descriptor(宿主没装运行时端口)时不猜,照修前走 score,由 prepare 自己报状态。
        if (descriptor && descriptor.available !== true && descriptorStatus(descriptor) !== 'loading') {
          try { host.warm?.(); } catch { /* 预热只是提示,失败不影响本回合 */ }
          return state(descriptorStatus(descriptor));
        }
      }
      const selected = positions.map(index => baseline.entries[index]);
      // Headers only. This bounded prefix is a reranking hint, never a claim that
      // the memory body or the full metadata has been indexed or read.
      const texts = selected.map(entry => host.text(entry).slice(0, 96));
      let result;
      try {
        result = await host.score(query, texts, {
          scopeId: context.scopeId, signal: context.signal, waitForCompletion: true, maxEncodeDocuments: 16, deadline: sendDeadline(context),
          // 每批编码之前的回验带上这一批待编码条目,宿主逐文件 stat 复核;批间 beforeEncode 只比令牌,末尾披露前再按披露集合 stat(150 号文 S2)。
          identities: selected.map(entry => [host.key(entry), entry.memoryVersion || '']), purpose: 'rerank', beforeEncode: () => context.check?.('finish'),
          // 复核 F2:每一批编码之前只 stat 这一批(≤4 条)的文件。
          resolveTexts: async batch => { await context.check?.('finish', batch.map(n => selected[n])); return batch.map(n => texts[n]); },
        });
        if (!['ready', 'partial', 'disabled', 'unavailable', 'loading', 'timeout', 'overloaded', 'truncated'].includes(result?.status)) throw Error('memory_semantic.score_failed');
      } catch (error) {
        if (!failures.degradable(error, context.signal)) throw error;
        return state('unavailable');
      }
      if (result.status !== 'ready' || result.scores?.length !== selected.length || !result.scores.every(Number.isFinite)) return state(result.status);
      await context.check?.('finish');
      const ordered = selected.map((entry, index) => ({ entry, score: result.scores[index], index })).sort((a, b) => b.score - a.score || a.index - b.index);
      const entries = baseline.entries.slice();
      positions.forEach((position, index) => { entries[position] = ordered[index].entry; });
      return { entries, baselineEntries: baseline.entries, rankingKeys: selected.map(entry => host.key(entry)), fillKeys: baseline.fillKeys,
        semantic: { status: 'reranked', mode: 'rerank-only', automaticCandidates: false, modelFingerprint: result.modelFingerprint, candidateCount: selected.length } };
    }
    // 152 L2:发送时召回、显式检索与后台预编码共用同一份记忆头挑选与窗口编码身份,预编码出的向量正好是之后请求要查的那一行。
    // 编码身份只含记忆键、版本、原文摘要与窗口坐标,与会话无关;文档向量落在共享的 HEADER_SCOPE 缓存里。
    function headerSelection(registry, automatic) {
      const fragmentLimit = automatic ? 512 : 128, charLimit = automatic ? 65536 : 16384, fragments = [], selected = [];
      let omittedHeaders = 0, fragmentChars = 0;
      for (const entry of registry.slice(0, 128)) {
        const initialFragments = fragments.length, initialChars = fragmentChars;
        const text = host.searchText ? host.searchText(entry) : host.text(entry); if (typeof text !== 'string' || text.length > 4096) continue;
        let complete = true;
        for (let start = 0; start < text.length;) {
          let end = Math.min(text.length, start + 96); if (end < text.length && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
          if (fragments.length >= fragmentLimit || fragmentChars + end - start > charLimit) { complete = false; break; }
          fragments.push({ entry, start, end, text: text.slice(start, end) }); fragmentChars += end - start;
          if (end === text.length) break; start = end - 16; if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start--;
        }
        if (automatic && !complete) { fragments.length = initialFragments; fragmentChars = initialChars; break; }
        selected.push(entry);
        if (!complete) omittedHeaders++;
      }
      omittedHeaders += registry.length - selected.length;
      return { fragments, selected, omittedHeaders, fragmentLimit };
    }
    function headerRequest(selected, query, scopeId, maxRows) {
      const request = SemanticAdmissionRequest.create({ query, scopeId, explicitMemory: true, identify: SemanticRetrieval.structuredIds,
        normalize: text => text.normalize('NFKC').toLowerCase(), terms: retrievalTerms, maxRows }), fields = new Map(), owners = new Map();
      try {
        for (const entry of selected) {
          const text = host.searchText ? host.searchText(entry) : host.text(entry); if (typeof text !== 'string' || text.length > 4096) continue;
          const key = host.key(entry), revision = String(entry.memoryVersion || '');
          const identity = { sourceId: JSON.stringify([scopeId, key]), field: 'memory.metadata', revision, epoch: scopeId, sourceRevision: crypto.createHash('sha256').update(text).digest('hex') };
          const field = request.addField({ identity, text }, { kind: 'raw-metadata-v1', order: [key],
            identityForWindow: window => ['memory-header-v1', key, revision, window.sourceRevision, window.start, window.end] });
          fields.set(key, field); owners.set(identity.sourceId, entry);
        }
      } catch (error) { request.dispose(); throw error; }
      return { request, fields, owners, entriesByField: new Map(selected.map(entry => [fields.get(host.key(entry)), entry])) };
    }
    const headerOwners = (request, input, entriesByField) => input.docs.map((_, n) => { const entry = entriesByField.get(request.fieldAt(n)); return entry ? host.key(entry) : null; });
    function kickPrewarm(context, registry) { try { if (typeof host.prewarm === 'function' && typeof context?.cwd === 'string') host.prewarm(context.cwd, registry); } catch { /* 预编码只是提示 */ } }
    // 152 L2:只编码不打分。与 search() 相同的挑选与编码身份;每一条编码之前 options.check 回验这一条的来源。
    async function prime(registry, options = {}) {
      const useGemma = typeof SemanticAdmissionRequest !== 'undefined' && typeof SemanticRuntimeTransportProof !== 'undefined' && SemanticRuntimeTransportProof.method() !== null;
      if (typeof host.prime !== 'function' || !useGemma) return { status: 'unavailable', total: 0, cached: 0, encoded: 0 };
      const { selected, fragmentLimit } = headerSelection(registry, true);
      if (!selected.length) return { status: 'ready', total: 0, cached: 0, encoded: 0 };
      const { request, entriesByField } = headerRequest(selected, 'memory header prewarm', HEADER_SCOPE, fragmentLimit);
      try {
        const input = request.inputs();
        let sources = [];
        return await host.prime(input.docs, { documentScopeId: HEADER_SCOPE, identities: input.identities, owners: headerOwners(request, input, entriesByField),
          signal: options.signal, deadline: options.deadline, maxEncodeDocuments: fragmentLimit, gapMs: options.gapMs,
          resolveTexts: async batch => { sources = batch.map(n => entriesByField.get(request.fieldAt(n))); await options.check?.(sources); return batch.map(n => input.docs[n]); },
          beforeEncode: () => options.check?.(sources) });
      } finally { request.dispose(); }
    }
    function mergeAutomatic(baseline, admitted, scoreOf, limit) {
      const matches = baseline.entries.filter(entry => !baseline.fillKeys.has(host.key(entry)));
      const keys = new Set(matches.map(host.key));
      const best = Math.max(-Infinity, ...Array.from(admitted.values(), row => row.semanticScore));
      // Admission verifies the original header. On unattended sends also omit
      // marginal alternatives that trail the strongest admitted hit.
      // 152 D1:SR2 未过、相对准入判据(152 Q1–Q3)过门之前,无人值守的发送只给已有关键词候选重排,不补纯语义命中。
      // 显式检索不受影响。打开它只需改 AUTOMATIC_SEMANTIC_ADDITIONS,不改下面的判定。
      const additions = !AUTOMATIC_SEMANTIC_ADDITIONS ? [] : Array.from(admitted.values())
        .filter(row => row.semanticScore >= best - 0.035 && !keys.has(host.key(row.entry)))
        .map(row => row.entry);
      const addedKeys = new Set(additions.map(host.key));
      const fills = baseline.entries.filter(entry => baseline.fillKeys.has(host.key(entry)) && !addedKeys.has(host.key(entry)));
      const candidates = [...matches,...additions];
      const entries = [...candidates.slice().sort((a,b)=>scoreOf(b)-scoreOf(a)), ...fills].slice(0,limit);
      const retained = new Set(entries.map(host.key));
      return {entries, baselineEntries:[...candidates,...fills].filter(entry=>retained.has(host.key(entry))),
        rankingKeys:candidates.filter(entry=>retained.has(host.key(entry))).map(host.key), fillKeys:new Set(fills.map(host.key)),
        semanticOnlyMatches:entries.filter(entry=>addedKeys.has(host.key(entry))).length};
    }
    async function search(registry, query, limit, config, context = {}, automaticBaseline = null) {
      context = { ...context, check: failures.guard(context.check) };
      const lexical=host.lexical(registry,query),baseline=lexical.slice(0,limit);
      const result=(rows,status,extra={})=>{
        if (automaticBaseline) {
          const fallback = deferredRecall(status, 'existing-recall');
          return { ...automaticBaseline, semantic: {status, mode:AUTOMATIC_SEMANTIC_ADDITIONS?'hybrid-header-search':'rerank-only', automaticCandidates:AUTOMATIC_SEMANTIC_ADDITIONS,
            semanticOnlyMatches:0, ...extra, ...(fallback ? {fallback} : {})} };
        }
        const deferred = deferredRecall(status, rows.some(row=>row.semanticOnly) ? 'keywords-and-admitted-semantic' : 'keywords');
        return {entries:rows.map(row=>row.entry),matched:rows.filter(row=>row.shared>0||row.semanticOnly).map(row=>row.entry),
        matches:new Map(rows.map(row=>[host.key(row.entry),{kind:row.semanticOnly?'semantic':row.shared>0?'lexical':'rule-fill',...(row.shared>0?{lexicalScore:row.score}:{}),...(Number.isFinite(row.semanticScore)?{semanticScore:row.semanticScore}:{})}])),
        semantic:{status,mode:'explicit-header-search',automaticCandidates:false,scoreKind:'cosine',answerability:'not-assessed',...(deferred ? { fallback:deferred } : {}),...extra}};
      };
      const fallback=async status=>{await context.check?.('finish');return result(baseline,status);};
      await context.check?.('start');
      if(config?.semanticRetrievalV1===false||!host.enabled(config))return fallback('disabled');
      if(!query||query.length>(automaticBaseline?8192:256)||!registry.length)return fallback('not-needed');
      const useGemma=typeof SemanticAdmissionRequest!=='undefined'&&typeof SemanticRuntimeTransportProof!=='undefined'&&SemanticRuntimeTransportProof.method()!==null;
      if(!useGemma){
        try{return await searchLegacy(registry,query,limit,context,lexical,result);}
        catch(error){if(!failures.degradable(error,context.signal))throw error;return fallback('unavailable');}
      }
      // Full selected metadata is split before encoding; neither memory bodies
      // nor text-bearing identities enter this path. Coverage is explicit.
      const {fragments,selected,omittedHeaders,fragmentLimit}=headerSelection(registry,!!automaticBaseline);
      const coverage={source:'memory-metadata',bodyIndexed:false,selection:'first-128-eligible-headers',headerLimit:128,fragmentLimit,
        candidateHeaders:registry.length,selectedHeaders:selected.length,fragments:fragments.length,omittedHeaders,headerComplete:omittedHeaders===0,
        encodedFragments:0,admissionEvaluated:false,complete:false};
      if(!fragments.length){await context.check?.('finish');return result(baseline,'budget',{coverage});}
      {
        const deadline=automaticBaseline ? sendDeadline(context) : Math.min(Date.now()+1000,Number.isFinite(context.deadline)?context.deadline:Infinity),scopeId=context.scopeId,{request,fields,owners,entriesByField}=headerRequest(selected,query,scopeId,fragmentLimit);
        try{
          const input=request.inputs();let scored;
          const checkSources = () => context.check?.('finish', automaticBaseline ? undefined : selected);
          let encodingSources;
          const resolveBatch = async batch => {
            encodingSources = batch.map(index => entriesByField.get(request.fieldAt(index)));
            await context.check?.('finish', encodingSources);
            return batch.map(index => input.docs[index]);
          };
          try {
            scored = await host.score(query, input.docs, {
              scopeId, documentScopeId:HEADER_SCOPE, owners:headerOwners(request,input,entriesByField), signal:context.signal, deadline, maxEncodeDocuments:automaticBaseline?0:128, identities:input.identities,
              policyContext:input.policyContext, purpose:'search',
              beforeEncode:()=>context.check?.('finish', automaticBaseline ? encodingSources : selected),
              ...(automaticBaseline ? {resolveTexts:resolveBatch, waitForCompletion:true} : {}),
            });
          } catch (error) {
            if (!failures.degradable(error,context.signal)) throw error;
            await context.check?.('finish'); return result(baseline,'unavailable',{coverage});
          }
          await context.check?.('finish');
          if (automaticBaseline && scored.status !== 'ready') { kickPrewarm(context, selected); return fallback(scored.status); }
          const known=SemanticRetrieval.hasScoreEvidence(scored);
          if (!known && ['ready','partial'].includes(scored.status) && scored.modelFingerprint===SemanticAdmissionRequest.CONTRACT.modelFingerprint)
            throw Error('semantic.score_evidence_invalid');
          // Send-time selection stops at the last whole header that fits. Explicit
          // searches retain their full-registry completeness contract.
          function readHeader(snapshot) {
            const entry = owners.get(snapshot.identity.sourceId);
            return entry ? {identity:snapshot.identity, text:host.searchText ? host.searchText(entry) : host.text(entry)} : null;
          }
          const decision = await request.evaluate(known ? scored : null, {
            poolComplete:(!!automaticBaseline || coverage.headerComplete) && !input.truncated,
            lexicalFields:lexical.filter(row=>row.shared>0 && fields.has(host.key(row.entry))).map(row=>fields.get(host.key(row.entry))),
            deadline, signal:context.signal, beforeVerify:checkSources,
            ...(automaticBaseline && !AUTOMATIC_SEMANTIC_ADDITIONS && typeof context.check === 'function' ? {
              verifyBatch: async snapshots => {
                await context.check('finish', selected);
                return snapshots.map(readHeader);
              }
            } : {}),
            verifyField:async snapshot => {
              const entry=owners.get(snapshot.identity.sourceId);
              await context.check?.('finish',automaticBaseline && entry ? [entry] : selected);
              return readHeader(snapshot);
            },
          });
          const d = request.read();
          const kept=lexical.filter(row=>row.shared>0&&d.weakAccepted.get(fields.get(host.key(row.entry)))===true),lexicalKeys=new Set(kept.map(row=>host.key(row.entry))),bestByKey=new Map();
          for(let n=0;n<d.semanticAccepted.length;n++){
            if(d.semanticAccepted[n]!==true)continue;
            const field=request.fieldAt(n);
            const entry=entriesByField.get(field);
            if(!entry)continue;
            const key=host.key(entry),score=scored.scores[n];
            if((automaticBaseline || !lexicalKeys.has(key))&&(!bestByKey.has(key)||score>bestByKey.get(key).semanticScore))
              bestByKey.set(key,{entry,shared:0,semanticOnly:true,semanticScore:score});
          }
          if (automaticBaseline) {
            if (!known || !decision.complete) { kickPrewarm(context, selected); return fallback('partial'); }
            const scores = new Map();
            for (let n=0; n<input.docs.length; n++) {
              const field=request.fieldAt(n), score=scored.scores[n];
              if (Number.isFinite(score)) scores.set(field,Math.max(scores.get(field) ?? -Infinity,score));
            }
            await context.check?.('finish'); request.read();
            const merged = mergeAutomatic(automaticBaseline, bestByKey, entry=>scores.get(fields.get(host.key(entry))) ?? -2, limit);
            if (host.budgetSafe && !host.budgetSafe(merged.entries, config)) return fallback('budget');
            return { ...merged, semantic:{status:'reranked',mode:AUTOMATIC_SEMANTIC_ADDITIONS?'hybrid-header-search':'rerank-only',automaticCandidates:AUTOMATIC_SEMANTIC_ADDITIONS,
              modelFingerprint:scored.modelFingerprint,admissionPolicy:decision.policyId,candidateCount:merged.rankingKeys.length,
              semanticOnlyMatches:merged.semanticOnlyMatches,coverage:{...coverage,encodedFragments:scored.coverage.cached,
              admissionEvaluated:true,complete:decision.complete&&coverage.headerComplete}} };
          }
          const added=[...bestByKey.values()].sort((a,b)=>b.semanticScore-a.semanticScore||host.key(a.entry).localeCompare(host.key(b.entry)));const addedKeys=new Set(added.map(row=>host.key(row.entry))),rows=[...kept,...added,...lexical.filter(row=>!row.shared&&!addedKeys.has(host.key(row.entry)))].slice(0,limit);
          await context.check?.('finish');request.read();return result(rows,decision.complete?'ready':'partial',{modelFingerprint:scored.modelFingerprint,admissionPolicy:decision.policyId,semanticOnlyMatches:rows.filter(row=>row.semanticOnly).length,coverage:{...coverage,encodedFragments:scored.coverage?.cached||0,admissionEvaluated:true,complete:decision.complete}});
        }finally{request.dispose();}
      }
    }
    return Object.freeze({ rank, search, prime, clear:()=>{progressGeneration++;searchProgress.clear();} });
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
  descriptor:()=>typeof SemanticRuntimeHooks.descriptor === 'function' ? SemanticRuntimeHooks.descriptor() : null,
  // Retry a failed worker through its existing cooldown.
  warm:()=>{ if (typeof SemanticRuntimeHooks.prewarm !== 'function') return; const task = SemanticRuntimeHooks.prewarm(); if (task && typeof task.catch === 'function') task.catch(() => {}); },
  score: (query, texts, options) => memoryRetrievalScorer().score(query, texts, options),
  prime: (docs, options) => memoryRetrievalScorer().prime(docs, options),
  prewarm: (cwd, entries) => memoryHeaderPrewarm.schedule(cwd, entries),
});
function memoryRetrievalScorer() {
  if (!memorySemanticRetrieval) {
    memorySemanticRetrieval = SemanticRetrieval.create(SemanticRuntimeHooks);
    SemanticRuntimeHooks.registerCache?.(memorySemanticRecall.clear);
  }
  return memorySemanticRetrieval;
}
// 152 L2:记忆头向量的后台预编码。发送时召回因向量没齐而退回关键词基线时被踢一下;按项目单飞,
// 忙就稍后再来(后台优先级、不在 worker 租约上排队)。每编一条之前核对库与配置没变,变了就按新库重来。
// 只把向量放进进程内缓存(与请求内编码同一行),不打分、不披露;语义关闭或库读不出(含工作数据锁定)时收工。
const memoryHeaderPrewarm = (() => {
  const running = new Map(), RETRY_MS = { busy: 400, timeout: 400, loading: 2000, partial: 2000 }, MAX_PASSES = 60;
  const stale = Object.freeze({ memoryHeaderPrewarmStale: true });
  // entries:发送路径刚挑出的那一份(已按会话排除、核心与原生 CLI 过滤)。没给时按库里未过期的条目。
  async function pass(cwd, entries) {
    const token = await memorySnapshotToken(cwd, { usage: false });
    const config = await readConfig().catch(() => null);
    if (!config || config.semanticRetrievalV1 === false || !memoryVectorRecallEnabled(config)) return null;
    let registry;
    try { registry = await loadMemoryRegistry(cwd); } catch { return null; }
    const now = Date.now(), stats = memoryStatBaseline(registry), authority = registry.authority;
    if (typeof authority !== 'string' && registry.length) return null;
    if (Array.isArray(entries) && entries.length) {
      // 只编仍在库里、版本未变的那几条;库在此之后再变由 check 截住。
      const live = new Map(registry.map(entry => [memoryRetrievalKey(entry), entry]));
      registry = entries.map(entry => live.get(memoryRetrievalKey(entry))).filter(entry => entry && !memoryIsExpired(entry, now));
    } else registry = registry.filter(entry => !memoryIsExpired(entry, now));
    const check = async (batch = []) => {
      const current = await memorySnapshotToken(cwd, { usage: false });
      if (current.library !== token.library || current.config !== token.config || batch.some(entry => memoryIsExpired(entry, Date.now()))) throw stale;
      if (current.configTrusted === false) {
        const live = await readConfig();
        if (live.semanticRetrievalV1 === false || !memoryVectorRecallEnabled(live)) throw stale;
      }
      if (authority && await memoryBodyAuthority() !== authority || !await memoryEntriesUnchanged(batch, stats)) throw stale;
    };
    let result;
    try { result = await memorySemanticRecall.prime(registry, { check, gapMs: 50, deadline: Date.now() + 120000 }); }
    catch (error) { if (error === stale) return 0; throw error; }
    return result.status === 'ready' ? null : Object.hasOwn(RETRY_MS, result.status) ? RETRY_MS[result.status] : null;
  }
  function schedule(cwd, entries, debounce = false) {
    if (typeof cwd !== 'string') return;
    const key = cwd ? projectKeyForCwd(cwd) : '', current = running.get(key), list = Array.isArray(entries) ? entries.slice(0, 128) : null;
    if (current) {
      current.again = true;
      if (list) current.entries = list;
      if (current.timer && current.debouncing) {
        if (debounce) current.timer.refresh?.();
        else { clearTimeout(current.timer); current.debouncing = false; current.timer = setTimeout(current.step, 0); current.timer.unref?.(); }
      }
      return;
    }
    const state = { again: false, passes: 0, entries: list, debouncing: debounce, timer: null, step: null };
    running.set(key, state);
    const step = state.step = async () => {
      state.timer = null; state.debouncing = false;
      let delay = null;
      try { delay = await pass(cwd, state.entries); } catch { delay = null; }
      state.passes++;
      if (state.again) { state.again = false; if (delay === null) delay = 0; }
      if (delay === null || state.passes >= MAX_PASSES) { running.delete(key); return; }
      const timer = setTimeout(step, delay); timer.unref?.();
    };
    state.timer = setTimeout(step, debounce ? 2000 : 0); state.timer.unref?.();
  }
  return Object.freeze({ schedule, pending: () => running.size });
})();
Object.assign(MemorySemanticHooks, { changed: (cwd, owner) => { memorySemanticRetrieval?.forget(owner); if (SemanticRuntimeTransportProof.method() !== null) memoryHeaderPrewarm.schedule(cwd || '', null, true); }, prewarmGlobal: () => memoryHeaderPrewarm.schedule('', null, true), rank: (...args) => memorySemanticRecall.rank(...args), search: (...args) => memorySemanticRecall.search(...args), clear: () => { memorySemanticRecall.clear(); memorySemanticRetrieval?.clear(); } });
if(typeof SemanticPolicyConsumers!=='undefined')SemanticPolicyConsumers.add('memory');
