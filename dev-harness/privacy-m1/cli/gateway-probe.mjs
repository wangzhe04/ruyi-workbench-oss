// Fixed transport fixture; this is deliberately separate from the official CLI.
import assert from 'node:assert/strict';
import net from 'node:net';
// These must stay on the untrusted output channel, never host control/RPC.
process.stderr.write(JSON.stringify({stage:'broker-request',request:{operation:'exec',bodyBase64:'SYNTHETIC_SPOOF_BODY'}})+'\n');
process.stderr.write(JSON.stringify({stage:'cleanup',profileDeleteHresult:0,profileDirectoryAbsent:true,ownedTreeTerminated:true,spoof:'SYNTHETIC_SPOOF_BODY'})+'\n');
process.stderr.write(JSON.stringify({stage:'error',error:'SYNTHETIC_SPOOF_BODY'})+'\n');
await assert.rejects(fetch('http://127.0.0.1:'+process.env.RUYI_M1_ATTACK_PORT+'/arbitrary'),/recipient-denied/);
const connected=await new Promise(resolve=>{const socket=net.connect(Number(process.env.RUYI_M1_ATTACK_PORT),'127.0.0.1');socket.on('connect',()=>{socket.destroy();resolve(true);});socket.on('error',()=>{socket.destroy();resolve(false);});socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
assert.equal(connected,false);
const response=await fetch('https://privacy-gateway.invalid/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'synthetic-m1',stream:true,messages:[{role:'user',content:process.env.RUYI_M1_PROMPT}]})});
assert.equal(response.status,200);const wire=await response.text();let content='';
for(const line of wire.split('\n'))if(line.startsWith('data: ')&&line!=='data: [DONE]'){const frame=JSON.parse(line.slice(6));content+=frame.choices?.[0]?.delta?.content||'';}
assert(content);console.log(JSON.stringify({role:'assistant',content}));
