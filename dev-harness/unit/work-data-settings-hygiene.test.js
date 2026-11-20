'use strict';
// 151 阶段 3G：加密设置面板里的「数据根体检与残留文件」（150 W3/W4）、U13 的 P3 文案（只读路径栏、灰按钮说原因、
// 不提供与当前模式相反的那一项、字节数用 fmtBytes）与 3C 审查 S6（文案对「数据动没动」的措辞）。
// 用真模块 + DOM 事件夹具（work-data-settings-fixture），断言实际发出的请求与屏上的文字。
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,authority,job,status,deferred}=require('../lib/work-data-settings-fixture');
const STAMP='2026-11-20T01-02-03-004Z-0123abcd';
const inspection=(extra={})=>({schema:1,ok:true,verdicts:[{code:'work_data_hygiene.leftovers_present',severity:'advice',action:'quarantine',params:{count:2,bytes:3072,paths:['sessions/a.json.corrupt','config.json.4321.0123abcd.tmp']}}],
 census:{files:1234,directories:56,entries:1291,bytes:5*1048576,largestFileBytes:1048576,nativeOwnerRoots:[],largest:[{path:'webcache',files:900,directories:3,bytes:3*1048576},{path:'sessions',files:300,directories:1,bytes:2*1048576}]},
 budget:{},scope:{included:{files:310,directories:4,bytes:2*1048576},leftoverCount:2},quarantine:[],...extra});
const plan=(extra={})=>({schema:1,token:'f'.repeat(64),files:2,bytes:3072,roots:[{root:'',files:2,bytes:3072}],
 items:[{path:'sessions/a.json.corrupt',root:'',reason:'quarantined-corrupt',area:'active',bytes:1024},{path:'config.json.4321.0123abcd.tmp',root:'',reason:'crash-stage',area:'active',bytes:2048}],
 itemsTruncated:false,skipped:[{path:'x.json.99.0123abcd.tmp',reason:'writer-alive'}],skippedCount:1,...extra});
function hygieneFixture(handlers={},statusExtra={}){
 const state={inspection:inspection(),plan:plan(),statusExtra};
 const f=fixture((route,options,body)=>{
  if(route==='/api/pick-folder')return {ok:true,path:'E:\\Synthetic Backup'};
  if(handlers[route])return handlers[route](body,state);
  if(route==='/api/work-data/hygiene')return {ok:true,inspection:state.inspection};
  if(route==='/api/work-data/hygiene/plan')return {ok:true,plan:state.plan};
  if(route==='/api/work-data/hygiene/quarantine')return {ok:true,result:{schema:1,moved:2,stamp:STAMP,areas:[{root:'',area:'quarantine-v1/'+STAMP,files:2}]}};
  if(route==='/api/work-data/hygiene/undo')return {ok:true,result:{schema:1,restored:2,kept:[],keptCount:0}};
  return status(state.statusExtra);
 });
 return {f,state};
}
const routes=(f,route)=>f.calls.filter(row=>row.route===route);
const tracked=(f,ids)=>{const focused=[];for(const id of ids)f.find(id).focus=()=>focused.push(id);return focused;};

test('U13: a plain root does not offer «switch to plain text», an encrypted root does not offer «turn on encryption», and an inapplicable choice falls back to export',async()=>{
 const {f}=hygieneFixture();await f.panel.refresh();
 const options=f.find('workDataOperation').children,by=value=>options.find(option=>option.value===value);
 assert.equal(by('disable').hidden,true);assert.equal(by('disable').disabled,true);assert.equal(by('enable').hidden,false);assert.equal(f.find('workDataOperation').value,'enable');
 f.panel.dispose();
 const {f:g}=hygieneFixture({}, {authority:authority('encrypted')});await g.panel.refresh();
 const encrypted=g.find('workDataOperation').children,pick=value=>encrypted.find(option=>option.value===value);
 assert.equal(pick('enable').hidden,true);assert.equal(pick('enable').disabled,true);assert.equal(pick('disable').hidden,false);
 assert.equal(g.find('workDataOperation').value,'export','the default «enable» is not offered on an encrypted root; the safe choice is export, never a mutation picked for the user');
 g.panel.dispose();
});

test('U13: a greyed-out submit says what is still missing, one reason at a time, and says nothing once it is enabled',async()=>{
 const {f}=hygieneFixture();await f.panel.refresh();const reason=()=>f.find('workDataSubmitReason');
 assert.equal(f.find('workDataSubmit').disabled,true);assert.equal(reason().hidden,false);assert.equal(reason().dataset.reason,'workData.reason.backup');assert.match(reason().textContent,/Choose folder/);
 assert.equal(f.find('workDataSubmit').getAttribute('aria-describedby'),'workDataSubmitReason');
 f.click('workDataPickBackup');await f.flush();assert.equal(reason().dataset.reason,'workData.reason.passwordShort');
 f.change('workDataPassword','a long private password');assert.equal(reason().dataset.reason,'workData.reason.passwordMismatch');
 f.change('workDataPasswordConfirm','a long private password');assert.equal(f.find('workDataSubmit').disabled,false);assert.equal(reason().hidden,true);assert.equal(reason().textContent,'');
 f.panel.dispose();
 const {f:g}=hygieneFixture({}, {authority:authority('encrypted')});await g.panel.refresh();
 g.change('workDataOperation','disable','change');g.click('workDataPickBackup');await g.flush();g.change('workDataPassword','a long private password');g.change('workDataPasswordConfirm','a long private password');
 assert.equal(g.find('workDataSubmitReason').dataset.reason,'workData.reason.confirmPlaintext');g.panel.dispose();
 const {f:h}=hygieneFixture({}, {job:job({state:'draining'})});await h.panel.refresh();
 assert.equal(h.find('workDataSubmitReason').dataset.reason,'workData.reason.busy','a running job is named as the reason');h.panel.dispose();
});

test('U13: the backup and restore-parent fields look read-only, say how to fill them, and open the folder picker when activated',async()=>{
 const {f}=hygieneFixture();await f.panel.refresh();const field=f.find('workDataBackupDirectory');
 assert.equal(field.readOnly,true);assert.match(field.className,/work-data-path/);assert.match(field.placeholder,/Choose folder/);
 assert.equal(field.getAttribute('aria-describedby'),'workDataBackupDirectoryHelp');assert.match(f.find('workDataBackupDirectoryHelp').textContent,/only through Choose folder/);
 f.click('workDataBackupDirectory');await f.flush();assert.equal(routes(f,'/api/pick-folder').length,1);assert.equal(field.value,'E:\\Synthetic Backup');
 field.dispatchEvent({type:'keydown',key:'Enter',preventDefault(){}});await f.flush();assert.equal(routes(f,'/api/pick-folder').length,2,'Enter on the field opens the same picker');
 assert.match(f.find('workDataRestoreParent').className,/work-data-path/);f.panel.dispose();
});

test('U13: the restore upload limit is written with fmtBytes, never as a bare byte count',async()=>{
 const {f}=hygieneFixture({}, {uploadMaxBytes:536870888,capabilities:{worker:true,upload:true,download:false}});await f.panel.refresh();
 f.change('workDataOperation','restore','change');const text=f.find('workDataRestoreFileHelp').textContent;
 assert.match(text,/no larger than 512\.0 MB\./);assert.doesNotMatch(text,/536870888/);
 f.language('zh-CN');assert.match(f.find('workDataRestoreFileHelp').textContent,/大小不超过 512\.0 MB。/);assert.doesNotMatch(f.find('workDataRestoreFileHelp').textContent,/字节/);f.panel.dispose();
});

test('S6: the over-budget advice claims the original data root was untouched only for a failed (not executed) job, never for an unconfirmed one',async()=>{
 const limit={kind:'files',maximum:'100000',areas:[]};
 for(const [state,claim] of [['failed',true],['uncertain',false]]){
  const j=job({state,cancellable:false,takeover:true,error:'work_data_setup.preparation_failed',reason:'work_data_tree.preserved_native_engineering_limit',limitDetail:limit});
  const f=fixture(route=>route.includes('/jobs/')?{ok:true,job:j}:status({maintenance:{phase:'retired',accepting:false},capabilities:{worker:false,upload:false,download:false},job:j}));
  await f.panel.refresh();const text=f.find('workDataProgress').textContent;
  assert.equal(/were not changed/.test(text),claim,state);assert.match(text,/about 1\.4x/,state);
  if(!claim)assert.match(text,/not confirmed yet/,state);
  f.language('zh-CN');assert.equal(/没有被改动/.test(f.find('workDataProgress').textContent),claim,state+' zh');f.panel.dispose();
 }
});

test('inspect is an explicit read-only action: one GET, then the size, the largest areas, the prediction, each verdict with its paths, and a read-only receipt',async()=>{
 const {f}=hygieneFixture();await f.panel.refresh();
 assert.equal(routes(f,'/api/work-data/hygiene').length,0,'opening the panel does not walk the data root');
 assert.match(f.find('workDataHygiene').textContent,/only reads file information; it does not change, move or delete any file/);
 f.click('workDataHygieneInspect');await f.flush();
 assert.equal(routes(f,'/api/work-data/hygiene').length,1);assert.equal(f.calls.filter(row=>row.method!=='GET'&&row.route!=='/api/pick-folder').length,0,'inspection never writes');
 const result=f.find('workDataHygieneResult').textContent;
 assert.match(f.find('workDataHygieneSummary').textContent,/1,234 files and 56 folders, 5\.0 MB in total/);
 assert.match(result,/310 files \(2\.0 MB\) go into a recovery package/);
 assert.match(f.find('workDataHygieneAreas').textContent,/webcache: 900 files, 3\.0 MB/);
 assert.equal(f.find('workDataHygienePrediction').dataset.state,'ok');assert.match(f.find('workDataHygienePrediction').textContent,/turning on encryption or exporting .* is expected to work\. The check made during the operation decides/);
 const verdict=f.find('workDataHygieneVerdicts').children[0];
 assert.equal(verdict.dataset.code,'work_data_hygiene.leftovers_present');assert.equal(verdict.dataset.severity,'advice');
 assert.match(verdict.textContent,/2 files, 3\.0 KB\. Where: sessions\/a\.json\.corrupt; config\.json\.4321\.0123abcd\.tmp/);
 assert.match(f.find('workDataHygieneReadOnly').textContent,/read-only check.*no file was changed, moved or deleted/);
 assert.equal(f.find('workDataHygieneQuarantine').hidden,false,'a quarantine verdict offers the move action');
 f.language('zh-CN');assert.match(f.find('workDataHygieneSummary').textContent,/共有 1,234 个文件、56 个文件夹，合计 5\.0 MB/);f.panel.dispose();
});

test('a blocking inspection predicts a refusal per current mode, names each limit with fmtBytes and drops unknown or forged verdicts',async()=>{
 const blocked=inspection({ok:false,verdicts:[
  {code:'work_data_hygiene.census_bytes_exceeded',severity:'blocking',action:'reduce',params:{actual:200*1048576,limit:120*1048576,largest:[]}},
  {code:'work_data_hygiene.aliases_present',severity:'blocking',action:'replace-alias',params:{count:1,paths:['linked']}},
  {code:'work_data_hygiene.evil',severity:'blocking',action:'reduce',params:{}},{code:'other.code',severity:'advice',params:{}}]});
 const {f,state}=hygieneFixture({}, {authority:authority('encrypted')});state.inspection=blocked;await f.panel.refresh();
 f.click('workDataHygieneInspect');await f.flush();
 assert.equal(f.find('workDataHygienePrediction').dataset.state,'blocked');assert.match(f.find('workDataHygienePrediction').textContent,/switching to plain text and exporting are expected to be refused/);
 const rows=f.find('workDataHygieneVerdicts').children;assert.equal(rows.length,2,'unknown codes are not shown');
 assert.match(rows[0].textContent,/File contents total 200\.0 MB, more than the limit \(120\.0 MB\)/);assert.equal(rows[0].dataset.severity,'blocking');
 assert.match(rows[1].textContent,/1 symbolic links or junctions.*Where: linked/);
 assert.equal(f.find('workDataHygieneQuarantine').hidden,true,'nothing to move, no move action');f.panel.dispose();
});

test('quarantine: plan lists every file, Back and Escape send nothing and return focus, confirm sends one token-bound POST, then a read-only re-check',async()=>{
 const {f}=hygieneFixture();await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();
 const focused=tracked(f,['workDataHygieneBack','workDataHygieneQuarantine','workDataHygieneNotice']);
 f.click('workDataHygieneQuarantine');await f.flush();
 assert.equal(routes(f,'/api/work-data/hygiene/plan').length,1);const box=f.find('workDataHygieneConfirm');
 assert.equal(box.hidden,false);assert.equal(box.getAttribute('role'),'alertdialog');assert.deepEqual(focused,['workDataHygieneBack'],'focus lands on Back so a held Enter cannot confirm');
 assert.match(f.find('workDataHygieneConfirmTitle').textContent,/Move these 2 files \(3\.0 KB in total\) to quarantine\?/);
 const files=f.find('workDataHygieneFiles').children.map(row=>row.textContent);
 assert.deepEqual(files,['sessions/a.json.corrupt (1.0 KB, copy of a broken file)','config.json.4321.0123abcd.tmp (2.0 KB, unfinished temporary file)']);
 assert.match(f.find('workDataHygieneConfirmBody').textContent,/nothing is deleted.*undo this at any time/);
 assert.match(f.find('workDataHygieneMore').textContent,/1 leftovers will not be moved this time: the process writing it is still running/);
 assert.equal(f.find('workDataHygieneInspect').disabled,true,'no second action while the question is open');
 let propagated=false;box.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){},stopPropagation(){propagated=true;}});
 assert.equal(box.hidden,true);assert.equal(propagated,true,'Escape is kept from closing the whole settings dialog');assert.deepEqual(focused,['workDataHygieneBack','workDataHygieneQuarantine']);
 assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);
 f.click('workDataHygieneQuarantine');await f.flush();f.click('workDataHygieneBack');assert.equal(box.hidden,true);assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);
 f.click('workDataHygieneQuarantine');await f.flush();f.click('workDataHygieneGo');f.click('workDataHygieneGo');await f.flush();
 const posts=routes(f,'/api/work-data/hygiene/quarantine');assert.equal(posts.length,1,'a double click sends one move');
 assert.deepEqual(posts[0].body,{token:'f'.repeat(64),expectedAuthority:authority()});assert.equal(posts[0].noTokenReplay,true);assert.equal(posts[0].method,'POST');
 assert.match(f.find('workDataHygieneNotice').textContent,/Moved 2 files into the quarantine area inside the data root \(quarantine-v1\/2026-.*\)\. Nothing was deleted/);
 assert.equal(f.find('workDataHygieneNotice').dataset.state,'ok');assert.equal(routes(f,'/api/work-data/hygiene').length,2,'the list is re-read (read-only) after the move');
 assert.equal(focused.at(-1),'workDataHygieneNotice');f.panel.dispose();
});

test('a plan with nothing movable opens no confirmation and says nothing was moved and why',async()=>{
 const {f,state}=hygieneFixture();state.plan=plan({files:0,bytes:0,items:[],roots:[],skipped:[{path:'a.corrupt',reason:'too-recent'}],skippedCount:1});
 await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();f.click('workDataHygieneQuarantine');await f.flush();
 assert.equal(f.find('workDataHygieneConfirm').hidden,true);assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);
 assert.match(f.find('workDataHygieneNotice').textContent,/nothing was moved\. 1 leftovers will not be moved this time: changed within the last two minutes/);f.panel.dispose();
});

test('each failure says whether files moved: refused before moving, stuck in quarantine, unknown, or a read-only check',async()=>{
 const scenario=async(route,error)=>{const {f}=hygieneFixture({[route]:()=>{throw error;}});await f.panel.refresh();
  if(route!=='/api/work-data/hygiene'){f.click('workDataHygieneInspect');await f.flush();}
  if(route==='/api/work-data/hygiene')f.click('workDataHygieneInspect');else{f.click('workDataHygieneQuarantine');await f.flush();if(route.endsWith('/quarantine'))f.click('workDataHygieneGo');}
  await f.flush();const text=f.find('workDataHygieneNotice').textContent;f.panel.dispose();return text;};
 assert.match(await scenario('/api/work-data/hygiene/quarantine',{code:'work_data_hygiene.plan_changed',status:409}),/changed after you confirmed.*\(work_data_hygiene\.plan_changed\) No file was moved this time\./);
 assert.match(await scenario('/api/work-data/hygiene/quarantine',{code:'work_data_hygiene.quarantine_recovery_required',status:409}),/Some files could not be moved back and are still in quarantine/);
 for(const error of [{code:'work_data_hygiene.operation_failed',status:500},{code:'work_data_setup.status_invalid'},{name:'TypeError'}])
  assert.match(await scenario('/api/work-data/hygiene/quarantine',error),/It is not confirmed whether files were moved/,JSON.stringify(error));
 assert.match(await scenario('/api/work-data/hygiene/quarantine',{code:'work_data_setup.busy',status:409}),/No file was moved this time/);
 assert.match(await scenario('/api/work-data/hygiene',{code:'work_data_hygiene.inventory_truncated',status:409}),/more files and folders than the check can list.*The check is read-only; no file was changed\./);
 assert.match(await scenario('/api/work-data/hygiene/plan',{code:'work_data_hygiene.operation_failed',status:500}),/The check is read-only; no file was changed\./);
});

test('undo: each quarantine area that still holds moved files offers Undo; it sends stamp, root and authority once and reports kept files',async()=>{
 const {f,state}=hygieneFixture({'/api/work-data/hygiene/undo':body=>({ok:true,result:{schema:1,restored:1,kept:['sessions/b.json.corrupt'],keptCount:1}})});
 state.inspection=inspection({verdicts:[],quarantine:[{root:'',stamp:STAMP,state:'moved',plaintext:0},{root:'.work-data/generations/'+'b'.repeat(48),stamp:STAMP,state:'restored',plaintext:0},
  {root:'',stamp:'2026-11-19T01-02-03-004Z-0123abcd',state:'partial',plaintext:2}]});
 await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();
 const rows=f.find('workDataHygieneAreasQuarantine').children;assert.equal(rows.length,3);
 assert.match(rows[0].textContent,/quarantine-v1\/2026-11-20T01-02-03-004Z-0123abcd \(moved\)Undo: move back/);
 assert.match(rows[1].textContent,/\(undone\)$/,'an undone area has no Undo');assert.match(rows[2].textContent,/2 of them are old plaintext copies, still stored as plain text/);
 assert.equal(f.find('workDataHygieneClean').textContent.length>0,true);
 f.click('workDataHygieneUndo0');f.click('workDataHygieneUndo0');await f.flush();
 const posts=routes(f,'/api/work-data/hygiene/undo');assert.equal(posts.length,1);assert.deepEqual(posts[0].body,{stamp:STAMP,root:'',expectedAuthority:authority()});assert.equal(posts[0].noTokenReplay,true);
 assert.match(f.find('workDataHygieneNotice').textContent,/Moved 1 files back.*1 files were not moved back .* stay in quarantine\. Where: sessions\/b\.json\.corrupt/);
 assert.equal(routes(f,'/api/work-data/hygiene').length,2);f.panel.dispose();
});

test('hygiene is unavailable while maintenance runs: buttons disabled with the reason, and an open confirmation closes with focus on a visible element',async()=>{
 const {f,state}=hygieneFixture();await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();f.click('workDataHygieneQuarantine');await f.flush();
 const focused=tracked(f,['workDataHygieneNotice']);f.setActive('workDataHygieneGo');
 state.statusExtra={job:job({state:'draining'})};await f.panel.refresh();await f.flush();
 assert.equal(f.find('workDataHygieneConfirm').hidden,true,'a job seen by the refresh closes the move question');assert.deepEqual(focused,['workDataHygieneNotice']);
 for(const id of ['workDataHygieneInspect','workDataHygieneQuarantine'])assert.equal(f.find(id).disabled,true,id);
 assert.equal(f.find('workDataHygieneReason').dataset.reason,'workData.hygiene.blockedMaintenance');
 f.click('workDataHygieneInspect');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene').length,1,'no request while maintenance runs');
 assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);f.panel.dispose();
 const {f:g}=hygieneFixture({}, {maintenance:{phase:'retired',accepting:false},capabilities:{worker:false,upload:false,download:false}});await g.panel.refresh();
 assert.equal(g.find('workDataHygieneInspect').disabled,true,'the cold maintenance service never gets a hygiene request');g.panel.dispose();
});

test('a changed authority drops the old inspection instead of describing the new root with it',async()=>{
 const {f,state}=hygieneFixture();await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();assert.equal(f.find('workDataHygieneResult').hidden,false);
 state.statusExtra={authority:authority('encrypted')};await f.panel.refresh();
 assert.equal(f.find('workDataHygieneResult').hidden,true);assert.equal(f.find('workDataHygieneQuarantine').hidden,true);f.panel.dispose();
});

// ── 3G v2：审查补的守卫 ──
const openMove=async f=>{await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();f.click('workDataHygieneQuarantine');await f.flush();assert.equal(f.find('workDataHygieneConfirm').hidden,false,'the move question is open');};
const directClick=(f,id)=>f.find(id).dispatchEvent({type:'click',defaultPrevented:false,preventDefault(){}});

test('F1: an authority change while the move question is open closes it, sends nothing and moves focus to the notice',async()=>{
 const {f,state}=hygieneFixture();await openMove(f);const focused=tracked(f,['workDataHygieneNotice']);f.setActive('workDataHygieneBack');
 state.statusExtra={authority:authority('encrypted')};await f.panel.refresh();await f.flush();
 assert.equal(f.find('workDataHygieneConfirm').hidden,true,'a plan made for the old root is not offered for the new one');
 assert.deepEqual(focused,['workDataHygieneNotice']);
 directClick(f,'workDataHygieneGo');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);f.panel.dispose();
});

test('F6 + v2: a background status read keeps the open question, greys «Move them» meanwhile, and a click during the read sends nothing',async()=>{
 let hold=null;const {f}=hygieneFixture({'/api/work-data/status':(_body,state)=>hold?hold.promise.then(()=>status(state.statusExtra)):status(state.statusExtra)});
 await openMove(f);
 hold=deferred();const reading=f.panel.refresh();await f.flush();
 assert.equal(f.find('workDataHygieneConfirm').hidden,false,'a routine refresh does not take the question away');
 assert.equal(f.find('workDataHygieneGo').disabled,true,'but the confirm button waits for the read');
 directClick(f,'workDataHygieneGo');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0,'confirmQuarantine refuses while the status read is in flight');
 hold.resolve();await reading;await f.flush();hold=null;
 assert.equal(f.find('workDataHygieneConfirm').hidden,false);assert.equal(f.find('workDataHygieneGo').disabled,false);
 f.click('workDataHygieneGo');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,1);f.panel.dispose();
});

test('v2: the move is confirmed against the authority the plan was made for; a root change during planning opens no question',async()=>{
 const {f}=hygieneFixture();await openMove(f);f.click('workDataHygieneGo');await f.flush();
 assert.deepEqual(routes(f,'/api/work-data/hygiene/quarantine')[0].body.expectedAuthority,authority(),'the plan-time authority is sent');f.panel.dispose();
 let g=null;const fx=hygieneFixture({'/api/work-data/hygiene/plan':async(_body,state)=>{state.statusExtra={authority:authority('encrypted')};await g.panel.refresh();return {ok:true,plan:state.plan};}});g=fx.f;
 await g.panel.refresh();g.click('workDataHygieneInspect');await g.flush();g.click('workDataHygieneQuarantine');await g.flush();
 assert.equal(g.find('workDataHygieneConfirm').hidden,true,'a plan computed for the old root is dropped');
 assert.match(g.find('workDataHygieneNotice').textContent,/work_data_setup\.authority_changed.*The check is read-only; no file was changed\./);
 assert.equal(routes(g,'/api/work-data/hygiene/quarantine').length,0);g.panel.dispose();
});

test('F9 + F10: once a maintenance job starts, Undo turns grey and even a forced click sends nothing',async()=>{
 const {f,state}=hygieneFixture();state.inspection=inspection({verdicts:[],quarantine:[{root:'',stamp:STAMP,state:'moved',plaintext:0}]});
 await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();assert.equal(f.find('workDataHygieneUndo0').disabled,false);
 state.statusExtra={job:job({state:'draining'})};await f.panel.refresh();await f.flush();
 assert.equal(f.find('workDataHygieneUndo0').disabled,true,'Undo is disabled while maintenance runs');
 directClick(f,'workDataHygieneUndo0');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene/undo').length,0,'undoArea itself refuses');f.panel.dispose();
});

// v3：清单回包时恰好在后台读状态 —— 用延迟的计划与延迟的状态读两把闸把时序摆出来。
function heldFixture(handlers={}){
 let hold=null;const planGate=deferred();
 const fx=hygieneFixture({'/api/work-data/status':(_body,state)=>hold?hold.promise.then(()=>status(state.statusExtra)):status(state.statusExtra),
  '/api/work-data/hygiene/plan':(_body,state)=>planGate.promise.then(()=>({ok:true,plan:state.plan})),...handlers});
 return {...fx,planGate,hold:()=>{hold=deferred();return hold;},release:()=>{const h=hold;hold=null;h.resolve();}};
}
// 返回 {reading}：直接返回挂着的 promise 会被 await 拆开、一直等到状态读放行。
const openDuringRead=async fx=>{
 const {f,planGate}=fx;await f.panel.refresh();f.click('workDataHygieneInspect');await f.flush();
 f.click('workDataHygieneQuarantine');await f.flush();
 fx.hold();const reading=f.panel.refresh();await f.flush();
 planGate.resolve();await f.flush();return {reading};
};

test('v3: a plan that arrives during a background status read still opens the question; «Move them» waits for the read',async()=>{
 const fx=heldFixture(),{f}=fx;const focused=tracked(f,['workDataHygieneBack']);
 const {reading}=await openDuringRead(fx);
 assert.equal(f.find('workDataHygieneConfirm').hidden,false,'the plan is not silently dropped');assert.deepEqual(focused,['workDataHygieneBack']);
 assert.equal(f.find('workDataHygieneFiles').children.length,2);assert.equal(f.find('workDataHygieneGo').disabled,true,'confirming waits for the status read');
 directClick(f,'workDataHygieneGo');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);
 fx.release();await reading;await f.flush();
 assert.equal(f.find('workDataHygieneConfirm').hidden,false);assert.equal(f.find('workDataHygieneGo').disabled,false);
 f.click('workDataHygieneGo');await f.flush();const posts=routes(f,'/api/work-data/hygiene/quarantine');
 assert.equal(posts.length,1);assert.deepEqual(posts[0].body.expectedAuthority,authority());f.panel.dispose();
});

test('v3: opened during a read whose answer shows a new root, the question closes and nothing is sent',async()=>{
 const fx=heldFixture(),{f,state}=fx;const {reading}=await openDuringRead(fx);
 assert.equal(f.find('workDataHygieneConfirm').hidden,false);
 state.statusExtra={authority:authority('encrypted')};fx.release();await reading;await f.flush();
 assert.equal(f.find('workDataHygieneConfirm').hidden,true,'renderHygiene drops a plan made for the old root');
 directClick(f,'workDataHygieneGo');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);f.panel.dispose();
});

test('v3: opened during a read, then the service reports the root changed: the plan-time authority was sent and the panel says nothing moved',async()=>{
 const fx=heldFixture({'/api/work-data/hygiene/quarantine':()=>{throw {code:'work_data_setup.authority_changed',status:409};}}),{f}=fx;
 const {reading}=await openDuringRead(fx);fx.release();await reading;await f.flush();
 f.click('workDataHygieneGo');await f.flush();
 const posts=routes(f,'/api/work-data/hygiene/quarantine');assert.equal(posts.length,1);assert.deepEqual(posts[0].body.expectedAuthority,authority(),'the authority recorded when the plan was requested');
 const notice=f.find('workDataHygieneNotice').textContent;
 assert.match(notice,/work_data_setup\.authority_changed/);assert.match(notice,/No file was moved this time\./);assert.doesNotMatch(notice,/not confirmed whether|Moved \d/);
 assert.equal(f.find('workDataHygieneNotice').dataset.state,'error');f.panel.dispose();
});

test('v3: opening the enable-encryption question closes the move question and a forced «Move them» sends nothing',async()=>{
 // Fill the form first: the folder picker itself is a held state (it closes an open move question by design).
 const {f}=hygieneFixture();await f.panel.refresh();
 f.click('workDataPickBackup');await f.flush();f.change('workDataPassword','a long private password');f.change('workDataPasswordConfirm','a long private password');
 await openMove(f);
 f.change('workDataPassword','a long private password!');f.change('workDataPasswordConfirm','a long private password!');
 assert.equal(f.find('workDataHygieneConfirm').hidden,false,'typing in the form keeps the move question');
 f.click('workDataSubmit');assert.equal(f.find('workDataConfirm').hidden,false,'the enable question is open');
 assert.equal(f.find('workDataHygieneConfirm').hidden,true,'two questions are never open at once');
 directClick(f,'workDataHygieneGo');await f.flush();assert.equal(routes(f,'/api/work-data/hygiene/quarantine').length,0);
 assert.equal(routes(f,'/api/work-data/jobs').length,0);f.panel.dispose();
});

test('F11: any other 4xx refusal of a move (not a hygiene code) is reported as nothing moved',async()=>{
 const {f}=hygieneFixture({'/api/work-data/hygiene/quarantine':()=>{throw {code:'api.body_too_large',status:413};}});await openMove(f);
 f.click('workDataHygieneGo');await f.flush();
 assert.match(f.find('workDataHygieneNotice').textContent,/No file was moved this time\./);assert.doesNotMatch(f.find('workDataHygieneNotice').textContent,/not confirmed whether/);f.panel.dispose();
});
