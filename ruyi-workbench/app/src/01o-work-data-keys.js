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
    // host: { store (DurableJsonStore), protector (LocalSecretCrypto), enabled() -> boolean }
    let cache = null;   // { instanceId, key } — the only place the plaintext master lives
    async function stateRead() {
      let state;
      try { state = await host.store.read(); } catch { fail('unavailable'); }
      if (!validate(state)) fail('invalid');
      return state;
    }
    // host.enabled() is allowed to be async (the product wires it to readConfig()), so it must be
    // awaited here; `promise === true` would silently keep the switch off forever.
    async function enabled() { try { return (await host.enabled()) === true; } catch { return false; } }
    async function unlock() {
      if (!(await enabled())) fail('disabled');
      if (!host.protector.supported()) fail('unsupported');
      const state = await stateRead();
      if (!state.instanceId) fail('absent');
      if (cache && cache.instanceId === state.instanceId) return cache.key;
      let key;
      try { key = await host.protector.run('unprotect', Buffer.from(state.protectedKey, 'base64'), entropy(state.instanceId)); }
      catch { fail('decrypt_failed'); }
      if (!Buffer.isBuffer(key) || key.length !== 32) { if (Buffer.isBuffer(key)) key.fill(0); fail('decrypt_failed'); }
      cache = { instanceId: state.instanceId, key };
      return key;
    }
    // Called only from an explicit enable flow (M3-3 UI / tests), never from a read or a write.
    async function ensure() {
      if (!(await enabled())) fail('disabled');
      if (!host.protector.supported()) fail('unsupported');
      const state = await stateRead();
      if (state.instanceId) return unlock();
      const key = cryptoApi.randomBytes(32), instanceId = cryptoApi.randomBytes(16).toString('hex');
      let wrapped;
      try { wrapped = await host.protector.run('protect', key, entropy(instanceId)); }
      catch { key.fill(0); fail('protect_failed'); }
      const next = { schema: SCHEMA, instanceId, protectedKey: wrapped.toString('base64') };
      wrapped.fill(0);
      try { await host.store.write(next); } catch { key.fill(0); fail('unavailable'); }
      cache = { instanceId, key };
      return key;
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
    const clear = () => { if (cache) cache.key.fill(0); cache = null; };
    return Object.freeze({ unlock, ensure, status, instance, clear, validate, empty });
  }
  return Object.freeze({ SCHEMA, create, validate, empty });
})(require('node:crypto'));
