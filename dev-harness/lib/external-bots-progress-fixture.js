'use strict';
// Source VM + original encrypted queue owner; synthetic official HTTPS events.
// No server/listener, socket, platform key, native process or engine capability.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),assert=require('node:assert/strict');
const {loadWorkDataChunks}=require('./work-data-chunks-fixture'),{functionBlock}=require('./source-slice');
const wire=require('./external-bot-fixtures');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function fixture({platform='qq',baselineRoot=null,_storage=null}={}) {
 const repo=path.resolve(__dirname,'../..'),directory=_storage?.directory||await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-b2-source-')),key=_storage?Buffer.from(_storage.key):crypto.randomBytes(32);
 const source=name=>fs.readFileSync(path.join(baselineRoot||repo,'ruyi-workbench/app/src',name),'utf8');
 let at=_storage?.at||Date.parse('2026-10-30T08:00:00Z'),serial=_storage?.serial||0,context,api;const timers=[],requests=[],projections=[],run=defer(),started=defer();
 const state={lostKey:false,failWrite:false,tokenGate:null,tokenAdvance:0,messageMode:'ok',businessEntries:0};
 run.promise.catch(()=>{});const active=[];
 const fx=loadWorkDataChunks();fx.store.Hooks.keys={snapshot:async()=>{if(state.lostKey)throw Object.assign(Error('fixture lost key'),{code:'work_data_key.absent'});const copy=Buffer.from(key);return{key:copy,instanceId:'b2-source',release:()=>copy.fill(0)};}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}}
 const https={request(options,listener){
  assert.equal(options.protocol,'https:');assert.equal(options.port,443);assert.equal(options.method,'POST');assert.equal(options.rejectUnauthorized,true);
  const request=new EventEmitter();request.destroy=()=>{};
  request.end=bytes=>{const body=JSON.parse(Buffer.from(bytes).toString());const token=options.path==='/app/getAppAccessToken'||options.path==='/open-apis/auth/v3/tenant_access_token/internal';
   if(platform==='qq'){assert.equal(options.hostname,'api.bot.qq.com');assert.ok(token||/^\/v2\/groups\/qq_room\/messages$/.test(options.path));}
   else{assert.equal(options.hostname,'open.feishu.cn');assert.ok(token||/^\/open-apis\/im\/v1\/messages\/[^/?#]+\/reply$/.test(options.path));}
   requests.push({options,body,token});state.onRequest?.(requests.at(-1));
   Promise.resolve().then(async()=>{
    if(token&&state.tokenGate)await state.tokenGate.promise;if(token&&state.tokenAdvance){at+=state.tokenAdvance;state.tokenAdvance=0;}
    if(!token&&state.messageMode==='lost-ack'){request.emit('error',Error('synthetic lost receipt'));return;}
    if(!token&&state.failAfterMessage)state.failWrite=true;
    const response=new PassThrough();response.statusCode=!token&&state.messageMode==='429'?429:200;response.headers=response.statusCode===429?{'retry-after':'7'}:{};
    listener(response);response.end(JSON.stringify(token?(platform==='qq'?{access_token:'synthetic_access'}:{code:0,tenant_access_token:'synthetic_access'}):response.statusCode===429?{code:429}:platform==='qq'?{id:'sent_'+serial++}:{code:0,data:{message_id:'sent_'+serial++}}));
   }).catch(error=>request.emit('error',error));
  };return request;
 }};
 const env={...wire.FAKE_BOT_ENV,RUYI_BOT_TEST_F_APP:'synthetic-app-only'};
 const connection=platform==='qq'?wire.qqConnection():{...wire.feishuConnection(),appSecretEnv:'RUYI_BOT_TEST_F_APP'};
 Object.assign(connection,{mode:'control',ownerSenderId:platform==='qq'?'qq_person':'ou_person',ownerConversationId:platform==='qq'?'qq_room':'oc_room',ownerConversationType:'group'});
 context=vm.createContext({Buffer,TextDecoder,URL,URLSearchParams,AbortController,Date:Clock,crypto,path,fs,fsp,process:{env},paths:{data:directory},OVERLAY_ID:'b2_epoch',STEWARD_SESSION_ID:'steward',ExternalBotHooks:{},
  require:name=>name==='node:https'?https:require(name),WorkDataStore:fx.store,readConfig:async()=>({workDataEncryptionV1:true}),nowIso:()=>new Clock().toISOString(),makeId:prefix=>prefix+'_'+(++serial),
  atomicWriteJson:async(...args)=>{if(state.failWrite)throw Object.assign(Error('synthetic write rejection'),{code:'EIO'});return fx.atomicWriteJson(...args);},
  setTimeout:(callback,ms)=>{const timer={callback,ms,active:true,unref(){}};timers.push(timer);return timer;},clearTimeout:timer=>{if(timer)timer.active=false;},
  runStewardTurn:async input=>{await context.ExternalBotHooks.validateActor(input.externalActor);state.businessEntries++;started.resolve();return run.promise;},
  PrivacyGateway:{withPolicy:(_id,work)=>work(),disclosurePolicyGuard:()=>()=>{},prepareDisclosure:async(text,binding)=>{projections.push({text,binding});return{receipt:{text,binding:{recipient:binding.recipient,purpose:binding.purpose,sourceHash:binding.sourceHash}}};},refreshDisclosure:async(receipt,binding)=>{assert.deepEqual(JSON.parse(JSON.stringify(binding)),JSON.parse(JSON.stringify(receipt.binding)));return receipt.text;},assertDisclosure:(receipt,binding)=>assert.equal(receipt.text,binding.value)},
  ExternalBotCredentials:{snapshot:async c=>{const values={};for(const slot of platform==='qq'?['botSecret']:['verificationToken','encryptKey','appSecret'])values[slot]=env[c[slot+'Env']]||'';return{values,credentialRevision:crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex')};}}
 });
 api=vm.runInContext(functionBlock(fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/00-boot.js'),'utf8'),'runKeyedChain')+'\n'+source('13v-external-channel-protocols.js')+'\n'+source('13x-external-channel-delivery.js')+'\n'+source('13w-external-bots.js')+`\n({
 read:externalBotReadState,write:externalBotWriteState,valid:externalBotValidState,normalize:externalBotNormalizeConnection,
 update:body=>runKeyedChain(externalBotChains,'state',()=>externalBotUpdateConnection(body)),
 accept:(headers,body)=>runKeyedChain(externalBotChains,'state',()=>externalBotAcceptCallback('${platform}','${connection.id}',headers,body)),
 next:externalBotNextJob,finish:externalBotFinishJob,recover:externalBotRecover,drain:externalBotDrain,wake:externalBotWakeWorker,
 send:typeof externalBotSendJob==='function'?externalBotSendJob:null,adapter:ExternalChannelDelivery.sendReply,
 page:async()=>externalBotDeliveryPage(await externalBotReadState(),new URLSearchParams()),publicItem:externalBotPublicItem,
 stop:ExternalBotHooks.stop,cancel:body=>runKeyedChain(externalBotChains,'state',()=>externalBotCancelDelivery(body)),
 retentionEligible:externalBotRetentionEligible,receipt:externalBotRetentionReceipt,validReceipt:externalBotValidRetentionReceipt,
 archive:body=>runKeyedChain(externalBotChains,'state',()=>externalBotArchiveDelivery(body)),
 preview:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionPreview(body)),
 reclaim:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionCommit(body)),
 retireActor:job=>{externalBotActors.delete(job.actor);externalBotActiveActors.delete(job.item.id);},
 busy:()=>externalBotWorkerBusy,workerError:()=>externalBotWorkerError})`,context,{timeout:3000});
 const commits=[],observers=[];const finish=context.externalBotFinishJob;
 if(api.send){const send=api.send;api.send=job=>{const promise=send(job);active.push(promise);return promise;};}
 context.externalBotFinishJob=async(job,result)=>{const value=await finish(job,result);const event={job,result};commits.push(event);for(const observer of [...observers])if(observer.test(event)){observers.splice(observers.indexOf(observer),1);observer.resolve(event);}return value;};
 const waitCommit=test=>{const existing=commits.find(test);return existing?Promise.resolve(existing):new Promise(resolve=>observers.push({test,resolve}));};
 const accept=async(text,id='in_'+(++serial),extra={})=>{const payload=platform==='qq'?wire.qqEvent({text,messageId:id,eventId:'event_'+id,timestamp:at,...extra}):wire.feishuEvent({text,messageId:id,eventId:'event_'+id,timestamp:at,group:true,...extra});const signed=platform==='qq'?wire.qqWire(payload,{timestamp:String(Math.floor(at/1000))}):wire.feishuWire(payload,{timestamp:String(Math.floor(at/1000))});return api.accept(signed.headers,signed.bytes);};
 const start=()=>{const promise=api.drain();active.push(promise);return promise;};
 const close=async()=>{api.stop();state.tokenGate?.resolve();run.reject(Error('fixture engine unavailable'));await Promise.allSettled(active);key.fill(0);if(!_storage){assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fsp.rm(directory,{recursive:true,force:true});}};
 return{api,context,state,connection,accept,requests,projections,timers,started,run,directory,start,waitCommit,cold:()=>fixture({platform,baselineRoot,_storage:{directory,key,at,serial}}),advance:ms=>{at+=ms;},now:()=>at,close};
}
async function turns(){for(let i=0;i<24;i++)await new Promise(resolve=>setImmediate(resolve));}
module.exports={fixture,defer,turns};
