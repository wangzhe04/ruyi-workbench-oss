'use strict';
// Test-only harness executes the actual transformed coarse lifecycle, replacing
// only asset IO, OS listener lookup and HTTP transport with deterministic fakes.
// No native process or model is started; production/research controller is not
// altered. Tests exercise the real controller guard/owner/erase state machine.
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),cp=require('node:child_process'),util=require('node:util'),{EventEmitter}=require('node:events');
const file=path.join(__dirname,'gcc-coarse-native-research.cjs');let wrapper=fs.readFileSync(file,'utf8');
const anchor='const compiled = new Module(__filename, module);';
if(wrapper.split(anchor).length!==2)throw Error('fake harness compile boundary changed');
wrapper=wrapper.replace(anchor,`source=source.replace("const verified = await verify(root, deadline, signal);", "const verified = {lock:{modelPath:'fake-model',runtimeEntry:'fake-exe',contract:CONTRACT,retrievalThresholds:{search:null,automatic:null}}};");\n`+anchor);
const start=wrapper.indexOf('const launchNative = createJobLauncher('),end=wrapper.indexOf('\nfunction create()',start);
if(start<0||end<start)throw Error('fake harness launcher boundary changed');
wrapper=wrapper.slice(0,start)+'const launchNative = args => globalThis.__gccFakeLauncher(args);'+wrapper.slice(end);
const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(__dirname);compiled._compile(wrapper,file);
const create=compiled.exports.create,originalFetch=global.fetch,originalExecFile=cp.execFile;
let state;
const execFile=()=>{throw Error('not used directly');};execFile[util.promisify.custom]=async()=>({stdout:`TCP 127.0.0.1:${state.port} 0.0.0.0:0 LISTENING 12347\n`,stderr:''});cp.execFile=execFile;
function deferred(){let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:value=>resolve(value)};}
function reset() {
  state={port:null,launches:0,requests:[],tokenGate:null,eraseValue:{id_slot:0,n_erased:0},eraseAbort:null,unknown:false};
  global.__gccFakeLauncher=async args=>{
    state.launches++;state.port=Number(args.args[args.args.indexOf('--port')+1]);
    const child=new EventEmitter();child.pid=12346;child.exitCode=null;child.signalCode=null;child.unref=()=>child;
    let finish;const exited=new Promise(resolve=>{finish=resolve;});
    const owner={child,nativePid:12347,getNativeIdentity:()=>({nativePid:12347,creationFileTime:'1'}),exited,
      terminate:async()=>{child.exitCode=0;child.emit('close',0,null);finish({cleanupStatus:state.unknown?'unknown':'observed'});}};
    args.onOwned(owner);return owner;
  };
  global.fetch=async (url,options={})=>{
    const endpoint=new URL(url).pathname,search=new URL(url).search;state.requests.push(endpoint+search);
    if(endpoint==='/health')return {ok:true};
    if(endpoint==='/slots')return {ok:true,json:async()=>[{n_ctx:1024}]};
    if(endpoint==='/tokenize'){if(state.tokenGate)await state.tokenGate.promise;return {ok:true,json:async()=>({tokens:[1,151643]})};}
    if(endpoint==='/slots/0'&&search==='?action=erase'){state.eraseAbort?.();return {ok:true,json:async()=>state.eraseValue};}
    if(endpoint==='/v1/embeddings')return {ok:true,json:async()=>({data:[{embedding:[1,...Array(1023).fill(0)]}],usage:{prompt_tokens:2}})};
    throw Error('unexpected endpoint '+endpoint);
  };
}
after(()=>{global.fetch=originalFetch;cp.execFile=originalExecFile;delete global.__gccFakeLauncher;});
test('pre-prepare falsy abort never launches',async()=>{reset();const client=create(),signal=new AbortController();signal.abort(0);let e=Symbol();
  try{await client.prepare({signal:signal.signal,deadline:Date.now()+3000});}catch(error){e=error;}assert.equal(e,0);assert.equal(state.launches,0);assert.equal((await client.stop()).workerExited,true);});
test('revocation during tokenize blocks erase and model input, preserving source error',async()=>{reset();const client=create(),ready=await client.prepare({deadline:Date.now()+5000,budgetMs:5000});assert.equal(ready.ok,true);
  state.requests=[];state.tokenGate=deferred();let revoked=false,guards=0;const denied=Error('authority revoked');
  const pending=client.encode(['SYNTHETIC'],{role:'query',deadline:Date.now()+1000,beforeEncode:async()=>{guards++;if(revoked)throw denied;}});
  while(!state.requests.includes('/tokenize'))await new Promise(r=>setImmediate(r));
  revoked=true;state.tokenGate.resolve();await assert.rejects(pending,error=>error===denied);
  assert.ok(guards>=2);assert.deepEqual(state.requests,['/tokenize']);assert.equal((await client.stop()).workerExited,true);
});
test('malformed erase stays primary when abort also arrives and never writes embedding',async()=>{reset();const client=create();assert.equal((await client.prepare({deadline:Date.now()+5000,budgetMs:5000})).ok,true);
  state.requests=[];state.eraseValue={id_slot:0,n_erased:-1};const controller=new AbortController();state.eraseAbort=()=>controller.abort(0);
  await assert.rejects(client.encode(['SYNTHETIC'],{role:'document',signal:controller.signal,deadline:Date.now()+1000,beforeEncode:async()=>{}}),error=>error.code==='INVALID_SLOT_ERASE');
  assert.ok(!state.requests.includes('/v1/embeddings'));assert.equal((await client.stop()).workerExited,true);
});
test('revocation after a valid erase is checked before embedding input is written',async()=>{reset();const client=create();
  assert.equal((await client.prepare({deadline:Date.now()+5000,budgetMs:5000})).ok,true);state.requests=[];
  let revoked=false;const denied=Error('source revoked after erase');state.eraseAbort=()=>{revoked=true;};
  await assert.rejects(client.encode(['SYNTHETIC'],{role:'document',deadline:Date.now()+1000,beforeEncode:async()=>{if(revoked)throw denied;}}),error=>error===denied);
  assert.ok(state.requests.includes('/slots/0?action=erase'));assert.ok(!state.requests.includes('/v1/embeddings'));
  assert.equal((await client.stop()).workerExited,true);
});
test('unknown cleanup retains same-root owner and blocks another client',async()=>{reset();const client=create();assert.equal((await client.prepare({deadline:Date.now()+5000,budgetMs:5000})).ok,true);
  state.unknown=true;const stopped=await client.stop();assert.equal(stopped.workerExited,false);assert.equal(stopped.cleanupStatus,'unknown');
  const other=create(),next=await other.prepare({deadline:Date.now()+5000,budgetMs:5000});assert.equal(next.available,false);assert.equal(state.launches,1);
});
