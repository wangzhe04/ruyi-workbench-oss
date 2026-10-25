// Complete message-source shards; source authority and disclosure remain with
// the existing session/storage/privacy owners. No embeddings or corpus sampling.
const SessionFullTextIndex = ((io,p,c) => {
  const FORMAT=3,SCHEMA=1,CHARS=4096,OVERLAP=256,SHARD_BYTES=256*1024,MANIFEST_BYTES=4*1024*1024;
  const HEX=/^[a-f0-9]{64}$/,GEN=/^[a-f0-9]{32}$/;
  const NORMALIZER='fullfield-nfkc-upper-nfkc-space/v1;unicode='+process.versions.unicode+';icu='+process.versions.icu+';v8='+process.versions.v8;
  const fail=suffix=>Object.assign(Error('session_fulltext.'+suffix),{code:'session_fulltext.'+suffix,apiCode:'session_fulltext.'+suffix,statusCode:409});
  const hash=value=>c.createHash('sha256').update(value).digest('hex');
  const digest=value=>hash(JSON.stringify(value));
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value)&&!value.startsWith('_');
  const clone=value=>JSON.parse(JSON.stringify(value));
  const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
  // The payload format is independent from the encrypted Store schema/AAD.
  // Array fields retain their own original UTF-16 coordinate spaces; no JSON
  // serialization, joined preview, or fabricated message offsets become text.
  function inspectSources(row){
    const parts=[];let unverified=false;
    const array=(value,field)=>{if(!Array.isArray(value)){if(value!=null)unverified=true;return;}
      value.forEach((part,n)=>{if(typeof part==='string')parts.push({field:field+'.'+n,text:part});
        else if(part&&typeof part==='object'&&!Array.isArray(part)&&typeof part.text==='string')parts.push({field:field+'.'+n+'.text',text:part.text});
        else unverified=true;});};
    if(typeof row.content==='string')parts.push({field:'content',text:row.content});else if(row.content!=null)array(row.content,'content');
    if(row.blocks!=null)array(row.blocks,'blocks');
    if(Array.isArray(row.segments))row.segments.forEach((segment,n)=>{if(typeof segment?.text==='string')parts.push({field:'segments.'+n+'.text',text:segment.text});});
    if(Array.isArray(row.attachments))row.attachments.forEach((attachment,n)=>{for(const field of ['textPreview','transcript','ocrText'])if(typeof attachment?.[field]==='string')parts.push({field:'attachments.'+n+'.'+field,text:attachment[field],attachment:true});});
    return {parts,unverified};
  }
  const sources=row=>inspectSources(row).parts;
  // FORMAT3 windows are canonical units, with bounded origin runs. A single
  // original grapheme can span many windows without ever storing its raw text
  // as an oversized shard row or allocating one mapping slot per original unit.
  // Compatibility decomposition can join ORIGINAL grapheme boundaries (for
  // example Hangul compatibility jamo). Retain the final already-canonical
  // output grapheme and normalize its boundary with the next source unit before
  // emitting any stable prefix. Expanded units retain their entire raw origin.
  function* canonicalGroups(text){
    let tail=null;
    for(const part of segmenter.segment(text)){const incoming=canonicalText(part.segment),boundary=tail?tail.text.length:0,joined=(tail?tail.text:'')+incoming;let next=null;
      for(const unit of segmenter.segment(joined)){const from=unit.index<boundary?tail.from:part.index,to=unit.index+unit.segment.length>boundary?part.index+part.segment.length:tail.to;
        for(const normalized of segmenter.segment(canonicalText(unit.segment))){if(next)yield next;next={text:normalized.segment,from,to,linear:normalized.segment.length===1&&to-from===1};}
      }
      tail=next;
    }
    if(tail)yield tail;
  }
  function* canonicalPieces(text){
    let whitespace=null;
    function* asciiParts(){for(let index=0;index<text.length;index+=CHARS)yield {text:text.slice(index,index+CHARS).toUpperCase(),from:index,to:Math.min(text.length,index+CHARS),linear:true};}
    const parts=/^[\x00-\x7f]*$/.test(text)?asciiParts():canonicalGroups(text);
    for(const part of parts){const matcher=/\s+|\S+/gu;let match;
      while((match=matcher.exec(part.text))){const blank=/^\s/u.test(match[0]),linear=part.linear,from=linear?part.from+match.index:part.from,to=linear?from+match[0].length:part.to;
        if(blank){if(whitespace)whitespace.to=to;else whitespace={from,to};continue;}
        if(whitespace){yield {text:' ',from:whitespace.from,to:whitespace.to,linear:false};whitespace=null;}
        yield {text:match[0],from,to,linear};
      }
    }
    if(whitespace)yield {text:' ',from:whitespace.from,to:whitespace.to,linear:false};
  }
  function rangeAt(ranges,position){for(const run of ranges)if(position>=run[0]&&position<run[0]+run[1])return run.length===3?{from:run[2]+position-run[0],to:run[2]+position-run[0]+1}:{from:run[2],to:run[3]};throw fail('shard_invalid');}
  function* slices(text){
    let buffer='',ranges=[],absolute=0,lastYield=0;
    const append=(value,from,to,linear)=>{const at=buffer.length,prior=ranges[ranges.length-1];buffer+=value;
      if(prior&&prior[0]+prior[1]===at&&prior.length===(linear?3:4)&&(linear?prior[2]+prior[1]===from:prior[2]===from&&prior[3]===to))prior[1]+=value.length;
      else ranges.push(linear?[at,value.length,from]:[at,value.length,from,to]);
    };
    const selected=end=>ranges.filter(run=>run[0]<end).map(run=>[run[0],Math.min(run[1],end-run[0]),...run.slice(2)]);
    const window=end=>{const chosen=selected(end),start=rangeAt(chosen,0).from,finish=rangeAt(chosen,end-1).to;lastYield=absolute+end;return{canonicalStart:absolute,start,end:finish,text:buffer.slice(0,end),ranges:chosen};};
    const drop=count=>{buffer=buffer.slice(count);ranges=ranges.filter(run=>run[0]+run[1]>count).map(run=>{const begin=Math.max(run[0],count),length=run[0]+run[1]-begin;return run.length===3?[begin-count,length,run[2]+begin-run[0]]:[begin-count,length,run[2],run[3]];});absolute+=count;};
    for(const part of canonicalPieces(text)){for(let offset=0;offset<part.text.length;){const count=Math.min(CHARS+1-buffer.length,part.text.length-offset),value=part.text.slice(offset,offset+count);append(value,part.linear?part.from+offset:part.from,part.linear?part.from+offset+count:part.to,part.linear);offset+=count;
        if(buffer.length>CHARS){let end=CHARS;if(/[\uDC00-\uDFFF]/.test(buffer[end]))end--;yield window(end);let count=end-OVERLAP;if(/[\uDC00-\uDFFF]/.test(buffer[count]))count--;drop(count);}
      }}
    if(buffer.length&&absolute+buffer.length>lastYield)yield window(buffer.length);
  }
  function rangesValid(row){let at=0,priorFrom=-1,priorTo=-1;if(!Array.isArray(row.ranges)||!row.ranges.length||row.ranges.length>CHARS)return false;
    for(const run of row.ranges){if(!Array.isArray(run)||![3,4].includes(run.length)||run.some(value=>!integer(value))||run[0]!==at||run[1]===0)return false;const from=run[2],to=run.length===3?from+run[1]:run[3];if(!integer(to)||from<row.start||to>row.end||to<=from||from<priorFrom||to<priorTo)return false;priorFrom=from;priorTo=to;at+=run[1];}
    return at===row.text.length&&rangeAt(row.ranges,0).from===row.start&&rangeAt(row.ranges,at-1).to===row.end;
  }
  const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
  // Default uppercase has no word-final lowercase context. Normalize after
  // expansion as well, so composed/decomposed case-equivalent inputs agree.
  const canonicalText=text=>text.normalize('NFKC').toUpperCase().normalize('NFKC');
  function folded(text){
    let value='';const from=[],to=[];
    // ASCII has no compatibility expansion or grapheme joins except CRLF.
    // Compute its complete canonical string once, then only map raw ranges.
    if(/^[\x00-\x7f]*$/.test(text)){
      value=text.toUpperCase().replace(/\s+/g,' ');from.length=value.length;to.length=value.length;
      if(!/[\t\n\v\f\r ]/.test(text)){for(let index=0;index<text.length;index++){from[index]=index;to[index]=index+1;}return {value,from,to};}
      let output=0,space=false;for(let index=0;index<text.length;){const start=index,code=text.charCodeAt(index),width=code===13&&text.charCodeAt(index+1)===10?2:1;index+=width;
        const whitespace=code===32||code>=9&&code<=13;if(whitespace&&space)continue;space=whitespace;from[output]=start;to[output++]=index;
      }
      return {value,from,to};
    }
    for(const part of segmenter.segment(text))for(const letter of canonicalText(part.segment)){
      const normalized=/\s/.test(letter)?' ':letter;if(normalized===' '&&value.endsWith(' '))continue;
      value+=normalized;for(let n=0;n<normalized.length;n++){from.push(part.index);to.push(part.index+part.segment.length);}
    }
    return {value,from,to};
  }
  const normalize=text=>canonicalText(text).replace(/\s+/g,' ');
  function create(host){
    if(!host||['validSessionId','root','enabled','writeJson','catalog','epoch','scan','scope','authorize','assertAuthorized','project','assertScope','sourceSequence','noise','terms'].some(name=>typeof host[name]!=='function'))throw fail('host_invalid');
    const sessionResults=host.resultUnit==='sessions';
    const canonical=id;const valid=value=>canonical(value)&&host.validSessionId(value)===value;
    // Only authenticated/readable manifest plaintext with invalid JSON can be
    // rebuilt as a missing derived pointer. A private symbol cannot be forged
    // by valid JSON and never softens key, schema, namespace or shard failures.
    const malformedManifest=Symbol('malformed-derived-manifest');
    let chain=Promise.resolve(),paused=false,building=false;
    const run=work=>{const pending=chain.catch(()=>{}).then(work);chain=pending;return pending;};
    const pathKey=value=>process.platform==='win32'?p.resolve(value).toLowerCase():p.resolve(value);
    async function namespace(sid,name=null,max=null){
      const directories=[host.root(),p.join(host.root(),'_fulltext-index-v1'),...(sid?[p.dirname(pathFor(sid,'manifest.json'))]:[])];
      for(const directory of directories){let stat;try{stat=await io.lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
        if(!stat.isDirectory()||stat.isSymbolicLink()||pathKey(await io.realpath(directory))!==pathKey(directory))throw fail('owned_namespace_changed');
      }
      if(name){let stat;try{stat=await io.lstat(pathFor(sid,name));}catch(error){if(error.code==='ENOENT')return;throw error;}
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fail('owned_namespace_changed');
        if(max!==null&&(!Number.isSafeInteger(stat.size)||stat.size>max*2+65536))throw fail('capacity');
      }
    }
    const pathFor=(sid,name)=>p.join(host.root(),'_fulltext-index-v1',...(sid?[sid]:[]),name);
    const storage=(sid,name,max=SHARD_BYTES,policy=undefined)=>WorkDataStore.createText({file:()=>pathFor(sid,name),purpose:'search-index',schema:SCHEMA,scopeId:'sessions',recordId:'fulltext-index:'+(sid?sid+':':'')+name.replace(/\.json$/,''),chunked:true,maxPlaintextBytes:max,keys:host.keys,enabled:policy===undefined?host.enabled:()=>policy,writeJson:host.writeJson});
    const read=async(sid,name,max)=>{try{await namespace(sid,name,max);const text=await storage(sid,name,max).read();if(Buffer.byteLength(text)>max)throw fail('capacity');let value;try{value=JSON.parse(text);}catch{if(sid&&name==='manifest.json')return malformedManifest;throw fail('record_invalid');}return value;}catch(error){if(error.code==='ENOENT')return null;throw error;}};
    const write=async(sid,name,value,max,policy=undefined)=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>max)throw fail('capacity');if(policy!==undefined&&await host.enabled()!==policy)throw fail('policy_changed');await namespace(sid,name,max);await storage(sid,name,max,policy).write(text);};
    function manifest(value,sid){
      if(!value)return null;
      const shape=keys(value),legacy=shape==='attachments,chunks,epoch,generation,messages,schema,sessionId,shards,sourceRevision',obsolete=shape==='attachments,chunks,epoch,format,generation,messages,schema,sessionId,shards,sourceRevision'&&[1,2].includes(value.format),current=shape==='attachments,chunks,epoch,format,generation,messages,normalizer,schema,sessionId,shards,sourceRevision'&&value.format===FORMAT&&typeof value.normalizer==='string'&&value.normalizer.length>0&&value.normalizer.length<=512;
      if((!legacy&&!obsolete&&!current)||value.schema!==SCHEMA||value.sessionId!==sid||!HEX.test(value.epoch||'')||!HEX.test(value.sourceRevision||'')||!GEN.test(value.generation||'')
        ||!integer(value.messages)||!integer(value.attachments)||!integer(value.chunks)||!Array.isArray(value.shards)||value.shards.length>100000
        ||value.shards.some((row,n)=>keys(row)!=='ordinal,records,sha256'||row.ordinal!==n||!HEX.test(row.sha256||'')||!integer(row.records)||row.records===0||row.records>64))throw fail('manifest_invalid');
      return legacy?{...value,format:1}:value;
    }
    const compatible=value=>value?.format===FORMAT&&value.normalizer===NORMALIZER;
    const currentManifest=async sid=>{const value=await read(sid,'manifest.json',MANIFEST_BYTES);return value===malformedManifest?value:manifest(value,sid);};
    const retired=async(sid,selected)=>{
      const current=await currentManifest(sid);if(!current||!compatible(current)||current.generation!==selected.generation)return true;
      return await host.epoch(sid)!==selected.epoch;
    };
    const state=phase=>write(null,'state.json',{schema:SCHEMA,phase},1024);
    const checkPaused=()=>{if(paused)throw fail('paused');};
    async function removeOwned(sid,names){for(const name of names){try{await io.unlink(pathFor(sid,name));}catch(error){if(error.code!=='ENOENT')throw error;}}}
    async function ownedNames(sid){
      if(!valid(sid))throw fail('session_invalid');await namespace(sid);const directory=p.dirname(pathFor(sid,'manifest.json'));let names;
      try{names=await io.readdir(directory);}catch(error){if(error.code==='ENOENT')return null;throw error;}
      if(names.length>100000||names.some(name=>name!=='manifest.json'&&!/^[a-f0-9]{32}\.(?:0|[1-9][0-9]*)\.json$/.test(name)))throw fail('owned_namespace_changed');
      for(const name of names){const stat=await io.lstat(p.join(directory,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fail('owned_namespace_changed');}
      return names;
    }
    async function purge(sid){
      const names=await ownedNames(sid);if(names===null)return;const directory=p.dirname(pathFor(sid,'manifest.json'));
      // Retire the selected generation only after validating the entire owned
      // namespace, before any immutable shard can disappear beneath its pointer.
      if(names.includes('manifest.json'))await removeOwned(sid,['manifest.json']);
      await removeOwned(sid,names.filter(name=>name!=='manifest.json'));await io.rmdir(directory);
    }
    async function purgeMissing(catalog){
      let names;try{names=await io.readdir(pathFor(null,''),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
      for(const name of names){if(name.name==='state.json'&&name.isFile()&&!name.isSymbolicLink())continue;if(!name.isDirectory()||name.isSymbolicLink()||!valid(name.name))throw fail('owned_namespace_changed');if(!catalog.includes(name.name))await purge(name.name);}
    }
    async function build(sid){
      checkPaused();const before=await host.epoch(sid);if(!HEX.test(before||''))return false;
      const prior=await currentManifest(sid);if(prior?.epoch===before&&compatible(prior))return false;
      // Validate every old owned name before building. Keep the bad pointer and
      // all old bytes until a completely verified new generation is published.
      const stale=prior===malformedManifest?await ownedNames(sid):null;
      const identities=new Set();
      const preview=await host.scan(sid,async row=>{checkPaused();if(typeof row?.id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id)){if(identities.has(row.id))throw fail('message_owner_ambiguous');identities.add(row.id);}}),policy=await host.enabled();
      if(!preview||preview.epoch!==before||!HEX.test(preview.revision||'')||typeof preview.requiresEncryption!=='boolean'||typeof policy!=='boolean')throw fail('source_invalid');
      if(preview.requiresEncryption&&policy!==true)throw fail('source_policy_conflict');
      if(await host.epoch(sid)!==before)throw fail('source_changed');
      const generation=c.randomBytes(16).toString('hex'),shards=[],owned=[];let rows=[],bytes=0,messages=0,attachments=0,chunks=0,turn=0,turnBasis='legacy-inferred',committed=false;
      const flush=async()=>{if(!rows.length)return;checkPaused();const ordinal=shards.length,name=generation+'.'+ordinal+'.json',value={schema:SCHEMA,sessionId:sid,generation,ordinal,rows},text=JSON.stringify(value);if(Buffer.byteLength(text)>SHARD_BYTES)throw fail('capacity');
        owned.push(name);await write(sid,name,value,SHARD_BYTES,policy);shards.push({ordinal,sha256:hash(text),records:rows.length});rows=[];bytes=0;};
      try{
        const proof=await host.scan(sid,async(row,ordinal)=>{
          checkPaused();if(!integer(ordinal)||!row||typeof row!=='object')throw fail('source_invalid');
          if(row.role==='user'){turn=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?row.turnSeq:turn+1;turnBasis=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?'explicit':'legacy-inferred';}
          const explicit=row.turnSeq??row.turnSummary?.turnSeq;if(Number.isSafeInteger(explicit)&&explicit>=0){turn=explicit;turnBasis='explicit';}
          messages++;attachments+=Array.isArray(row.attachments)?row.attachments.length:0;if(host.noise(row))return;
          const intrinsic=typeof row.id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id),messageId=intrinsic?row.id:'legacy-ordinal:'+ordinal,contentRevision=digest(row);let chunkOrdinal=0;
          for(const source of sources(row)){
            for(const chunk of slices(source.text)){
              checkPaused();const entry={sessionId:sid,turnSeq:turn,turnSeqBasis:turnBasis,messageId,messageIdBasis:intrinsic?'intrinsic':'physical-ordinal',contentRevision,chunkOrdinal:chunkOrdinal++,messageOrdinal:ordinal,source:source.field,coordinate:'utf16',start:chunk.start,end:chunk.end,canonicalStart:chunk.canonicalStart,text:chunk.text,ranges:chunk.ranges};
              const size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>SHARD_BYTES-4096||rows.length>=64)await flush();rows.push(entry);bytes+=size;chunks++;
            }
          }
        });
        await flush();checkPaused();if(!proof||proof.epoch!==before||!HEX.test(proof.revision||'')||proof.count!==messages||proof.revision!==preview.revision||proof.requiresEncryption!==preview.requiresEncryption||await host.epoch(sid)!==before)throw fail('source_changed');
        const value={schema:SCHEMA,format:FORMAT,normalizer:NORMALIZER,sessionId:sid,epoch:before,sourceRevision:proof.revision,generation,messages,attachments,chunks,shards};
        await write(sid,'manifest.json',value,MANIFEST_BYTES,policy);committed=true;
        if(prior===malformedManifest)await removeOwned(sid,stale.filter(name=>name!=='manifest.json'));
        else if(prior)await removeOwned(sid,prior.shards.map(row=>prior.generation+'.'+row.ordinal+'.json'));
        return true;
      }finally{if(!committed)await removeOwned(sid,owned);}
    }
    async function rawCoverage(visibility=null){
      const catalog=await host.catalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
      let complete=0,pending=0,attachmentSources=0,unverifiedMessages=0;for(const sid of catalog){if(visibility){if(await host.authorize(sid,visibility.context,visibility.access)!==true)continue;visibility.seen.add(sid);}const sequence=host.sourceSequence(sid),value=await currentManifest(sid);if(value&&compatible(value)&&value.epoch===await host.epoch(sid)){
        // Unknown/non-text array members are still unverified. Read the actual
        // committed stream and bind the count to this selected source revision.
        let unsupported=0;const proof=await host.scan(sid,async row=>{if(!host.noise(row)&&inspectSources(row).unverified)unsupported++;});
        if(!proof||proof.epoch!==value.epoch||proof.revision!==value.sourceRevision||sequence!==host.sourceSequence(sid))throw fail('source_changed');
        complete++;attachmentSources+=value.attachments;unverifiedMessages+=unsupported;
      }else pending++;if(visibility){if(sequence!==host.sourceSequence(sid))throw fail('source_changed');visibility.sequences.set(sid,sequence);}}
      return {phase:paused?'paused':building?'building':'idle',sessions:visibility?visibility.seen.size:catalog.length,indexedSessions:complete,pendingSessions:pending,complete:pending===0&&attachmentSources===0&&unverifiedMessages===0,messages:{unverifiedText:unverifiedMessages},attachments:{unverifiedFullText:attachmentSources},coverageUnit:'committed-display-message-sources',fullTextSampling:false};
    }
    async function coverage(context){
      const observed=await host.scope(context);if(keys(observed)!=='revision,scopeId'||typeof observed.scopeId!=='string'||!observed.scopeId.length||observed.scopeId.length>160||typeof observed.revision!=='string'||!HEX.test(observed.revision))throw fail('scope_invalid');const access=Object.freeze(clone(observed));
      const seen=new Set(),sequences=new Map(),value=await rawCoverage({context,access,seen,sequences});
      if(host.assertScope(context,access)!==true||[...seen].some(sid=>host.assertAuthorized(sid,context,access)!==true||host.sourceSequence(sid)!==sequences.get(sid)))throw fail('disclosure_changed');
      return value;
    }
    const step=(limit=1,context)=>run(async()=>{
      if(paused)return coverage(context);building=true;
      try{await state('building');const catalog=await host.catalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');await purgeMissing(catalog);let built=0;for(const sid of catalog){checkPaused();if(await build(sid)&&++built>=Math.min(16,Math.max(1,limit)))break;}
      }catch(error){if(error.code!=='session_fulltext.paused')throw error;}
      finally{building=false;await state(paused?'paused':'idle');}
      return coverage(context);
    });
    // The private production preparation path walks each catalog entry once.
    // Public step retains its bounded <=16 contract and original coverage result.
    const prepare=context=>run(async()=>{
      if(paused)return coverage(context);
      const observed=await host.scope(context);if(keys(observed)!=='revision,scopeId'||typeof observed.scopeId!=='string'||!observed.scopeId.length||observed.scopeId.length>160||typeof observed.revision!=='string'||!HEX.test(observed.revision))throw fail('scope_invalid');const access=Object.freeze(clone(observed));
      const assertAccess=()=>{if(host.assertScope(context,access)!==true)throw fail('disclosure_changed');};
      const finish=async()=>{assertAccess();const value=await coverage(context);assertAccess();return value;};
      if(paused)return finish();
      const check=()=>{checkPaused();assertAccess();};
      check();building=true;let failed=false,failure;
      try{
        await state('building');check();const catalog=await host.catalog();check();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
        await purgeMissing(catalog);check();let visited=0;
        for(const sid of catalog){check();await build(sid);check();if(++visited%16===0){await require('node:timers/promises').setImmediate();check();}}
      }catch(error){if(error?.code!=='session_fulltext.paused'){failed=true;failure=error;}}
      finally{building=false;}
      try{await state(paused?'paused':'idle');}catch(error){
        if(!failed)throw error;
        const own=(value,name)=>{if(value===null||typeof value!=='object'&&typeof value!=='function')return undefined;const field=Object.getOwnPropertyDescriptor(value,name);return field&&'value'in field?field.value:undefined;};
        const combined=new AggregateError([failure,error],'session_fulltext.prepare_cleanup_failed',{cause:failure});combined.code=own(failure,'code')??'session_fulltext.prepare_failed';combined.cleanupFailed=true;
        for(const name of ['apiCode','statusCode']){const value=own(failure,name);if(value!==undefined)combined[name]=value;}
        for(const name of ['helperMayStillRun','ownershipRetained','targetRetained'])if([failure,error].some(value=>own(value,name)===true))combined[name]=true;
        throw combined;
      }
      if(failed)throw failure;
      return finish();
    });
    async function search(query,context,limit=20){
      if(typeof query!=='string'||query.length<2||query.length>OVERLAP)throw fail('query_invalid');
      const observed=await host.scope(context);if(keys(observed)!=='revision,scopeId'||typeof observed.scopeId!=='string'||!observed.scopeId.length||observed.scopeId.length>160||typeof observed.revision!=='string'||!HEX.test(observed.revision))throw fail('scope_invalid');const access=Object.freeze(clone(observed));
      const terms=[...new Set(host.terms(query).filter(term=>typeof term==='string'&&!term.startsWith('#')).map(normalize))];
      const phrase=normalize(query);if(!phrase.length||phrase.length>OVERLAP||!phrase.trim())throw fail('query_invalid');
      const needed=Math.max(1,Math.ceil(terms.length/2)),cap=Math.min(50,Math.max(1,Math.floor(Number(limit)||20))),candidates=[];
      // The public consumers limit session results. A dense session gets one
      // best citation, never all of the bounded global candidate slots.
      const compare=(a,b)=>b.score-a.score||a.row.sessionId.localeCompare(b.row.sessionId)||a.row.messageOrdinal-b.row.messageOrdinal||a.row.chunkOrdinal-b.row.chunkOrdinal||a.start-b.start||a.row.source.localeCompare(b.row.source);
      const catalog=await host.catalog();if(!Array.isArray(catalog)||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
      for(const sid of catalog){
        if(!valid(sid))throw fail('catalog_invalid');if(await host.authorize(sid,context,access)!==true)continue;
        const value=await currentManifest(sid);if(!value||!compatible(value)||value.epoch!==await host.epoch(sid))continue;let best=null;
        for(const ref of value.shards){
          const shard=await read(sid,value.generation+'.'+ref.ordinal+'.json',SHARD_BYTES);if(!shard||hash(JSON.stringify(shard))!==ref.sha256||shard.schema!==SCHEMA||shard.sessionId!==sid||shard.generation!==value.generation||shard.ordinal!==ref.ordinal||!Array.isArray(shard.rows)||shard.rows.length!==ref.records){if(await retired(sid,value))break;throw fail('shard_invalid');}
          for(const row of shard.rows){
            if(keys(row)!=='canonicalStart,chunkOrdinal,contentRevision,coordinate,end,messageId,messageIdBasis,messageOrdinal,ranges,sessionId,source,start,text,turnSeq,turnSeqBasis'||row.coordinate!=='utf16'||!['explicit','legacy-inferred'].includes(row.turnSeqBasis)||!['intrinsic','physical-ordinal'].includes(row.messageIdBasis)||!(/^(?:content(?:\.\d+(?:\.text)?)?|blocks\.\d+(?:\.text)?|segments\.\d+\.text|attachments\.\d+\.(?:textPreview|transcript|ocrText))$/).test(row.source)||row.sessionId!==sid||!integer(row.messageOrdinal)||!integer(row.turnSeq)||typeof row.messageId!=='string'||row.messageId.length>256||!HEX.test(row.contentRevision||'')||!integer(row.chunkOrdinal)||!integer(row.start)||!integer(row.end)||typeof row.source!=='string'||typeof row.text!=='string'||row.end<=row.start||!integer(row.canonicalStart)||!row.text.length||row.text.length>CHARS||!rangesValid(row))throw fail('shard_invalid');
            const exact=row.text.indexOf(phrase),matched=terms.filter(term=>row.text.includes(term));if(exact<0&&matched.length<needed)continue;
            const at=exact>=0?exact:row.text.indexOf(matched[0]),width=exact>=0?phrase.length:matched[0].length;
            const start=rangeAt(row.ranges,at).from,end=rangeAt(row.ranges,at+width-1).to;if(!integer(start)||!integer(end))throw fail('shard_invalid');
            const hit={row:Object.freeze({...row,text:undefined,ranges:undefined,canonicalStart:undefined}),canonicalStart:row.canonicalStart,windowHash:digest({text:row.text,ranges:row.ranges}),at,width,epoch:value.epoch,sourceRevision:value.sourceRevision,score:(exact>=0?30:0)+matched.length,start,end};
            if(sessionResults){if(!best||compare(hit,best)<0)best=hit;}
            else{candidates.push(hit);candidates.sort((a,b)=>b.score-a.score||a.row.sessionId.localeCompare(b.row.sessionId)||a.start-b.start);if(candidates.length>cap*4)candidates.length=cap*4;}
          }
        }
        if(sessionResults&&best){candidates.push(best);candidates.sort(compare);if(candidates.length>cap)candidates.length=cap;}
      }
      const selected=new Map();for(const hit of candidates){const key=[hit.row.sessionId,hit.row.messageId,hit.row.contentRevision,hit.row.source,hit.start,hit.end].join('\0');if(!selected.has(key))selected.set(key,hit);}
      const results=[],sequences=new Map();
      for(const sid of [...new Set([...selected.values()].map(hit=>hit.row.sessionId))]){
        if(await host.authorize(sid,context,access)!==true)continue;const hits=[...selected.values()].filter(hit=>hit.row.sessionId===sid),resolved=[],retained=new Set();let retainedBytes=0;
        let sourceTurn=0,sourceTurnBasis='legacy-inferred';
        const proof=await host.scan(sid,async(row,ordinal)=>{
          if(row.role==='user'){sourceTurn=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?row.turnSeq:sourceTurn+1;sourceTurnBasis=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?'explicit':'legacy-inferred';}
          const explicit=row.turnSeq??row.turnSummary?.turnSeq;if(Number.isSafeInteger(explicit)&&explicit>=0){sourceTurn=explicit;sourceTurnBasis='explicit';}
          const revision=digest(row),parts=sources(row),intrinsic=typeof row.id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id),messageId=intrinsic?row.id:'legacy-ordinal:'+ordinal;
          for(const hit of hits.filter(hit=>hit.row.messageOrdinal===ordinal&&hit.row.contentRevision===revision)){
            const source=parts.find(part=>part.field===hit.row.source);if(!source||hit.end>source.text.length)continue;
            let proven=false,finished=false,chunkOrdinal=0;for(const part of parts){for(const window of slices(part.text)){if(part.field===source.field&&window.canonicalStart===hit.canonicalStart){proven=chunkOrdinal===hit.row.chunkOrdinal&&window.start===hit.row.start&&window.end===hit.row.end&&hit.row.messageId===messageId&&hit.row.messageIdBasis===(intrinsic?'intrinsic':'physical-ordinal')&&hit.row.turnSeq===sourceTurn&&hit.row.turnSeqBasis===sourceTurnBasis&&digest({text:window.text,ranges:window.ranges})===hit.windowHash&&rangeAt(window.ranges,hit.at).from===hit.start&&rangeAt(window.ranges,hit.at+hit.width-1).to===hit.end;finished=true;break;}chunkOrdinal++;}if(finished)break;}if(!proven)throw fail('shard_source_mismatch');
            const owner=ordinal+'\0'+source.field;if(!retained.has(owner)){retained.add(owner);retainedBytes+=Buffer.byteLength(source.text);if(retainedBytes>256*1024*1024)throw fail('projection_capacity');}
            const snippetStart=Math.max(0,hit.start-60),snippetEnd=Math.min(source.text.length,hit.end+120,snippetStart+600);
            resolved.push({hit,sourceText:source.text,text:source.text.slice(snippetStart,snippetEnd),snippetEnd,snippetTruncated:snippetEnd<Math.min(source.text.length,hit.end+120)});
          }
        });
        if(!proof||proof.epoch!==hits[0].epoch||proof.revision!==hits[0].sourceRevision||await host.epoch(sid)!==proof.epoch)continue;
        const sequence=host.sourceSequence(sid);if(typeof sequence!=='string'&&!(Number.isSafeInteger(sequence)&&sequence>=0))throw fail('source_invalid');
        for(const {hit,sourceText,text,snippetEnd,snippetTruncated}of resolved){const projected=await host.project({sourceText,text,reference:Object.freeze({...hit.row,matchStart:hit.start,matchEnd:hit.end,snippetStart:Math.max(0,hit.start-60),snippetEnd,...(snippetTruncated?{snippetTruncated:true}:{})}),start:hit.start,end:hit.end,context,access});if(keys(projected)!=='reference,snippet'||typeof projected.snippet!=='string'||Buffer.byteLength(JSON.stringify(projected))>16384)throw fail('projection_invalid');const disclosed=clone(projected);
          if(await host.authorize(sid,context,access)!==true||await host.epoch(sid)!==proof.epoch||host.sourceSequence(sid)!==sequence)continue;
          results.push({...disclosed,score:hit.score});sequences.set(sid,sequence);
        }
      }
      const covered=new Set(),coverageSequences=new Map(),coverageState=await rawCoverage({context,access,seen:covered,sequences:coverageSequences});
      if(host.assertScope(context,access)!==true||[...sequences].some(([sid,seq])=>host.sourceSequence(sid)!==seq||host.assertAuthorized(sid,context,access)!==true)||[...covered].some(sid=>host.assertAuthorized(sid,context,access)!==true||host.sourceSequence(sid)!==coverageSequences.get(sid)))throw fail('disclosure_changed');
      return {query,results:results.sort((a,b)=>b.score-a.score).slice(0,cap),coverage:coverageState,scope:{mode:'message-shards',sampling:false,coordinate:'utf16',maxQueryChars:OVERLAP}};
    }
    async function restorePause(context){const saved=await read(null,'state.json',1024);if(saved&&(keys(saved)!=='phase,schema'||saved.schema!==SCHEMA||!['paused','building','idle'].includes(saved.phase)))throw fail('state_invalid');paused=saved?.phase==='paused';return coverage(context);}
    return Object.freeze({step,prepare,search,coverage,restorePause,invalidate:(sid,deleted=false)=>run(async()=>{await purge(sid);}),pause:()=>{paused=true;return run(()=>state('paused'));},resume:()=>{paused=false;return run(()=>state('idle'));},isPaused:()=>paused,busy:()=>building,pending:()=>chain});
  }
  return Object.freeze({SCHEMA,CHARS,OVERLAP,SHARD_BYTES,sources,create});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'));

// Explicit production composition. No timer, route switch, directory creation,
// key creation or background indexing occurs merely by loading this module.
// A reviewed caller must supply destination-scope disclosure, including the
// reference itself. Model and UI consumers must bind their real existing scope.
let sessionFullTextOwner = null;
function bindSessionFullTextIndex(disclosure,sessionResults=false) {
  const names=['scope','authorize','assertAuthorized','project','assertScope'];
  if(sessionFullTextOwner)throw Object.assign(Error('session_fulltext.already_bound'),{code:'session_fulltext.already_bound'});
  if(!disclosure||Object.keys(disclosure).sort().join(',')!==names.slice().sort().join(',')||names.some(name=>typeof disclosure[name]!=='function'))
    throw Object.assign(Error('session_fulltext.scope_binding_required'),{code:'session_fulltext.scope_binding_required'});
  const projection=Object.fromEntries(names.map(name=>[name,disclosure[name]])),source=createSessionFullTextSource();
  const instance=SessionFullTextIndex.create({...projection,resultUnit:sessionResults===true?'sessions':'references',root:()=>paths.sessions,keys:workDataKeys,writeJson:atomicWriteJson,
    validSessionId:safeSessionId,noise:sessionSearchRowIsNoise,terms:retrievalTerms,
    enabled:async()=>{const config=await readConfig();return WorkDataRootHooks.mode?WorkDataRootHooks.mode(config.workDataEncryptionV1):config.workDataEncryptionV1===true;},
    epoch:source.epoch,scan:source.scan,sourceSequence:source.sequence,
    catalog:async()=>{
      let entries;try{entries=await fsp.readdir(paths.sessions,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
      const ids=[],physical=new Set(),pattern=process.platform==='win32'?/^([A-Za-z0-9_-]{1,64})\.json$/i:/^([A-Za-z0-9_-]{1,64})\.json$/;
      for(const entry of entries){const match=pattern.exec(entry.name);if(!match||safeSessionId(match[1])!==match[1])continue;
        const key=process.platform==='win32'?match[1].toLowerCase():match[1];
        if(!entry.isFile()||entry.isSymbolicLink()||physical.has(key))throw Object.assign(Error('session_fulltext.catalog_invalid'),{code:'session_fulltext.catalog_invalid'});
        physical.add(key);ids.push(match[1]);
      }
      return ids.sort();
    }});
  const admitted=work=>WorkDataMaintenanceHooks.run('session-fulltext-index',work);
  sessionFullTextOwner=instance;
  return Object.freeze({search:instance.search,coverage:instance.coverage,prepare:context=>admitted(()=>instance.prepare(context)),
    restorePause:context=>admitted(()=>instance.restorePause(context)),step:(limit,context)=>admitted(()=>instance.step(limit,context)),
    pause:()=>admitted(()=>instance.pause()),resume:()=>admitted(()=>instance.resume()),
    invalidate:(id,deleted)=>admitted(()=>instance.invalidate(id,deleted))});
}
if(typeof SessionFullTextHooks!=='undefined')Object.assign(SessionFullTextHooks,{
  bind:bindSessionFullTextIndex,
  bindSessions:disclosure=>bindSessionFullTextIndex(disclosure,true),
  maintenanceState:()=>({pending:sessionFullTextOwner?[sessionFullTextOwner.pending()]:[],active:Number(!!sessionFullTextOwner?.busy())}),
  maintenancePause:()=>{if(!sessionFullTextOwner)return null;const saved={paused:sessionFullTextOwner.isPaused()};sessionFullTextOwner.pause().catch(()=>{});return saved;},
  maintenanceResume:saved=>{if(saved&&!saved.paused&&sessionFullTextOwner)sessionFullTextOwner.resume().catch(()=>{});},
});
