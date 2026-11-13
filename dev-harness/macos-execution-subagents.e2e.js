'use strict';
require('./lib/self-isolate-home');
// Opt-in actual root -> foreground orchestration -> node provider -> real ACC SDK.
// Synthetic PNG payloads only; no desktop capture/input/GUI/held faults.
// Background/API/resume/CLI and full P5 remain separate qualification scopes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port');
const t = createRunner('MACOS EXECUTION SUBAGENTS');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'res-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const app = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const env = { ...fixtureChildEnv(), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
  APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TMPDIR: root,
  RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data };
for (const dir of [data, work, env.HOME, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, env);
let server, provider, token, port, output = '';
const observations = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(read, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(); }
  throw new Error('Timed out ' + label + '\n' + output.slice(-4000));
}
async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(route + ': ' + res.status + ' ' + await res.text());
  return res.json();
}
async function start() {
  port = await getFreePort(); token = '';
  server = cp.spawn(process.execPath, [app, 'serve', '--port', String(port)], { env: { ...process.env, ...env }, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
  await until(async () => {
    try { const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json')));
      if (runtime.pid !== server.pid || !runtime.token) return false;
      port = runtime.port; token = runtime.token;
      return (await api('/health')).ok;
    } catch { return false; }
  }, 'serve ready');
}
async function stop() {
  if (!server) return;
  const child = server, identity = snapshotProcessTable()?.find(row => row.pid === child.pid);
  if (!identity) throw new Error('Cannot establish owned service identity');
  killOwnTree(child);
  await until(() => {
    const rows = snapshotProcessTable();
    return rows && !rows.some(row => row.pid === identity.pid && row.created === identity.created);
  }, 'owned service exit');
  server = null;
}
async function turn(sessionId, message) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wcw-token': token }, body: JSON.stringify({ sessionId, message, cwd: work }),
    signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('turn HTTP ' + res.status);
  const events = (await res.text()).split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await api('/api/sessions/' + sessionId)).execution === null, 'driver finally');
  observations.push({ sessionId, message, events }); return events;
}
(async()=>{
  const specs=[],subContinuations=[],mainContinuations=[],proof=[],resourceObservations=[];
  const ledgerFile=path.join(data,'desktop-executions-v1/state.json');
  const entries=id=>JSON.parse(fs.readFileSync(ledgerFile)).entries.filter(row=>row.sessionId===id);
  const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
  const images=history=>history.filter(row=>row.role==='user'&&Array.isArray(row.content)&&row.content.some(part=>part.type==='image_url')).length;
  function check(value,label){t.ok(value,label);if(!value)throw new Error('Stopped after '+label);}
  function paired(history){const i=history.findIndex(row=>row.role==='assistant'&&row.tool_calls?.some(call=>call.id==='node_image'));return i>=0&&history[i+1]?.tool_call_id==='node_image'&&history[i+2]?.tool_call_id==='node_observe';}
  try{
    if(process.platform!=='darwin'||process.env.RUYI_EXECUTION_SUBAGENT_REQUIRED!=='1'){console.log('SKIP opt-in foreground node receipt qualification');return;}
    const helper=process.env.RUYI_EXECUTION_CONTEXT_HELPER,python=process.env.RUYI_ACC_PYTHON;if(!helper||!python)throw new Error('Explicit candidate helper and ACC Python required');
    const acc=path.resolve(__dirname,'../mcp/ai-computer-control');
    provider=await startFakeProvider({async handler(req){
      const users=req.messages.filter(row=>row.role==='user').map(row=>typeof row.content==='string'?row.content:'').join('\n');
      const spec=specs.find(row=>users.includes(row.label));if(!spec)return textFrames('metadata fixture');
      if(req.body.model==='fake-sub'){
        const nodeId=spec.nodeIds.find(id=>users.includes('SUBTASK '+spec.label+' '+id));if(!nodeId)throw new Error('Missing actual node task identity');
        if(spec.resourceWait&&nodeId==='worker0'&&!req.messages.some(row=>row.role==='tool')){
          await until(()=>fs.existsSync(path.join(root,'node-resource-requested')),'actual sibling tool resource request');
          await new Promise(resolve=>setTimeout(resolve,1200));
          const intent=fs.readdirSync(path.join(data,'desktop-executions-v1')).filter(name=>name.startsWith('intent-')).map(name=>JSON.parse(fs.readFileSync(path.join(data,'desktop-executions-v1',name)))).find(value=>value.sessionId===spec.sessionId&&value.nodeId==='worker1');
          const live=await api('/api/agent-runs/'+intent.runId+'?sessionId='+spec.sessionId);
          resourceObservations.push({label:spec.label,runId:intent.runId,node:live.run.nodes.find(node=>node.id==='worker1')});
        }
        if(spec.resourceWait&&nodeId==='worker1'&&!req.messages.some(row=>row.role==='tool'&&row.tool_call_id==='node_write'))return toolCallFrames('file_write',{path:spec.resourceFile,content:'actual isolated node resource write'},'node_write');
        if(spec.delayed&&nodeId==='worker1'&&!req.messages.some(row=>row.role==='tool'))await until(()=>fs.existsSync(path.join(root,'node-flush-paused')),'owned first-node delivery rendezvous');
        if(spec.dispatchGap&&nodeId==='worker1'&&!req.messages.some(row=>row.role==='tool'))await until(()=>fs.existsSync(path.join(root,'node-acc-blocked.json')),'owned first ACC entry rendezvous');
        if(req.messages.some(row=>row.role==='tool'&&row.tool_call_id==='node_observe')){
          if(spec.readControl&&!req.messages.some(row=>row.role==='tool'&&row.tool_call_id==='node_control'))return toolCallFrames([{name:'ai_computer_control__execution_receipt',args:{invocation_id:'0'.repeat(32)},id:'node_control'},{name:'ai_computer_control__execution_receipt',args:{invocation_id:'not-an-invocation'},id:'node_control_bad'}]);
          subContinuations.push({label:spec.label,nodeId,messages:req.messages,entries:entries(spec.sessionId)});return textFrames(spec.refuse?'EXPECTED_ACC_REFUSAL_NOT_SUPPORTED':'NODE_TASK_COMPLETE');
        }
        if(spec.fault)return toolCallFrames([{name:'ai_computer_control__fixture_image',args:{label:spec.label+' '+nodeId},id:'node_image'}, {name:'file_write',args:{path:spec.mustNotExist,content:'must never run'},id:'node_after_image'}]);
        return toolCallFrames([{name:'ai_computer_control__fixture_image',args:{label:spec.label+' '+nodeId},id:'node_image'},
          {name:'ai_computer_control__fixture_observe_node',args:{label:spec.label+' '+nodeId},id:'node_observe'}]);
      }
      const result=req.messages.find(row=>row.role==='tool'&&row.tool_call_id==='launch_'+spec.label);
      if(result){mainContinuations.push({label:spec.label,messages:req.messages,entries:entries(spec.sessionId),result:JSON.parse(result.content)});return textFrames('NODE_CHAIN_COMPLETE');}
      return toolCallFrames('orchestrate_agents',{nodes:spec.nodeIds.map(id=>({id,task:'SUBTASK '+spec.label+' '+id,toolTier:'exec',model:'fake-sub',maxIters:4,...(spec.resourceWait&&id==='worker0'?{resources:['file:'+spec.resourceFile]}:{})})),background:spec.background===true},'launch_'+spec.label);
    }});
    fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({configSchema:9,permissionMode:'bypass',defaultWorkspace:work,
      toolLoadingMode:'full',subagentMaxPerTurn:8,subagentMaxConcurrent:3,agentWorkflowMaxNodes:8,agentAutoWake:false,
      providers:[{id:'fake',type:'openai-compat',apiStyle:'chat',baseUrl:provider.url,apiKey:'synthetic-key',model:'fake-main',vision:true,models:[{id:'fake-main'},{id:'fake-sub'}]}],activeProvider:'fake',
      includeWorkbenchMcp:false,autoImportClaudeCodeMcp:false,enableMcpDropIn:false,schedulerEnabledV1:false,stewardEnabledV1:false,
      allowDesktopTools:true,allowCommandTools:true,desktopMcp:{enabled:false,autodetect:false},bridgeExternalToolsToProvider:true,
      externalMcpServers:[{id:'ai-computer-control',enabled:true,command:python,args:['-X','utf8',path.resolve(__dirname,'fixtures/execution-image-server.py')],cwd:acc,startupTimeoutMs:20000,
        env:{...env,PYTHONPATH:path.join(acc,'src'),PYTHONDONTWRITEBYTECODE:'1',WCW_DATA_DIR:path.join(root,'acc-data'),RUYI_FIXTURE_DATA:data,
          RUYI_EXECUTION_CONTEXT_REQUIRED:'0',ACC_TOOLSETS:'desktop,macro',ACC_HIDE_TOOLS:'',RUYI_MACOS_AUTOMATION_HELPER:helper}}]}));
    env.RUYI_DESKTOP_EXECUTION_RECEIPTS='1';env.RUYI_NODE_TEST_ROOT=root;env.RUYI_NODE_TEST_SERVER=app;env.NODE_OPTIONS=(env.NODE_OPTIONS||'')+' --require='+path.resolve(__dirname,'fixtures/execution-node-preload.cjs');await start();
    for(const scenario of [1,2,3,'DELAYED','DISPATCH_GAP','RESOURCE_WAIT']){
      const count=typeof scenario==='number'?scenario:2;
      const spec={label:'NODE_FOREGROUND_'+scenario,nodeIds:Array.from({length:count},(_,i)=>'worker'+i),delayed:scenario==='DELAYED',dispatchGap:scenario==='DISPATCH_GAP',resourceWait:scenario==='RESOURCE_WAIT',resourceFile:path.join(work,'node-resource.txt'),readControl:scenario===1};
      if(spec.delayed)fs.writeFileSync(path.join(root,'node-control'),'delay_first_node_flush');
      if(spec.resourceWait)fs.writeFileSync(path.join(root,'node-control'),'resource_wait');
      spec.sessionId=(await api('/api/sessions',{title:spec.label,cwd:work})).session.id;specs.push(spec);
      const events=await turn(spec.sessionId,spec.label),rows=entries(spec.sessionId),continuation=mainContinuations.find(row=>row.label===spec.label);
      proof.push({spec,events,rows,continuation});
      check(!events.some(row=>row.type==='error')&&continuation?.result.status==='succeeded',spec.label+' actual foreground workflow succeeds through real root/node/provider/SDK');
      check(rows.length===count*2&&rows.every(row=>row.phase==='returned'&&row.deliverySha256&&row.nodeDelivery),spec.label+' each actual ACC business invocation has a durable typed node delivery');
      check(new Set(rows.map(row=>row.admissionId)).size===count&&new Set(rows.map(row=>row.callIdHash)).size===count*2,spec.label+' repeated textual call IDs remain distinct across actual nodes');
      const saved=[];
      for(const row of rows){const file=path.join(data,'desktop-executions-v1',row.nodeDelivery.file),snapshot=JSON.parse(fs.readFileSync(file));saved.push(snapshot);
        check(snapshot.historySha256===hash(JSON.stringify(snapshot.history))&&snapshot.historySha256===row.deliverySha256&&snapshot.admissionId===row.admissionId,
          spec.label+' exact private node history binds actual invocation '+row.toolName+'/'+row.nodeDelivery.scope.nodeId);
        check(images(snapshot.history)===1&&snapshot.binding.nodeId===row.nodeDelivery.scope.nodeId&&snapshot.binding.attempt===1,
          spec.label+' actual required image part and node attempt survive delivery '+row.toolName+'/'+snapshot.binding.nodeId);
      }
      const resumes=subContinuations.filter(row=>row.label===spec.label);
      check(resumes.length===count&&resumes.every(row=>paired(row.messages)&&images(row.messages)===1),spec.label+' actual node model continuations see paired tool block followed by its image');
      for(const resumed of resumes){const result=JSON.parse(resumed.messages.find(row=>row.role==='tool'&&row.tool_call_id==='node_observe').content);
        check(result.ok&&result.sameNodeAdmission&&result.lastImageDeliveryMatchesSnapshot&&result.images===1,
          spec.label+' next actual ACC body sees its own saved node image, never parent history '+resumed.nodeId);}
      const parent=fs.readFileSync(path.join(data,'sessions',spec.sessionId+'.provider.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
      check(images(parent)===0&&!parent.some(row=>row.role==='tool'&&row.tool_call_id==='node_image'),spec.label+' child history stays separate from actual parent transcript');
      proof.push({spec,snapshots:saved,resumes,parent});
      if(spec.delayed){check(fs.existsSync(path.join(root,'node-flush-paused'))&&fs.readFileSync(path.join(root,'node-flush-release'),'utf8')==='sibling_at_actual_guard','controlled sibling guard waits for real pending node image publication without dispatch failure');fs.rmSync(path.join(root,'node-control'));}
      if(spec.dispatchGap){const queued=JSON.parse(fs.readFileSync(path.join(root,'node-dispatch-observation.json')));check(queued.rows.length===1&&queued.first.phase==='dispatching'&&queued.first.nodeDelivery.scope.nodeId==='worker0','actual sibling cannot prepare or dispatch while first ACC call and its delivery own the session ticket');proof.push({serialDispatchObservation:queued});}
      if(spec.readControl){const control=JSON.parse(resumes[0].messages.find(row=>row.role==='tool'&&row.tool_call_id==='node_control').content),invalid=JSON.parse(resumes[0].messages.find(row=>row.role==='tool'&&row.tool_call_id==='node_control_bad').content);check(control.incomplete===true&&control.semantic_validation?.lifecycle_unknown===true&&invalid.ok===false&&invalid.outcome==='unknown'&&rows.length===2,'actual read-only receipt query reports historical uncertainty without inventing a new unknown desktop action or blocking the next model request');}
      if(spec.resourceWait){const waiting=resourceObservations.find(row=>row.label===spec.label);check(waiting.node.status==='waiting_resource'&&waiting.node.progressLog.some(row=>row.kind==='gen'),'actual tool heartbeat does not falsely resume resource-waiting node in live run API');check(fs.readFileSync(spec.resourceFile,'utf8')==='actual isolated node resource write','actual resource acquisition resumes isolated file tool and later ACC delivery');fs.rmSync(path.join(root,'node-control'));}
    }
    await stop();await start();check(specs.every(spec=>entries(spec.sessionId).every(row=>row.phase==='returned'&&row.deliverySha256)),'actual service restart strictly reopens and retains valid node snapshot deliveries');
    const background={label:'NODE_BACKGROUND_REFUSAL',nodeIds:['worker0'],background:true,refuse:true};
    background.sessionId=(await api('/api/sessions',{title:background.label,cwd:work})).session.id;specs.push(background);
    const backgroundEvents=await turn(background.sessionId,background.label),accepted=mainContinuations.find(row=>row.label===background.label)?.result;
    const backgroundRun=await until(async()=>{if(!accepted?.runId)return false;const value=await api('/api/agent-runs/'+accepted.runId+'?sessionId='+background.sessionId);return !value.run.live&&value.run.status!=='running'?value.run:false;},'actual unsupported background node finishes with explicit tool refusal');
    const backgroundResume=subContinuations.find(row=>row.label===background.label);
    check(accepted.background===true&&entries(background.sessionId).length===0&&backgroundResume?.messages.filter(row=>row.role==='tool').every(row=>JSON.parse(row.content).ok===false),
      'actual background workflow cannot borrow its former parent admission or dispatch ACC without independent workflow identity');
    proof.push({spec:background,events:backgroundEvents,run:backgroundRun,resume:backgroundResume});
    const apiOrigin={label:'NODE_API_ZERO_REFUSAL',nodeIds:['worker0'],refuse:true};
    apiOrigin.sessionId=(await api('/api/sessions',{title:apiOrigin.label,cwd:work})).session.id;specs.push(apiOrigin);
    const apiResult=await api('/api/agent-workflow/launch',{token,sessionId:apiOrigin.sessionId,nodes:[{id:'worker0',task:'SUBTASK '+apiOrigin.label+' worker0',toolTier:'exec',model:'fake-sub',maxIters:4}],envelope:true});
    const apiSession=await api('/api/sessions/'+apiOrigin.sessionId),apiResume=subContinuations.find(row=>row.label===apiOrigin.label);
    proof.push({spec:apiOrigin,result:apiResult,session:apiSession,resume:apiResume});
    check(apiSession.session?.turnSeq===0&&entries(apiOrigin.sessionId).length===0&&apiResume?.messages.filter(row=>row.role==='tool').every(row=>JSON.parse(row.content).ok===false),
      'actual authenticated API origin preserves factual turn zero and refuses ACC rather than inventing a parent turn');
    await stop();fs.writeFileSync(path.join(root,'node-control'),'stop_after_delivery');await start();
    const stopped={label:'NODE_STOP_AFTER_DELIVERY',nodeIds:['worker0'],fault:'stop_after_delivery',mustNotExist:path.join(work,'stopped-node-must-not-write.txt')};
    stopped.sessionId=(await api('/api/sessions',{title:stopped.label,cwd:work})).session.id;specs.push(stopped);
    const pendingStop=turn(stopped.sessionId,stopped.label);pendingStop.catch(()=>{});
    await until(()=>fs.existsSync(path.join(root,'node-stop-paused')),'actual node acknowledgement before Stop');
    const execution=(await api('/api/sessions/'+stopped.sessionId)).execution;
    const stopResponse=await api('/api/stop',{sessionId:stopped.sessionId,expectedExecution:execution});fs.writeFileSync(path.join(root,'node-stop-release'),'release');
    const stoppedEvents=await pendingStop,stoppedRows=entries(stopped.sessionId);proof.push({spec:stopped,events:stoppedEvents,rows:stoppedRows,stopResponse});
    check(stopResponse.ok&&stoppedRows.length===1&&stoppedRows[0].phase==='returned'&&stoppedRows[0].deliverySha256,'real parent Stop retains already acknowledged child image and exact private snapshot');
    check(!fs.existsSync(stopped.mustNotExist)&&!stoppedEvents.some(row=>row.type==='tool_use'&&row.id==='node_after_image'),'Stop after node image never dispatches later same-batch local mutation');
    check(!subContinuations.some(row=>row.label===stopped.label)&&!mainContinuations.some(row=>row.label===stopped.label),'Stop after node delivery does not resume child or parent model');
    fs.rmSync(path.join(root,'node-control'));const afterStop=await turn(stopped.sessionId,'explicit new request after acknowledged node Stop');
    check(!afterStop.some(row=>row.type==='error')&&entries(stopped.sessionId).length===1,'explicit later parent request can continue verified delivery without replaying the stopped node');
    for(const mode of ['intent_eio','history_eio','reservation_loss']){
      await stop();for(const file of ['node-fault-hit.json','node-flush-paused','node-flush-release'])fs.rmSync(path.join(root,file),{force:true});
      fs.writeFileSync(path.join(root,'node-control'),mode);await start();
      const spec={label:'NODE_FAULT_'+mode,nodeIds:['worker0'],fault:mode,mustNotExist:path.join(work,mode+'-must-not-exist.txt')};
      spec.sessionId=(await api('/api/sessions',{title:spec.label,cwd:work})).session.id;specs.push(spec);
      const events=await turn(spec.sessionId,spec.label),rows=entries(spec.sessionId);proof.push({spec,events,rows,fault:JSON.parse(fs.readFileSync(path.join(root,'node-fault-hit.json')))});
      check(!fs.existsSync(spec.mustNotExist)&&!events.some(row=>row.type==='tool_use'&&row.id==='node_after_image'),mode+' never dispatches a later same-node local file write');
      if(mode==='intent_eio'){
        check(rows.length===0&&!events.some(row=>row.type==='tool_use'&&row.subagentId),'actual node intent publication failure dispatches no business call');
        check(mainContinuations.find(row=>row.label===spec.label)?.result.status==='failed','known no-dispatch intent failure returns a failed node envelope');
      }else{
        check(rows.length===1&&rows[0].deliverySha256===null,mode+' keeps exactly one unacknowledged node invocation');
        check(!subContinuations.some(row=>row.label===spec.label)&&!mainContinuations.some(row=>row.label===spec.label),mode+' blocks both node and parent model continuation');
        const trace=path.join(root,'acc-data/logs/execution-receipts',rows[0].invocationId,'events.ndjson');
        check(mode==='history_eio'?fs.existsSync(trace)&&fs.readFileSync(trace,'utf8').includes('acc_request_terminal'):!fs.existsSync(trace),mode+' distinguishes actual completed SDK entry from reservation refusal before SDK send');
        await stop();fs.rmSync(path.join(root,'node-control'));await start();const held=await turn(spec.sessionId,'new request after node delivery fault');
        check(held.some(row=>row.type==='error')&&entries(spec.sessionId).length===1&&entries(spec.sessionId)[0].phase==='unknown',mode+' actual restart holds without re-executing the node or later local write');
      }
      fs.rmSync(path.join(root,'node-control'),{force:true});
    }
    await stop();const damaged=entries(specs[0].sessionId)[0];fs.unlinkSync(path.join(data,'desktop-executions-v1',damaged.nodeDelivery.file));await start();
    const before=provider.requests.length,held=await turn(specs[0].sessionId,'after owned node snapshot deletion');
    check(held.some(row=>row.type==='error')&&entries(specs[0].sessionId).find(row=>row.invocationId===damaged.invocationId).phase==='unknown',
      'actual restart detects deleted acknowledged node transcript and durably holds its session');
    check(provider.requests.length===before&&entries(specs[0].sessionId).length===2,'lost node history never reaches a new model request or replays an ACC invocation');
  }catch(error){t.fail(error.stack||String(error));}
  finally{
    try{await stop();}catch(error){t.fail('cleanup '+error.message);}if(provider)await provider.close();
    if(process.env.RUYI_EXECUTION_SUBAGENT_EVIDENCE)fs.writeFileSync(process.env.RUYI_EXECUTION_SUBAGENT_EVIDENCE,JSON.stringify({scope:'actual foreground positive-turn node/provider/SDK synthetic PNG receipts and node history; no background/API0/resume/CLI/native capture/input/full P5',root,proof,subContinuations,mainContinuations,resourceObservations,observations,output},null,2));
    fs.rmSync(root,{recursive:true,force:true});t.done();
  }
})();
