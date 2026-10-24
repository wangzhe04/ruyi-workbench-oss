// Shared filesystem owner for the three auxiliary NDJSON journals. Domain owners
// keep their own serialization chains, legacy readers/retention and action policy.
// No plaintext temporary files; no implicit key creation; a key lease belongs to
// one complete read/append/replacement operation, never to a warm count cache.
const WorkDataJournals = ((fsp, pathModule, cryptoApi) => {
  const MAX_RECORD_BYTES = 256 * 1024 * 1024;
  const MAX_CIPHER_RECORD_BYTES = WorkDataChunks.maxFileBytes(MAX_RECORD_BYTES) + 64;
  const CACHE_MAX = 64, states = new Map(), recoveryGates = new Map(), pendingReservations = new Set(), recoveryTickets = new WeakMap();
  const fail = suffix => { throw Object.assign(new Error('work_data_journal.' + suffix), { code: 'work_data_journal.' + suffix, apiCode: 'work_data_journal.' + suffix, statusCode: 503 }); };
  const stampOf = stat => stat ? [stat.size, stat.mtimeNs, stat.ctimeNs, stat.dev, stat.ino].join('|') : 'missing';
  const fileStamp = async file => {
    try { return stampOf(await fsp.stat(file, { bigint: true })); }
    catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  };
  const remember = (file, value) => {
    states.delete(file); states.set(file, value);
    while (states.size > CACHE_MAX) states.delete(states.keys().next().value);
  };
  const candidate = line => {
    const trimmed = String(line).trim();
    if (!trimmed.startsWith('{')) return false;
    try { const row = JSON.parse(trimmed); return !!row && typeof row === 'object' && !Array.isArray(row) && Object.hasOwn(row, 'w'); }
    catch { return /^\{\s*"(?:w|\\u0077)"\s*:/i.test(trimmed); }
  };
  const authority = credential => credential.instanceId + ':' + cryptoApi.createHash('sha256').update(credential.key).digest('hex');
  // Classify/count physical records without keeping any key, string or line.
  // This pass can discover a late escaped/reordered w after a giant value before
  // the authentication pass allocates a sealed row. Giant ordinary legacy rows
  // acquire no new cap and require no row copy merely to prove their metadata.
  async function readMetadata(file) {
    let handle;
    try { handle = await fsp.open(file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return { count: 0, committedBytes: 0, tornBytes: 0, sealed: false, authStamp: '', stamp: 'missing' }; throw error; }
    try {
      const stamp = stampOf(await handle.stat({ bigint: true })), buffer = Buffer.alloc(64 * 1024);
      let probe = WorkDataRecords.lineProbe(), rowBytes = 0, count = 0, committedBytes = 0, sealed = false;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead) {
          const newline = buffer.indexOf(10, start), end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
          const part = buffer.subarray(start, end); probe.feed(part); rowBytes += part.length;
          if (end === bytesRead) break;
          if (probe.reserved()) {
            sealed = true;
            if (rowBytes > MAX_CIPHER_RECORD_BYTES) fail('physical_record_limit');
          }
          count++; committedBytes += rowBytes + 1; rowBytes = 0; probe = WorkDataRecords.lineProbe(); start = end + 1;
        }
      }
      if (stampOf(await handle.stat({ bigint: true })) !== stamp || await fileStamp(file) !== stamp) fail('source_changed');
      return { count, committedBytes, tornBytes: rowBytes, tornReserved: probe.reserved(), sealed, authStamp: '', stamp };
    } finally { await handle.close(); }
  }
  async function readPhysicalRow(handle, start, length) {
    if (length > MAX_CIPHER_RECORD_BYTES) fail('physical_record_limit');
    const bytes = Buffer.alloc(length); let used = 0;
    while (used < length) {
      const result = await handle.read(bytes, used, Math.min(64 * 1024, length - used), start + used);
      if (!result.bytesRead) fail('source_changed'); used += result.bytesRead;
    }
    return bytes.toString('utf8');
  }
  const withLease = async (host, work) => {
    let pending = null, failed = false;
    const owner = { credential: () => pending || (pending = WorkDataStore.acquireSnapshot(host.keys || WorkDataStore.requireKeys())) };
    try { return await work(owner); }
    catch (error) { failed = true; throw error; }
    finally {
      let lease;
      try { if (pending) lease = await pending; } catch { /* acquisition already failed */ }
      if (lease) { try { await lease.release(); } catch { if (!failed) fail('snapshot_release'); } }
    }
  };
  async function validateSealed(host, plain, ordinal) {
    if (!host.validateSealedLine) return;
    try { if (await host.validateSealedLine(plain, ordinal) !== true) fail('shape'); }
    catch (error) { if (String(error && error.code || '').startsWith('work_data')) throw error; fail('shape'); }
  }
  // Each physical LF consumes an ordinal, including blank/bad legacy rows.
  // Metadata never retains row bytes. A finite window copies ordinary rows in
  // bounded pieces only after their offsets are known; only sealed rows need a
  // complete bounded allocation for the existing authenticated codec.
  async function scan(file, host, owner, visit, refuseSealed = false, includeTorn = false, visitInvalidTorn = false, proof = null, sink = null, digestSink = false) {
    const metadata = proof || await readMetadata(file);
    if (metadata.sealed && refuseSealed) fail('downgrade_refused');
    if (!visit && !sink && !metadata.sealed && !(includeTorn && metadata.tornReserved)) return metadata;
    if (includeTorn && metadata.tornReserved && metadata.tornBytes > MAX_CIPHER_RECORD_BYTES) fail('physical_record_limit');
    if (await fileStamp(file) !== metadata.stamp) fail('source_changed');
    if (metadata.stamp === 'missing') return metadata;
    const handle = await fsp.open(file, 'r'), buffer = Buffer.alloc(64 * 1024);
    let count = 0, committedBytes = 0, rowBytes = 0, authStamp = '', sealed = false, sealedTail = false, probe = WorkDataRecords.lineProbe();
    const digest = visit || digestSink ? cryptoApi.createHash('sha256') : null;
    const output = part => { if (digestSink && !visit) digest.update(part); sink(part); };
    const emit = async (reserved, committed) => {
      let plain;
      if (reserved) {
        if (refuseSealed) fail('downgrade_refused');
        const raw = await readPhysicalRow(handle, committedBytes, rowBytes);
        if (!committed) { try { JSON.parse(raw); } catch { return; } }
        const credential = await owner.credential();
        plain = await WorkDataRecords.decodeRecordLine(raw, credential.key,
          { ...host.context, instanceId: credential.instanceId, ordinal: count }, MAX_RECORD_BYTES);
        await validateSealed(host, plain, count);
        if (!committed) sealedTail = true;
        sealed = true; authStamp = authority(credential);
      } else if (visit) {
        // Full maintenance visitors preserve the old full-row legacy semantics.
        const parts = []; let used = 0;
        while (used < rowBytes) {
          const part = Buffer.alloc(Math.min(64 * 1024, rowBytes - used));
          const { bytesRead } = await handle.read(part, 0, part.length, committedBytes + used);
          if (!bytesRead) fail('source_changed'); parts.push(part.subarray(0, bytesRead)); used += bytesRead;
        }
        plain = Buffer.concat(parts, rowBytes).toString('utf8');
      }
      if (visit) { digest.update(plain, 'utf8'); if (committed) digest.update('\n'); await visit(plain, count, committed); }
      if (sink) {
        if (reserved) output(Buffer.from(plain, 'utf8'));
        else {
          let used = 0;
          while (used < rowBytes) {
            const part = Buffer.alloc(Math.min(64 * 1024, rowBytes - used));
            const { bytesRead } = await handle.read(part, 0, part.length, committedBytes + used);
            if (!bytesRead) fail('source_changed'); output(part.subarray(0, bytesRead)); used += bytesRead;
          }
        }
        if (committed) output(Buffer.from('\n'));
      }
    };
    try {
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead) {
          const newline = buffer.indexOf(10, start), end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
          const part = buffer.subarray(start, end); probe.feed(part); rowBytes += part.length;
          if (probe.reserved() && rowBytes > MAX_CIPHER_RECORD_BYTES) fail('physical_record_limit');
          if (end === bytesRead) break;
          await emit(probe.reserved(), true);
          count++; committedBytes += rowBytes + 1; rowBytes = 0; probe = WorkDataRecords.lineProbe(); start = end + 1;
        }
      }
      if (includeTorn && rowBytes) await emit(probe.reserved(), false);
      if (stampOf(await handle.stat({ bigint: true })) !== metadata.stamp || await fileStamp(file) !== metadata.stamp) fail('source_changed');
      return { ...metadata, count, committedBytes, tornBytes: rowBytes, sealed, sealedTail, authStamp, digest: digest ? digest.digest('hex') : '' };
    } finally { await handle.close(); }
  }
  function create(host) {
    const file = () => typeof host.file === 'function' ? host.file() : host.file;
    if (!host.context || !WorkDataRecords.JOURNAL_KINDS.includes(host.context.kind)) fail('kind');
    const keyFor = target => target + '\u0000' + host.context.kind + '\u0000' + host.context.sessionId + '\u0000' + (host.context.runId || '');
    const recoveryPending = () => recoveryGates.has(keyFor(file()));
    const assertAdmission = target => {
      if (recoveryGates.has(keyFor(target))) fail('recovery_required');
      // Failure gates are never LRU-evicted. Pending writers reserve the same
      // bounded slots so independent file chains cannot overfill them on failure.
      if (recoveryGates.size + pendingReservations.size >= CACHE_MAX) fail('recovery_capacity');
    };
    const reserveWrite = target => {
      const key = keyFor(target);
      assertAdmission(target);
      if (pendingReservations.has(key)) fail('write_pending');
      pendingReservations.add(key);
      return () => pendingReservations.delete(key);
    };
    const isEnabled = async () => {
      try { return await host.enabled() === true; }
      catch { fail('switch_unavailable'); }
    };
    const auth = () => withLease(host, async owner => authority(await owner.credential()));
    const checkAuthority = async expected => withLease(host, async owner => {
      const enabled = await isEnabled();
      if (enabled || expected) { const credential = await owner.credential(); return !expected || expected === authority(credential); }
      return true;
    });
    const stateWithin = async (target, owner, enabled) => {
      const cacheKey = keyFor(target), stamp = await fileStamp(target);
      // Mutation admission authenticates current bytes. File stamps are useful
      // read-cache hints, never content proof (Windows can preserve all fields).
      const proof = await readMetadata(target);
      if (!enabled && proof.tornReserved) fail('downgrade_refused');
      const result = await scan(target, host, owner, null, !enabled, true, false, proof);
      if (result.sealedTail) fail('sealed_tail_uncommitted');
      const after = await fileStamp(target);
      if (after !== stamp) fail('source_changed');
      const state = { ...result, stamp: after };
      remember(cacheKey, state); return state;
    };
    // A reusable operation owns one lazy key snapshot and switch value. Domain
    // chains may borrow it for preflight + mutation + append; never for a model turn.
    const withOperation = work => withLease(host, async owner => {
      owner.enabled = await isEnabled();
      if (owner.enabled) await owner.credential();
      return work(owner);
    });
    const within = (operation, work) => operation ? work(operation) : withOperation(work);
    const preflight = operation => within(operation, async owner => {
      assertAdmission(file()); return stateWithin(file(), owner, owner.enabled);
    });
    // Select windows AFTER decryption; ciphertext expansion is never a capacity.
    // Each read pays one bounded metadata pass: Windows can preserve the full stat
    // tuple across an external in-place replacement. The legacy reader keeps its
    // original byte window, surrounded by real stamps; no O(tail) claim is made.
    const readWindow = (fullBytes, tailBytes, visit, includeInvalidTorn = false, legacyRead = null, operation = null, digestSink = false) => within(operation, async owner => {
      const target = file(), before = await fileStamp(target), cacheKey = keyFor(target);
      const proof = await readMetadata(target);
      if (!proof.sealed && !proof.tornReserved && !visit && !digestSink && legacyRead) {
        const window = await legacyRead();
        if (await fileStamp(target) !== before) fail('source_changed');
        remember(cacheKey, { ...proof, stamp: before });
        return { ...window, ...proof, stamp: before, authStamp: '' };
      }
      const chunks = []; let size = 0, droppedHead = false;
      const sink = visit ? null : part => {
        chunks.push(part); size += part.length;
        if (size > fullBytes) droppedHead = true;
        if (droppedHead) {
          while (chunks.length && size - chunks[0].length >= tailBytes) size -= chunks.shift().length;
          if (chunks.length && size > tailBytes) {
            const cut = size - tailBytes; chunks[0] = chunks[0].subarray(cut); size -= cut;
          }
        }
      };
      const result = await scan(target, host, owner, visit, false, true, includeInvalidTorn, proof, sink, digestSink);
      if (await fileStamp(target) !== before) fail('source_changed');
      remember(cacheKey, { ...result, stamp: before });
      const gate = recoveryGates.get(cacheKey); let recoveryTicket;
      // Only explicit full visitors can attest that the domain rebuilt all state.
      if (gate && visit) {
        recoveryTicket = Object.freeze({});
        recoveryTickets.set(recoveryTicket, { key: cacheKey, gate, stamp: before, authStamp: result.authStamp, digest: result.digest });
      }
      return { text: visit ? '' : Buffer.concat(chunks, size).toString('utf8'), droppedHead, ...result, stamp: before, recoveryTicket };
    });
    // Opt-in stable disclosure proof hashes exactly the logical sink bytes from
    // this scan, including bytes discarded by a tail window. Revalidation scans
    // current bytes and acquires a fresh short lease; stat is only a cheap guard.
    const readProof = async (fullBytes, tailBytes) => {
      const target = file(), result = await readWindow(fullBytes, tailBytes, null, false, null, null, true);
      const expected = { digest: result.digest, authStamp: result.authStamp, stamp: result.stamp };
      const check = () => withOperation(async owner => {
        if (file() !== target || await fileStamp(target) !== expected.stamp) fail('source_changed');
        const current = await scan(target, host, owner, null, false, true, false, null, () => {}, true);
        if (current.digest !== expected.digest || current.authStamp !== expected.authStamp) fail('source_changed');
        if (await fileStamp(target) !== expected.stamp) fail('source_changed');
      });
      return { ...result, check };
    };
    const stage = async (target, rows, startOrdinal, credential) => {
      await fsp.mkdir(pathModule.dirname(target), { recursive: true });
      const temp = target + '.sealed-stage-' + cryptoApi.randomBytes(12).toString('hex');
      let output, complete = false;
      try {
        output = await fsp.open(temp, 'wx', 0o600);
        for (let index = 0; index < rows.length; index++) {
          await validateSealed(host, rows[index], startOrdinal + index);
          const factory = WorkDataRecords.encodeRecordFactory(rows[index], credential.key,
            { ...host.context, instanceId: credential.instanceId, ordinal: startOrdinal + index }, MAX_RECORD_BYTES);
          try {
            for await (const part of factory()) {
              const bytes = Buffer.from(part); let offset = 0;
              while (offset < bytes.length) {
                const result = await output.write(bytes, offset, bytes.length - offset, null);
                if (!result.bytesWritten) fail('short_write'); offset += result.bytesWritten;
              }
            }
          } finally { factory.dispose(); }
        }
        await output.close(); output = null; complete = true; return temp;
      } finally {
        if (output) await output.close().catch(() => {});
        if (!complete) await fsp.unlink(temp).catch(() => {});
      }
    };
    const copyStage = async (target, temp) => {
      const input = await fsp.open(temp, 'r'); let output;
      try {
        output = await fsp.open(target, 'a'); const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
          let offset = 0;
          while (offset < bytesRead) {
            const result = await output.write(buffer, offset, bytesRead - offset, null);
            if (!result.bytesWritten) fail('short_write'); offset += result.bytesWritten;
          }
        }
      } finally { if (output) await output.close(); await input.close(); }
    };
    // Callers serialize this owner with their existing append/rewrite chain.
    const append = (rows, legacyAppend, operation = null) => within(operation, async owner => {
      const target = file(), enabled = owner.enabled;
      assertAdmission(target);
      const state = await stateWithin(target, owner, enabled);
      if (!enabled) {
        await legacyAppend();
        const after = await fileStamp(target);
        remember(keyFor(target), { count: state.count + rows.length, committedBytes: Number(after.split('|')[0]),
          tornBytes: 0, sealed: false, authStamp: '', stamp: after });
        return { sealed: false, authStamp: '' };
      }
      const credential = await owner.credential(), releaseReservation = reserveWrite(target);
      let temp;
      try {
        temp = await stage(target, rows, state.count, credential);
        if (await fileStamp(target) !== state.stamp) fail('source_changed');
        if (state.tornBytes) await fsp.truncate(target, state.committedBytes);
        try { await copyStage(target, temp); }
        catch (error) {
          // A failed batch must not leave its first complete rows for an inbox
          // retry to duplicate. The caller owns the per-file serialization chain.
          // A second filesystem failure during rollback is diagnosed separately;
          // neither this layer nor its caller replays an already executed action.
          try { await fsp.truncate(target, state.committedBytes); }
          catch (rollbackError) {
            pendingReservations.delete(keyFor(target));
            recoveryGates.set(keyFor(target), Object.freeze({}));
            try { if (host.onRollbackFailure) host.onRollbackFailure(rollbackError); } catch { /* diagnostics */ }
            fail('recovery_required');
          }
          throw error;
        }
        const after = await fileStamp(target);
        const next = { count: state.count + rows.length, committedBytes: Number(after.split('|')[0]), tornBytes: 0, sealed: true,
          authStamp: authority(credential), stamp: after };
        remember(keyFor(target), next); return { sealed: true, authStamp: next.authStamp };
      } catch (error) { states.delete(keyFor(target)); throw error; }
      finally { if (temp) await fsp.unlink(temp).catch(() => {}); releaseReservation(); }
    });
    const replace = (rows, legacyReplace, operation = null) => within(operation, async owner => {
      const target = file(), enabled = owner.enabled;
      assertAdmission(target);
      const state = await stateWithin(target, owner, enabled);
      if (!enabled) {
        await legacyReplace(); states.delete(keyFor(target)); return { sealed: false, authStamp: '' };
      }
      const credential = await owner.credential(), releaseReservation = reserveWrite(target);
      let temp;
      try {
        temp = await stage(target, rows, 0, credential);
        if (await fileStamp(target) !== state.stamp) fail('source_changed');
        const factory = async function* () {
          const input = await fsp.open(temp, 'r'); const buffer = Buffer.alloc(64 * 1024);
          try {
            for (;;) { const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break; yield Buffer.from(buffer.subarray(0, bytesRead)); }
          } finally { await input.close(); }
        };
        await host.writeJson(target, factory, { stream: true }); states.delete(keyFor(target));
        return { sealed: rows.length > 0, authStamp: rows.length ? authority(credential) : '' };
      } finally { if (temp) await fsp.unlink(temp).catch(() => {}); releaseReservation(); }
    });
    const acknowledgeRecovery = (ticket, operation = null) => within(operation, async owner => {
      const proof = ticket && recoveryTickets.get(ticket), key = keyFor(file());
      if (!proof || proof.key !== key || proof.gate !== recoveryGates.get(key)) fail('recovery_ticket');
      if (await fileStamp(file()) !== proof.stamp) fail('source_changed');
      if (proof.authStamp && authority(await owner.credential()) !== proof.authStamp) fail('recovery_key_changed');
      const current = await scan(file(), host, owner, () => {}, false, true);
      if (current.digest !== proof.digest || current.authStamp !== proof.authStamp) fail('recovery_changed');
      if (await fileStamp(file()) !== proof.stamp) fail('source_changed');
      recoveryGates.delete(key); recoveryTickets.delete(ticket);
    });
    return Object.freeze({ append, replace, readWindow, readProof, withOperation, preflight, checkAuthority, recoveryPending, acknowledgeRecovery, authStamp: auth, metadataProof: () => readMetadata(file()),
      fileStamp: () => fileStamp(file()), forget: () => states.delete(keyFor(file())) });
  }
  return Object.freeze({ create, candidate, MAX_RECORD_BYTES });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
