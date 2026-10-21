'use strict';
// Staged follow-up; a failed transport gate never launches the official CLI.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto'),net=require('node:net'),dgram=require('node:dgram');
const {launch,receiver,safeRemove,summarizeProbe,redactEvidence}=require('./run');
const {pathToFileURL}=require('node:url');
const {startFakeProvider}=require('../../lib/fake-openai-provider');
const {createGateway}=require('./gateway-broker');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function treeManifest(root) {
  const files=[];
  function walk(directory,relative='') {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const rel=relative?relative+'/'+entry.name:entry.name,absolute=path.join(directory,entry.name);
      if(entry.isSymbolicLink())throw new Error('program-tree-symlink:'+rel);
      if(entry.isDirectory())walk(absolute,rel);
      else if(entry.isFile()){const bytes=fs.readFileSync(absolute);files.push({path:rel,size:bytes.length,sha256:sha(bytes)});}
      else throw new Error('program-tree-nonfile:'+rel);
    }
  }
  walk(root);return {fileCount:files.length,totalBytes:files.reduce((n,f)=>n+f.size,0),sha256:sha(JSON.stringify(files)),files};
}
function summarizeLpac(probe) {
  const base=summarizeProbe(probe),root=probe.events.find(e=>e.stage==='token-verified');
  const child=probe.output.find(e=>e.kind==='descendant-token');
  const expectedCount=probe.registryRead?1:0,launched=probe.events.find(e=>e.stage==='launched');
  const tokens=Boolean(root&&child&&root.isAppContainer&&child.isAppContainer&&root.profileSidMatched&&root.packageSid===child.packageSid&&root.capabilityCount===expectedCount&&child.capabilityCount===expectedCount&&Array.isArray(root.capabilitySids)&&root.capabilitySids.length===expectedCount&&JSON.stringify(root.capabilitySids)===JSON.stringify(child.capabilitySids)&&launched?.capabilities===expectedCount&&JSON.stringify(launched?.capabilityNames)===JSON.stringify(probe.registryRead?['registryRead']:[]));
  const aapDenied=[false,true].every(descendant=>probe.output.some(e=>e.kind==='file'&&e.name==='outside-all-app-packages-read'&&e.descendant===descendant&&e.allowed===false&&['EPERM','EACCES'].includes(e.code)));
  const selfHttp=[false,true].every(descendant=>probe.output.some(e=>e.kind==='same-process-http'&&e.descendant===descendant&&e.allowed===true&&e.accepted===1));
  const optOut=probe.events.some(e=>e.stage==='launched'&&e.isolation==='LPAC');
  const osGatePassed=base.processCompleted&&base.fileBoundaryObserved&&tokens&&optOut&&aapDenied&&base.networkDeliveryBlockedAtTestedReceivers;
  return {processCompleted:base.processCompleted,fileBoundaryObserved:base.fileBoundaryObserved,appContainerParentAndDescendantTokensVerified:tokens,directLpacTokenQueryVerified:Boolean(root?.isLessPrivilegedAppContainer&&child?.isLessPrivilegedAppContainer),lpacOptOutAttributeApplied:optOut,aapParentAndDescendantReadDenied:aapDenied,networkDeliveryBlockedAtTestedReceivers:base.networkDeliveryBlockedAtTestedReceivers,sameProcessHttpParentAndDescendant:selfHttp,osGatePassed,transportGatePassed:osGatePassed&&selfHttp,exclusiveFilesystemAllowlistEstablished:false,registryViewConstrained:false};
}
async function positive(receivers,counters) {
  const before={...counters};
  for(let i=0;i<receivers.length;i++) {
    const r=receivers[i],address=i===1||i===4?'::1':'127.0.0.1';
    if(i<3)await new Promise((resolve,reject)=>{const socket=net.connect(r.port,address);socket.on('error',reject);socket.on('data',()=>socket.end());socket.on('close',resolve);});
    else await new Promise((resolve,reject)=>{const socket=dgram.createSocket(i===4?'udp6':'udp4');socket.on('error',reject);socket.on('message',()=>socket.close(resolve));socket.send('CONTROL',r.port,address);});
  }
  return {before,after:{...counters}};
}
async function main() {
  if(process.platform!=='win32'||Number(process.versions.node.split('.')[0])!==24)throw new Error('Windows and Node 24 required');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-m1-cli-lpac-')),projection=path.join(root,'projection'),write=path.join(projection,'write');fs.mkdirSync(write,{recursive:true});
  const result={schemaVersion:1,experiment:'privacy-m1-cli-lpac',generatedAt:new Date().toISOString(),productWired:false,completedM1:false,platform:{os:'Windows',release:os.release(),node:process.version},historicalEvidence:{file:'privacy-m1-cli.json',baselineCommit:'6d1e6544',currentSourcesDiffer:true},sourceManifest:treeManifest(__dirname),programs:{node:{version:process.version,sha256:sha(fs.readFileSync(process.execPath))}},attempts:[],gateway:{status:'untested'},realCli:[],cleanup:{},untested:['public Internet','private LAN','system DNS resolver','proxy override','redirects','CLI model/tool/edit/compact/restart','crash recovery']};
  result.priorAttempts=[{stage:'direct-lpac-query-before-resume',sourceManifestSha256:'12529042ff852b3500921b02b2ef00c41394c84af1730287e4aad447a984509a',isolations:['AppContainer','LPAC'],queryClass:46,win32Error:87,rootResumed:false,cleanupVerified:true,resolution:'Keep unavailable direct LPAC query unknown; verify documented launch opt-out, token classes 29/30/31 and behavior instead.'},{stage:'pipe-create-with-combined-sacl',status:'failed',rootResumed:false,profileDeleted:true,resolution:'Create owned DACL-only pipe, then lower its label through its WRITE_OWNER handle without enabling privileges.',sourceBinding:'Historical development diagnostic; preceding source was not retained as a separate snapshot.'},{stage:'pipe-global-local-namespace',status:'failed',childExit:1,childDiagnostic:'ENOENT',upstreamRequests:0,cleanupVerified:true,resolution:'Host creates only the target profile qualified pipe namespace; client uses LOCAL random name.',sourceBinding:'Historical development diagnostic; preceding source was not retained as a separate snapshot.'}];
  result.sourceDependencies=Object.fromEntries(['../../lib/kill-own-tree.js','../../lib/fake-openai-provider.js','../../../ruyi-workbench/app/src/01i-privacy-rules.js','../../../ruyi-workbench/app/src/01h-privacy-core.js'].map(relative=>[relative,sha(fs.readFileSync(path.join(__dirname,relative)))]));
  const receivers=[],counters={},providers=[];
  try {
    const helper=path.join(root,'AppContainerHost.exe'),compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    cp.execFileSync(compiler,['/nologo','/target:exe','/r:System.Web.Extensions.dll','/out:'+helper,path.join(__dirname,'AppContainerHost.cs')],{windowsHide:true,stdio:'pipe'});
    result.programs.helper={sha256:sha(fs.readFileSync(helper)),compilerSha256:sha(fs.readFileSync(compiler))};
    fs.copyFileSync(helper,path.join(projection,'TokenProbe.exe'));const node=path.join(projection,'node.exe');fs.copyFileSync(process.execPath,node);fs.copyFileSync(path.join(__dirname,'probe.js'),path.join(projection,'probe.js'));
    result.programs.node.projectedSha256=sha(fs.readFileSync(node));
    const npm=path.join(process.env.APPDATA,'npm','node_modules');
    for(const [id,packageName,entry]of [['claude','@anthropic-ai/claude-code','bin/claude.exe'],['kimi','@moonshot-ai/kimi-code','dist/main.mjs']]) {
      const directory=path.join(npm,packageName),metadata=path.join(directory,'package.json');
      if(!fs.existsSync(metadata)){result.realCli.push({id,status:'missing'});continue;}
      const pkg=JSON.parse(fs.readFileSync(metadata,'utf8'));
      result.realCli.push({id,packageName,packageVersion:pkg.version,entry,entrySha256:fs.existsSync(path.join(directory,entry))?sha(fs.readFileSync(path.join(directory,entry))):null,installedProgramTree:treeManifest(directory),executed:false,status:'blocked',reason:'LPAC transport gate must pass before official CLI launch',completeLoop:false});
    }
    fs.writeFileSync(path.join(projection,'project.txt'),'SYNTHETIC_PROJECT_[PRIVATE_M1]');fs.writeFileSync(path.join(root,'outside-secret.txt'),'SYNTHETIC_SECRET_M1_ONLY');fs.mkdirSync(path.join(root,'aap-control'));fs.writeFileSync(path.join(root,'aap-control','outside-readable.txt'),'SYNTHETIC_AAP_OUTSIDE_PROJECTION');
    for(const [kind,address,label]of [['tcp','127.0.0.1','loopback-tcp4'],['tcp','::1','loopback-tcp6'],['tcp','127.0.0.1','private-gateway'],['udp','127.0.0.1','loopback-udp4'],['udp','::1','loopback-udp6'],['udp','127.0.0.1','dns-owned-receiver']])receivers.push(await receiver(kind,address,counters,label));
    const config=path.join(projection,'probe.json');fs.writeFileSync(config,JSON.stringify({sameProcessHttp:true,tokenProbe:path.join(projection,'TokenProbe.exe'),allowed:path.join(projection,'project.txt'),denied:path.join(root,'outside-secret.txt'),allAppPackages:path.join(root,'aap-control','outside-readable.txt'),deniedWrite:path.join(root,'outside-write.txt'),write,tcp4:receivers[0].port,tcp6:receivers[1].port,gateway:receivers[2].port,udp4:receivers[3].port,udp6:receivers[4].port,dns:receivers[5].port}));
    for(const [isolation,registryRead]of [['AppContainer',false],['LPAC',false],['LPAC',true]]) {
      const control=await positive(receivers,counters),probe=await launch(helper,root,projection,write,node,['--preserve-symlinks-main',path.join(projection,'probe.js'),config],45000,{},isolation,registryRead);
      probe.isolation=isolation;probe.registryRead=registryRead;probe.receivers=receivers.map(r=>({id:r.label,positiveControlConnections:(control.after[r.label]||0)-(control.before[r.label]||0),unauthorizedConnections:(counters[r.label]||0)-(control.after[r.label]||0)}));
      probe.hostChecks={originalProjectUnchanged:fs.readFileSync(path.join(projection,'project.txt'),'utf8')==='SYNTHETIC_PROJECT_[PRIVATE_M1]',outsideWriteAbsent:!fs.existsSync(path.join(root,'outside-write.txt'))};
      probe.summary=isolation==='LPAC'?summarizeLpac(probe):summarizeProbe(probe);result.attempts.push(probe);
      process.stderr.write(JSON.stringify({isolation,code:probe.code,summary:probe.summary})+'\n');
    }
    const lpac=result.attempts.find(p=>p.isolation==='LPAC'&&p.registryRead);
    result.gateway={sameProcessHttp:{status:lpac.summary.sameProcessHttpParentAndDescendant?'passed':'blocked',reason:'LPAC registryRead listen is tested separately; TCP is not required by the direct fetch-to-pipe candidate.'},directFetchPipe:{status:'blocked',reason:'LPAC OS gate must pass'},supportedTransportReview:{scope:'Read-only inspection of the installed Kimi OpenAI SDK default-fetch selection supports testing Node public --import with our original global fetch adapter. No vendor source is copied into repository or patched. The adapter is not the OS or host authorization boundary.',references:['https://moonshotai.github.io/kimi-code/en/configuration/providers.html','https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html','https://nodejs.org/docs/latest/api/cli.html']}};
    if(lpac.summary.osGatePassed) {
      for(const name of ['gateway-preload.mjs','fetch-adapter.mjs','gateway-probe.mjs'])fs.copyFileSync(path.join(__dirname,name),path.join(projection,name));
      let responseChallenge='M1_RESPONSE_'+crypto.randomBytes(16).toString('hex');const provider=await startFakeProvider({handler:()=>responseChallenge});providers.push(provider);const control=await fetch(provider.url+'/v1/models');await control.text();
      const prefix=['--preserve-symlinks-main','--preserve-symlinks','--import',pathToFileURL(path.join(projection,'gateway-preload.mjs')).href];
      const fixtureHome=path.join(write,'pipe-fixture');fs.mkdirSync(fixtureHome);const fixtureBroker=createGateway({upstream:provider.url,responseChallenge});
      const before={...counters},beforeRequests=provider.requests.length;
      const fixture=await launch(helper,root,projection,fixtureHome,node,[...prefix,path.join(projection,'gateway-probe.mjs')],18000,{RUYI_M1_PROMPT:fixtureBroker.projectedPrompt,RUYI_M1_ATTACK_PORT:String(receivers[0].port)},'LPAC',true,fixtureBroker);
      fixture.gatewayEvidence=fixtureBroker.evidence;fixture.receiver={positiveControlHttpStatus:control.status,modelRequests:provider.requests.length-beforeRequests,unauthorizedConnections:receivers.map(r=>({id:r.label,count:(counters[r.label]||0)-(before[r.label]||0)}))};
      fixture.spoofedControlRejected=fixtureBroker.evidence.rejected===0&&fixtureBroker.evidence.requests.length===1&&fixture.events.filter(e=>e.stage==='cleanup').length===1&&!fixture.events.some(e=>e.stage==='error'||JSON.stringify(e).includes('SYNTHETIC_SPOOF_BODY'));
      fixture.passed=fixture.code===0&&fixture.expectedResponseObserved&&fixture.spoofedControlRejected&&fixture.events.some(e=>e.stage==='pipe-created')&&fixture.receiver.modelRequests===1&&fixture.receiver.unauthorizedConnections.every(r=>r.count===0)&&fixtureBroker.evidence.requests.some(r=>r.path==='/v1/chat/completions'&&r.delivery==='confirmed'&&r.responseContainsChallenge);
      result.ipcFixture=fixture;result.gateway.directFetchPipe={status:fixture.passed?'passed':'blocked',reason:fixture.passed?'Fixed fixture fetch traversed LOCAL pipe and real PrivacyCore to independent HTTP receiver.':'Pipe/preload fixture did not complete; official CLI is not launched.'};
      if(fixture.passed) {
        const cli=result.realCli.find(item=>item.id==='kimi'&&item.status!=='missing');
        if(cli) {
          const copy=path.join(projection,'kimi');fs.cpSync(path.join(npm,cli.packageName),copy,{recursive:true});cli.projectedProgramTree=treeManifest(copy);cli.programTreesMatch=cli.installedProgramTree.sha256===cli.projectedProgramTree.sha256;
          const modelHome=path.join(write,'kimi-pipe-model');fs.mkdirSync(modelHome);responseChallenge='M1_RESPONSE_'+crypto.randomBytes(16).toString('hex');const broker=createGateway({upstream:provider.url,deadline:Date.now()+25000,responseChallenge}),beforeKimi=provider.requests.length,beforeKimiConnections={...counters};
          const attempt=await launch(helper,root,projection,modelHome,node,[...prefix,path.join(copy,cli.entry),'--prompt',broker.projectedPrompt,'--output-format','stream-json'],25000,{KIMI_MODEL_NAME:'synthetic-m1',KIMI_MODEL_API_KEY:'SYNTHETIC_NONCREDENTIAL',KIMI_MODEL_BASE_URL:'https://privacy-gateway.invalid/v1',KIMI_MODEL_PROVIDER_TYPE:'openai'},'LPAC',true,broker);
          attempt.gatewayEvidence=broker.evidence;attempt.receiver={modelRequests:provider.requests.length-beforeKimi,bodySha256:provider.requests.slice(beforeKimi).map(r=>sha(r.raw)),containsOriginal:provider.requests.slice(beforeKimi).some(r=>r.raw.includes('SYNTHETIC_M1_CONTACT_SECRET')),unauthorizedConnections:receivers.map(r=>({id:r.label,count:(counters[r.label]||0)-(beforeKimiConnections[r.label]||0)}))};
          attempt.receiver.matchesBrokerBody=JSON.stringify(attempt.receiver.bodySha256)===JSON.stringify(broker.evidence.requests.filter(r=>r.path==='/v1/chat/completions').map(r=>r.upstreamBodySha256));
          cli.executed=true;cli.modelAttempt=attempt;cli.status=cli.programTreesMatch&&attempt.code===0&&attempt.expectedResponseObserved&&attempt.receiver.modelRequests===1&&!attempt.receiver.containsOriginal&&attempt.receiver.matchesBrokerBody&&attempt.receiver.unauthorizedConnections.every(r=>r.count===0)&&broker.evidence.requests.some(r=>r.delivery==='confirmed'&&r.responseContainsChallenge)?'limited-model-request-passed':'blocked';cli.completeLoop=false;
          result.gateway.actualKimiModel={status:cli.status,completeLoop:false};
        }
      }
    }
  } finally {
    for(const listener of receivers)await listener.close();
    for(const provider of providers)await provider.close();
    safeRemove(root);result.cleanup.temporaryDirectoryAbsent=!fs.existsSync(root);
    const launches=[...result.attempts,result.ipcFixture,...result.realCli.map(c=>c.modelAttempt)].filter(Boolean);
    result.cleanup.launchCount=launches.length;result.cleanup.verified=result.cleanup.temporaryDirectoryAbsent&&result.attempts.length===3&&launches.every(p=>p.events.some(e=>e.stage==='cleanup'&&e.profileDeleteHresult===0&&e.profileDirectoryAbsent===true&&(e.processCreated===false||e.ownedTreeTerminated===true)));
    const clean=redactEvidence(result,root,process.env.USERPROFILE),index=process.argv.indexOf('--evidence');
    if(index>=0)fs.writeFileSync(process.argv[index+1],JSON.stringify(clean,null,2)+'\n');
    console.log(JSON.stringify({gateway:clean.gateway,cleanup:clean.cleanup,attempts:clean.attempts.map(p=>({isolation:p.isolation,summary:p.summary}))},null,2));
    if(!result.cleanup.verified)process.exitCode=1;
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={treeManifest,summarizeLpac};
