'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const REPO=process.env.RUYI_INTERNAL_REPO||path.resolve(__dirname,'../..'),DRAFT=process.env.RUYI_INTERNAL_DRAFT||path.join(REPO,'ruyi-workbench/app/src');
const {functionBlock,bracedBlock,constBlock}=require(path.join(REPO,'dev-harness/lib/source-slice'));
const read=file=>fs.readFileSync(fs.existsSync(path.join(DRAFT,file))?path.join(DRAFT,file):path.join(REPO,'dev-harness/lib',file),'utf8'),original=file=>fs.readFileSync(path.join(REPO,'ruyi-workbench/app/src',file),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value)),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function child(){return Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});}
function fixture(extra={}){
 const state={calls:[],events:[],config:{toolLoadingMode:'full',questionTimeoutMs:3000,permissionMode:'auto'},session:{id:'sid',cwd:'C:/workspace',turnSeq:9},timers:[],mutations:[]};
 const children=new Map(),settlers=new Map(),runs=new Map(),owner={cancelRequested:false};settlers.set('sid',owner);
 const context={InternalMcpHooks:{},CliBusinessHooks:{},MAX_BODY_BYTES:128*1024*1024,require,Buffer,TextDecoder,AbortController,console,crypto,path,process:{execPath:process.execPath,env:{}},activeChildren:children,turnSettlers:settlers,activeAgentRuns:runs,AGENT_RUN_TERMINAL:new Set(['succeeded','failed','cancelled']),
  safeSessionId:value=>/^[A-Za-z0-9_-]{1,64}$/.test(String(value))?String(value):'',commandForSelfMcp:()=>({command:process.execPath,args:['server.js','mcp']}),dataRoot:()=> 'C:/base',paths:{data:'C:/base',config:'C:/base/config.json'},RUNTIME:{port:45678},RUYI_MCP_SERVER_ID:'ruyi',VERSION:'unit',RUYI_MCP_CLI_TOOL_PREFIX:'mcp__ruyi__',DESKTOP_MCP_SERVER_ID:'desktop',TOOL_PACK_DESCRIPTIONS:{core:'core',files:'files'},
  MCP_TOOLS:['file_read','todo_write','mission_update','request_user_input','permission_prompt','orchestrate_agents','wait_agents','agent_result','workbench_memory_read','mcp_resource','steward_status'].map(name=>({name})),
  PrivacyGateway:{assertSupported:()=>{if(state.config.privacy)throw Object.assign(Error('PRIVATE'),{code:'privacy.engine_not_supported'});},assertPolicyAvailable:()=>{},enabled:cfg=>!!cfg.privacy},readConfig:async()=>{if(state.onConfig)await state.onConfig();return state.config;},
  requestIsLoopback:req=>req.local!==false,json:(value,status=200)=>({body:JSON.stringify(value),status}),send:(res,payload)=>{res.status=payload.status;res.raw=payload.body;res.writableEnded=true;},
  nativeToolAvailableInContext:()=>true,isStewardToolName:name=>String(name).startsWith('steward_'),observationRecallEnabled:()=>true,toolPackForName:()=> 'files',
  VisualPipeline:{extractToolImages:result=>result.images||[],stripToolImageFields:result=>({...result,images:'[image attached in MCP content]'})},truncateToolResult:(name,text)=>name==='file_read'?'TRUNCATED':text,maskProviders:()=>({masked:true}),
  setInterval:fn=>{const timer={fn,unref(){},cleared:false};state.timers.push(timer);return timer;},clearInterval:timer=>{timer.cleared=true;},
  normalizeTodoItems:items=>items||[],loadSession:async()=>state.session,mutateSession:async(sid,work)=>{if(state.beforeMutate)await state.beforeMutate();const out=await work(state.session);state.mutations.push(sid);return{session:state.session,ok:true,value:out};},
  makeId:prefix=>prefix+'_one',nowIso:()=> '2026-10-24',MISSION_MAX_TEXT:1000,applyMissionUpdate:(mission,body,trusted)=>{state.trusted=trusted;return{...mission,...body};},maybeFinalizeMission:async()=>{},bumpMissionChangeSeq:async()=>1,
  requestUserQuestion:async(sid,id,questions,onEvent)=>{state.question={sid,id,questions};onEvent({type:'question'});return{ok:true,answers:{one:'two'},content:'answer'};},
  toolDisabledByPolicy:()=>false,sessionDesktopToolsOf:()=>null,bridgedReadPathGate:async()=>null,CLI_TOOL_TIER:{Read:'read'},nativeToolTier:()=> 'exec',resolvePermissionMode:()=> 'auto',nativeToolGate:()=> 'allow',toolIsRevertible:()=>false,consumeGrant:()=>null,
  logEvent:()=>{},driverAutoSessions:new Set(),permissionWaitMs:()=>3000,pendingPermissions:new Map(),registerIntervention:()=>{},
  EventStreamHooks:{markAgentEnvelopeDelivered:(session,id)=>{session.delivered=id;}},resolveWaitAgentsMs:value=>value||1000,waitForAgentRunResults:async(sid,ids,ms,signal,heartbeat)=>{heartbeat();return{ok:true,runIds:ids};},settleWaitEnvelopes:(session,out)=>{session.settled=out.runIds;},agentRunResultSlice:async args=>({ok:true,live:false,runStatus:'succeeded',runId:args.runId}),
  ...extra};
 const tool=extra.toolCall||(async(name,args,ctx)=>{state.calls.push({name,args,ctx});state.ctx=ctx;if(state.onCall)return state.onCall(name,args,ctx);return{ok:true,name,args};});context.toolCall=tool;
 context.cliTodoService=undefined;
 vm.createContext(context);vm.runInContext(read('13ae-cli-business-services.js'),context);
 const relay=vm.runInContext(read('13af-internal-mcp-relay.js')+'\nInternalMcpRelay;',context);context.InternalMcpRelay=relay;
 const acquire=()=>{const grant=relay.create({session:state.session,executionOwner:owner,config:state.config,packs:['files']}),reg={child:child(),kind:'claude',state:'running',exited:false,session:state.session,executionOwner:owner,onEvent:event=>state.events.push(event)};children.set('sid',reg);relay.bind(grant,reg,owner);return{grant,reg,token:grant.definition.env.RUYI_INTERNAL_MCP_CAP};};
 const request=async(token,message,headers={},stream)=>{const req=Readable.from(stream||[Buffer.from(JSON.stringify(message))]);req.method='POST';req.headers={'x-ruyi-internal-mcp-cap':token,...headers};const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,headersSent:false,frames:[],writeHead(status){this.status=status;this.headersSent=true;},write(text){this.frames.push(JSON.parse(text));return true;},end(){this.writableEnded=true;}});await relay.handle(req,res,'/api/mcp/internal/request');return res;};
 return{state,context,children,settlers,runs,owner,relay,acquire,request};
}
const rpc=(name,args={},id=1)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}}),last=res=>res.frames.at(-1);

test('capability requires exact registered main execution; plain API tokens and caller SID grant no authority',async()=>{
 const f=fixture(),g=f.acquire();assert.equal(g.grant.definition.env.WCW_TOKEN,'');assert.equal(g.grant.definition.env.RUYI_HOME,'C:/base');
 assert.equal((await f.request('a'.repeat(32),rpc('file_read'),{'x-wcw-token':'a'.repeat(32)})).status,403);
 const out=await f.request(g.token,rpc('file_read',{sessionId:'victim',turnSeq:999}));assert.equal(out.status,200);assert.equal(f.state.ctx.session,f.state.session);assert.equal(f.state.ctx.sessionId,'sid');assert.equal(f.state.ctx.turnSeq,9);assert.equal(f.state.ctx.mainTurn,false);assert.equal(f.relay.isContext({sessionId:'sid'}),false);assert.equal(f.relay.isContext(f.state.ctx),true);assert.throws(()=>f.relay.assertTool(f.state.ctx,'file_read'),/internal_mcp.unavailable/);
});
test('authorization checks precede body reading and reject browser/remote/oversized transports',async()=>{
 const f=fixture(),g=f.acquire();let readCount=0;async function* input(){readCount++;yield Buffer.from('{}');}
 for(const headers of [{origin:'http://localhost'},{'sec-fetch-mode':'cors'},{'content-length':String(128*1024*1024+1)},{'x-ruyi-internal-mcp-cap':'a'.repeat(64)}])assert.equal((await f.request(g.token,{},headers,input())).status,403);
 assert.equal(readCount,0);assert.equal(f.state.calls.length,0);
});
test('owner replacement, cancelled execution, pause, child exit and close revoke the old capability',async()=>{
 for(const mutate of [(f,g)=>f.children.set('sid',{...g.reg}),(f,g)=>{g.reg.state='paused';},(f,g)=>{g.reg.child.exitCode=0;},f=>{f.owner.cancelRequested=true;},(f,g)=>g.reg.child.emit('close'),f=>f.settlers.set('sid',{})]){
 const f=fixture(),g=f.acquire();mutate(f,g);assert.equal((await f.request(g.token,rpc('file_read'))).status,403);assert.equal(f.state.calls.length,0);}
 const f=fixture(),old=f.acquire();old.reg.child.emit('close');const fresh=f.acquire();assert.equal((await f.request(old.token,rpc('file_read'))).status,403);assert.equal((await f.request(fresh.token,rpc('file_read'))).status,200);
});
test('owner loss after config await or body chunk refuses execution; loss after tool suppresses result and private error',async()=>{
 const f=fixture(),g=f.acquire();f.state.onConfig=()=>{f.owner.cancelRequested=true;};assert.equal((await f.request(g.token,rpc('file_read'))).frames.length,0);assert.equal(f.state.calls.length,0);
 const h=fixture(),p=h.acquire();async function* input(){yield Buffer.from('{"jsonrpc":"2.0",');h.children.delete('sid');yield Buffer.from('"id":1,"method":"ping"}');}assert.equal((await h.request(p.token,{}, {},input())).status,403);
 const k=fixture(),lease=k.acquire();k.state.onCall=()=>{k.children.delete('sid');throw Error('PRIVATE');};const out=await k.request(lease.token,rpc('file_read'));assert.equal(out.frames.length,0);
});
function nodeContext(f){const ctrl=new AbortController(),node={id:'node',attempts:1,status:'running'},runtime={run:{sessionId:'sid',status:'running',nodes:[node]},nodeControls:new Map([['node',ctrl]]),ctrl:new AbortController()};f.runs.set('run',runtime);return{runtime,runId:'run',node,attempt:1,ctrl,session:f.state.session,workingDir:'C:/node-workspace'};}
test('node capability binds runtime/node/attempt/controller and does not impersonate parent controls',async()=>{
 const f=fixture(),c=nodeContext(f),grant=f.relay.createNode({config:f.state.config,context:c}),proc=child();f.relay.bindNode(grant,proc);const token=grant.definition.env.RUYI_INTERNAL_MCP_CAP;
 assert.equal((await f.request(token,rpc('file_read'))).status,200);assert.equal(f.state.ctx.workingDir,'C:/node-workspace');assert.equal(f.children.size,0);
 const listed=last(await f.request(token,{jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools.map(x=>x.name);assert.ok(!listed.includes('todo_write'));assert.ok(!listed.includes('request_user_input'));
 assert.ok(last(await f.request(token,rpc('mission_update'))).error);c.ctrl.abort();assert.equal((await f.request(token,rpc('file_read'))).status,403);
});

test('CLI resource direct RPC retains the exact typed pre-dispatch refusal for main and node',async()=>{
 for(const isNode of [false,true]){
  const f=fixture();let resourceCalls=0,dispatchCalls=0;
  f.context.ManagedMcp={active:()=>({ended:false}),resource:()=>{resourceCalls++;},rejected:vm.runInContext(functionBlock(original('04-permission-runtime.js'),'rejected')+'\nrejected',f.context)};
  f.context.toolCall=async()=>{dispatchCalls++;return{ok:true};};
  const c=isNode?nodeContext(f):null,g=isNode?f.relay.createNode({config:f.state.config,context:c}):f.acquire().grant;
  if(isNode)f.relay.bindNode(g,child());const token=g.definition.env.RUYI_INTERNAL_MCP_CAP;
  const response=last(await f.request(token,rpc('mcp_resource',{op:'read',resourceId:'forged'})));
  assert.equal(response.error,undefined);assert.equal(response.result.isError,true);
  assert.deepEqual(JSON.parse(response.result.content[0].text),plain(f.context.ManagedMcp.rejected({code:'privacy.mcp_native_turn_required'})));
  assert.equal(resourceCalls,0);assert.equal(dispatchCalls,0);
  assert.ok(!last(await f.request(token,{jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools.some(tool=>tool.name==='mcp_resource'));
 }
});

test('actual typed proxy and toolCall refuse CLI resource even with a live provider ALS, with no downstream call',async()=>{
 const f=fixture(),g=f.acquire();let resourceCalls=0,catalogCalls=0,issued;
 Object.assign(f.context,{ManagedMcp:{active:()=>({ended:false}),resource:()=>{resourceCalls++;return{ok:true};},rejected:vm.runInContext(functionBlock(original('04-permission-runtime.js'),'rejected')+'\nrejected',f.context)},
  PrivacyGateway:{active:()=>false,assertSupported:()=>{},assertToolChannel:()=>{},withExecution:async(name,args,ctx,run)=>run(args)},
  NATIVE_COMMAND_TOOL_NAMES:new Set(),NATIVE_DESKTOP_TOOL_NAMES:new Set(),nativeToolDisabledByPolicy:()=>'',unknownToolError:()=>Error('unknown'),normalizeMetaToolArgs:(name,args)=>args,validateNativeToolArgs:()=>null,normalizeToolInvokeArgs:args=>args,toolInvokeMissingNameResult:()=>null,
  adaptiveCatalogForMcp:async()=>{catalogCalls++;throw Error('resource must refuse before discovery');}});
 const handlers={file_read:{handler:async(args,ctx)=>{issued=ctx;return{ok:true};}},mcp_resource:{handler:(args,ctx)=>f.context.ManagedMcp.resource(args,ctx)},
  tool_invoke_read:{handler:(args,ctx)=>f.context.invokeAdaptiveMcpTool('read',args.name,args.arguments||{},ctx)},
  tool_invoke_exec:{handler:async(args,ctx)=>f.context.toolCall(args.name,args.arguments||{},ctx)}};
 f.context.TOOL_HANDLERS=handlers;
 vm.runInContext(functionBlock(read('12-tool-dispatch.js'),'invokeAdaptiveMcpTool')+'\n'+functionBlock(read('12-tool-dispatch.js'),'toolCall')+'\n'+functionBlock(read('12-tool-dispatch.js'),'mcpCatalogForContext'),f.context);
 const expected=plain(f.context.ManagedMcp.rejected({code:'privacy.mcp_native_turn_required'}));
 for(const args of [{name:'mcp_resource',arguments:{op:'list'}},{name:'tool_invoke_read',arguments:{name:'mcp_resource',arguments:{op:'read',resourceId:'forged'}}}]){
  const name=args.name==='tool_invoke_read'?'tool_invoke_exec':'tool_invoke_read';
  const response=last(await f.request(g.token,rpc(name,args)));assert.equal(response.error,undefined);assert.equal(response.result.isError,true);assert.deepEqual(JSON.parse(response.result.content[0].text),expected);
 }
 await f.request(g.token,rpc('file_read'));assert.ok(issued);
 const catalog=[{function:{name:'mcp_resource'}},{function:{name:'file_read'}}];
 // Exercise the real discovery handlers inside a still-live exact request context.
 f.context.adaptiveCatalogForMcp=async()=>({catalog});f.context.policyDesktopOverrideFor=async()=>null;
 f.context.listCompactTools=rows=>({tools:rows.map(row=>row.function.name)});f.context.searchToolCatalog=rows=>({matches:rows.map(row=>row.function.name)});
 const discovery=Object.fromEntries(['list_tools','tool_search'].map(name=>{const block=bracedBlock(read('12-tool-dispatch.js'),name+': ');return[name,vm.runInContext('('+block.slice(block.indexOf('{'))+')',f.context).handler];}));
 f.context.TOOL_HANDLERS.file_read.handler=async(args,ctx)=>{issued=ctx;
  assert.deepEqual(plain((await discovery.list_tools({},ctx)).tools),['file_read']);
  assert.deepEqual(plain((await discovery.tool_search({},ctx)).matches),['file_read']);
  return f.context.toolCall('mcp_resource',{},ctx);};
 const directNested=last(await f.request(g.token,rpc('tool_invoke_exec',{name:'file_read'})));assert.deepEqual(JSON.parse(directNested.result.content[0].text),expected);
 assert.equal(resourceCalls,0);assert.equal(catalogCalls,0);
 assert.equal(f.context.mcpCatalogForContext(catalog,null),catalog,'ordinary provider catalogue is unchanged');
 await assert.rejects(f.context.toolCall('mcp_resource',{},issued),/internal_mcp.unavailable/,'expired internal context cannot reuse the safe-refusal path');
});
test('node stale attempt/runtime/control/child cannot call after replacement',async()=>{
 for(const mutate of [(f,c)=>{c.node.attempts++;},(f,c)=>f.runs.set('run',{...c.runtime}),(f,c)=>c.runtime.nodeControls.set('node',new AbortController()),(f,c,p)=>{p.signalCode='SIGTERM';},(f,c)=>{c.runtime.stopRequested=true;}]){const f=fixture(),c=nodeContext(f),grant=f.relay.createNode({config:f.state.config,context:c}),proc=child();f.relay.bindNode(grant,proc);mutate(f,c,proc);assert.equal((await f.request(grant.definition.env.RUYI_INTERNAL_MCP_CAP,rpc('file_read'))).status,403);}
});
test('full default initialize/ping/list/resources RPCs retain masks and exact resource confinement',async()=>{
 const f=fixture(),g=f.acquire();for(const method of ['initialize','ping','notifications/initialized'])assert.equal((await f.request(g.token,{jsonrpc:'2.0',id:1,method})).status,200);
 const list=last(await f.request(g.token,{jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools.map(x=>x.name);assert.ok(list.includes('todo_write'));assert.ok(!list.includes('mcp_resource'));assert.ok(!list.includes('steward_status'));
 const out=last(await f.request(g.token,{jsonrpc:'2.0',id:3,method:'resources/list'})).result;assert.equal(out.resources.length,1);
 const valid=last(await f.request(g.token,{jsonrpc:'2.0',id:4,method:'resources/read',params:{uri:'file://C:/base/config.json'}}));assert.equal(JSON.parse(valid.result.contents[0].text).masked,true);
 assert.ok(last(await f.request(g.token,{jsonrpc:'2.0',id:5,method:'resources/read',params:{uri:'file://C:/other/config.json'}})).error);
});
test('full memory body, ordinary truncation and inline image content preserve the former MCP shapes',async()=>{
 const f=fixture(),g=f.acquire();f.state.onCall=()=>({ok:true,memory:{body:'x'.repeat(70001)}});assert.ok(last(await f.request(g.token,rpc('workbench_memory_read'))).result.content[0].text.length>70001);
 assert.equal(last(await f.request(g.token,rpc('file_read'))).result.content[0].text,'TRUNCATED');
 f.state.onCall=()=>({ok:false,images:['data:image/png;base64,AQID']});const out=last(await f.request(g.token,rpc('screen_capture'))).result;assert.equal(out.isError,true);assert.equal(out.content[1].mimeType,'image/png');assert.equal(out.content[1].data,'AQID');
});
test('tool and error output recheck privacy; protected config cannot expose error text or late result',async()=>{
 const f=fixture(),g=f.acquire();f.state.onCall=()=>{f.state.config.privacy=true;throw Error('PRIVATE_PATH');};const out=last(await f.request(g.token,rpc('file_read')));assert.equal(out.error.message,'privacy.engine_not_supported');assert.ok(!JSON.stringify(out).includes('PRIVATE_PATH'));
});
test('workflow progress uses the original progress token and is cleared after completion',async()=>{
 const f=fixture(),g=f.acquire(),wait=deferred();f.state.onCall=()=>wait.promise;const message=rpc('orchestrate_agents');message.params._meta={progressToken:'progress-one'};const pending=f.request(g.token,message);
 while(!f.state.timers.length)await new Promise(r=>setImmediate(r));f.state.timers[0].fn();wait.resolve({ok:true});const out=await pending;assert.equal(out.frames[0].method,'notifications/progress');assert.equal(out.frames[0].params.progressToken,'progress-one');assert.equal(f.state.timers[0].cleared,true);
});
test('trusted context business dispatch overrides caller SID and uses shared todo/question/permission/mission services',async()=>{
 const f=fixture(),g=f.acquire();f.state.session.mission={goal:'old'};
 f.state.onCall=(name,args,ctx)=>f.relay.business(name,args,ctx);
 const todo=last(await f.request(g.token,rpc('todo_write',{sessionId:'victim',items:[{text:'one'}]}))).result;assert.equal(JSON.parse(todo.content[0].text).count,1);assert.deepEqual(f.state.mutations,['sid']);assert.equal(f.state.events[0].type,'todo');
 const question=last(await f.request(g.token,rpc('request_user_input',{questions:[{question:'ask'}]}))).result;assert.equal(JSON.parse(question.content[0].text).answers.one,'two');assert.equal(f.state.question.sid,'sid');
 const permission=last(await f.request(g.token,rpc('permission_prompt',{tool_name:'Read',input:{file:'a'}}))).result;assert.equal(JSON.parse(permission.content[0].text).behavior,'allow');
 const mission=last(await f.request(g.token,rpc('mission_update',{goal:'new'}))).result;assert.equal(JSON.parse(mission.content[0].text).mission.goal,'new');assert.equal(f.state.trusted,false);
 await assert.rejects(f.relay.business('todo_write',{}, {sessionId:'sid'}),/internal_mcp.unavailable/);
});
test('mutation owner check rejects lost registration while waiting for the real session chain',async()=>{
 const f=fixture(),g=f.acquire();f.state.onCall=(name,args,ctx)=>f.relay.business(name,args,ctx);f.state.beforeMutate=()=>{f.children.delete('sid');};const out=await f.request(g.token,rpc('todo_write',{items:[{text:'never'}]}));assert.equal(out.frames.length,0);assert.equal(f.state.mutations.length,0);assert.equal(f.state.session.todos,undefined);
});
test('agent wait/result retain delivery settlement and onEvent identity in the shared service',async()=>{
 const f=fixture(),g=f.acquire();f.state.onCall=(name,args,ctx)=>f.relay.business(name,args,ctx);
 const wait=last(await f.request(g.token,rpc('wait_agents',{runIds:['run_one']})));assert.equal(JSON.parse(wait.result.content[0].text).ok,true);assert.deepEqual(plain(f.state.session.settled),['run_one']);
 await f.request(g.token,rpc('agent_result',{runId:'run_two'}));assert.equal(f.state.session.delivered,'run_two');
});
test('HTTP authorization table precheck accepts only the dedicated capability and never ordinary token or caller SID',()=>{
 const authorize=vm.runInNewContext(constBlock(read('01b-route-auth.js'),'ROUTE_AUTH')+'\n'+functionBlock(read('01-config.js'),'authorizeRoute')+'\nauthorizeRoute',{MAX_BODY_BYTES:128*1024*1024,requestIsLoopback:req=>req.local!==false,tokenOk:req=>req.headers['x-wcw-token']==='management',originOk:()=>true});
 const headers={'x-ruyi-internal-mcp-cap':'a'.repeat(64)};assert.equal(authorize({headers},'POST','/api/mcp/internal/request'),null);
 for(const req of [{headers:{'x-wcw-token':'management'}},{headers:{...headers,origin:'http://localhost'}},{headers:{...headers,'sec-fetch-mode':'cors'}},{headers:{...headers,'content-length':String(128*1024*1024+1)}},{headers,local:false}])assert.notEqual(authorize(req,'POST','/api/mcp/internal/request'),null);
 assert.notEqual(authorize({headers},'POST','/api/tools/file_write'),null);
});
test('default stdio dispatch leaves consumer and read-only memory transports independent and never starts a disk owner',async()=>{
 for(const [argv,env,want]of [[['--memory-read-only'],{},'memory'],[[],{RUYI_MCP_CONSUMER_TOKEN:'consumer'},'consumer'],[[],{},'internal']]){
  const calls=[];const start=vm.runInNewContext(functionBlock(read('13-http-router.js'),'startMcp')+'\nstartMcp',{process:{argv,env},MemoryCliHooks:{startRelay:()=>calls.push('memory')},PrivacyCore:{configHooks:{startConsumerMcp:()=>calls.push('consumer')}},InternalMcpHooks:{startRelay:()=>calls.push('internal')},ensureDirs:()=>{throw Error('disk owner must not start');}});await start();assert.deepEqual(calls,[want]);
 }
});

function transportFixture(respond){
 const stdin=new EventEmitter(),proc=new EventEmitter(),output=[],requests=[];stdin.setEncoding=()=>{};stdin.pause=()=>{};
 Object.assign(proc,{env:{RUYI_INTERNAL_MCP_CAP:'a'.repeat(64),RUYI_INTERNAL_MCP_PORT:'45678'},stdin,stdout:{write:line=>output.push(JSON.parse(line))}});
 const http={request(options,callback){const request=new EventEmitter();request.options=options;request.setTimeout=()=>{};request.destroy=error=>{request.emit('error',error||Error('closed'));request.emit('close');};request.end=bytes=>{request.body=JSON.parse(String(bytes));queueMicrotask(()=>respond(request,callback));};requests.push(request);return request;}};
 const relay=vm.runInNewContext(read('13af-internal-mcp-relay.js')+'\nInternalMcpRelay;',{MAX_BODY_BYTES:128*1024*1024,require:name=>{assert.equal(name,'node:http');return http;},InternalMcpHooks:{},process:proc,Buffer,TextDecoder,AbortController,crypto});
 return{relay,stdin,output,requests,proc};
}
test('stdio forwards full RPC/progress once through HTTP and drains accepted calls after stdin EOF',async()=>{
 const f=transportFixture((request,callback)=>{const response=Object.assign(new EventEmitter(),{statusCode:200,destroy:error=>response.emit('error',error)});callback(response);const id=request.body.id;response.emit('data',Buffer.from(JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'p',progress:1}})+'\n'));response.emit('data',Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result:{content:[{type:'text',text:'actual transport result'}]}})+'\n'));response.emit('end');request.emit('close');});
 await f.relay.startRelay();f.stdin.emit('data',JSON.stringify(rpc('file_read'))+'\n');f.stdin.emit('end');for(let i=0;i<10&&f.output.length<2;i++)await new Promise(r=>setImmediate(r));assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.hostname,'127.0.0.1');assert.equal(f.requests[0].options.headers['x-ruyi-internal-mcp-cap'],'a'.repeat(64));assert.equal(f.output[0].method,'notifications/progress');assert.equal(f.output[1].result.content[0].text,'actual transport result');
});
test('stdio never replays transport failure and never emits a second terminal after receiving one',async()=>{
 for(const finalFirst of [false,true]){const f=transportFixture((request,callback)=>{const response=Object.assign(new EventEmitter(),{statusCode:200});callback(response);if(finalFirst)response.emit('data',Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.body.id,result:{ok:true}})+'\n'));response.emit('error',Error('lost after possible mutation'));request.emit('close');});await f.relay.startRelay();f.stdin.emit('data',JSON.stringify(rpc('file_write'))+'\n');for(let i=0;i<10&&!f.output.length;i++)await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(f.requests.length,1);assert.equal(f.output.length,1);assert.equal(!!f.output[0].error,!finalFirst);}
});

test('standalone default MCP preserves setup guidance without accepting the old shared-token environment as authority',async()=>{
 const f=transportFixture(()=>assert.fail('an unconfigured process must not call HTTP'));delete f.proc.env.RUYI_INTERNAL_MCP_CAP;
 Object.assign(f.proc.env,{WCW_TOKEN:'a'.repeat(32),WCW_SESSION_ID:'sid',WCW_PORT:'45678'});await f.relay.startRelay();f.stdin.emit('data',JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n');
 for(let i=0;i<10&&!f.output.length;i++)await new Promise(r=>setImmediate(r));assert.equal(f.requests.length,0);assert.match(f.output[0].error.message,/^mcp_consumer\.setup_required:/);
});

test('revoked host HTTP 403 drains its body before RPC parsing and preserves setup guidance without replay',async()=>{
 let drained=0,dataListeners=-1;
 const f=transportFixture((request,callback)=>{const response=Object.assign(new EventEmitter(),{statusCode:403,resume:()=>{drained++;},destroy:error=>response.emit('error',error)});callback(response);dataListeners=response.listenerCount('data');response.emit('data',Buffer.from('{\n  "private": "HOST_PRIVATE_AUTH_DETAIL"\n}\n'));response.emit('end');request.emit('close');});
 await f.relay.startRelay();f.stdin.emit('data',JSON.stringify(rpc('file_read'))+'\n');for(let i=0;i<10&&!f.output.length;i++)await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
 assert.equal(f.output.length,1);assert.match(f.output[0].error.message,/^mcp_consumer\.setup_required:/);assert.equal(f.requests.length,1);assert.equal(drained,1);assert.equal(dataListeners,0);assert.ok(!JSON.stringify(f.output).includes('HOST_PRIVATE_AUTH_DETAIL'));
});

test('real loopback HTTP pretty JSON 403 produces the original setup receipt once',async t=>{
 const http=require('node:http');let calls=0,finish,timer;const output=[],stdin=new EventEmitter(),proc=new EventEmitter();stdin.setEncoding=()=>{};stdin.pause=()=>{};
 const server=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,private:'HOST_PRIVATE_AUTH_DETAIL'},null,2)+'\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{clearTimeout(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const result=new Promise((resolve,reject)=>{finish=resolve;timer=setTimeout(()=>reject(Error('403 receipt timed out')),3000);});
 Object.assign(proc,{env:{RUYI_INTERNAL_MCP_CAP:'a'.repeat(64),RUYI_INTERNAL_MCP_PORT:String(server.address().port)},stdin,stdout:{write:line=>{output.push(JSON.parse(line));finish();}}});
 const relay=vm.runInNewContext(read('13af-internal-mcp-relay.js')+'\nInternalMcpRelay;',{MAX_BODY_BYTES:128*1024*1024,require,InternalMcpHooks:{},process:proc,Buffer,TextDecoder,AbortController,crypto});
 await relay.startRelay();stdin.emit('data',JSON.stringify(rpc('file_read'))+'\n');await result;stdin.emit('end');await new Promise(r=>setImmediate(r));
 assert.equal(calls,1);assert.equal(output.length,1);assert.deepEqual(output[0],{jsonrpc:'2.0',id:1,error:{code:-32000,message:'mcp_consumer.setup_required: Create an independent connection in Ruyi Settings > MCP. / 请在如意设置的 MCP 页面生成独立连接配置。'}});assert.ok(!JSON.stringify(output).includes('HOST_PRIVATE_AUTH_DETAIL'));
});

test('shared services and HTTP adapters preserve frozen original CLI receipts and events',async()=>{
 const golden=JSON.parse(read('internal-mcp-business-receipts.json'));
 assert.equal(golden.baselineCommit,'c773068c4904ecb322a3edf112bb53a82d88a9dd');
 const specs=[
  ['todo','13-http-router.js',"if (req.method === 'POST' && pathname === '/api/todo')",'cliTodoService',{items:[{text:'one'}]}],
  ['mission','13-http-router.js',"if (pathname === '/api/mission')",'cliMissionService',{action:'update',goal:'new'}],
  ['question','13d-core-domain-routes.js',"if (req.method === 'POST' && pathname === '/api/question/request')",'cliQuestionService',{questions:[{question:'q'}]}],
  ['permission','13d-core-domain-routes.js',"if (req.method === 'POST' && pathname === '/api/permission/request')",'cliPermissionService',{toolName:'Read',input:{path:'a'}}],
  ['launch','13-http-router.js',"if (req.method === 'POST' && pathname === '/api/agent-workflow/launch')",'cliAgentLaunchService',{task:'work',envelope:true}],
 ];
 for(const [name,file,marker,service,args]of specs){
  const outputs=[];
  for(const baseline of [true,false]){
   const f=fixture(),g=f.acquire(),body={token:'ordinary',sessionId:'sid',...args};f.state.session.mission={goal:'old'};
   Object.assign(f.context,{readJsonBody:async()=>body,tokenMatches:()=>true,tokenOk:()=>false,resolveProvider:()=>({id:'provider',model:'model'}),activeOpenAiProvider:()=>null,
    detectClaudePath:()=>'',existsExecutableAsync:async()=>false,PERMISSION_MODES:['auto'],normalizeCwd:cwd=>cwd,resolveOrchestrateNodes:async()=>({nodes:[{id:'one'}]}),
    deliverAgentRunEnvelope:async()=>{},buildAgentRunEnvelope:run=>({ok:true,runId:run.id}),runAgentWorkflow:async options=>{f.state.workflow={session:options.parentSession.id,mode:options.permModeOverride,nodes:options.nodes};await options.onComplete({id:'run_one'});return{ok:true,runId:'run_one'};}});
   let response;
   if(baseline){const route=bracedBlock(read(file),marker),pathname=name==='launch'?'/api/agent-workflow/launch':'/api/'+(name==='question'?'question/request':name==='permission'?'permission/request':name);const run=vm.runInContext('(async function(req,res,pathname){'+route+'})',f.context);const res={};await run({method:'POST'},res,pathname);response={body:res.raw,status:res.status};}
   else{const call=vm.runInContext(service,f.context);response=await call(body,{ownerReg:g.reg,ownerCheck:()=>{},trusted:false});}
   outputs.push({response,state:f.state.session,events:f.state.events,workflow:f.state.workflow,trusted:f.state.trusted});
  }
  for(const output of outputs)assert.deepEqual(plain(output),golden.cases[name].expected,name+' must match the frozen original receipt contract');
 }
});

test('relay shell handlers retain MCP refusal and scratchpad retains main-turn restriction',async()=>{
 const source=read('12-tool-dispatch.js');
 for(const name of ['shell_start','shell_poll','shell_kill']){
  const block=bracedBlock(source,name+': '),handler=vm.runInNewContext('('+block.slice(block.indexOf('{'))+')',{RUNTIME:{isMcpChild:false},InternalMcpHooks:{isContext:ctx=>ctx===true},shellMcpChildGuard:()=>({ok:false,code:'existing-shell-refusal'}),guardWorkspaceExecute:async()=>({ok:true})});
  assert.equal((await handler.handler({},true)).code,'existing-shell-refusal');
 }
 const scratch=vm.runInNewContext(functionBlock(source,'scratchpadWriteTool')+'\nscratchpadWriteTool',{RUNTIME:{isMcpChild:false},safeSessionId:()=>true});
 assert.equal((await scratch({}, {mainTurn:false,session:{id:'sid'}})).ok,false);
});

test('real session MCP config writes only the supplied execution capability and a grantless config cannot inherit authority',async()=>{
 const f=fixture(),g=f.acquire(),written=[];Object.assign(f.context,{sessionMcpConfigSweepDone:true,ensureDirs:async()=>{},addExternalMcpServersToMap:()=>{},atomicWriteJson:async(file,value)=>written.push({file,value:plain(value)})});f.context.paths.generated='C:/base/generated';
 const generate=vm.runInContext(functionBlock(read('01-config.js'),'generateSessionMcpConfig')+'\ngenerateSessionMcpConfig',f.context);
 await generate('sid','auto',['files'],{internalMcpGrant:g.grant});const own=written.at(-1).value.mcpServers.ruyi;assert.equal(own.env.RUYI_INTERNAL_MCP_CAP,g.token);assert.equal(own.env.RUYI_HOME,'C:/base');assert.equal(own.env.WCW_TOKEN,'');
 await generate('unowned','auto',['files']);assert.equal(written.at(-1).value.mcpServers.ruyi.env.RUYI_INTERNAL_MCP_CAP,'');assert.equal(written.at(-1).value.mcpServers.ruyi.env.WCW_TOKEN,'');
});

test('actual fixture spawn creates capability before spawn and binds the exact registered wrapper child',()=>{
 const f=fixture(),app={RUNTIME:{token:'management',port:45678},InternalMcpRelay:f.relay,activeChildren:f.children,turnSettlers:f.settlers,
  recordSessionExecutionOwner:(sid,owner)=>f.settlers.set(sid,owner),registerSessionExecutionChild:(sid,reg,owner)=>{reg.executionOwner=owner;f.children.set(sid,reg);}};let spawned;
 const spawn=vm.runInNewContext(functionBlock(read('internal-mcp-fixture.js'),'spawnMcpInApp')+'\nspawnMcpInApp',{cp:{spawn:(command,args,options)=>{spawned={command,args,options};return Object.assign(child(),{pid:123});}},process,__filename:'fixture.js',serial:0});
 const proc=spawn(app,{session:f.state.session,env:{WCW_TOKEN:'inherited-management'}}),reg=f.children.get('sid');assert.equal(proc,reg.child);assert.equal(reg.internalMcpGrant.reg,reg);assert.equal(spawned.options.env.WCW_TOKEN,'');assert.match(spawned.options.env.RUYI_INTERNAL_MCP_CAP,/^[a-f0-9]{64}$/);proc.emit('close');assert.equal(reg.internalMcpGrant,null);
});

test('business adapter preserves original CLI forwarding whitelists instead of elevating extra model fields',async()=>{
 const f=fixture(),g=f.acquire();let captured;f.context.cliAgentLaunchService=async body=>{captured=plain(body);return f.context.json({ok:true});};f.context.cliMissionService=async body=>{captured=plain(body);return f.context.json({ok:true,mission:{}});};f.state.onCall=(name,args,ctx)=>f.relay.business(name,args,ctx);
 await f.request(g.token,rpc('orchestrate_agents',{task:'task',async:true,poolPolicy:{unsafe:true},sessionId:'victim',background:'true'}));assert.equal(captured.sessionId,'sid');assert.equal(captured.async,undefined);assert.equal(captured.poolPolicy,undefined);assert.equal(captured.background,false);assert.equal(captured.envelope,true);
 await f.request(g.token,rpc('mission_update',{goal:'goal',autoMode:'until-done',patch:{unsafe:true},action:'start'}));assert.equal(captured.action,'update');assert.equal(captured.autoMode,undefined);assert.equal(captured.patch,undefined);
});

test('actual nested toolCall cannot bypass node scope through a typed proxy and expired contexts stay denied',async()=>{
 const f=fixture(),c=nodeContext(f),grant=f.relay.createNode({config:f.state.config,context:c});f.relay.bindNode(grant,child());let effects=0,issued;
 const handlers={file_read:{handler:async(args,ctx)=>{issued=ctx;return{ok:true};}},todo_write:{handler:async()=>{effects++;return{ok:true};}},tool_invoke_exec:{handler:async(args,ctx)=>f.context.toolCall(args.name,args.arguments||{},ctx)}};
 Object.assign(f.context,{PrivacyGateway:{active:()=>false,assertSupported:()=>{},assertToolChannel:()=>{},withExecution:async(name,args,ctx,run)=>run(args)},TOOL_HANDLERS:handlers,NATIVE_COMMAND_TOOL_NAMES:new Set(),NATIVE_DESKTOP_TOOL_NAMES:new Set(),nativeToolDisabledByPolicy:()=>'',unknownToolError:()=>Error('unknown'),normalizeMetaToolArgs:(name,args)=>args,validateNativeToolArgs:()=>null,normalizeToolInvokeArgs:args=>args,toolInvokeMissingNameResult:()=>null});
 vm.runInContext(functionBlock(read('12-tool-dispatch.js'),'toolCall'),f.context);
 const token=grant.definition.env.RUYI_INTERNAL_MCP_CAP;assert.ok(last(await f.request(token,rpc('tool_invoke_exec',{name:'todo_write'}))).error);assert.equal(effects,0);
 await f.request(token,rpc('file_read'));assert.ok(issued);await assert.rejects(f.context.toolCall('file_read',{},issued),/internal_mcp.unavailable/);
});

test('consumer discovery writer and pure relay reader agree on stable base when active generation differs',async()=>{
 let written,opened;const file=read('13ac-mcp-consumer.js'),base='C:/stable-base',active='C:/stable-base/.work-data/generations/abc';
 const listen=vm.runInNewContext(functionBlock(file,'listen')+'\nlisten',{atomicWriteJson:async(name,value)=>{written={name,value};},path,dataRoot:()=>base,paths:{data:active},RUNTIME:{port:45678},instance:'a'.repeat(32)});await listen();
 const discovery=vm.runInNewContext(functionBlock(file,'discovery')+'\ndiscovery',{relayPath:path,dataRoot:()=>base,paths:{data:base},relayFs:{lstatSync:name=>{opened=name;return{isFile:()=>true,isSymbolicLink:()=>false,size:100};},readFileSync:()=>JSON.stringify(written.value)},validId:()=>true});
 assert.equal(discovery().port,45678);assert.equal(opened,written.name);assert.equal(written.name,path.join(base,'mcp-host-v1.json'));assert.ok(!written.name.includes('generations'));
});

test('post-await receipt mutations and UI events require the original execution owner',async()=>{
 for(const kind of ['wait','result','launch','todo','mission','permission']){
  const f=fixture(),g=f.acquire(),gate=deferred(),entered=deferred();let receiptEffects=0;
  const ownerCheck=()=>{if(f.children.get('sid')!==g.reg)throw Error('lost exact owner');},options={ownerReg:g.reg,ownerCheck};
  Object.assign(f.context,{setTimeout:()=>({}),EventStreamHooks:{markAgentEnvelopeDelivered:()=>{receiptEffects++;}},settleWaitEnvelopes:()=>{receiptEffects++;},
    resolveProvider:()=>({id:'provider',model:'model'}),activeOpenAiProvider:()=>null,detectClaudePath:()=>'',existsExecutableAsync:async()=>false,PERMISSION_MODES:['auto'],normalizeCwd:cwd=>cwd,resolveOrchestrateNodes:async()=>({nodes:[{id:'one'}]}),
    deliverAgentRunEnvelope:async()=>{receiptEffects++;},buildAgentRunEnvelope:run=>({ok:true,runId:run.id}),bumpMissionChangeSeq:async()=>{receiptEffects++;return 1;}});
  f.state.session.mission={goal:'old'};
  let pending;
  if(kind==='wait'){f.context.waitForAgentRunResults=async()=>{entered.resolve();await gate.promise;return{ok:true};};pending=f.context.cliAgentResultService({sessionId:'sid'},'wait',options);}
  else if(kind==='result'){f.context.agentRunResultSlice=async()=>{entered.resolve();await gate.promise;return{ok:true,live:false,runStatus:'succeeded',runId:'run_one'};};pending=f.context.cliAgentResultService({sessionId:'sid'},'result',options);}
  else if(kind==='launch'){f.context.runAgentWorkflow=async call=>{entered.resolve();await gate.promise;await call.onComplete({id:'run_one'});return{ok:true};};pending=f.context.cliAgentLaunchService({sessionId:'sid',task:'work',envelope:true},options);}
  else if(kind==='permission'){g.reg.lastEventAt=123;f.context.nativeToolGate=()=> 'ask';pending=f.context.cliPermissionService({sessionId:'sid',toolName:'Edit',input:{}},options);while(!f.context.pendingPermissions.has('perm_one'))await new Promise(r=>setImmediate(r));entered.resolve();}
  else{f.context.mutateSession=async(sid,work)=>{await work(f.state.session);entered.resolve();await gate.promise;return{ok:true,session:f.state.session};};pending=kind==='todo'?f.context.cliTodoService({sessionId:'sid',items:[{text:'one'}]},options):f.context.cliMissionService({sessionId:'sid',action:'update',goal:'new'},options);}
  const rejected=assert.rejects(pending,/lost exact owner/);await entered.promise;
  const replacement={...g.reg,session:{id:'sid',cwd:'C:/replacement'}};f.children.set('sid',replacement);
  if(kind==='permission'){const entry=f.context.pendingPermissions.get('perm_one');f.context.pendingPermissions.delete('perm_one');entry.resolve({behavior:'allow'});}else gate.resolve();
  await rejected;assert.equal(receiptEffects,0,kind);assert.equal(f.state.events.filter(event=>event.type!=='permission_request').length,0,kind);assert.equal(f.state.session.delivered,undefined);assert.equal(replacement.session.delivered,undefined);if(kind==='permission')assert.equal(g.reg.lastEventAt,123);
 }
});

test('real bridged adaptive dispatch rechecks exact owner before checkpoint and final external call after awaits',async()=>{
 for(const cut of ['checkpoint','external']){
  const f=fixture(),g=f.acquire(),gate=deferred(),entered=deferred();let checkpoints=0,calls=0;
  const bridge={serverId:'external',toolName:'write'},item={name:'external_write',tier:'edit',tool:{function:{parameters:{}}}};
  Object.assign(f.context,{isControlPlaneToolName:()=>false,policyDesktopOverrideFor:async()=>null,adaptiveCatalogForMcp:async()=>({bridged:{route:{}},catalog:[item]}),resolveBridge:()=>bridge,
    toolDisabledByPolicy:()=>'',bridgedToolTier:()=> 'edit',toolInvokeTierCovers:()=>true,toolArgsMissingRequired:()=>[],getBridgedClient:async()=>({callTool:async()=>{calls++;return{ok:true};}}),
    bridgedOfficeScriptGate:()=>null,bridgedWriteRelativePathArg:()=>null,bridgedReadPathGate:async()=>{if(cut==='checkpoint'){entered.resolve();await gate.promise;}return null;},journalBridgedWrite:async()=>{checkpoints++;},
    withToolArgsGuide:value=>value,PrivacyGateway:{assertSupported:()=>{},revalidateExecution:async(name,args)=>{if(cut==='external'){entered.resolve();await gate.promise;}return args;}}});
  const invoke=vm.runInContext(functionBlock(read('12-tool-dispatch.js'),'invokeAdaptiveMcpTool')+'\ninvokeAdaptiveMcpTool',f.context);f.state.onCall=(name,args,ctx)=>invoke('edit','external_write',{},ctx);
  const pending=f.request(g.token,rpc('tool_invoke_edit',{name:'external_write'}));await entered.promise;f.children.set('sid',{...g.reg});gate.resolve();await pending;
  assert.equal(checkpoints,cut==='checkpoint'?0:1,cut);assert.equal(calls,0,cut);
 }
});

test('real Kimi environment merge keeps its own capability but fixed blanks shield external and readonly MCP children',async()=>{
 const f=fixture(),g=f.acquire(),configSource=read('01-config.js');let generated;
 // The serving environment intentionally has no grant: fixed blanks must anticipate the future Kimi env.
 Object.assign(f.context,{process:{env:{},execPath:process.execPath},ensureDirs:async()=>{},ensureDesktopMcpWarm:async()=>{},mcpConfigFilePath:()=> 'C:/base/generated/full.json',
   resolveExternalMcpServers:()=>[{id:'external',command:'external.exe',env:{USER_EXTERNAL_SECRET:'keep'}},{id:'desktop',command:'desktop.exe'}],desktopMcpPolicyEnv:()=>({}),atomicWriteJson:async(file,value)=>{generated=plain(value);}});
 vm.runInContext(['BRIDGED_ENV_KEEP','BRIDGED_ENV_DROP','BRIDGED_CLI_ENV_BLANK_KEYS'].map(name=>constBlock(configSource,name)).join('\n')+'\n'+['bridgedEnvKeyStripped','bridgedCliServerEnv','addExternalMcpServersToMap','generateMcpConfig'].map(name=>functionBlock(configSource,name)).join('\n'),f.context);
 await f.context.generateMcpConfig();
 const prepared=functionBlock(read('05b-kimi-bridge.js'),'runKimiAcpTurnPrepared'),envCode=prepared.slice(prepared.indexOf('  const env ='),prepared.indexOf('  const spawn ='));
 f.context.permissionWaitMs=()=>1000;f.context.syncMcpServersToKimi=async()=>{};
 const merge=vm.runInContext('(async function(config,session,internalMcpGrant){'+envCode+'\nreturn env;})',f.context),mainEnv=await merge({includeWorkbenchMcp:true},f.state.session,g.grant);
 assert.equal(mainEnv.RUYI_INTERNAL_MCP_CAP,g.token);assert.equal({...mainEnv,...generated.mcpServers.ruyi.env}.RUYI_INTERNAL_MCP_CAP,g.token);
 for(const name of ['external','desktop']){const childEnv={...mainEnv,...generated.mcpServers[name].env};assert.equal(childEnv.RUYI_INTERNAL_MCP_CAP,'');assert.equal(childEnv.RUYI_INTERNAL_MCP_PORT,'');assert.equal(childEnv.WCW_TOKEN,'');}
 assert.equal(generated.mcpServers.external.env.USER_EXTERNAL_SECRET,'keep');
 const spawnEnv=vm.runInContext(functionBlock(original('04-permission-runtime.js'),'bridgedServerSpawnEnv')+'\nbridgedServerSpawnEnv',f.context);assert.equal(spawnEnv(mainEnv,{USER_EXTERNAL_SECRET:'keep'}).RUYI_INTERNAL_MCP_CAP,undefined);
 f.context.paths.generated='C:/base/generated';
 const memory=vm.runInContext(constBlock(read('13ad-memory-cli-relay.js'),'MemoryCliRelay')+'\nMemoryCliRelay',Object.assign(f.context,{fsp:{mkdir:async()=>{}},atomicWriteJson:async()=>{}}));const restricted=await memory.create({session:f.state.session,executionOwner:f.owner,config:f.state.config});
 assert.equal({...mainEnv,...restricted.definition.env}.RUYI_INTERNAL_MCP_CAP,'');assert.equal(restricted.definition.env.RUYI_INTERNAL_MCP_PORT,'');
 const transport=transportFixture(()=>{});await transport.relay.startRelay();assert.equal(transport.proc.env.RUYI_INTERNAL_MCP_CAP,undefined);assert.equal(transport.proc.env.RUYI_INTERNAL_MCP_PORT,undefined);
});

test('an expired permission timer clears only its own prompt through command-core denial without stale pause or UI effects',async()=>{
 const f=fixture(),g=f.acquire(),timers=[],commands=[];f.state.config.autonomyPauseOnTimeout=true;f.context.driverAutoSessions.add('sid');g.reg.lastEventAt=123;
 Object.assign(f.context,{setTimeout:fn=>{timers.push(fn);return{};},nativeToolGate:()=> 'ask',runAutomaticInterventionDecision:(command,apply)=>{commands.push(command);apply();},settleIntervention:()=>{}});
 const ownerCheck=()=>{if(f.children.get('sid')!==g.reg)throw Error('lost exact owner');};const pending=f.context.cliPermissionService({sessionId:'sid',toolName:'Edit',input:{}},{ownerReg:g.reg,ownerCheck});
 const rejected=assert.rejects(pending,/lost exact owner/);while(!f.context.pendingPermissions.has('perm_one'))await new Promise(r=>setImmediate(r));f.context.pendingPermissions.set('new_prompt',{sessionId:'sid'});f.children.set('sid',{...g.reg});timers[0]();await rejected;
 assert.equal(commands.length,1);assert.equal(commands[0].source,'clear_permission');assert.equal(commands[0].interventionId,'perm_one');assert.equal(f.context.pendingPermissions.has('perm_one'),false);assert.equal(f.context.pendingPermissions.has('new_prompt'),true);assert.equal(g.reg.pausePending,undefined);assert.equal(g.reg.lastEventAt,123);assert.deepEqual(f.state.events.map(x=>x.type),['permission_request']);
});
