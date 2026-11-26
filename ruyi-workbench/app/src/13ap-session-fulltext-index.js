// Complete message-source shards; source authority and disclosure remain with
// the existing session/storage/privacy owners. No embeddings or corpus sampling.
const SessionFullTextIndex = ((io,p,c) => {
  // 150 号文 S1 的失败分类(00-boot);单文件 vm 夹具没装它时保守:不包、不降级(同修前)。
  const semanticFailures=typeof SemanticFailurePolicy!=='undefined'?SemanticFailurePolicy:{guard:fn=>fn,degradable:()=>false};
  const FORMAT=3,SCHEMA=1,CHARS=4096,OVERLAP=256,SHARD_BYTES=256*1024,MANIFEST_BYTES=4*1024*1024;
  const PREPARE_SLICE_MS=1500;
  // 151 阶段 4A(150 S6/S7/S14/U5):后台增量建索引、持久向量、短查询语义噪声。
  const VECTOR_FILE='vectors.json',VECTOR_SCHEMA=1,VECTOR_BYTES=8*1024*1024,VECTOR_ENTRIES=3584,VECTOR_MEMORY_BYTES=96*1024*1024,SEMANTIC_ROWS=4096,SEMANTIC_ROWS_PERSISTED=32768;
  const SHORT_QUERY_GRAPHEMES=4,SHORT_QUERY_SEMANTIC_MIN=0.7;
  const BACKGROUND_SLICE_MS=200,BACKGROUND_GAP_MS=40,BACKGROUND_BUSY_RETRY_MS=300,BACKGROUND_SESSION_BUDGET_MS=30000,BACKGROUND_MAX_BUDGET_MS=240000,BACKGROUND_SKIP_RETRY_MS=60000,BACKGROUND_ENCODE_BATCH=8,BACKGROUND_SCOPE='session-index-background',BACKGROUND_QUIET_MS=1500,BACKGROUND_MAX_YIELDS=2,BACKGROUND_BUSY_SLICE_EVERY_MS=3000,BACKGROUND_ENCODE_BATCH_MS=150,BACKGROUND_ENCODE_GAP_MS=50,BACKGROUND_BUSY_YIELD_MS=25;
  const LITTLE_ENDIAN=require('node:os').endianness()==='LE';
  // 4A 复审 F1:后台计时器在模块加载时(不在任何请求里)取的异步上下文里排,不继承排它那一刻的请求 AsyncLocalStorage
  // (观察回忆请求开着时 restrictedCatalog 只给 [exactSid],带进后台会把别的会话当「已删」清掉)。
  const BACKGROUND_ROOT=new (require('node:async_hooks').AsyncResource)('session-fulltext-background');
  const EXCLUSIVE_YIELDED=Object.freeze({exclusiveYielded:true});
  const pauseBriefly=ms=>new Promise(resolve=>typeof setTimeout==='function'?setTimeout(resolve,ms):typeof setImmediate==='function'?setImmediate(resolve):resolve());
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
  // 语义窗口:shard 行里每 96 码元一窗、相邻重叠 16(不切开代理对)。检索与后台编码共用这一个生成器,窗口坐标逐个相同。
  function* semanticWindows(text){for(let at=0;at<text.length;){let next=Math.min(text.length,at+96);if(next<text.length&&text.charCodeAt(next)>=0xdc00&&text.charCodeAt(next)<=0xdfff)next--;yield {at,next};
    if(next===text.length)break;let following=next-16;if(text.charCodeAt(following)>=0xdc00&&text.charCodeAt(following)<=0xdfff)following--;at=following;}}
  // 持久向量的键:会话 + 消息序号 + 来源字段 + 消息内容修订(整行摘要)+ 窗口坐标与窗口摘要。消息没变就复用(重建索引换
  // generation/epoch 不作废),消息一变 contentRevision 就变;模型指纹另记在文件里,换模型整份不用。
  const windowVectorKey=(sid,ordinal,source,revision,canonicalStart,at,start,end,windowHash)=>hash(JSON.stringify(['fulltext-window-v1',sid,ordinal,source,revision,canonicalStart,at,start,end,windowHash]));
  function packVector(vector){const value=Float32Array.from(vector);return Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64');}
  function unpackVector(text,dims){if(typeof text!=='string')return null;const bytes=Buffer.from(text,'base64');if(bytes.length!==dims*4)return null;const out=new Float32Array(dims);
    if(LITTLE_ENDIAN)new Uint8Array(out.buffer).set(bytes);else for(let n=0;n<dims;n++)out[n]=bytes.readFloatLE(n*4);let nonzero=false;for(let n=0;n<dims;n++){if(!Number.isFinite(out[n]))return null;if(out[n]!==0)nonzero=true;}return nonzero?out:null;}
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
    // 151 阶段 4A:后台建索引的「提交」(写 manifest 并换掉旧 shard、清已删会话、写向量文件)与搜索互斥。搜索从读 manifest
    // 到披露前出口复核期间持读租约(beginRead);后台提交先等所有读租约放掉,读租约遇到进行中的后台提交就等它做完再拿。
    // 请求自己驱动的建索引(prepare/step,调用方在读租约之外调用)不经这里;读租约内没有一处会等 run 链,所以不会互等。
    // 关键词首屏(预览)请求持「优先」读租约:它在读的时候后台在会话之间停下来(正在建的那一条照常建完),首屏不与后台抢。
    // 4A 复审 F5:等在后台提交后面的读者(readersWaiting)也算在读 —— 提交一个接一个时不让首屏一直排在后面;优先租约放掉的时刻
    // 记下来,之后 1.5 s 内后台不起新片(首屏一发接一发时不插进来)。
    let readers=0,priorityReaders=0,readersWaiting=0,lastPriorityRelease=0,backgroundCommit=null,readerWaiters=[],priorityWaiters=[];
    async function beginRead(options={}){const priority=options.priority===true;if(backgroundCommit){readersWaiting++;try{while(backgroundCommit)await backgroundCommit;}finally{readersWaiting--;}}readers++;if(priority)priorityReaders++;let released=false;
      return ()=>{if(released)return;released=true;readers--;if(priority&&--priorityReaders===0){lastPriorityRelease=Date.now();const waiting=priorityWaiters;priorityWaiters=[];for(const resolve of waiting)resolve();}if(readers)return;const list=readerWaiters;readerWaiters=[];for(const resolve of list)resolve();wakeBackground();};}
    // yieldIf:等读者期间若它变真(有删除排着队、回合开始了),不再等、交回 EXCLUSIVE_YIELDED,调用方放弃这批提交。
    async function exclusive(work,yieldIf=null){for(;;){if(yieldIf&&yieldIf())return EXCLUSIVE_YIELDED;if(backgroundCommit){await backgroundCommit;continue;}
        if(readersWaiting>0){await pauseBriefly(1);continue;}if(readers>0){await new Promise(resolve=>{readerWaiters.push(resolve);if(yieldIf)pauseBriefly(25).then(resolve);});continue;}break;}
      let release;backgroundCommit=new Promise(resolve=>{release=resolve;});try{return await work();}finally{backgroundCommit=null;release();}}
    // 150 S14:向量按会话落盘(<sid>/vectors.json,与 shard 同一个 WorkDataStore 载体,加密档同样密封),进程内按会话缓存解码结果
    // (LRU,按字节记账)。删会话只清这一条(purge 删整个会话目录);撤销、暂停、维护、运行时缓存失效整表清空,下次按需回读。
    const vectorStoreEnabled=host.vectors===true,vectorMemory=new Map();let vectorMemoryBytes=0,vectorGeneration=0;
    const vectorClear=()=>{vectorGeneration++;vectorMemory.clear();vectorMemoryBytes=0;};
    const vectorEvict=sid=>{const entry=vectorMemory.get(sid);if(!entry)return;vectorMemory.delete(sid);vectorMemoryBytes-=entry.bytes;};
    const vectorPut=(sid,model,entries)=>{vectorEvict(sid);let bytes=256;for(const vector of entries.values())bytes+=vector.byteLength+96;vectorMemory.set(sid,{model,entries,bytes});vectorMemoryBytes+=bytes;
      while(vectorMemoryBytes>VECTOR_MEMORY_BYTES&&vectorMemory.size>1)vectorEvict(vectorMemory.keys().next().value);};
    const vectorGet=(sid,model,key)=>{const entry=vectorMemory.get(sid);if(!entry||entry.model!==model)return null;return entry.entries.get(key)||null;};
    function decodeVectors(value,sid,model){
      if(!value||keys(value)!=='dims,entries,model,schema,sessionId'||value.schema!==VECTOR_SCHEMA||value.sessionId!==sid||typeof value.model!=='string'||!value.model.length||value.model.length>512||!Number.isSafeInteger(value.dims)||value.dims<1||value.dims>8192||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))return null;
      const out=new Map();if(value.model!==model)return out;const rows=Object.entries(value.entries);if(rows.length>VECTOR_ENTRIES)return null;
      for(const [key,text]of rows){if(!HEX.test(key))return null;const vector=unpackVector(text,value.dims);if(!vector)return null;out.set(key,vector);}return out;
    }
    // 回读失败(坏件、缺钥匙、被删)一律当「没有向量」:语义只少几个候选,词法与披露不受影响;撤权/暂停照常上抛。
    async function vectorLoad(sids,model,check=checkPaused){
      const generation=vectorGeneration,missing=sids.filter(sid=>{const entry=vectorMemory.get(sid);if(entry&&entry.model===model){vectorMemory.delete(sid);vectorMemory.set(sid,entry);return false;}return true;});
      // 读到一条放一条(调用方按语义期限截断时,已读到的不白读)。
      const pooled=await orderedPool(missing,async sid=>{check();let entries=null;try{entries=decodeVectors(await read(sid,VECTOR_FILE,VECTOR_BYTES),sid,model);}catch(error){if(error?.code==='session_fulltext.paused')throw error;return null;}check();return {sid,entries:entries||new Map()};},{onSettled:value=>{if(value&&generation===vectorGeneration)vectorPut(value.sid,model,value.entries);}});
      {const failure=poolFailure(pooled.settled);if(failure)throw failure;}
    }
    let invalidatesQueued=0;
    async function vectorFileExists(sid){try{return (await io.lstat(pathFor(sid,VECTOR_FILE))).isFile();}catch(error){if(['ENOENT','ENOTDIR'].includes(error?.code))return false;throw error;}}
    function windowKeysOf(sid,row){const windowHash=digest({text:row.text,ranges:row.ranges}),out=[];for(const {at,next}of semanticWindows(row.text)){const start=rangeAt(row.ranges,at).from,end=rangeAt(row.ranges,next-1).to;out.push(windowVectorKey(sid,row.messageOrdinal,row.source,row.contentRevision,row.canonicalStart,at,start,end,windowHash));}return out;}
    // 4A 复审 F2:按新一代窗口键裁剪向量文件;读不出(坏件、缺钥匙)就整份删掉,裁空也删。
    async function pruneVectors(sid,keep,policy){vectorEvict(sid);let value;try{value=await read(sid,VECTOR_FILE,VECTOR_BYTES);}catch(error){if(error?.code==='session_fulltext.paused')throw error;value=undefined;}
      if(value===null)return;const shaped=!!value&&keys(value)==='dims,entries,model,schema,sessionId'&&value.sessionId===sid&&!!value.entries&&typeof value.entries==='object'&&!Array.isArray(value.entries);
      const kept=shaped?Object.fromEntries(Object.entries(value.entries).filter(([key])=>keep.has(key))):{};
      if(!shaped||!Object.keys(kept).length){await removeOwned(sid,[VECTOR_FILE]);return;}if(Object.keys(kept).length===Object.keys(value.entries).length)return;
      await write(sid,VECTOR_FILE,{...value,entries:kept},VECTOR_BYTES,policy);}
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
      if(names.length>100000||names.some(name=>name!=='manifest.json'&&name!==VECTOR_FILE&&!/^[a-f0-9]{32}\.(?:0|[1-9][0-9]*)\.json$/.test(name)))throw fail('owned_namespace_changed');
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
    async function build(sid,check=checkPaused,options={}){
      check();const before=await host.epoch(sid);if(!HEX.test(before||''))return false;
      const prior=await currentManifest(sid);
      if(prior?.epoch===before&&compatible(prior)&&(!attachmentSource||prior.attachments===0))return false;
      // Validate every old owned name before building. Keep the bad pointer and
      // all old bytes until a completely verified new generation is published.
      const stale=prior===malformedManifest?await ownedNames(sid,check):null;
      const identities=new Set(),previewAttachments=attachmentWitness(),previewBudget=attachmentBudget(),policy=await host.enabled();
      // 4A 复审 F2:这条会话已有向量文件时,记下新一代全部窗口的向量键;提交时同一 exclusive 里把向量文件裁到只剩这些键
      // (改掉/删掉的消息的向量不留盘),裁空就删文件。
      const vectorKeys=vectorStoreEnabled&&await vectorFileExists(sid)?new Set():null;
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
      let rows=[],bytes=0,messages=0,attachments=0,attachmentsIndexed=0,attachmentsDeferred=false,chunks=0,turn=0,turnBasis='legacy-inferred',committed=false,deferred=false,sliceYieldAt=Date.now()+16;
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
              if(Date.now()>=sliceYieldAt){
                // 4A 三审 (b):后台建索引时宿主在忙(回合/代理在跑),每 8 ms 计算让出 25 ms,主线程只占约四分之一。
                const paced=options.background&&!backgroundState.urgent&&hostBusy();if(paced)await pauseBriefly(BACKGROUND_BUSY_YIELD_MS);else await new Promise(resolve=>typeof setImmediate==='function'?setImmediate(resolve):resolve());sliceYieldAt=Date.now()+(paced?8:16);}
              check();const entry={sessionId:sid,turnSeq:turn,turnSeqBasis:turnBasis,messageId,messageIdBasis:intrinsic?'intrinsic':'physical-ordinal',contentRevision:revision,chunkOrdinal:chunkOrdinal++,messageOrdinal:ordinal,source:source.field,coordinate:'utf16',start:chunk.start,end:chunk.end,canonicalStart:chunk.canonicalStart,text:chunk.text,ranges:chunk.ranges};
              if(vectorKeys&&!/^attachments\./.test(entry.source))for(const key of windowKeysOf(sid,entry))vectorKeys.add(key);
              const size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>SHARD_BYTES-4096||rows.length>=64)await flush();rows.push(entry);bytes+=size;chunks++;
            }
          }
        },{check});
        await flush();check();if(!proof||proof.epoch!==before||!HEX.test(proof.revision||'')||proof.count!==messages||proof.revision!==preview.revision||proof.requiresEncryption!==preview.requiresEncryption
          ||observedAttachments.finish()!==attachmentRevision||await host.epoch(sid)!==before)throw fail('source_changed');
        const value={schema:SCHEMA,format:FORMAT,normalizer:NORMALIZER,sessionId:sid,epoch:before,sourceRevision:proof.revision,generation,messages,attachments,chunks,shards,
          ...(attachmentSource&&attachments?{attachmentRevision,attachmentsIndexed,...(attachmentsDeferred?{attachmentsRetryAt:Date.now()+30000}:{})}:{})};
        // 151 阶段 4A:后台建索引的提交与搜索的读租约互斥;等租约期间正文可能变了,拿到提交权后再核一次 epoch。
        // 后台的提交可以攒批(deferCommit):建好的 shard 先留着,等一个没有读租约的空档,在一次 exclusive 里把攒下的提交一并做完
        // —— 前端连续轮询时空档很短,逐条等空档会让后台一轮只提交一两条。提交时只再核暂停/撤权与 epoch(会话预算不再计时)。
        const commitCheck=options.deferCommit?checkPaused:check;
        const commit=async()=>{if(options.background){commitCheck();await backgroundRevoked();if(await host.epoch(sid)!==before)throw fail('source_changed');}
          const finish=beginMutation();try{await write(sid,'manifest.json',value,MANIFEST_BYTES,policy,commitCheck);committed=true;}finally{finish();}
          if(prior===malformedManifest)await removeOwned(sid,stale.filter(name=>name!=='manifest.json'&&name!==VECTOR_FILE));
          else if(prior)await removeOwned(sid,prior.shards.map(row=>prior.generation+'.'+row.ordinal+'.json'));
          if(vectorKeys)await pruneVectors(sid,vectorKeys,policy);};
        if(typeof options.deferCommit==='function'){deferred=true;options.deferCommit({commit,abort:async()=>{if(!committed)await removeOwned(sid,owned);}});return 'deferred';}
        if(options.background)await exclusive(commit);else await commit();
        return true;
      }finally{if(!committed&&!deferred)await removeOwned(sid,owned);}
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
      let complete=0,pending=0,attachmentSources=0,unverifiedMessages=0;const pendingIds=options.pendingIds instanceof Set?options.pendingIds:null,markPending=sid=>{pending++;pendingIds?.add(sid);};const visit=async sid=>{check();if(visibility){const already=typeof host.authorizedEpoch==='function'&&host.assertAuthorized(sid,visibility.context,visibility.access)===true;if(!already&&await host.authorize(sid,visibility.context,visibility.access)!==true)return;visibility.seen.add(sid);}check();const sequence=host.sourceSequence(sid),value=options.manifests?.has(sid)&&indexUnchanged(options.mutation)?options.manifests.get(sid):await currentManifest(sid);check();options.observed?.set(sid,value?.generation||null);const reused=options.reuse?.get(sid)||coverageProofs.get(sid),authorized=visibility&&typeof host.authorizedEpoch==='function'?host.authorizedEpoch(sid,visibility.context,visibility.access):null;
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
        if(proof.epoch!==value.epoch)markPending(sid);
        else if(proof.revision!==value.sourceRevision)throw fail('source_changed');
        else if(value.attachmentRevision&&(value.attachmentRevision!==witness.finish()||attachmentRetryDue(value)))markPending(sid);
        else{complete++;attachmentSources+=value.attachments-(value.attachmentsIndexed||0);unverifiedMessages+=unsupported;if(value.attachments===0)rememberCoverage(sid,{generation:value.generation,epoch:proof.epoch,revision:proof.revision,sequence,unverified:unsupported});}
      }else markPending(sid);if(visibility){if(sequence!==host.sourceSequence(sid))throw fail('source_changed');visibility.sequences.set(sid,sequence);}};
      check();{const visited=await orderedPool(catalog,visit);const failure=poolFailure(visited.settled,options.timeout);if(failure)throw failure;}
      return {phase:isPaused()?'paused':building?'building':'idle',sessions:visibility?visibility.seen.size:catalog.length,indexedSessions:complete,pendingSessions:pending,complete:pending===0&&attachmentSources===0&&unverifiedMessages===0,messages:{unverifiedText:unverifiedMessages},attachments:{unverifiedFullText:attachmentSources},coverageUnit:'committed-display-message-sources',fullTextSampling:false,...(backgroundState.started?{background:backgroundStatus()}:{})};
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
    function preparationComplete(scopeId){return preparationProgress.get(scopeId)?.done===true||backgroundComplete();}
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
      // 150 S14:有持久向量(非 Gemma 研究路径)时语义候选不再按会话 id 截在 4096 行;Gemma 的整池证明仍是 4096 行。
      // 150 U5:短查询(去空白后 ≤4 个字素)语义只给词法命中重排,纯语义命中要过 0.7。
      const gemmaMethod=typeof SemanticRuntimeTransportProof!=='undefined'&&SemanticRuntimeTransportProof.isMethod(options.method),vectorsOn=vectorStoreEnabled&&!!semantic&&!gemmaMethod,semanticRowCap=vectorsOn?SEMANTIC_ROWS_PERSISTED:SEMANTIC_ROWS;
      const deferEncoding=vectorsOn&&options.deferDocumentEncoding===true,shortQuery=[...segmenter.segment(phrase.replace(/\s+/g,''))].length<=SHORT_QUERY_GRAPHEMES;
      let fragmentCount=0,entityTruncated=false,lexicalTruncated=false,lexicalPartial=false,shortQueryFiltered=0;
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
            if(semantic){const semanticKey=sourceKeyOf(row);for(const {at,next}of semanticWindows(row.text)){totals.set(semanticKey,(totals.get(semanticKey)||0)+1);
              if(semanticRows.length<semanticRowCap){const width=next-at,start=rangeAt(row.ranges,at).from,end=rangeAt(row.ranges,next-1).to;
                semanticRows.push({text:row.text.slice(at,next),identity:[sid,value.epoch,value.sourceRevision,value.generation,row.contentRevision,row.source,row.canonicalStart,at,start,end,windowHash],hit:{row:Object.freeze({...row,text:undefined,ranges:undefined,canonicalStart:undefined}),canonicalStart:row.canonicalStart,windowHash,at,width,epoch:value.epoch,sourceRevision:value.sourceRevision,start,end}});}fragmentCount++;}}
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
          semanticRows.push(...part.semanticRows.slice(0,Math.max(0,semanticRowCap-semanticRows.length)));candidates.push(...part.candidates);candidates.sort(compare);if(candidates.length>candidateLimit){if(requiredIds.length)entityTruncated=true;lexicalTruncated=true;candidates.length=candidateLimit;}}});
        const failure=poolFailure(scanned.settled,options.timeout);if(failure)throw failure;}
      const metadataRows=[];let metadataTruncated=options.metadataEntriesTruncated===true;
      if(semantic&&Array.isArray(options.metadataEntries)){for(const item of options.metadataEntries){check();if(!item||!valid(item.sid)||typeof item.field!=='string'||typeof item.text!=='string'||typeof item.epoch!=='string'||item.text.length>8192){metadataTruncated=true;continue;}const key=JSON.stringify([item.sid,item.field]);for(let at=0;at<item.text.length;){let end=Math.min(item.text.length,at+96);if(end<item.text.length&&item.text.charCodeAt(end)>=0xdc00&&item.text.charCodeAt(end)<=0xdfff)end--;metadataTotals.set(key,(metadataTotals.get(key)||0)+1);if(metadataRows.length<256)metadataRows.push({text:item.text.slice(at,end),identity:['metadata',item.sid,item.field,item.epoch,digest(item.text),at,end],metadata:item,metadataKey:key,hit:{row:{sessionId:item.sid},epoch:item.epoch}});else metadataTruncated=true;if(end===item.text.length)break;let next=end-16;if(item.text.charCodeAt(next)>=0xdc00&&item.text.charCodeAt(next)<=0xdfff)next--;at=next;}}}
      if(metadataRows.length){if(semanticRows.length+metadataRows.length>semanticRowCap)metadataTruncated=true;semanticRows.splice(0,0,...metadataRows);if(semanticRows.length>semanticRowCap)semanticRows.length=semanticRowCap;}
      let semanticState={status:options.lexicalOnly===true?'deferred':semanticOff?'disabled':semanticLater?'deferred':semantic?'empty':'unavailable',coverage:{cached:0,total:semanticRows.length,complete:false}};
      let ranked=[],gemmaDecision=typeof SemanticRuntimeTransportProof!=='undefined'&&SemanticRuntimeTransportProof.isMethod(options.method)?{complete:false,policyId:SemanticWindowPolicy.CONTRACT.id}:null;const gemmaMetadata=new Map(),gemmaWeak=new Map();
      if(semantic&&semanticRows.length){
        // Lexical shard text is uppercased. Resolve original spelling through
        // the authenticated source owner only when a vector is not cached.
        const semanticDeadline=Math.min(Date.now()+1000,Number.isFinite(options.deadline)?options.deadline:Infinity),policyContext=typeof SemanticOriginalWindows!=='undefined'?SemanticOriginalWindows.createRequest({query,scopeId:access.scopeId,modelFingerprint:SemanticWindowPolicy.CONTRACT.modelFingerprint}):null;
        // Scoring yields after its slice; validating a completed score can use the remaining request budget.
        let sourceDeadline=semanticDeadline;
        const sourceExpired=Object.freeze({semanticSourceBudget:true}),sourceCheck=()=>{check();if(options.signal?.aborted)throw options.signal.reason===undefined?Error('semantic.aborted'):options.signal.reason;if(Date.now()>=sourceDeadline)throw sourceExpired;};
        const originalFragments=new Map(),originalFields=new Map(),loadedSources=new Set(),sourceSequences=new Map(),sourceGuards=new Map();let activeSids=[],activeMetadata=new Set();
        const bodyRows=new Map(),sourceEpochs=new Map();
        semanticRows.forEach((entry,index)=>{
          const sid=entry.hit.row.sessionId;
          if(!sourceEpochs.has(sid))sourceEpochs.set(sid,entry.hit.epoch);
          if(!entry.metadata){const rows=bodyRows.get(sid)||[];rows.push({entry,index});bodyRows.set(sid,rows);}
        });
        // 150 S8:回验分两档。权威复核(重读会话头与 epoch、附件与元数据复核)只在来源解析时(host.scan 首尾读头并核 epoch)
        // 和整次 score 结束后各做一次;编码前后那几次(06ha 前后各一、06hb 写入前与回包后各一)改为同步的廉价比对:
        // scope、授权表、进程内 sequence —— 进程内任何写都推 sequence,撤权与改写在下一次比对就拦住;外部改盘由结束时
        // 的权威复核拦住,该次结果整体作废(与修前编码中途撤权同一结局:整次搜索报错,不披露)。窗口策略(Gemma2)
        // 自己的 start/finish 两次 verify 也走权威档,逐窗 resolved 那几次走廉价档。
        // 截止只由语义层自己判(06ha 每批前看期限、06hb 写入前看期限),回验不再抛「预算用完」—— 修前编码刚回来、回包后那次
        // 回验撞上截止就把刚算好的整批连同本次全部进度一起丢掉,回报 cached=0(S13)。
        const verifiedMetadata=new Set();
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
          const {settled}=await orderedPool(sids,async sid=>{check();if(await host.authorize(sid,context,access)!==true)throw fail('source_denied');
            if(await host.epoch(sid)!==sourceEpochs.get(sid)||host.sourceSequence(sid)!==sourceSequences.get(sid))throw fail('source_changed');
            for(const guard of sourceGuards.get(sid)||[])if(!await guard())throw fail('source_changed');for(const item of verifiedMetadata)if(item.sid===sid&&!await options.verifyMetadata(item))throw fail('source_changed');
          });
          if(settled.some(row=>row.status==='rejected'))throw poolFailure(settled,options.timeout);
          if(host.assertScope(context,access)!==true||sids.some(sid=>host.assertAuthorized(sid,context,access)!==true||host.sourceSequence(sid)!==sourceSequences.get(sid)))throw fail('disclosure_changed');
        };
        const resolveTexts=async indices=>{
          activeSids=[...new Set(indices.map(n=>semanticRows[n].hit.row.sessionId))];activeMetadata=new Set(indices.map(n=>semanticRows[n].metadata).filter(Boolean));
          for(const meta of activeMetadata){sourceCheck();if(typeof options.verifyMetadata!=='function'||!await options.verifyMetadata(meta))throw fail('source_changed');sourceSequences.set(meta.sid,host.sourceSequence(meta.sid));verifiedMetadata.add(meta);}
          const missing=[...new Set(indices.filter(n=>!semanticRows[n].metadata).map(n=>semanticRows[n].hit.row.sessionId))].filter(sid=>!loadedSources.has(sid));
          const {settled}=await orderedPool(missing,async sid=>{
            sourceCheck();
            if(await host.authorize(sid,context,access)!==true)throw fail('source_denied');
            const rows=bodyRows.get(sid);
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
            return {sid,fragments,fields,checks,sequence:host.sourceSequence(sid)};
          },{onSettled:({sid,fragments,fields,checks,sequence})=>{
            // 原文片段只在整条来源回读完、epoch 与 revision 都核过之后才并入;按原顺序交付,中途撞截止的来源一字不留。
            for(const [index,text]of fragments)originalFragments.set(index,text);for(const [index,text]of fields)originalFields.set(index,text);
            sourceSequences.set(sid,sequence);sourceGuards.set(sid,checks);loadedSources.add(sid);
          }});
          if(settled.some(row=>row.status==='rejected'))throw poolFailure(settled,sourceExpired);
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
        // 151 阶段 4A:持久向量按需回读(只读本次有语义行的会话);界面线程搜索(deferDocumentEncoding)请求内不编文档片段,
        // 只编查询,文档向量全靠后台;模型还没就绪就不在请求里等它(标 loading、后台预热)。
        // 4A 复审建议:请求里回读向量受语义期限约束,读不完的这一发当没有(读到的已进缓存,下一发接着用)。
        const storedVectors=async model=>{const sids=[...new Set(semanticRows.filter(row=>!row.metadata).map(row=>row.hit.row.sessionId))];try{await vectorLoad(sids,model,()=>{check();if(Date.now()>=semanticDeadline)throw sourceExpired;});}catch(error){if(error!==sourceExpired)throw error;}
          return n=>{const row=semanticRows[n];if(!row||row.metadata)return null;const h=row.hit;return vectorGet(h.row.sessionId,model,windowVectorKey(h.row.sessionId,h.row.messageOrdinal,h.row.source,h.row.contentRevision,h.canonicalStart,h.at,h.start,h.end,h.windowHash));};};
        const semanticCold=deferEncoding&&typeof host.semanticReady==='function'&&host.semanticReady()!==true;
        if(semanticCold){try{host.semanticWarm?.();}catch{}semanticState={status:'loading',scores:semanticRows.map(()=>null),coverage:{cached:0,total:semanticRows.length,complete:false}};}
        else try{
          const texts=semanticRows.map(row=>row.text);
          const scoreOptions={scopeId:access.scopeId,identities:semanticRows.map(row=>row.identity),owners:semanticRows.map(row=>row.metadata?row.metadata.sid:row.hit.row.sessionId),maxEncodeDocuments:deferEncoding?Math.min(64,metadataRows.length):128,resolveTexts:semanticFailures.guard(budgetedResolve),beforeEncode:semanticFailures.guard(beforeEncode),policyContext,signal:options.signal,...(vectorsOn?{stored:semanticFailures.guard(storedVectors)}:{})};
          let previousCached=0;
          const continuationDeadline=Math.min(semanticDeadline+2000,(options.deadline??Infinity)-1000);
          for(;;){
            const started=Date.now();
            semanticState=await semantic.score(query,texts,{...scoreOptions,deadline:sourceDeadline});
            if(!gemmaMethod||candidates.length||isPaused()||!Number.isFinite(options.deadline))break;
            const {cached,total,complete}=semanticState.coverage;
            if(complete||!['timeout','partial'].includes(semanticState.status)||cached<=previousCached||cached>=total)break;
            // Continue only when measured progress predicts completion before the
            // request deadline, leaving a slice for source verification and disclosure.
            const remainingMs=(Date.now()-started)*(total-cached)/(cached-previousCached);
            if(continuationDeadline-Date.now()<Math.max(1,remainingMs))break;
            previousCached=cached;
            sourceDeadline=Math.min(Date.now()+1000,continuationDeadline);
          }
        }catch(error){if(error!==sourceExpired&&semanticFailures.degradable(error,options.signal)){semanticState={status:'unavailable',scores:semanticRows.map(()=>null),coverage:{cached:0,total:semanticRows.length,complete:false}};}else{if(error!==sourceExpired)throw error;const descriptor=typeof SemanticRuntimeHooks!=='undefined'?SemanticRuntimeHooks.descriptor():null;semanticState={status:'timeout',scores:semanticRows.map(()=>null),coverage:{cached:0,total:semanticRows.length,complete:false},...(typeof SemanticWindowPolicy!=='undefined'&&descriptor?.modelId===SemanticWindowPolicy.CONTRACT.modelId?{modelFingerprint:SemanticWindowPolicy.CONTRACT.modelFingerprint}:{})};}}
        check();await authoritative();
        if(policyContext&&(gemmaDecision||SemanticRetrieval.hasScoreEvidence(semanticState)||semanticState.modelFingerprint===SemanticWindowPolicy.CONTRACT.modelFingerprint)){
          const verificationDeadline=Math.min(Date.now()+1000,Number.isFinite(options.deadline)?options.deadline:Infinity);
          sourceDeadline=verificationDeadline;
          const expired=Object.freeze({semanticBudget:true}),guard=()=>{check();if(options.signal?.aborted)throw options.signal.reason===undefined?Error('semantic.aborted'):options.signal.reason;if(Date.now()>=verificationDeadline)throw expired;},policy=SemanticWindowPolicy.createSemanticCoarsePolicy({identify,normalize,terms:retrievalTerms,partialLexicalFields:true}),rawRows=[],entries=[],rowSources=[],tokens=new Map(),fieldRows=new Map(),canonical=new Map(),sourceIndices=[];
          try{
            guard();await resolveTexts(semanticRows.map((_,n)=>n));guard();
            for(let n=0;n<semanticRows.length;n++){guard();const row=semanticRows[n],full=row.metadata?row.metadata.text:originalFields.get(n);if(typeof full!=='string')continue;const identity=row.metadata?{sourceId:row.metadata.sid,field:'metadata.'+row.metadata.field,revision:digest(full),epoch:row.metadata.epoch,sourceRevision:row.metadata.epoch}:{sourceId:JSON.stringify([row.hit.row.sessionId,row.hit.row.messageId]),field:row.hit.row.source,revision:row.hit.row.contentRevision,epoch:row.hit.epoch,sourceRevision:row.hit.sourceRevision},token=policyContext.captureField(identity,full,row.metadata?'raw-metadata-v1':'canonical-message-v3');let source;
              if(row.metadata)source=policyContext.rawWindow(token,row.identity.at(-2),row.identity.at(-1));else{let windows=canonical.get(token);if(!windows){windows=new Map();for(const window of policyContext.canonicalSlices(token)){guard();windows.set(window.canonicalStart,window);}canonical.set(token,windows);}source=policyContext.canonicalWindow(token,windows.get(row.hit.canonicalStart),row.hit.at,row.hit.width);}
              const raw=policyContext.row(source,[row.hit.row.sessionId,row.hit.row.messageOrdinal??-1,row.hit.row.source??row.metadata.field],row.identity),key=row.metadata?row.metadataKey:sourceKeyOf(row.hit.row);if(!tokens.has(key))tokens.set(key,policyContext.weakKey(token));if(!fieldRows.has(key))fieldRows.set(key,rawRows.length);rawRows.push(raw);entries.push(SemanticRetrieval.hasScoreEvidence(semanticState)?{result:semanticState,index:n}:null);rowSources.push({source,token,full,n});sourceIndices.push(n);
            }
            const coverage=await rawCoverage({context,access,seen:new Set(),sequences:new Map()},{check:guard,timeout:expired,manifests:scannedManifests,mutation:searchMutation});guard();
            const verifiedSids=[...new Set(rowSources.map(item=>semanticRows[item.n].hit.row.sessionId))];
            const decision=await policy.evaluate({query,scopeId:access.scopeId,modelFingerprint:SemanticWindowPolicy.CONTRACT.modelFingerprint,rows:rawRows,lexical:candidates.filter(hit=>fieldRows.has(sourceKeyOf(hit.row))).map(hit=>({key:tokens.get(sourceKeyOf(hit.row)),index:fieldRows.get(sourceKeyOf(hit.row))})),scoreEntries:entries,poolComplete:coverage.complete===true&&rawRows.length===semanticRows.length&&fragmentCount<=semanticRows.length-metadataRows.length&&!metadataTruncated&&!entityTruncated&&!lexicalTruncated,context:policyContext.context,windowContext:policyContext,deadline:verificationDeadline,signal:options.signal,
              resolve:async(index,whole)=>{check();const item=rowSources[index];if((semanticRows[item.n].metadata?semanticRows[item.n].metadata.text:originalFields.get(item.n))!==item.full)throw fail('source_changed');return whole?policyContext.wholeSource(item.token):item.source;},beforeVerify:async event=>{
                // The policy stops starting new windows at its soft deadline. Finish
                // validation of already resolved windows under the outer deadline.
                check();activeSids=verifiedSids;
                if(event?.phase==='resolved')await beforeEncode();else await authoritative();
                check();
              }});
            try{const d=policy.decisions(decision,policyContext.context),accepted=semanticRows.map(()=>null);d.semanticAccepted.forEach((value,index)=>{accepted[sourceIndices[index]]=value;});for(const [key,token]of tokens){const verdict=d.weakAccepted.get(token);if(verdict!==undefined)gemmaWeak.set(key,verdict);const index=d.weakWindowIndices.get(token);if(index!==undefined){const chosen=sourceIndices[index];for(let n=0;n<candidates.length;n++)if(sourceKeyOf(candidates[n].row)===key)candidates[n]={...semanticRows[chosen].hit,score:candidates[n].score,entity:false,edge:false,exact:false,verifiedWindow:true};}const field=fieldRows.get(key);if(field!==undefined&&rawRows[field].metadata)gemmaMetadata.set(key,d.metadataAccepted.get(rawRows[field].fieldKey)??null);}gemmaDecision={complete:decision.complete,policyId:decision.policyId};semanticState={...semanticState,status:!decision.complete&&Date.now()>=verificationDeadline?'timeout':semanticState.status,admission:{policyId:decision.policyId,purpose:'search-relevance',answerability:'not-assessed',status:decision.status,accepted},coverage:{...semanticState.coverage,complete:decision.complete}};}finally{policy.dispose(decision,policyContext.context);}
          }catch(error){if(error!==expired&&error!==sourceExpired)throw error;gemmaDecision={complete:false,policyId:SemanticWindowPolicy.CONTRACT.id};semanticState={...semanticState,status:'timeout',admission:{policyId:gemmaDecision.policyId,purpose:'search-relevance',answerability:'not-assessed',status:'partial',accepted:semanticRows.map(()=>null)},coverage:{...semanticState.coverage,complete:false}};}
        }
        if(host.assertScope(context,access)!==true)throw fail('disclosure_changed');
        const admission=semanticState.admission;
        if(admission&&(!Array.isArray(admission.accepted)||admission.accepted.length!==semanticRows.length||admission.accepted.some(value=>value!==true&&value!==false&&value!==null)||!['evaluated','partial','uncalibrated'].includes(admission.status)))throw fail('semantic_policy_invalid');
        for(let n=0;n<semanticRows.length;n++){const row=semanticRows[n],key=row.metadata?row.metadataKey:sourceKeyOf(row.hit.row),evidences=row.metadata?metadataEvidence:semanticEvidence,score=semanticState.scores[n],decision=admission?admission.accepted[n]:Number.isFinite(score)?score>=(semanticState.minScore??0.85):null;let entry=evidences.get(key);if(!entry){entry={scored:0,accepted:false};evidences.set(key,entry);}if(Number.isFinite(score)&&typeof decision==='boolean'){entry.scored++;if(decision)entry.accepted=true;}}
        ranked=semanticRows.map((row,n)=>({...row.hit,metadata:!!row.metadata,semanticScore:semanticState.scores[n],score:semanticState.scores[n],rankScore:semanticState.scores[n]})).filter((hit,n)=>!hit.metadata&&typeof hit.semanticScore==='number'&&Number.isFinite(hit.semanticScore)&&(admission?admission.accepted[n]===true:hit.semanticScore>=(semanticState.minScore??0.85))).sort(compare);
        if(shortQuery){const lexicalSources=new Set(candidates.map(hit=>sourceKeyOf(hit.row))),before=ranked.length;ranked=ranked.filter(hit=>lexicalSources.has(sourceKeyOf(hit.row))||hit.semanticScore>=SHORT_QUERY_SEMANTIC_MIN);shortQueryFiltered=before-ranked.length;}
        // Exact phrases retain priority; other lexical and semantic evidence
        // contribute comparable reciprocal ranks before the final result cap.
      }
        {
          const identity=hit=>[hit.row.sessionId,hit.row.messageId,hit.row.source,hit.canonicalStart].join('\0');
          const fused=new Map();
          candidates.sort(compare).forEach((hit,n)=>{const id=identity(hit);if(!fused.has(id))fused.set(id,{hit,rankScore:1/(61+n),exact:!!hit.exact,lexical:true,lexicalRank:n});});
          const seen=new Set();let rank=0;
          for(const hit of ranked){const id=identity(hit);if(seen.has(id))continue;seen.add(id);const prior=fused.get(id);
            /* 4A 复审建议:两路都命中时保留词法命中(摘录围着关键词),语义只加名次与分数 */if(prior){prior.rankScore+=1/(61+rank);prior.semanticRank=rank;prior.fusedSemanticScore=hit.semanticScore;}
            else fused.set(id,{hit,rankScore:1/(61+rank),exact:false,semanticRank:rank});rank++;
          }
          const merged=[...fused.values()].map(item=>({...item.hit,lexical:!!item.lexical,lexicalRank:item.lexicalRank,semanticRank:item.semanticRank,...(item.fusedSemanticScore===undefined?{}:{fusedSemanticScore:item.fusedSemanticScore}),exact:item.exact,rankScore:item.rankScore+(item.exact?1:0)})).sort((a,b)=>b.rankScore-a.rankScore||compare(a,b));if(merged.length>candidateLimit)lexicalTruncated=true;candidates.splice(0,candidates.length,...merged.slice(0,candidateLimit));
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
        results.push({...disclosed,score:hit.score,rankScore:hit.rankScore??hit.score,matchMode:hit.semanticRank!==undefined?(hit.lexical?'both':'semantic'):'lexical',...(hit.semanticScore!==undefined?{semanticScore:hit.semanticScore}:hit.fusedSemanticScore!==undefined?{semanticScore:hit.fusedSemanticScore}:{})});sequences.set(sid,sequence);projectedSessions.add(sid);
      }
      const covered=new Set(),coverageSequences=new Map(),observedManifests=new Map(),pendingIds=new Set(),coverageState=await rawCoverage({context,access,seen:covered,sequences:coverageSequences},{...options,reuse:coverageReuse,observed:observedManifests,manifests:scannedManifests,mutation:searchMutation,pendingIds});check();
      for(const check of sourceChecks)if(!await check(true))throw fail('source_changed');
      if(host.assertScope(context,access)!==true||[...sequences].some(([sid,seq])=>host.sourceSequence(sid)!==seq||host.assertAuthorized(sid,context,access)!==true)||[...covered].some(sid=>host.assertAuthorized(sid,context,access)!==true||host.sourceSequence(sid)!==coverageSequences.get(sid)))throw fail('disclosure_changed');
      const sorted=results.sort((a,b)=>(b.rankScore??b.score)-(a.rankScore??a.score));const unique=sessionResults?sorted.filter((hit,n)=>sorted.findIndex(other=>other.reference.sessionId===hit.reference.sessionId)===n):sorted;
      const result={query,results:unique.slice(0,cap),coverage:coverageState,ranking:'rrf-v1',...(previewStopped?{previewIncomplete:true}:{}),lexicalAdmission:{partial:lexicalPartial||lexicalTruncated,truncated:lexicalTruncated},...(requiredIds.length?{entity:{required:requiredIds.length,partial:entityTruncated}}:{}),semantic:{status:semanticState.status,coverage:!coverageState.complete||fragmentCount>semanticRows.length-metadataRows.length||metadataTruncated||!semanticState.coverage?.complete?'partial':'complete',candidateFragments:semanticRows.length,cachedFragments:semanticState.coverage?.cached||0,truncated:fragmentCount>semanticRows.length-metadataRows.length||metadataTruncated||entityTruncated,minScore:semanticState.minScore??0.85,...(shortQueryFiltered?{shortQueryFiltered}:{}),...(semanticState.admission?{admission:{policyId:semanticState.admission.policyId,status:semanticState.admission.status,purpose:semanticState.admission.purpose,answerability:semanticState.admission.answerability}}:{}),...(semanticState.modelFingerprint?{modelFingerprint:semanticState.modelFingerprint}:{})},scope:{mode:'message-shards',sampling:false,coordinate:'utf16',maxQueryChars:OVERLAP}};
      const selectedEpochs=new Map([...sequences.keys()].map(sid=>[sid,manifests.get(sid)?.epoch]));
      searchProofs.set(result,{context,access,mutation:searchMutation,observedManifests,coverageSequences,selectedEpochs,metadataTotals,metadataEvidence,metadataTruncated,gemmaDecision,gemmaMetadata,pendingIds});return result;
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
    // 151 阶段 4A(150 S6/S7/S14/S15):后台增量建索引与编码。线程搜索不再在请求里建索引,只 kick() 一下;调度器空闲时
    // (没有在飞的回合 —— 有请求在 drain() 等它时除外)按 200 ms 片推进、片间让出,单个会话建索引内部照旧每 16 ms 让出
    // 事件循环;有搜索在读(读租约)时照常建 shard,只把「提交」押到租约放掉之后(exclusive)。编码则让给在读的搜索。每片走维护准入(维护期不起新片;在飞的被 maintenancePause 截住)与 run 链(与 invalidate、
    // pause 串行)。撤权即停:每片开头重读配置(索引关/暂停 → 停);编码每批前再核语义开关、暂停与该会话的进程内
    // sequence,运行时在发出前还会回调 beforeEncode 再核一次;落盘前核 epoch 与 manifest generation。
    // 150 S7:单个会话超出预算或失败 → 记跳过标记(原因、次数、下次重试时刻)换下一个,不挡后面的会话;到期后预算加倍重试。
    // 已核过的会话按进程内 sequence 记账,sequence 没变就不重读;搜索看到 pending 时把那几条点名重查(外部改盘也认得出)。
    // 没有宿主计时器(单文件 vm 夹具)时不自动调度,由调用方 backgroundTick() 推进。
    const backgroundState={enabled:typeof host.backgroundPolicy==='function',started:false,timer:null,active:null,again:false,urgent:0,waiters:[],
      lexical:{cursor:0,full:true,done:false,serial:undefined,passSerial:undefined,built:0,failed:0},encode:{cursor:0,done:false,serial:undefined,passSerial:undefined,model:null,stall:null},
      checked:new Map(),encoded:new Map(),skipped:new Map(),yields:new Map(),lastBusySliceAt:0,priority:new Set(),encodePriority:new Set(),settled:false,totalBuilt:0,totalEncoded:0,state:'idle'};
    // 撤权(索引关/暂停)在后台片里一律当「暂停」处理:不记跳过标记,配置恢复后接着来。
    const backgroundRevoked=async()=>{checkPaused();const policy=await host.backgroundPolicy();if(!policy||policy.index!==true)throw fail('paused');return policy;};
    const bgTimers={set:host.timers?.setTimeout||(typeof setTimeout==='function'?setTimeout:null),clear:host.timers?.clearTimeout||(typeof clearTimeout==='function'?clearTimeout:null)};
    const budgetExceeded=Object.freeze({backgroundBudget:true});
    const bgSerial=()=>typeof host.sourceSerial==='function'?host.sourceSerial():null;
    const dueSkips=()=>{const now=Date.now();for(const row of backgroundState.skipped.values())if(row.until<=now)return true;return false;};
    function backgroundComplete(){const st=backgroundState;return st.started&&st.lexical.done&&!st.priority.size&&!st.skipped.size&&st.lexical.serial!==undefined&&st.lexical.serial===bgSerial();}
    // 还有活没干完、只是在等(首屏静默期、回合在跑、片间间隔)时报 waiting,前端据此接着拉,不当作「停了」。
    function backgroundStatus(){const st=backgroundState,waiting=st.state==='idle'&&(st.timer!==null||!!st.active)&&!backgroundComplete();return {state:isPaused()?'paused':waiting?'waiting':st.state,complete:backgroundComplete(),skippedSessions:st.skipped.size,...(st.skipped.size?{skipped:[...new Set([...st.skipped.values()].map(row=>row.code))].slice(0,4)}:{}),encodedFragments:st.totalEncoded};}
    function notifyBackground(){const list=backgroundState.waiters;backgroundState.waiters=[];for(const resolve of list)resolve();}
    // 已排着一个更晚的(比如运行时不可用时 30 s 后重试)就提前到这一次;已排着的更早就不动。
    function scheduleBackground(delay){const st=backgroundState;if(!st.enabled||!bgTimers.set||st.active)return;const at=Date.now()+Math.max(0,delay);
      if(st.timer!==null){if(st.timerAt<=at)return;if(bgTimers.clear)bgTimers.clear(st.timer);st.timer=null;}
      const timer=BACKGROUND_ROOT.runInAsyncScope(()=>bgTimers.set(()=>{if(st.timer!==timer)return;st.timer=null;void backgroundTick().catch(()=>{});},Math.max(0,delay)));st.timer=timer;st.timerAt=at;if(typeof timer?.unref==='function')timer.unref();}
    function wakeBackground(){const st=backgroundState;if(st.started&&st.again&&!st.active){st.again=false;scheduleBackground(0);}}
    function backgroundKick(options={}){
      const st=backgroundState;if(!st.enabled)return false;st.started=true;
      // 4A 复审 F4:点名的会话若有跳过标记且正文没变(sequence 相同),标记、退避与加倍预算原样保留,不因每一发搜索重置。
      const proof=options.result?searchProofs.get(options.result):null;if(proof?.pendingIds)for(const sid of proof.pendingIds){const skip=st.skipped.get(sid);if(skip&&skip.sequence===host.sourceSequence(sid))continue;st.checked.delete(sid);st.encoded.delete(sid);st.skipped.delete(sid);st.priority.add(sid);st.encodePriority.add(sid);}
      st.settled=false;
      if(options.force===true)st.lexical.full=true;
      if(st.active){st.again=true;return true;}scheduleBackground(0);return true;
    }
    // 请求在等后台把它点名的几条会话建完(与它们的向量编完):只等不建,到 until 为止。等待期间这些会话建索引失败
    // (命名空间被改、策略冲突、钥匙不可用、维护准入关闭……)照修前的口径从这一发上抛 —— 失败面不因改成后台而被吞掉;
    // 只有「超出预算」是跳过标记、不上抛(150 S7)。
    async function backgroundDrain({result=null,until=Date.now()+1500,check=()=>{}}={}){
      const st=backgroundState;if(!st.enabled)return {progressed:false};const before=st.totalBuilt,started=Date.now(),wanted=searchProofs.get(result)?.pendingIds||new Set();let failure=null;st.urgent++;
      // 点名的会话建完就不再等;它们的向量最多再等 1.5 s(编码慢时语义下一发补,不拖住词法结果)。
      let lexicalAt=0;const lexicalSatisfied=()=>st.lexical.done&&!st.priority.size&&!(st.active&&st.state==='building');
      const satisfied=()=>{if(!lexicalSatisfied()){lexicalAt=0;return false;}if(!lexicalAt)lexicalAt=Date.now();return !st.encodePriority.size&&!st.active&&st.timer===null&&!st.again||Date.now()-lexicalAt>=1500;};
      try{backgroundKick({result});for(;;){check();if(failure||Date.now()>=until||satisfied()||st.settled&&!st.active)break;
        // 没有宿主计时器(单文件 vm 夹具):在这里逐片推进,同样只推到 until 为止。
        if(!bgTimers.set){const outcome=await backgroundTick();if(outcome&&'error'in outcome){failure={error:outcome.error};break;}if(!outcome?.again)break;continue;}
        const watched=st.active;await new Promise(resolve=>{st.waiters.push(resolve);const timer=bgTimers.set(resolve,Math.max(1,Math.min(50,until-Date.now())));if(typeof timer?.unref==='function')timer.unref();});
        if(watched&&st.lastError&&st.lastError.at>=started)failure={error:st.lastError.error};}}
      finally{st.urgent--;}
      if(failure)throw failure.error;
      for(const sid of wanted){const skip=st.skipped.get(sid);if(skip&&skip.failed&&skip.at>=started)throw skip.error;}
      check();return {progressed:st.totalBuilt>before};
    }
    async function backgroundTick(){
      const st=backgroundState;if(!st.enabled)return {again:false};if(st.active)return st.active;st.started=true;
      const work=(async()=>{
        if(isPaused()){st.state='paused';return {again:false};}
        let policy;try{policy=await host.backgroundPolicy();}catch{return {again:true,delay:BACKGROUND_BUSY_RETRY_MS};}
        if(!policy||policy.index!==true){st.state='disabled';st.priority.clear();st.encodePriority.clear();return {again:false};}
        if(policy.semantic!==true||!vectorStoreEnabled||!host.encoder)st.encodePriority.clear();
        if(!st.urgent){if(priorityReaders>0)return {again:true,delay:200};const quiet=lastPriorityRelease+BACKGROUND_QUIET_MS-Date.now();if(quiet>0)return {again:true,delay:quiet};}
        if(policy.semantic===true)st.vectorsPurged=false;
        // 4A 二审 (c):有回合或代理在跑时不再整段停摆 —— 每 3 s 放行一片(低占空比),点名的会话也就有进度。
        if(!st.urgent&&hostBusy()){const wait=st.lastBusySliceAt+BACKGROUND_BUSY_SLICE_EVERY_MS-Date.now();if(wait>0)return {again:true,delay:Math.min(wait,BACKGROUND_BUSY_SLICE_EVERY_MS)};st.lastBusySliceAt=Date.now();}
        const admit=typeof host.admit==='function'?host.admit:work=>work();
        const serial=bgSerial(),lexical=st.lexical;
        // 4A 复审 F2:语义关了就把盘上已有的向量文件全部删掉(一次;再打开后由后台重编)。
        if(policy.semantic!==true&&vectorStoreEnabled&&!st.vectorsPurged)return await admit(()=>run(()=>purgeVectorsUnit()));
        if(st.priority.size||lexical.cursor>0||!lexical.done||lexical.full||serial!==null&&serial!==lexical.serial||dueSkips())return await admit(()=>run(()=>lexicalUnit(serial)));
        if(policy.semantic===true&&vectorStoreEnabled&&host.encoder&&(st.encodePriority.size||!st.encode.done||st.encode.cursor>0||st.encode.serial!==serial))return await admit(()=>run(()=>encodeUnit(serial)));
        st.state='idle';return {again:false};
      })();
      st.active=work;let outcome;
      try{outcome=await work;}catch(error){const paused=error?.code==='session_fulltext.paused';st.state=paused?'paused':'retry';outcome=paused?{again:false}:{again:true,delay:BACKGROUND_BUSY_RETRY_MS*4,error};if(!paused)st.lastError={error,at:Date.now()};}
      finally{st.active=null;}
      if(!outcome.again&&!outcome.idleWait&&!st.again||outcome.retryLater)st.settled=true;
      notifyBackground();
      // 片在「有读租约」时让出:租约放掉时 wakeBackground 会再排;片收尾前租约已经放掉的(唤醒时片还在跑、被吞掉)这里补排。
      if(outcome.idleWait){if(readers===0){st.again=false;scheduleBackground(0);}}
      else if(outcome.again||st.again){st.again=false;scheduleBackground(outcome.delay??BACKGROUND_GAP_MS);}
      return outcome;
    }
    const backgroundYield=Object.freeze({backgroundYield:true});
    const bgCatalog=()=>typeof host.backgroundCatalog==='function'?host.backgroundCatalog():host.catalog();
    // 删除排着队、或(没有请求在等时)宿主不空闲:后台在下一个检查点让出 run 链。
    // 4A 二审 (c):删除排队时一律让;宿主不空闲(有回合在跑)时,同一条会话至多让 2 次,之后建完为止(否则持续有回合时大会话
    // 永远建不完);只有代理在跑(host.busy)不让 —— 那只降低起片频率。
    function hostBusy(){return typeof host.idle==='function'&&host.idle()!==true||typeof host.busy==='function'&&host.busy()===true;}
    function yieldRequested(sid=null){if(invalidatesQueued>0)return true;if(backgroundState.urgent||typeof host.idle!=='function'||host.idle()===true)return false;return sid===null||(backgroundState.yields.get(sid)||0)<BACKGROUND_MAX_YIELDS;}
    async function purgeVectorsUnit(){
      const st=backgroundState;checkPaused();const catalog=await bgCatalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid)))throw fail('catalog_invalid');
      try{for(const sid of catalog){checkPaused();if(yieldRequested())return {again:true,delay:BACKGROUND_BUSY_RETRY_MS};if(!await vectorFileExists(sid))continue;
          const done=await exclusive(()=>removeOwned(sid,[VECTOR_FILE],checkPaused),yieldRequested);if(done===EXCLUSIVE_YIELDED)return {again:true,delay:BACKGROUND_BUSY_RETRY_MS};
          // 二审建议 P6:删一条就忘一条(内存、编码记账),中途让出后语义又打开时这条会被重编。
          vectorEvict(sid);st.encoded.delete(sid);st.encode.done=false;}
      }catch(error){if(error?.code==='session_fulltext.paused'){st.state='paused';return {again:false};}throw error;}
      vectorClear();st.encoded.clear();st.encode.done=false;st.vectorsPurged=true;return {again:true,delay:BACKGROUND_GAP_MS};
    }
    async function lexicalUnit(serial){
      const st=backgroundState,lexical=st.lexical,pending=[];checkPaused();building=true;st.state='building';const sliceEnd=Date.now()+BACKGROUND_SLICE_MS;
      try{
        await beginBuilding();const catalog=await bgCatalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid))||new Set(catalog).size!==catalog.length)throw fail('catalog_invalid');
        const present=new Set(catalog);for(const map of [st.checked,st.encoded,st.skipped])for(const sid of [...map.keys()])if(!present.has(sid))map.delete(sid);
        if(lexical.cursor===0&&!st.priority.size){lexical.passSerial=serial;lexical.passFull=lexical.full;lexical.full=false;lexical.built=0;lexical.failed=0;await exclusive(()=>purgeMissing(catalog,checkPaused));}
        const failed=(sid,sequence,skip,budget,error)=>{lexical.failed++;st.checked.delete(sid);
          const attempts=(skip&&skip.sequence===sequence?skip.attempts:0)+1,over=error===budgetExceeded;st.skipped.set(sid,{code:over?'budget':String(error?.code||'error').slice(0,80),failed:!over,error:over?null:error,at:Date.now(),sequence,budget,attempts,until:Date.now()+BACKGROUND_SKIP_RETRY_MS*Math.min(16,2**(attempts-1))});};
        const visit=async sid=>{
          const sequence=host.sourceSequence(sid),skip=st.skipped.get(sid);
          if(skip){if(skip.sequence!==sequence)st.skipped.delete(sid);else if(skip.until>Date.now())return;}
          const budget=skip&&skip.sequence===sequence?Math.min(BACKGROUND_MAX_BUDGET_MS,skip.budget*2):BACKGROUND_SESSION_BUDGET_MS,deadline=Date.now()+budget;
          // 4A 复审 F3:建一条会话途中有删除排队、或回合开始了(且没有请求在等),在下一个检查点让出 run 链:不记跳过标记,
          // 已写的 shard 照常清掉,下一片重建。
          const check=()=>{checkPaused();if(yieldRequested(sid))throw backgroundYield;if(Date.now()>=deadline)throw budgetExceeded;};
          try{const outcome=await build(sid,check,{background:true,deferCommit:job=>{pending.push({...job,sid,sequence,skip,budget});}});st.yields.delete(sid);if(outcome!=='deferred'){st.skipped.delete(sid);st.checked.set(sid,sequence);}}
          // 二审建议 P5:让出的会话放回点名队列最前,complete 在它建完之前一直为假。
          catch(error){if(error?.code==='session_fulltext.paused')throw error;if(error===backgroundYield){st.checked.delete(sid);st.yields.set(sid,(st.yields.get(sid)||0)+1);st.priority=new Set([sid,...st.priority]);throw error;}failed(sid,sequence,skip,budget,error);}
        };
        // 攒下的提交:没有读租约(或攒满 32 条、片要收尾)时在一次 exclusive 里依次提交;单条失败照常记跳过标记,暂停则其余全部放弃。
        // 每次 exclusive 至多提交 16 条,读者一来就让(非阻塞模式);阻塞模式(攒满 128 条或片收尾)提交到清空为止。
        const flush=async(blocking=true)=>{while(pending.length){if(!blocking&&(readers>0||readersWaiting>0))return;const jobs=pending.splice(0,16);const outcome=await exclusive(async()=>{for(let n=0;n<jobs.length;n++){const job=jobs[n];
          try{await job.commit();lexical.built++;st.totalBuilt++;st.skipped.delete(job.sid);st.checked.set(job.sid,job.sequence);}
          catch(error){await job.abort().catch(()=>{});if(error?.code==='session_fulltext.paused'){for(const rest of jobs.slice(n+1))await rest.abort().catch(()=>{});throw error;}failed(job.sid,job.sequence,job.skip,job.budget,error);}}},()=>invalidatesQueued>0);
          /* 提交只为排队的删除让路(回合在跑不让,否则建好的批永远提交不了);让出的会话放回点名队列 */if(outcome===EXCLUSIVE_YIELDED){for(const job of jobs){st.checked.delete(job.sid);st.priority.add(job.sid);await job.abort().catch(()=>{});}throw backgroundYield;}}};
        const step=async sid=>{while(priorityReaders>0&&!st.urgent)await new Promise(resolve=>priorityWaiters.push(resolve));checkPaused();await visit(sid);if(readers===0&&readersWaiting===0)await flush(false);else if(pending.length>=128)await flush(true);};
        for(const sid of [...st.priority]){checkPaused();st.priority.delete(sid);if(present.has(sid))await step(sid);if(Date.now()>=sliceEnd){await flush();return {again:true,delay:BACKGROUND_GAP_MS};}}
        while(lexical.cursor<catalog.length){
          checkPaused();
          const sid=catalog[lexical.cursor++];
          if(lexical.passFull||st.checked.get(sid)!==host.sourceSequence(sid)||st.skipped.has(sid))await step(sid);
          if(Date.now()>=sliceEnd)break;
        }
        await flush();
        if(lexical.cursor>=catalog.length){lexical.cursor=0;lexical.done=true;lexical.serial=lexical.passSerial;if(lexical.built||lexical.failed)st.encode.done=false;return {again:true,delay:BACKGROUND_GAP_MS};}
        return {again:true,delay:BACKGROUND_GAP_MS};
      }catch(error){if(error===backgroundYield)return {again:true,delay:BACKGROUND_BUSY_RETRY_MS};if(error?.code==='session_fulltext.paused'){st.state='paused';return {again:false};}throw error;}
      finally{for(const job of pending.splice(0)){st.checked.delete(job.sid);await job.abort().catch(()=>{});}building=false;if(st.state==='building')st.state='idle';await state(paused?'paused':'idle');}
    }
    // 后台编码一条会话还缺的窗口。原文只按 shard 行的 contentRevision 从正文现读(整行摘要相同 = 建索引时的同一段正文),
    // 不读附件派生正文(那一路仍在请求内按附件策略回读)。返回 done / partial(片用完或有读租约,下一片接着编)/ skip / stop。
    async function encodeSession(sid,model,sliceEnd,sequence){
      const st=backgroundState,value=await currentManifest(sid);if(!value||value===malformedManifest||!compatible(value))return 'skip';
      if(typeof host.backgroundEligible==='function'&&await host.backgroundEligible(sid)!==true)return 'skip';
      const epoch=await host.epoch(sid);if(!HEX.test(epoch||'')||epoch!==value.epoch)return 'skip';
      const windows=[];
      for(const ref of value.shards){checkPaused();const shard=await read(sid,value.generation+'.'+ref.ordinal+'.json',SHARD_BYTES);
        if(!shard||hash(JSON.stringify(shard))!==ref.sha256||shard.sessionId!==sid||shard.generation!==value.generation||!Array.isArray(shard.rows))return 'skip';
        for(const row of shard.rows){if(typeof row?.text!=='string'||!rangesValid(row)||!integer(row.messageOrdinal)||typeof row.source!=='string'||!HEX.test(row.contentRevision||''))return 'skip';if(/^attachments\./.test(row.source))continue;
          const windowHash=digest({text:row.text,ranges:row.ranges});
          for(const {at,next}of semanticWindows(row.text)){if(windows.length>=VECTOR_ENTRIES)break;const start=rangeAt(row.ranges,at).from,end=rangeAt(row.ranges,next-1).to;
            windows.push({key:windowVectorKey(sid,row.messageOrdinal,row.source,row.contentRevision,row.canonicalStart,at,start,end,windowHash),ordinal:row.messageOrdinal,source:row.source,revision:row.contentRevision,start,end});}}}
      await vectorLoad([sid],model);const existing=vectorMemory.get(sid)?.model===model?vectorMemory.get(sid).entries:new Map(),wanted=new Set(windows.map(row=>row.key));
      const missing=windows.filter(row=>!existing.has(row.key));if(!missing.length&&[...existing.keys()].every(key=>wanted.has(key)))return 'done';
      const byOrdinal=new Map();for(const row of missing){const list=byOrdinal.get(row.ordinal);if(list)list.push(row);else byOrdinal.set(row.ordinal,[row]);}
      const originals=new Map();
      const proof=await host.scan(sid,async(row,ordinal)=>{checkPaused();const wantedRows=byOrdinal.get(ordinal);if(!wantedRows||host.noise(row))return;const revision=digest(row);
        for(const part of sources(row))for(const item of wantedRows)if(item.source===part.field&&item.revision===revision&&item.end<=part.text.length)originals.set(item.key,part.text.slice(item.start,item.end));},{check:checkPaused});
      if(!proof||proof.epoch!==epoch||host.sourceSequence(sid)!==sequence)return 'skip';
      const revoked=async()=>{const policy=await backgroundRevoked();if(policy.semantic!==true)throw encodeRevoked;if(host.sourceSequence(sid)!==sequence)throw fail('source_changed');};
      const todo=missing.filter(row=>{const text=originals.get(row.key);return typeof text==='string'&&text.length>0&&text.length<=8192;}),fresh=new Map();let outcome='done',dims=null;
      for(let offset=0;offset<todo.length;){
        if(fresh.size&&(Date.now()>=sliceEnd||readers>0&&!st.urgent)||yieldRequested()||priorityReaders>0&&!st.urgent){outcome='partial';break;}
        await revoked();
        let count=Math.min(BACKGROUND_ENCODE_BATCH,todo.length-offset);const estimate=n=>typeof host.encoder.estimateEncodingBudget==='function'?host.encoder.estimateEncodingBudget('document',n):n*40;/* 4A 二审 (e):后台一批至多约 150 ms(运行时同一时刻只编一批,前台的查询/记忆重排不被长批挡成 overloaded) */while(count>1&&estimate(count)>BACKGROUND_ENCODE_BATCH_MS)count--;
        const batch=todo.slice(offset,offset+count),texts=batch.map(row=>originals.get(row.key));
        const result=await host.encoder.encode(texts,{role:'document',scopeId:BACKGROUND_SCOPE,deadline:Date.now()+1000,minimumBudgetMs:Math.min(900,Math.max(1,estimate(count))),beforeEncode:async()=>{checkPaused();if(host.sourceSequence(sid)!==sequence)throw fail('source_changed');}});
        if(!result?.ok){st.encode.stall=String(result?.reason||'unavailable');outcome=fresh.size?'partial':'stop';break;}
        if(result.modelFingerprint!==model||!Array.isArray(result.vectors)||result.vectors.length!==texts.length){st.encode.stall='model_changed';return 'stop';}
        batch.forEach((row,n)=>{const vector=result.vectors[n];if(result.truncated?.[n]||!Array.isArray(vector)||!vector.length||vector.length>8192||!vector.every(Number.isFinite)||!vector.some(x=>x!==0))return;if(dims===null)dims=vector.length;if(vector.length===dims)fresh.set(row.key,Float32Array.from(vector));});
        offset+=count;
        // 4A 二审 (e):批与批之间空出 50 ms,前台(查询编码、记忆重排)每 25 ms 一次的重试能插进来。
        if(offset<todo.length)await pauseBriefly(BACKGROUND_ENCODE_GAP_MS);
      }
      if(!fresh.size&&outcome!=='done')return outcome;
      for(const vector of existing.values()){if(dims===null)dims=vector.length;break;}
      // 单文件容量按维度折算条数(base64 文本 + 键),超出的窗口不落盘(该会话语义覆盖记为部分)。
      const fit=dims?Math.max(1,Math.min(VECTOR_ENTRIES,Math.floor((VECTOR_BYTES-4096)/(Math.ceil(dims*4/3)*4+80)))):0,next=new Map();for(const row of windows){if(next.size>=fit)break;const vector=fresh.get(row.key)||existing.get(row.key);if(vector&&vector.length===dims)next.set(row.key,vector);}
      await revoked();if(await host.epoch(sid)!==epoch)return 'skip';
      const record={schema:VECTOR_SCHEMA,sessionId:sid,model,dims:dims||1,entries:Object.fromEntries([...next].map(([key,vector])=>[key,packVector(vector)]))},policy=await host.enabled();
      const written=await exclusive(async()=>{await revoked();const current=await currentManifest(sid);if(current===malformedManifest||current?.generation!==value.generation)return false;
        if(next.size)await write(sid,VECTOR_FILE,record,VECTOR_BYTES,policy,checkPaused);else await removeOwned(sid,[VECTOR_FILE],checkPaused);return true;});
      if(!written)return 'skip';
      vectorPut(sid,model,next);st.totalEncoded+=fresh.size;return outcome;
    }
    const encodeRevoked=Object.freeze({backgroundEncodeRevoked:true});
    async function encodeUnit(serial){
      const st=backgroundState,encode=st.encode;checkPaused();
      // 运行时没就绪时不在 run 链里等它加载(那会把点名的建索引挡在后面):有 descriptor 的宿主只发一次不等的预热、稍后再来;
      // 没有 descriptor 的宿主(夹具)才走一次有界 prepare。
      let descriptor=typeof host.encoder.descriptor==='function'?host.encoder.descriptor():undefined;
      if(descriptor===undefined){try{descriptor=await host.encoder.prepare({scopeId:BACKGROUND_SCOPE,deadline:Date.now()+1000});}catch{descriptor=null;}checkPaused();}
      else if(descriptor?.available!==true){try{const task=host.encoder.prewarm?.();if(task&&typeof task.catch==='function')task.catch(()=>{});}catch{}}
      // 运行时还在加载:2 s 后再看;起不来/已关:30 s 后再试(运行时自己有故障退避);Gemma 研究路径不落持久向量。
      if(descriptor?.modelId==='embeddinggemma-2-text-q4'){encode.done=true;encode.serial=serial;st.encodePriority.clear();st.state='idle';return {again:false};}
      if(descriptor?.available!==true||typeof descriptor.modelFingerprint!=='string'||!descriptor.modelFingerprint){const loading=['loading','warming','cold','starting'].includes(descriptor?.state);encode.stall=String(descriptor?.reason||descriptor?.state||'unavailable');st.encodePriority.clear();st.state='idle';return {again:true,delay:loading?2000:30000,retryLater:true};}
      const model=descriptor.modelFingerprint;if(encode.model!==model){encode.model=model;encode.cursor=0;st.encoded.clear();}
      if(encode.cursor===0)encode.passSerial=serial;
      st.state='encoding';const sliceEnd=Date.now()+BACKGROUND_SLICE_MS;
      try{
        const catalog=await bgCatalog();if(!Array.isArray(catalog)||catalog.some(sid=>!valid(sid)))throw fail('catalog_invalid');
        const present=new Set(catalog);
        // 一条会话编一段:done/skip 记账(sequence + 模型),partial 下一片接着编,stop(运行时忙/不可用)整片收工稍后再来。
        const one=async sid=>{const sequence=host.sourceSequence(sid),mark=st.encoded.get(sid);if(mark&&mark.sequence===sequence&&mark.model===model)return 'done';
          let outcome;try{outcome=await encodeSession(sid,model,sliceEnd,sequence);}catch(error){if(error?.code==='session_fulltext.paused'||error===encodeRevoked)throw error;outcome='skip';}
          if(outcome==='done'||outcome==='skip')st.encoded.set(sid,{sequence,model});return outcome;};
        // 请求点名的几条(刚建完索引的)先编。
        for(const sid of [...st.encodePriority]){checkPaused();if(!present.has(sid)){st.encodePriority.delete(sid);continue;}const outcome=await one(sid);
          if(outcome==='stop'){st.encodePriority.clear();st.state='idle';return {again:true,delay:2000,retryLater:true};}if(outcome!=='partial')st.encodePriority.delete(sid);if(Date.now()>=sliceEnd||outcome==='partial')return {again:true,delay:BACKGROUND_GAP_MS};}
        while(encode.cursor<catalog.length){checkPaused();if(readers>0&&!st.urgent)return {again:false,idleWait:(st.again=true)};if(st.priority.size)return {again:true,delay:0};if(yieldRequested())return {again:true,delay:BACKGROUND_BUSY_RETRY_MS};if(!st.urgent&&typeof host.idle==='function'&&host.idle()!==true)return {again:true,delay:BACKGROUND_BUSY_RETRY_MS};
          const outcome=await one(catalog[encode.cursor]);
          if(outcome==='stop'){st.state='idle';return {again:true,delay:2000,retryLater:true};}
          if(outcome!=='partial')encode.cursor++;
          if(Date.now()>=sliceEnd)break;
        }
        if(encode.cursor>=catalog.length){encode.cursor=0;encode.done=true;encode.serial=encode.passSerial;encode.stall=null;st.state='idle';return {again:false};}
        return {again:true,delay:BACKGROUND_GAP_MS};
      }catch(error){if(error===encodeRevoked){st.encodePriority.clear();st.state='idle';return {again:false};}if(error?.code==='session_fulltext.paused'){st.state='paused';return {again:false};}throw error;}
      finally{if(st.state==='encoding')st.state='idle';}
    }
    async function restorePause(context){const phase=savedPhase(await read(null,'state.json',1024));persistedPhase=phase;paused=phase==='paused';return coverage(context);}
    return Object.freeze({step,prepare,resetPreparation,preparationComplete,search,revalidate,mutationState,coverage,restorePause,usesWindowPolicy:(result,context)=>{const proof=searchProofs.get(result);return !!proof&&proof.context===context&&!!proof.gemmaDecision;},metadataAdmission:(result,sid,field,context)=>{const proof=searchProofs.get(result);if(!proof||proof.context!==context)return null;const key=JSON.stringify([sid,field]);if(proof.gemmaDecision)return proof.gemmaMetadata.get(key)??null;const value=proof.metadataEvidence.get(key),total=proof.metadataTotals.get(key)||0;return value?.accepted?true:total>0&&value?.scored===total?false:null;},invalidate:(sid,deleted=false)=>{const finish=beginMutation();clearCanonicalCaches();/* 4A 复审 F3:排着队的删除让后台在下一个检查点让出 run 链 */invalidatesQueued++;let queued=true;const dequeue=()=>{if(queued){queued=false;invalidatesQueued--;}};return run(async()=>{dequeue();/* 150 S14:只忘这一条会话的向量(修前整表清空) */if(typeof semantic?.forget==='function')semantic.forget(sid);else semantic?.clear();vectorEvict(sid);for(const map of [backgroundState.checked,backgroundState.encoded,backgroundState.skipped])map.delete(sid);clearCanonicalCaches();preparationProgress.clear();coverageProofs.delete(sid);await purge(sid);}).finally(()=>{dequeue();finish();if(backgroundState.started&&!deleted)backgroundKick();});},pause:()=>{paused=true;clearCanonicalCaches();vectorClear();return run(()=>state('paused'));},resume:()=>{paused=false;return run(()=>state('idle')).then(value=>{if(backgroundState.started)backgroundKick({force:true});return value;});},isPaused,
      beginRead,backgroundKick,backgroundDrain,backgroundTick,backgroundStatus,backgroundComplete,clearVectors:vectorClear,vectorsCached:()=>vectorMemory.size,
      setMaintenancePaused:value=>{const next=value===true;/* 2C 复审建议 4:工作数据维护期间迁移编解码(01x/01ad)会重写 _fulltext-index-v1 而不经 beginMutation;进出维护各推一次 mutationSerial,沿用 manifest 的捷径与 13as 的 index_changed 判据都因此失效重读。 */if(next!==maintenancePaused){mutationSerial++;/* 3F:维护可能重写或删掉 state.json,确知的盘上 phase 一并作废,下一次写前重读。 */persistedPhase=undefined;}const leaving=maintenancePaused&&!next;maintenancePaused=next;clearCanonicalCaches();/* 4A:维护可能重封或改写向量文件,解码缓存作废;后台核账全部重来。 */vectorClear();if(next||leaving){backgroundState.checked.clear();backgroundState.encoded.clear();backgroundState.lexical.full=true;}if(leaving&&backgroundState.started)backgroundKick();},busy:()=>building,pending:()=>maintenanceChain});
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
    // 151 阶段 4A:后台建索引与持久向量。配置每片现读(索引关/暂停/语义关即停);空闲 = 没有在飞的回合;片经维护准入;
    // 编码只给非管家会话(管家线程不进线程搜索);运行时没就绪时搜索不等它。
    vectors:true,backgroundPolicy:async()=>{const config=await readConfig();return {index:config.sessionSearchIndexV1!==false&&config.sessionSearchIndexPausedV1!==true,semantic:process.env.RUYI_DISABLE_SEMANTIC!=='1'&&config.semanticRetrievalV1!==false};},
    idle:()=>typeof turnSettlers==='undefined'||turnSettlers.size===0,busy:()=>typeof activeAgentRuns!=='undefined'&&activeAgentRuns.size>0,sourceSerial:typeof sessionFullTextSourceSerial==='function'?sessionFullTextSourceSerial:undefined,
    admit:work=>typeof WorkDataMaintenanceHooks.fresh==='function'?WorkDataMaintenanceHooks.fresh('session-fulltext-index',work):WorkDataMaintenanceHooks.run('session-fulltext-index',work),
    backgroundEligible:async sid=>{const selected=typeof source.inspect==='function'?await source.inspect(sid):null;return !!selected&&selected.head?.kind!=='steward'&&selected.head?.rawKind!=='steward';},
    ...(typeof SemanticRuntimeHooks!=='undefined'&&typeof SemanticRuntimeHooks.encode==='function'?{encoder:SemanticRuntimeHooks,semanticReady:()=>typeof SemanticRuntimeHooks.descriptor!=='function'||SemanticRuntimeHooks.descriptor()?.available===true,semanticWarm:()=>{const task=SemanticRuntimeHooks.prewarm?.();if(task&&typeof task.catch==='function')task.catch(()=>{});}}:{}),
    // 4A 复审 F1:后台只用全目录(从不用请求范围的 restrictedCatalog)。
    backgroundCatalog:()=>fullCatalog(),
    catalog:async()=>{
      const restricted=disclosure.restrictedCatalog?.();if(restricted!==null&&restricted!==undefined)return restricted;
      return fullCatalog();
    }});
  async function fullCatalog(){
      let entries;try{entries=await fsp.readdir(paths.sessions,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
      const ids=[],physical=new Set(),pattern=process.platform==='win32'?/^([A-Za-z0-9_-]{1,64})\.json$/i:/^([A-Za-z0-9_-]{1,64})\.json$/;
      for(const entry of entries){const match=pattern.exec(entry.name);if(!match||safeSessionId(match[1])!==match[1])continue;
        const key=process.platform==='win32'?match[1].toLowerCase():match[1];
        if(!entry.isFile()||entry.isSymbolicLink()||physical.has(key))throw Object.assign(Error('session_fulltext.catalog_invalid'),{code:'session_fulltext.catalog_invalid'});
        physical.add(key);ids.push(match[1]);
      }
      return ids.sort();
  }
  const admitted=work=>WorkDataMaintenanceHooks.run('session-fulltext-index',work);
  sessionFullTextOwner=instance;
  // 运行时缓存失效(换模型、语义开关、加密开关)时向量解码缓存一并作废;注册表只存弱引用,实例活着它就在。
  if(typeof SemanticRuntimeHooks!=='undefined'&&typeof SemanticRuntimeHooks.registerCache==='function')SemanticRuntimeHooks.registerCache(instance.clearVectors);
  return Object.freeze({beginRead:instance.beginRead,backgroundKick:instance.backgroundKick,backgroundDrain:instance.backgroundDrain,backgroundStatus:instance.backgroundStatus,search:instance.search,revalidate:instance.revalidate,usesWindowPolicy:instance.usesWindowPolicy,metadataAdmission:instance.metadataAdmission,mutationState:instance.mutationState,coverage:instance.coverage,resetPreparation:instance.resetPreparation,preparationComplete:instance.preparationComplete,prepare:(context,options)=>admitted(()=>instance.prepare(context,options)),
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
