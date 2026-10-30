'use strict';
// Pure original helper/form/render VM. No FS mutation, queue/engine/server/
// HTTPS/native/platform key or real timer capability in the evaluated source.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createRunner}=require('./lib/harness'),{functionBlock,constBlock}=require('./lib/source-slice');
const t=createRunner('EXTERNAL BOTS PROGRESS STATIC'),root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'ruyi-workbench/app/src/13w-external-bots.js'),'utf8'),ui=fs.readFileSync(path.join(root,'ruyi-workbench/app/public/js/external-bots.js'),'utf8');
let now=Date.parse('2026-10-30T08:00:00Z');class Clock extends Date{static now(){return now;}}
const context=vm.createContext({Date:Clock,nowIso:()=>new Date(now).toISOString(),makeId:()=> 'notice_1'});
const methods=['externalBotString','externalBotFeedback','externalBotValidFeedback','externalBotStatusCommand','externalBotStatusText','externalBotFeedbackWaiting','externalBotFeedbackDelay'];
const api=vm.runInContext(methods.map(name=>functionBlock(source,name)).join('\n')+'\n({create:externalBotFeedback,valid:externalBotValidFeedback,command:externalBotStatusCommand,text:externalBotStatusText,waiting:externalBotFeedbackWaiting,delay:externalBotFeedbackDelay})',context);
(async()=>{try{
 for(const [input,target,language]of [['进度','','zh'],['查询进度 botmsg_1','botmsg_1','zh'],['/status','','en'],['STATUS item_2','item_2','en'],['/status bad input','!invalid','en']]){const result=api.command(input);assert.equal(result.targetId,target);assert.equal(result.language,language);t.ok(true,'exact read-only status command: '+input);}
 for(const input of ['查询账单','status report please later','progress report','执行所有任务']){if(input==='status report please later')assert.equal(api.command(input).targetId,'!invalid');else assert.equal(api.command(input),null);}t.ok(true,'normal message text remains normal; malformed explicit status commands do not become business requests');
 const item={id:'item_1',platform:'qq',connectionId:'a',conversationId:'room',control:{appId:'app'},receivedAt:new Date(now).toISOString(),execution:{status:'unknown'},delivery:{status:'pending'}};
 item.feedback=api.create(item,{sentAt:new Date(now+600000).toISOString()},true);assert.equal(item.feedback.sentAt,item.receivedAt);assert.equal(item.feedback.finalSeq,2);assert.equal(api.valid(item),true);t.ok(true,'future wire timestamp cannot extend passive window; progress reserves subsequent final sequence');
 now+=299999;assert.equal(api.waiting(item,'progress'),'ready');now++;assert.equal(api.waiting(item,'progress'),'window_closed');assert.equal(api.waiting(item,'delivery'),'window_closed');t.ok(true,'QQ direct/group conservative5min intersection closes exactly at boundary');
 for(const patch of [{finalSeq:1},{reservations:[{attemptId:undefined,at:new Date(now).toISOString()}]},{sentAt:'broken'},{queryId:'query',progress:item.feedback.progress}]){const changed={...item,feedback:{...item.feedback,...patch}};assert.equal(api.valid(changed),false);}t.ok(true,'corrupt sequence/attempt/timestamp or progress-query mixture is refused by durable validator');
 const connection={id:'a',appId:'app',platform:'qq'},state={connections:[connection],items:[]};
 for(let i=0;i<6;i++)state.items.push({...item,feedback:{...item.feedback,progress:null,finalSeq:1,reservations:[{attemptId:'a'+i,at:new Date(now).toISOString()}]}});
 assert.equal(api.delay(state,item),now+60000);t.ok(true,'actual product budget aggregates durable chat reservations rather than trusting in-memory sending counts');
 state.connections=[];assert.equal(api.delay(state,item),now+60000);t.ok(true,'deleting/replacing a live connection cannot discard original app budget reservations');
 for(const lang of ['zh','en']){const text=api.text(item,lang);assert.match(text,lang==='zh'?/未确认/:/unconfirmed/);assert.equal(text.includes('replyText'),false);assert.equal(text.includes('completed'),false);}t.ok(true,'unknown status stays unconfirmed; query emits fixed metadata language rather than original task body or guessed success');
 const nodes=new Map(),labels=[];const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false,hidden:false,label:{hidden:false},closest(){return this.label;},focus(){}});return nodes.get(id);};
 const catalogs=['zh-CN','en-US'].map(lang=>JSON.parse(fs.readFileSync(path.join(root,'ruyi-workbench/app/public/locales',lang+'.json'),'utf8')));
 const u=vm.createContext({active:true,isVisible:()=>true,writeOwner:null,byId:node,globalThis:{crypto:{randomUUID:()=> 'synthetic'}},say:(...args)=>labels.push(args),mutate:body=>body,
  t:key=>catalogs[0][key],el:(_tag,_class,text)=>({text}),strings:value=>Array.isArray(value)&&value.every(id=>typeof id==='string'&&id.length>0)});
 const defs=['ENV_NAME','FIELDS','ENV_FIELDS','IDS'].map(name=>constBlock(ui,name)).join('\n')+'\n'+['connectionPayload','validExternalFeedback','edit','platformFields','modeFields','save','renderFeedback'].map(name=>functionBlock(ui,name)).join('\n');
 const form=vm.runInContext(defs+'\n({edit,save,render:renderFeedback,valid:validExternalFeedback,payload:connectionPayload})',u);
 const row={id:'bot_a',platform:'qq',appId:'app',label:'Test',mode:'control',ownerSenderId:'person',ownerConversationId:'room',ownerConversationType:'group',allowedSenderIds:['person'],allowedConversationIds:['room'],enabled:true,progressUpdates:true};
 form.edit(row);assert.equal(node('cfgStewardBotProgress').checked,true);assert.equal(form.save().connection.progressUpdates,true);node('cfgStewardBotProgress').checked=false;assert.equal(form.save().connection.progressUpdates,false);t.ok(true,'real edit/save functions preserve and explicitly clear the progress checkbox; old form ownership remains');
 node('cfgStewardBotMode').value='inbox';node('cfgStewardBotProgress').checked=true;assert.equal(form.save().connection.progressUpdates,false);assert.equal(form.payload(row).progressUpdates,true);t.ok(true,'inbox form cannot silently enable remote progress; existing connection toggle payload preserves selected setting');
 const displayed=[];form.render({id:'item_1',feedback:{queryId:'',progress:{status:'unknown'},progressWaiting:'window_closed',replyWaiting:'throttled'}},{appendChild:v=>displayed.push(v.text)});assert.equal(displayed.some(v=>v===undefined),false);assert.ok(displayed.some(v=>v.includes('本地')));assert.ok(displayed.some(v=>v.includes(catalogs[0]['externalBots.delivery.unknown'])));t.ok(true,'real renderer explains local saved/window/rate/unknown separately from accepted and executed facts');
 assert.equal(form.valid({queryId:'',progress:null,progressWaiting:'ready',replyWaiting:'window_closed'}),true);assert.equal(form.valid({queryId:'',progress:{status:'success'},progressWaiting:'ready',replyWaiting:''}),false);t.ok(true,'public feedback validator rejects invented success states');
 for(let i=0;i<2;i++){const lang=i?'en-US':'zh-CN',mirror=JSON.parse(fs.readFileSync(path.join(root,'docs/i18n/locales',lang+'.json'),'utf8'));for(const key of Object.keys(catalogs[i]).filter(k=>/^externalBots\.(progress|feedback)/.test(k)))assert.equal(catalogs[i][key],mirror[key]);}t.ok(true,'new natural status/help labels exist in both product and documentation catalogs for both languages');
 const history=require('./lib/external-bots-source-history'),crypto=require('node:crypto');const old=require('./fixtures/external-bots-cancel/history.json');
 for(const version of ['v1','v2','v3']){const actual=history.historicalSource(version),expected=version==='v3'?old.v3Sha256:old[version].sha256;assert.equal(crypto.createHash('sha256').update(actual).digest('hex'),expected);}
 assert.equal(crypto.createHash('sha256').update(history.retryCoreSource()).digest('hex'),history.replyRetryContracts.product.coreSha256);
 t.ok(true,'exact B2 inverse layer preserves original historical v1/v2/v3 and retry-core source hashes and assertions');
 const wakeHistory=require('./fixtures/external-bots-progress/deferred-wake-history.json');
 assert.equal(crypto.createHash('sha256').update(source).digest('hex'),wakeHistory.sha256);
 for(const corrupt of [source+'\n// unrelated source drift',source.replace(wakeHistory.inverseSpans[0].before,''),source.replace(wakeHistory.inverseSpans[1].before,wakeHistory.inverseSpans[1].before+'\n// changed wake')])assert.throws(()=>history.replyRetrySourceV2(corrupt),assert.AssertionError);
 const savedSpan=wakeHistory.inverseSpans[0].before;try{wakeHistory.inverseSpans[0].before+='\n// tampered fixture span';assert.throws(()=>history.replyRetrySourceV2(source),assert.AssertionError);}finally{wakeHistory.inverseSpans[0].before=savedSpan;}
 t.ok(true,'finite deferred-wake inverse accepts only its complete new source and rejects unrelated drift, missing/changed wake and tampered fixture span');
 const capState={schema:6,connections:[],items:[{text:'x'.repeat(40),details:{a:'b',c:'d',e:'f'}}]},compact=Buffer.byteLength(JSON.stringify(capState)),pretty=Buffer.byteLength(JSON.stringify(capState,null,2));assert.ok(pretty>compact);
 let writes=0;const capContext=vm.createContext({Buffer,EXTERNAL_BOT_LIMITS:{stateBytes:compact},externalBotUpgradeFeedbackState:()=>{},externalBotError:(code,status)=>Object.assign(Error(code),{code,statusCode:status}),externalBotStore:{write:()=>{writes++;}},state:capState});
 const writing=vm.runInContext(functionBlock(source,'externalBotWriteState')+'\nexternalBotWriteState(state)',capContext);
 await assert.rejects(writing,error=>error.code==='external_channel.inbox_full'&&error.statusCode===503);assert.equal(writes,0);
 t.ok(true,'payload6 preflights actual pretty-byte legacy read capacity before any store write; numeric boundary supplied only to pure helper');
}catch(error){t.fail(error.stack||String(error));}finally{t.done({exit:true});}})();
