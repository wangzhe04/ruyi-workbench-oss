'use strict';
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=p.resolve(__dirname,'../..'),TOOLS=p.join(ROOT,'ruyi-workbench/tools'),ID='m4-image-cpython312-candidate-v2';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function treeFixture(options={}) {
  const root=p.resolve('C:/synthetic-profile'),nodes=new Map();let serial=1,opens=0,closes=0,reads=0;
  const add=(file,data)=>{nodes.set(file,{data:data===undefined?undefined:Buffer.from(data),ino:BigInt(serial++),nlink:data===undefined?2n:1n,revision:1n,symlink:false});};
  const ensure=file=>{if(nodes.has(file))return;const parent=p.dirname(file);if(parent!==file)ensure(parent);add(file);};ensure(root);
  const put=(relative,data)=>{const file=p.join(root,...relative.split('/'));ensure(p.dirname(file));add(file,data);};
  const files=[['payload/python_embed/python312._pth','python312.zip\r\n.\r\nLib/site-packages\r\n'],['payload/python_embed/app.py','print("synthetic")'],['control/contract.json','{}']];
  for(const [name,data] of files)put(name,data);
  const rows=files.map(([name,data])=>({path:name,bytes:Buffer.byteLength(data),sha256:sha(data)}));
  const stat=file=>{const value=nodes.get(file);if(!value)throw Object.assign(Error('missing'),{code:'ENOENT'});return{dev:1n,ino:value.ino,size:BigInt(value.data?.length||0),mtimeNs:value.revision,ctimeNs:value.revision,nlink:value.nlink,isFile:()=>value.data!==undefined,isDirectory:()=>value.data===undefined,isSymbolicLink:()=>value.symlink};};
  const io={
    async lstat(file){options.onStat?.({file,root,nodes,put});return stat(file);}, async realpath(file){return file;},
    async readdir(file){return[...nodes.keys()].filter(name=>p.dirname(name)===file&&name!==file).map(name=>p.basename(name));},
    async open(file){opens++;let offset=0;options.onOpen?.();return{async stat(){return stat(file);},async read(buffer,start,length){reads++;const source=nodes.get(file).data,count=Math.min(length,source.length-offset);source.copy(buffer,start,offset,offset+count);offset+=count;options.onRead?.({reads,file,put,nodes,root});return{bytesRead:count};},async close(){closes++;options.onClose?.({file,root,put,nodes});}};}
  };
  const source=fs.readFileSync(p.join(TOOLS,'media-profile-tree.cjs'),'utf8'),module={exports:{}};
  vm.runInNewContext(source,{module,exports:module.exports,require:name=>name==='node:fs/promises'?io:require(name),Buffer,AbortSignal});
  return{root,rows,nodes,put,verify:(r=rows,s)=>module.exports.verifyClosedTree(root,r,s),stats:()=>({opens,closes,reads})};
}
const code=expected=>error=>error.code==='media.profile_'+expected;
test('closed tree checks every byte and returns observation with all authority gates false',async()=>{
  const f=treeFixture(),receipt=await f.verify();a.equal(receipt.files,3);a.equal(receipt.bytes,f.rows.reduce((n,row)=>n+row.bytes,0));a.equal(receipt.executionAuthorized,false);a.equal(receipt.ready,false);a.equal(receipt.namespaceLeaseProved,false);a.equal(f.stats().closes,3);
});
for(const [name,mutate,expected] of [
  ['missing',f=>f.nodes.delete(p.join(f.root,'control/contract.json')),'tree_extra_or_missing'],
  ['same size drift',f=>f.nodes.get(p.join(f.root,'control/contract.json')).data=Buffer.from('[]'),'drift'],
  ['unlisted executable bytecode',f=>f.put('payload/python_embed/__pycache__/app.cpython-312.pyc','x'),'bytecode_forbidden'],
  ['legacy bytecode',f=>f.put('payload/python_embed/app.pyc','x'),'bytecode_forbidden'],
  ['dynamic pth',f=>f.put('payload/python_embed/inject.pth','import bad'),'pth_forbidden'],
  ['second bootstrap',f=>f.put('payload/python_embed/python._pth','.'),'pth_forbidden'],
  ['installation launcher',f=>f.put('payload/python_embed/Scripts/f2py.exe','x'),'scripts_forbidden'],
  ['empty unexpected directory',f=>f.put('extra/empty-marker',''),'tree_extra_or_missing'],
  ['file hardlink',f=>f.nodes.get(p.join(f.root,'control/contract.json')).nlink=2n,'alias'],
  ['directory reparse',f=>f.nodes.get(p.join(f.root,'payload')).symlink=true,'alias']
])test('closed tree refuses '+name,async()=>{const f=treeFixture();mutate(f);await a.rejects(f.verify(),code(expected));a.equal(f.stats().opens,f.stats().closes);});
for(const [name,rows,expected] of [
  ['case alias',r=>[...r,{...r[1],path:r[1].path.toUpperCase()}],'path_alias'],
  ['file-directory alias',r=>[...r,{...r[1],path:'payload/PYTHON_EMBED'}],'path_alias'],
  ['reserved Windows name',r=>[{...r[1],path:'payload/NUL.py'}],'path_invalid'],
  ['trailing dot',r=>[{...r[1],path:'payload/file.'}],'path_invalid'],
  ['loose pyc in claimed inventory',r=>[{...r[1],path:'payload/app.pyc'}],'bytecode_forbidden'],
  ['dynamic pth in claimed inventory',r=>[{...r[1],path:'payload/inject.pth'}],'pth_forbidden']
])test('inventory refuses '+name+' before first filesystem await',async()=>{const f=treeFixture();await a.rejects(f.verify(rows(f.rows)),code(expected));a.equal(f.stats().reads,0);});
test('mutation at last close is caught by complete final namespace scan',async()=>{
  let count=0;const f=treeFixture({onClose:({put})=>{if(++count===3)put('control/late.json','{}');}});await a.rejects(f.verify(),code('tree_extra_or_missing'));a.equal(f.stats().opens,f.stats().closes);
});
test('cancellation immediately after open still closes the opened handle',async()=>{
  const controller=new AbortController(),f=treeFixture({onOpen:()=>controller.abort()});await a.rejects(f.verify(f.rows,{signal:controller.signal}),code('cancelled'));a.equal(f.stats().opens,1);a.equal(f.stats().closes,1);
});
test('rows are captured before the first await and caller mutation cannot change the expected hash',async()=>{
  let first=true,f;f=treeFixture({onStat:()=>{if(first){first=false;f.rows[0].sha256='0'.repeat(64);f.rows.push({...f.rows[1],path:'fake.py'});}}});const result=await f.verify();a.equal(result.files,3);
});
function adapterFixture() {
  const buffers=new Map();for(const name of [ID+'.json',ID+'-sources.json'])buffers.set(name,fs.readFileSync(p.join(ROOT,'ruyi-workbench/resources/media-profiles',name)));
  const module={exports:{}},source=fs.readFileSync(p.join(TOOLS,'verify-media-profile.cjs'),'utf8');let observations=0;
  const fakeFs={readFileSync:file=>buffers.get(p.basename(file))};
  vm.runInNewContext(source,{module,exports:module.exports,__dirname:TOOLS,Buffer,require:name=>name==='node:fs'?fakeFs:name==='./media-profile-tree.cjs'?{verifyClosedTree:async()=>{observations++;return{files:3251,bytes:396911379,executionAuthorized:false,namespaceLeaseProved:false};}}:require(name)});
  const profile=JSON.parse(buffers.get(ID+'.json')),api=module.exports;
  return{api,buffers,profile,capture:(language='en-US')=>api.captureMediaProfile({profileId:ID,workerHash:profile.worker.sha256,language}),observations:()=>observations};
}
test('only private exact capture is accepted and it still refuses execution as pending',()=>{
  const f=adapterFixture(),capture=f.capture();a.equal(capture.profileId,ID);a.throws(()=>f.api.assertMediaProfileExecutable({...capture}),code('owner_invalid'));a.throws(()=>f.api.assertMediaProfileExecutable(capture),code('qualification_pending'));
  a.notEqual(f.capture('zh-Hans-CN').hash,capture.hash);a.equal(f.observations(),0);
});
test('forged ready/source flags and stale captures cannot change the pinned profile',()=>{
  const f=adapterFixture(),capture=f.capture();f.buffers.set(ID+'.json',Buffer.from(JSON.stringify({...f.profile,ready:true,executionAuthorized:true,sourceArchiveAvailable:true})));a.throws(()=>f.api.assertMediaProfileExecutable(capture),code('changed'));
});
test('unknown profile, foreign worker and injected language have finite refusals',()=>{
  const f=adapterFixture();a.throws(()=>f.api.captureMediaProfile({profileId:'C:/forged.json',workerHash:f.profile.worker.sha256,language:'en-US'}),code('unknown'));
  a.throws(()=>f.api.captureMediaProfile({profileId:ID,workerHash:'0'.repeat(64),language:'en-US'}),code('binding_invalid'));
  a.throws(()=>f.capture('en-US;PATH=other'),code('binding_invalid'));
});
test('a changed/unknown source recipe cannot mint a private capture',()=>{
  const f=adapterFixture();f.buffers.set(ID+'-sources.json',Buffer.from('{}'));a.throws(()=>f.capture(),code('changed'));
});
test('production processor explicit candidate and unknown ID never fall back to legacy or spawn',async()=>{
  const f=adapterFixture(),source=fs.readFileSync(p.join(ROOT,'ruyi-workbench/app/src/13bc-media-image-processor.js'),'utf8');let legacy=0,spawns=0,stats=0;
  const load=name=>name==='node:fs/promises'?{lstat:async()=>{stats++;throw Error('unexpected IO');}}:name==='node:child_process'?{spawn:()=>{spawns++;throw Error('unexpected spawn');}}:name==='../tools/verify-media-artifacts.cjs'?{verifyMediaArtifacts:async()=>{legacy++;throw Error('unexpected fallback');}}:name==='../tools/verify-media-profile.cjs'?f.api:require(name);
  const api=vm.runInNewContext(source+';MediaImageProcessor;',{require:load,process:{platform:'win32',env:{PATH:'C:/hostile',PYTHONPATH:'C:/hostile',PYTHONHOME:'C:/hostile'}},Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  const args={runtimeRoot:p.resolve('C:/synthetic-runtime'),sourceRoot:p.resolve('C:/synthetic-source'),language:'en-US'};
  await a.rejects(api.create({...args,resourceProfile:ID}),e=>e.code==='privacy.image_processor_resource_profile_pending');
  await a.rejects(api.create({...args,resourceProfile:'unknown'}),e=>e.code==='privacy.image_processor_resource_profile_unknown');
  a.equal(legacy,0);a.equal(spawns,0);a.equal(stats,0);
});
test('real frozen data preserves old locks and the complete 3251 candidate without loose caches',()=>{
  const f=adapterFixture(),profile=f.profile,legacy=fs.readFileSync(p.join(ROOT,'ruyi-workbench/resources/media-runtime-dependencies.json'));
  a.equal(sha(legacy),'4e84862cf50907c84b14a55dcabcc347ae3a52e78a88031b7ecb878565d6735f');a.equal(profile.artifacts.length,3251);a.equal(profile.artifacts.reduce((n,row)=>n+row.bytes,0),396911379);
  a.equal(profile.artifacts.some(row=>/\.pyc$|\.pth$|\/Scripts\//i.test(row.path)),false);a.equal(profile.pythonVersion,'3.12.10');a.equal(profile.ready,false);a.equal(profile.graph.nativeDllClosure,'pending');
});

function copyFixture(options={}){
  const sources=new Map([['payload/one.py',Buffer.from('public one')],['control/two.json',Buffer.from('{}')]]),outputs=new Map(),sourceLease=Object.freeze({source:true}),targetLease=Object.freeze({target:true});let closed=0,syncs=0,revoked=false,finished=0,begun=0;
  const rows=[...sources].map(([name,bytes])=>({path:name,source:p.resolve('C:/synthetic-sealed-source',name),bytes:bytes.length,sha256:sha(bytes)}));
  const stat=(data,ino)=>({dev:1n,ino:BigInt(ino),size:BigInt(data.length),mtimeNs:1n,ctimeNs:1n,nlink:1n,isFile:()=>true});
  const sourceOwner={capture:async()=>sourceLease,assert:value=>value===sourceLease&&!revoked,openPinned:async(lease,row)=>{
    const data=Buffer.from(sources.get(row.path));if(options.sourceDrift)data[0]^=1;
    return{stat:async()=>stat(data,1+rows.findIndex(value=>value.path===row.path)),read:async(buffer,offset,length,position)=>{const count=Math.min(length,4,Math.max(0,data.length-position));data.copy(buffer,offset,position,position+count);return{bytesRead:count};},close:async()=>{closed++;if(options.closeFails)throw Error('synthetic source close');}};
  }};
  const targetOwner={beginEmpty:async()=>{begun++;return targetLease;},assert:value=>value===targetLease,
    openExclusive:async(lease,row)=>{outputs.set(row.path,Buffer.alloc(0));return{
      stat:async()=>stat(outputs.get(row.path),100+rows.findIndex(value=>value.path===row.path)),
      write:async(buffer,offset,length,position)=>{if(options.shortWrite)return{bytesWritten:0};const count=Math.min(3,length),prior=outputs.get(row.path),next=Buffer.alloc(Math.max(prior.length,position+count));prior.copy(next);buffer.copy(next,position,offset,offset+count);outputs.set(row.path,next);return{bytesWritten:count};},
      sync:async()=>{syncs++;if(options.readbackDrift)outputs.get(row.path)[0]^=1;if(options.revokeAtSync)revoked=true;},
      read:async(buffer,offset,length,position)=>{const data=outputs.get(row.path),count=Math.min(length,5,Math.max(0,data.length-position));data.copy(buffer,offset,position,position+count);return{bytesRead:count};},close:async()=>{closed++;}
    };},finishReadback:async()=>{finished++;return{files:outputs.size,bytes:[...outputs.values()].reduce((n,value)=>n+value.length,0),treeComplete:true,directoryDurabilityProved:false};}};
  const api=require('../../ruyi-workbench/tools/media-profile-restore.cjs');return{run:()=>api.copyOwnedRows(rows,{sourceOwner,targetOwner}),stats:()=>({closed,syncs,finished,begun}),sources,outputs};
}
test('owned copy handles partial reads/writes, fsyncs and independently reads back every copied byte',async()=>{
  const f=copyFixture(),result=await f.run();a.equal(result.files,2);a.equal(result.executionAuthorized,false);a.equal(result.ready,false);a.equal(result.directoryDurabilityProved,false);a.equal(f.stats().syncs,2);a.equal(f.stats().closed,4);
  for(const [name,bytes] of f.sources)a.deepEqual(f.outputs.get(name),bytes);
});
for(const [name,options,suffix]of[
  ['source drift',{sourceDrift:true},'source_drift'],['target readback drift',{readbackDrift:true},'readback_drift'],['zero partial write',{shortWrite:true},'write_failed'],['revocation during fsync',{revokeAtSync:true},'owner_changed']
])test('owned copy refuses '+name+' and closes both handles without claiming full restoration',async()=>{const f=copyFixture(options);await a.rejects(f.run(),error=>error.code==='media.profile_restore_'+suffix);a.equal(f.stats().closed,2);a.equal(f.stats().finished,0);});
test('uncertain copied-file close retains the external custodians and refuses success',async()=>{
  const f=copyFixture({closeFails:true});await a.rejects(f.run(),error=>error.code==='media.profile_restore_cleanup_unknown'&&error.ownershipRetained===true&&error.cleanupFailed===true);a.equal(f.stats().finished,0);
});
test('disk RestoreMap or truth flags cannot instantiate source and target custodians',async()=>{
  const api=require('../../ruyi-workbench/tools/media-profile-restore.cjs');await a.rejects(api.restoreMediaProfile({mapBytes:Buffer.from('{"ready":true}')}),error=>error.code==='media.profile_restore_map_changed');
  await a.rejects(api.copyOwnedRows([{path:'one.py',source:p.resolve('C:/synthetic'),bytes:0,sha256:sha('')}]),error=>error.code==='media.profile_restore_custody_pending');
});

// Execute only the real E2E scenario and frontend preparation functions against
// in-memory HTTP/process facades. No server/socket/component is started. These
// controls check fixture session orchestration, not actual image qualification.
async function sessionOrchestration(fixtures,sourceOverride){
  const {EventEmitter}=require('node:events'),zlib=require('node:zlib'),{functionBlock}=require('../lib/source-slice');
  const source=sourceOverride||fs.readFileSync(p.join(ROOT,'dev-harness/media-resource-profile.e2e.js'),'utf8');
  const scenario=functionBlock(source,'scenario'),frontend=functionBlock(source,'frontendState');a.ok(scenario&&frontend);
  const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
  const chunk=(name,data)=>{const body=Buffer.concat([Buffer.from(name),data]),length=Buffer.alloc(4),tail=Buffer.alloc(4);length.writeUInt32BE(data.length);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,tail]);};
  const row=Buffer.from([0,255,255,255,255,255,255]),png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.concat([row,row]))),chunk('IEND',Buffer.alloc(0))]);
  const calls=[],assertions=[],sessions=new Map(),uploads=new Map(),artifacts=new Map(),fake={requests:[]};let privacy='off',child,nextArtifact=0;
  const response=(json={},status=200,bytes=Buffer.alloc(0))=>({json,status,bytes,headers:{get:()=>sha(png)}});
  const request=async(port,route,options={})=>{
    const body=options.body;calls.push({route,body,method:options.method||'GET'});
    if(route==='/health')return response({},200);if(route==='/api/bootstrap')return response({token:'synthetic-token'});
    if(route==='/api/sessions'){const id='session_'+(sessions.size+1);sessions.set(id,{raw:false,history:[]});return response({session:{id}});}
    if(route==='/api/upload'){const file={id:'file_'+(uploads.size+1),name:body.name,kind:'image'};uploads.set(file.id,{file,bytes:Buffer.from(body.data,'base64')});return response({file});}
    if(route.startsWith('/api/upload/content?'))return response({},200,uploads.get(new URL(route,'http://synthetic').searchParams.get('id')).bytes);
    if(route==='/api/privacy/settings'){privacy=body.mode;return response({ok:true});}
    if(route==='/api/media/images/prepare'){
      if(!fixtures)return response({error:{code:'privacy.image_processor_resource_profile_pending'}},409);
      const id=(++nextArtifact).toString(16).padStart(32,'0'),reference='https://ruyi.invalid/protected-image/'+id;artifacts.set(reference,{sessionId:body.sessionId,deleted:false});
      return response({id,reference,manifest:{sourceHash:sha(png),sourceRevision:'synthetic',transformHash:sha('transform'),width:2,height:2,payloadHash:sha(png)}});
    }
    if(route.startsWith('/api/media/images/')&&options.method==='DELETE'){artifacts.get('https://ruyi.invalid/protected-image/'+route.split('/').at(-1)).deleted=true;return response({ok:true});}
    if(route.includes('/preview?'))return response({},200,png);
    if(route==='/api/chat/stream'){
      const session=sessions.get(body.sessionId),reference=body.attachments[0].protectedImage?.reference;
      if(privacy==='off'){session.raw=true;fake.requests.push({raw:JSON.stringify({image:'data:image/png;base64,'+png.toString('base64')})});return response({ok:true});}
      if(session.raw)return response({error:{code:'privacy.media_not_supported'}},409);
      if(session.history.some(ref=>artifacts.get(ref)?.deleted))return response({error:{code:'privacy.image_expired'}},409);
      if(!reference)return response({error:{code:'privacy.image_preparation_required'}},409);
      a.equal(artifacts.get(reference).sessionId,body.sessionId);session.history.push(reference);
      fake.requests.push({raw:JSON.stringify({images:session.history.map(()=> 'data:image/png;base64,'+png.toString('base64'))})});return response({ok:true});
    }
    throw Error('Unexpected synthetic route '+route);
  };
  const sandbox={fs:{mkdirSync(){},writeFileSync(){},readFileSync:fs.readFileSync},path:p,WB:p.join(ROOT,'ruyi-workbench'),releaseEnvironment:()=>({}),process:{env:{},execPath:'synthetic-node'},ID,PNG:png,crypto,vm,Buffer,URL,TextEncoder,DataView,AbortController,setTimeout,clearTimeout,getFreePort:async()=>0,request,sha,sleep:async()=>{},ok:(condition,label)=>assertions.push({condition,label}),
    cp:{spawn(){child=new EventEmitter();child.stdout={resume(){}};child.stderr={resume(){}};queueMicrotask(()=>child.emit('spawn'));return child;}},killOwnTree(){child.emit('exit',0);child.emit('close',0);return{killed:[1]};},previewPixels:()=>({width:2,height:2,pixel:()=>[255,255,255]})};
  const run=vm.runInNewContext(frontend+'\n'+scenario+';scenario;',sandbox);
  const cases=fixtures?['first','second'].map(id=>({id,bytes:png,sha256:sha(png),expected:'success',width:2,height:2,pixels:[{x:0,y:0,rgb:[255,255,255]}]})):undefined;
  await run(p.resolve('C:/synthetic-e2e-home'),fake,{profile:ID,fixtures:cases});return{calls,assertions,sessions,fake};
}
test('actual default E2E uses separate OFF and ON sessions without raw-history contamination',async()=>{
  const f=await sessionOrchestration(false),chats=f.calls.filter(row=>row.route==='/api/chat/stream'),prepares=f.calls.filter(row=>row.route==='/api/media/images/prepare');
  a.equal(f.sessions.size,2);a.notEqual(chats[0].body.sessionId,chats[1].body.sessionId);a.ok(prepares.every(row=>row.body.sessionId===chats[1].body.sessionId));
  a.equal(f.sessions.get(chats[1].body.sessionId).raw,false);a.equal(f.fake.requests.length,1);a.ok(f.assertions.every(row=>row.condition),JSON.stringify(f.assertions.filter(row=>!row.condition)));
});
test('actual full E2E gives each fixture a fresh session and keeps one-image/hash/deletion assertions',async()=>{
  const f=await sessionOrchestration(true),chats=f.calls.filter(row=>row.route==='/api/chat/stream'),prepares=f.calls.filter(row=>row.route==='/api/media/images/prepare');
  a.equal(f.sessions.size,3);a.equal(new Set(chats.map(row=>row.body.sessionId)).size,3);a.equal(new Set(prepares.map(row=>row.body.sessionId)).size,2);
  a.equal(f.calls.filter(row=>row.method==='DELETE').length,2);a.equal(f.assertions.filter(row=>/final model PNG equals/.test(row.label)).length,2);a.ok(f.assertions.every(row=>row.condition),JSON.stringify(f.assertions.filter(row=>!row.condition)));
});
