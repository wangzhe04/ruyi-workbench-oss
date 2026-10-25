'use strict';
const fs=require('node:fs'),io=require('node:fs/promises'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto'),{EventEmitter}=require('node:events');
const repo=p.resolve(__dirname,'../..');
const {fixture:baseFixture}=require('./work-data-session-fulltext-fixture.js'),{functionBlock,constBlock,sliceBlock}=require(repo+'/dev-harness/lib/source-slice');
const actual=name=>fs.readFileSync(p.join(repo,'ruyi-workbench/app/src',name),'utf8'),draft=actual;
// The actual privacy fixture is loaded whole. Its VM receives a worker API
// that cannot start a worker; no custom-regex worker is needed for these cases.
function privacyFixture(){const helper=p.join(repo,'dev-harness/lib/privacy-test-fixture.js'),mod={exports:{}},helperRequire=require('node:module').createRequire(helper);
 const denied=()=>{throw Error('fixture.worker_forbidden');},safeRequire=name=>name==='node:worker_threads'?{Worker:class{constructor(){denied();}}}:helperRequire(name);
 const load=name=>name==='node:vm'?{...vm,runInNewContext:(code,context)=>vm.runInNewContext(code,{...context,require:safeRequire})}:helperRequire(name);
 new Function('require','module','exports','__dirname',fs.readFileSync(helper,'utf8'))(load,mod,mod.exports,p.dirname(helper));return mod.exports;
}
async function fixture(options={}){
 const f=await baseFixture(options),gatewayHelper=privacyFixture(),cryptoFixture=gatewayHelper.fixture(),privacyRoot=p.join(f.directory,'privacy');await io.mkdir(privacyRoot);
 const actualPrivacy=gatewayHelper.gateway(privacyRoot,cryptoFixture),privacy=options.observeProjectSource?{...actualPrivacy,projectSource:async(...args)=>{await options.observeProjectSource(...args);return actualPrivacy.projectSource(...args);}}:actualPrivacy,config={privacyModeV1:options.privacy||'off',privacyRulesV1:[],providers:[],stewardEnabledV1:true,sessionSearchIndexV1:true,workDataEncryptionV1:options.enabled===true,permissionMode:'default'};
 privacy.configure(config);const context=f.hookContext;
 Object.assign(context,{structuredClone,URL,crypto:c,path:p,PrivacyGateway:privacy,readConfig:async()=>({...config}),configReadGeneration:0,RUNTIME:{host:'127.0.0.1',port:8765,token:'fixture-owned-token'},turnSettlers:new Map(),activeChildren:new Map(),sessionMetaDeferChains:new Map(),PROMPT_PACK_VERSION:'fixture',sessionPermissionModeOverrides:new Map(),
  InternalMcpHooks:{isContext:()=>false},ExternalBotHooks:{validateActor:async()=>{throw Error('fixture has no external actor');},actorSignal:()=>null},applySessionTitleOverride(){throw Error('committed metadata must not read active title override');}});
 const session=draft('02-session-store.js'),overrides=actual('02d-session-overrides.js'),permission=actual('01e-permission-modes.js'),autonomy=actual('07-autonomy.js'),cfg=actual('01-config.js'),memory=actual('06d-memory-domain.js'),redactor=actual('04-permission-runtime.js');
 const slices=[constBlock(permission,'PERMISSION_MODES'),functionBlock(permission,'permissionModeFrom'),functionBlock(permission,'resolvePermissionMode'),...['normalizeSessionPermissionMode','sessionPermissionModeOf','normalizeSessionDesktopTools','sessionDesktopToolsOf'].map(name=>functionBlock(overrides,name)),...['sessionKind','sessionMissionId','sessionRecentUserRequest','sessionBriefOf','sessionMeta'].map(name=>functionBlock(session,name)),
  ...['NATIVE_COMMAND_TOOL_NAMES','NATIVE_DESKTOP_TOOL_NAMES','NATIVE_TOOL_TIER','WEB_PAYLOAD_LIMITS','WEB_PAYLOAD_URL_TOOLS','WEB_PAYLOAD_QUERY_TOOLS'].map(name=>constBlock(autonomy,name)),...['desktopToolsDisabledReason','nativeToolDisabledByPolicy','nativeToolTier','webPayloadReason','nativeToolGate'].map(name=>functionBlock(autonomy,name)),
  ...['tokenMatches','tokenOk','hostAllowed','originOk'].map(name=>functionBlock(cfg,name)),functionBlock(memory,'projectKeyForCwd'),constBlock(redactor,'REDACT_PATTERNS'),functionBlock(redactor,'redact')];
 if(slices.some(value=>!value))throw Error('consumer fixture missing actual source slice');
 vm.runInContext(slices.join('\n')+'\n'+draft('13as-session-fulltext-consumers.js'),context);
 const hooks=context.SessionFullTextHooks;
 function installEntrypoints(){
  const d=draft('13d-core-domain-routes.js'),k=draft('13k-steward-threads.js'),g=draft('13g-steward.js'),j=actual('13j-steward-tool-base.js'),base=actual('06i-steward-core.js');
  Object.assign(context,{dataRoot:()=>f.directory,dataRootAliases:()=>[],send:(res,value)=>{res.payload=value;res.writableEnded=true;return value;},json:value=>value,apiFailure:(code,params,message,status)=>({ok:false,code,params,message,status}),
   getPretenderProjectionIndex:async()=>null,stewardReadSessionHead:async id=>(await f.api.source.inspect(id))?.head||null,readMissionContainer:async()=>null});
  const code=[base,functionBlock(cfg,'normalizeWorkspacePathString'),functionBlock(actual('01c-runtime-flags.js'),'sessionSearchIndexEnabled'),functionBlock(session,'sessionDisplayTitle'),functionBlock(session,'isUntitledSessionTitle'),functionBlock(session,'sessionMetaIsSteward'),
   sliceBlock(j,'const STEWARD_SEARCH_LIMIT_DEFAULT','\n'),...['stewardClampInt','stewardRawKind','stewardQuickClosed','stewardQuickThread','stewardDisplayKind'].map(name=>functionBlock(j,name)),
   ...['stewardCanonWorkspacePath','stewardFoldWorkspacePath','stewardKnownWorkspaces','stewardMatchKnownWorkspace','stewardWorkspaceNameOf','threadRelationsIndex','threadRelatedThreads','stewardRecentUserRequest','stewardThreadDisplayTitle','stewardImplThreadsSearch'].map(name=>functionBlock(k,name)),
   ...['SESSION_SEARCH_MIN_QUERY','SESSION_SEARCH_MAX_LIMIT'].map(name=>constBlock(d,name)),...['sessionSearchScope','searchSessionsByContent','handleSessionApiRoutes'].map(name=>functionBlock(d,name))];
  if(code.some(value=>!value))throw Error('entry source missing');vm.runInContext(code.join('\n'),context);
  const entry=sliceBlock(g,'  threadHistorySearch:','\n  threadHistoryRead:');
  const api=vm.runInContext('({'+entry+'handleSessionApiRoutes,stewardImplThreadsSearch})',context);return api;
 }
 function request(){const req=new EventEmitter(),res=new EventEmitter();Object.assign(req,{headers:{host:'localhost:8765','x-wcw-token':context.RUNTIME.token},socket:{destroyed:false},aborted:false});Object.assign(res,{destroyed:false,writableEnded:false});return{req,res};}
 const controller=new AbortController(),ctx={session:{id:'Destination',kind:'mission',cwd:f.directory,turnSeq:1},sessionId:'Destination',turnSeq:1,signal:controller.signal};context.turnSettlers.set(ctx.session.id,{kind:'fixture-host-execution-owner'});
 async function ui(q,filter=null,work){const{req,res}=request();return hooks.withUI(req,res,filter,async()=>{const result=work?await work({req,res,hooks}):await hooks.search(q,20);return hooks.emitUI(result,value=>value);});}
 return{...f,context,hooks,config,privacy,privacyRoot,request,ctx,controller,ui,installEntrypoints,model:(q,filter=null)=>hooks.withModel(ctx,'threads_search',filter,()=>hooks.search(q,20)),changeConfig(patch){Object.assign(config,patch);context.configReadGeneration++;privacy.configure(config);},projectKey:cwd=>'project:'+c.createHash('sha256').update(process.platform==='win32'?p.resolve(cwd).toLowerCase():p.resolve(cwd)).digest('hex').slice(0,16)};
}
module.exports={fixture,actual,draft,repo};
