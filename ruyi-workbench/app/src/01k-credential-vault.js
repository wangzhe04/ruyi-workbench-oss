// 81-P1: Immutable encrypted credential records; config holds typed references, never vault plaintext.
const CredentialVault = ((cryptoApi) => {
  const MAX = Object.freeze({ bytes: 8 * 1024 * 1024, records: 1024, value: 65536, slots: 256 });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const fail = suffix => { throw Object.assign(new Error('credential_vault.' + suffix), { code: 'credential_vault.' + suffix, apiCode: 'credential_vault.' + suffix, statusCode: 503 }); };
  const empty = () => ({ schema: 1, instanceId: '', protectedKey: '', records: [] });
  function validate(state) {
    if (!object(state) || Object.keys(state).sort().join(',') !== 'instanceId,protectedKey,records,schema' || state.schema !== 1 || !Array.isArray(state.records) || state.records.length > MAX.records) return false;
    if (!state.instanceId && !state.protectedKey) return state.records.length === 0;
    if (!id(state.instanceId) || typeof state.protectedKey !== 'string' || state.protectedKey.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(state.protectedKey)) return false;
    const ids = new Set();
    return state.records.every(row => {
      if (!object(row) || Object.keys(row).sort().join(',') !== 'envelope,fingerprint,id,owner' || !id(row.id) || ids.has(row.id)
        || !/^[a-f0-9]{64}$/.test(row.owner) || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !object(row.envelope)) return false;
      ids.add(row.id); return true;
    });
  }
  const pointer = pieces => '/' + pieces.map(piece => String(piece).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
  function at(root, p) {
    if (typeof p !== 'string' || !p.startsWith('/') || p.length > 1024) fail('reference_invalid');
    const parts = p.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.some(part => ['__proto__', 'constructor', 'prototype'].includes(part))) fail('reference_invalid');
    let parent = root;
    for (const part of parts.slice(0, -1)) { if (!parent || !Object.hasOwn(parent, part)) fail('reference_invalid'); parent = parent[part]; }
    const key = parts.at(-1); if (!parent || !Object.hasOwn(parent, key)) fail('reference_invalid');
    return { parent, key, value: parent[key] };
  }
  function secretUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
      const url = new globalThis.URL(value);
      return !!(url.username || url.password) || [...url.searchParams.keys()].some(key => /(?:key|token|secret|credential|signature|^sig$|password)/i.test(key));
    } catch { return false; }
  }
  function slots(config) {
    const out = [];
    const add = (parts, value, binding) => {
      if (value === '' || value === null || value === undefined) return;
      if (object(value) && !Object.keys(value).length || Array.isArray(value) && !value.length) return;
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX.value) fail('value_limit');
      if (out.length >= MAX.slots) fail('slots_limit');
      out.push({ pointer: pointer(parts), serialized, binding });
    };
    for (const [i, provider] of (Array.isArray(config.providers) ? config.providers : []).entries()) {
      if (!object(provider) || typeof provider.id !== 'string') continue;
      const binding = ['provider', provider.id, provider.baseUrl || '', provider.audioBaseUrl || '', provider.extraBaseUrls || [], provider.apiStyle || 'chat'];
      add(['providers', i, 'apiKey'], provider.apiKey, binding);
      add(['providers', i, 'extraHeaders'], provider.extraHeaders, binding);
      for (const name of ['baseUrl', 'audioBaseUrl']) if (secretUrl(provider[name])) add(['providers', i, name], provider[name], binding);
      if (Array.isArray(provider.extraBaseUrls) && provider.extraBaseUrls.some(secretUrl)) add(['providers', i, 'extraBaseUrls'], provider.extraBaseUrls, binding);
    }
    add(['privacyRulesV1'], config.privacyRulesV1, ['privacy-rules-v1']);
    add(['modelsApiKey'], config.modelsApiKey, ['claude', config.modelsApiBase || '']);
    if (secretUrl(config.modelsApiBase)) add(['modelsApiBase'], config.modelsApiBase, ['claude', config.modelsApiBase]);
    if (object(config.searchBackend)) {
      const binding = ['search', config.searchBackend.baseUrl || '', config.searchBackend.type || ''];
      add(['searchBackend', 'apiKey'], config.searchBackend.apiKey, binding);
      if (secretUrl(config.searchBackend.baseUrl)) add(['searchBackend', 'baseUrl'], config.searchBackend.baseUrl, binding);
    }
    for (const [i, server] of (Array.isArray(config.externalMcpServers) ? config.externalMcpServers : []).entries()) {
      if (!object(server) || typeof server.id !== 'string') continue;
      const binding = ['mcp', server.id, server.url || '', server.command || '', server.args || [], server.cwd || ''];
      for (const name of ['env', 'headers', 'args']) add(['externalMcpServers', i, name], server[name], binding);
      if (secretUrl(server.url)) add(['externalMcpServers', i, 'url'], server.url, binding);
    }
    return out;
  }
  function create(host) {
    const { store, core, protector } = host;
    let chain = Promise.resolve(), keyCache = null;
    const serial = work => { const next = chain.catch(() => {}).then(work); chain = next; return next; };
    const hash = (key, value) => cryptoApi.createHmac('sha256', key).update(value).digest('hex');
    const entropy = instanceId => Buffer.from('ruyi.credential-vault.v1:' + instanceId);
    async function stateRead() {
      try {
        if (await host.size() > MAX.bytes) fail('capacity');
        const state = await store.read(); if (!validate(state)) fail('storage_unavailable'); return state;
      } catch { fail('storage_unavailable'); }
    }
    async function stateWrite(state) {
      if (!validate(state) || Buffer.byteLength(JSON.stringify(state)) > MAX.bytes) fail('capacity');
      try { await store.write(state); } catch { store.invalidate(); fail('storage_unavailable'); }
    }
    async function master(state, initialize) {
      if (!state.instanceId) {
        if (!initialize) fail('key_missing');
        if (!protector.supported()) fail('unsupported');
        const key = cryptoApi.randomBytes(32), instanceId = cryptoApi.randomBytes(16).toString('hex');
        try {
          const wrapped = await protector.run('protect', key, entropy(instanceId));
          state.instanceId = instanceId; state.protectedKey = wrapped.toString('base64'); wrapped.fill(0);
          keyCache = { binding: state.instanceId + ':' + state.protectedKey, key };
          return key;
        } catch { key.fill(0); fail('unlock_failed'); }
      }
      const binding = state.instanceId + ':' + state.protectedKey;
      if (keyCache?.binding === binding) return keyCache.key;
      try {
        const key = await protector.run('unprotect', Buffer.from(state.protectedKey, 'base64'), entropy(state.instanceId));
        if (key.length !== 32) { key.fill(0); fail('unlock_failed'); }
        if (keyCache) keyCache.key.fill(0);
        keyCache = { binding, key }; return key;
      } catch { fail('unlock_failed'); }
    }
    const aad = (state, recordId, purpose = 'credential') => ({ instanceId: state.instanceId, recordId, purpose });
    function hydrate(raw, state, key) {
      const refs = raw.credentialRefsV1;
      if (!refs) return raw;
      if (!object(refs) || refs.version !== 1 || !Array.isArray(refs.slots) || refs.slots.length > MAX.slots || Object.keys(refs).sort().join(',') !== 'slots,version') fail('reference_invalid');
      const seen = new Set(), used = [];
      for (const ref of refs.slots) {
        if (!object(ref) || Object.keys(ref).sort().join(',') !== 'id,pointer' || !id(ref.id) || seen.has(ref.pointer)) fail('reference_invalid');
        seen.add(ref.pointer);
        const slot = at(raw, ref.pointer); if (slot.value !== '') fail('reference_collision');
        const record = state.records.find(row => row.id === ref.id); if (!record) fail('reference_missing');
        try { slot.parent[slot.key] = JSON.parse(core.open(record.envelope, key, aad(state, record.id), 'master-v1')); }
        catch { fail('decrypt_failed'); }
        used.push({ ref, record });
      }
      const recognized = new Map(slots(raw).map(slot => [slot.pointer, slot]));
      for (const { ref, record } of used) {
        const slot = recognized.get(ref.pointer); if (!slot || hash(key, JSON.stringify([slot.pointer, slot.binding])) !== record.owner) fail('binding_mismatch');
        if (hash(key, record.owner + ':' + slot.serialized) !== record.fingerprint) fail('integrity_failed');
      }
      delete raw.credentialRefsV1;
      raw.credentialEncryptionV1 = true;
      raw.configExplicitKeysV1 = [...new Set([...(Array.isArray(raw.configExplicitKeysV1) ? raw.configExplicitKeysV1 : []), 'credentialEncryptionV1'])].sort();
      return raw;
    }
    // 3.0.2 normalized encrypted placeholders before reading the vault. Authenticate the
    // original record and its provider binding before accepting any conflicting edit.
    function hydrateCompatible(raw, state, key) {
      if (raw.version !== '3.0.2' || !Array.isArray(raw.credentialRefsV1?.slots)) return hydrate(raw, state, key);
      const edits = [];
      for (const ref of raw.credentialRefsV1.slots) {
        const slot = at(raw, ref.pointer);
        if (slot.value === '') continue;
        const emptyMap = /^(?:\/providers\/\d+\/extraHeaders|\/externalMcpServers\/\d+\/(?:env|headers))$/.test(ref.pointer)
          && object(slot.value) && Object.keys(slot.value).length === 0;
        const emptyArgs = /^\/externalMcpServers\/\d+\/args$/.test(ref.pointer) && Array.isArray(slot.value) && !slot.value.length;
        const providerKey = /^\/providers\/(\d+)\/apiKey$/.exec(ref.pointer);
        if (providerKey && typeof slot.value === 'string' && slot.value.trim() && slot.value.length <= 2048) {
          edits.push({ index: Number(providerKey[1]), value: slot.value });
        } else if (!emptyMap && !emptyArgs) fail('reference_collision');
        slot.parent[slot.key] = '';
      }
      hydrate(raw, state, key);
      for (const { index, value } of edits) {
        const provider = raw.providers[index];
        if (provider.apiKey === value) continue;
        if (raw.providers.length >= 20) fail('recovery_provider_limit');
        let suffix = 1, id;
        do { id = 'vault-recovered-' + index + '-' + suffix++; } while (raw.providers.some(p => p.id === id));
        raw.providers.push({ ...structuredClone(provider), id, label: String(provider.label || provider.id).slice(0, 45) + '（原凭据库）' });
        provider.apiKey = value;
      }
      return raw;
    }
    async function hydrateConfig(raw) {
      if (!object(raw)) return { raw, needsMigration: false };
      return serial(async () => {
        const clone = structuredClone(raw);
        if (clone.credentialRefsV1) {
          const state = await stateRead(), key = await master(state, false);
          return { raw: hydrateCompatible(clone, state, key), needsMigration: false };
        }
        const enabled = clone.credentialEncryptionV1 === true;
        return { raw: clone, needsMigration: enabled && slots(clone).length > 0 };
      });
    }
    async function protectUnlocked(serialized, force, allowPlaintext) {
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX.bytes) fail('config_invalid');
      let raw; try { raw = JSON.parse(serialized); } catch { fail('config_invalid'); }
      if (!object(raw)) fail('config_invalid');
      let state, key;
      if (raw.credentialRefsV1) { state = await stateRead(); key = await master(state, false); raw = hydrateCompatible(raw, state, key); }
      const enabled = force || raw.credentialEncryptionV1 === true;
      if (!enabled) {
        if (!allowPlaintext && await host.size() > 0) fail('disable_requires_migration');
        return JSON.stringify(raw, null, 2);
      }
      const selected = slots(raw); if (!selected.length) return JSON.stringify(raw, null, 2);
      if (!state) { state = await stateRead(); key = await master(state, true); }
      const refs = [];
      let dirty = false;
      for (const slot of selected) {
        const owner = hash(key, JSON.stringify([slot.pointer, slot.binding])), fingerprint = hash(key, owner + ':' + slot.serialized);
        let record = state.records.find(row => row.owner === owner && row.fingerprint === fingerprint);
        if (record) {
          try { if (core.open(record.envelope, key, aad(state, record.id), 'master-v1') !== slot.serialized) fail('integrity_failed'); }
          catch { fail('integrity_failed'); }
        }
        if (!record) {
          if (state.records.length >= MAX.records) fail('capacity');
          const recordId = cryptoApi.randomBytes(16).toString('hex');
          record = { id: recordId, owner, fingerprint, envelope: core.seal(slot.serialized, key, aad(state, recordId), 'master-v1') };
          state.records.push(record); dirty = true;
        }
        at(raw, slot.pointer).parent[at(raw, slot.pointer).key] = '';
        refs.push({ pointer: slot.pointer, id: record.id });
      }
      if (dirty) await stateWrite(state);
      raw.credentialEncryptionV1 = true;
      raw.configExplicitKeysV1 = [...new Set([...(Array.isArray(raw.configExplicitKeysV1) ? raw.configExplicitKeysV1 : []), 'credentialEncryptionV1'])].sort();
      raw.credentialRefsV1 = { version: 1, slots: refs };
      return JSON.stringify(raw, null, 2);
    }
    const protectConfig = (serialized, options = {}) => serial(() => protectUnlocked(serialized, options.force === true, options.allowPlaintext === true));
    async function protectCorrupt(serialized, name, enabled = true) {
      if (!enabled) return serialized;
      return serial(async () => {
        const state = await stateRead(); const fresh = !state.instanceId; const key = await master(state, true);
        if (fresh) await stateWrite(state);
        const recordId = 'backup-' + cryptoApi.createHash('sha256').update(name).digest('hex');
        return JSON.stringify({ ruyiEncryptedBackupV1: 1, name, envelope: core.seal(serialized, key, aad(state, recordId, 'config-backup'), 'master-v1') }, null, 2);
      });
    }
    return Object.freeze({ hydrateConfig, protectConfig, protectCorrupt });
  }
  return { create, empty, validate, MAX, slots };
})(require('node:crypto'));

const credentialEnvelope = ((cryptoApi) => {
  const LIMITS = { bytes: 1024 * 1024 };
  const fail = suffix => { throw Object.assign(new Error('credential_vault.' + suffix), { code: 'credential_vault.' + suffix }); };
  function checkText(value, max = LIMITS.bytes) {
    if (typeof value !== 'string') fail('text_required');
    if (Buffer.byteLength(value, 'utf8') > max) fail('text_limit');
    return value;
  }
  function identity(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) fail('identity_invalid');
    return value;
  }
  function checkKey(key) { if (!Buffer.isBuffer(key) || key.length !== 32) fail('key_invalid'); }
  function aadFor(binding, keyId) {
    if (!binding || typeof binding !== 'object') fail('binding_invalid');
    return Buffer.from(JSON.stringify(['ruyi-privacy', 1, identity(keyId), identity(binding.instanceId), identity(binding.purpose), identity(binding.recordId)]), 'utf8');
  }
  function seal(plaintext, key, binding, keyId) {
    checkKey(key); const privacyText = checkText(plaintext); const aad = aadFor(binding, keyId);
    if (Buffer.from(privacyText, 'utf8').toString('utf8') !== privacyText) fail('unicode_invalid');
    const nonce = cryptoApi.randomBytes(12), cipher = cryptoApi.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(privacyText, 'utf8'), cipher.final()]);
    return Object.freeze({ version: 1, algorithm: 'A256GCM', keyId, nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  }
  function decode(value, size, max) {
    if (typeof value !== 'string' || value.length > max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('envelope_invalid');
    const bytes = Buffer.from(value, 'base64');
    if ((size !== null && bytes.length !== size) || bytes.toString('base64') !== value) fail('envelope_invalid');
    return bytes;
  }
  function open(envelope, key, binding, expectedKeyId) {
    // Uniform errors prevent accidental disclosure of values or crypto internals through tool errors.
    try {
      checkKey(key);
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'algorithm,ciphertext,keyId,nonce,tag,version'
        || envelope.version !== 1 || envelope.algorithm !== 'A256GCM' || envelope.keyId !== expectedKeyId) fail('envelope_invalid');
      const aad = aadFor(binding, expectedKeyId), nonce = decode(envelope.nonce, 12, 16), tag = decode(envelope.tag, 16, 24);
      const ciphertext = decode(envelope.ciphertext, null, Math.ceil(LIMITS.bytes / 3) * 4);
      if (ciphertext.length > LIMITS.bytes) fail('envelope_invalid');
      const decipher = cryptoApi.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch { fail('decrypt_failed'); }
  }
  return { seal, open };
})(require('node:crypto'));
