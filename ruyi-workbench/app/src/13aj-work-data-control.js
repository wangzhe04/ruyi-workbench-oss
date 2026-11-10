// The cold lifecycle's one pending intent. A private issued receipt is required
// for every update/removal. A failed or interrupted write never authorizes the
// next mutation; the next boot refuses before normal recovery/ensureDirs.
const WorkDataMaintenanceControl = ((fsApi, pathApi, cryptoApi) => {
  const NAME = 'maintenance-v1.json', STAGE = '.maintenance-v1.stage-', LIMIT = 32 * 1024, RETIRE_LIMIT = 4 * 1024 * 1024;
  const ID = /^[a-f0-9]{48}$/, SHA = /^[a-f0-9]{64}$/;
  const LEGACY_NATIVE = 'migrations/skill-backups', CONTROL_PARENTS = ['.work-data','.work-data/generations'];
  const hash = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const fail = (suffix, cause) => Object.assign(new Error('work_data_setup.' + suffix), {
    code: 'work_data_setup.' + suffix, apiCode: 'work_data_setup.' + suffix, statusCode: 409,
    retry: false, operationMayHaveExecuted: true, ...(cause !== undefined ? { cause } : {}),
  });
  async function directory(root, missing = false) {
    const absolute = pathApi.resolve(root), parsed = pathApi.parse(absolute);
    let current = parsed.root;
    for (const part of ['', ...absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean)]) {
      if (part) current = pathApi.join(current, part);
      let stat;
      try { stat = await fsApi.lstat(current); } catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || fold(await fsApi.realpath(current)) !== fold(current)) throw fail('control_alias');
    }
    return true;
  }
  async function read(file) {
    const before = await fsApi.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(RETIRE_LIMIT)) throw fail('intent_invalid');
    const handle = await fsApi.open(file, 'r');
    try {
      const bytes = Buffer.alloc(Number(before.size) + 1); let used = 0;
      for (;;) {
        const result = await handle.read(bytes, used, bytes.length - used, null); used += result.bytesRead;
        if (used > Number(before.size)) throw fail('intent_changed');
        if (!result.bytesRead) break;
      }
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw fail('intent_changed');
      return { bytes: bytes.subarray(0, used), identity: { dev: String(after.dev), ino: String(after.ino) } };
    } finally { await handle.close(); }
  }
  function candidateValid(candidate) {
    if (!candidate) return false;
    const fields = Object.keys(candidate).sort().join(',');
    return (fields === 'headerSha256,id,mode' // Intents written before pointer binding.
      || fields === 'headerSha256,id,mode,pointerSha256' && typeof candidate.pointerSha256 === 'string'
        && /^[a-f0-9]{64}$/.test(candidate.pointerSha256))
      && /^[a-f0-9]{48}$/.test(candidate.id || '') && ['plain', 'encrypted'].includes(candidate.mode)
      && (candidate.headerSha256 === null || /^[a-f0-9]{64}$/.test(candidate.headerSha256));
  }
  function transitionValid(state) {
    const value = state.transition, candidate = state.candidate;
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'operationId,preparedSha256,schema'
      && value.schema === 1 && typeof value.operationId === 'string' && ID.test(value.operationId)
      && typeof value.preparedSha256 === 'string' && SHA.test(value.preparedSha256)
      && ['enable', 'disable'].includes(state.operation) && ['key-ready', 'published', 'complete', 'retiring'].includes(state.phase)
      && candidate && typeof candidate.pointerSha256 === 'string' && SHA.test(candidate.pointerSha256)
      && typeof candidate.headerSha256 === 'string' && SHA.test(candidate.headerSha256);
  }
  function transitionReadyValid(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'schema,targetNativeSha256,targetSha256' && value.schema === 1
      && typeof value.targetSha256 === 'string' && SHA.test(value.targetSha256)
      && typeof value.targetNativeSha256 === 'string' && SHA.test(value.targetNativeSha256);
  }
  function transitionSourceScopeValid(value) {
    return value && typeof value==='object'&&!Array.isArray(value)
      && Object.keys(value).sort().join(',')==='createdParents,nativePath,schema'&&value.schema===1&&value.nativePath===LEGACY_NATIVE
      && Array.isArray(value.createdParents)&&value.createdParents.length<=CONTROL_PARENTS.length
      && CONTROL_PARENTS.slice(CONTROL_PARENTS.length-value.createdParents.length).every((name,index)=>value.createdParents[index]===name);
  }
  function legacyTransitionSourceScope({sourceFiles,sourceDirectories,specialCoverage}={}) {
    if(!Array.isArray(sourceFiles)||!Array.isArray(sourceDirectories)
      ||specialCoverage?.type!=='skill-backup-portable'||specialCoverage.originalObjects!=='new-owned-portable'
      ||typeof specialCoverage.sourcePath!=='string'||fold(specialCoverage.sourcePath)!==LEGACY_NATIVE
      ||sourceFiles.some(row=>typeof row?.path!=='string'||[...CONTROL_PARENTS,LEGACY_NATIVE].includes(fold(row.path)))
      ||sourceDirectories.some(row=>typeof row?.path!=='string'))throw fail('transition_source_invalid');
    const directories=new Set(sourceDirectories.map(row=>fold(row.path)));
    const scope={schema:1,nativePath:LEGACY_NATIVE,createdParents:Object.freeze(CONTROL_PARENTS.filter(name=>!directories.has(name)))};
    if(!directories.has(LEGACY_NATIVE)||!transitionSourceScopeValid(scope))throw fail('transition_source_invalid');
    return Object.freeze(scope);
  }
  function sourceOrdinaryDigest({sourceFiles,sourceDirectories}={}, {candidateId,scope}={}) {
    if(!Array.isArray(sourceFiles)||!Array.isArray(sourceDirectories)||typeof candidateId!=='string'||!ID.test(candidateId)
      ||scope!==undefined&&!transitionSourceScopeValid(scope))
      throw fail('transition_source_invalid');
    // The excluded native owner subtree has its own inverse and census proof.
    // The caller must verify that proof and the exact shadow before any cleanup.
    const native='.work-data/skill-backups',shadow='.work-data/generations/'+candidateId,seen=new Set();
    const omit=(relative,directory)=>{
      const name=fold(relative);
      return name==='.work-data/'+NAME||name===native||name.startsWith(native+'/')||name===shadow||name.startsWith(shadow+'/')
        ||scope!==undefined&&(name.startsWith(LEGACY_NATIVE+'/')||directory&&(name===LEGACY_NATIVE||scope.createdParents.includes(name)));
    };
    const ordinary=(rows,directory)=>{
      const result=[];
      for(const row of rows){
        const relative=row?.path;
        if(typeof relative!=='string'||relative===''&&!directory||relative!==''&&relative.split('/').some(part=>!part||part==='.'||part==='..'||/[\\:\0\r\n]/.test(part)))
          throw fail('transition_source_invalid');
        if(omit(relative,directory))continue;
        const key=fold(relative);
        if(seen.has(key)||typeof row.identity!=='string'||!/^\d{1,40}:\d{1,40}$/.test(row.identity))
          throw fail('transition_source_invalid');
        seen.add(key);
        if(directory){result.push([relative,row.identity]);continue;}
        if(typeof row.sha256!=='string'||!SHA.test(row.sha256)
          ||!['mtimeNs','ctimeNs'].every(field=>typeof row[field]==='string'&&/^-?\d{1,40}$/.test(row[field])))throw fail('transition_source_invalid');
        result.push([relative,row.identity,row.mtimeNs,row.ctimeNs,row.sha256]);
      }
      return result.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    };
    const files=ordinary(sourceFiles,false),directories=ordinary(sourceDirectories,true);
    if(directories[0]?.[0]!=='')throw fail('transition_source_invalid');
    const sourceScope=scope===undefined?{}:{scope:{nativePath:scope.nativePath,createdParents:scope.createdParents}};
    return hash(JSON.stringify({files,directories,...sourceScope}));
  }
  function retirementValid(value) {
    const claim = value?.claim, rows = value?.rows;
    return value && Object.keys(value).sort().join(',') === 'claim,retainedSha256,rows,schema'
      && value.schema === 1 && SHA.test(value.retainedSha256 || '')
      && claim && Object.keys(claim).sort().join(',') === 'childPid,dev,ino,parentPid,sha256'
      && SHA.test(claim.sha256 || '') && [claim.dev, claim.ino].every(field => typeof field === 'string' && /^\d{1,40}$/.test(field))
      && [claim.parentPid, claim.childPid].every(pid => Number.isSafeInteger(pid) && pid > 0)
      && Array.isArray(rows) && rows.length > 0 && rows.length <= 10000
      && rows.every(row => row && Object.keys(row).sort().join(',') === 'dir,id,path,sha256'
        && typeof row.dir === 'boolean' && /^[a-f0-9]{24}$/.test(row.id || '') && SHA.test(row.sha256 || '')
        && typeof row.path === 'string' && row.path.length <= 8192 && row.path.split('/').every(part =>
          part && part !== '.' && part !== '..' && !/[\\:\0\r\n]/.test(part)))
      && new Set(rows.map(row => fold(row.path))).size === rows.length;
  }
  function stateValid(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    const fields = Object.keys(state).sort().join(',');
    const baseFields = 'backup,candidate,createdAt,expectedAuthority,id,operation,phase,schema';
    const transitionFields=baseFields+',transition'+(state.transitionReady===undefined?'':',transitionReady')
      +(state.transitionSourceScope===undefined?'':',transitionSourceScope')
      +(state.transitionSourceSha256===undefined?'':',transitionSourceSha256');
    const retiring=state.phase==='retiring';
    const expectedFields=retiring?transitionFields.split(',').concat('retirement').sort().join(','):transitionFields;
    return (!retiring&&fields===baseFields || fields===expectedFields&&transitionValid(state)
      && (state.transitionReady===undefined||transitionReadyValid(state.transitionReady))
      && (state.transitionSourceScope===undefined||transitionSourceScopeValid(state.transitionSourceScope)
        &&state.transitionSourceSha256!==undefined&&state.operation==='enable'&&state.expectedAuthority?.generation===0
        &&state.expectedAuthority.id===null&&state.expectedAuthority.mode==='plain'&&state.expectedAuthority.sha256===null)
      && (state.transitionSourceSha256===undefined||typeof state.transitionSourceSha256==='string'&&SHA.test(state.transitionSourceSha256)))
      && (!retiring || state.transitionReady && state.transitionSourceSha256 && retirementValid(state.retirement))
      && state.schema === 1 && ID.test(state.id || '')
      && ['enable', 'disable', 'restore'].includes(state.operation)
      && ['prepared', 'candidate', 'key-ready', 'published', 'complete', 'retiring'].includes(state.phase)
      && typeof state.createdAt === 'string' && new Date(state.createdAt).toISOString() === state.createdAt
      && state.backup && Object.keys(state.backup).sort().join(',') === 'path,sha256'
      && typeof state.backup.path === 'string' && pathApi.isAbsolute(state.backup.path)
      && /^[a-f0-9]{64}$/.test(state.backup.sha256 || '')
      && state.expectedAuthority && Object.keys(state.expectedAuthority).sort().join(',') === 'generation,id,mode,sha256'
      && Number.isSafeInteger(state.expectedAuthority.generation) && state.expectedAuthority.generation >= 0
      && (state.expectedAuthority.id === null || /^[a-f0-9]{48}$/.test(state.expectedAuthority.id))
      && ['plain', 'encrypted'].includes(state.expectedAuthority.mode)
      && (state.expectedAuthority.sha256 === null || /^[a-f0-9]{64}$/.test(state.expectedAuthority.sha256))
      && (state.candidate === null || candidateValid(state.candidate));
  }
  // One exact root control file, selected by this module under the same source
  // lease. A serializable receipt, clone, Proxy, or arbitrary callback cannot
  // grant the FullSnapshot control-file exception.
  const recoveryProofs=new WeakMap();
  function acceptsRecoveryProfile(proof,base,ownership) {
    const known=recoveryProofs.get(proof);
    return !!known&&known.kind==='complete'&&!known.retired&&known.ownership===ownership&&typeof base==='string'&&fold(known.base)===fold(base);
  }
  async function verifyRecoveryProfile(proof,{base,ownership,path,bytes}={}) {
    const known=recoveryProofs.get(proof);
    if(!acceptsRecoveryProfile(proof,base,ownership)||fold(path||'')!=='.work-data/'+NAME
      ||!Buffer.isBuffer(bytes)||!bytes.equals(known.bytes))throw fail('complete_recovery_receipt_invalid');
    await known.check();return true;
  }

  function create({ base, ownership, assertExclusive, assertDurableBackup, flush }) {
    if (typeof base !== 'string' || !pathApi.isAbsolute(base) || pathApi.resolve(base) !== base
      || typeof assertExclusive !== 'function' || typeof assertDurableBackup !== 'function'
      || typeof flush !== 'function') throw fail('control_host_invalid');
    const root = pathApi.join(base, '.work-data'), file = pathApi.join(root, NAME), issued = new WeakMap();
    const controlIdentity={};
    let writing = false;
    async function admission() {
      if (!ownership || !Array.isArray(ownership.roots) || !ownership.roots.some(value => fold(value) === fold(base))
        || await assertExclusive(ownership) !== true) throw fail('ownership_required');
      await directory(base);
    }
    async function inspect() {
      await admission(); if (!await directory(root, true)) return Object.freeze({ pending: false });
      const names = await fsApi.readdir(root);
      if (names.some(name => fold(name).startsWith(STAGE))) throw fail('intent_stage_pending');
      if (!names.some(name => fold(name) === NAME)) return Object.freeze({ pending: false });
      const captured = await read(file); let state;
      try {
        const text = captured.bytes.toString('utf8'); if (!Buffer.from(text).equals(captured.bytes)) throw fail('intent_invalid');
        state = JSON.parse(text);
        if (!stateValid(state) || state.phase !== 'retiring' && captured.bytes.length > LIMIT) throw fail('intent_invalid');
      } catch (cause) { throw fail('intent_invalid', cause); }
      return Object.freeze({ pending: true, id: state.id, operation: state.operation, phase: state.phase,
        backupPath: state.backup.path, sha256: hash(captured.bytes) });
    }
    async function verify(receipt) {
      const known = issued.get(receipt); if (!known) throw fail('intent_receipt_invalid');
      await admission(); await directory(root); const captured = await read(file);
      if (hash(captured.bytes) !== known.sha256 || captured.identity.dev !== known.identity.dev
        || captured.identity.ino !== known.identity.ino) throw fail('intent_changed');
      return receipt;
    }
    async function publishIntent(serialized, selected, checkPrevious) {
      if (!await directory(root, true)) await fsApi.mkdir(root, { mode: 0o700 });
      await directory(root);
      const stageName = STAGE + cryptoApi.randomBytes(24).toString('hex'), stage = pathApi.join(root, stageName);
      const handle = await fsApi.open(stage, 'wx', 0o600);
      let staged;
      try {
        await handle.writeFile(serialized, 'utf8'); await handle.sync();
        const stat = await handle.stat({bigint:true});
        staged = {dev:String(stat.dev),ino:String(stat.ino)};
      } finally { await handle.close(); }
      await flush([root, base]); await admission();
      if ((await fsApi.readdir(root)).some(name => fold(name).startsWith(STAGE) && name !== stageName)) throw fail('intent_stage_pending');
      await checkPrevious(stageName);
      const ready = await read(stage), sha256 = hash(Buffer.from(serialized));
      if (hash(ready.bytes) !== sha256 || ready.identity.dev !== staged.dev || ready.identity.ino !== staged.ino)
        throw fail('intent_changed');
      await fsApi.rename(stage, file);
      await flush([root, base]);
      const captured = await read(file);
      if (hash(captured.bytes) !== sha256 || captured.identity.dev !== staged.dev || captured.identity.ino !== staged.ino)
        throw fail('intent_changed');
      return Object.freeze({ name: '.work-data/' + NAME, sha256,
        identity: Object.freeze(captured.identity), id: selected.id, phase: selected.phase });
    }
    async function write(state, previous = null) {
      let serialized, selected;
      try { serialized = JSON.stringify(state); selected = JSON.parse(serialized); if (selected?.phase === 'retiring' || !stateValid(selected)) throw fail('intent_invalid'); }
      catch (cause) { throw fail('intent_invalid', cause); }
      if (Buffer.byteLength(serialized) > LIMIT) throw fail('intent_invalid');
      if (writing) throw fail('intent_busy'); writing = true;
      try {
        await admission();
        const observed = await inspect();
        if (await assertDurableBackup(JSON.parse(serialized).backup) !== true) throw fail('backup_unverified');
        if (previous) {
          await verify(previous); const prior = issued.get(previous), next = JSON.parse(serialized);
          for (const key of ['schema', 'id', 'operation', 'createdAt', 'expectedAuthority', 'backup'])
            if (JSON.stringify(prior.state[key]) !== JSON.stringify(next[key])) throw fail('intent_binding_changed');
          const order = ['prepared', 'candidate', 'key-ready', 'published', 'complete'];
          const difference = order.indexOf(next.phase) - order.indexOf(prior.state.phase);
          if (difference < 0 || difference > 1) throw fail('intent_phase_invalid');
          if (prior.state.candidate && (!next.candidate || prior.state.candidate.id !== next.candidate.id
            || prior.state.candidate.mode !== next.candidate.mode
            || prior.state.candidate.pointerSha256 !== next.candidate.pointerSha256
            || prior.state.candidate.headerSha256 !== null && prior.state.candidate.headerSha256 !== next.candidate.headerSha256)) throw fail('intent_binding_changed');
          if (prior.state.transition) {
            if (!next.transition || prior.state.transition.operationId !== next.transition.operationId
              || prior.state.transition.preparedSha256 !== next.transition.preparedSha256
              || prior.state.transitionSourceSha256 !== next.transitionSourceSha256
              || JSON.stringify(prior.state.transitionSourceScope)!==JSON.stringify(next.transitionSourceScope)) throw fail('intent_binding_changed');
          } else if (next.transition && (prior.state.phase !== 'key-ready' || next.phase !== 'key-ready')) {
            throw fail('intent_phase_invalid');
          }
          if (prior.state.transitionReady) {
            if (!next.transitionReady || prior.state.transitionReady.targetSha256 !== next.transitionReady.targetSha256
              || prior.state.transitionReady.targetNativeSha256 !== next.transitionReady.targetNativeSha256) throw fail('intent_binding_changed');
          } else if (next.transitionReady && (!prior.state.transition || prior.state.phase !== 'key-ready' || next.phase !== 'key-ready')) {
            throw fail('intent_phase_invalid');
          }
        }
        else {
          if (selected.phase !== 'prepared' || selected.candidate !== null) throw fail('intent_phase_invalid');
          if (observed.pending) throw fail('intent_pending');
        }
        if (selected.phase !== 'prepared' && selected.candidate === null
          || ['key-ready', 'published', 'complete'].includes(selected.phase)
            && selected.candidate?.mode === 'encrypted' && !selected.candidate.headerSha256) throw fail('intent_phase_invalid');
        const receipt = await publishIntent(serialized, selected, async()=>{
          if (previous) await verify(previous);
          else { try { await fsApi.lstat(file); throw fail('intent_pending'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        });
        issued.set(receipt, { ...receipt, state: JSON.parse(serialized) }); return receipt;
      } catch (cause) {
        // Retain a staged/selected intent on every uncertainty. Normal boot sees
        // either name and refuses; no data mutation follows a failed write.
        throw fail('intent_write_failed', cause);
      } finally { writing = false; }
    }
    // A separate cross-process reader/retirement authority. Nothing below adds
    // parsed state to issued, and finish still requires its own write receipt.
    async function captureRecovery(ownStage) {
      await admission();await directory(root);
      if((await fsApi.readdir(root)).some(name=>fold(name).startsWith(STAGE)&&name!==ownStage))throw fail('intent_stage_pending');
      const before=await fsApi.lstat(file,{bigint:true});
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(RETIRE_LIMIT))throw fail('intent_invalid');
      const handle=await fsApi.open(file,'r'),bytes=Buffer.alloc(Number(before.size)+1);let used=0;
      try {
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||opened.nlink!==1n||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw fail('intent_changed');
        for(;;){const part=await handle.read(bytes,used,bytes.length-used,null);used+=part.bytesRead;if(used>Number(before.size))throw fail('intent_changed');if(!part.bytesRead)break;}
        const after=await handle.stat({bigint:true}),current=await fsApi.lstat(file,{bigint:true});
        if(!current.isFile()||current.isSymbolicLink()||after.nlink!==1n||current.nlink!==1n
          ||after.dev!==before.dev||after.ino!==before.ino||current.dev!==before.dev||current.ino!==before.ino
          ||after.size!==before.size||current.size!==before.size||used!==Number(before.size)
          ||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||current.mtimeNs!==after.mtimeNs||current.ctimeNs!==after.ctimeNs)throw fail('intent_changed');
        return {bytes:Buffer.from(bytes.subarray(0,used)),receipt:Object.freeze({name:'.work-data/'+NAME,sha256:hash(bytes.subarray(0,used)),bytes:used,
          identity:Object.freeze({dev:String(current.dev),ino:String(current.ino)})})};
      }finally{bytes.fill(0);await handle.close();}
    }
    async function selectRecovery(kind) {
      if(writing)throw fail('intent_busy');
      const original=await captureRecovery(), ineligible=kind+'_recovery_ineligible';let state;
      try {
        const text=original.bytes.toString('utf8');if(!Buffer.from(text).equals(original.bytes))throw fail('intent_invalid');
        state=JSON.parse(text);
        const a=state.expectedAuthority;
        if(!stateValid(state)||(kind==='complete'?state.phase!=='complete':!state.transition)
          ||state.phase!=='retiring'&&original.bytes.length>LIMIT||!['enable','disable'].includes(state.operation)
          ||(a.generation===0?a.id!==null||a.sha256!==null:!/^[a-f0-9]{48}$/.test(a.id||'')||!/^[a-f0-9]{64}$/.test(a.sha256||''))
          ||a.mode!==(state.operation==='enable'?'plain':'encrypted')||!state.candidate
          ||state.candidate.mode!==(state.operation==='enable'?'encrypted':'plain')||!/^[a-f0-9]{64}$/.test(state.candidate.headerSha256||''))throw fail(ineligible);
      }catch(cause){original.bytes.fill(0);throw fail(ineligible,cause);}
      const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
      const selected=freeze({state,receipt:original.receipt});
      const check=async ownStage=>{
        const current=await captureRecovery(ownStage);
        try{if(current.receipt.sha256!==original.receipt.sha256||current.receipt.bytes!==original.receipt.bytes
          ||current.receipt.identity.dev!==original.receipt.identity.dev||current.receipt.identity.ino!==original.receipt.identity.ino
          ||!current.bytes.equals(original.bytes))throw fail('intent_changed');return true;}
        finally{current.bytes.fill(0);}
      };
      recoveryProofs.set(selected,{base,ownership,kind,owner:controlIdentity,bytes:original.bytes,check,retired:false});
      return selected;
    }
    const selectCompleteRecovery = () => selectRecovery('complete');
    const selectTransitionRecovery = () => selectRecovery('transition');
    async function recoverInverse(selected, recover) {
      const known=recoveryProofs.get(selected);
      if(!known||known.kind!=='transition'||known.owner!==controlIdentity||known.retired||typeof recover!=='function'
        ||!['key-ready','retiring'].includes(selected.state.phase)||!selected.state.transitionReady||!selected.state.transitionSourceSha256)
        throw fail('transition_recovery_receipt_invalid');
      if(writing)throw fail('intent_busy');writing=true;
      let receipt=selected.receipt, committed=selected.state.phase==='retiring', finished=false, closed=false;
      const check=async()=>{
        if(finished||closed)throw fail('transition_recovery_receipt_invalid');
        const current=await captureRecovery();
        try{
          if(current.receipt.sha256!==receipt.sha256||JSON.stringify(current.receipt.identity)!==JSON.stringify(receipt.identity))
            throw fail('intent_changed');
          return true;
        }finally{current.bytes.fill(0);}
      };
      const persist=async(plan,verify)=>{
        if(committed||closed||typeof verify!=='function')throw fail('transition_recovery_receipt_invalid');
        const next={...selected.state,phase:'retiring',retirement:plan},serialized=JSON.stringify(next);
        if(!stateValid(next)||Buffer.byteLength(serialized)>RETIRE_LIMIT)throw fail('intent_invalid');
        receipt=await publishIntent(serialized,next,async ownStage=>{
          await known.check(ownStage);
          if(await verify(ownStage)!==true)throw fail('transition_recovery_receipt_invalid');
          await known.check(ownStage);
        });
        committed=true;await check();return next;
      };
      const finish=async verify=>{
        if(!committed||typeof verify!=='function')throw fail('transition_recovery_receipt_invalid');
        await check();
        if(await verify()!==true)throw fail('transition_recovery_receipt_invalid');
        await check();await fsApi.unlink(file);finished=true;await flush([root,base]);
      };
      try{await check();const result=await recover({check,persist,finish});if(!finished)throw fail('transition_recovery_receipt_invalid');return result;}
      finally{closed=true;known.retired=true;known.bytes.fill(0);writing=false;}
    }
    async function recoverTransition(selected, recover) {
      const known = recoveryProofs.get(selected);
      if (!known || known.kind !== 'transition' || known.owner !== controlIdentity || known.retired || selected.state.phase==='retiring' || typeof recover !== 'function')
        throw fail('transition_recovery_receipt_invalid');
      if (writing) throw fail('intent_busy');
      writing = true;
      let completed = null, completing = null;
      const check = () => {
        if (known.retired) throw fail('transition_recovery_receipt_invalid');
        return known.check();
      };
      const finish = async verifyResult => {
        const verify = async () => {
          if (await verifyResult() !== true) throw fail('completion_unverified');
        };
        await check(); await verify();
        if (selected.state.phase === 'complete') {
          await check();
          return true;
        }
        const final = {...selected.state,phase:'complete'};
        completed = await publishIntent(JSON.stringify(final), final, async ownStage => {
          await known.check(ownStage); await verify(); await known.check(ownStage);
        });
        return true;
      };
      const complete = verifyResult => {
        if (known.retired || completing || !selected.state.transitionReady || typeof verifyResult !== 'function')
          throw fail('transition_recovery_receipt_invalid');
        completing = finish(verifyResult);
        completing.catch(()=>{});
        return completing;
      };
      try {
        await check();
        const result = await recover(selected.state, check, complete);
        if (completing) await completing;
        if (completed) {
          const current = await captureRecovery();
          try {
            if (current.receipt.sha256 !== completed.sha256 || current.receipt.identity.dev !== completed.identity.dev
              || current.receipt.identity.ino !== completed.identity.ino) throw fail('intent_changed');
          } finally { current.bytes.fill(0); }
        } else await check();
        return result;
      } finally {
        if (completing) await Promise.allSettled([completing]);
        known.retired = true;
        known.bytes.fill(0);
        writing = false;
      }
    }
    async function recoverComplete(selected,verifyCompleted,assertFinal) {
      const known=recoveryProofs.get(selected);
      if(!known||known.kind!=='complete'||known.owner!==controlIdentity||known.retired)throw fail('complete_recovery_receipt_invalid');
      if(typeof verifyCompleted!=='function'||typeof assertFinal!=='function')throw fail('completion_unverified');
      if(writing)throw fail('intent_busy');writing=true;
      try {
        // This primitive delegates C11 business qualification to the trusted
        // host. The read token proves only this exact complete intent, and the
        // callbacks must prove the existing durable result and its bound backup.
        // It is never an independent result validator or a C10 success receipt.
        const verify=async()=>{try{if(await verifyCompleted(selected.state)===true)return;}catch(cause){throw fail('completion_unverified',cause);}throw fail('completion_unverified');};
        await known.check();await verify();await known.check();await verify();await known.check();
        // Synchronous source/helper and original PID safety checks follow the last
        // awaited intent capture, immediately before the only intent deletion.
        if(assertFinal()!==true)throw fail('completion_unverified');
        await fsApi.unlink(file);known.retired=true;
        await flush([root,base]);
        try{await fsApi.lstat(file);}catch(cause){if(cause.code==='ENOENT')return true;throw cause;}
        throw fail('intent_changed');
      }finally{writing=false;}
    }

    async function finish(receipt, verifyPublished) {
      if (writing) throw fail('intent_busy'); writing = true;
      try {
        await inspect();
        const current = await verify(receipt);
        if (current.phase !== 'complete' || issued.get(receipt).state.phase !== 'complete'
          || typeof verifyPublished !== 'function' || await verifyPublished() !== true) throw fail('completion_unverified');
        await verify(receipt); await fsApi.unlink(file); await flush([root, base]); issued.delete(receipt);
      } finally { writing = false; }
    }
    return Object.freeze({ inspect, write, verify, finish, selectCompleteRecovery, recoverComplete, selectTransitionRecovery, recoverTransition, recoverInverse });
  }
  return Object.freeze({ create, acceptsRecoveryProfile, verifyRecoveryProfile, legacyTransitionSourceScope, sourceOrdinaryDigest });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
// Late immutable binding, matching the captured-file adapter pattern in 01aa.
// Only this owner can validate its module-private WeakMap recovery proofs.
if(typeof WorkDataFullSnapshot!=='undefined'&&WorkDataFullSnapshot.Hooks)Object.defineProperty(WorkDataFullSnapshot.Hooks,'controlRecoveryProfile',{
  enumerable:true,configurable:false,writable:false,value:Object.freeze({
    accepts:WorkDataMaintenanceControl.acceptsRecoveryProfile,verify:WorkDataMaintenanceControl.verifyRecoveryProfile,
  }),
});
