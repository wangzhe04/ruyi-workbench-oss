'use strict';
const a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto'),z=require('node:zlib');
const ROOT=p.resolve(__dirname,'../..'),h=b=>c.createHash('sha256').update(b).digest('hex');
const coreSource=['01i-privacy-rules.js','01h-privacy-core.js'].map(name=>fs.readFileSync(p.join(ROOT,'ruyi-workbench/app/src',name),'utf8')).join('\n');
const core=vm.runInNewContext(coreSource+';PrivacyCore;', {require,Buffer});
const source=fs.readFileSync(process.env.MEDIA_IMAGE_SOURCE||p.join(ROOT,'ruyi-workbench/app/src/13ba-media-image-contract.js'),'utf8');
const contract=vm.runInNewContext(source+';MediaImageContract;',{require,Buffer,PrivacyCore:core,setTimeout,clearTimeout});
function fixture({changeFrame,finish,start,onAssert}={}){
  const original=Buffer.from('SYNTHETIC-LOCAL-ENCODED-SOURCE-NOT-A-DECODER-FIXTURE'),policy={personal:true,rules:[]};
  let sourceRev='s1',policyRev='p1',processorRev='v1',time=1000;const calls=[];
  const sourceOwner={capture:()=>({bytes:original,hash:h(original),revision:sourceRev,scope:'thread-synthetic'}),assert:s=>{onAssert?.('source');return s.revision===sourceRev&&h(original)===s.hash;}};
  const policyOwner={capture:()=>({config:policy,hash:h(JSON.stringify(policy)),rulesHash:h(coreSource),revision:policyRev}),assert:s=>s.revision===policyRev&&s.hash===h(JSON.stringify(policy))};
  const processorOwner={capture:()=>({version:processorRev,hash:h(processorRev)}),assert:s=>s.version===processorRev,start:request=>{
    calls.push(request);const frame={rgba:Buffer.alloc(32*16*4,200),width:32,height:16,sourceHash:request.sourceHash,processorHash:h(processorRev),frames:1,orientationApplied:true,ocrComplete:true,codesComplete:true,
      transform:{width:32,height:16,orientation:1},words:[{text:'local.fixture@example.test',line:0,box:[4,4,8,8]}],codes:[{kind:'qr',text:'local.fixture@example.test',box:[20,0,24,4]}]};
    for(let n=3;n<frame.rgba.length;n+=4)frame.rgba[n]=255;frame.rgba[(15*32+31)*4+3]=0;
    changeFrame?.(frame);return {promise:start?start(frame,request):Promise.resolve(frame),finish:options=>{calls.push({finish:options});return finish?finish(options):{closed:true,helperMayStillRun:false,ownershipRetained:false};}};
  }};
  const pipeline=contract.create({sourceOwner,policyOwner,processorOwner,now:()=>time});
  return {pipeline,calls,original,sourceOwner,policyOwner,processorOwner,sourceHash:h(original),setSource:()=>sourceRev='s2',setPolicy:()=>policyRev='p2',setProcessor:()=>processorRev='v2',setTime:value=>time=value};
}
function png(bytes){a.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let pos=8,header,idat=[];const names=[];
  while(pos<bytes.length){const n=bytes.readUInt32BE(pos),name=bytes.toString('ascii',pos+4,pos+8),data=bytes.subarray(pos+8,pos+8+n);names.push(name);if(name==='IHDR')header=Buffer.from(data);if(name==='IDAT')idat.push(data);pos+=n+12;}a.equal(pos,bytes.length);return{names,width:header.readUInt32BE(0),height:header.readUInt32BE(4),raw:z.inflateSync(Buffer.concat(idat)),header};}
const pixel=(image,x,y)=>[...image.raw.subarray(y*(image.width*3+1)+1+x*3,y*(image.width*3+1)+1+x*3+3)];
const {functionBlock}=require('./source-slice');
const prototypeSource=fs.readFileSync(p.join(ROOT,'dev-harness/privacy-m1/media/prototype.js'),'utf8'),policyStart=prototypeSource.indexOf('const POLICY ='),policyEnd=prototypeSource.indexOf('const sha =',policyStart),mappingCoreSource=['01i-privacy-rules.js','01h-privacy-core.js'].map(file=>fs.readFileSync(p.join(ROOT,'ruyi-workbench/app/src',file),'utf8')).join('\n');
const mappingCore=vm.runInNewContext(mappingCoreSource+';PrivacyCore;', {require,Buffer});
const adapter=vm.runInNewContext(prototypeSource.slice(policyStart,policyEnd)+'\n'+functionBlock(prototypeSource,'mapWords')+';({mapWords,loadDetector:()=>({detector:core.createDetector(POLICY)})});',{core:mappingCore,failure:code=>Object.assign(Error(code),{code})});

module.exports={core,contract,fixture,source,ROOT,h,png,pixel,functionBlock,loadDetector:adapter.loadDetector,mapWords:(...args)=>JSON.parse(JSON.stringify(adapter.mapWords(...args)))};
