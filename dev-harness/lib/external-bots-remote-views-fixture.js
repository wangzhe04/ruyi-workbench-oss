'use strict';
const a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {functionBlock,constBlock}=require('./source-slice');
const {fixture,plain}=require('./external-bots-inbox-fixture'),privacy=require('./privacy-test-fixture');
const moduleSource=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/13w1-external-remote-views.js'),'utf8');
const botSource=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/13w-external-bots.js'),'utf8');
async function make(t){
 const f=fixture({source:botSource}),dir=path.dirname(f.file);f.context.nowIso=()=>new Date(f.context.Date.now()).toISOString();fs.mkdirSync(dir,{recursive:true});const journal=path.join(dir,'interventions.json'),runFile=path.join(dir,'run.json');fs.writeFileSync(journal,'synthetic journal');fs.writeFileSync(runFile,'synthetic run');
 const p=privacy.fixture(),gateway=privacy.gateway(dir,p);gateway.configure({privacyModeV1:'enhanced',privacyRulesV1:[],providers:[]});t.after(()=>p.vault.clear());
 const questions=[{id:'q1',answerMode:'single',allowOther:false,options:[{id:'o1',label:'one'},{id:'o2',label:'two'}]}],rows=['permission','question','plan','pool','replan'].map((type,i)=>({id:'iv_'+type,sessionId:'session',type,status:'pending',interventionVersion:i,requestedAt:'2026-10-30T01:00:00.000Z',input:{command:'synthetic command'},toolName:'exec',tier:'exec',questions,context:'full question context',runId:'run'}));
 const state={rows,head:{id:'session',title:'synthetic title',cwd:'C:/synthetic',permissionMode:'default'},config:{privacyModeV1:'enhanced'},generation:0,seq:0,degraded:false,strictReads:0};
 const permissions=new Map([['iv_permission',{sessionId:'session',deadlineAt:Date.now()+300000}]]),qs=new Map([['iv_question',{sessionId:'session',questions:structuredClone(questions)}]]),plans=new Map([['iv_plan',{sessionId:'session',markdown:'long plan '+ 'x'.repeat(6000)+' PRIVATE_SOURCE_CANARY'}]]),run={id:'run',sessionId:'session',status:'running',permissionCeiling:'default',taskPool:[{id:'iv_pool',status:'proposed',task:'complete pool task',roleId:'worker'}],replanPatches:[{id:'iv_replan',status:'pending',changes:[{op:'add',task:'full change'}]}]},runs=new Map([['run',{run}]]);
 Object.assign(f.context,{structuredClone,fs,configReadFence:()=>{const version=state.generation;return()=>{if(version!==state.generation)throw Error('config changed');};},sessionDiskWriteSeqOf:()=>state.seq,interventionFilePath:()=>journal,
 readInterventionsWithMeta:async(_sid,options)=>{a.equal(options.strict,true);state.strictReads++;return{interventions:plain(state.rows),degraded:state.degraded,corruptLines:0};},readSessionHeadResilient:async()=>plain(state.head),readConfig:async()=>plain(state.config),pendingPermissions:permissions,pendingQuestions:qs,pendingPlans:plans,activeAgentRuns:runs,
 agentRunFile:()=>runFile,readAgentRunSnapshot:async()=>plain(run),getPretenderProjectionIndex:async()=>({sessions:[{sessionId:'session',interventions:state.rows}],degraded:{active:state.degraded}}),pendingInterventionRefs:index=>({refs:index.sessions[0].interventions.filter(iv=>iv.status==='pending').map(iv=>({slice:{sessionId:'session'},iv}))}),PrivacyGateway:gateway});
 const src=file=>fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src',file),'utf8');
 const registration=src('04-permission-runtime.js'),store=src('02-session-store.js');
 const owner={authority:null,cancelRequested:false},reg={child:{stdin:{writable:true}}};Object.assign(f.context,{turnSettlers:new Map([['session',owner]]),activeChildren:new Map([['session',reg]]),interventionWriteChains:new Map()});
 fs.writeFileSync(journal,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const declarations=[constBlock(registration,'interventionConsumerOrigins'),...['assertSessionExecutionOwner','captureInterventionConsumer','registerInterventionConsumer','assertInterventionConsumer'].map(name=>functionBlock(registration,name)),...['foldInterventionJournalText','interventionJournalStamp','readInterventionJournalProof'].map(name=>functionBlock(store,name))];
 f.context.decodeSessionJournalText=async(_sid,_kind,text)=>text;
 f.context.ExternalChannelProtocols.prepareAudienceRevision=async()=>({revision:'b'.repeat(64),assert(){}});
 vm.runInContext(declarations.join('\n')+'\nfor(const registry of [pendingPermissions,pendingQuestions,pendingPlans])for(const entry of registry.values())registerInterventionConsumer(entry,"session");\n'+moduleSource+'\nglobalThis.remoteViews=ExternalBotRemoteViews',f.context);
 await gateway.withPolicy('session',async()=>{gateway.active().scope.protectValue('PRIVATE_SOURCE_CANARY','INTERNAL');});
 return{f,api:f.context.remoteViews,state,permissions,qs,plans,runs,run,gateway,journal,runFile};
}
async function request(f,id){if(!(await f.api.read()).connections.length)await f.api.update({op:'upsert',connection:{...f.connection,mode:'control',ownerSenderId:'user_a',ownerConversationId:'room_a',ownerConversationType:'group'},controlConfirmed:true});f.advance(1001);await f.api.accept(f.message({messageId:id,eventId:'event_'+id,text:'/pending'}));return(await f.api.read()).items.at(-1).id;}
module.exports={make,request};
