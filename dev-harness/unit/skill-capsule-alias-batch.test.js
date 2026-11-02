'use strict';
require('../lib/media-artifact-test-guard');
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const helper=fs.readFileSync(path.join(__dirname,'../lib/skill-capsule-native-fixture.js'),'utf8');
const entry=fs.readFileSync(path.join(__dirname,'../migration-skill-backup-representation.e2e.js'),'utf8');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const pairs=[['C:\\owned\\S','OLDROOT'],['C:\\owned\\S\\original-directory','OLDDIR'],['C:\\owned\\S\\original-directory\\private.bin','OLDBIN.BIN'],['C:\\owned\\S\\original-directory\\long-empty-alias-file.txt','']];
function load(result={status:0,stdout:'',stderr:''}){const calls=[],module={exports:{}};vm.runInNewContext(helper,{module,Buffer,process:{env:{}},require(name){assert.equal(name,'node:child_process');return{spawnSync(...args){calls.push(args);return result;}};}});return{api:module.exports,calls};}
test('four original setup aliases share exactly one real-helper compilation and unchanged30000 budget',()=>{
 const {api,calls}=load();assert.equal(api.setShortNames(pairs),undefined);assert.equal(calls.length,1);
 const [command,args,options]=calls[0];assert.equal(command,'powershell.exe');assert.deepEqual(Array.from(args.slice(0,4)),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand']);
 assert.equal(args.length,5);assert.equal(options.timeout,30000);assert.equal(options.windowsHide,true);assert.equal(options.encoding,'utf8');
 assert.deepEqual(JSON.parse(options.env.RUYI_NATIVE_FIXTURE_RELATIVES),pairs);assert.equal(options.env.RUYI_NATIVE_FIXTURE_PATH,pairs[0][0]);
 assert.equal(sha(Buffer.from(options.env.RUYI_NATIVE_FIXTURE_SOURCE,'base64')),'7d4f26d9888acebe7597ae528c5b69d4876407077a60e582c4fc2b37152ebbc0');
 const script=Buffer.from(args[4],'base64').toString('utf16le');assert.ok(script.startsWith("$ErrorActionPreference='Stop'; Add-Type -ReferencedAssemblies System.Web.Extensions -TypeDefinition "));
 assert.equal((script.match(/Add-Type/g)||[]).length,1);assert.ok(script.endsWith('foreach($entry in $entries){[SkillCapsuleFixture]::Alias([string]$entry[0],[string]$entry[1])}'));
 assert.equal(script.includes('catch'),false,'first Alias native exception terminates the original helper without later setup');
});
test('batch error and original spawn exception propagate once without retry or metadata parsing',()=>{
 const failed=load({status:7,stdout:'not JSON',stderr:'owned failure'});assert.throws(()=>failed.api.setShortNames(pairs),/native fixture failed: 7 owned failure/);assert.equal(failed.calls.length,1);
 const error=Object.assign(Error('synthetic spawn failure'),{code:'EIO'}),thrown=load({error});assert.throws(()=>thrown.api.setShortNames(pairs),e=>e===error);assert.equal(thrown.calls.length,1);
});
test('malformed or unbounded batches issue no helper while the original single Alias API remains independent',()=>{
 const {api,calls}=load();for(const bad of [null,[],pairs.slice(1),[...pairs,pairs[0]],Object.assign(new Array(4),{0:pairs[0]}),[[null,'x'],...pairs.slice(1)],[[pairs[0][0],4],...pairs.slice(1)]])assert.throws(()=>api.setShortNames(bad),/exactly four setup alias pairs/);
 assert.equal(calls.length,0);api.setShortName(pairs[0][0],pairs[0][1]);assert.equal(calls.length,1);assert.equal(calls[0][2].env.RUYI_NATIVE_FIXTURE_ALIAS,'OLDROOT');
});
test('long representation keeps both24s waits and complete original metadata, object and cold verification bodies',()=>{
 const {functionBlock}=require('../lib/source-slice');
 assert.equal((entry.match(/await delay\(24000\)/g)||[]).length,2);assert.match(entry,/timeout:120000/);
 const originalEntry=entry.replace(/async function proveCodeCache[^\n]*\n/,'').replace("'migrationReadBackupHistory','migrationCapsuleCode'","'migrationReadBackupHistory'").replace("await proveCodeCache(api,'cold');",'').replace("const coldCodeLine=restarted.stdout.split(/\\r?\\n/).find(line=>line.startsWith('NATIVE CODE CACHE cold '));assert.ok(coldCodeLine);console.log(coldCodeLine);await proveCodeCache(api,'parent');",'');
 const inverse=originalEntry.replace('{basicMetadata,setShortNames}','{basicMetadata,setShortName}').replace("setShortNames([[live,'OLDROOT'],[path.join(live,'original-directory'),'OLDDIR'],[path.join(live,'original-directory','private.bin'),'OLDBIN.BIN'],[path.join(live,'original-directory','long-empty-alias-file.txt'),'']]);","setShortName(live,'OLDROOT');setShortName(path.join(live,'original-directory'),'OLDDIR');setShortName(path.join(live,'original-directory','private.bin'),'OLDBIN.BIN');setShortName(path.join(live,'original-directory','long-empty-alias-file.txt'),'');");
 assert.equal(sha(inverse),'f5d732c5c143b9bd0ac102196def38ce7b0bef2b54cc686156961cedec755627','the exact complete archived R1 entry returns after only batching inverses');
 assert.ok(functionBlock(entry,'checkObjects').includes("Buffer.from(stream.data,'base64')"));
 assert.match(entry,/setShortNames\(\[\[live,'OLDROOT'\],\[path\.join\(live,'original-directory'\),'OLDDIR'\]/);
 assert.ok(entry.indexOf('setShortNames([[')<entry.indexOf('const before=await api.migrationCapsuleCapturePreserved'));
});
