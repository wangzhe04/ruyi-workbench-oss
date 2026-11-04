'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),c=require('node:crypto');
const {loadWorkDataChunks}=require('../lib/work-data-chunks-fixture');
const code=fs.readFileSync(require('node:path').resolve(__dirname,'../../ruyi-workbench/app/src/01af-work-data-attachment-chunks.js'),'utf8');
const sha=v=>c.createHash('sha256').update(v).digest('hex'),revision='b'.repeat(32),meta={logicalName:'秘密😀.bin',mime:'application/octet-stream',kind:'original'};
const binding={purpose:'session',instanceId:'a'.repeat(32),schema:1,scopeId:'uploads',recordId:'upload:file_one',seq:1,generation:1};
const masters=[];test.afterEach(()=>{for(const key of masters)key.fill(0);masters.length=0;});
test('metadata scalar validation matches old UTF8 roundtrip for every UTF16 unit and surrogate boundary pair',()=>{
 const {functionBlock}=require('../lib/source-slice'),scalar=vm.runInNewContext('('+functionBlock(code,'scalarString')+')');
 const check=value=>a.equal(scalar(value),Buffer.from(value,'utf8').toString('utf8')===value);
 for(let unit=0;unit<=0xffff;unit++)check('filename-'+String.fromCharCode(unit));
 for(let high=0xd800;high<=0xdbff;high++)for(const low of [0xdc00,0xdfff]){const pair=String.fromCharCode(high,low);for(const value of [pair,'x'+pair+'y',pair+'\ud800','\udc00'+pair])check(value);}
});
function fixture(hook){const fx=loadWorkDataChunks(),keys=[];const crypto={...fx.crypto,seal(text,key,b){keys.push(key);if(hook)hook(text,key,b);return fx.crypto.seal(text,key,b);}};const api=vm.runInNewContext(code+'\nWorkDataAttachmentChunks;',{require,Buffer,WorkDataCrypto:crypto}),key=c.randomBytes(32);masters.push(key);return{api,fx,keys,key};}
function seal(f,bytes){const writer=f.api.createWriter({key:f.key,binding,revision,metadata:meta,maxBytes:f.api.MAX_BYTES}),parts=[];for(let at=0;at<bytes.length;at+=f.api.CHUNK_BYTES)parts.push(writer.write(bytes.subarray(at,at+f.api.CHUNK_BYTES)));const data=writer.finish(),manifest=f.api.openManifest({data,key:f.key,binding,revision,maxBytes:f.api.MAX_BYTES});return{parts,data,manifest};}
for(const size of [0,1,262143,262144,262161,524291])test('draft binary format authenticates all bytes at size '+size,()=>{
 const f=fixture(),bytes=Buffer.alloc(size);for(let n=0;n<size;n++)bytes[n]=n%256;const x=seal(f,bytes),decoded=x.parts.map((part,ordinal)=>f.api.openChunk({manifest:x.manifest,ordinal,data:part.data,key:f.key}));
 a.deepEqual(Buffer.concat(decoded),bytes);a.equal(f.api.verifyComplete(x.manifest,decoded),true);a.equal(x.manifest.sha256,sha(bytes));a.equal(x.manifest.metadata.logicalName,meta.logicalName);a(!x.data.includes(Buffer.from(meta.logicalName)));a(Object.isFrozen(x.manifest)&&Object.isFrozen(x.manifest.chunks));for(const key of f.keys)a(key.every(v=>v===0));a(f.key.some(v=>v!==0));for(const part of decoded)part.fill(0);f.key.fill(0);
});
test('draft range selection covers only required chunks at boundaries',()=>{const f=fixture(),x=seal(f,Buffer.alloc(f.api.CHUNK_BYTES+17,255));a.deepEqual(Array.from(f.api.selectChunks(x.manifest,0,0)),[]);a.deepEqual(Array.from(f.api.selectChunks(x.manifest,0,1)),[0]);a.deepEqual(Array.from(f.api.selectChunks(x.manifest,262140,262148)),[0,1]);a.deepEqual(Array.from(f.api.selectChunks(x.manifest,262144,262161)),[1]);for(const range of [[-1,1],[2,1],[0,262162],[NaN,1],[0,Infinity]])a.throws(()=>f.api.selectChunks(x.manifest,...range),/range/);});
for(const kind of ['cipher','truncate','wrong-key','wrong-revision','wrong-record','swap'])test('draft binary refuses '+kind,()=>{
 const f=fixture(),x=seal(f,Buffer.alloc(f.api.CHUNK_BYTES+17,7));
 if(kind==='wrong-key')a.throws(()=>f.api.openManifest({data:x.data,key:c.randomBytes(32),binding,revision,maxBytes:f.api.MAX_BYTES}));
 else if(kind==='wrong-revision')a.throws(()=>f.api.openManifest({data:x.data,key:f.key,binding,revision:'c'.repeat(32),maxBytes:f.api.MAX_BYTES}));
 else if(kind==='wrong-record')a.throws(()=>f.api.openManifest({data:x.data,key:f.key,binding:{...binding,recordId:'upload:other'},revision,maxBytes:f.api.MAX_BYTES}));
 else {const data=kind==='swap'?x.parts[1].data:Buffer.from(x.parts[0].data);if(kind==='cipher')data[20]^=1;const actual=kind==='truncate'?data.subarray(0,-1):data;a.throws(()=>f.api.openChunk({manifest:x.manifest,ordinal:0,data:actual,key:f.key}),/chunk_changed/);}
});
test('draft rejects partial/reordered whole verification and cloned or released manifests',()=>{const f=fixture(),x=seal(f,Buffer.alloc(f.api.CHUNK_BYTES+17,4)),parts=x.parts.map((p,ordinal)=>f.api.openChunk({manifest:x.manifest,ordinal,data:p.data,key:f.key}));a.throws(()=>f.api.verifyComplete(x.manifest,[parts[0]]),/whole_changed/);a.throws(()=>f.api.verifyComplete(x.manifest,[parts[1],parts[0]]),/whole_changed/);a.throws(()=>f.api.selectChunks({...x.manifest},0,1),/manifest_unavailable/);f.api.release(x.manifest);a.throws(()=>f.api.openChunk({manifest:x.manifest,ordinal:0,data:x.parts[0].data,key:f.key}),/manifest_unavailable/);for(const p of parts)p.fill(0);});
test('draft writer clears owned master on abort and never clears caller master',()=>{const f=fixture(),w=f.api.createWriter({key:f.key,binding,revision,metadata:meta,maxBytes:f.api.MAX_BYTES});w.write(Buffer.alloc(f.api.CHUNK_BYTES));a.throws(()=>w.write(Buffer.alloc(f.api.CHUNK_BYTES+1)),/chunk_limit/);a(f.keys[0].every(v=>v===0));a(f.key.some(v=>v!==0));a.throws(()=>w.finish(),/writer_closed/);});
test('draft never coerces hostile ordinal, revision, metadata getter or proxy',()=>{const f=fixture(),x=seal(f,Buffer.from([0,255]));let traps=0;const ordinal={toString(){traps++;return'0';}},revisionObject={toString(){traps++;return revision;}},getter=Object.defineProperty({...meta},'logicalName',{get(){traps++;return'bad';}}),proxy=new Proxy(meta,{ownKeys(){traps++;return[];}});a.throws(()=>f.api.openChunk({manifest:x.manifest,ordinal,data:x.parts[0].data,key:f.key}));for(const metadata of [getter,proxy])a.throws(()=>f.api.createWriter({key:f.key,binding,revision,metadata,maxBytes:f.api.MAX_BYTES}));a.throws(()=>f.api.createWriter({key:f.key,binding,revision:revisionObject,metadata:meta,maxBytes:f.api.MAX_BYTES}));a.equal(traps,0);});
test('draft part names cannot accept traversal, negative or out-of-range ordinals',()=>{const f=fixture();a.equal(f.api.partName(0),'part-000000.json');for(const value of ['../escape',-1,NaN,1024,{}])a.throws(()=>f.api.partName(value),/ordinal/);});

for(const stage of ['write','finish'])for(const primary of [undefined,null,false,0,'',Error('seal primary')])test('draft preserves '+stage+' primary '+String(primary)+' when key erasure also fails',()=>{
 let clears=0;const cleanup=Error('key erasure failed'),f=fixture((text,key,b)=>{
   Object.defineProperty(key,'fill',{value(){clears++;throw cleanup;},configurable:true});
   if(stage==='write'||b.recordId.startsWith('blob-manifest:'))throw primary;
 }),w=f.api.createWriter({key:f.key,binding,revision,metadata:meta,maxBytes:f.api.MAX_BYTES});
 if(stage==='finish')w.write(Buffer.alloc(f.api.CHUNK_BYTES));
 let caught=false;try{stage==='write'?w.write(Buffer.from([1])):w.finish();}catch(error){caught=true;a.equal(error.code,'work_data_blob.cleanup');a.equal(error.cleanupFailed,true);a.equal(error.keyClearUnproven,true);a.equal(error.ownershipRetained,true);a.equal(error.errors.length,2);a.equal(error.errors[0],primary);a.equal(error.errors[1],cleanup);a.equal(error.cause,primary);}
 a.equal(caught,true);a.equal(clears,1);a.throws(()=>w.dispose(),error=>error.errors.length===1&&error.errors[0]===cleanup&&error.keyClearUnproven===true);a.throws(()=>w.finish(),error=>error.errors.length===1&&error.errors[0]===cleanup&&error.keyClearUnproven===true);a.equal(clears,1);a(f.key.some(v=>v!==0));
 for(const key of f.keys)Buffer.prototype.fill.call(key,0);
});
for(const stage of ['finish','dispose','limit'])test('draft refuses successful '+stage+' when private key erasure fails',()=>{
 let clears=0;const f=fixture((text,key)=>Object.defineProperty(key,'fill',{value(){clears++;throw false;},configurable:true})),w=f.api.createWriter({key:f.key,binding,revision,metadata:meta,maxBytes:f.api.MAX_BYTES});w.write(Buffer.alloc(f.api.CHUNK_BYTES));
 a.throws(()=>stage==='finish'?w.finish():stage==='dispose'?w.dispose():w.write(Buffer.alloc(f.api.CHUNK_BYTES+1)),error=>{a.equal(error.code,'work_data_blob.cleanup');a.equal(error.errors.at(-1),false);a.equal(error.keyClearUnproven,true);if(stage==='limit')a.match(error.errors[0].message,/chunk_limit/);return true;});
 a.equal(clears,1);a.throws(()=>w.dispose(),error=>error.cleanupFailed===true);a.throws(()=>w.finish(),error=>error.keyClearUnproven===true&&error.errors[0]===false);a.equal(clears,1);for(const key of f.keys)Buffer.prototype.fill.call(key,0);
});

test('draft normally closed writer keeps writer_closed refusal without cleanup uncertainty',()=>{const f=fixture(),w=f.api.createWriter({key:f.key,binding,revision,metadata:meta,maxBytes:f.api.MAX_BYTES});w.finish();a.throws(()=>w.finish(),error=>error.code==='work_data_blob.writer_closed'&&!error.cleanupFailed);w.dispose();a.throws(()=>w.finish(),error=>error.code==='work_data_blob.writer_closed'&&!error.keyClearUnproven);});

test('draft binding hash pins an explicit field order',()=>{
 const f=fixture(),bytes=Buffer.from([7,8,9]),ordered={...binding},shuffled={generation:binding.generation,seq:binding.seq,recordId:binding.recordId,scopeId:binding.scopeId,schema:binding.schema,instanceId:binding.instanceId,purpose:binding.purpose};
 a.notDeepEqual(Object.keys(ordered),Object.keys(shuffled));
 const writer=f.api.createWriter({key:f.key,binding:shuffled,revision,metadata:meta,maxBytes:f.api.MAX_BYTES}),part=writer.write(bytes),data=writer.finish();
 const manifest=f.api.openManifest({data,key:f.key,binding:ordered,revision,maxBytes:f.api.MAX_BYTES});
 a.equal(manifest.bindingHash,sha(JSON.stringify([binding.purpose,binding.instanceId,binding.schema,binding.scopeId,binding.recordId,binding.seq,binding.generation])));
 const decoded=f.api.openChunk({manifest,ordinal:0,data:part.data,key:f.key});a.deepEqual(decoded,bytes);decoded.fill(0);f.key.fill(0);
});

for(const [field,value]of [['seq',2],['scopeId','other-uploads'],['instanceId','c'.repeat(32)],['generation',2],['schema',2],['purpose','cache']])test('draft authenticates expected binding '+field,()=>{
 const f=fixture(),x=seal(f,Buffer.from([0,255]));a.throws(()=>f.api.openManifest({data:x.data,key:f.key,binding:{...binding,[field]:value},revision,maxBytes:f.api.MAX_BYTES}));
});
test('draft rejects authenticated malformed manifests and a false whole digest',()=>{
 const f=fixture(),x=seal(f,Buffer.from([0,255])),base=Object.fromEntries(Object.entries(binding).sort(([a],[b])=>a.localeCompare(b))),ctx={...base,recordId:'blob-manifest:'+sha(binding.recordId+'\0'+revision),seq:1};
 const {workData,...container}=JSON.parse(x.data.toString('utf8'));a.equal(workData,2);const original=JSON.parse(f.fx.crypto.open(container,f.key,ctx));
 const encode=value=>Buffer.from(JSON.stringify({workData:2,...f.fx.crypto.seal(JSON.stringify(value),f.key,ctx)}));
 const variants=[{...original,count:2},{...original,totalBytes:3},{...original,chunkBytes:1},{...original,revision:'c'.repeat(32)},{...original,bindingHash:'0'.repeat(64)},{...original,metadata:{...meta,kind:'unknown'}},{...original,chunks:[{...original.chunks[0],ordinal:1}]},{...original,chunks:[{...original.chunks[0],physicalBytes:f.api.MAX_CARRIER+1}]},{...original,extra:true}];
 for(const value of variants)a.throws(()=>f.api.openManifest({data:encode(value),key:f.key,binding,revision,maxBytes:f.api.MAX_BYTES}));
 const manifest=f.api.openManifest({data:encode({...original,sha256:'0'.repeat(64)}),key:f.key,binding,revision,maxBytes:f.api.MAX_BYTES}),part=f.api.openChunk({manifest,ordinal:0,data:x.parts[0].data,key:f.key});
 try{a.deepEqual(part,Buffer.from([0,255]));a.throws(()=>f.api.verifyComplete(manifest,[part]),/whole_changed/);}finally{part.fill(0);}
});
