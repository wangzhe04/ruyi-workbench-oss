// M3-2: managed record store for the work-data families frozen in
// docs/optimization-plan/93-m3-1-encrypted-storage-freeze.md.
//
// One whole-record JSON file per family record. With work-data encryption disabled (the default)
// it writes exactly the object the previous DurableJsonStore/atomicWriteJson path wrote, so the
// bytes on disk do not change. With it enabled it writes the WorkDataCrypto v2 container, and a
// container that cannot be authenticated (wrong purpose/instance/schema/scope/record, missing or
// unavailable key) throws — it never degrades to an empty record or to plaintext.
const WorkDataStore = ((fsp, pathModule) => {
  // Late-binding hook (the `*Hooks` pattern from CLAUDE.md): modules loading after 02-session-store need
  // the process-wide key set, but a static reference would pull them into the dependency cycle. 02 fills
  // this at load time; consumers must treat a missing value as "not initialised yet".
  const Hooks = {};
  const CONTAINER = 2;      // outer file version; inner envelope version comes from WorkDataCrypto
  const fail = suffix => {
    const error = new Error('work_data_store.' + suffix);
    error.code = 'work_data_store.' + suffix;
    error.apiCode = error.code;
    error.statusCode = suffix === 'shape' || suffix === 'schema' || suffix === 'sanitize' || suffix === 'validate' ? 400 : 503;
    throw error;
  };
  // Hooks must be filled by 02 before any family store writes; a missing value is a boot-order bug,
  // not a TypeError deep inside a write.
  const requireKeys = () => {
    const keys = Hooks.keys;
    if (!keys || typeof keys.unlock !== 'function' || typeof keys.instance !== 'function') fail('not_initialised');
    return keys;
  };
  // A host may pass its own key set (tests, and the stores 02 owns); everyone else goes through the
  // late-binding hook so a family can live outside the dependency cycle.
  const keysFor = host => ((host && host.keys && typeof host.keys.unlock === 'function') ? host.keys : requireKeys());
  // The switch itself may be unreadable; that is "unknown", never "off" — a plaintext rewrite of a
  // sealed record is the one outcome the frozen contract forbids without an explicit migration.
  const sealing = async host => {
    let enabled;
    try { enabled = await host.enabled(); } catch { fail('switch_unavailable'); }
    return enabled === true;
  };
  const guardWrite = async (host, target) => {
    // mkdir first: atomicWriteJson does not create directories (the old DurableJsonStore write chain did).
    await fsp.mkdir(pathModule.dirname(target), { recursive: true }).catch(() => {});
    if (await sealing(host)) return;
    let head = '';
    try { head = (await fsp.readFile(target, 'utf8')).slice(0, 4096); }
    catch (error) { if (error && error.code !== 'ENOENT') fail('storage_unavailable'); return; }
    if (/"workData"\s*:\s*2/.test(head)) fail('downgrade_refused');   // sealed on disk, switch off: refuse
  };
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
    let corruptLogged = false;
    const corrupt = async error => {
      // quarantine:true mirrors DurableJsonStore's default (keep a .corrupt copy for forensics);
      // quarantine:false leaves the file untouched so the next write replaces it. The copy is
      // size-aware because a cacheless store can hit the same bad file several times in one request.
      if (host.quarantine === true) {
        try {
          const target = file(), copy = target + '.corrupt';
          const [stat, prev] = await Promise.all([fsp.stat(target), fsp.stat(copy).catch(() => null)]);
          if (!prev || prev.size !== stat.size) await fsp.copyFile(target, copy);
        } catch { /* best effort */ }
      }
      if (!corruptLogged) { corruptLogged = true; try { if (host.onCorrupt) host.onCorrupt(error); } catch { /* diagnostics never block */ } }
      return fallback();
    };
    async function decrypt(parsed, budget) {
      const { workData, ...container } = parsed;
      if (workData !== CONTAINER) fail('corrupt');
      const key = await keysFor(host).unlock();   // disabled/absent/unavailable are hard failures, not empty data
      const plaintext = WorkDataCrypto.open(container, key, {
        purpose: host.purpose, instanceId: container.instanceId, schema: host.schema, scopeId: host.scopeId,
        recordId: host.recordId, seq: container.seq, generation: generationOf(container.keyId),
      });
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > budget) fail('corrupt');
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
      const target = file();
      await guardWrite(host, target);
      if (!(await sealing(host))) { await host.writeJson(target, prepared); return prepared; }
      // Enabled: never create a key here. Key creation belongs to the explicit enable flow (M3-3).
      const plaintext = JSON.stringify(prepared);
      if (Buffer.byteLength(plaintext, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('shape');
      const key = await keysFor(host).unlock();
      const instanceId = await keysFor(host).instance();
      const container = WorkDataCrypto.seal(plaintext, key, {
        purpose: host.purpose, instanceId, schema: host.schema, scopeId: host.scopeId, recordId: host.recordId, seq: 1,
      });
      await host.writeJson(target, { workData: CONTAINER, ...container });
      return prepared;
    }
    return Object.freeze({ read, write, filePath: file });
  }
  // Whole-record TEXT variant (session head): the caller owns the serialization, so the plaintext
  // path can keep writing byte-identical JSON while the enabled path seals the same bytes.
  function createText(host) {
    const file = () => String(host.file());
    // schema 是 01n 的必填绑定项；族没显式给时用 record 格式版本（与 createJson 同口径）。
    const schema = Number.isFinite(host.schema) ? host.schema : 1;
    const bindingOf = container => ({
      purpose: host.purpose, instanceId: container.instanceId, schema, scopeId: host.scopeId,
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
      const key = await keysFor(host).unlock();
      // instanceId from the key set (not from the container) so the binding is a real check; seq stays
      // the container's own value until M3-3 pins revisions with an external anchor.
      const plaintext = WorkDataCrypto.open(container, key, { ...bindingOf(container), instanceId: await host.keys.instance() });
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('corrupt');
      return plaintext;
    }
    async function write(plainText) {   // not 	ext: that identifier collides with 00-boot's symbol
      if (typeof plainText !== 'string') fail('shape');
      const target = file();
      await guardWrite(host, target);
      // The size cap belongs to the sealed path only: the old plaintext writer had no limit, so a
      // >1 MiB head must keep saving while encryption is off (the read side refuses it when sealed).
      if (!(await sealing(host))) { await host.writeJson(target, plainText); return plainText; }
      if (Buffer.byteLength(plainText, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('shape');
      const key = await keysFor(host).unlock();
      const instanceId = await keysFor(host).instance();
      const container = WorkDataCrypto.seal(plainText, key, { purpose: host.purpose, instanceId, schema,
        scopeId: host.scopeId, recordId: host.recordId, seq: 1 });
      await host.writeJson(target, { workData: CONTAINER, ...container });
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
  return Object.freeze({ create, createJson, createText, CONTAINER, Hooks, requireKeys });
})(require('node:fs/promises'), require('node:path'));
