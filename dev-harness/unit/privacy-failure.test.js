'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..');
const load=()=>import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'ruyi-workbench/app/public/js/privacy-failure.js')).toString('base64'));
test('privacy failures recognize exact stable legacy and structured errors without treating prose as authority',async()=>{
  const {privacyFailure}=await load();
  for(const value of ['privacy.engine_not_supported',new Error('privacy.engine_not_supported'),{errorInfo:{code:'privacy.engine_not_supported'}},new Error(JSON.stringify({error:{code:'privacy.engine_not_supported',params:{secret:'never display'}}}))]){
    const failure=privacyFailure(value);assert.equal(failure.code,'privacy.engine_not_supported');assert.equal(failure.action,'engine');assert.ok(!JSON.stringify(failure).includes('never display'));
  }
  for(const value of ['User wrote privacy.engine_not_supported in a note',' privacy.engine_not_supported','privacy.unknown_future_code',{message:'stack says privacy.policy_unavailable here'},{errorClass:'provider_error',error:'ordinary provider failure'}])assert.equal(privacyFailure(value),null);
  const cyclic={};cyclic.error=cyclic;assert.equal(privacyFailure(cyclic),null);
  assert.equal(privacyFailure({ok:true,message:'privacy.engine_not_supported'}),null);
  assert.equal(privacyFailure(JSON.stringify({ok:true,message:'privacy.policy_unavailable'})),null);
});
test('withheld result receipts retain execution uncertainty and never manufacture a retry action',async()=>{
  const {privacyFailure}=await load();
  const value={errorInfo:{code:'privacy.policy_changed'},receipt:{operationMayHaveExecuted:true,resultUnavailable:true},stack:'private synthetic stack'};
  const failure=privacyFailure(value);assert.equal(failure.mayHaveExecuted,true);assert.equal(failure.resultUnavailable,true);assert.ok(!JSON.stringify(failure).includes('private synthetic'));
  const withheld=privacyFailure({operationMayHaveExecuted:true,resultUnavailable:true});assert.equal(withheld.code,'privacy.tool_result_withheld');assert.equal(withheld.action,'');
});
test('voice known protected or paused state blocks capture while ordinary OFF retains original behavior',async()=>{
  const {privacyVoiceFailure}=await load();assert.equal(privacyVoiceFailure({privacyModeV1:'off'}),null);assert.equal(privacyVoiceFailure(undefined),null);
  for(const mode of ['basic','enhanced','strict'])assert.equal(privacyVoiceFailure({privacyModeV1:mode}).code,'privacy.media_not_supported');
  assert.equal(privacyVoiceFailure({privacyModeV1:'off',privacyPolicyRecoveryRequiredV1:true}).code,'privacy.policy_unavailable');
});
test('cancelled and withheld guidance preserves uncertainty in both locales and mirrored catalogs',async()=>{
  const {privacyFailure}=await load();
  const cancelled=privacyFailure('privacy.execution_cancelled'),withheld=privacyFailure({code:'privacy.tool_result_withheld',operationMayHaveExecuted:true,resultUnavailable:true});
  for(const locale of ['zh-CN','en-US']){
    const catalog=JSON.parse(fs.readFileSync(path.join(root,'ruyi-workbench/app/public/locales',locale+'.json'),'utf8')),mirror=JSON.parse(fs.readFileSync(path.join(root,'docs/i18n/locales',locale+'.json'),'utf8'));
    for(const key of [cancelled.key,withheld.key]){assert.equal(catalog[key],mirror[key]);assert.ok(catalog[key]);}
    assert.ok(!/派发前|before dispatch/i.test(catalog[cancelled.key]));
    assert.match(catalog[cancelled.key],locale==='zh-CN'?/若已开始执行.*检查/:/If execution had started.*check/);
    assert.match(catalog[withheld.key],locale==='zh-CN'?/未向外部返回.*可能已经执行/:/may already have run/);
  }
});
test('actual persisted segment builder keeps only bounded code and uncertainty booleans alongside legacy text',()=>{
  const source=fs.readFileSync(path.join(root,'ruyi-workbench/app/src/02c-turn-segments.js'),'utf8'),context={};vm.runInNewContext(source+'\nthis.builder=createTurnSegmentBuilder();',context);
  context.builder.consume({type:'result',ok:false,error:{code:'privacy.tool_result_withheld',operationMayHaveExecuted:true,resultUnavailable:true,stack:'DO_NOT_PERSIST_STACK',params:{secret:'DO_NOT_PERSIST_PARAMS'}}});
  const segment=context.builder.snapshot()[0];assert.equal(segment.code,'privacy.tool_result_withheld');assert.equal(segment.operationMayHaveExecuted,true);assert.equal(segment.resultUnavailable,true);assert.ok(!JSON.stringify(segment).includes('DO_NOT_PERSIST'));
  context.builder.consume({type:'result',ok:false,error:'ordinary error',code:'x'.repeat(500)});const last=context.builder.snapshot().at(-1);assert.equal(last.code,undefined);assert.equal(last.text,'ordinary error');
});

test('managed and independent MCP failures use exact codes and explicit error receipts only',async()=>{
  const {privacyFailure}=await load();
  const cases=[["privacy.mcp_arguments_changed","mcpChanged"],["privacy.mcp_cancelled","cancelled"],["privacy.mcp_dispatch_changed","mcpChanged"],["privacy.mcp_recipient_changed","mcpChanged"],["privacy.mcp_resource_binary_unsupported","mcpBinary"],["privacy.mcp_resource_changed","mcpChanged"],["privacy.mcp_resource_invalid","mcpInvalid"],["privacy.mcp_resource_limit","mcpLimit"],["privacy.mcp_resource_unavailable","mcpUnavailable"],["privacy.mcp_resource_unsupported","mcpUnsupported"],["privacy.mcp_result_unavailable","withheld"],["privacy.mcp_turn_changed","mcpChanged"],["privacy.server_tools_not_supported","serverTools"],["privacy.tool_channel_not_supported","toolChannel"],["mcp_consumer.unauthorized","consumerGrant"],["mcp_consumer.revoked","consumerGrant"],["mcp_consumer.not_found","consumerGrant"],["mcp_consumer.grant_invalid","consumerGrant"],["mcp_consumer.workspace_invalid","consumerWorkspace"],["mcp_consumer.workspace_changed","consumerWorkspace"],["mcp_consumer.workspace_denied","consumerWorkspace"],["mcp_consumer.connection_invalid","consumerConnection"],["mcp_consumer.configuration_changed","consumerConnection"],["mcp_consumer.cursor_invalid","consumerCursor"],["mcp_consumer.capacity","consumerLimit"],["mcp_consumer.audit_changed","consumerAudit"],["mcp_consumer.audit_busy","consumerAudit"],["mcp_consumer.audit_missing","consumerAudit"],["mcp_consumer.cancelled","cancelled"],["mcp_consumer.message_invalid","consumerRequest"],["mcp_consumer.result_limit","consumerLimit"],["mcp_consumer.body_limit","consumerLimit"],["mcp_consumer.resource_denied","consumerGrant"],["mcp_consumer.method_not_supported","consumerRequest"],["mcp_consumer.tool_denied","consumerGrant"],["mcp_consumer.permission_required","consumerGrant"],["mcp_consumer.private_arguments_denied","reference"],["mcp_consumer.media_not_supported","mcpBinary"],["mcp_consumer.operation_failed","consumerFailed"],["mcp_consumer.lease_exists","consumerConnection"],["mcp_consumer.lease_required","consumerConnection"],["mcp_consumer.setup_required","consumerConnection"],["mcp_consumer.unavailable","consumerConnection"],["mcp_consumer.subscription_pending","consumerSubscription"]];
  for(const [code,key]of cases){const failure=privacyFailure({code});assert.equal(failure.key,'privacy.failure.'+key);assert.equal(failure.action,'');}
  assert.equal(privacyFailure({isError:false,content:[{type:'text',text:'privacy.mcp_turn_changed'}]}),null);
  assert.equal(privacyFailure({isError:true,content:[{type:'text',text:JSON.stringify({ok:false,code:'privacy.mcp_turn_changed'})}]}).key,'privacy.failure.mcpChanged');
  const rpc={jsonrpc:'2.0',id:17,error:{code:-32000,message:'mcp_consumer.unavailable: fixed guidance',data:{operationMayHaveExecuted:true,resultUnavailable:true}}};
  for(const value of [rpc,new Error(JSON.stringify(rpc))]){const receipt=privacyFailure(value);assert.equal(receipt.code,'privacy.tool_result_withheld');assert.equal(receipt.action,'');}
  for(const value of ['mcp_consumer.future_unknown','privacy.mcp_future_unknown','note: mcp_consumer.revoked'])assert.equal(privacyFailure(value),null);
  for(const locale of ['zh-CN','en-US']){const catalog=JSON.parse(fs.readFileSync(path.join(root,'ruyi-workbench/app/public/locales',locale+'.json'),'utf8')),mirror=JSON.parse(fs.readFileSync(path.join(root,'docs/i18n/locales',locale+'.json'),'utf8'));for(const [,key]of cases){assert.ok(catalog['privacy.failure.'+key]);assert.equal(catalog['privacy.failure.'+key],mirror['privacy.failure.'+key]);}}
});
test('pending same-URI subscriptions guide waiting or connection checks without a business retry action',async()=>{
  const {privacyFailure}=await load(),failure=privacyFailure({ok:false,code:'mcp_consumer.subscription_pending'});
  assert.equal(failure.key,'privacy.failure.consumerSubscription');assert.equal(failure.action,'');assert.equal(failure.mayHaveExecuted,false);
  assert.equal(privacyFailure({ok:true,code:'mcp_consumer.subscription_pending'}),null);
  assert.equal(privacyFailure({text:'mcp_consumer.subscription_pending'}),null);
  for(const locale of ['zh-CN','en-US']){const catalog=JSON.parse(fs.readFileSync(path.join(root,'ruyi-workbench/app/public/locales',locale+'.json'),'utf8'));assert.match(catalog[failure.key],locale==='zh-CN'?/等待当前订阅请求结束或检查连接/:/Wait for the current subscription request to finish or check the connection/);assert.match(catalog[failure.key],locale==='zh-CN'?/不要因此重新执行业务操作/:/do not repeat the business operation/);}
});
test('successful MCP and ordinary data cannot manufacture privacy failures or execution uncertainty',async()=>{
  const {privacyFailure}=await load();
  const data={code:'mcp_consumer.revoked',operationMayHaveExecuted:true,resultUnavailable:true};
  const ordinary=[{isError:false,data},{ok:true,data},{data},{data:{data}},{error:{code:-32000,message:'ordinary failure',data}},
    {path:'synthetic.txt',text:JSON.stringify({ok:false,code:'mcp_consumer.revoked'})},
    {message:'mcp_consumer.revoked'}, {text:'privacy.policy_unavailable'},
    {text:JSON.stringify({operationMayHaveExecuted:true,resultUnavailable:true})},
    {ok:true,content:[{type:'text',text:'mcp_consumer.revoked'}],code:'mcp_consumer.revoked',data},
    {jsonrpc:'2.0',id:1,result:{data}},
    {jsonrpc:'2.0',id:1,result:{},error:{code:-32000,message:'malformed mixed envelope',data}},
    {jsonrpc:'2.0',id:1,error:{code:'-32000',message:'invalid error code',data}},
    {jsonrpc:'2.0',id:1,error:{code:-32000,message:'ordinary failure',data:{data}}},
    {jsonrpc:'2.0',id:1,isError:false,error:{code:-32000,message:'ordinary failure',data}},
    {isError:false,code:'mcp_consumer.revoked',operationMayHaveExecuted:true,resultUnavailable:true}];
  for(const value of ordinary)assert.equal(privacyFailure(value),null,JSON.stringify(value));
  for(const value of ordinary.filter(value=>!Object.hasOwn(value,'message')&&!Object.hasOwn(value,'text')))assert.equal(privacyFailure(new Error(JSON.stringify(value))),null);
  const failure=privacyFailure({jsonrpc:'2.0',id:'request',error:{code:-32000,message:'fixed error',data}});
  assert.equal(failure.code,'mcp_consumer.revoked');assert.equal(failure.mayHaveExecuted,true);assert.equal(failure.resultUnavailable,true);
  // Keep exact HTTP codedError and legacy Error.message JSON support.
  for(const value of [new Error('mcp_consumer.workspace_denied'),new Error(JSON.stringify({ok:false,error:{code:'mcp_consumer.workspace_denied'}}))])assert.equal(privacyFailure(value).key,'privacy.failure.consumerWorkspace');
  assert.equal(privacyFailure({type:'error',text:JSON.stringify({code:'privacy.mcp_turn_changed'})}).key,'privacy.failure.mcpChanged');
  assert.equal(privacyFailure({ok:false,code:'privacy.tool_result_withheld',operationMayHaveExecuted:true,resultUnavailable:true}).mayHaveExecuted,true);
});
test('actual tool renderer keeps successful and unflagged business results visible and localizes explicit errors only',async()=>{
  const {privacyFailure}=await load();
  const {createChatRenderPrimitives}=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'ruyi-workbench/app/public/js/chat-render-primitives.js')).toString('base64'));
  let cards=0; const renderer=createChatRenderPrimitives({privacyFailure,privacyFailureCard:()=>{cards++;return {textContent:'localized error'};}});
  const host=()=>({textContent:'',children:[],classList:{add(){},toggle(){}},appendChild(value){this.children.push(value);}});
  const business=[{text:JSON.stringify({ok:false,code:'mcp_consumer.revoked'})},{message:'privacy.policy_unavailable'},
    {code:'mcp_consumer.revoked'},{data:{code:'mcp_consumer.revoked'}},
    {isError:false,code:'mcp_consumer.revoked'},{ok:true,code:'privacy.tool_result_withheld',operationMayHaveExecuted:true,resultUnavailable:true},
    {ok:true,content:[{type:'text',text:'privacy.policy_unavailable'}]}];
  for(const value of business){const pre=host();renderer.renderToolResultInto(pre,'file_read',value);assert.equal(pre.textContent,renderer.safeStringify(value));assert.equal(pre.children.length,0);}
  assert.equal(cards,0);
  for(const value of [{ok:false,code:'mcp_consumer.workspace_denied'}, {isError:true,content:[{type:'text',text:JSON.stringify({code:'privacy.mcp_turn_changed'})}]},
    {operationMayHaveExecuted:true,resultUnavailable:true,code:'privacy.tool_result_withheld'}]){const pre=host();renderer.renderToolResultInto(pre,'file_write',value);assert.equal(pre.children[0].textContent,'localized error');}
  assert.equal(cards,3);
});

const loadPublicModule=name=>import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'ruyi-workbench/app/public/js',name+'.js')).toString('base64'));
test('privacy resource limits give bounded bilingual guidance and preserve execution uncertainty',async()=>{
  const {privacyFailure}=await load();
  const {createChatRenderPrimitives}=await loadPublicModule('chat-render-primitives');
  for(const code of ['learned_scan_limit','structure_limit','text_limit','matches_limit','mapping_limit','aggregate_limit','regex_input_limit','regex_matches_limit']){
    const value={ok:false,code:'privacy.'+code,operationMayHaveExecuted:true,resultUnavailable:true,params:{private:'DO_NOT_SHOW'}};
    const failure=privacyFailure(value);
    assert.equal(failure.key,'privacy.failure.'+(code==='mapping_limit'?'mappingLimit':'scanLimit'));
    assert.equal(failure.action,'');assert.equal(failure.mayHaveExecuted,true);assert.equal(failure.resultUnavailable,true);
    assert.equal(privacyFailure('Provider mentioned privacy.'+code),null);
    assert.equal(privacyFailure({ok:true,code:value.code}),null);
    for(const locale of ['zh-CN','en-US']){
      const catalog=JSON.parse(fs.readFileSync(path.join(root,'ruyi-workbench/app/public/locales',locale+'.json'),'utf8'));
      const mirror=JSON.parse(fs.readFileSync(path.join(root,'docs/i18n/locales',locale+'.json'),'utf8'));
      const guidance=catalog[failure.key];assert.equal(guidance,mirror[failure.key]);
      assert.match(guidance,locale==='zh-CN'?/检查已完成的操作/:/Check completed operations/);
      assert.ok(!/关闭|disable|turn off/i.test(guidance));
      const renderer=createChatRenderPrimitives({privacyFailure,privacyFailureCard:error=>({textContent:catalog[privacyFailure(error).key]})});
      const host={textContent:'',children:[],classList:{add(){}},appendChild(card){this.children.push(card);}};
      renderer.renderToolResultInto(host,'file_read',value);
      assert.equal(host.children[0].textContent,guidance);assert.ok(!JSON.stringify(host.children).includes('DO_NOT_SHOW'));
    }
  }
});
test('API presenter preserves legacy detail priority, stable mappings and raw unknown errors',async()=>{
  const [{createApiErrorPresenter},net,{privacyFailure}]=await Promise.all([loadPublicModule('api-error-i18n'),loadPublicModule('net'),load()]);
  const present=createApiErrorPresenter({t:(key,params)=>({key,params}),apiErrorInfo:net.apiErrorInfo,rawApiErrText:net.apiErrText,privacyFailure});
  const http=(code,message,params)=>new Error(JSON.stringify({error:{code,message,params}}));
  assert.equal(present(http('api.request_failed','Provider is finishing the previous turn.')),'Provider is finishing the previous turn.');
  assert.deepEqual(present(http('request.field_required','field required',{field:'name'})),{key:'error.api.fieldRequired',params:{field:'name'}});
  for(const size of [299,300,301])assert.deepEqual(present(http('api.internal_error','x'.repeat(size))),{key:'error.api.internalErrorDetail',params:{detail:'x'.repeat(Math.min(size,300))+(size>300?'…':'')}});
  assert.deepEqual(present(http('api.internal_error','api.internal_error')),{key:'error.api.internalError',params:{}});
  assert.equal(present(http('future.unknown','Keep this server detail.')),'Keep this server detail.');
  assert.equal(present(new Error('Provider mentioned privacy.engine_not_supported in its explanation.')),'Provider mentioned privacy.engine_not_supported in its explanation.');
});
test('API presenter prioritizes exact privacy envelopes without exposing raw detail or receipt parameters',async()=>{
  const [{createApiErrorPresenter},net,{privacyFailure}]=await Promise.all([loadPublicModule('api-error-i18n'),loadPublicModule('net'),load()]);
  const present=createApiErrorPresenter({t:key=>key,apiErrorInfo:net.apiErrorInfo,rawApiErrText:net.apiErrText,privacyFailure});
  const error=new Error(JSON.stringify({error:{code:'privacy.engine_not_supported',message:'DO_NOT_SHOW_RAW',params:{secret:'DO_NOT_SHOW_SECRET'}}}));
  assert.equal(present(error),'privacy.failure.engine');
  assert.equal(present({errorInfo:{code:'privacy.policy_changed'},operationMayHaveExecuted:true,resultUnavailable:true}),privacyFailure({errorInfo:{code:'privacy.policy_changed'},operationMayHaveExecuted:true,resultUnavailable:true}).key);
  assert.equal(present({error:{code:'mcp_consumer.subscription_pending',message:'DO_NOT_SHOW_RAW'}}),'privacy.failure.consumerSubscription');
});
