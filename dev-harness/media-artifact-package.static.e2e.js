#!/usr/bin/env node
'use strict';
// 只读发布接线合同；原三组断言保持不变。PowerShell模型必须显式运行，不能由本件启动。
const {createRunner}=require('./lib/harness'),runner=createRunner('MEDIA ARTIFACT PACKAGE STATIC');
function test(label,work){try{work();runner.ok(true,label);}catch(error){runner.fail(label);console.error(error.stack||error);}}
'use strict';const a=require('node:assert/strict'),fs=require('node:fs'),p=require('node:path'),source=fs.readFileSync(p.resolve(__dirname,'../ruyi-workbench/tools/package-offline.ps1'),'utf8');
test('Full media artifact verification has an explicit existing-source input and never downloads a sidecar',()=>{a.match(source,/\[string\]\$MediaSourcesRoot = ""/);a.match(source,/function Assert-MediaArtifactInventory/);a.match(source,/mediaProcessingEnabled/);a.match(source,/mediaEgressEnabled/);a.match(source,/installsPerformed/);});
test('source and staged inventories gate the respective first existing Python runtime probes',()=>{const sourceGate=source.indexOf('Assert-MediaArtifactInventory $root $offlineSrc $mediaSources'),sourceProbe=source.indexOf('Assert-FullAccOcrPayload $offlineSrc'),stageGate=source.indexOf('Assert-MediaArtifactInventory $stage $accDst $mediaDestination'),stageProbe=source.indexOf('Assert-FullAccOcrPayload $accDst');a.ok(sourceGate>=0&&sourceProbe>sourceGate);a.ok(stageGate>sourceGate&&stageProbe>stageGate);});
test('only the pinned source archive and verifier tools are copied within the IncludeAcc branch',()=>{a.match(source,/Join-Path \$mediaSources "opencv-windows-ffmpeg-source-sidecar.zip"/);a.match(source,/Join-Path \$stage "resources\\media-runtime-sources"/);a.match(source,/@\("media-runtime-lock.cjs", "verify-media-artifacts.cjs"\)/);const branch=source.indexOf('if ($IncludeAcc) {'),zip=source.indexOf('Join-Path $mediaSources "opencv-windows-ffmpeg-source-sidecar.zip"');a.ok(branch>=0&&zip>branch);});


test('package Node selection is one Application and the explicit source models cannot launch a packager',()=>{
 a.match(source,/\$mediaNode = Get-Command node\.exe -CommandType Application -ErrorAction SilentlyContinue \| Select-Object -First 1(?:\r?\n)/);
 a.equal((source.match(/\$mediaOutput = & \$mediaNode\.Source \$verifier \$AccRoot \$SourceRoot/g)||[]).length,1);
 const helper=source.slice(source.indexOf('function Assert-MediaArtifactInventory'),source.indexOf('$accSummary ='));
 for(const name of ['media-runtime-lock.cjs','verify-media-artifacts.cjs']){
  const bytes=fs.readFileSync(p.resolve(__dirname,'../ruyi-workbench/tools',name));
  const digest=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  a.ok(helper.includes('"'+name+'" = "'+digest+'"'),'actual package function must pin the exact selected '+name);
 }
 a.doesNotMatch(helper,/foreach\s*\([^\r\n]*mediaNode|catch\s*\{|Start-Process|Invoke-Expression/);
 for(const name of ['media-artifact-package-function-model.ps1','media-artifact-multiple-command-model.ps1','media-artifact-no-fallback-model.ps1']){
  const model=fs.readFileSync(p.join(__dirname,'lib',name),'utf8');
  a.match(model,/\[Parameter\(Mandatory=\$true\)\]\[string\]\$FixtureRoot/);
  a.doesNotMatch(model,/[A-Z]:[\\/]|ruyi-m4-[^'"\r\n]*202610|candidate[\\/]|promotion[\\/]|powershell\.exe|Start-Process\s+-/);
 }
});
runner.done();
