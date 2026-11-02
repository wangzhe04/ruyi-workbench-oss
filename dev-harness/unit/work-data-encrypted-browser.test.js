'use strict';
require('../lib/media-artifact-test-guard');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const core=require('../lib/work-data-production-upload-core'),{functionBlock}=require('../lib/source-slice');
const driver=fs.readFileSync(path.join(__dirname,'../work-data-production-restore-encrypted.browser.e2e.js'),'utf8');
const browserProof=require('../lib/work-data-production-browser-attach');
const attach=fs.readFileSync(path.join(__dirname,'../lib/work-data-production-browser-attach.js'),'utf8');
const ENABLE_PASSWORD='SYNTHETIC independent enable',EXPORT_PASSWORD='SYNTHETIC independent export';
test('real encrypted preparation consumes only the same actual export backup, with source authority and the original1MiB bound',async()=>{
 const actual=functionBlock(driver,'preparePackage'),f={base:'synthetic-source',backups:'synthetic-backups'},source={generation:0,id:null,mode:'plain',sha256:null},encrypted={generation:1,id:'a'.repeat(48),mode:'encrypted',sha256:'b'.repeat(64)},bytes=Buffer.from('public synthetic export bytes'),file='actual-export-result.ruyi-backup',row={file,bytes:bytes.length,sha256:core.H(bytes)};
 const run=async fault=>{
  const payload=fault==='oversize'?Buffer.alloc(1024*1024+1):bytes,proofRow={...row,bytes:payload.length,sha256:core.H(payload)};
  const calls=[],opens=[],passes=[],recovery={inspectSealed(text){assert.equal(text,bytes.toString());return fault!=='invalid-package';},async open(text,password){opens.push({text,password});return{snapshot:{generation:encrypted.generation,keys:fault==='no-master'?[]:[{}],auxiliaries:[{type:'skill-backup-portable'}],files:[{path:'.work-data/generations/'+encrypted.id+'/work-data-key-v1.json'},{path:'.work-data/generations/'+encrypted.id+'/sessions/sess_encrypted_browser_payload.json'}]},release(){calls.push('release-open');}};}};
  const w={assertCapabilities(){},assertNoIntent(){},record(value){assert.equal(value.source,'actual enable then actual export result.backup.path');assert.equal(value.packageBuiltByPureSeal,false);assert.equal(JSON.stringify(value).includes(EXPORT_PASSWORD),false);},checked:x=>passes.push(x),
   async runMaintenanceRound(g,ref,spec){assert.equal(g,f);calls.push(spec.operation);const selected=spec.operation==='enable'?source:encrypted,body=spec.body({source:selected});assert.equal(body.expectedAuthority,selected);assert.equal(body.password,spec.operation==='enable'?ENABLE_PASSWORD:EXPORT_PASSWORD);const saved={id:'c'.repeat(48),operation:spec.operation,state:spec.operation==='enable'?'published':'verified',sourceAuthority:selected,authority:encrypted,backup:{path:file,sha256:proofRow.sha256,bytes:proofRow.bytes}};const status={job:null,lastResult:saved,authority:encrypted,configMirror:true};if(fault==='wrong-export-authority'&&spec.operation==='export')saved.authority={...encrypted,generation:2};await spec.verify({status,jobId:saved.id,source:selected});return{next:{status}};}};
  const entry=vm.runInNewContext('('+actual+')',{assert,core:{H:core.H,read(got){assert.equal(got,file);return{bytes:payload,row:proofRow};}},ENABLE_PASSWORD,EXPORT_PASSWORD,PAYLOAD_ID:'sess_encrypted_browser_payload'});
  const result=await entry(w,f,{initial:true},recovery);assert.equal(result.packageFile,file);assert.equal(result.sealed,bytes);assert.deepEqual(opens,[{text:bytes.toString(),password:EXPORT_PASSWORD}]);assert.deepEqual(calls,['enable','export','release-open']);assert.equal(passes.length,2);return result;
 };
 await run();for(const fault of ['invalid-package','no-master','wrong-export-authority'])await assert.rejects(run(fault),fault);
 await assert.rejects(run('oversize'),/unchanged browser1MiB bound/);
 assert.doesNotMatch(actual,/recovery\.seal\s*\(/,'encrypted positive never assembles a replacement package');
});
test('body-only search uses actual input/click expressions and requires unique expected-session snippet plus visible message',async()=>{
 const actual=functionBlock(attach,'assertReadableRestoredSession'),id='sess_encrypted_browser_payload',term='M3SyntheticBodyOnlyControl';
 const run=async fault=>{
  let modalHidden=false,input='',messages='',mode='steward',selected=false;const steps=[],notes=[];
  const sessionReads=browserProof.createSessionReadObserver({origin:'http://inert',capture:async()=>({body:JSON.stringify({ok:true,session:{id,messages:[{role:'user',content:term}]}})}),record:x=>notes.push(x)});
  const document={documentElement:{getAttribute:()=>mode},getElementById(name){if(name==='settingsModal')return{classList:{contains:()=>modalHidden}};if(name==='sessionSearch')return{value:input};if(name==='messages')return{textContent:messages};throw Error('unexpected DOM id');},
   querySelector(selector){assert.ok(selector.includes(id));return fault==='wrong-session'?null:{classList:{contains:()=>selected},querySelector(name){assert.equal(name,'.rail-search-snippet');return{textContent:input};}};},
   querySelectorAll(selector){if(selector==='#railList .steward-board-thread.is-sel')return selected?[{}]:[];assert.equal(selector,'#railList .rail-search-snippet');return fault==='duplicate-results'?[{},{}]:[{}];}};
  const entry=vm.runInNewContext('('+actual+')',{assert,Buffer,Date,hash:core.H,step:'initial',readState:null,sessionReads,async click(selector){steps.push(selector);if(selector==='#settingsModal [data-close-modal]')modalHidden=true;else if(selector==='[data-lens="classic"]')mode='classic';else if(selector==='#railList .rail-search-snippet'){selected=true;messages=fault==='wrong-body'?'unrelated':term;sessionReads.request({requestId:'read1',request:{url:'http://inert/api/sessions/'+id,method:'GET'}});sessionReads.response({requestId:'read1',response:{status:200}});await sessionReads.finished({requestId:'read1'});}else assert.fail(selector);},async insert(selector,value){assert.equal(selector,'#sessionSearch');assert.equal(value,term);steps.push(selector);input=value;},evaluate:expression=>vm.runInNewContext(expression,{document}),async waitUntil(check,milliseconds,label){assert.ok(Number.isFinite(milliseconds)&&milliseconds>=0&&milliseconds<=30000,'remaining wait never exceeds original30s bound');if(label==='restored settings closes')assert.equal(milliseconds,10000);if(!await check())throw Error(label+' deadline');},healthy(){if(fault==='unknown')throw Error('unknown');},note:x=>notes.push(x)});
  const result=await entry({sessionId:id,bodyTerm:term});assert.deepEqual(steps,['#settingsModal [data-close-modal]','[data-lens="classic"]','#sessionSearch','#railList .rail-search-snippet']);assert.equal(result.bodySearchHit,true);assert.equal(result.messageBodyVisible,true);assert.equal(result.querySha256,core.H(Buffer.from(term)));assert.equal(JSON.stringify(notes).includes(term),false);assert.equal(result.lastState.mode,'classic');assert.equal(result.lastState.selectedExpected,true);assert.equal(result.sessionGet.requests[0].summary.status,200);return result;
 };
 await run();for(const [fault,message] of [['wrong-session','restored body search result deadline'],['duplicate-results','restored body search result deadline'],['wrong-body','restored message body renders deadline'],['unknown','unknown']])await assert.rejects(run(fault),{message},'inverse '+fault);
});


test('native browser handoff judge reopens complete receiver and binds exact job, file, marker and root identities',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-encrypted-browser-proof-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('ruyi-encrypted-browser-proof-'));fs.rmSync(root,{recursive:true,force:true});});
 const base=path.join(root,'source'),dir=path.join(root,'custody');fs.mkdirSync(base);fs.mkdirSync(dir);
 const id='a'.repeat(48),jobId='b'.repeat(48),nonce='c'.repeat(64),sealed=Buffer.from('Public synthetic complete receiver'),file=path.join(dir,'restore-upload-'+id+'.sealed'),markerFile=path.join(dir,'restore-upload-owner.json');fs.writeFileSync(file,sealed);fs.writeFileSync(markerFile,JSON.stringify({schema:1,nonce}));
 const row=core.read(file).row,marker=core.read(markerFile).row,stat=fs.lstatSync(dir,{bigint:true}),handoffFile=path.join(dir,'handoff-'+jobId+'-'+'d'.repeat(64)+'.json'),original={schema:1,jobId,uploadId:id,base,root:dir,file,bytes:sealed.length,sha256:core.H(sealed),identity:{dev:row.dev,ino:row.ino},marker:{dev:marker.dev,ino:marker.ino,sha256:marker.sha256},rootNonce:nonce,rootIdentity:{dev:String(stat.dev),ino:String(stat.ino)}};
 const writeHandoff=value=>fs.writeFileSync(handoffFile,JSON.stringify(value));writeHandoff(original);
 const facts={uploads:[{status:201,accepted:{uploadId:id},receiver:{source:'receiver-custody-readback',uploadId:id,bytes:sealed.length,sha256:core.H(sealed),row},body:null,postData:{unavailableReason:'cdp-file-body-not-exposed'}}],jobs:[{status:202,accepted:{id:jobId},body:{uploadId:id,passwordMatched:true}}],folderChoices:[{},{}]},markers=new Map([[id,{row:marker,value:{nonce}}]]),w={custodyWithUpload(_f,got){assert.equal(got,id);return{dir};}};
 const entry=vm.runInNewContext('('+functionBlock(driver,'verifyHandoff')+')',{assert,core,fs,path});
 await entry({w,f:{base},facts,sealed,jobId,markers});
 for(const mutation of [value=>value.jobId='e'.repeat(48),value=>value.uploadId='f'.repeat(48),value=>value.sha256='0'.repeat(64),value=>value.identity.ino='0',value=>value.rootNonce='0'.repeat(64),value=>value.marker.sha256='0'.repeat(64)]){
  const value=JSON.parse(JSON.stringify(original));mutation(value);writeHandoff(value);await assert.rejects(entry({w,f:{base},facts,sealed,jobId,markers}));
 }
 writeHandoff(original);const bad=structuredClone(facts);bad.uploads[0].body={bytes:sealed.length,sha256:'0'.repeat(64)};await assert.rejects(entry({w,f:{base},facts:bad,sealed,jobId,markers}));
});
test('new driver is a separate original-budget exclusive entry; original plain and HTTP journey remain independent',()=>{
 const runner=fs.readFileSync(path.join(__dirname,'../run-all.js'),'utf8');
 assert.ok(runner.includes("'work-data-production-restore-encrypted.browser.e2e.js': 900000"));
 const exclusive=runner.slice(runner.indexOf('const PARALLEL_EXCLUSIVE'),runner.indexOf(']);',runner.indexOf('const PARALLEL_EXCLUSIVE')));
 assert.ok(exclusive.includes("'work-data-production-restore-encrypted.browser.e2e.js'"));
 assert.ok(exclusive.includes("'work-data-production-restore.browser.e2e.js'"));
 assert.ok(runner.includes("'work-data-production-restore.browser.e2e.js': 900000"));
});

test('new entry binding pins its own current driver in addition to the real browser/product closure',()=>{
 const file=path.resolve('synthetic-driver.js'),old=path.resolve('synthetic-original.js'),extra={file,bytes:5,sha256:core.H(Buffer.from('extra'))},original={file:old,bytes:8,sha256:core.H(Buffer.from('original'))};let changed=false,baseChecks=0;
 const selected={boundFiles:[original],recheck(){baseChecks++;}};
 const entry=vm.runInNewContext('('+functionBlock(driver,'bindTarget')+')',{plainBrowser:{bindTarget:()=>selected},__filename:file,assert,Buffer,core:{H:core.H,norm:core.norm,read(got,pin){assert.equal(got,file);if(pin&&changed)throw Error('driver changed');return{row:extra};}}});
 const bound=entry();assert.equal(bound.boundFiles.length,2);assert.ok(bound.boundFiles.some(row=>row.file===file));assert.equal(bound.recheck().files,2);assert.equal(baseChecks,1);changed=true;assert.throws(()=>bound.recheck(),/driver changed/);
});
test('new entry failure durably records safe diagnostics and exits synchronously without native cleanup after unknown',async()=>{
 const actual=functionBlock(driver,'runActual'),original=Error('SYNTHETIC private password body must not persist'),exit=Error('controlled synchronous exit'),events=[],ctx={phase:'initialization',unknown:false,failure:null};let diagnosis;
 const handle={spawned:Promise.resolve()},world={ctx,openJournal(){},record(){},fixture(){return{base:'synthetic'};},spawnServe(){return handle;},async readyWarm(){ctx.unknown=true;ctx.failure=original;throw original;},latch(error){assert.equal(error,original);ctx.unknown=true;},close(){events.push('close-journal');},manager:{captureNativeBirths(){assert.fail('unreachable native observation');}}};
 const entry=vm.runInNewContext('('+actual+')',{assert,fs:{mkdtempSync:()=>path.resolve('synthetic-root'),mkdirSync(){},openSync(file,flags,mode){assert.equal(path.basename(file),'failure-summary.json');assert.equal(flags,'wx');assert.equal(mode,0o600);events.push('summary-open');return 42;},writeFileSync(fd,text){assert.equal(fd,42);diagnosis=JSON.parse(text);events.push('summary-write');},fsyncSync(fd){assert.equal(fd,42);events.push('summary-sync');},closeSync(){events.push('summary-close');}},path,os:{tmpdir:()=>path.resolve('synthetic-temp')},process:{platform:'win32',versions:{node:'24.14.1'},exit(code){assert.equal(code,1);events.push('exit');throw exit;}},require(name){assert.equal(name,'./lib/harness');return{createRunner:()=>({})};},__dirname:path.resolve(__dirname,'..'),bindTarget:()=>({boundFiles:[]}),restore:{createWorld:()=>world},seed(){},getFreePort:async()=>12345,releaseEnvironment(){},snapshotProcessTable(){},ownDescendants(){},safeFailure:()=>({errorName:'Error'}),console:{error(){events.push('diagnostic');}}});
 await assert.rejects(entry([]),error=>error===exit);assert.equal(diagnosis.nativeUnknown,true);assert.equal(diagnosis.submissionStarted,false);assert.equal(JSON.stringify(diagnosis).includes('private password'),false);assert.equal(ctx.failure,original);assert.ok(events.indexOf('summary-sync')<events.indexOf('close-journal'));assert.ok(events.indexOf('summary-close')<events.indexOf('exit'));assert.equal(events.filter(x=>x==='exit').length,1);
});



test('passive exact-session GET evidence has fixed bounds, safe summaries and no invented304/unavailable success',async()=>{
 const id='sess_encrypted_browser_payload',term='M3OnlySyntheticTerm',secret='DO_NOT_PERSIST_SYNTHETIC_SECRET';
 const run=async(fault)=>{
  let captures=0;const notes=[],raw={body:JSON.stringify({ok:true,session:{id:fault==='wrong-id'?'sess_other':id,messages:[{role:'user',content:fault==='wrong-body'?'other':term}]},password:secret,token:secret})};
  if(fault==='http-error')raw.body=JSON.stringify({ok:false,error:{code:'work_data.body_locked',params:{password:secret}}});
  if(fault==='bound')raw.body=JSON.stringify({session:{id,messages:[{content:term+'x'.repeat(65536)}]}});
  if(fault==='invalid')raw.body='not-json '+secret;
  const observed=browserProof.createSessionReadObserver({origin:'http://inert',now:()=>fault==='deadline'?500:100,
   check(){if(fault==='unknown')throw Error('unknown');},capture:async(_id,ms)=>{captures++;assert.ok(ms>0&&ms<=10000);if(fault==='unavailable')throw Error(secret);return raw;},record:r=>notes.push(r)});
  assert.equal(observed.request({requestId:'early',request:{url:'http://inert/api/sessions/'+id,method:'GET'}}),false);
  observed.arm(id,term,300);
  for(const [method,url] of [['POST','http://inert/api/sessions/'+id],['GET','http://foreign/api/sessions/'+id],['GET','http://inert/api/sessions/'+id+'?extra=1'],['GET','http://inert/api/sessions/other']])assert.equal(observed.request({requestId:'wrong',request:{method,url}}),false);
  assert.equal(observed.request({requestId:'one',request:{url:'http://inert/api/sessions/'+id,method:'GET'}}),true);
  observed.response({requestId:'one',response:{status:fault==='304'?304:fault==='http-error'?503:200}});
  if(fault==='unknown'){await assert.rejects(observed.finished({requestId:'one'}),/unknown/);assert.equal(captures,0);return;}
  await observed.finished({requestId:'one'});
  assert.equal(JSON.stringify(observed.snapshot()).includes(secret),false);assert.equal(JSON.stringify(notes).includes(secret),false);
  assert.equal(observed.ready(),!fault);
  if(!fault){const s=observed.snapshot().requests[0].summary;assert.equal(s.sessionId,id);assert.equal(s.messageCount,1);assert.equal(s.termMessages,1);assert.equal(s.status,200);assert.match(s.sha256,/^[a-f0-9]{64}$/);}
  if(fault==='304'){assert.equal(captures,0);assert.equal(observed.snapshot().requests[0].status,304);assert.equal(observed.snapshot().requests[0].summary,undefined);}
  if(fault==='deadline')assert.equal(captures,0);
  if(fault==='http-error')assert.equal(observed.snapshot().requests[0].summary.errorCode,'work_data.body_locked');
  if(captures&&fault!=='unavailable')assert.equal(raw.body,'','held CDP body string cleared after summary/bound failure');
 };
 await run();for(const fault of ['wrong-id','wrong-body','http-error','304','bound','invalid','unavailable','deadline','unknown'])await run(fault);
 const over=browserProof.createSessionReadObserver({origin:'http://inert',capture:()=>assert.fail('no unsolicited getter')});over.arm(id,term,Date.now()+30000);
 for(let i=0;i<17;i++)over.request({requestId:String(i),request:{url:'http://inert/api/sessions/'+id,method:'GET'}});
 assert.equal(over.snapshot().requests.length,16);assert.equal(over.snapshot().overflow,true);assert.equal(over.ready(),false);
});

test('classic intent, selected-id proof and exact GET are mandatory; existing mode/search/body deadlines and safe codes remain bounded',async()=>{
 const actual=functionBlock(attach,'assertReadableRestoredSession'),id='sess_encrypted_browser_payload',term='M3SyntheticBodyOnlyControl';
 const run=async fault=>{
  let mode='steward',hidden=false,input='',selected=false,text='';let calls=0;const waits=[];
  const sessionReads=browserProof.createSessionReadObserver({origin:'http://inert',capture:async()=>({body:JSON.stringify({session:{id:fault==='get-id'?'sess_wrong':id,messages:[{content:term}]}})})});
  const document={documentElement:{getAttribute:()=>mode},getElementById(name){if(name==='settingsModal')return{classList:{contains:()=>hidden}};if(name==='sessionSearch')return{value:input};if(name==='messages')return fault==='missing-box'?null:{textContent:text};throw Error('DOM id');},
   querySelector(){return{classList:{contains:()=>selected},querySelector:()=>({textContent:input})};},querySelectorAll(selector){return selector.includes('.is-sel')?(selected?(fault==='selected-count'?[{},{}]:[{}]):[]):[{}];}};
  const context={assert,Buffer,Date,hash:core.H,step:'initial',readState:null,sessionReads,healthy(){if(fault==='unknown')throw Error('unknown');},
   evaluate:s=>vm.runInNewContext(s,{document}),async click(selector){calls++;if(selector.includes('data-close-modal'))hidden=true;else if(selector==='[data-lens="classic"]'){if(fault!=='mode')mode='classic';}else if(selector.includes('rail-search-snippet')){selected=fault!=='selected';text=term;if(fault!=='get-missing'){sessionReads.request({requestId:'one',request:{method:'GET',url:'http://inert/api/sessions/'+id}});sessionReads.response({requestId:'one',response:{status:200}});await sessionReads.finished({requestId:'one'});}}else assert.fail(selector);},
   async insert(_selector,value){input=value;},async waitUntil(check,ms,label){waits.push({ms,label});assert.ok(ms>=0&&ms<=30000);if(!await check())throw Error(label+' deadline');},note(){}};
  const entry=vm.runInNewContext('('+actual+')',context);
  if(!fault){await entry({sessionId:id,bodyTerm:term});assert.equal(context.readState.last.selectedExpected,true);return;}
  const expected=fault==='mode'?'M3_BROWSER_CLASSIC_TIMEOUT':fault==='unknown'?null:'M3_BROWSER_BODY_TIMEOUT';
  await assert.rejects(entry({sessionId:id,bodyTerm:term}),error=>expected?error.code===expected:error.message==='unknown');
  assert.ok(calls<=3,'no alternate route or click retry after failed wait');
  const json=JSON.stringify(context.readState);assert.equal(json.includes(term),false,'retained DOM sample never contains raw text');
 };
 await run();for(const fault of ['mode','selected','selected-count','get-id','get-missing','missing-box','unknown'])await run(fault);
 for(const code of ['M3_BROWSER_CLASSIC_TIMEOUT','M3_BROWSER_SEARCH_TIMEOUT','M3_BROWSER_BODY_TIMEOUT']){
  const safe=browserProof.safeFailure(Object.assign(Error('PRIVATE SYNTHETIC TOKEN'),{code}));assert.equal(safe.code,code);assert.equal(JSON.stringify(safe).includes('PRIVATE'),false);
 }
});


test('original lens intent and row/openSession adoption compose with the original user renderer; stale/wrong responses cannot satisfy body read',async()=>{
 const root=path.resolve(__dirname,'../..'),read=name=>fs.readFileSync(path.join(root,'ruyi-workbench/app/public/js',name),'utf8');
 const sources={shell:read('shell-mode.js'),frame:read('app-frame.js'),board:read('steward-board.js'),session:read('session-experience.js'),renderer:read('chat-static-renderer.js'),primitives:read('chat-render-primitives.js'),turn:read('turn-narrative.js')};
 class E{constructor(){this.children=[];this.dataset={};this.classList={add(){}};this.style={};this.text='';}set textContent(s){this.text=String(s);}get textContent(){return this.text+this.children.map(x=>x.textContent||'').join('');}appendChild(e){this.children.push(e);return e;}append(...es){this.children.push(...es);}setAttribute(){}}
 const el=(_tag,_class,text)=>{const e=new E();if(text!==undefined)e.textContent=text;return e;};
 const messageShell=vm.runInNewContext('('+functionBlock(sources.primitives,'messageShell')+')',{document:{createElement:()=>new E()},el,buildMsgAvatar(){},t:s=>s,fmtTime(){assert.fail('missing timestamp stays optional');}});
 const render=vm.runInNewContext('('+functionBlock(sources.renderer,'renderStaticMessage')+')',{messageShell,bindDisclosureSource(){},validTurnSegments:()=>[],messageAttachmentStrip:()=>null,el,MARKDOWN_SYNC_MAX_CHARS:48000,metaFromMessage:()=>null,renderMarkdown:s=>s,highlightIn(){},bindMermaidDocument(){},msgActions:()=>new E()});
 async function run(fault){
  const id='sess_encrypted_browser_payload',term='M3ActualOriginalRender',head={id,title:'Title without body query',messages:[{role:'user',content:term},{role:'assistant',content:'ack'}]};let mode='steward',text='',drawer=0,stored=[],apiReads=0;
  const context={state:{currentSession:null},sessionChoices:0,sessionOpenSeq:0,sessionExecutionReadSeq:0,sessionOpenPending:null,sessionOpenRefreshPending:false,steerPendingList:[],steeredSeen:[],currentChangedWhileAway:false,
   intentSeq:0,pendingIntent:'',SHELL_FOCUS_ANCHORS:{classic:'title'},normalizeShellMode:x=>x==='classic'?'classic':'steward',canEnterSteward:()=>false,recoverStewardShell:()=>'',documentRef:{documentElement:{setAttribute(_k,v){mode=v;}}},syncModeControl(){},currentShellMode:()=>mode,runShellTransition:fn=>fn(),setStoredShellMode:v=>stored.push(v),byId:()=>null,syncLensSeg(){},
   isStewardMode:()=>mode==='steward',openThread(){drawer++;return id;},renderRail(){},$(id){return null;},localStorage:{setItem(){}},latestUsage(){},
   async api(url){if(url==='/api/sessions/'+id){apiReads++;if(fault==='stale')context.sessionOpenSeq++;return{session:fault==='wrong-id'?{...head,id:'wrong'}:fault==='wrong-body'?{...head,messages:[{role:'user',content:'different'}]}:head};}if(url.startsWith('/api/status?'))return{};throw Error('unexpected original request');},
   renderSessions(){},renderCurrentSession(){const m=context.state.currentSession.messages[0];text=render(m,'key','sig',{readonly:true}).textContent;}};
  for(const name of ['invalidateImageOperations','captureLiveTurn','resetStickyScroll','updateEngineDependentUI','scrollMessagesToBottom','renderResumeBanner','syncStreamingUi','mountActiveTurn','syncOwnTurnLiveIndicator','syncLivePolling','syncEventStreamPresence','renderContextMeter','refreshLiveTurn'])context[name]=()=>{};
  vm.createContext(context);
  for(const [s,name]of [[sources.shell,'applyShellMode'],[sources.frame,'setLens'],[sources.session,'openSession'],[sources.board,'openRow']])vm.runInContext(functionBlock(s,name),context);
  if(fault!=='steward')context.setLens('classic');
  context.openRow(id);for(let i=0;i<12;i++)await Promise.resolve();
  if(!fault){assert.equal(mode,'classic');assert.deepEqual(stored,['classic']);assert.equal(context.state.currentSession.id,id);assert.equal(apiReads,1);assert.ok(text.includes(term));}
  else{assert.equal(text.includes(term),false);if(fault==='steward'){assert.equal(drawer,1);assert.equal(apiReads,0);}}
 }
 await run();for(const fault of ['steward','stale','wrong-id','wrong-body'])await run(fault);
 assert.match(sources.frame,/button\.onclick = \(\) => setLens\(button\.dataset\.lens\)/,'real lens control binding remains original product code');
});

