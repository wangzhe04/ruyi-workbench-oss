'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {constBlock}=require('../lib/source-slice'),{loadWorkDataChunks}=require('../lib/work-data-chunks-fixture');
const sourceFile=process.env.RUYI_MARKER_STORE_SOURCE||path.resolve(__dirname,'../../ruyi-workbench/app/src/01p-work-data-store.js');
const base=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'ruyi-reserved-key-unit-'));
after(()=>{assert.equal(path.dirname(root),base);fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const fx=loadWorkDataChunks(),dir=fs.mkdtempSync(path.join(root,'case-')),file=path.join(dir,'value'),master=crypto.randomBytes(32),state={keys:0};
 const store=vm.runInNewContext(constBlock(fs.readFileSync(sourceFile,'utf8'),'WorkDataStore')+'\nWorkDataStore;',{require,Buffer,WorkDataCrypto:fx.crypto,WorkDataChunks:fx.chunks});
 const keys={snapshot:async()=>{state.keys++;const key=Buffer.from(master);return{key,instanceId:'marker-unit',release:()=>key.fill(0)};}};
 const host={file:()=>file,purpose:'memory',schema:1,scopeId:'global',recordId:'example',keys,enabled:()=>false,writeJson:fx.atomicWriteJson};
 return{fx,store,file,host,state};
}
const escaped=Array.from('workData',char=>String.fromCharCode(92)+'u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
const truncated='{"'+escaped+'":2,"ciphertext":',privateError=error=>String(error?.code||'').startsWith('work_data');

test('escaped-key truncated carriers fail closed across text and JSON read/write APIs, preserving bytes with OFF',async()=>{
 for(const kind of ['text','json']){const f=fixture(),api=kind==='text'?f.store.createText(f.host):f.store.createJson({...f.host,defaultValue:()=>({schema:1,entries:{}}),schemaVersion:1,validate:value=>!!value.entries});fs.writeFileSync(f.file,truncated);
 await assert.rejects(()=>api.read(),privateError);await assert.rejects(()=>api.write(kind==='text'?'replacement':{schema:1,entries:{}}),privateError);assert.equal(fs.readFileSync(f.file,'utf8'),truncated);assert.equal(f.state.keys,0);}
});

test('all partial Unicode/literal key spellings and hex cases remain reserved on parse failure',async()=>{
 const f=fixture(),api=f.store.createText(f.host);
 for(let mask=1;mask<256;mask++){const key=Array.from('workData',(char,index)=>mask&(1<<index)?String.fromCharCode(92)+'u'+char.charCodeAt(0).toString(16).padStart(4,'0').toUpperCase():char).join(''),raw='{"'+key+'":2,"ciphertext":';fs.writeFileSync(f.file,raw);await assert.rejects(()=>api.read(),privateError);}
 assert.equal(f.state.keys,0);
});

test('streaming marker probe recognizes every split and arbitrarily long whitespace at the buffer boundary',async()=>{
 const f=fixture(),marker='"'+escaped+'":';
 for(let split=1;split<marker.length;split++){fs.writeFileSync(f.file,' '.repeat(65536-split)+marker);assert.equal(await f.store.hasContainerMarker(f.file),true,'split '+split);}
 fs.writeFileSync(f.file,' '.repeat(65536-10)+'"'+escaped+'"'+' '.repeat(180000)+':');assert.equal(await f.store.hasContainerMarker(f.file),true);
});

test('ordinary escaped quote examples, non-reserved key case and nested business keys do not become container headers',async()=>{
 const f=fixture(),api=f.store.createText(f.host);
 const cases=[String.raw`{"example":"\u0022workData\u0022:2"}`,String.raw`{"example":"\u0022workData\u0022:2"`,JSON.stringify({WorkData:2,example:'ordinary'}),JSON.stringify({schema:1,nested:{workData:2}})];
 for(const raw of cases){fs.writeFileSync(f.file,raw);assert.equal(await api.read(),raw);await api.write('ordinary replacement');assert.equal(fs.readFileSync(f.file,'utf8'),'ordinary replacement');}
 assert.equal(f.state.keys,0);
});

test('Markdown opt-in keeps literal/escaped examples as legacy but refuses a JSON-looking truncated carrier',async()=>{
 const f=fixture(),api=f.store.createText({...f.host,legacyText:'markdown'}),raw='# Documentation\n'+truncated+'\nLiteral "workData":3';fs.writeFileSync(f.file,raw);assert.equal(await api.read(),raw);await api.write(raw);assert.equal(f.state.keys,0);fs.writeFileSync(f.file,truncated);await assert.rejects(()=>api.read(),privateError);await assert.rejects(()=>api.write(raw),privateError);assert.equal(fs.readFileSync(f.file,'utf8'),truncated);
});

test('binary gzip classification and OFF byte identity remain unchanged by the JSON marker',async()=>{
 const f=fixture(),bytes=zlib.gzipSync(Buffer.from('documentation '+truncated+'\nPRIVATE-BINARY')),api=f.store.createBinary({...f.host,chunked:true,maxPlaintextBytes:256*1024*1024,maxBinaryBytes:1024*1024,validateLegacyBinary:value=>{zlib.gunzipSync(value);return true;}});await api.write(bytes);assert.deepEqual(fs.readFileSync(f.file),bytes);assert.deepEqual(await api.read(),bytes);assert.equal(f.state.keys,0);
});

test('write guards independently reject truncated escaped carriers before any plaintext replacement',async()=>{
 const fixtures=[fixture(),fixture()],apis=[fixtures[0].store.createText(fixtures[0].host),fixtures[1].store.createJson({...fixtures[1].host,schemaVersion:1,defaultValue:()=>({schema:1,entries:{}}),validate:value=>!!value.entries})];
 for(const f of fixtures)fs.writeFileSync(f.file,truncated);const results=await Promise.allSettled(apis.map((api,index)=>api.write(index?{schema:1,entries:{}}:'REPLACEMENT')));assert.deepEqual(results.map(value=>value.status),['rejected','rejected']);
 for(const f of fixtures){assert.equal(fs.readFileSync(f.file,'utf8'),truncated);assert.equal(f.state.keys,0);}
});
