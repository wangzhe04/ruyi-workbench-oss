'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=process.env.RUYI_DERIVED_INDEX_REPO||path.resolve(__dirname,'../..'),draft=process.env.RUYI_DERIVED_INDEX_SOURCE||path.join(repo,'ruyi-workbench/app/src');
const {loadWorkDataChunks}=require(path.join(repo,'dev-harness/lib/work-data-chunks-fixture'));
const {functionBlock,constBlock}=require(path.join(repo,'dev-harness/lib/source-slice'));
const temp=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(temp,'ruyi-derived-test-'));after(()=>{assert.equal(path.dirname(root),temp);assert.ok(path.basename(root).startsWith('ruyi-derived-test-'));fs.rmSync(root,{recursive:true,force:true});});
const src=n=>fs.readFileSync(path.join(draft,n),'utf8'),boot=fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/00-boot.js'),'utf8');
const privateError=e=>String(e?.code||'').startsWith('work_data'),plain=v=>JSON.parse(JSON.stringify(v));
function fixture(){
 const dir=fs.mkdtempSync(path.join(root,'case-')),state={enabled:false,key:crypto.randomBytes(32),instance:'derived-index-unit',missing:false,acquires:0,releases:0,io:false,failWrite:false},disk={...fsp,stat:async(...a)=>{if(state.io)throw Object.assign(Error('denied'),{code:'EACCES'});return fsp.stat(...a);}};
 const fx=loadWorkDataChunks({fsp:disk});fx.store.Hooks.keys={snapshot:async()=>{if(state.missing)throw Object.assign(Error('missing'),{code:'work_data_key.absent'});state.acquires++;const key=Buffer.from(state.key);return {key,instanceId:state.instance,release:async()=>{if(state.releaseGate)await state.releaseGate;state.releases++;key.fill(0);if(state.releaseFailure)throw Error('release failed');}};},unlock:async()=>state.key,instance:async()=>state.instance};
 const records=vm.runInNewContext(constBlock(fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/01q-work-data-records.js'),'utf8'),'WorkDataRecords')+';WorkDataRecords',{WorkDataCrypto:fx.crypto,Buffer});
 const searchFile=path.join(dir,'search.json'),projectionFile=path.join(dir,'projection.json');
 const c=vm.createContext({require,Buffer,console,crypto,path,fs,fsp:disk,WorkDataStore:fx.store,WorkDataRecords:records,SESSION_SEARCH_INDEX_VERSION:2,SESSION_SEARCH_HEAD_BYTES:1048576,SESSION_SEARCH_TAIL_BYTES:1048576,NDJSON_EDGE_EXTEND_CHUNK:65536,NDJSON_EDGE_EXTEND_MAX:2097152,sessionSearchIndexCache:null,sessionSearchRefreshChains:new Map(),PRETENDER_INDEX_SCHEMA:8,pretenderIndexRuntime:{writers:0,counters:{persists:0},value:null},
 sessionSearchIndexPath:()=>searchFile,pretenderIndexPath:()=>projectionFile,sessionBodyPaths:id=>({messages:path.join(dir,id+'.ndjson')}),
 readConfig:async()=>{if(state.switchError)throw Error('unknown switch');return{workDataEncryptionV1:state.enabled};},nowIso:()=> 'fixed-time',buildSessionSearchUnit:async m=>'unit:'+m.id,
 atomicWriteJson:async(...a)=>{if(state.failWrite)throw Object.assign(Error('full'),{code:'ENOSPC'});return fx.atomicWriteJson(...a);},pretenderFileStamp:async file=>{try{const st=await fsp.stat(file);return st.size+':'+st.mtimeMs;}catch{return '-';}}});
 const d=src('13d-core-domain-routes.js'),p=src('13e-pretender-index.js');
 const searchNames=['sessionSearchIndexStore','sessionSearchIndexAuthStamp','readSessionSearchIndex','refreshSessionSearchIndexNow','readNdjsonEdges','parseNdjsonRows','sessionSearchRows'];
 const projectionNames=['validatePretenderIndex','pretenderIndexStore','pretenderCheckIndexAuth','readPretenderIndexDisk','writePretenderIndexFileNow'];
 vm.runInContext(functionBlock(boot,'safeJsonParse')+'\n'+functionBlock(boot,'runKeyedChain')+'\nconst sessionSearchIndexFileStamp=st=>[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(":");\n'+searchNames.map(n=>functionBlock(d,n)).join('\n')+'\n'+projectionNames.map(n=>functionBlock(p,n)).join('\n')+'\nglobalThis.api={'+[...searchNames,...projectionNames].join(',')+'};',c);
 return{state,fx,records,c,api:c.api,searchFile,projectionFile,read:()=>fs.readFileSync(searchFile,'utf8')};
}
test('search OFF retains compact JSON, warm memo and no key work; ordinary cache I/O remains miss',async()=>{const f=fixture();const result=await f.api.refreshSessionSearchIndexNow([{id:'s1',updatedAt:'u',messageCount:2}]);assert.deepEqual(plain(result),{s1:{stamp:'u|2',unit:'unit:s1'}});assert.equal(f.read(),JSON.stringify({version:2,builtAt:'fixed-time',entries:result}));assert.equal(f.state.acquires,0);assert.deepEqual(plain((await f.api.readSessionSearchIndex()).entries),plain(result));f.state.io=true;assert.equal(await f.api.readSessionSearchIndex(),null);});
test('search ON seals >1MiB metadata and warm memo refuses key, instance and master changes without overwrite',async()=>{const f=fixture();f.state.enabled=true;const value={version:2,entries:{s:{stamp:'s',unit:'private-search-unit'.repeat(70000)}}};await f.api.sessionSearchIndexStore().write(JSON.stringify(value));const raw=f.read();assert.equal(JSON.parse(raw.split('\n')[0]).purpose,'search-index');assert.ok(!raw.includes('private-search-unit'));assert.equal((await f.api.readSessionSearchIndex()).entries.s.unit,value.entries.s.unit);f.state.missing=true;await assert.rejects(()=>f.api.readSessionSearchIndex(),privateError);await assert.rejects(()=>f.api.readSessionSearchIndex(),privateError);f.state.missing=false;f.state.key=crypto.randomBytes(32);await assert.rejects(()=>f.api.readSessionSearchIndex(),privateError);assert.equal(f.read(),raw);});
test('authenticated wrong search domain and corrupt cache cannot become writable empty state or plaintext downgrade',async()=>{const f=fixture();f.state.enabled=true;await f.api.sessionSearchIndexStore().write(JSON.stringify({version:2,entries:{s:{stamp:'s',unit:'secret'}}}));let raw=f.read();fs.writeFileSync(f.searchFile,raw.slice(0,-8));const broken=f.read();await assert.rejects(()=>f.api.refreshSessionSearchIndexNow([{id:'s'}]),privateError);assert.equal(f.read(),broken);fs.writeFileSync(f.searchFile,raw);f.state.enabled=false;await assert.rejects(()=>f.api.refreshSessionSearchIndexNow([{id:'changed'}]),privateError);assert.equal(f.read(),raw);});
test('search write failure publishes no new memo and unknown switch is never OFF',async()=>{const f=fixture();await f.api.refreshSessionSearchIndexNow([{id:'old'}]);const raw=f.read();f.state.failWrite=true;await f.api.refreshSessionSearchIndexNow([{id:'new'}]);assert.equal(f.read(),raw);assert.equal(f.c.sessionSearchIndexCache,null);f.state.switchError=true;await assert.rejects(()=>f.api.readSessionSearchIndex(),privateError);});
test('encrypted bodies retain logical plaintext edge coverage and authenticate physical ordinals with one released lease',async()=>{const f=fixture(),id='sess_rows',values=Array.from({length:2800},(_,i)=>({role:'user',content:'row'+i+':'+('z'.repeat(480))}));const raw=values.map((row,ordinal)=>f.records.encodeLine(JSON.stringify(row),f.state.key,{instanceId:f.state.instance,sessionId:id,kind:'messages',ordinal})).join('\n')+'\n';assert.ok(Buffer.byteLength(raw)>2097152);fs.writeFileSync(f.c.sessionBodyPaths(id).messages,raw);const result=await f.api.sessionSearchRows(id);assert.equal(result.length,values.length);assert.equal(result[1400].content,values[1400].content);assert.equal(f.state.acquires,1);assert.equal(f.state.releases,1);f.state.missing=true;await assert.rejects(()=>f.api.sessionSearchRows(id),privateError);f.state.missing=false;const lines=raw.trimEnd().split('\n');[lines[3],lines[4]]=[lines[4],lines[3]];fs.writeFileSync(f.c.sessionBodyPaths(id).messages,lines.join('\n')+'\n');await assert.rejects(()=>f.api.sessionSearchRows(id),privateError);});
test('projection OFF compact bytes and sealed ON roundtrip; warm key change clears value and rejects disk',async()=>{const f=fixture(),value={schemaVersion:8,sessions:[{sessionId:'s',revision:'r',card:{title:'private-projection'}}],sources:{s:'stamp'},usageStamp:'u'};assert.equal(await f.api.writePretenderIndexFileNow(value),true);assert.equal(fs.readFileSync(f.projectionFile,'utf8'),JSON.stringify(value));assert.equal(f.state.acquires,0);f.state.enabled=true;await f.api.pretenderCheckIndexAuth();await f.api.writePretenderIndexFileNow(value);const raw=fs.readFileSync(f.projectionFile,'utf8');assert.ok(!raw.includes('private-projection'));assert.deepEqual(plain(await f.api.readPretenderIndexDisk()),value);f.c.pretenderIndexRuntime.value=value;f.state.key=crypto.randomBytes(32);await f.api.pretenderCheckIndexAuth();assert.equal(f.c.pretenderIndexRuntime.value,null);await assert.rejects(()=>f.api.readPretenderIndexDisk(),privateError);assert.equal(fs.readFileSync(f.projectionFile,'utf8'),raw);});
test('projection missing key fails on every warm attempt and OFF save does not downgrade ciphertext',async()=>{const f=fixture(),value={schemaVersion:8,sessions:[],sources:{},usageStamp:'u'};f.state.enabled=true;await f.api.pretenderCheckIndexAuth();await f.api.writePretenderIndexFileNow(value);const raw=fs.readFileSync(f.projectionFile,'utf8');f.state.missing=true;await assert.rejects(()=>f.api.pretenderCheckIndexAuth(),privateError);await assert.rejects(()=>f.api.readPretenderIndexDisk(),privateError);f.state.missing=false;f.state.enabled=false;assert.equal(await f.api.writePretenderIndexFileNow({...value,builtAt:'new'}),false);assert.equal(fs.readFileSync(f.projectionFile,'utf8'),raw);});

test('logical encrypted head/tail matches legacy complete-row edges for a large body',async()=>{
 const f=fixture(),id='large_edges';f.state.enabled=true;
 const values=Array.from({length:1600},(_,i)=>({role:i%2?'assistant':'user',content:'edge-'+i+':'+('汉'.repeat(700))}));
 const lines=values.map(row=>JSON.stringify(row)),plainBody=lines.join('\n')+'\n',file=f.c.sessionBodyPaths(id).messages;
 fs.writeFileSync(file,plainBody);const edges=await f.api.readNdjsonEdges(file,1048576,1048576);
 const expected=[...f.api.parseNdjsonRows(edges.head),...f.api.parseNdjsonRows(edges.tail)];
 fs.writeFileSync(file,lines.map((line,ordinal)=>f.records.encodeLine(line,f.state.key,{instanceId:f.state.instance,sessionId:id,kind:'messages',ordinal})).join('\n')+'\n');
 const actual=await f.api.sessionSearchRows(id);assert.deepEqual(plain(actual),plain(expected));assert.equal(f.state.acquires,f.state.releases);
});

test('mixed body with only middle ciphertext preserves logical edges while ON and never needs keys for all-plain body',async()=>{
 const f=fixture(),id='mixed_middle';f.state.enabled=true;
 const values=Array.from({length:6000},(_,i)=>({role:'user',content:'mixed-'+i+':'+('m'.repeat(490))})),lines=values.map(row=>JSON.stringify(row)),file=f.c.sessionBodyPaths(id).messages;
 fs.writeFileSync(file,lines.join('\n')+'\n');const edges=await f.api.readNdjsonEdges(file,1048576,1048576),expected=[...f.api.parseNdjsonRows(edges.head),...f.api.parseNdjsonRows(edges.tail)];
 assert.deepEqual(plain(await f.api.sessionSearchRows(id)),plain(expected));assert.equal(f.state.acquires,0);
 const mixed=lines.map((line,ordinal)=>ordinal>=2900&&ordinal<3100?f.records.encodeLine(line,f.state.key,{instanceId:f.state.instance,sessionId:id,kind:'messages',ordinal}):line);
 fs.writeFileSync(file,mixed.join('\n')+'\n');assert.deepEqual(plain(await f.api.sessionSearchRows(id)),plain(expected));assert.equal(f.state.acquires,1);assert.equal(f.state.releases,1);
 f.state.missing=true;await assert.rejects(()=>f.api.sessionSearchRows(id),privateError);
});

test('legacy giant rows remain skipped at the edge bound, encrypted torn tails never publish plaintext rows',async()=>{
 const f=fixture(),id='giant_edges',file=f.c.sessionBodyPaths(id).messages;f.state.enabled=true;
 const lines=[JSON.stringify({role:'user',content:'q'.repeat(4*1048576)}),...Array.from({length:2400},(_,i)=>JSON.stringify({role:'user',content:'tail-'+i+':'+('x'.repeat(950))}))];
 fs.writeFileSync(file,lines.join('\n')+'\n');const edges=await f.api.readNdjsonEdges(file,1048576,1048576),expected=[...f.api.parseNdjsonRows(edges.head),...f.api.parseNdjsonRows(edges.tail)];
 const mixed=lines.map((line,ordinal)=>ordinal===1800?f.records.encodeLine(line,f.state.key,{instanceId:f.state.instance,sessionId:id,kind:'messages',ordinal}):line);
 fs.writeFileSync(file,mixed.join('\n')+'\n');assert.deepEqual(plain(await f.api.sessionSearchRows(id)),plain(expected));
 fs.writeFileSync(file,f.records.encodeLine(JSON.stringify({role:'user',content:'private-torn'}),f.state.key,{instanceId:f.state.instance,sessionId:id,kind:'messages',ordinal:0}));const before=fs.readFileSync(file,'utf8');
 await assert.rejects(()=>f.api.sessionSearchRows(id),privateError);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('warming ordinary plaintext while ON never makes OFF require a missing key',async()=>{
 const f=fixture(),search={version:2,entries:{s:{stamp:'s',unit:'plain index'}}},projection={schemaVersion:8,sessions:[],sources:{},usageStamp:'u'};
 fs.writeFileSync(f.searchFile,JSON.stringify(search));fs.writeFileSync(f.projectionFile,JSON.stringify(projection));f.state.enabled=true;
 assert.deepEqual(plain(await f.api.readSessionSearchIndex()),search);await f.api.pretenderCheckIndexAuth();assert.deepEqual(plain(await f.api.readPretenderIndexDisk()),projection);f.c.pretenderIndexRuntime.value=projection;
 f.state.enabled=false;f.state.missing=true;const before=f.state.acquires;
 assert.deepEqual(plain(await f.api.readSessionSearchIndex()),search);await f.api.pretenderCheckIndexAuth();assert.deepEqual(plain(await f.api.readPretenderIndexDisk()),projection);assert.equal(f.state.acquires,before);
});

test('short authority reads await asynchronous source cleanup before resolving',async()=>{
 const f=fixture();let release;f.state.releaseGate=new Promise(resolve=>{release=resolve;});let settled=false;
 const pending=f.api.sessionSearchIndexAuthStamp().then(()=>{settled=true;});await new Promise(setImmediate);assert.equal(settled,false);release();await pending;assert.equal(f.state.releases,1);
 f.state.enabled=true;let releaseProjection;f.state.releaseGate=new Promise(resolve=>{releaseProjection=resolve;});settled=false;
 const checking=f.api.pretenderCheckIndexAuth().then(()=>{settled=true;});await new Promise(setImmediate);assert.equal(settled,false);releaseProjection();await checking;assert.equal(f.state.releases,2);
});

test('stream cleanup completes and cannot replace a primary ordinal/authentication failure',async()=>{
 const f=fixture(),id='primary_error';f.state.enabled=true;f.state.releaseFailure=true;
 const raw=f.records.encodeLine(JSON.stringify({role:'user',content:'secret'}),f.state.key,{instanceId:f.state.instance,sessionId:id,kind:'messages',ordinal:1})+'\n';fs.writeFileSync(f.c.sessionBodyPaths(id).messages,raw);
 await assert.rejects(()=>f.api.sessionSearchRows(id),error=>error.code==='work_data_record.ordinal_mismatch');assert.equal(f.state.releases,1);assert.equal(fs.readFileSync(f.c.sessionBodyPaths(id).messages,'utf8'),raw);
});

test('oversized reordered or escaped reserved rows stay hard errors after bounded legacy buffering is dropped',async()=>{
 const f=fixture(),id='late_reserved',file=f.c.sessionBodyPaths(id).messages;f.state.enabled=true;
 for(const [prefix,key] of [['','w'],['','\\u0077'],['\ufeff','\\u0077']]){
   const raw=prefix+'{"e":"'+'x'.repeat(3300000)+'","'+key+'":2}\n';fs.writeFileSync(file,raw);
   await assert.rejects(()=>f.api.sessionSearchRows(id),privateError);assert.equal(fs.statSync(file).size,Buffer.byteLength(raw));
 }
});
