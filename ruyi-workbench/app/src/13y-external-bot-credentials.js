// Dedicated local bot credentials, never a model tool. Windows DPAPI CurrentUser protects stored values;
// it does not protect against another program already running as the same OS user. No npm dependency.
const ExternalBotCredentials = (() => {
  const childProcess = require('node:child_process');
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
  const validSecret = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= LIMIT.secretBytes
    && !/[\x00-\x1f\x7f]/.test(value) && Buffer.from(value).toString('utf8') === value;
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
  const store = DurableJsonStore.create({ id: 'external-bot-credentials', file: () => path.join(paths.data, 'external-bot-credentials.json'), schemaVersion: 1,
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
  const DPAPI_SCRIPT = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$PSModuleAutoLoadingPreference='None'
try {
  [void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  $op = [Console]::In.ReadLine()
  $bytes = [Convert]::FromBase64String([Console]::In.ReadLine())
  $entropy = [Convert]::FromBase64String([Console]::In.ReadLine())
  if ($op -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($op -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { throw 'operation' }
  [Console]::Out.Write('{"ok":true,"value":"'+[Convert]::ToBase64String($result)+'"}')
  [Array]::Clear($bytes,0,$bytes.Length)
  [Array]::Clear($result,0,$result.Length)
  exit 0
} catch { [Console]::Out.Write('{"ok":false}'); exit 1 }`;
  function dpapi(op, value, owner) {
    if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('external_credentials.unsupported'), { code: 'external_credentials.unsupported', apiCode: 'external_credentials.unsupported', statusCode: 501 }));
    return new Promise((resolve, reject) => {
      let child, complete = false, outputSize = 0;
      const output = [];
      const finish = (suffix, result) => {
        if (complete) return;
        complete = true; clearTimeout(timer);
        for (const chunk of output) chunk.fill(0);
        output.length = 0;
        if (suffix) reject(Object.assign(new Error('external_credentials.' + suffix), { code: 'external_credentials.' + suffix, apiCode: 'external_credentials.' + suffix, statusCode: 503 }));
        else resolve(result);
      };
      const stop = suffix => { finish(suffix); if (child) { try { child.kill(); } catch { /* own PowerShell has no descendants */ } } };
      const timer = setTimeout(() => stop('process_timeout'), LIMIT.processMs);
      const environment = {};
      // Do not inherit RUYI_BOT_* or provider credentials into the helper environment.
      for (const key of ['SystemRoot', 'SystemDrive', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) if (typeof process.env[key] === 'string') environment[key] = process.env[key];
      const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Only Windows' built-in modules are needed. Without an explicit path PowerShell discovers
      // third-party modules installed machine-wide, even with -NoProfile and a sanitized environment.
      environment.PSModulePath = path.join(path.dirname(executable), 'Modules');
      try {
        child = childProcess.spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: environment });
        child.on('error', () => finish('process_failed'));
        child.stdout.on('data', chunk => {
          if (complete) { chunk.fill(0); return; }
          outputSize += chunk.length;
          if (outputSize > LIMIT.outputBytes) { chunk.fill(0); stop('process_capacity'); return; }
          output.push(chunk);
        });
        child.stdout.on('error', () => stop('process_failed'));
        child.stdin.on('error', () => stop('process_failed'));
        child.on('close', code => {
          if (complete) return;
          let response;
          const bytes = Buffer.concat(output);
          try { response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { finish('process_failed'); return; }
          finally { bytes.fill(0); }
          if (code !== 0 || !exact(response, ['ok', 'value']) || response.ok !== true || !base64(response.value, LIMIT.cipherBytes)) { finish(op === 'unprotect' ? 'decrypt_failed' : 'process_failed'); return; }
          finish(null, Buffer.from(response.value, 'base64'));
        });
        // Three ASCII lines need neither pipe EOF nor cmdlet/module discovery (Add-Type/JSON).
        child.stdin.end([op, value.toString('base64'), Buffer.from('ruyi.external-bot-credentials.v1:' + JSON.stringify(owner)).toString('base64'), ''].join('\n'));
      } catch { stop('process_failed'); }
    });
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
  return Object.freeze({ snapshot, inspect, read, save, remove });
})();
