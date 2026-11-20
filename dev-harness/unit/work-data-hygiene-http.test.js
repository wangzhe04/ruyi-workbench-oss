'use strict';
// 151 阶段 3G(150 W3/W4):数据根体检与残留隔离的 HTTP 入口(13ah)。01ac 自己不持闸,这些测试钉住调用方替它持的那些:
// 与维护作业互斥、走维护闸门(run('http'),之后的作业 drain 会等它)、同一数据根按 runKeyedChain 串行、只用规范数据根、
// 写操作带 expectedAuthority、意外错误换成稳定码且不带路径。引擎用真的 01ac(在隔离临时根上),只有排队/互斥两条用桩。
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {constBlock,functionBlock}=require('../lib/source-slice');
const src=path.resolve(__dirname,'../../ruyi-workbench/app/src'),read=name=>fs.readFileSync(path.join(src,name),'utf8');
const Ownership=vm.runInNewContext(constBlock(read('01g-server-ownership.js'),'ServerOwnership')+'\nServerOwnership',{require,Buffer,process});
function loadHygiene(){
 const context=vm.createContext({Buffer,process,require,console,TextDecoder,fsp,fs,path,crypto});
 vm.runInContext(functionBlock(read('01-config.js'),'atomicWriteJson'),context);
 vm.runInContext(['01t-work-data-recovery.js','01aa-work-data-tree.js','01ac-work-data-root-hygiene.js'].map(read).join('\n'),context);
 return vm.runInContext('WorkDataRootHygiene',context);
}
function loadSetup({chain=true}={}){
 const context=vm.createContext({require,Buffer,AbortController,Promise,Set,Map,WeakMap,Object,Error,TypeError,process,setTimeout,clearTimeout,WorkDataRecovery:{LIMITS:{serialized:1048576}}});
 if(chain)vm.runInContext(functionBlock(read('00-boot.js'),'runKeyedChain'),context);
 const Setup=vm.runInContext(constBlock(read('13ah-work-data-setup.js'),'WorkDataSetup')+'\nWorkDataSetup',context);
 const Maintenance=vm.runInContext(constBlock(read('13ag-work-data-maintenance.js'),'WorkDataMaintenance')+'\nWorkDataMaintenance',context);
 return {Setup,Maintenance};
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const tick=()=>new Promise(setImmediate),until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await tick();}throw Error('condition did not settle');};
const plainAuthority={generation:0,id:null,mode:'plain',sha256:null};
const request=(body,method='POST')=>{const bytes=Buffer.from(typeof body==='string'?body:JSON.stringify(body));return{method,async *[Symbol.asyncIterator](){yield bytes;}};};
async function tempBase(t,name){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-hygiene-http-'+name+'-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 return Ownership.canonicalRoot(root);
}
const put=async(base,relative,bytes,old=true)=>{const file=path.join(base,...relative.split('/'));await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file,bytes);
 if(old){const past=new Date(Date.now()-3600000);fs.utimesSync(file,past,past);}return file;};
function fixture({base,engine,chain=true,hygieneBase,authority=plainAuthority}={}){
 const {Setup,Maintenance}=loadSetup({chain});let counter=0,response;const queue=[],events=[];
 const m=Maintenance.create({owns:()=>false,snapshot:()=>({busy:{},pending:[],dirty:0}),pause:()=>({}),resume:()=>{},progress:async()=>{},flush:async()=>{},yield:tick});
 const handle={ready:new Promise(()=>{}),cancel:async()=>{events.push('cancel-child');},handoff:async()=>{}};
 const worker={start:async()=>{events.push('start');return handle;}};
 const host={maintenance:m,inspect:async()=>({authority:{...authority},base,configMirror:false,experimentalEncryption:true}),validateDirectories:async()=>{},worker:()=>worker,id:()=>String(++counter).padStart(48,'a'),now:()=>'',
  defer:work=>queue.push(work),respond:(_res,body,status)=>{response={body,status};},receiptPath:()=>false,receiptOwner:()=>null,
  ...(engine===null?{}:{hygiene:engine||loadHygiene()}),...(hygieneBase?{hygieneBase}:{hygieneBase:async()=>base})};
 const api=Setup.create(host);
 const call=async(pathname,body,method)=>{response=null;const handled=await api.handle(body===undefined?{method:method||'GET'}:request(body,method),{},pathname);assert.equal(handled,true);return response;};
 return {api,m,host,events,queue,call,start:()=>queue.shift()()};
}
const codeOf=promise=>promise.then(()=>assert.fail('expected a refusal'),error=>({code:error.apiCode||error.code,status:error.statusCode,message:String(error.message)}));

test('inspect is read-only on the canonical base and returns the 01ac schema; plan, confirm-by-token quarantine and undo round-trip the bytes',async t=>{
 const base=await tempBase(t,'roundtrip');
 await put(base,'sessions/sess_a.json','{"id":"sess_a"}');const leftover=await put(base,'sessions/sess_b.json.corrupt','BROKEN');
 const f=fixture({base}),before=fs.readdirSync(base).sort();
 const inspected=await f.call('/api/work-data/hygiene');
 assert.equal(inspected.status,200);assert.equal(inspected.body.ok,true);assert.equal(inspected.body.inspection.schema,1);
 assert.deepEqual(JSON.parse(JSON.stringify(inspected.body.inspection.verdicts.map(row=>row.code))),['work_data_hygiene.leftovers_present']);
 assert.deepEqual(fs.readdirSync(base).sort(),before,'inspect created, moved or removed nothing');assert.equal(fs.existsSync(leftover),true);
 const planned=await f.call('/api/work-data/hygiene/plan');const plan=planned.body.plan;
 assert.equal(plan.files,1);assert.match(plan.token,/^[a-f0-9]{64}$/);assert.deepEqual(JSON.parse(JSON.stringify(plan.items.map(row=>row.path))),['sessions/sess_b.json.corrupt']);
 assert.equal(plan.itemsTruncated,false);assert.equal(plan.skippedCount,0);assert.equal(fs.existsSync(leftover),true,'planning moves nothing');
 const moved=await f.call('/api/work-data/hygiene/quarantine',{token:plan.token,expectedAuthority:plainAuthority});
 assert.equal(moved.body.result.moved,1);assert.equal(fs.existsSync(leftover),false);
 const area=moved.body.result.areas[0].area;assert.match(area,/^quarantine-v1\/\d{4}-/);
 assert.equal(fs.readFileSync(path.join(base,...area.split('/'),'data','sessions','sess_b.json.corrupt'),'utf8'),'BROKEN','same root, same bytes');
 // A replayed confirmation is bound to the plan it confirmed.
 assert.equal((await codeOf(f.call('/api/work-data/hygiene/quarantine',{token:plan.token,expectedAuthority:plainAuthority}))).code,'work_data_hygiene.plan_changed');
 const listed=(await f.call('/api/work-data/hygiene')).body.inspection.quarantine;assert.deepEqual(JSON.parse(JSON.stringify(listed.map(row=>row.state))),['moved']);
 const undone=await f.call('/api/work-data/hygiene/undo',{stamp:moved.body.result.stamp,root:'',expectedAuthority:plainAuthority});
 assert.equal(undone.body.result.restored,1);assert.equal(undone.body.result.keptCount,0);assert.equal(fs.readFileSync(leftover,'utf8'),'BROKEN');
});

test('requests are bounded and fail closed: shape, stale authority, a base that is not the canonical data root, missing engine or chain',async t=>{
 const base=await tempBase(t,'refusals');await put(base,'sessions/a.json.corrupt','A');
 const f=fixture({base});
 for(const body of [{token:'x',expectedAuthority:plainAuthority},{token:'a'.repeat(64)},{token:'a'.repeat(64),expectedAuthority:plainAuthority,extra:1}])
  assert.deepEqual(await codeOf(f.call('/api/work-data/hygiene/quarantine',body)),{code:'work_data_setup.request_invalid',status:400,message:'work_data_setup.request_invalid'},JSON.stringify(body));
 assert.equal((await codeOf(f.call('/api/work-data/hygiene/undo',{stamp:'x'.repeat(65),root:'',expectedAuthority:plainAuthority}))).code,'work_data_setup.request_invalid');
 const badStamp=await codeOf(f.call('/api/work-data/hygiene/undo',{stamp:'../x',root:'',expectedAuthority:plainAuthority}));
 assert.equal(badStamp.code,'work_data_hygiene.request_invalid','the engine validates the stamp');assert.equal(badStamp.status,400,'a malformed request is a 400, not the engine\'s blanket 409');
 const encrypted={generation:1,id:'b'.repeat(48),mode:'encrypted',sha256:'c'.repeat(64)};
 assert.equal((await codeOf(f.call('/api/work-data/hygiene/quarantine',{token:'a'.repeat(64),expectedAuthority:encrypted}))).code,'work_data_setup.authority_changed');
 const other=fixture({base,hygieneBase:async()=>base+'-elsewhere'});
 assert.deepEqual(await codeOf(other.call('/api/work-data/hygiene')),{code:'work_data_setup.root_unavailable',status:503,message:'work_data_setup.root_unavailable'});
 assert.equal((await codeOf(fixture({base,engine:null}).call('/api/work-data/hygiene'))).code,'work_data_hygiene.unavailable');
 assert.equal((await codeOf(fixture({base,chain:false}).call('/api/work-data/hygiene'))).code,'work_data_hygiene.unavailable','no per-root chain, no hygiene');
 assert.equal(fs.existsSync(path.join(base,'sessions','a.json.corrupt')),true,'no refusal moved anything');
});

test('engine refusals keep their stable code; anything else becomes operation_failed without the raw message or path',async t=>{
 const base=await tempBase(t,'errors');
 const raw=Object.assign(Error("EPERM: operation not permitted, rename '"+base+"\\sessions\\x.corrupt'"),{code:'EPERM'});
 const engine={inspect:async()=>{throw raw;},planQuarantine:async()=>{throw Object.assign(Error('work_data_hygiene.inventory_truncated'),{code:'work_data_hygiene.inventory_truncated',statusCode:409,params:{paths:['secret']}});},
  quarantine:async()=>assert.fail('the write routes have their own raw-error case (v3)'),undoQuarantine:async()=>{throw Object.assign(Error('work_data_hygiene.base_unavailable'),{code:'work_data_hygiene.base_unavailable',statusCode:409});}};
 const f=fixture({base,engine});
 const failed=await codeOf(f.call('/api/work-data/hygiene'));
 assert.deepEqual(failed,{code:'work_data_hygiene.operation_failed',status:500,message:'work_data_hygiene.operation_failed'});
 const truncated=await codeOf(f.call('/api/work-data/hygiene/plan'));assert.equal(truncated.code,'work_data_hygiene.inventory_truncated');assert.equal(truncated.status,409);
 const unavailable=await codeOf(f.call('/api/work-data/hygiene/undo',{stamp:'2026-01-01T00-00-00-000Z-00000000',root:'',expectedAuthority:plainAuthority}));
 assert.equal(unavailable.code,'work_data_hygiene.base_unavailable');assert.equal(unavailable.status,503,'an unreachable data root is a 503');
});

test('v3: raw errors from the write routes (quarantine, undo) become operation_failed/500 with no path in the response',async t=>{
 const base=await tempBase(t,'raw-writes');
 const raw=()=>Object.assign(Error("EPERM: operation not permitted, rename '"+path.join(base,'sessions','x.json.corrupt')+"'"),{code:'EPERM',path:path.join(base,'sessions','x.json.corrupt')});
 const engine={inspect:async()=>({schema:1}),planQuarantine:async()=>({}),quarantine:async()=>{throw raw();},undoQuarantine:async()=>{throw raw();}};
 const f=fixture({base,engine});
 for(const [route,body] of [['/api/work-data/hygiene/quarantine',{token:'a'.repeat(64),expectedAuthority:plainAuthority}],['/api/work-data/hygiene/undo',{stamp:'2026-01-01T00-00-00-000Z-00000000',root:'',expectedAuthority:plainAuthority}]]){
  const error=await f.api.handle(request(body),{},route).then(()=>null,value=>value);
  assert.ok(error,route+' refuses');
  assert.deepEqual({code:error.apiCode,status:error.statusCode,message:error.message},{code:'work_data_hygiene.operation_failed',status:500,message:'work_data_hygiene.operation_failed'},route);
  const wire=JSON.stringify({...error,message:error.message,stack:undefined});
  assert.ok(!wire.includes(base)&&!wire.includes('EPERM')&&!wire.includes('x.json.corrupt'),route+' carries no path, errno or file name: '+wire);
 }
});

test('a read queued behind another read re-checks after a maintenance job was admitted while it waited',async t=>{
 const base=await tempBase(t,'queued-read');const gate=deferred(),entered=deferred();let inspects=0,plans=0;
 const engine={inspect:async()=>{inspects++;entered.resolve();await gate.promise;return {schema:1};},
  planQuarantine:async()=>{plans++;return {schema:1,token:'a'.repeat(64),files:0,bytes:0,roots:[],items:[],skipped:[]};},quarantine:async()=>assert.fail('no move'),undoQuarantine:async()=>assert.fail('no undo')};
 const f=fixture({base,engine});f.host.respond=()=>{};
 const a=f.api.handle({method:'GET'},{},'/api/work-data/hygiene');await entered.promise;
 const b=f.api.handle({method:'GET'},{},'/api/work-data/hygiene/plan').then(()=>'served',error=>error.apiCode);
 for(let i=0;i<5;i++)await tick();
 // A read in flight does not block intake (only moves do): the job is admitted while B waits in the chain.
 const job=await f.api.submit({operation:'enable',password:'synthetic hygiene password',expectedAuthority:plainAuthority,backupDirectory:'C:/synthetic/backups'});
 assert.equal(job.state,'queued');
 gate.resolve();await a;
 assert.equal(await b,'work_data_setup.busy','the queued plan read sees the admitted job and refuses');assert.equal(plans,0,'the engine never ran for it');
 await f.api.cancel(job.id);
});

test('desktop close: a move queued in the chain is refused without touching files, and later requests are refused before any IO',async t=>{
 const base=await tempBase(t,'desktop-close');const leftover=await put(base,'sessions/a.json.corrupt','A');
 const gate=deferred(),entered=deferred(),real=loadHygiene();let inspects=0,moves=0;
 const engine={...real,inspect:async input=>{inspects++;if(inspects===1){entered.resolve();await gate.promise;}return real.inspect(input);},quarantine:async input=>{moves++;return real.quarantine(input);}};
 const f=fixture({base,engine});f.host.respond=()=>{};
 const plan=await real.planQuarantine({base});
 const a=f.api.handle({method:'GET'},{},'/api/work-data/hygiene');await entered.promise;
 const queued=f.api.handle(request({token:plan.token,expectedAuthority:plainAuthority}),{},'/api/work-data/hygiene/quarantine').then(()=>'served',error=>error.apiCode);
 for(let i=0;i<5;i++)await tick();
 assert.equal(await f.api.closeForDesktop(),true);
 gate.resolve();await a;
 assert.equal(await queued,'work_data_setup.busy','the queued move is refused once the desktop is closing');
 assert.equal(moves,0);assert.equal(fs.readFileSync(leftover,'utf8'),'A','the leftover stays where it was');
 assert.equal(fs.existsSync(path.join(base,'quarantine-v1')),false,'no quarantine area was created');
 let reads=0;const inspect=f.host.inspect;f.host.inspect=async()=>{reads++;return inspect();};
 assert.equal((await codeOf(f.call('/api/work-data/hygiene'))).code,'work_data_setup.busy');
 assert.equal(reads,0,'a request after the close is refused at admission, before reading the authority');
});

test('mutual exclusion: no hygiene while a maintenance job is admitted or intake is closed; no job while a move runs',async t=>{
 const base=await tempBase(t,'exclusion');await put(base,'sessions/a.json.corrupt','A');
 const f=fixture({base});
 const job=await f.api.submit({operation:'enable',password:'synthetic hygiene password',expectedAuthority:plainAuthority,backupDirectory:'C:/synthetic/backups'});
 for(const [route,body] of [['/api/work-data/hygiene'],['/api/work-data/hygiene/plan'],['/api/work-data/hygiene/quarantine',{token:'a'.repeat(64),expectedAuthority:plainAuthority}],['/api/work-data/hygiene/undo',{stamp:'2026-01-01T00-00-00-000Z-00000000',root:'',expectedAuthority:plainAuthority}]])
  assert.equal((await codeOf(f.call(route,body))).code,'work_data_setup.busy',route+' refused while a job is admitted');
 await f.api.cancel(job.id);f.start();await until(async()=>{await f.api.handle({method:'GET'},{},'/api/work-data/jobs/'+job.id);return true;});
 await until(()=>f.m.accepting());
 const lease=f.m.begin();assert.equal((await codeOf(f.call('/api/work-data/hygiene'))).code,'work_data_setup.busy','closed intake refuses before any IO');lease.resume();
 // A move in flight blocks a new job; a job started after it drains until the move ends.
 const gate=deferred(),entered=deferred();const real=loadHygiene();
 const engine={...real,quarantine:async input=>{entered.resolve();await gate.promise;return real.quarantine(input);}};
 const g=fixture({base,engine});const plan=(await g.call('/api/work-data/hygiene/plan')).body.plan;
 const moving=g.call('/api/work-data/hygiene/quarantine',{token:plan.token,expectedAuthority:plainAuthority});await entered.promise;
 assert.equal((await codeOf(g.api.submit({operation:'enable',password:'synthetic hygiene password',expectedAuthority:plainAuthority,backupDirectory:'C:/synthetic/backups'}))).code,'work_data_setup.busy');
 assert.equal(g.m.status().admitted,1,'the move runs as an admitted http owner of the maintenance gate');
 gate.resolve();assert.equal((await moving).body.result.moved,1);assert.equal(g.m.status().admitted,0);
 const later=await g.api.submit({operation:'enable',password:'synthetic hygiene password',expectedAuthority:plainAuthority,backupDirectory:'C:/synthetic/backups'});assert.equal(later.state,'queued','intake reopens once the move ended');
});

test('no hygiene request runs while a restore package upload is still being received',async t=>{
 const base=await tempBase(t,'upload');await put(base,'sessions/a.json.corrupt','A');
 const f=fixture({base}),body=deferred(),entered=deferred(),port=43210;
 const worker=f.host.worker();worker.putUpload=async()=>'e'.repeat(48);worker.resolveUpload=async()=>({});
 const upload={method:'POST',url:'/api/work-data/uploads',socket:{localPort:port,remoteAddress:'127.0.0.1'},
  headers:{host:'127.0.0.1:'+port,'content-type':'application/octet-stream','content-length':'4'},
  async *[Symbol.asyncIterator](){entered.resolve();await body.promise;yield Buffer.from('ABCD');}};
 const receiving=f.api.handle(upload,{},'/api/work-data/uploads');await entered.promise;
 for(const [route,payload] of [['/api/work-data/hygiene'],['/api/work-data/hygiene/plan']])
  assert.equal((await codeOf(f.call(route,payload))).code,'work_data_setup.busy',route+' refused while an upload is received');
 body.resolve();await receiving;
 assert.equal((await f.call('/api/work-data/hygiene')).body.ok,true,'available again once the upload ended');
});

test('a maintenance job submitted while a read is admitted waits for it in drain (the gate is real, not a flag)',async t=>{
 const base=await tempBase(t,'drain');const gate=deferred(),entered=deferred(),real=loadHygiene();
 const engine={...real,inspect:async input=>{entered.resolve();await gate.promise;return real.inspect(input);}};
 const f=fixture({base,engine});const reading=f.call('/api/work-data/hygiene');await entered.promise;
 const job=await f.api.submit({operation:'enable',password:'synthetic hygiene password',expectedAuthority:plainAuthority,backupDirectory:'C:/synthetic/backups'});
 f.start();await until(()=>f.m.status().phase==='waiting');for(let i=0;i<10;i++)await tick();
 assert.equal(f.events.includes('start'),false,'the worker is not started while the inspection is still admitted');
 gate.resolve();assert.equal((await reading).body.ok,true);await until(()=>f.events.includes('start'));
 await f.api.cancel(job.id).catch(()=>{});
});

test('one data root, one chain: overlapping hygiene requests run one after another, in arrival order',async t=>{
 const base=await tempBase(t,'chain');const order=[],first=deferred(),entered=deferred();
 const engine={inspect:async()=>{order.push('inspect:start');entered.resolve();await first.promise;order.push('inspect:end');return {schema:1};},
  planQuarantine:async()=>{order.push('plan');return {schema:1,token:'a'.repeat(64),files:0,bytes:0,roots:[],items:[],skipped:[]};},
  quarantine:async()=>{order.push('quarantine');return {schema:1,moved:0,stamp:null,areas:[]};},undoQuarantine:async()=>{order.push('undo');return {schema:1,restored:0,kept:[]};}};
 const f=fixture({base,engine});
 const a=f.call('/api/work-data/hygiene');await entered.promise;
 // Separate requests share the setup's chain map; each needs its own response slot.
 const responses=[];f.host.respond=(_res,body)=>responses.push(body);
 const b=f.api.handle({method:'GET'},{},'/api/work-data/hygiene/plan');const c=f.api.handle(request({token:'b'.repeat(64),expectedAuthority:plainAuthority}),{},'/api/work-data/hygiene/quarantine');
 for(let i=0;i<10;i++)await tick();assert.deepEqual(order,['inspect:start'],'later requests wait for the running one');
 first.resolve();await a;await b;await c;assert.deepEqual(order,['inspect:start','inspect:end','plan','quarantine']);
});

test('ROUTE_AUTH registers the four hygiene routes at the token tier',()=>{
 const routes=vm.runInNewContext(constBlock(read('01b-route-auth.js'),'ROUTE_AUTH')+'\nROUTE_AUTH',{});
 for(const [m,p] of [['GET','/api/work-data/hygiene'],['GET','/api/work-data/hygiene/plan'],['POST','/api/work-data/hygiene/quarantine'],['POST','/api/work-data/hygiene/undo']]){
  const row=routes.find(r=>r.m===m&&(r.prefix?p.startsWith(r.p):r.p===p));assert.ok(row,m+' '+p);assert.equal(row.auth,'token',m+' '+p);
 }
});

test('the cold read-only maintenance service answers hygiene routes with busy, not job_not_found or takeover_committed',async t=>{
 const http=require('node:http'),api=vm.runInNewContext(read('13al-work-data-maintenance-http.js')+'\nWorkDataMaintenanceHttp;',{http,crypto,Buffer,URL,Set,Promise});
 const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const id='a'.repeat(48),host=api.create({id,port,assertColdOwner:()=>true,readStatus:()=>({authority:plainAuthority,job:{id,operation:'enable',state:'handoff',createdAt:1}})});
 t.after(()=>host.close());await host.listen();
 const send=(url,method='GET',headers={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers,agent:false},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});req.on('error',reject);req.end();});
 const token=(await send('/api/bootstrap','POST')).value.token,headers={'x-wcw-token':token};
 for(const [url,method] of [['/api/work-data/hygiene','GET'],['/api/work-data/hygiene/plan','GET'],['/api/work-data/hygiene/quarantine','POST'],['/api/work-data/hygiene/undo','POST']]){
  const result=await send(url,method,headers);assert.equal(result.status,409,url);assert.equal(result.value.error.code,'work_data_setup.busy',url);
 }
 assert.equal((await send('/api/work-data/hygiene','GET')).value.error.code,'auth.token_invalid','the token gate still comes first');
});
