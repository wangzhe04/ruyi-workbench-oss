// M3-1: versioned work-data envelope plus purpose-isolated key derivation for the managed data families
// frozen in docs/optimization-plan/93-m3-1-encrypted-storage-freeze.md.
// Pure module: no filesystem, no store, no implicit key creation. A storage adapter must hand in an
// already-unlocked 32-byte master, so "not enabled and no old reference never creates a key" is
// structural rather than a policy check. Keys derive per purpose (HKDF), never reuse the vault master
// as an AEAD key, and the envelope records generation/schema/scope/record/seq so a rotated key or a
// misplaced record fails closed instead of decrypting into the wrong family.
const WorkDataCrypto = ((cryptoApi) => {
  const FORMAT_VERSION = 2;
  const KEY_PREFIX = 'work-data-v2.k';
  const MAX_PLAINTEXT = 1024 * 1024;
  const MAX_GENERATION = 99;
  // Frozen purpose list: the census gate asserts the artifact and this table stay identical.
  const PURPOSES = Object.freeze(['session', 'memory', 'queue', 'task', 'workflow', 'search-index', 'cache', 'backup', 'audit', 'migration', 'user-config']);
  const CONTAINER_KEYS = Object.freeze(['envelope', 'instanceId', 'keyId', 'purpose', 'recordId', 'schema', 'scopeId', 'seq', 'version']);
  const SALT_TEXT = 'ruyi.work-data.v1';
  const SALT = Buffer.from(SALT_TEXT, 'utf8');
  const fail = suffix => { throw Object.assign(new Error('work_data.' + suffix), { code: 'work_data.' + suffix, apiCode: 'work_data.' + suffix }); };
  const identity = (value, suffix = 'binding_invalid') => {
    // '-' is allowed: session-derived record ids (sess_xxx, steward-abc) are the common case.
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) fail(suffix);
    return value;
  };
  const count = (value, suffix) => { if (!Number.isSafeInteger(value) || value < 0) fail(suffix); return value; };
  const checkMaster = master => { if (!Buffer.isBuffer(master) || master.length !== 32) fail('key_invalid'); return master; };
  const checkPurpose = purpose => {
    if (typeof purpose !== 'string' || !PURPOSES.includes(purpose)) fail('purpose_invalid');
    return purpose;
  };
  const checkGeneration = generation => {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) fail('generation_invalid');
    return generation;
  };
  const keyId = generation => KEY_PREFIX + checkGeneration(generation);
  // Generation is part of the derivation info, not just the key id label: a rotation changes the key
  // material, so an old envelope cannot be reopened by pretending it is the current generation.
  function deriveKey(master, purpose, generation = 1) {
    checkMaster(master);
    checkPurpose(purpose);
    checkGeneration(generation);
    return Buffer.from(cryptoApi.hkdfSync('sha256', master, SALT, Buffer.from('purpose:' + purpose + ':k' + generation, 'utf8'), 32));
  }
  function bindingOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('binding_invalid');
    return {
      purpose: checkPurpose(value.purpose), instanceId: identity(value.instanceId), schema: count(value.schema, 'schema_invalid'),
      scopeId: identity(value.scopeId), recordId: identity(value.recordId), seq: count(value.seq, 'seq_invalid'),
      generation: checkGeneration(value.generation === undefined ? 1 : value.generation),
    };
  }
  // schema/scope/seq travel in the AAD after the privacy-core triple, so a record moved between
  // families, scopes or revisions cannot authenticate even when the purpose and key match.
  const aadBinding = binding => ({ instanceId: binding.instanceId, purpose: binding.purpose, recordId: binding.recordId,
    extra: [binding.schema, binding.scopeId, binding.seq] });
  function seal(plaintext, master, value) {
    checkMaster(master);
    if (typeof plaintext !== 'string') fail('text_required');
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT) fail('text_limit');
    const binding = bindingOf(value), id = keyId(binding.generation);
    const derived = deriveKey(master, binding.purpose, binding.generation);
    try {
      return Object.freeze({ version: FORMAT_VERSION, keyId: id, purpose: binding.purpose, instanceId: binding.instanceId,
        schema: binding.schema, scopeId: binding.scopeId, recordId: binding.recordId, seq: binding.seq,
        envelope: PrivacyCore.seal(plaintext, derived, aadBinding(binding), id) });
    } finally { derived.fill(0); }
  }
  function open(container, master, value) {
    checkMaster(master);
    const binding = bindingOf(value), id = keyId(binding.generation);
    if (!container || typeof container !== 'object' || Array.isArray(container)
      || Object.keys(container).sort().join(',') !== CONTAINER_KEYS.join(',')) fail('envelope_invalid');
    // Order matters: a v1 container (purpose bound in AAD only, master key reused) must never be
    // accepted here as if it were v2, so callers have to migrate deliberately.
    if (container.version !== FORMAT_VERSION) fail('format_unsupported');
    if (container.purpose !== binding.purpose) fail('purpose_mismatch');
    if (container.keyId !== id) fail('key_mismatch');
    if (container.instanceId !== binding.instanceId || container.schema !== binding.schema || container.scopeId !== binding.scopeId
      || container.recordId !== binding.recordId || container.seq !== binding.seq) fail('binding_mismatch');
    const derived = deriveKey(master, binding.purpose, binding.generation);
    try { return PrivacyCore.open(container.envelope, derived, aadBinding(binding), id); }
    catch { fail('decrypt_failed'); } finally { derived.fill(0); }
  }
  return Object.freeze({ FORMAT_VERSION, MAX_PLAINTEXT, PURPOSES, keyId, deriveKey, seal, open });
})(require('node:crypto'));
