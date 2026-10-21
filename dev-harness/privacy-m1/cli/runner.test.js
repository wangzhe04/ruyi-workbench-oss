'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {safeRemove,childEnvironment,brokerReply,summarizeProbe,redactEvidence}=require('./run');

test('environment allowlist does not inherit model keys, proxy, node injection, or user HOME',()=>{
  const names=['ANTHROPIC_API_KEY','KIMI_API_KEY','HTTP_PROXY','NODE_OPTIONS','HOME'];
  const previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  try {
    names.forEach(k=>process.env[k]='SYNTHETIC_SHOULD_NOT_INHERIT');
    const env=childEnvironment('OWNED_WRITE','OWNED_PROGRAM');
    for(const key of names.filter(k=>k!=='HOME')) assert.equal(env[key],undefined);
    for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP']) assert.equal(env[key],'OWNED_WRITE');
  } finally { for(const key of names) { if(previous[key]===undefined) delete process.env[key]; else process.env[key]=previous[key]; } }
});
test('broker has exactly one fixed synthetic response and denies arbitrary command/path requests',()=>{
  assert.equal(brokerReply({kind:'rpc',operation:'read-project-model'}),'MODEL_VIEW:[PRIVATE_M1]\n');
  for(const req of [null,{}, {kind:'rpc',operation:'exec',command:'whoami'}, {kind:'rpc',operation:'read-file',path:'C:\\secret'}, {kind:'other',operation:'read-project-model'}]) assert.equal(brokerReply(req),'DENIED\n');
});
test('empty, crashed and missing-child evidence never proves tested boundaries',()=>{
  const summary=summarizeProbe({code:1,output:[],receivers:[]});
  assert.equal(summary.processCompleted,false); assert.equal(summary.fileBoundaryObserved,false);
  assert.equal(summary.networkDeliveryBlockedAtTestedReceivers,false); assert.equal(summary.fixtureBrokerRoundTrip,false);
  const names=['loopback-tcp4','loopback-tcp6','private-gateway','loopback-udp4','loopback-udp6','dns-owned-receiver'];
  const probe={code:0,output:names.map(name=>({kind:'network',name,descendant:false,allowed:false})),receivers:names.map(id=>({id,positiveControlConnections:1,unauthorizedConnections:0}))};
  assert.equal(summarizeProbe(probe).networkDeliveryBlockedAtTestedReceivers,false);
  probe.output.push(...names.map(name=>({kind:'network',name,descendant:true,allowed:null})));
  assert.equal(summarizeProbe(probe).networkDeliveryBlockedAtTestedReceivers,true);
  probe.receivers[0].unauthorizedConnections=1;
  assert.equal(summarizeProbe(probe).networkDeliveryBlockedAtTestedReceivers,false);
  probe.output.push({kind:'file',name:'outside-all-app-packages-read',allowed:true,descendant:true});
  assert.equal(summarizeProbe(probe).allApplicationPackagesOutsideFileReadable,true);
  assert.equal(summarizeProbe(probe).projectionIsExclusiveFilesystemAllowlist,false);
});
test('cleanup refuses workspace/temp roots and removes only owned temporary tree',()=>{
  assert.throws(()=>safeRemove(os.tmpdir()),/outside owned/); assert.throws(()=>safeRemove(__dirname),/outside owned/);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-m1-cli-unit-')); fs.writeFileSync(path.join(root,'owned'),'synthetic');
  safeRemove(root); assert.equal(fs.existsSync(root),false);
});
test('all nested evidence values and keys, including escaped JSON, redact temporary and user paths',()=>{
  const root='C:\\Users\\SYNTHETIC_USER\\Temp\\ruyi-m1-cli-own',home='C:\\Users\\SYNTHETIC_USER';
  const source={output:[{path:root+'\\file',home:home+'/mixed'}],events:[{[home]:root.replaceAll('\\','/')}],stdout:JSON.stringify({path:root,home})};
  const clean=redactEvidence(source,root,home),encoded=JSON.stringify(clean);
  assert.equal(encoded.includes('SYNTHETIC_USER'),false);assert.equal(clean.output[0].path,'<temporary-root>\\file');assert.match(clean.stdout,/<user-home>/);
});
