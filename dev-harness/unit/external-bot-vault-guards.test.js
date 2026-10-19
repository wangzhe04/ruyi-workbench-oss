'use strict';
const {test,after}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {constBlock,functionBlock}=require('../lib/source-slice');
const guard=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/03-bridge-guard.js'),'utf8');
const tools=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/11-native-tools.js'),'utf8');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ruyi-bot-vault-guards-'));const data=path.join(root,'data'),alias=path.join(root,'legacy');fs.mkdirSync(data);
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const context=vm.createContext({fs,fsp:fs.promises,path,dataRoot:()=>data,dataRootAliases:()=>[alias],_dataRootReal:data});
vm.runInContext([functionBlock(guard,'pathWithinRoot'),functionBlock(guard,'isSensitiveDataPath'),constBlock(guard,'WRITE_PROTECTED_DATA_DIRS'),constBlock(guard,'WRITE_PROTECTED_DATA_FILES'),functionBlock(guard,'isWriteProtectedDataPath'),constBlock(guard,'SENSITIVE_HARDLINK_FILES'),functionBlock(guard,'sensitiveFileIdentities'),functionBlock(guard,'isSensitiveHardlinkStat'),functionBlock(tools,'sensitiveGlobsForRg')].join('\n'),context);
test('vault and atomic-temp family are equally read/write sensitive through the current root, legacy alias and NTFS suffixes',()=>{
 for(const base of [data,alias])for(const name of ['external-bot-credentials.json','external-bot-credentials.json.123.random.tmp','external-bot-credentials.json::$DATA','external-bot-credentials.json.','external-bots/state-v1.json','external-bots/state-v1.json.123.random.tmp']){
  const file=path.join(base,name);assert.equal(context.isSensitiveDataPath(file),true,file);assert.equal(context.isWriteProtectedDataPath(file),true,file);
 }
 assert.equal(context.isSensitiveDataPath(path.join(data,'checkpoints','s1','before.txt')),false);assert.equal(context.isSensitiveDataPath(path.join(root,'ordinary.txt')),false);
 assert.equal(context.isSensitiveDataPath(path.join(root,'project','external-bot-credentials.json')),false);assert.equal(context.isWriteProtectedDataPath(path.join(root,'project','external-bots','state-v1.json')),false);
 const globs=context.sensitiveGlobsForRg(root);assert.ok(globs.includes('!/data/external-bot-credentials.json'));assert.ok(globs.includes('!/data/external-bot-credentials.json*'));assert.ok(globs.includes('!/legacy/external-bot-credentials.json*'));
 assert.ok(globs.includes('!/data/external-bots'));assert.ok(globs.includes('!/legacy/external-bots'));
});
test('vault and pending-temp hardlinks cannot evade the existing inode gate; unrelated hardlinks stay readable',async t=>{
 const original=path.join(data,'external-bot-credentials.json'),temp=original+'.123.random.tmp';fs.writeFileSync(original,'encrypted synthetic envelope');fs.writeFileSync(temp,'encrypted synthetic temporary envelope');
 const a=path.join(root,'alias-a'),b=path.join(root,'alias-b'),ordinary=path.join(root,'ordinary'),ordinaryLink=path.join(root,'ordinary-link');fs.writeFileSync(ordinary,'normal user text');
 try{fs.linkSync(original,a);fs.linkSync(temp,b);fs.linkSync(ordinary,ordinaryLink);}catch(error){t.skip('hardlinks unavailable: '+error.code);return;}
 const identities=await context.sensitiveFileIdentities();assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(a,{bigint:true}),identities),true);assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(b,{bigint:true}),identities),true);assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(ordinaryLink,{bigint:true}),identities),false);
 const botDir=path.join(data,'external-bots');fs.mkdirSync(botDir);for(const name of ['state-v1.json','state-v1.json.123.random.tmp']){const source=path.join(botDir,name),link=path.join(root,'hard-'+name);fs.writeFileSync(source,'owner authorization');fs.linkSync(source,link);assert.equal(await context.isSensitiveHardlinkStat(await fs.promises.stat(link,{bigint:true}),await context.sensitiveFileIdentities()),true);}
});
