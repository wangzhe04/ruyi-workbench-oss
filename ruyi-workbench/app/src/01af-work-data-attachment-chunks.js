// Isolated format draft. No filesystem, key creation, migration or consumer wiring.
// Manifest brands attest crypto parsing only; they never grant IO/delete authority.
const WorkDataAttachmentChunks = ((cryptoApi) => {
  const CHUNK_BYTES=256*1024, MAX_BYTES=256*1024*1024, MAX_CHUNKS=MAX_BYTES/CHUNK_BYTES, MAX_CARRIER=2*1024*1024;
  const issued=new WeakMap(),hex=/^[a-f0-9]{64}$/,revisionPattern=/^[a-f0-9]{32}$/;
  const fail=suffix=>{throw Object.assign(Error('work_data_blob.'+suffix),{code:'work_data_blob.'+suffix});};
  const sha=bytes=>cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const buffer=value=>!require('node:util').types.isProxy(value)&&Buffer.isBuffer(value);
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  const own=(value,fields)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||require('node:util').types.isProxy(value))fail('shape');
    const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
    if(names.some(name=>typeof name!=='string'))fail('shape');
    if(names.sort().join(',')!==fields.split(',').sort().join(',')||names.some(name=>!Object.hasOwn(descriptors[name],'value')))fail('shape');
    return Object.fromEntries(names.map(name=>[name,descriptors[name].value]));
  };
  const cap=value=>{if(!Number.isSafeInteger(value)||value<1||value>MAX_BYTES)fail('limit_invalid');return value;};
  function bindingOf(value){
    const b=own(value,'purpose,instanceId,schema,scopeId,recordId,seq,generation');
    for(const name of ['instanceId','scopeId','recordId'])if(typeof b[name]!=='string'||!b[name].length||b[name].length>160||!/^[A-Za-z0-9_.:-]+$/.test(b[name]))fail('binding');
    if(!WorkDataCrypto.PURPOSES.includes(b.purpose)||!integer(b.schema)||!integer(b.seq)||!Number.isSafeInteger(b.generation)||b.generation<1||b.generation>99)fail('binding');
    return Object.freeze(b);
  }
  // Pin an explicit field order for the binding hash. own() already returns a
  // key-sorted object, but hashing an array keeps the manifest's binding
  // identity independent of that helper's ordering detail.
  const bindingText=b=>JSON.stringify([b.purpose,b.instanceId,b.schema,b.scopeId,b.recordId,b.seq,b.generation]);
  // Validate the same UTF-16 scalar sequence without allocating temporary
  // plaintext filename bytes. Lone surrogates fail the old UTF8 roundtrip too.
  function scalarString(value){
    for(let n=0;n<value.length;n++){
      const unit=value.charCodeAt(n);
      if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(++n);if(!(next>=0xdc00&&next<=0xdfff))return false;}
      else if(unit>=0xdc00&&unit<=0xdfff)return false;
    }
    return true;
  }
  function metadataOf(value){
    const v=own(value,'logicalName,mime,kind');
    if(typeof v.logicalName!=='string'||!v.logicalName.length||v.logicalName.length>200||/[\x00-\x1f]/.test(v.logicalName)||!scalarString(v.logicalName)
      ||typeof v.mime!=='string'||v.mime.length>128||!/^[-A-Za-z0-9.+]+\/[-A-Za-z0-9.+]+$/.test(v.mime)
      ||!['original','tool-image','send-derivative'].includes(v.kind))fail('metadata');
    return Object.freeze(v);
  }
  function context(base,revision,kind,ordinal=0){return{...base,recordId:'blob-'+kind+':'+sha(base.recordId+'\0'+revision),seq:kind==='manifest'?1:ordinal+1};}
  const partName=ordinal=>{if(!integer(ordinal)||ordinal>=MAX_CHUNKS)fail('ordinal');return'part-'+String(ordinal).padStart(6,'0')+'.json';};
  function encode(plain,key,binding){return Buffer.from(JSON.stringify({workData:2,...WorkDataCrypto.seal(plain,key,binding)}),'utf8');}
  function decode(bytes,key,binding){
    if(!buffer(bytes)||bytes.length>MAX_CARRIER)fail('carrier_limit');
    const raw=bytes.toString('utf8');if(!Buffer.from(raw,'utf8').equals(bytes))fail('carrier_utf8');
    let parsed;try{parsed=JSON.parse(raw);}catch{fail('carrier');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.workData!==2)fail('carrier');
    const{workData,...container}=parsed;return WorkDataCrypto.open(container,key,binding);
  }
  function createWriter({key,binding,revision,metadata,maxBytes}={}){
    const base=bindingOf(binding),meta=metadataOf(metadata),maximum=cap(maxBytes);
    if(typeof revision!=='string'||!revisionPattern.test(revision))fail('revision');
    if(!buffer(key)||key.length!==32)fail('key');
    const rows=[],digest=cryptoApi.createHash('sha256');let total=0,short=false,closed=false,material=Buffer.from(key),cleanupFailed=false,cleanupFailure;
    const close=(primary,failed=false)=>{
      if(!closed){
        closed=true;
        try{if(material)material.fill(0);}catch(error){cleanupFailed=true;cleanupFailure=error;}
        finally{material=null;rows.length=0;}
      }
      // Failure is sticky: a repeated dispose cannot turn unproven key erasure into success.
      if(cleanupFailed)throw Object.assign(new AggregateError([...(failed?[primary]:[]),cleanupFailure],'work_data_blob.cleanup',{cause:failed?primary:cleanupFailure}),{
        code:'work_data_blob.cleanup',cleanupFailed:true,ownershipRetained:true,keyClearUnproven:true,
      });
      if(failed)throw primary;
    };
    return Object.freeze({
      write(bytes){
        try {
        if(closed)fail('writer_closed');
        if(!buffer(bytes)||!bytes.length||bytes.length>CHUNK_BYTES||short||rows.length>=MAX_CHUNKS||total+bytes.length>maximum)fail('chunk_limit');
        const ordinal=rows.length,data=encode(Buffer.prototype.toString.call(bytes,'base64'),material,context(base,revision,'chunk',ordinal));
        const row=Object.freeze({ordinal,bytes:bytes.length,sha256:sha(bytes),physicalBytes:data.length,physicalSha256:sha(data)});
        digest.update(bytes);total+=bytes.length;short=bytes.length<CHUNK_BYTES;rows.push(row);
        return Object.freeze({name:partName(ordinal),data}); // Caller owns/clears ciphertext Buffer.
        }catch(error){close(error,true);}
      },
      finish(){
        if(closed){close();fail('writer_closed');}
        let result,failed=false,primary;
        try {
        const manifest={type:'attachment-chunks-v1',schema:1,revision,bindingHash:sha(bindingText(base)),metadata:meta,chunkBytes:CHUNK_BYTES,totalBytes:total,sha256:digest.digest('hex'),count:rows.length,chunks:rows};
        result=encode(JSON.stringify(manifest),material,context(base,revision,'manifest'));
        }catch(error){failed=true;primary=error;}
        close(primary,failed);return result;
      },
      dispose(){close();},
    });
  }
  function openManifest({data,key,binding,revision,maxBytes}={}){
    const base=bindingOf(binding),maximum=cap(maxBytes);if(typeof revision!=='string'||!revisionPattern.test(revision))fail('revision');
    const plain=decode(data,key,context(base,revision,'manifest'));let v;try{v=JSON.parse(plain);}catch{fail('manifest');}
    const m=own(v,'type,schema,revision,bindingHash,metadata,chunkBytes,totalBytes,sha256,count,chunks');
    if(m.type!=='attachment-chunks-v1'||m.schema!==1||m.revision!==revision||m.bindingHash!==sha(bindingText(base))||m.chunkBytes!==CHUNK_BYTES
      ||!integer(m.totalBytes)||m.totalBytes>maximum||typeof m.sha256!=='string'||!hex.test(m.sha256)||!integer(m.count)||m.count>MAX_CHUNKS||m.count!==Math.ceil(m.totalBytes/CHUNK_BYTES)||!Array.isArray(m.chunks)||m.chunks.length!==m.count)fail('manifest');
    const metadata=metadataOf(m.metadata);let total=0;
    const chunks=m.chunks.map((entry,ordinal)=>{
      const row=own(entry,'ordinal,bytes,sha256,physicalBytes,physicalSha256');
      if(row.ordinal!==ordinal||!integer(row.bytes)||row.bytes<1||row.bytes>CHUNK_BYTES||ordinal+1<m.count&&row.bytes!==CHUNK_BYTES||typeof row.sha256!=='string'||!hex.test(row.sha256)
        ||!integer(row.physicalBytes)||row.physicalBytes<1||row.physicalBytes>MAX_CARRIER||typeof row.physicalSha256!=='string'||!hex.test(row.physicalSha256))fail('manifest_chunk');
      total+=row.bytes;return Object.freeze(row);
    });
    if(total!==m.totalBytes||!m.count&&m.sha256!==sha(Buffer.alloc(0)))fail('manifest');
    const result=Object.freeze({...m,metadata,chunks:Object.freeze(chunks)});issued.set(result,{base,revision});return result;
  }
  function current(manifest){const state=issued.get(manifest);if(!state)fail('manifest_unavailable');return state;}
  function selectChunks(manifest,start,end){
    current(manifest);if(!integer(start)||!integer(end)||start>end||end>manifest.totalBytes)fail('range');
    if(start===end)return Object.freeze([]);
    return Object.freeze(Array.from({length:Math.floor((end-1)/CHUNK_BYTES)-Math.floor(start/CHUNK_BYTES)+1},(_,n)=>n+Math.floor(start/CHUNK_BYTES)));
  }
  function openChunk({manifest,ordinal,data,key}={}){
    const state=current(manifest);if(!integer(ordinal)||ordinal>=manifest.count)fail('chunk_changed');const row=manifest.chunks[ordinal];
    if(!buffer(data)||data.length!==row.physicalBytes||sha(data)!==row.physicalSha256)fail('chunk_changed');
    const encoded=decode(data,key,context(state.base,state.revision,'chunk',ordinal));
    if(encoded.length!==4*Math.ceil(row.bytes/3)||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))fail('chunk_encoding');
    const bytes=Buffer.from(encoded,'base64');
    try{if(bytes.length!==row.bytes||bytes.toString('base64')!==encoded||sha(bytes)!==row.sha256)fail('chunk_changed');return bytes;}
    catch(error){bytes.fill(0);throw error;}
  }
  function verifyComplete(manifest,parts){
    current(manifest);const digest=cryptoApi.createHash('sha256');let count=0,total=0;
    for(const bytes of parts){const row=manifest.chunks[count++];if(!row||!buffer(bytes)||bytes.length!==row.bytes||sha(bytes)!==row.sha256)fail('whole_changed');digest.update(bytes);total+=bytes.length;}
    if(count!==manifest.count||total!==manifest.totalBytes||digest.digest('hex')!==manifest.sha256)fail('whole_changed');return true;
  }
  return Object.freeze({createWriter,openManifest,openChunk,selectChunks,verifyComplete,partName,release:manifest=>{issued.delete(manifest);},CHUNK_BYTES,MAX_BYTES,MAX_CARRIER});
})(require('node:crypto'));
