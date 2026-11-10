'use strict';
require('./lib/self-isolate-home');
// Real isolated HTTP/disk/restart with synthetic callbacks. --sealed uses the
// selected encrypted generation and Windows CurrentUser DPAPI.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {createRunner}=require('./lib/harness'),{fixtureChildEnv}=require('./lib/fixture-home'),{killOwnTree}=require('./lib/kill-own-tree'),{getFreePort}=require('./free-port');
const {FAKE_BOT_ENV,qqWire,qqEvent}=require('./lib/external-bot-fixtures'),{retentionSeed}=require('./lib/external-bots-retention-seed');
const {CONFIG_SCHEMA}=require('../ruyi-workbench/app/server.js');
const {createRetentionEvidence}=require('./lib/external-bots-retention-evidence');
function installFaults(flags){
  const fs=require('node:fs'),path=require('node:path'),io=fs.promises,rename=io.rename;
  const fold=value=>process.platform==='win32'?value.toLowerCase():value;
  if (flags.sealed) {
    require('node:https').request = () => {
      fs.writeFileSync(flags.outbound, 'unexpected-https');
      throw Error('external HTTPS is outside this fixture');
    };
  }
  io.rename=async function(from,to){
    if(fold(path.resolve(String(to)))!==fold(flags.file)||!fs.existsSync(flags.arm))return rename.call(this,from,to);
    const text=fs.readFileSync(from,'utf8');
    if (flags.sealed) {
      const header=JSON.parse(text.split('\n',1)[0]);
      if(header.workData!==3||header.purpose!=='queue')throw Error('retention attempted to publish an unsealed ledger');
    } else if(!JSON.parse(text).retentionRequests?.length) return rename.call(this,from,to);
    const mode=fs.readFileSync(flags.arm,'utf8');
    if(mode==='fail'){
      fs.writeFileSync(flags.failed,'failed-before-commit');
      throw Object.assign(Error('synthetic retention write failure'),{code:'ENOSPC'});
    }
    if(mode==='hold'){fs.writeFileSync(flags.held,'held-before-commit');while(fs.existsSync(flags.arm))await new Promise(r=>setTimeout(r,10));}
    const result=await rename.call(this,from,to);
    if(mode==='lose'){fs.writeFileSync(flags.committed,'committed-before-ack');while(fs.existsSync(flags.arm))await new Promise(r=>setTimeout(r,10));}
    return result;
  };
}
async function seedSealed(home, config, seed, env) {
  assert.equal(process.platform,'win32');
  assert.equal(fs.realpathSync(home).toLowerCase(),home.toLowerCase());
  Object.assign(process.env,env,{RUYI_HOME:home,WIN_CLAUDE_WORKBENCH_HOME:home});
  const api=require('./lib/server-internals').loadServerInternals([
    'WorkDataManifest','WorkDataKeys','LocalSecretCrypto','ServerOwnership','atomicWriteJson',
    'WorkDataRootHooks','workDataKeys','externalBotReadState','externalBotWriteState',
  ]);
  const owner=await api.ServerOwnership.acquire([home]);
  let staged;
  try {
    const manifest=api.WorkDataManifest.create({base:home}),initial=await manifest.readActive();
    const encrypted=await manifest.prepare({expected:initial,mode:'encrypted'});
    const keys=api.WorkDataKeys.create({store:{read:async()=>{throw Error('unexpected seed key read');}},
      enabled:()=>false,protector:api.LocalSecretCrypto});
    staged=await keys.stageNew();
    await api.atomicWriteJson(path.join(encrypted.root,'work-data-key-v1.json'),staged.header);
    await api.atomicWriteJson(path.join(encrypted.root,'config.json'),{...config,workDataEncryptionV1:true});
    await manifest.commit({expected:initial,candidate:encrypted});
    const selected=await api.WorkDataRootHooks.bind(owner);
    assert.equal(fs.realpathSync.native(selected.root).toLowerCase(),fs.realpathSync.native(encrypted.root).toLowerCase());
    await api.externalBotWriteState(seed);
    return {data:encrypted.root,read:api.externalBotReadState,clear:()=>api.workDataKeys.clear()};
  } finally {
    staged?.lease.release();
    api.workDataKeys.clear();
    await owner.release();
  }
}
const runner=createRunner('EXTERNAL BOTS RETENTION'),{ok}=runner,check=(value,label)=>{ok(Boolean(value),label);assert.ok(value,label);};
(async()=>{
  const args=process.argv.slice(2),sealed=args[0]==='--sealed';
  assert.equal(args.length,sealed?1:0,'expected only --sealed');
  const isolated=fixtureChildEnv({perTest:true}),home=fs.realpathSync(isolated.home);
  const arm=path.join(home,'retention-arm'),held=path.join(home,'retention-held'),committed=path.join(home,'retention-committed');
  const failed=path.join(home,'retention-failed');
  const preload=path.join(home,'retention-faults.cjs'),outbound=path.join(home,'retention-outbound');
  const seed=retentionSeed(),config={configSchema:CONFIG_SCHEMA,stewardEnabledV1:false,schedulerEnabledV1:false,autoImportClaudeCodeMcp:false,includeWorkbenchMcp:false,desktopMcp:{enabled:false,autodetect:false},externalMcpServers:[]};
  fs.writeFileSync(path.join(home,'config.json'),JSON.stringify(config));
  const sealedSeed=sealed?await seedSealed(home,config,seed,isolated.env):null;
  const data=sealedSeed?.data||home,file=path.join(data,'external-bots/state-v1.json');
  if(!sealed){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(seed,null,2));}
  fs.writeFileSync(preload,'('+installFaults.toString()+')('+JSON.stringify({file,arm,held,committed,failed,sealed,outbound})+');');
  const readState=sealedSeed?.read||(()=>JSON.parse(fs.readFileSync(file,'utf8')));
  const evidence=createRetentionEvidence('http');if(evidence){evidence.bind({root:home,home});evidence.captureFile('seed-before-server.bin',file);evidence.captureFile('config-before-server.bin',path.join(data,'config.json'));evidence.captureFile('fault-preload-before-server.bin',preload);}
  let originalFailure;
  let server,serverClosed=false,token='',port=await getFreePort();const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async fn=>{for(let i=0;i<400;i++){const result=await fn();if(result)return result;await pause(25);}throw Error('retention fixture timeout');};
  const request=async(method,route,body,headers={},admin=true)=>{if(evidence&&route.startsWith('/api/external-bots/retention/'))evidence.event('http-request',{method,route,body:body===undefined?null:Buffer.isBuffer(body)?body.toString('base64'):JSON.stringify(body)});const res=await fetch('http://127.0.0.1:'+port+route,{method,headers:{'content-type':'application/json',...(admin?{'x-wcw-token':token}:{}),...headers},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});const json=await res.json();if(evidence&&route.startsWith('/api/external-bots/retention/'))evidence.event('http-response',{method,route,status:res.status,json});return{status:res.status,json};};
  const start=async()=>{serverClosed=false;server=cp.spawn(process.execPath,['--require',preload,'app/server.js','serve','--port',String(port)],{cwd:path.resolve(__dirname,'../ruyi-workbench'),windowsHide:true,stdio:'ignore',env:{...process.env,...isolated.env,...FAKE_BOT_ENV,RUYI_HOME:home,WIN_CLAUDE_WORKBENCH_HOME:home}});server.once('close',()=>{serverClosed=true;});evidence?.observeChild('server',server,{stdio:'ignore'});await until(async()=>{try{return(await request('GET','/health',undefined,{},false)).status===200;}catch{return false;}});token=await until(async()=>{try{const runtime=JSON.parse(fs.readFileSync(path.join(home,'runtime.json'),'utf8'));return runtime.pid===server.pid&&runtime.token;}catch{return false;}});};
  const stop=async()=>{if(server){const child=server;evidence?.cleanup('server',child,'killOwnTree');if(child.exitCode===null&&child.signalCode===null)killOwnTree(child);await until(()=>serverClosed);server=null;}};
  const preview=(id='retention_e2e_000001')=>request('POST','/api/external-bots/retention/preview',{requestId:id,retainDays:30});
  const commit=body=>request('POST','/api/external-bots/retention/commit',body);
  const callback=(id,text)=>{const wire=qqWire(qqEvent({messageId:'retention_'+id,eventId:'repeat_'+id,text}));return request('POST','/api/external-bots/callback/qq?connectionId=qq_test',wire.bytes,wire.headers,false);};
  try{
    await start();for(const p of ['preview','commit']){check((await request('POST','/api/external-bots/retention/'+p,{}, {},false)).status===403,'R1 '+p+' token gate');check((await request('POST','/api/external-bots/retention/'+p,{}, {origin:'https://foreign.invalid'})).status===403,'R2 '+p+' origin gate');}
    const before=fs.readFileSync(file,'utf8'),p=(await preview()).json;check(p.count===4&&p.eligible===4&&fs.readFileSync(file,'utf8')===before,'R3 preview selects only four known terminal/read old bodies and writes nothing');const body={requestId:p.requestId,previewToken:p.previewToken};evidence?.captureFile('ledger-before.bin',file);evidence?.event('preview-selected',{preview:p,body});
    fs.writeFileSync(arm,'fail');
    check((await commit(body)).status===503&&fs.existsSync(failed)&&fs.readFileSync(file,'utf8')===before,
      'R4 failed atomic write removes no body and creates no receipt');
    fs.unlinkSync(arm);

    fs.writeFileSync(arm,'lose');
    const raw=Buffer.from(JSON.stringify(body));
    const req=http.request({host:'127.0.0.1',port,path:'/api/external-bots/retention/commit',method:'POST',
      headers:{'content-type':'application/json','content-length':raw.length,'x-wcw-token':token}});
    let acknowledged=false,disconnected=false,published;
    req.once('response',response=>{acknowledged=true;response.resume();});
    req.once('close',()=>{disconnected=true;});
    req.on('error',()=>{});
    try{
      evidence?.captureBytes('lost-ack-request.bin',raw);
      req.end(raw);
      await until(()=>fs.existsSync(committed));
      const saved=await readState();
      assert.equal(saved.retentionReceipts?.length,4);
      assert.ok(saved.retentionRequests?.some(row=>row.requestId===body.requestId&&row.count===4));
      published=fs.readFileSync(file);
      evidence?.captureFile('ledger-published-before-ack.bin',file);
      assert.equal(disconnected,false,'the original client is connected at the publish barrier');
    }finally{req.destroy();}
    await until(()=>disconnected);
    assert.equal(acknowledged,false,'the original client closed without a response while publication was held');
    evidence?.event('lost-ack-disconnected',{acknowledged,disconnected});
    fs.unlinkSync(arm);
    await stop();await start();
    const again=await commit(body);evidence?.captureFile('ledger-after-cold-replay.bin',file);check(again.status===200&&again.json.alreadyReclaimed&&again.json.receipt.count===4,'R5 real lost HTTP ACK reconciles exact durable request across process restart');
    const state=await readState();check(state.schema===5&&state.items.length===4&&state.retentionReceipts.length===4&&state.retentionRequests.length===1,'R6 body rows are physically removed while bounded receipts remain');
    if(sealed){
      const header=JSON.parse(published.toString('utf8').split('\n',1)[0]);
      check(header.workData===3&&header.purpose==='queue'&&fs.readFileSync(file).equals(published)&&!published.includes(body.requestId)&&
        !published.includes('RECLAIM_PRIVATE_BODY_')&&!published.includes('RECLAIM_PRIVATE_REPLY_'),'R14 cold exact-request replay preserves sealed ledger bytes and hides receipt and bodies');
    }
    for(const id of ['read','sent','failed','cancelled']){const contents=JSON.stringify(await readState());check(!contents.includes('RECLAIM_PRIVATE_BODY_'+id)&&!contents.includes('RECLAIM_PRIVATE_REPLY_'+id),'R7 no body/reply retained for '+id);check((await callback(id,'RECLAIM_PRIVATE_BODY_'+id)).status===200,'R8 signed duplicate ACK only '+id);check((await callback(id,'changed body')).status===409,'R9 changed duplicate conflicts '+id);}
    const cancelled=seed.items.find(row=>row.id==='body_cancelled'),cancel=await request('POST','/api/external-bots/deliveries/cancel',{id:cancelled.id,attemptId:cancelled.delivery.attemptId});check(cancel.status===200&&cancel.json.alreadyCancelled&&cancel.json.item.reclaimed,'R10 cancelled receipt remains idempotent');
    const retry=await request('POST','/api/external-bots/deliveries/retry',{id:'body_failed',expectedAttemptId:'attempt_failed_original',retryRequestId:'retention_seed_retry_000001'});check(retry.status===200&&retry.json.alreadyRetried&&retry.json.item.reclaimed,'R11 historical retry receipt remains stable without business/send');
    const changed=await commit({...body,previewToken:body.previewToken.replace(/.$/,body.previewToken.endsWith('0')?'1':'0')});check(changed.status===409,'R12 same request with different selection token refuses');
    check((await callback('new','new body after reclaim')).status===200&&(await readState()).items.length===5,'R13 freed capacity admits a new body under payload5');
    if(sealed)check(!fs.existsSync(outbound),'R15 sealed replay and signed callbacks never attempt external HTTPS');
  }catch(error){originalFailure=error;if(!runner.failures)runner.fail(error.stack||String(error));}finally{if(evidence)evidence.captureFile('ledger-final.bin',file);if(fs.existsSync(arm))fs.unlinkSync(arm);await stop();sealedSeed?.clear();evidence?.finish(originalFailure);runner.done();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
