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
  const fail = (suffix, statusCode) => {
    const error = new Error('work_data_store.' + suffix);
    error.code = 'work_data_store.' + suffix;
    error.apiCode = error.code;
    error.statusCode = statusCode || (suffix === 'shape' || suffix === 'schema' || suffix === 'sanitize' || suffix === 'validate' ? 400 : 503);
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
  // workData is a reserved container marker. A truncated container must not enter the legacy
  // "bad plaintext means empty" path, which would let a subsequent mutation erase ciphertext.
  const containerMarker = rawText => /"workData"\s*:/.test(rawText);
  const hasContainerMarker = async target => {
    const handle = await fsp.open(target, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let carry = '';
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) return false;
        const chunk = carry + buffer.subarray(0, bytesRead).toString('latin1');
        if (containerMarker(chunk)) return true;
        // Keep a split key or a key followed by arbitrarily long JSON whitespace across chunks.
        carry = chunk.replace(/[ \t\r\n]+$/, '').slice(-10);
      }
    } finally { await handle.close(); }
  };
  const validateSealed = async (host, plainText) => {
    if (typeof host.validateSealedText === 'function') {
      let valid;
      try { valid = await host.validateSealedText(plainText); }
      catch (error) { if (String(error && error.code || '').startsWith('work_data')) throw error; fail('validate', 503); }
      if (valid !== true) fail('validate', 503);
    }
    return plainText;
  };
  // Probe only the bounded first line. Existing pretty JSON and arbitrary legacy plaintext remain
  // on their original read path; the chunk writer always emits a compact, complete first-line header.
  const chunkHeader = async target => {
    const handle = await fsp.open(target, 'r');
    try {
      const max = 16 * 1024, buffer = Buffer.alloc(max + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
        if (buffer.subarray(0, used).includes(10)) break;
      }
      const prefix = buffer.subarray(0, used).toString('utf8'), newline = prefix.indexOf('\n');
      const first = newline < 0 ? prefix : prefix.slice(0, newline);
      if (Buffer.byteLength(first, 'utf8') > max) {
        if (/"workData"\s*:\s*3\b/.test(first)) fail('chunk_header_limit');
        return null;
      }
      let parsed;
      try { parsed = JSON.parse(first); } catch {
        if (/"workData"\s*:\s*3\b/.test(first)) fail('corrupt');
        return null;
      }
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.workData === 3 ? parsed : null;
    } finally { await handle.close(); }
  };
  const chunkLines = async function* (target, maxPlaintextBytes) {
    const handle = await fsp.open(target, 'r');
    try {
      const maxFile = WorkDataChunks.maxFileBytes(maxPlaintextBytes);
      if ((await handle.stat()).size > maxFile) fail('chunk_file_limit');
      const buffer = Buffer.alloc(64 * 1024);
      let carry = Buffer.alloc(0), total = 0, first = true;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maxFile) fail('chunk_file_limit');
        const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
        let start = 0;
        for (let end = data.indexOf(10, start); end >= 0; end = data.indexOf(10, start)) {
          const line = data.subarray(start, end), maxLine = first ? WorkDataChunks.MAX_HEADER_BYTES : WorkDataChunks.MAX_CHUNK_LINE_BYTES;
          if (!line.length || line.length > maxLine) fail('chunk_line_limit');
          const chunkLineText = line.toString('utf8');
          if (!Buffer.from(chunkLineText, 'utf8').equals(line)) fail('corrupt');
          yield chunkLineText;
          first = false; start = end + 1;
        }
        carry = Buffer.from(data.subarray(start));
        if (carry.length > (first ? WorkDataChunks.MAX_HEADER_BYTES : WorkDataChunks.MAX_CHUNK_LINE_BYTES)) fail('chunk_line_limit');
      }
      // Every encoded line, including the last, has exactly one LF. Missing LF is a torn write;
      // an additional LF was already rejected as an empty line above.
      if (carry.length || first) fail('corrupt');
    } finally { await handle.close(); }
  };
  const readChunks = async (host, target, header) => {
    const keys = keysFor(host), key = await keys.unlock();
    const plainText = await WorkDataChunks.openLines(chunkLines(target, host.maxPlaintextBytes), key, {
      purpose: host.purpose, instanceId: await keys.instance(), schema: Number.isFinite(host.schema) ? host.schema : 1,
      scopeId: host.scopeId, recordId: host.recordId, seq: host.seq === undefined ? 1 : host.seq,
      generation: generationOf(header.keyId),
    }, host.maxPlaintextBytes);
    return validateSealed(host, plainText);
  };
  const guardWrite = async (host, target) => {
    // mkdir first: atomicWriteJson does not create directories (the old DurableJsonStore write chain did).
    await fsp.mkdir(pathModule.dirname(target), { recursive: true }).catch(() => {});
    // One switch snapshot owns both the downgrade guard and this write. Re-reading it after the
    // guard could turn an allowed sealed update into a plaintext overwrite during a toggle.
    const enabled = await sealing(host);
    let header;
    try { header = host.chunked === true ? await chunkHeader(target) : null; }
    catch (error) { if (error && error.code === 'ENOENT') return enabled; throw error; }
    if (header) {
      if (!enabled) fail('downgrade_refused');
      if (host.chunked !== true) fail('chunked_unsupported');
      await readChunks(host, target, header); // never replace a missing-key, truncated or tampered old revision
      return enabled;
    }
    let rawText = '';
    try { rawText = await fsp.readFile(target, 'utf8'); }
    catch (error) { if (error && error.code !== 'ENOENT') fail('storage_unavailable'); return enabled; }
    let parsed;
    try { parsed = JSON.parse(rawText); } catch {
      if (/"workData"\s*:\s*3\b/.test(rawText)) fail(enabled ? 'chunked_unsupported' : 'downgrade_refused');
      if (containerMarker(rawText)) fail('corrupt');
      return enabled;
    }
    if (!enabled && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'workData')) fail('downgrade_refused');
    if (enabled && host.chunked === true && parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'workData')) await openTextRecord(host, parsed);
    return enabled;
  };
  const generationOf = keyId => {
    const match = /\.k(\d{1,2})$/.exec(String(keyId || ''));
    const generation = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(generation) || generation < 1) fail('corrupt');
    return generation;
  };
  const openTextRecord = async (host, parsed) => {
    const { workData, ...container } = parsed;
    if (workData !== CONTAINER) fail(workData === 3 ? 'chunked_unsupported' : 'corrupt');
    const keys = keysFor(host), key = await keys.unlock();
    const plainText = WorkDataCrypto.open(container, key, { purpose: host.purpose, instanceId: await keys.instance(),
      schema: Number.isFinite(host.schema) ? host.schema : 1, scopeId: host.scopeId, recordId: host.recordId,
      seq: container.seq, generation: generationOf(container.keyId) });
    if (typeof plainText !== 'string' || Buffer.byteLength(plainText, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('corrupt');
    return validateSealed(host, plainText);
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
        purpose: host.purpose, instanceId: await keysFor(host).instance(), schema: host.schema, scopeId: host.scopeId,
        recordId: host.recordId, seq: container.seq, generation: generationOf(container.keyId),
      });
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > budget) fail('corrupt');
      let value;
      try { value = JSON.parse(plaintext); } catch { fail('corrupt'); }
      if (typeof host.validateSealedValue === 'function') {
        let valid;
        try { valid = await host.validateSealedValue(value); }
        catch (error) { if (String(error && error.code || '').startsWith('work_data')) throw error; fail('validate', 503); }
        if (valid !== true) fail('validate', 503);
      }
      return prepare(value);
    }
    async function read() {
      const target = file();
      let rawText;
      try { rawText = await fsp.readFile(target, 'utf8'); }
      catch (error) { if (error && error.code === 'ENOENT') return fallback(); throw error; }
      let parsed;
      try { parsed = JSON.parse(rawText); } catch (error) {
        if (/"workData"\s*:\s*3\b/.test(rawText)) fail('chunked_unsupported');
        if (containerMarker(rawText)) fail('corrupt');
        return await corrupt(error);   // legacy "invalid means empty" contract for plaintext only
      }
      if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'workData')) return decrypt(parsed, WorkDataCrypto.MAX_PLAINTEXT);
      // Legacy plaintext record: keep the previous "bad shape means empty plus a diagnostic" contract.
      try { return prepare(parsed); } catch (error) { return await corrupt(error); }
    }
    async function write(value) {
      const prepared = prepare(value);
      const target = file();
      const enabled = await guardWrite(host, target);
      if (typeof host.validateSealedValue === 'function') await read();
      if (!enabled) { await host.writeJson(target, prepared); return prepared; }
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
    if (host.chunked === true) WorkDataChunks.limitOf(host.maxPlaintextBytes);
    // schema 是 01n 的必填绑定项；族没显式给时用 record 格式版本（与 createJson 同口径）。
    const schema = Number.isFinite(host.schema) ? host.schema : 1;
    async function read() {
      // ENOENT propagates on purpose: the resilient session-head readers retry on it and must keep
      // doing so; callers that treat a missing record as empty catch it themselves.
      const header = host.chunked === true ? await chunkHeader(file()) : null;
      if (header) {
        if (host.chunked !== true) fail('chunked_unsupported');
        return readChunks(host, file(), header);
      }
      const rawText = await fsp.readFile(file(), 'utf8');
      let parsed;
      try { parsed = JSON.parse(rawText); } catch {
        if (/"workData"\s*:\s*3\b/.test(rawText)) fail('chunked_unsupported');
        if (containerMarker(rawText)) fail('corrupt');
        return rawText;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'workData')) return rawText;
      // instanceId from the key set (not from the container) so the binding is a real check; seq stays
      // the container's own value until M3-3 pins revisions with an external anchor.
      return openTextRecord(host, parsed);
    }
    async function write(plainText) {   // not 	ext: that identifier collides with 00-boot's symbol
      if (typeof plainText !== 'string') fail('shape');
      const target = file();
      const enabled = await guardWrite(host, target);
      // The size cap belongs to the sealed path only: the old plaintext writer had no limit, so a
      // >1 MiB head must keep saving while encryption is off (the read side refuses it when sealed).
      if (!enabled) { await host.writeJson(target, plainText); return plainText; }
      if (host.chunked === true) {
        const keys = keysFor(host), key = await keys.unlock();
        const factory = WorkDataChunks.sealFactory(plainText, key, { purpose: host.purpose,
          instanceId: await keys.instance(), schema, scopeId: host.scopeId, recordId: host.recordId,
          seq: host.seq === undefined ? 1 : host.seq }, host.maxPlaintextBytes);
        try { await host.writeJson(target, factory, { stream: true }); }
        finally { factory.dispose(); }
        return plainText;
      }
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
    const validateSealedValue = value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      if (schemaVersion !== null && value[schemaKey] !== schemaVersion) return false;
      return typeof host.validate !== 'function' || host.validate(value) === true;
    };
    const store = create({ ...host, schema: Number.isFinite(host.schema) ? host.schema : (schemaVersion === null ? 1 : schemaVersion),
      prepare, defaultValue: host.defaultValue, validateSealedValue });
    // Async-only: a sealed record needs the unlocked key, which has no synchronous form.
    return Object.freeze({ ...store, readSync: () => fail('sync_unsupported') });
  }
  return Object.freeze({ create, createJson, createText, CONTAINER, Hooks, requireKeys, hasContainerMarker });
})(require('node:fs/promises'), require('node:path'));
