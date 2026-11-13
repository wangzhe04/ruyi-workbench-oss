'use strict';
// Real isolated session files and in-memory MCP transport gates; no helper, native process or GUI.
const { test, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-image-history-'));
for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMPDIR']) { process.env[key] = path.join(root,key); fs.mkdirSync(process.env[key]); }
process.env.RUYI_HOME = path.join(root,'data'); process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS = '1';
fs.mkdirSync(process.env.RUYI_HOME); fs.writeFileSync(path.join(process.env.RUYI_HOME,'config.json'), JSON.stringify({configSchema:9,credentialEncryptionV1:false,includeWorkbenchMcp:false,autoImportClaudeCodeMcp:false,enableMcpDropIn:false}));
const internals = require('../lib/server-internals').loadServerInternals(['DesktopExecutionRuntime','McpStdioClient','McpHttpClient','createSession','loadSession','saveSession','sessionBodyPaths','sessionPath'], { withEval:true, testPlatform:'darwin' });
const { DesktopExecutionRuntime: runtime, McpStdioClient, McpHttpClient, createSession, loadSession, saveSession, sessionBodyPaths, sessionPath } = internals;
after(() => fs.rmSync(root,{recursive:true,force:true}));
const clone = value => JSON.parse(JSON.stringify(value));
function imageHistory() {
  const assistant = {role:'assistant',content:'',tool_calls:[{id:'one',function:{name:'image',arguments:'{}'}},{id:'two',function:{name:'wait',arguments:'{}'}}]};
  const first={role:'tool',tool_call_id:'one',content:'image received'}, second={role:'tool',tool_call_id:'two',content:'wait received'};
  const image={role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]};
  return {assistant,first,second,image,history:[assistant,first,image],batch:{assistant,start:1}};
}
async function fixture() {
  const s=await createSession({title:'protected image history',cwd:root});s.turnSeq=1;s.messages.push({role:'user',content:'fixture'});
  s.providerHistory=imageHistory().history;await saveSession(s,{requirePersisted:true});return s;
}
test('candidate inserts every later tool reply before already persisted images and returns actual tool index',()=>{
  const f=imageHistory();const index=runtime.appendMainTool(f.history,f.batch,f.second);
  assert.equal(index,2);assert.deepEqual(f.history.map(row=>row.role),['assistant','tool','tool','user']);assert.equal(f.history[3],f.image);
  assert.equal(runtime.mainDeliveryMatches(f.history,{index:1,row:JSON.stringify(f.first),images:[JSON.stringify(f.image.content)],imageIndices:[3]}),true);
});
test('batch anchor and requested call identity must remain current before inserting history',()=>{
  const f=imageHistory();assert.throws(()=>runtime.appendMainTool(f.history,{assistant:clone(f.assistant),start:1},f.second),{code:'execution_history_changed'});
  assert.throws(()=>runtime.appendMainTool(f.history,f.batch,{role:'tool',tool_call_id:'not_requested',content:'x'}),{code:'execution_history_changed'});
  assert.deepEqual(f.history.map(row=>row.role),['assistant','tool','user']);
});
test('real stale metadata snapshot cannot overwrite an inserted tool result or its image',async()=>{
  const s=await fixture(),stale=await loadSession(s.id),f=imageHistory();
  s.providerHistory=[f.assistant,f.first,f.second,f.image];await saveSession(s,{requirePersisted:true});
  stale.title='obsolete rename';await assert.rejects(saveSession(stale,{requirePersisted:true}),{code:'SESSION_PROVIDER_HISTORY_CONFLICT'});
  const disk=await loadSession(s.id);assert.deepEqual(disk.providerHistory,s.providerHistory);assert.notEqual(disk.title,'obsolete rename');
  disk.title='fresh rename';await saveSession(disk,{requirePersisted:true});assert.equal((await loadSession(s.id)).title,'fresh rename');
});
test('stamped disk remains protected after candidate flag off and rejects unstamped stale object',async()=>{
  const s=await fixture(),stale=clone(s);delete stale.providerHistoryRevision;process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS='0';
  try { await assert.rejects(saveSession(stale,{requirePersisted:true}),{code:'SESSION_PROVIDER_HISTORY_CONFLICT'}); }
  finally {process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS='1';}
  assert.deepEqual((await loadSession(s.id)).providerHistory,s.providerHistory);
});
test('stamp zero is an existing protected revision, not absence',async()=>{
  process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS='0';const s=await createSession({title:'legacy zero',cwd:root});const stale=clone(s);
  process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS='1';await saveSession(s,{requirePersisted:true});assert.equal(s.providerHistoryRevision,0);
  await assert.rejects(saveSession(stale,{requirePersisted:true}),{code:'SESSION_PROVIDER_HISTORY_CONFLICT'});
});
test('queued same-object writer takes revision/body/head from one chain-time snapshot',async()=>{
  const s=await fixture(),f=imageHistory();
  const first=saveSession(s,{requirePersisted:true});s.providerHistory=[f.assistant,f.first,f.second,f.image];const second=saveSession(s,{requirePersisted:true});
  await Promise.all([first,second]);const disk=await loadSession(s.id);assert.deepEqual(disk.providerHistory,s.providerHistory);
  assert.equal(disk.providerHistoryRevision,s.providerHistoryRevision);assert.equal(JSON.parse(fs.readFileSync(sessionPath(s.id))).providerHistoryCount,4);
});
test('missing, null and malformed existing heads never reset an initialized revision',async()=>{
  for(const value of [null,'null','{invalid']) {
    const s=await fixture(),file=sessionPath(s.id);
    if(value===null)fs.unlinkSync(file);else fs.writeFileSync(file,value);
    await assert.rejects(saveSession(s,{requirePersisted:true}));
    if(value===null)assert.equal(fs.existsSync(file),false);else assert.equal(fs.readFileSync(file,'utf8'),value);
  }
});
test('invalid or future revisions refuse before replacing body; rewrite overflow is bounded',async()=>{
  const s=await fixture(),file=sessionPath(s.id),body=sessionBodyPaths(s.id).provider,before=fs.readFileSync(body);
  for(const revision of ['0',null,-1,Number.MAX_SAFE_INTEGER+1]) {
    const bad=clone(s);bad.providerHistoryRevision=revision;await assert.rejects(saveSession(bad,{requirePersisted:true}),{code:'SESSION_PROVIDER_HISTORY_CONFLICT'});
    assert.deepEqual(fs.readFileSync(body),before);
  }
  const head=JSON.parse(fs.readFileSync(file));head.providerHistoryRevision=Number.MAX_SAFE_INTEGER;head.providerHistoryCommit.revision=Number.MAX_SAFE_INTEGER;fs.writeFileSync(file,JSON.stringify(head));
  s.providerHistoryRevision=Number.MAX_SAFE_INTEGER;s.providerHistoryCommit=clone(head.providerHistoryCommit);s.providerHistory.push({role:'user',content:'overflow'});
  await assert.rejects(saveSession(s,{requirePersisted:true}),{code:'SESSION_PROVIDER_HISTORY_CAPACITY'});assert.deepEqual(fs.readFileSync(body),before);
});
test('head commit updates live revision even if a later body stat step fails',async()=>{
  const s=await fixture(),before=s.providerHistoryRevision;s.providerHistory.push({role:'user',content:'committed before stat fault'});
  internals.__eval("globalThis.__imageOriginalStamp = sessionBodyFileStamp; sessionBodyFileStamp = async () => { throw new Error('isolated post-commit stat fault'); };");
  try {await assert.rejects(saveSession(s,{requirePersisted:true}),/post-commit stat fault/);}
  finally {internals.__eval('sessionBodyFileStamp = globalThis.__imageOriginalStamp; delete globalThis.__imageOriginalStamp;');}
  const head=JSON.parse(fs.readFileSync(sessionPath(s.id)));assert.equal(head.providerHistoryRevision,before+1);assert.equal(s.providerHistoryRevision,head.providerHistoryRevision);
  const disk=await loadSession(s.id);assert.equal(disk.providerHistory.at(-1).content,'committed before stat fault');
});
test('actual branded wrapper cannot use fabricated meta/checker as a private root dispatch permit',async()=>{
  const client=new McpStdioClient({id:'wrapped-alias',command:'python',args:['fixture_wrapper.py']});client.serverInfo={name:'AI Computer Control'};
  let writes=0;client.child={stdin:{writable:true,write(){writes++;}}};client.executionContextRequired=true;
  const options={meta:{'org.ruyi.workbench/execution-v1':{schema:1}},executionCheck(){}};
  const result=await client.callTool('wait',{seconds:0},1000,options);assert.equal(result.code,'execution_metadata_required');assert.equal(result.action_sent,false);
  await assert.rejects(client._rpc('tools/call',{name:'wait',arguments:{seconds:0}},1000,options),{code:'execution_metadata_required'});assert.equal(writes,0);
  assert.equal(runtime.callRefusal(client,'execution_receipt',{invocation_id:'0'.repeat(32)}),null);
  const remote=new McpHttpClient({id:'remote',url:'http://127.0.0.1:1'});remote.serverInfo={name:'AI Computer Control'};
  assert.equal((await remote.callTool('wait',{seconds:0},1000,options)).code,'execution_metadata_required');
});

test('same-length protected rewrite rolls back both bodies when head commit fails',async()=>{
  const s=await fixture(),old=clone(s.providerHistory),revision=s.providerHistoryRevision;
  s.providerHistory[1].content='uncommitted same-count replacement';
  internals.__eval(`globalThis.__imageAtomic=atomicWriteJson;atomicWriteJson=async function(file,value,options){if(file===${JSON.stringify(sessionPath(s.id))})throw new Error('isolated head commit failure');return globalThis.__imageAtomic(file,value,options);};`);
  try {await assert.rejects(saveSession(s,{requirePersisted:true}),/head commit failure/);}
  finally {internals.__eval('atomicWriteJson=globalThis.__imageAtomic;delete globalThis.__imageAtomic;');}
  const disk=await loadSession(s.id);assert.deepEqual(disk.providerHistory,old);assert.equal(disk.providerHistoryRevision,revision);
});
test('cold reader restores simulated same-count interrupted rewrite by committed body hashes rather than line count',async()=>{
  const s=await fixture(),bp=sessionBodyPaths(s.id),old=clone(s.providerHistory);
  fs.copyFileSync(bp.messages,bp.messages+'.prevbody');fs.copyFileSync(bp.provider,bp.provider+'.prevbody');
  const changed=clone(old);changed[1].content='crashed same-count rewrite';
  fs.writeFileSync(bp.provider,changed.map(row=>JSON.stringify(row)).join('\n')+'\n');
  internals.__eval(`dropSessionBodyState(${JSON.stringify(s.id)});`);
  const disk=await loadSession(s.id);assert.deepEqual(disk.providerHistory,old);assert.equal(disk.providerHistoryRevision,s.providerHistoryRevision);
});
test('either surviving protection field refuses legacy downgrade with flag off',async()=>{
  for(const removed of ['providerHistoryRevision','providerHistoryCommit']) {
    const s=await fixture(),file=sessionPath(s.id),bp=sessionBodyPaths(s.id),before=fs.readFileSync(bp.provider),head=JSON.parse(fs.readFileSync(file));
    delete head[removed];fs.writeFileSync(file,JSON.stringify(head));const stale=clone(s);delete stale.providerHistoryRevision;delete stale.providerHistoryCommit;
    process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS='0';
    try {await assert.rejects(saveSession(stale,{requirePersisted:true}),{code:'SESSION_PROVIDER_HISTORY_CONFLICT'});}
    finally {process.env.RUYI_DESKTOP_EXECUTION_RECEIPTS='1';}
    assert.deepEqual(fs.readFileSync(bp.provider),before);assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file)),removed),false);
    fs.writeFileSync(file+'.v1bak',JSON.stringify({...stale,messages:[{role:'user',content:'stale backup'}]}));
    assert.equal(await loadSession(s.id),null);assert.deepEqual(fs.readFileSync(bp.provider+'.corrupt'),before);
  }
});
test('cached append and metadata saves refuse corrupted head commit or actual body',async()=>{
  for(const corruption of ['missing_commit','wrong_hash','body']) {
    const s=await fixture(),file=sessionPath(s.id),bp=sessionBodyPaths(s.id),head=JSON.parse(fs.readFileSync(file));
    if(corruption==='body')fs.writeFileSync(bp.provider,fs.readFileSync(bp.provider,'utf8').replace('image received','false received'));
    else {if(corruption==='missing_commit')delete head.providerHistoryCommit;else head.providerHistoryCommit.providerSha256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(head));}
    const before=fs.readFileSync(bp.provider),headBefore=fs.readFileSync(file);s.title='must refuse';
    await assert.rejects(saveSession(s,{requirePersisted:true}),{code:corruption==='body'?'SESSION_BODY_UNVERIFIED':'SESSION_PROVIDER_HISTORY_CONFLICT'});
    assert.deepEqual(fs.readFileSync(bp.provider),before);assert.deepEqual(fs.readFileSync(file),headBefore);
  }
});
test('partial rollback copy failure preserves both snapshots for a later cold recovery',async()=>{
  const s=await fixture(),bp=sessionBodyPaths(s.id),old=clone(s.providerHistory);s.providerHistory[1].content='uncommitted replacement';
  const originalCopy=fs.promises.copyFile;let failed=false;
  fs.promises.copyFile=async function(from,to,...args){if(!failed&&from===bp.provider+'.prevbody'){failed=true;throw Object.assign(new Error('isolated rollback copy failure'),{code:'EACCES'});}return originalCopy.call(this,from,to,...args);};
  internals.__eval(`globalThis.__imageAtomic=atomicWriteJson;atomicWriteJson=async function(file,value,options){if(file===${JSON.stringify(sessionPath(s.id))})throw new Error('isolated head commit failure');return globalThis.__imageAtomic(file,value,options);};`);
  try {await assert.rejects(saveSession(s,{requirePersisted:true}),/head commit failure/);}
  finally {fs.promises.copyFile=originalCopy;internals.__eval('atomicWriteJson=globalThis.__imageAtomic;delete globalThis.__imageAtomic;');}
  assert.equal(failed,true);assert.equal(fs.existsSync(bp.messages+'.prevbody'),true);assert.equal(fs.existsSync(bp.provider+'.prevbody'),true);
  const disk=await loadSession(s.id);assert.deepEqual(disk.providerHistory,old);
});
test('exception after real head publication does not roll committed bodies or live revision back',async()=>{
  const s=await fixture(),revision=s.providerHistoryRevision;s.providerHistory[1].content='published same-count replacement';
  internals.__eval(`globalThis.__imageAtomic=atomicWriteJson;atomicWriteJson=async function(file,value,options){const result=await globalThis.__imageAtomic(file,value,options);if(file===${JSON.stringify(sessionPath(s.id))})throw new Error('isolated lost head acknowledgement');return result;};`);
  try {await assert.rejects(saveSession(s,{requirePersisted:true}),/lost head acknowledgement/);}
  finally {internals.__eval('atomicWriteJson=globalThis.__imageAtomic;delete globalThis.__imageAtomic;');}
  assert.equal(s.providerHistoryRevision,revision+1);const disk=await loadSession(s.id);assert.equal(disk.providerHistory[1].content,'published same-count replacement');
  assert.equal(disk.providerHistoryRevision,s.providerHistoryRevision);
});
test('write-chain recovery removes only verified uncommitted tails on either body',async()=>{
  for(const files of [['messages'],['provider'],['messages','provider']]) {
    const s=await fixture(),bp=sessionBodyPaths(s.id),old=clone(s.providerHistory),messages=clone(s.messages);
    for(const field of files)fs.appendFileSync(bp[field],JSON.stringify({role:'user',content:'uncommitted tail'})+'\n');
    s.title='fresh metadata';await saveSession(s,{requirePersisted:true});
    const disk=await loadSession(s.id);assert.deepEqual(disk.providerHistory,old);assert.deepEqual(disk.messages,messages);
    assert.equal(disk.title,'fresh metadata');
  }
});
test('failed uncommitted-tail truncation refuses save without blessing the tail',async()=>{
  const s=await fixture(),file=sessionPath(s.id),bp=sessionBodyPaths(s.id),head=fs.readFileSync(file);
  fs.appendFileSync(bp.provider,JSON.stringify({role:'user',content:'uncommitted tail'})+'\n');const body=fs.readFileSync(bp.provider);
  internals.__eval('globalThis.__imageTruncate=truncateSessionBody;truncateSessionBody=async()=>false;');
  try {await assert.rejects(saveSession(s,{requirePersisted:true}),{code:'SESSION_BODY_UNVERIFIED'});}
  finally {internals.__eval('truncateSessionBody=globalThis.__imageTruncate;delete globalThis.__imageTruncate;');}
  assert.deepEqual(fs.readFileSync(file),head);assert.deepEqual(fs.readFileSync(bp.provider),body);
  assert.deepEqual((await loadSession(s.id)).providerHistory,s.providerHistory);
});
test('protected head cannot masquerade as a legacy storage version',async()=>{
  const s=await fixture(),file=sessionPath(s.id),bp=sessionBodyPaths(s.id),head=JSON.parse(fs.readFileSync(file)),before=fs.readFileSync(bp.provider);
  delete head.storageVersion;fs.writeFileSync(file,JSON.stringify(head));
  await assert.rejects(saveSession(s,{requirePersisted:true}),{code:'SESSION_PROVIDER_HISTORY_CONFLICT'});
  assert.equal(await loadSession(s.id),null);assert.deepEqual(fs.readFileSync(bp.provider),before);
});
test('rewind watermark follows actual head publication even when its acknowledgement is lost',async()=>{
  for(const published of [false,true]) {
    const s=await fixture(),gen=Number(s.rewindGen)||0;s.providerHistory[1].content='rewritten during rewind';
    internals.__eval(`globalThis.__imageAtomic=atomicWriteJson;atomicWriteJson=async function(file,value,options){if(file!==${JSON.stringify(sessionPath(s.id))})return globalThis.__imageAtomic(file,value,options);${published?'await globalThis.__imageAtomic(file,value,options);':''}throw new Error('isolated rewind head acknowledgement failure');};`);
    try {await assert.rejects(saveSession(s,{requirePersisted:true,rewindBump:true}),/rewind head acknowledgement failure/);}
    finally {internals.__eval('atomicWriteJson=globalThis.__imageAtomic;delete globalThis.__imageAtomic;');}
    const head=JSON.parse(fs.readFileSync(sessionPath(s.id))),watermark=internals.__eval(`sessionRewindGenHighWater.get(${JSON.stringify(s.id)})||0`);
    assert.equal(head.rewindGen||0,published?gen+1:gen);assert.equal(watermark,published?gen+1:gen);
    assert.equal((await loadSession(s.id)).rewindGen||0,watermark);
  }
});
