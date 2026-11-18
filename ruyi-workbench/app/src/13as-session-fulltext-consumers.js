// Real search destinations own admission. Neither JSON/model arguments nor an
// index scope label can issue this private, per-call disclosure capability.
const SessionFullTextConsumers = ((c, AsyncLocalStorage) => {
  const fail=suffix=>Object.assign(Error('session_search.'+suffix),{code:'session_search.'+suffix,apiCode:'session_search.'+suffix,statusCode:409});
  const hash=value=>c.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const clone=value=>structuredClone(value);
  function create(host) {
    const local=new AsyncLocalStorage(),issued=new WeakMap(),threadPreviews=new Map();
    const required=['readConfig','configGeneration','uiAuthority','modelAuthority','source','catalog','metadata','projectKey','terms','redact','bindIndex'];
    if(required.some(name=>typeof host?.[name]!=='function')||!host.privacy)throw fail('host_invalid');
    const source=host.source(),privacy=host.privacy;
    if(['epoch','scan','sequence','inspect'].some(name=>typeof source[name]!=='function'))throw fail('source_unavailable');
    const selectedMethod=config=>config.semanticRetrievalV1!==false&&typeof SemanticRuntimeTransportProof!=='undefined'&&typeof SemanticRuntimeTransportProof.method==='function'?SemanticRuntimeTransportProof.method():null;
    function current(token=local.getStore()) {const cap=issued.get(token);if(!cap||cap.closed)throw fail('scope_required');cap.assert();return cap;}
    function projectFilter(value) {if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||!/^project:[a-f0-9]{16}$/.test(value))throw fail('project_invalid');return value;}
    async function enter(kind,authority,filter,work,exactSid=null,threadSearch=false) {
      const startedAt=Date.now(),selectedFilter=projectFilter(filter),policy=privacy.disclosurePolicyGuard(),generation=host.configGeneration(),config=await host.readConfig();policy();
      if(host.configGeneration()!==generation)throw fail('destination_changed');const grant=await authority(config);policy();
      if(!grant||typeof grant.assert!=='function'||typeof grant.revalidate!=='function'||typeof grant.scopeId!=='string')throw fail('destination_invalid');
      if(exactSid&&grant.scopeId!==exactSid)throw fail('destination_changed');
      const token=Object.freeze({}),cap={kind,config,generation,grant,startedAt,method:selectedMethod(config),semanticEpoch:selectedMethod(config)?SemanticRuntimeTransportProof.lifecycle():null,relatedMetadata:null,filter:selectedFilter,exactSid,sources:new Map(),disclosed:new Set(),disclosures:[],attachmentChecks:[],indexState:null,closed:false,emitted:false};
      cap.threadSearch=threadSearch;cap.preparedSessions=0;
      cap.access=Object.freeze({scopeId:grant.scopeId,revision:hash([c.randomBytes(24).toString('hex'),generation,cap.filter])});
      cap.assert=()=>{if(cap.closed||local.getStore()!==token||host.configGeneration()!==generation||cap.method!==selectedMethod(config)||cap.method&&cap.semanticEpoch!==SemanticRuntimeTransportProof.lifecycle())throw fail('destination_changed');policy();grant.assert();for(const [sid,row]of cap.sources)if(source.sequence(sid)!==row.sequence)throw fail('source_changed');};
      issued.set(token,cap);
      return local.run(token,async()=>{try{cap.assert();const value=await(kind==='model'||kind==='observation'?privacy.withPolicy(grant.scopeId,work):work());if(!cap.emitted){await final(cap);assertIndexState(cap);}return value;}finally{cap.closed=true;cap.sources.clear();cap.disclosed.clear();cap.disclosures.length=0;cap.attachmentChecks.length=0;grant.close?.();}});
    }
    async function authorize(sid,token,access) {
      const cap=current(token);if(access.revision!==cap.access.revision||access.scopeId!==cap.access.scopeId)throw fail('scope_changed');
      if(cap.exactSid&&sid!==cap.exactSid)return false;
      await cap.grant.revalidate();cap.assert();const selected=await source.inspect(sid);cap.assert();
      if(!selected||selected.head.kind==='steward'||selected.head.rawKind==='steward')return false;
      const metadata=host.metadata(selected.head),project=host.projectKey(metadata.cwd);
      if(cap.filter&&project!==cap.filter)return false;
      const prior=cap.sources.get(sid);if(prior&&(prior.epoch!==selected.epoch||prior.sequence!==selected.sequence))throw fail('source_changed');
      cap.sources.set(sid,{...selected,metadata});return true;
    }
    function assertAuthorized(sid,token,access) {const cap=current(token),row=cap.sources.get(sid);return (!cap.exactSid||sid===cap.exactSid)&&access.revision===cap.access.revision&&!!row&&(!cap.filter||host.projectKey(row.metadata.cwd)===cap.filter)&&source.sequence(sid)===row.sequence;}
    function authorizedEpoch(sid,token,access) {if(!assertAuthorized(sid,token,access))return null;return current(token).sources.get(sid).epoch;}
    function authorizedEmpty(sid,token,access) {return assertAuthorized(sid,token,access)&&current(token).sources.get(sid).head.messageCount===0;}
    async function final(cap,completeAttachmentCheck=true) {
      cap.assert();await cap.grant.revalidate();cap.assert();
      const sources=[...cap.sources];for(let start=0;start<sources.length;start+=4){const batch=await Promise.allSettled(sources.slice(start,start+4).map(async([sid,row])=>{if(await source.epoch(sid)!==row.epoch)throw fail('source_changed');cap.assert();}));const failed=batch.find(row=>row.status==='rejected');if(failed)throw failed.reason;}
      for(const check of cap.attachmentChecks)if(!await check(completeAttachmentCheck))throw fail('source_changed');
      cap.assert();for(const guard of cap.disclosures)guard();
    }
    const strings=(value,fn)=>typeof value==='string'?fn(value):Array.isArray(value)?value.map(row=>strings(row,fn)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,row])=>[key,strings(row,fn)])):value;
    async function localDisplay(sid,value) {
      if(typeof value==='string')return privacy.displayText(sid,value);
      if(Array.isArray(value)){const out=[];for(const row of value)out.push(await localDisplay(sid,row));return out;}
      if(value&&typeof value==='object'){const out={};for(const [key,row]of Object.entries(value))out[key]=await localDisplay(sid,row);return out;}
      return value;
    }
    async function disclose(cap,sid,value,purpose) {
      cap.disclosed.add(sid);
      const binding={recipient:cap.grant.scopeId,purpose,sourceHash:hash(value)};
      if(cap.kind==='ui'){
        const prepared=await privacy.prepareLocalDisclosure(sid,()=>localDisplay(sid,value));cap.assert();cap.disclosures.push(prepared.assert);
        return prepared.value;
      }
      const prepared=await privacy.prepareMultiSourceDisclosure(privacy.foreignView(value),[sid,cap.grant.scopeId],binding);cap.assert();cap.disclosures.push(prepared.assert);return prepared.value;
    }
    function relatedMetadata(cap,sid,value){if(!cap.relatedMetadata)return value;const approved=cap.relatedMetadata.get(sid)||new Set(),out={...value,summary:approved.has('summary')?value.summary||'':''};if(out.brief)out.brief={...out.brief,gist:approved.has('brief.gist')?out.brief.gist||'':''};delete out.recentUserRequest;return out;}
    async function publicMetadata(sid) {
      const token=local.getStore(),cap=current(token);if(!await authorize(sid,token,cap.access))throw fail('source_denied');
      const row=cap.sources.get(sid),raw=cap.kind==='ui'?row.metadata:privacy.foreignView(row.metadata);
      // The routing identifier is never reattached after projection. A protected
      // identifier that cannot be used by the old destination contract refuses.
      if(raw.id!==sid)throw fail('identifier_sensitive');
      const value=strings(await disclose(cap,sid,raw,'session-search:metadata'),host.redact);cap.assert();if(value.id!==sid)throw fail('identifier_projection');return relatedMetadata(cap,sid,value);
    }
    async function projection(input) {
      const token=local.getStore(),cap=current(token),sid=input.reference.sessionId;
      if(typeof input.sourceText!=='string')throw fail('source_denied');
      const metadata=await publicMetadata(sid),reference=clone(input.reference);delete reference.text;delete reference.contentRevision;delete reference.sourceRevision;delete reference.windowHash;delete reference.epoch;delete reference.revision;delete reference.identity;
      if(input.revalidate)cap.attachmentChecks.push(input.revalidate);
      let view;
      const prepared=await privacy.withPolicy(sid,async()=>{
        view=await privacy.projectSource(input.sourceText,true);
        let snippet;
        if(view){const sliced=privacy.sliceSource(view,reference.snippetStart,reference.snippetEnd);reference.snippetStart=sliced.start;reference.snippetEnd=sliced.end;snippet=sliced.text;}
        else{
          // OFF still keeps the existing unconditional credential filter. Filter
          // the complete source first; a clipped key fragment is never scanned
          // as if it were the full credential. Projected excerpt coordinates
          // are explicitly distinct from the unchanged original match tuple.
          const redacted=host.redact(input.sourceText);
          if(redacted===input.sourceText)snippet=redacted.slice(reference.snippetStart,reference.snippetEnd);
          else{const at=redacted.toLowerCase().indexOf(cap.query.toLowerCase());snippet=at<0?'«redacted»':redacted.slice(Math.max(0,at-60),Math.min(redacted.length,at+cap.query.length+120));delete reference.snippetStart;delete reference.snippetEnd;reference.snippetCoordinate='credential-redacted-text';}
        }
        const raw={reference:{...reference,session:metadata},snippet},binding={recipient:cap.grant.scopeId,purpose:'session-search:source',sourceHash:hash([reference,input.sourceText])};
        const value=await privacy.prepareDisclosure(raw,binding);privacy.assertDisclosure(value.receipt,binding);return value.value;
      });
      cap.assert();const disclosed=await disclose(cap,sid,prepared,'session-search:hit');cap.assert();
      disclosed.snippet=host.redact(disclosed.snippet);return disclosed;
    }
    const index=host.bindIndex({scope:async token=>current(token).access,authorize,assertAuthorized,authorizedEpoch,authorizedEmpty,project:projection,restrictedCatalog:()=>{const cap=issued.get(local.getStore());return cap&&!cap.closed&&cap.exactSid?[cap.exactSid]:null;},
      assertScope:(token,access)=>{const cap=current(token);return cap.access.revision===access.revision&&cap.access.scopeId===access.scopeId;}});
    function assertIndexState(cap){if(!cap.indexState)return;const current=index.mutationState();if(cap.indexState.active||current.active||current.serial!==cap.indexState.serial)throw fail('index_changed');}
    async function metadata(check=()=>{},timeout=null) {const token=local.getStore(),cap=current(token),out=[];check();if(cap.threadSearch&&cap.metadataView)return clone(cap.metadataView);const ids=cap.exactSid?[cap.exactSid]:cap.searchCatalog??await host.catalog();
      for(let start=0;start<ids.length;start+=4){check();const batch=await Promise.allSettled(ids.slice(start,start+4).map(async sid=>{check();return (cap.threadSearch&&assertAuthorized(sid,token,cap.access)||await authorize(sid,token,cap.access))?clone(cap.sources.get(sid).metadata):null;}));
        const failures=batch.filter(row=>row.status==='rejected');if(failures.length)throw (failures.find(row=>row.reason!==timeout&&row.reason?.code!=='privacy.disclosure_dirty')||failures.find(row=>row.reason!==timeout)||failures[0]).reason;
        for(const row of batch)if(row.value)out.push(row.value);}
      cap.assert();check();if(cap.threadSearch)cap.metadataView=clone(out);return out;}
    async function searchOnce(query,limit,check,deadline,timeout,preview) {
      const token=local.getStore(),cap=current(token),q=String(query||'').trim();cap.query=q;cap.relatedMetadata=null;
      if(q.length>256)throw fail('query_invalid');
      if(q.length<2)return{ok:true,query:q,results:[],indexed:0,scope:scope(cap.config.sessionSearchIndexV1!==false),reason:'query_too_short'};
      check();const enabled=cap.config.sessionSearchIndexV1!==false,paused=cap.config.sessionSearchIndexPausedV1===true;
      const resumable=typeof index.resetPreparation==='function',early=enabled&&cap.threadSearch&&resumable;
      const preparationKey=cap.threadSearch?JSON.stringify([cap.kind,cap.access.scopeId,cap.filter]):cap.access.scopeId;
      const prepare=()=>index.prepare(token,{check,timeout,incremental:true,threadSearch:cap.threadSearch,preparationKey,onPrepared:()=>{cap.preparedSessions++;}});
      const lexicalPreview=preview&&cap.threadSearch;
      let progress=null;if(early&&!paused&&!lexicalPreview)progress=index.preparationComplete?.(preparationKey)?{done:true}:await prepare();
      const metas=await metadata(check,timeout),terms=[...new Set(host.terms(q).filter(term=>!term.startsWith('#')))];
      const fieldsOf=meta=>[['title',meta.title],['summary',meta.summary],['brief.title',meta.brief?.title],['brief.gist',meta.brief?.gist],['cwd',meta.cwd]].filter(([,text])=>typeof text==='string'&&text.length);
      const metadataEntries=[],metadataIds=typeof SemanticRetrieval!=='undefined'?SemanticRetrieval.structuredIds(q):[],metadataPhrase=q.normalize('NFKC').toLowerCase();let metadataEntryTruncated=false;
      for(const meta of metas){check();const fields=fieldsOf(meta);if(!cap.method&&fields.some(([,text])=>{const norm=text.normalize('NFKC').toLowerCase();return norm.includes(metadataPhrase)||terms.length>0&&terms.every(term=>norm.includes(term));}))continue;for(const [field,text]of fields){const norm=text.normalize('NFKC').toLowerCase(),ids=cap.method?SemanticRetrieval.structuredIds(text):[];if(cap.method&&metadataIds.some(id=>!ids.includes(id)))continue;const eligible=cap.method?(metadataIds.length>0||norm.includes(metadataPhrase)||terms.some(term=>norm.includes(term))):terms.some(term=>norm.includes(term));if(!eligible)continue;const selected=cap.sources.get(meta.id);if(!selected)throw fail('source_changed');if(metadataEntries.length<256)metadataEntries.push({sid:meta.id,field,text,epoch:selected.epoch,sequence:selected.sequence});else metadataEntryTruncated=true;}}

      const verifyMetadata=async item=>{check();if(await authorize(item.sid,token,cap.access)!==true)throw fail('source_denied');check();const selected=cap.sources.get(item.sid),field=fieldsOf(selected.metadata).find(([name])=>name===item.field);if(selected.epoch!==item.epoch||selected.sequence!==item.sequence||field?.[1]!==item.text||await source.epoch(item.sid)!==item.epoch)throw fail('source_changed');check();return true;};
      let found={results:[],coverage:{phase:'disabled',sessions:metas.length,indexedSessions:0,pendingSessions:metas.length,complete:false,attachments:{unverifiedFullText:0},fullTextSampling:false}};
      let proofResult=null;
      if(enabled){
        cap.assert();
        const incremental=early||!cap.exactSid&&metas.length>64&&resumable;if(!early&&incremental&&!paused&&!lexicalPreview)progress=await prepare();
        found=await index.search(q,token,limit,{check,deadline,timeout,metadataEntries,metadataEntriesTruncated:metadataEntryTruncated,method:cap.method,verifyMetadata,lexicalOnly:lexicalPreview});
        if(!lexicalPreview&&!paused&&found.coverage.pendingSessions&&found.coverage.phase!=='paused'){
          if(!incremental){await index.prepare(token,{check,timeout,...(cap.exactSid?{single:true}:{})});check();found=await index.search(q,token,limit,{check,deadline,timeout,metadataEntries,metadataEntriesTruncated:metadataEntryTruncated,method:cap.method,verifyMetadata});}
          else if(progress?.done){index.resetPreparation(preparationKey);if(!cap.threadSearch||metas.length<=16){await prepare();check();found=await index.search(q,token,limit,{check,deadline,timeout,metadataEntries,metadataEntriesTruncated:metadataEntryTruncated,method:cap.method,verifyMetadata});}}
        }
        proofResult=found;if(paused)found={...found,coverage:{...found.coverage,phase:'paused'}};
      }
      const windowPolicy=!!cap.method,identifyPolicy=typeof SemanticRetrieval!=='undefined'?SemanticRetrieval.structuredIds:()=>[],requiredPolicyIds=identifyPolicy(q);if(windowPolicy){cap.relatedMetadata=new Map();for(const meta of metas){const approved=new Set(fieldsOf(meta).filter(([field,value])=>{const ids=identifyPolicy(value),norm=value.normalize('NFKC').toLowerCase();return !requiredPolicyIds.some(id=>!ids.includes(id))&&(requiredPolicyIds.length>0||norm.includes(metadataPhrase)||(terms.length>0&&terms.every(term=>norm.includes(term)))||index.metadataAdmission(proofResult,meta.id,field,token)===true);}).map(([field])=>field));cap.relatedMetadata.set(meta.id,approved);}}const results=new Map();let lexicalPartial=!!found.lexicalAdmission?.partial||metadataEntryTruncated;
      for(const hit of found.results){const meta=relatedMetadata(cap,hit.reference.session?.id,hit.reference.session);if(!meta||typeof meta.id!=='string')throw fail('projection_invalid');if(!results.has(meta.id))results.set(meta.id,{...meta,...(meta.brief?{briefTitle:meta.brief.title,briefGist:meta.brief.gist}:{}),snippet:hit.snippet,reference:windowPolicy?{...hit.reference,session:meta}:hit.reference,score:hit.score,rankScore:hit.rankScore,...(hit.semanticScore===undefined?{}:{semanticScore:hit.semanticScore})});}
      const ceiling=Math.min(50,Math.max(1,Math.floor(Number(limit)||20)));
      const identify=typeof SemanticRetrieval!=='undefined'&&typeof SemanticRetrieval.structuredIds==='function'?SemanticRetrieval.structuredIds:()=>[],requiredIds=identify(q);
      for(const meta of metas.slice().sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))){check();const fields=[meta.title,meta.summary,meta.brief?.title,meta.brief?.gist,meta.cwd].filter(Boolean),text=fields.join('\n'),hay=text.normalize('NFKC').toLowerCase(),phrase=q.normalize('NFKC').toLowerCase(),entityField=requiredIds.length&&fields.some(field=>{const ids=identify(field);return requiredIds.every(id=>ids.includes(id));});if(requiredIds.length?!entityField:!hay.includes(phrase)&&terms.filter(term=>hay.includes(term)).length<Math.max(1,Math.ceil(terms.length/2)))continue;
        const exact=fields.some(field=>field.normalize('NFKC').toLowerCase().includes(phrase)),strong=!!entityField||exact||terms.length>0&&fields.some(field=>{const normalized=field.normalize('NFKC').toLowerCase();return terms.every(term=>normalized.includes(term));});if(!strong){const matching=fieldsOf(meta).filter(([,value])=>{const norm=value.normalize('NFKC').toLowerCase();return terms.some(term=>norm.includes(term));}),decisions=matching.map(([field])=>typeof index.metadataAdmission==='function'?index.metadataAdmission(proofResult,meta.id,field,token):null);if(decisions.length&&decisions.every(value=>value===false))continue;if(!decisions.some(value=>value===true)){lexicalPartial=true;if(windowPolicy)continue;}}const rankScore=found.ranking==='rrf-v1'?(exact?1+1/61:1/61):1;
        if(!results.has(meta.id)){const safe=await publicMetadata(meta.id),safeFields=[safe.title,safe.summary,safe.brief?.title,safe.brief?.gist,safe.cwd].filter(Boolean);let excerpt=requiredIds.length?safeFields.find(field=>{const ids=identify(field);return requiredIds.every(id=>ids.includes(id));}):safe.summary||safe.title||'';if(windowPolicy){const approved=fieldsOf(meta).filter(([field,value])=>{const ids=identify(value),normalized=value.normalize('NFKC').toLowerCase();if(requiredIds.some(id=>!ids.includes(id)))return false;return requiredIds.length>0||normalized.includes(phrase)||(terms.length>0&&terms.every(term=>normalized.includes(term)))||index.metadataAdmission(proofResult,meta.id,field,token)===true;}).map(([field])=>field);const selected=approved.map(field=>fieldsOf(safe).find(([name])=>name===field)).find(Boolean);if(!selected){lexicalPartial=true;continue;}excerpt=selected[1];}if(requiredIds.length&&!excerpt)continue;results.set(meta.id,{...safe,...(safe.brief?{briefTitle:safe.brief.title,briefGist:safe.brief.gist}:{}),snippet:host.redact(excerpt),score:1,rankScore,...(requiredIds.length?{matchKind:'lexical-entity'}:{}),reference:null,...(windowPolicy?{matchKind:'metadata-context'}:{})});}
        else if(exact&&found.ranking==='rrf-v1'){const prior=results.get(meta.id);prior.rankScore=Math.max(prior.rankScore??0,rankScore);}}
      let verified=null,indexState=null;if(enabled&&typeof index.revalidate==='function'){if(typeof index.mutationState==='function')indexState=index.mutationState();verified=await index.revalidate(proofResult,token,{check,timeout});check();}
      await final(cap,false);check();
      if(indexState){const current=index.mutationState();if(indexState.active||current.active||current.serial!==indexState.serial)verified={...verified,changed:Math.max(1,verified.changed||0)};}
      if(verified?.changed){const coverage={...found.coverage,phase:'pending',pendingSessions:Math.max(found.coverage.pendingSessions||0,verified.changed),complete:false};return{ok:true,query:q,results:[],indexed:Math.max(0,(found.coverage.indexedSessions||0)-verified.changed),coverage,partial:true,reason:'index_changed',...(found.semantic?{semantic:{...found.semantic,coverage:'partial'}}:{}),scope:{...scope(enabled),fullText:false}};}
      if(indexState&&!cap.indexState)cap.indexState=indexState;
      return{ok:true,query:q,results:[...results.values()].sort((a,b)=>(b.rankScore??b.score)-(a.rankScore??a.score)||String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))).slice(0,ceiling),indexed:found.coverage.indexedSessions,coverage:found.coverage,lexicalAdmission:{partial:lexicalPartial,truncated:!!found.lexicalAdmission?.truncated},...(lexicalPreview?{lexicalPreview:true,partial:!found.coverage.complete}:{}),...(found.entity?{entity:found.entity}:{}),...(found.semantic?{semantic:found.semantic}:{}),scope:{...scope(enabled),fullText:enabled&&found.coverage.complete}};
    }
    async function search(query,limit,options={}){const cap=current(),timeout=Object.freeze(Object.assign(Error('session_search.deadline'),{code:'session_search.deadline'})),budget=Math.max(1,Math.min(30000,Number(host.searchBudgetMs)||(cap.threadSearch?15000:2500))),deadline=cap.startedAt+budget;
      const check=()=>{cap.assert();if(Date.now()>=deadline)throw timeout;};
      let preview=options.preview===true;
      if(options.previewIfLarge===true&&cap.threadSearch&&cap.kind==='model'&&cap.config.sessionSearchIndexV1!==false){
        const key=hash([cap.access.scopeId,cap.filter,query]);
        if(!threadPreviews.has(key)&&!index.preparationComplete?.(JSON.stringify([cap.kind,cap.access.scopeId,cap.filter]))){
          cap.searchCatalog=await host.catalog();cap.assert();
          if(cap.searchCatalog.length>=64){
            preview=true;threadPreviews.set(key,true);
            if(threadPreviews.size>64)threadPreviews.delete(threadPreviews.keys().next().value);
          }
        }
      }
      for(let pass=0;pass<4;pass++){try{return await searchOnce(query,limit,check,deadline,timeout,preview);}catch(error){if(error===timeout){await final(cap);const enabled=cap.config.sessionSearchIndexV1!==false;return{ok:true,query:String(query||'').trim(),results:[],indexed:cap.threadSearch?null:0,partial:true,reason:'deadline',coverage:{phase:'timeout',sessions:cap.threadSearch?null:cap.sources.size,indexedSessions:cap.threadSearch?null:0,pendingSessions:cap.threadSearch?null:cap.sources.size,complete:false,attachments:{unverifiedFullText:cap.threadSearch?null:0},fullTextSampling:false,...(cap.threadSearch?{preparedThisRequest:cap.preparedSessions}:{})},semantic:{status:'timeout',coverage:'partial'},scope:scope(enabled)};}if(error?.code!=='privacy.disclosure_dirty'||pass===3)throw error;cap.disclosures.length=0;cap.attachmentChecks.length=0;await final(cap);check();}}}
    function scope(enabled=true) {return{fullText:false,messageText:enabled,mode:enabled?'message_shards':'metadata_only',sampling:false,coordinate:'utf16',maxQueryChars:256,
      coverageUnit:'committed-display-message-sources',note:enabled?'搜索已提交的消息和可验证的附件正文。附件提取范围见 coverage。':'正文搜索已关闭，仅搜索会话元数据。'};}
    async function finish(value) {const cap=current();for(let pass=0;pass<4;pass++){try{const prepared=await privacy.prepareMultiSourceDisclosure(privacy.foreignView(value),[...cap.disclosed,cap.grant.scopeId],{recipient:cap.grant.scopeId,purpose:'session-search:result',sourceHash:hash(value)});cap.disclosures.push(prepared.assert);await final(cap);return prepared.value;}catch(error){if(error.code!=='privacy.disclosure_dirty'||pass===3)throw error;cap.disclosures.length=0;await final(cap);}}}
    async function emitUI(value,emit) {
      const cap=current();
      if(cap.kind!=='ui'||typeof emit!=='function')throw fail('destination_invalid');
      if(cap.attachmentChecks.length)await final(cap);
      cap.assert();for(const guard of cap.disclosures)guard();
      assertIndexState(cap);
      cap.emitted=true;const result=emit(value);
      if(result&&typeof result.then==='function')throw fail('sink_invalid');
      return result;
    }
    return Object.freeze({withUI:(req,res,filter,work)=>enter('ui',config=>host.uiAuthority(req,res,config),filter,work,null,true),
      withModel:(ctx,tool,filter,work)=>enter('model',config=>host.modelAuthority(ctx,tool,config),filter,work,null,tool==='threads_search'),withObservation:(ctx,work)=>{if(!ctx?.session?.id||!observationMainReadAllowed(ctx))throw fail('model_scope_required');return enter('observation',config=>host.modelAuthority(ctx,'observation_recall',config),null,work,ctx.session.id);},search,metadata,publicMetadata,usesSourceBoundMethod:()=>!!current().method,searchEvidenceActive:()=>!!current().relatedMetadata,finish,emitUI,scope,
      retireSession:id=>index.invalidate(id,true)});
  }
  return Object.freeze({create});
})(require('node:crypto'),require('node:async_hooks').AsyncLocalStorage);

// Lazy composition: module load does not bind, backfill or enable an index.
let sessionFullTextConsumers=null;
function getSessionFullTextConsumers() {
  if(sessionFullTextConsumers)return sessionFullTextConsumers;
  const deny=suffix=>{throw Object.assign(Error('session_search.'+suffix),{code:'session_search.'+suffix,apiCode:'session_search.'+suffix,statusCode:409});};
  const modelAuthority=async(ctx,tool,config)=>{
    if(!ctx?.session||safeSessionId(ctx.session.id)!==ctx.session.id||ctx.sessionId&&ctx.sessionId!==ctx.session.id||!['threads_search','steward_threads_search','observation_recall'].includes(tool)||tool==='observation_recall'&&!observationMainReadAllowed(ctx))deny('model_scope_required');
    const session=ctx.session,id=session.id,kind=session.kind,turn=ctx.turnSeq??session.turnSeq,settler=turnSettlers.get(id),actor=ctx.externalActor;
    if(tool==='steward_threads_search'&&(kind!=='steward'||config.stewardEnabledV1!==true))deny('model_scope_required');
    if(nativeToolTier(tool)!=='read'||nativeToolDisabledByPolicy(tool,config,sessionDesktopToolsOf(session))||nativeToolGate(resolvePermissionMode({session,config}),'read',tool,{})!=='allow')deny('tool_denied');
    if(actor)await ExternalBotHooks.validateActor(actor);const actorSignal=actor?ExternalBotHooks.actorSignal(actor):null;
    if(actor&&!actorSignal)deny('model_scope_required');
    const assert=()=>{if(ctx.session!==session||session.id!==id||session.kind!==kind||(ctx.turnSeq??session.turnSeq)!==turn||ctx.signal?.aborted||turnSettlers.get(id)!==settler||actor&&(ExternalBotHooks.actorSignal(actor)!==actorSignal||actorSignal.aborted)||tool==='observation_recall'&&!observationMainReadAllowed(ctx))deny('destination_changed');if(InternalMcpHooks.isContext(ctx))InternalMcpHooks.assertTool(ctx,tool);};
    return{scopeId:id,assert,revalidate:async()=>{assert();if(actor)await ExternalBotHooks.validateActor(actor);assert();}};
  };
  const uiAuthority=async(req,res)=>{if(!tokenOk(req)||!originOk(req))deny('user_scope_required');const token=RUNTIME.token;let closed=false;
    const close=()=>{if(!res.writableEnded)closed=true;},abort=()=>{closed=true;};res.on('close',close);req.on('aborted',abort);
    const assert=()=>{if(closed||req.aborted||res.destroyed||req.socket?.destroyed||RUNTIME.token!==token||!tokenOk(req)||!originOk(req))deny('destination_changed');};
    return{scopeId:'user-session-search',assert,revalidate:async()=>assert(),close(){res.removeListener('close',close);req.removeListener('aborted',abort);}};
  };
  sessionFullTextConsumers=SessionFullTextConsumers.create({readConfig,configGeneration:()=>configReadGeneration,uiAuthority,modelAuthority,
    source:createSessionFullTextSource,metadata:head=>sessionMeta(head,null,{committedOnly:true}),projectKey:cwd=>cwd?'project:'+projectKeyForCwd(cwd):'',terms:retrievalTerms,redact,privacy:PrivacyGateway,
    catalog:async()=>{const entries=await fsp.readdir(paths.sessions,{withFileTypes:true}),ids=[];const seen=new Set();for(const entry of entries){const match=/^([A-Za-z0-9_-]{1,64})\.json$/i.exec(entry.name);if(!match||safeSessionId(match[1])!==match[1])continue;const key=process.platform==='win32'?match[1].toLowerCase():match[1];if(!entry.isFile()||entry.isSymbolicLink()||seen.has(key))deny('catalog_invalid');seen.add(key);ids.push(match[1]);}return ids.sort();},bindIndex:disclosure=>SessionFullTextHooks.bindSessions(disclosure)});
  return sessionFullTextConsumers;
}
Object.assign(SessionFullTextHooks,{
  withUI:(req,res,filter,work)=>getSessionFullTextConsumers().withUI(req,res,filter,work),
  withModel:(ctx,tool,filter,work)=>getSessionFullTextConsumers().withModel(ctx,tool,filter,work),
  withObservation:(ctx,work)=>getSessionFullTextConsumers().withObservation(ctx,work),
  search:(query,limit,options)=>getSessionFullTextConsumers().search(query,limit,options),metadata:()=>getSessionFullTextConsumers().metadata(),
  retireSession:id=>getSessionFullTextConsumers().retireSession(id),
  publicMetadata:id=>getSessionFullTextConsumers().publicMetadata(id),usesSourceBoundMethod:()=>getSessionFullTextConsumers().usesSourceBoundMethod(),searchEvidenceActive:()=>getSessionFullTextConsumers().searchEvidenceActive(),finish:value=>getSessionFullTextConsumers().finish(value),
  emitUI:(value,emit)=>getSessionFullTextConsumers().emitUI(value,emit),scope:enabled=>getSessionFullTextConsumers().scope(enabled),
});
