// Setup owns admission and in-memory job progress. The cold worker owns all base
// mutation, durable results and process handoff. A warm server never flips paths.
const WorkDataSetup = (() => {
  const ID = /^[a-f0-9]{48}$/, SHA = /^[a-f0-9]{64}$/;
  const fail = (suffix, statusCode = 409) => Object.assign(Error('work_data_setup.' + suffix), { code:'work_data_setup.' + suffix, apiCode:'work_data_setup.' + suffix, statusCode, retry:false });
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
  const validText = value => typeof value === 'string' && Buffer.from(value).toString('utf8') === value && !value.includes('\0');
  function authority(value) {
    if (!exact(value,['generation','id','mode','sha256']) || Object.keys(value).length !== 4 || !Number.isSafeInteger(value.generation) || value.generation < 0
      || !['plain','encrypted'].includes(value.mode) || (value.generation === 0 ? value.id !== null || value.sha256 !== null : !ID.test(value.id || '') || !SHA.test(value.sha256 || ''))) throw fail('authority_invalid',400);
    return Object.freeze({generation:value.generation,id:value.id,mode:value.mode,sha256:value.sha256});
  }
  const same = (a,b) => a.generation===b.generation && a.id===b.id && a.mode===b.mode && a.sha256===b.sha256;
  async function readJson(req, max = 16384) {
    const chunks=[];let bytes=0;
    try {
      for await (const value of req) { const chunk=Buffer.from(value);bytes+=chunk.length;if(bytes>max) { chunk.fill(0);throw fail('body_too_large',413); }chunks.push(chunk); }
      const raw=Buffer.concat(chunks,bytes);try { const text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))throw fail('body_invalid',400);let parsed;
        try { parsed=text.trim()?JSON.parse(text):{}; }catch { throw fail('body_invalid',400); }if(!object(parsed))throw fail('body_invalid',400);return parsed;
      }finally {raw.fill(0);}
    }finally {for(const chunk of chunks)chunk.fill(0);}
  }
  function create(host) {
    const jobs=new Map(),cachedBodies=new WeakMap();let active=null,creating=false,receiving=false;
    const view=job=>Object.freeze({id:job.id,operation:job.operation,state:job.state,createdAt:job.createdAt,cancellable:!job.committed&&!job.cancelRequested&&!['failed','cancelled'].includes(job.state),
      takeover:job.committed,retry:false,error:job.error||null,operationMayHaveExecuted:job.committed});
    const ensureExpected=async expected=>{const current=await host.inspect();if(!same(expected,authority(current.authority)))throw fail('authority_changed');return current;};
    const code=error=>/^work_data(?:_[a-z0-9]+)*\.[a-z0-9_.-]{1,96}$/.test(String(error?.code||''))?error.code:'work_data_setup.worker_failed';
    const cancelled=job=>{if(job.cancelRequested)throw fail('cancelled');};
    const awaitReady=(job,ready)=>new Promise((resolve,reject)=>{
      const cleanup=()=>job.abort.signal.removeEventListener('abort',abort),abort=()=>{cleanup();reject(fail('cancelled'));};
      job.abort.signal.addEventListener('abort',abort,{once:true});if(job.abort.signal.aborted)return abort();
      ready.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
    });
    async function execute(job) {
      let failed;
      try {
        cancelled(job);await ensureExpected(job.args.expectedAuthority);cancelled(job);
        job.lease=host.maintenance.begin({signal:job.abort.signal});job.state='draining';await job.lease.idle();cancelled(job);
        await ensureExpected(job.args.expectedAuthority);cancelled(job);job.state='preparing';
        const worker=host.worker();if(typeof worker.start!=='function')throw fail('worker_unavailable',501);
        job.handle=await worker.start({...job.args,id:job.id,password:job.secret.toString('utf8')});job.secret.fill(0);job.secret=null;
        if(!job.handle || !job.handle.ready || typeof job.handle.ready.then!=='function' || typeof job.handle.cancel!=='function' || typeof job.handle.handoff!=='function')throw fail('worker_contract_invalid');
        const ready=Promise.resolve(job.handle.ready);ready.catch(()=>{});cancelled(job);await awaitReady(job,ready);cancelled(job);job.state='ready';
        // This synchronous boundary is indivisible with respect to cancel HTTP.
        // Once commitment begins no timeout or uncertain result may reopen warm IO.
        job.lease.assertIdle();job.committed=true;job.state='handoff';job.lease.retire();
        await job.handle.handoff();
        // Handoff completion is not conversion completion. Success is reported
        // only by a successor reading the cold worker's durable receipt.
      }catch(error){failed=error;job.error=code(error);job.state=job.committed?'uncertain':job.cancelRequested?'cancelled':'failed';}
      finally {
        if(job.secret){job.secret.fill(0);job.secret=null;}job.args=null;
        if(!job.committed){
          try{if(job.handle)await job.handle.cancel();}catch(error){job.error=code(error);job.state='failed';}
          try{if(job.lease && !job.abort.signal.aborted)job.lease.resume();}catch{job.error='work_data_setup.resume_failed';job.state='failed';}
          if(active===job)active=null;
        }
      }
      return failed;
    }
    async function submit(body) {
      if(creating||active||!host.maintenance.accepting())throw fail('busy');creating=true;
      let secret;
      try {
        if(!exact(body,['operation','password','expectedAuthority','backupDirectory','targetDirectory','uploadId','confirmPlaintext']) || !['enable','disable','export','restore'].includes(body.operation))throw fail('request_invalid',400);
        if(!validText(body.password)||body.password.length<12||Buffer.byteLength(body.password)>1024)throw fail('password_invalid',400);
        secret=Buffer.from(body.password);body.password='';
        const expectedAuthority=authority(body.expectedAuthority),observed=await ensureExpected(expectedAuthority);
        if(body.operation==='enable'&&expectedAuthority.mode!=='plain'||body.operation==='disable'&&expectedAuthority.mode!=='encrypted')throw fail('mode_conflict');
        if(body.operation==='disable'&&body.confirmPlaintext!==true)throw fail('plaintext_confirmation_required',400);
        if(body.confirmPlaintext!==undefined&&typeof body.confirmPlaintext!=='boolean')throw fail('request_invalid',400);
        if(!validText(body.backupDirectory)||!body.backupDirectory.length||body.backupDirectory.length>1024)throw fail('path_invalid',400);
        const jobId=host.id();if(!ID.test(jobId)||jobs.has(jobId))throw fail('id_invalid');let uploadGrant=null;
        if(body.operation==='restore'){
          if(!validText(body.targetDirectory)||!body.targetDirectory.length||body.targetDirectory.length>1024||!ID.test(body.uploadId||''))throw fail('restore_input_invalid',400);
          const uploadWorker=host.worker();
          // A worker that cannot start cannot consume the grant or reach the queue.
          if(typeof uploadWorker.start!=='function')throw fail('worker_unavailable',501);
          if(typeof uploadWorker.resolveUpload!=='function'||typeof WorkDataRestoreUploads==='undefined')throw fail('upload_unavailable',501);
          uploadGrant=await uploadWorker.resolveUpload(body.uploadId,{jobId});
          if(WorkDataRestoreUploads.ownsGrant(uploadGrant,{uploadId:body.uploadId,jobId})!==true)throw fail('upload_unavailable',501);
        }else if(body.targetDirectory!==undefined||body.uploadId!==undefined)throw fail('request_invalid',400);
        const worker=host.worker();if(typeof worker.start!=='function')throw fail('worker_unavailable',501);
        await host.validateDirectories({base:observed.base,backupDirectory:body.backupDirectory,targetDirectory:body.targetDirectory});
        await ensureExpected(expectedAuthority);
        const job={id:jobId,operation:body.operation,state:'queued',createdAt:host.now(),committed:false,cancelRequested:false,abort:new AbortController(),secret,
          args:{operation:body.operation,expectedAuthority,backupDirectory:body.backupDirectory,...(body.operation==='restore'?{targetDirectory:body.targetDirectory,uploadId:body.uploadId,uploadGrant}:{}),confirmPlaintext:body.confirmPlaintext===true}};
        if(!ID.test(job.id)||jobs.has(job.id))throw fail('id_invalid');secret=null;
        while(jobs.size>=32){const oldest=[...jobs.values()].find(row=>['failed','cancelled'].includes(row.state));if(!oldest)throw fail('capacity');jobs.delete(oldest.id);}
        jobs.set(job.id,job);active=job;host.defer(()=>{job.done=execute(job);});return view(job);
      }finally {secret?.fill(0);creating=false;}
    }
    async function cancel(id) {
      const job=jobs.get(id);if(!job)throw fail('job_not_found',404);
      if(job.committed)throw fail('cancel_too_late');
      if(!['cancelled','failed'].includes(job.state)){job.cancelRequested=true;job.state='cancel_requested';job.abort.abort();}
      return view(job);
    }
    async function status() {
      const observed=await host.inspect(),worker=host.worker();let lastResult=null;
      if(typeof worker.readResult==='function'){try{lastResult=await worker.readResult();}catch{throw fail('result_unavailable',503);}}
      return {ok:true,authority:authority(observed.authority),configMirror:observed.configMirror,maintenance:host.maintenance.status(),job:active?view(active):null,
        lastResult,capabilities:{worker:typeof worker.start==='function',upload:typeof worker.putUpload==='function'&&typeof worker.resolveUpload==='function',download:typeof worker.download==='function'},processRestartRequired:true};
    }
    async function receiveUpload(req) {
      // The main router authenticates the header token before this handler. This
      // route additionally binds the actual loopback socket and same-port Origin.
      if(active||creating||receiving||!host.maintenance.accepting())throw fail('busy');
      const worker=host.worker();
      if(typeof worker.putUpload!=='function'||typeof worker.resolveUpload!=='function')throw fail('upload_unavailable',501);
      const headers=req.headers||{},port=req.socket?.localPort;
      const peer=String(req.socket?.remoteAddress||'').toLowerCase(),name=headers.host;
      if(!Number.isInteger(port)||port<1||port>65535||!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(peer)
        ||typeof name!=='string'||![`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(name.toLowerCase()))throw fail('upload_origin_invalid',403);
      if(headers.origin!==undefined){let origin;try{origin=new URL(headers.origin);}catch{throw fail('upload_origin_invalid',403);}
        if(origin.protocol!=='http:'||origin.host.toLowerCase()!==name.toLowerCase()||origin.origin!==headers.origin)throw fail('upload_origin_invalid',403);}
      if(headers['sec-fetch-site']!==undefined&&!['same-origin','none'].includes(headers['sec-fetch-site']))throw fail('upload_origin_invalid',403);
      if(req.url!=='/api/work-data/uploads'||headers['content-type']!=='application/octet-stream'
        ||headers['transfer-encoding']!==undefined||headers['content-encoding']!==undefined||headers['content-disposition']!==undefined)throw fail('upload_headers_invalid',400);
      const length=headers['content-length'];
      if(typeof length!=='string'||!(/^[1-9][0-9]{0,9}$/).test(length))throw fail('upload_length_required',411);
      const maximum=WorkDataRecovery.LIMITS.serialized,size=Number(length);
      if(!Number.isSafeInteger(size)||size>maximum)throw fail('body_too_large',413);
      // One admitted receiver per process. The maintenance drain includes both
      // bounded ingestion and the real broker's fsync/native flush publication.
      receiving=true;
      try{return await host.maintenance.run('http',async()=>{
        const bytes=Buffer.alloc(size);let used=0;
        try{
          for await(const chunk of req){
            if(!Buffer.isBuffer(chunk)||chunk.length>size-used)throw fail('body_too_large',413);
            chunk.copy(bytes,used);used+=chunk.length;
          }
          if(used!==size||req.aborted===true)throw fail('upload_incomplete',400);
          const uploadId=await worker.putUpload(bytes);
          if(!ID.test(uploadId||''))throw fail('upload_contract_invalid');
          return {ok:true,uploadId};
        }finally{bytes.fill(0);}
      });}finally{receiving=false;}
    }
    async function handle(req,res,pathname) {
      let response,statusCode=200;
      if(req.method==='GET'&&pathname==='/api/work-data/status')response=await status();
      else if(req.method==='POST'&&pathname==='/api/work-data/jobs'){response={ok:true,job:await submit(await readJson(req))};statusCode=202;}
      else if(req.method==='POST'&&pathname==='/api/work-data/uploads'){response=await receiveUpload(req);statusCode=201;}
      else if((req.method==='GET'||req.method==='POST')&&pathname.startsWith('/api/work-data/jobs/')) {
        const match=/^\/api\/work-data\/jobs\/([a-f0-9]{48})(\/cancel)?$/.exec(pathname);if(!match)throw fail('job_not_found',404);
        if(req.method==='GET'&&!match[2]){const job=jobs.get(match[1]);if(!job)throw fail('job_not_found',404);response={ok:true,job:view(job)};}
        else if(req.method==='POST'&&match[2]){const body=await readJson(req,256);if(Object.keys(body).length)throw fail('request_invalid',400);response={ok:true,job:await cancel(match[1])};}
        else throw fail('method_not_allowed',405);
      }else return false;
      host.respond(res,response,statusCode);return true;
    }
    const bypasses=(req,pathname)=>pathname==='/api/mcp/internal/request'||req.method==='POST'&&pathname==='/api/memory-cli'
      ||req.method==='GET'&&pathname==='/api/events/stream'||req.method==='POST'&&pathname==='/api/bootstrap';
    async function runHttp(req,pathname,work) {
      if(host.maintenance.entered('http'))return work();
      if(bypasses(req,pathname))return work(); // own signed grants, or finite setup; never wait for stream lifetime
      if(host.maintenance.accepting())return host.maintenance.run('http',work);
      // Only these finite receipt routes may read a body while closed. Every
      // other request, including GETs that can rebuild caches, refuses before IO.
      if(req.method!=='POST'||!host.receiptPath(pathname))throw fail('busy');
      const body=await readJson(req,65536),owner=host.receiptOwner(pathname,body);if(!owner)throw fail('receipt_owner_unavailable');
      cachedBodies.set(req,body);
      try{return await host.maintenance.continueOwner(owner,()=>host.maintenance.run('http',work));}
      finally{cachedBodies.delete(req);}
    }
    return Object.freeze({submit,cancel,status,handle,runHttp,bypasses,cachedBody:req=>cachedBodies.get(req)});
  }
  return Object.freeze({create,authority,readJson});
})();

async function workDataSetupInspect() {
  try {
  const selected=WorkDataRootAuthority.selected();if(!WorkDataRootHooks.ready()||!selected)throw Object.assign(Error('work_data_setup.root_unavailable'),{code:'work_data_setup.root_unavailable',statusCode:503});
  const current=await WorkDataManifest.create({base:selected.canonicalBase}).readActive();
  if(current.proof.sha256!==selected.proof.sha256||current.generation!==selected.generation||current.id!==selected.id)throw Object.assign(Error('work_data_setup.authority_changed'),{code:'work_data_setup.authority_changed',statusCode:409});
  // readConfig can repair/normalize/migrate and is deliberately excluded here.
  const stat=await fsp.lstat(paths.config);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4*1024*1024)throw Object.assign(Error('work_data_setup.config_unavailable'),{code:'work_data_setup.config_unavailable',statusCode:503});
  const file=await fsp.open(paths.config,'r');let raw;
  try {const chunks=[];let bytes=0;try{while(true){const chunk=Buffer.alloc(65536),read=await file.read(chunk,0,chunk.length,null);if(!read.bytesRead){chunk.fill(0);break;}bytes+=read.bytesRead;if(bytes>4*1024*1024){chunk.fill(0);throw Error('bounded config');}chunks.push(chunk.subarray(0,read.bytesRead));}const all=Buffer.concat(chunks,bytes);try{const text=all.toString('utf8');if(!Buffer.from(text).equals(all))throw Error('utf8');raw=JSON.parse(text.replace(/^\uFEFF/,''));}finally{all.fill(0);}}finally{for(const chunk of chunks)chunk.fill(0);}}
  catch {throw Object.assign(Error('work_data_setup.config_unavailable'),{code:'work_data_setup.config_unavailable',statusCode:503});}finally{await file.close();}
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.workDataEncryptionV1!==undefined&&typeof raw.workDataEncryptionV1!=='boolean')throw Object.assign(Error('work_data_setup.config_unavailable'),{code:'work_data_setup.config_unavailable',statusCode:503});
  const configMirror=raw.workDataEncryptionV1===true,mode=WorkDataRootAuthority.mode(configMirror)?'encrypted':'plain';
  if(current.generation&&current.mode!==mode)throw Object.assign(Error('work_data_setup.authority_changed'),{code:'work_data_setup.authority_changed',statusCode:409});
  return {base:selected.canonicalBase,authority:{generation:current.generation,id:current.id,mode,sha256:current.proof.sha256},configMirror};
  }catch(error){const code=/^work_data(?:_[a-z0-9]+)*\.[a-z0-9_.-]{1,96}$/.test(String(error?.code||''))?error.code:'work_data_setup.status_unavailable';throw Object.assign(Error(code),{code,apiCode:code,statusCode:Number.isInteger(error?.statusCode)?error.statusCode:503,retry:false});}
}
async function workDataSetupDirectories({base,backupDirectory,targetDirectory}) {
  try {
  const key=value=>process.platform==='win32'?path.resolve(value).toUpperCase():path.resolve(value),inside=(a,b)=>{const rel=path.relative(key(a),key(b));return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
  const fail=()=>{throw Object.assign(Error('work_data_setup.path_invalid'),{code:'work_data_setup.path_invalid',statusCode:400});};
  async function real(directory){if(!path.isAbsolute(directory))fail();const absolute=path.resolve(directory),parsed=path.parse(absolute);let cursor=parsed.root;for(const part of ['',...absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)]){if(part)cursor=path.join(cursor,part);const stat=await fsp.lstat(cursor);if(!stat.isDirectory()||stat.isSymbolicLink()||key(await fsp.realpath(cursor))!==key(cursor))fail();}}
  await real(backupDirectory);if(inside(base,backupDirectory)||inside(backupDirectory,base))fail();
  if(targetDirectory!==undefined){if(!path.isAbsolute(targetDirectory)||inside(base,targetDirectory)||inside(targetDirectory,base)||inside(targetDirectory,backupDirectory))fail();await real(path.dirname(targetDirectory));try{await fsp.lstat(targetDirectory);}catch(error){if(error.code==='ENOENT')return;throw error;}fail();}
  }catch{throw Object.assign(Error('work_data_setup.path_invalid'),{code:'work_data_setup.path_invalid',apiCode:'work_data_setup.path_invalid',statusCode:400,retry:false});}
}
function workDataSetupReceiptPath(pathname) {
  return ['/api/stop','/api/chat/answer','/api/question/heartbeat','/api/permission/decision','/api/plan/decision'].includes(pathname)
    || /^\/api\/missions\/[^/]+\/interventions\/[^/]+\/decision$/.test(pathname)||/^\/api\/agent-runs\/[^/]+$/.test(pathname)
    || /^\/api\/sessions\/[^/]+\/background\/stop$/.test(pathname);
}
function workDataSetupReceiptOwner(pathname,body) {
  const proposedOwner=(live,sid,poolId)=>live&&live.run&&live.run.sessionId===sid&&!live.closing&&!live.stopRequested&&!live.ctrl?.signal?.aborted
    && !(typeof AGENT_RUN_TERMINAL!=='undefined'&&AGENT_RUN_TERMINAL.has(live.run.status))
    && typeof poolId==='string'&&poolId.length>0&&poolId.length<=128&&Array.isArray(live.run.taskPool)
    && live.run.taskPool.some(item=>item&&item.id===poolId&&item.status==='proposed')?live:null;
  if(pathname==='/api/stop'){const sid=safeSessionId(body.sessionId),checked=sid?sessionExecutionCheck(sid,body.expectedExecution):null;return checked?.ok?checked.owner:null;}
  let entry;
  if(pathname==='/api/chat/answer'||pathname==='/api/question/heartbeat')entry=pendingQuestions.get(String(body.questionId||body.toolUseId||''));
  else if(pathname==='/api/permission/decision')entry=pendingPermissions.get(String(body.requestId||''));
  else if(pathname==='/api/plan/decision')entry=pendingPlans.get(String(body.planId||''));
  else {
    const contract=/^\/api\/missions\/([^/]+)\/interventions\/([^/]+)\/decision$/.exec(pathname);
    if(contract){let sid,id;try{sid=decodeURIComponent(contract[1]);id=decodeURIComponent(contract[2]);}catch{return null;}entry=pendingPermissions.get(id)||pendingQuestions.get(id)||pendingPlans.get(id);
      if(!entry){if(!['approve','reject'].includes(body.action)||body.sessionId!==undefined&&body.sessionId!==sid)return null;const owners=[...activeAgentRuns.values()].filter(live=>proposedOwner(live,sid,id));return owners.length===1?owners[0]:null;}
      if(entry.sessionId!==sid)return null;}
    const run=/^\/api\/agent-runs\/([^/]+)$/.exec(pathname);
    if(run){const live=activeAgentRuns.get(run[1]);if(['pool_approve','pool_reject'].includes(body.action))return proposedOwner(live,body.sessionId,body.poolId);return body.action==='stop'&&live?.run?.sessionId===body.sessionId?live:null;}
    const background=/^\/api\/sessions\/([^/]+)\/background\/stop$/.exec(pathname);
    if(background){let sid;try{sid=decodeURIComponent(background[1]);}catch{return null;}if(typeof body.id!=='string')return null;
      if(body.id.startsWith('run:')){const live=activeAgentRuns.get(body.id.slice(4));return live?.run?.sessionId===sid?live:null;}
      if(body.id.startsWith('shell:')){const shell=shellSessions.get(body.id.slice(6));return shell?.running&&shell.sessionId===sid?shell:null;}
    }
  }
  if(!entry||body.sessionId!==undefined&&entry.sessionId!==body.sessionId)return null;
  return turnSettlers.get(entry.sessionId)||null;
}
const workDataSetup = WorkDataSetup.create({maintenance:WorkDataMaintenanceHooks,inspect:workDataSetupInspect,validateDirectories:workDataSetupDirectories,
  worker:()=>WorkDataMaintenanceWorkerHooks,id:()=>crypto.randomBytes(24).toString('hex'),now:nowIso,defer:work=>setImmediate(work),respond:(res,body,status)=>send(res,json(body,status)),
  receiptPath:workDataSetupReceiptPath,receiptOwner:workDataSetupReceiptOwner});
Object.assign(WorkDataSetupHooks,workDataSetup);
