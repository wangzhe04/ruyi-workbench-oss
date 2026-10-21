'use strict';
// node filesystem.js --evidence <owned report>. Infrastructure success is not strict-boundary success.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {launch,safeRemove,redactEvidence,childEnvironment}=require('./run');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function sourceManifest() {
  const files=['AppContainerHost.cs','run.js','filesystem.js','filesystem-probe.js','filesystem-inspect.ps1','filesystem-contract.md','filesystem.test.js'].map(name=>{const bytes=fs.readFileSync(path.join(__dirname,name));return {path:name,size:bytes.length,sha256:sha(bytes)};});
  return {fileCount:files.length,sha256:sha(JSON.stringify(files)),files};
}
function helperEnvironment(write,projection) {
  return {...childEnvironment(write,projection),TEMP:os.tmpdir(),TMP:os.tmpdir()};
}
function compileHelper(root) {
  const compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe'),helper=path.join(root,'AppContainerHost.exe');
  cp.execFileSync(compiler,['/nologo','/target:exe','/r:System.Web.Extensions.dll','/out:'+helper,path.join(__dirname,'AppContainerHost.cs')],{windowsHide:true,stdio:'pipe',env:helperEnvironment(root,root)});
  return {helper,compiler};
}
function summarizeFilesystem(attempt,fixtures) {
  const rows=attempt.output||[],root=attempt.events?.find(e=>e.stage==='token-verified');
  const ready=[false,true].every(descendant=>rows.some(e=>e.kind==='filesystem'&&e.descendant===descendant&&e.name==='probe'&&e.operation==='ready'&&e.verified));
  const tokenRows=rows.filter(e=>e.name==='actual-descendant-token'&&e.operation==='token');
  const actualTokens=rows.filter(e=>e.kind==='descendant-token');
  const tokens=Boolean(root?.isAppContainer&&root.profileSidMatched&&root.capabilityCount===1&&actualTokens.length===2&&actualTokens.every(e=>e.isAppContainer&&e.packageSid===root.packageSid&&JSON.stringify(e.capabilitySids)===JSON.stringify(root.capabilitySids))&&[false,true].every(descendant=>tokenRows.some(e=>e.descendant===descendant&&Number.isInteger(e.exitCode))));
  const tokenProbeCleanExits=[false,true].every(descendant=>tokenRows.some(e=>e.descendant===descendant&&e.exitCode===0));
  const matrixComplete=ready&&fixtures.every(f=>[false,true].every(descendant=>['read','enumerate','write','extended-read'].every(operation=>rows.some(e=>e.descendant===descendant&&e.name===f.name&&e.operation===operation&&typeof e.allowed==='boolean'))));
  const outsideAccess=rows.filter(e=>fixtures.some(f=>f.name===e.name)&&e.allowed===true&&e.verified===true).map(e=>({name:e.name,operation:e.operation,descendant:e.descendant}));
  const controls=[false,true].every(descendant=>[['project','read',true],['project','write',false],['output','write',true]].every(([name,operation,allowed])=>rows.some(e=>e.descendant===descendant&&e.name===name&&e.operation===operation&&e.allowed===allowed&&(allowed?e.verified===true:['EACCES','EPERM'].includes(e.code)))));
  return {processCompleted:attempt.code===0,rootAndChildExecuted:ready,rootAndDescendantTokensVerified:tokens,descendantTokenProbeCleanExits:tokenProbeCleanExits,directLpacQueryVerified:Boolean(root?.isLessPrivilegedAppContainer&&actualTokens.length===2&&actualTokens.every(e=>e.isLessPrivilegedAppContainer)),matrixComplete,projectionAndOutputControlsPassed:controls,outsideFixtureAccess:outsideAccess,strictFilesystemContract:outsideAccess.length?'failed':'unknown',exclusiveFilesystemAllowlistEstablished:false,registryViewConstrained:false};
}
async function main() {
  if(process.platform!=='win32'||Number(process.versions.node.split('.')[0])!==24)throw new Error('Windows Node 24 required');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-m1-cli-filesystem-')),projection=path.join(root,'projection'),write=path.join(projection,'write');fs.mkdirSync(write,{recursive:true});
  const result={schemaVersion:1,experiment:'privacy-m1-cli-filesystem',generatedAt:new Date().toISOString(),productWired:false,completedM1:false,baselineCommit:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),platform:{release:os.release(),node:process.version},contract:'filesystem-contract.md',sourceManifest:sourceManifest(),sourceDependencies:Object.fromEntries(['../../lib/kill-own-tree.js','../../lib/fake-openai-provider.js'].map(relative=>[relative,sha(fs.readFileSync(path.join(__dirname,relative)))])),programs:{node:{version:process.version,sha256:sha(fs.readFileSync(process.execPath))}},attempts:[],cleanup:{},limitations:['finite synthetic matrix does not prove whole-filesystem isolation','required system/runtime file inventory not established','registry view untested','hardlink row is intentionally unsafe projection creation, separate from LPAC ACL authorization','reparse races and competing malicious host processes untested','raw NT device names, alternate streams and all possible name aliases untested','no VM, managed WSL or privileged filesystem enforcement installed or tested']};
  const priorIndex=process.argv.indexOf('--prior-evidence');
  if(priorIndex>=0){const priorBytes=fs.readFileSync(process.argv[priorIndex+1]),prior=JSON.parse(priorBytes);result.priorAttempts=[...(prior.priorAttempts||[]),{evidenceSha256:sha(priorBytes),sourceManifest:prior.sourceManifest,programs:prior.programs,attempts:prior.attempts,cleanup:prior.cleanup,resolution:'Historical bounded attempt retained with its source identity. Capture-pipe timeouts remain unknown; later inherited-output snapshots and CLR exit failures are separate observations.'}];}
  try {
    const {helper,compiler}=compileHelper(root);result.programs.helper={sha256:sha(fs.readFileSync(helper)),compilerSha256:sha(fs.readFileSync(compiler))};
    const node=path.join(projection,'node.exe'),tokenProbe=path.join(projection,'TokenProbe.exe');fs.copyFileSync(process.execPath,node);fs.copyFileSync(helper,tokenProbe);fs.copyFileSync(path.join(__dirname,'filesystem-probe.js'),path.join(projection,'filesystem-probe.js'));
    const fixtures=[];
    for(const principal of ['user','everyone','arap','profile'])for(const rights of ['read','write']) {
      const name=principal+'-'+rights,directory=path.join(root,name),expected='SYNTHETIC_SECRET_'+name;fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'marker.txt'),expected);fixtures.push({name,directory,expected,principal,rights});
    }
    const aap=path.join(root,'aap-control');fs.mkdirSync(aap);fs.writeFileSync(path.join(aap,'marker.txt'),'SYNTHETIC_SECRET_aap');fixtures.push({name:'aap',directory:aap,expected:'SYNTHETIC_SECRET_aap'});
    result.positiveControls=fixtures.map(f=>{const read=fs.readFileSync(path.join(f.directory,'marker.txt'),'utf8')===f.expected,enumerate=fs.readdirSync(f.directory).includes('marker.txt'),target=path.join(f.directory,'host-positive.txt');fs.writeFileSync(target,'SYNTHETIC_HOST_CONTROL');const writeVerified=fs.readFileSync(target,'utf8')==='SYNTHETIC_HOST_CONTROL';fs.unlinkSync(target);return {name:f.name,read,enumerate,write:writeVerified};});
    const source=path.join(root,'hardlink-source'),outside=path.join(source,'marker.txt'),inside=path.join(projection,'linked-secret.txt');fs.mkdirSync(source);fs.writeFileSync(outside,'SYNTHETIC_HARDLINK_SECRET');fs.linkSync(outside,inside);
    const identity=file=>{const stat=fs.statSync(file,{bigint:true});return {device:String(stat.dev),fileId:String(stat.ino),links:Number(stat.nlink)};};
    const snapshot=()=>JSON.parse(cp.execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'filesystem-inspect.ps1'),'-Root',root],{windowsHide:true,encoding:'utf8',env:helperEnvironment(write,projection)}));
    result.hardlink={unsafeProjectionMakerNegativeControl:true,before:{outside:identity(outside),inside:identity(inside),acl:snapshot()},hostReadVerified:fs.readFileSync(outside,'utf8')==='SYNTHETIC_HARDLINK_SECRET'};
    const project=path.join(projection,'project.txt');fs.writeFileSync(project,'SYNTHETIC_MODEL_VIEW');
    const config=path.join(projection,'filesystem-probe.json');fs.writeFileSync(config,JSON.stringify({fixtures:fixtures.map(({name,directory,expected})=>({name,directory,expected})),write,project,tokenProbe,hardlink:{inside,outside},junctions:fixtures.filter(f=>['user-write','arap-write'].includes(f.name))}));
    const attempt=await launch(helper,root,projection,write,node,['--preserve-symlinks-main',path.join(projection,'filesystem-probe.js'),config],30000,{},'LPAC',true,null,{filesystemFixtures:fixtures.filter(f=>f.principal).map(({directory,principal,rights})=>({directory,principal,rights})),filesystemStorage:true});
    attempt.summary=summarizeFilesystem(attempt,fixtures);result.attempts.push(attempt);result.hardlink.after={outside:identity(outside),inside:identity(inside),acl:snapshot()};
    result.hardlink.sharedIdentity=result.hardlink.before.outside.fileId===result.hardlink.before.inside.fileId&&result.hardlink.before.outside.device===result.hardlink.before.inside.device;
    result.hardlink.outsideAclChanged=result.hardlink.before.acl['hardlink-source\\marker.txt']!==result.hardlink.after.acl['hardlink-source\\marker.txt'];
    result.hostChecks={originalProjectUnchanged:fs.readFileSync(project,'utf8')==='SYNTHETIC_MODEL_VIEW',sourceMarkerUnchanged:fs.readFileSync(outside,'utf8')==='SYNTHETIC_HARDLINK_SECRET'};
    // A separate primary-token candidate, not a thread impersonation boundary. No retries or system ACL changes.
    const restrictedProjection=path.join(root,'restricted-projection'),restrictedWrite=path.join(restrictedProjection,'write');fs.mkdirSync(restrictedWrite,{recursive:true});
    for(const name of ['node.exe','TokenProbe.exe','filesystem-probe.js'])fs.copyFileSync(path.join(projection,name),path.join(restrictedProjection,name));
    const restrictedProject=path.join(restrictedProjection,'project.txt');fs.writeFileSync(restrictedProject,'SYNTHETIC_MODEL_VIEW');
    const restrictedConfig=path.join(restrictedProjection,'filesystem-probe.json');fs.writeFileSync(restrictedConfig,JSON.stringify({fixtures:[],junctions:[],hardlink:{},write:restrictedWrite,project:restrictedProject,tokenProbe:path.join(restrictedProjection,'TokenProbe.exe')}));
    const restricted=await launch(helper,root,restrictedProjection,restrictedWrite,path.join(restrictedProjection,'node.exe'),['--preserve-symlinks-main',path.join(restrictedProjection,'filesystem-probe.js'),restrictedConfig],10000,{},'LPAC',true,null,{filesystemRestrictedToken:true,filesystemStorage:true});
    restricted.summary=summarizeFilesystem(restricted,[]);
    const restrictedRoot=restricted.events.find(e=>e.stage==='token-verified');
    result.restrictedPrimaryTokenCandidate={attempt:restricted,rootRestrictionVerified:restrictedRoot?.expectedRestrictionMatched===true&&restrictedRoot.restrictedSidCount===1,descendantRestrictionVerified:restricted.output.filter(e=>e.kind==='descendant-token').length===2&&restricted.output.filter(e=>e.kind==='descendant-token').every(e=>JSON.stringify(e.restrictedSids)===JSON.stringify(restrictedRoot?.restrictedSids)),exclusiveFilesystemAllowlistEstablished:false,status:restricted.summary.rootAndChildExecuted?'probe-executed-needs-full-attack-matrix':'blocked-before-complete-probe',interpretation:'Creation or runtime failure is not isolation success. A successful reduced probe would still require the full adversarial filesystem matrix and runtime-resource inventory.'};
  } finally {
    safeRemove(root);result.sourcesStableDuringRun=result.sourceManifest.sha256===sourceManifest().sha256;result.cleanup.temporaryDirectoryAbsent=!fs.existsSync(root);const launches=[...result.attempts,result.restrictedPrimaryTokenCandidate?.attempt].filter(Boolean);result.cleanup.launchCount=launches.length;result.cleanup.verified=result.cleanup.temporaryDirectoryAbsent&&launches.length===2&&launches.every(a=>a.events.some(e=>e.stage==='cleanup'&&e.profileDeleteHresult===0&&e.profileDirectoryAbsent===true&&(e.processCreated===false||e.ownedTreeTerminated===true)));
    result.infrastructurePassed=result.cleanup.verified&&result.sourcesStableDuringRun&&result.attempts.every(a=>a.summary.processCompleted&&a.summary.matrixComplete&&a.summary.rootAndDescendantTokensVerified&&a.summary.descendantTokenProbeCleanExits&&a.summary.projectionAndOutputControlsPassed)&&Boolean(result.positiveControls?.every(c=>c.read&&c.enumerate&&c.write));
    const clean=redactEvidence(result,root,process.env.USERPROFILE),index=process.argv.indexOf('--evidence');if(index>=0)fs.writeFileSync(process.argv[index+1],JSON.stringify(clean,null,2)+'\n');
    console.log(JSON.stringify({summary:clean.attempts.map(a=>a.summary),restrictedPrimaryTokenCandidate:clean.restrictedPrimaryTokenCandidate&&{status:clean.restrictedPrimaryTokenCandidate.status,rootRestrictionVerified:clean.restrictedPrimaryTokenCandidate.rootRestrictionVerified,events:clean.restrictedPrimaryTokenCandidate.attempt.events},infrastructurePassed:clean.infrastructurePassed,cleanup:clean.cleanup},null,2));
    if(!result.infrastructurePassed)process.exitCode=1;
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={summarizeFilesystem,compileHelper,helperEnvironment};
