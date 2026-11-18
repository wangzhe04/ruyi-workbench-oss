'use strict';
// Synthetic-only primitive, no app server, no inference, no migration/enable.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
async function main(){
 const H=x=>crypto.createHash('sha256').update(x).digest('hex'),server=path.resolve('ruyi-workbench/app/server.js'),scriptPin=process.argv[3],serverPin=process.argv[4];
 if(!/^[a-f0-9]{64}$/.test(scriptPin||'')||!/^[a-f0-9]{64}$/.test(serverPin||'')||H(fs.readFileSync(__filename))!==scriptPin||H(fs.readFileSync(server))!==serverPin)throw Error('study input drift');
 const root=path.resolve(process.argv[2]||'');if(!process.argv[2]||fs.existsSync(root)||path.dirname(root)!==path.resolve('output'))throw Error('new direct output root required');
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'OWNER.json'),JSON.stringify({owner:'root-atime-study',nonce:crypto.randomBytes(32).toString('hex')})+'\n',{flag:'wx'});
 const home=path.join(root,'home'),base=path.join(root,'data'),fixture=path.join(base,'nested');fs.mkdirSync(fixture,{recursive:true});fs.writeFileSync(path.join(fixture,'sample.txt'),'synthetic\n',{flag:'wx'});
 const env=require('../lib/release-checks').releaseEnvironment(home,base);for(const k of Object.keys(process.env))if(!Object.hasOwn(env,k))delete process.env[k];Object.assign(process.env,env,{RUYI_DISABLE_SEMANTIC:'1'});
 const api=require('../lib/server-internals').loadServerInternals(['migrationCapsuleCapturePreserved','MigrationHooks','flushWorkbenchLogs']);
 const receipt={schema:1,status:'RUNNING',rows:[],limits:['Synthetic standalone primitive; no full service, model or encrypted setup.','Actual native capture readback is sampled; no mutation of product source.']};
 try{
  const snap=async()=>{const result=await api.migrationCapsuleCapturePreserved(base,crypto.randomBytes(32).toString('hex'));const item=result.entries.find(x=>x.rel==='');if(!item||!Array.isArray(item.times))throw Error('root snapshot missing');return item.times.slice();};
  const check=()=>{if(api.MigrationHooks.helperMayStillRun()!==false)throw Error('native helper unknown');};
  const ops=[['control',async()=>{}],['lstat',async()=>{await fsp.lstat(base,{bigint:true});}],['realpath',async()=>{await fsp.realpath(base);}],['root-and-child-realpath',async()=>{await fsp.lstat(base,{bigint:true});await fsp.realpath(base);await fsp.lstat(fixture,{bigint:true});await fsp.realpath(fixture);}]];
  for(const [name,op] of ops){const old=new Date('2020-01-01T00:00:00.000Z'),st=await fsp.stat(base);await fsp.utimes(base,old,st.mtime);const before=await snap();check();await op();const after=await snap();check();receipt.rows.push({operation:name,changed:before.map((x,i)=>x!==after[i]),beforeAccess:before[1],afterAccess:after[1]});}
  receipt.status='COMPLETE_SYNTHETIC_STUDY';
 }catch(e){receipt.status='FAIL_RETAIN';receipt.errorCode=typeof e.code==='string'?e.code:'study.failed';process.exitCode=1;}
 finally{try{await api.flushWorkbenchLogs({allowFailure:false});}catch{receipt.logCleanup='unknown';process.exitCode=1;}receipt.helperKnownStopped=api.MigrationHooks.helperMayStillRun()===false;receipt.bindingsStable=H(fs.readFileSync(__filename))===scriptPin&&H(fs.readFileSync(server))===serverPin;if(!receipt.bindingsStable)process.exitCode=1;fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}
 console.log(JSON.stringify({status:receipt.status,rows:receipt.rows,helperKnownStopped:receipt.helperKnownStopped}));
}
main().catch(()=>{console.error('study failed');process.exitCode=1;});
