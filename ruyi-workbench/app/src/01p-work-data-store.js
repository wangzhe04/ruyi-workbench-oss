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
  const keyApi = keys => !!keys && (typeof keys.snapshot === 'function' || typeof keys.unlock === 'function' && typeof keys.instance === 'function');
  const requireKeys = () => {
    const keys = Hooks.keys;
    if (!keyApi(keys)) fail('not_initialised');
    return keys;
  };
  // A host may pass its own key set (tests, and the stores 02 owns); everyone else goes through the
  // late-binding hook so a family can live outside the dependency cycle.
  const keysFor = host => (host && keyApi(host.keys) ? host.keys : requireKeys());
  const ownedSnapshot = (key, instanceId, releaseSource) => {
    if (!Buffer.isBuffer(key) || key.length !== 32 || typeof instanceId !== 'string' || !instanceId) fail('key_snapshot', 503);
    const owned = Buffer.from(key); let released = false;
    return Object.freeze({ key: owned, instanceId, release: async () => {
      if (released) return;
      released=true;const errors=[];let releaseFailed=false;
      try{owned.fill(0);}catch(cause){errors.push(cause);}
      try{if(releaseSource)await releaseSource();}catch(cause){releaseFailed=true;errors.push(cause);}
      // A sole cleanup rejection keeps its original identity (including falsy values);
      // only multiple/ambiguous failures need the aggregating uncertainty carrier.
      if(errors.length===1)throw errors[0];
      if(errors.length)throw capturedCleanupFailure('work_data_store.snapshot_release',undefined,false,errors,releaseFailed);
    } });
  };
  const acquireSnapshot = async (keys = requireKeys()) => {
    if (!keyApi(keys)) fail('not_initialised');
    if (typeof keys.snapshot === 'function') {
      const source = await keys.snapshot();
      try {
        if (!source || typeof source.release !== 'function') fail('key_snapshot', 503);
        return ownedSnapshot(source.key, source.instanceId, () => source.release());
      } catch (error) {
        let cleanupFailed = false, cleanupFailure;
        try { if (typeof source?.release === 'function') await source.release(); }
        catch (cause) { cleanupFailed = true; cleanupFailure = cause; }
        if (cleanupFailed) {
          throw capturedCleanupFailure('work_data_store.key_snapshot',error,true,[cleanupFailure],true);
        }
        throw error;
      }
    }
    const unlocked = await keys.unlock();
    if (!Buffer.isBuffer(unlocked) || unlocked.length !== 32) fail('key_snapshot', 503);
    // Legacy custom providers are supported, but never retain their shared Buffer across an await.
    const copy = Buffer.from(unlocked);
    try { return ownedSnapshot(copy, await keys.instance()); }
    finally { copy.fill(0); }
  };
  const withOperation = async (host, work, ownedResult = false) => {
    let pending = null, result, failed = false, cleanupFailed = false, failure, cleanupFailure;
    const operation = { credential: () => pending || (pending = acquireSnapshot(keysFor(host))) };
    try { result = await work(operation); } catch (error) { failed = true; failure = error; }
    let lease;
    try { if (pending) lease = await pending; } catch (error) { if (!failed) { failed = true; failure = error; } }
    try { if (lease) await lease.release(); } catch (error) { cleanupFailed = true; cleanupFailure = error; }
    if (failed || cleanupFailed) {
      const resultCleanup=[];try{if(ownedResult&&Buffer.isBuffer(result))result.fill(0);}catch(cause){resultCleanup.push(cause);}
      if(cleanupFailed||resultCleanup.length)throw capturedCleanupFailure('work_data_store.snapshot_release',failure,failed,[...(cleanupFailed?[cleanupFailure]:[]),...resultCleanup],cleanupFailed);
      throw failure;
    }
    return result;
  };
  // The switch itself may be unreadable; that is "unknown", never "off" — a plaintext rewrite of a
  // sealed record is the one outcome the frozen contract forbids without an explicit migration.
  const sealing = async host => {
    let enabled;
    try { enabled = await host.enabled(); } catch { fail('switch_unavailable'); }
    return enabled === true;
  };
  // workData is a reserved container marker. A truncated container must not enter the legacy
  // "bad plaintext means empty" path, which would let a subsequent mutation erase ciphertext.
  // Match the reserved JSON key token itself, including per-character unicode escapes.
  // Do not decode the entire document: escaped quotation marks inside ordinary text
  // must not turn a JSON string example into a container header.
  const containerMarker = rawText => /"(?:w|\\u0077)(?:o|\\u006[fF])(?:r|\\u0072)(?:k|\\u006[bB])(?:D|\\u0044)(?:a|\\u0061)(?:t|\\u0074)(?:a|\\u0061)"\s*:/.test(rawText);
  // Opt-in Markdown may legitimately discuss the reserved JSON key in its body. An object,
  // array or quoted JSON-looking prefix retains the existing fail-closed container classifier.
  const markdownPlaintext = (host, rawText) => host.legacyText === 'markdown' && !/^[\s\ufeff]*[\{\["]/.test(rawText);
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
        let end = chunk.length;
        // A trailing-whitespace regex retries from every leading space when the buffer
        // ends in a key fragment. Trim backwards once instead of quadratic backtracking.
        while (end > 0 && [32, 9, 13, 10].includes(chunk.charCodeAt(end - 1))) end--;
        carry = chunk.slice(Math.max(0, end - 80), end);
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
  function capturedCleanupFailure(code,primary,failed,errors,releaseFailed=false) {
    const unknown=value=>{
      if(value===null||!['object','function'].includes(typeof value))return false;
      const seen=new Set();try{for(let depth=0;value!==null&&depth<8;depth++){
        if(seen.has(value))return true;seen.add(value);const flag=Object.getOwnPropertyDescriptor(value,'helperMayStillRun');
        if(flag)return !Object.hasOwn(flag,'value')||flag.value===true;value=Object.getPrototypeOf(value);
      }return value!==null;}catch{return true;}
    };
    const causes=[...(failed?[primary]:[]),...errors];
    // Error metadata is optional data, never a reason to execute a foreign getter.
    try{const descriptor=primary!=null?Object.getOwnPropertyDescriptor(Object(primary),'code'):null;if(descriptor&&Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(descriptor.value))code=descriptor.value;}catch{}
    return Object.assign(new AggregateError(causes,code,{cause:causes[0]}),{code,apiCode:code,statusCode:503,
      cleanupFailed:true,ownershipRetained:true,helperMayStillRun:releaseFailed||causes.some(unknown)});
  }
  // Captured reads consume only opaque files issued by the preserved tree.
  // The immutable late bridge validates ownership and the complete source proof;
  // a host cannot replace those checks with a JSON flag or a byte Buffer.
  const capturedMode = host => Object.hasOwn(host, 'capturedFile');
  // Keep the source grant through asynchronous key cleanup as well. The
  // ordinary operation path remains unchanged; a failed captured binary never
  // leaves its decoded Buffer alive merely because key release failed later.
  async function capturedOperation(host, work) { return withOperation(host, work, true); }
  async function withCapturedFile(host, target, work) {
    const bridge = Hooks.capturedFiles;
    if (!bridge || !Object.isFrozen(bridge)
      || ['read', 'verify', 'assert'].some(name => typeof bridge[name] !== 'function')) fail('captured_file_unavailable');
    let token, bytes, result, failed = false, failure;
    const assert = () => { if (bridge.assert(token, target) !== true) fail('captured_file_invalid'); };
    const verify = async () => { if (await bridge.verify(token, target) !== true) fail('captured_file_invalid'); assert(); };
    try {
      token = await (typeof host.capturedFile === 'function' ? host.capturedFile() : host.capturedFile);
      if (!token || typeof token !== 'object' || typeof token.release !== 'function') fail('captured_file_invalid');
      bytes = await bridge.read(token, target);
      if (!Buffer.isBuffer(bytes)) fail('captured_file_invalid');
      await verify();
      result = await work(bytes, assert);
      await verify(); assert();
    } catch (error) { failed = true; failure = error; }
    const cleanupErrors=[];let releaseFailed=false;
    try{if(Buffer.isBuffer(bytes))bytes.fill(0);}catch(cause){cleanupErrors.push(cause);}
    try{if(token&&typeof token.release==='function'){const released=token.release();if(released!==undefined){Promise.resolve(released).catch(()=>{});throw new Error('captured_release_unproven');}}}
    catch(cause){releaseFailed=true;cleanupErrors.push(cause);}
    if(failed||cleanupErrors.length){
      try{if(Buffer.isBuffer(result))result.fill(0);}catch(cause){cleanupErrors.push(cause);}
      if(cleanupErrors.length)throw capturedCleanupFailure('work_data_store.captured_cleanup',failure,failed,cleanupErrors,releaseFailed);
      throw failure;
    }
    return result;
  }
  function headerFromPrefix(prefix) {
    const max = 16 * 1024, newline = prefix.indexOf('\n');
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
  }
  const capturedLines = async function* (bytes, maximum, assert) {
    if (bytes.length > WorkDataChunks.maxFileBytes(maximum)) fail('chunk_file_limit');
    let start = 0, first = true;
    for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
      assert(); const line = bytes.subarray(start, end);
      const max = first ? WorkDataChunks.MAX_HEADER_BYTES : WorkDataChunks.MAX_CHUNK_LINE_BYTES;
      if (!line.length || line.length > max) fail('chunk_line_limit');
      const capturedLineText = line.toString('utf8');
      if (!Buffer.from(capturedLineText, 'utf8').equals(line)) fail('corrupt');
      yield capturedLineText; assert(); first = false; start = end + 1;
    }
    if (first || start !== bytes.length) fail('corrupt'); assert();
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
      return headerFromPrefix(buffer.subarray(0, used).toString('utf8'));
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
  const readChunks = async (host, target, header, operation) => {
    const credential = await operation.credential();
    const plainText = await WorkDataChunks.openLines(chunkLines(target, host.maxPlaintextBytes), credential.key, {
      purpose: host.purpose, instanceId: credential.instanceId, schema: Number.isFinite(host.schema) ? host.schema : 1,
      scopeId: host.scopeId, recordId: host.recordId, seq: host.seq === undefined ? 1 : host.seq,
      generation: generationOf(header.keyId),
    }, host.maxPlaintextBytes);
    return validateSealed(host, plainText);
  };
  const guardWrite = async (host, target, operation) => {
    // mkdir first: atomicWriteJson does not create directories (the old DurableJsonStore write chain did).
    await fsp.mkdir(pathModule.dirname(target), { recursive: true }).catch(() => {});
    // One switch snapshot owns both the downgrade guard and this write. Re-reading it after the
    // guard could turn an allowed sealed update into a plaintext overwrite during a toggle.
    const enabled = await sealing(host);
    if (host.binaryLegacy === true) {
      let legacy;
      try { legacy = await readGzipLegacy(host, target, enabled ? host.maxBinaryBytes : Infinity); }
      catch (error) { if (error && error.code === 'ENOENT') return enabled; throw error; }
      if (legacy) {
        // Valid gzip is unambiguously legacy binary. Ordinary malformed legacy
        // gzip could previously be replaced; never search its payload as UTF8.
        validateBinaryLegacy(host, legacy, { sealed: false, enabled }, true);
        return enabled;
      }
    }
    let header;
    try { header = host.chunked === true ? await chunkHeader(target) : null; }
    catch (error) { if (error && error.code === 'ENOENT') return enabled; throw error; }
    if (header) {
      if (!enabled) fail('downgrade_refused');
      if (host.chunked !== true) fail('chunked_unsupported');
      await readChunks(host, target, header, operation); // never replace a missing-key, truncated or tampered old revision
      return enabled;
    }
    let rawText = '';
    try { rawText = await fsp.readFile(target, 'utf8'); }
    catch (error) { if (error && error.code !== 'ENOENT') fail('storage_unavailable'); return enabled; }
    if (markdownPlaintext(host, rawText)) return enabled;
    let parsed;
    try { parsed = JSON.parse(rawText); } catch {
      if (/"workData"\s*:\s*3\b/.test(rawText)) fail(enabled ? 'chunked_unsupported' : 'downgrade_refused');
      if (containerMarker(rawText)) fail('corrupt');
      return enabled;
    }
    if (!enabled && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, 'workData')) fail('downgrade_refused');
    if (enabled && host.chunked === true && parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'workData')) await openTextRecord(host, parsed, operation);
    return enabled;
  };
  const generationOf = keyId => {
    const match = /\.k(\d{1,2})$/.exec(String(keyId || ''));
    const generation = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(generation) || generation < 1) fail('corrupt');
    return generation;
  };
  const openTextRecord = async (host, parsed, operation) => {
    const { workData, ...container } = parsed;
    if (workData !== CONTAINER) fail(workData === 3 ? 'chunked_unsupported' : 'corrupt');
    const credential = await operation.credential();
    const plainText = WorkDataCrypto.open(container, credential.key, { purpose: host.purpose, instanceId: credential.instanceId,
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
    async function decrypt(parsed, budget, operation) {
      const { workData, ...container } = parsed;
      if (workData !== CONTAINER) fail('corrupt');
      const credential = await operation.credential(); // key and instance share this complete operation
      const plaintext = WorkDataCrypto.open(container, credential.key, {
        purpose: host.purpose, instanceId: credential.instanceId, schema: host.schema, scopeId: host.scopeId,
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
    async function readWithin(operation) {
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
      if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'workData')) return decrypt(parsed, WorkDataCrypto.MAX_PLAINTEXT, operation);
      // Legacy plaintext record: keep the previous "bad shape means empty plus a diagnostic" contract.
      try { return prepare(parsed); } catch (error) { return await corrupt(error); }
    }
    async function writeWithin(value, operation) {
      const prepared = prepare(value);
      const target = file();
      const enabled = await guardWrite(host, target, operation);
      if (typeof host.validateSealedValue === 'function') await readWithin(operation);
      if (!enabled) { await host.writeJson(target, prepared); return prepared; }
      // Enabled: never create a key here. Key creation belongs to the explicit enable flow (M3-3).
      const plaintext = JSON.stringify(prepared);
      if (Buffer.byteLength(plaintext, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('shape');
      const credential = await operation.credential();
      const container = WorkDataCrypto.seal(plaintext, credential.key, {
        purpose: host.purpose, instanceId: credential.instanceId, schema: host.schema, scopeId: host.scopeId, recordId: host.recordId, seq: 1,
      });
      await host.writeJson(target, { workData: CONTAINER, ...container });
      return prepared;
    }
    const read = () => withOperation(host, readWithin);
    const write = value => withOperation(host, operation => writeWithin(value, operation));
    return Object.freeze({ read, write, filePath: file });
  }
  // Whole-record TEXT variant (session head): the caller owns the serialization, so the plaintext
  // path can keep writing byte-identical JSON while the enabled path seals the same bytes.
  async function textValue(host, rawText, operation) {
      if (markdownPlaintext(host, rawText)) return rawText;
      let parsed;
      try { parsed = JSON.parse(rawText); } catch {
        if (/"workData"\s*:\s*3\b/.test(rawText)) fail('chunked_unsupported');
        if (containerMarker(rawText)) fail('corrupt');
        return rawText;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'workData')) return rawText;
      // instanceId from the key set (not from the container) so the binding is a real check; seq stays
      // the container's own value until M3-3 pins revisions with an external anchor.
      return openTextRecord(host, parsed, operation);
  }
  async function readCapturedText(host, bytes, operation, assert) {
    assert();
    const header = host.chunked === true ? headerFromPrefix(bytes.subarray(0, 16 * 1024 + 1).toString('utf8')) : null;
    if (header) {
      const credential = await operation.credential(); assert();
      const plainText = await WorkDataChunks.openLines(capturedLines(bytes, host.maxPlaintextBytes, assert), credential.key, {
        purpose: host.purpose, instanceId: credential.instanceId, schema: Number.isFinite(host.schema) ? host.schema : 1,
        scopeId: host.scopeId, recordId: host.recordId, seq: host.seq === undefined ? 1 : host.seq,
        generation: generationOf(header.keyId),
      }, host.maxPlaintextBytes);
      assert(); return validateSealed(host, plainText);
    }
    const guardedOperation = { credential: async () => { const credential = await operation.credential(); assert(); return credential; } };
    const value = await textValue(host, bytes.toString('utf8'), guardedOperation); assert(); return value;
  }
  function createText(host) {
    const file = () => String(host.file());
    if (host.chunked === true) WorkDataChunks.limitOf(host.maxPlaintextBytes);
    // schema 是 01n 的必填绑定项；族没显式给时用 record 格式版本（与 createJson 同口径）。
    const schema = Number.isFinite(host.schema) ? host.schema : 1;
    async function readWithin(operation) {
      // ENOENT propagates on purpose: the resilient session-head readers retry on it and must keep
      // doing so; callers that treat a missing record as empty catch it themselves.
      const header = host.chunked === true ? await chunkHeader(file()) : null;
      if (header) {
        if (host.chunked !== true) fail('chunked_unsupported');
        return readChunks(host, file(), header, operation);
      }
      const rawText = await fsp.readFile(file(), 'utf8');
      return textValue(host, rawText, operation);
    }
    async function writeWithin(plainText, operation) {   // not 	ext: that identifier collides with 00-boot's symbol
      if (capturedMode(host)) fail('captured_read_only');
      if (typeof plainText !== 'string') fail('shape');
      const target = file();
      const enabled = await guardWrite(host, target, operation);
      // The size cap belongs to the sealed path only: the old plaintext writer had no limit, so a
      // >1 MiB head must keep saving while encryption is off (the read side refuses it when sealed).
      if (!enabled) { await host.writeJson(target, plainText); return plainText; }
      if (host.chunked === true) {
        const credential = await operation.credential();
        const factory = WorkDataChunks.sealFactory(plainText, credential.key, { purpose: host.purpose,
          instanceId: credential.instanceId, schema, scopeId: host.scopeId, recordId: host.recordId,
          seq: host.seq === undefined ? 1 : host.seq }, host.maxPlaintextBytes);
        try { await host.writeJson(target, factory, { stream: true }); }
        finally { factory.dispose(); }
        return plainText;
      }
      if (Buffer.byteLength(plainText, 'utf8') > WorkDataCrypto.MAX_PLAINTEXT) fail('shape');
      const credential = await operation.credential();
      const container = WorkDataCrypto.seal(plainText, credential.key, { purpose: host.purpose, instanceId: credential.instanceId, schema,
        scopeId: host.scopeId, recordId: host.recordId, seq: 1 });
      await host.writeJson(target, { workData: CONTAINER, ...container });
      return plainText;
    }
    const read = () => capturedMode(host)
      ? withCapturedFile(host, file(), (bytes, assert) => capturedOperation(host, operation => readCapturedText(host, bytes, operation, assert)))
      : withOperation(host, readWithin);
    const write = plainText => withOperation(host, operation => writeWithin(plainText, operation));
    return Object.freeze({ read, write, filePath: file });
  }
  // DurableJsonStore-compatible whole-file JSON store (M3-2d). Same prepare pipeline as
  // DurableJsonStore (shape → schema → sanitize → schema stamp → capacity → validate), so a family
  // can be moved onto the envelope without changing what counts as a valid record. capacity is applied
  // locally to keep this module out of the 01-config cycle.
const gzipMagic = bytes => bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8;
// Used only after gzip decoding failed. Complete valid gzip is never searched
// for JSON markers inside its compressed payload. Carry escaped key characters
// across chunks so a damaged prefixed container cannot disguise workData.
function damagedBinaryMarker(bytes) {
  let carry = '';
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    const raw = carry + bytes.subarray(offset, offset + 64 * 1024).toString('latin1');
    const decoded = raw.replace(/\\u([a-fA-F0-9]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
    if (containerMarker(decoded)) return true;
    carry = raw.replace(/[ \t\r\n]+$/, '').slice(-80);
  }
  return false;
}
function validateBinaryLegacy(host, bytes, context, replaceMalformed = false) {
  try {
    if (host.validateLegacyBinary(bytes, context) !== true) throw new Error('invalid gzip');
  } catch (error) {
    if (String(error && error.code || '').startsWith('work_data')) throw error;
    if (error && error.code === 'ERR_BUFFER_TOO_LARGE') fail('binary_decode_limit');
    if (!(error && error.gzipValidated === true) && damagedBinaryMarker(bytes)) fail('corrupt');
    if (!replaceMalformed) throw error;
  }
}
async function readGzipLegacy(host, target, legacyCap = Infinity) {
  const handle = await fsp.open(target, 'r');
  try {
    const prefix = Buffer.alloc(3);
    let prefixUsed = 0;
    while (prefixUsed < prefix.length) {
      const read = await handle.read(prefix, prefixUsed, prefix.length - prefixUsed, prefixUsed);
      if (!read.bytesRead) break;
      prefixUsed += read.bytesRead;
    }
    const legacy = prefixUsed === 3 && gzipMagic(prefix);
    const stat = await handle.stat();
    const cap = legacy ? legacyCap : WorkDataChunks.maxFileBytes(host.maxPlaintextBytes);
    if (stat.size > cap) fail('binary_file_limit');
    if (!legacy) return null;
    // Bounded allocation and complete read from one descriptor. A concurrent
    // growth cannot make readFile allocate outside the host engineering cap.
    const bytes = Buffer.alloc(stat.size); let used = 0;
    while (used < bytes.length) {
      const next = await handle.read(bytes, used, Math.min(64 * 1024, bytes.length - used), used);
      if (!next.bytesRead) break;
      used += next.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, used);
    if (extra.bytesRead) fail('binary_changed');
    return bytes.subarray(0, used);
  } finally { await handle.close(); }
}
function createBinary(host) {
  if (typeof host.validateLegacyBinary !== 'function') fail('binary_codec');
  if (host.chunked !== true) fail('chunked_unsupported');
  if (!Number.isSafeInteger(host.maxBinaryBytes) || host.maxBinaryBytes < 1
      || host.maxBinaryBytes > WorkDataChunks.MAX_PLAINTEXT_BYTES) fail('binary_file_limit');
  WorkDataChunks.limitOf(host.maxPlaintextBytes);
  const file = () => String(host.file());
  const decode = plainText => {
    let value;
    try { value = JSON.parse(plainText); } catch { fail('binary_shape'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'data,encoding'
        || value.encoding !== 'gzip-base64-v1' || typeof value.data !== 'string'
        || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) fail('binary_shape');
    const bytes = Buffer.from(value.data, 'base64');
    try {
    if (bytes.length > host.maxBinaryBytes || bytes.toString('base64') !== value.data || !gzipMagic(bytes)) fail('binary_shape');
    try { if (host.validateLegacyBinary(bytes, { sealed: true, enabled: true }) !== true) fail('binary_shape'); }
    catch (error) { if (String(error?.code || '').startsWith('work_data')) throw error; fail('binary_shape'); }
    return bytes;
    } catch (error) { bytes.fill(0); throw error; }
  };
  const validateSealedText = plainText => { decode(plainText); return true; };
  const borrowedKeys = operation => ({
    snapshot: async () => {
      const lease = await operation.credential();
      return { key: lease.key, instanceId: lease.instanceId, release: () => {} };
    },
    // Existing requireKeys compatibility checks these functions. createText's
    // B acquireSnapshot will prefer snapshot and never mix these two snapshots.
    unlock: async () => (await operation.credential()).key,
    instance: async () => (await operation.credential()).instanceId,
  });
  async function read() {
    const consume = async (operation, captured, assert) => {
        let legacy;
        if (captured) {
          assert();
          if (gzipMagic(captured)) legacy = Buffer.from(captured);
          else if (captured.length > WorkDataChunks.maxFileBytes(host.maxPlaintextBytes)) fail('binary_file_limit');
        } else legacy = await readGzipLegacy(host, file());
        if (legacy) {
          try { validateBinaryLegacy(host, legacy, { sealed: false, enabled: false }); if (assert) assert(); return legacy; }
          catch (error) { if (captured) legacy.fill(0); throw error; }
        }
        let validated;
        const validateRead = plainText => { validated = { plainText, bytes: decode(plainText) }; return true; };
        const textHost = { ...host, keys: borrowedKeys(operation), validateSealedText: validateRead };
        try {
          const plainText = captured ? await readCapturedText(textHost, captured, operation, assert) : await createText(textHost).read();
          if (!validated) {
            host.validateLegacyBinary(Buffer.alloc(0), { sealed: false, enabled: false });
            throw new Error('invalid gzip');
          }
          return validated.plainText === plainText ? validated.bytes : decode(plainText);
        } catch (error) { if (captured && validated) validated.bytes.fill(0); throw error; }
    };
    return capturedMode(host)
      ? withCapturedFile(host, file(), (bytes, assert) => capturedOperation(host, operation => consume(operation, bytes, assert)))
      : withOperation(host, operation => consume(operation, null, null), true);
  }
  async function write(bytes) {
    if (capturedMode(host)) fail('captured_read_only');
    if (!Buffer.isBuffer(bytes) || !gzipMagic(bytes)) fail('binary_shape');
    return withOperation(host, async operation => {
      const target = file();
      const scopedHost = { ...host, binaryLegacy: true, validateSealedText };
      const enabled = await guardWrite(scopedHost, target, operation);
      if (enabled && bytes.length > host.maxBinaryBytes) fail('binary_file_limit');
      if (host.validateLegacyBinary(bytes, { sealed: enabled, enabled }) !== true) fail('binary_shape');
      if (!enabled) {
        // Atomic writer's existing async-iterable path preserves raw Buffer bytes.
        const factory = async function* () { yield bytes; };
        await host.writeJson(target, factory, { stream: true });
        return bytes;
      }
      const plainText = JSON.stringify({ encoding: 'gzip-base64-v1', data: bytes.toString('base64') });
      const lease = await operation.credential();
      const factory = WorkDataChunks.sealFactory(plainText, lease.key, {
        purpose: host.purpose, instanceId: lease.instanceId,
        schema: Number.isFinite(host.schema) ? host.schema : 1,
        scopeId: host.scopeId, recordId: host.recordId,
        seq: host.seq === undefined ? 1 : host.seq,
      }, host.maxPlaintextBytes);
      try { await host.writeJson(target, factory, { stream: true }); }
      finally { factory.dispose(); }
      return bytes;
    });
  }
  return Object.freeze({ read, write, filePath: file });
}

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
  return Object.freeze({ create, createJson, createText, createBinary, CONTAINER, Hooks, requireKeys, acquireSnapshot, hasContainerMarker });
})(require('node:fs/promises'), require('node:path'));
