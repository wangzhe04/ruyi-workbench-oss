'use strict';
// node run.js [--evidence <path>]. No installed CLI/config is executed outside containment.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { once } = require('node:events');
const { killOwnTree } = require('../../lib/kill-own-tree');
const { startFakeProvider } = require('../../lib/fake-openai-provider');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let launchesStarted=0;
function redactEvidence(value,root,userHome) {
  const replacements=[root,userHome].filter(Boolean).flatMap((raw,index)=>{const label=index===0?'<temporary-root>':'<user-home>';return [...new Set([raw,raw.replaceAll('\\','/'),JSON.stringify(raw).slice(1,-1)])].map(needle=>[needle,label]);}).sort((a,b)=>b[0].length-a[0].length);
  const scrub=text=>replacements.reduce((current,[needle,label])=>current.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),label),text);
  const walk=input=>typeof input==='string'?scrub(input):Array.isArray(input)?input.map(walk):input&&typeof input==='object'?Object.fromEntries(Object.entries(input).map(([key,item])=>[scrub(key),walk(item)])):input;
  const cleaned=walk(value);
  const verify=input=>{if(typeof input==='string'&&scrub(input)!==input)throw new Error('private path remained in evidence');if(input&&typeof input==='object')for(const [key,item]of Object.entries(input)){verify(key);verify(item);}};
  verify(cleaned);return cleaned;
}
function brokerReply(request) {
  return request && request.kind === 'rpc' && request.operation === 'read-project-model'
    ? 'MODEL_VIEW:[PRIVATE_M1]\n' : 'DENIED\n';
}
function summarizeProbe(probe) {
  const requiredFiles = {'project-read':true,'outside-secret-read':false,'project-write-denied':false,'owned-write':true,'outside-write':false};
  const receivers = probe.receivers || [];
  const completeFiles = [false,true].every(descendant => Object.entries(requiredFiles).every(([name,allowed]) => probe.output.some(e=>e.kind==='file'&&e.name===name&&e.descendant===descendant&&e.allowed===allowed)));
  const completeNetwork = receivers.length===6 && receivers.every(r=>r.positiveControlConnections===1&&r.unauthorizedConnections===0&&[false,true].every(descendant=>probe.output.some(e=>e.kind==='network'&&e.name===r.id&&e.descendant===descendant&&e.allowed!==true)));
  const aapReadable=probe.output.some(e=>e.kind==='file'&&e.name==='outside-all-app-packages-read'&&e.allowed===true);
  return { processCompleted:probe.code===0, fileBoundaryObserved:completeFiles, allApplicationPackagesOutsideFileReadable:aapReadable, projectionIsExclusiveFilesystemAllowlist:aapReadable?false:null, networkDeliveryBlockedAtTestedReceivers:completeNetwork, networkDenialMechanism:'not established: TCP timeout and UDP no-reply are retained', descendantAppContainerTokenVerified:probe.output.some(e=>e.kind==='descendant-token'&&e.isAppContainer===true), fixtureBrokerRoundTrip:probe.output.some(e=>e.kind==='broker'&&e.receivedModelView===true&&e.containsOriginal===false), realCliBrokerIntegrated:false };
}
function safeRemove(root) {
  const resolved = path.resolve(root), base = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(base) || !path.basename(resolved).startsWith('ruyi-m1-cli-')) throw new Error('cleanup target outside owned temporary root');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
function childEnvironment(write, projection) {
  const env = {};
  // Explicit allowlist: never inherit proxy variables, tokens, CLI settings, user paths.
  for (const key of ['SystemRoot', 'WINDIR', 'ComSpec']) if (process.env[key]) env[key] = process.env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TEMP', 'TMP']) env[key] = write;
  env.PATH = projection + path.delimiter + path.join(process.env.SystemRoot, 'System32');
  env.PATHEXT = '.EXE;.CMD';
  env.CLAUDE_CONFIG_DIR = path.join(write, 'claude');
  env.KIMI_SHARE_DIR = path.join(write, 'kimi');
  env.KIMI_CODE_HOME = path.join(write, 'kimi-code');
  env.KIMI_DISABLE_TELEMETRY = '1';
  env.DISABLE_AUTOUPDATER = '1';
  env.DISABLE_TELEMETRY = '1';
  env.DO_NOT_TRACK = '1';
  return env;
}
async function receiver(kind, address, counters, label) {
  if (kind === 'tcp') {
    const server = net.createServer(socket => { counters[label] = (counters[label] || 0) + 1; socket.on('error', () => {}); socket.on('data', () => {}); socket.end('ACK'); });
    server.listen(0, address); await once(server, 'listening');
    return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)), label };
  }
  const server = dgram.createSocket(address.includes(':') ? 'udp6' : 'udp4');
  server.on('message', (data, peer) => { counters[label] = (counters[label] || 0) + 1; server.send('ACK', peer.port, peer.address); });
  server.bind(0, address); await once(server, 'listening');
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)), label };
}
async function launch(helper, root, projection, write, exe, args, timeoutMs = 20000, environmentOverrides = {}) {
  launchesStarted++;
  const file = path.join(root, 'launch-' + crypto.randomUUID() + '.json');
  const profile='ruyi.m1.'+crypto.randomUUID().replaceAll('-','');
  fs.writeFileSync(file, JSON.stringify({ profile, projection, write, aapDirectory:path.join(root,'aap-control'), exe, args, cwd: write, env: {...childEnvironment(write, projection),...environmentOverrides}, timeoutMs }));
  const child = cp.spawn(helper, [file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [], events = []; let text = '', error = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { if(text.length < 262144) text += chunk; });
  child.stderr.on('data', chunk => { if(error.length < 262144) error += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const value = JSON.parse(line); if(output.length<128) output.push(value); if(value.kind === 'rpc') child.stdin.write(brokerReply(value)); } catch {}
  });
  child.stdin.on('error', () => {});
  let watchdogFired=false;
  const watchdog=setTimeout(()=>{ watchdogFired=true; killOwnTree(child); },timeoutMs+10000);
  let code;
  try { [code] = await once(child, 'close'); }
  finally { clearTimeout(watchdog); lines.close(); if(child.exitCode===null && child.signalCode===null) killOwnTree(child); }
  for (const line of error.split(/\r?\n/)) { try { events.push(JSON.parse(line)); } catch {} }
  if(!events.some(e=>e.stage==='cleanup'&&e.profileDeleteHresult===0&&e.profileDirectoryAbsent===true)) {
    try { const recovered=cp.spawnSync(helper,['--cleanup-profile',profile],{windowsHide:true,encoding:'utf8',timeout:10000}); for(const line of String(recovered.stderr||'').split(/\r?\n/)){try{events.push(JSON.parse(line));}catch{}} }
    catch {events.push({stage:'recovery-cleanup',failed:true});}
  }
  // Only bounded/redacted diagnostics are persisted. No CLI transcript from a real account exists.
  const redact = value => value.split(root).join('<temporary-root>').replaceAll(process.env.USERPROFILE || '<none>', '<user-home>');
  return { code, watchdogFired, output, events, stdout: redact(text).slice(0, 6000), stderr: redact(error).slice(0, 6000) };
}
async function main() {
  if(process.platform !== 'win32') throw new Error('Windows-only executable prototype');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-m1-cli-'));
  const projection = path.join(root, 'projection'), write = path.join(projection, 'write');
  fs.mkdirSync(write, { recursive: true });
  const result = { schemaVersion: 1, experiment: 'privacy-m1-cli', productWired: false, completedM1: false, generatedAt: new Date().toISOString(), platform: { os: 'Windows', release: os.release(), node: process.version }, assumptions: ['AppContainer with zero network capabilities is the OS boundary', 'Job Object is lifecycle management only', 'No firewall edits or loopback exemptions'], osProbe: null, realCli: [], untested: ['public Internet TCP', 'private LAN TCP', 'system DNS resolver', 'proxy override', 'redirects', 'project MCP/plugin injection', 'real CLI model/tool/edit/compact/restart loop', 'crash-recovery cleanup'], cleanup: {} };
  result.priorAttempts=JSON.parse(fs.readFileSync(path.join(__dirname,'prior-attempts.json'),'utf8'));
  result.sourceSha256=Object.fromEntries(['AppContainerHost.cs','probe.js','run.js','runner.test.js','prior-attempts.json'].map(name=>[name,hash(path.join(__dirname,name))]));
  const receivers = [], counters = {}, providers=[];
  try {
    const helper = path.join(root, 'AppContainerHost.exe');
    const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    cp.execFileSync(compiler, ['/nologo', '/target:exe', '/r:System.Web.Extensions.dll', '/out:' + helper, path.join(__dirname, 'AppContainerHost.cs')], { windowsHide: true, stdio: 'pipe' });
    fs.copyFileSync(helper,path.join(projection,'TokenProbe.exe'));
    const node = path.join(projection, 'node.exe'); fs.copyFileSync(process.execPath, node);
    fs.copyFileSync(path.join(__dirname, 'probe.js'), path.join(projection, 'probe.js'));
    fs.writeFileSync(path.join(projection, 'project.txt'), 'SYNTHETIC_PROJECT_[PRIVATE_M1]');
    fs.writeFileSync(path.join(root, 'outside-secret.txt'), 'SYNTHETIC_SECRET_M1_ONLY');
    fs.mkdirSync(path.join(root,'aap-control'));fs.writeFileSync(path.join(root,'aap-control','outside-readable.txt'),'SYNTHETIC_AAP_OUTSIDE_PROJECTION');
    for (const [kind, address, label] of [['tcp','127.0.0.1','loopback-tcp4'],['tcp','::1','loopback-tcp6'],['tcp','127.0.0.1','private-gateway'],['udp','127.0.0.1','loopback-udp4'],['udp','::1','loopback-udp6'],['udp','127.0.0.1','dns-owned-receiver']]) receivers.push(await receiver(kind,address,counters,label));
    const before = { ...counters };
    // Reachability positive controls run in the uncontained host, against owned listeners only.
    for (let i=0;i<receivers.length;i++) {
      const r=receivers[i], address = i===1||i===4 ? '::1' : '127.0.0.1';
      if(i<3) await new Promise((resolve,reject) => { const s=net.connect(r.port,address); s.on('error',reject); s.on('data',()=>s.end()); s.on('close',resolve); });
      else await new Promise((resolve,reject) => { const s=dgram.createSocket(i===4?'udp6':'udp4'); s.on('error',reject); s.on('message',()=>s.close(resolve)); s.send('CONTROL',r.port,address); });
    }
    const controlled = { ...counters };
    const config = path.join(projection,'probe.json');
    fs.writeFileSync(config,JSON.stringify({ tokenProbe:path.join(projection,'TokenProbe.exe'),allowed:path.join(projection,'project.txt'), denied:path.join(root,'outside-secret.txt'), allAppPackages:path.join(root,'aap-control','outside-readable.txt'),deniedWrite:path.join(root,'outside-write.txt'), write, tcp4:receivers[0].port,tcp6:receivers[1].port,gateway:receivers[2].port,udp4:receivers[3].port,udp6:receivers[4].port,dns:receivers[5].port }));
    result.osProbe = await launch(helper,root,projection,write,node,['--preserve-symlinks-main',path.join(projection,'probe.js'),config]);
    result.osProbe.receivers = receivers.map(r=>({id:r.label,positiveControlConnections:(controlled[r.label]||0)-(before[r.label]||0),unauthorizedConnections:(counters[r.label]||0)-(controlled[r.label]||0)}));
    result.osProbe.hostChecks = { originalProjectUnchanged:fs.readFileSync(path.join(projection,'project.txt'),'utf8') === 'SYNTHETIC_PROJECT_[PRIVATE_M1]', outsideWriteAbsent:!fs.existsSync(path.join(root,'outside-write.txt')), parentOutputExists:fs.existsSync(path.join(write,'parent.txt')), childOutputExists:fs.existsSync(path.join(write,'child.txt')) };
    result.osProbe.summary=summarizeProbe(result.osProbe);
    const lifetimeHome=path.join(write,'lifetime');fs.mkdirSync(lifetimeHome);
    const hang="require('node:child_process').spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore',env:process.env});console.log(JSON.stringify({kind:'lifetime',descendantSpawned:true}));setInterval(()=>{},1000)";
    result.timeoutProbe=await launch(helper,root,projection,lifetimeHome,node,['--eval',hang],1000);
    const npm = path.join(process.env.APPDATA,'npm','node_modules');
    for (const spec of [{ id:'claude',package:'@anthropic-ai/claude-code', entry:'bin/claude.exe' },{ id:'kimi',package:'@moonshot-ai/kimi-code',entry:'dist/main.mjs' }]) {
      const installed = path.join(npm,spec.package), metadata = path.join(installed,'package.json'), entry = path.join(installed,spec.entry);
      if(!fs.existsSync(metadata)||!fs.existsSync(entry)) { result.realCli.push({id:spec.id,status:'missing'}); continue; }
      const pkg=JSON.parse(fs.readFileSync(metadata,'utf8')), copy=path.join(projection,spec.id);
      fs.mkdirSync(copy);
      // Copy only installed program assets, never configuration, credentials, or user state.
      if(spec.id==='claude') { fs.mkdirSync(path.join(copy,'bin')); fs.copyFileSync(entry,path.join(copy,spec.entry)); }
      else { fs.cpSync(path.join(installed,'dist'),path.join(copy,'dist'),{recursive:true}); fs.copyFileSync(metadata,path.join(copy,'package.json')); if(fs.existsSync(path.join(installed,'node_modules'))) fs.cpSync(path.join(installed,'node_modules'),path.join(copy,'node_modules'),{recursive:true,dereference:true}); }
      const copiedEntry=path.join(copy,spec.entry), target=spec.id==='claude'?copiedEntry:node, prefix=spec.id==='claude'?[]:['--preserve-symlinks-main','--preserve-symlinks',copiedEntry];
      const versionHome=path.join(write,spec.id+'-version'),helpHome=path.join(write,spec.id+'-help'); fs.mkdirSync(versionHome);fs.mkdirSync(helpHome);
      const cli={ id:spec.id, packageVersion:pkg.version, entrySha256:hash(entry), version:await launch(helper,root,projection,versionHome,target,[...prefix,'--version'],30000), help:await launch(helper,root,projection,helpHome,target,[...prefix,'--help'],30000), completeLoop:false };
      const gateway=await startFakeProvider({handler:()=> 'SYNTHETIC_GATEWAY_RESPONSE',fallback:(req,res)=>{res.writeHead(501);res.end('SYNTHETIC_PROTOCOL_NOT_IMPLEMENTED');}}); providers.push(gateway);
      let gatewayConnections=0; gateway.server.on('connection',()=>gatewayConnections++);
      const control=await fetch(gateway.url+'/v1/models'); await control.text(); const connectionsBefore=gatewayConnections;
      const modelHome=path.join(write,spec.id+'-model');fs.mkdirSync(modelHome);
      const modelEnv=spec.id==='claude' ? {ANTHROPIC_API_KEY:'SYNTHETIC_NONCREDENTIAL',ANTHROPIC_BASE_URL:gateway.url,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'} : {KIMI_MODEL_NAME:'synthetic-m1',KIMI_MODEL_API_KEY:'SYNTHETIC_NONCREDENTIAL',KIMI_MODEL_BASE_URL:gateway.url+'/v1',KIMI_MODEL_PROVIDER_TYPE:'openai'};
      const modelArgs=spec.id==='claude'?['--print','--model','synthetic-m1','SYNTHETIC_M1_GATEWAY_PROBE']:['--prompt','SYNTHETIC_M1_GATEWAY_PROBE','--output-format','stream-json'];
      cli.syntheticGatewayAttempt=await launch(helper,root,projection,modelHome,target,[...prefix,...modelArgs],15000,modelEnv);
      cli.syntheticGatewayAttempt.receiver={positiveControlHttpStatus:control.status,unauthorizedTcpConnections:gatewayConnections-connectionsBefore,modelRequests:gateway.requests.length};
      cli.syntheticGatewayAttempt.scope='actual installed CLI, synthetic key and endpoint; no real provider call';
      result.realCli.push(cli);
    }
  } finally {
    for(const r of receivers) await r.close();
    for(const provider of providers) await provider.close();
    safeRemove(root); result.cleanup.temporaryDirectoryAbsent=!fs.existsSync(root);
    result.cleanup.profiles = [result.osProbe,result.timeoutProbe,...result.realCli.flatMap(c=>[c.version,c.help,c.syntheticGatewayAttempt])].filter(Boolean).flatMap(r=>r.events.filter(e=>e.stage==='cleanup'||e.stage==='recovery-cleanup'));
    const launches=[result.osProbe,result.timeoutProbe,...result.realCli.flatMap(c=>[c.version,c.help,c.syntheticGatewayAttempt])].filter(Boolean);
    result.cleanup.launchesStarted=launchesStarted;
    result.cleanup.verified=result.cleanup.temporaryDirectoryAbsent&&launchesStarted>0&&launches.length===launchesStarted&&launches.every(r=>r.events.some(e=>e.stage==='cleanup'&&e.profileDeleteHresult===0&&e.profileDirectoryAbsent===true&&e.ownedTreeTerminated===true))&&result.cleanup.profiles.every(e=>e.profileDeleteHresult===0&&e.profileDirectoryAbsent===true&&(e.stage==='recovery-cleanup'||e.ownedTreeTerminated===true));
    result.infrastructurePassed=result.cleanup.verified&&launches.every(r=>!r.watchdogFired&&!r.events.some(e=>e.stage==='error'));
    const index=process.argv.indexOf('--evidence');
    const out=index<0?null:process.argv[index+1];
    const cleaned=redactEvidence(result,root,process.env.USERPROFILE);
    if(out) fs.writeFileSync(out,JSON.stringify(cleaned,null,2)+'\n');
    console.log(JSON.stringify(cleaned,null,2));
    if(!result.infrastructurePassed)process.exitCode=1;
  }
}
if(require.main===module) main().catch(e=>{ console.error(e.message); process.exitCode=1; });
module.exports={safeRemove,childEnvironment,brokerReply,summarizeProbe,redactEvidence};
