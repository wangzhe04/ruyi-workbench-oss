// Complete message-source shards; source authority and disclosure remain with
// the existing session/storage/privacy owners. No embeddings or corpus sampling.
const SessionFullTextIndex = ((io,p,c) => {
  // 150 号文 S1 的失败分类(00-boot);单文件 vm 夹具没装它时保守:不包、不降级(同修前)。
  const semanticFailures=typeof SemanticFailurePolicy!=='undefined'?SemanticFailurePolicy:{guard:fn=>fn,degradable:()=>false};
  const FORMAT=3,SCHEMA=1,CHARS=4096,OVERLAP=256,SHARD_BYTES=256*1024,MANIFEST_BYTES=4*1024*1024;
  const PREPARE_SLICE_MS=1500;
  const ATTACHMENT_REFS_PER_MESSAGE=16,ATTACHMENT_REFS_PER_SESSION=64,ATTACHMENT_DOCS_PER_SESSION=2;
  const HEX=/^[a-f0-9]{64}$/,GEN=/^[a-f0-9]{32}$/;
  const NORMALIZER='fullfield-nfkc-upper-nfkc-space/v1;unicode='+process.versions.unicode+';icu='+process.versions.icu+';v8='+process.versions.v8;
  const fail=suffix=>Object.assign(Error('session_fulltext.'+suffix),{code:'session_fulltext.'+suffix,apiCode:'session_fulltext.'+suffix,statusCode:409});
  const hash=value=>c.createHash('sha256').update(value).digest('hex');
  const digest=value=>hash(JSON.stringify(value));
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value)&&!value.startsWith('_');
  const clone=value=>JSON.parse(JSON.stringify(value));
  const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
  // 151 阶段 2F:逐会话的 I/O(扫索引、回读源头、复核 manifest)原来 4 个一批、等这批最慢的那个,负载下一次慢 I/O 让
  // 另外三路空等。改为有界的滑动窗口:完成的结果按原顺序同步交给 onSettled(累计、截断、预览早停的账与修前逐批时同序);
  // 「重排窗口」也有界 —— 第 at 条只有在 at-已交付 < width 且在飞数 < width 时才起,否则这一路等一个空位(不退出),
  // 所以一条慢的排头最多让 width 条结果压在它后面,预览早停(stop() 只看已按序交付的结果)和 width 函数(预览按
  // 「还差几条」收窄)给出的回读上界不会因为排头慢而失效(2F 复审应改 1)。交付后只留状态与失败原因,不留值,峰值
  // 内存不随库的大小增长(复审应改 2)。某一条失败(或 onSettled 抛错)后不再起新的,已起的等完;返回原序的 settled
  // 前缀(值已释放)与是否早停;调用方按修前的口径从中取错。
  const POOL_WIDTH=8;
  async function orderedPool(items,work,options={}){
    const width=typeof options.width==='function'?options.width:()=>options.width||POOL_WIDTH,stop=options.stop||(()=>false),onSettled=options.onSettled||(()=>{});
    const out=new Array(items.length);let next=0,committed=0,inFlight=0,failed=false,stopped=false,commitError=null,waiters=[];
    const commit=()=>{while(!failed&&committed<next&&out[committed]){const row=out[committed];if(row.status==='rejected'){failed=true;break;}try{onSettled(row.value,committed);}catch(error){failed=true;commitError={error};break;}out[committed]={status:'fulfilled'};committed++;}};
    const wake=()=>{const list=waiters;waiters=[];for(const resolve of list)resolve();};
    const lane=async()=>{while(!failed&&next<items.length){if(stop()){stopped=true;break;}const limit=Math.max(1,Math.min(POOL_WIDTH,width()));
      if(inFlight>=limit||next-committed>=limit){if(inFlight===0)break;await new Promise(resolve=>waiters.push(resolve));continue;}
      const at=next++;inFlight++;try{out[at]={status:'fulfilled',value:await work(items[at],at)};}catch(reason){out[at]={status:'rejected',reason};failed=true;}inFlight--;commit();wake();}
      wake();};
    await Promise.all(Array.from({length:Math.min(POOL_WIDTH,items.length)},lane));
    if(commitError)throw commitError.error;
    return {settled:out.slice(0,next),stopped:stopped&&!failed&&next<items.length};
  }
  const poolFailure=(settled,timeout)=>{const failures=settled.filter(row=>row.status==='rejected');return failures.length?(failures.find(row=>row.reason!==timeout&&row.reason?.code!=='privacy.disclosure_dirty')||failures.find(row=>row.reason!==timeout)||failures[0]).reason:null;};
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
  // 150 S5 快速路径(06h9 SemanticOriginalWindows 有逐字节相同的副本,unit/fulltext-canonical-fast-path.test.js 钉两份一致、
  // 并在差分语料上与修前实现逐字节比对)。修前每个原字素调 3 次 Intl.Segmenter.segment(),中文 100 KB 要秒级。
  // canonicalUnit(code) 只对「单码元、规范化结果 d 也是单码元、d 自身再规范化不变、d 属于字素簇断点恒为 Other 的白名单
  // (TAB/LF/VT/FF、可打印 ASCII、BMP 汉字、U+2010–2027 标点、U+3001–3029 中日标点)且不是 Extended_Pictographic / Grapheme_Extend」
  // 的码元给出 d,其余一律 -1 走原路径。白名单里任意两码元之间按 GB4/GB5/GB999 必断(白名单不含 CR,没有 CR×LF),所以当尾巴与来者都是白名单码元时,
  // 原路径三次切分的结果可以直接写出:先吐出尾巴(再规范化不变),来者成为新尾巴、坐标 [index,index+1)、linear。
  // 结果按码元记在进程内 64K 表里(每个码元只算一次)。吐出的连续线性单码元组合并成一组(每组不超过 CHARS):
  // canonicalPieces 按 \s+|\S+ 切、sliceWindows 把首尾相接的线性段并进同一 run,与逐字一组的缓冲区、ranges、切窗点完全相同。
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
  // 150 S5 切片缓存:输出只取决于正文本身(规则、CHARS/OVERLAP、unicode/icu 版本在进程内不变),所以键就是正文字符串本身
  // (比 contentRevision 更严:不会撞、正文一变就不命中;revision 变而正文没变只是照样命中同一结果)。只在内存。
  // 上限按真实堆估算(字符串按 2 字节/字计、键正文也计入,ranges 压成每段 4 个 Int32 的平铺数组、按 1.5 倍计,每窗另计 4 KB 对象开销;实测英文 22–44 万字真实留存(含键正文)约为估算的 0.6–0.8):
  // 单份 ≤32 MB、单条 ≤8 MB(正文超过 maxEntryBytes/5 字不进缓存),13ap 与 06h9 两份合计 ≤64 MB;填充中途也按上限淘汰,
  // 单条超限就当场退出缓存。闲置 120 s 过期:每次调用惰性淘汰,另有 unref 的定时清扫(只在缓存非空时挂着,加载模块不起定时器)。
  // clearSliceCache() 供撤销、暂停、维护与策略变化时清空。1024 字以下不进缓存。按需扩展:先到的消费者提前 break 也只算到
  // 它要的那几窗,后来者接着往下算;生成器抛错就整条丢弃并原样上抛。每次吐出的都是新对象(ranges 现造),缓存里的原件不外泄。
  // 清空世代(generation):每次 clearSliceCache() 加一。slices(text,generation) 的世代默认取调用那一刻;搜索/请求在读正文之前
  // 先取世代传进来。世代落后于当前的调用只给自己的消费者现算,既不读也不写缓存 —— 清空前读到的正文不会在清空后被放回去。
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
  function slices(text,generation=SLICE_CACHE.generation){return cachedSlices(text,generation);}
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
  // 150 S5(2D 复审 F3):撤销、暂停、进出维护、写入策略变化时清空两份切片缓存(本模块与 06h9),已删或已改策略的会话明文
  // 不留在堆里;关闭索引后没人再调切片,条目由 unref 定时清扫在闲置期满后清掉。
  const clearCanonicalCaches=()=>{clearSliceCache();if(typeof SemanticOriginalWindows!=='undefined'&&typeof SemanticOriginalWindows.clearSliceCache==='function')SemanticOriginalWindows.clearSliceCache();};
  let canonicalCachePolicy;
  function create(host){
    if(!host||['validSessionId','root','enabled','writeJson','catalog','epoch','scan','scope','authorize','assertAuthorized','project','assertScope','sourceSequence','noise','terms'].some(name=>typeof host[name]!=='function'))throw fail('host_invalid');
    const sessionResults=host.resultUnit==='sessions';
    const semantic=host.semantic||null,searchProofs=new WeakMap();
    const canonical=id;const valid=value=>canonical(value)&&host.validSessionId(value)===value;
    const attachmentSource=host.attachmentSource;
    const attachmentField=/^attachments\.(\d+)\.extractedText$/;
    const attachmentBudget=()=>({refs:ATTACHMENT_REFS_PER_SESSION,docs:ATTACHMENT_DOCS_PER_SESSION});
    function attachmentCandidates(row,budget){
      if(!attachmentSource||!Array.isArray(row.attachments)||!budget.refs)return [];
      const candidates=[];
      for(const [index,reference] of row.attachments.slice(0,Math.min(budget.refs,ATTACHMENT_REFS_PER_MESSAGE)).entries()){
        budget.refs--;
        if(attachmentSource.isDocument(reference)){
          if(!budget.docs)continue;
          budget.docs--;
        }
        candidates.push([index,reference]);
      }
      return candidates;
    }
    async function selectedAttachments(candidates,policy){
      const selected=[];
      for(const [index,reference] of candidates)selected[index]=await attachmentSource.select(reference,policy);
      return selected;
    }
    function attachmentWitness(){
      const digest=c.createHash('sha256');
      return {
        add:(ordinal,selected)=>{if(selected.length)digest.update(JSON.stringify([ordinal,selected.map(value=>value?.revision??null)])+'\n');},
        finish:()=>digest.digest('hex'),
      };
    }
    async function extractedSources(row,policy,selected,deferred=()=>{}){
      const parts=[];
      for(const [index,source] of selected.entries()){
        if(!source)continue;
        const attachment=row.attachments[index],result=await attachmentSource.read(attachment,policy,source);
        if(result?.deferred===true)deferred();
        const text=result?.text;
        if(typeof text!=='string')continue;
        const revalidate=async(complete=false)=>{
          const current=await attachmentSource.select(attachment,policy);
          if(current?.revision!==source.revision)return false;
          return !complete||!policy||attachmentSource.verify(attachment,source);
        };
        parts.push({field:'attachments.'+index+'.extractedText',text,revision:digest([source.revision,text]),revalidate});
      }
      return parts;
    }
    // Only authenticated/readable manifest plaintext with invalid JSON can be
    // rebuilt as a missing derived pointer. A private symbol cannot be forged
    // by valid JSON and never softens key, schema, namespace or shard failures.
    const malformedManifest=Symbol('malformed-derived-manifest');
    let chain=Promise.resolve(),maintenanceChain=chain,paused=false,maintenancePaused=false,building=false,mutationSerial=0,mutationActive=0;const preparationProgress=new Map();
    const maintenanceCancellations=new WeakSet();
    const beginMutation=()=>{mutationSerial++;mutationActive++;return()=>{mutationActive--;mutationSerial++;};};
    const mutationState=()=>({serial:mutationSerial,active:mutationActive});
    const run=work=>{
      const pending=chain.catch(()=>{}).then(work);
      chain=pending;
      // A deliberately cancelled index request has settled its maintenance
      // obligation. Keep its original rejection for the request itself.
      maintenanceChain=pending.catch(error=>{if(!maintenanceCancellations.has(error))throw error;});
      void maintenanceChain.catch(()=>{});
      return pending;
    };
    const pathKey=value=>process.platform==='win32'?p.resolve(value).toLowerCase():p.resolve(value);
    // directoriesVerified:逐会话检索时第一个 shard 紧跟 manifest 读,中间只隔 manifest 的读取与解析那几次 await,目录链
    // (数据根/索引根/会话目录)刚由 manifest 那一次核过,这一个 shard 不再重核;其后的 shard 之间隔着整片的逐行处理,照旧逐个重核。
    // 每个 shard 自己的文件级核对(普通文件、非链接、nlink=1、尺寸)都做。150 S6:单 shard 会话(绝大多数)每发省 6 次 lstat/realpath。
    // 151 阶段 2F:目录链原来逐级 lstat+realpath(数据根、索引根、会话目录,每次 6 次调用)。逐级 lstat 照旧(由浅到深,
    // 不穿过任何没核过的链接/junction;ENOENT 视为无索引),realpath 只做最深一级:各级都是非链接目录时,最深一级
    // realpath===自身 当且仅当每一级祖先 realpath===自身(realpath 解析整条路径),所以拒绝的情形与修前逐级核对相同,
    // 错误码都是 owned_namespace_changed。某一级不存在时,先对已存在的最深一级做 realpath 再按「无索引」返回(修前在
    // 那之前已逐级 realpath 过它们)。每次 4 次调用。
    async function namespace(sid,name=null,max=null,directoriesVerified=false){
      const directories=directoriesVerified?[]:[host.root(),p.join(host.root(),'_fulltext-index-v1'),...(sid?[p.dirname(pathFor(sid,'manifest.json'))]:[])];
      const owned=async directory=>{if(directory&&pathKey(await io.realpath(directory))!==pathKey(directory))throw fail('owned_namespace_changed');};
      for(let level=0;level<directories.length;level++){const directory=directories[level];let stat;try{stat=await io.lstat(directory);}catch(error){if(error.code==='ENOENT'){await owned(directories[level-1]);return;}throw error;}
        if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('owned_namespace_changed');
      }
      await owned(directories[directories.length-1]);
      if(name){let stat;try{stat=await io.lstat(pathFor(sid,name));}catch(error){if(error.code==='ENOENT')return;throw error;}
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fail('owned_namespace_changed');
        if(max!==null&&(!Number.isSafeInteger(stat.size)||stat.size>max*2+65536))throw fail('capacity');
      }
    }
    const pathFor=(sid,name)=>p.join(host.root(),'_fulltext-index-v1',...(sid?[sid]:[]),name);
    const storage=(sid,name,max=SHARD_BYTES,policy=undefined)=>WorkDataStore.createText({file:()=>pathFor(sid,name),purpose:'search-index',schema:SCHEMA,scopeId:'sessions',recordId:'fulltext-index:'+(sid?sid+':':'')+name.replace(/\.json$/,''),chunked:true,maxPlaintextBytes:max,keys:host.keys,enabled:policy===undefined?host.enabled:()=>policy,writeJson:host.writeJson});
    const read=async(sid,name,max,directoriesVerified=false)=>{try{await namespace(sid,name,max,directoriesVerified);const text=await storage(sid,name,max).read();if(Buffer.byteLength(text)>max)throw fail('capacity');let value;try{value=JSON.parse(text);}catch{if(sid&&name==='manifest.json')return malformedManifest;throw fail('record_invalid');}return value;}catch(error){if(error.code==='ENOENT')return null;throw error;}};
    const write=async(sid,name,value,max,policy=undefined,check=undefined)=>{if(sid!==null||name!=='state.json')await markBuilding();const text=JSON.stringify(value);if(Buffer.byteLength(text)>max)throw fail('capacity');if(policy!==undefined&&await host.enabled()!==policy)throw fail('policy_changed');await namespace(sid,name,max);check?.();await storage(sid,name,max,policy).write(text);};
    function manifest(value,sid){
      if(!value)return null;
      const shape=keys(value),legacy=shape==='attachments,chunks,epoch,generation,messages,schema,sessionId,shards,sourceRevision',obsolete=shape==='attachments,chunks,epoch,format,generation,messages,schema,sessionId,shards,sourceRevision'&&[1,2].includes(value.format),currentFields='attachments,chunks,epoch,format,generation,messages,normalizer,schema,sessionId,shards,sourceRevision';
      const attachmentFields='attachmentRevision,attachments,attachmentsIndexed,';
      const sharedFields='chunks,epoch,format,generation,messages,normalizer,schema,sessionId,shards,sourceRevision';
      const withAttachments=(shape===attachmentFields+sharedFields||shape===attachmentFields+'attachmentsRetryAt,'+sharedFields&&integer(value.attachmentsRetryAt))
        && typeof value.attachmentRevision==='string'&&HEX.test(value.attachmentRevision)&&integer(value.attachmentsIndexed)&&value.attachmentsIndexed<=value.attachments;
      const current=(shape===currentFields||withAttachments)&&value.format===FORMAT&&typeof value.normalizer==='string'&&value.normalizer.length>0&&value.normalizer.length<=512;
      if((!legacy&&!obsolete&&!current)||value.schema!==SCHEMA||value.sessionId!==sid||!HEX.test(value.epoch||'')||!HEX.test(value.sourceRevision||'')||!GEN.test(value.generation||'')
        ||!integer(value.messages)||!integer(value.attachments)||!integer(value.chunks)||!Array.isArray(value.shards)||value.shards.length>100000
        ||value.shards.some((row,n)=>keys(row)!=='ordinal,records,sha256'||row.ordinal!==n||!HEX.test(row.sha256||'')||!integer(row.records)||row.records===0||row.records>64))throw fail('manifest_invalid');
      return legacy?{...value,format:1}:value;
    }
    const compatible=value=>value?.format===FORMAT&&value.normalizer===NORMALIZER
      && (!attachmentSource||value.attachments===0||typeof value.attachmentRevision==='string');
    const attachmentRetryDue=value=>value?.attachmentsRetryAt>0&&value.attachmentsRetryAt<=Date.now();
    const currentManifest=async sid=>{const value=await read(sid,'manifest.json',MANIFEST_BYTES);return value===malformedManifest?value:manifest(value,sid);};
    const retired=async(sid,selected)=>{
      const current=await currentManifest(sid);if(!current||!compatible(current)||current.generation!==selected.generation)return true;
      return await host.epoch(sid)!==selected.epoch;
    };
    // 151 阶段 3F:state.json 只记「paused / building / idle」这一个落盘标记。修前每一发 step/prepare 都无条件先写
    // building、收尾再写 idle,冷起的运行时只做冷读与搜索也会把它重写一遍(加密档每次重封,大小不变、字节与 revision 变)。
    // 现在:①只在内容真变时才写——persistedPhase 记本实例确知的盘上值(undefined=不知道,null=文件不存在),
    // 不知道时先回读一次;回读失败(坏件、缺钥匙……)就当不知道,照修前直接写,错误面与修前相同。
    // ②盘上已确知是「未暂停」(idle/building)时,building 改为惰性:一次运行开始只记 buildingPending,直到第一处真正
    // 改动 owned 命名空间(写 shard/manifest、清会话目录)之前才落 building,所以落盘的 building 仍然先于任何改动;
    // 整发没有改动就不落。盘上不确知(文件不存在、读不出)或是 paused 时,照修前在运行开头就写 building
    // (写入授权失败照旧在读任何来源之前浮出)。
    // 写失败一律退回「不知道」,下一次照旧回读或重写。本命名空间只由本进程这一个实例写(第二个 serve 在恢复前被拒)。
    let persistedPhase,buildingPending=false;
    const savedPhase=saved=>{if(saved&&(keys(saved)!=='phase,schema'||saved.schema!==SCHEMA||!['paused','building','idle'].includes(saved.phase)))throw fail('state_invalid');return saved?saved.phase:null;};
    // 读出的载体形态(密封/明文)与当前策略不符时也当「不知道」:读取器两种都收,但修前每发都会按当前策略重写,
    // 明文 state 在加密档下会被重封、密封 state 在关闭档下会以 downgrade_refused 拒绝 —— 这两条照修前走写入路径。
    const stateCarrierSealed=async()=>{const handle=await io.open(pathFor(null,'state.json'),'r');try{const head=Buffer.alloc(256),{bytesRead}=await handle.read(head,0,head.length,0);return /^\{[^\n]*"workData"\s*:\s*3\b/.test(head.subarray(0,bytesRead).toString('utf8'));}finally{await handle.close();}};
    const knownPhase=async()=>{if(persistedPhase===undefined){try{const phase=savedPhase(await read(null,'state.json',1024));persistedPhase=phase===null||await stateCarrierSealed()===(await host.enabled()===true)?phase:undefined;}catch{persistedPhase=undefined;}}return persistedPhase;};
    const state=async phase=>{
      if(phase!=='building')buildingPending=false;
      if(await knownPhase()===phase)return;
      persistedPhase=undefined;await write(null,'state.json',{schema:SCHEMA,phase},1024);persistedPhase=phase;
    };
    const beginBuilding=async()=>{buildingPending=false;const known=await knownPhase();if(known==='idle'||known==='building'){buildingPending=true;return;}await state('building');};
    const markBuilding=async()=>{if(!buildingPending)return;buildingPending=false;await state('building');};
    const isPaused=()=>paused||maintenancePaused;
    const checkPaused=()=>{
      if(!isPaused())return;
      const error=fail('paused');
      if(maintenancePaused)maintenanceCancellations.add(error);
      throw error;
    };
    async function removeOwned(sid,names,check=()=>{}){for(const name of names){check();try{await io.unlink(pathFor(sid,name));}catch(error){if(error.code!=='ENOENT')throw error;}}}
    async function ownedNames(sid,check=()=>{}){
      if(!valid(sid))throw fail('session_invalid');await namespace(sid);const directory=p.dirname(pathFor(sid,'manifest.json'));let names;
      try{names=await io.readdir(directory);}catch(error){if(error.code==='ENOENT')return null;throw error;}
      if(names.length>100000||names.some(name=>name!=='manifest.json'&&!/^[a-f0-9]{32}\.(?:0|[1-9][0-9]*)\.json$/.test(name)))throw fail('owned_namespace_changed');
      for(const name of names){check();const stat=await io.lstat(p.join(directory,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw fail('owned_namespace_changed');}
      return names;
    }
    async function purge(sid,check=()=>{}){
      check();const names=await ownedNames(sid,check);if(names===null)return;await markBuilding();check();const directory=p.dirname(pathFor(sid,'manifest.json'));
      // Retire the selected generation only after validating the entire owned
      // namespace, before any immutable shard can disappear beneath its pointer.
      const finish=beginMutation();try{if(names.includes('manifest.json'))await removeOwned(sid,['manifest.json'],check);
      await removeOwned(sid,names.filter(name=>name!=='manifest.json'),check);check();await io.rmdir(directory);}finally{finish();}
    }
    async function purgeMissing(catalog,check=()=>{}){
      let names;try{names=await io.readdir(pathFor(null,''),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
      for(const name of names){check();if(name.name==='state.json'&&name.isFile()&&!name.isSymbolicLink())continue;if(!name.isDirectory()||name.isSymbolicLink()||!valid(name.name))throw fail('owned_namespace_changed');if(!catalog.includes(name.name))await purge(name.name,check);}
    }
    async function build(sid,check=checkPaused){
      check();const before=await host.epoch(sid);if(!HEX.test(before||''))return false;
      const prior=await currentManifest(sid);
      if(prior?.epoch===before&&compatible(prior)&&(!attachmentSource||prior.attachments===0))return false;
      // Validate every old owned name before building. Keep the bad pointer and
      // all old bytes until a completely verified new generation is published.
      const stale=prior===malformedManifest?await ownedNames(sid,check):null;
      const identities=new Set(),previewAttachments=attachmentWitness(),previewBudget=attachmentBudget(),policy=await host.enabled();
      if(canonicalCachePolicy!==undefined&&canonicalCachePolicy!==policy)clearCanonicalCaches();canonicalCachePolicy=policy;
      const preview=await host.scan(sid,async(row,ordinal)=>{
        check();if(typeof row?.id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id)){if(identities.has(row.id))throw fail('message_owner_ambiguous');identities.add(row.id);}
        if(!host.noise(row))previewAttachments.add(ordinal,await selectedAttachments(attachmentCandidates(row,previewBudget),policy));
      },{check});
      const attachmentRevision=previewAttachments.finish();
      if(!preview||preview.epoch!==before||!HEX.test(preview.revision||'')||typeof preview.requiresEncryption!=='boolean'||typeof policy!=='boolean')throw fail('source_invalid');
      if(preview.requiresEncryption&&policy!==true)throw fail('source_policy_conflict');
      if(await host.epoch(sid)!==before)throw fail('source_changed');
      if(prior?.epoch===before&&compatible(prior)&&prior.attachmentRevision===attachmentRevision&&!attachmentRetryDue(prior))return false;
      const generation=c.randomBytes(16).toString('hex'),shards=[],owned=[],observedAttachments=attachmentWitness(),buildBudget=attachmentBudget();
      let rows=[],bytes=0,messages=0,attachments=0,attachmentsIndexed=0,attachmentsDeferred=false,chunks=0,turn=0,turnBasis='legacy-inferred',committed=false,sliceYieldAt=Date.now()+16;
      const flush=async()=>{if(!rows.length)return;check();const ordinal=shards.length,name=generation+'.'+ordinal+'.json',value={schema:SCHEMA,sessionId:sid,generation,ordinal,rows},text=JSON.stringify(value);if(Buffer.byteLength(text)>SHARD_BYTES)throw fail('capacity');
        owned.push(name);await write(sid,name,value,SHARD_BYTES,policy);shards.push({ordinal,sha256:hash(text),records:rows.length});rows=[];bytes=0;};
      try{
        const proof=await host.scan(sid,async(row,ordinal)=>{
          check();if(!integer(ordinal)||!row||typeof row!=='object')throw fail('source_invalid');
          if(row.role==='user'){turn=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?row.turnSeq:turn+1;turnBasis=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?'explicit':'legacy-inferred';}
          const explicit=row.turnSeq??row.turnSummary?.turnSeq;if(Number.isSafeInteger(explicit)&&explicit>=0){turn=explicit;turnBasis='explicit';}
          messages++;attachments+=Array.isArray(row.attachments)?row.attachments.length:0;if(host.noise(row))return;
          const intrinsic=typeof row.id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id),messageId=intrinsic?row.id:'legacy-ordinal:'+ordinal,contentRevision=digest(row);let chunkOrdinal=0;
          const selected=await selectedAttachments(attachmentCandidates(row,buildBudget),policy);
          observedAttachments.add(ordinal,selected);
          if(selected.length)check();
          const extracted=await extractedSources(row,policy,selected,()=>{attachmentsDeferred=true;});
          attachmentsIndexed+=extracted.length;
          for(const source of [...sources(row),...extracted]){
            const revision=source.revision?digest([contentRevision,source.revision]):contentRevision;
            for(const chunk of slices(source.text)){
              // 150 S5:大正文按时间片让出事件循环(只改何时继续,不改切出什么);让出回来先 check(),撤权、暂停与取消照常截住。
              if(Date.now()>=sliceYieldAt){await new Promise(resolve=>typeof setImmediate==='function'?setImmediate(resolve):resolve());sliceYieldAt=Date.now()+16;}
              check();const entry={sessionId:sid,turnSeq:turn,turnSeqBasis:turnBasis,messageId,messageIdBasis:intrinsic?'intrinsic':'physical-ordinal',contentRevision:revision,chunkOrdinal:chunkOrdinal++,messageOrdinal:ordinal,source:source.field,coordinate:'utf16',start:chunk.start,end:chunk.end,canonicalStart:chunk.canonicalStart,text:chunk.text,ranges:chunk.ranges};
              const size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>SHARD_BYTES-4096||rows.length>=64)await flush();rows.push(entry);bytes+=size;chunks++;
            }
          }
        },{check});
        await flush();check();if(!proof||proof.epoch!==before||!HEX.test(proof.revision||'')||proof.count!==messages||proof.revision!==preview.revision||proof.requiresEncryption!==preview.requiresEncryption
          ||observedAttachments.finish()!==attachmentRevision||await host.epoch(sid)!==before)throw fail('source_changed');
        const value={schema:SCHEMA,format:FORMAT,normalizer:NORMALIZER,sessionId:sid,epoch:before,sourceRevision:proof.revision,generation,messages,attachments,chunks,shards,
          ...(attachmentSource&&attachments?{attachmentRevision,attachmentsIndexed,...(attachmentsDeferred?{attachmentsRetryAt:Date.now()+30000}:{})}:{})};
        const finish=beginMutation();try{await write(sid,'manifest.json',value,MANIFEST_BYTES,policy,check);committed=true;}finally{finish();}
        if(prior===malformedManifest)await removeOwned(sid,stale.filter(name=>name!=='manifest.json'));
        else if(prior)await removeOwned(sid,prior.shards.map(row=>prior.generation+'.'+row.ordinal+'.json'));
        return true;
      }finally{if(!committed)await removeOwned(sid,owned);}
    }
    // 150 S6:覆盖率要证明「选中的 manifest 仍对应当前提交的正文」,修前每一发搜索都把【没有命中】的会话正文整份重扫一遍。
    // 同一发里已有 reuse(命中回读时顺带证明过的那几条);这里把证明跨请求留住,判据与 reuse 完全相同:同一 generation、
    // 同一 epoch(会话头原文哈希 + 正文 stat 戳,本 scope 刚授权时现读)、同一 sourceRevision、进程内 sequence 未变、无附件。
    // 任一不符就照旧重扫。只存计数,不存正文。
    const coverageProofs=new Map();
    // 150 S6:同一发搜索里 manifest 原来读三遍(检索、覆盖率、revalidate)。索引只由本进程这一个实例写(owned namespace,
    // 第二个 serve 实例在恢复前被拒),每次写 manifest/清会话都经 beginMutation 推 mutationSerial —— 自检索起计数没动、
    // 也没有在飞的写,就沿用检索那一刻读到的 manifest;动过就照旧重读。
    const indexUnchanged=since=>!!since&&since.active===0&&mutationActive===0&&!maintenancePaused&&mutationSerial===since.serial;
    const rememberCoverage=(sid,proof)=>{coverageProofs.delete(sid);coverageProofs.set(sid,Object.freeze(proof));while(coverageProofs.size>65536)coverageProofs.delete(coverageProofs.keys().next().value);};
    async function rawCoverage(visibility=null,options={}){
      const check=typeof options.check==='function'?options.check:()=>{};check();
      const catalog=await host.catalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
      let complete=0,pending=0,attachmentSources=0,unverifiedMessages=0;const visit=async sid=>{check();if(visibility){const already=typeof host.authorizedEpoch==='function'&&host.assertAuthorized(sid,visibility.context,visibility.access)===true;if(!already&&await host.authorize(sid,visibility.context,visibility.access)!==true)return;visibility.seen.add(sid);}check();const sequence=host.sourceSequence(sid),value=options.manifests?.has(sid)&&indexUnchanged(options.mutation)?options.manifests.get(sid):await currentManifest(sid);check();options.observed?.set(sid,value?.generation||null);const reused=options.reuse?.get(sid)||coverageProofs.get(sid),authorized=visibility&&typeof host.authorizedEpoch==='function'?host.authorizedEpoch(sid,visibility.context,visibility.access):null;
      if(value&&compatible(value)&&value.messages===0&&value.attachments===0&&value.chunks===0&&Array.isArray(value.shards)&&value.shards.length===0&&visibility&&typeof host.authorizedEmpty==='function'&&host.authorizedEmpty(sid,visibility.context,visibility.access)===true&&authorized===value.epoch){complete++;}
      else if(value&&compatible(value)&&reused&&value.attachments===0&&reused.generation===value.generation&&reused.epoch===value.epoch&&reused.revision===value.sourceRevision&&reused.sequence===sequence&&authorized===value.epoch){complete++;unverifiedMessages+=reused.unverified;}
      else if(value&&compatible(value)){
        // Unknown/non-text array members are still unverified. Read the actual
        // committed stream and bind the count to this selected source revision.
        let unsupported=0;
        const witness=attachmentWitness(),budget=attachmentBudget(),policy=value.attachmentRevision?await host.enabled():null;
        const proof=await host.scan(sid,async(row,ordinal)=>{
          if(host.noise(row))return;
          if(inspectSources(row).unverified)unsupported++;
          if(value.attachmentRevision)witness.add(ordinal,await selectedAttachments(attachmentCandidates(row,budget),policy));
        },{check});
        if(!proof||sequence!==host.sourceSequence(sid))throw fail('source_changed');
        if(proof.epoch!==value.epoch)pending++;
        else if(proof.revision!==value.sourceRevision)throw fail('source_changed');
        else if(value.attachmentRevision&&(value.attachmentRevision!==witness.finish()||attachmentRetryDue(value)))pending++;
        else{complete++;attachmentSources+=value.attachments-(value.attachmentsIndexed||0);unverifiedMessages+=unsupported;if(value.attachments===0)rememberCoverage(sid,{generation:value.generation,epoch:proof.epoch,revision:proof.revision,sequence,unverified:unsupported});}
      }else pending++;if(visibility){if(sequence!==host.sourceSequence(sid))throw fail('source_changed');visibility.sequences.set(sid,sequence);}};
      check();{const visited=await orderedPool(catalog,visit);const failure=poolFailure(visited.settled,options.timeout);if(failure)throw failure;}
      return {phase:isPaused()?'paused':building?'building':'idle',sessions:visibility?visibility.seen.size:catalog.length,indexedSessions:complete,pendingSessions:pending,complete:pending===0&&attachmentSources===0&&unverifiedMessages===0,messages:{unverifiedText:unverifiedMessages},attachments:{unverifiedFullText:attachmentSources},coverageUnit:'committed-display-message-sources',fullTextSampling:false};
    }
    async function coverage(context,options={}){
      const observed=await host.scope(context);if(keys(observed)!=='revision,scopeId'||typeof observed.scopeId!=='string'||!observed.scopeId.length||observed.scopeId.length>160||typeof observed.revision!=='string'||!HEX.test(observed.revision))throw fail('scope_invalid');const access=Object.freeze(clone(observed));
      const seen=new Set(),sequences=new Map(),value=await rawCoverage({context,access,seen,sequences},options);
      if(host.assertScope(context,access)!==true||[...seen].some(sid=>host.assertAuthorized(sid,context,access)!==true||host.sourceSequence(sid)!==sequences.get(sid)))throw fail('disclosure_changed');
      return value;
    }
    const step=(limit=1,context)=>run(async()=>{
      if(isPaused())return coverage(context);building=true;
      try{await beginBuilding();const catalog=await host.catalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');await purgeMissing(catalog);let built=0;for(const sid of catalog){checkPaused();if(await build(sid)&&++built>=Math.min(16,Math.max(1,limit)))break;}
      }catch(error){if(error.code!=='session_fulltext.paused')throw error;}
      finally{building=false;await state(paused?'paused':'idle');}
      return coverage(context);
    });
    // The private production preparation path walks each catalog entry once.
    // Public step retains its bounded <=16 contract and original coverage result.
    const prepare=(context,options={})=>run(async()=>{
      options.check?.();if(isPaused())return coverage(context,options);
      const observed=await host.scope(context);if(keys(observed)!=='revision,scopeId'||typeof observed.scopeId!=='string'||!observed.scopeId.length||observed.scopeId.length>160||typeof observed.revision!=='string'||!HEX.test(observed.revision))throw fail('scope_invalid');const access=Object.freeze(clone(observed));
      const assertAccess=()=>{if(host.assertScope(context,access)!==true)throw fail('disclosure_changed');};
      const preparationKey=options.preparationKey??access.scopeId;
      const finish=async()=>{assertAccess();const value=await coverage(context,options);assertAccess();return value;};
      if(isPaused())return options.incremental?{done:false}:finish();
      if(options.incremental===true){const catalog=await host.catalog(),prior=preparationProgress.get(preparationKey);options.check?.();assertAccess();if(Array.isArray(catalog)&&prior?.signature===hash(JSON.stringify(catalog))&&prior.next>=catalog.length)return {done:true};}
      let singleSid=null,buildingSid=null;const check=()=>{checkPaused();assertAccess();const sid=singleSid||buildingSid;if(sid&&host.assertAuthorized(sid,context,access)!==true)throw fail('disclosure_changed');options.check?.();};
      check();building=true;let failed=false,failure;
      try{
        await beginBuilding();check();const catalog=await host.catalog();check();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
        const authorized=async sid=>typeof host.authorizedEpoch==='function'&&host.assertAuthorized(sid,context,access)===true||await host.authorize(sid,context,access)===true;
        if(options.incremental===true){const signature=hash(JSON.stringify(catalog)),prior=preparationProgress.get(preparationKey),progress=prior?.signature===signature?prior:{signature,next:0};preparationProgress.set(preparationKey,progress);while(preparationProgress.size>32)preparationProgress.delete(preparationProgress.keys().next().value);
          // 150 S6:线程搜索原来每发只建 16 个会话,随后对全库复核,建完 N 个会话要 N/16 发。改为按时间片:每发至少推进 16 个
          // (修前的保证,负载下也不比修前少;显式传 options.sliceMs 时至少 1 个),之后片用完(默认 1.5 s)或到条数上限(256)才停;进度照旧只在一条会话建完后推进(失败的那条下一发重试)。
          const threadSlice=options.threadSearch===true,batchSize=threadSlice?256:64,sliceMs=Number.isFinite(options.sliceMs)?Math.max(0,options.sliceMs):threadSlice?PREPARE_SLICE_MS:Infinity,sliceEnd=Date.now()+sliceMs,minimum=threadSlice&&!Number.isFinite(options.sliceMs)?16:1;let advanced=0;
          const end=Math.min(catalog.length,progress.next+batchSize);for(;progress.next<end;){check();const sid=catalog[progress.next];if(await authorized(sid)){buildingSid=sid;check();if(await build(sid,check))options.onPrepared?.();check();buildingSid=null;}progress.next++;if(++advanced>=minimum&&Date.now()>=sliceEnd)break;}
        }else{if(options.single===true){if(catalog.length!==1||!await authorized(catalog[0]))throw fail('source_denied');singleSid=catalog[0];check();}
          else await purgeMissing(catalog,check);check();let visited=0;
          for(const sid of catalog){check();if(singleSid||await authorized(sid)){buildingSid=sid;check();await build(sid,check);check();buildingSid=null;}if(++visited%16===0){await require('node:timers/promises').setImmediate();check();}}}
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
      if(options.incremental===true){const progress=preparationProgress.get(preparationKey),catalog=await host.catalog();check();const done=!!progress&&progress.signature===hash(JSON.stringify(catalog))&&progress.next>=catalog.length;if(progress)progress.done=done;return {done};}
      return finish();
    });
    function resetPreparation(scopeId){preparationProgress.delete(scopeId);}
    function preparationComplete(scopeId){return preparationProgress.get(scopeId)?.done===true;}
    async function search(query,context,limit=20,options={}){
      // 150 S5(2D 复审):切片缓存世代在读任何正文之前取;这一发若跨过了 invalidate/pause/维护的清空,回读切片只现算、不放回缓存。
      const sliceGeneration=SLICE_CACHE.generation;
      const check=typeof options.check==='function'?options.check:()=>{};check();
      // 150 S15:调用方已知语义关(配置 semanticRetrievalV1:false)时零语义开销 —— 不建语义行、不算窗口摘要、不碰运行时。
      // semanticDeferred:调用方这一发还在建正文索引,语义留到下一发(状态 deferred,与纯词法预览同口径,但命中照旧全量回读)。
      const semanticOff=options.semanticDisabled===true,semanticLater=options.lexicalOnly===true||options.semanticDeferred===true,semantic=semanticLater||semanticOff?null:host.semantic||null;
      if(typeof query!=='string'||query.length<2||query.length>OVERLAP)throw fail('query_invalid');
      const observed=await host.scope(context);if(keys(observed)!=='revision,scopeId'||typeof observed.scopeId!=='string'||!observed.scopeId.length||observed.scopeId.length>160||typeof observed.revision!=='string'||!HEX.test(observed.revision))throw fail('scope_invalid');const access=Object.freeze(clone(observed));
      const terms=[...new Set(host.terms(query).filter(term=>typeof term==='string'&&!term.startsWith('#')).map(normalize))];
      const phrase=normalize(query);if(!phrase.length||phrase.length>OVERLAP||!phrase.trim())throw fail('query_invalid');
      const identify=typeof SemanticRetrieval!=='undefined'&&typeof SemanticRetrieval.structuredIds==='function'?SemanticRetrieval.structuredIds:()=>[],requiredIds=identify(query);
      const idChar=char=>[...char.normalize('NFKC').toLowerCase()].every(value=>'abcdefghijklmnopqrstuvwxyz0123456789-_:'.includes(value));
      const identifierAt=(text,id)=>{const needle=id.toUpperCase();for(let at=text.indexOf(needle);at>=0;at=text.indexOf(needle,at+1)){let left=at,right=at+needle.length;while(left>0&&at-left<512&&idChar(text[left-1]))left--;while(right<text.length&&right-at-needle.length<512&&idChar(text[right]))right++;if(left>0&&idChar(text[left-1])||right<text.length&&idChar(text[right]))continue;if(identify(text.slice(left,right)).includes(id))return at;}return -1;};
      const needed=Math.max(1,Math.ceil(terms.length/2)),cap=Math.min(50,Math.max(1,Math.floor(Number(limit)||20))),candidateLimit=4096,candidates=[],semanticRows=[],manifests=new Map();
      let fragmentCount=0,entityTruncated=false,lexicalTruncated=false,lexicalPartial=false;
      const semanticTotals=new Map(),semanticEvidence=new Map(),metadataTotals=new Map(),metadataEvidence=new Map(),sourceKeyOf=row=>JSON.stringify([row.sessionId,row.messageOrdinal,row.source,row.contentRevision]);
      // The public consumers limit session results. A dense session gets one
      // best citation, never all of the bounded global candidate slots.
      const compare=(a,b)=>b.score-a.score||a.row.sessionId.localeCompare(b.row.sessionId)||a.row.messageOrdinal-b.row.messageOrdinal||a.row.chunkOrdinal-b.row.chunkOrdinal||a.start-b.start||a.row.source.localeCompare(b.row.source);
      const searchMutation=mutationState(),scannedManifests=new Map();const catalog=await host.catalog();if(!Array.isArray(catalog)||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
      const scanIndex=async sid=>{check();const candidates=[],semanticRows=[],entitySources=new Map(),termSources=new Map();let fragmentCount=0,entityTruncated=false,lexicalTruncated=false;const totals=new Map();const addCandidate=hit=>{if(candidates.length<candidateLimit){let at=candidates.push(hit)-1;while(at>0){const parent=(at-1)>>1;if(compare(candidates[at],candidates[parent])<=0)break;[candidates[at],candidates[parent]]=[candidates[parent],candidates[at]];at=parent;}return;}lexicalTruncated=true;if(compare(hit,candidates[0])>=0)return;candidates[0]=hit;let at=0;for(;;){let child=at*2+1;if(child>=candidates.length)break;if(child+1<candidates.length&&compare(candidates[child+1],candidates[child])>0)child++;if(compare(candidates[child],candidates[at])<=0)break;[candidates[at],candidates[child]]=[candidates[child],candidates[at]];at=child;}};
        if(!valid(sid))throw fail('catalog_invalid');
        const already=typeof host.authorizedEpoch==='function'&&host.assertAuthorized(sid,context,access)===true;
        if(!already&&await host.authorize(sid,context,access)!==true)return null;
        const value=await currentManifest(sid),authorized=typeof host.authorizedEpoch==='function'?host.authorizedEpoch(sid,context,access):await host.epoch(sid);scannedManifests.set(sid,value);
        if(!value||!compatible(value)||value.epoch!==authorized)return null;let best=null;
        for(const ref of value.shards){check();
          const shard=await read(sid,value.generation+'.'+ref.ordinal+'.json',SHARD_BYTES,ref.ordinal===0);if(!shard||hash(JSON.stringify(shard))!==ref.sha256||shard.schema!==SCHEMA||shard.sessionId!==sid||shard.generation!==value.generation||shard.ordinal!==ref.ordinal||!Array.isArray(shard.rows)||shard.rows.length!==ref.records){if(await retired(sid,value))break;throw fail('shard_invalid');}
          for(const row of shard.rows){check();
            if(keys(row)!=='canonicalStart,chunkOrdinal,contentRevision,coordinate,end,messageId,messageIdBasis,messageOrdinal,ranges,sessionId,source,start,text,turnSeq,turnSeqBasis'||row.coordinate!=='utf16'||!['explicit','legacy-inferred'].includes(row.turnSeqBasis)||!['intrinsic','physical-ordinal'].includes(row.messageIdBasis)||!(/^(?:content(?:\.\d+(?:\.text)?)?|blocks\.\d+(?:\.text)?|segments\.\d+\.text|attachments\.\d+\.(?:textPreview|transcript|ocrText|extractedText))$/).test(row.source)||row.sessionId!==sid||!integer(row.messageOrdinal)||!integer(row.turnSeq)||typeof row.messageId!=='string'||row.messageId.length>256||!HEX.test(row.contentRevision||'')||!integer(row.chunkOrdinal)||!integer(row.start)||!integer(row.end)||typeof row.source!=='string'||typeof row.text!=='string'||row.end<=row.start||!integer(row.canonicalStart)||!row.text.length||row.text.length>CHARS||!rangesValid(row))throw fail('shard_invalid');
            const sourceKey=JSON.stringify([row.messageOrdinal,row.source,row.contentRevision]),rowIds=requiredIds.length?identify(row.text).filter(id=>requiredIds.includes(id)&&identifierAt(row.text,id)>=0):[];let entity=entitySources.get(sourceKey);if(entity)entity.maxStart=Math.max(entity.maxStart,row.canonicalStart);
            if(rowIds.length){if(!entity){if(entitySources.size>=4096)entityTruncated=true;else{entity={ids:new Set(),hits:[],maxStart:row.canonicalStart};entitySources.set(sourceKey,entity);}}if(entity)for(const id of rowIds)entity.ids.add(id);}
            const exact=row.text.indexOf(phrase),matched=terms.filter(term=>row.text.includes(term)),windowHash=semantic||exact>=0||matched.length>0||rowIds.length?digest({text:row.text,ranges:row.ranges}):null;
            // 150 S6:check 只在逐行处做一次(上面 for 循环头);逐 96 字窗不再各调一次。窗口循环是同步的纯计算,
            // 一行至多 4096 字 ≈ 43 窗,行间的那次 check 照样能截住撤权、取消与截止。
            if(semantic){for(let at=0;at<row.text.length;){const semanticKey=sourceKeyOf(row);totals.set(semanticKey,(totals.get(semanticKey)||0)+1);let next=Math.min(row.text.length,at+96);if(next<row.text.length&&row.text.charCodeAt(next)>=0xdc00&&row.text.charCodeAt(next)<=0xdfff)next--;
              if(semanticRows.length<4096){const width=next-at,start=rangeAt(row.ranges,at).from,end=rangeAt(row.ranges,next-1).to;
                semanticRows.push({text:row.text.slice(at,next),identity:[sid,value.epoch,value.sourceRevision,value.generation,row.contentRevision,row.source,row.canonicalStart,at,start,end,windowHash],hit:{row:Object.freeze({...row,text:undefined,ranges:undefined,canonicalStart:undefined}),canonicalStart:row.canonicalStart,windowHash,at,width,epoch:value.epoch,sourceRevision:value.sourceRevision,start,end}});}fragmentCount++;
              if(next===row.text.length)break;let following=next-16;if(row.text.charCodeAt(following)>=0xdc00&&row.text.charCodeAt(following)<=0xdfff)following--;at=following;}}
            if(requiredIds.length&&!rowIds.length||!requiredIds.length&&exact<0&&!matched.length)continue;
            const idTerm=requiredIds.length?rowIds[0].toUpperCase():null,at=requiredIds.length?identifierAt(row.text,rowIds[0]):exact>=0?exact:row.text.indexOf(matched[0]),width=requiredIds.length?idTerm.length:exact>=0?phrase.length:matched[0].length;
            const start=rangeAt(row.ranges,at).from,end=rangeAt(row.ranges,at+width-1).to;if(!integer(start)||!integer(end))throw fail('shard_invalid');
            const hit={row:Object.freeze({...row,text:undefined,ranges:undefined,canonicalStart:undefined}),canonicalStart:row.canonicalStart,windowHash,at,width,epoch:value.epoch,sourceRevision:value.sourceRevision,entity:requiredIds.length>0,edge:at+width===row.text.length,exact:exact>=0||requiredIds.length>0,score:requiredIds.length?(exact>=0?90:60)+matched.length:(exact>=0?30:0)+matched.length,start,end};
            if(!requiredIds.length&&terms.length){let group=termSources.get(sourceKey);if(!group){if(termSources.size<4096){group={terms:new Set(),hit};termSources.set(sourceKey,group);}else lexicalTruncated=true;}if(group)for(const term of matched)group.terms.add(term);}
            if(!requiredIds.length&&exact<0&&matched.length<needed)continue;
            if(!requiredIds.length){const group=termSources.get(sourceKey);if(group)group.hasCandidate=true;}
            if(requiredIds.length&&entity){if(entity.hits.length<32)entity.hits.push(hit);else{entityTruncated=true;const replace=entity.hits.findIndex(item=>item.edge);if(!hit.edge&&replace>=0)entity.hits[replace]=hit;}}
            else addCandidate(hit);
          }
        }
        if(!requiredIds.length&&terms.length)for(const group of termSources.values())if(!group.hasCandidate&&terms.every(term=>group.terms.has(term)))addCandidate(group.hit);
        if(candidates.length>candidateLimit){candidates.sort(compare);candidates.length=candidateLimit;lexicalTruncated=true;}
        if(requiredIds.length){const eligible=new Set([...entitySources].filter(([,value])=>requiredIds.every(id=>value.ids.has(id))).map(([key])=>key));for(const [key,value]of entitySources)if(eligible.has(key))candidates.push(...value.hits.filter(hit=>!hit.edge||hit.canonicalStart===value.maxStart));for(let n=semanticRows.length-1;n>=0;n--){const row=semanticRows[n].hit.row;if(!eligible.has(JSON.stringify([row.messageOrdinal,row.source,row.contentRevision])))semanticRows.splice(n,1);}fragmentCount=0;for(const [key,count]of totals){const [,ordinal,source,revision]=JSON.parse(key);if(eligible.has(JSON.stringify([ordinal,source,revision])))fragmentCount+=count;}candidates.sort(compare);if(candidates.length>candidateLimit){entityTruncated=true;candidates.length=candidateLimit;}if(entityTruncated)fragmentCount++;}
        if(sessionResults&&!requiredIds.length){const perSource=new Map();for(const hit of candidates.sort(compare)){const key=sourceKeyOf(hit.row);if(!perSource.has(key))perSource.set(key,hit);}const bounded=[...perSource.values()].sort(compare);if(bounded.length>candidateLimit)lexicalTruncated=true;candidates.splice(0,candidates.length,...bounded.slice(0,candidateLimit));}
        return {sid,value,candidates,semanticRows,fragmentCount,entityTruncated,lexicalTruncated,totals};
      };
      check();{const scanned=await orderedPool(catalog,scanIndex,{onSettled:part=>{if(!part)return;manifests.set(part.sid,part.value);fragmentCount+=part.fragmentCount;entityTruncated||=part.entityTruncated;lexicalTruncated||=part.lexicalTruncated;for(const [key,count]of part.totals)semanticTotals.set(key,(semanticTotals.get(key)||0)+count);
          semanticRows.push(...part.semanticRows.slice(0,Math.max(0,4096-semanticRows.length)));candidates.push(...part.candidates);candidates.sort(compare);if(candidates.length>candidateLimit){if(requiredIds.length)entityTruncated=true;lexicalTruncated=true;candidates.length=candidateLimit;}}});
        const failure=poolFailure(scanned.settled,options.timeout);if(failure)throw failure;}
      const metadataRows=[];let metadataTruncated=options.metadataEntriesTruncated===true;
      if(semantic&&Array.isArray(options.metadataEntries)){for(const item of options.metadataEntries){check();if(!item||!valid(item.sid)||typeof item.field!=='string'||typeof item.text!=='string'||typeof item.epoch!=='string'||item.text.length>8192){metadataTruncated=true;continue;}const key=JSON.stringify([item.sid,item.field]);for(let at=0;at<item.text.length;){let end=Math.min(item.text.length,at+96);if(end<item.text.length&&item.text.charCodeAt(end)>=0xdc00&&item.text.charCodeAt(end)<=0xdfff)end--;metadataTotals.set(key,(metadataTotals.get(key)||0)+1);if(metadataRows.length<256)metadataRows.push({text:item.text.slice(at,end),identity:['metadata',item.sid,item.field,item.epoch,digest(item.text),at,end],metadata:item,metadataKey:key,hit:{row:{sessionId:item.sid},epoch:item.epoch}});else metadataTruncated=true;if(end===item.text.length)break;let next=end-16;if(item.text.charCodeAt(next)>=0xdc00&&item.text.charCodeAt(next)<=0xdfff)next--;at=next;}}}
      if(metadataRows.length){if(semanticRows.length+metadataRows.length>4096)metadataTruncated=true;semanticRows.splice(0,0,...metadataRows);if(semanticRows.length>4096)semanticRows.length=4096;}
      let semanticState={status:options.lexicalOnly===true?'deferred':semanticOff?'disabled':semanticLater?'deferred':semantic?'empty':'unavailable',coverage:{cached:0,total:semanticRows.length,complete:false}};
      let ranked=[],gemmaDecision=typeof SemanticRuntimeTransportProof!=='undefined'&&SemanticRuntimeTransportProof.isMethod(options.method)?{complete:false,policyId:SemanticWindowPolicy.CONTRACT.id}:null;const gemmaMetadata=new Map(),gemmaWeak=new Map();
      if(semantic&&semanticRows.length){
        // Lexical shard text is uppercased. Resolve original spelling through
        // the authenticated source owner only when a vector is not cached.
        const semanticDeadline=Math.min(Date.now()+1000,Number.isFinite(options.deadline)?options.deadline:Infinity),policyContext=typeof SemanticOriginalWindows!=='undefined'?SemanticOriginalWindows.createRequest({query,scopeId:access.scopeId,modelFingerprint:SemanticWindowPolicy.CONTRACT.modelFingerprint}):null;
        const sourceExpired=Object.freeze({semanticSourceBudget:true}),sourceCheck=()=>{check();if(options.signal?.aborted)throw options.signal.reason===undefined?Error('semantic.aborted'):options.signal.reason;if(Date.now()>=semanticDeadline)throw sourceExpired;};
        const originalFragments=new Map(),originalFields=new Map(),loadedSources=new Set(),sourceSequences=new Map(),sourceGuards=new Map();let activeSids=[],activeMetadata=new Set();
        // 150 S8:回验分两档。权威复核(重读会话头与 epoch、附件与元数据复核)只在来源解析时(host.scan 首尾读头并核 epoch)
        // 和整次 score 结束后各做一次;编码前后那几次(06ha 前后各一、06hb 写入前与回包后各一)改为同步的廉价比对:
        // scope、授权表、进程内 sequence —— 进程内任何写都推 sequence,撤权与改写在下一次比对就拦住;外部改盘由结束时
        // 的权威复核拦住,该次结果整体作废(与修前编码中途撤权同一结局:整次搜索报错,不披露)。窗口策略(Gemma2)
        // 自己的 start/finish 两次 verify 也走权威档,逐窗 resolved 那几次走廉价档。
        // 截止只由语义层自己判(06ha 每批前看期限、06hb 写入前看期限),回验不再抛「预算用完」—— 修前编码刚回来、回包后那次
        // 回验撞上截止就把刚算好的整批连同本次全部进度一起丢掉,回报 cached=0(S13)。
        const sampleEpoch=sid=>semanticRows.find(entry=>entry.hit.row.sessionId===sid).hit.epoch,verifiedMetadata=new Set();
        const beforeEncode=async()=>{
          check();
          if(host.assertScope(context,access)!==true)throw fail('disclosure_changed');
          // 还没核实过的来源(截止前没来得及回读)交回的是 null,不会进编码;只比对已核实的。
          for(const sid of activeSids){if(!sourceSequences.has(sid))continue;if(host.sourceSequence(sid)!==sourceSequences.get(sid))throw fail('source_changed');if(host.assertAuthorized(sid,context,access)!==true)throw fail('source_denied');}
        };
        const authoritative=async()=>{
          check();
          if(host.assertScope(context,access)!==true)throw fail('disclosure_changed');
          const sids=[...new Set([...loadedSources,...[...verifiedMetadata].map(item=>item.sid)])];
          for(const sid of sids){if(await host.authorize(sid,context,access)!==true)throw fail('source_denied');
            if(await host.epoch(sid)!==sampleEpoch(sid)||host.sourceSequence(sid)!==sourceSequences.get(sid))throw fail('source_changed');
            for(const guard of sourceGuards.get(sid)||[])if(!await guard())throw fail('source_changed');for(const item of verifiedMetadata)if(item.sid===sid&&!await options.verifyMetadata(item))throw fail('source_changed');
          }
          if(host.assertScope(context,access)!==true||sids.some(sid=>host.assertAuthorized(sid,context,access)!==true||host.sourceSequence(sid)!==sourceSequences.get(sid)))throw fail('disclosure_changed');
        };
        const resolveTexts=async indices=>{
          activeSids=[...new Set(indices.map(n=>semanticRows[n].hit.row.sessionId))];activeMetadata=new Set(indices.map(n=>semanticRows[n].metadata).filter(Boolean));
          for(const meta of activeMetadata){sourceCheck();if(typeof options.verifyMetadata!=='function'||!await options.verifyMetadata(meta))throw fail('source_changed');sourceSequences.set(meta.sid,host.sourceSequence(meta.sid));verifiedMetadata.add(meta);}
          for(const n of indices){sourceCheck();if(semanticRows[n].metadata)continue;const sid=semanticRows[n].hit.row.sessionId;if(loadedSources.has(sid))continue;
            if(await host.authorize(sid,context,access)!==true)throw fail('source_denied');
            const rows=semanticRows.map((entry,index)=>({entry,index})).filter(item=>!item.entry.metadata&&item.entry.hit.row.sessionId===sid);
            const policy=attachmentSource&&rows.some(item=>attachmentField.test(item.entry.hit.row.source))?await host.enabled():null,budget=attachmentBudget();
            let sourceTurn=0,sourceTurnBasis='legacy-inferred';const checks=new Set(),fragments=new Map(),fields=new Map();
            const proof=await host.scan(sid,async(row,ordinal)=>{
              if(row.role==='user'){sourceTurn=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?row.turnSeq:sourceTurn+1;sourceTurnBasis=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?'explicit':'legacy-inferred';}
              const explicit=row.turnSeq??row.turnSummary?.turnSeq;if(Number.isSafeInteger(explicit)&&explicit>=0){sourceTurn=explicit;sourceTurnBasis='explicit';}
              if(host.noise(row))return;
              const attachments=policy!==null?attachmentCandidates(row,budget):[];
              const chosen=rows.filter(item=>item.entry.hit.row.messageOrdinal===ordinal);if(!chosen.length)return;
              const revision=digest(row),parts=sources(row);
              if(policy!==null&&chosen.some(item=>attachmentField.test(item.entry.hit.row.source)))parts.push(...await extractedSources(row,policy,await selectedAttachments(attachments,policy)));
              const intrinsic=typeof row.id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id),messageId=intrinsic?row.id:'legacy-ordinal:'+ordinal,windows=new Map(),neededWindows=new Set(chosen.map(item=>item.entry.hit.row.source+'\0'+item.entry.hit.canonicalStart));let chunkOrdinal=0;
              for(const part of parts){for(const window of slices(part.text,sliceGeneration)){const key=part.field+'\0'+window.canonicalStart;if(neededWindows.has(key))windows.set(key,{window,chunkOrdinal});chunkOrdinal++;if(windows.size===neededWindows.size)break;}if(windows.size===neededWindows.size)break;}
              for(const {entry,index}of chosen){const hit=entry.hit,source=parts.find(part=>part.field===hit.row.source);
                if(!source||hit.end>source.text.length||hit.row.contentRevision!==(source.revision?digest([revision,source.revision]):revision))continue;
                const found=windows.get(source.field+'\0'+hit.canonicalStart),window=found?.window;
                if(!window||found.chunkOrdinal!==hit.row.chunkOrdinal||window.start!==hit.row.start||window.end!==hit.row.end||hit.row.messageId!==messageId||hit.row.messageIdBasis!==(intrinsic?'intrinsic':'physical-ordinal')||hit.row.turnSeq!==sourceTurn||hit.row.turnSeqBasis!==sourceTurnBasis||digest({text:window.text,ranges:window.ranges})!==hit.windowHash||rangeAt(window.ranges,hit.at).from!==hit.start||rangeAt(window.ranges,hit.at+hit.width-1).to!==hit.end)throw fail('shard_source_mismatch');
                if(source.revalidate&&!checks.has(source.revalidate)){if(!await source.revalidate())throw fail('source_changed');checks.add(source.revalidate);}
                const text=source.text.slice(hit.start,hit.end);if(text.length<=8192)fragments.set(index,text);fields.set(index,source.text);
              }
            },{check:sourceCheck});
            if(!proof||rows.some(item=>item.entry.hit.epoch!==proof.epoch||item.entry.hit.sourceRevision!==proof.revision)||await host.epoch(sid)!==proof.epoch||host.assertScope(context,access)!==true)throw fail('source_changed');
            // 原文片段只在整条来源回读完、epoch 与 revision 都核过之后才并入;中途撞截止的那条一字不留。
            for(const [index,text]of fragments)originalFragments.set(index,text);for(const [index,text]of fields)originalFields.set(index,text);
            sourceSequences.set(sid,host.sourceSequence(sid));sourceGuards.set(sid,checks);loadedSources.add(sid);
          }
          await beforeEncode();
          return indices.map(n=>semanticRows[n].metadata?semanticRows[n].text:(originalFragments.get(n)??null));
        };
        // 交给 06ha 的那一份:解析途中撞上截止不再整次抛出(修前抛到 score 外,本次已编好的批次连同计数一起作废),而是交回
        // 已核实的那部分,其余记 null —— 06ha 照旧只编可用的、下一批之前看期限收尾,已缓存的向量计入本次覆盖。
        const budgetedResolve=async indices=>{
          try{return await resolveTexts(indices);}
          catch(error){if(error!==sourceExpired)throw error;await beforeEncode();return indices.map(n=>semanticRows[n].metadata?(verifiedMetadata.has(semanticRows[n].metadata)?semanticRows[n].text:null):(originalFragments.get(n)??null));}
        };
        // 150 号文 S1:语义层自己的非守卫失败(运行时起不来、契约违例)退回词法结果并标 unavailable,不再 500;
        // 交给语义层的两个回调经 SemanticFailurePolicy.guard 包过,它们抛的(撤权、源变化、取消、privacy)照常上抛。
        try{semanticState=await semantic.score(query,semanticRows.map(row=>row.text),{scopeId:access.scopeId,identities:semanticRows.map(row=>row.identity),maxEncodeDocuments:128,resolveTexts:semanticFailures.guard(budgetedResolve),beforeEncode:semanticFailures.guard(beforeEncode),policyContext,deadline:semanticDeadline,signal:options.signal});}catch(error){if(error!==sourceExpired&&semanticFailures.degradable(error,options.signal)){semanticState={status:'unavailable',scores:semanticRows.map(()=>null),coverage:{cached:0,total:semanticRows.length,complete:false}};}else{if(error!==sourceExpired)throw error;const descriptor=typeof SemanticRuntimeHooks!=='undefined'?SemanticRuntimeHooks.descriptor():null;semanticState={status:'timeout',scores:semanticRows.map(()=>null),coverage:{cached:0,total:semanticRows.length,complete:false},...(typeof SemanticWindowPolicy!=='undefined'&&descriptor?.modelId===SemanticWindowPolicy.CONTRACT.modelId?{modelFingerprint:SemanticWindowPolicy.CONTRACT.modelFingerprint}:{})};}}
        check();await authoritative();
        if(policyContext&&(gemmaDecision||SemanticRetrieval.hasScoreEvidence(semanticState)||semanticState.modelFingerprint===SemanticWindowPolicy.CONTRACT.modelFingerprint)){
          const expired=Object.freeze({semanticBudget:true}),guard=()=>{check();if(options.signal?.aborted)throw options.signal.reason===undefined?Error('semantic.aborted'):options.signal.reason;if(Date.now()>=semanticDeadline)throw expired;},policy=SemanticWindowPolicy.createSemanticCoarsePolicy({identify,normalize,terms:retrievalTerms}),rawRows=[],entries=[],rowSources=[],tokens=new Map(),fieldRows=new Map(),canonical=new Map(),sourceIndices=[];
          try{
            guard();await resolveTexts(semanticRows.map((_,n)=>n));guard();
            for(let n=0;n<semanticRows.length;n++){guard();const row=semanticRows[n],full=row.metadata?row.metadata.text:originalFields.get(n);if(typeof full!=='string')continue;const identity=row.metadata?{sourceId:row.metadata.sid,field:'metadata.'+row.metadata.field,revision:digest(full),epoch:row.metadata.epoch,sourceRevision:row.metadata.epoch}:{sourceId:JSON.stringify([row.hit.row.sessionId,row.hit.row.messageId]),field:row.hit.row.source,revision:row.hit.row.contentRevision,epoch:row.hit.epoch,sourceRevision:row.hit.sourceRevision},token=policyContext.captureField(identity,full,row.metadata?'raw-metadata-v1':'canonical-message-v3');let source;
              if(row.metadata)source=policyContext.rawWindow(token,row.identity.at(-2),row.identity.at(-1));else{let windows=canonical.get(token);if(!windows){windows=new Map();for(const window of policyContext.canonicalSlices(token)){guard();windows.set(window.canonicalStart,window);}canonical.set(token,windows);}source=policyContext.canonicalWindow(token,windows.get(row.hit.canonicalStart),row.hit.at,row.hit.width);}
              const raw=policyContext.row(source,[row.hit.row.sessionId,row.hit.row.messageOrdinal??-1,row.hit.row.source??row.metadata.field],row.identity),key=row.metadata?row.metadataKey:sourceKeyOf(row.hit.row);if(!tokens.has(key))tokens.set(key,policyContext.weakKey(token));if(!fieldRows.has(key))fieldRows.set(key,rawRows.length);rawRows.push(raw);entries.push(SemanticRetrieval.hasScoreEvidence(semanticState)?{result:semanticState,index:n}:null);rowSources.push({source,token,full,n});sourceIndices.push(n);
            }
            const coverage=await rawCoverage({context,access,seen:new Set(),sequences:new Map()},{check:guard,timeout:expired});guard();
            const decision=await policy.evaluate({query,scopeId:access.scopeId,modelFingerprint:SemanticWindowPolicy.CONTRACT.modelFingerprint,rows:rawRows,lexical:candidates.filter(hit=>fieldRows.has(sourceKeyOf(hit.row))).map(hit=>({key:tokens.get(sourceKeyOf(hit.row)),index:fieldRows.get(sourceKeyOf(hit.row))})),scoreEntries:entries,poolComplete:coverage.complete===true&&rawRows.length===semanticRows.length&&fragmentCount<=semanticRows.length-metadataRows.length&&!metadataTruncated&&!entityTruncated&&!lexicalTruncated,context:policyContext.context,windowContext:policyContext,deadline:semanticDeadline,signal:options.signal,
              resolve:async(index,whole)=>{guard();const item=rowSources[index];await resolveTexts([item.n]);guard();if((semanticRows[item.n].metadata?semanticRows[item.n].metadata.text:originalFields.get(item.n))!==item.full)throw fail('source_changed');return whole?policyContext.wholeSource(item.token):item.source;},beforeVerify:async event=>{guard();activeSids=[...new Set(rowSources.map(item=>semanticRows[item.n].hit.row.sessionId))];activeMetadata=new Set(rowSources.map(item=>semanticRows[item.n].metadata).filter(Boolean));if(event?.phase==='resolved')await beforeEncode();else await authoritative();guard();}});
            try{const d=policy.decisions(decision,policyContext.context),accepted=semanticRows.map(()=>null);d.semanticAccepted.forEach((value,index)=>{accepted[sourceIndices[index]]=value;});for(const [key,token]of tokens){const verdict=d.weakAccepted.get(token);if(verdict!==undefined)gemmaWeak.set(key,verdict);const index=d.weakWindowIndices.get(token);if(index!==undefined){const chosen=sourceIndices[index];for(let n=0;n<candidates.length;n++)if(sourceKeyOf(candidates[n].row)===key)candidates[n]={...semanticRows[chosen].hit,score:candidates[n].score,entity:false,edge:false,exact:false,verifiedWindow:true};}const field=fieldRows.get(key);if(field!==undefined&&rawRows[field].metadata)gemmaMetadata.set(key,d.metadataAccepted.get(rawRows[field].fieldKey)??null);}gemmaDecision={complete:decision.complete,policyId:decision.policyId};semanticState={...semanticState,admission:{policyId:decision.policyId,purpose:'search-relevance',answerability:'not-assessed',status:decision.status,accepted},coverage:{...semanticState.coverage,complete:decision.complete}};}finally{policy.dispose(decision,policyContext.context);}
          }catch(error){if(error!==expired&&error!==sourceExpired)throw error;gemmaDecision={complete:false,policyId:SemanticWindowPolicy.CONTRACT.id};semanticState={...semanticState,status:'timeout',admission:{policyId:gemmaDecision.policyId,purpose:'search-relevance',answerability:'not-assessed',status:'partial',accepted:semanticRows.map(()=>null)},coverage:{...semanticState.coverage,complete:false}};}
        }
        if(host.assertScope(context,access)!==true)throw fail('disclosure_changed');
        const admission=semanticState.admission;
        if(admission&&(!Array.isArray(admission.accepted)||admission.accepted.length!==semanticRows.length||admission.accepted.some(value=>value!==true&&value!==false&&value!==null)||!['evaluated','partial','uncalibrated'].includes(admission.status)))throw fail('semantic_policy_invalid');
        for(let n=0;n<semanticRows.length;n++){const row=semanticRows[n],key=row.metadata?row.metadataKey:sourceKeyOf(row.hit.row),evidences=row.metadata?metadataEvidence:semanticEvidence,score=semanticState.scores[n],decision=admission?admission.accepted[n]:Number.isFinite(score)?score>=(semanticState.minScore??0.85):null;let entry=evidences.get(key);if(!entry){entry={scored:0,accepted:false};evidences.set(key,entry);}if(Number.isFinite(score)&&typeof decision==='boolean'){entry.scored++;if(decision)entry.accepted=true;}}
        ranked=semanticRows.map((row,n)=>({...row.hit,metadata:!!row.metadata,semanticScore:semanticState.scores[n],score:semanticState.scores[n],rankScore:semanticState.scores[n]})).filter((hit,n)=>!hit.metadata&&typeof hit.semanticScore==='number'&&Number.isFinite(hit.semanticScore)&&(admission?admission.accepted[n]===true:hit.semanticScore>=(semanticState.minScore??0.85))).sort(compare);
        // Exact phrases retain priority; other lexical and semantic evidence
        // contribute comparable reciprocal ranks before the final result cap.
      }
        {
          const identity=hit=>[hit.row.sessionId,hit.row.messageId,hit.row.source,hit.canonicalStart].join('\0');
          const fused=new Map();
          candidates.sort(compare).forEach((hit,n)=>{const id=identity(hit);if(!fused.has(id))fused.set(id,{hit,rankScore:1/(61+n),exact:!!hit.exact,lexical:true,lexicalRank:n});});
          const seen=new Set();let rank=0;
          for(const hit of ranked){const id=identity(hit);if(seen.has(id))continue;seen.add(id);const prior=fused.get(id);
            if(prior){prior.rankScore+=1/(61+rank);prior.semanticRank=rank;if(!prior.exact)prior.hit=hit;}
            else fused.set(id,{hit,rankScore:1/(61+rank),exact:false,semanticRank:rank});rank++;
          }
          const merged=[...fused.values()].map(item=>({...item.hit,lexical:!!item.lexical,lexicalRank:item.lexicalRank,semanticRank:item.semanticRank,exact:item.exact,rankScore:item.rankScore+(item.exact?1:0)})).sort((a,b)=>b.rankScore-a.rankScore||compare(a,b));if(merged.length>candidateLimit)lexicalTruncated=true;candidates.splice(0,candidates.length,...merged.slice(0,candidateLimit));
        }
      const selected=new Map();for(const hit of candidates){const key=[hit.row.sessionId,hit.row.messageId,hit.row.contentRevision,hit.row.source,hit.start,hit.end].join('\0');if(!selected.has(key))selected.set(key,hit);}
      const results=[],verifiedHits=[],sequences=new Map(),sourceChecks=[],coverageReuse=new Map(),retainedSources=new Set();let retainedBytes=0;
      // 150 S6:逐会话回读源头核对命中,原来串行一条一条等 I/O;改成 4 路并发(与 scanIndex 同口径),保留字节的账在
      // 回读全部结束后按原来的会话顺序、原来的命中顺序记,截断判据与修前同序。已在本 scope 授权且 sequence 未变的会话
      // 不再重读会话头(scanIndex 刚读过;回读本身 host.scan 首尾各读一次头并核 epoch,外部改盘照样认得出)。
      const hitsBySid=new Map();for(const hit of selected.values()){const list=hitsBySid.get(hit.row.sessionId);if(list)list.push(hit);else hitsBySid.set(hit.row.sessionId,[hit]);}
      const verifySource=async sid=>{check();
        const already=typeof host.authorizedEpoch==='function'&&host.assertAuthorized(sid,context,access)===true;
        if(!already&&await host.authorize(sid,context,access)!==true)return null;const hits=hitsBySid.get(sid),resolved=[];
        const policy=attachmentSource&&hits.some(hit=>attachmentField.test(hit.row.source))?await host.enabled():null,budget=attachmentBudget();
        let sourceTurn=0,sourceTurnBasis='legacy-inferred',unverified=0;
        const proof=await host.scan(sid,async(row,ordinal)=>{
          if(row.role==='user'){sourceTurn=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?row.turnSeq:sourceTurn+1;sourceTurnBasis=Number.isSafeInteger(row.turnSeq)&&row.turnSeq>0?'explicit':'legacy-inferred';}
          const explicit=row.turnSeq??row.turnSummary?.turnSeq;if(Number.isSafeInteger(explicit)&&explicit>=0){sourceTurn=explicit;sourceTurnBasis='explicit';}
          if(host.noise(row))return;if(inspectSources(row).unverified)unverified++;
          const candidates=policy!==null?attachmentCandidates(row,budget):[];
          const rowHits=hits.filter(hit=>hit.row.messageOrdinal===ordinal);
          if(!rowHits.length)return;
          const revision=digest(row),parts=sources(row),intrinsic=typeof row.id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(row.id),messageId=intrinsic?row.id:'legacy-ordinal:'+ordinal;
          if(policy!==null&&rowHits.some(hit=>attachmentField.test(hit.row.source))){
            parts.push(...await extractedSources(row,policy,await selectedAttachments(candidates,policy)));
          }
          const windows=new Map(),neededWindows=new Set(rowHits.map(hit=>hit.row.source+'\0'+hit.canonicalStart));let windowOrdinal=0;
          for(const part of parts){for(const window of slices(part.text,sliceGeneration)){const key=part.field+'\0'+window.canonicalStart;if(neededWindows.has(key))windows.set(key,{window,chunkOrdinal:windowOrdinal});windowOrdinal++;if(windows.size===neededWindows.size)break;}if(windows.size===neededWindows.size)break;}
          for(const hit of rowHits){
            const source=parts.find(part=>part.field===hit.row.source);if(!source||hit.end>source.text.length)continue;const sourceIds=requiredIds.length?identify(source.text):[];if(requiredIds.some(id=>!sourceIds.includes(id)))continue;
            if(hit.entity){const part=source.text.slice(hit.start,hit.end).normalize('NFKC').toLowerCase();let left=hit.start,right=hit.end;while(left>0&&hit.start-left<512&&idChar(source.text[left-1]))left--;while(right<source.text.length&&right-hit.end<512&&idChar(source.text[right]))right++;if(left>0&&idChar(source.text[left-1])||right<source.text.length&&idChar(source.text[right])||!requiredIds.includes(part)||!identify(source.text.slice(left,right)).includes(part))continue;}
            if(hit.row.contentRevision!==(source.revision?digest([revision,source.revision]):revision))continue;
            const found=windows.get(source.field+'\0'+hit.canonicalStart),window=found?.window;const proven=!!window&&found.chunkOrdinal===hit.row.chunkOrdinal&&window.start===hit.row.start&&window.end===hit.row.end&&hit.row.messageId===messageId&&hit.row.messageIdBasis===(intrinsic?'intrinsic':'physical-ordinal')&&hit.row.turnSeq===sourceTurn&&hit.row.turnSeqBasis===sourceTurnBasis&&digest({text:window.text,ranges:window.ranges})===hit.windowHash&&rangeAt(window.ranges,hit.at).from===hit.start&&rangeAt(window.ranges,hit.at+hit.width-1).to===hit.end;if(!proven)throw fail('shard_source_mismatch');
            if(hit.lexical){const original=normalize(source.text),strong=!!requiredIds.length||original.includes(phrase)||(terms.length>0&&terms.every(term=>original.includes(term)));if(!strong){const key=sourceKeyOf(hit.row);if(gemmaDecision){const decision=gemmaWeak.get(key);if(decision!==true){if(decision!==false)lexicalPartial=true;if(hit.semanticRank!==undefined){delete hit.lexicalRank;hit.lexical=false;}else continue;}}else{const evidence=semanticEvidence.get(key),total=semanticTotals.get(key)||0;if(evidence?.accepted){}else if(total>0&&evidence?.scored===total)continue;else lexicalPartial=true;}}}
            const owner=sid+'\0'+ordinal+'\0'+source.field;
            const snippetStart=Math.max(0,hit.start-60),snippetEnd=Math.min(source.text.length,hit.end+120,snippetStart+600);
            resolved.push({owner,hit,sourceText:source.text,text:source.text.slice(snippetStart,snippetEnd),snippetEnd,snippetTruncated:snippetEnd<Math.min(source.text.length,hit.end+120),revalidate:source.revalidate});
          }
        },{check});
        if(!proof||proof.epoch!==hits[0].epoch||proof.revision!==hits[0].sourceRevision)return null;
        const sequence=host.sourceSequence(sid);if(typeof sequence!=='string'&&!(Number.isSafeInteger(sequence)&&sequence>=0))throw fail('source_invalid');
        return {sid,proof,sequence,unverified,resolved};
      };
      // 关键词先回(151 阶段 2):纯词法预览(lexicalOnly)没有语义名次,回读后的最终名次就是候选顺序(精确命中在前、
      // 其余按词法分)。会话按候选顺序回读,已核实的会话(或条目)够上限再多 4 个就停:前 cap 个与全量回读相同,只有
      // 某会话首条命中在回读里被剔掉的极端情况下名次可能略有出入。预览本来就标 partial,随后的非预览请求照旧全量回读。
      // 修前预览把每个有命中的会话(宽查询下是全库)都回读一遍。
      let previewStopped=false;const verifySids=[...hitsBySid.keys()],previewVerified=()=>sessionResults?new Set(verifiedHits.map(row=>row.sid)).size:verifiedHits.length,enoughForPreview=()=>options.lexicalOnly===true&&previewVerified()>=cap+4;
      // 2F:预览的回读并发按「还差几条」收窄(在飞数 ≤ cap+4-已核实),回读条数的上界与修前逐批时同级;非预览照常满宽度。
      const verifyWidth=()=>options.lexicalOnly===true?cap+4-previewVerified():POOL_WIDTH;
      check();{const verified=await orderedPool(verifySids,verifySource,{width:verifyWidth,stop:enoughForPreview,onSettled:part=>{if(!part)return;const {sid,proof,sequence,unverified}=part;
          const selectedManifest=manifests.get(sid);if(selectedManifest?.attachments===0){const reuse={generation:selectedManifest.generation,epoch:proof.epoch,revision:proof.revision,sequence,unverified};coverageReuse.set(sid,reuse);if(selectedManifest.epoch===proof.epoch&&selectedManifest.sourceRevision===proof.revision)rememberCoverage(sid,reuse);}
          for(const {owner,...item}of part.resolved){if(!retainedSources.has(owner)){const size=Buffer.byteLength(item.sourceText);if(retainedBytes+size>256*1024*1024){lexicalTruncated=true;continue;}retainedSources.add(owner);retainedBytes+=size;}verifiedHits.push({...item,sid,proof,sequence});}}});
        const failure=poolFailure(verified.settled,options.timeout);if(failure)throw failure;previewStopped=verified.stopped;}
      // Recompute reciprocal ranks only after source proof and admission. Apply
      // the user cap before privacy projection, including one result per session.
      const lexicalRanks=new Map(),semanticRanks=new Map();
      verifiedHits.filter(row=>row.hit.lexicalRank!==undefined).sort((a,b)=>a.hit.lexicalRank-b.hit.lexicalRank).forEach((row,n)=>lexicalRanks.set(row,n));
      verifiedHits.filter(row=>row.hit.semanticRank!==undefined).sort((a,b)=>a.hit.semanticRank-b.hit.semanticRank).forEach((row,n)=>semanticRanks.set(row,n));
      for(const row of verifiedHits)row.hit.rankScore=(row.hit.exact?1:0)+(lexicalRanks.has(row)?1/(61+lexicalRanks.get(row)):0)+(semanticRanks.has(row)?1/(61+semanticRanks.get(row)):0);
      verifiedHits.sort((a,b)=>b.hit.rankScore-a.hit.rankScore||compare(a.hit,b.hit));
      const stillAuthorized=async sid=>typeof host.authorizedEpoch==='function'&&host.assertAuthorized(sid,context,access)===true||await host.authorize(sid,context,access)===true;
      const projectedSessions=new Set();let projectedCount=0;
      for(const {hit,sourceText,text,snippetEnd,snippetTruncated,revalidate,sid,proof,sequence}of verifiedHits){check();if(projectedCount>=cap)break;if(sessionResults&&projectedSessions.has(sid))continue;
        // 150 S6:投影前后两次原来各重读一遍会话头(host.authorize);本 scope 已授权且 sequence 未变时改为同步比对。
        // 权威复核不删,合并到出口:消费方在披露前对本 scope 的全部来源逐个重读 epoch(13as final),外部改盘在那里拦下。
        if(!await stillAuthorized(sid)||(typeof host.authorizedEpoch==='function'?host.authorizedEpoch(sid,context,access):await host.epoch(sid))!==proof.epoch||host.sourceSequence(sid)!==sequence)continue;
        if(revalidate&&!await revalidate())continue;
        projectedCount++;const projected=await host.project({sourceText,text,reference:Object.freeze({...hit.row,...(hit.semanticScore===undefined?{matchStart:hit.start,matchEnd:hit.end,...(hit.entity?{matchKind:'lexical-entity'}:hit.verifiedWindow?{matchKind:'verified-window'}:{})}:{matchKind:'semantic',matchStart:hit.start,matchEnd:hit.end}),snippetStart:Math.max(0,hit.start-60),snippetEnd,...(snippetTruncated?{snippetTruncated:true}:{})}),start:hit.start,end:hit.end,context,access,revalidate});if(keys(projected)!=='reference,snippet'||typeof projected.snippet!=='string'||Buffer.byteLength(JSON.stringify(projected))>16384)throw fail('projection_invalid');const disclosed=clone(projected);
        if(!await stillAuthorized(sid)||(typeof host.authorizedEpoch==='function'?host.authorizedEpoch(sid,context,access):await host.epoch(sid))!==proof.epoch||host.sourceSequence(sid)!==sequence)continue;
        if(revalidate){if(!await revalidate())continue;sourceChecks.push(revalidate);}
        results.push({...disclosed,score:hit.score,rankScore:hit.rankScore??hit.score,...(hit.semanticScore===undefined?{}:{semanticScore:hit.semanticScore})});sequences.set(sid,sequence);projectedSessions.add(sid);
      }
      const covered=new Set(),coverageSequences=new Map(),observedManifests=new Map(),coverageState=await rawCoverage({context,access,seen:covered,sequences:coverageSequences},{...options,reuse:coverageReuse,observed:observedManifests,manifests:scannedManifests,mutation:searchMutation});check();
      for(const check of sourceChecks)if(!await check(true))throw fail('source_changed');
      if(host.assertScope(context,access)!==true||[...sequences].some(([sid,seq])=>host.sourceSequence(sid)!==seq||host.assertAuthorized(sid,context,access)!==true)||[...covered].some(sid=>host.assertAuthorized(sid,context,access)!==true||host.sourceSequence(sid)!==coverageSequences.get(sid)))throw fail('disclosure_changed');
      const sorted=results.sort((a,b)=>(b.rankScore??b.score)-(a.rankScore??a.score));const unique=sessionResults?sorted.filter((hit,n)=>sorted.findIndex(other=>other.reference.sessionId===hit.reference.sessionId)===n):sorted;
      const result={query,results:unique.slice(0,cap),coverage:coverageState,ranking:'rrf-v1',...(previewStopped?{previewIncomplete:true}:{}),lexicalAdmission:{partial:lexicalPartial||lexicalTruncated,truncated:lexicalTruncated},...(requiredIds.length?{entity:{required:requiredIds.length,partial:entityTruncated}}:{}),semantic:{status:semanticState.status,coverage:!coverageState.complete||fragmentCount>semanticRows.length-metadataRows.length||metadataTruncated||!semanticState.coverage?.complete?'partial':'complete',candidateFragments:semanticRows.length,cachedFragments:semanticState.coverage?.cached||0,truncated:fragmentCount>semanticRows.length-metadataRows.length||metadataTruncated||entityTruncated,minScore:semanticState.minScore??0.85,...(semanticState.admission?{admission:{policyId:semanticState.admission.policyId,status:semanticState.admission.status,purpose:semanticState.admission.purpose,answerability:semanticState.admission.answerability}}:{}),...(semanticState.modelFingerprint?{modelFingerprint:semanticState.modelFingerprint}:{})},scope:{mode:'message-shards',sampling:false,coordinate:'utf16',maxQueryChars:OVERLAP}};
      const selectedEpochs=new Map([...sequences.keys()].map(sid=>[sid,manifests.get(sid)?.epoch]));
      searchProofs.set(result,{context,access,mutation:searchMutation,observedManifests,coverageSequences,selectedEpochs,metadataTotals,metadataEvidence,metadataTruncated,gemmaDecision,gemmaMetadata});return result;
    }
    async function revalidate(result,context,options={}){
      const proof=searchProofs.get(result);if(!proof||proof.context!==context)throw fail('disclosure_changed');
      const check=typeof options.check==='function'?options.check:()=>{},rows=[...proof.observedManifests];let changed=0;
      check();{const revalidated=await orderedPool(rows,async([sid,generation])=>{
        check();if(host.assertAuthorized(sid,context,proof.access)!==true||host.sourceSequence(sid)!==proof.coverageSequences.get(sid))throw fail('disclosure_changed');
        if(proof.selectedEpochs.has(sid)&&await host.epoch(sid)!==proof.selectedEpochs.get(sid))throw fail('source_changed');
        if(indexUnchanged(proof.mutation))return false;const current=await currentManifest(sid);check();return (current?.generation||null)!==generation;
      },{onSettled:value=>{if(value===true)changed++;}});const failure=poolFailure(revalidated.settled,options.timeout);if(failure)throw failure;}
      check();if(host.assertScope(context,proof.access)!==true)throw fail('disclosure_changed');return {changed};
    }
    async function restorePause(context){const phase=savedPhase(await read(null,'state.json',1024));persistedPhase=phase;paused=phase==='paused';return coverage(context);}
    return Object.freeze({step,prepare,resetPreparation,preparationComplete,search,revalidate,mutationState,coverage,restorePause,usesWindowPolicy:(result,context)=>{const proof=searchProofs.get(result);return !!proof&&proof.context===context&&!!proof.gemmaDecision;},metadataAdmission:(result,sid,field,context)=>{const proof=searchProofs.get(result);if(!proof||proof.context!==context)return null;const key=JSON.stringify([sid,field]);if(proof.gemmaDecision)return proof.gemmaMetadata.get(key)??null;const value=proof.metadataEvidence.get(key),total=proof.metadataTotals.get(key)||0;return value?.accepted?true:total>0&&value?.scored===total?false:null;},invalidate:(sid,deleted=false)=>{const finish=beginMutation();clearCanonicalCaches();return run(async()=>{semantic?.clear();clearCanonicalCaches();preparationProgress.clear();coverageProofs.delete(sid);await purge(sid);}).finally(finish);},pause:()=>{paused=true;clearCanonicalCaches();return run(()=>state('paused'));},resume:()=>{paused=false;return run(()=>state('idle'));},isPaused,
      setMaintenancePaused:value=>{const next=value===true;/* 2C 复审建议 4:工作数据维护期间迁移编解码(01x/01ad)会重写 _fulltext-index-v1 而不经 beginMutation;进出维护各推一次 mutationSerial,沿用 manifest 的捷径与 13as 的 index_changed 判据都因此失效重读。 */if(next!==maintenancePaused){mutationSerial++;/* 3F:维护可能重写或删掉 state.json,确知的盘上 phase 一并作废,下一次写前重读。 */persistedPhase=undefined;}maintenancePaused=next;clearCanonicalCaches();},busy:()=>building,pending:()=>maintenanceChain});
  }
  return Object.freeze({SCHEMA,CHARS,OVERLAP,SHARD_BYTES,sources,create,canonicalCacheSize:()=>SLICE_CACHE.entries.size});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'));

// Committed upload references select the original attachment face. A stored
// path or a preview supplied with the message does not authorize a file read.
function createSessionFullTextAttachmentSource() {
  const textName=/\.(txt|md|markdown|json|js|ts|tsx|jsx|py|ps1|bat|cmd|csv|tsv|xml|svg|html|css|yaml|yml|ini|log)$/i;
  const documentName=/\.(pdf|docx|docm|dotx|pptx|pptm|xlsx|xlsm|odt|ods|odp)$/i;
  const isDocument=reference=>typeof reference?.name==='string'&&documentName.test(reference.name);
  const pathKey=value=>process.platform==='win32'?value.toLowerCase():value;
  const revision=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const stamp=stat=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(key=>String(stat[key]));
  const runtime=root=>WorkDataAttachmentRuntime.create({root,keys:workDataKeys,enabled:()=>true});
  const sealedRevision=({sha256,totalBytes,revision:version},root)=>revision(['sealed-v1',root,sha256,totalBytes,version]);
  const missing=error=>['work_data_attachment_catalog.id_missing','work_data_attachment_catalog.not_sealed','ENOENT'].includes(error?.code);
  async function select(reference,policy) {
    if(!reference||typeof paths.uploads!=='string'||typeof policy!=='boolean')return null;
    const {id,name,size}=reference;
    if(typeof id!=='string'||!/^file_[a-f0-9]{16}$/.test(id)||typeof name!=='string'||!name.length||name.length>200
      ||name!==path.win32.basename(name)||sanitizeFsSegmentName(name)!==name||/[. ]$/.test(name)
      ||/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)||!Number.isSafeInteger(size)||size<0)return null;
    const document=isDocument(reference);
    if(!document&&!textName.test(name))return null;
    const cap=document?8*1024*1024:256*1024;
    if(size>cap||document&&!(await MediaImageHooks.availability?.())?.available)return null;
    const root=path.resolve(paths.uploads);
    if(policy){
      try{
        const info=await runtime(root).stat(id);
        if(info.totalBytes!==size||info.metadata?.kind!=='original'||info.metadata?.logicalName!==name)return null;
        return {root,revision:sealedRevision(info,root),document};
      }catch(error){
        if(missing(error))return null;
        throw error;
      }
    }
    const directory=path.join(root,id),file=path.join(directory,name);
    try {
      for(const folder of [root,directory]){
        const stat=await fsp.lstat(folder);
        if(!stat.isDirectory()||stat.isSymbolicLink()||pathKey(await fsp.realpath(folder))!==pathKey(folder))return null;
      }
      const stat=await fsp.lstat(file,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size!==BigInt(size)
        ||pathKey(await fsp.realpath(file))!==pathKey(file))return null;
      return {root,file,stat,revision:revision(['plain-v1',file,...stamp(stat)]),document};
    }catch(error){
      if(['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error?.code))return null;
      throw error;
    }
  }
  async function extract(name,bytes,document) {
    if(document){
      const result=await FileVisualIo.protectedDocument(name,{as:'text'},null,undefined,bytes);
      if(result.ok===true)return {text:result.content};
      return ['reader_unavailable','document_read_timeout','document_read_failed'].includes(result.code)?{deferred:true}:null;
    }
    const text=decodeTextFileBytes(bytes);
    return /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F\uFFFD]/u.test(text)?null:{text};
  }
  async function read(reference,policy,expected) {
    const selected=await select(reference,policy);
    if(!selected||selected.revision!==expected.revision)return null;
    let result;
    if(policy){
      let lease;
      try { lease=await runtime(selected.root).read(reference.id,0,reference.size); }
      catch(error){
        if(missing(error))return null;
        throw error;
      }
      try {
        if(lease.complete!==true||sealedRevision(lease,selected.root)!==selected.revision
          ||lease.metadata?.kind!=='original'||lease.metadata?.logicalName!==reference.name)return null;
        lease.assert();
        result=await extract(reference.name,lease.bytes,selected.document);
        lease.assert();
      } finally { lease.release(); }
    } else if(reference.size===0) {
      result={text:''};
    } else if(typeof MediaImageHooks.readLocalMediaFile==='function') {
      try {
        result=await MediaImageHooks.readLocalMediaFile(selected.file,undefined,
          bytes=>extract(reference.name,bytes,selected.document),{expectedStat:selected.stat});
      }catch(error){
        if(['ENOENT','privacy.image_source_alias','privacy.image_source_invalid','privacy.image_source_changed','privacy.image_source_limit'].includes(error?.code))return null;
        throw error;
      }
    }
    return (await select(reference,policy))?.revision===selected.revision?result:null;
  }
  async function verify(reference,expected){
    try{
      const proof=await runtime(expected.root).verify(reference.id);
      return proof.verified===true&&sealedRevision(proof,expected.root)===expected.revision
        && (await select(reference,true))?.revision===expected.revision;
    }catch(error){
      if(missing(error)||['work_data_blob.physical','work_data_blob.whole_changed','work_data_blob.namespace','work_data_blob.revoked'].includes(error?.code))return false;
      throw error;
    }
  }
  return Object.freeze({select,read,verify,isDocument});
}

// Explicit production composition. No timer, route switch, directory creation,
// key creation or background indexing occurs merely by loading this module.
// A reviewed caller must supply destination-scope disclosure, including the
// reference itself. Model and UI consumers must bind their real existing scope.
let sessionFullTextOwner = null;
function bindSessionFullTextIndex(disclosure,sessionResults=false) {
  const names=['scope','authorize','assertAuthorized','project','assertScope'];
  if(sessionFullTextOwner)throw Object.assign(Error('session_fulltext.already_bound'),{code:'session_fulltext.already_bound'});
  if(!disclosure||Object.keys(disclosure).some(name=>!names.includes(name)&&!['authorizedEpoch','authorizedEmpty','restrictedCatalog'].includes(name))||names.some(name=>typeof disclosure[name]!=='function')||['authorizedEpoch','authorizedEmpty','restrictedCatalog'].some(name=>disclosure[name]!==undefined&&typeof disclosure[name]!=='function'))
    throw Object.assign(Error('session_fulltext.scope_binding_required'),{code:'session_fulltext.scope_binding_required'});
  const projection=Object.fromEntries([...names,...['authorizedEpoch','authorizedEmpty'].filter(name=>disclosure[name])].map(name=>[name,disclosure[name]])),source=createSessionFullTextSource();
  const instance=SessionFullTextIndex.create({...projection,resultUnit:sessionResults===true?'sessions':'references',root:()=>paths.sessions,keys:workDataKeys,writeJson:atomicWriteJson,
    validSessionId:safeSessionId,noise:sessionSearchRowIsNoise,terms:retrievalTerms,
    ...(typeof SemanticRetrieval!=='undefined'&&typeof SemanticRuntimeHooks!=='undefined'?{semantic:SemanticRetrieval.create(SemanticRuntimeHooks)}:{}),
    ...(typeof paths.uploads==='string'?{attachmentSource:createSessionFullTextAttachmentSource()}:{}),
    enabled:async()=>{const config=await readConfig();return WorkDataRootHooks.mode?WorkDataRootHooks.mode(config.workDataEncryptionV1):config.workDataEncryptionV1===true;},
    epoch:source.epoch,scan:source.scan,sourceSequence:source.sequence,
    catalog:async()=>{
      const restricted=disclosure.restrictedCatalog?.();if(restricted!==null&&restricted!==undefined)return restricted;
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
  return Object.freeze({search:instance.search,revalidate:instance.revalidate,usesWindowPolicy:instance.usesWindowPolicy,metadataAdmission:instance.metadataAdmission,mutationState:instance.mutationState,coverage:instance.coverage,resetPreparation:instance.resetPreparation,preparationComplete:instance.preparationComplete,prepare:(context,options)=>admitted(()=>instance.prepare(context,options)),
    restorePause:context=>admitted(()=>instance.restorePause(context)),step:(limit,context)=>admitted(()=>instance.step(limit,context)),
    pause:()=>admitted(()=>instance.pause()),resume:()=>admitted(()=>instance.resume()),
    invalidate:(id,deleted)=>admitted(()=>instance.invalidate(id,deleted))});
}
if(typeof SessionFullTextHooks!=='undefined')Object.assign(SessionFullTextHooks,{
  bind:bindSessionFullTextIndex,
  bindSessions:disclosure=>bindSessionFullTextIndex(disclosure,true),
  maintenanceState:()=>({pending:sessionFullTextOwner?[sessionFullTextOwner.pending()]:[],active:Number(!!sessionFullTextOwner?.busy())}),
  maintenancePause:()=>{if(!sessionFullTextOwner)return null;sessionFullTextOwner.setMaintenancePaused(true);return true;},
  maintenanceResume:saved=>{if(saved&&sessionFullTextOwner)sessionFullTextOwner.setMaintenancePaused(false);},
});

if(typeof SemanticPolicyConsumers!=='undefined')SemanticPolicyConsumers.add('session');
