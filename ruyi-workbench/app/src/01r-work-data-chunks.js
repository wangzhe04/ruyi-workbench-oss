// Opt-in large whole-text format. The file is NDJSON: one authenticated manifest header followed by
// independently authenticated UTF-8 chunks. Pure crypto/iterators only: no filesystem or key creation.
// Existing WorkDataCrypto v2 envelopes and its 1 MiB limit are unchanged.
const WorkDataChunks = ((cryptoApi) => {
  const FORMAT = 3, NAME = 'chunks-v1';
  const CHUNK_BYTES = 512 * 1024;
  // Engineering ceiling, not a business-domain capacity. Every opt-in host must supply its own cap;
  // migration preflight must reject an oversized source before changing authority.
  const MAX_PLAINTEXT_BYTES = 256 * 1024 * 1024;
  const MAX_CHUNKS = Math.ceil(MAX_PLAINTEXT_BYTES / (CHUNK_BYTES - 3));
  const MAX_HEADER_BYTES = 16 * 1024;
  // GCM ciphertext has the same byte count as plaintext; base64 expands to 4*ceil(n/3). The remaining
  // 2048 bytes cover the bounded identity fields, ordinal, nonce/tag and exact v2 envelope keys.
  const MAX_CHUNK_LINE_BYTES = 4 * Math.ceil(CHUNK_BYTES / 3) + 2048;
  const HEADER_KEYS = ['format', 'instanceId', 'keyId', 'manifest', 'purpose', 'recordId', 'revision', 'schema', 'scopeId', 'seq', 'workData'].sort().join(',');
  const MANIFEST_KEYS = ['chunkBytes', 'count', 'format', 'lengths', 'revision', 'sha256', 'totalBytes'].sort().join(',');
  const fail = suffix => { throw Object.assign(new Error('work_data_chunk.' + suffix), {
    code: 'work_data_chunk.' + suffix, apiCode: 'work_data_chunk.' + suffix, statusCode: 503,
  }); };
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
  // Process-wide codec admission, not a domain capacity or an RSS limit. Caller-retained objects,
  // returned strings and garbage awaiting collection are outside this additional work-buffer budget.
  function createAdmission({ budgetBytes, maxActive }) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1 || !Number.isSafeInteger(maxActive) || maxActive < 1) fail('admission_invalid');
    const queue = [];
    let activeBytes = 0, activeCount = 0;
    const drain = () => {
      while (queue.length && activeCount < maxActive) {
        const job = queue[0];
        if (job.bytes > budgetBytes ? activeCount !== 0 : activeBytes + job.bytes > budgetBytes) return;
        queue.shift(); activeBytes += job.bytes; activeCount++;
        let released = false;
        job.resolve(() => {
          if (released) return;
          released = true; activeBytes -= job.bytes; activeCount--; drain();
        });
      }
    };
    const acquire = bytes => {
      if (!integer(bytes) || bytes > MAX_PLAINTEXT_BYTES) fail('admission_invalid');
      return new Promise(resolve => { queue.push({ bytes, resolve }); drain(); });
    };
    const run = async (bytes, work) => {
      const release = await acquire(bytes);
      try { return await work(); } finally { release(); }
    };
    return Object.freeze({ acquire, run, snapshot: () => ({ budgetBytes, maxActive, activeBytes, activeCount, queued: queue.length }) });
  }
  const admission = createAdmission({ budgetBytes: 64 * 1024 * 1024, maxActive: 4 });
  function limitOf(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PLAINTEXT_BYTES) fail('limit_invalid');
    return value;
  }
  function maxFileBytes(value) {
    const cap = limitOf(value), count = Math.ceil(cap / (CHUNK_BYTES - 3));
    return MAX_HEADER_BYTES + 4 * Math.ceil(cap / 3) + count * 2056;
  }
  function contextOf(value) {
    if (!value || !WorkDataCrypto.PURPOSES.includes(value.purpose)
      || !identity(value.instanceId) || !identity(value.scopeId) || !identity(value.recordId)
      || !integer(value.schema) || !integer(value.seq)) fail('binding_invalid');
    const generation = value.generation === undefined ? 1 : value.generation;
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 99) fail('binding_invalid');
    return Object.freeze({ purpose: value.purpose, instanceId: value.instanceId, schema: value.schema,
      scopeId: value.scopeId, recordId: value.recordId, seq: value.seq, generation });
  }
  const digest = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  function bindings(context, revision) {
    const base = digest(JSON.stringify([context.purpose, context.instanceId, context.schema, context.scopeId, context.recordId, context.seq]));
    const prefix = 'chunks:' + base + ':' + revision;
    return ordinal => ({ ...context, recordId: prefix + (ordinal === null ? ':m' : ':c:' + ordinal), seq: ordinal === null ? 0 : ordinal });
  }
  function parseLine(line, maxBytes) {
    if (typeof line !== 'string' || !line || Buffer.byteLength(line, 'utf8') > maxBytes) fail('line_invalid');
    try { return JSON.parse(line); } catch { fail('corrupt'); }
  }
  function encodeLine(value, maxBytes) {
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line, 'utf8') > maxBytes) fail('limit');
    return line + '\n';
  }
  // Capture an immutable string and frozen identity. Each consumption creates fresh buffers/nonces;
  // callers pass the factory, never a previously consumed generator, to their atomic writer.
  function sealFactory(plainText, key, expected, maxPlaintextBytes) {
    const cap = limitOf(maxPlaintextBytes), context = contextOf(expected);
    if (typeof plainText !== 'string' || !Buffer.isBuffer(key) || key.length !== 32) fail('shape');
    const totalBytes = Buffer.byteLength(plainText, 'utf8');
    if (totalBytes > cap) fail('limit');
    if (typeof plainText.isWellFormed === 'function') {
      if (!plainText.isWellFormed()) fail('unicode_invalid');
    } else for (let i = 0; i < plainText.length; i++) {
        const unit = plainText.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = plainText.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) fail('unicode_invalid');
        } else if (unit >= 0xdc00 && unit <= 0xdfff) fail('unicode_invalid');
    }
    const revision = cryptoApi.randomBytes(16).toString('hex');
    const material = Buffer.from(key); // key-store clear/rotation must not change an in-flight revision
    let disposed = false;
    const factory = async function* () {
      if (disposed) fail('key_released');
      const release = await admission.acquire(totalBytes);
      try {
        if (disposed) fail('key_released');
        const bytes = Buffer.from(plainText, 'utf8');
        const lengths = [];
        for (let start = 0; start < bytes.length;) {
          let end = Math.min(bytes.length, start + CHUNK_BYTES);
          while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
          lengths.push(end - start); start = end;
        }
        if (lengths.length > MAX_CHUNKS) fail('limit');
        const manifest = { format: 1, revision, totalBytes: bytes.length, count: lengths.length,
          chunkBytes: CHUNK_BYTES, lengths, sha256: digest(bytes) };
        const binding = bindings(context, revision);
        yield encodeLine({ workData: FORMAT, format: NAME, purpose: context.purpose, instanceId: context.instanceId,
          schema: context.schema, scopeId: context.scopeId, recordId: context.recordId, seq: context.seq,
          keyId: WorkDataCrypto.keyId(context.generation), revision,
          manifest: WorkDataCrypto.seal(JSON.stringify(manifest), material, binding(null)) }, MAX_HEADER_BYTES);
        let offset = 0;
        for (let ordinal = 0; ordinal < lengths.length; ordinal++) {
          if (disposed) fail('key_released');
          const end = offset + lengths[ordinal];
          yield encodeLine({ i: ordinal, e: WorkDataCrypto.seal(bytes.toString('utf8', offset, end), material, binding(ordinal)) }, MAX_CHUNK_LINE_BYTES);
          offset = end;
        }
      } finally { release(); }
    };
    factory.dispose = () => { disposed = true; material.fill(0); };
    return factory;
  }
  async function openLines(lines, key, expected, maxPlaintextBytes) {
    const cap = limitOf(maxPlaintextBytes), context = contextOf(expected);
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('shape');
    let header = null, manifest = null, binding = null, output = null, offset = 0, ordinal = 0;
    let release = null;
    const hash = cryptoApi.createHash('sha256');
    try {
      for await (const line of lines) {
        if (!header) {
          header = parseLine(line, MAX_HEADER_BYTES);
          if (!exact(header, HEADER_KEYS) || header.workData !== FORMAT || header.format !== NAME
            || typeof header.revision !== 'string' || !/^[a-f0-9]{32}$/.test(header.revision)
            || header.keyId !== WorkDataCrypto.keyId(context.generation)
            || ['purpose', 'instanceId', 'schema', 'scopeId', 'recordId', 'seq'].some(name => header[name] !== context[name])) fail('binding_mismatch');
          binding = bindings(context, header.revision);
          try { manifest = JSON.parse(WorkDataCrypto.open(header.manifest, key, binding(null))); }
          catch { fail('authenticate_failed'); }
          if (!exact(manifest, MANIFEST_KEYS) || manifest.format !== 1 || manifest.revision !== header.revision
            || manifest.chunkBytes !== CHUNK_BYTES || !integer(manifest.totalBytes) || manifest.totalBytes > cap
            || !integer(manifest.count) || manifest.count > MAX_CHUNKS || !Array.isArray(manifest.lengths)
            || manifest.lengths.length !== manifest.count || typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)
            || (manifest.totalBytes === 0) !== (manifest.count === 0)) fail('manifest_invalid');
          let sum = 0;
          for (let i = 0; i < manifest.lengths.length; i++) {
            const length = manifest.lengths[i];
            if (!integer(length) || length < 1 || length > CHUNK_BYTES
              || (i < manifest.lengths.length - 1 && length < CHUNK_BYTES - 3)) fail('manifest_invalid');
            sum += length;
          }
          if (!Number.isSafeInteger(sum) || sum !== manifest.totalBytes) fail('manifest_invalid');
          release = await admission.acquire(manifest.totalBytes);
          output = Buffer.alloc(manifest.totalBytes); // only after manifest authentication and all limits
          continue;
        }
        if (ordinal >= manifest.count) fail('sequence_invalid');
        const row = parseLine(line, MAX_CHUNK_LINE_BYTES);
        if (!exact(row, 'e,i') || row.i !== ordinal) fail('sequence_invalid');
        let chunkPlainText;
        try { chunkPlainText = WorkDataCrypto.open(row.e, key, binding(ordinal)); } catch { fail('authenticate_failed'); }
        const bytes = Buffer.from(chunkPlainText, 'utf8');
        if (bytes.toString('utf8') !== chunkPlainText || bytes.length !== manifest.lengths[ordinal]) fail('length_invalid');
        bytes.copy(output, offset); offset += bytes.length; hash.update(bytes); ordinal++;
      }
      if (!header || ordinal !== manifest.count || offset !== manifest.totalBytes) fail('sequence_invalid');
      if (hash.digest('hex') !== manifest.sha256) fail('hash_mismatch');
      return output.toString('utf8');
    } finally { if (release) release(); }
  }
  return Object.freeze({ FORMAT, NAME, CHUNK_BYTES, MAX_PLAINTEXT_BYTES, MAX_CHUNKS, MAX_HEADER_BYTES,
    MAX_CHUNK_LINE_BYTES, limitOf, maxFileBytes, sealFactory, openLines, createAdmission, admission });
})(require('node:crypto'));
