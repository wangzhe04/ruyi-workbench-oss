// Unified source-bound Gemma2 retrieval method. Only Node built-ins.
const SemanticScoreEvidence = (() => {
// Data-only cache identity canonicalization. No score signer or registry is public.
const invalid=()=>Error('semantic.score_evidence_invalid');
function identity(value){if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value)&&value.length<=64&&value.every(v=>v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v)))return JSON.stringify(value);throw invalid();}
return {identity};

})();
const SemanticOriginalWindows = (() => {
// Canonical generator copied byte-for-byte from reviewed90a; provenance stays private.
const Encoding=SemanticScoreEvidence;
const CHARS=4096,OVERLAP=256,segmenter=new Intl.Segmenter('und',{granularity:'grapheme'}),canonicalText=text=>text.normalize('NFKC').toUpperCase().normalize('NFKC'),fail=suffix=>Object.assign(Error('semantic.window_'+suffix),{code:'semantic.window_'+suffix});
// 150 S5 fast path and slice cache: byte-identical copies of 13ap (locked by unit/fulltext-canonical-fast-path.test.js).
  const CANONICAL_UNITS=new Int32Array(65536);
function canonicalUnit(code){
    let value=CANONICAL_UNITS[code];
    if(value===0){const output=canonicalText(String.fromCharCode(code));
      value=output.length===1&&/^[\x09-\x0c\x20-\x7e\u2010-\u2027\u3001-\u3029\p{Script=Han}]$/u.test(output)&&!/[\p{Extended_Pictographic}\p{Grapheme_Extend}]/u.test(output)&&canonicalText(output)===output?output.charCodeAt(0)+1:-1;
      CANONICAL_UNITS[code]=value;}
    return value>0?value-1:-1;
  }
function* canonicalGroups(text){
    let tail=null,run=null;
    for(const part of segmenter.segment(text)){
      const code=part.segment.length===1&&tail!==null&&tail.text.length===1&&canonicalUnit(tail.text.charCodeAt(0))===tail.text.charCodeAt(0)?canonicalUnit(part.segment.charCodeAt(0)):-1;
      if(code>=0){const linear=tail.to-tail.from===1;
        if(run&&run.linear&&linear&&run.to===tail.from&&run.text.length<CHARS){run.text+=tail.text;run.to=tail.to;}
        else{if(run)yield run;run={text:tail.text,from:tail.from,to:tail.to,linear};}
        tail={text:code===part.segment.charCodeAt(0)?part.segment:String.fromCharCode(code),from:part.index,to:part.index+1,linear:true};continue;}
      if(run){yield run;run=null;}
      const incoming=canonicalText(part.segment),boundary=tail?tail.text.length:0,joined=(tail?tail.text:'')+incoming;let next=null;
      for(const unit of segmenter.segment(joined)){const from=unit.index<boundary?tail.from:part.index,to=unit.index+unit.segment.length>boundary?part.index+part.segment.length:tail.to;
        for(const normalized of segmenter.segment(canonicalText(unit.segment))){if(next)yield next;next={text:normalized.segment,from,to,linear:normalized.segment.length===1&&to-from===1};}
      }
      tail=next;
    }
    if(run)yield run;
    if(tail)yield tail;
  }
function* canonicalPieces(text){
    let whitespace=null;
    function* asciiParts(){for(let index=0;index<text.length;index+=CHARS)yield {text:text.slice(index,index+CHARS).toUpperCase(),from:index,to:Math.min(text.length,index+CHARS),linear:true};}
    const parts=/^[\x00-\x7f]*$/.test(text)?asciiParts():canonicalGroups(text),blankUnit=/\s/u;
    for(const part of parts){
      if(part.text.length===1){const linear=part.linear,from=part.from,to=linear?from+1:part.to;
        if(blankUnit.test(part.text)){if(whitespace)whitespace.to=to;else whitespace={from,to};continue;}
        if(whitespace){yield {text:' ',from:whitespace.from,to:whitespace.to,linear:false};whitespace=null;}
        yield {text:part.text,from,to,linear};continue;}
      const matcher=/\s+|\S+/gu;let match;
      while((match=matcher.exec(part.text))){const blank=/^\s/u.test(match[0]),linear=part.linear,from=linear?part.from+match.index:part.from,to=linear?from+match[0].length:part.to;
        if(blank){if(whitespace)whitespace.to=to;else whitespace={from,to};continue;}
        if(whitespace){yield {text:' ',from:whitespace.from,to:whitespace.to,linear:false};whitespace=null;}
        yield {text:match[0],from,to,linear};
      }
    }
    if(whitespace)yield {text:' ',from:whitespace.from,to:whitespace.to,linear:false};
  }
function rangeAt(ranges,position){for(const run of ranges)if(position>=run[0]&&position<run[0]+run[1])return run.length===3?{from:run[2]+position-run[0],to:run[2]+position-run[0]+1}:{from:run[2],to:run[3]};throw fail('shard_invalid');}
  const SLICE_CACHE={entries:new Map(),bytes:0,minChars:1024,maxBytes:33554432,maxEntryBytes:8388608,maxEntries:128,idleMs:120000,timer:null,generation:0};
function sliceCacheEvict(key,entry){
    const cache=SLICE_CACHE;if(!entry.live)return;entry.live=false;if(cache.entries.get(key)===entry)cache.entries.delete(key);cache.bytes-=entry.bytes;
  }
function clearSliceCache(){
    const cache=SLICE_CACHE;cache.generation++;for(const [key,entry] of cache.entries)sliceCacheEvict(key,entry);cache.entries.clear();cache.bytes=0;
    if(cache.timer!==null){if(typeof clearTimeout==='function')clearTimeout(cache.timer);cache.timer=null;}
  }
function sweepSliceCache(now,keep=null){
    const cache=SLICE_CACHE;
    for(const [key,entry] of cache.entries){if(entry===keep||now-entry.used<=cache.idleMs&&cache.entries.size<=cache.maxEntries&&cache.bytes<=cache.maxBytes)break;sliceCacheEvict(key,entry);}
    if(cache.timer===null&&cache.entries.size&&typeof setTimeout==='function'){const timer=setTimeout(()=>{if(cache.timer===timer){cache.timer=null;sweepSliceCache(Date.now());}},cache.idleMs>>2);cache.timer=timer;if(typeof timer?.unref==='function')timer.unref();}
  }
function* cachedSlices(text,generation){
    const cache=SLICE_CACHE;if(text.length<cache.minChars||text.length*5>cache.maxEntryBytes){yield* sliceWindows(text);return;}
    const now=Date.now(),current=generation===cache.generation;sweepSliceCache(now);
    let entry=current?cache.entries.get(text):undefined;
    if(entry){cache.entries.delete(text);cache.entries.set(text,entry);entry.used=now;}
    else{entry={windows:[],source:sliceWindows(text),failure:null,done:false,live:current,bytes:2*text.length+64,used:now};if(current){cache.entries.set(text,entry);cache.bytes+=entry.bytes;sweepSliceCache(now,entry);}}
    for(let index=0;;index++){
      if(index===entry.windows.length){
        if(entry.failure)throw entry.failure;if(entry.done)return;
        let next;try{next=entry.source.next();}catch(error){entry.failure=error;entry.source=null;sliceCacheEvict(text,entry);throw error;}
        if(next.done){entry.done=true;entry.source=null;return;}
        const value=next.value,flat=new Int32Array(value.ranges.length*4);let at=0;for(const run of value.ranges){flat[at++]=run[0];flat[at++]=run[1];flat[at++]=run[2];flat[at++]=run.length===4?run[3]:-1;}
        const size=2*value.text.length+flat.byteLength+(flat.byteLength>>1)+4096;entry.windows.push({canonicalStart:value.canonicalStart,start:value.start,end:value.end,text:value.text,flat});entry.bytes+=size;
        if(entry.live){cache.bytes+=size;if(entry.bytes>cache.maxEntryBytes)sliceCacheEvict(text,entry);else sweepSliceCache(Date.now(),entry);}
      }
      const window=entry.windows[index],flat=window.flat,ranges=[];
      for(let at=0;at<flat.length;at+=4)ranges.push(flat[at+3]<0?[flat[at],flat[at+1],flat[at+2]]:[flat[at],flat[at+1],flat[at+2],flat[at+3]]);
      yield {canonicalStart:window.canonicalStart,start:window.start,end:window.end,text:window.text,ranges};
    }
  }
function slices(text,generation=SLICE_CACHE.generation){return cachedSlices(text,generation);}
function* sliceWindows(text){
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
const canonicalProofs=new WeakMap(),requests=new WeakMap(),IDENTITY_KEYS=['sourceId','field','revision','epoch','sourceRevision'];
function* canonicalSlices(text,generation=SLICE_CACHE.generation){if(typeof text!=='string')throw fail('text_invalid');for(const window of slices(text,generation)){for(const range of window.ranges)Object.freeze(range);Object.freeze(window.ranges);Object.freeze(window);canonicalProofs.set(window,{text,canonicalStart:window.canonicalStart,start:window.start,end:window.end,textValue:window.text,ranges:window.ranges});yield window;}}
function* rawSlices(text){if(typeof text!=='string')throw fail('text_invalid');for(let start=0;start<text.length;){let end=Math.min(text.length,start+96);if(end<text.length&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;yield {start,end,text:text.slice(start,end)};if(end===text.length)break;start=end-16;if(text.charCodeAt(start)>=0xdc00&&text.charCodeAt(start)<=0xdfff)start--;}}
function observationProjectedSpans(text) {return [...text.matchAll(/\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g)].map(match=>[match.index,match.index+match[0].length]);}
function observationProjectedRange(text,start,end,spans=observationProjectedSpans(text)) {
  let low=0,high=spans.length;while(low<high){const mid=(low+high)>>>1;if(spans[mid][1]<=start)low=mid+1;else high=mid;}
  for(let index=low;index<spans.length;index++){const [left,right]=spans[index];if(left>=end&&left>=start)break;
    if(start>left&&start<right)start=left;
    if(end>left&&end<right)end=left>start?left:right;
  }
  return {start,end};
}
function* projectedSlices(text){const spans=observationProjectedSpans(text);for(let at=0;at<text.length;){let end=Math.min(text.length,at+96);if(end<text.length&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;const range=observationProjectedRange(text,at,end,spans);at=range.start;end=range.end;yield {start:at,end,text:text.slice(at,end)};if(end===text.length)break;let next=end-16;const adjusted=observationProjectedRange(text,next,end,spans);next=adjusted.start;if(next<=at)next=end;at=next;if(text.charCodeAt(at)>=0xdc00&&text.charCodeAt(at)<=0xdfff)at--;}}
function hasPosition(text,start,end){for(const row of rawSlices(text)){if(row.start===start)return row.end===end;if(row.start>start)return false;}return false;}
function validRawPosition(f,start,end){if(f.kind==='canonical-message-v3')return false;if(!f.positions){f.positions=new Map();f.positionIterator=(f.kind==='privacy-projected-v1'?projectedSlices(f.text):rawSlices(f.text));}if(f.positions.has(start))return f.positions.get(start)===end;for(;;){const next=f.positionIterator.next();if(next.done)return false;f.positions.set(next.value.start,next.value.end);if(next.value.start>=start)return next.value.start===start&&next.value.end===end;}}
function createRequest({query,scopeId,modelFingerprint}){if(typeof query!=='string'||!query.trim()||typeof scopeId!=='string'||!scopeId||typeof modelFingerprint!=='string'||!modelFingerprint)throw fail('context_invalid');const context=Object.freeze({}),sliceGeneration=SLICE_CACHE.generation,fields=new WeakMap(),windows=new WeakMap(),rows=new WeakMap(),weakKeys=new WeakMap(),byIdentity=new Map();let used=false,fieldSerial=0,poolReference=null,poolSnapshot=null;
 const field=token=>{const f=fields.get(token);if(!f)throw fail('field_invalid');return f;};
 function captureField(identity,text,kind){if(!identity||typeof text!=='string'||!['canonical-message-v3','raw-original-v1','raw-metadata-v1','privacy-projected-v1'].includes(kind)||IDENTITY_KEYS.some(k=>typeof identity[k]!=='string'))throw fail('field_invalid');const selected=Object.fromEntries(IDENTITY_KEYS.map(k=>[k,identity[k]])),key=JSON.stringify(selected),prior=byIdentity.get(key);if(prior){const old=field(prior);if(old.text!==text||old.kind!==kind)throw fail('source_changed');return prior;}const token=Object.freeze({});fields.set(token,{identity:selected,text,kind,key:'field-'+(++fieldSerial)});byIdentity.set(key,token);return token;}
 function wholeSource(token){const f=field(token);return {identity:{...f.identity,start:0,end:f.text.length},fieldText:f.text,text:f.text,fieldWitness:token};}
 function canonicalWindow(token,slice,at,width){const f=field(token);if(f.kind!=='canonical-message-v3'||canonicalProofs.get(slice)?.text!==f.text||!Number.isSafeInteger(at)||!Number.isSafeInteger(width)||!hasPosition(slice.text,at,at+width))throw fail('canonical_invalid');const start=rangeAt(slice.ranges,at).from,end=rangeAt(slice.ranges,at+width-1).to,witness=Object.freeze({});windows.set(witness,{field:token,start,end,canonicalStart:slice.canonicalStart,at,width,cacheText:slice.text.slice(at,at+width)});return {identity:{...f.identity,start,end},fieldText:f.text,text:f.text.slice(start,end),fieldWitness:token,windowWitness:witness};}
 function rawWindow(token,start,end){const f=field(token);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>f.text.length||!validRawPosition(f,start,end))throw fail('raw_invalid');const witness=Object.freeze({});windows.set(witness,{field:token,start,end});return {identity:{...f.identity,start,end},fieldText:f.text,text:f.text.slice(start,end),fieldWitness:token,windowWitness:witness};}
 function assertSource(source,wholeField,requestContext,row){if(requestContext!==context||!source||typeof wholeField!=='boolean')throw fail('context_invalid');const f=field(source.fieldWitness),expected=row?rows.get(row):null;if(row&&(!expected||expected.field!==source.fieldWitness))throw fail('row_source_changed');if(source.fieldText!==f.text||IDENTITY_KEYS.some(k=>source.identity?.[k]!==f.identity[k]))throw fail('source_changed');const {start,end}=source.identity;if(wholeField){if(start!==0||end!==f.text.length||source.text!==f.text)throw fail('whole_field_invalid');}else{const w=windows.get(source.windowWitness);if(!w||w.field!==source.fieldWitness||start!==w.start||end!==w.end||source.text!==f.text.slice(start,end)||expected&&['start','end','canonicalStart','at','width'].some(k=>w[k]!==expected.window[k]))throw fail('window_invalid');}return true;}
 function row(source,orderParts,encodingIdentity=IDENTITY_KEYS.map(k=>source.identity[k]).concat(source.identity.start,source.identity.end)){assertSource(source,false,context);if(!Array.isArray(orderParts)||orderParts.some(x=>!['string','number'].includes(typeof x)||typeof x==='number'&&!Number.isFinite(x)))throw fail('row_order_invalid');const f=field(source.fieldWitness),value=Object.freeze({fieldKey:f.key,order:JSON.stringify([...orderParts,source.identity.start]),metadata:f.kind==='raw-metadata-v1'}),window={...windows.get(source.windowWitness)};rows.set(value,{field:source.fieldWitness,window,cacheText:window.cacheText??source.text,encodedText:source.text,encodingIdentity:Encoding.identity(encodingIdentity)});return value;}
 function assertScore(row,doc,encodedIdentity,encodedText){const expected=rows.get(row);if(!expected||expected.cacheText!==doc||expected.encodingIdentity!==encodedIdentity||encodedText!==null&&expected.encodedText!==encodedText)throw fail('score_source_changed');}
 function weakKey(token){field(token);const value=Object.freeze({});weakKeys.set(value,token);return value;}
 function assertWeak(key,row){const r=rows.get(row);if(!r||weakKeys.get(key)!==r.field)throw fail('weak_source_changed');}
 const assertPool=pool=>{if(!used||pool!==poolReference||poolSnapshot!==null&&(pool.length!==poolSnapshot.length||pool.some((r,n)=>r!==poolSnapshot[n])))throw fail('pool_changed');};
 const api=Object.freeze({context,captureField,wholeSource,canonicalSlices:token=>canonicalSlices(field(token).text,sliceGeneration),canonicalWindow,rawSlices:token=>field(token).kind==='privacy-projected-v1'?projectedSlices(field(token).text):rawSlices(field(token).text),rawWindow,row,weakKey,assertWeak,assertSource,assertScore,assertPool,
  begin:(requestContext,q,scope,fp,pool)=>{if(requestContext!==context||used||q!==query||scope!==scopeId||fp!==modelFingerprint||!Array.isArray(pool)||pool.some(r=>!rows.has(r)))throw fail('request_reused_or_changed');used=true;poolReference=pool;poolSnapshot=pool.slice();
    // Frozen arrays can still have getters or holes. Skip repeated full-pool
    // scans only when every position is an immutable own data property.
    if(Object.isFrozen(pool)){
      let fixed=true;
      for(let n=0;n<pool.length;n++){
        const slot=Object.getOwnPropertyDescriptor(pool,n);
        if(!slot||!Object.hasOwn(slot,'value')||!rows.has(slot.value)){fixed=false;break;}
      }
      if(fixed)poolSnapshot=null;
    }},fieldKey:token=>field(token).key});requests.set(api,context);return api;}
return {canonicalSlices,rawSlices,projectedSlices,createRequest,isRequest:(value,context)=>requests.get(value)===context,clearSliceCache};

})();
