// In-memory semantic primitives. The host owns runtime availability and authorization.
const SemanticRetrieval = ((crypto) => {
const scoreEvidenceRecords=new WeakMap(),scoreEvidenceModel='sha256:9d41595d7508ff328b6c5a4223c7af26a91ed2fe53662cc9d633c1373eb4163e';
const scoreEvidenceInvalid=()=>Error('semantic.score_evidence_invalid');
function scoreEvidenceIdentity(value){if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value)&&value.length<=64&&value.every(v=>v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v)))return JSON.stringify(value);throw scoreEvidenceInvalid();}
function scoreEvidenceVector(v){return Array.isArray(v)&&v.length===768&&v.every(Number.isFinite)&&v.some(n=>n!==0);}
function scoreEvidenceCosine(a,b){let dot=0,an=0,bn=0;for(let n=0;n<a.length;n++){dot+=a[n]*b[n];an+=a[n]*a[n];bn+=b[n]*b[n];}return dot/Math.sqrt(an*bn);}
function sealScoreEvidence(result,{query,scopeId,modelFingerprint,docs,identities,queryVector,vectors,encodedTexts,stillCurrent}){ if(!result||typeof result!=='object'||scoreEvidenceRecords.has(result)||typeof query!=='string'||!query.trim()||typeof scopeId!=='string'||!scopeId||modelFingerprint!==scoreEvidenceModel||result.modelFingerprint!==scoreEvidenceModel||!Array.isArray(docs)||!Array.isArray(identities)||identities.length!==docs.length||!docs.every(t=>typeof t==='string')||!Array.isArray(vectors)||vectors.length!==docs.length||!Array.isArray(encodedTexts)||encodedTexts.length!==docs.length||encodedTexts.some((t,n)=>vectors[n]===null?t!==null:typeof t!=='string')||!Array.isArray(result.scores)||result.scores.length!==docs.length||!scoreEvidenceVector(queryVector))throw scoreEvidenceInvalid();
 const scores=vectors.map((v,n)=>{if(v===null){if(result.scores[n]!==null)throw scoreEvidenceInvalid();return null;}if(!scoreEvidenceVector(v))throw scoreEvidenceInvalid();const value=scoreEvidenceCosine(queryVector,v);if(!Number.isFinite(value)||!Number.isFinite(result.scores[n])||Math.abs(value-result.scores[n])>1e-12)throw scoreEvidenceInvalid();return result.scores[n];});
 scoreEvidenceRecords.set(result,Object.freeze({query,scopeId,modelFingerprint,docs:docs.slice(),identities:identities.map(scoreEvidenceIdentity),scores,encodedTexts:encodedTexts.slice(),stillCurrent}));return result;
}
function readScoreEvidence(result,{query,scopeId,modelFingerprint}){const p=scoreEvidenceRecords.get(result);if(!p||!p.stillCurrent()||p.query!==query||p.scopeId!==scopeId||p.modelFingerprint!==modelFingerprint||result.modelFingerprint!==p.modelFingerprint||!Array.isArray(result.scores)||result.scores.length!==p.scores.length||p.scores.some((v,n)=>result.scores[n]!==v))throw scoreEvidenceInvalid();return {docs:p.docs.slice(),identities:p.identities.slice(),scores:p.scores.slice(),encodedTexts:p.encodedTexts.slice()};}
  const searchPolicy=Object.freeze({id:'explicit-scalar-search-v1',modelId:'synthetic-scalar-model',minScore:0.85,structuredIdentifiers:true,purpose:'search-relevance',automatic:null});
  function structuredIdMatches(identifierText) {
    const normalized=String(identifierText).normalize('NFKC').toLowerCase(),matches=[];
    // Validate the complete maximal ASCII identifier token. Searching inside a
    // rejected token would conflate AB-ZZ-91, XY-ZZ-91 and overlong prefixes.
    for(const match of normalized.matchAll(/[a-z0-9_:-]+/g)){
      const token=match[0];let from=0,to=token.length;
      // Boundary separators may be prose punctuation ("OP-12:"). Trim only
      // the two edges; invalid internal segments never restart suffix parsing.
      while(from<to&&!/[a-z0-9]/.test(token[from]))from++;
      while(to>from&&!/[a-z0-9]/.test(token[to-1]))to--;
      const value=token.slice(from,to);if(value.length>256||!/^[a-z][a-z0-9]{1,15}(?:[-_:][a-z0-9]+)+$/.test(value))continue;
      if(!/\d/.test(value.slice(value.search(/[-_:]/)+1)))continue;
      matches.push({value,start:match.index+from,end:match.index+to});
    }
    return matches;
  }
  const structuredIds=text=>[...new Set(structuredIdMatches(text).map(match=>match.value))];
  function assessAdmission(query,docs,scores,{complete=true,minScore=searchPolicy.minScore}={}) {
    const required=structuredIds(query),reasons=[];
    const accepted=scores.map((score,n)=>{
      const reason=!Number.isFinite(score)?'unscored':score<minScore?'low-cosine':required.some(id=>!structuredIds(docs[n]).includes(id))?'identifier-mismatch':'accepted';
      reasons.push(reason);return reason==='unscored'?null:reason==='accepted';
    });
    return{policyId:searchPolicy.id,purpose:searchPolicy.purpose,status:complete?'evaluated':'partial',accepted,reasons,
      features:{minimumCosine:minScore,requiredIdentifiers:required.length},answerability:'not-assessed'};
  }
  function create(runtime, options={}) {
    // Queries cannot evict document vectors. One complete 4096-fragment corpus
    // fits even while another scope/model is being warmed.
    const codecProof=typeof SemanticRuntimeTransportProof!=='undefined'?SemanticRuntimeTransportProof:null;
    const documentLimit=Math.max(4096,Math.min(16384,options.documentLimit||8192)),queryLimit=128;
    const documents=new Map(),queries=new Map();let cacheGeneration=0,codecToken=null,sourceReserveMs=0;
    const clear=()=>{cacheGeneration++;sourceReserveMs=0;documents.clear();queries.clear();};
    // 151 阶段 4A(150 S14):删除一条会话只忘掉它自己的文档向量(调用方在 score 时按行给 owners),查询向量与别的会话不动。
    const forget=owner=>{if(typeof owner!=='string'||!owner)return;for(const [k,row]of documents)if(row.owner===owner)documents.delete(k);};
    if(typeof runtime?.registerCache==='function')runtime.registerCache(clear);
    // Reserve measured call cost before starting another bounded batch. A native
    // deadline still kills its owner; routine tail-budget exhaustion must not.
    const callMsPerText={query:32,document:20};
    const minimumBudget=(role,count)=>{
      const local=Math.max(64,Math.ceil(callMsPerText[role]*Math.max(1,count)*1.25+16));
      if(typeof runtime?.estimateEncodingBudget!=='function')return local;
      const hint=runtime.estimateEncodingBudget(role,count);
      if(typeof hint!=='number'||!Number.isFinite(hint)||hint<0||hint>60000)throw Error('semantic.invalid_budget_hint');
      return Math.max(local,Math.ceil(hint));
    };
    const key=(scope,model,value)=>crypto.createHash('sha256').update(JSON.stringify([scope,model,value])).digest('hex');
    const vector=value=>Array.isArray(value)&&value.length>0&&value.length<=8192&&value.every(Number.isFinite)&&value.some(n=>n!==0);
    const get=(map,k)=>{const v=map.get(k);if(v){map.delete(k);map.set(k,v);}return v;};
    function put(map,k,v,limit){map.delete(k);map.set(k,v.slice());while(map.size>limit)map.delete(map.keys().next().value);}
    async function score(query,docs,{scopeId,signal,deadlineMs=1000,deadline:outerDeadline=Infinity,progressDeadline,identities=[],owners=[],maxEncodeDocuments=128,purpose='search',resolveTexts,beforeEncode,policyContext,stored}={}) {
      let generation=cacheGeneration;
      const empty=status=>({status,scores:docs.map(()=>null),coverage:{cached:0,total:docs.length,complete:false}});
      if(!runtime||typeof runtime.prepare!=='function'||typeof runtime.encode!=='function')return empty('unavailable');
      const deadline=Math.min(Date.now()+Math.max(1,Math.min(1000,deadlineMs)),Number.isFinite(outerDeadline)?outerDeadline:Infinity);
      // The caller may reserve a bounded window for a slow first fragment or
      // an admitted native batch. New batches still use the ordinary slice.
      let finishDeadline=Number.isFinite(progressDeadline)
        ? Math.max(deadline,Math.min(deadline+2000,progressDeadline)) : deadline;
      const descriptor=await runtime.prepare({scopeId,signal,deadline});
      if(beforeEncode)await beforeEncode();
      if(signal?.aborted)throw signal.reason===undefined?Error('semantic.aborted'):signal.reason;
      if(generation!==cacheGeneration)return empty('unavailable');
      // 150 号文 S18:先看 descriptor 再看期限。冷模型加载期 prepare 往往正好耗尽期限,修前先判期限就把「加载中」报成 timeout。
      if(!descriptor?.available){if(['disabled','unavailable','timeout','overloaded'].includes(descriptor?.reason))return empty(['loading','warming'].includes(descriptor.state)?'loading':descriptor.reason);throw Error('semantic.prepare_failed');}
      if(Date.now()>=finishDeadline)return empty('timeout');
      // Codec/startup readiness does not qualify a new retrieval policy. Keep
      // the explicit Gemma2 backend unavailable to consumers until its complete
      // K1/identifier/weak-evidence policy is connected across all entry points.
      if(descriptor.modelId==='embeddinggemma-2-text-q4'&&descriptor.policyReady!==true)return empty('unavailable');
      if(descriptor.modelId==='embeddinggemma-2-text-q4'&&purpose!=='rerank'&&(typeof SemanticOriginalWindows==='undefined'||!SemanticOriginalWindows.isRequest(policyContext,policyContext?.context)))return empty('unavailable');
      const minScore=descriptor.retrievalThresholds?.[purpose];
      if(purpose==='automatic'&&!(typeof minScore==='number'&&Number.isFinite(minScore)))return empty('disabled');
      const model=descriptor.modelFingerprint;if(typeof model!=='string'||!model.length||model.length>512)throw Error('semantic.invalid_model');
      let requestCodecToken=null;if(descriptor.modelId==='embeddinggemma-2-text-q4'){if(!codecProof)throw Error('semantic.untrusted_codec_result');requestCodecToken=codecProof.snapshot(model);if(requestCodecToken!==codecToken){clear();generation=cacheGeneration;codecToken=requestCodecToken;}}
      const qkey=key(scopeId,model,['query',query]),keys=docs.map((text,n)=>key(scopeId,model,['document',identities[n],text]));
      let q=get(queries,qkey),status='ready';const cachedDocuments=keys.map(k=>get(documents,k)||null),vectors=cachedDocuments.map(row=>row?.vector||null),encodedTexts=cachedDocuments.map(row=>row?.encodedText??null);
      // 151 阶段 4A(150 S14):调用方的持久向量(按模型指纹 + 片段来源 identity 落盘,后台编码)。只给非 Gemma 模型用 ——
      // Gemma 的分数证据要绑原文(encodedTexts),持久层不存原文。读盘途中缓存被清(撤权、换模型)就当没读到。
      if(typeof stored==='function'&&descriptor.modelId!=='embeddinggemma-2-text-q4'&&vectors.some(v=>!v)){const lookup=await stored(model);if(signal?.aborted)throw signal.reason===undefined?Error('semantic.aborted'):signal.reason;if(generation!==cacheGeneration)return empty('unavailable');
        if(typeof lookup==='function')for(let n=0;n<vectors.length;n++)if(!vectors[n]){const v=lookup(n);if(v&&v.length>0&&v.length<=8192)vectors[n]=v;}}
      // If one measured encode exceeds the usual grace, reserve its measured
      // cost for this request. The source owner keeps time for final validation.
      const needsDocuments=cachedDocuments.some(row=>!row);
      if(finishDeadline>deadline && (!q||needsDocuments)){
        const singleCost=(q?0:minimumBudget('query',1))+
          (needsDocuments?sourceReserveMs+minimumBudget('document',1):0);
        finishDeadline=Math.min(progressDeadline,deadline+Math.max(2000,singleCost));
      }
      async function encode(texts,role){
        if(signal?.aborted)throw signal.reason===undefined?Error('semantic.aborted'):signal.reason;
        if(beforeEncode)await beforeEncode();
        if(signal?.aborted)throw signal.reason===undefined?Error('semantic.aborted'):signal.reason;
        if(generation!==cacheGeneration)return {ok:false,reason:'unavailable'};
        // Source resolution and the final authority guard can consume the
        // budget used to select a batch. Submit only the prefix that still fits;
        // an unchanged oversized batch must not block every later request.
        let encodedCount=texts.length;
        if(role==='document')while(encodedCount>1&&minimumBudget(role,encodedCount)>deadline-Date.now())encodedCount--;
        texts=texts.slice(0,encodedCount);
        const minimumBudgetMs=minimumBudget(role,texts.length);
        if(finishDeadline-Date.now()<minimumBudgetMs)return {ok:false,reason:'timeout'};
        const encodeOptions={role,scopeId,signal,deadline:finishDeadline,minimumBudgetMs,beforeEncode};
        if(finishDeadline>deadline)encodeOptions.budgetMs=finishDeadline-Date.now();
        let began=Date.now();
        let result=await runtime.encode(texts,encodeOptions);
        // A competing batch can occupy the resident worker beyond the normal
        // 200 ms retry window. Back off within the same absolute reservation.
        const extended=finishDeadline>deadline;
        for(let tries=0;result?.reason==='overloaded'&&tries<(extended?24:8)&&typeof setTimeout==='function';tries++){
          const delayMs=extended&&tries>=8?100:25;
          if(finishDeadline-Date.now()<=minimumBudgetMs+delayMs)break;
          await new Promise(resolve=>setTimeout(resolve,delayMs));
          if(signal?.aborted)throw signal.reason===undefined?Error('semantic.aborted'):signal.reason;
          if(beforeEncode)await beforeEncode();
          if(generation!==cacheGeneration)return {ok:false,reason:'unavailable'};
          // 4A 三审 P7:只量最后一次真正发出的那次,重试前的等待不进单条耗时估计(否则一次撞车就把预算越学越大)。
          began=Date.now();
          result=await runtime.encode(texts,encodeOptions);
        }
        if(beforeEncode)await beforeEncode();
        if(signal?.aborted)throw signal.reason===undefined?Error('semantic.aborted'):signal.reason;
        if(generation!==cacheGeneration)return {ok:false,reason:'unavailable'};
        const perText=(Date.now()-began)/Math.max(1,texts.length);
        const costCap=finishDeadline>deadline?5000:250;
        if(result?.ok)callMsPerText[role]=Math.min(costCap,Math.max(12,callMsPerText[role]*0.6+perText*0.4));
        else if(result?.reason==='timeout')callMsPerText[role]=Math.min(costCap,Math.max(callMsPerText[role]*1.5,perText));
        if(!result?.ok){if(['unavailable','disabled','timeout','overloaded'].includes(result?.reason))return result;throw Error('semantic.encode_failed');}
        const validated=descriptor.modelId==='embeddinggemma-2-text-q4'?codecProof.verify(result,{texts,role,scopeId,modelFingerprint:model}):result;
        if(validated.modelFingerprint!==model||!Array.isArray(validated.vectors)||validated.vectors.length!==texts.length||!validated.vectors.every(vector))throw Error('semantic.invalid_vectors');
        const dimension=validated.vectors[0].length;if(descriptor.modelId==='embeddinggemma-2-text-q4'&&dimension!==768)throw Error('semantic.invalid_vectors');if(validated.vectors.some(v=>v.length!==dimension)||q&&q.length!==dimension)throw Error('semantic.invalid_vectors');
        return {ok:true,modelFingerprint:validated.modelFingerprint,vectors:validated.vectors.map(v=>v.slice()),...(validated.truncated?{truncated:validated.truncated.slice()}:{}),encodedCount};
      }
      if(!q){const result=await encode([query],'query');if(!result.ok)return {...empty(result.reason),modelFingerprint:model};if(result.truncated?.[0])return {...empty('truncated'),modelFingerprint:model};q=result.vectors[0];put(queries,qkey,q,queryLimit);}
      // 维度与查询不符的持久向量(同指纹却换了维度只可能是坏件)当作没有,不进打分。
      for(let n=0;n<vectors.length;n++)if(vectors[n]&&!cachedDocuments[n]&&vectors[n].length!==q.length)vectors[n]=null;
      const missing=[];for(let n=0;n<vectors.length;n++)if(!vectors[n])missing.push(n);
      const budget=Math.max(0,Math.min(128,Math.floor(Number(maxEncodeDocuments)||0)));
      const selected=missing.slice(0,budget);
      for(let offset=0;offset<selected.length;){
        let count=Math.min(4,selected.length-offset);
        while(count>1&&minimumBudget('document',count)>deadline-Date.now())count--;
        let batch=selected.slice(offset,offset+count);
        // 151 阶段 2:剩下的预算连一片都编不完时就不再去解析下一批来源(解析要回读会话正文,修前读完才发现编不了,
        // 白白把本次 score 拖过自己的截止)。
        const admissionDeadline=offset===0?finishDeadline:deadline;
        if(Date.now()>=admissionDeadline||minimumBudget('document',1)>admissionDeadline-Date.now()){if(beforeEncode)await beforeEncode();status='timeout';break;}
        const readStarted=Date.now();
        let texts=typeof resolveTexts==='function'?await resolveTexts(batch,{signal,deadline:finishDeadline}):batch.map(n=>docs[n]);
        // A source scan may itself consume the whole reservation before any
        // encode is submitted. Keep its observed cost for the next request.
        const readMs=Date.now()-readStarted;
        if(finishDeadline>deadline&&generation===cacheGeneration&&readMs>=100)
          sourceReserveMs=Math.min(15000,Math.ceil(readMs*1.5));
        if(!Array.isArray(texts)||texts.length!==batch.length||texts.some(text=>text!==null&&typeof text!=='string'))throw Error('semantic.invalid_source');
        const usable=batch.map((n,i)=>({n,position:i,text:texts[i]})).filter(item=>typeof item.text==='string'&&item.text.length>0&&item.text.length<=8192);
        if(usable.length<batch.length)status='partial';if(!usable.length){offset+=count;continue;}
        batch=usable.map(item=>item.n);texts=usable.map(item=>item.text);const result=await encode(texts,'document');
        if(!result.ok){status=result.reason;break;}
        // Keep vectors aligned with the actual submitted source prefix. Entries
        // resolved but not executed remain pending, including gaps in usable rows.
        batch=batch.slice(0,result.encodedCount);
        batch.forEach((n,i)=>{if(result.truncated?.[i]){status='truncated';return;}vectors[n]=result.vectors[i];encodedTexts[n]=texts[i];documents.delete(keys[n]);documents.set(keys[n],{vector:vectors[n].slice(),encodedText:encodedTexts[n],owner:typeof owners[n]==='string'?owners[n]:null});while(documents.size>documentLimit)documents.delete(documents.keys().next().value);});
        offset+=usable[result.encodedCount-1].position+1;
        if(Date.now()>=deadline){status='timeout';break;}
      }
      if(generation!==cacheGeneration)return empty('unavailable');
      // A genuine worker timeout can close the transport before this slice returns.
      // Discard the slice if that transport can no longer attest its scores.
      if(requestCodecToken && status==='timeout' && runtime.descriptor?.()?.available===false)return empty('timeout');
      if(requestCodecToken&&codecProof.snapshot(model)!==requestCodecToken)return empty('unavailable');
      const norm=v=>Math.sqrt(v.reduce((sum,n)=>sum+n*n,0)),qn=norm(q);
      const scores=vectors.map(v=>{if(!v)return null;if(v.length!==q.length)throw Error('semantic.invalid_vectors');return v.reduce((sum,n,i)=>sum+n*q[i],0)/(norm(v)*qn);});
      const cached=vectors.filter(Boolean).length,complete=cached===docs.length;
      if(status==='ready'&&!complete)status='partial';
      // The last successful batch may finish on the slice boundary. No missing scores remain.
      if(status==='timeout'&&complete)status='ready';
      const effectiveMinimum=typeof minScore==='number'&&Number.isFinite(minScore)?minScore:0.85;
      const admission=purpose==='search'&&descriptor.modelId===searchPolicy.modelId && Number.isFinite(descriptor.retrievalThresholds?.search)?assessAdmission(query,docs,scores,{complete,minScore:effectiveMinimum}):null;
      const scored={status,scores,modelFingerprint:model,minScore:admission?admission.features.minimumCosine:effectiveMinimum,coverage:{cached,total:docs.length,complete},...(admission?{admission}:{})};
      if(descriptor.modelId==='embeddinggemma-2-text-q4')sealScoreEvidence(scored,{query,scopeId,modelFingerprint:model,docs,identities,queryVector:q,vectors,encodedTexts,stillCurrent:()=>generation===cacheGeneration&&codecProof.snapshot(model)===requestCodecToken});
      return scored;
    }
    return Object.freeze({score,clear,forget});
  }
const SemanticWindowPolicy = (() => {
// Unregistered research policy. Raw coarse rank is global to one complete
// producer search, while every scalar verdict remains bound to its own field.
const crypto=require('node:crypto'),Windowing=typeof SemanticOriginalWindows==='undefined'?null:SemanticOriginalWindows;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONTRACT = Object.freeze({ id: 'embeddinggemma2-global-eligible-k1-cos070-window-v1',modelId:'embeddinggemma-2-text-q4',modelFingerprint:'sha256:9d41595d7508ff328b6c5a4223c7af26a91ed2fe53662cc9d633c1373eb4163e', topK: 1, threshold: .70, scoreKind:'cosine-not-probability', verifier:null,
  weakWindow: 'fixed-best-eligible-original96-overlap16-before-cosine-admission; no-result-driven-window-switch', metadataDisplay: 'same-field-complete-projected-context-not-raw-window-quote', coarseThreshold: null, strong: 'same-original-field-only', unknown: 'not-promoted-and-partial', pools:Object.freeze({session:'complete eligible committed-body pool plus same-field lexically related metadata including strong fields; no unrelated metadata discovery',memory:'complete bounded eligible memory-header fields',observation:'complete bounded registered-tool or authorized-projected-message fields'}),geometry:Object.freeze({message:'canonical-message-v3 original96/16',memory:'raw-original-v1 original96/16',metadata:'raw-metadata-v1 original96/16',committedMessage:'privacy-projected-v1 placeholder-safe96/16'}),metadataContext:'identity title/brief.title/cwd are labels; summary/gist need their own admitted field; recent request omitted without a field proof',automatic: null });

function createSemanticCoarsePolicy({ identify, normalize, terms, readScoreEvidence, explicitMemory = false, partialLexicalFields = false }) {
  if(typeof readScoreEvidence!=='function')throw TypeError('semantic.scorer_reader_required');
  const issuedDecisions = new WeakMap();
  if ([identify, normalize, terms].some(value => typeof value !== 'function')) throw TypeError('composite.host_invalid');
  async function evaluate({ query, rows, lexical, scoreEntries, poolComplete, context, windowContext, modelFingerprint, scopeId, signal, deadline, resolve, beforeVerify }) {
    if (!Array.isArray(rows) || !Array.isArray(lexical) || !Array.isArray(scoreEntries) || rows.length !== scoreEntries.length
      || typeof poolComplete !== 'boolean' || !Windowing.isRequest(windowContext,context) || modelFingerprint!==CONTRACT.modelFingerprint || rows.length > 4096 || rows.some(row=>typeof row.fieldKey!=='string'||typeof row.order!=='string') || typeof resolve !== 'function' || typeof beforeVerify !== 'function' || !Number.isFinite(deadline)) throw TypeError('composite.request_invalid');
    const accepted = rows.map(() => null), lexicalDecisions = new Map(), metadataDecisions = new Map(), lexicalWindowIndices = new Map(), metadataWindowIndices = new Map();
    if(typeof query!=='string'||!query.trim()||!normalize(query).trim()||typeof scopeId!=='string'||!scopeId)throw TypeError('semantic.policy_query_invalid');
    const abort=()=>{if(signal?.aborted)throw signal.reason===undefined?Object.assign(Error('semantic.policy_aborted'),{code:'ABORT_ERR'}):signal.reason;};
    let started=false;
    const verify=async event=>{abort();if(started)windowContext.assertPool(rows);await beforeVerify(event);abort();if(started)windowContext.assertPool(rows);};
    await verify({phase:'start',index:null,source:null});
    windowContext.begin(context,query,scopeId,modelFingerprint,rows);
    started=true;
    const evidenceReads=new Map(),scores=scoreEntries.map((entry,n)=>{if(entry===null)return null;if(!entry||!Number.isSafeInteger(entry.index)||entry.index<0)throw Error('semantic.score_evidence_invalid');let proof=evidenceReads.get(entry.result);if(!proof){proof=readScoreEvidence(entry.result,{query,scopeId,modelFingerprint});evidenceReads.set(entry.result,proof);}if(entry.index>=proof.scores.length)throw Error('semantic.score_evidence_invalid');windowContext.assertScore(rows[n],proof.docs[entry.index],proof.identities[entry.index],proof.encodedTexts[entry.index]);return proof.scores[entry.index];});
    const required = identify(query), phrase = normalize(query), effective = [...new Set(terms(query).filter(x => typeof x === 'string' && !x.startsWith('#')).map(normalize))];
    // When the query labels an uppercase code as a literal, its spelling is
    // part of the request. Ordinary paraphrases and unlabelled acronyms stay semantic.
    const literalCodes = [...query.normalize('NFKC').matchAll(/(?:标记|代号|编号|关键字|(?:关键|独有|唯一|检索|搜索)词|\b(?:literal|marker|identifier|keyword|token)(?=\s*:))(?:\s*:\s*|\s+)([A-Z][A-Z0-9_]{1,63})(?![\w:-])/g)].map(match => match[1].toLowerCase());
    function hasLiteralCodes(text) {
      if (!literalCodes.length) return true;
      const words = new Set(text.normalize('NFKC').toLowerCase().match(/[a-z0-9_]+(?:[-:][a-z0-9_]+)*/g));
      return literalCodes.every(code => words.has(code));
    }
    const strong = text => {
      if (!hasLiteralCodes(text)) return {eligible:false, reason:'literal-mismatch'};
      const sourceIds = identify(text);
      if (required.some(id => !sourceIds.includes(id))) return { eligible: false, reason: 'identifier-mismatch' };
      const normalized = normalize(text);
      return { eligible: true, reason: required.length ? 'all-identifiers-same-field' : normalized.includes(phrase) ? 'exact-phrase-same-field'
        : effective.length && effective.every(term => normalized.includes(term)) ? 'all-effective-terms-same-field' : null };
    };
    const fullSources = new Map(), fieldSources = new Map(), eligible = rows.map(() => true);
    let sourceUnknown = false;
    async function resolved(index, wholeField) {
      abort();
      if (Date.now() >= deadline) { sourceUnknown = true; return null; }
      const source = wholeField && fullSources.has(index) ? fullSources.get(index) : await resolve(index, wholeField);
      await verify({ phase: 'resolved', index, source });
      if(source)windowContext.assertSource(source,wholeField,context,rows[index]);
      if (wholeField && source) fullSources.set(index, source);
      return source;
    }
    // Body rows retain the producer's full-ID source filter. Metadata has a
    // separate field lifecycle, so prove all remaining field eligibility before
    // cutting global K. A rejected metadata ID may never consume the K slot.
    if (required.length || literalCodes.length) for (let index = 0; index < rows.length; index++) {
      let source = fieldSources.get(rows[index].fieldKey);
      if (!source) { source = await resolved(index, true); if (source) fieldSources.set(rows[index].fieldKey, source); }
      if (!source) { eligible[index] = null; sourceUnknown = true; }
      else { fullSources.set(index, source); eligible[index] = hasLiteralCodes(source.fieldText) && required.every(id => identify(source.fieldText).includes(id)); }
    }
    // A partially encoded or truncated eligible corpus cannot establish a
    // global winner. Deterministically excluded IDs need no vector or score.
    const globalComplete = poolComplete === true && !sourceUnknown && scores.every((score, index) => eligible[index] === false || Number.isFinite(score));
    for(let i=0;i<eligible.length;i++)if(eligible[i]===false)accepted[i]=false;
    if(globalComplete)accepted.fill(false);
    // A lexical hit names a particular field. Its best window is known once
    // every eligible window of that field has a score and the source pool is intact.
    const allowFieldRanking = partialLexicalFields && poolComplete && !sourceUnknown;
    const incompleteFields = new Set();
    if (!globalComplete && allowFieldRanking) {
      rows.forEach((row, index) => {
        if (eligible[index] && !Number.isFinite(scores[index])) incompleteFields.add(row.fieldKey);
      });
    }
    const order = globalComplete || allowFieldRanking ? scores.map((score, index) => ({ score, index })).filter(item => eligible[item.index] === true && !incompleteFields.has(rows[item.index].fieldKey))
      .sort((a, b) => b.score - a.score || rows[a.index].order.localeCompare(rows[b.index].order) || a.index - b.index) : [];
    const bestByField = new Map();
    for (const item of order) {
      const field = rows[item.index].fieldKey;
      if (!bestByField.has(field)) bestByField.set(field, item);
    }
    const selected = globalComplete ? order.slice(0, CONTRACT.topK).map(item => item.index) : [], work = new Map(), requiredWork = [], strongEvidence = [];
    async function evidence(index, wholeField, role, lexicalKey = null) {
      let source = await resolved(index, wholeField);
      if (!source) { sourceUnknown = true;if(role==='semantic')accepted[index]=null; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if(rows[index].metadata)metadataDecisions.set(rows[index].fieldKey,null); return; }
      const classification = strong(source.fieldText);
      if (!classification.eligible) { if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, false); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, false); return; }
      if (classification.reason) {
        // The frozen policy removes strong fields after choosing K. Keep their
        // lexical evidence, without adding semantic RRF weight or refilling K.
        if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, true);
        if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, true);
        strongEvidence.push({ index, role, fieldKey: rows[index].fieldKey, reason: classification.reason }); return;
      }
      if (role === 'weak-lexical' || role === 'metadata') {
        const choice = globalComplete || role === 'weak-lexical' ? bestByField.get(rows[index].fieldKey) : null;
        if (!choice) { sourceUnknown = true; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, null); return; }
        const previous = source; index = choice.index; source = await resolved(index, false);
        if (!source) { sourceUnknown = true; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, null); return; }
        if (['sourceId','field','revision','epoch','sourceRevision'].some(key => source.identity[key] !== previous.identity[key])) throw Error('composite.window_source_changed');
      }
      const key = hash([source.identity, source.text]);
      // The actual producer may run in a fixture VM. Copy its trusted data-only
      // identity into this realm; bridge validation still rejects non-data DTOs.
      if (!work.has(key)) work.set(key, { source: { identity: JSON.parse(JSON.stringify(source.identity)), text: source.text }, uses: [] });
      work.get(key).uses.push({ index, role, lexicalKey, metadataKey: rows[index].metadata ? rows[index].fieldKey : null });
    }
    // Select K before strong bypass. Never refill the K budget after bypass.
    for (const index of selected) await evidence(index, false, 'semantic');
    // Explicit memory lookup can answer with several distinct facts. A strong
    // top lexical match keeps the existing no-refill behavior.
    if (explicitMemory && selected.length && !strongEvidence.length && !sourceUnknown) {
      const seen = new Set([rows[selected[0]].fieldKey]);
      for (const item of order.slice(1)) {
        if (seen.size >= 3 || item.score < CONTRACT.threshold) break;
        const key = rows[item.index].fieldKey;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(item.index);
        await evidence(item.index, false, 'semantic');
      }
    }
    for (const item of lexical) {
      if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= rows.length) { lexicalDecisions.set(item.key, null); sourceUnknown = true; continue; }
      windowContext.assertWeak(item.key,rows[item.index]);
      if (!lexicalDecisions.has(item.key)) await evidence(item.index, true, 'weak-lexical', item.key);
    }
    // Metadata supplement is a distinct same-field consumer, never a session
    // exemption. All supplied metadata fields need an explicit verdict.
    const seenMetadata = new Set();
    for (let index = 0; index < rows.length; index++) if (rows[index].metadata && !seenMetadata.has(rows[index].fieldKey)) {
      seenMetadata.add(rows[index].fieldKey); await evidence(index, true, 'metadata');
    }
    const items = [...work.values()];
    for (const item of items) for (const use of item.uses) requiredWork.push({ index: use.index, role: use.role, identity: item.source.identity });
    // Each exact admitted window consumes its own already-computed cosine.
    // No extra inference and no independent window search after a rejection.
    const results=items.map(item=>{const values=item.uses.map(use=>scores[use.index]);
      if(values.some(value=>!Number.isFinite(value)))return {accepted:null,score:null,cached:false};
      if(values.some(value=>value < -1.00001||value > 1.00001||Math.abs(value-values[0])>1e-12))throw Error('bge.window_score_mismatch');
      return {accepted:values[0]>=CONTRACT.threshold,score:values[0],cached:false};});
    const verified={status:results.every(result=>result.accepted!==null)?'complete':'partial',results,
      coverage:{complete:results.every(result=>result.accepted!==null),total:items.length,completed:results.filter(result=>result.accepted!==null).length}};
    if (!Array.isArray(verified.results) || verified.results.length !== items.length) throw Error('composite.verifier_shape');
    for (let n = 0; n < items.length; n++) {
      const result = verified.results[n];
      if (![true, false, null].includes(result.accepted)) throw Error('composite.verdict_invalid');
      // The host's accepted value must implement this precise frozen policy.
      if (result.accepted !== null && (typeof result.score !== 'number' || !Number.isFinite(result.score) || result.accepted !== (result.score >= CONTRACT.threshold))) throw Error('composite.policy_mismatch');
      for (const use of items[n].uses) {
        if (use.role === 'semantic') accepted[use.index] = result.accepted;
        if (use.lexicalKey !== null) { lexicalDecisions.set(use.lexicalKey, result.accepted); if (result.accepted === true) lexicalWindowIndices.set(use.lexicalKey, use.index); }
        if (use.metadataKey !== null) { metadataDecisions.set(use.metadataKey, result.accepted); if (result.accepted === true) metadataWindowIndices.set(use.metadataKey, use.index); }
      }
    }
    await verify({ phase: 'finish', index: null, source: null });
    const finished = globalComplete && !sourceUnknown && verified.coverage?.complete === true && Date.now() < deadline;
    const policyId=explicitMemory?'embeddinggemma2-memory-distinct-k3-cos070-v1':CONTRACT.id;
    const decision=Object.freeze({policyId:literalCodes.length?policyId+'-literal-v1':policyId,purpose:'search-relevance',answerability:'not-assessed',complete:finished,status:finished?'evaluated':'partial',
      counts:Object.freeze({candidates:rows.length,eligible:eligible.filter(x=>x===true).length,excludedIdentifiers:eligible.filter(x=>x===false).length,selected:selected.length,weakWindows:lexicalWindowIndices.size,metadataWindows:metadataWindowIndices.size})});
    issuedDecisions.set(decision,{context,validatePool:()=>{windowContext.assertPool(rows);for(const result of evidenceReads.keys())readScoreEvidence(result,{query,scopeId,modelFingerprint});},semanticAccepted:accepted.slice(),weakAccepted:new Map(lexicalDecisions),metadataAccepted:new Map(metadataDecisions),
      weakWindowIndices:new Map(lexicalWindowIndices),metadataWindowIndices:new Map(metadataWindowIndices),globalSelectedIndices:selected.slice(),globalCoarseComplete:globalComplete});
    return decision;
  }
  const lookup=(decision,context)=>{const stored=issuedDecisions.get(decision);if(!stored||stored.context!==context)throw Error('semantic.policy_context_invalid');stored.validatePool();return stored;};
  return Object.freeze({ evaluate,contract:CONTRACT,dispose:(decision,context)=>{const stored=issuedDecisions.get(decision);if(!stored||stored.context!==context)throw Error('semantic.policy_context_invalid');issuedDecisions.delete(decision);},decisions:(decision,context)=>{const stored=lookup(decision,context);return {semanticAccepted:stored.semanticAccepted.slice(),weakAccepted:new Map(stored.weakAccepted),metadataAccepted:new Map(stored.metadataAccepted),weakWindowIndices:new Map(stored.weakWindowIndices),metadataWindowIndices:new Map(stored.metadataWindowIndices),globalSelectedIndices:stored.globalSelectedIndices.slice(),globalCoarseComplete:stored.globalCoarseComplete};} });
}
return {CONTRACT,createSemanticCoarsePolicy:options=>createSemanticCoarsePolicy({...options,readScoreEvidence})};

})();
const SemanticAdmissionRequest = (() => {
// Trusted in-process adapter for consumers. Fields are original authorized text,
// never projected DTO slices. Authority remains in verifyField/beforeVerify.
const W=typeof SemanticOriginalWindows==='undefined'?null:SemanticOriginalWindows,{createSemanticCoarsePolicy,CONTRACT}=SemanticWindowPolicy;
function create({query,scopeId,identify,normalize,terms,readScoreEvidence,explicitMemory=false,modelFingerprint=CONTRACT.modelFingerprint,maxRows=4096}){
 if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096)throw Error('semantic.request_limit_invalid');
 const windowContext=W.createRequest({query,scopeId,modelFingerprint}),context=windowContext.context,policy=createSemanticCoarsePolicy({identify,normalize,terms,readScoreEvidence,explicitMemory}),fields=new Map(),rowFields=[],rows=[],sources=[],docs=[],identities=[];let disposed=false,decision=null,truncated=false;
 const active=()=>{if(disposed)throw Error('semantic.request_disposed');};
 function addField(source,{kind='raw-original-v1',order,identityForWindow}={}){active();if(decision)throw Error('semantic.request_already_evaluated');if(!source||typeof source.text!=='string'||!Array.isArray(order))throw Error('semantic.field_invalid');const snapshot={identity:{...source.identity},text:source.text},token=windowContext.captureField(snapshot.identity,snapshot.text,kind),key=windowContext.weakKey(token),entry={token,key,snapshot,indices:[]};fields.set(key,entry);
  const push=(window,cacheText)=>{if(rows.length>=Math.min(4096,maxRows)){truncated=true;return false;}const identity=identityForWindow?identityForWindow(window.identity):['original-field',...['sourceId','field','revision','epoch','sourceRevision','start','end'].map(k=>window.identity[k])],row=windowContext.row(window,order,identity);entry.indices.push(rows.length);rows.push(row);sources.push(window);rowFields.push(entry);docs.push(cacheText);identities.push(identity);return true;};
  if(kind==='canonical-message-v3'){outer:for(const shard of windowContext.canonicalSlices(token))for(const part of W.rawSlices(shard.text)){if(!push(windowContext.canonicalWindow(token,shard,part.start,part.end-part.start),part.text))break outer;}}
  else for(const part of windowContext.rawSlices(token))if(!push(windowContext.rawWindow(token,part.start,part.end),part.text))break;
  return key;
 }
 async function evaluate(scored,{poolComplete,lexicalFields=[],deadline,signal,verifyField,beforeVerify}={}){active();if(decision)throw Error('semantic.request_already_evaluated');if(typeof verifyField!=='function'||typeof beforeVerify!=='function')throw Error('semantic.authority_missing');const lexical=[];for(const key of lexicalFields){const field=fields.get(key);if(!field)throw Error('semantic.weak_field_invalid');if(field.indices.length)lexical.push({key,index:field.indices[0]});else truncated=true;}
  decision=await policy.evaluate({query,scopeId,modelFingerprint,windowContext,context,rows,lexical,scoreEntries:rows.map((_,index)=>scored?{result:scored,index}:null),poolComplete:poolComplete===true&&!truncated,signal,deadline,
   resolve:async(index,whole)=>{const field=rowFields[index],current=await verifyField(field.snapshot,whole?'whole':'window');if(current===null)return null;if(!current||current.text!==field.snapshot.text||['sourceId','field','revision','epoch','sourceRevision'].some(k=>current.identity?.[k]!==field.snapshot.identity[k]))throw Error('semantic.source_changed');return whole?windowContext.wholeSource(field.token):sources[index];},beforeVerify});
  return decision;
 }
 function read(){active();if(!decision)throw Error('semantic.request_not_evaluated');const d=policy.decisions(decision,context),weakAccepted=new Map(),weakWindowIndices=new Map(),metadataAccepted=new Map(),metadataWindowIndices=new Map();for(const [key,f]of fields){if(d.weakAccepted.has(key))weakAccepted.set(key,d.weakAccepted.get(key));if(d.weakWindowIndices.has(key))weakWindowIndices.set(key,d.weakWindowIndices.get(key));const fieldKey=windowContext.fieldKey(f.token);if(d.metadataAccepted.has(fieldKey))metadataAccepted.set(key,d.metadataAccepted.get(fieldKey));if(d.metadataWindowIndices.has(fieldKey))metadataWindowIndices.set(key,d.metadataWindowIndices.get(fieldKey));}return {...d,weakAccepted,weakWindowIndices,metadataAccepted,metadataWindowIndices};}
 return Object.freeze({addField,evaluate,read,inputs:()=>{active();return {policyContext:windowContext,docs:docs.slice(),identities:identities.map(v=>Array.isArray(v)?v.slice():v),rowCount:rows.length,truncated};},window:index=>{active();if(!Number.isSafeInteger(index)||!sources[index])throw Error('semantic.window_invalid');const s=sources[index];return {identity:{...s.identity},text:s.text};},fieldAt:index=>{active();return rowFields[index]?.key??null;},dispose:()=>{if(disposed)return;if(decision)policy.dispose(decision,context);disposed=true;fields.clear();for(const list of [rows,sources,rowFields,docs,identities])list.length=0;decision=null;}});
}
return {create,CONTRACT};

})();


  return Object.freeze({create,assessAdmission,searchPolicy,structuredIds,structuredIdMatches,readScoreEvidence,windowPolicy:SemanticWindowPolicy,admissionRequest:SemanticAdmissionRequest,hasScoreEvidence:result=>scoreEvidenceRecords.has(result)});
})(require('node:crypto'));

// Compatibility aliases share the scorer's closed reader; no caller-supplied issuer.
const SemanticWindowPolicy=SemanticRetrieval.windowPolicy;
const SemanticAdmissionRequest=SemanticRetrieval.admissionRequest;
// Registration is data only; readiness is evaluated exclusively by the host.
const SemanticPolicyConsumers=new Set();
