'use strict';
// Existing tool + real memory files/context/usage and shared admission policy.
// A synthetic local encoder isolates authority and integration, not model quality.
require('./lib/self-isolate-home');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {createRunner}=require('./lib/harness'),t=createRunner('EXPLICIT MEMORY SEMANTIC'),{ok}=t;
const home=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-memory-explicit-'));Object.assign(process.env,{RUYI_HOME:home,WIN_CLAUDE_WORKBENCH_HOME:home,RUYI_DISABLE_SEMANTIC:'1'});
const config={configSchema:9,permissionMode:'bypass',semanticRetrievalV1:true,runtimeMemoryVectorRecallV1:true,autoImportClaudeCodeMcp:false},configFile=path.join(home,'config.json');fs.writeFileSync(configFile,JSON.stringify(config));
const app=path.resolve(__dirname,'../ruyi-workbench/app'),manifest=JSON.parse(fs.readFileSync(path.join(app,'src/manifest.json'),'utf8')),source=manifest.modules.map(m=>fs.readFileSync(path.join(app,'src',typeof m==='string'?m:m.file),'utf8')).join('\n');
 const mod=new Module(path.join(app,'server.js'),module);mod.filename=path.join(app,'server.js');mod.paths=Module._nodeModulePaths(app);mod._compile(source+'\nmodule.exports.__test={activeChildren,readMemoryUsageState,memoryUsageKey,memoryToolLibraryVersion,resolveMemoryPreflight,proposeMemoryRelation,confirmMemoryRelation,setRuntime:hooks=>Object.assign(SemanticRuntimeHooks,hooks),clear:()=>MemorySemanticHooks.clear()};',mod.filename);const srv=mod.exports,a=srv.__test;
(async()=>{try{
 const cwd=path.join(home,'project'),other=path.join(home,'other-project');fs.mkdirSync(cwd);fs.mkdirSync(other);const session=await srv.createSession({title:'explicit memory semantic',cwd});session.turnSeq=1;const reg={state:'running',session};a.activeChildren.set(session.id,reg);
 const ctx=()=>({session,sessionId:session.id,workingDir:cwd,turnSeq:session.turnSeq,config});
 const save=async(id,name,extra={},target=cwd)=>{const result=await srv.saveMemory({id,scope:'project',type:'reference',name,description:name,body:'PRIVATE_BODY_'+id,...extra},target);if(!result.ok)throw Error('save fixture: '+id);};
 await save('cert-guidance','分发流程',{description:'无关填充'.repeat(28)+'证书签署应先经过人工核准'});await save('exact-alpha','exact alpha record');await save('rule-fill','团队通用约定',{type:'convention'});await save('body-only','header without description',{description:'',coreSummary:''});
 await save('expired','证书 expired',{expiresAt:'2000-01-01'});await save('excluded','证书 excluded');await save('foreign','证书 foreign',{},other);await save('core-rule','核心规则',{type:'preference',core:true});session.memoryExclusions=[{id:'excluded',scope:'project'}];
 const seen=[];let calls=0,action=null,prepareAction=null;
 const ready=()=>({available:true,modelId:'paraphrase-multilingual-MiniLM-L12-v2',modelFingerprint:'synthetic-explicit-memory',retrievalThresholds:{search:.34,automatic:null}});
 const encode=async(texts,{role})=>{calls++;seen.push(...texts);if(action){const next=action;action=null;await next();}return{ok:true,modelFingerprint:'synthetic-explicit-memory',vectors:texts.map(text=>role==='query'||text.includes('证书')?[1,0]:[0,1]),truncated:texts.map(()=>false)};};
 const normal=()=>a.setRuntime({prepare:async()=>{if(prepareAction){const next=prepareAction;prepareAction=null;await next();}return ready();},encode});normal();
 const list=(query,args={},extra={})=>srv.toolCall('workbench_memory_list',{query,...args},{...ctx(),...extra});
 fs.writeFileSync(configFile,JSON.stringify({...config,semanticRetrievalV1:false}));const baseline=await list('release credential approval');ok(baseline.ok&&!baseline.memories.some(row=>row.id==='cert-guidance'),'disabled existing tool preserves lexical baseline');fs.writeFileSync(configFile,JSON.stringify(config));
 const found=await list('release credential approval');ok(found.ok&&found.memories.some(row=>row.id==='cert-guidance'&&row.retrieval.kind==='semantic')&&found.semantic.semanticOnlyMatches===1,'existing list query adds an admitted semantic-only memory');ok(found.semantic.admissionPolicy==='minilm-search-relevance-v1'&&found.semantic.automaticCandidates===false,'explicit semantic admission remains distinct from automatic recall');
 ok(seen.some(text=>text.includes('证书'))&&!seen.some(text=>/PRIVATE_BODY_|expired|excluded|foreign/.test(text)),'encoder sees full eligible metadata chunks including late description, never memory bodies or excluded scope');
 const usage=await a.readMemoryUsageState();ok(!!usage.entries[a.memoryUsageKey({id:'cert-guidance',scope:'project'},cwd)]&&!usage.entries[a.memoryUsageKey({id:'rule-fill',scope:'project'},cwd)],'semantic matches count usage; unrelated rule fills do not');
 const exact=await list('exact alpha release credential approval');ok(exact.memories[0]?.id==='exact-alpha'&&exact.memories.some(row=>row.id==='cert-guidance'),'exact lexical matches retain priority while semantic discovery is additive');
 const global=await list('release credential approval',{scope:'global'});ok(global.ok&&global.count===0,'explicit scope filter runs before semantic encoding');
 session.memoriesExplicit=true;session.memories=[{id:'exact-alpha',scope:'project'}];a.clear();const fixed=await list('release credential approval');ok(fixed.ok&&!fixed.memories.some(row=>row.id==='cert-guidance'),'semantic discovery cannot expand fixed selections');session.memoriesExplicit=false;session.memories=[];
 const relation=await a.proposeMemoryRelation({type:'supersedes',from:'exact-alpha',to:'cert-guidance',scope:'project'},cwd);await a.confirmMemoryRelation(relation.relation.id,cwd);a.clear();const superseded=await list('release credential approval');ok(superseded.memories.find(row=>row.id==='cert-guidance')?.superseded===true,'semantic discovery retains confirmed supersedes warnings');
 a.clear();const identifiers=await list('CASE-4477');ok(identifiers.ok&&!identifiers.memories.some(row=>row.retrieval?.kind==='semantic'),'high similarity cannot bypass structured-identifier admission');
 a.clear();a.setRuntime({prepare:async()=>({...ready(),modelId:'unregistered-model'}),encode});const unknown=await list('release credential approval');ok(unknown.ok&&unknown.semantic.status==='admission-unavailable'&&!unknown.memories.some(row=>row.id==='cert-guidance'),'unknown model without admission cannot add semantic-only memories');normal();
 for(const status of ['loading','timeout','overloaded']){
   a.clear();
   a.setRuntime({prepare:async()=>({available:false,reason:status==='loading'?'unavailable':status,state:status})});
   const unavailable=await list('exact alpha release credential approval');
   ok(unavailable.ok&&unavailable.memories.some(row=>row.id==='exact-alpha'&&row.retrieval?.kind==='lexical')
     &&!unavailable.memories.some(row=>row.id==='cert-guidance')
     &&unavailable.matchedCount===1&&unavailable.ruleFillCount>0
     &&unavailable.semantic.fallback?.reason===status&&unavailable.semantic.fallback.method==='keywords',
   'availability '+status+' keeps an authorized keyword hit and separately counts default fills');
 }normal();
 a.clear();const beforePrepare=calls;prepareAction=()=>{session.memoryExclusions.push({id:'cert-guidance',scope:'project'});};const revoked=await list('release credential approval');ok(!revoked.ok&&calls===beforePrepare,'selection revocation during model preparation prevents encoding');session.memoryExclusions=[{id:'excluded',scope:'project'}];
 const race=async(change,extra={})=>{a.clear();action=change;return list('release credential approval',{},extra);};
 let raced=await race(()=>save('cert-guidance','changed',{description:'证书 changed'}));ok(!raced.ok,'metadata revision during encoding discards the result');
 ok(a.memoryToolLibraryVersion([{id:'same',scope:'project',memoryVersion:'unchanged-stat',name:'first'}])!==a.memoryToolLibraryVersion([{id:'same',scope:'project',memoryVersion:'unchanged-stat',name:'other'}]),'same-sized metadata with an unchanged stat hint still changes library identity');
 raced=await race(()=>{session.rewindGen=(Number(session.rewindGen)||0)+1;});ok(!raced.ok,'rewind during encoding discards the result');
 raced=await race(()=>{reg.session={...session};});ok(!raced.ok,'live owner session-object replacement invalidates the read');reg.session=session;
 raced=await race(()=>fs.writeFileSync(configFile,JSON.stringify({...config,runtimeMemoryVectorRecallV1:false})));ok(!raced.ok,'configuration revocation during encoding is not an availability fallback');fs.writeFileSync(configFile,JSON.stringify(config));
 const controller=new AbortController();let aborted=false;try{await race(()=>controller.abort(),{signal:controller.signal});}catch(error){aborted=error.name==='AbortError';}ok(aborted,'in-flight cancellation retains the abort contract');
 a.clear();action=()=>{throw Object.assign(Error('key unavailable'),{code:'work_data.key_unavailable'});};let keyFailed=false;try{await list('release credential approval');}catch(error){keyFailed=error.code==='work_data.key_unavailable';}ok(keyFailed,'key failures propagate instead of returning lexical fallback');
 a.clear();const beforeAuto=calls,automatic=await a.resolveMemoryPreflight(session,cwd,'release credential approval',null,config);ok(!automatic.entries.some(row=>row.id==='cert-guidance')&&calls===beforeAuto,'automatic memory still cannot add semantic-only candidates');
 }finally{a.clear();if(path.dirname(home)!==path.resolve(os.tmpdir())||!path.basename(home).startsWith('ruyi-memory-explicit-'))throw Error('fixture cleanup outside owned temp');fs.rmSync(home,{recursive:true,force:true});}t.done();})().catch(error=>{console.error(error);process.exitCode=1;});
