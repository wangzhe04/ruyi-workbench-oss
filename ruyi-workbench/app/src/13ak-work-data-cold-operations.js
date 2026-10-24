// Operation body for the fresh maintenance worker. The launcher supplies actual
// owner lifetimes; snapshot, codec and native-object work use their real owners.
// This module never starts a normal server or changes process-global paths.
const WorkDataColdOperations = ((io, p, cryptoApi) => {
  const hash = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const fold = name => process.platform === 'win32' ? name.toLowerCase() : name;
  const fail = (suffix, details = {}) => Object.assign(new Error('work_data_setup.' + suffix), {
    code: 'work_data_setup.' + suffix, apiCode: 'work_data_setup.' + suffix,
    statusCode: 409, retry: false, ...details,
  });
  const inside = (root, target) => {
    const rel = p.relative(fold(root), fold(target)); return rel === '' || rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel);
  };
  async function realDirectory(directory) {
    const absolute = p.resolve(directory), parsed = p.parse(absolute); let current = parsed.root;
    for (const part of ['', ...absolute.slice(parsed.root.length).split(p.sep).filter(Boolean)]) {
      if (part) current = p.join(current, part);
      const stat = await io.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fold(await io.realpath(current)) !== fold(current)) throw fail('path_alias');
    }
  }
  async function absent(file) {
    try { await io.lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw fail('target_exists');
  }
  async function readBounded(file, maximum) {
    await realDirectory(p.dirname(file)); const before = await io.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) throw fail('file_invalid');
    const handle = await io.open(file, 'r');
    try {
      const parts = []; let bytes = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(65536, maximum - bytes + 1)); const result = await handle.read(buffer, 0, buffer.length, null);
        bytes += result.bytesRead; if (bytes > maximum) throw fail('file_too_large');
        if (!result.bytesRead) break; parts.push(buffer.subarray(0, result.bytesRead));
      }
      const after = await handle.stat({ bigint: true }), selected = await io.lstat(file, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n
        || !selected.isFile() || selected.isSymbolicLink() || selected.nlink !== 1n
        || selected.dev !== after.dev || selected.ino !== after.ino || selected.size !== after.size
        || selected.mtimeNs !== after.mtimeNs || selected.ctimeNs !== after.ctimeNs) throw fail('file_changed');
      return { bytes: Buffer.concat(parts, bytes), identity: { dev: String(after.dev), ino: String(after.ino) } };
    } finally { await handle.close(); }
  }
  // A preflight estimate, not a reservation: other applications can consume
  // space later. Group by filesystem device, including distinct selected paths
  // on the same volume, and use unprivileged available blocks, never bfree.
  async function requireSpace(requests) {
    const volumes = new Map();
    for (const [directory,bytes] of requests) {
      let stat,space;
      try {
        await realDirectory(directory);stat=await io.lstat(directory,{bigint:true});space=await io.statfs(directory,{bigint:true});
        if(typeof bytes!=='bigint'||bytes<0n||typeof space.bsize!=='bigint'||space.bsize<=0n||typeof space.bavail!=='bigint'||space.bavail<0n)throw fail('space_unavailable');
      } catch(cause) {throw fail('space_unavailable',{cause});}
      const device=String(stat.dev),available=space.bsize*space.bavail,prior=volumes.get(device);
      volumes.set(device,{required:bytes+(prior?.required||0n),available:prior&&prior.available<available?prior.available:available});
    }
    for(const value of volumes.values())if(value.required>value.available)throw fail('space_insufficient',{requiredBytes:String(value.required),availableBytes:String(value.available)});
  }
  const treeBudget = (bytes,files,directories) => 16n*1024n*1024n+2n*BigInt(bytes)+65536n*BigInt(files)+8192n*BigInt(directories+1);
  function create(host) {
    if (['acquire', 'flush', 'verifyFresh', 'verifyDisposableNativeTree', 'migrationFactory', 'progress', 'helperMayStillRun'].some(name => typeof host[name] !== 'function')) throw fail('operation_host_invalid');
    async function execute(context) {
      const base = p.resolve(context.base), id = context.id;
      if (!/^[a-f0-9]{48}$/.test(id || '') || await context.assertExclusive(context.ownership) !== true) throw fail('ownership_required');
      const owned = new Set(), issuedBackups = new Map(); let alive = true, mutation = false, intent = null, restoreStarted = false, resultStarted = false, helperUncertain = false;
      const retainHelper = cause => {
        const seen = new Set(); let current = cause;
        try {
          for (let depth=0;current && (typeof current==='object'||typeof current==='function');depth++) {
            if (depth>=32 || seen.has(current)) {helperUncertain=true;break;}
            seen.add(current);if (current.helperMayStillRun===true) {helperUncertain=true;break;}current=current.cause;
          }
          if (host.helperMayStillRun() !== false) helperUncertain=true;
          if (typeof MigrationHooks !== 'undefined') { const inspect=MigrationHooks.helperMayStillRun; if (inspect!==undefined && (typeof inspect!=='function' || inspect()!==false)) helperUncertain=true; }
          if (typeof LocalSecretCrypto.helperMayStillRun === 'function' && LocalSecretCrypto.helperMayStillRun() !== false) helperUncertain=true;
        } catch {helperUncertain=true;}
        return helperUncertain;
      };
      if (retainHelper(null)) throw fail('native_helper_uncertain',{helperMayStillRun:true});
      const assertExclusive = owner => alive && context.assertExclusive(context.ownership) === true
        && (owner === context.ownership || owned.has(owner));
      // Record native uncertainty before key/vault owners replace private native
      // errors with their public typed codes. Never modify a foreign exception.
      const protector = Object.freeze({supported:()=>LocalSecretCrypto.supported(),async run(...args){
        try{return await LocalSecretCrypto.run(...args);}catch(cause){retainHelper(cause);throw cause;}
      }});
      const acquire = async root => {
        if (inside(base, root) || inside(root, base)) throw fail('target_invalid');
        const owner = await host.acquire([root]); owned.add(owner); return owner;
      };
      const release = async owner => { if (retainHelper(null)) throw fail('native_helper_uncertain',{helperMayStillRun:true}); if (!owned.has(owner)) throw fail('ownership_required'); owned.delete(owner); await owner.release(); };
      const full = () => WorkDataFullSnapshot.create({ base, ownership: context.ownership, assertExclusive,
        protector, externalOwner: options => ExternalBotCredentials.create(options),
        skillBackupOwner: options => MigrationHooks.createBackupOwner(options), maintenanceResultOwner: WorkDataMaintenanceResult });
      const authority = await WorkDataManifest.create({ base }).readActive();
      if (authority.generation !== context.expectedAuthority.generation || authority.proof.sha256 !== context.expectedAuthority.sha256) throw fail('authority_changed');
      let sourceMode = authority.mode;
      if (!authority.generation) {
        const sourceConfig = await readBounded(p.join(base, 'config.json'), 4 * 1024 * 1024);
        const text = sourceConfig.bytes.toString('utf8');
        if (!Buffer.from(text).equals(sourceConfig.bytes)) throw fail('config_unavailable');
        const value = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || value.workDataEncryptionV1 !== undefined && typeof value.workDataEncryptionV1 !== 'boolean') throw fail('config_unavailable');
        sourceMode = value.workDataEncryptionV1 === true ? 'encrypted' : 'plain';
      }
      if (sourceMode !== context.expectedAuthority.mode || authority.id !== context.expectedAuthority.id) throw fail('authority_changed');
      const expected = Object.freeze({ generation: authority.generation, id: authority.id, mode: sourceMode, sha256: authority.proof.sha256 });
      const readResultAuthority = async () => {
        const current = await WorkDataManifest.create({ base }).readActive(); let mode = current.mode;
        if (!current.generation) {
          const raw = await readBounded(p.join(base,'config.json'),4*1024*1024), text = raw.bytes.toString('utf8');
          if (!Buffer.from(text).equals(raw.bytes)) throw fail('config_unavailable');
          const value = JSON.parse(text.replace(/^\uFEFF/,''));
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || value.workDataEncryptionV1 !== undefined && typeof value.workDataEncryptionV1 !== 'boolean') throw fail('config_unavailable');
          mode = value.workDataEncryptionV1 === true ? 'encrypted' : 'plain';
        }
        return Object.freeze({generation:current.generation,id:current.id,mode,sha256:current.proof.sha256});
      };
      const maxPackage = WorkDataRecovery.LIMITS.serialized;
      const verifyBackup = async value => {
        const receipt = issuedBackups.get(value.path);
        if (!receipt || receipt.sha256 !== value.sha256 || !assertExclusive(context.ownership)) return false;
        if ('identity' in value && (value.bytes !== receipt.bytes || value.identity?.dev !== receipt.identity.dev || value.identity?.ino !== receipt.identity.ino)) return false;
        const current = await readBounded(value.path, maxPackage);
        return current.identity.dev === receipt.identity.dev && current.identity.ino === receipt.identity.ino && hash(current.bytes) === receipt.sha256;
      };
      const control = WorkDataMaintenanceControl.create({ base, ownership: context.ownership, assertExclusive,
        assertDurableBackup: verifyBackup, flush: host.flush });
      if (context.operation !== 'restore' && (await control.inspect()).pending) throw fail('intent_pending');
      const results = WorkDataMaintenanceResult.create({base,ownership:context.ownership,assertExclusive,
        readAuthority:readResultAuthority,assertDurableBackup:verifyBackup,flush:host.flush});
      const persistResult = async result => {
        resultStarted = true;
        const receipt = issuedBackups.get(result.backup.path);
        if (!receipt) throw fail('backup_unverified');
        const value = {schema:1,id,operation:context.operation,state:result.state,finishedAt:new Date().toISOString(),
          sourceAuthority:expected,authority:await readResultAuthority(),
          backup:{path:receipt.path,sha256:receipt.sha256,bytes:receipt.bytes,identity:{...receipt.identity}},
          ...(context.operation === 'restore' ? {restored:{target:result.restored.target,activation:result.activation}} : {})};
        const saved = await results.write(value);
        if (await results.verify(saved) !== true) throw fail('result_unverified');
        return saved;
      };
      const completed = async result => {await persistResult(result);return Object.freeze(result);};
      const progress = phase => host.progress(Object.freeze({ id, operation: context.operation, phase }));
      try {
        const backupDirectory = context.paths.backupDirectory;
        if (!p.isAbsolute(backupDirectory) || inside(base, backupDirectory) || inside(backupDirectory, base)) throw fail('backup_directory_invalid');
        await realDirectory(backupDirectory);
        if (!['enable', 'disable', 'export', 'restore'].includes(context.operation)) throw fail('operation_invalid');
        if (context.operation === 'enable' && expected.mode === 'encrypted' || context.operation === 'disable' && expected.mode === 'plain') throw fail('mode_unchanged');
        const saveBackup = async bytes => {
          const backupFile = p.join(backupDirectory, 'ruyi-work-data-' + id + '.ruyi-backup'); await absent(backupFile);
          const handle = await io.open(backupFile, 'wx', 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          await host.flush([backupDirectory]);
          const saved = await readBounded(backupFile, maxPackage);
          if (!saved.bytes.equals(bytes)) throw fail('backup_verification_failed');
          const backup = Object.freeze({path:backupFile,sha256:hash(saved.bytes)});
          issuedBackups.set(backupFile,Object.freeze({...backup,bytes:saved.bytes.length,identity:saved.identity}));
          return backup;
        };
        if (context.operation === 'restore') {
          // Password recovery is independent of the current source keys. Authenticate
          // the entire upload before creating any backup, result or target object.
          if (typeof context.paths.uploadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(context.paths.uploadSha256)) throw fail('upload_unverified');
          const uploaded = await readBounded(context.paths.uploadFile,maxPackage);
          if (hash(uploaded.bytes) !== context.paths.uploadSha256) throw fail('upload_changed');
          const serialized = uploaded.bytes.toString('utf8');
          if (!Buffer.from(serialized,'utf8').equals(uploaded.bytes)) throw fail('upload_invalid');
          const authenticated = await WorkDataRecovery.open(serialized,context.password);
          try {
            const target = context.paths.targetDirectory;
            if (typeof target !== 'string' || !p.isAbsolute(target) || inside(base,target) || inside(target,base)
              || inside(target,backupDirectory)) throw fail('target_invalid');
            await realDirectory(p.dirname(target)); await absent(target);
            const snapshot=authenticated.snapshot,decodedBytes=snapshot.files.reduce((sum,row)=>sum+row.data.length,0)+snapshot.auxiliaries.reduce((sum,row)=>sum+row.data.length,0);
            await requireSpace([[backupDirectory,BigInt(uploaded.bytes.length)+1048576n],[p.dirname(target),treeBudget(decodedBytes,snapshot.files.length,snapshot.directories.length)],[base,1048576n]]);
            const backup = await saveBackup(uploaded.bytes);
            if (!await verifyBackup(backup)) throw fail('backup_changed');
            const targetOwner = await acquire(target);
            restoreStarted = true;
            const restored = await full().restore({serialized,password:context.password,target,targetOwnership:targetOwner});
            await release(targetOwner);
            if (await host.verifyFresh({target,password:context.password,generation:null}) !== true) throw fail('fresh_verification_failed');
            if (!await verifyBackup(backup)) throw fail('backup_changed');
            return await completed({id,operation:'restore',state:'verified',backup,restored,restartRoot:base,
              activation:'separate-fresh-root',publication:'fresh-process-required',profile:restored.profile});
          } finally { authenticated.release(); }
        }
        await progress('snapshot');
        const captured = await full().seal({ password: context.password, appVersion: VERSION, generation: expected.generation });
        const allocation=treeBudget(captured.sourceProof.bytes,captured.files,captured.directories);
        await requireSpace([[backupDirectory,BigInt(Buffer.byteLength(captured.serialized,'utf8'))+1048576n+allocation],[base,context.operation==='export'?1048576n:allocation+1048576n]]);
        const backup = await saveBackup(Buffer.from(captured.serialized,'utf8'));
        await progress('verify-backup');
        // An authenticated package is exercised through the real restore owner,
        // then checked by a separate cold Node process before any source intent.
        const rehearsal = p.join(backupDirectory, '.ruyi-work-data-verify-' + id); await absent(rehearsal);
        const rehearsalOwner = await acquire(rehearsal);
        const rehearsed = await full().restore({ serialized: captured.serialized, password: context.password, target: rehearsal, targetOwnership: rehearsalOwner });
        const tree = WorkDataTree.create(), cleanupProof = await tree.capture(rehearsal);
        try {
          const original = await WorkDataRecovery.open(captured.serialized, context.password);
          try {
            const expectedFiles = new Map(original.snapshot.files.map(row => [row.path, hash(row.data)]));
            for (const row of rehearsed.stagedStates) expectedFiles.set(row.path, row.stagedSha256);
            if (JSON.stringify([...cleanupProof.directories].sort()) !== JSON.stringify([...original.snapshot.directories].sort())
              || cleanupProof.files.length !== expectedFiles.size || cleanupProof.files.some(row => row.sha256 !== expectedFiles.get(row.path))) throw fail('rehearsal_changed');
          } finally { original.release(); }
          await release(rehearsalOwner);
          if (await host.verifyFresh({ target: rehearsal, password: context.password, generation: expected.generation }) !== true) throw fail('fresh_verification_failed');
          const cleanupOwner = await acquire(rehearsal);
          await tree.verify(cleanupProof);
          if (!owned.has(cleanupOwner) || p.dirname(rehearsal) !== backupDirectory || p.basename(rehearsal) !== '.ruyi-work-data-verify-' + id
            || inside(base, rehearsal) || inside(rehearsal, base)) throw fail('rehearsal_cleanup_invalid');
          // Default-stream verification cannot detect a newly added ADS. The
          // native namespace owner must prove the exact newly-created objects
          // have no extra streams/children before this disposable tree is removed.
          if (await host.verifyDisposableNativeTree({ target: rehearsal, snapshot: cleanupProof, ownership: cleanupOwner, assertExclusive }) !== true) throw fail('rehearsal_changed');
          await tree.verify(cleanupProof);
          await io.rm(rehearsal, { recursive: true, force: false }); await host.flush([backupDirectory]);
          await release(cleanupOwner);
        } finally { cleanupProof.release(); }
        if (!await verifyBackup(backup)) throw fail('backup_changed');
        if (context.operation === 'export') return await completed({ id, operation: 'export', state: 'verified', backup, restartRoot: base,
          publication: 'fresh-process-required', profile: captured.profile, retainedPlaintext: 'source root and excluded user content are retained' });
        const state = { schema: 1, id, operation: context.operation, phase: 'prepared', createdAt: new Date().toISOString(), expectedAuthority: expected, backup, candidate: null };
        mutation = true; intent = await control.write(state);
        const update = async (phase, candidate, headerSha256) => {
          state.phase = phase;
          state.candidate = { id: candidate.id, mode: candidate.mode, headerSha256: headerSha256 ?? state.candidate?.headerSha256 ?? null };
          intent = await control.write(state, intent); return Object.freeze({ ownedFile: intent });
        };
        const migration = host.migrationFactory({ base, ownership: context.ownership, assertExclusive,
          manifest: WorkDataManifest.create({ base }), protector,
          assertDurableBackup: ({ backupReceipt, sourceProof }) => backupReceipt === backup && sourceProof === captured && verifyBackup(backupReceipt),
          assertIntent: async () => { await control.verify(intent); return Object.freeze({ ownedFile: intent }); },
          onCandidate: ({ candidate }) => update('candidate', candidate),
          onKeyReady: ({ candidate, headerSha256 }) => update('key-ready', candidate, headerSha256),
          assertSpecialCoverage: async ({backupReceipt,sourceProof}) => backupReceipt === backup && sourceProof === captured
            && captured.specialCoverage?.type === 'skill-backup-portable' && captured.specialCoverage.originalObjects === 'refused' && await verifyBackup(backupReceipt),
          maintenanceResultOwner: WorkDataMaintenanceResult,
          specialOwnerFactory: options => MigrationHooks.createBackupOwner(options), writeJson: atomicWriteJson });
        await progress('prepare-generation');
        const prepared = await migration.prepare({ expected: authority, targetMode: context.operation === 'enable' ? 'encrypted' : 'plain',
          backupReceipt: backup, sourceProof: captured });
        await progress('publish-generation');
        const published = await migration.publish(prepared);
        await update('published', prepared.candidate);
        // verifyPublished must inspect the exact selected generation using cold,
        // independent owner factories; no global mode/cache change is accepted.
        const verifyPublished = async () => {
          const proof = await migration.verifyPublished(prepared), selected = await WorkDataManifest.create({ base }).readActive();
          const sameActive = value => value && value.id === prepared.candidate.id && value.mode === prepared.candidate.mode
            && value.root === prepared.candidate.root && value.generation === expected.generation + 1
            && value.proof?.sha256 === selected.proof.sha256;
          if (!proof || Object.keys(proof).sort().join(',') !== 'active,candidateId,generation,logicalFiles,mode,processExitRequired,readOnly,specialSha256,targetSha256'
            || proof.readOnly !== true || proof.processExitRequired !== true || proof.candidateId !== prepared.candidate.id
            || proof.generation !== expected.generation + 1 || proof.mode !== prepared.candidate.mode
            || !/^[a-f0-9]{64}$/.test(proof.targetSha256) || !/^[a-f0-9]{64}$/.test(proof.specialSha256)
            || proof.logicalFiles !== prepared.transformed.length || !sameActive(proof.active) || !sameActive(published.active)
            || !sameActive(selected)) throw fail('generation_unverified');
          return true;
        };
        await verifyPublished();
        await update('complete', prepared.candidate);
        const result = { id, operation: context.operation, state: 'published', backup, authority: published,
          restartRoot: base, publication: 'fresh-process-required', profile: captured.profile, retainedPlaintext: prepared.retainedPlainDisclosure };
        const resultReceipt = await persistResult(result);
        await control.finish(intent, async()=>await verifyPublished() === true && await results.verify(resultReceipt) === true); intent = null;
        return Object.freeze(result);
      } catch (cause) {
        retainHelper(cause);
        throw fail(mutation ? 'transition_requires_recovery' : restoreStarted ? 'restore_requires_inspection' : resultStarted ? 'result_requires_recovery' : 'preparation_failed', { cause,
          operationMayHaveExecuted: mutation || restoreStarted || resultStarted,
          sourceIntentRetained: intent !== null,
          resultMayHaveBeenWritten: resultStarted,
          ...(helperUncertain ? {helperMayStillRun:true} : {}),
          ...(restoreStarted ? {targetMayHaveBeenCreated:true,targetPath:context.paths.targetDirectory} : {}),
          ...(issuedBackups.size === 1 ? { backupPath: issuedBackups.keys().next().value } : {}) });
      } finally {
        alive = false;
        // Native flush/capsule adapters settle their actual helper before returning.
        // A helper uncertainty is never converted into a released source lease.
        if (!retainHelper(null)) for (const owner of [...owned]) await release(owner);
      }
    }
    return Object.freeze({ execute });
  }
  return Object.freeze({ create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
