'use strict';
// Simulated child/timers; verifies lifetime protocol, never actual DPAPI.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(process.env.RUYI_LOCAL_CRYPTO_SOURCE||path.join(__dirname,'../../ruyi-workbench/app/src/01j-local-crypto.js'),'utf8');
function fixture({spawnThrows=false,killThrows=false}={}){
 const children=[],timers=new Map();let sequence=0;
 const api=vm.runInNewContext(source+'\nLocalSecretCrypto;',{Buffer,TextDecoder,process:{platform:'win32',env:{SystemRoot:'C:\\Windows'}},
  setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
  require:name=>name==='node:path'?path:{spawn(){
   if(spawnThrows)throw Error('synthetic private launch failure');
   const child=new EventEmitter();child.pid=100+children.length;child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=input=>{child.input=input;};child.kills=0;child.kill=()=>{child.kills++;if(killThrows)throw Error('synthetic kill refusal');return true;};children.push(child);return child;
  }},
 });
 const fire=ms=>{const row=[...timers].find(([,value])=>value.ms===ms);assert.ok(row,'requested timer exists');timers.delete(row[0]);row[1].fn();};
 const run=()=>api.run('protect',Buffer.from('synthetic private bytes'),Buffer.from('fixed-entropy'));
 return{api,children,timers,fire,run};
}
test('timeout requests own-child stop but rejects only after observed close',async()=>{
 const f=fixture(),pending=f.run(),child=f.children[0];let settled=false;pending.catch(()=>{settled=true;});f.fire(15000);await Promise.resolve();assert.equal(settled,false);assert.equal(child.kills,1);assert.equal(f.api.helperMayStillRun(),false);
 child.emit('close',1);await assert.rejects(pending,e=>e.code==='local_crypto.process_timeout'&&e.helperMayStillRun===undefined);assert.equal(f.api.helperMayStillRun(),false);assert.equal(f.timers.size,0);
});
test('unobserved close produces bounded permanent uncertainty, including after late close',async()=>{
 const f=fixture(),pending=f.run(),child=f.children[0];f.fire(15000);f.fire(2000);await assert.rejects(pending,e=>e.code==='local_crypto.process_timeout'&&e.helperMayStillRun===true);assert.equal(f.api.helperMayStillRun(),true);child.emit('close',1);assert.equal(f.api.helperMayStillRun(),true);assert.equal(f.timers.size,0);
});
for(const mode of ['capacity','stdin','stdout','error','kill-throws'])test(mode+' failure cannot settle before close or uncertainty receipt',async()=>{
 const f=fixture({killThrows:mode==='kill-throws'}),pending=f.run(),child=f.children[0];let settled=false;pending.catch(()=>{settled=true;});
 if(mode==='capacity'){const chunk=Buffer.alloc(131073,1);child.stdout.emit('data',chunk);assert.ok(chunk.every(byte=>byte===0));}
 else if(mode==='stdin')child.stdin.emit('error',Error('private input detail'));
 else if(mode==='stdout')child.stdout.emit('error',Error('private output detail'));
 else if(mode==='error')child.emit('error',Error('private child detail'));
 else f.fire(15000);
 await Promise.resolve();assert.equal(settled,false);assert.equal(child.kills,1);f.fire(2000);await assert.rejects(pending,e=>e.helperMayStillRun===true&&e.message===e.code&&!e.message.includes('private'));assert.equal(f.api.helperMayStillRun(),true);
});
test('spawn throw without an issued child has no uncertain helper',async()=>{
 const f=fixture({spawnThrows:true});await assert.rejects(f.run(),e=>e.code==='local_crypto.process_failed'&&e.helperMayStillRun===undefined);assert.equal(f.api.helperMayStillRun(),false);assert.equal(f.timers.size,0);
});
test('success requires close, clears private output and all timers',async()=>{
 const f=fixture(),pending=f.run(),child=f.children[0],bytes=Buffer.from(JSON.stringify({ok:true,value:Buffer.from('wrapped').toString('base64')}));let settled=false;pending.then(()=>{settled=true;});child.stdout.emit('data',bytes);await Promise.resolve();assert.equal(settled,false);child.emit('close',0);assert.equal((await pending).toString(),'wrapped');assert.ok(bytes.every(byte=>byte===0));assert.equal(f.api.helperMayStillRun(),false);assert.equal(f.timers.size,0);
});
test('late output after stop is cleared and cannot become a successful result',async()=>{
 const f=fixture(),pending=f.run(),child=f.children[0];f.fire(15000);const late=Buffer.from('{"ok":true,"value":"YWJj"}');child.stdout.emit('data',late);assert.ok(late.every(byte=>byte===0));child.emit('close',0);await assert.rejects(pending,{code:'local_crypto.process_timeout'});assert.equal(f.api.helperMayStillRun(),false);
});
test('another successful call cannot clear a prior unknown helper',async()=>{
 const f=fixture(),first=f.run();f.fire(15000);f.fire(2000);await assert.rejects(first);const second=f.run(),child=f.children[1];child.stdout.emit('data',Buffer.from('{"ok":true,"value":"YWJj"}'));child.emit('close',0);assert.equal((await second).toString(),'abc');assert.equal(f.api.helperMayStillRun(),true);
});
