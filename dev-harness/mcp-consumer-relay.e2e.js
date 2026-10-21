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
const app = require('./lib/server-internals').loadServerInternals(['McpConsumers', 'PrivacyCore', 'PrivacyGateway', 'handleApi', 'send', 'mutateConfig', 'readConfig', 'journalReadIndex', 'journalRollback', 'loadSession', 'saveSession', 'activeChildren', 'generateMcpConfig', 'syncMcpServersToKimiNow', 'classifyAgentMcpCandidate'], { withEval: true });
const { vault } = fixture(); app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
const t = createRunner('MCP CONSUMER RELAY'), { ok } = t;
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
async function create(label, tools = ['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'file_copy', 'file_move']) {
  const issued = await management({ op: 'create', label, workspace, tools, resources: ['capabilities', 'workspace'] });
  if (issued.status !== 200) throw Error('Synthetic consumer setup failed');
  const entry = Object.values(issued.value.configuration.mcpServers)[0];
  return { ...issued.value, entry, token: entry.env.RUYI_MCP_CONSUMER_TOKEN };
}
function client(issued, extra = {}, internal = false) {
  const env = { ...process.env, ...issued.entry.env, ...extra };
  if (!internal) { delete env.WCW_TOKEN; delete env.WCW_PORT; delete env.WCW_HOST; delete env.WCW_SESSION_ID; }
  const child = cp.spawn(process.execPath, [serverFile, 'mcp', ...(internal ? [] : ['--consumer'])], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  const replies = new Map(), replyCounts = new Map(), notifications = []; let buffer = '', errors = '';
  child.stdin.on('error', () => {}); child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue; const row = JSON.parse(line); if (row.id !== undefined) { replyCounts.set(row.id,(replyCounts.get(row.id)||0)+1); replies.set(row.id, row); } else notifications.push(row); } });
  const send = async (method, params = {}, explicitId) => {
    const id = explicitId === undefined ? ++serial : explicitId; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let attempt = 0; attempt < 400; attempt++) { if (replies.has(id)) { const value = replies.get(id); replies.delete(id); return value; } if (child.exitCode !== null) throw Error('Owned relay exited'); await pause(25); }
    throw Error('Owned relay reply timed out');
  };
  return { child, send, replyCount:id=>replyCounts.get(id)||0, notify:(method,params)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n'), notifications, errors: () => errors };
}
async function host() {
  server = http.createServer((req, res) => {
    // Observe exact owned HTTP bytes without consuming/replacing the request stream.
    const push=req.push, chunks=[];
    req.push=function(chunk,...rest){ if(chunk)chunks.push(Buffer.from(chunk));else {try{observedRequests.push({token:req.headers['x-ruyi-mcp-consumer'],body:JSON.parse(Buffer.concat(chunks))});}catch{}}return push.call(this,chunk,...rest);};
    const write=res.write;
    res.write=function(chunk,...rest){
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
const bodyText = result => result?.result?.content?.[0]?.text || '';
(async () => {
  await app.mutateConfig(config => Object.assign(config, { privacyModeV1: 'enhanced', privacyRulesV1: [], credentialEncryptionV1: true,
    permissionMode: 'acceptEdits', defaultWorkspace: workspace, workspaces: [], recentWorkspaces: [], allowOutsideWorkspace: false,
    providers: [], schedulerEnabledV1: false, stewardEnabledV1: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false } }));
  await host();
  const first = await create('Consumer A'), second = await create('Consumer B');
  ok(first.token !== second.token && !JSON.stringify(first.configuration).includes('WCW_TOKEN'), 'independent configurations use distinct tokens, no management token');
  const stored = fs.readFileSync(path.join(data, 'mcp-consumers-v1.json'), 'utf8');
  ok(!stored.includes(first.token) && !stored.includes(second.token) && stored.includes('tokenHash'), 'host persists only token hashes and grants');
  const list = await management({ op: 'list' }); ok(!list.text.includes(first.token) && !list.text.includes(second.token), 'management list cannot recover issued tokens');
  for (const [headers, endpoint, body] of [
    [{}, '/api/mcp/consumer', { op: 'open',consumerId:first.consumer.id }],
    [{ 'x-ruyi-mcp-consumer': 'b'.repeat(64) }, '/api/mcp/consumer', { op: 'open',consumerId:first.consumer.id }],
    [{ 'x-wcw-token':adminToken }, '/api/mcp/consumer', { op: 'open',consumerId:first.consumer.id }],
    [{ 'x-ruyi-mcp-consumer': first.token, origin: 'http://127.0.0.1' }, '/api/mcp/consumer', { op: 'open',consumerId:first.consumer.id }],
    [{ 'x-ruyi-mcp-consumer': first.token, 'sec-fetch-mode': 'cors' }, '/api/mcp/consumer', { op: 'open',consumerId:first.consumer.id }],
    [{ 'x-ruyi-mcp-consumer': first.token }, '/api/mcp/consumer/', { op: 'open',consumerId:first.consumer.id }],
    [{ 'x-ruyi-mcp-consumer': first.token }, '/api/mcp/consumers', { op: 'list' }],
    [{ 'x-ruyi-mcp-consumer': first.token }, '/api/mcp/internal/verify', { sessionId: 'fake' }],
  ]) { const response = await request(body, headers, endpoint); ok(response.status === 403 && !response.text.includes(data) && !response.text.includes(first.token), 'consumer credential never authenticates browser, management, suffix or internal routes'); }
  const oversized=JSON.stringify({op:'open',consumerId:first.consumer.id,padding:'x'.repeat(1024*1024)});
  for(const framing of [{},{'transfer-encoding':'chunked'}]){const response=await request(oversized,{'x-ruyi-mcp-consumer':first.token,...framing},'/api/mcp/consumer',true);ok(response.status===403&&!response.text.includes(first.token),'valid credential still refuses oversized Content-Length or streamed body before business');}
  const a = client(first), b = client(second);
  const [initA, initB] = await Promise.all([a.send('initialize', { clientInfo: { name: 'same-client', version: '1' }, scopeId: 'forged' }), b.send('initialize', { clientInfo: { name: 'same-client', version: '1' }, scopeId: 'forged' })]);
  ok(initA.result?._meta?.identity === 'authenticated-connection' && initB.result?._meta?.identity === 'authenticated-connection', 'two real stdio consumers initialize independently despite identical clientInfo and forged scope');
  let cursor, tools = [];
  do { const response = await a.send('tools/list', cursor ? { cursor } : {}); tools.push(...response.result.tools); cursor = response.result.nextCursor; if (cursor) ok((await b.send('tools/list', { cursor })).error, 'a paging cursor cannot move to another connection'); } while (cursor);
  const oldPage = await a.send('tools/list');
  await app.mutateConfig(config => { config.privacyModeV1 = 'off'; });
  await app.mutateConfig(config => { config.privacyModeV1 = 'enhanced'; });
  ok(Boolean((await a.send('tools/list', { cursor: oldPage.result.nextCursor })).error), 'policy flipback invalidates issued cursor rather than resuming a new snapshot');
  ok(tools.length === 7 && tools.every(tool => first.consumer.tools.includes(tool.name)), 'actual paginated tools list advertises precisely the explicit native grant');
  ok((await a.send('resources/templates/list')).result.resourceTemplates.length === 0, 'unsupported templates are accurately empty');
  const listed = await a.send('resources/list'); ok(listed.result.resources.length === 2, 'resources list offers useful fixed safe summaries');
  for (const resource of listed.result.resources) { const value = await a.send('resources/read', { uri: resource.uri }); ok(value.result.contents[0].mimeType === 'application/json' && !JSON.stringify(value).includes(adminToken), 'each offered resource reads through the authenticated output boundary'); }
  ok((await a.send('resources/read', { uri: 'file://' + path.join(data, 'config.json') })).error, 'raw config and arbitrary resource URIs are not granted');
  ok((await a.send('resources/subscribe', { uri: listed.result.resources[0].uri })).error?.code === -32601, 'subscriptions are not advertised or silently accepted');
  const privateFile = path.join(workspace, 'source.txt'); fs.writeFileSync(privateFile, 'consumer-private@example.test');
  const originalProgressRules=(await app.readConfig()).privacyRulesV1;
  await app.mutateConfig(config=>{config.privacyRulesV1=[...originalProgressRules,{id:'progress-body-fixture',kind:'literal',value:'Operation started',category:'INTERNAL'}];});
  const read = await a.send('tools/call', { name: 'file_read', arguments: { path: privateFile }, _meta: { progressToken: 'safe-progress' } });
  const protectedText = bodyText(read), alias = protectedText.match(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/)?.[0];
  ok(alias && !protectedText.includes('consumer-private@example.test'), 'actual file receiver result is fully protected');
  const stringProgress=a.notifications.find(row=>row.method==='notifications/progress'&&row.params.progressToken==='safe-progress');
  ok(stringProgress && typeof stringProgress.params.message==='string' && !stringProgress.params.message.includes('Operation started') && !JSON.stringify(read).includes('consumer-private@example.test'), 'string progress routing token is exact while configured-secret host message and actual source result remain protected');
  const numericRead=await a.send('tools/call',{name:'file_read',arguments:{path:privateFile},_meta:{progressToken:42}});
  const numericProgress=a.notifications.find(row=>row.method==='notifications/progress'&&row.params.progressToken===42);
  ok(!numericRead.result?.isError && Array.isArray(numericRead.result?.content) && numericProgress && typeof numericProgress.params.progressToken==='number' && typeof numericProgress.params.message==='string' && !numericProgress.params.message.includes('Operation started') && !JSON.stringify(numericRead).includes('consumer-private@example.test'), 'numeric progress routing token preserves type/value while notification body and actual file result remain protected');
  await app.mutateConfig(config=>{config.privacyRulesV1=originalProgressRules;});
  const ownDestination = path.join(workspace, 'own-copy.txt'), foreignDestination = path.join(workspace, 'foreign-copy.txt');
  const workspaceStat=fs.statSync(workspace), ceilingIdentity=[workspaceStat.dev,workspaceStat.ino,workspaceStat.birthtimeMs].join(':');
  const withCeiling=app.__eval('withFileAccessCeiling'), assertCeiling=app.__eval('assertFileAccessCeiling');
  let descriptorAccepted=false;
  await withCeiling(workspace,ceilingIdentity,async()=>{await assertCeiling([{path:path.join(workspace,'owned.tmp'),temporaryFor:ownDestination}]);descriptorAccepted=true;});
  ok(descriptorAccepted,'host atomic temporary descriptor checks actual and intended local paths inside ceiling');
  for(const descriptor of [{path:path.join(root,'outside.tmp'),temporaryFor:ownDestination},{path:path.join(workspace,'owned.tmp'),temporaryFor:path.join(root,'outside.txt')},{path:{}},{temporaryFor:ownDestination},{path:ownDestination,temporaryFor:42},{path:''},{path:ownDestination,temporaryFor:''},{path:'relative.tmp',temporaryFor:ownDestination}]){
    let refused=false;try{await withCeiling(workspace,ceilingIdentity,()=>assertCeiling([descriptor]));}catch(error){refused=error.code==='mcp_consumer.workspace_denied';}
    ok(refused,'outside actual/intent or malformed host IO descriptor never bypasses workspace ceiling');
  }
  const write = await a.send('tools/call', { name: 'file_write', arguments: { path: ownDestination, content: alias } });
  ok(!write.result?.isError && fs.readFileSync(ownDestination, 'utf8') === 'consumer-private@example.test', 'same connection can perform an explicitly granted local write under existing permission floor');
  if(!Number.isFinite(write.result?._meta?.turnSeq))throw Error('Actual write did not return audit turn metadata; inspect fixed refusal before checkpoint checks');
  const auditId = first.consumer.auditSessionId, writeSeq = write.result?._meta?.turnSeq;
  const audit = await app.loadSession(auditId), journal = await app.journalReadIndex(auditId);
  ok(audit && Number.isFinite(writeSeq) && journal.some(entry => Number(entry.turnSeq) === writeSeq), 'actual write uses a real audit session and existing checkpoint journal');
  ok(!JSON.stringify(audit).includes(first.token) && !JSON.stringify(audit).includes('consumer-private@example.test'), 'audit chat contains neither consumer credential nor tool content');
  const createRollback=await app.journalRollback(auditId, writeSeq);
  ok(createRollback.ok&&!fs.existsSync(ownDestination), 'existing journal rollback restores actual create-beforeimage bytes');
  fs.writeFileSync(ownDestination, 'BEFORE-CHECKPOINT');
  const overwritten = await a.send('tools/call', { name: 'file_write', arguments: { path: ownDestination, content: 'AFTER-CHECKPOINT' } });
  ok(fs.readFileSync(ownDestination, 'utf8') === 'AFTER-CHECKPOINT', 'audit-backed overwrite reaches actual filesystem receiver');
  if(!Number.isFinite(overwritten.result?._meta?.turnSeq))throw Error('Actual overwrite did not return audit turn metadata');
  const overwriteRollback=await app.journalRollback(auditId, overwritten.result._meta.turnSeq);
  ok(overwriteRollback.ok&&fs.readFileSync(ownDestination, 'utf8') === 'BEFORE-CHECKPOINT', 'existing journal rollback restores exact overwrite bytes');
  app.__eval('globalThis.__mcpAuditBusy={promise:Promise.resolve(),source:"test-ui",driverRunId:"fixture-ui",cancel(){}};recordSessionExecutionOwner(' + JSON.stringify(auditId) + ',globalThis.__mcpAuditBusy)');
  const busy = await a.send('tools/call', { name: 'file_write', arguments: { path: ownDestination, content: 'MUST-NOT-WRITE' } });
  ok(busy.result?.isError && fs.readFileSync(ownDestination, 'utf8') === 'BEFORE-CHECKPOINT', 'UI-owned audit thread refuses consumer write without superseding owner');
  ok(app.__eval('turnSettlers.get(' + JSON.stringify(auditId) + ')===globalThis.__mcpAuditBusy'), 'refused admission preserves unrelated UI owner');
  app.__eval('turnSettlers.delete(' + JSON.stringify(auditId) + ');delete globalThis.__mcpAuditBusy');
  const edit = await a.send('tools/call', {name:'file_edit',arguments:{path:ownDestination,oldText:'BEFORE-CHECKPOINT',newText:'EDITED-CHECKPOINT'}});
  ok(!edit.result?.isError && fs.readFileSync(ownDestination,'utf8')==='EDITED-CHECKPOINT', 'granted file_edit remains a useful actual local write');
  const copiedFile=path.join(workspace,'copied.txt'), movedFile=path.join(workspace,'moved.txt');
  const copied=await a.send('tools/call',{name:'file_copy',arguments:{from:ownDestination,to:copiedFile}});
  ok(!copied.result?.isError && fs.readFileSync(copiedFile,'utf8')==='EDITED-CHECKPOINT', 'granted file_copy retains native checkpointed local semantics');
  const moved=await a.send('tools/call',{name:'file_move',arguments:{from:copiedFile,to:movedFile}});
  ok(!moved.result?.isError && !fs.existsSync(copiedFile) && fs.readFileSync(movedFile,'utf8')==='EDITED-CHECKPOINT', 'granted file_move reaches actual receiver without additional confirmation');
  const beforePermissionPage=await a.send('tools/list');
  const auditPermission=await app.loadSession(auditId); auditPermission.permissionMode='plan'; await app.saveSession(auditPermission);
  const afterPermissionPage=await a.send('tools/list');
  ok(afterPermissionPage.result.tools.every(tool=>['file_read','file_list','file_search'].includes(tool.name)), 'tools directory intersects current consumer audit permission floor');
  const capabilityView=await a.send('resources/read',{uri:'ruyi://consumer/capabilities'});
  const capabilityData=JSON.parse(capabilityView.result.contents[0].text);
  ok(capabilityData.grantedTools.length===7 && capabilityData.currentlyAvailableTools.length===3, 'capability resource distinguishes grant ceiling from currently executable tools');
  ok(Boolean((await a.send('tools/list',{cursor:beforePermissionPage.result.nextCursor})).error), 'permission-driven catalog change invalidates prior page source snapshot');
  const blockedPermission=await a.send('tools/call',{name:'file_write',arguments:{path:ownDestination,content:'MUST-NOT-WRITE'}});
  ok(blockedPermission.result?.isError && fs.readFileSync(ownDestination,'utf8')==='EDITED-CHECKPOINT', 'actual write separately rechecks audit permission floor');
  delete auditPermission.permissionMode; await app.saveSession(auditPermission);
  const foreign = await b.send('tools/call', { name: 'file_write', arguments: { path: foreignDestination, content: alias } });
  ok(foreign.result?.isError && !fs.existsSync(foreignDestination), 'another consumer cannot restore the first connection alias');
  const outside = path.join(root, 'outside.txt'); fs.writeFileSync(outside, 'OUTSIDE_PRIVATE');
  await app.mutateConfig(config => { config.allowOutsideWorkspace = true; config.permissionMode = 'bypass'; });
  const escaped = await a.send('tools/call', { name: 'file_read', arguments: { path: outside } });
  ok(!JSON.stringify(escaped).includes('OUTSIDE_PRIVATE'), 'workspace ceiling cannot be widened by global outside/bypass settings');
  const deniedWrite = await a.send('tools/call', { name: 'file_write', arguments: { path: path.join(root, 'outside-write.txt'), content: 'NO' } });
  ok(!fs.existsSync(path.join(root, 'outside-write.txt')) && deniedWrite.result?.isError, 'wide write still cannot escape consumer ceiling');
  if (process.platform === 'win32') {
    const link = path.join(workspace, 'outside-link'); fs.symlinkSync(root, link, 'junction');
    const value = await a.send('tools/call', { name: 'file_read', arguments: { path: path.join(link, 'outside.txt') } });
    ok(!JSON.stringify(value).includes('OUTSIDE_PRIVATE'), 'actual junction destination is checked, not only lexical workspace prefix');
  }
  const capacity = await create('Concurrent opens', ['file_read']);
  const opens = await Promise.all(Array.from({length:9}, () => request({op:'open',consumerId:capacity.consumer.id},{'x-ruyi-mcp-consumer':capacity.token},'/api/mcp/consumer')));
  ok(opens.filter(value=>value.status===200).length===4, 'concurrent opens enforce exactly the per-consumer four-connection capacity after filesystem awaits');
  const acceptedOpens=opens.filter(value=>value.status===200);await Promise.all(acceptedOpens.map(value=>bindLease(capacity,value.value)));
  const livePings=await Promise.all(acceptedOpens.map(value=>request({op:'request',consumerId:capacity.consumer.id,...value.value,message:{jsonrpc:'2.0',id:'capacity-ping',method:'ping',params:{}}},{'x-ruyi-mcp-consumer':capacity.token},'/api/mcp/consumer')));
  const fifthOpen=await request({op:'open',consumerId:capacity.consumer.id},{'x-ruyi-mcp-consumer':capacity.token},'/api/mcp/consumer');
  ok(livePings.length===4&&livePings.every(value=>value.status===200&&value.value.result)&&fifthOpen.status===403,'four accepted host connections are actually lease-live and callable while a fifth remains refused');
  for (const value of opens.filter(value=>value.status===200)) await request({op:'close',consumerId:capacity.consumer.id,...value.value},{'x-ruyi-mcp-consumer':capacity.token},'/api/mcp/consumer');
  const killedConsumer = await create('Abrupt stdio disconnect'), killedClient = client(killedConsumer);
  await killedClient.send('initialize');
  const killedPage=await killedClient.send('tools/list'), killedRead=await killedClient.send('tools/call',{name:'file_read',arguments:{path:privateFile}});
  const killedAlias=bodyText(killedRead).match(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/)?.[0];
  const killedConnection=openedConnections.find(value=>value.token===killedConsumer.token).value;
  killedClient.child.kill('SIGKILL');
  let oldConnection;
  for(let attempt=0;attempt<100;attempt++) {
    oldConnection=await request({op:'request',consumerId:killedConsumer.consumer.id,...killedConnection,message:{jsonrpc:'2.0',id:'old',method:'tools/list',params:{cursor:killedPage.result.nextCursor}}},{'x-ruyi-mcp-consumer':killedConsumer.token},'/api/mcp/consumer');
    if(oldConnection.status===403) break; await pause(20);
  }
  ok(oldConnection.status===403, 'actual SIGKILL closes the owned lease and immediately invalidates old connection/cursor');
  const afterKill=client(killedConsumer); await afterKill.send('initialize');
  const staleFile=path.join(workspace,'stale-after-kill.txt');
  const staleAlias=await afterKill.send('tools/call',{name:'file_write',arguments:{path:staleFile,content:killedAlias}});
  ok(killedAlias && staleAlias.result?.isError && !fs.existsSync(staleFile), 'reconnect after abrupt process death cannot restore old connection alias');
  // Hold the actual host readConfig, before any permission/workspace/tool await.
  // The existing real stdio A lease stays alive while its business HTTP RPC dies.
  const aConnection=openedConnections.find(value=>value.token===first.token).value;
  function rawRpc(message) {
    const bytes=Buffer.from(JSON.stringify({op:'request',consumerId:first.consumer.id,...aConnection,message}));
    let resolve; const done=new Promise(r=>{resolve=r;});
    const owned=http.request(base+'/api/mcp/consumer',{method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,'x-ruyi-mcp-consumer':first.token}},response=>{
      let text='';response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve(text));response.on('error',()=>resolve(text));
    });
    owned.on('error',()=>resolve(''));owned.end(bytes);return {owned,done};
  }
  async function holdConfig() {
    app.__eval(`globalThis.__mcpConfigHold={entered:false,resumed:false,count:0};globalThis.__mcpConfigOriginal=readConfig;
      globalThis.__mcpConfigToolOriginal=toolCall;
      readConfig=async function(...args){const value=await globalThis.__mcpConfigOriginal(...args);
        if(!globalThis.__mcpConfigHold.entered){globalThis.__mcpConfigHold.entered=true;await new Promise(resolve=>{globalThis.__mcpConfigHold.release=resolve;});globalThis.__mcpConfigHold.resumed=true;}
        return value;};
      toolCall=async function(...args){globalThis.__mcpConfigHold.count++;return globalThis.__mcpConfigToolOriginal(...args);};`);
  }
  async function waitConfigHeld() {
    for(let attempt=0;attempt<400&&!app.__eval('globalThis.__mcpConfigHold.entered');attempt++)await pause(25);
    ok(app.__eval('globalThis.__mcpConfigHold.entered'), 'actual host configuration read is held before business dispatch');
  }
  const restoreConfigHook=()=>app.__eval('readConfig=globalThis.__mcpConfigOriginal;toolCall=globalThis.__mcpConfigToolOriginal;delete globalThis.__mcpConfigOriginal;delete globalThis.__mcpConfigToolOriginal;delete globalThis.__mcpConfigHold');
  await holdConfig();
  const closeBeforeDispatch=path.join(workspace,'config-close-no-write.txt');
  const closedRpc=rawRpc({jsonrpc:'2.0',id:'config-close',method:'tools/call',params:{name:'file_write',arguments:{path:closeBeforeDispatch,content:'MUST-NOT-WRITE'}}});
  await waitConfigHeld();closedRpc.owned.destroy();await closedRpc.done;await pause(25);
  app.__eval('globalThis.__mcpConfigHold.release()');await pause(25);
  ok(app.__eval('globalThis.__mcpConfigHold.resumed&&globalThis.__mcpConfigHold.count===0')&&!fs.existsSync(closeBeforeDispatch), 'RPC socket close during held readConfig produces zero business calls and zero write despite live connection lease');
  restoreConfigHook();
  await holdConfig();
  const cancelBeforeDispatch=path.join(workspace,'config-cancel-no-write.txt');
  const cancelledRpc=rawRpc({jsonrpc:'2.0',id:'config-cancel',method:'tools/call',params:{name:'file_write',arguments:{path:cancelBeforeDispatch,content:'MUST-NOT-WRITE'}}});
  await waitConfigHeld();
  await rawRpc({jsonrpc:'2.0',id:'config-cancel',method:'tools/list',params:{}}).done;
  const cancelResponse=await request({op:'request',consumerId:first.consumer.id,...aConnection,message:{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'config-cancel'}}},{'x-ruyi-mcp-consumer':first.token},'/api/mcp/consumer');
  ok(cancelResponse.status===200&&cancelResponse.text==='','actual non-browser cancellation request passes the consumer transport gate with no notification response body');
  app.__eval('globalThis.__mcpConfigHold.release()');const cancelledBody=await cancelledRpc.done;
  ok(app.__eval('globalThis.__mcpConfigHold.count===0')&&!fs.existsSync(cancelBeforeDispatch)&&cancelledBody.includes('cancelled'), 'early cancel survives held readConfig and duplicate ID refusal does not delete original controller');
  restoreConfigHook();
  const queuedConsumer=await create('Queued cancellation'), queuedClient=client(queuedConsumer);await queuedClient.send('initialize');
  app.__eval(`globalThis.__mcpQueueHold={count:0,tools:0};globalThis.__mcpQueueConfigOriginal=readConfig;globalThis.__mcpQueueToolOriginal=toolCall;
    globalThis.__mcpQueueWait=new Promise(resolve=>{globalThis.__mcpQueueHold.release=resolve;});
    readConfig=async function(...args){const value=await globalThis.__mcpQueueConfigOriginal(...args);globalThis.__mcpQueueHold.count++;await globalThis.__mcpQueueWait;return value;};
    toolCall=async function(...args){globalThis.__mcpQueueHold.tools++;return globalThis.__mcpQueueToolOriginal(...args);};`);
  const occupied=Array.from({length:4},(_,i)=>queuedClient.send('ping',{},'occupied-'+i));
  for(let attempt=0;attempt<400&&app.__eval('globalThis.__mcpQueueHold.count')<4;attempt++)await pause(25);
  ok(app.__eval('globalThis.__mcpQueueHold.count')===4,'four real relay RPCs occupy all active slots at held host config');
  const queuedFile=path.join(workspace,'queued-cancel-no-write.txt');
  const queuedWrite=queuedClient.send('tools/call',{name:'file_write',arguments:{path:queuedFile,content:'MUST-NOT-WRITE'}},'queued-write');
  queuedClient.notify('notifications/cancelled',{requestId:'queued-write'});
  const queuedReply=await queuedWrite;
  app.__eval('globalThis.__mcpQueueHold.release()');await Promise.all(occupied);
  ok(queuedReply.error?.message.includes('cancelled') && app.__eval('globalThis.__mcpQueueHold.tools')===0 && !fs.existsSync(queuedFile) && !observedRequests.some(value=>value.token===queuedConsumer.token&&value.body.message?.method==='tools/call'),'fifth queued write cancels locally before any business POST or side effect');
  app.__eval('readConfig=globalThis.__mcpQueueConfigOriginal;toolCall=globalThis.__mcpQueueToolOriginal;delete globalThis.__mcpQueueConfigOriginal;delete globalThis.__mcpQueueToolOriginal;delete globalThis.__mcpQueueHold;delete globalThis.__mcpQueueWait');
  const reusedQueued=await queuedClient.send('ping',{},'queued-write');
  ok(Boolean(reusedQueued.result), 'cancelled queued ID can be reused without a delayed host cancel poisoning its new request');
  await holdConfig();
  const activeCancelFile=path.join(workspace,'active-cancel-no-write.txt');
  const activeCancel=queuedClient.send('tools/call',{name:'file_write',arguments:{path:activeCancelFile,content:'MUST-NOT-WRITE'}},'active-cancel');
  await waitConfigHeld();queuedClient.notify('notifications/cancelled',{requestId:'active-cancel'});
  const activeCancelReply=await activeCancel;
  app.__eval('globalThis.__mcpConfigHold.release()');await pause(25);
  ok(activeCancelReply.error?.message.includes('cancelled')&&app.__eval('globalThis.__mcpConfigHold.count')===0&&!fs.existsSync(activeCancelFile),'relay cancel destroys exact active HTTP while host readConfig is held, with zero business calls');
  restoreConfigHook();
  const reusedActive=await queuedClient.send('ping',{},'active-cancel');
  ok(Boolean(reusedActive.result)&&queuedClient.replyCount('active-cancel')===2,'cancelled active ID has exactly one cancellation reply and one successful reuse, without late duplicate or second host cancel');
  const connectingConsumer=await create('Connecting cancellation');heldLeaseToken=connectingConsumer.token;heldLeaseAck=null;
  const connectingClient=client(connectingConsumer), connectingInit=connectingClient.send('initialize',{},'connecting-init');
  const connectingFile=path.join(workspace,'connecting-cancel-no-write.txt');
  const connectingWrite=connectingClient.send('tools/call',{name:'file_write',arguments:{path:connectingFile,content:'MUST-NOT-WRITE'}},'connecting-write');
  for(let attempt=0;attempt<400&&!heldLeaseAck;attempt++)await pause(25);
  ok(Boolean(heldLeaseAck),'actual lease acknowledgement is held while client connected() awaits');
  connectingClient.notify('notifications/cancelled',{requestId:'connecting-write'});await pause(25);heldLeaseAck();
  const [connectingInitReply,connectingWriteReply]=await Promise.all([connectingInit,connectingWrite]);
  ok(connectingInitReply.result && connectingWriteReply.error?.message.includes('cancelled') && !fs.existsSync(connectingFile)
    && !observedRequests.some(value=>value.token===connectingConsumer.token&&value.body.message?.method==='tools/call'),'cancel during connected await produces zero business HTTP POST and no file while initialization may complete');
  const progressConsumer=await create('Progress-only transport'), progressClient=client(progressConsumer);await progressClient.send('initialize');
  app.__eval('globalThis.__mcpProgressCount=0;globalThis.__mcpProgressOriginal=toolCall;toolCall=async function(...args){globalThis.__mcpProgressCount++;return globalThis.__mcpProgressOriginal(...args);};');
  for(const mode of ['clean','close']){
    const id='progress-only-'+mode, target=path.join(workspace,id+'.txt');progressDrop={token:progressConsumer.token,id,mode,dropped:0};
    const reply=await progressClient.send('tools/call',{name:'file_write',arguments:{path:target,content:'COMPLETED-'+mode},_meta:{progressToken:id}},id);
    ok(progressDrop.dropped===1 && progressClient.notifications.some(row=>row.method==='notifications/progress'&&row.params.progressToken===id), 'actual '+mode+' transport delivers progress but withholds only the matching final result');
    ok(reply.error?.data?.operationMayHaveExecuted===true && reply.error.data.resultUnavailable===true && reply.error.data.retry===false && progressClient.replyCount(id)===1, 'progress-only '+mode+' stream completes original RPC with one fixed no-retry refusal');
    ok(fs.readFileSync(target,'utf8')==='COMPLETED-'+mode, 'progress-only '+mode+' response loss leaves the actual completed write intact');
    progressDrop=null;
  }
  ok(app.__eval('globalThis.__mcpProgressCount')===2,'two progress-only losses execute exactly two business operations with no automatic replay');
  app.__eval('toolCall=globalThis.__mcpProgressOriginal;delete globalThis.__mcpProgressOriginal;delete globalThis.__mcpProgressCount');
  const heldConsumer = await create('Held write'), heldClient = client(heldConsumer);
  await heldClient.send('initialize');
  app.__eval(`globalThis.__mcpHeld = { count: 0, reached: false }; globalThis.__mcpOriginalToolCall = toolCall;
    toolCall = async function(name,input,context) {
      const result = await globalThis.__mcpOriginalToolCall(name,input,context);
      if (name === 'file_write' && input.path.endsWith('held.txt')) {
        globalThis.__mcpHeld.count++; globalThis.__mcpHeld.reached = true;
        await new Promise(resolve => { globalThis.__mcpHeld.release = resolve; });
      }
      return result;
    };`);
  const heldFile = path.join(workspace, 'held.txt');
  const pendingHeld = heldClient.send('tools/call', { name: 'file_write', arguments: { path: heldFile, content: 'COMPLETED-BUSINESS' } });
  for (let attempt=0; attempt<400 && !app.__eval('globalThis.__mcpHeld.reached'); attempt++) await pause(25);
  ok(app.__eval('globalThis.__mcpHeld.reached') && fs.readFileSync(heldFile, 'utf8') === 'COMPLETED-BUSINESS', 'held call has actually completed the side effect before revocation');
  await management({ op: 'revoke', id: heldConsumer.consumer.id });
  app.__eval('globalThis.__mcpHeld.release()');
  const heldResponse = await pendingHeld;
  ok(heldResponse.error?.data?.retry === false && !JSON.stringify(heldResponse).includes('COMPLETED-BUSINESS'), 'revoked completed write withholds result and instructs no automatic retry');
  ok(app.__eval('globalThis.__mcpHeld.count') === 1 && fs.readFileSync(heldFile, 'utf8') === 'COMPLETED-BUSINESS', 'business side effect is not replayed on withheld result');
  app.__eval('toolCall=globalThis.__mcpOriginalToolCall;delete globalThis.__mcpOriginalToolCall;delete globalThis.__mcpHeld');
  await management({ op: 'revoke', id: first.consumer.id });
  const revoked = await a.send('tools/list'); ok(Boolean(revoked.error), 'revocation refuses an existing real relay connection');
  const replacement = client(second); await replacement.send('initialize');
  const disconnectedAlias = await replacement.send('tools/call', { name: 'file_write', arguments: { path: path.join(workspace, 'reconnected.txt'), content: alias } });
  ok(disconnectedAlias.result?.isError && !fs.existsSync(path.join(workspace, 'reconnected.txt')), 'reconnect receives a fresh scope and cannot reuse an old alias');
  await app.mutateConfig(config => { config.privacyModeV1 = 'off'; });
  ok((await request({ op: 'open' }, {}, '/api/mcp/consumer')).status === 403, 'OFF does not disable consumer authentication');
  const offLiteral = path.join(workspace, 'off-literal.txt');
  const offWrite = await b.send('tools/call', { name:'file_write', arguments:{path:offLiteral,content:alias} });
  ok(!offWrite.result?.isError && fs.readFileSync(offLiteral,'utf8')===alias, 'OFF preserves literal opaque refs without restoring another connection original');
  const internalEntry = { entry: { env: { RUYI_HOME: data, RUYI_MCP_INTERNAL_ONLY: '1' } } };
  const noBridge = client(internalEntry, {}, true);
  ok(Boolean((await noBridge.send('initialize')).error), 'global internal marker alone cannot authorize standalone MCP even OFF');
  const fakeBridge = client(internalEntry, { WCW_HOST:'127.0.0.1', WCW_PORT:new URL(base).port, WCW_SESSION_ID:auditId, WCW_TOKEN:'c'.repeat(32) }, true);
  ok(Boolean((await fakeBridge.send('initialize')).error), 'fake inherited environment cannot authenticate old direct tools');
  const kimiBridge = client(internalEntry, { WCW_HOST:'127.0.0.1', WCW_PORT:new URL(base).port, WCW_SESSION_ID:auditId, WCW_TOKEN:adminToken }, true);
  app.activeChildren.set(auditId, { kind:'kimi-acp', child:kimiBridge.child, state:'running', exited:false });
  ok(Boolean((await kimiBridge.send('initialize')).result), 'Kimi-style inherited WCW environment plus actual registered child retains global bridge initialization');
  app.activeChildren.delete(auditId);
  ok(Boolean((await kimiBridge.send('tools/list')).error), 'every internal RPC revalidates live host child ownership');
  const kimiDir = path.join(root, 'kimi-home'); fs.mkdirSync(kimiDir);
  const consumerKey = Object.keys(second.configuration.mcpServers)[0], kimiFile = path.join(kimiDir, 'mcp.json');
  fs.writeFileSync(kimiFile, JSON.stringify(second.configuration));
  const syncConfig = await app.readConfig(); syncConfig.includeWorkbenchMcp = true;
  await app.syncMcpServersToKimiNow(syncConfig, kimiDir);
  const synced = JSON.parse(fs.readFileSync(kimiFile,'utf8')).mcpServers;
  ok(JSON.stringify(synced[consumerKey]) === JSON.stringify(second.entry) && synced.ruyi?.env?.RUYI_MCP_INTERNAL_ONLY === '1', 'global Kimi sync preserves independently issued config and retains internal bridge entry');
  ok(app.classifyAgentMcpCandidate({id:consumerKey,...synced[consumerKey]}, 'kimi', {}).reason === 'ruyi-self', 'self-command consumer configuration is filtered from external auto-import without canonicalizing its id');
  ok(!fs.existsSync(path.join(data, 'privacy-scopes')), 'connection scopes create no persistent original mapping files');
  const readonlyClient=client(capacity);await readonlyClient.send('initialize');
  const readonlyFile=path.join(workspace,'readonly-grant-no-write.txt'),readonlyWrite=await readonlyClient.send('tools/call',{name:'file_write',arguments:{path:readonlyFile,content:'NO'}});
  ok(readonlyWrite.result?.isError&&!fs.existsSync(readonlyFile),'read-only consumer grant refuses actual write even when global permission floor is bypass');
  const originalPort = new URL(base).port;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await host();
  const movedClient = client(second); const movedInit = await movedClient.send('initialize');
  ok(Boolean(movedInit.result) && !second.entry.env.WCW_PORT && !second.entry.args.some(arg => String(arg).includes(originalPort)), 'fresh stdio consumer discovers actual running host port without editing configuration');
  ok(children.every(child => child.pid > 0), 'fixture owns every stdio child it will clean');
})().catch(error => { console.error(error.stack); t.fail('uncaught consumer fixture error'); }).finally(async () => {
  try { heldLeaseAck?.(); app.__eval('if(globalThis.__mcpQueueHold?.release)globalThis.__mcpQueueHold.release();if(globalThis.__mcpConfigHold?.release)globalThis.__mcpConfigHold.release();if(globalThis.__mcpConfigOriginal)readConfig=globalThis.__mcpConfigOriginal;if(globalThis.__mcpConfigToolOriginal)toolCall=globalThis.__mcpConfigToolOriginal'); } catch {}
  for(const owned of ownedLeases)owned.destroy();
  for (const child of children) await killOwnTree(child);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  vault.clear(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); t.done();
});
