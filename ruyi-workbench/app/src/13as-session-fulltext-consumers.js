// Real search destinations own admission. Neither JSON/model arguments nor an
// index scope label can issue this private, per-call disclosure capability.
const SessionFullTextConsumers = ((c, AsyncLocalStorage) => {
  const fail=suffix=>Object.assign(Error('session_search.'+suffix),{code:'session_search.'+suffix,apiCode:'session_search.'+suffix,statusCode:409});
  const hash=value=>c.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const clone=value=>structuredClone(value);
  function create(host) {
    const local=new AsyncLocalStorage(),issued=new WeakMap();
    const required=['readConfig','configGeneration','uiAuthority','modelAuthority','source','catalog','metadata','projectKey','terms','redact','bindIndex'];
    if(required.some(name=>typeof host?.[name]!=='function')||!host.privacy)throw fail('host_invalid');
    const source=host.source(),privacy=host.privacy;
    if(['epoch','scan','sequence','inspect'].some(name=>typeof source[name]!=='function'))throw fail('source_unavailable');
    function current(token=local.getStore()) {const cap=issued.get(token);if(!cap||cap.closed)throw fail('scope_required');cap.assert();return cap;}
    function projectFilter(value) {if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||!/^project:[a-f0-9]{16}$/.test(value))throw fail('project_invalid');return value;}
    async function enter(kind,authority,filter,work) {
      const selectedFilter=projectFilter(filter),policy=privacy.disclosurePolicyGuard(),generation=host.configGeneration(),config=await host.readConfig();policy();
      if(host.configGeneration()!==generation)throw fail('destination_changed');const grant=await authority(config);policy();
      if(!grant||typeof grant.assert!=='function'||typeof grant.revalidate!=='function'||typeof grant.scopeId!=='string')throw fail('destination_invalid');
      const token=Object.freeze({}),cap={kind,config,generation,grant,filter:selectedFilter,sources:new Map(),disclosed:new Set(),disclosures:[],closed:false,emitted:false};
      cap.access=Object.freeze({scopeId:grant.scopeId,revision:hash([c.randomBytes(24).toString('hex'),generation,cap.filter])});
      cap.assert=()=>{if(cap.closed||local.getStore()!==token||host.configGeneration()!==generation)throw fail('destination_changed');policy();grant.assert();for(const [sid,row]of cap.sources)if(source.sequence(sid)!==row.sequence)throw fail('source_changed');};
      issued.set(token,cap);
      const perform=()=>local.run(token,async()=>{try{cap.assert();const value=await work();if(!cap.emitted)await final(cap);return value;}finally{cap.closed=true;cap.sources.clear();cap.disclosed.clear();cap.disclosures.length=0;grant.close?.();}});
      try{grant.assert();return await(kind==='model'?privacy.withPolicy(grant.scopeId,perform):perform());}catch(error){grant.close?.();throw error;}
    }
    async function authorize(sid,token,access) {
      const cap=current(token);if(access.revision!==cap.access.revision||access.scopeId!==cap.access.scopeId)throw fail('scope_changed');
      await cap.grant.revalidate();cap.assert();const selected=await source.inspect(sid);cap.assert();
      if(!selected||selected.head.kind==='steward'||selected.head.rawKind==='steward')return false;
      const metadata=host.metadata(selected.head),project=host.projectKey(metadata.cwd);
      if(cap.filter&&project!==cap.filter)return false;
      const prior=cap.sources.get(sid);if(prior&&(prior.epoch!==selected.epoch||prior.sequence!==selected.sequence))throw fail('source_changed');
      cap.sources.set(sid,{...selected,metadata});return true;
    }
    function assertAuthorized(sid,token,access) {const cap=current(token),row=cap.sources.get(sid);return access.revision===cap.access.revision&&!!row&&(!cap.filter||host.projectKey(row.metadata.cwd)===cap.filter)&&source.sequence(sid)===row.sequence;}
    async function final(cap) {
      cap.assert();await cap.grant.revalidate();cap.assert();
      for(const [sid,row]of cap.sources){if(await source.epoch(sid)!==row.epoch)throw fail('source_changed');cap.assert();}
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
    async function publicMetadata(sid) {
      const token=local.getStore(),cap=current(token);if(!await authorize(sid,token,cap.access))throw fail('source_denied');
      const row=cap.sources.get(sid),raw=cap.kind==='ui'?row.metadata:privacy.foreignView(row.metadata);
      // The routing identifier is never reattached after projection. A protected
      // identifier that cannot be used by the old destination contract refuses.
      if(raw.id!==sid)throw fail('identifier_sensitive');
      const value=strings(await disclose(cap,sid,raw,'session-search:metadata'),host.redact);cap.assert();if(value.id!==sid)throw fail('identifier_projection');return value;
    }
    async function projection(input) {
      const token=local.getStore(),cap=current(token),sid=input.reference.sessionId;
      if(typeof input.sourceText!=='string'||!await authorize(sid,token,cap.access))throw fail('source_denied');
      const metadata=await publicMetadata(sid),reference=clone(input.reference);delete reference.text;
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
    const index=host.bindIndex({scope:async token=>current(token).access,authorize,assertAuthorized,project:projection,
      assertScope:(token,access)=>{const cap=current(token);return cap.access.revision===access.revision&&cap.access.scopeId===access.scopeId;}});
    async function metadata() {const token=local.getStore(),cap=current(token),out=[];for(const sid of await host.catalog())if(await authorize(sid,token,cap.access))out.push(clone(cap.sources.get(sid).metadata));cap.assert();return out;}
    async function searchOnce(query,limit) {
      const token=local.getStore(),cap=current(token),q=String(query||'').trim();cap.query=q;
      if(q.length>256)throw fail('query_invalid');
      if(q.length<2)return{ok:true,query:q,results:[],indexed:0,scope:scope(cap.config.sessionSearchIndexV1!==false),reason:'query_too_short'};
      const enabled=cap.config.sessionSearchIndexV1!==false,metas=await metadata(),terms=[...new Set(host.terms(q).filter(term=>!term.startsWith('#')))];
      let found={results:[],coverage:{phase:'disabled',sessions:metas.length,indexedSessions:0,pendingSessions:metas.length,complete:false,attachments:{unverifiedFullText:0},fullTextSampling:false}};
      if(enabled){cap.assert();const coverage=await index.coverage(token);if(coverage.pendingSessions&&coverage.phase!=='paused'){await index.prepare(token);cap.assert();}found=await index.search(q,token,limit);}
      const results=new Map();
      for(const hit of found.results){const meta=hit.reference.session;if(!meta||typeof meta.id!=='string')throw fail('projection_invalid');if(!results.has(meta.id))results.set(meta.id,{...meta,...(meta.brief?{briefTitle:meta.brief.title,briefGist:meta.brief.gist}:{}),snippet:hit.snippet,reference:hit.reference,score:hit.score});}
      const ceiling=Math.min(50,Math.max(1,Math.floor(Number(limit)||20)));
      for(const meta of metas.slice().sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))){if(results.size>=ceiling)break;const text=[meta.title,meta.summary,meta.brief?.title,meta.brief?.gist,meta.cwd].filter(Boolean).join('\n'),hay=text.normalize('NFKC').toLowerCase(),phrase=q.normalize('NFKC').toLowerCase();if(!hay.includes(phrase)&&terms.filter(term=>hay.includes(term)).length<Math.max(1,Math.ceil(terms.length/2)))continue;
        if(!results.has(meta.id)){const safe=await publicMetadata(meta.id);results.set(meta.id,{...safe,...(safe.brief?{briefTitle:safe.brief.title,briefGist:safe.brief.gist}:{}),snippet:host.redact(safe.summary||safe.title||''),score:1,reference:null});}}
      await final(cap);
      return{ok:true,query:q,results:[...results.values()].sort((a,b)=>b.score-a.score||String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))).slice(0,ceiling),indexed:found.coverage.indexedSessions,coverage:found.coverage,scope:{...scope(enabled),fullText:enabled&&found.coverage.complete}};
    }
    async function search(query,limit){const cap=current();for(let pass=0;pass<4;pass++){try{return await searchOnce(query,limit);}catch(error){if(error?.code!=='privacy.disclosure_dirty'||pass===3)throw error;cap.disclosures.length=0;await final(cap);}}}
    function scope(enabled=true) {return{fullText:false,messageText:enabled,mode:enabled?'message_shards':'metadata_only',sampling:false,coordinate:'utf16',maxQueryChars:256,
      coverageUnit:'committed-display-message-sources',note:enabled?'搜索完整已提交消息文字；附件全文提取尚未全部验证，请以 coverage 为准。':'正文搜索已关闭，仅搜索会话元数据。'};}
    async function finish(value) {const cap=current();for(let pass=0;pass<4;pass++){try{const prepared=await privacy.prepareMultiSourceDisclosure(privacy.foreignView(value),[...cap.disclosed,cap.grant.scopeId],{recipient:cap.grant.scopeId,purpose:'session-search:result',sourceHash:hash(value)});cap.disclosures.push(prepared.assert);await final(cap);return prepared.value;}catch(error){if(error.code!=='privacy.disclosure_dirty'||pass===3)throw error;cap.disclosures.length=0;await final(cap);}}}
    function emitUI(value,emit) {const cap=current();if(cap.kind!=='ui'||typeof emit!=='function')throw fail('destination_invalid');cap.assert();for(const guard of cap.disclosures)guard();cap.emitted=true;const result=emit(value);if(result&&typeof result.then==='function')throw fail('sink_invalid');return result;}
    return Object.freeze({withUI:(req,res,filter,work)=>enter('ui',config=>host.uiAuthority(req,res,config),filter,work),
      withModel:(ctx,tool,filter,work)=>enter('model',config=>host.modelAuthority(ctx,tool,config),filter,work),search,metadata,publicMetadata,finish,emitUI,scope});
  }
  return Object.freeze({create});
})(require('node:crypto'),require('node:async_hooks').AsyncLocalStorage);

// Lazy composition: module load does not bind, backfill or enable an index.
let sessionFullTextConsumers=null;
function getSessionFullTextConsumers() {
  if(sessionFullTextConsumers)return sessionFullTextConsumers;
  const deny=suffix=>{throw Object.assign(Error('session_search.'+suffix),{code:'session_search.'+suffix,apiCode:'session_search.'+suffix,statusCode:409});};
  const modelAuthority=async(ctx,tool,config)=>{
    if(!ctx?.session||safeSessionId(ctx.session.id)!==ctx.session.id||ctx.sessionId&&ctx.sessionId!==ctx.session.id||!['threads_search','steward_threads_search'].includes(tool))deny('model_scope_required');
    const session=ctx.session,id=session.id,kind=session.kind,turn=ctx.turnSeq??session.turnSeq,settler=turnSettlers.get(id),actor=ctx.externalActor;
    if(tool==='steward_threads_search'&&(kind!=='steward'||config.stewardEnabledV1!==true))deny('model_scope_required');
    if(nativeToolTier(tool)!=='read'||nativeToolDisabledByPolicy(tool,config,sessionDesktopToolsOf(session))||nativeToolGate(resolvePermissionMode({session,config}),'read',tool,{})!=='allow')deny('tool_denied');
    if(actor)await ExternalBotHooks.validateActor(actor);const actorSignal=actor?ExternalBotHooks.actorSignal(actor):null;
    if(actor&&!actorSignal)deny('model_scope_required');
    const assert=()=>{if(ctx.session!==session||session.id!==id||session.kind!==kind||(ctx.turnSeq??session.turnSeq)!==turn||ctx.signal?.aborted||turnSettlers.get(id)!==settler||actor&&(ExternalBotHooks.actorSignal(actor)!==actorSignal||actorSignal.aborted))deny('destination_changed');if(InternalMcpHooks.isContext(ctx))InternalMcpHooks.assertTool(ctx,tool);};
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
  search:(query,limit)=>getSessionFullTextConsumers().search(query,limit),metadata:()=>getSessionFullTextConsumers().metadata(),
  publicMetadata:id=>getSessionFullTextConsumers().publicMetadata(id),finish:value=>getSessionFullTextConsumers().finish(value),
  emitUI:(value,emit)=>getSessionFullTextConsumers().emitUI(value,emit),scope:enabled=>getSessionFullTextConsumers().scope(enabled),
});
