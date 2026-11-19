'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),vm=require('node:vm');
const {fixture:producer}=require('../lib/fulltext-owned-producer-fixture'),{fixture:consumer}=require('../lib/fulltext-consumer-fixture');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('maintenance waits for an owned index cancellation and preserves unrelated failures',async t=>{
 const f=await producer();t.after(()=>f.close());
 let reached,release,settled=false;
 const held=new Promise(resolve=>{release=resolve;});
 const entered=new Promise(resolve=>{reached=resolve;});
 f.onCatalog(async()=>{reached();await held;});
 const preparing=f.index.prepare(null,{incremental:true});
 const request=a.rejects(preparing,{code:'session_fulltext.paused'});
 await entered;
 f.index.setMaintenancePaused(true);
 const drain=f.index.pending().then(()=>{settled=true;});
 await Promise.resolve();
 a.equal(settled,false);
 release();
 await Promise.all([request,drain]);
 a.equal(settled,true);
 const spoof=Object.assign(Error('not issued by the index owner'),{code:'session_fulltext.paused'});
 f.onCatalog(null);
 const rejected=f.index.prepare(null,{check(){throw spoof;}});
 await Promise.all([a.rejects(rejected,error=>error===spoof),a.rejects(f.index.pending(),error=>error===spoof)]);
 f.index.setMaintenancePaused(false);
 const failure=Object.assign(Error('synthetic index state write failed'),{code:'EIO'});
 const failedIndex=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create({...f.host,writeJson:async()=>{throw failure;}});
 const retained=error=>error.cause===failure&&error.cleanupFailed===true&&error.errors.every(item=>item===failure);
 await Promise.all([a.rejects(failedIndex.prepare(null),retained),a.rejects(failedIndex.pending(),retained)]);
});
test('encrypted source scan cooperatively stops and closes before returning on abort',async t=>{const f=await producer({enabled:true});t.after(()=>f.close());await f.put('A',Array.from({length:8},(_,n)=>({role:'user',id:'m'+n,content:'synthetic '+n})));let leases=0;f.keys.snapshot=async()=>{leases++;return {key:Buffer.from(f.master),instanceId:f.instanceId,release(){leases--;}};};const signal=new AbortController();let visits=0;await a.rejects(f.api.source.scan('A',async()=>{visits++;signal.abort();},{signal:signal.signal}),error=>error.name==='AbortError');a.equal(visits,1);a.equal(leases,0,'key leases are released before returning');await delay(20);a.equal(visits,1,'no detached scan continues after rejection');});
test('scan check observes deadline during a multi-row source and propagates exact sentinel',async t=>{const f=await producer({enabled:true});t.after(()=>f.close());await f.put('A',Array.from({length:8},(_,n)=>({role:'user',id:'m'+n,content:'synthetic '+n})));const timeout=Object.freeze(Error('synthetic deadline'));let visits=0;await a.rejects(f.api.source.scan('A',async()=>{visits++;},{check:()=>{if(visits>=2)throw timeout;}}),error=>error===timeout);a.equal(visits,2);await delay(20);a.equal(visits,2);});
async function setup(t,revoke){const f=await consumer();t.after(()=>f.close());let clock=0;f.context.Date=class extends Date{static now(){return clock;}};const ns=vm.runInContext('SessionFullTextConsumers',f.context);let denied=false,searches=0;const api=ns.create({searchBudgetMs:1,readConfig:async()=>({sessionSearchIndexV1:true}),configGeneration:()=>0,uiAuthority:async()=>({scopeId:'ui',assert(){if(denied)throw Object.assign(Error('denied'),{code:'privacy.denied'});},async revalidate(){}}),modelAuthority:async()=>{throw Error('unused');},source:()=>({epoch:async()=> 'epoch',sequence:()=>0,inspect:async()=>null,scan:async()=>{}}),catalog:async()=>{clock=100;if(revoke)denied=true;return [];},metadata:x=>x,projectKey:()=>'',terms:q=>q.split(' '),redact:x=>x,privacy:f.privacy,bindIndex:()=>({coverage:async()=>({phase:'idle',pendingSessions:0}),search:async()=>{searches++;throw Error('must not run after deadline');}})});return{api,searches:()=>searches};}
test('consumer reports explicit partial deadline only after authorized cleanup',async t=>{const {api,searches}=await setup(t,false);const out=await api.withUI({}, {}, null,()=>api.search('query',5));a.equal(out.ok,true);a.equal(out.partial,true);a.equal(out.reason,'deadline');a.equal(out.coverage.complete,false);a.equal(searches(),0);});
test('thread rail renders unmeasured deadlines distinctly from a measured zero',async t=>{
 const {api}=await setup(t,false),out=await api.withUI({}, {}, null,()=>api.search('大巴',5));
 a.equal(out.indexed,null);a.equal(out.coverage.indexedSessions,null);a.equal(out.coverage.sessions,null);
 const {functionBlock}=require('../lib/source-slice'),fs=require('node:fs'),path=require('node:path');
 const render=functionBlock(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/public/js/session-experience.js'),'utf8'),'renderSessions');
 // 150 号文 U11:说明的判据搬进了纯函数模块 session-search-state.js(renderSessions 从那里 import),vm 视图把它一并递进去。
 const {sessionSearchNotices}=await import(require('node:url').pathToFileURL(path.join(__dirname,'../../ruyi-workbench/app/public/js/session-search-state.js')).href);
 const node={};const view={railRenderer:null,$:()=>node,t:(key,values)=>key+(values?JSON.stringify(values):''),sessionSearchQuery:()=>out.query,sessionSearchState:out,sessionSearchNotices};
 vm.runInNewContext(render+'\nrenderSessions();',view);
 a.equal(node.textContent,'session.searchProgressUnavailable');
 view.sessionSearchState={query:out.query,coverage:{phase:'idle',indexedSessions:0,sessions:400}};
 vm.runInNewContext(render+'\nrenderSessions();',view);
 a.equal(node.textContent,'session.searchCoverage{"indexed":0,"total":400}');
});
test('real session route and threads_search do not publish a zero when the deadline prevents coverage measurement',async t=>{
 const f=await consumer();t.after(()=>f.close());
 await f.put('A',[{role:'user',id:'a',content:'周末那班大巴'}]);
 await f.put('B',[{role:'user',id:'b',content:'another session'}]);
 const {handleSessionApiRoutes,threadHistorySearch}=f.installEntrypoints();
 let calls=0;f.context.Date=class extends Date{static now(){return calls++===0?0:30000;}};
 const {req,res}=f.request();Object.assign(req,{method:'GET',url:'/api/sessions/search?q='+encodeURIComponent('大巴')});
 await handleSessionApiRoutes(req,res,'/api/sessions/search');
 a.equal(res.payload.reason,'deadline');a.equal(res.payload.coverage.indexedSessions,null);
 calls=0;const result=await threadHistorySearch({q:'大巴'},f.ctx);
 a.equal(result.reason,'deadline');a.equal(result.partial,true);a.equal(result.indexed,null);
});
test('real thread rail preview returns an authorized title before any cold shard build',async t=>{
 const f=await consumer();t.after(()=>f.close());
 await f.put('A',[{role:'user',id:'a',content:'开场记录'}],{head:{title:'大巴乘车备忘',kind:'mission',cwd:f.directory}});
 await f.put('Z',[{role:'user',id:'z',content:'周末那班大巴'}],{head:{title:'末段线程',kind:'mission',cwd:f.directory}});
 const {handleSessionApiRoutes}=f.installEntrypoints();
 async function request(preview){
  const {req,res}=f.request();Object.assign(req,{method:'GET',url:'/api/sessions/search?q='+encodeURIComponent('大巴')+(preview?'&preview=1':'')});
  await handleSessionApiRoutes(req,res,'/api/sessions/search');return res.payload;
 }
 const early=await request(true);
 a.equal(early.lexicalPreview,true);a.equal(early.partial,true);a.equal(early.coverage.indexedSessions,0);
 a.deepEqual(Array.from(early.results,row=>row.id),['A']);
 const later=await request(false);a.equal(later.coverage.complete,true);a.ok(later.results.some(row=>row.id==='Z'));
});
test('revocation wins over deadline and is never converted to availability fallback',async t=>{const {api,searches}=await setup(t,true);await a.rejects(api.withUI({}, {}, null,()=>api.search('query',5)),{code:'privacy.denied'});a.equal(searches(),0);});
test('concurrent timeout never masks key failure and waits for all started readers',async t=>{const f=await producer({enabled:true});t.after(()=>f.close());await f.put('A',[{role:'user',id:'a',content:'alpha'}]);await f.put('B',[{role:'user',id:'b',content:'beta'}]);await f.index.step(16);const timeout=Object.freeze(Error('deadline')),denied=Object.assign(Error('key denied'),{code:'work_data.key_denied'});let ended=false;
 const ns=vm.runInNewContext('SessionFullTextIndex',f.hookContext),index=ns.create({...f.host,scan:async sid=>{if(sid==='A'){await delay(25);ended=true;throw timeout;}throw denied;}});
 await a.rejects(index.search('nonmatching query',null,5,{check(){},timeout}),error=>error===denied);a.equal(ended,true,'all started readers settled before error returned');});
test('source key change after a projected hit refuses rather than returning cached evidence',async t=>{const f=await producer({enabled:true});t.after(()=>f.close());await f.put('A',[{role:'user',id:'a',content:'keychange needle'}]);await f.index.step(16);f.project(()=>{f.master.fill(0);});await a.rejects(f.index.search('keychange needle',null,5),error=>String(error.code||'').startsWith('work_data'));});
test('deadline in preparation finishes cleanup and leaves no detached writer',async t=>{const f=await producer({enabled:true});t.after(()=>f.close());await f.put('A',Array.from({length:12},(_,n)=>({role:'user',id:'m'+n,content:'synthetic '.repeat(500)})));const original=f.host.writeJson;let writes=0;f.host.writeJson=async(...args)=>{await delay(2);writes++;return original(...args);};const ns=vm.runInNewContext('SessionFullTextIndex',f.hookContext),index=ns.create(f.host),timeout=Object.freeze(Error('deadline'));let checks=0;
 await a.rejects(index.prepare(null,{check(){if(++checks>20)throw timeout;}}),error=>error===timeout);const settled=writes;await delay(30);a.equal(writes,settled,'no index writer continues after timeout is returned');});
test('incremental preparation retains committed progress across deadline without scanning denied sessions',async t=>{const f=await producer({enabled:true});t.after(()=>f.close());for(const sid of ['A','B','C'])await f.put(sid,[{role:'user',id:'m',content:'synthetic '+sid}]);const epoch=f.host.epoch,scan=f.host.scan,timeout=Object.freeze(Error('deadline'));let stop=true,hitDeadline=false,scans=[];
 f.allowed.set('C',false);f.host.epoch=async sid=>{if(stop&&sid==='B')hitDeadline=true;return epoch(sid);};f.host.scan=async(sid,...args)=>{scans.push(sid);return scan(sid,...args);};const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create(f.host);
 await a.rejects(index.prepare(null,{incremental:true,timeout,check(){if(hitDeadline)throw timeout;}}),error=>error===timeout);a.ok(scans.includes('A'));a.ok(!scans.includes('C'));stop=false;hitDeadline=false;scans=[];const next=await index.prepare(null,{incremental:true,timeout,check(){}});a.equal(next.done,true);a.ok(scans.includes('B'));a.ok(!scans.includes('A'),'already committed prefix is not rebuilt');a.ok(!scans.includes('C'),'denied source never scanned');
});
// 150 S6:线程搜索的冷准备从「每发固定 16 个会话」改为按时间片(默认 1.5 s,上限 256 个/发)。修前这里断言 [16,32,33];
// 现在用最小时间片(sliceMs:0 = 每发恰好 1 个)钉住「有界、跨发续做、只在建完后才找得到较晚的会话」,再用足够长的时间片
// 钉住「片够就一发建完、不再停在 16」(修前要 3 发)。
test('cold thread queries prepare bounded slices and find a later session on repeat',async t=>{
 const f=await producer({enabled:true});t.after(()=>f.close());
 for(let n=0;n<33;n++)await f.put('S'+String(n).padStart(2,'0'),[{role:'user',id:'m',content:n===32?'周末那班大巴':'synthetic '+n}]);
 const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create(f.host);
 for(const count of [1,2,3]){
   const progress=await index.prepare(null,{incremental:true,threadSearch:true,sliceMs:0});
   const found=await index.search('大巴',null,5);
   a.equal(found.coverage.indexedSessions,count);a.equal(progress.done,false);
   a.equal(found.results.some(row=>row.reference.session?.id==='S32'||row.reference.sessionId==='S32'),false);
 }
 // A slice long enough for the rest (the default 1.5 s does this in an idle process; fixed here so load cannot flake it).
 const progress=await index.prepare(null,{incremental:true,threadSearch:true,sliceMs:60000});
 const found=await index.search('大巴',null,5);
 a.equal(found.coverage.indexedSessions,33,'one call finishes the library when the time slice allows (was 16 per call)');a.equal(progress.done,true);
 a.equal(found.results.some(row=>row.reference.session?.id==='S32'||row.reference.sessionId==='S32'),true);
});
test('ordinary private preparation cannot scan a denied source or finish after revocation',async t=>{const f=await producer({enabled:true});t.after(()=>f.close());for(const sid of ['Allowed','Denied'])await f.put(sid,[{role:'user',id:'m',content:'synthetic '+sid}]);f.allowed.set('Denied',false);const scan=f.host.scan;let seen=[];f.host.scan=async(sid,...args)=>{seen.push(sid);return scan(sid,...args);};const index=vm.runInNewContext('SessionFullTextIndex',f.hookContext).create(f.host);await index.prepare(null);a.ok(seen.includes('Allowed'));a.ok(!seen.includes('Denied'));
 await f.put('Allowed',[{role:'user',id:'m',content:'changed'}]);let revoked=false;f.host.scan=async(sid,visit,options)=>scan(sid,async(...args)=>{if(!revoked){revoked=true;f.allowed.set('Allowed',false);}return visit(...args);},options);await a.rejects(index.prepare(null),{code:'session_fulltext.disclosure_changed'});
});
