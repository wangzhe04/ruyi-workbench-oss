'use strict';
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=p.resolve(__dirname,'../../ruyi-workbench/app/src');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function deferred(){let resolve,entered;const wait=new Promise(r=>resolve=r),ready=new Promise(r=>entered=r);return{wait,ready,resolve,entered};}
function fixture(boundary,{deleted=false,recreated=false,maintenanceRefuses=false,closeFails=false}={}){
  const wait=deferred();let opens=0,closes=0,reads=0,starts=0,processorCreates=0,managedCalls=0,current='sess_A',capturedPolicy;
  const checkpoints=[];async function checkpoint(name){checkpoints.push(name);if(name===boundary){wait.entered();await wait.wait;}}
  const config={privacyModeV1:'on',workDataEncryptionV1:false},policyConfig={personal:true,rules:[]};
  const policy={config:policyConfig,hash:sha(JSON.stringify(policyConfig)),rulesHash:sha('rules'),revision:'p1',assert:()=>true};
  const sourceBytes=Buffer.alloc(32,7),stat={dev:1n,ino:2n,size:32n,mtimeNs:3n,ctimeNs:4n,nlink:1n,isFile:()=>true,isDirectory:()=>false,isSymbolicLink:()=>false};
  const directory={isDirectory:()=>true,isSymbolicLink:()=>false};
  const processorSnapshot={hash:sha('processor'),version:'v1'};
  const processor={capture:()=>processorSnapshot,assert:()=>true,start(request){starts++;return{promise:Promise.resolve({rgba:Buffer.alloc(12*12*4,255),width:12,height:12,sourceHash:request.sourceHash,processorHash:processorSnapshot.hash,
    frames:1,orientationApplied:true,ocrComplete:true,codesComplete:true,transform:{width:12,height:12,orientation:1},words:[{text:'person@example.test',line:0,box:[1,1,5,5]}],codes:[]}),finish:()=>({closed:true,helperMayStillRun:false,ownershipRetained:false})};}};
  const hooks={},privacy={active:()=>({scopeId:current}),run:(id,conf,work)=>{current=id;return work();},captureMediaPolicy:()=>policy,setHost:value=>capturedPolicy=value};
  const sandbox={require,Buffer,Headers,setTimeout,clearTimeout,crypto,path:p,process:{platform:process.platform,env:{}},
    paths:{uploads:p.resolve('fixture-uploads'),data:p.resolve('fixture-data')},appRoot:()=>p.resolve('fixture-app'),
    fs:{lstatSync:file=>file.endsWith('.png')?stat:directory,fstatSync:()=>stat,realpathSync:{native:file=>file}},
    fsp:{async open(){opens++;await checkpoint('open');return{fd:7,async close(){closes++;if(closeFails)throw Object.assign(Error('close uncertain'),{code:'fixture.close_uncertain'});},async read(bytes,offset,length){reads++;await checkpoint(reads===1?'read':'tail');if(reads===1){sourceBytes.copy(bytes,offset,0,length);return{bytesRead:length};}return{bytesRead:0};}};},async mkdir(){}},
    assertSessionIdForPath:id=>id,sanitizeFsSegmentName:name=>name,
    async readConfig(){await checkpoint('config');return config;},async loadSession(id){await checkpoint('session');return{id,createdAt:recreated?'new':'old'};},
    sessionSaveIsTombstoned:session=>deleted&&session.createdAt==='old',
    PrivacyGateway:privacy,WorkDataMaintenanceHooks:{run(kind,work){managedCalls++;if(maintenanceRefuses)throw Error('maintenance refusing');return work();}},
    WorkDataStore:{requireKeys:()=>({})},atomicWriteJson:()=>{throw Error('actual writes forbidden');},
    MediaDerivedStore:{create:({authority})=>{let value;return{async put(input){const captured=await authority.capture(input.sourceId);authority.assert(captured);value={...input,bytes:Buffer.from(input.bytes),captured};return{id:'mimg_'+('0'.repeat(32))};},async read(){const bytes=Buffer.from(value.bytes);return{bytes,manifest:value.manifest,assert:()=>authority.assert(value.captured),release:()=>bytes.fill(0)};},async remove(){value?.bytes.fill(0);value=null;},async dispose(){value?.bytes.fill(0);value=null;}};}},
    MediaImageProcessor:{async create(){processorCreates++;await checkpoint('processorOwner');return processor;},isOwner:owner=>owner===processor},
    activeOpenAiProvider:()=>({vision:true,model:'synthetic',baseUrl:'https://model.invalid'}),providerWireProtocol:()=>({completionUrl:x=>x,requestHeaders:()=>({'X-Tenant':'synthetic'})}),
    ProviderMediaHooks:{},VisualMediaHooks:{},MediaImageHooks:hooks};
  const core=['01i-privacy-rules.js','01h-privacy-core.js','13ba-media-image-contract.js'].map(name=>fs.readFileSync(p.join(root,name),'utf8')).join('\n');
  const sourceNames=['13bd-media-image-service.js','13be-media-image-host.js'];
  const code=core+'\n'+sourceNames.map(name=>fs.readFileSync(p.join(root,name),'utf8')).join('\n');
  const api=vm.runInNewContext(code+';({MediaImageHost});',sandbox);
  return{api,hooks,wait,stats:()=>({opens,closes,reads,starts,processorCreates,managedCalls}),
    prepare:()=>api.MediaImageHost.prepare({sessionId:'sess_A',id:'file_A',name:'image.png'}),
    async entered(){await wait.ready;},unblock:()=>wait.resolve(),invalidate:()=>capturedPolicy.invalidateMedia()};
}
for(const boundary of ['config','session','open','read','tail','processorOwner'])test('host scope lease prevents deleted-session prepare after '+boundary+' await',async()=>{
  const f=fixture(boundary),pending=f.prepare();const rejected=a.rejects(pending,e=>e.code==='privacy.image_revoked');await f.entered();await f.hooks.revokeScope('sess_A');f.unblock();await rejected;
  const s=f.stats();a.equal(s.closes,s.opens);a.equal(s.starts,0,'no processor job launched after revocation');
});
test('host readConfig pending for one session survives revocation of another',async()=>{
  const f=fixture('config'),pending=f.prepare();await f.entered();await f.hooks.revokeScope('sess_B');f.unblock();const prepared=await pending;a.match(prepared.reference,/protected-image/);await f.hooks.revokeScope('sess_A');a.equal(f.stats().closes,1);
});
test('deleted old session objects refuse before opening source, including after revoke already finished',async()=>{
  const f=fixture(undefined,{deleted:true});await f.hooks.revokeScope('sess_A');await a.rejects(f.prepare(),e=>e.code==='session.not_found');a.equal(f.stats().opens,0);
});
test('an explicitly recreated same-id session receives a new epoch',async()=>{
  const f=fixture(undefined,{deleted:true,recreated:true});await f.hooks.revokeScope('sess_A');const result=await f.prepare();a.match(result.reference,/protected-image/);await f.hooks.revokeScope('sess_A');a.equal(f.stats().closes,1);
});
test('scope authority is revoked even when maintenance refuses admission',async()=>{
  const f=fixture('config',{maintenanceRefuses:true}),pending=f.prepare(),rejected=a.rejects(pending,e=>e.code==='privacy.image_revoked');await f.entered();
  await f.hooks.revokeScope('sess_A');f.unblock();await rejected;a.equal(f.stats().managedCalls,0,'revocation authority itself needs no filesystem maintenance admission');
});
for(const boundary of ['read','processorOwner'])test('host retains the failed source cleanup owner after revoked '+boundary,async()=>{
  const f=fixture(boundary,{closeFails:true}),pending=f.prepare(),rejected=a.rejects(pending,e=>e.code==='privacy.image_cleanup_failed'&&e.ownershipRetained===true&&e.cleanupFailed===true);
  await f.entered();await f.hooks.revokeScope('sess_A');f.unblock();await rejected;a.equal(f.stats().closes,1);a.equal(f.stats().starts,0);
  // Four uncertain close failures occupy all four owner slots. No fifth source
  // may open, even though every revoked epoch has already lost send authority.
  for(let i=0;i<3;i++)await a.rejects(f.prepare(),e=>e.code==='privacy.image_cleanup_failed');
  const before=f.stats().opens;await a.rejects(f.prepare(),e=>e.code==='privacy.image_busy');a.equal(f.stats().opens,before);
});
