// Production adapter building blocks only. No startup/configure side effect, no
// claim/upload/activation implementation, and no public worker-ready capability.
const WorkDataNativeAdapters = ((io, p, c) => {
  const INPUT_LIMIT = 32768, VERIFY_MS = 120000, CLOSE_MS = 2000;
  const ID = /^[a-f0-9]{48}$/, SHA = /^[a-f0-9]{64}$/;
  const keys = x => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().join(',') : '';
  // Same-path comparison follows the platform's path identity: Windows paths are
  // case-insensitive, so a case variant of one physical path is still that path.
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const fail = (code, uncertain = false) => Object.assign(Error('work_data_adapter.' + code), {
    code:'work_data_adapter.' + code, retry:false, ...(uncertain ? {helperMayStillRun:true} : {}),
  });
  const absolute = x => typeof x === 'string' && x.length <= 4096 && !/[\0\r\n]/.test(x)
    && p.isAbsolute(x) && p.resolve(x) === x && p.parse(x).root !== x;
  function input(value) {
    if (keys(value) !== 'generation,id,kind,nonce,parentPid,password,schema,target' || value.schema !== 1 || value.kind !== 'verify-full'
      || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.nonce !== 'string' || !SHA.test(value.nonce) || !Number.isSafeInteger(value.parentPid) || value.parentPid < 1
      || !absolute(value.target) || !(value.generation === null || Number.isSafeInteger(value.generation) && value.generation >= 0)
      || typeof value.password !== 'string' || value.password.length < 12 || Buffer.byteLength(value.password) > 1024
      || value.password.includes('\0') || Buffer.from(value.password).toString('utf8') !== value.password) throw fail('input_invalid');
    return value;
  }
  function result(value, request, pid) {
    if (keys(value) !== 'directories,files,generation,id,kind,nonce,pid,schema,sourceSha256,target' || value.schema !== 1 || value.kind !== 'verified-full'
      || value.id !== request.id || value.nonce !== request.nonce || value.pid !== pid || value.target !== request.target
      || !Number.isSafeInteger(value.generation) || value.generation < 0 || request.generation !== null && value.generation !== request.generation
      || typeof value.sourceSha256 !== 'string' || !SHA.test(value.sourceSha256) || !Number.isSafeInteger(value.files) || value.files < 0
      || !Number.isSafeInteger(value.directories) || value.directories < 0) throw fail('result_invalid');
    return Object.freeze({...value});
  }
  function productionBindings() {
    return {ownership:ServerOwnership, manifest:WorkDataManifest, fullSnapshot:WorkDataFullSnapshot,
      nativePublish:WorkDataNativePublish, disposableTree:WorkDataDisposableNativeTree,
      capturePreserved:migrationCapsuleCapturePreserved, protector:LocalSecretCrypto,
      externalOwner:options => ExternalBotCredentials.create(options), skillOwner:options => MigrationHooks.createBackupOwner(options),
      migrationHost:WorkDataMigrationHost, resultOwner:WorkDataMaintenanceResult, worker:WorkDataMaintenanceWorker,
      writeJson:atomicWriteJson, appVersion:VERSION,
      helperMayStillRun:() => LocalSecretCrypto.helperMayStillRun() || MigrationHooks.helperMayStillRun()};
  }
  function create({bindings = productionBindings(), proc = process, verifierCommand = null,
    clock = {setTimeout,clearTimeout,setInterval}} = {}) {
    for (const [name, methods] of Object.entries({ownership:['acquire','canonicalRoot','isLease','owns','createSourceKeeper','isSourceKeeper'],manifest:['create'],fullSnapshot:['create'],
      nativePublish:['createFlush'],disposableTree:['create'],migrationHost:['create'],worker:['create','spawnCold','processChannel']})) {
      if (!bindings[name] || methods.some(method => typeof bindings[name][method] !== 'function')) throw fail('bindings_invalid');
    }
    if (!bindings.protector || ['supported','run'].some(name => typeof bindings.protector[name] !== 'function')
      || ['capturePreserved','externalOwner','skillOwner','writeJson','helperMayStillRun'].some(name => typeof bindings[name] !== 'function')
      || !bindings.resultOwner || typeof bindings.appVersion !== 'string' || !Number.isSafeInteger(proc.pid) || proc.pid < 1
      || ['setTimeout','clearTimeout','setInterval'].some(name => typeof clock[name] !== 'function')) throw fail('bindings_invalid');
    const command = verifierCommand === null ? null : (() => {
      if (keys(verifierCommand) !== 'args,command' || typeof verifierCommand.command !== 'string' || !verifierCommand.command
        || !Array.isArray(verifierCommand.args) || !verifierCommand.args.every(x => typeof x === 'string')) throw fail('command_invalid');
      return Object.freeze({command:verifierCommand.command,args:Object.freeze([...verifierCommand.args])});
    })();
    let unknown = false, verifying = false, heldTimer = null;
    const receipts = new WeakSet();
    function latch(cause) {
      const isProxy = require('node:util').types.isProxy, active = new Set(), done = new Set();
      let nodes = 0;
      function observe(value, depth = 0) {
        if (!value || typeof value !== 'object' && typeof value !== 'function') return false;
        if (isProxy(value) || active.has(value)) return true;
        if (done.has(value)) return false;
        if (depth >= 16 || ++nodes > 128) return true;
        active.add(value);
        try {
          if (Array.isArray(value)) {
            const length = Object.getOwnPropertyDescriptor(value,'length');
            if (!length || !Object.hasOwn(length,'value') || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 64) return true;
            for (let i = 0; i < length.value; i++) {
              const item = Object.getOwnPropertyDescriptor(value,String(i));
              if (!item || !Object.hasOwn(item,'value') || observe(item.value,depth+1)) return true;
            }
          }
          let prototype = value;
          for (let level = 0; prototype !== null; level++) {
            if (level >= 16 || isProxy(prototype)) return true;
            for (const name of ['helperMayStillRun','ownershipRetained','cause','errors']) {
              const descriptor = Object.getOwnPropertyDescriptor(prototype,name);
              if (!descriptor) continue;
              if (!Object.hasOwn(descriptor,'value')) return true;
              if (name === 'helperMayStillRun' || name === 'ownershipRetained') {
                if (descriptor.value !== undefined && descriptor.value !== false) return true;
              } else if (name === 'cause') {
                if (observe(descriptor.value,depth+1)) return true;
              } else {
                const errors = descriptor.value;
                if (!errors || isProxy(errors) || !Array.isArray(errors) || observe(errors,depth+1)) return true;
              }
            }
            prototype = Object.getPrototypeOf(prototype);
          }
          done.add(value); return false;
        } finally { active.delete(value); }
      }
      try {
        if (observe(cause) || bindings.helperMayStillRun() !== false) unknown = true;
      } catch { unknown = true; }
      return unknown;
    }
    const check = () => { if (latch(null)) throw fail('helper_uncertain', true); };
    const guarded = async work => { check(); try { const value = await work(); check(); return value; } catch(error) { latch(error); throw error; } };
    const protector = Object.freeze({supported:() => bindings.protector.supported(),run:(...args) => guarded(() => bindings.protector.run(...args))});
    const flushNative = bindings.nativePublish.createFlush();
    const census = bindings.disposableTree.create({capturePreserved:(...args) => guarded(() => bindings.capturePreserved(...args))});
    async function flush(directories) {
      const selected = [...directories], value = await guarded(() => flushNative(selected));
      if (keys(value) !== 'directoryFlush,flushDirectories,ok' || value.ok !== true || !Array.isArray(value.flushDirectories)
        || JSON.stringify(value.flushDirectories) !== JSON.stringify(selected) || !Array.isArray(value.directoryFlush)
        || value.directoryFlush.length !== selected.length || value.directoryFlush.some(x => x !== 0)) throw fail('flush_unverified');
      return value;
    }
    async function disposable(value) { if (await guarded(() => census(value)) !== true) throw fail('census_unverified'); return true; }
    function sourceKeeper({base,ownership}) {
      check(); const keeper = bindings.ownership.createSourceKeeper(ownership,base);
      if (!bindings.ownership.isSourceKeeper(keeper,ownership,base)) throw fail('source_keeper_invalid');
      return keeper;
    }
    async function withSource(ownership,base,work) {
      const keeper = sourceKeeper({base,ownership}); let failed = false, primary;
      try { const value = await guarded(() => work(keeper)); if (!keeper.assertExclusive(ownership)) throw fail('source_owner_lost',true); return value; }
      catch (error) { failed = true; primary = error; latch(error); throw error; }
      finally {
        const cleanup = [];
        if (latch(null)) { try { keeper.retainUnknown(failed ? primary : undefined); } catch(error) { cleanup.push(error); } if (!failed) cleanup.push(fail('helper_uncertain',true)); }
        else { try { await keeper.releaseChecked(() => { check(); return true; }); check(); } catch(error) { unknown = true; cleanup.push(error); try { keeper.retainUnknown(error); } catch { /* The genuine lease already retained its close uncertainty. */ } } }
        if (cleanup.length) throw Object.assign(new AggregateError(failed ? [primary,...cleanup] : cleanup,'work_data_adapter.source_keeper_cleanup',{cause:failed ? primary : cleanup[0]}),{
          code:'work_data_adapter.source_keeper_cleanup',helperMayStillRun:true,ownershipRetained:true,retry:false});
      }
    }
    function fullSnapshot(base, ownership, assertExclusive) {
      check(); if (typeof assertExclusive !== 'function' || !bindings.ownership.owns(ownership,base)) throw fail('ownership_required');
      const exclusive = async candidate => bindings.ownership.owns(candidate) && await assertExclusive(candidate) === true && bindings.ownership.owns(candidate);
      const owner = bindings.fullSnapshot.create({base,ownership,assertExclusive:exclusive,protector,
        externalOwner:bindings.externalOwner,skillBackupOwner:bindings.skillOwner,maintenanceResultOwner:bindings.resultOwner});
      return Object.freeze({seal:value => withSource(ownership,base,() => owner.seal(value)),
        restore:value => withSource(ownership,base,() => withSource(value?.targetOwnership === undefined ? ownership : value.targetOwnership,value?.target,() => owner.restore(value)))});
    }
    async function readAuthority(base) { return guarded(async () => {
      const value = await bindings.manifest.create({base}).readActive();
      if (value.generation !== 0) return value;
      // Legacy mode is the raw mirror. Never invoke repairing readConfig here.
      const file = p.join(base,'config.json'), before = await io.lstat(file,{bigint:true});
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4194304n) throw fail('config_invalid');
      const handle = await io.open(file,'r'); let bytes, primary, failed = false;
      try {
        const opened = await handle.stat({bigint:true});
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1n) throw fail('config_changed');
        const buffer = Buffer.alloc(Number(before.size) + 1); bytes = buffer; let used = 0;
        for (;;) { const read = await handle.read(buffer,used,buffer.length-used,null); used += read.bytesRead; if (used > Number(before.size)) throw fail('config_changed'); if (!read.bytesRead) break; }
        const after = await handle.stat({bigint:true}), selected = await io.lstat(file,{bigint:true});
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
          || selected.isSymbolicLink() || selected.nlink !== 1n || selected.dev !== after.dev || selected.ino !== after.ino
          || selected.size !== after.size || selected.mtimeNs !== after.mtimeNs || selected.ctimeNs !== after.ctimeNs) throw fail('config_changed');
        bytes = buffer.subarray(0,used); const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw fail('config_invalid');
        const config = JSON.parse(text.replace(/^\uFEFF/,''));
        if (!config || typeof config !== 'object' || Array.isArray(config) || config.workDataEncryptionV1 !== undefined && typeof config.workDataEncryptionV1 !== 'boolean') throw fail('config_invalid');
        return Object.freeze({...value,mode:config.workDataEncryptionV1 === true ? 'encrypted' : 'plain'});
      } catch(error) { failed = true; primary = error; throw error; }
      finally {
        const cleanup = [];
        try { bytes?.fill(0); } catch(error) { cleanup.push(error); }
        try { await handle.close(); } catch(error) { cleanup.push(error); }
        if (cleanup.length) {
          const causes = failed ? [primary,...cleanup] : cleanup;
          for (const cause of causes) latch(cause);
          throw Object.assign(new AggregateError(causes,'work_data_adapter.authority_cleanup_failed',{cause:causes[0]}), {
            code:'work_data_adapter.authority_cleanup_failed',retry:false,...(latch(null) ? {helperMayStillRun:true} : {}),
          });
        }
      }
    }); }
    async function runVerifier(channel = bindings.worker.processChannel(proc)) {
      check(); if (!channel.parentConnected()) throw fail('ipc_required');
      let bytes, request, owner, keeper, finalKeeper, ownerReleased = false, primary, failed = false;
      try {
        bytes = await guarded(() => channel.readInput(INPUT_LIMIT));
        if (!Buffer.isBuffer(bytes) || bytes.length > INPUT_LIMIT) throw fail('input_invalid');
        const raw = bytes.toString('utf8'); if (!Buffer.from(raw).equals(bytes)) throw fail('input_invalid');
        request = input(JSON.parse(raw));
        // canonicalRoot still proves the real path and rejects aliases; the comparison
        // only tolerates the case variant Windows gives back for one physical path.
        if (request.parentPid !== channel.parentPid() || request.parentPid === proc.pid
          || fold(await bindings.ownership.canonicalRoot(request.target)) !== fold(request.target)) throw fail('parent_or_target_invalid');
        owner = await bindings.ownership.acquire([request.target]); keeper = sourceKeeper({base:request.target,ownership:owner});
        finalKeeper = sourceKeeper({base:request.target,ownership:owner});
        const exclusive = keeper.assertExclusive;
        if (!exclusive(owner)) throw fail('ownership_required');
        const before = await readAuthority(request.target);
        if (request.generation !== null && before.generation !== request.generation) throw fail('authority_changed');
        const captured = await guarded(() => fullSnapshot(request.target,owner,exclusive).seal({password:request.password,appVersion:bindings.appVersion,generation:before.generation}));
        const after = await readAuthority(request.target);
        if (before.generation !== after.generation || before.id !== after.id || before.mode !== after.mode || before.proof.sha256 !== after.proof.sha256) throw fail('authority_changed');
        const reply = result({schema:1,kind:'verified-full',id:request.id,nonce:request.nonce,pid:proc.pid,target:request.target,
          generation:after.generation,sourceSha256:captured.sourceProof.sha256,files:captured.files,directories:captured.directories},request,proc.pid);
        // A result is not permission to release an uncertain helper/owner.
        check(); await channel.send(reply); return reply;
      } catch(error) { failed = true; primary = error; latch(error); throw error; }
      finally {
        const cleanup = [];
        const record = error => { cleanup.push(error); latch(error); };
        try { if (Buffer.isBuffer(bytes)) bytes.fill(0); } catch(error) { record(error); }
        try { if (request) request.password = null; } catch(error) { record(error); }
        if (owner && !latch(null)) {
          try {
            if (!bindings.ownership.isLease(owner) || !keeper || !finalKeeper) throw fail('ownership_unproven',true);
            await keeper.releaseChecked(() => { check(); return true; }); check();
            await finalKeeper.releaseOwner(() => { check(); return true; }); check();
            ownerReleased = true;
          } catch(error) { record(error); unknown = true; }
        }
        if (owner && !ownerReleased) {
          const retaining = finalKeeper || keeper;
          if (retaining) { try { retaining.retainUnknown(failed ? primary : cleanup[0]); } catch(error) { record(error); } }
          if (latch(null)) record(fail('helper_uncertain',true));
          if (heldTimer === null) {
            try { heldTimer = clock.setInterval(() => { void owner; void keeper; void primary; },60000); heldTimer.ref?.(); }
            catch(error) { record(error); unknown = true; }
          }
        }
        if (cleanup.length) {
          const causes = failed ? [primary,...cleanup] : cleanup;
          throw Object.assign(new AggregateError(causes,'work_data_adapter.verifier_cleanup_failed',{cause:causes[0]}), {
            code:'work_data_adapter.verifier_cleanup_failed', retry:false, ...(latch(null) ? {helperMayStillRun:true} : {}),
          });
        }
      }
    }
    async function verifyFreshReceipt({target,password,generation = null,id = c.randomBytes(24).toString('hex')}) {
      check(); if (!command) throw fail('verifier_entry_unbound'); if (verifying) throw fail('verifier_busy');
      const request = input({schema:1,kind:'verify-full',id,nonce:c.randomBytes(32).toString('hex'),parentPid:proc.pid,target,password,generation});
      const serialized = Buffer.from(JSON.stringify(request)); request.password = null;
      if (serialized.length > INPUT_LIMIT) { serialized.fill(0); throw fail('input_invalid'); }
      verifying = true;
      try {
        const env = bindings.worker.create({env:proc.env}).environment(target);
        const child = bindings.worker.spawnCold(command,env);
        return await new Promise((resolve,reject) => {
          let settled = false, spawned = false, exited = false, exitCode = null, exitSignal = null, response = null, error = null, closeTimer = null;
          const finish = (cause, receipt) => { if (settled) return; settled = true; clock.clearTimeout(timer); if (closeTimer) clock.clearTimeout(closeTimer); serialized.fill(0); if (cause) {latch(cause);reject(cause);} else {receipts.add(receipt);resolve(receipt);} };
          const stop = cause => { if (settled || error) return; error = cause; closeTimer = clock.setTimeout(() => { unknown = true; finish(fail('verifier_close_unverified',true)); },CLOSE_MS); try {child.kill();} catch {} };
          const timer = clock.setTimeout(() => stop(fail('verifier_timeout')),VERIFY_MS);
          child.once('spawn',() => {spawned = true;});
          child.once('exit',(code,signal) => {exited = true;exitCode = code;exitSignal = signal;});
          child.on('error',() => { if (!spawned && !child.pid) finish(fail('verifier_unavailable')); else stop(fail('verifier_process')); });
          child.on('message',value => {try {if (response) throw fail('result_duplicate');response = result(value,request,child.pid);} catch(cause) {stop(cause);} });
          child.once('close',(code,signal) => {if (settled) return; if (error) return finish(error); if (!spawned || !exited || exitCode !== 0 || exitSignal || code !== 0 || signal || !response || !Number.isSafeInteger(child.pid) || child.pid < 1) return finish(fail('verifier_failed')); try {check();finish(null,response);} catch(cause) {finish(cause);} });
          child.stdin.once('error',() => stop(fail('verifier_input')));
          try {child.stdin.end(serialized,() => serialized.fill(0));} catch {stop(fail('verifier_input'));}
        });
      } catch(error) { latch(error); throw error; }
      finally {serialized.fill(0);verifying = false;}
    }
    const verifyFresh = async value => { await verifyFreshReceipt(value); return true; };
    function coldOperationHost(progress) {
      if (typeof progress !== 'function') throw fail('progress_invalid'); check();
      return Object.freeze({acquire:roots => {check();return bindings.ownership.acquire(roots);},sourceKeeper,flush,verifyFresh,
        verifyDisposableNativeTree:disposable,migrationFactory:options => {
          check(); const owner = bindings.migrationHost.create(options), wrapped = {};
          for (const name of ['prepare','publish','cancel','verifyPublished']) wrapped[name] = value => guarded(() => owner[name](value));
          return Object.freeze(wrapped);
        },
        progress,helperMayStillRun:() => latch(null)});
    }
    const capabilities = Object.freeze({implemented:Object.freeze(['native-flush-adapter','full-snapshot-adapter','cold-verifier-protocol','genuine-source-keeper']),verifierCommandBound:command !== null,
      operations:Object.freeze({enable:false,disable:false,export:false,restore:false}),
      unsupported:Object.freeze(['runtime-configure','crash-claim','upload','download','fresh-root-activation'])});
    return Object.freeze({capabilities,sourceKeeper,flush,verifyDisposableNativeTree:disposable,fullSnapshot,readAuthority,runVerifier,verifyFresh,verifyFreshReceipt,
      coldOperationHost,helperMayStillRun:cause => latch(cause),ownsVerifierReceipt:value => receipts.has(value)});
  }
  return Object.freeze({create,input,result,INPUT_LIMIT,VERIFY_MS,CLOSE_MS});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'));
