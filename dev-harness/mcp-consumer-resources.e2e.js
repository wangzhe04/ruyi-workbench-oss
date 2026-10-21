'use strict';
// Real generated host API and two real stdio relay children. All grants, files,
// tokens and receiver bytes are synthetic and owned by this isolated fixture.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { killOwnTree } = require('./lib/kill-own-tree');
const { fixture } = require('./lib/privacy-test-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-consumer-relay-')), data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('./lib/server-internals').loadServerInternals(['McpConsumers', 'PrivacyCore', 'PrivacyGateway', 'handleApi', 'send', 'mutateConfig', 'readConfig', 'journalReadIndex', 'journalRollback', 'loadSession', 'saveSession', 'activeChildren', 'recordSessionExecutionOwner', 'turnSettlers', 'generateMcpConfig', 'syncMcpServersToKimiNow', 'classifyAgentMcpCandidate'], { withEval: true });
const { vault } = fixture(); app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
const t = createRunner('MCP CONSUMER RESOURCES'), { ok } = t;
const serverFile = path.resolve(__dirname, '../ruyi-workbench/app/server.js'), children = [], adminToken = 'a'.repeat(32);
let server, base, serial = 0; const openedConnections = [], observedRequests = [], ownedLeases=[]; let heldLeaseToken=null, heldLeaseAck=null, progressDrop=null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(body, headers = {}, endpoint = '/api/mcp/consumers', raw = false) {
  // Consumer transport is deliberately non-browser. Undici fetch automatically
  // adds Sec-Fetch-Mode:cors and must not be used to stand in for this transport.
  if(endpoint==='/api/mcp/consumer'||endpoint==='/api/mcp/internal/verify')return new Promise((resolve,reject)=>{
    const bytes=Buffer.from(raw?body:JSON.stringify(body));
    const owned=http.request(base+endpoint,{method:'POST',headers:{'content-type':'application/json',...(headers['transfer-encoding']?{}:{'content-length':bytes.length}),...headers}},response=>{
      let text='';response.on('data',chunk=>{text+=chunk;});response.on('end',()=>{let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:response.statusCode,value,text});});response.on('error',reject);
    });owned.setTimeout(10000,()=>owned.destroy(Error('Owned consumer HTTP timeout')));owned.on('error',reject);owned.end(bytes);
  });
  const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ? body : JSON.stringify(body), signal:AbortSignal.timeout(10000) });
  const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, value, text };
}
const management = body => request(body, { 'x-wcw-token': adminToken });
async function bindLease(issued,connection){
  return new Promise((resolve,reject)=>{let ack=false;const bytes=Buffer.from(JSON.stringify({op:'lease',consumerId:issued.consumer.id,...connection}));
    const owned=http.request(base+'/api/mcp/consumer',{method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,'x-ruyi-mcp-consumer':issued.token}},response=>{
      response.on('data',chunk=>{if(response.statusCode!==200||chunk.toString().trim()){owned.destroy();if(!ack)reject(Error('Owned lease refused'));return;}if(!ack){ack=true;owned.setTimeout(45000);resolve();}});response.on('error',()=>{if(!ack)reject(Error('Owned lease failed'));});
    });ownedLeases.push(owned);owned.setTimeout(5000,()=>owned.destroy(Error('Owned lease ACK timeout')));owned.on('error',error=>{if(!ack)reject(error);});owned.end(bytes);
  });
}
async function create(label, tools = ['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'file_copy', 'file_move'], resourceGrants=['capabilities','workspace']) {
  const issued = await management({ op: 'create', label, workspace, tools, resources: resourceGrants });
  if (issued.status !== 200) throw Error('Synthetic consumer setup failed');
  const entry = Object.values(issued.value.configuration.mcpServers)[0];
  return { ...issued.value, entry, token: entry.env.RUYI_MCP_CONSUMER_TOKEN };
}
function client(issued, extra = {}, internal = false) {
  const env = { ...process.env, ...issued.entry.env, ...extra };
  if (!internal) { delete env.WCW_TOKEN; delete env.WCW_PORT; delete env.WCW_HOST; delete env.WCW_SESSION_ID; }
  const child = cp.spawn(process.execPath, [...(extra.FIXTURE_OBSERVER?['--require',extra.FIXTURE_OBSERVER]:[]),serverFile, 'mcp', ...(internal ? [] : ['--consumer'])], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }); children.push(child);
  const observations=[]; child.on('message',value=>observations.push(value));
  const replies = new Map(), replyCounts = new Map(), notifications = []; let buffer = '', errors = '';
  child.stdin.on('error', () => {}); child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue; const row = JSON.parse(line); if (row.id !== undefined) { replyCounts.set(row.id,(replyCounts.get(row.id)||0)+1); replies.set(row.id, row); } else notifications.push(row); } });
  const send = async (method, params = {}, explicitId) => {
    const id = explicitId === undefined ? ++serial : explicitId; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let attempt = 0; attempt < 400; attempt++) { if (replies.has(id)) { const value = replies.get(id); replies.delete(id); return value; } if (child.exitCode !== null) throw Error('Owned relay exited'); await pause(25); }
    throw Error('Owned relay reply timed out');
  };
  return { child, send, observations, replyCount:id=>replyCounts.get(id)||0, notify:(method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n'), notifications, errors: () => errors };
}
async function host() {
  server = http.createServer((req, res) => {
    res.once('close',()=>{if(req.url==='/api/mcp/consumer'&&req.fixtureOp==='request'&&!res.writableEnded)transportClosed.add(req.headers['x-ruyi-mcp-consumer']+':'+typeof req.fixtureMessageId+':'+String(req.fixtureMessageId));});
    // Observe exact owned HTTP bytes without consuming/replacing the request stream.
    const push=req.push, chunks=[];
    req.push=function(chunk,...rest){ if(chunk)chunks.push(Buffer.from(chunk));else {try{const body=JSON.parse(Buffer.concat(chunks));req.fixtureOp=body.op;req.fixtureMessageId=body.message?.id;observedRequests.push({token:req.headers['x-ruyi-mcp-consumer'],body});}catch{}}return push.call(this,chunk,...rest);};
    const write=res.write;
    res.write=function(chunk,...rest){
      const fault=leaseFaults.get(req.headers['x-ruyi-mcp-consumer']);
      if(fault&&req.fixtureOp==='lease'){
        let value;try{value=JSON.parse(String(chunk));}catch{}
        if(value?.method==='notifications/resources/updated'){
          fault.count++;
          if(fault.mode==='post-owner'){if(!fault.queued){fault.queued=true;queueMicrotask(()=>{app.recordSessionExecutionOwner(fault.auditId,fault.owner);fault.changed=true;});}return write.call(this,chunk,...rest);}
          if(fault.mode==='false')return false;
          if(fault.mode==='fragment'){const bytes=String(chunk),middle=Math.floor(bytes.length/2);const result=write.call(this,bytes.slice(0,middle));setTimeout(()=>{if(!this.destroyed)write.call(this,bytes.slice(middle));},10);return result;}
          if(fault.mode==='uri')value.params.uri='file:///not-granted';
          if(fault.mode==='extra')value.params.extra='MUST-NOT-FORWARD';
          if(fault.mode==='malformed')return write.call(this,'not-json\n');
          if(fault.mode==='oversize')return write.call(this,'x'.repeat(600)+'\n');
          return write.call(this,JSON.stringify(value)+'\n');
        }
      }
      if(progressDrop && req.headers['x-ruyi-mcp-consumer']===progressDrop.token){
        try { const value=JSON.parse(String(chunk)); if(value.id===progressDrop.id && Object.hasOwn(value,'result')){progressDrop.dropped++;if(progressDrop.mode==='close')this.destroy();return true;} } catch {}
      }
      if(heldLeaseToken && req.headers['x-ruyi-mcp-consumer']===heldLeaseToken && String(chunk)==='\n'){
        if(!heldLeaseAck)heldLeaseAck=()=>{heldLeaseToken=null;return write.call(this,chunk,...rest);};return true;
      }
      return write.call(this,chunk,...rest);
    };
    const end = res.end; res.end = function(chunk, ...rest) {
      try { const value=JSON.parse(String(chunk)); if(value.connectionId) openedConnections.push({token:req.headers['x-ruyi-mcp-consumer'],value}); } catch {}
      return end.call(this,chunk,...rest);
    };
    void app.handleApi(req, res, new URL(req.url, 'http://local').pathname).catch(() => { if (!res.headersSent) res.writeHead(500); res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  app.__eval('RUNTIME.token=' + JSON.stringify(adminToken) + ';RUNTIME.port=' + server.address().port + ';RUNTIME.host="127.0.0.1";'); await app.McpConsumers.listen();
}
const leaseFaults=new Map(),transportClosed=new Set();
const resourceStartedAt=performance.now();
const resourceDeadline=setTimeout(()=>{console.error('FAIL resource protocol whole-case deadline (360s)');for(const lease of ownedLeases)lease.destroy();for(const child of children){try{killOwnTree(child);}catch{}}if(server)server.closeAllConnections();process.exit(1);},360000);
const bodyText = result => result?.result?.content?.[0]?.text || '';

const CAP='ruyi://consumer/capabilities',WORK='ruyi://consumer/workspace';
const updates=(c,uri)=>c.notifications.filter(row=>row.method==='notifications/resources/updated'&&row.params?.uri===uri).length;
async function until(check,label,budget=22000){const end=Date.now()+budget;while(Date.now()<end){if(await check())return;await pause(25);}throw Error(label+' deadline');}
function holdRead(name,sessionId){
  app.__eval(`globalThis.__resourceHold={entered:false,calls:0,release:null,name:${JSON.stringify(name)}};globalThis.__resourceLoad=loadSession;
    loadSession=async function(...args){const value=await globalThis.__resourceLoad(...args);if(args[0]===${JSON.stringify(sessionId)})globalThis.__resourceHold.calls++;if(args[0]===${JSON.stringify(sessionId)}&&!globalThis.__resourceHold.entered){globalThis.__resourceHold.entered=true;await new Promise(resolve=>{globalThis.__resourceHold.release=resolve;});}return value;};`);
}
async function held(){await until(()=>app.__eval('Boolean(globalThis.__resourceHold?.entered)'),'actual resource snapshot hold');}
function releaseRead(){app.__eval('globalThis.__resourceHold?.release?.();loadSession=globalThis.__resourceLoad;delete globalThis.__resourceLoad;delete globalThis.__resourceHold');}
const workers=require('node:worker_threads'),originalEmit=workers.Worker.prototype.emit;let workerHold;
function holdAck(){workerHold={entered:false,release:null};workers.Worker.prototype.emit=function(event,...args){if(event==='message'&&args[0]?.ready===true&&!workerHold.entered){workerHold.entered=true;workerHold.release=()=>originalEmit.call(this,event,...args);return true;}return originalEmit.call(this,event,...args);};}
function releaseAck(){workerHold?.release?.();workers.Worker.prototype.emit=originalEmit;workerHold=null;}
async function setMode(mode){await app.mutateConfig(config=>{config.permissionMode=mode;});}
async function readResource(c,uri){const reply=await c.send('resources/read',{uri});if(reply.error||!Array.isArray(reply.result?.contents)||!reply.result.contents.length)throw Error('Actual resource read refused');return reply;}
(async()=>{try{
  await app.mutateConfig(config=>Object.assign(config,{privacyModeV1:'enhanced',privacyRulesV1:[{id:'resource-workspace',kind:'literal',value:workspace,category:'INTERNAL'}],credentialEncryptionV1:true,
    permissionMode:'acceptEdits',defaultWorkspace:workspace,workspaces:[],recentWorkspaces:[],allowOutsideWorkspace:false,providers:[],schedulerEnabledV1:false,stewardEnabledV1:false,includeWorkbenchMcp:false,autoImportClaudeCodeMcp:false,desktopMcp:{enabled:false,autodetect:false}}));
  await host();const first=await create('Resource A'),second=await create('Resource B'),a=client(first),b=client(second);
  for(const c of [a,b]){const init=await c.send('initialize');ok(init.result?.capabilities?.resources?.subscribe===true,'real stdio advertises fixed-resource subscriptions');}
  const templates=await a.send('resources/templates/list'),template=templates.result?.resourceTemplates?.[0];
  ok(template?.uriTemplate==='ruyi://consumer/{kind}'&&JSON.stringify(template._meta.allowedKinds)===JSON.stringify(['capabilities','workspace']),'nonempty RFC template enumerates precisely host-granted fixed kinds');
  const views=new Map();
  for(const kind of template._meta.allowedKinds){
    const uri=template.uriTemplate.replace('{kind}',kind),reply=await readResource(a,uri),view=JSON.parse(reply.result.contents[0].text);views.set(kind,view);
    const complete=kind==='capabilities'?Array.isArray(view.grantedTools)&&view.grantedTools.length===7&&view.currentlyAvailableTools.includes('file_write')&&view.resources.includes('workspace')&&view.templates[0].uriTemplate===template.uriTemplate&&view.subscriptions===true&&view.osIsolation===false
      :typeof view.workspace==='string'&&view.workspace.length>0&&view.workspace!==workspace&&view.permissions==='existing-workbench-permission-floor'&&view.grantRevision===first.consumer.revision;
    ok(complete&&reply.result.contents[0].uri===uri&&reply.result.contents[0].mimeType==='application/json'&&!JSON.stringify(reply).includes(workspace)&&!JSON.stringify(reply).includes(adminToken),'both template expansions return complete actual protected schemas/content, not empty or error views');
  }
  const otherWorkspace=JSON.parse((await readResource(b,WORK)).result.contents[0].text).workspace;
  ok(otherWorkspace!==views.get('workspace').workspace&&!otherWorkspace.includes(workspace)&&Boolean((await b.send('resources/read',{uri:views.get('workspace').workspace})).error),'connection-local protected workspace aliases differ and cannot become another consumer resource authority');
  const limited=await create('Limited resources',['file_read','file_write'],['capabilities']),c=client(limited);await c.send('initialize');
  const limitedTemplates=await c.send('resources/templates/list');ok(JSON.stringify(limitedTemplates.result.resourceTemplates[0]._meta.allowedKinds)==='["capabilities"]','separate consumer template does not enumerate an ungranted workspace');
  for(const method of ['resources/read','resources/subscribe','resources/unsubscribe'])for(const uri of [WORK,'file:///arbitrary','ruyi://consumer/unknown'])ok(Boolean((await c.send(method,{uri,scopeId:'forged',connectionId:'forged'})).error),'ungranted/unknown/file URI and forged routing never add resource authority');
  for(const [target,uri]of [[a,CAP],[a,WORK],[b,CAP]])ok(Boolean((await target.send('resources/subscribe',{uri})).result),'actual granted subscription receives successful ACK');
  ok(Boolean((await a.send('resources/subscribe',{uri:CAP})).result),'ready subscription is idempotent');
  await setMode('dontAsk');await until(()=>updates(a,CAP)>0&&updates(b,CAP)>0,'two actual consumers receive changed-content notification');
  ok(updates(a,WORK)===0,'unmodified workspace resource emits no fake initial/progress update');
  const reduced=await readResource(a,CAP);ok(!JSON.parse(reduced.result.contents[0].text).currentlyAvailableTools.includes('file_write'),'notification is followed by actual resource content with current permission floor');
  await b.send('resources/unsubscribe',{uri:CAP});await a.send('resources/unsubscribe',{uri:WORK});const beforeA=updates(a,CAP),beforeB=updates(b,CAP);
  const unsubscribeChangedAt=Date.now();await setMode('acceptEdits');await until(()=>updates(a,CAP)>beforeA,'retained connection subscription');await pause(Math.max(0,17000-(Date.now()-unsubscribeChangedAt)));ok(updates(b,CAP)===beforeB&&updates(a,WORK)===0,'other-connection unsubscribe and exact-URI unsubscribe suppress their notifications');
  const flip=updates(a,CAP);await app.mutateConfig(config=>{config.privacyModeV1='off';});await app.mutateConfig(config=>{config.privacyModeV1='enhanced';});await until(()=>updates(a,CAP)>flip,'policy flipback notification');
  ok(!JSON.stringify(await readResource(a,WORK)).includes(workspace),'policy-flipback notification does not bypass subsequent protected full resource read');
  // A pending worker is real: only delivery of its ready event is held. The
  // original worker, regex result, projection, final guard and authentication run.
  await a.send('resources/unsubscribe',{uri:CAP});await app.mutateConfig(config=>{config.privacyRulesV1.push({id:'resource-ack-regex',kind:'regex',value:'NEVER_RESOURCE_MATCH_123456',category:'INTERNAL'});});
  holdAck();const pendingId='pending-subscribe',pending=a.send('resources/subscribe',{uri:CAP},pendingId);await until(()=>workerHold.entered,'actual subscribe ACK worker ready hold',2000);
  const duplicate=await a.send('resources/subscribe',{uri:CAP});ok(duplicate.error&&/subscription_pending/.test(duplicate.error.message),'duplicate while first ACK pending cannot falsely succeed');
  a.notify('notifications/cancelled',{requestId:pendingId});await until(()=>transportClosed.has(first.token+':string:'+pendingId),'exact host subscription response observes abort before ACK release',2000);releaseAck();const cancelled=await pending;ok(Boolean(cancelled.error)&&!cancelled.result,'cancelled first subscribe has one refusal and no successful ACK after exact host abort');
  await app.mutateConfig(config=>{config.privacyRulesV1=config.privacyRulesV1.filter(rule=>rule.id!=='resource-ack-regex');});
  const cancelledCount=updates(a,CAP);await setMode('dontAsk');await pause(17000);ok(updates(a,CAP)===cancelledCount&&a.replyCount(pendingId)===1,'cancelled subscription remains absent across a real changed-content heartbeat');
  await a.send('resources/subscribe',{uri:CAP});holdRead('ABA',first.consumer.auditSessionId);await setMode('acceptEdits');await held();
  const abaCount=updates(a,CAP);await a.send('resources/unsubscribe',{uri:CAP});await a.send('resources/subscribe',{uri:CAP});releaseRead();await pause(200);
  ok(updates(a,CAP)===abaCount,'held old subscription callback cannot emit after unsubscribe/resubscribe ABA');
  await setMode('dontAsk');await until(()=>updates(a,CAP)>abaCount,'replacement subscription survives ABA and receives new actual source change');ok(!JSON.parse((await readResource(a,CAP)).result.contents[0].text).currentlyAvailableTools.includes('file_write'),'new ABA subscription remains live and actual current read reflects its new source change');
  holdRead('last-unsubscribe',first.consumer.auditSessionId);await setMode('acceptEdits');await held();const lastCount=updates(a,CAP);
  await a.send('resources/unsubscribe',{uri:CAP});releaseRead();await pause(200);ok(updates(a,CAP)===lastCount,'last unsubscribe releases its entry and held callback cannot emit');
  await setMode('acceptEdits');
  // Held heartbeat passes are single-flight and revocation owns their lifetime.
  await c.send('resources/subscribe',{uri:CAP});holdRead('revoke',limited.consumer.auditSessionId);await setMode('dontAsk');await held();const revokedCount=updates(c,CAP);await pause(16000);ok(app.__eval('globalThis.__resourceHold.calls')===1,'held actual heartbeat does not start a second concurrent resource check');
  await management({op:'revoke',id:limited.consumer.id});releaseRead();await pause(200);
  ok(updates(c,CAP)===revokedCount&&Boolean((await c.send('resources/read',{uri:CAP})).error),'retire clears subscriptions and held callback cannot emit after revoke');
  await setMode('acceptEdits');const postGrant=await create('Post-write source guard',['file_read','file_write'],['capabilities']),postPeer=client(postGrant);await postPeer.send('initialize');await postPeer.send('resources/subscribe',{uri:CAP});
  let postSettle;const postOwner={promise:new Promise(resolve=>{postSettle=resolve;}),source:'fixture-native',driverRunId:'resource-post-write',phase:'running',cancelRequested:false,cancel(){this.cancelRequested=true;}};
  const postFault={mode:'post-owner',count:0,queued:false,changed:false,auditId:postGrant.consumer.auditSessionId,owner:postOwner,settle:postSettle};leaseFaults.set(postGrant.token,postFault);
  await setMode('dontAsk');await until(()=>postFault.changed&&updates(postPeer,CAP)>0,'actual post-write owner invalidation');
  if(app.turnSettlers.get(postFault.auditId)===postOwner)app.turnSettlers.delete(postFault.auditId);postSettle();const postFirst=updates(postPeer,CAP);
  await until(()=>updates(postPeer,CAP)>postFirst,'stale post-await snapshot does not advance');ok(postFault.count>=2,'post-write source invalidation preserves old snapshot and repeats only a fixed notification, never a tool');
  await postPeer.send('resources/unsubscribe',{uri:CAP});await killOwnTree(postPeer.child);leaseFaults.delete(postGrant.token);
  // Every wire fault below follows a real subscription + actual source change.
  // This is an adversarial receiver; it never creates a fake protected result.
  const peers=[];
  for(const mode of ['fragment','uri','extra','malformed','oversize','false']){const grant=await create('Parser '+mode,['file_read','file_write'],['capabilities']),peer=client(grant);await peer.send('initialize');await peer.send('resources/subscribe',{uri:CAP});leaseFaults.set(grant.token,{mode,count:0});peers.push({mode,grant,peer});}
  await setMode('acceptEdits');await app.mutateConfig(config=>{config.privacyModeV1='basic';});await app.mutateConfig(config=>{config.privacyModeV1='enhanced';});await until(()=>peers.every(item=>leaseFaults.get(item.grant.token).count>0),'actual notification peer faults');
  for(const item of peers){if(item.mode==='fragment'){await until(()=>updates(item.peer,CAP)>0,'fragmented actual relay notification');ok(true,'fragmented strict NDJSON resource update reaches actual stdio consumer');}else{await pause(100);ok(Boolean((await item.peer.send('ping')).error)&&updates(item.peer,CAP)===0,'invalid lease frame or host backpressure retires connection without arbitrary stdout delivery');}}
  leaseFaults.clear();
  const observer=path.join(root,'lease-stdout-observer.cjs');
  fs.writeFileSync(observer,`const http=require('node:http'),{PassThrough,Writable}=require('node:stream');
const originalWrite=process.stdout.write.bind(process.stdout),sink=new PassThrough({highWaterMark:1});
const destination=new Writable({highWaterMark:1,write(bytes,encoding,done){originalWrite(bytes,encoding,done);}});sink.pipe(destination);
process.stdout.write=(...args)=>sink.write(...args);sink.on('drain',()=>process.stdout.emit('drain'));sink.on('error',()=>process.exit(1));destination.on('error',()=>process.exit(1));
let lease,armed=false;const report=value=>{if(process.connected)process.send(value,()=>{});};
process.on('message',value=>{if(value?.fixtureTransport==='pause'){const pause=()=>{sink.pause();report({kind:'transport-paused'});};if(destination.writableLength)destination.once('drain',pause);else pause();}if(value?.fixtureTransport==='resume')sink.resume();});
const emit=http.ClientRequest.prototype.emit;http.ClientRequest.prototype.emit=function(event,...args){
if(event==='response'&&!lease&&this.path==='/api/mcp/consumer'&&args[0]?.headers?.['content-type']==='application/x-ndjson'){lease=args[0];lease.on('resume',()=>{if(armed)report({kind:'lease-resumed',paused:lease.isPaused(),listeners:process.stdout.listenerCount('drain')});});}return emit.call(this,event,...args);};
process.stdout.on('newListener',(event,listener)=>{if(event==='drain'&&listener.name==='resumeLease'){armed=true;report({kind:'lease-paused',paused:lease?.isPaused(),needDrain:sink.writableNeedDrain,listeners:process.stdout.listenerCount('drain')+1});}});
process.stdout.on('removeListener',(event,listener)=>{if(event==='drain'&&listener.name==='resumeLease')report({kind:'lease-listener-removed',listeners:process.stdout.listenerCount('drain')});});`);
  const pressureClients=[];
  for(const closeWhilePaused of [false,true]){
    const grant=await create('Actual stdout backpressure '+closeWhilePaused,['file_read'],['capabilities','workspace']),peer=client(grant,{FIXTURE_OBSERVER:observer});pressureClients.push(peer);await peer.send('initialize');
    await peer.send('resources/subscribe',{uri:CAP});await peer.send('resources/subscribe',{uri:WORK});
    peer.child.send({fixtureTransport:'pause'});await until(()=>peer.observations.some(value=>value.kind==='transport-paused'),'controlled Writable readable side is actually paused');
    await app.mutateConfig(config=>{config.privacyModeV1='basic';});await app.mutateConfig(config=>{config.privacyModeV1='enhanced';});
    await until(()=>peer.observations.some(value=>value.kind==='lease-paused'),'controlled real Writable false pauses actual lease response');
    ok(peer.observations.filter(value=>value.kind==='lease-paused').every(value=>value.paused===true&&value.needDrain===true&&value.listeners===1),'controlled real Writable backpressure pauses only the lease with one resume listener');
    if(closeWhilePaused){await management({op:'revoke',id:grant.consumer.id});await until(()=>peer.observations.some(value=>value.kind==='lease-listener-removed'&&value.listeners===0),'disconnect removes held lease drain listener');peer.child.send({fixtureTransport:'resume'});ok(true,'retire removes the exact paused-lease drain listener without a new queue');}
    else{peer.child.send({fixtureTransport:'resume'});await until(()=>peer.observations.some(value=>value.kind==='lease-resumed'&&!value.paused)&&updates(peer,CAP)>0,'actual drain resumes lease and complete notification');ok(true,'controlled real Writable drain resumes strict notification forwarding through common output');await peer.send('resources/unsubscribe',{uri:CAP});await peer.send('resources/unsubscribe',{uri:WORK});}
  }
  for(const peer of pressureClients)await killOwnTree(peer.child);
  // No subscriptions: normal existing heartbeat must not re-read configuration.
  for(const item of peers)await killOwnTree(item.peer.child);await killOwnTree(c.child);
  await app.mutateConfig(config=>{config.permissionMode='acceptEdits';});
  app.__eval('globalThis.__resourceReadCount=0;globalThis.__resourceReadConfig=readConfig;readConfig=async function(...args){globalThis.__resourceReadCount++;return globalThis.__resourceReadConfig(...args);};');
  await pause(17000);const idle=app.__eval('globalThis.__resourceReadCount');app.__eval('readConfig=globalThis.__resourceReadConfig;delete globalThis.__resourceReadConfig;delete globalThis.__resourceReadCount');
  ok(idle===0,'zero subscriptions across a true heartbeat perform zero configuration reads');
  ok(!fs.existsSync(path.join(data,'privacy-scopes')),'resource subscriptions retain no persistent original mappings');
}catch(error){console.error(error.stack);t.fail('uncaught resource protocol fixture');}finally{
  releaseAck();try{app.__eval('globalThis.__resourceHold?.release?.();if(globalThis.__resourceLoad)loadSession=globalThis.__resourceLoad;if(globalThis.__resourceReadConfig)readConfig=globalThis.__resourceReadConfig;');}catch{}
  for(const fault of leaseFaults.values())if(fault.owner){if(app.turnSettlers.get(fault.auditId)===fault.owner)app.turnSettlers.delete(fault.auditId);fault.settle();}
  for(const lease of ownedLeases)lease.destroy();for(const child of children)await killOwnTree(child);
  if(server){server.closeAllConnections();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned resource host close deadline')),5000);server.close(error=>{clearTimeout(timer);if(error)reject(error);else resolve();});});}
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});clearTimeout(resourceDeadline);console.log('INFO resource protocol duration_ms='+Math.round(performance.now()-resourceStartedAt));t.done();
}})();
