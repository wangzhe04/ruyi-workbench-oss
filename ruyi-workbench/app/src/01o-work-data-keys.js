// M3-2: independent work-data master key. It is deliberately NOT the credential vault master: 93 §4
// froze separate lifecycles for credentials and work data, so this file owns its own DPAPI-wrapped
// key and its own enable/rotate semantics. The key only exists after the user enables work-data
// encryption; nothing here creates a key on a read, and a failed/short/absent key never degrades to
// plaintext storage.
const WorkDataKeys = ((cryptoApi) => {
  const SCHEMA = 1;
  const MAX_BYTES = 64 * 1024;
  const STATE_KEYS = Object.freeze(['instanceId', 'protectedKey', 'schema']);
  const entropy = instanceId => Buffer.from('ruyi.work-data.v1:' + instanceId, 'utf8');
  const fail = suffix => { throw Object.assign(new Error('work_data_key.' + suffix), { code: 'work_data_key.' + suffix, apiCode: 'work_data_key.' + suffix }); };
  const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const sealed = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_BYTES && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  const empty = () => ({ schema: SCHEMA, instanceId: '', protectedKey: '' });
  function validate(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (Object.keys(state).sort().join(',') !== STATE_KEYS.join(',')) return false;
    if (state.schema !== SCHEMA) return false;
    if (!state.instanceId && !state.protectedKey) return true;
    return id(state.instanceId) && sealed(state.protectedKey);
  }
  function create(host) {
    // Internal cache owns its master; operations receive independent copies only.
    let cache = null, epoch = 0, ensureTail = Promise.resolve();
    const sameHeader = (a, b) => !!a && !!b && a.schema === b.schema
      && a.instanceId === b.instanceId && a.protectedKey === b.protectedKey;
    const evict = () => { if (cache) cache.key.fill(0); cache = null; };
    // clear is memory eviction, not rotation. Existing operation copies remain valid; an in-flight
    // unprotect begun before clear may finish but cannot silently repopulate the cleared cache.
    const clear = () => { epoch++; evict(); };
    async function stateRead() {
      let state;
      try { state = await host.store.read(); }
      catch (cause) {
        evict();
        // Same verdict as DurableJsonStore's settled-read rule: malformed content is settled damage;
        // EBUSY/EACCES/EMFILE-style failures are "not read this time". Only the cause class is kept.
        const settled = cause instanceof SyntaxError || String(cause?.code || '').startsWith('EDURABLE_');
        throw Object.assign(new Error('work_data_key.unavailable'), { code: 'work_data_key.unavailable', apiCode: 'work_data_key.unavailable', settled });
      }
      if (!validate(state)) { evict(); fail('invalid'); }
      const header = { schema: state.schema, instanceId: state.instanceId, protectedKey: state.protectedKey };
      if (cache && !sameHeader(cache, header)) evict();
      return header;
    }
    async function enabled() { try { return (await host.enabled()) === true; } catch { return false; } }
    const leaseOf = (master, instanceId) => {
      const key = Buffer.from(master); let released = false;
      return Object.freeze({ key, instanceId, release: () => { if (!released) { released = true; key.fill(0); } } });
    };
    // Explicit setup/recovery staging. These methods never access the active store, policy or
    // cache: the lifecycle owner publishes the returned header only inside a verified new root.
    // An OFF active configuration is therefore preserved throughout shadow preparation.
    async function stageRecovered(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'instanceId,key' || !id(value.instanceId)) fail('invalid');
      if (!Buffer.isBuffer(value.key) || value.key.length !== 32) fail('key_invalid');
      const key = Buffer.from(value.key), instanceId = value.instanceId;
      let wrapped, roundtrip, protectInput, protectDomain, verifyDomain;
      try {
        if (!host.protector.supported()) fail('unsupported');
        protectDomain = entropy(instanceId); protectInput = Buffer.from(key);
        try { wrapped = await host.protector.run('protect', protectInput, protectDomain); }
        catch { fail('protect_failed'); }
        if (!Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > MAX_BYTES) fail('protect_failed');
        const header = { schema: SCHEMA, instanceId, protectedKey: wrapped.toString('base64') };
        if (!validate(header)) fail('protect_failed');
        // Use a fresh fixed-purpose entropy buffer: a malformed protector must not turn a
        // mutated first-call argument into a different accepted wrapping domain.
        verifyDomain = entropy(instanceId);
        try { roundtrip = await host.protector.run('unprotect', wrapped, verifyDomain); }
        catch { fail('roundtrip_failed'); }
        if (!Buffer.isBuffer(roundtrip) || roundtrip.length !== 32 || !cryptoApi.timingSafeEqual(key, roundtrip)) fail('roundtrip_failed');
        return Object.freeze({ header: Object.freeze(header), lease: leaseOf(key, instanceId) });
      } finally {
        key.fill(0);
        if (protectInput) protectInput.fill(0);
        if (Buffer.isBuffer(wrapped)) wrapped.fill(0);
        if (Buffer.isBuffer(roundtrip)) roundtrip.fill(0);
        if (protectDomain) protectDomain.fill(0);
        if (verifyDomain) verifyDomain.fill(0);
      }
    }
    async function stageNew() {
      let key;
      try {
        if (!host.protector.supported()) fail('unsupported');
        key = cryptoApi.randomBytes(32);
        const instanceId = cryptoApi.randomBytes(16).toString('hex');
        return await stageRecovered({ instanceId, key });
      } finally { if (Buffer.isBuffer(key)) key.fill(0); }
    }
    async function snapshot() {
      // Existing sealed records remain readable after disabling encryption. No read ever creates a key.
      if (!host.protector.supported()) fail('unsupported');
      const state = await stateRead();
      if (!state.instanceId) fail('absent');
      if (cache && sameHeader(cache, state)) return leaseOf(cache.key, state.instanceId);
      const startedEpoch = epoch;
      let key, wrapped, domain;
      try {
        wrapped = Buffer.from(state.protectedKey, 'base64'); domain = entropy(state.instanceId);
        try { key = await host.protector.run('unprotect', wrapped, domain); }
        catch { fail('decrypt_failed'); }
        if (!Buffer.isBuffer(key) || key.length !== 32) fail('decrypt_failed');
        // Key and instance come from one exact header. A replacement during an async unprotect is
        // not a usable snapshot, even when it retained the same instance id.
        if (!sameHeader(state, await stateRead())) fail('changed');
        if (epoch === startedEpoch) {
          if (!cache || !sameHeader(cache, state)) {
            evict(); cache = { ...state, key: Buffer.from(key) };
          }
          return leaseOf(cache.key, state.instanceId);
        }
        return leaseOf(key, state.instanceId);
      } finally {
        if (Buffer.isBuffer(key)) key.fill(0);
        if (wrapped) wrapped.fill(0);
        if (domain) domain.fill(0);
      }
    }
    async function unlock() {
      const lease = await snapshot();
      try { return Buffer.from(lease.key); }
      finally { lease.release(); }
    }
    // Serial creation is explicit and rejection-resilient. The tail never retains a returned master.
    async function ensureOnce() {
      if (!(await enabled())) fail('disabled');
      if (!host.protector.supported()) fail('unsupported');
      const state = await stateRead();
      if (state.instanceId) return unlock();
      clear(); const startedEpoch = epoch;
      let key = cryptoApi.randomBytes(32), wrapped, domain;
      let instanceId;
      try {
        instanceId = cryptoApi.randomBytes(16).toString('hex');
        domain = entropy(instanceId);
        try { wrapped = await host.protector.run('protect', key, domain); }
        catch { fail('protect_failed'); }
        if (!Buffer.isBuffer(wrapped) || !wrapped.length) fail('protect_failed');
        const next = { schema: SCHEMA, instanceId, protectedKey: wrapped.toString('base64') };
        if (!validate(next)) fail('protect_failed');
        // Do not overwrite authority created externally while protection was awaiting. Cross-process
        // CAS/rotation remains the data-root owner's job; this queue covers this native key set.
        if ((await stateRead()).instanceId) return unlock();
        try { await host.store.write(next); } catch { fail('unavailable'); }
        if (epoch === startedEpoch) { evict(); cache = { ...next, key: Buffer.from(key) }; }
        return Buffer.from(key);
      } finally {
        key.fill(0);
        if (Buffer.isBuffer(wrapped)) wrapped.fill(0);
        if (domain) domain.fill(0);
      }
    }
    function ensure() {
      const pending = ensureTail.then(ensureOnce, ensureOnce);
      ensureTail = pending.then(() => undefined, () => undefined);
      return pending;
    }
    async function status() {
      const state = await stateRead().catch(() => empty());
      return Object.freeze({ enabled: await enabled(), present: !!state.instanceId });
    }
    async function instance() {
      const state = await stateRead();
      if (!state.instanceId) fail('absent');
      return state.instanceId;
    }
    // 150 W6: classify the active header for boot and the recovery-package rewrap without ever
    // creating a key. snapshot() deliberately collapses every protector failure into decrypt_failed;
    // only a definitive DPAPI refusal (the helper ran and Unprotect rejected this blob) is 'locked'.
    // A helper timeout, spawn failure or capacity refusal is 'unavailable' and is never reported as
    // key loss. 'damaged' covers a malformed header (settled read failure or invalid shape); a header
    // file that could not be read this time (EBUSY/EACCES...) is 'unavailable', never 'damaged'.
    async function probe() {
      if (!host.protector.supported()) return Object.freeze({ status: 'unsupported' });
      let state;
      try { state = await stateRead(); }
      catch (error) { return Object.freeze({ status: error?.code === 'work_data_key.invalid' || error?.settled === true ? 'damaged' : 'unavailable' }); }
      if (!state.instanceId) return Object.freeze({ status: 'absent' });
      const startedEpoch = epoch;
      try { (await snapshot()).release(); return Object.freeze({ status: 'healthy', instanceId: state.instanceId }); }
      catch (error) {
        if (error?.code !== 'work_data_key.decrypt_failed') return Object.freeze({ status: 'unavailable', instanceId: state.instanceId });
      }
      let wrapped, domain, key;
      try {
        wrapped = Buffer.from(state.protectedKey, 'base64'); domain = entropy(state.instanceId);
        try { key = await host.protector.run('unprotect', wrapped, domain); }
        catch (error) {
          return Object.freeze({ status: error?.code === 'local_crypto.decrypt_failed' ? 'locked' : 'unavailable', instanceId: state.instanceId });
        }
        // A blob that opens to anything but a 32-byte master is not this root's key under this account.
        if (!Buffer.isBuffer(key) || key.length !== 32) return Object.freeze({ status: 'locked', instanceId: state.instanceId });
        // The first failure was transient (e.g. a cold PowerShell start timed out) and the retry opened
        // the key: it is healthy. Warm the cache only from the same exact, still-current header.
        let current;
        try { current = await stateRead(); } catch { return Object.freeze({ status: 'unavailable', instanceId: state.instanceId }); }
        if (!sameHeader(state, current)) return Object.freeze({ status: 'unavailable', instanceId: state.instanceId });
        if (epoch === startedEpoch) { evict(); cache = { ...state, key: Buffer.from(key) }; }
        return Object.freeze({ status: 'healthy', instanceId: state.instanceId });
      } finally {
        if (Buffer.isBuffer(key)) key.fill(0);
        if (wrapped) wrapped.fill(0);
        if (domain) domain.fill(0);
      }
    }
    return Object.freeze({ unlock, ensure, snapshot, stageNew, stageRecovered, status, instance, probe, clear, validate, empty });
  }
  return Object.freeze({ SCHEMA, create, validate, empty });
})(require('node:crypto'));

// 150 W6: rewrap the CURRENT root's work-data master from a password-protected full recovery package
// after a reinstall, machine change or administrator password reset. When their DPAPI wrapping is lost
// as well, the credential-vault master and the external-bot credentials are restaged from the same
// package inside the same all-or-nothing replacement. Pure orchestration: the host injects the file IO,
// the real protector staging (stageRecovered), the package opener and sealed-record samples.
// Invariants:
//   - nothing is written unless the package key is shown to belong to this root: its instanceId must
//     match the root's evidence and, whenever decidable sealed records exist, it must authenticate them
//     (AEAD open). Undecidable (malformed) samples count neither way; a minority of records that fail
//     (bit rot) is reported, not used to block a key that opens the rest. With no decidable record the
//     proof is the 128-bit instanceId only, and the replaced header is kept as a side copy;
//   - the replacement is staged and DPAPI round-tripped before any write, each file is replaced
//     atomically, re-read and re-unlocked from disk; any failure after the first write restores the
//     exact previous bytes (or absence) of every replaced file and removes the side copy it created;
//   - passwords and masters never enter errors, logs or results (codes, statuses and counts only).
const WorkDataKeyRewrap = ((cryptoApi) => {
  const COMMAND = 'work-data-rewrap-key';
  const SAMPLE_LIMIT = 64;
  const fail = (suffix, extra = {}) => { throw Object.assign(new Error('work_data_key.' + suffix), { code: 'work_data_key.' + suffix, apiCode: 'work_data_key.' + suffix, statusCode: 409, ...extra }); };
  const same = (a, b) => a === null || b === null ? a === b : Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  const rethrowUncertain = error => { if (error?.helperMayStillRun === true) throw error; };
  // Boot refuses only on settled evidence about the key itself. 'unavailable' (the DPAPI helper timed
  // out or could not start, or the header file was not readable this time) does not refuse: it is not
  // key loss, every sealed read/write still fails closed on its own (no plaintext fallback, no key
  // creation), and the next read retries. The caller logs a visible diagnostic instead.
  const BOOT_REFUSAL = Object.freeze({ locked: 'rewrap_required', damaged: 'header_damaged', absent: 'header_missing' });
  function bootRefusal(probe, encrypted) {
    const suffix = probe && BOOT_REFUSAL[probe.status];
    if (!suffix || !encrypted || probe.status === 'absent' && encrypted !== 'manifest') return null;
    return Object.assign(new Error('work_data_key.' + suffix), { code: 'work_data_key.' + suffix, apiCode: 'work_data_key.' + suffix, statusCode: 503, ruyiStartErrorKind: 'startup-failed' });
  }
  function create(host) {
    async function vaultStatus() {
      if (!host.vault) return { status: 'absent', bytes: null };
      const bytes = await host.vault.readBytes();
      if (bytes === null) return { status: 'absent', bytes };
      let snap;
      try { snap = await host.vault.snapshot(); }
      catch (error) {
        rethrowUncertain(error);
        if (error?.code !== 'credential_vault.unlock_failed') return { status: 'damaged', bytes };
        let state; try { state = JSON.parse(bytes.toString('utf8')); } catch { return { status: 'damaged', bytes }; }
        return { status: 'locked', bytes, state };
      }
      if (!snap) return { status: 'empty', bytes };
      snap.lease.release();
      return { status: 'healthy', bytes };
    }
    async function botsStatus() {
      if (!host.bots) return { status: 'absent', bytes: null };
      const bytes = await host.bots.readBytes();
      if (bytes === null) return { status: 'absent', bytes };
      return { status: await host.bots.inspect(), bytes };
    }
    async function inspect() {
      const encrypted = await host.encrypted();
      if (!encrypted) return Object.freeze({ refusal: null, status: 'plain' });
      const probe = await host.keys.probe();
      return Object.freeze({ refusal: bootRefusal(probe, encrypted), status: probe.status });
    }
    async function rewrap({ serialized, password } = {}) {
      const probe = await host.keys.probe();
      if (probe.status === 'unsupported') fail('rewrap_unsupported');
      if (probe.status === 'unavailable') fail('unlock_unavailable');
      const encrypted = await host.encrypted();
      const samples = probe.status === 'healthy' ? [] : await host.samples(SAMPLE_LIMIT);
      const needWork = probe.status === 'locked' || probe.status === 'damaged'
        || probe.status === 'absent' && (encrypted === 'manifest' || samples.length > 0);
      const vault = await vaultStatus(), bots = await botsStatus();
      const needVault = vault.status === 'locked', needBots = bots.status === 'locked';
      if (!needWork && !needVault && !needBots) return Object.freeze({ ok: true, changed: false, workDataKey: probe.status, credentialVault: vault.status, externalBotCredentials: bots.status });
      const headerBefore = await host.readHeaderBytes();
      const opened = await host.openPackage(serialized, password);
      const disposable = [opened];
      try {
        const keys = Array.isArray(opened.snapshot?.keys) ? opened.snapshot.keys : [];
        const plan = [], extra = {};
        let workKey = null, instanceId = null, proven = [], weak = false;
        if (needWork) {
          // The sealed records are the root's authority; a header that disagrees with them is damage.
          const ids = [...new Set(samples.map(row => row.instanceId))];
          if (ids.length === 1) instanceId = ids[0];
          else if (ids.length > 1) instanceId = ids.includes(probe.instanceId) ? probe.instanceId : null;
          else instanceId = probe.instanceId || null;
          if (!instanceId) fail('rewrap_target_unknown');
          workKey = keys.find(key => key && key.purpose === 'work-data' && key.instanceId === instanceId) || null;
          if (!workKey || !Buffer.isBuffer(workKey.master) || workKey.master.length !== 32) fail('rewrap_package_mismatch');
          let failed = 0;
          for (const row of samples.filter(item => item.instanceId === instanceId)) {
            const verdict = host.authenticate(row.container, workKey.master);
            if (verdict === true) proven.push(row); else if (verdict === false) failed++;
          }
          // More records must authenticate than fail: a tie (one planted record next to one genuine one) is refused.
          if (failed && failed >= proven.length) fail('rewrap_package_mismatch');
          if (failed) extra.unreadableRecords = failed;
          // No decidable record: the 128-bit instanceId of the existing header is the only evidence.
          weak = !proven.length;
          if (weak && probe.instanceId !== instanceId) fail('rewrap_target_unknown');
          const staged = await host.stage({ instanceId, key: workKey.master });
          disposable.push(staged.lease);
          if (staged.header.instanceId !== instanceId) fail('rewrap_verify_failed');
          plan.push({ name: 'workDataKey', before: headerBefore, after: Buffer.from(JSON.stringify(staged.header), 'utf8'),
            read: host.readHeaderBytes, write: host.writeHeaderBytes });
        }
        let vaultKey = null;
        if (needVault) {
          vaultKey = keys.find(key => key && key.purpose === 'credential' && key.instanceId === vault.state?.instanceId) || null;
          if (!vaultKey || !Buffer.isBuffer(vaultKey.master) || vaultKey.master.length !== 32) fail('rewrap_credential_mismatch');
          let staged;
          try { staged = await host.vault.stage({ state: vault.state, key: vaultKey.master }); }
          catch (error) {
            rethrowUncertain(error);
            if (/^credential_vault\.recovery_/.test(String(error?.code || ''))) fail('rewrap_credential_mismatch');
            throw error;
          }
          disposable.push(staged.lease);
          plan.push({ name: 'credentialVault', before: vault.bytes, after: Buffer.from(JSON.stringify(staged.state), 'utf8'),
            read: host.vault.readBytes, write: host.vault.writeBytes });
        }
        let botsRestaged = false;
        if (needBots) {
          // The package's portable copy restages only if every row's binding/revision still matches
          // (random 128-bit revisions): bots changed after the export cannot be restored from it.
          const portable = (Array.isArray(opened.snapshot?.auxiliaries) ? opened.snapshot.auxiliaries : []).filter(row => row?.type === 'external-bot-credentials');
          for (const row of portable) {
            let staged;
            try { staged = await host.bots.stage({ bytes: bots.bytes, portable: row.data }); }
            catch (error) {
              rethrowUncertain(error);
              if (error?.code === 'external_credentials.recovery_invalid') continue;
              throw error;
            }
            plan.push({ name: 'externalBotCredentials', before: bots.bytes, after: Buffer.from(JSON.stringify(staged.state), 'utf8'),
              read: host.bots.readBytes, write: host.bots.writeBytes });
            botsRestaged = true; break;
          }
        }
        if (!plan.length) return Object.freeze({ ok: true, changed: false, workDataKey: probe.status, credentialVault: vault.status, externalBotCredentials: bots.status });
        const written = [];
        let sideCopy = null;
        try {
          host.fault('before-write');
          // Keep the old header whenever the proof is not clean (instanceId only, or some records failed),
          // so a wrong decision stays reversible after the new key is healthy.
          if ((weak || extra.unreadableRecords) && headerBefore !== null) sideCopy = await host.keepSideCopy(headerBefore);
          for (const step of plan) {
            // Exclusive ownership is held by the caller; this re-read still refuses a concurrent edit.
            if (!same(await step.read(), step.before)) fail('rewrap_changed');
            written.push(step); await step.write(step.after);
            host.fault('after-write');
          }
          for (const step of plan) if (!same(await step.read(), step.after)) fail('rewrap_verify_failed');
          if (workKey) {
            const lease = await host.freshKeys().snapshot();
            try {
              if (lease.instanceId !== instanceId || !cryptoApi.timingSafeEqual(lease.key, workKey.master)) fail('rewrap_verify_failed');
              for (const row of proven) if (host.authenticate(row.container, lease.key) !== true) fail('rewrap_verify_failed');
            } finally { lease.release(); }
          }
          if (vaultKey) {
            host.vault.clear();
            const snap = await host.vault.snapshot();
            try { if (!snap || snap.state.instanceId !== vault.state.instanceId || !cryptoApi.timingSafeEqual(snap.lease.key, vaultKey.master)) fail('rewrap_verify_failed'); }
            finally { snap?.lease.release(); }
          }
          if (botsRestaged && await host.bots.inspect() !== 'healthy') fail('rewrap_verify_failed');
          host.fault('after-verify');
        } catch (error) {
          let rollbackFailed = false;
          for (const step of written.reverse()) {
            try { await step.write(step.before); if (!same(await step.read(), step.before)) rollbackFailed = true; }
            catch { rollbackFailed = true; }
          }
          if (sideCopy !== null) { try { await host.removeSideCopy(sideCopy); } catch { /* an extra copy of the old header is harmless */ } }
          host.vault?.clear();
          if (!written.length) throw error;
          if (rollbackFailed) fail('rewrap_rollback_failed', { helperMayStillRun: error?.helperMayStillRun === true });
          if (error && typeof error === 'object' && !Object.isFrozen(error)) error.rolledBack = true;
          throw error;
        }
        return Object.freeze({ ok: true, changed: true,
          workDataKey: workKey ? 'rewrapped' : probe.status, credentialVault: vaultKey ? 'rewrapped' : vault.status,
          externalBotCredentials: botsRestaged ? 'rewrapped' : bots.status, ...extra,
          ...(weak ? { proof: 'instance-id', previousHeaderKept: sideCopy !== null } : extra.unreadableRecords ? { previousHeaderKept: sideCopy !== null } : {}) });
      } finally {
        for (const item of disposable.reverse()) { try { item.release(); } catch { /* best effort zeroing */ } }
      }
    }
    return Object.freeze({ inspect, rewrap });
  }
  return Object.freeze({ COMMAND, SAMPLE_LIMIT, BOOT_REFUSAL, bootRefusal, create });
})(require('node:crypto'));

// The process-wide key set. Families create their stores with it; enabled() reads the config switch
// every time (M3-3 owns the enable flow).
