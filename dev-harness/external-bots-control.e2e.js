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
  const faults = path.join(home, 'control-faults.cjs');
  fs.writeFileSync(faults, `const fs=require('fs'),p=fs.promises,rename=p.rename;p.rename=async function(from,to){if(String(to).replaceAll('\\\\','/').endsWith('/external-bots/state-v1.json')){const data=JSON.parse(fs.readFileSync(from,'utf8'));if(fs.existsSync(${JSON.stringify(failCompletedFlag)})&&data.items.some(x=>x.messageId==='completion_failure'&&x.execution&&x.execution.status==='completed'))throw Object.assign(new Error('synthetic completion write failure'),{code:'ENOSPC'});if(fs.existsSync(${JSON.stringify(holdFlag)})){fs.writeFileSync(${JSON.stringify(heldFlag)},'held');while(fs.existsSync(${JSON.stringify(holdFlag)}))await new Promise(r=>setTimeout(r,10));}}return rename.call(this,from,to);};`);
  let server, fake, apiServer, port, apiPort, token = '', targetId = '', heldTokenResponse = null, holdToken = false, deliveryMode = 'ok';
  const commandCalls = new Map(), toolReceipts = [], outbound = [];
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
    server = cp.spawn(process.execPath, ['--require', path.join(__dirname,'lib/external-channel-delivery-preload.js'), '--require', faults, 'app/server.js', 'serve', '--port', String(port)], {
      cwd: WB, windowsHide:true, stdio:'ignore', env:{ ...process.env, ...isolated.env, ...FAKE_BOT_ENV, RUYI_BOT_TEST_F_APP:'synthetic-app-secret', RUYI_FAKE_EXTERNAL_API_PORT:String(apiPort), RUYI_HOME:home, WIN_CLAUDE_WORKBENCH_HOME:home },
    });
    await until(async()=>{try{return(await request('GET','/health',undefined,{},false)).status===200;}catch{return false;}},'server');
    token=await until(()=>{try{return JSON.parse(fs.readFileSync(path.join(home,'runtime.json'),'utf8')).token;}catch{return false;}},'token');
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
        res.setHeader('content-type','application/json');res.end(JSON.stringify(req.headers.host==='api.bot.qq.com'?{access_token:'synthetic-token',expires_in:'7200'}:{code:0,tenant_access_token:'synthetic-token',expire:7200}));return;
      }
      outbound.push({host:req.headers.host,path:req.url,body});
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
    ok(fake.errors.length===0,'C19 scripted model fixture has no hidden handler failures');
  } catch(error){runner.fail(error.stack||String(error));}
  finally{if(fs.existsSync(holdFlag))fs.unlinkSync(holdFlag);if(heldTokenResponse)heldTokenResponse.destroy();await stop();if(fake)await fake.close();if(apiServer){apiServer.closeAllConnections();await new Promise(resolve=>apiServer.close(resolve));}runner.done({exit:true});}
})();
