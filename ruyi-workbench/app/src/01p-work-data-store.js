// M3-2: managed record store for the work-data families frozen in
// docs/optimization-plan/93-m3-1-encrypted-storage-freeze.md.
//
// One whole-record JSON file per family record. With work-data encryption disabled (the default)
// it writes exactly the object the previous DurableJsonStore/atomicWriteJson path wrote, so the
// bytes on disk do not change. With it enabled it writes the WorkDataCrypto v2 container, and a
// container that cannot be authenticated (wrong purpose/instance/schema/scope/record, missing or
// unavailable key) throws — it never degrades to an empty record or to plaintext.
const WorkDataStore = ((fsp) => {
  // Late-binding hook (the `*Hooks` pattern from CLAUDE.md): modules loading after 02-session-store need
  // the process-wide key set, but a static reference would pull them into the dependency cycle. 02 fills
  // this at load time; consumers must treat a missing value as "not initialised yet".
  const Hooks = {};
  const CONTAINER = 2;      // outer file version; inner envelope version comes from WorkDataCrypto
  const fail = suffix => { throw Object.assign(new Error('work_data_store.' + suffix), { code: 'work_data_store.' + suffix, apiCode: 'work_data_store.' + suffix }); };
  const generationOf = keyId => {
    const match = /\.k(\d{1,2})$/.exec(String(keyId || ''));
    const generation = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(generation) || generation < 1) fail('corrupt');
    return generation;
  };
  function create(host) {
    // host: { file(), purpose, schema, scopeId, recordId, keys (WorkDataKeys api),
    //         enabled() -> boolean (may be async), prepare(value) -> value, defaultValue() -> value,
    //         onCorrupt?(error) }
    const file = () => String(host.file());
    const prepare = value => {
      const next = host.prepare ? host.prepare(value) : value;
      if (!next || typeof next !== 'object' || Array.isArray(next)) fail('shape');
      return next;
    };
    const fallback = () => prepare(host.defaultValue ? host.defaultValue() : {});
    const corrupt = async error => {
      // quarantine:true mirrors DurableJsonStore's default (keep a .corrupt copy for forensics);
      // quarantine:false leaves the file untouched so the next write replaces it.
      if (host.quarantine === true) { try { await fsp.copyFile(file(), file() + '.corrupt'); } catch { /* best effort */ } }
      try { if (host.onCorrupt) host.onCorrupt(error); } catch { /* diagnostics never block */ }
      return fallback();
    };
    async function decrypt(parsed, budget) {
      const { workData, ...container } = parsed;
      if (workData !== CONTAINER) fail('corrupt');
      const key = await host.keys.unlock();   // disabled/absent/unavailable are hard failures, not empty data
      const plaintext = WorkDataCrypto.open(container, key, {
        purpose: host.purpose, instanceId: container.instanceId, schema: host.schema, scopeId: host.scopeId,
        recordId: host.recordId, seq: container.seq, generation: generationOf(container.keyId),
      });
      if (typeof plaintext !== 'string' || plaintext.length > budget) fail('corrupt');
      let value;
      try { value = JSON.parse(plaintext); } catch { fail('corrupt'); }
      return prepare(value);
    }
    async function read() {
      const target = file();
      let rawText;
      try { rawText = await fsp.readFile(target, 'utf8'); }
      catch (error) { if (error && error.code === 'ENOENT') return fallback(); throw error; }
      let parsed;
      try { parsed = JSON.parse(rawText); } catch (error) { return await corrupt(error); }   // legacy "invalid means empty" contract
      if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'workData')) return decrypt(parsed, WorkDataCrypto.MAX_PLAINTEXT);
      // Legacy plaintext record: keep the previous "bad shape means empty plus a diagnostic" contract.
      try { return prepare(parsed); } catch (error) { return await corrupt(error); }
    }
    async function write(value) {
      const prepared = prepare(value);
      if (!(await host.enabled())) { await host.writeJson(file(), prepared); return prepared; }
      // Enabled: never create a key here. Key creation belongs to the explicit enable flow (M3-3).
      const key = await host.keys.unlock();
      const instanceId = await host.keys.instance();
      const container = WorkDataCrypto.seal(JSON.stringify(prepared), key, {
        purpose: host.purpose, instanceId, schema: host.schema, scopeId: host.scopeId, recordId: host.recordId, seq: 1,
      });
      await host.writeJson(file(), { workData: CONTAINER, ...container });
      return prepared;
    }
    return Object.freeze({ read, write, filePath: file });
  }
  // Whole-record TEXT variant (session head): the caller owns the serialization, so the plaintext
  // path can keep writing byte-identical JSON while the enabled path seals the same bytes.
  function createText(host) {
    const file = () => String(host.file());
    const bindingOf = container => ({
      purpose: host.purpose, instanceId: container.instanceId, schema: host.schema, scopeId: host.scopeId,
      recordId: host.recordId, seq: container.seq, generation: generationOf(container.keyId),
    });
    async function read() {
      // ENOENT propagates on purpose: the resilient session-head readers retry on it and must keep
      // doing so; callers that treat a missing record as empty catch it themselves.
      const rawText = await fsp.readFile(file(), 'utf8');
      let parsed;
      try { parsed = JSON.parse(rawText); } catch { return rawText; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'workData')) return rawText;
      const { workData, ...container } = parsed;
      if (workData !== CONTAINER) fail('corrupt');
      const key = await host.keys.unlock();
      // instanceId from the key set (not from the container) so the binding is a real check; seq stays
      // the container's own value until M3-3 pins revisions with an external anchor.
      const plaintext = WorkDataCrypto.open(container, key, { ...bindingOf(container), instanceId: await host.keys.instance() });
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('corrupt');
      return plaintext;
    }
    async function write(plainText) {   // not 	ext: that identifier collides with 00-boot's symbol
      if (typeof plainText !== 'string') fail('shape');
      // The size cap belongs to the sealed path only: the old plaintext writer had no limit, so a
      // >1 MiB head must keep saving while encryption is off (the read side refuses it when sealed).
      if (!(await host.enabled())) { await host.writeJson(file(), plainText); return plainText; }
      if (Buffer.byteLength(plainText, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('shape');
      const key = await host.keys.unlock();
      const instanceId = await host.keys.instance();
      const container = WorkDataCrypto.seal(plainText, key, { purpose: host.purpose, instanceId, schema: host.schema,
        scopeId: host.scopeId, recordId: host.recordId, seq: 1 });
      await host.writeJson(file(), { workData: CONTAINER, ...container });
      return plainText;
    }
    return Object.freeze({ read, write, filePath: file });
  }
  // DurableJsonStore-compatible whole-file JSON store (M3-2d). Same prepare pipeline as
  // DurableJsonStore (shape → schema → sanitize → schema stamp → capacity → validate), so a family
  // can be moved onto the envelope without changing what counts as a valid record. capacity is applied
  // locally to keep this module out of the 01-config cycle.
  function createJson(host) {
    const schemaKey = String(host.schemaKey || 'schema');
    const schemaVersion = Number.isFinite(host.schemaVersion) ? host.schemaVersion : null;
    const applyCapacity = (value, rules) => {
      for (const rule of Array.isArray(rules) ? rules : []) {
        let target = value;
        for (const key of String((rule && rule.path) || '').split('.').filter(Boolean)) {
          target = target && typeof target === 'object' ? target[key] : null;
        }
        const max = Math.max(0, Math.floor(Number(rule && rule.max) || 0));
        if (!target || !max) continue;
        if (Array.isArray(target) && target.length > max) target.splice(0, target.length - max);
        else if (typeof target === 'object') {
          const keys = Object.keys(target);
          for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete target[key];
        }
      }
      return value;
    };
    const prepare = raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('shape');
      const actual = raw[schemaKey];
      if (schemaVersion !== null && actual !== schemaVersion && (host.strictRead === true || actual !== undefined)) fail('schema');
      let value;
      try { value = JSON.parse(JSON.stringify(raw)); } catch { fail('shape'); }
      if (typeof host.sanitize === 'function') value = host.sanitize(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('sanitize');
      if (schemaVersion !== null) value[schemaKey] = schemaVersion;
      applyCapacity(value, host.capacity);
      if (typeof host.validate === 'function' && host.validate(value) !== true) fail('validate');
      return value;
    };
    const store = create({ ...host, schema: Number.isFinite(host.schema) ? host.schema : (schemaVersion === null ? 1 : schemaVersion), prepare, defaultValue: host.defaultValue });
    // Async-only: a sealed record needs the unlocked key, which has no synchronous form.
    return Object.freeze({ ...store, readSync: () => fail('sync_unsupported') });
  }
  return Object.freeze({ create, createJson, createText, CONTAINER, Hooks });
})(require('node:fs/promises'));
