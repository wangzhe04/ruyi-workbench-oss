'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {treeManifest,summarizeLpac}=require('./lpac');
const names=['loopback-tcp4','loopback-tcp6','private-gateway','loopback-udp4','loopback-udp6','dns-owned-receiver'];
function fixture() {
  const output=[];
  for(const descendant of [false,true]) {
    for(const [name,allowed]of Object.entries({'project-read':true,'outside-secret-read':false,'project-write-denied':false,'owned-write':true,'outside-write':false,'outside-all-app-packages-read':false}))output.push({kind:'file',name,allowed,descendant,code:allowed?undefined:'EPERM'});
    for(const name of names)output.push({kind:'network',name,allowed:null,descendant});
    output.push({kind:'same-process-http',allowed:true,accepted:1,descendant});
  }
  output.push({kind:'descendant-token',isAppContainer:true,isLessPrivilegedAppContainer:null,packageSid:'SYNTHETIC_PROFILE',capabilityCount:0,capabilitySids:[]});
  return {code:0,output,events:[{stage:'token-verified',isAppContainer:true,isLessPrivilegedAppContainer:null,profileSidMatched:true,packageSid:'SYNTHETIC_PROFILE',capabilityCount:0,capabilitySids:[]},{stage:'launched',isolation:'LPAC',capabilities:0,capabilityNames:[]}],receivers:names.map(id=>({id,positiveControlConnections:1,unauthorizedConnections:0}))};
}
test('limited LPAC behavioral result preserves unavailable direct query and requires both generations',()=>{
  const probe=fixture(),summary=summarizeLpac(probe);assert.equal(summary.osGatePassed,true);assert.equal(summary.directLpacTokenQueryVerified,false);assert.equal(summary.exclusiveFilesystemAllowlistEstablished,false);
  probe.output=probe.output.filter(event=>!(event.name==='outside-all-app-packages-read'&&event.descendant));assert.equal(summarizeLpac(probe).osGatePassed,false);
});
test('missing token, mismatched package, positive receiver, failed self HTTP and crash block the respective gates',()=>{
  for(const mutate of [p=>p.output=p.output.filter(e=>e.kind!=='descendant-token'),p=>p.output.find(e=>e.kind==='descendant-token').packageSid='OTHER',p=>p.receivers[0].unauthorizedConnections=1,p=>p.code=1]) {const probe=fixture();mutate(probe);assert.equal(summarizeLpac(probe).osGatePassed,false);assert.equal(summarizeLpac(probe).transportGatePassed,false);}
  const probe=fixture();probe.output.find(e=>e.kind==='same-process-http').allowed=false;assert.equal(summarizeLpac(probe).transportGatePassed,false);
});
test('complete program manifest includes nested assets, binds names and bytes, and is deterministic',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-m1-cli-hash-'));
  try {fs.mkdirSync(path.join(root,'nested'));fs.writeFileSync(path.join(root,'entry'),'one');fs.writeFileSync(path.join(root,'nested','native.bin'),'two');const first=treeManifest(root);assert.equal(first.fileCount,2);assert.deepEqual(first,treeManifest(root));fs.writeFileSync(path.join(root,'nested','native.bin'),'changed');assert.notEqual(treeManifest(root).sha256,first.sha256);fs.renameSync(path.join(root,'entry'),path.join(root,'renamed'));assert.notEqual(treeManifest(root).sha256,first.sha256);}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});
