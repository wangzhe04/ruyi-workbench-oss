'use strict';
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),vm=require('node:vm'),c=require('node:crypto');
const root=process.env.RUYI_SOURCE_ROOT||p.resolve(__dirname,'../..');
const candidate=process.env.MEDIA_IMAGE_SOURCE||p.join(root,'ruyi-workbench/app/src/13ba-media-image-contract.js');
const sha=x=>c.createHash('sha256').update(x).digest('hex');
const coreSource=['01i-privacy-rules.js','01h-privacy-core.js'].map(f=>fs.readFileSync(p.join(root,'ruyi-workbench/app/src',f),'utf8')).join('\n');
const core=vm.runInNewContext(coreSource+';PrivacyCore;',{require,Buffer});
function make({memoryError,closure,primary=false,detach=false}) {
 let cleanupTarget,transferred,frame;
 function BufferFacade(){} Object.setPrototypeOf(BufferFacade,Buffer);
 BufferFacade.prototype={fill:function(...args){if(this===cleanupTarget)throw memoryError;return Buffer.prototype.fill.apply(this,args);}};
 const contract=vm.runInNewContext(fs.readFileSync(candidate,'utf8')+';MediaImageContract;',{require,Buffer:detach?Buffer:BufferFacade,PrivacyCore:core,setTimeout,clearTimeout});
 const original=Buffer.alloc(8192,42),config={personal:true,rules:[]};
 const source={bytes:original,hash:sha(original),revision:'s1',scope:'synthetic'};
 const policy={config,hash:sha(JSON.stringify(config)),rulesHash:sha(coreSource),revision:'p1'};
 const processor={hash:sha('processor'),version:'v1'};
 const pipeline=contract.create({sourceOwner:{capture:()=>source,assert:()=>true},policyOwner:{capture:()=>policy,assert:()=>true},processorOwner:{capture:()=>processor,assert:()=>true,start(request){
  cleanupTarget=request.source;if(detach)transferred=structuredClone(request.source.buffer,{transfer:[request.source.buffer]});
  frame={rgba:Buffer.alloc(32*16*4,255),width:32,height:16,sourceHash:source.hash,processorHash:processor.hash,frames:1,orientationApplied:true,ocrComplete:true,codesComplete:true,transform:{width:32,height:16,orientation:1},words:[{text:'synthetic@example.test',line:0,box:[4,4,8,8]}],codes:[]};
  return {promise:primary?Promise.reject(false):Promise.resolve(frame),finish:closure};
 }}});
 return {pipeline,frame:()=>frame,original,cleanup:()=>{if(transferred)Buffer.from(transferred).fill(0);else if(cleanupTarget)cleanupTarget.fill(0);}};
}
const closureCases=[
 {name:'closed-false proof',call:()=>({closed:false,helperMayStillRun:true,ownershipRetained:true}),typed:true},
 {name:'throws false',call:()=>{throw false;},cause:false},
 {name:'throws null',call:()=>{throw null;},cause:null},
 {name:'throws undefined',call:()=>{throw undefined;},cause:undefined},
 {name:'Promise-only closure',call:()=>Promise.reject(false),typed:true}
];
for(const primary of[false,true])for(const closure of closureCases)for(const memoryError of[false,null,undefined])test(`worker unknown survives ${closure.name}, memory ${String(memoryError)}, primary ${primary}`,async()=>{
 const f=make({memoryError,closure:closure.call,primary});let error;
 try{await f.pipeline.prepare();}catch(e){error=e;}finally{f.cleanup();}
 a.equal(error.code,'privacy.image_cleanup_failed');a.equal(error.cleanupFailed,true);a.equal(error.ownershipRetained,true);a.equal(error.helperMayStillRun,true);
 a.equal(error.errors.length,primary?3:2);a.equal(error.cause,error.errors[0]);if(primary)a.equal(error.errors[0],false);
 const closeCause=error.errors[primary?1:0];if(closure.typed)a.equal(closeCause.code,'privacy.image_processor_close_unknown');else a.equal(closeCause,closure.cause);
 a.equal(error.errors.at(-1),memoryError);a.equal(f.original.every(x=>x===42),true);if(!primary)a.equal(f.frame().rgba.every(x=>x===0),true);
});
test('known closed processor plus pure memory failure does not invent a live helper',async()=>{
 const f=make({memoryError:false,closure:()=>({closed:true,helperMayStillRun:false,ownershipRetained:false})});let error;try{await f.pipeline.prepare();}catch(e){error=e;}finally{f.cleanup();}
 a.equal(error.code,'privacy.image_cleanup_failed');a.equal(error.helperMayStillRun,false);a.equal(error.ownershipRetained,true);a.deepEqual([...error.errors],[false]);
});
test('real Buffer detachment plus unknown closure retains both causes and true helper uncertainty',async()=>{
 const f=make({detach:true,closure:()=>({closed:false,helperMayStillRun:true,ownershipRetained:true})});let error;try{await f.pipeline.prepare();}catch(e){error=e;}finally{f.cleanup();}
 a.equal(error.code,'privacy.image_cleanup_failed');a.equal(error.helperMayStillRun,true);a.equal(error.errors.length,3);a.equal(error.errors[0].code,'privacy.image_source_changed');a.equal(error.errors[1].code,'privacy.image_processor_close_unknown');a.equal(error.errors[2].name,'TypeError');a.equal(error.cause,error.errors[0]);
 a.equal(f.frame().rgba.every(x=>x===0),true);a.equal(f.original.every(x=>x===42),true);
});
