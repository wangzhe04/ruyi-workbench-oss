'use strict';
require('./lib/self-isolate-home');
// Production callback -> durable owner worker -> actual Steward tool loop -> official reply adapter.
// Only model responses and fixed official HTTPS transport are synthetic; no runner/session substitution.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const { getFreePort } = require('./free-port');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { FAKE_BOT_ENV, feishuConnection, feishuEvent, feishuWire, qqConnection, qqEvent, qqWire } = require('./lib/external-bot-fixtures');
const { CONFIG_SCHEMA: CURRENT_CONFIG_SCHEMA } = require('../ruyi-workbench/app/server.js');
const runner = createRunner('EXTERNAL BOTS CONTROL'); const { ok } = runner;
const WB = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const isolated = fixtureChildEnv({ perTest: true }); const home = isolated.home; const work = path.join(home, 'work'); fs.mkdirSync(work);
  const stateFile = path.join(home, 'external-bots', 'state-v1.json');
  const holdFlag = path.join(home, 'hold-inbox'), heldFlag = path.join(home, 'inbox-held'), failCompletedFlag = path.join(home, 'fail-completed');
  const failCancelFlag = path.join(home, 'fail-cancel'), holdCancelFlag = path.join(home, 'hold-cancel'), cancelHeldFlag = path.join(home, 'cancel-held');
  const faults = path.join(home, 'control-faults.cjs');
  fs.writeFileSync(faults, `const fs=require('fs'),p=fs.promises,rename=p.rename;p.rename=async function(from,to){if(String(to).replaceAll('\\\\','/').endsWith('/external-bots/state-v1.json')){const data=JSON.parse(fs.readFileSync(from,'utf8'));if(fs.existsSync(${JSON.stringify(failCompletedFlag)})&&data.items.some(x=>x.messageId==='completion_failure'&&x.execution&&x.execution.status==='completed'))throw Object.assign(new Error('synthetic completion write failure'),{code:'ENOSPC'});if(fs.existsSync(${JSON.stringify(holdFlag)})){fs.writeFileSync(${JSON.stringify(heldFlag)},'held');while(fs.existsSync(${JSON.stringify(holdFlag)}))await new Promise(r=>setTimeout(r,10));}}return rename.call(this,from,to);};`);
  const cancelFaults = path.join(home, 'cancel-faults.cjs');
  fs.writeFileSync(cancelFaults, `const fs=require('node:fs'),p=fs.promises,rename=p.rename;p.rename=async function(from,to){if(String(to).replaceAll('\\\\','/').endsWith('/external-bots/state-v1.json')){const state=JSON.parse(fs.readFileSync(from,'utf8'));if(state.items.some(item=>item.messageId==='cancel_token'&&item.delivery?.status==='cancelled')&&fs.existsSync(${JSON.stringify(failCancelFlag)}))throw Object.assign(Error('synthetic cancellation write failure'),{code:'ENOSPC'});if(state.items.some(item=>item.messageId==='cancel_lost_ack'&&item.delivery?.status==='cancelled')&&fs.existsSync(${JSON.stringify(holdCancelFlag)})){fs.writeFileSync(${JSON.stringify(cancelHeldFlag)},'held');while(fs.existsSync(${JSON.stringify(holdCancelFlag)}))await new Promise(resolve=>setTimeout(resolve,10));}}return rename.call(this,from,to);};`);
  const holdRetryFlag = path.join(home, 'hold-retry'), retryHeldFlag = path.join(home, 'retry-held');
  const loseRetryCommitFlag = path.join(home, 'lose-retry-commit-result'), retryCommitLostFlag = path.join(home, 'retry-commit-lost');
  const retryFaults = path.join(home, 'retry-faults.cjs');
  const installRetryFaults = flags => {
    const fs = require('node:fs'), io = fs.promises, rename = io.rename;
    io.rename = async function(from, to) {
      if (!String(to).replaceAll('\\', '/').endsWith('/external-bots/state-v1.json')) return rename.call(this, from, to);
      const state = JSON.parse(fs.readFileSync(from, 'utf8'));
      const owns = (messageId, retryRequestId) => state.items.some(item => item.messageId === messageId && item.delivery?.status === 'pending'
        && item.replyHistory?.some(record => record.retryRequestId === retryRequestId && record.nextAttemptId === item.delivery.attemptId));
      if (owns('reply_retry_lost', 'retry_http_lost_00000001') && fs.existsSync(flags.hold)) {
        fs.writeFileSync(flags.held, 'held-before-rename');
        while (fs.existsSync(flags.hold)) await new Promise(resolve => setTimeout(resolve, 10));
      }
      const loseResult = owns('reply_retry_write', 'retry_http_write_00000001') && fs.existsSync(flags.lose);
      const result = await rename.call(this, from, to);
      if (loseResult) {
        fs.unlinkSync(flags.lose); fs.writeFileSync(flags.lost, 'actual-rename-committed');
        throw Object.assign(Error('synthetic lost retry commit result'), { code: 'EIO' });
      }
      return result;
    };
  };
  fs.writeFileSync(retryFaults, '(' + installRetryFaults.toString() + ')(' + JSON.stringify({ hold:holdRetryFlag, held:retryHeldFlag, lose:loseRetryCommitFlag, lost:retryCommitLostFlag }) + ');');
  let server, fake, apiServer, port, apiPort, token = '', targetId = '', heldTokenResponse = null, holdToken = false, deliveryMode = 'ok', holdMessage = false, heldMessageResponse = null, retryTokenMode = 'ok';
  const commandCalls = new Map(), toolReceipts = [], outbound = [];
  const progressRequests = new Map(); // Original held fake-provider request references only.
  const request = async (method, route, body, headers = {}, admin = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type':'application/json', ...(admin ? { 'x-wcw-token': token } : {}), ...headers },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; } return { status: response.status, json, text };
  };
  const until = async (fn, name = 'condition') => { for (let i = 0; i < 1200; i++) { const value = await fn(); if (value) return value; await sleep(25); } throw new Error('timeout: ' + name); };
  const readItem = async id => (await request('GET', '/api/external-bots/inbox')).json.items.find(item => item.messageId === id);
  const delivered = id => until(async () => { const item = await readItem(id); return item?.delivery?.status === 'sent' && item; }, 'delivered ' + id);
  const callback = (id, text, platform = 'feishu', eventId = id) => {
    const wire = platform === 'feishu' ? feishuWire(feishuEvent({ messageId: id, eventId, text, group: true })) : qqWire(qqEvent({ messageId: id, eventId, text }));
    return request('POST', '/api/external-bots/callback/' + platform + '?connectionId=' + platform + '_test', wire.bytes, wire.headers, false);
  };
  const connection = () => ({ ...feishuConnection(), mode: 'control', ownerSenderId: 'ou_person', ownerConversationId: 'oc_room', ownerConversationType: 'group', appSecretEnv: 'RUYI_BOT_TEST_F_APP' });
  const configure = value => request('POST', '/api/external-bots/connections', { op:'upsert', connection: value, controlConfirmed: true });
  const start = async () => {
    server = cp.spawn(process.execPath, ['--require', path.join(__dirname,'lib/external-channel-delivery-preload.js'), '--require', faults, '--require', cancelFaults, '--require', retryFaults, 'app/server.js', 'serve', '--port', String(port)], {
      cwd: WB, windowsHide:true, stdio:'ignore', env:{ ...process.env, ...isolated.env, ...FAKE_BOT_ENV, RUYI_BOT_TEST_F_APP:'synthetic-app-secret', RUYI_FAKE_EXTERNAL_API_PORT:String(apiPort), RUYI_HOME:home, WIN_CLAUDE_WORKBENCH_HOME:home },
    });
    await until(async()=>{try{return(await request('GET','/health',undefined,{},false)).status===200;}catch{return false;}},'server');
    token=await until(async()=>{
      try {
        const runtime=JSON.parse(fs.readFileSync(path.join(home,'runtime.json'),'utf8'));
        if(runtime.pid!==server.pid||typeof runtime.token!=='string'||!runtime.token)return false;
        const probe=await request('GET','/api/external-bots/connections',undefined,{'x-wcw-token':runtime.token},false);
        return probe.status===200?runtime.token:false;
      } catch {return false;}
    },'token');
  };
  const stop=async()=>{if(server){const child=server;killOwnTree(child);await until(()=>child.exitCode!==null||child.signalCode!==null,'server exit');server=null;}};
  const findExecution = content => {
    const visit = value => { if (typeof value === 'string') { try { return visit(JSON.parse(value)); } catch { return null; } }
      if (!value || typeof value !== 'object') return null; if (value.serverInstanceId && value.driverRunId) return value;
      for(const child of Object.values(value)){const result=visit(child);if(result)return result;} return null; }; return visit(content);
  };
  try {
    apiServer = http.createServer(async(req,res)=>{let bytes='';for await(const chunk of req)bytes+=chunk;const body=JSON.parse(bytes||'{}');
      if(req.url.includes('token')||req.url==='/app/getAppAccessToken'){
        if(holdToken){heldTokenResponse=res;return;}
        if(retryTokenMode==='unavailable'){res.writeHead(503,{'content-type':'application/json'});res.end('{"code":1,"msg":"synthetic token unavailable"}');return;}
        res.setHeader('content-type','application/json');res.end(JSON.stringify(req.headers.host==='api.bot.qq.com'?{access_token:'synthetic-token',expires_in:'7200'}:{code:0,tenant_access_token:'synthetic-token',expire:7200}));return;
      }
      outbound.push({host:req.headers.host,path:req.url,body});
      if(holdMessage){heldMessageResponse=res;return;}
      if(deliveryMode==='drop'){res.destroy();return;}
      if(deliveryMode==='reject'){res.writeHead(429,{'content-type':'application/json'});res.end('{"code":999,"msg":"synthetic rate limit"}');return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(req.headers.host==='api.bot.qq.com'?{id:'qq_sent_'+outbound.length}:{code:0,data:{message_id:'f_sent_'+outbound.length}}));
    }); await new Promise(resolve=>apiServer.listen(0,'127.0.0.1',resolve));apiPort=apiServer.address().port;
    fake=await startFakeProvider({handler(req){
      const isSteward=req.tools.some(tool=>(tool.function?.name||tool.name)==='steward_thread_new');
      const latest=String(req.messages.filter(row=>row.role==='user').at(-1)?.content||'');
      if(!isSteward){if(latest.includes('HOLD_REMOTE_TASK')){req.open();req.sse(textFrames('task remains active',{finish:null})[0]);return;}return textFrames('子任务已就绪。');}
      const marker=latest.match(/CONTROL_[A-Z]+(?:_[0-9]+)?/)?.[0];
      if(!marker)return textFrames(JSON.stringify({say:'已查看，无需额外动作。',why:'系统事件',acts:[],actions:[]}));
      const step=(commandCalls.get(marker)||0)+1;commandCalls.set(marker,step);
      if (['CONTROL_PROGRESS', 'CONTROL_QPROGRESS'].includes(marker) && step === 1) { req.open(); progressRequests.set(marker, req); return; }
      const recentTool=req.messages.filter(row=>row.role==='tool').at(-1);if(recentTool)toolReceipts.push({marker,content:recentTool.content});
      const call=(name,args)=>toolCallFrames(name,args,'call_'+marker+'_'+step);
      if(marker==='CONTROL_CREATE'&&step===1)return call('steward_thread_new',{title:'REMOTE_TASK',cwd:work,tier:'fast',brief:{userText:'准备一句子任务已就绪，等待后续指令。',goal:'输出就绪回执',acceptance:['真实任务存在']}});
      if(marker==='CONTROL_CREATE'&&step===2){try{targetId=JSON.parse(recentTool.content).sessionId||'';}catch{}return textFrames(JSON.stringify({say:'已新建任务，子任务进展请以任务状态为准。',why:'真实工具回执',acts:[],actions:[]}));}
      if(marker==='CONTROL_QUERY'&&step===1)return call('steward_threads_search',{q:'REMOTE_TASK',limit:10});
      if(marker==='CONTROL_QUERY'&&step===2)return call('steward_thread_status',{sessionId:targetId});
      if(marker==='CONTROL_CONTINUE'&&step===1)return call('steward_thread_continue',{sessionId:targetId,message:'HOLD_REMOTE_TASK'});
      if(marker==='CONTROL_STOP'&&step===1)return call('steward_thread_status',{sessionId:targetId});
      if(marker==='CONTROL_STOP'&&step===2){const execution=findExecution(recentTool?.content);if(!execution)throw Error('actual status tool did not return execution identity');return call('steward_thread_stop',{sessionId:targetId,expectedExecution:execution,reason:'远程owner明确停止'});}
      return textFrames(JSON.stringify({say:marker==='CONTROL_STOP'?'已按刚读取的执行身份请求停止。':'已处理本次指令，请以实际任务状态为准。',why:'合成模型依据生产工具结果答复',acts:[],actions:[]}));
    }});
    fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({configSchema:CURRENT_CONFIG_SCHEMA,activeProvider:'fake',engineMode:'interactive',permissionMode:'default',defaultWorkspace:work,workspaces:[{path:work,read:true,write:true,exec:true}],
      includeWorkbenchMcp:false,autoImportClaudeCodeMcp:false,enableMcpDropIn:false,schedulerEnabledV1:false,stewardEnabledV1:true,stewardPollMs:120000,stewardMaxParallelThreads:4,missionAutoContinue:false,
      desktopMcp:{enabled:false,autodetect:false},providers:[{id:'fake',label:'Fake',type:'openai-compat',baseUrl:fake.url,apiKey:'synthetic-key',model:'fake-model',models:[{id:'fake-model',label:'Fake'}]}]}));
    port=await getFreePort();await start();
    const unconfirmed=await request('POST','/api/external-bots/connections',{op:'upsert',connection:connection()});
    ok(unconfirmed.status===409,'C0 control owner authority requires explicit local confirmation');
    ok((await configure(connection())).status===200,'C1 local owner explicitly enables group control and reply credentials');
    ok((await callback('control_create','请创建任务 CONTROL_CREATE，并告诉我真实结果。')).status===200,'C2 authenticated owner callback is quickly accepted');
    const created=await delivered('control_create');
    if(!targetId)console.log('CONTROL_FIXTURE_DIAGNOSTIC',JSON.stringify({execution:created.execution,commands:[...commandCalls],receipts:toolReceipts,providerCalls:fake.requests.map(req=>({tools:req.tools?.slice(0,4).map(tool=>tool.function?.name||tool.name),lastRole:req.messages?.at(-1)?.role}))}));
    ok(Boolean(targetId)&&created.execution.status==='completed'&&created.execution.turnSeq>0,'C3 actual Steward tool loop created a real task and persisted its own turn receipt');
    const head=(await request('GET','/api/sessions/'+targetId)).json;
    ok(head.session.createdBy==='steward'&&head.session.title==='REMOTE_TASK','C4 actual thread_new created the production session, not a fixture-injected snapshot');
    await until(async()=>((await request('GET','/api/sessions/'+targetId)).json.execution===null),'child completes');
    await callback('control_query','请查询任务 CONTROL_QUERY 的进度。');await delivered('control_query');
    ok(toolReceipts.some(row=>row.marker==='CONTROL_QUERY'&&String(row.content).includes(targetId)),'C5 query consumed actual search/status tool receipts');
    await callback('control_continue','请继续办理 CONTROL_CONTINUE。');await delivered('control_continue');
    const live=await until(async()=>{const value=(await request('GET','/api/sessions/'+targetId)).json;return value.execution&&value;},'real continued execution');
    ok(Boolean(live.execution.serverInstanceId&&live.execution.driverRunId),'C6 actual continue admitted a new execution with the existing 65 identity');
    await callback('control_stop','请停止刚才任务 CONTROL_STOP。');await delivered('control_stop');
    await until(async()=>((await request('GET','/api/sessions/'+targetId)).json.execution===null),'real stop');
    ok(toolReceipts.some(row=>row.marker==='CONTROL_STOP'&&String(row.content).includes('"stopped":true')),'C7 remote stop uses a fresh status-tool execution identity and stops the actual task');
    const before=commandCalls.get('CONTROL_CREATE');await callback('control_create','请创建任务 CONTROL_CREATE，并告诉我真实结果。','feishu','retry_event');await sleep(100);
    ok(commandCalls.get('CONTROL_CREATE')===before&&outbound.filter(row=>row.path.includes('/control_create/reply')).length===1,'C8 platform retry repeats neither task execution nor reply');
    const steward=(await request('GET','/api/sessions/steward')).json.session;
    ok(steward.messages.some(message=>message.meta?.origin==='external-owner'&&message.meta.externalSource?.senderId==='ou_person'),'C9 persisted user message retains verified external owner provenance');
    ok(outbound.some(row=>row.path==='/open-apis/im/v1/messages/control_stop/reply'&&row.body.msg_type==='text'),'C10 real official Feishu reply adapter targets the original message');
    const qq={...qqConnection(),mode:'control',ownerSenderId:'qq_person',ownerConversationId:'qq_room',ownerConversationType:'group'};
    await configure(qq);await callback('qq_query','查看当前进展 CONTROL_QQQUERY','qq');await delivered('qq_query');
    ok(outbound.some(row=>row.host==='api.bot.qq.com'&&row.path==='/v2/groups/qq_room/messages'&&row.body.msg_id==='qq_query'),'C11 QQ control also replies only to its original group/message binding');
    holdToken=true;const beforeRevoke=outbound.length;await callback('token_revoke','请汇报当前情况 CONTROL_REVOKE');
    await until(()=>heldTokenResponse,'token request held');await request('POST','/api/external-bots/connections',{op:'disable',id:'feishu_test'});
    holdToken=false;heldTokenResponse.end('{"code":0,"tenant_access_token":"late-token","expire":7200}');heldTokenResponse=null;
    const revoked=await until(async()=>{const item=await readItem('token_revoke');return item?.delivery?.status==='failed'&&item;},'revoked delivery');
    ok(outbound.length===beforeRevoke&&revoked.delivery.errorCode==='external_delivery.token_aborted','C12 revoke during token await prevents the message POST and keeps its known token-phase failure code');
    await configure(connection());deliveryMode='reject';await callback('reply_reject','请汇报 CONTROL_REJECT');
    const rejected=await until(async()=>{const item=await readItem('reply_reject');return item?.delivery?.status==='failed'&&item;},'rejected reply');
    ok(rejected.delivery.errorCode.startsWith('external_delivery.'),'C13 platform rejected delivery remains failed with the typed adapter reason');
    deliveryMode='drop';await callback('reply_unknown','请汇报 CONTROL_UNKNOWN');
    const unknown=await until(async()=>{const item=await readItem('reply_unknown');return item?.delivery?.status==='unknown'&&item;},'unknown reply');
    const unknownCalls=commandCalls.get('CONTROL_UNKNOWN');await callback('reply_unknown','请汇报 CONTROL_UNKNOWN','feishu','duplicate_unknown');await sleep(100);
    ok(unknown.execution.status==='completed'&&commandCalls.get('CONTROL_UNKNOWN')===unknownCalls,'C14 lost platform response never reruns the underlying command');deliveryMode='ok';
    fs.writeFileSync(holdFlag,'hold');
    const wire=feishuWire(feishuEvent({messageId:'lost_ack',eventId:'lost_ack_event',text:'请汇报 CONTROL_LOSTACK',group:true}));
    const lost=http.request({host:'127.0.0.1',port,path:'/api/external-bots/callback/feishu?connectionId=feishu_test',method:'POST',headers:{...wire.headers,'content-length':wire.bytes.length}});lost.on('error',()=>{});lost.end(wire.bytes);
    await until(()=>fs.existsSync(heldFlag),'queued rename held');lost.destroy();fs.unlinkSync(holdFlag);
    await delivered('lost_ack');const lostCalls=commandCalls.get('CONTROL_LOSTACK');await callback('lost_ack','请汇报 CONTROL_LOSTACK','feishu','retry_lost_ack');await sleep(100);
    ok(lostCalls>0&&commandCalls.get('CONTROL_LOSTACK')===lostCalls,'C15 a disconnected callback still wakes durable work, and retry does not execute twice');
    fs.writeFileSync(failCompletedFlag,'fail');await callback('completion_failure','请汇报 CONTROL_FINISHFAIL');
    const failedRead=await until(async()=>{const value=(await request('GET','/api/external-bots/inbox')).json;const item=value.items.find(row=>row.messageId==='completion_failure');return value.worker.errorCode&&item?.execution?.status==='unknown'&&value;},'failed completion projection');
    const completedCalls=commandCalls.get('CONTROL_FINISHFAIL');ok(failedRead.worker.errorCode==='external_channel.storage_unavailable','C16 completion write failure projects unknown with persistent visible read quality');
    const persistedFailure=JSON.parse(fs.readFileSync(stateFile,'utf8')).items.find(item=>item.messageId==='completion_failure');
    ok(persistedFailure?.execution?.status==='running','C16b failed completion persistence leaves the durable execution running before restart');
    fs.unlinkSync(failCompletedFlag);await stop();await start();
    // Health/token readiness precedes asynchronous worker recovery. Observe its actual durable commit,
    // rather than treating the first inbox read as proof that background recovery has already finished.
    const recovered=await until(()=>{
      const item=JSON.parse(fs.readFileSync(stateFile,'utf8')).items.find(row=>row.messageId==='completion_failure');
      if(commandCalls.get('CONTROL_FINISHFAIL')!==completedCalls)throw new Error('restart replayed the uncertain command');
      return item?.execution?.status==='unknown'&&item;
    },'persisted restart recovery');
    ok((await readItem('completion_failure')).execution.status==='unknown'&&recovered.execution.errorCode==='external_channel.execution_unknown'
      &&Number.isFinite(Date.parse(recovered.execution.finishedAt))&&commandCalls.get('CONTROL_FINISHFAIL')===completedCalls,'C17 restart settles running-to-unknown without replaying a command after failed result persistence');
    await callback('control_create','请创建任务 CONTROL_CREATE，并告诉我真实结果。','feishu','restart_duplicate');await sleep(100);
    ok(commandCalls.get('CONTROL_CREATE')===before,'C18 actual process restart preserves source-message execution dedupe');
    const list = await request('GET', '/api/external-bots/deliveries?limit=2&archive=all');
    ok(list.status === 200 && list.json.items.length === 2 && list.json.nextCursor && list.json.items.every(item => item.acceptance.status === 'accepted'), 'B1a delivery page exposes separate accepted execution and delivery facts');
    const secondPage = await request('GET', '/api/external-bots/deliveries?limit=2&archive=all&cursor=' + list.json.nextCursor);
    ok(secondPage.status === 200 && secondPage.json.items.length === 2 && secondPage.json.items.every(item => !list.json.items.some(first => first.id === item.id)), 'B1b acceptance-order cursor has no overlap after actual delivery status changes');
    ok((await request('GET', '/api/external-bots/deliveries', undefined, {}, false)).status === 403
      && (await request('POST', '/api/external-bots/deliveries/archive', { id: created.id, archived: true }, { origin: 'https://foreign.invalid' })).status === 403, 'B1c local token and same-origin archive checks precede mutation');
    ok((await request('POST', '/api/external-bots/deliveries/archive', { id: created.id, archived: true }, {}, false)).status === 403
      && (await request('GET', '/api/external-bots/deliveries/archive')).status === 403, 'B1i authorization table admits only the two intended authenticated method/path pairs');
    const factsBeforeArchive = JSON.parse(fs.readFileSync(stateFile, 'utf8')).items.find(item => item.id === created.id);
    const archiveResult = await request('POST', '/api/external-bots/deliveries/archive', { id: created.id, archived: true });
    const factsAfterArchive = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const archivedItem = factsAfterArchive.items.find(item => item.id === created.id), { archivedAt, ...unchangedFacts } = archivedItem;
    ok(archiveResult.status === 200 && archivedAt && factsAfterArchive.schema === 2 && JSON.stringify(unchangedFacts) === JSON.stringify(factsBeforeArchive)
      && archiveResult.json.retained === factsAfterArchive.items.length && archiveResult.json.capacity === 1000, 'B1d logical archive atomically upgrades payload without changing dedupe execution or attempt facts or claiming free capacity');
    const archivedPage = await request('GET', '/api/external-bots/deliveries?archive=archived');
    ok(archivedPage.json.items.some(item => item.id === created.id) && !(await request('GET', '/api/external-bots/deliveries')).json.items.some(item => item.id === created.id), 'B1e archive changes only management list visibility');
    const sentBeforeArchiveRetry = outbound.length;
    await callback('control_create', '请创建任务 CONTROL_CREATE，并告诉我真实结果。', 'feishu', 'archived_duplicate'); await sleep(100);
    ok(commandCalls.get('CONTROL_CREATE') === before && outbound.length === sentBeforeArchiveRetry, 'B1f archived platform duplicate repeats neither business nor delivery');
    await stop(); await start();
    ok((await request('GET', '/api/external-bots/deliveries?archive=archived')).json.items.some(item => item.id === created.id)
      && (await readItem('control_create')).delivery.attemptId === created.delivery.attemptId, 'B1g restart retains archived identity and original sending attempt');
    ok((await request('POST', '/api/external-bots/deliveries/archive', { id: created.id, archived: false })).status === 200
      && (await request('GET', '/api/external-bots/deliveries')).json.items.some(item => item.id === created.id), 'B1h unarchive restores visibility without a downgrade or second queue');
    const cancelRoute = '/api/external-bots/deliveries/cancel', cancelBody = item => ({ id:item.id, attemptId:item.delivery.attemptId });
    ok((await request('POST',cancelRoute,cancelBody(created),{},false)).status===403
      &&(await request('POST',cancelRoute,cancelBody(created),{origin:'https://foreign.invalid'})).status===403
      &&(await request('GET',cancelRoute)).status===403,'X1 cancel requires exact authenticated POST and same-origin authority');
    ok((await request('POST',cancelRoute+'?extra=1',cancelBody(created))).status===400
      &&(await request('POST',cancelRoute,{...cancelBody(created),extra:true})).status===400,'X2 cancel rejects query parameters and extra body authority');
    holdToken=true;await callback('cancel_token','请汇报 CONTROL_CANCELTOKEN');await until(()=>heldTokenResponse,'cancel token held');
    const cancellable=await readItem('cancel_token'),cancelCalls=commandCalls.get('CONTROL_CANCELTOKEN');
    ok(cancellable.cancelAvailable===true&&cancellable.delivery.status==='sending','X3 current unsubmitted sender advertises cancellation through real HTTP');
    fs.writeFileSync(failCancelFlag,'fail');const beforeFailedCancel=fs.readFileSync(stateFile,'utf8');
    const failedCancel=await request('POST',cancelRoute,cancelBody(cancellable));
    ok(failedCancel.status===503&&fs.readFileSync(stateFile,'utf8')===beforeFailedCancel
      &&(await readItem('cancel_token')).delivery.status==='sending','X4 failed durable cancellation gives no ACK or early abort');
    fs.unlinkSync(failCancelFlag);
    const cancelled=await request('POST',cancelRoute,cancelBody(cancellable));
    holdToken=false;heldTokenResponse.end('{"code":0,"tenant_access_token":"late-cancel-token","expire":7200}');heldTokenResponse=null;
    const cancelReceipt=cancelled.json?.item;
    ok(cancelled.status===200&&cancelReceipt.delivery.status==='cancelled'&&cancelReceipt.delivery.attemptId===cancellable.delivery.attemptId
      &&JSON.stringify(cancelReceipt.execution)===JSON.stringify(cancellable.execution),'X5 persisted cancellation retires only the original reply attempt and preserves business result');
    const repeatCancel=await request('POST',cancelRoute,cancelBody(cancellable));
    ok(repeatCancel.status===200&&repeatCancel.json.alreadyCancelled===true&&repeatCancel.json.item.delivery.cancelledAt===cancelReceipt.delivery.cancelledAt
      &&outbound.every(row=>!row.path.includes('/cancel_token/reply')),'X6 same attempt is idempotent and aborted token never creates a message request');
    holdMessage=true;await callback('cancel_submitted','请汇报 CONTROL_CANCELSUBMITTED');await until(()=>heldMessageResponse,'message request submitted');
    const submitted=await readItem('cancel_submitted');
    ok(submitted.cancelAvailable!==true&&(await request('POST',cancelRoute,cancelBody(submitted))).status===409,'X7 synchronous message submission closes cancellation before the platform response');
    holdMessage=false;heldMessageResponse.end('{"code":0,"data":{"message_id":"submitted-before-cancel"}}');heldMessageResponse=null;await delivered('cancel_submitted');
    holdToken=true;await callback('cancel_lost_ack','请汇报 CONTROL_CANCELLOSTACK');await until(()=>heldTokenResponse,'lost cancellation token held');
    const lostItem=await readItem('cancel_lost_ack'),cancelBytes=Buffer.from(JSON.stringify(cancelBody(lostItem)));
    fs.writeFileSync(holdCancelFlag,'hold');
    const lostCancel=http.request({host:'127.0.0.1',port,path:cancelRoute,method:'POST',headers:{'x-wcw-token':token,'content-type':'application/json','content-length':cancelBytes.length}});
    lostCancel.on('error',()=>{});lostCancel.end(cancelBytes);await until(()=>fs.existsSync(cancelHeldFlag),'cancel durable rename held');lostCancel.destroy();fs.unlinkSync(holdCancelFlag);
    await until(async()=> (await readItem('cancel_lost_ack')).delivery.status==='cancelled','lost ACK still persists cancellation');
    holdToken=false;heldTokenResponse.end('{"code":0,"tenant_access_token":"late-lost-ack-token","expire":7200}');heldTokenResponse=null;
    ok((await request('POST',cancelRoute,cancelBody(lostItem))).json.alreadyCancelled===true
      &&outbound.every(row=>!row.path.includes('/cancel_lost_ack/reply')),'X8 lost local cancellation ACK is reconciled by the same durable receipt with zero message requests');
    await stop();await start();
    await callback('cancel_token','请汇报 CONTROL_CANCELTOKEN','feishu','cancel_restart_duplicate');
    await sleep(100);
    const afterRestart=await readItem('cancel_token'),ledger3=JSON.parse(fs.readFileSync(stateFile,'utf8'));
    ok(afterRestart.delivery.status==='cancelled'&&afterRestart.delivery.cancelledAt===cancelReceipt.delivery.cancelledAt
      &&commandCalls.get('CONTROL_CANCELTOKEN')===cancelCalls&&ledger3.schema===3
      &&outbound.every(row=>!row.path.includes('/cancel_token/reply')&&!row.path.includes('/cancel_lost_ack/reply')),'X9 process restart and callback redelivery retain payload3 cancellation without re-executing business');
    await request('POST','/api/external-bots/deliveries/archive',{id:afterRestart.id,archived:true});
    await request('POST','/api/external-bots/deliveries/archive',{id:afterRestart.id,archived:false});
    ok(JSON.parse(fs.readFileSync(stateFile,'utf8')).schema===3&&(await readItem('cancel_token')).delivery.status==='cancelled'
      &&(await request('POST',cancelRoute,{...cancelBody(afterRestart),attemptId:'different_attempt'})).status===409,'X10 archive cycles retain schema3 and a different attempt cannot reuse cancellation authority');
    // R: retry only a real producer's known pre-message failure; no ledger seeding.
    const retryRoute = '/api/external-bots/deliveries/retry';
    const retryBody = (item, retryRequestId) => ({ id:item.id, expectedAttemptId:item.delivery.attemptId, retryRequestId });
    const failedTokenReply = async (messageId, marker) => {
      retryTokenMode = 'unavailable'; await callback(messageId, '请汇报 ' + marker);
      return until(async () => {
        const inbox = (await request('GET','/api/external-bots/inbox')).json;
        const item = inbox.items.find(row=>row.messageId===messageId);
        return item?.delivery?.status === 'failed' && inbox.worker.running === false && item;
      }, 'known token failure and actual worker idle ' + messageId);
    };
    ok((await request('POST',retryRoute,retryBody(created,'retry_http_auth_00000001'),{},false)).status===403
      &&(await request('POST',retryRoute,retryBody(created,'retry_http_auth_00000001'),{origin:'https://foreign.invalid'})).status===403
      &&(await request('GET',retryRoute)).status===403,'R1 retry requires exact local token POST and origin authority');
    ok((await request('POST',retryRoute+'?extra=1',retryBody(created,'retry_http_auth_00000001'))).status===400
      &&(await request('POST',retryRoute,{...retryBody(created,'retry_http_auth_00000001'),extra:true})).status===400,'R2 retry rejects query and extra authority fields');
    const retryFailed = await failedTokenReply('reply_retry','CONTROL_RETRY'), retryCalls = commandCalls.get('CONTROL_RETRY');
    ok(retryFailed.execution.status==='completed'&&retryFailed.delivery.errorCode==='external_delivery.token_unavailable'
      &&outbound.every(row=>!row.path.includes('/reply_retry/reply')),'R3 actual callback and Steward produce known token-phase failure with zero MESSAGE');
    retryTokenMode='ok';const retryRequest=retryBody(retryFailed,'retry_http_simple_00000001'),retried=await request('POST',retryRoute,retryRequest);
    const retrySent=await delivered('reply_retry');
    ok(retried.status===200&&retried.json.alreadyRetried===false&&retrySent.delivery.attemptId===retried.json.receipt.attemptId
      &&retrySent.delivery.attemptId!==retryFailed.delivery.attemptId&&retrySent.replyHistory.length===1
      &&JSON.stringify(retrySent.replyHistory[0].attempt)===JSON.stringify(retryFailed.delivery)
      &&JSON.stringify(retrySent.execution)===JSON.stringify(retryFailed.execution)&&commandCalls.get('CONTROL_RETRY')===retryCalls
      &&outbound.filter(row=>row.path.includes('/reply_retry/reply')).length===1,'R4 manual retry persists prior attempt and sends original reply once without business rerun');
    const repeatedRetry=await request('POST',retryRoute,retryRequest);
    ok(repeatedRetry.status===200&&repeatedRetry.json.alreadyRetried===true
      &&JSON.stringify(repeatedRetry.json.receipt)===JSON.stringify(retried.json.receipt)
      &&outbound.filter(row=>row.path.includes('/reply_retry/reply')).length===1&&commandCalls.get('CONTROL_RETRY')===retryCalls,'R5 stable request after sent returns original durable receipt without another MESSAGE');
    const lostRetryFailed=await failedTokenReply('reply_retry_lost','CONTROL_RETRYLOST'),lostRetryCalls=commandCalls.get('CONTROL_RETRYLOST');
    retryTokenMode='ok';const lostRetryBody=retryBody(lostRetryFailed,'retry_http_lost_00000001'),lostRetryBytes=Buffer.from(JSON.stringify(lostRetryBody));
    fs.writeFileSync(holdRetryFlag,'hold');
    const lostRetry=http.request({host:'127.0.0.1',port,path:retryRoute,method:'POST',headers:{'x-wcw-token':token,'content-type':'application/json','content-length':lostRetryBytes.length}});
    lostRetry.on('error',()=>{});lostRetry.end(lostRetryBytes);await until(()=>fs.existsSync(retryHeldFlag),'retry durable rename held');lostRetry.destroy();fs.unlinkSync(holdRetryFlag);
    const lostRetrySent=await delivered('reply_retry_lost'),lostRetryReconciled=await request('POST',retryRoute,lostRetryBody);
    ok(lostRetryReconciled.status===200&&lostRetryReconciled.json.alreadyRetried===true
      &&lostRetryReconciled.json.receipt.attemptId===lostRetrySent.delivery.attemptId&&lostRetrySent.replyHistory.length===1
      &&commandCalls.get('CONTROL_RETRYLOST')===lostRetryCalls&&outbound.filter(row=>row.path.includes('/reply_retry_lost/reply')).length===1,'R6 dropped local ACK still commits one retry and stable request reconciles one MESSAGE');
    await stop();await start();await callback('reply_retry_lost','请汇报 CONTROL_RETRYLOST','feishu','retry_payload4_duplicate');
    const coldRetry=await request('POST',retryRoute,lostRetryBody),coldRetryItem=await readItem('reply_retry_lost');
    ok(coldRetry.status===200&&coldRetry.json.alreadyRetried===true
      &&JSON.stringify(coldRetry.json.receipt)===JSON.stringify(lostRetryReconciled.json.receipt)
      &&coldRetryItem.delivery.attemptId===lostRetrySent.delivery.attemptId&&coldRetryItem.replyHistory.length===1
      &&commandCalls.get('CONTROL_RETRYLOST')===lostRetryCalls&&outbound.filter(row=>row.path.includes('/reply_retry_lost/reply')).length===1,'R7 restart and callback duplicate retain payload4 history and same request without business/send replay');
    const cancelRetryFailed=await failedTokenReply('reply_retry_cancel','CONTROL_RETRYCANCEL'),cancelRetryCalls=commandCalls.get('CONTROL_RETRYCANCEL');
    retryTokenMode='ok';holdToken=true;const cancelRetryBody=retryBody(cancelRetryFailed,'retry_http_cancel_00000001'),cancelRetry=await request('POST',retryRoute,cancelRetryBody);
    await until(()=>heldTokenResponse,'retry token held for cancellation');const cancelRetrySending=await readItem('reply_retry_cancel');
    const cancelRetryResult=await request('POST',cancelRoute,cancelBody(cancelRetrySending));
    holdToken=false;heldTokenResponse.end('{"code":0,"tenant_access_token":"late-retry-cancel-token","expire":7200}');heldTokenResponse=null;
    const cancelledRetry=await until(async()=>{const item=await readItem('reply_retry_cancel');return item?.delivery?.status==='cancelled'&&item;},'retried attempt cancelled');
    const cancelledRetryReplay=await request('POST',retryRoute,cancelRetryBody);
    ok(cancelRetry.status===200&&cancelRetryResult.status===200&&cancelledRetry.delivery.attemptId===cancelRetry.json.receipt.attemptId
      &&cancelledRetryReplay.json.alreadyRetried===true&&cancelledRetryReplay.json.item.delivery.status==='cancelled'
      &&cancelledRetry.replyHistory.length===1&&JSON.parse(fs.readFileSync(stateFile,'utf8')).schema===4
      &&commandCalls.get('CONTROL_RETRYCANCEL')===cancelRetryCalls&&outbound.every(row=>!row.path.includes('/reply_retry_cancel/reply')),'R8 precise successor cancellation retains schema4 history; old receipt cannot resurrect it');
    const writeRetryFailed=await failedTokenReply('reply_retry_write','CONTROL_RETRYWRITE'),writeRetryCalls=commandCalls.get('CONTROL_RETRYWRITE');
    retryTokenMode='ok';const writeRetryBody=retryBody(writeRetryFailed,'retry_http_write_00000001');fs.writeFileSync(loseRetryCommitFlag,'lose-result');
    const lostWriteResult=await request('POST',retryRoute,writeRetryBody),retainedRetry=await readItem('reply_retry_write');
    ok(lostWriteResult.status===503&&fs.existsSync(retryCommitLostFlag)&&retainedRetry.delivery.status==='pending'
      &&retainedRetry.replyHistory.length===1&&outbound.every(row=>!row.path.includes('/reply_retry_write/reply')),'R9 actual rename may commit pending retry before reported failure; no fabricated success or MESSAGE');
    const resumedRetry=await request('POST',retryRoute,writeRetryBody),resumedSent=await delivered('reply_retry_write');
    ok(resumedRetry.status===200&&resumedRetry.json.alreadyRetried===true&&resumedSent.delivery.attemptId===retainedRetry.delivery.attemptId
      &&resumedSent.replyHistory.length===1&&commandCalls.get('CONTROL_RETRYWRITE')===writeRetryCalls
      &&outbound.filter(row=>row.path.includes('/reply_retry_write/reply')).length===1,'R10 same explicit human receipt resumes only its durable pending attempt after lost write result');
    const ledger4=JSON.parse(fs.readFileSync(stateFile,'utf8')),vm=require('node:vm'),crypto=require('node:crypto');
    const { historicalSource }=require('./lib/external-bots-source-history');
    const oldRejected=['v1','v2','v3'].every(version=>vm.runInNewContext(historicalSource(version)+';externalBotValidState(ledger)',{ledger:ledger4,Buffer,ExternalBotHooks:{},crypto,path})===false);
    ok(ledger4.schema===4&&oldRejected,'R11 exact historical v1/v2/v3 validators reject entire real producer payload4 ledger');
    // B2 actual acceptance entrance: original HTTP callback/worker/model turn,
    // held at the real fakeProvider request, and original official API adapter.
    // Kept after all B1 payload4 assertions so their semantics remain unchanged.
    for (const platform of ['feishu', 'qq']) {
      const marker = platform === 'qq' ? 'CONTROL_QPROGRESS' : 'CONTROL_PROGRESS', messageId = 'b2_' + platform;
      const selected = platform === 'qq' ? { ...qqConnection(), mode:'control', ownerSenderId:'qq_person', ownerConversationId:'qq_room', ownerConversationType:'group' } : connection();
      const configured = await request('POST','/api/external-bots/connections',{op:'upsert',connection:{...selected,progressUpdates:true},controlConfirmed:true});
      ok(configured.status===200, 'B2 ' + platform + ' progress setting uses original owner confirmation/API');
      const text = '请汇报 ' + marker;
      await callback(messageId,text,platform);
      await until(()=>progressRequests.get(marker),'held original B2 provider');
      const running = await until(async()=>{const row=await readItem(messageId);return row?.feedback?.progress?.status==='sent'&&row;},'B2 committed progress');
      ok(running.execution.status==='running'&&running.delivery===null&&commandCalls.get(marker)===1,'B2 '+platform+' automatic notice arrives while original provider/owner is still pending');
      const providerBefore=fake.requests.length,queryId=messageId+'_status';await callback(queryId,'/status '+running.id,platform);
      const queried=await delivered(queryId);
      ok(queried.feedback?.queryId===running.id&&queried.execution.turnSeq===0&&/processing/.test(queried.execution.replyText)
        &&fake.requests.length===providerBefore&&commandCalls.get(marker)===1,'B2 '+platform+' active query traverses callback/worker/adapter without a second business/provider call');
      const held=progressRequests.get(marker);for(const frame of textFrames(JSON.stringify({say:'B2_ACTUAL_FINAL',why:'original held provider completed',acts:[],actions:[]})))held.sse(frame);held.end();progressRequests.delete(marker);
      const final=await delivered(messageId),replies=outbound.filter(row=>platform==='qq'?row.body.msg_id===messageId:row.path.includes('/'+messageId+'/reply'));
      ok(final.execution.status==='completed'&&final.feedback.progress.status==='sent'&&replies.length===2
        &&(platform==='qq'?replies[0].body.msg_seq===1&&replies[1].body.msg_seq===2:replies[0].body.uuid!==replies[1].body.uuid),'B2 '+platform+' final keeps original execution and a separate stable sequence/attempt from progress');
      const requestsBefore=outbound.length;await stop();await start();await callback(messageId,text,platform,'b2_repeat_'+platform);
      const repeated=await readItem(messageId);
      ok(repeated.feedback.progress.attemptId===final.feedback.progress.attemptId&&repeated.delivery.attemptId===final.delivery.attemptId
        &&commandCalls.get(marker)===1&&outbound.length===requestsBefore,'B2 '+platform+' actual cold restart and duplicate callback preserve progress/final receipts without business/send replay');
    }
    ok(fake.errors.length===0,'C19 scripted model fixture has no hidden handler failures');
  } catch(error){runner.fail(error.stack||String(error));}
  finally{if(fs.existsSync(holdRetryFlag))fs.unlinkSync(holdRetryFlag);if(fs.existsSync(holdFlag))fs.unlinkSync(holdFlag);if(fs.existsSync(holdCancelFlag))fs.unlinkSync(holdCancelFlag);if(heldTokenResponse)heldTokenResponse.destroy();if(heldMessageResponse)heldMessageResponse.destroy();await stop();if(fake)await fake.close();if(apiServer){apiServer.closeAllConnections();await new Promise(resolve=>apiServer.close(resolve));}runner.done({exit:true});}
})();
