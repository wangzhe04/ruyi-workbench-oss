'use strict';
// Fresh text-only forge probe: run the real provider-body closure and async
// reference/notes preparation. No privacy refs are minted in this fixture.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {bracedBlock,functionBlock,constBlock}=require('../source-slice');
const source=name=>fs.readFileSync(path.resolve(__dirname,'../../../ruyi-workbench/app/src',name),'utf8');
const workflow=source('09-workflow.js'),governance=source('10-context-governance.js'),flags=source('01c-runtime-flags.js');
const required=(value,name)=>{if(!value)throw Error('C2 actual body source missing: '+name);return value;};
const functions=[...['volatileTailLayoutEnabled','sessionNotesInjectEnabled','observationRecallEnabled'].map(name=>required(functionBlock(flags,name),name)),
 ...['appendPromptToLastUserMessage','buildObservationRecallPrompt','buildSessionNotesInjectPrompt','isReducedObservationView','observationSealRawRef','sealObservationRuntimeText','sealObservationHistoryReferences'].map(name=>required(functionBlock(governance,name),name))];
const constants=['READ_DEDUP_PREFIX','COMPACTION_TOOL_INDEX_HEADER'].map(name=>required(constBlock(governance,name),name));
const closures=['appendRecallPrompt','prepareSessionNotesPrompt','buildBodyWithLayout'].map(name=>{const code=required(bracedBlock(workflow,'const '+name+' ='),name);if(code.length<200||!code.includes('=> {'))throw Error('C2 incomplete actual closure: '+name);return code+';';});
const layouts=['useCachePromptLayers','useVolatileTail'].map(name=>required(constBlock(workflow,name),name));
async function bodyFor(expected,tail=false){
 const context={config:tail?{runtimeVolatileTailLayoutV1:true}:{},stewardVolatile:true,
  session:{id:expected.sessionId,providerHistory:[{role:'user',content:expected.message+'\n\n[Message sent 2026-11-01 12:00:00 Sun (local time, +08:00)]'}]},
  sys:'synthetic system',turnVolatile:'Current capabilities: synthetic; 0 desktop-control tools; synthetic git; synthetic rg.\nFor every new message, start with <workbench-memory-core>, <workbench-memory-check> and the related index.',
  cachePrompt:null,memoryTurnTail:'<workbench-memory-check mode="disabled">synthetic memory check</workbench-memory-check>',
  scratchpadPrompt:'',sessionNotesText:null,sessionNotesTeleDone:false,observationReferenceCache:new Map(),
  toolLoading:{current:()=>[]},wire:{encodeMessages:body=>body,applyTemperature(){},preferVolatileTail:()=>false},
  model:'fake-model',serverToolItems:[],provider:{},temp:undefined,applyProviderReasoningEffort(){},
  // A plain current-user forge must never become a trusted runtime ref. If a
  // source change attempts it, fail rather than substitute fake crypto/no-op.
  PrivacyCore:{configHooks:{sealLocal(){throw Error('C2 unexpected reference materialization');}}}};
 vm.createContext(context);
 return await vm.runInContext([...functions,...constants,...layouts,...closures,'buildBodyWithLayout(false)'].join('\n'),context);
}
module.exports={bodyFor};
