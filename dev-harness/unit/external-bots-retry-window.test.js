'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto'),{pathToFileURL}=require('node:url');
const repo=p.resolve(__dirname,'../..'),{functionBlock,constBlock}=require('../lib/source-slice');
const {replyRetryContracts,replyRetrySourceV2,historicalSource,retryCoreSource}=require('../lib/external-bots-source-history');
const source=fs.readFileSync(p.join(repo,'ruyi-workbench/app/src/13w-external-bots.js'),'utf8');
test('central read hint is the exact original synchronous precommit gate over 5280 live status combinations',()=>{
 const span=replyRetryContracts.hint.spans.find(row=>row.after==='  if (!externalBotReplyRetryWindow(item))');
 a.ok(span,'the frozen pre-hint gate must be available as exact source evidence');
 const old=span.before.trim().slice(4,-1),context=vm.createContext({externalBotUnsettled:new Map(),externalBotDeliveries:new Map()});
 vm.runInContext(constBlock(source,'EXTERNAL_BOT_REPLY_RETRY_ERRORS')+'\n'+functionBlock(source,'externalBotReplyRetryWindow')+'\nfunction original(item){return !('+old+');}globalThis.api={window:externalBotReplyRetryWindow,original,errors:EXTERNAL_BOT_REPLY_RETRY_ERRORS};',context);
 let count=0;for(const execution of ['queued','running','completed','failed','unknown'])for(const delivery of ['pending','sending','sent','failed','unknown','cancelled'])for(const errorCode of [...context.api.errors,'external_delivery.rate_limited','external_delivery.rejected','external_channel.delivery_unknown'])for(const live of [false,true])for(const unsettled of [false,true])for(const messageId of ['', 'already_sent'])for(const updatedAt of ['2026-10-26T00:00:00Z','invalid']){
 const item={id:'one',control:{},execution:{status:execution},delivery:{status:delivery,errorCode,messageId,updatedAt}};context.externalBotDeliveries.clear();context.externalBotUnsettled.clear();if(live)context.externalBotDeliveries.set('one',{});if(unsettled)context.externalBotUnsettled.set('one',{});
 a.equal(context.api.window(item),Boolean(context.api.original(item)));count++;}
 a.equal(count,5280);a.equal(context.api.window({control:null}),false);
});
test('UI hint, async owner authorization and source identity are separate and V2 inverse is exact',()=>{
 const inverse=replyRetrySourceV2(source);
 a.equal(c.createHash('sha256').update(inverse).digest('hex'),'36dafa162e277baea75f82e7faf4d2d37ebb31ff022090000788cb68b993e3c6');
 a.equal(functionBlock(source,'externalBotOwnerMatches'),functionBlock(inverse,'externalBotOwnerMatches'));
 a.ok(functionBlock(source,'externalBotRetryReply').includes("if (!await externalBotOwnerMatches("));a.ok(functionBlock(source,'externalBotPublicItem').includes("if (externalBotReplyRetryWindow(item)) out.retryAvailable = true;"));
});
test('v5 hint history strips exactly to V2 then c82 and keeps every earlier source SHA',()=>{
 const history=require('../fixtures/external-bots-cancel/history.json');
 for(const [name,expected]of [['v3',history.v3Sha256],['v2',history.v2.sha256],['v1',history.v1.sha256]])a.equal(c.createHash('sha256').update(historicalSource(name)).digest('hex'),expected);
 a.equal(c.createHash('sha256').update(replyRetrySourceV2(source)).digest('hex'),history.v4.sha256);a.equal(c.createHash('sha256').update(retryCoreSource(source)).digest('hex'),replyRetryContracts.product.coreSha256);
});
test('state validator rejects raw non-string identity and never creates a request from invalid history',async()=>{
 const m=await import(pathToFileURL(p.join(repo,'ruyi-workbench/app/public/js/external-bot-retry-state.js')).href);
 const state=m.createReplyRetryState({store:new Map()}),row={id:'bad',delivery:{status:'pending',attemptId:'next'},replyHistory:[{attempt:{status:'failed',attemptId:undefined,errorCode:'',messageId:'',updatedAt:'2026-10-26T00:00:00Z'},nextAttemptId:'next',retryRequestId:'existing_request_0001',requestedAt:'2026-10-26T00:00:00Z'}]};
 a.equal(m.validReplyRetryHistory(row),false);a.equal(state.available(row),null);a.equal(state.begin(row),null);a.equal(state.snapshot().length,0);
});
