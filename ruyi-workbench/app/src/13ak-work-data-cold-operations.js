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
  // 151 阶段 3A(150 号文 W7):演练(把备份包真正恢复一遍)放在数据根【同卷】、数据根旁边、以产品私有前缀命名的临时目录,
  // 不再放进用户选的备份文件夹 —— 备份文件夹可能是 U 盘或云同步目录,任何时候都只能出现密文备份包。
  // 数据根本身就在这一卷、这一位置,所以演练期间的明文不会比数据根自己走得更远。注意:Windows 上 mkdir 的 mode(0o700)
  // 被忽略,目录的 ACL 继承自父目录(默认数据根 ~/.ruyi 的父目录是用户目录,即用户自己的 ACL);模型文件工具的读取由
  // 03 isSensitiveDataPath / 11 sensitiveGlobsForRg 按这个前缀(每个数据根及其别名的同级)拦住。
  // 父目录必须能被原生 flush 刷盘(数据根直接放在盘符根下时,非提权进程刷不了 C:\):13ah 提交前与冷端快照前各探一次。
  const REHEARSAL_PREFIX = '.ruyi-work-data-rehearsal-';
  const rehearsalPathFor = (base, id) => p.join(p.dirname(base), REHEARSAL_PREFIX + id);
  // 151 阶段 3A(W7 残留):冷端被杀或崩溃时演练目录会留下。恢复主人(13au recoverSource / recoverCompletedIntent、
  // 13am 启动收尾)在【已证明两个原进程都已死】之后调用这里,只删本 claim id 对应的那个路径;不是普通目录、是联接/符号链接、
  // realpath 不等于词法路径(祖先有别名)、拿不到独占所有权(比如验证进程还活着)或删不干净,一律类型化拒绝(rehearsal_retained),
  // 让恢复整体失败、交接记录保留 —— 明文副本不会被悄悄遗忘。fs.rm 不跟随目录内的联接(rev3A probe-rm-junction 实测)。
  async function removeOrphanRehearsal({ base, id, acquire }) {
    if (typeof base !== 'string' || !p.isAbsolute(base) || !/^[a-f0-9]{48}$/.test(String(id || '')) || typeof acquire !== 'function') throw fail('rehearsal_retained');
    const target = rehearsalPathFor(p.resolve(base), id);
    let stat;
    try { stat = await io.lstat(target, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return 'absent'; throw fail('rehearsal_retained', { cause: error }); }
    try {
      if (!stat.isDirectory() || stat.isSymbolicLink() || fold(await io.realpath(target)) !== fold(target)) throw fail('rehearsal_retained');
      const owner = await acquire([target]);
      try {
        const again = await io.lstat(target, { bigint: true });
        if (!again.isDirectory() || again.isSymbolicLink() || again.dev !== stat.dev || again.ino !== stat.ino) throw fail('rehearsal_retained');
        await io.rm(target, { recursive: true, force: false });
        try { await io.lstat(target); } catch (error) { if (error.code === 'ENOENT') return 'removed'; throw error; }
        throw fail('rehearsal_retained');
      } finally { if (owner && typeof owner.release === 'function') await owner.release(); }
    } catch (error) {
      if (String(error?.code || '') === 'work_data_setup.rehearsal_retained') throw error;
      throw fail('rehearsal_retained', { cause: error });
    }
  }
  const decimalIdentity = value => !!value && typeof value === 'object' && typeof value.dev === 'string' && typeof value.ino === 'string'
    && /^\d{1,40}$/.test(value.dev) && /^\d{1,40}$/.test(value.ino);
  // 151 阶段 3A:离线 e2e 的故障注入点。生产默认关闭:与仓库其余测试钩子同一道双闸 —— 只有 RUYI_TEST_HOOKS=1
  // 并且 RUYI_TEST_WORK_DATA_COLD_FAULT 为下列名字之一时,才在该点抛出一个本模块的类型化失败
  // (它只会让操作失败,从不让任何检查通过)。
  const TEST_FAULTS = Object.freeze(['verify-backup', 'backup-flush']);
  const testFault = point => {
    if (process.env.RUYI_TEST_HOOKS !== '1') return;
    const selected = process.env.RUYI_TEST_WORK_DATA_COLD_FAULT;
    if (typeof selected === 'string' && TEST_FAULTS.includes(selected) && selected === point) throw fail('test_fault_' + point.replace('-', '_'));
  };
  // Only this module's own cold failures are ever proven self-recovered. The set is
  // private: a property on an arbitrary thrown value can never claim recovery.
  const recoveredFailures = new WeakSet();
  function create(host) {
    if (['acquire', 'flush', 'verifyFresh', 'verifyDisposableNativeTree', 'fullSnapshot', 'captureRehearsal', 'migrationFactory', 'progress', 'helperMayStillRun'].some(name => typeof host[name] !== 'function')) throw fail('operation_host_invalid');
    // 151 阶段 3D v2:整次冷操作期间让刷盘助手常驻(一次编译、多次刷盘);操作结束(成功或失败)立即解除驻留,
    // 空闲的助手随即退出。驻留只影响进程复用,不改变任何一次刷盘的失败语义。
    async function execute(context) {
      const releaseResident = typeof WorkDataNativePublish !== 'undefined' && typeof WorkDataNativePublish?.holdResident === 'function' ? WorkDataNativePublish.holdResident() : null;
      try { return await executeOperation(context); } finally { if (releaseResident) releaseResident(); }
    }
    async function executeOperation(context) {
      const base = p.resolve(context.base), id = context.id;
      if (!/^[a-f0-9]{48}$/.test(id || '') || await context.assertExclusive(context.ownership) !== true) throw fail('ownership_required');
      // The handoff claim is a bounded capability: finish/abandon only. This body
      // can never read, rewrite or re-own the record it is asked to retire.
      const claim = context.claim === undefined ? null : context.claim;
      if (claim !== null && (!claim || typeof claim !== 'object'
        || typeof claim.finish !== 'function' || typeof claim.abandon !== 'function')) throw fail('claim_capability_invalid');
      const clearClaim = async () => { if (claim) try { await claim.finish(); } catch { /* retained: result without intent is classifiable */ } };
      // Returns whether the record is actually gone. A refused abandon keeps it for
      // classification and keeps the process from claiming self-recovery.
      const releaseClaim = async () => { if (!claim) return true; try { await claim.abandon(); return true; } catch { return false; } };
      const owned = new Set(), issuedBackups = new Map();
      let alive = true, mutation = false, intent = null, restoreStarted = false, resultStarted = false, helperUncertain = false;
      let backupStarted = false, rehearsalStarted = false;
      // 151 阶段 3A(W1/W8/W7):本次尝试自己造出的东西的身份证明。只有身份对得上的才允许在失败时清理;
      // 名字只用来定位,不授予任何权限。
      let createdBackup = null, backupRemoved = false, rehearsalHandedToRestore = false, createdRehearsal = null, rehearsalLease = null;
      const rehearsal = rehearsalPathFor(base, id), rehearsalParent = p.dirname(rehearsal);
      // The exact path this attempt may create. It is inspection evidence only: it
      // never authorizes a recovery, a retry or a success claim.
      let backupAttemptPath = null;
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
      const observePending = value => {
        const types=require('node:util').types;
        try {
          if(!types.isPromise(value)||types.isProxy(value)||Object.getOwnPropertyDescriptor(value,'constructor'))return;
          const proto=Object.getPrototypeOf(value),descriptor=proto&&!types.isProxy(proto)?Object.getOwnPropertyDescriptor(proto,'constructor'):null;
          const ctor=descriptor?.value,species=typeof ctor==='function'&&!types.isProxy(ctor)?Object.getOwnPropertyDescriptor(ctor,Symbol.species):null;
          if(descriptor&&Object.hasOwn(descriptor,'value')&&typeof ctor==='function'&&!types.isProxy(ctor)
            &&Function.prototype.toString.call(ctor)==='function Promise() { [native code] }'&&species
            &&(Object.hasOwn(species,'value')?species.value===undefined||species.value===null||species.value===ctor
              :typeof species.get==='function'&&!types.isProxy(species.get)&&species.set===undefined
                &&Function.prototype.toString.call(species.get)==='function get [Symbol.species]() { [native code] }'))
            Reflect.apply(Promise.prototype.then,value,[()=>{},()=>{}]);
        }catch{/* Pending ownership remains uncertain; no arbitrary then/getter is executed. */}
      };
      // The genuine host owns preserved source reads and synchronous admission.
      // Do not fall back to the ordinary reader when that capability is missing.
      const full = (rehearsalReceipt=false) => {
        const snapshot = host.fullSnapshot(base,context.ownership,assertExclusive,{onNativeCause:retainHelper,rehearsalReceipt});
        const types = require('node:util').types;
        if (snapshot && (types.isProxy(snapshot) || types.isPromise(snapshot))) {
          // A factory may already have started asynchronous work. Observe only
          // a descriptor-verified native Promise; never await it as ownership.
          observePending(snapshot);
          throw fail('snapshot_host_uncertain',{helperMayStillRun:true});
        }
        if (!snapshot || typeof snapshot !== 'object') throw fail('snapshot_host_invalid');
        for (const name of rehearsalReceipt ? ['seal','restore','captureRestored'] : ['seal','restore']) {
          const method = Object.getOwnPropertyDescriptor(snapshot,name);
          if (method && !Object.hasOwn(method,'value')) throw fail('snapshot_host_uncertain',{helperMayStillRun:true});
          if (typeof method?.value !== 'function') throw fail('snapshot_host_invalid');
        }
        return snapshot;
      };
      // Every refusal below happens before a byte is written, so the handoff record
      // may be dropped instead of pinning the next boot to a pending `owned` claim.
      // 151 阶段 3A(W1):这些拒绝发生在写出任何字节之前,源也没被碰过 —— 交接记录撤掉之后,进程可以
      // 把服务交还给原根。还没收尾的 intent/stage 不算:那是上一次留下的现场,后继启动会照常拒绝。
      const preflight = async work => {
        try { return await work(); } catch (cause) {
          const released = await releaseClaim();
          let code = ''; try { code = String(cause?.code || ''); } catch { code = ''; }
          if (released && !retainHelper(cause) && cause && (typeof cause === 'object' || typeof cause === 'function')
            && !['work_data_setup.intent_pending', 'work_data_setup.intent_stage_pending'].includes(code)) recoveredFailures.add(cause);
          throw cause;
        }
      };
      const selected = await preflight(async () => {
        const current = await WorkDataManifest.create({ base }).readActive();
        if (current.generation !== context.expectedAuthority.generation || current.proof.sha256 !== context.expectedAuthority.sha256) throw fail('authority_changed');
        let mode = current.mode;
        if (!current.generation) {
          const sourceConfig = await readBounded(p.join(base, 'config.json'), 4 * 1024 * 1024);
          const text = sourceConfig.bytes.toString('utf8');
          if (!Buffer.from(text).equals(sourceConfig.bytes)) throw fail('config_unavailable');
          const value = JSON.parse(text.replace(/^\uFEFF/, ''));
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || value.workDataEncryptionV1 !== undefined && typeof value.workDataEncryptionV1 !== 'boolean') throw fail('config_unavailable');
          mode = value.workDataEncryptionV1 === true ? 'encrypted' : 'plain';
        }
        if (mode !== context.expectedAuthority.mode || current.id !== context.expectedAuthority.id) throw fail('authority_changed');
        return Object.freeze({ authority: current, expected: Object.freeze({ generation: current.generation, id: current.id, mode, sha256: current.proof.sha256 }) });
      });
      const authority = selected.authority, expected = selected.expected;
      const authorityOf = async root => {
        const current = await WorkDataManifest.create({base:root}).readActive(); let mode = current.mode;
        if (!current.generation) {
          const raw = await readBounded(p.join(root,'config.json'),4*1024*1024), text = raw.bytes.toString('utf8');
          if (!Buffer.from(text).equals(raw.bytes)) throw fail('config_unavailable');
          const value = JSON.parse(text.replace(/^\uFEFF/,''));
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || value.workDataEncryptionV1 !== undefined && typeof value.workDataEncryptionV1 !== 'boolean') throw fail('config_unavailable');
          mode = value.workDataEncryptionV1 === true ? 'encrypted' : 'plain';
        }
        return Object.freeze({generation:current.generation,id:current.id,mode,sha256:current.proof.sha256});
      };
      const readResultAuthority = () => authorityOf(base);
      const maxPackage = WorkDataRecovery.LIMITS.serialized;
      const verifyBackup = async value => {
        const receipt = issuedBackups.get(value.path);
        if (!receipt || receipt.sha256 !== value.sha256 || !assertExclusive(context.ownership)) return false;
        if ('identity' in value && (value.bytes !== receipt.bytes || value.identity?.dev !== receipt.identity.dev || value.identity?.ino !== receipt.identity.ino)) return false;
        const current = await readBounded(value.path, maxPackage);
        return current.identity.dev === receipt.identity.dev && current.identity.ino === receipt.identity.ino && hash(current.bytes) === receipt.sha256;
      };
      const control = await preflight(async () => WorkDataMaintenanceControl.create({ base, ownership: context.ownership, assertExclusive,
        assertDurableBackup: verifyBackup, flush: host.flush }));
      if (context.operation !== 'restore') await preflight(async () => { if ((await control.inspect()).pending) throw fail('intent_pending'); });
      const results = await preflight(async () => WorkDataMaintenanceResult.create({base,ownership:context.ownership,assertExclusive,
        readAuthority:readResultAuthority,assertDurableBackup:verifyBackup,flush:host.flush}));
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
      // --- 151 阶段 3A: failure self-clean (W1/W7/W8) -----------------------------
      const own = (value, name) => { try { const d = Object.getOwnPropertyDescriptor(value, name); return d && Object.hasOwn(d, 'value') ? d.value : undefined; } catch { return undefined; } };
      // The restore owner reports the identity of the directory its own mkdir created
      // (01ab restore_failed). It is accepted only for this exact rehearsal path.
      const restoredIdentity = cause => {
        const seen = new Set(); let value = cause;
        for (let depth = 0; depth < 12 && value && typeof value === 'object' && !seen.has(value); depth++) {
          seen.add(value);
          const identity = own(value, 'targetIdentity'), target = own(value, 'targetPath');
          if (own(value, 'targetRetained') === true && decimalIdentity(identity) && typeof target === 'string' && fold(p.resolve(target)) === fold(rehearsal))
            return Object.freeze({ dev: identity.dev, ino: identity.ino });
          value = own(value, 'cause');
        }
        return null;
      };
      const sameIdentity = (stat, identity) => String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
      const gone = async file => { try { await io.lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
      const removeRehearsal = async cause => {
        // Never handed to restore: whatever sits at that path (if anything) is not ours.
        if (!rehearsalHandedToRestore) return true;
        const identity = createdRehearsal || restoredIdentity(cause);
        let stat;
        try { stat = await io.lstat(rehearsal, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        if (!identity || !stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, identity)) return false;
        // Delete only under an exclusive owner of that tree: the one still held, or a
        // fresh one (refused while, for example, a verifier process still owns it).
        let lease = rehearsalLease && owned.has(rehearsalLease) ? rehearsalLease : null;
        if (!lease) { lease = await acquire(rehearsal); rehearsalLease = lease; }
        try {
          if (assertExclusive(lease) !== true || retainHelper(null)) return false;
          const again = await io.lstat(rehearsal, { bigint: true });
          if (!again.isDirectory() || again.isSymbolicLink() || !sameIdentity(again, identity)) return false;
          await io.rm(rehearsal, { recursive: true, force: false });
          return await gone(rehearsal);
        } finally { await release(lease); rehearsalLease = null; }
      };
      const removeBackup = async () => {
        if (!createdBackup) return false;
        let stat;
        try { stat = await io.lstat(createdBackup.path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') { backupRemoved = true; return true; } throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, createdBackup)) return false;
        // A package that was fully issued must also still hold exactly the issued bytes:
        // a substituted body is evidence and stays where it is.
        const receipt = issuedBackups.get(createdBackup.path);
        if (receipt) {
          const current = await readBounded(createdBackup.path, maxPackage);
          if (!sameIdentity(current.identity, createdBackup) || hash(current.bytes) !== receipt.sha256) return false;
        }
        await io.unlink(createdBackup.path);
        if (!await gone(createdBackup.path)) return false;
        issuedBackups.delete(createdBackup.path); backupRemoved = true; return true;
      };
      // Deletion durability is deliberately not flushed here: the volume flush may be
      // the very thing that failed, and a resurrected entry is still only this
      // attempt's own ciphertext package or private rehearsal.
      const selfClean = async cause => {
        try {
          if (rehearsalStarted && !await removeRehearsal(cause)) return false;
          if (backupStarted && !await removeBackup()) return false;
          if (retainHelper(null)) return false;
          // Nothing above writes the source, so the authority must be unchanged. It is proven
          // BEFORE the handoff record is retired: a changed source keeps the record for the
          // next boot instead of being forgotten (review 3A 建议 4).
          const now = await readResultAuthority();
          if (now.generation !== expected.generation || now.id !== expected.id || now.mode !== expected.mode || now.sha256 !== expected.sha256) return false;
          if (!await releaseClaim()) return false;
          return !retainHelper(null);
        } catch (failure) { retainHelper(failure); return false; }
      };
      try {
        const backupDirectory = context.paths.backupDirectory;
        if (!p.isAbsolute(backupDirectory) || inside(base, backupDirectory) || inside(backupDirectory, base)) throw fail('backup_directory_invalid');
        await realDirectory(backupDirectory);
        if (!['enable', 'disable', 'export', 'restore'].includes(context.operation)) throw fail('operation_invalid');
        if (context.operation === 'enable' && expected.mode === 'encrypted' || context.operation === 'disable' && expected.mode === 'plain') throw fail('mode_unchanged');
        // 151 阶段 3A(W8):写出备份包之前先证明备份文件夹所在的卷支持之后要用的同一个目录刷盘。
        // exFAT/FAT32/ReFS/网络位置在这里就被拒,什么也没写;warm 端提交时已探过一次,这里是冷端自己的复核。
        // Restore authenticates its upload first, so a wrong password still touches nothing.
        const probeBackupVolume = async () => {
          try { await host.flush([backupDirectory]); }
          catch (cause) {
            let kind = 'uncertain';
            try { if (typeof WorkDataNativePublish !== 'undefined' && typeof WorkDataNativePublish.classifyFlushFailure === 'function') kind = WorkDataNativePublish.classifyFlushFailure(cause); } catch { kind = 'uncertain'; }
            throw fail(kind === 'volume_unsupported' ? 'backup_filesystem_unsupported' : 'backup_durability_unavailable', { cause });
          }
        };
        // 151 阶段 3A(review 应改 1):演练放在数据根的父目录里,删除后要对那个父目录刷盘。数据根直接放在盘符根下
        // (C:\X)时非提权进程刷不了 C:\,整轮快照与演练做完才会失败 —— 所以在任何快照之前先探一次,刷不了就带
        // 稳定码与人话提前拒绝(把数据文件夹移进一个子文件夹,或换个数据位置);绝不退回备份文件夹(W7)。
        const probeRehearsalParent = async () => {
          try { await host.flush([rehearsalParent]); }
          catch (cause) {
            let kind = 'uncertain';
            try { if (typeof WorkDataNativePublish !== 'undefined' && typeof WorkDataNativePublish.classifyFlushFailure === 'function') kind = WorkDataNativePublish.classifyFlushFailure(cause); } catch { kind = 'uncertain'; }
            throw fail(kind === 'uncertain' ? 'rehearsal_location_unavailable' : 'rehearsal_location_unsupported', { cause });
          }
        };
        const saveBackup = async bytes => {
          const backupFile = p.join(backupDirectory, 'ruyi-work-data-' + id + '.ruyi-backup');
          // Bind the path before touching the disk so a later failure can name it,
          // without that name granting any authority over the file.
          backupAttemptPath = backupFile;
          await absent(backupFile);
          const handle = await io.open(backupFile, 'wx', 0o600);
          // `wx` is the first byte-level effect. Everything before it (a pre-existing
          // path, a refused open) provably created nothing, so those refusals may
          // still abandon the handoff record; everything after it may leave bytes a
          // later boot must inspect, so the record is retained unless this attempt
          // proves the exact file it created is gone again (selfClean below).
          backupStarted = true;
          try {
            // The identity of the object `wx` just created is the only removal authority.
            const made = await handle.stat({ bigint: true });
            if (made.isFile() && made.nlink === 1n) createdBackup = Object.freeze({ path: backupFile, dev: String(made.dev), ino: String(made.ino) });
            await handle.writeFile(bytes); await handle.sync();
          } finally { await handle.close(); }
          testFault('backup-flush');
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
          if (!context.upload||uploaded.bytes.length!==context.upload.bytes||uploaded.identity.dev!==context.upload.identity.dev||uploaded.identity.ino!==context.upload.identity.ino||hash(uploaded.bytes) !== context.paths.uploadSha256) throw fail('upload_changed');
          const serialized = uploaded.bytes.toString('utf8');
          if (!Buffer.from(serialized,'utf8').equals(uploaded.bytes)) throw fail('upload_invalid');
          const authenticated = await WorkDataRecovery.open(serialized,context.password);
          try {
            const target = context.paths.targetDirectory;
            // The sealed backup directory and the plaintext restore root stay
            // disjoint in both directions: one must not contain the other.
            if (typeof target !== 'string' || !p.isAbsolute(target) || inside(base,target) || inside(target,base)
              || inside(target,backupDirectory) || inside(backupDirectory,target)) throw fail('target_invalid');
            await realDirectory(p.dirname(target)); await absent(target);
            const snapshot=authenticated.snapshot,decodedBytes=snapshot.files.reduce((sum,row)=>sum+row.data.length,0)+snapshot.auxiliaries.reduce((sum,row)=>sum+row.data.length,0);
            await requireSpace([[backupDirectory,BigInt(uploaded.bytes.length)+1048576n],[p.dirname(target),treeBudget(decodedBytes,snapshot.files.length,snapshot.directories.length)],[base,1048576n]]);
            await probeBackupVolume();
            const backup = await saveBackup(uploaded.bytes);
            if (!await verifyBackup(backup)) throw fail('backup_changed');
            const targetIdentity = async () => {
              let stat;
              try { stat = await io.lstat(target, { bigint: true }); }
              catch (cause) { throw fail('target_changed', { cause }); }
              if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('target_changed');
              let real;
              try { real = await io.realpath(target); }
              catch (cause) { throw fail('target_changed', { cause }); }
              if (fold(real) !== fold(target)) throw fail('target_changed');
              return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
            };
            const targetOwner = await acquire(target);
            restoreStarted = true;
            const restored = await full().restore({serialized,password:context.password,target,targetOwnership:targetOwner});
            // The restored-root identity and authority are read while this process
            // still holds the target owner. Neither is source authority, and both
            // remain in memory until a future activation owner consumes them.
            const activationIdentity = await targetIdentity();
            const activationAuthority = await authorityOf(target);
            await release(targetOwner);
            if (await host.verifyFresh({target,password:context.password,generation:null}) !== true) throw fail('fresh_verification_failed');
            // A target replaced or re-authored after fresh verification never
            // authorizes a result: both its directory identity and all four target
            // authority fields must still match what the owner held.
            const currentIdentity = await targetIdentity();
            if (currentIdentity.dev !== activationIdentity.dev || currentIdentity.ino !== activationIdentity.ino) throw fail('target_changed');
            let currentAuthority;
            try { currentAuthority = await authorityOf(target); }
            catch (cause) { throw fail('target_changed', { cause }); }
            if (currentAuthority.generation !== activationAuthority.generation || currentAuthority.id !== activationAuthority.id
              || currentAuthority.mode !== activationAuthority.mode || currentAuthority.sha256 !== activationAuthority.sha256) throw fail('target_changed');
            if (!await verifyBackup(backup)) throw fail('backup_changed');
            const verified = await completed({id,operation:'restore',state:'verified',backup,restored,restartRoot:base,
              activation:'separate-fresh-root',publication:'fresh-process-required',profile:restored.profile,
              activationTarget:Object.freeze({target,identity:activationIdentity,authority:activationAuthority})});
            // Only the verified result authorizes retiring the handoff record. Restore
            // writes no source intent, and a failed removal keeps the record for
            // classification instead of replaying the operation.
            await clearClaim();
            return verified;
          } finally { authenticated.release(); }
        }
        // The rehearsal is disjoint from both the source and the backup directory by
        // construction (a backup directory may contain neither the base nor its parent).
        if (inside(base, rehearsal) || inside(rehearsal, base) || inside(backupDirectory, rehearsal) || inside(rehearsal, backupDirectory)) throw fail('rehearsal_location_invalid');
        await realDirectory(rehearsalParent);
        await probeRehearsalParent();
        await probeBackupVolume();
        await progress('snapshot');
        const captured = await full().seal({ password: context.password, appVersion: VERSION, generation: expected.generation });
        const allocation=treeBudget(captured.sourceProof.bytes,captured.files,captured.directories),packageBytes=BigInt(Buffer.byteLength(captured.serialized,'utf8'))+1048576n;
        // The package coexists first with the rehearsal (removed before any generation
        // work) and then with the new generation; each pair is checked on its own.
        await requireSpace([[backupDirectory,packageBytes],[rehearsalParent,allocation+1048576n]]);
        await requireSpace([[backupDirectory,packageBytes],[base,context.operation==='export'?1048576n:allocation+1048576n]]);
        const backup = await saveBackup(Buffer.from(captured.serialized,'utf8'));
        await progress('verify-backup');
        // An authenticated package is exercised through the real restore owner,
        // then checked by a separate cold Node process before any source intent.
        // From here a disposable tree may exist on disk: it is an effect too.
        rehearsalStarted = true;
        await realDirectory(rehearsalParent);
        await absent(rehearsal);
        const rehearsalOwner = await acquire(rehearsal);rehearsalLease = rehearsalOwner;
        const rehearsalReceipt = captured.specialCoverage?.originalObjects === 'new-owned-portable';
        const rehearsalSnapshot = full(rehearsalReceipt);
        // Only from this call on can a directory of this attempt exist at that path.
        rehearsalHandedToRestore = true;
        const rehearsed = await rehearsalSnapshot.restore({ serialized: captured.serialized, password: context.password, target: rehearsal, targetOwnership: rehearsalOwner });
        {
          const made = await io.lstat(rehearsal, { bigint: true });
          if (made.isDirectory() && !made.isSymbolicLink()) createdRehearsal = Object.freeze({ dev: String(made.dev), ino: String(made.ino) });
        }
        const cleanupProof = rehearsalReceipt
          ? await rehearsalSnapshot.captureRestored(rehearsed,{target:rehearsal,ownership:rehearsalOwner})
          : await host.captureRehearsal({target:rehearsal,ownership:rehearsalOwner,assertExclusive});
        let cleanupReleaseAttempted=false,cleanupPrimary,cleanupFailed=false;
        const releaseCleanupProof=()=>{
          if(rehearsalReceipt||cleanupReleaseAttempted)return;cleanupReleaseAttempted=true;
          try {
            const returned=cleanupProof.release();
            if(returned!==undefined){observePending(returned);throw fail('rehearsal_release_unproven');}
          } catch(cause){helperUncertain=true;throw fail('rehearsal_cleanup_uncertain',{cause,helperMayStillRun:true});}
        };
        try {
          if (rehearsalReceipt) {
            // Portable restore has new opaque paths. The same restore producer
            // binds those paths and the pre-verifier fingerprint to this package.
            if (rehearsed.specialProfile?.originalObjects !== 'new-owned-portable' || cleanupProof.root !== rehearsal
              || cleanupProof.packageSha256 !== backup.sha256 || cleanupProof.packageBytes !== issuedBackups.get(backup.path)?.bytes
              || cleanupProof.manifestSha256 !== rehearsed.manifestSha256) throw fail('rehearsal_changed');
          } else {
            const original = await WorkDataRecovery.open(captured.serialized, context.password);
            try {
              const expectedFiles = new Map(original.snapshot.files.map(row => [row.path, hash(row.data)]));
              for (const row of rehearsed.stagedStates) expectedFiles.set(row.path, row.stagedSha256);
              if (JSON.stringify([...cleanupProof.directories].sort()) !== JSON.stringify([...original.snapshot.directories].sort())
                || cleanupProof.files.length !== expectedFiles.size || cleanupProof.files.some(row => row.sha256 !== expectedFiles.get(row.path))) throw fail('rehearsal_changed');
            } finally { original.release(); }
          }
          await release(rehearsalOwner);rehearsalLease = null;
          testFault('verify-backup');
          if (await host.verifyFresh({ target: rehearsal, password: context.password, generation: expected.generation }) !== true) throw fail('fresh_verification_failed');
          const cleanupOwner = await acquire(rehearsal);rehearsalLease = cleanupOwner;
          // The portable native census below already compares the exact
          // restored receipt. Its final byte and identity readback still
          // follows that census, immediately before disposal.
          if(!rehearsalReceipt&&await cleanupProof.verify(cleanupOwner)!==true)throw fail('rehearsal_changed');
          if (!owned.has(cleanupOwner) || p.dirname(rehearsal) !== rehearsalParent || p.basename(rehearsal) !== REHEARSAL_PREFIX + id
            || inside(base, rehearsal) || inside(rehearsal, base) || inside(backupDirectory, rehearsal) || inside(rehearsal, backupDirectory)) throw fail('rehearsal_cleanup_invalid');
          // Default-stream verification cannot detect a newly added ADS. The
          // native namespace owner must prove the exact newly-created objects
          // have no extra streams/children before this disposable tree is removed.
          if (await host.verifyDisposableNativeTree({ target: rehearsal, snapshot: cleanupProof, ownership: cleanupOwner, assertExclusive }) !== true) throw fail('rehearsal_changed');
          if(await cleanupProof.verify(cleanupOwner)!==true)throw fail('rehearsal_changed');
          // Buffer release must be proven before deletion or target-owner close.
          // A failed release is attempted once and keeps the claim/owners held.
          releaseCleanupProof();
          if(retainHelper(null)||assertExclusive(cleanupOwner)!==true)throw fail('rehearsal_cleanup_uncertain',{helperMayStillRun:true});
          await io.rm(rehearsal, { recursive: true, force: false }); await host.flush([rehearsalParent]);
          await release(cleanupOwner);rehearsalLease = null;
        } catch(cause){cleanupFailed=true;cleanupPrimary=cause;throw cause;}
        finally {
          try{releaseCleanupProof();}catch(cause){
            if(cleanupFailed)throw fail('rehearsal_cleanup_uncertain',{cause:new AggregateError([cleanupPrimary,cause],'work_data_setup.rehearsal_cleanup',{cause:cleanupPrimary}),helperMayStillRun:true});
            throw cause;
          }
        }
        if (!await verifyBackup(backup)) throw fail('backup_changed');
        if (context.operation === 'export') {
          const exported = await completed({ id, operation: 'export', state: 'verified', backup, restartRoot: base,
            publication: 'fresh-process-required', profile: captured.profile, retainedPlaintext: 'source root and excluded user content are retained' });
          // Only the verified result authorizes retiring the handoff record. A failed
          // removal keeps it: result without intent is classifiable, never replayed.
          await clearClaim();
          return exported;
        }
        const state = { schema: 1, id, operation: context.operation, phase: 'prepared', createdAt: new Date().toISOString(), expectedAuthority: expected, backup, candidate: null };
        mutation = true; intent = await control.write(state);
        const update = async (phase, candidate, { headerSha256, transition, transitionReady, transitionSourceScope, transitionSourceSha256 } = {}) => {
          state.phase = phase;
          state.candidate = { id: candidate.id, mode: candidate.mode, pointerSha256: candidate.pointerProof.sha256,
            headerSha256: headerSha256 ?? state.candidate?.headerSha256 ?? null };
          if (transition !== undefined) state.transition = transition;
          if (transitionReady !== undefined) state.transitionReady = transitionReady;
          if (transitionSourceScope !== undefined) state.transitionSourceScope = transitionSourceScope;
          if (transitionSourceSha256 !== undefined) state.transitionSourceSha256 = transitionSourceSha256;
          intent = await control.write(state, intent); return Object.freeze({ ownedFile: intent });
        };
        // Attachments: enabling seals the candidate upload copies; disabling
        // unseals the sealed source rows into the candidate through replaceInto.
        let uploadsOwnerFactory, uploadsRestoreFactory;
        if (context.operation === 'enable') uploadsOwnerFactory = ({ root, keys }) => WorkDataUploadsOwner.create({ root, keys, enabled: () => true });
        else if (context.operation === 'disable') uploadsRestoreFactory = ({ sourceRoot, keys }) => WorkDataUploadsOwner.create({ root: sourceRoot, keys, enabled: () => true });
        const migration = host.migrationFactory({ base, ownership: context.ownership, assertExclusive,onNativeCause:retainHelper,
          manifest: WorkDataManifest.create({ base, candidateAllocator: typeof host.createCandidateBoundary==='function' ? ({candidate,root,assertIssued}) => host.createCandidateBoundary({candidate,root,sourceProof:captured,assertIssued,ownership:context.ownership,assertExclusive,assertIntent:async()=>{await control.verify(intent);},onNativeCause:retainHelper}) : undefined }), protector,
          assertDurableBackup: ({ backupReceipt, sourceProof }) => backupReceipt === backup && sourceProof === captured && verifyBackup(backupReceipt),
          assertIntent: async () => { await control.verify(intent); return Object.freeze({ ownedFile: intent }); },
          onCandidate: ({ candidate }) => update('candidate', candidate),
          onKeyReady: ({ candidate, headerSha256 }) => update('key-ready', candidate, { headerSha256 }),
          onSpecialPrepared: ({ candidate, transition }) => {
            const sourcePath=captured.specialCoverage?.sourcePath;
            const legacyNative=context.operation==='enable'&&expected.generation===0&&typeof sourcePath==='string'&&fold(sourcePath)==='migrations/skill-backups';
            const scope=legacyNative?WorkDataMaintenanceControl.legacyTransitionSourceScope(captured):undefined;
            return update('key-ready',candidate,{transition,transitionSourceScope:scope,
              transitionSourceSha256:WorkDataMaintenanceControl.sourceOrdinaryDigest(captured,{candidateId:candidate.id,scope})});
          },
          onSpecialReady: ({ candidate, transitionReady }) => update('key-ready', candidate, { transitionReady }),
          assertSpecialCoverage: async ({backupReceipt,sourceProof}) => backupReceipt === backup && sourceProof === captured
            && captured.specialCoverage?.type === 'skill-backup-portable'
            && ['refused','new-owned-portable'].includes(captured.specialCoverage.originalObjects) && await verifyBackup(backupReceipt),
          maintenanceResultOwner: WorkDataMaintenanceResult,
          ...(uploadsOwnerFactory ? { uploadsOwnerFactory } : {}),
          ...(uploadsRestoreFactory ? { uploadsRestoreFactory } : {}),
          specialOwnerFactory: options => MigrationHooks.createBackupOwner(options), writeJson: atomicWriteJson });
        await progress('prepare-generation');
        const prepared = await migration.prepare({ expected: authority, targetMode: context.operation === 'enable' ? 'encrypted' : 'plain',
          backupReceipt: backup, sourceProof: captured });
        await progress('publish-generation');
        const published = await migration.publish(prepared);
        if (published.active?.proof?.sha256 !== state.candidate.pointerSha256) throw fail('generation_unverified');
        await update('published', prepared.candidate);
        // verifyPublished must inspect the exact selected generation using cold,
        // independent owner factories; no global mode/cache change is accepted.
        const verifyPublished = async recheck => {
          const proof = await migration.verifyPublished(prepared,{recheck}), selected = await WorkDataManifest.create({ base }).readActive();
          const sameActive = value => value && value.id === prepared.candidate.id && value.mode === prepared.candidate.mode
            && value.root === prepared.candidate.root && value.generation === expected.generation + 1
            && value.proof?.sha256 === state.candidate.pointerSha256;
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
        await control.finish(intent, async()=>await verifyPublished(true) === true && await results.verify(resultReceipt) === true); intent = null;
        // The intent is gone and the result is verified: this is the only point at
        // which the handoff record may be retired for a generation change.
        await clearClaim();
        return Object.freeze(result);
      } catch (cause) {
        retainHelper(cause);
        // A claim may be dropped only when this attempt provably left nothing behind.
        // Before any source intent, restore target or result, the only effects are the
        // backup package and the rehearsal tree; both are removed here when, and only
        // when, the object at that path is still the exact one this attempt created
        // (151 阶段 3A, 150 号文 W1/W7/W8). Any source mutation, restore/result start,
        // unproven identity, failed removal or unknown native helper keeps the record
        // for a later boot, exactly as before.
        let recovered = false;
        if (!mutation && !restoreStarted && !resultStarted && !helperUncertain) recovered = await selfClean(cause);
        // An issued backup is the strongest receipt. Before one exists, the exact
        // path this attempt tried to create is still worth naming for inspection -
        // it is not a receipt and authorizes nothing. A package this attempt removed
        // again is no longer named.
        const boundBackup = backupAttemptPath !== null && p.isAbsolute(backupAttemptPath)
          && backupAttemptPath.length <= 4096 && p.resolve(backupAttemptPath) === backupAttemptPath ? backupAttemptPath : null;
        const backupPath = backupRemoved ? null : issuedBackups.size === 1 ? issuedBackups.keys().next().value : boundBackup;
        const error = fail(mutation ? 'transition_requires_recovery' : restoreStarted ? 'restore_requires_inspection' : resultStarted ? 'result_requires_recovery' : 'preparation_failed', { cause,
          operationMayHaveExecuted: mutation || restoreStarted || resultStarted,
          sourceIntentRetained: intent !== null,
          resultMayHaveBeenWritten: resultStarted,
          ...(helperUncertain ? {helperMayStillRun:true} : {}),
          ...(restoreStarted ? {targetMayHaveBeenCreated:true,targetPath:context.paths.targetDirectory} : {}),
          ...(backupPath ? { backupPath } : {}),
          ...(recovered ? { selfRecovered: true } : {}) });
        if (recovered) recoveredFailures.add(error);
        throw error;
      } finally {
        alive = false;
        // Native flush/capsule adapters settle their actual helper before returning.
        // A helper uncertainty is never converted into a released source lease.
        if (!retainHelper(null)) for (const owner of [...owned]) await release(owner);
      }
    }
    // True only for a failure this module threw after proving that nothing of the
    // attempt remains (no intent, no result, no target, no package, no rehearsal),
    // that the handoff record is retired and that the source authority is unchanged.
    // The caller may then hand the service back to the original root.
    const selfRecovered = error => { try { return (typeof error === 'object' || typeof error === 'function') && error !== null && recoveredFailures.has(error); } catch { return false; } };
    return Object.freeze({ execute, selfRecovered });
  }
  return Object.freeze({ create, REHEARSAL_PREFIX, rehearsalPathFor, removeOrphanRehearsal });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
