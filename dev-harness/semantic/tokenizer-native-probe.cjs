'use strict';
// Isolated official-native tokenizer study. No product worker or model inference.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const root=path.resolve(__dirname,'../..'),study=path.join(root,'output/tokenizer-native-research-v1/probe-native-official-0232'),assets=path.join(root,'output/semantic-runtime-win32-x64'),modelDir=path.join(assets,'models/paraphrase-multilingual-MiniLM-L12-v2');
function denyNetwork(){const deny=()=>{throw Error('NETWORK_DISABLED');};globalThis.fetch=deny;for(const name of ['node:http','node:https']){const api=require(name);api.request=deny;api.get=deny;}const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;require('node:tls').connect=deny;}
function corpus(){
 const fixture=require('./calibration-fixture.cjs'),rows=[...fixture.documents.map(doc=>({id:'doc:'+doc.id,text:doc.text})),...fixture.queries.map(query=>({id:'query:'+query.id,text:query.text}))];
 const special=['',' ','\t\r\n','Hello world','HELLO World hello','é e\u0301 É Å Å A\u030a','ＡＢＣ１２３ ａｂｃ','ﬁ ﬃ ① Ⅰ ℌ','中文标点，。！？「」《》','日本語カタカナひらがな','ภาษาไทยไม่มีช่องว่าง','العَرَبِيَّةُ فارسی','עברית שלום','한국어 한글','Русский Ё ё','İ I ı i ß ẞ','👨‍👩‍👧‍👦 👍🏽 🇨🇳 🧑🏿‍💻','a\u0000b\u0001c\u007fd','a\u200bb\u200cc\u200dd','a\u00a0b\u202fc\u3000d','a\u2028b\u2029c','\ufefftext\uffff','\ud800','\udc00','\ud800a\udc00','<s>','</s>','<pad>','<unk>','<mask>','hello<mask>world','hello <mask> world','hello   <mask>world','<s>Hello</s>','<pad> <pad>','[CLS] [SEP] [MASK]','BEE-401 BEE_401 bee:401','secret@example.invalid https://example.invalid/a?q=1','one\ntwo\n\nthree','\\ / \' " ` $ {} [] < > | ~ ^ % & * + = - _ : ; , . ? !'];
 special.forEach((text,i)=>rows.push({id:'edge:'+String(i).padStart(3,'0'),text}));
 for(const count of [120,125,126,127,128,129,130,256,1024,4096])for(const word of ['a ','中'])rows.push({id:'length:'+word.trim()+':'+count,text:word.repeat(count)});
 for(const text of ['a'.repeat(8192),'中'.repeat(8192),'😀'.repeat(4096),'e\u0301'.repeat(4096)])rows.push({id:'maxchars:'+rows.length,text});
 if(rows.length!==new Set(rows.map(row=>row.id)).size||rows.some(row=>row.text.length>8192))throw Error('corpus invalid');return rows;
}
async function child(backend,out){
 if(fs.existsSync(out))throw Error('Use a new child report');denyNetwork();
 const report={schemaVersion:1,backend,status:'RUNNING',node:process.version,platform:process.platform,arch:process.arch,nodeApi:process.versions.napi,stages:[],rows:[]},start=performance.now();
 const stamp=name=>report.stages.push({name,elapsedMs:performance.now()-start,...process.memoryUsage(),peakRssBytes:process.resourceUsage().maxRSS*1024});
 const idle=()=>new Promise(resolve=>setTimeout(resolve,100)),gc=async()=>{if(!global.gc)throw Error('Explicit diagnostic GC unavailable');global.gc();await new Promise(resolve=>setImmediate(resolve));global.gc();await idle();};
 let tokenizer;stamp('start');
 try{
  let Native;
  if(backend==='js'){
   const lib=await import(pathToFileURL(path.join(assets,'node_modules/@huggingface/transformers/dist/transformers.node.mjs')).href);
   lib.env.allowRemoteModels=false;lib.env.allowLocalModels=true;lib.env.useBrowserCache=false;lib.env.useFSCache=false;stamp('library-imported');
   tokenizer=await lib.AutoTokenizer.from_pretrained(modelDir,{local_files_only:true});
  }else if(backend==='native'){
   Native=require(path.join(study,'package'));stamp('library-imported');tokenizer=Native.Tokenizer.fromFile(path.join(modelDir,'tokenizer.json'));
  }else throw Error('backend invalid');
  stamp('tokenizer-loaded-cold');await idle();stamp('loaded-idle-no-explicit-gc');await gc();stamp('loaded-after-explicit-diagnostic-gc');
  for(const row of corpus()){
   let rawIds,inputs;
   if(backend==='js'){
    rawIds=tokenizer.encode(row.text);
    const value=tokenizer([row.text],{padding:true,truncation:true,max_length:128});
    inputs={ids:Array.from(value.input_ids.data,Number),mask:Array.from(value.attention_mask.data,Number),types:value.token_type_ids?Array.from(value.token_type_ids.data,Number):null,dims:value.input_ids.dims};
   }else{
    tokenizer.disableTruncation();tokenizer.disablePadding();
    const full=await tokenizer.encode(row.text,null,{addSpecialTokens:true});rawIds=full.getIds();
    // Published binding accepts lowercase strings despite its enum's spelling.
    tokenizer.setTruncation(128,{direction:'right',strategy:'LongestFirst',stride:0});
    tokenizer.setPadding({direction:'right',padId:1,padTypeId:0,padToken:'<pad>'});
    const encoded=await tokenizer.encode(row.text,null,{addSpecialTokens:true});
    inputs={ids:encoded.getIds(),mask:encoded.getAttentionMask(),types:encoded.getTypeIds(),dims:[1,encoded.getLength()]};
   }
   const types=inputs.types??Array(inputs.ids.length).fill(0);
   if(inputs.ids.length>128||inputs.mask.length!==inputs.ids.length||types.length!==inputs.ids.length||inputs.dims[0]!==1||inputs.dims[1]!==inputs.ids.length)throw Error('Invalid model input: '+row.id);
   report.rows.push({id:row.id,textSha256:sha(row.text),utf16Chars:row.text.length,rawTokenCount:rawIds.length,rawIds:Array.from(rawIds),...inputs,effectiveTypes:types});
  }
  stamp('all-texts-encoded');await idle();stamp('encoded-idle-no-explicit-gc');await gc();stamp('encoded-after-explicit-diagnostic-gc');
  tokenizer=null;await gc();stamp('tokenizer-unreferenced-after-diagnostic-gc');report.status='PASS_ENCODING';
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);process.exitCode=1;}
 finally{fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({backend,status:report.status,rows:report.rows.length,error:report.error})+'\n');}
}
function main(out){
 if(fs.existsSync(out))throw Error('Use a new parent report');
 const report={schemaVersion:1,status:'RUNNING',createdAt:new Date().toISOString(),productionChanged:false,modelInference:false,corpusCount:corpus().length,children:[],mismatches:[],fieldPresenceDifferences:[]};
 const run=backend=>{const file=out.replace(/\.json$/,'.'+backend+'.json'),started=Date.now(),p=spawnSync(process.execPath,['--expose-gc',__filename,'--child',backend,file],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:1024*1024,windowsHide:true}),value=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;report.children.push({backend,file,exitCode:p.status,signal:p.signal,error:p.error?.message,stdout:p.stdout,stderr:p.stderr,wallMs:Date.now()-started,stages:value?.stages});if(p.status!==0||value?.status!=='PASS_ENCODING')throw Error('Child failed: '+backend);return value;};
 try{
  const archive=JSON.parse(fs.readFileSync(path.join(study,'archive-verification.json'))),metadata=JSON.parse(fs.readFileSync(path.join(study,'package/package.json')));
  if(archive.sourceCommit!=='c2b33f8e16dac92ac530bf3ebd8d6c60ab7607c4'||archive.slsaPayloadDigestAndSourceMatch!==true||metadata.version!=='0.23.2')throw Error('Native provenance mismatch');
  const provenanceFiles=[__filename,path.join(__dirname,'calibration-fixture.cjs'),path.join(study,'package/tokenizers.win32-x64-msvc.node'),path.join(study,'package/index.js'),path.join(study,'package/package.json'),path.join(study,'package/LICENSE'),path.join(study,'archive-verification.json'),...['tokenizer.json','tokenizer_config.json','special_tokens_map.json'].map(name=>path.join(modelDir,name)),path.join(assets,'node_modules/@huggingface/transformers/dist/transformers.node.mjs'),path.join(root,'ruyi-workbench/semantic-runtime/worker.cjs')];
  report.provenance=provenanceFiles.map(file=>{const bytes=fs.readFileSync(file);return{path:file,bytes:bytes.length,sha256:sha(bytes)};});
  const js=run('js'),native=run('native');if(js.rows.length!==native.rows.length||js.rows.length!==report.corpusCount)throw Error('Row count mismatch');
  for(let i=0;i<js.rows.length;i++){
   const a=js.rows[i],b=native.rows[i];if(a.id!==b.id||a.textSha256!==b.textSha256)throw Error('Row identity mismatch');
   for(const field of ['rawTokenCount','rawIds','ids','mask','effectiveTypes','dims'])if(JSON.stringify(a[field])!==JSON.stringify(b[field])){const n=Array.isArray(a[field])?a[field].findIndex((value,j)=>value!==b[field][j]):null;report.mismatches.push({id:a.id,field,firstDifferentIndex:n,jsLength:a[field]?.length??null,nativeLength:b[field]?.length??null,jsFirst:n===null?a[field]:a[field][n],nativeFirst:n===null?b[field]:b[field][n]});}
   if((a.types===null)!==(b.types===null))report.fieldPresenceDifferences.push({id:a.id,jsTypesPresent:a.types!==null,nativeTypesPresent:b.types!==null,effectiveTypesEqual:JSON.stringify(a.effectiveTypes)===JSON.stringify(b.effectiveTypes)});
  }
  report.status=report.mismatches.length?'RED_NOT_EQUIVALENT':'PASS_EQUIVALENCE';
  report.resourceComparison=Object.fromEntries(['tokenizer-loaded-cold','loaded-idle-no-explicit-gc','loaded-after-explicit-diagnostic-gc','all-texts-encoded','encoded-after-explicit-diagnostic-gc'].map(name=>{const a=js.stages.find(row=>row.name===name),b=native.stages.find(row=>row.name===name);return[name,{jsRss:a.rss,nativeRss:b.rss,rssReductionBytes:a.rss-b.rss,rssReductionFraction:1-b.rss/a.rss,jsHeapUsed:a.heapUsed,nativeHeapUsed:b.heapUsed,jsPeakRssBytes:a.peakRssBytes,nativePeakRssBytes:b.peakRssBytes}];}));
  report.notes=['Fresh sequential Node24 processes. No model/ORT session was loaded. Existing Transformers JS import and native binding have different library footprints, included in totals.','Cold peak is process lifetime OS peak. Resident idle and heap are distinct; explicit diagnostic GC stages do not change production GC behavior.','Native raw counting disables truncation/padding; actual inputs use explicit right LongestFirst128 plus BatchLongest right pad1/zero type. Single text per physical batch, original JSON pipeline unchanged.','A missing JS token_type_ids field is reported separately, never silently declared the same API. effectiveTypes comparison models the existing worker zero fallback; actual tensor fields and lengths remain in child receipts.','All raw untruncated IDs and actual128-token model-input IDs/mask/type/dims are retained for each case. Empty strings and isolated surrogate stress cases may exceed product policy but are not removed to improve results.','This finite corpus does not prove every Unicode input equivalent; any observed mismatch is RED. No latency, end-to-end RAM or production readiness claim.'];
 }catch(error){report.status='FAIL';report.error=String(error.stack||error);}
 report.finishedAt=new Date().toISOString();fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({out,status:report.status,rows:report.corpusCount,mismatches:report.mismatches.length,firstMismatches:report.mismatches.slice(0,12),resources:report.resourceComparison,error:report.error}));if(report.status!=='PASS_EQUIVALENCE')process.exitCode=1;
}
if(process.argv[2]==='--child')child(process.argv[3],path.resolve(process.argv[4])).catch(error=>{console.error(error);process.exitCode=1;});else main(path.resolve(process.argv[2]||path.join(study,'tokenizer-probe-v1.json')));
