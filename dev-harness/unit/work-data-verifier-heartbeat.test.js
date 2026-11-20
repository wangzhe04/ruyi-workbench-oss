'use strict';
// 151 阶段 3D(150 号文 W12):独立校验子进程的超时与 uncertain 解耦。真实 13aq 适配器(production-host 纯夹具)
// + 假子进程/假计时器:verify-progress 心跳只续期停滞计时,从不结算;没有心跳 120 s 才 verifier_timeout;
// 总时长另有上限;结果之后迟到的心跳被忽略,不会被当成第二个结果。
// v2(审查 L1):心跳带真实进展计数 progress。子进程只在进程内进展计数前进时才发;父进程只认严格递增的计数。
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{EventEmitter}=require('node:events');
const {createFixture,tick}=require('../lib/work-data-production-host-fixture');

function harness(){
 const f=createFixture(),timers=new Map();let sequence=0;
 const clock={setTimeout(fn,ms){const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval(){}};
 const child=new EventEmitter();let request=null;
 Object.assign(child,{pid:4242,kills:0,kill(){child.kills++;queueMicrotask(()=>{child.emit('exit',1,null);child.emit('close',1,null);});return true;}});
 child.stdin=new EventEmitter();child.stdin.end=(bytes,callback)=>{request=JSON.parse(Buffer.from(bytes).toString('utf8'));callback?.();};
 const native=f.api.native.create({bindings:{...f.nativeBindings,worker:{create:()=>({environment:()=>({})}),spawnCold:()=>child,processChannel(){throw Error('not used');}}},
  proc:{pid:1,env:{}},clock,verifierCommand:{command:process.execPath,args:['server.js','work-data-verify']}});
 const target=path.join(f.root,'rehearsal-target');
 const stall=()=>[...timers.values()].filter(value=>value.ms===120000);
 const fire=ms=>{const entry=[...timers].find(([,value])=>value.ms===ms);assert.ok(entry,'timer '+ms);timers.delete(entry[0]);entry[1].fn();};
 const beat=progress=>child.emit('message',{schema:1,kind:'verify-progress',id:request.id,nonce:request.nonce,pid:child.pid,progress});
 const reply=()=>child.emit('message',{schema:1,kind:'verified-full',id:request.id,nonce:request.nonce,pid:child.pid,target,generation:1,sourceSha256:'c'.repeat(64),files:3,directories:2});
 const exit=()=>{child.emit('exit',0,null);child.emit('close',0,null);};
 return {native,child,target,timers,stall,fire,beat,reply,exit,request:()=>request};
}
const observe=promise=>{const state={done:false,value:null,error:null};state.promise=promise.then(value=>{state.done=true;state.value=value;},error=>{state.done=true;state.error=error;});return state;};

test('verify-progress heartbeats with increasing progress renew the stall deadline and the verified result still settles normally',async()=>{
 const h=harness(),pending=observe(h.native.verifyFreshReceipt({target:h.target,password:'synthetic heartbeat password',generation:1}));await tick();
 h.child.emit('spawn');assert.ok(h.request(),'the request reached the verifier');assert.equal(h.stall().length,1);
 assert.ok([...h.timers.values()].some(value=>value.ms===4*3600*1000),'a total ceiling still bounds a live verifier');
 const first=h.stall()[0];for(let n=1;n<=3;n++){h.beat(n*10);await tick();assert.equal(pending.done,false);}
 assert.equal(h.stall().length,1);assert.notEqual(h.stall()[0],first,'the stall deadline was replaced, not stacked');
 h.reply();h.beat(99);h.exit();await pending.promise;
 assert.equal(pending.error,null,String(pending.error?.code));assert.equal(pending.value.files,3);assert.equal(h.timers.size,0);
});

test('a silent verifier times out on the stall bound; a non-advancing or foreign heartbeat is not progress',async()=>{
 const h=harness(),pending=observe(h.native.verifyFreshReceipt({target:h.target,password:'synthetic heartbeat password',generation:1}));await tick();h.child.emit('spawn');
 h.beat(5);await tick();const renewed=h.stall()[0];h.beat(5);h.beat(3);await tick();
 assert.equal(h.stall()[0],renewed,'a repeated or lower progress count does not renew');
 h.fire(120000);await pending.promise;assert.equal(pending.error.code,'work_data_adapter.verifier_timeout');assert.equal(h.child.kills,1);
 const g=harness(),other=observe(g.native.verifyFreshReceipt({target:g.target,password:'synthetic heartbeat password',generation:1}));await tick();g.child.emit('spawn');
 g.child.emit('message',{schema:1,kind:'verify-progress',id:g.request().id,nonce:'0'.repeat(64),pid:g.child.pid,progress:1});await other.promise;
 assert.equal(other.error.code,'work_data_adapter.result_invalid','a heartbeat for another request is refused like any foreign message');
});

test('the verifier child sends a heartbeat only when its in-process progress count has advanced',async()=>{
 const f=createFixture();let progress=7,releaseSeal,tickFn=null;const sent=[];
 const clock={setTimeout:()=>({ref(){},unref(){}}),clearTimeout(){},setInterval:(fn,ms)=>{assert.equal(ms,5000);tickFn=fn;return {unref(){}};},clearInterval(){tickFn=null;}};
 const fullSnapshot={create:()=>({seal:()=>new Promise(resolve=>{releaseSeal=()=>resolve({verifiedGeneration:1,sourceProof:{sha256:'d'.repeat(64)},files:1,directories:1});})})};
 const tree={...f.nativeBindings.tree,progressCount:()=>progress};
 const adapter=f.api.native.create({bindings:{...f.nativeBindings,fullSnapshot,tree},proc:f.proc,clock});
 const bytes=Buffer.from(JSON.stringify({schema:1,kind:'verify-full',id:'a'.repeat(48),nonce:'c'.repeat(64),parentPid:888,target:f.paths.base,generation:1,password:'synthetic verifier password'}));
 const running=adapter.runVerifier({parentConnected:()=>true,parentPid:()=>888,readInput:async()=>bytes,send:async message=>{sent.push(message);}});
 for(let n=0;n<100&&!releaseSeal;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof releaseSeal,'function','seal is in flight');assert.equal(typeof tickFn,'function');
 tickFn();await tick();assert.equal(sent.length,0,'no progress since the request: no heartbeat (a stuck child stays silent)');
 progress=12;tickFn();await tick();tickFn();await tick();
 assert.deepEqual(sent.map(message=>message.progress),[12],'one heartbeat for one advance');assert.equal(sent[0].kind,'verify-progress');
 releaseSeal();const reply=await running;assert.equal(reply.kind,'verified-full');assert.equal(sent.at(-1).kind,'verified-full');assert.equal(tickFn,null,'the heartbeat stops before the result');
});
