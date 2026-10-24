'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events'),{Readable}=require('node:stream'),{constBlock,functionBlock}=require('../lib/source-slice');
const src=process.env.RUYI_MEMORY_BODY_SOURCE_DIR||path.resolve(__dirname,'../../ruyi-workbench/app/src'),read=name=>fs.readFileSync(path.join(src,name),'utf8');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-memory-relay-unit-'));after(()=>{assert.ok(path.basename(root).startsWith('ruyi-memory-relay-unit-'));fs.rmSync(root,{recursive:true,force:true});});
function child(){return Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});}
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'cap-')),state={calls:0,config:{workDataEncryptionV1:true,includeWorkbenchMcp:false}},children=new Map(),settlers=new Map(),runs=new Map();
 const context={dataRoot:()=>dir,require,Buffer,TextDecoder,AbortController,console,crypto,path,fsp,activeChildren:children,turnSettlers:settlers,activeAgentRuns:runs,AGENT_RUN_TERMINAL:new Set(['succeeded','failed','cancelled']),safeSessionId:value=>/^[A-Za-z0-9_-]{1,64}$/.test(String(value))?String(value):'',commandForSelfMcp:()=>({command:process.execPath,args:['synthetic-server.js','mcp']}),paths:{data:dir,generated:dir},RUNTIME:{port:45678},RUYI_MCP_SERVER_ID:'ruyi',VERSION:'unit',MCP_TOOLS:[{name:'workbench_memory_list'},{name:'workbench_memory_read'},{name:'permission_prompt'}],PrivacyGateway:{assertSupported:()=>{}},readConfig:async()=>{if(state.onConfig)await state.onConfig();return state.config;},atomicWriteJson:async(file,value)=>fsp.writeFile(file,JSON.stringify(value)),requestIsLoopback:req=>req.loopback!==false,json:(value,status=200)=>({value,status}),send:(res,payload)=>{res.payload=payload;res.writableEnded=true;},listWorkbenchMemories:async(args,ctx)=>{state.calls++;state.ctx=ctx;if(state.onCall)await state.onCall();return{ok:true,memories:[],args};},readWorkbenchMemory:async(args,ctx)=>{state.calls++;state.ctx=ctx;if(state.onCall)await state.onCall();return{ok:true,memory:{id:args.id,body:'PRIVATE_MEMORY_FULL_'+ 'x'.repeat(70000)}};}};
 const relay=vm.runInNewContext(constBlock(read('13ad-memory-cli-relay.js'),'MemoryCliRelay')+'\nMemoryCliRelay;',context);
 const session={id:'sid',cwd:dir,turnSeq:1,memoriesExplicit:true,memories:[{id:'one',scope:'global'}]},owner={driverRunId:'execution-one'};settlers.set('sid',owner);
 const acquire=async()=>{const grant=await relay.create({session,executionOwner:owner,config:state.config}),reg={child:child(),kind:'claude',state:'running',exited:false,session,executionOwner:owner};children.set('sid',reg);relay.bind(grant,reg,owner);return{grant,reg,token:grant.definition.env.RUYI_MEMORY_CAP};};
 const request=async(token,body,headers={},stream)=>{const req=Readable.from(stream||[Buffer.from(JSON.stringify(body))]);req.method='POST';req.headers={'x-ruyi-memory-cap':token,...headers};const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false});await relay.handle(req,res,'/api/memory-cli');return res.payload;};
 return{dir,state,children,settlers,runs,context,relay,session,owner,acquire,request};
}

test('main capability config exposes only a scoped relay, no global token/external MCP, and lists exactly two read tools',async()=>{
 const f=fixture(),{token,grant}=await f.acquire(),definition=JSON.parse(fs.readFileSync(grant.configPath)).mcpServers;assert.deepEqual(Object.keys(definition),['ruyi']);assert.ok(definition.ruyi.args.includes('--memory-read-only'));assert.equal(definition.ruyi.env.WCW_TOKEN,'');
 const result=await f.request(token,{op:'list'});assert.equal(result.status,200);assert.deepEqual(Array.from(result.value.tools,t=>t.name),['workbench_memory_list','workbench_memory_read']);assert.equal(f.state.calls,0);
});

test('call whitelist is independent of listing and neither metadata injection nor general API tokens grant authority',async()=>{
 const f=fixture(),{token}=await f.acquire();
 for(const body of [{op:'call',name:'permission_prompt',args:{}},{op:'call',name:'tool_invoke_read',args:{}},{op:'call',name:'workbench_memory_read',args:{id:'one',sessionId:'another'}},{op:'call',name:'workbench_memory_read',args:{id:'../one'}},{op:'list',sessionId:'another'}])assert.equal((await f.request(token,body)).status,403);
 assert.equal((await f.request('management-token',{op:'list'},{'x-wcw-token':'management-token'})).status,403);assert.equal(f.state.calls,0);
});

test('read receives actual parent selection/cwd/turn and returns the full legal body beyond 60K',async()=>{
 const f=fixture(),{token}=await f.acquire(),out=await f.request(token,{op:'call',name:'workbench_memory_read',args:{id:'one',scope:'global'}});assert.equal(out.status,200);assert.ok(out.value.result.memory.body.length>70000);assert.equal(f.state.ctx.session,f.session);assert.equal(f.state.ctx.turnSeq,1);assert.equal(f.state.ctx.workingDir,f.session.cwd);assert.equal(f.state.ctx.memoryLiveRead,true);assert.equal(f.state.ctx.memoryReadOwner(),true);
});

test('owner replacement, pause, exit, cancellation and close revoke old-session tokens before any domain read',async()=>{
 for(const mutate of [(f,g)=>f.children.set('sid',{...g.reg}),(f,g)=>{g.reg.state='paused';},(f,g)=>{g.reg.child.exitCode=0;},f=>{f.owner.cancelRequested=true;},(f,g)=>g.reg.child.emit('close')]){
 const f=fixture(),g=await f.acquire();mutate(f,g);assert.equal((await f.request(g.token,{op:'call',name:'workbench_memory_read',args:{id:'one'}})).status,403);assert.equal(f.state.calls,0);}
 const f=fixture(),old=await f.acquire();old.reg.child.emit('close');const next=await f.acquire();assert.equal((await f.request(old.token,{op:'list'})).status,403);assert.equal((await f.request(next.token,{op:'list'})).status,200);
});

test('every async boundary rechecks the exact owner and never publishes a body after stop',async()=>{
 const f=fixture(),{token}=await f.acquire();f.state.onConfig=()=>{f.owner.cancelRequested=true;};assert.equal((await f.request(token,{op:'call',name:'workbench_memory_read',args:{id:'one'}})).status,403);assert.equal(f.state.calls,0);
 const g=fixture(),lease=await g.acquire();g.state.onCall=()=>{g.children.delete('sid');};const denied=await g.request(lease.token,{op:'call',name:'workbench_memory_read',args:{id:'one'}});assert.equal(denied.status,403);assert.equal(denied.value.result,undefined);
 const h=fixture(),credential=await h.acquire();async function* stream(){yield Buffer.from('{"op":');h.children.delete('sid');yield Buffer.from('"list"}');}assert.equal((await h.request(credential.token,{}, {},stream())).status,403);assert.equal(h.state.calls,0);
});

test('memory key failures remain stable errors and browser transports are denied without execution',async()=>{
 const f=fixture(),{token}=await f.acquire();f.state.onCall=()=>{throw Object.assign(new Error('PRIVATE_PATH_MUST_NOT_LEAK'),{code:'work_data_key.absent'});};const result=await f.request(token,{op:'call',name:'workbench_memory_read',args:{id:'one'}});assert.equal(result.status,503);assert.equal(result.value.code,'work_data_key.absent');assert.ok(!JSON.stringify(result).includes('PRIVATE_PATH'));
 assert.equal((await f.request(token,{op:'list'},{origin:'http://localhost'})).status,403);
});

function nodeContext(f){const ctrl=new AbortController(),node={id:'node',attempts:1,status:'running'},runtime={run:{id:'run_one',sessionId:'sid',status:'running',nodes:[node]},nodeControls:new Map([['node',ctrl]]),ctrl:new AbortController()};f.runs.set('run_one',runtime);return{runtime,runId:'run_one',node,attempt:1,ctrl,session:f.session,workingDir:f.session.cwd};}

test('workflow read/edit children get their own attempt capability without impersonating the parent CLI or enabling full MCP',async()=>{
 const f=fixture(),context=nodeContext(f),grant=await f.relay.createNode({config:f.state.config,context,subagentId:'sub_one'}),proc=child();f.relay.bindNode(grant,proc);const token=grant.definition.env.RUYI_MEMORY_CAP;
 assert.equal(f.children.size,0);assert.equal((await f.request(token,{op:'call',name:'workbench_memory_read',args:{id:'one'}})).status,200);assert.equal(f.state.ctx.memoryReadOwner(),true);assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(grant.configPath)).mcpServers),['ruyi']);context.ctrl.abort();assert.equal((await f.request(token,{op:'list'})).status,403);
});

test('workflow attempt/runtime/controller replacement and exited child cannot reuse a read-only node token',async()=>{
 for(const mutate of [(f,c,p)=>{c.node.attempts++;},(f,c)=>f.runs.set('run_one',{...c.runtime}),(f,c)=>c.runtime.nodeControls.set('node',new AbortController()),(f,c,p)=>{p.exitCode=0;},(f,c)=>{c.runtime.stopRequested=true;}]){
 const f=fixture(),context=nodeContext(f),grant=await f.relay.createNode({config:f.state.config,context,subagentId:'sub_one'}),proc=child();f.relay.bindNode(grant,proc);mutate(f,context,proc);assert.equal((await f.request(grant.definition.env.RUYI_MEMORY_CAP,{op:'list'})).status,403);}
});

test('Kimi stdio definition uses absent type and named env pairs; new and resume/load share the exact supplied lifecycle',async()=>{
 const f=fixture(),{grant}=await f.acquire(),server=f.relay.kimiDefinition(grant);assert.equal(Object.hasOwn(server,'type'),false);assert.ok(Array.isArray(server.env));assert.equal(server.env.find(x=>x.name==='WCW_TOKEN').value,'');
 const names=['kimiAcpCapabilityState','kimiAcpLifecycle','kimiAcpSessionRestoreMethods','kimiAcpMethodNotFound','kimiAcpRestoreSession'];const bridge=read('05b-kimi-bridge.js');
 const api=vm.runInNewContext(names.map(name=>functionBlock(bridge,name)).join('\n')+'\n({kimiAcpLifecycle,kimiAcpRestoreSession});',{});const lifecycle=api.kimiAcpLifecycle({additionalDirectories:true},f.dir,[],()=>{},[server]);assert.equal(lifecycle.mcpServers[0],server);
 for(const method of ['resume','load']){const calls=[],rpc={request:async(name,params)=>{calls.push({name,params});return{};}},caps={loadSession:method==='load',sessionCapabilities:{resume:method==='resume'?{}:false}};await api.kimiAcpRestoreSession(rpc,'old-native-session',lifecycle,caps,{},()=>{},null);assert.equal(calls[0].params.mcpServers[0],server);assert.equal(calls[0].params.sessionId,'old-native-session');}
});



test('ROUTE_AUTH accepts only the exact bounded loopback capability transport and cannot reuse it as API authority',()=>{
 const f=fixture(),table=constBlock(read('01b-route-auth.js'),'ROUTE_AUTH'),source=functionBlock(read('01-config.js'),'authorizeRoute');
 const authorize=vm.runInNewContext(table+'\n'+source+'\nauthorizeRoute;',{MAX_BODY_BYTES:128*1024*1024,requestIsLoopback:req=>req.local!==false,tokenOk:req=>req.headers['x-wcw-token']==='management-token',originOk:()=>true});
 const request={headers:{'x-ruyi-memory-cap':'a'.repeat(64)}};assert.equal(authorize(request,'POST','/api/memory-cli'),null);
 for(const route of ['/api/memory-cli/other','/api/memory-cli?extra'])assert.notEqual(authorize(request,'POST',route),null);
 for(const method of ['GET','DELETE','HEAD'])assert.notEqual(authorize(request,method,'/api/memory-cli'),null);
 for(const req of [{headers:{'x-wcw-token':'management-token'}},{local:false,headers:request.headers},{headers:{...request.headers,origin:'http://localhost'}},{headers:{...request.headers,'content-length':'16385'}}])assert.notEqual(authorize(req,'POST','/api/memory-cli'),null);
 assert.notEqual(authorize(request,'POST','/api/tools/file_write'),null);
});

test('full MCP keeps complete memory results while unrelated tool results keep their original truncation',async()=>{
 const f=fixture(),output=[],truncated=[];let result={ok:true,memory:{id:'one',body:'x'.repeat(70000)}};
 Object.assign(f.context,{InternalMcpHooks:{},MAX_BODY_BYTES:128*1024*1024,dataRoot:()=>f.dir,process,TOOL_PACK_DESCRIPTIONS:{core:'core'},isStewardToolName:()=>false,VisualPipeline:{extractToolImages:()=>[]},toolCall:async()=>result,truncateToolResult:(name,text)=>{truncated.push(name);return'TRUNCATED';}});
 const relay=vm.runInNewContext(constBlock(read('13af-internal-mcp-relay.js'),'InternalMcpRelay')+'\nInternalMcpRelay;',f.context);
 const grant=relay.create({session:f.session,executionOwner:f.owner,config:f.state.config}),reg={child:child(),kind:'claude',state:'running',exited:false,session:f.session,executionOwner:f.owner};f.children.set('sid',reg);relay.bind(grant,reg,f.owner);
 const call=async(name,id)=>{const req=Readable.from([Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{}}}))]);req.method='POST';req.headers={'x-ruyi-internal-mcp-cap':grant.definition.env.RUYI_INTERNAL_MCP_CAP};const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,headersSent:false,writeHead(){this.headersSent=true;},write(line){output.push(JSON.parse(line));return true;},end(){this.writableEnded=true;}});await relay.handle(req,res,'/api/mcp/internal/request');return output.find(x=>x.id===id).result;};
 assert.ok((await call('workbench_memory_read',1)).content[0].text.length>70000);assert.equal(truncated.length,0);assert.equal((await call('file_read',2)).content[0].text,'TRUNCATED');assert.deepEqual(truncated,['file_read']);
});


test('restricted stdio independently rejects resources/typed invocation and forwards only list/read without a management token',async()=>{
 const stdin=Object.assign(new EventEmitter(),{setEncoding(){},pause(){this.paused=true;}}),output=[],posts=[];
 const proc={env:{RUYI_MEMORY_CAP:'a'.repeat(64),RUYI_MEMORY_PORT:'45678',WCW_TOKEN:'MUST_BE_BLANKED'},stdin,stdout:{write:text=>output.push(JSON.parse(text))}};
 const http={request:(options,callback)=>{const req=new EventEmitter();req.setTimeout=()=>{};req.end=body=>{posts.push({options,body:JSON.parse(body)});queueMicrotask(()=>{const response=Object.assign(new EventEmitter(),{statusCode:200});callback(response);const value=JSON.parse(body).op==='list'?{ok:true,tools:[{name:'workbench_memory_read'},{name:'workbench_memory_list'}]}:{ok:true,result:{ok:true,memory:{body:'x'.repeat(70000)}}};response.emit('data',Buffer.from(JSON.stringify(value)));response.emit('end');});};return req;}};
 const relay=vm.runInNewContext(constBlock(read('13ad-memory-cli-relay.js'),'MemoryCliRelay')+'\nMemoryCliRelay;',{require:name=>{assert.equal(name,'node:http');return http;},Buffer,TextDecoder,crypto,process:proc,RUYI_MCP_SERVER_ID:'ruyi',VERSION:'unit'});await relay.startRelay();assert.equal(proc.env.WCW_TOKEN,undefined);
 const call=async(method,params,id)=>{stdin.emit('data',JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');for(let i=0;i<20&&!output.some(row=>row.id===id);i++)await new Promise(resolve=>setImmediate(resolve));return output.find(row=>row.id===id);};
 assert.deepEqual((await call('tools/list',{},1)).result.tools.map(x=>x.name),['workbench_memory_read','workbench_memory_list']);assert.ok((await call('tools/call',{name:'workbench_memory_read',arguments:{id:'one'}},2)).result.content[0].text.length>70000);const before=posts.length;
 assert.ok((await call('tools/call',{name:'tool_invoke_read',arguments:{name:'file_read'}},3)).error);assert.ok((await call('resources/read',{uri:'file:///sensitive'},4)).error);assert.equal(posts.length,before);assert.ok(posts.every(row=>row.options.headers['x-ruyi-memory-cap']==='a'.repeat(64)&&!row.options.headers['x-wcw-token']));
 stdin.emit('data','x'.repeat(16385));assert.equal(stdin.paused,true);assert.equal(posts.length,before);
});


test('Claude CLI adapter enables only the two readonly names for the restricted config and preserves OFF args',async()=>{
 const adapter=vm.runInNewContext(constBlock(read('05-claude-engine.js'),'AGENT_CLI_ADAPTERS')+'\nAGENT_CLI_ADAPTERS.claude;',{RUYI_MCP_CLI_TOOL_PREFIX:'mcp__ruyi__',CLAUDE_PERMISSION_MODE_MAP:{default:'default'}});
 const base={session:{id:'sid'},config:{permissionMode:'default',permissionBridge:true,includeWorkbenchMcp:false,workDataEncryptionV1:true},basePrompt:'memory',attachments:[],interactive:false,memoryReadOnlyConfigPath:'synthetic-config.json'};
 const args=await adapter.buildArgs(base);assert.equal(args[args.indexOf('--mcp-config')+1],'synthetic-config.json');assert.deepEqual(String(args[args.indexOf('--allowedTools')+1]).split(','),['mcp__ruyi__workbench_memory_list','mcp__ruyi__workbench_memory_read']);assert.ok(!args.includes('--permission-prompt-tool'));
 const off=await adapter.buildArgs({...base,memoryReadOnlyConfigPath:undefined,config:{...base.config,workDataEncryptionV1:false}});assert.ok(!off.includes('--mcp-config'));assert.ok(!off.includes('--allowedTools'));assert.ok(off.includes('--permission-prompt-tool'));
});

test('native CLI encrypted prompts give read-by-id rather than ciphertext paths, while OFF native prompts keep their old path hints',()=>{
 const build=vm.runInNewContext(functionBlock(read('06d-memory-domain.js'),'buildMemoryPromptSection')+'\nbuildMemoryPromptSection;',{memorySupersededMarks:()=>null,buildCoreMemoryPromptSection:()=>'',neutralizeFenceTag:text=>text,getPromptPack:()=>({memoryHeader:(tool,byId)=>'reader:'+tool+':'+byId,memorySupersededNote:'',memoryTruncated:'truncated'}),memorySupersededTag:()=>'',memoryIndexCharCap:()=>10000});
 const entries=[{id:'one',scope:'global',file:'C:/synthetic/ciphertext/one.md',name:'name',description:'description'}];
 const on=build(entries,'claude',{workDataEncryptionV1:true});assert.ok(on.includes('workbench_memory_read'));assert.ok(on.includes('[one](global)'));assert.ok(!on.includes(entries[0].file));
 const off=build(entries,'claude',{workDataEncryptionV1:false});assert.ok(off.includes('reader:Read'));assert.ok(off.includes(entries[0].file));
});


test('explicit full MCP keeps full/external node authority beside an independently named reader',async()=>{
 const f=fixture(),context=nodeContext(f),base=path.join(f.dir,'full.json'),full={command:'full-host',args:['mcp'],env:{WCW_TOKEN:'explicit-full'}};
 await fsp.writeFile(base,JSON.stringify({mcpServers:{ruyi:full,external:{command:'external'}}}));
 const grant=await f.relay.createNode({config:{...f.state.config,includeWorkbenchMcp:true},context,subagentId:'exec',baseConfigPath:base});
 const servers=JSON.parse(fs.readFileSync(grant.configPath)).mcpServers;assert.deepEqual(servers.ruyi,full);assert.equal(servers.external.command,'external');assert.ok(servers['ruyi-memory'].args.includes('--memory-read-only'));assert.equal(grant.serverId,'ruyi-memory');
 f.relay.bindNode(grant,child());assert.equal((await f.request(grant.definition.env.RUYI_MEMORY_CAP,{op:'call',name:'permission_prompt',args:{}})).status,403);
 assert.equal(f.relay.readerTool({includeWorkbenchMcp:true}),'mcp__ruyi-memory__workbench_memory_read');
});

test('Kimi explicitly supplies the dedicated lifecycle reader with full MCP enabled and workflow env excludes parent credentials',async()=>{
 const f=fixture();f.state.config.includeWorkbenchMcp=true;const {grant}=await f.acquire(),server=f.relay.kimiDefinition(grant);assert.equal(server.name,'ruyi-memory');assert.equal(server.env.find(row=>row.name==='WCW_TOKEN').value,'');
 const source=read('05-claude-engine.js'),adapters=vm.runInNewContext(constBlock(source,'AGENT_CLI_ADAPTERS')+'\nAGENT_CLI_ADAPTERS;',{});assert.equal(adapters.kimi.memoryMcpViaLifecycle,true);assert.equal(adapters.claude.memoryMcpViaLifecycle,false);const shape=vm.runInNewContext(constBlock(fs.readFileSync(path.join(__dirname,'agent-cli-adapters.test.js'),'utf8'),'INTERFACE')+'\nINTERFACE;');for(const value of Object.values(adapters))assert.deepEqual(Object.keys(value).sort(),Object.keys(shape).sort());
 assert.ok(source.includes('(!config.includeWorkbenchMcp || adapter.memoryMcpViaLifecycle)'));
 const node=read('07-autonomy.js');assert.ok(node.includes("for (const key of ['WCW_SESSION_ID', 'WCW_PORT', 'WCW_HOST', 'WCW_TOKEN']) delete env[key]"));
});


test('an existing explicitly configured reader name is refused without overwriting any user server',async()=>{
 const f=fixture(),context=nodeContext(f),base=path.join(f.dir,'collision.json'),raw=JSON.stringify({mcpServers:{'ruyi-memory':{command:'user-owned'}}});await fsp.writeFile(base,raw);
 await assert.rejects(()=>f.relay.createNode({config:{...f.state.config,includeWorkbenchMcp:true},context,subagentId:'collision',baseConfigPath:base}),{code:'memory_cli.server_conflict'});assert.equal(fs.readFileSync(base,'utf8'),raw);assert.equal(fs.existsSync(path.join(f.dir,'workbench.memory-mcp.collision.json')),false);
});


test('full MCP retries refresh the reader overlay without modifying or reinterpreting their original full config',async()=>{
 const f=fixture(),context=nodeContext(f),base=path.join(f.dir,'workbench.mcp.retry.json'),raw=JSON.stringify({mcpServers:{ruyi:{command:'full-host',args:['mcp']},external:{command:'external'}}});await fsp.writeFile(base,raw);
 const input={config:{...f.state.config,includeWorkbenchMcp:true},context,subagentId:'retry',baseConfigPath:base},first=await f.relay.createNode(input),proc=child();f.relay.bindNode(first,proc);proc.emit('close');const second=await f.relay.createNode(input);
 assert.notEqual(first.configPath,base);assert.equal(first.configPath,second.configPath);assert.notEqual(first.definition.env.RUYI_MEMORY_CAP,second.definition.env.RUYI_MEMORY_CAP);assert.equal(fs.readFileSync(base,'utf8'),raw);assert.equal((await f.request(first.definition.env.RUYI_MEMORY_CAP,{op:'list'})).status,403);
 f.relay.bindNode(second,child());assert.equal((await f.request(second.definition.env.RUYI_MEMORY_CAP,{op:'list'})).status,200);
});
