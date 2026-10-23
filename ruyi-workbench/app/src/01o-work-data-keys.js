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
      try { state = await host.store.read(); } catch { evict(); fail('unavailable'); }
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
    return Object.freeze({ unlock, ensure, snapshot, status, instance, clear, validate, empty });
  }
  return Object.freeze({ SCHEMA, create, validate, empty });
})(require('node:crypto'));

// The process-wide key set. Families create their stores with it; enabled() reads the config switch
// every time (M3-3 owns the enable flow).
