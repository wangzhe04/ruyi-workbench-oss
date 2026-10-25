'use strict';
// Actual source/store/record/lexical/privacy owners. Only the machine key is supplied;
// no DPAPI, service process, provider or native helper runs here.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const draft=path.join(root,'ruyi-workbench/app/src');
const {constBlock,functionBlock}=require(root+'/dev-harness/lib/source-slice');
const {loadWorkDataJournals}=require(root+'/dev-harness/lib/work-data-journals-fixture');
const selected=name=>path.join(draft,name);
const actual=name=>fs.readFileSync(root+'/ruyi-workbench/app/src/'+name,'utf8');
async function fixture(options={}){
  const ownsDirectory=!options.directory,directory=options.directory||await fsp.mkdtemp(path.join(os.tmpdir(),'ruyi-fulltext-unit-')),sessions=path.join(directory,'sessions');await fsp.mkdir(sessions,{recursive:true});
  const fx=loadWorkDataJournals(),master=options.master?Buffer.from(options.master):crypto.randomBytes(32),instanceId=options.instanceId||'a'.repeat(32),keys={unlock:async()=>master,instance:async()=>instanceId};let enabled=options.enabled===true;
  const context={require,Buffer,console,process,Intl,crypto,fs,fsp,path,WorkDataStore:fx.store,WorkDataRecords:fx.WorkDataRecords,WorkDataChunks:fx.chunks,
    workDataKeys:keys,atomicWriteJson:fx.atomicWriteJson,readConfig:async()=>({workDataEncryptionV1:enabled}),paths:{sessions},sessionPath:id=>path.join(sessions,id+'.json'),
    sessionDiskWriteSeq:new Map(),sessionWriteChains:new Map(),sessionDeleteTombstones:new Map(),sessionPermissionModeOverrides:new Map(),sessionDesktopToolsOverrides:new Map()};
  const store=fs.readFileSync(selected('02-session-store.js'),'utf8'),config=actual('01-config.js');
  const names=['sessionBodyPaths','sessionHeadStore','readSessionHeadText','writeSessionHead','sessionDiskWriteSeqOf','sessionFullTextSequence','createSessionFullTextSource'];
  const parts=[constBlock(config,'RESERVED_SESSION_FILE_IDS'),functionBlock(config,'safeSessionId'),
    constBlock(store,'SESSION_STORAGE_VERSION'),constBlock(store,'SESSION_HEAD_ADAPTER_SCHEMA'),constBlock(store,'sessionFullTextHeadWriteSeq'),constBlock(store,'sessionFullTextHeadWrites'),
    ...names.map(name=>functionBlock(store,name)),functionBlock(actual('13d-core-domain-routes.js'),'sessionSearchRowIsNoise'),
    constBlock(actual('06h-retrieval-index.js'),'RETRIEVAL_TEXT_CAP'),functionBlock(actual('06h-retrieval-index.js'),'retrievalTerms')];
  if(parts.some(part=>!part))throw Error('actual source slice missing');
  const api=vm.runInNewContext(parts.join('\n')+'\n({source:createSessionFullTextSource(),writeSessionHead,safeSessionId,noise:sessionSearchRowIsNoise,terms:retrievalTerms})',
    {...context,assertSessionIdForPath:id=>{if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('id invalid');}});
  const hookContext={require,Buffer,Intl,process,fs,fsp,paths:{sessions},workDataKeys:keys,atomicWriteJson:fx.atomicWriteJson,
    WorkDataRootHooks:{mode:value=>value===true},WorkDataMaintenanceHooks:{run:(_kind,work)=>work()},SessionFullTextHooks:{},
    readConfig:context.readConfig,safeSessionId:api.safeSessionId,sessionSearchRowIsNoise:api.noise,retrievalTerms:api.terms,createSessionFullTextSource:()=>api.source,WorkDataStore:fx.store};
  const namespace=vm.runInNewContext(fs.readFileSync(options.module||selected('13ap-session-fulltext-index.js'),'utf8')+'\nSessionFullTextIndex;',hookContext);
  const allowed=new Map(),catalog=[];let scopeRevision=0,projectHook=null,scanHook=null,catalogHook=null;
  const target=fx.privacy.createScope({scopeId:'destination',detector:fx.privacy.createDetector({personal:true,knownSecrets:['secret-needle-value']})});
  const scope=()=>({scopeId:'destination',revision:crypto.createHash('sha256').update(String(scopeRevision)).digest('hex')});
  const host={root:()=>sessions,enabled:async()=>enabled,writeJson:fx.atomicWriteJson,keys,validSessionId:api.safeSessionId,
    catalog:async()=>{if(catalogHook)await catalogHook();return [...catalog];},epoch:api.source.epoch,
    scan:async(id,visit)=>api.source.scan(id,async(row,n)=>{if(scanHook)await scanHook(id,row,n);await visit(row,n);}),sourceSequence:api.source.sequence,
    scope:async()=>scope(),assertScope:(_,proof)=>proof.revision===scope().revision,
    authorize:async id=>allowed.get(id)!==false,assertAuthorized:id=>allowed.get(id)!==false,
    project:async input=>{if(projectHook)await projectHook(input);return {reference:input.reference,snippet:target.protectRaw(input.text).text};},noise:api.noise,terms:api.terms};
  const index=namespace.create(host);
  async function put(id,rows,extra={}){
    context.sessionDiskWriteSeq.set(id,(context.sessionDiskWriteSeq.get(id)||0)+1);context.sessionDeleteTombstones.delete(id);
    if(!catalog.includes(id))catalog.push(id);
    if(extra.legacy){await api.writeSessionHead(id,JSON.stringify({id,messages:rows,...extra.head}));return;}
    const lines=rows.map((row,ordinal)=>{const text=JSON.stringify(row);return enabled?fx.WorkDataRecords.encodeLine(text,master,{instanceId,sessionId:id,kind:'messages',ordinal}):text;});
    await fsp.writeFile(path.join(sessions,id+'.messages.ndjson'),lines.length?lines.join('\n')+'\n':'');
    await api.writeSessionHead(id,JSON.stringify({id,storageVersion:2,messageCount:rows.length,...extra.head}));
  }
  return {directory,sessions,index,host,api,fx,context,hookContext,keys,master,instanceId,catalog,allowed,put,
    project:fn=>projectHook=fn,scan:fn=>scanHook=fn,onCatalog:fn=>catalogHook=fn,changeScope:()=>scopeRevision++,
    restart:()=>namespace.create(host),enable:value=>enabled=value,
    close:async()=>{master.fill(0);if(ownsDirectory){if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('ruyi-fulltext-unit-'))throw Error('fixture cleanup outside owned temp');await fsp.rm(directory,{recursive:true,force:true});}}};
}
module.exports={fixture,root};
