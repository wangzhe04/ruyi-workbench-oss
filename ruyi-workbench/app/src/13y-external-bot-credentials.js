// Dedicated local bot credentials, never a model tool. Windows DPAPI CurrentUser protects stored values;
// it does not protect against another program already running as the same OS user. No npm dependency.
const ExternalBotCredentials = (() => {
  function create(options) {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['file', 'root'].includes(key)) || Object.keys(options).length !== 1))
    throw Object.assign(Error('external_credentials.recovery_owner_invalid'), { code: 'external_credentials.recovery_owner_invalid' });
  if (options !== undefined && (typeof (Object.hasOwn(options,'file') ? options.file : options.root) !== 'string'
      || !path.isAbsolute(Object.hasOwn(options,'file') ? options.file : options.root)))
    throw Object.assign(Error('external_credentials.recovery_owner_invalid'), { code: 'external_credentials.recovery_owner_invalid' });
  const selected = options === undefined ? null : Object.hasOwn(options,'file') ? options.file : path.join(options.root, 'external-bot-credentials.json');
  // An explicit factory owns one fixed source. The default keeps startup root rebinding.
  const selectedFile = selected === null ? () => path.join(paths.data, 'external-bot-credentials.json') : () => selected;
  const SLOTS = Object.freeze({ qq: ['botSecret'], feishu: ['verificationToken', 'encryptKey', 'appSecret'] });
  const REF = Object.freeze({ botSecret: 'botSecretEnv', verificationToken: 'verificationTokenEnv', encryptKey: 'encryptKeyEnv', appSecret: 'appSecretEnv' });
  // Includes cold Windows PowerShell/.NET startup on slower machines; still bounded, with no retry.
  const LIMIT = Object.freeze({ records: 64, bytes: 4 * 1024 * 1024, cipherBytes: 65536, secretBytes: 4096, processMs: 15000, outputBytes: 131072 });
  const revisionKey = crypto.randomBytes(32);
  const chains = new Map();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const identity = value => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
  const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
  const fail = (suffix, statusCode = 503) => { throw Object.assign(new Error('external_credentials.' + suffix), { code: 'external_credentials.' + suffix, apiCode: 'external_credentials.' + suffix, statusCode }); };
  function validSecret(value) {
    if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > LIMIT.secretBytes
      || /[\x00-\x1f\x7f]/.test(value)) return false;
    const bytes = Buffer.from(value);
    try { return bytes.toString('utf8') === value; } finally { bytes.fill(0); }
  }
  function binding(connection) {
    if (!object(connection) || typeof connection.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(connection.id) || !Object.hasOwn(SLOTS, connection.platform)
      || !identity(connection.appId) || !identity(connection.tenantId) || (connection.botUserId !== undefined && typeof connection.botUserId !== 'string') || (connection.botUserId && !identity(connection.botUserId))
      || (connection.platform === 'feishu' && !identity(connection.botUserId))) fail('identity_invalid', 400);
    return { connectionId: connection.id, platform: connection.platform, appId: connection.appId, tenantId: connection.tenantId, botUserId: connection.botUserId || '' };
  }
  function sameBinding(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function base64(value, max) {
    if (typeof value !== 'string' || !value.length || value.length > max * 2 || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length <= max && bytes.toString('base64') === value;
  }
  function validState(state) {
    if (!exact(state, ['schema', 'records']) || state.schema !== 1 || !Array.isArray(state.records) || state.records.length > LIMIT.records) return false;
    const ids = new Set();
    for (const row of state.records) {
      if (!exact(row, ['binding', 'revision', 'cipher', 'present']) || !exact(row.binding, ['connectionId', 'platform', 'appId', 'tenantId', 'botUserId'])) return false;
      let normalized;
      try { normalized = binding({ ...row.binding, id: row.binding.connectionId }); } catch { return false; }
      if (!sameBinding(normalized, row.binding) || ids.has(row.binding.connectionId) || typeof row.revision !== 'string' || !/^[a-f0-9]{32}$/.test(row.revision)
        || !Array.isArray(row.present) || (row.present.length ? !base64(row.cipher, LIMIT.cipherBytes) : row.cipher !== '')
        || new Set(row.present).size !== row.present.length || row.present.some(slot => !SLOTS[row.binding.platform].includes(slot))) return false;
      ids.add(row.binding.connectionId);
    }
    return true;
  }
  const store = DurableJsonStore.create({ id: 'external-bot-credentials', file: selectedFile, schemaVersion: 1,
    defaultValue: () => ({ schema: 1, records: [] }), cache: false, strictRead: true, quarantine: false, validate: validState });
  async function stateRead() {
    try {
      const stat = await fsp.stat(store.filePath()).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && stat.size > LIMIT.bytes) fail('storage_unavailable');
      return await store.read();
    } catch { return fail('storage_unavailable'); }
  }
  async function stateWrite(state) {
    if (Buffer.byteLength(JSON.stringify(state)) > LIMIT.bytes) fail('capacity', 409);
    try { await store.write(state); } catch { store.invalidate(); fail('storage_unavailable'); }
  }
  // The command is static. Secret data goes only through bounded stdin, never argv, environment or files.
  // No exception text or child stderr is exposed. DPAPI operates under the already loaded current user profile.
  async function dpapi(op, value, owner) {
    try { return await LocalSecretCrypto.run(op, value, Buffer.from('ruyi.external-bot-credentials.v1:' + JSON.stringify(owner))); }
    catch (error) {
      const suffix = String(error && error.code || '').replace(/^local_crypto\./, '');
      fail(['unsupported', 'decrypt_failed', 'process_timeout', 'process_capacity'].includes(suffix) ? suffix : 'process_failed', suffix === 'unsupported' ? 501 : 503);
    }
  }
  function selectedEnv(connection, slots) {
    const env = {};
    for (const slot of slots) {
      const reference = connection[REF[slot]] === undefined ? '' : connection[REF[slot]];
      if (typeof reference !== 'string' || (reference && !/^RUYI_BOT_[A-Z0-9_]{1,100}$/.test(reference))) fail('env_reference_invalid', 400);
      if (reference) env[slot] = { reference, value: typeof process.env[reference] === 'string' ? process.env[reference] : '' };
    }
    return env;
  }
  function revision(owner, row, env) {
    return crypto.createHmac('sha256', revisionKey).update(JSON.stringify([owner, row?.revision || '', env])).digest('hex');
  }
  async function localValues(row, owner) {
    if (!row || !row.present.length) return {};
    const bytes = await dpapi('unprotect', Buffer.from(row.cipher, 'base64'), owner);
    try {
      const values = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!exact(values, SLOTS[owner.platform]) || Object.keys(values).length !== row.present.length
        || row.present.some(slot => !validSecret(values[slot])) || Object.keys(values).some(slot => !row.present.includes(slot))) fail('decrypt_failed');
      return values;
    } catch { return fail('decrypt_failed'); }
    finally { bytes.fill(0); }
  }
  function describe(connection, state) {
    const owner = binding(connection), slots = SLOTS[owner.platform], env = selectedEnv(connection, slots);
    const row = state.records.find(record => record.binding.connectionId === owner.connectionId);
    if (row && !sameBinding(row.binding, owner)) fail('identity_mismatch', 409);
    const values = {}, fields = {};
    for (const slot of slots) {
      const source = env[slot] ? 'env' : row?.present.includes(slot) ? 'local' : 'none';
      const value = env[slot]?.value || '', ready = source === 'env' && validSecret(value);
      values[slot] = ready ? value : '';
      fields[slot] = { source, present: source === 'local' || Boolean(value), ready,
        errorCode: source === 'env' && !ready ? 'external_credentials.' + (value ? 'env_invalid' : 'env_missing') : '' };
    }
    return { owner, row, slots, result: { values, credentialRevision: revision(owner, row, env), fields } };
  }
  async function takeSnapshot(connection, state, inspection = false) {
    const { owner, row, slots, result } = describe(connection, state);
    if (slots.some(slot => result.fields[slot].source === 'local')) {
      let local;
      try { local = await localValues(row, owner); }
      catch (error) {
        if (!inspection) throw error;
        for (const slot of slots) if (result.fields[slot].source === 'local') result.fields[slot].errorCode = error.code;
        return result;
      }
      for (const slot of slots) if (result.fields[slot].source === 'local') {
        result.values[slot] = local[slot]; result.fields[slot].ready = true;
      }
    }
    return result;
  }
  function publicSnapshot(snapshot) { return { credentialRevision: snapshot.credentialRevision, fields: snapshot.fields }; }
  async function snapshot(connection) { binding(connection); const captured = { ...connection }; return takeSnapshot(captured, await stateRead()); }
  async function inspect(connection) { binding(connection); const captured = { ...connection }; return publicSnapshot(await takeSnapshot(captured, await stateRead(), true)); }
  async function read(connection) { return (await snapshot(connection)).values; }
  async function save(connection, patch) {
    if (object(connection)) connection = { ...connection };
    const owner = binding(connection);
    const env = selectedEnv(connection, SLOTS[owner.platform]);
    if (process.platform !== 'win32') fail('unsupported', 501);
    if (connection.enabled !== false) fail('connection_enabled', 409);
    if (!exact(patch, ['set', 'remove', 'expectedRevision', 'replaceAll']) || typeof patch.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(patch.expectedRevision)
      || !exact(patch.set || {}, SLOTS[owner.platform]) || !Array.isArray(patch.remove || [])
      || (patch.replaceAll !== undefined && typeof patch.replaceAll !== 'boolean')
      || (patch.replaceAll === true && SLOTS[owner.platform].some(slot => env[slot]
        ? !(patch.remove || []).includes(slot) || Object.hasOwn(patch.set || {}, slot)
        : !Object.hasOwn(patch.set || {}, slot) || (patch.remove || []).includes(slot)))
      || (patch.remove || []).some(slot => !SLOTS[owner.platform].includes(slot))
      || Object.entries(patch.set || {}).some(([slot, value]) => env[slot] || !validSecret(value) || (patch.remove || []).includes(slot))) fail('patch_invalid', 400);
    patch = { ...patch, set: { ...(patch.set || {}) }, remove: [...(patch.remove || [])] };
    // This module also serializes its own durable read/compare/write; the caller owns the wider connection state lock.
    return runKeyedChain(chains, 'vault', async () => {
      const state = await stateRead(), before = describe(connection, state).result;
      if (before.credentialRevision !== patch.expectedRevision) fail('revision_conflict', 409);
      const index = state.records.findIndex(row => row.binding.connectionId === owner.connectionId);
      const previous = index >= 0 ? state.records[index] : null;
      const values = patch.replaceAll === true ? {} : await localValues(previous, owner);
      for (const slot of patch.remove || []) delete values[slot];
      Object.assign(values, patch.set || {});
      const present = SLOTS[owner.platform].filter(slot => Object.hasOwn(values, slot));
      if (index < 0 && state.records.length >= LIMIT.records) fail('capacity', 409);
      let protectedValue = '';
      if (present.length) {
        const bytes = Buffer.from(JSON.stringify(values)); let cipher;
        try { cipher = await dpapi('protect', bytes, owner); } finally { bytes.fill(0); }
        protectedValue = cipher.toString('base64'); cipher.fill(0);
      }
      // Retain a revision tombstone after removal: an old empty-vault observation must never become valid again.
      const record = { binding: owner, revision: crypto.randomBytes(16).toString('hex'), cipher: protectedValue, present };
      if (index < 0) state.records.push(record); else state.records[index] = record;
      await stateWrite(state);
      // Re-read the durable envelope. A failure here must not be hidden by a success cache.
      return inspect(connection);
    });
  }
  async function remove(connection, options = {}) { return save(connection, { set: {}, remove: SLOTS[binding(connection).platform], expectedRevision: options.expectedRevision }); }
  // Full work-data recovery uses local DPAPI rows directly, never selectedEnv or
  // public credentialRevision. An env override must not hide a retained local row.
  const recoveryExact = (value, fields) => exact(value, fields) && Object.keys(value).length === fields.length;
  const recoveryHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  function recoveryState(value) {
    if (!validState(value) || Buffer.byteLength(JSON.stringify(value)) > LIMIT.bytes) fail('recovery_invalid', 409);
    return JSON.parse(JSON.stringify(value));
  }
  function recoveryDecode(bytes) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('recovery_invalid', 409); }
  }
  async function recoveryRaw() {
    let handle, raw, failed = false;
    const scratch = Buffer.alloc(LIMIT.bytes + 1);
    try {
      try { handle = await fsp.open(store.filePath(), 'r'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      let used = 0;
      while (used < scratch.length) {
        const read = await handle.read(scratch, used, scratch.length - used, null);
        if (!read.bytesRead) break; used += read.bytesRead;
      }
      if (used > LIMIT.bytes) fail('recovery_invalid', 409);
      raw = Buffer.from(scratch.subarray(0, used));
      const state = recoveryState(recoveryDecode(raw));
      return { raw, state };
    } catch (error) {
      failed = true;
      raw?.fill(0);
      if (String(error?.code || '').startsWith('external_credentials.')) throw error;
      fail('storage_unavailable');
    } finally {
      scratch.fill(0);
      if (handle) try { await handle.close(); }
      catch { raw?.fill(0); if (!failed) fail('storage_unavailable'); }
    }
  }
  async function recoveryCapturedRaw(token) {
    if (typeof WorkDataTree === 'undefined' || typeof WorkDataTree.readCapturedFile !== 'function'
        || typeof WorkDataTree.verifyCapturedFile !== 'function' || typeof WorkDataTree.assertCapturedFile !== 'function') fail('recovery_owner_invalid', 409);
    const raw = await WorkDataTree.readCapturedFile(token, store.filePath());
    try {
      WorkDataTree.assertCapturedFile(token, store.filePath());
      if (!Buffer.isBuffer(raw) || raw.length > LIMIT.bytes) fail('recovery_invalid', 409);
      return { raw, state: recoveryState(recoveryDecode(raw)) };
    } catch (error) { raw?.fill(0); throw error; }
  }
  async function snapshotForWorkDataRecovery(capturedSource) {
    return runKeyedChain(chains, 'vault', async () => {
      const captured = capturedSource === undefined ? await recoveryRaw() : await recoveryCapturedRaw(capturedSource);
      if (!captured) return Object.freeze({ present: false, source: null, portable: null, release() {} });
      let portable, returned = false;
      try {
        const records = [];
        for (const row of captured.state.records) {
          if (capturedSource !== undefined) WorkDataTree.assertCapturedFile(capturedSource, store.filePath());
          const values = await localValues(row, row.binding);
          if (capturedSource !== undefined) WorkDataTree.assertCapturedFile(capturedSource, store.filePath());
          records.push({ binding: { ...row.binding }, revision: row.revision, present: [...row.present], values });
        }
        portable = Buffer.from(JSON.stringify({ schema: 1, records }), 'utf8');
        if (portable.length > LIMIT.bytes) fail('recovery_invalid', 409);
        if (capturedSource !== undefined) {
          if (await WorkDataTree.verifyCapturedFile(capturedSource, store.filePath()) !== true) fail('recovery_owner_invalid', 409);
          WorkDataTree.assertCapturedFile(capturedSource, store.filePath());
        }
        let released = false;
        const source = Object.freeze({ data: captured.raw, sha256: recoveryHash(captured.raw) });
        returned = true;
        return Object.freeze({ present: true, source, portable, release() {
          if (!released) { released = true; captured.raw.fill(0); portable.fill(0); }
        } });
      } finally { if (!returned) { captured.raw.fill(0); portable?.fill(0); } }
    });
  }
  async function stageRecoveredForWorkData(input) {
    if (!recoveryExact(input, ['state', 'portable']) || !Buffer.isBuffer(input.portable) || input.portable.length > LIMIT.bytes) fail('recovery_invalid', 409);
    // Capture both caller-owned inputs before any DPAPI await. Staging never
    // writes/reads the active store and may run before the target directory exists.
    const source = recoveryState(input.state), portable = Buffer.from(input.portable);
    const plain = [];
    try {
      const payload = recoveryDecode(portable);
      if (!recoveryExact(payload, ['schema', 'records']) || payload.schema !== 1 || !Array.isArray(payload.records)
        || payload.records.length !== source.records.length) fail('recovery_invalid', 409);
      // Validate every row before the first native protection operation.
      for (let i = 0; i < source.records.length; i++) {
        const expected = source.records[i], row = payload.records[i];
        if (!recoveryExact(row, ['binding', 'revision', 'present', 'values']) || !sameBinding(row.binding, expected.binding)
          || row.revision !== expected.revision || JSON.stringify(row.present) !== JSON.stringify(expected.present)
          || !recoveryExact(row.values, expected.present) || expected.present.some(slot => !validSecret(row.values[slot]))) fail('recovery_invalid', 409);
        const values = {};
        for (const slot of SLOTS[expected.binding.platform]) if (expected.present.includes(slot)) values[slot] = row.values[slot];
        plain.push(Buffer.from(JSON.stringify(values), 'utf8'));
      }
      const records = [];
      for (let i = 0; i < source.records.length; i++) {
        const row = source.records[i]; let cipher, check;
        try {
          let encrypted = '';
          if (row.present.length) {
            // Keep an independent comparison copy: a faulty protector must not
            // mutate its own input and make a different recovered value appear valid.
            const protectInput = Buffer.from(plain[i]);
            try { cipher = await dpapi('protect', protectInput, row.binding); }
            finally { protectInput.fill(0); }
            if (!Buffer.isBuffer(cipher) || !cipher.length || cipher.length > LIMIT.cipherBytes) fail('recovery_roundtrip_failed');
            check = await dpapi('unprotect', cipher, row.binding);
            if (!Buffer.isBuffer(check) || check.length !== plain[i].length || !crypto.timingSafeEqual(check, plain[i])) fail('recovery_roundtrip_failed');
            encrypted = cipher.toString('base64');
          }
          records.push({ binding: { ...row.binding }, revision: row.revision, present: [...row.present], cipher: encrypted });
        } finally { if (Buffer.isBuffer(cipher)) cipher.fill(0); if (Buffer.isBuffer(check)) check.fill(0); }
      }
      const state = recoveryState({ schema: 1, records });
      return Object.freeze({ state, sourceStateSha256: recoveryHash(JSON.stringify(source)), stagedStateSha256: recoveryHash(JSON.stringify(state)) });
    } finally { portable.fill(0); for (const bytes of plain) bytes.fill(0); }
  }
  return Object.freeze({ snapshot, inspect, read, save, remove, snapshotForWorkDataRecovery, stageRecoveredForWorkData });
  }
  return Object.freeze({ create, ...create() });
})();
