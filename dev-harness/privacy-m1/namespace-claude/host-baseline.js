'use strict';
// Ordinary host compatibility baseline. NOT a security boundary or VM acceptance.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const {startGateway}=require('./http-gateway');
const {startFakeAnthropic}=require('../../lib/fake-anthropic-provider');
const {treeManifest}=require('../cli/lpac');
const {createClaudeObserver}=require('../cli/claude-observer');
const {killOwnTree}=require('../../lib/kill-own-tree');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const {StringDecoder}=require('node:string_decoder');
async function main(){
  if(process.platform!=='win32'||Number(process.versions.node.split('.')[0])!==24)throw new Error('Windows Node24 required');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-claude-http-')),home=path.join(root,'home'),work=path.join(root,'work'),program=path.join(root,'program');
  const files=['host-baseline.js','http-gateway.js','../cli/gateway-broker.js','../cli/claude-observer.js','../cli/lpac.js','../../lib/kill-own-tree.js','../../lib/fake-anthropic-provider.js','../../../ruyi-workbench/app/src/01i-privacy-rules.js','../../../ruyi-workbench/app/src/01h-privacy-core.js'];
  const result={experiment:'claude-http-ordinary-host-baseline',securityBoundaryEstablished:false,completedM1:false,generatedAt:new Date().toISOString(),sourceManifest:files.map(file=>({path:file,sha256:sha(fs.readFileSync(path.join(__dirname,file)))}))};
  let fake,gateway,child;
  try{
    for(const dir of [home,work,path.join(home,'roaming'),path.join(home,'local'),path.join(home,'temp'),path.join(home,'config')])fs.mkdirSync(dir,{recursive:true});
    const installed=path.join(process.env.APPDATA,'npm/node_modules/@anthropic-ai/claude-code');
    result.program={version:JSON.parse(fs.readFileSync(path.join(installed,'package.json'),'utf8')).version,installed:treeManifest(installed)};
    if(result.program.version!=='2.1.202')throw new Error('frozen-version-mismatch');
    fs.cpSync(installed,program,{recursive:true});result.program.copy=treeManifest(program);if(result.program.copy.sha256!==result.program.installed.sha256)throw new Error('copy-mismatch');
    const challenge='hostonlynonce'+crypto.randomBytes(16).toString('hex'),observer=createClaudeObserver(challenge);
    fake=await startFakeAnthropic({handler:()=>challenge});gateway=await startGateway({upstream:fake.url,responseChallenge:challenge,deadline:Date.now()+25000});
    const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATH:path.join(process.env.WINDIR,'System32'),HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'temp'),TMP:path.join(home,'temp'),CLAUDE_CONFIG_DIR:path.join(home,'config'),ANTHROPIC_BASE_URL:gateway.url,ANTHROPIC_API_KEY:'SYNTHETIC_NONCREDENTIAL',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',DISABLE_AUTOUPDATER:'1',API_TIMEOUT_MS:'12000',CLAUDE_CODE_CERT_STORE:'bundled'};
    const args=['--bare','--print','--model','synthetic-m1','--output-format','stream-json','--verbose','--tools','','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--max-turns','1',gateway.projectedPrompt];
    child=cp.spawn(path.join(program,'bin/claude.exe'),args,{cwd:work,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdoutBytes=0,stderrBytes=0;const decoder=new StringDecoder('utf8');const limit=()=>{if(!result.outputLimit){result.outputLimit=true;result.outputKillReceipt=killOwnTree(child);}};child.stdout.on('data',b=>{stdoutBytes+=b.length;if(stdoutBytes+stderrBytes>1048576)limit();else observer.write(decoder.write(b));});child.stderr.on('data',b=>{stderrBytes+=b.length;if(stdoutBytes+stderrBytes>1048576)limit();});
    result.exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{result.timedOut=true;result.killReceipt=killOwnTree(child);},25000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
    result.observation=observer.summary;result.output={stdoutBytes,stderrBytes};result.http=gateway.observed;result.gateway=gateway.evidence;
    result.receiver={requests:fake.requests.length,bodySha256:fake.requests.map(r=>sha(r.raw)),containsOriginal:fake.requests.some(r=>r.raw.includes('SYNTHETIC_M1_CONTACT_SECRET'))};
    result.receiver.hashesMatch=JSON.stringify(result.receiver.bodySha256)===JSON.stringify(gateway.evidence.requests.map(r=>r.upstreamBodySha256));
    result.compatibilityPassed=result.exit.code===0&&!result.outputLimit&&observer.observed&&fake.requests.length===1&&!result.receiver.containsOriginal&&result.receiver.hashesMatch&&gateway.evidence.requests.length===1&&gateway.evidence.requests[0].delivery==='confirmed'&&gateway.evidence.requests[0].responseContainsChallenge===true;
  }finally{
    if(child)result.finalKillReceipt=killOwnTree(child);if(gateway)await gateway.close();if(fake)await fake.close();
    if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('cleanup-root');fs.rmSync(root,{recursive:true,force:true});result.cleanup={temporaryDirectoryAbsent:!fs.existsSync(root)};
    result.compatibilityPassed=Boolean(result.compatibilityPassed&&result.cleanup.temporaryDirectoryAbsent&&result.finalKillReceipt?.skipped==='root-exited');if(!result.compatibilityPassed)process.exitCode=1;
    const i=process.argv.indexOf('--evidence');if(i>=0)fs.writeFileSync(process.argv[i+1],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
