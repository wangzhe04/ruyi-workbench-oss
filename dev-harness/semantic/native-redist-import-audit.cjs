'use strict';
// Read-only PE/dumpbin metadata audit: never loads a candidate DLL or native model.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),a=require('node:assert/strict');
const out=path.resolve(process.argv[2]||'output/semantic-rank-redist-audit-r1');
if(fs.existsSync(out))throw Error('Use a fresh audit output.');fs.mkdirSync(out,{recursive:true});
const native='C:/r31-native-headless-research/build-rank-buffer/bin';
const vs='C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools';
const redist=vs+'/VC/Redist/MSVC/14.44.35112',crt=redist+'/x64/Microsoft.VC143.CRT',omp=redist+'/x64/Microsoft.VC143.OpenMP';
const sdk='C:/Program Files (x86)/Windows Kits/10/Redist/ucrt/DLLs/x64';
const dumpbin=vs+'/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64/dumpbin.exe';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const info=file=>({file,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))});
class PE{
 constructor(file){this.file=file;this.b=fs.readFileSync(file);const b=this.b;a.equal(b.readUInt16LE(0),0x5a4d);const p=b.readUInt32LE(0x3c);a.equal(b.readUInt32LE(p),0x4550);this.machine=b.readUInt16LE(p+4);a.equal(this.machine,0x8664);const opt=p+24;a.equal(b.readUInt16LE(opt),0x20b);this.imageBase=b.readBigUInt64LE(opt+24);this.headers=b.readUInt32LE(opt+60);this.sections=[];const count=b.readUInt16LE(p+6),start=opt+b.readUInt16LE(p+20);for(let i=0;i<count;i++){const s=start+i*40;this.sections.push({rva:b.readUInt32LE(s+12),size:b.readUInt32LE(s+8),rawSize:b.readUInt32LE(s+16),raw:b.readUInt32LE(s+20)});}this.dir=opt+112;this.imports=[];this.exports=new Set();this.forwarders=[];this.parseImports();this.parseExports();}
 offset(rva){a(Number.isSafeInteger(rva)&&rva>=0);if(rva<this.headers)return rva;const s=this.sections.find(s=>rva>=s.rva&&rva<s.rva+Math.max(s.size,s.rawSize));a(s,'unmapped RVA');const delta=rva-s.rva;a(delta<s.rawSize);return s.raw+delta;}
 string(rva){const start=this.offset(rva),end=this.b.indexOf(0,start);a(end>=start&&end-start<32768);return this.b.toString('ascii',start,end);}
 directory(n){return {rva:this.b.readUInt32LE(this.dir+n*8),size:this.b.readUInt32LE(this.dir+n*8+4)};}
 thunks(rva){const items=[],start=this.offset(rva);for(let i=0;i<200000;i++){const v=this.b.readBigUInt64LE(start+8*i);if(!v)return items;if(v&(1n<<63n))items.push('#'+Number(v&65535n));else{a(v<0x100000000n);items.push(this.string(Number(v)+2));}}throw Error('thunk bound');}
 parseImports(){const d=this.directory(1);if(d.rva){const start=this.offset(d.rva);for(let i=0;i<4096;i++){const o=start+20*i,fields=Array.from({length:5},(_,k)=>this.b.readUInt32LE(o+4*k));if(fields.every(x=>!x))break;this.imports.push({name:this.string(fields[3]),delay:false,symbols:this.thunks(fields[0]||fields[4])});}}
  const delay=this.directory(13);if(delay.rva){const start=this.offset(delay.rva);for(let i=0;i<4096;i++){const o=start+32*i,f=Array.from({length:8},(_,k)=>this.b.readUInt32LE(o+4*k));if(f.every(x=>!x))break;const rva=v=>f[0]&1?v:Number(BigInt(v)-this.imageBase);this.imports.push({name:this.string(rva(f[1])),delay:true,symbols:this.thunks(rva(f[4]||f[3]))});}}}
 parseExports(){const d=this.directory(0);if(!d.rva)return;const o=this.offset(d.rva),base=this.b.readUInt32LE(o+16),n=this.b.readUInt32LE(o+20),named=this.b.readUInt32LE(o+24),func=this.offset(this.b.readUInt32LE(o+28)),names=this.offset(this.b.readUInt32LE(o+32)),ord=this.offset(this.b.readUInt32LE(o+36));a(n<200000&&named<200000);for(let i=0;i<n;i++){const rva=this.b.readUInt32LE(func+4*i);if(rva)this.exports.add('#'+(base+i));if(rva>=d.rva&&rva<d.rva+d.size)this.forwarders.push({ordinal:base+i,target:this.string(rva)});}for(let i=0;i<named;i++){this.exports.add(this.string(this.b.readUInt32LE(names+4*i)));a(this.b.readUInt16LE(ord+2*i)<n);}}
}
const inventory=JSON.parse(fs.readFileSync('output/native-headless-qwen-research/rank-buffer-inventory.json'));
const nativeFiles=inventory.map(x=>{const f=path.join(native,x.path),row=info(f);a.equal(row.sha256,x.sha256);a.equal(row.bytes,x.bytes);return f;});
const redistFiles=[...fs.readdirSync(crt).filter(x=>x.toLowerCase().endsWith('.dll')).map(x=>path.join(crt,x)),...fs.readdirSync(omp).filter(x=>x.toLowerCase().endsWith('.dll')).map(x=>path.join(omp,x))];
const ucrtFiles=fs.readdirSync(sdk).filter(x=>x.toLowerCase().endsWith('.dll')).map(x=>path.join(sdk,x));
const modules=new Map(),rows=[];const metadataFiles=[...nativeFiles,...redistFiles,...ucrtFiles];
for(const file of metadataFiles){const pe=new PE(file);modules.set(path.basename(file).toLowerCase(),pe);const category=nativeFiles.includes(file)?'native':redistFiles.includes(file)?'vc-redist':'sdk-ucrt';const row={...info(file),category,machine:'AMD64',imports:pe.imports.map(x=>({name:x.name,delay:x.delay,symbolCount:x.symbols.length})),forwardedExports:pe.forwarders};rows.push(row);}
const dumpbinLogs=[];
for(const file of [...nativeFiles,...redistFiles]){const res=cp.spawnSync(dumpbin,['/NOLOGO','/DEPENDENTS',file],{encoding:'utf8',windowsHide:true,timeout:20000});a.equal(res.status,0);const text=res.stdout;const found=[...text.matchAll(/^\s+([A-Za-z0-9_.-]+\.dll)\s*$/gmi)].map(x=>x[1].toLowerCase());const expected=modules.get(path.basename(file).toLowerCase()).imports.map(x=>x.name.toLowerCase());a.deepEqual([...new Set(found)].sort(),[...new Set(expected)].sort(),file);dumpbinLogs.push({file,stdout:text,exitCode:res.status});}
fs.writeFileSync(path.join(out,'dumpbin-dependents.json'),JSON.stringify({tool:info(dumpbin),runs:dumpbinLogs},null,2)+'\n',{flag:'wx'});
const required=new Set(nativeFiles.map(f=>path.basename(f).toLowerCase())),queue=[...required],system=new Set(),unresolved=new Set(),symbolFailures=[];
const osNames=new Set(['kernel32.dll','ntdll.dll','ws2_32.dll','advapi32.dll','bcrypt.dll','bcryptprimitives.dll','user32.dll','shell32.dll','ole32.dll','oleaut32.dll','iphlpapi.dll','psapi.dll','dbghelp.dll','winmm.dll','version.dll','shlwapi.dll']);
for(let q=0;q<queue.length;q++){
 const pe=modules.get(queue[q]);a(pe);
 for(const dependency of pe.imports){const name=dependency.name.toLowerCase();
  if(name.startsWith('api-ms-win-')||name.startsWith('ext-ms-win-')||osNames.has(name)||name==='ucrtbase.dll'){system.add(name);continue;}
  const target=modules.get(name);if(!target){unresolved.add(name);continue;}
  for(const symbol of dependency.symbols)if(!target.exports.has(symbol))symbolFailures.push({from:path.basename(pe.file),to:name,symbol});
  if(!required.has(name)){required.add(name);queue.push(name);}
 }
}
const selectedRedist=rows.filter(x=>x.category==='vc-redist'&&required.has(path.basename(x.file).toLowerCase()));
const allRedist=rows.filter(x=>x.category==='vc-redist');
const bytes=items=>items.reduce((n,x)=>n+x.bytes,0),nativeBytes=bytes(rows.filter(x=>x.category==='native'));
// PowerShell retrieves version-resource metadata only, with literal fixed paths.
const ps='$ErrorActionPreference="Stop"; $files=@('+[...redistFiles,...ucrtFiles,redist+'/vc_redist.x64.exe'].map(f=>"'"+f.replaceAll("'","''")+"'").join(',')+'); @($files | ForEach-Object {$x=Get-Item -LiteralPath $_; [pscustomobject]@{file=$x.FullName;fileVersion=$x.VersionInfo.FileVersion;productVersion=$x.VersionInfo.ProductVersion}}) | ConvertTo-Json -Depth 3';
const versionRun=cp.spawnSync('powershell.exe',['-NoProfile','-Command',ps],{encoding:'utf8',windowsHide:true,timeout:30000});a.equal(versionRun.status,0);
const versions=JSON.parse(versionRun.stdout);for(const r of rows){const v=versions.find(x=>x.file.replaceAll('\\','/').toLowerCase()===r.file.replaceAll('\\','/').toLowerCase());if(v){r.fileVersion=v.fileVersion;r.productVersion=v.productVersion;}}
const packageFile='C:/ProgramData/Microsoft/VisualStudio/Packages/Microsoft.VisualStudio.Product.BuildTools,version=17.14.37614.0/_package.json';
const packageJson=JSON.parse(fs.readFileSync(packageFile));
const report={schemaVersion:1,status:unresolved.size||symbolFailures.length?'STATIC_CLOSURE_PENDING':'PASS_STATIC_IMPORT_CLOSURE_WITH_OS_AND_LICENSE_PREREQUISITES',modelsRun:0,compiled:false,loadedCandidateDlls:false,copiedFromSystem32:false,installed:false,downloaded:false,tool:info(dumpbin),sourceInventory:info('output/native-headless-qwen-research/rank-buffer-inventory.json'),nativeBytes,files:rows,requiredNonOsFiles:[...required],requiredRedist:selectedRedist,systemProvidedDependencies:[...system].sort(),unresolved:[...unresolved],symbolFailures,
 plans:{staticMinimum:{nativeFiles:8,redistFiles:selectedRedist.length,redistBytes:bytes(selectedRedist),totalBytes:nativeBytes+bytes(selectedRedist),scope:'Normal/delay PE import closure only, starting all eight fixed native modules including known dynamic modules; not an execution-tested universal minimum.'},conservativeWindows10Plus:{nativeFiles:8,crtAndOpenmpFiles:allRedist.length,crtAndOpenmpBytes:bytes(allRedist),totalBytes:nativeBytes+bytes(allRedist),scope:'All ten x64 VC143.CRT files plus x64 OpenMP vcomp140 from official Redist, adjacent to executable; system Windows10/11 UCRT remains an OS prerequisite. License/clean-machine/multiCPU gates pending.'},optionalSdkUcrt:{files:ucrtFiles.length,bytes:bytes(rows.filter(x=>x.category==='sdk-ucrt')),totalWithAllCrtAndNative:nativeBytes+bytes(allRedist)+bytes(rows.filter(x=>x.category==='sdk-ucrt')),scope:'Inventory only, not adopted. Windows10/11 always use OS UCRT; adding these SDK files does not override that or create broader OS compatibility.'}},
 localLicenseMetadata:{redistVersionPointer:info(vs+'/VC/Auxiliary/Build/Microsoft.VCRedistVersion.default.txt'),buildToolsPackageMetadata:info(packageFile),packageLicenseUrls:[...new Set(packageJson.localizedResources.map(x=>x.license).filter(Boolean))],standaloneLicenseOrRedistTextFoundUnderRedist:false,fullTermsBytesRetained:false,redistributableInstaller:info(redist+'/vc_redist.x64.exe')},
 limits:['Static imports include delay imports and imported named/ordinal symbols for resolved non-OS dependencies; no clean VM/loader/model run.', 'LoadLibrary/GetProcAddress branches and optional plugins cannot be proven exhaustive by import tables. All existing eight native modules retained; no native dependency trimming claimed.', 'MSVC Redist folder14.44.35112 contains actual14.44.35211.0 binaries. Toolset is14.44.35207. Directory name is not the binary version.', 'Full applicable BuildTools/runtime license text and owner distribution authority remain pending; official REDIST/docs provide scope, not a legal conclusion.', 'No System32 copy, registry install, global environment edit, model or frozen runtime evidence modified.', 'AVX2-only native research is not portable CPU-dispatch/Windows platform qualification.']};
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,output:out,nativeBytes,redistMinimum:report.plans.staticMinimum,conservative:report.plans.conservativeWindows10Plus,sdkUcrt:report.plans.optionalSdkUcrt,system:report.systemProvidedDependencies,unresolved:report.unresolved,symbolFailures:report.symbolFailures.length}));
