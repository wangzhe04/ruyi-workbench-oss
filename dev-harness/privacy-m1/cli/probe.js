'use strict';
// Synthetic adversarial child. Runs inside AppContainer, including its child.
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const cp = require('node:child_process');
const readline = require('node:readline');
const http = require('node:http');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const descendant = process.argv[3] === 'descendant';
const emit = value => process.stdout.write(JSON.stringify({ ...value, descendant }) + '\n');
function fileCheck(name, operation) {
  try { const value = operation(); emit({ kind: 'file', name, allowed: true, value }); }
  catch (e) { emit({ kind: 'file', name, allowed: false, code: e.code }); }
}
async function tcp(name, host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port }); let done = false;
    const finish = (allowed, code) => { if (done) return; done = true; socket.destroy(); emit({ kind: 'network', name, allowed, code }); resolve(); };
    socket.on('connect', () => { socket.write('SYNTHETIC_M1'); finish(true, 'CONNECTED'); });
    socket.on('error', e => finish(false, e.code)); socket.setTimeout(1500, () => finish(null, 'TIMEOUT'));
  });
}
async function udp(name, host, port, family, dns = false) {
  return new Promise(resolve => {
    const socket = dgram.createSocket(family); let done = false;
    const finish = (allowed, code) => { if(done) return; done = true; clearTimeout(timer); try { socket.close(); } catch {} emit({ kind: 'network', name, allowed, code }); resolve(); };
    const timer = setTimeout(() => finish(null, 'NO_REPLY'), 1500);
    socket.on('error', e => finish(false, e.code)); socket.on('message', () => finish(true, 'RECEIVED_REPLY'));
    // Raw DNS query for synthetic.invalid goes only to the owned UDP receiver.
    const payload = dns ? Buffer.from('0001010000010000000000000973796e74686574696307696e76616c69640000010001', 'hex') : Buffer.from('SYNTHETIC_M1');
    socket.send(payload, port, host, error => { if(error) finish(false, error.code); });
  });
}
async function main() {
  fileCheck('project-read', () => fs.readFileSync(cfg.allowed, 'utf8'));
  fileCheck('outside-secret-read', () => fs.readFileSync(cfg.denied, 'utf8'));
  fileCheck('outside-all-app-packages-read', () => fs.readFileSync(cfg.allAppPackages, 'utf8'));
  fileCheck('project-write-denied', () => { fs.writeFileSync(cfg.allowed, 'MUTATED'); return true; });
  fileCheck('owned-write', () => { fs.writeFileSync(cfg.write + (descendant ? '/child.txt' : '/parent.txt'), 'SYNTHETIC_OUTPUT'); return true; });
  fileCheck('outside-write', () => { fs.writeFileSync(cfg.deniedWrite, 'MUTATED'); return true; });
  if (cfg.sameProcessHttp) {
    let accepted=0,stage='listen';
    const server=http.createServer((req,res)=>{accepted++;res.end('SYNTHETIC_SELF_HTTP');});
    try {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      stage='request';
      const response=await fetch('http://127.0.0.1:'+server.address().port+'/fixed',{signal:AbortSignal.timeout(2000),redirect:'error'});
      emit({kind:'same-process-http',allowed:response.status===200&&(await response.text())==='SYNTHETIC_SELF_HTTP',accepted});
    } catch(error) {emit({kind:'same-process-http',allowed:false,accepted,stage,code:error.cause?.code||error.code||error.name,syscall:error.cause?.syscall||error.syscall});}
    finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  await tcp('loopback-tcp4', '127.0.0.1', cfg.tcp4);
  await tcp('loopback-tcp6', '::1', cfg.tcp6);
  await tcp('private-gateway', '127.0.0.1', cfg.gateway);
  await udp('loopback-udp4', '127.0.0.1', cfg.udp4, 'udp4');
  await udp('loopback-udp6', '::1', cfg.udp6, 'udp6');
  await udp('dns-owned-receiver', '127.0.0.1', cfg.dns, 'udp4', true);
  if (!descendant) {
    const tokenChild = cp.spawnSync(cfg.tokenProbe, ['--token-self'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env,timeout:5000 });
    emit({kind:'descendant-token-probe-exit',code:tokenChild.status,error:tokenChild.error&&tokenChild.error.code});
    const lines = readline.createInterface({ input: process.stdin });
    const answer = new Promise(resolve => lines.once('line', line => { resolve(line); lines.close(); }));
    emit({ kind: 'rpc', operation: 'read-project-model' });
    const value = await answer;
    emit({ kind: 'broker', receivedModelView: value === 'MODEL_VIEW:[PRIVATE_M1]', containsOriginal: value.includes('SYNTHETIC_SECRET_') });
    process.stdin.pause(); process.stdin.destroy();
    const child = cp.spawn(process.execPath, ['--preserve-symlinks-main', __filename, process.argv[2], 'descendant'], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    emit({ kind: 'child', code });
  }
}
main().catch(e => { emit({ kind: 'fatal', code: e.code, message: e.message }); process.exitCode = 1; });
