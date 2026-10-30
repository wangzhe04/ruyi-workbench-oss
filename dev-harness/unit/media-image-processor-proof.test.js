'use strict';
// Real JS owner with synthetic filesystem/pipe events. No component/native process
// is started. This validates proof minting and revocation, not OCR/QR correctness.
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const source=fs.readFileSync(process.env.MEDIA_IMAGE_PROCESSOR_SOURCE||path.resolve(__dirname,'../../ruyi-workbench/app/src/13bc-media-image-processor.js'),'utf8');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(){
  let child,spawns=0;
  const receipt={schema:1,verificationKind:'offline-artifact-inventory',dependencyFilesVerified:true,pythonVersion:'3.12.10',runtimeArtifacts:4987,verifiedRuntimeBytes:413946142,
    sourceArchiveVerified:true,verifiedSourceBytes:19922194,installsPerformed:false,mediaProcessingEnabled:false,mediaEgressEnabled:false};
  const stat={dev:1n,ino:2n,size:100n,mtimeNs:3n,ctimeNs:4n,nlink:1n,isFile:()=>true,isSymbolicLink:()=>false};
  const io={lstat:async()=>stat,realpath:async value=>value};
  const childProcess={spawn(){spawns++;child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>true;
    child.stdin.end=(wire,callback)=>{
      const length=wire.readUInt32BE(0),meta=JSON.parse(wire.subarray(4,4+length).toString('utf8'));
      const header={schema:1,width:2,height:2,rgbaBytes:16,sourceHash:meta.sourceHash,processorHash:meta.processorHash,frames:1,orientationApplied:true,ocrComplete:true,codesComplete:true,
        transform:{width:2,height:2,orientation:1},words:[],codes:[],recognitionConfidence:'unknown',language:meta.language,codeProfile:'opencv-qr-and-opencv-supported-linear-v3-source-support'};
      const text=Buffer.from(JSON.stringify(header)),size=Buffer.alloc(4);size.writeUInt32BE(text.length);
      queueMicrotask(()=>{child.emit('spawn');callback();child.stdout.emit('data',Buffer.concat([size,text,Buffer.alloc(16,255)]));child.emit('exit',0);child.emit('close',0);});
    };return child;
  }};
  const load=name=>name==='node:fs/promises'?io:name==='node:child_process'?childProcess:name==='../tools/verify-media-artifacts.cjs'?{verifyMediaArtifacts:async()=>receipt}:require(name);
  const api=vm.runInNewContext(source+';MediaImageProcessor;', {require:load,process:{platform:'win32',env:{}},Buffer,setTimeout,clearTimeout,setInterval,clearInterval});
  return {api,child:()=>child,spawns:()=>spawns,create:()=>api.create({runtimeRoot:path.resolve('C:/synthetic-runtime'),sourceRoot:path.resolve('C:/synthetic-source'),language:'en-US'})};
}
test('actual JS owner cannot attest caller-constructed empty reports or cloned frames',async()=>{
  const f=fixture(),owner=await f.create();assert.equal(f.spawns(),0);assert.equal(f.api.isOwner(owner),true);
  assert.throws(()=>owner.assertCoverage({words:[],codes:[],ocrComplete:true,codesComplete:true,rgba:Buffer.alloc(16)}),error=>error.code==='privacy.image_processor_coverage_unverified');
  const bytes=Buffer.from('public synthetic bytes'),job=owner.start({source:bytes,sourceHash:hash(bytes),processor:owner.capture(),deadline:Date.now()+1000});
  const frame=await job.promise;assert.equal(owner.assertCoverage(frame),true);assert.equal(job.finish().closed,true);assert.equal(f.spawns(),1);
  assert.throws(()=>owner.assertCoverage({...frame}),error=>error.code==='privacy.image_processor_coverage_unverified');
  frame.words.push({text:'changed',line:0,box:[0,0,1,1]});assert.throws(()=>owner.assertCoverage(frame),error=>error.code==='privacy.image_processor_coverage_unverified');frame.rgba.fill(0);
});
test('late stdio errors revoke proofs after known close without inventing a live helper',async()=>{
  const f=fixture(),owner=await f.create(),bytes=Buffer.from('public synthetic bytes');
  const job=owner.start({source:bytes,sourceHash:hash(bytes),processor:owner.capture(),deadline:Date.now()+1000}),frame=await job.promise;
  assert.equal(owner.assertCoverage(frame),true);f.child().stdout.emit('error',Error('synthetic late IO'));
  assert.throws(()=>owner.assertCoverage(frame),error=>error.code==='privacy.image_processor_coverage_unverified');assert.throws(()=>owner.capture());
  assert.equal(owner.helperMayStillRun(),false);assert.equal(job.finish().closed,true);frame.rgba.fill(0);
});
