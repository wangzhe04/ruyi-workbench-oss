'use strict';
// Synthetic-only primitive, no app server, no inference, no migration/enable.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
async function main(){
 const H=x=>crypto.createHash('sha256').update(x).digest('hex'),server=path.resolve(process.argv[5]||''),scriptPin=process.argv[3],serverPin=process.argv[4];
 if(!/^[a-f0-9]{64}$/.test(scriptPin||'')||!/^[a-f0-9]{64}$/.test(serverPin||'')||H(fs.readFileSync(__filename))!==scriptPin||H(fs.readFileSync(server))!==serverPin)throw Error('study input drift');
 const root=path.resolve(process.argv[2]||'');if(!process.argv[2]||fs.existsSync(root)||path.dirname(root)!==path.resolve('output'))throw Error('new direct output root required');
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'OWNER.json'),JSON.stringify({owner:'root-atime-study',nonce:crypto.randomBytes(32).toString('hex')})+'\n',{flag:'wx'});
 const home=path.join(root,'home'),base=path.join(root,'data'),fixture=path.join(base,'nested');fs.mkdirSync(fixture,{recursive:true});fs.writeFileSync(path.join(fixture,'sample.txt'),'synthetic\n',{flag:'wx'});
 const env=require('../lib/release-checks').releaseEnvironment(home,base);for(const k of Object.keys(process.env))if(!Object.hasOwn(env,k))delete process.env[k];Object.assign(process.env,env,{RUYI_DISABLE_SEMANTIC:'1'});
 const Module=require('node:module'),original=path.resolve('ruyi-workbench/app/server.js'),m=new Module(original,module);m.filename=original;m.paths=Module._nodeModulePaths(path.dirname(original));m._compile(fs.readFileSync(server,'utf8')+'\nmodule.exports.__study={migrationCapsuleCapturePreserved,MigrationHooks,flushWorkbenchLogs};\n',original);const api=m.exports.__study;
 const receipt={schema:1,status:'RUNNING',rows:[],limits:['Synthetic standalone primitive; no full service, model or encrypted setup.','Actual native capture readback is sampled; no mutation of product source.']};
 try{
  const snap=async(dir)=>{const result=await api.migrationCapsuleCapturePreserved(dir,crypto.randomBytes(32).toString('hex'));const item=result.entries.find(x=>x.rel==='');if(!item||!Array.isArray(item.times))throw Error('root snapshot missing');return item.times.slice();};
  const check=()=>{if(api.MigrationHooks.helperMayStillRun()!==false)throw Error('native helper unknown');};
  for(const kind of ['empty','one-file','one-directory','nested']){const dir=path.join(root,'case-'+kind);await fsp.mkdir(dir);if(kind==='one-file')await fsp.writeFile(path.join(dir,'a.txt'),'a');if(kind==='one-directory'||kind==='nested')await fsp.mkdir(path.join(dir,'child'));if(kind==='nested')await fsp.writeFile(path.join(dir,'child','b.txt'),'b');const old=new Date('2020-01-01T00:00:00.000Z'),st=await fsp.stat(dir);await fsp.utimes(dir,old,st.mtime);const directBefore=(await fsp.lstat(dir,{bigint:true})).atimeNs;const before=await snap(dir);check();const directAfter=(await fsp.lstat(dir,{bigint:true})).atimeNs;const after=await snap(dir);check();const fileTimeToNs=x=>BigInt(x)*100n-11644473600000000000n;receipt.rows.push({operation:kind,changed:before.map((x,i)=>x!==after[i]),directBeforeNs:String(directBefore),firstCaptureNs:String(fileTimeToNs(before[1])),directAfterNs:String(directAfter),secondCaptureNs:String(fileTimeToNs(after[1]))});}
  receipt.status='COMPLETE_SYNTHETIC_STUDY';
 }catch(e){receipt.status='FAIL_RETAIN';receipt.errorCode=typeof e.code==='string'?e.code:'study.failed';process.exitCode=1;}
 finally{try{await api.flushWorkbenchLogs({allowFailure:false});}catch{receipt.logCleanup='unknown';process.exitCode=1;}receipt.helperKnownStopped=api.MigrationHooks.helperMayStillRun()===false;receipt.bindingsStable=H(fs.readFileSync(__filename))===scriptPin&&H(fs.readFileSync(server))===serverPin;if(!receipt.bindingsStable)process.exitCode=1;fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}
 console.log(JSON.stringify({status:receipt.status,rows:receipt.rows,helperKnownStopped:receipt.helperKnownStopped}));
}
main().catch(()=>{console.error('study failed');process.exitCode=1;});
