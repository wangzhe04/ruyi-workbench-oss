// 81-P1: Immutable encrypted credential records; config holds typed references, never vault plaintext.
const CredentialVault = ((cryptoApi) => {
  const MAX = Object.freeze({ bytes: 8 * 1024 * 1024, records: 1024, value: 65536, slots: 256 });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const fail = suffix => { throw Object.assign(new Error('credential_vault.' + suffix), { code: 'credential_vault.' + suffix, apiCode: 'credential_vault.' + suffix, statusCode: 503 }); };
  const empty = () => ({ schema: 1, instanceId: '', protectedKey: '', records: [] });
  // 150 P15: only a DPAPI verdict on the wrapped key is unlock_failed (another account, a reset password).
  // A helper that timed out, could not start or was blocked by policy says nothing about the key: those are
  // unlock_timeout / helper_unavailable, retryable as they are, and the guidance never suggests a new data
  // root. A helper that may still be running keeps that marker for the callers that must hold ownership.
  const unlockFailure = error => {
    const code = error?.code, uncertain = error?.helperMayStillRun === true ? { helperMayStillRun: true } : {};
    const suffix = code === 'local_crypto.process_timeout' ? 'unlock_timeout'
      : ['local_crypto.process_failed', 'local_crypto.process_capacity', 'local_crypto.helper_blocked'].includes(code) ? 'helper_unavailable'
      : String(code || '').startsWith('credential_vault.') ? null : 'unlock_failed';
    if (!suffix) return error;
    return Object.assign(new Error('credential_vault.' + suffix), { code: 'credential_vault.' + suffix, apiCode: 'credential_vault.' + suffix, statusCode: 503, ...uncertain });
  };
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
      const url = new URL(value);
      return !!(url.username || url.password) || [...url.searchParams.keys()].some(key => /(?:key|token|secret|credential|signature|^sig$|password)/i.test(key));
    } catch { return false; }
  }
  // Every position a credential can occupy, with the binding its record is owned under. kind 'url' and
  // 'urls' positions hold a credential only when the URL itself carries one. One table serves both the
  // slots that are encrypted (slots) and the positions a moved credential may be found at (150 P15).
  function sites(config, visit) {
    for (const [i, provider] of (Array.isArray(config.providers) ? config.providers : []).entries()) {
      if (!object(provider) || typeof provider.id !== 'string') continue;
      const binding = ['provider', provider.id, provider.baseUrl || '', provider.audioBaseUrl || '', provider.extraBaseUrls || [], provider.apiStyle || 'chat'];
      visit(['providers', i, 'apiKey'], provider.apiKey, binding, 'value');
      visit(['providers', i, 'extraHeaders'], provider.extraHeaders, binding, 'value');
      for (const name of ['baseUrl', 'audioBaseUrl']) visit(['providers', i, name], provider[name], binding, 'url');
      visit(['providers', i, 'extraBaseUrls'], provider.extraBaseUrls, binding, 'urls');
    }
    visit(['privacyRulesV1'], config.privacyRulesV1, ['privacy-rules-v1'], 'value');
    visit(['modelsApiKey'], config.modelsApiKey, ['claude', config.modelsApiBase || ''], 'value');
    visit(['modelsApiBase'], config.modelsApiBase, ['claude', config.modelsApiBase], 'url');
    if (object(config.searchBackend)) {
      const binding = ['search', config.searchBackend.baseUrl || '', config.searchBackend.type || ''];
      visit(['searchBackend', 'apiKey'], config.searchBackend.apiKey, binding, 'value');
      visit(['searchBackend', 'baseUrl'], config.searchBackend.baseUrl, binding, 'url');
    }
    for (const [i, server] of (Array.isArray(config.externalMcpServers) ? config.externalMcpServers : []).entries()) {
      if (!object(server) || typeof server.id !== 'string') continue;
      const binding = ['mcp', server.id, server.url || '', server.command || '', server.args || [], server.cwd || ''];
      for (const name of ['env', 'headers', 'args']) visit(['externalMcpServers', i, name], server[name], binding, 'value');
      visit(['externalMcpServers', i, 'url'], server.url, binding, 'url');
    }
  }
  function slots(config) {
    const out = [];
    sites(config, (parts, value, binding, kind) => {
      if (kind === 'url' && !secretUrl(value) || kind === 'urls' && !(Array.isArray(value) && value.some(secretUrl))) return;
      if (value === '' || value === null || value === undefined) return;
      if (object(value) && !Object.keys(value).length || Array.isArray(value) && !value.length) return;
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX.value) fail('value_limit');
      if (out.length >= MAX.slots) fail('slots_limit');
      out.push({ pointer: pointer(parts), serialized, binding });
    });
    return out;
  }
  // 150 P15: a trailing slash added to or removed from a bound URL does not change the service. A binding
  // is also tried with each of its URLs (at most four) toggled; the host and path otherwise stay exact.
  function bindingVariants(binding) {
    const urls = [];
    binding.forEach((item, i) => {
      if (typeof item === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(item)) urls.push([i]);
      else if (Array.isArray(item)) item.forEach((url, j) => { if (typeof url === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(url)) urls.push([i, j]); });
    });
    const toggle = url => url.endsWith('/') ? url.replace(/\/+$/, '') : url + '/';
    const variants = [];
    for (let mask = 1; mask < 1 << Math.min(urls.length, 4); mask++) {
      const copy = binding.map(item => Array.isArray(item) ? [...item] : item);
      urls.slice(0, 4).forEach(([i, j], bit) => { if (mask & 1 << bit) { if (j === undefined) copy[i] = toggle(copy[i]); else copy[i][j] = toggle(copy[i][j]); } });
      variants.push(copy);
    }
    return variants;
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
        } catch (error) { key.fill(0); throw unlockFailure(error); }
      }
      const binding = state.instanceId + ':' + state.protectedKey;
      if (keyCache?.binding === binding) return keyCache.key;
      try {
        const key = await protector.run('unprotect', Buffer.from(state.protectedKey, 'base64'), entropy(state.instanceId));
        if (key.length !== 32) { key.fill(0); fail('unlock_failed'); }
        if (keyCache) keyCache.key.fill(0);
        keyCache = { binding, key }; return key;
      } catch (error) { throw unlockFailure(error); }
    }
    const aad = (state, recordId, purpose = 'credential') => ({ instanceId: state.instanceId, recordId, purpose });
    // 150 P15: a hand edit of config.json used to fail the whole configuration (binding_mismatch) when it
    // only reordered or removed a provider or toggled a trailing slash. Records stay owned by the pointer
    // and binding they were sealed under; hydration now finds each record's owner:
    //   1. at its recorded pointer, with the exact binding or a trailing-slash variant;
    //   2. otherwise at the same field of another entry of the same list (a moved provider or MCP server)
    //      whose binding matches, while that position is still empty (fields bound to each other move together);
    //   3. otherwise the credential is withheld: it is never given to a service it was not bound to. Withheld
    //      references are kept in their own list (credentialWithheldRefsV1), not in a slot, so a value typed
    //      into the old position does not destroy them and undoing the hand edit restores them (4B review v2).
    //      Decryption, integrity and a value typed over a live reference (reference_collision) fail closed as before.
    const WITHHELD_KEY = 'credentialWithheldRefsV1', WITHHELD_MAX = 32;
    function hydrate(raw, state, key, report = null) {
      const refs = raw.credentialRefsV1, kept = raw[WITHHELD_KEY];
      delete raw[WITHHELD_KEY];
      if (!refs && !Array.isArray(kept)) return raw;
      if (refs && (!object(refs) || refs.version !== 1 || !Array.isArray(refs.slots) || refs.slots.length > MAX.slots || Object.keys(refs).sort().join(',') !== 'slots,version')) fail('reference_invalid');
      const open = record => {
        let value;
        try { value = JSON.parse(core.open(record.envelope, key, aad(state, record.id), 'master-v1')); }
        catch { fail('decrypt_failed'); }
        if (hash(key, record.owner + ':' + JSON.stringify(value)) !== record.fingerprint) fail('integrity_failed');
        return value;
      };
      const seen = new Set(), entries = [];
      for (const ref of refs ? refs.slots : []) {
        if (!object(ref) || Object.keys(ref).sort().join(',') !== 'id,pointer' || !id(ref.id) || seen.has(ref.pointer)) fail('reference_invalid');
        seen.add(ref.pointer);
        if (typeof ref.pointer !== 'string' || !ref.pointer.startsWith('/') || ref.pointer.length > 1024) fail('reference_invalid');
        const record = state.records.find(row => row.id === ref.id); if (!record) fail('reference_missing');
        entries.push({ ref, record, value: open(record), at: null, kept: false });
      }
      // A kept (withheld) reference was never in use: a malformed, vanished or unreadable one is dropped quietly.
      for (const ref of Array.isArray(kept) ? kept.slice(0, WITHHELD_MAX) : []) {
        const shape = object(ref) ? Object.keys(ref).sort().join(',') : '';
        if (!['id,pointer', 'id,ownerId,pointer'].includes(shape) || !id(ref.id) || typeof ref.pointer !== 'string' || !ref.pointer.startsWith('/') || ref.pointer.length > 1024
          || shape === 'id,ownerId,pointer' && !(typeof ref.ownerId === 'string' && ref.ownerId.length > 0 && ref.ownerId.length <= 128)) continue;
        if (entries.some(entry => entry.ref.id === ref.id && entry.ref.pointer === ref.pointer)) continue;
        const record = state.records.find(row => row.id === ref.id); if (!record) continue;
        let value; try { value = open(record); } catch { continue; }
        entries.push({ ref: { pointer: ref.pointer, id: ref.id }, record, value, at: null, kept: true, ownerId: typeof ref.ownerId === 'string' ? ref.ownerId : null });
      }
      const locate = p => { try { return at(raw, p); } catch (error) { if (error?.code === 'credential_vault.reference_invalid') return null; throw error; } };
      const put = (entry, p) => { const slot = locate(p); slot.parent[slot.key] = structuredClone(entry.value); entry.at = p; };
      const clear = entry => { const slot = locate(entry.at); if (slot) slot.parent[slot.key] = ''; entry.at = null; };
      for (const entry of entries) {
        if (entry.kept) continue;
        const slot = locate(entry.ref.pointer);
        if (slot && slot.value !== '') fail('reference_collision');
        if (slot) put(entry, entry.ref.pointer);
      }
      const owns = (entry, binding, exactOnly = false) => [binding, ...(exactOnly ? [] : bindingVariants(binding))]
        .some(candidate => hash(key, JSON.stringify([entry.ref.pointer, candidate])) === entry.record.owner);
      const recognized = () => new Map(slots(raw).map(slot => [slot.pointer, slot]));
      // A wrongly placed value changes no binding but its own slot's; settle placements to a fixed point.
      for (let round = 0, changed = true; changed && round <= entries.length; round++) {
        changed = false; const current = recognized();
        for (const entry of entries) if (entry.at && !(current.has(entry.at) && owns(entry, current.get(entry.at).binding))) { clear(entry); changed = true; }
      }
      let moved = false;
      for (const entry of entries) if (entry.at && !owns(entry, recognized().get(entry.at).binding, true)) moved = true;
      const listParts = entry => { const parts = entry.ref.pointer.slice(1).split('/'); return parts.length === 3 && ['providers', 'externalMcpServers'].includes(parts[0]) ? parts : null; };
      // A field that is part of its own binding (an MCP server's args/url, a provider's URLs) is relocated
      // first, so the other fields of the same entry see their real binding (review 4B-S1). Each candidate
      // is tried by placing the value there and reading that position's binding back.
      const selfBound = new Set(['args', 'url', 'baseUrl', 'audioBaseUrl', 'extraBaseUrls']);
      const fieldOf = entry => entry.ref.pointer.slice(1).split('/')[2];
      // Fields that are part of each other's binding (a secret URL and args of one MCP server) can only prove
      // their owner together: the unplaced entries of one original entry first move as a group to every
      // candidate entry of the same list (4B review round 2); single fields that remain are tried one by one.
      const groups = new Map();
      for (const entry of entries) {
        const parts = listParts(entry); if (entry.at || !parts) continue;
        const group = groups.get(parts[0] + '/' + parts[1]) || []; group.push(entry); groups.set(parts[0] + '/' + parts[1], group);
      }
      for (const group of groups.values()) {
        const root = listParts(group[0])[0], list = Array.isArray(raw[root]) ? raw[root] : [], hits = [];
        for (let i = 0; i < list.length; i++) {
          const targets = group.map(entry => pointer([root, i, fieldOf(entry)]));
          if (new Set(targets).size !== targets.length || targets.some(p => { const slot = locate(p); return !slot || slot.value !== '' || entries.some(other => other.at === p); })) continue;
          group.forEach((entry, j) => put(entry, targets[j]));
          const current = recognized(), proven = group.every((entry, j) => current.has(targets[j]) && owns(entry, current.get(targets[j]).binding));
          group.forEach(clear);
          if (proven) hits.push(targets);
        }
        if (hits.length === 1) { group.forEach((entry, j) => put(entry, hits[0][j])); moved = true; }
      }
      const pending = entries.filter(entry => !entry.at).sort((a, b) => Number(!selfBound.has(fieldOf(a))) - Number(!selfBound.has(fieldOf(b))));
      for (const entry of pending) {
        if (entries.some(other => other !== entry && other.at === entry.ref.pointer)) continue;
        const parts = listParts(entry), candidates = [];
        // A position outside the provider/server lists has one possible place: its own pointer, when empty.
        if (!parts) { const slot = locate(entry.ref.pointer); if (slot && slot.value === '') candidates.push(entry.ref.pointer); }
        else sites(raw, (siteParts, value) => {
          if (siteParts[0] !== parts[0] || siteParts[2] !== parts[2] || value !== '') return;
          const p = pointer(siteParts);
          if (!entries.some(other => other.at === p)) candidates.push(p);
        });
        const found = candidates.filter(p => { put(entry, p); const slot = recognized().get(p), hit = !!slot && owns(entry, slot.binding); clear(entry); return hit; });
        if (found.length === 1) { put(entry, found[0]); moved = true; }
      }
      // A relocated value is accepted only if its final position still proves the same owner.
      const final = recognized();
      for (const entry of entries) if (entry.at && !(final.has(entry.at) && owns(entry, final.get(entry.at).binding))) clear(entry);
      if (report) {
        report.moved ||= moved;
        const containerOf = p => { const parts = p.slice(1).split('/'); return parts.length === 3 ? '/' + parts.slice(0, 2).join('/') : null; };
        // The entry now at an old position is named as the owner of a withheld value only with proof: another
        // credential sealed at that same position is still verified there in place (4B review v2). Otherwise
        // the owner is unknown (null): after a reorder the occupant is usually someone else.
        const provenHomes = new Set(entries.filter(entry => entry.at && entry.at === entry.ref.pointer).map(entry => containerOf(entry.ref.pointer)).filter(Boolean));
        // 4B review v3: a withheld entry remembers the id of the provider/server it was first withheld from, when
        // that is known (proven as above, or nothing in this load moved). Once no entry with that id is left (the
        // provider was deleted), the reference is retired: re-adding the same id and URL later starts empty.
        const reordered = entries.some(entry => entry.at && entry.at !== entry.ref.pointer);
        for (const entry of entries) {
          if (entry.at || report.withheld.length >= WITHHELD_MAX) continue;
          const home = containerOf(entry.ref.pointer), container = home ? locate(home) : null;
          if (home && !container) continue;   // the list entry it belonged to no longer exists: nothing to restore
          const occupant = typeof container?.value?.id === 'string' ? container.value.id : null;
          const ownerId = entry.kept ? entry.ownerId : home && (provenHomes.has(home) || !reordered) ? occupant : null;
          if (ownerId && home) {
            const list = raw[home.slice(1).split('/')[0]];
            if (!Array.isArray(list) || !list.some(item => object(item) && item.id === ownerId)) continue;
          }
          const slot = locate(entry.ref.pointer);
          report.withheld.push({ pointer: entry.ref.pointer, id: entry.ref.id, ownerId,
            containerId: home && provenHomes.has(home) ? occupant : null,
            // Shown to the user only while its old position is empty; a value typed there keeps it silently.
            shown: !!slot && slot.value === '' });
        }
      }
      delete raw.credentialRefsV1;
      raw.credentialEncryptionV1 = true;
      raw.configExplicitKeysV1 = [...new Set([...(Array.isArray(raw.configExplicitKeysV1) ? raw.configExplicitKeysV1 : []), 'credentialEncryptionV1'])].sort();
      return raw;
    }
    // Withheld references of the last configuration this vault hydrated (pointers and record ids only).
    let withheldMemory = [];
    const shownWithheld = rows => rows.filter(row => row.shown).map(({ pointer: p, containerId }) => ({ pointer: p, containerId }));
    async function hydrateConfig(raw) {
      if (!object(raw)) return { raw, needsMigration: false };
      return serial(async () => {
        const clone = structuredClone(raw);
        if (clone.credentialRefsV1 || Array.isArray(clone[WITHHELD_KEY])) {
          const state = await stateRead(), key = await master(state, false), report = { moved: false, withheld: [] };
          const hydrated = hydrate(clone, state, key, report);
          withheldMemory = report.withheld;
          // A moved or restored credential is rewritten at its position once; withheld ones are carried by protectConfig.
          return { raw: hydrated, needsMigration: report.moved, withheld: shownWithheld(report.withheld) };
        }
        withheldMemory = [];
        const enabled = clone.credentialEncryptionV1 === true;
        return { raw: clone, needsMigration: enabled && slots(clone).length > 0 };
      });
    }
    async function protectUnlocked(serialized, force, allowPlaintext) {
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX.bytes) fail('config_invalid');
      let raw; try { raw = JSON.parse(serialized); } catch { fail('config_invalid'); }
      if (!object(raw)) fail('config_invalid');
      let state, key;
      const report = { moved: false, withheld: [] }, ownRefs = !!raw.credentialRefsV1 || Array.isArray(raw[WITHHELD_KEY]);
      if (ownRefs) { state = await stateRead(); key = await master(state, false); raw = hydrate(raw, state, key, report); }
      delete raw[WITHHELD_KEY];
      const enabled = force || raw.credentialEncryptionV1 === true;
      if (!enabled) {
        if (!allowPlaintext && await host.size() > 0) fail('disable_requires_migration');
        return JSON.stringify(raw, null, 2);
      }
      // 150 P15 + 4B review v2: withheld references travel in their own list. A configuration with references
      // carries its own; the runtime (hydrated) configuration carries those of the last load of this vault.
      let carried = [];
      for (const item of ownRefs ? report.withheld : withheldMemory) {
        // The owner was deleted in this write (no entry with its id left in its list): the reference is retired.
        const root = item.pointer.slice(1).split('/')[0];
        if (item.ownerId && !(Array.isArray(raw[root]) && raw[root].some(row => object(row) && row.id === item.ownerId))) continue;
        if (!carried.some(row => row.pointer === item.pointer && row.id === item.id)) carried.push({ pointer: item.pointer, id: item.id, ...(item.ownerId ? { ownerId: item.ownerId } : {}) });
      }
      if (carried.length) { const known = state || await stateRead(); carried = carried.filter(item => known.records.some(row => row.id === item.id)).slice(0, WITHHELD_MAX); }
      const selected = slots(raw); if (!selected.length && !carried.length) return JSON.stringify(raw, null, 2);
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
      if (carried.length) raw[WITHHELD_KEY] = carried;
      return JSON.stringify(raw, null, 2);
    }
    const protectConfig = (serialized, options = {}) => serial(() => protectUnlocked(serialized, options.force === true, options.allowPlaintext === true));
    async function protectBackup(serialized, nextSerialized) {
      const next = JSON.parse(nextSerialized);
      if (!next.credentialRefsV1 && next.credentialEncryptionV1 !== true) return serialized;
      return protectConfig(serialized, { force: true });
    }
    async function protectCorrupt(serialized, name, enabled = true) {
      if (!enabled) return serialized;
      return serial(async () => {
        const state = await stateRead(); const fresh = !state.instanceId; const key = await master(state, true);
        if (fresh) await stateWrite(state);
        const recordId = 'backup-' + cryptoApi.createHash('sha256').update(name).digest('hex');
        return JSON.stringify({ ruyiEncryptedBackupV1: 1, name, envelope: core.seal(serialized, key, aad(state, recordId, 'config-backup'), 'master-v1') }, null, 2);
      });
    }
    // Full work-data recovery foundations, separate from credential-only backup/import.
    // This validates every immutable vault record, including historical records not referenced
    // by the current configuration. Actual config pointer/owner bindings and all sealLocal /
    // external direct-DPAPI references still require the migration host's complete inventory.
    const recoveryLease = (masterKey, instanceId) => {
      const key = Buffer.from(masterKey); let released = false;
      return Object.freeze({ key, instanceId, release: () => { if (!released) { released = true; key.fill(0); } } });
    };
    function recoveryStateCopy(value) {
      if (!validate(value)) fail('recovery_state_invalid');
      let serializedState;
      try { serializedState = JSON.stringify(value); } catch { fail('recovery_state_invalid'); }
      if (Buffer.byteLength(serializedState, 'utf8') > MAX.bytes) fail('capacity');
      const state = JSON.parse(serializedState);
      if (state.instanceId) {
        const wrapped = Buffer.from(state.protectedKey, 'base64');
        try { if (!wrapped.length || wrapped.toString('base64') !== state.protectedKey) fail('recovery_state_invalid'); }
        finally { wrapped.fill(0); }
      }
      return { state, serializedState };
    }
    function verifyRecoveryRecords(state, key) {
      for (const record of state.records) {
        if (typeof record.owner !== 'string' || typeof record.fingerprint !== 'string') fail('recovery_record_invalid');
        let serialized;
        try {
          serialized = core.open(record.envelope, key, aad(state, record.id), 'master-v1');
          if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX.value) fail('recovery_record_invalid');
          JSON.parse(serialized);
        } catch { fail('recovery_record_invalid'); }
        const actual = Buffer.from(hash(key, record.owner + ':' + serialized), 'hex'), expected = Buffer.from(record.fingerprint, 'hex');
        try { if (expected.length !== 32 || !cryptoApi.timingSafeEqual(actual, expected)) fail('recovery_record_invalid'); }
        finally { actual.fill(0); expected.fill(0); }
      }
    }
    const snapshotForWorkDataRecovery = () => serial(async () => {
      const { state, serializedState } = recoveryStateCopy(await stateRead());
      if (!state.instanceId) return null; // No key and no records: never initialize on a backup read.
      if (!protector.supported()) fail('unsupported');
      let key, wrapped, domain;
      try {
        wrapped = Buffer.from(state.protectedKey, 'base64'); domain = entropy(state.instanceId);
        // Own this key directly. master(false) exposes the cache Buffer, whose clear() lifecycle
        // must not zero a pending recovery snapshot with no records but live privacy mappings.
        try { key = await protector.run('unprotect', wrapped, domain); } catch (error) { throw unlockFailure(error); }
        if (!Buffer.isBuffer(key) || key.length !== 32) fail('unlock_failed');
        verifyRecoveryRecords(state, key);
        const after = recoveryStateCopy(await stateRead());
        if (after.serializedState !== serializedState) fail('recovery_changed');
        // Parsed-state exact content proof, not original file bytes, stat proof or cross-process
        // CAS. The host also compares actual vault-file bytes within its writer barrier.
        return Object.freeze({ state, lease: recoveryLease(key, state.instanceId),
          proof: Object.freeze({ serializedState, sha256: cryptoApi.createHash('sha256').update(serializedState, 'utf8').digest('hex') }) });
      } finally {
        if (Buffer.isBuffer(key)) key.fill(0);
        if (wrapped) wrapped.fill(0);
        if (domain) domain.fill(0);
      }
    });
    async function stageRecoveredForWorkData(value) {
      if (!object(value) || Object.keys(value).sort().join(',') !== 'key,state') fail('recovery_state_invalid');
      if (!Buffer.isBuffer(value.key) || value.key.length !== 32) fail('recovery_key_invalid');
      // Copy before the first await. Neither caller mutation/release nor active vault operations
      // may change this target-stage authority, and this method never touches the active cache.
      const { state } = recoveryStateCopy(value.state);
      if (!state.instanceId) fail('recovery_state_invalid');
      const key = Buffer.from(value.key);
      let protectInput, wrapped, roundtrip, protectDomain, verifyDomain;
      try {
        verifyRecoveryRecords(state, key);
        if (!protector.supported()) fail('unsupported');
        protectInput = Buffer.from(key); protectDomain = entropy(state.instanceId);
        try { wrapped = await protector.run('protect', protectInput, protectDomain); } catch (error) { throw unlockFailure(error); }
        if (!Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > 65536) fail('unlock_failed');
        const next = { ...state, protectedKey: wrapped.toString('base64') };
        recoveryStateCopy(next);
        verifyDomain = entropy(state.instanceId);
        try { roundtrip = await protector.run('unprotect', wrapped, verifyDomain); } catch { fail('recovery_roundtrip_failed'); }
        if (!Buffer.isBuffer(roundtrip) || roundtrip.length !== 32 || !cryptoApi.timingSafeEqual(key, roundtrip)) fail('recovery_roundtrip_failed');
        verifyRecoveryRecords(next, roundtrip);
        return Object.freeze({ state: next, lease: recoveryLease(key, state.instanceId) });
      } finally {
        key.fill(0);
        if (protectInput) protectInput.fill(0);
        if (Buffer.isBuffer(wrapped)) wrapped.fill(0);
        if (Buffer.isBuffer(roundtrip)) roundtrip.fill(0);
        if (protectDomain) protectDomain.fill(0);
        if (verifyDomain) verifyDomain.fill(0);
      }
    }

    function clear() { if (keyCache) keyCache.key.fill(0); keyCache = null; }
    async function backupKey(password, salt) {
      if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024 || Buffer.from(password).toString('utf8') !== password) fail('backup_password');
      return new Promise((resolve, reject) => cryptoApi.scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => error ? reject(Object.assign(new Error('credential_vault.backup_failed'), { code: 'credential_vault.backup_failed' })) : resolve(key)));
    }
    async function exportBackup(serialized, password) {
      return serial(async () => {
        let config; try { config = JSON.parse(serialized); } catch { fail('config_invalid'); }
        if (!object(config) || !config.credentialRefsV1) fail('backup_no_credentials');
        const state = await stateRead(), key = await master(state, false);
        hydrate(structuredClone(config), state, key); // Verify every reference before producing a recovery package.
        const salt = cryptoApi.randomBytes(16), exportId = cryptoApi.randomBytes(16).toString('hex'), derived = await backupKey(password, salt);
        try {
          // 4B review v3: withheld references travel with the package, so undoing the hand edit after a restore
          // still brings them back; they stay bound to the endpoint they were sealed for.
          const withheldIds = Array.isArray(config.credentialWithheldRefsV1) ? config.credentialWithheldRefsV1.map(row => row?.id).filter(id) : [];
          const referenced = new Set([...config.credentialRefsV1.slots.map(slot => slot.id), ...withheldIds]);
          const payload = JSON.stringify({ schema: 1, config, instanceId: state.instanceId, master: key.toString('base64'), records: state.records.filter(record => referenced.has(record.id)) });
          if (Buffer.byteLength(payload) > core.LIMITS.bytes) fail('backup_capacity');
          return JSON.stringify({ schema: 1, kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64') }, exportId,
            envelope: core.seal(payload, derived, { instanceId: exportId, recordId: 'portable-v1', purpose: 'vault-export' }, 'export-v1') });
        } finally { derived.fill(0); }
      });
    }
    async function prepareImport(serialized, password, options = {}) {
      // Preparation is side-effect free. The recovery service merges verified runtime values under the destination key and retains rollback.
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 2 * core.LIMITS.bytes) fail('backup_invalid');
      let data; try { data = JSON.parse(serialized); } catch { fail('backup_invalid'); }
      if (!object(data) || Object.keys(data).sort().join(',') !== 'envelope,exportId,kdf,schema' || data.schema !== 1 || !id(data.exportId)
        || !object(data.kdf) || Object.keys(data.kdf).sort().join(',') !== 'N,name,p,r,salt' || data.kdf.name !== 'scrypt'
        || data.kdf.N !== 32768 || data.kdf.r !== 8 || data.kdf.p !== 1 || typeof data.kdf.salt !== 'string') fail('backup_invalid');
      const salt = Buffer.from(data.kdf.salt, 'base64');
      if (salt.length !== 16 || salt.toString('base64') !== data.kdf.salt) fail('backup_invalid');
      const derived = await backupKey(password, salt);
      let key;
      try {
        let payload; try { payload = JSON.parse(core.open(data.envelope, derived, { instanceId: data.exportId, recordId: 'portable-v1', purpose: 'vault-export' }, 'export-v1')); }
        catch { fail('backup_authentication'); }
        if (!object(payload) || payload.schema !== 1 || !id(payload.instanceId) || typeof payload.master !== 'string' || !object(payload.config)) fail('backup_invalid');
        key = Buffer.from(payload.master, 'base64'); if (key.length !== 32 || key.toString('base64') !== payload.master) fail('backup_invalid');
        if (!protector.supported()) fail('unsupported');
        let wrapped; try { wrapped = await protector.run('protect', key, entropy(payload.instanceId)); } catch (error) { throw unlockFailure(error); }
        const state = { schema: 1, instanceId: payload.instanceId, protectedKey: wrapped.toString('base64'), records: payload.records }; wrapped.fill(0);
        if (!validate(state) || Buffer.byteLength(JSON.stringify(state)) > MAX.bytes) fail('backup_invalid');
        const runtime = hydrate(structuredClone(payload.config), state, key);
        return { config: JSON.stringify(payload.config, null, 2), state, ...(options.runtime === true ? { runtime } : {}) };
      } finally { derived.fill(0); if (key) key.fill(0); }
    }
    async function migrateBackups(nextSerialized) {
      const next = JSON.parse(nextSerialized);
      if (next.credentialEncryptionV1 === false || !host.backups) return;
      if (!next.credentialRefsV1 && next.credentialEncryptionV1 !== true) return;
      try {
        const names = await host.backups.list();
        if (names.length > 128) fail('backup_capacity');
        for (const name of names) {
          const original = await host.backups.read(name);
          let parsed; try { parsed = JSON.parse(original); } catch { /* Preserve malformed backup inside a whole-file envelope. */ }
          if (parsed?.ruyiEncryptedBackupV1 === 1) {
            await serial(async () => {
              const state = await stateRead(), key = await master(state, false);
              const recordId = 'backup-' + cryptoApi.createHash('sha256').update(name).digest('hex');
              try { core.open(parsed.envelope, key, aad(state, recordId, 'config-backup'), 'master-v1'); } catch { fail('backup_integrity'); }
            });
            continue;
          }
          const protectedCopy = object(parsed) ? await protectConfig(original, { force: true }) : await protectCorrupt(original, name);
          if (protectedCopy !== original) await host.backups.write(name, protectedCopy);
        }
      } catch (error) { if (String(error?.code || '').startsWith('credential_vault.')) throw error; fail('backup_unavailable'); }
    }
    const stateStamp = () => host.stamp ? host.stamp() : Promise.resolve('');
    const sealLocal = (serialized, purpose, recordId) => serial(async () => {
      const state = await stateRead(), fresh = !state.instanceId, key = await master(state, true);
      if (fresh) await stateWrite(state);
      return { version: 1, instanceId: state.instanceId, envelope: core.seal(serialized, key, aad(state, recordId, purpose), 'master-v1') };
    });
    const openLocal = (value, purpose, recordId) => serial(async () => {
      const state = await stateRead(), key = await master(state, false);
      if (!value || value.version !== 1 || value.instanceId !== state.instanceId) fail('binding_mismatch');
      try { return core.open(value.envelope, key, aad(state, recordId, purpose), 'master-v1'); } catch { fail('decrypt_failed'); }
    });
    // Positions only (never values): the settings page names which credentials need re-entry.
    const credentialWithheld = () => shownWithheld(withheldMemory);
    return Object.freeze({ protectConfig, protectBackup, protectCorrupt, hydrateConfig, migrateBackups, exportBackup, prepareImport, stateStamp, sealLocal, openLocal, snapshotForWorkDataRecovery, stageRecoveredForWorkData, clear, credentialWithheld });
  }
  return Object.freeze({ create, validate, empty, MAX });
})(require('node:crypto'));

Object.assign(PrivacyCore.configHooks, CredentialVault.create({
  core: PrivacyCore, protector: LocalSecretCrypto,
  store: DurableJsonStore.create({ id: 'credential-vault-v1', file: () => path.join(paths.data, 'credential-vault-v1.json'), schemaVersion: 1,
    defaultValue: CredentialVault.empty, cache: false, strictRead: true, quarantine: false, validate: CredentialVault.validate }),
  size: async () => { try { return (await fsp.stat(path.join(paths.data, 'credential-vault-v1.json'))).size; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } },
  stamp: async () => {
    try { const stat = await fsp.stat(path.join(paths.data, 'credential-vault-v1.json'), { bigint: true }); return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`; }
    catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  },
  backups: {
    list: async () => (await fsp.readdir(paths.data)).filter(name => /^config\.json\.(?:prev|corrupt|bak[^/\\]*)$/.test(name)),
    read: async name => {
      const file = path.join(paths.data, name), stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CredentialVault.MAX.bytes) throw new Error('backup unavailable');
      return fsp.readFile(file, 'utf8');
    },
    write: (name, serialized) => atomicWriteJson(path.join(paths.data, name), serialized, { mode: 0o600 }),
  },
}));
