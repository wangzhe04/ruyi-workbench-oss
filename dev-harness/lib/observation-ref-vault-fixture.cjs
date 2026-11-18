'use strict';
// Real filesystem + real CredentialVault/PrivacyCore. Only OS protector is synthetic.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'../..'),{constBlock}=require('./source-slice'),read=name=>fs.readFileSync(path.join(repo,'ruyi-workbench/app/src',name),'utf8');
const primitives=vm.runInNewContext(read('01i-privacy-rules.js')+'\n'+read('01h-privacy-core.js')+'\n'+read('01m-privacy-regex.js')+'\n'+constBlock(read('01k-credential-vault.js'),'CredentialVault')+'\n({PrivacyCore,PrivacyRegex,CredentialVault});',{require,Buffer,URL,structuredClone,setTimeout,clearTimeout});
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),purpose='observation-message-ref-v2',scopeId='synthetic-session-A',recordId=sha(JSON.stringify(['main-message-ref-v2',scopeId,'synthetic-created-at',0]));
const content=value=>'publicneedle The protected PIN is '+value+'; End.';
const payload=JSON.stringify({version:2,sessionId:scopeId,anchor:sha('synthetic-created-at'),rewindGen:0,epoch:sha('synthetic-body-stat'),revision:sha('synthetic-stream'),ordinal:0,identity:sha('known-row-metadata'),raw:sha(content('3141')),rawEnd:content('3141').length,projected:sha('synthetic-projected-body'),projectedStart:0,projectedEnd:94}).padEnd(1024,' ');
async function atomic(file,value){await fsp.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';await fsp.writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await fsp.rename(temp,file);}
async function fixture(directory,protectorId='A'){
 await fsp.mkdir(directory,{recursive:true});const file=path.join(directory,'credential-vault-v1.json'),wrapping=crypto.createHash('sha256').update('SYNTHETIC_TEST_PROTECTOR_ONLY:'+protectorId).digest(),stats={reads:0,writes:0};
 const store={read:async()=>{stats.reads++;try{return JSON.parse(await fsp.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return primitives.CredentialVault.empty();throw error;}},write:async value=>{stats.writes++;await atomic(file,value);},invalidate(){}};
 const protector={supported:()=>true,run:async(op,input,domain)=>{
  if(op==='protect'){const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',wrapping,nonce);cipher.setAAD(domain);return Buffer.concat([nonce,cipher.update(input),cipher.final(),cipher.getAuthTag()]);}
  if(op!=='unprotect')throw Error('synthetic protector operation');const decipher=crypto.createDecipheriv('aes-256-gcm',wrapping,input.subarray(0,12));decipher.setAAD(domain);decipher.setAuthTag(input.subarray(-16));return Buffer.concat([decipher.update(input.subarray(12,-16)),decipher.final()]);
 }};
 const api=primitives.CredentialVault.create({core:primitives.PrivacyCore,store,protector,size:async()=>{try{return(await fsp.stat(file)).size;}catch(error){if(error.code==='ENOENT')return 0;throw error;}},stamp:async()=>{try{const s=await fsp.stat(file);return`${s.size}:${s.mtimeMs}`;}catch(error){if(error.code==='ENOENT')return'absent';throw error;}}});
 const gateway=vm.runInNewContext(read('03a-privacy-gateway.js')+'\nPrivacyGateway.setHost({data:paths.data,makeStore:file=>({read:async()=>JSON.parse(await fsp.readFile(file,"utf8")),write:value=>atomicWriteJson(file,value)})});PrivacyGateway;',{require,Buffer,structuredClone,URL,PrivacyRegex:primitives.PrivacyRegex,PrivacyCore:{...primitives.PrivacyCore,configHooks:{sealLocal:api.sealLocal,openLocal:api.openLocal}},fsp,path,paths:{data:directory},atomicWriteJson:atomic,setImmediate});
 const config={privacyModeV1:'enhanced',privacyRulesV1:[],providers:[],workDataEncryptionV1:false};gateway.configure(config);
 return{directory,file,api,gateway,config,stats,publish:store.write,read:store.read,close(){api.clear();wrapping.fill(0);}};
}
async function seed(f){
 let projected;
 await f.gateway.withPolicy(scopeId,async()=>{f.gateway.active().scope.protectValue('3141','INTERNAL');projected=await f.gateway.projectSource(content('3141'),true);await f.gateway.beforeRequest({messages:[{role:'user',content:projected.text}]});});
 const sealed=await f.api.sealLocal(payload,purpose,recordId);await atomic(path.join(f.directory,'public-reference.json'),sealed);return{sealed,projected:projected.text};
}
module.exports={fixture,seed,sha,purpose,recordId,scopeId,payload,content,atomic,repo};
if(require.main===module)(async()=>{
 const directory=path.resolve(process.argv[2]),protectorId=process.argv[3];if(!directory.startsWith(path.join(repo,'output')+path.sep))throw Error('child directory outside output');const f=await fixture(directory,protectorId);
 try{const sealed=JSON.parse(await fsp.readFile(path.join(directory,'public-reference.json'),'utf8')),opened=await f.api.openLocal(sealed,purpose,recordId);let projected;await f.gateway.withPolicy(scopeId,async()=>{projected=await f.gateway.projectSource(content('3141'),true);});if(opened!==payload||projected.text.includes('3141')||!projected.text.includes('RUYI_PVT'))throw Error('fresh-process verification failed');console.log(JSON.stringify({opened:true,projectedProtected:true,workDataEncryption:false,writes:f.stats.writes}));}finally{f.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
