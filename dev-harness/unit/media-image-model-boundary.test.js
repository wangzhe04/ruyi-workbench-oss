'use strict';
// Pure model boundary tests; fake in-memory file/mapping owner and fetch recorder.
// This does not launch a provider/server, regex worker, Python or native helper.
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../../ruyi-workbench/app/src');
const source=['01i-privacy-rules.js','01h-privacy-core.js','03a-privacy-gateway.js','04h-provider-http.js'].map(name=>fs.readFileSync(path.join(root,name),'utf8')).join('\n');
function fixture(){
  const calls=[],events=[],hooks={};let finalValid=true;
  const fileApi={lstat:async()=>{throw Object.assign(Error('absent'),{code:'ENOENT'});},mkdir:async()=>{}};
  const sandbox={require:name=>name==='fs/promises'||name==='node:fs/promises'?fileApi:require(name),Buffer,URL,structuredClone,setImmediate,AbortSignal,
    MediaImageHooks:hooks,PrivacyRegex:{scan:async()=>{throw Error('regex worker forbidden in pure model');}},fetch:(url,options)=>{events.push('fetch');calls.push({url,options});return Promise.resolve({ok:true});}};
  const api=vm.runInNewContext(source+';PrivacyCore.configHooks.sealLocal=async value=>value;PrivacyCore.configHooks.openLocal=async value=>value;PrivacyGateway.setHost({data:"C:/synthetic-media-mappings",makeStore:()=>({read:async()=>({}),write:async()=>{}})});({gateway:PrivacyGateway,post:providerModelPostOnce,hooks:ProviderMediaHooks});',sandbox);
  return {...api,calls,events,setValid:value=>{finalValid=value;},isValid:()=>finalValid};
}
const config={privacyModeV1:'enhanced',privacyRulesV1:[],providers:[]};
const media='https://ruyi.invalid/protected-image/'+'a'.repeat(32);
test('Gateway still rejects raw data URLs and unowned references when protection is ON',async()=>{
  const f=fixture();f.gateway.configure(config);
  await f.gateway.run('s1',config,async()=>{
    for(const url of ['data:image/png;base64,YQ==',media])await assert.rejects(f.gateway.beforeModelRequest({messages:[{role:'user',content:[{type:'image_url',image_url:{url}}]}]}),error=>error.code==='privacy.media_not_supported');
  });
});
test('a registered host projector preserves only the owned media block and still protects neighboring text',async()=>{
  const f=fixture();f.gateway.configure(config);f.gateway.setHost({projectMediaPart:(part,detail)=>part?.type==='image_url'&&part.image_url.url===media&&detail.scopeId==='s1'?structuredClone(part):null});
  await f.gateway.run('s1',config,async()=>{
    const body={messages:[{role:'user',content:[{type:'text',text:'private@example.test'},{type:'image_url',image_url:{url:media}}]}]};
    const prepared=await f.gateway.beforeModelRequest(body),encoded=JSON.stringify(prepared);
    assert.equal(encoded.includes('private@example.test'),false);assert.equal(encoded.includes(media),true);
    assert.equal(body.messages[0].content[0].text,'private@example.test');
  });
});
test('typed JSON Pointer rules still run before host image projection',async()=>{
  const f=fixture(),policy={...config,privacyRulesV1:[{id:'image-slot',kind:'field',value:'/messages/1/content/0',category:'INTERNAL'}]};
  f.gateway.configure(policy);f.gateway.setHost({projectMediaPart:part=>part?.type==='image_url'?part:null});
  await f.gateway.run('s1',policy,async()=>{await assert.rejects(f.gateway.beforeModelRequest({messages:[{role:'user',content:[{type:'image_url',image_url:{url:media}}]}]}),error=>error.code==='privacy.typed_sensitive');});
});
test('final model POST revalidates media after the last await and encoding before any fetch',async()=>{
  const f=fixture();f.gateway.configure({privacyModeV1:'off'});
  f.hooks.beforeModelPost=async({body})=>{f.events.push('borrow');await Promise.resolve();return {body,assert(){f.events.push('assert');if(!f.isValid())throw Object.assign(Error('changed'),{code:'privacy.image_source_changed'});},release(){f.events.push('release');}};};f.setValid(false);
  await assert.rejects(f.post({url:'http://localhost/v1/chat/completions',headers:{},body:{messages:[{role:'user',content:'public'}]}}),error=>error.code==='privacy.image_source_changed');
  assert.equal(f.calls.length,0);assert.deepEqual(f.events,['borrow','assert','release']);
});
test('successful final commit has no asynchronous gap between authority assertion and fetch invocation',async()=>{
  const f=fixture();f.gateway.configure({privacyModeV1:'off'});
  f.hooks.beforeModelPost=async({body})=>({body,assert(){f.events.push('assert');},release(){f.events.push('release');}});
  await f.post({url:'http://localhost/v1/chat/completions',headers:{},body:{messages:[{role:'user',content:'public'}]}});
  assert.deepEqual(f.events,['assert','fetch','release']);assert.equal(f.calls.length,1);
});
test('captured image policy rejects configuration and scope replacement, and never grants OFF or unknown mode',async()=>{
  const f=fixture();f.gateway.configure(config);let policy;
  await f.gateway.run('s1',config,async()=>{policy=f.gateway.captureMediaPolicy();assert.equal(policy.assert(),true);});
  await f.gateway.run('s2',config,async()=>{assert.throws(()=>policy.assert(),error=>error.code==='privacy.scope_changed');});
  f.gateway.configure({...config,privacyTechnicalV1:true});await f.gateway.run('s1',{...config,privacyTechnicalV1:true},async()=>{assert.throws(()=>policy.assert(),error=>error.code==='privacy.policy_changed');});
  f.gateway.configure({privacyModeV1:'off'});assert.equal(f.gateway.captureMediaPolicy(),null);
  f.gateway.configure({privacyModeV1:'future'});assert.throws(()=>f.gateway.captureMediaPolicy(),error=>error.code==='privacy.policy_unavailable');
});
