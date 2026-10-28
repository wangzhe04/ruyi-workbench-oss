// Long-lived boot-root preference: <home>/.ruyi/boot-root-v1.json records which
// root a normal serve should start from after a restore committed a fresh target.
// It is a preference, never authority: 00-boot re-proves the target directory
// identity and generation before using it, and every manifest/owner check still
// happens in bind (failure there is fail closed). TEMP activation receipts stay
// single-handoff state and are never read or promoted here.
//
// Writes are create-or-swap with an exact previous sha/dev/ino receipt, an
// independent wx 0600 stage, file sync, native directory flush, rename and a
// strict single-link readback. A bad, replaced or non-canonical record is never
// repaired or overwritten by a read; it only falls back to the default root.
const WorkDataRootPreference = ((io, p, c) => {
  const DIR = '.ruyi', NAME = 'boot-root-v1.json', STAGE = '.boot-root-v1.stage-';
  const LIMIT = 16 * 1024, SHA = /^[a-f0-9]{64}$/;
  const fail = (suffix, cause) => Object.assign(Error('work_data_boot_root.' + suffix), {
    code: 'work_data_boot_root.' + suffix, apiCode: 'work_data_boot_root.' + suffix, statusCode: 409, retry: false,
    ...(cause === undefined ? {} : { cause }),
  });
  const shape = (value, expected) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === expected;
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const hash = bytes => c.createHash('sha256').update(bytes).digest('hex');
  const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\0\r\n]/.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value
    && p.isAbsolute(value) && p.resolve(value) === value && p.parse(value).root !== value;
  const alias = stat => stat.isSymbolicLink() || stat.reparsePoint === true || typeof stat.reparseTag === 'number' && stat.reparseTag !== 0;
  const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
  const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const receiptShape = value => shape(value, 'base,dev,ino,sha256') && absolute(value.base)
    && SHA.test(value.sha256 || '') && /^\d{1,40}$/.test(value.dev || '') && /^\d{1,40}$/.test(value.ino || '');
  // The codec/validator is owned by 00-boot (which must never depend on this
  // module). Re-derive it at call time so a fixture without 00-boot fails closed
  // instead of inventing a second record shape.
  const codec = () => {
    const value = typeof BootRootPreference === 'undefined' ? null : BootRootPreference;
    if (!value || value.NAME !== NAME || value.DIR !== DIR || value.LIMIT !== LIMIT
      || typeof value.validate !== 'function' || typeof value.decode !== 'function') throw fail('host_invalid');
    return value;
  };
  // A target root is proven by every path component: real directory, no link or
  // reparse point, realpath equal, and the final dev/ino equal to the record.
  async function directory(root, missing = false) {
    const parsed = p.parse(root);
    let cursor = parsed.root;
    const rows = [];
    for (const part of ['', ...root.slice(cursor.length).split(p.sep).filter(Boolean)]) {
      if (part) cursor = p.join(cursor, part);
      let stat;
      try { stat = await io.lstat(cursor, { bigint: true }); }
      catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
      if (!stat.isDirectory() || alias(stat) || fold(await io.realpath(cursor)) !== fold(cursor)) throw fail('path_alias');
      rows.push({ path: cursor, ...identity(stat) });
    }
    return rows;
  }
  async function homeDirectory(home) {
    // A redirected/aliased home is allowed: the user profile itself may be a
    // junction or symlink. recordDirectory() still proves <home>/.ruyi resolves
    // to realpath(home)/.ruyi, so the record directory cannot be a junction.
    let stat;
    try { stat = await io.stat(home, { bigint: true }); }
    catch (error) { throw fail('home_invalid', error); }
    if (!stat.isDirectory()) throw fail('home_invalid');
    return stat;
  }
  // <home>/.ruyi itself must be a real directory: realpath(dir) has to be exactly
  // realpath(home)/.ruyi. Ancestor aliases of the home are preserved, but a junction
  // at the record directory (which would dodge the 03 home-persistence floor) is not.
  async function recordDirectory(loc, missing = false) {
    let stat;
    try { stat = await io.lstat(loc.dir, { bigint: true }); }
    catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || alias(stat)) throw fail('path_alias');
    const expected = p.join(await io.realpath(loc.home), DIR);
    if (fold(await io.realpath(loc.dir)) !== fold(expected)) throw fail('path_alias');
    return stat;
  }
  async function capture(file, maximum) {
    const before = await io.lstat(file, { bigint: true });
    if (!before.isFile() || alias(before) || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum)) throw fail('record_invalid');
    const handle = await io.open(file, 'r'), scratch = Buffer.alloc(65536), chunks = [];
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(identity(opened), identity(before)) || !opened.isFile() || opened.nlink !== 1n) throw fail('record_changed');
      let used = 0;
      for (;;) {
        const part = await handle.read(scratch, 0, Math.min(scratch.length, maximum + 1 - used), null);
        if (!part.bytesRead) break;
        used += part.bytesRead;
        if (used > maximum) throw fail('record_invalid');
        chunks.push(Buffer.from(scratch.subarray(0, part.bytesRead)));
      }
      const after = await handle.stat({ bigint: true }), visible = await io.lstat(file, { bigint: true });
      if (!sameIdentity(identity(after), identity(before)) || !sameIdentity(identity(visible), identity(before))
        || alias(visible) || after.nlink !== 1n || visible.nlink !== 1n || after.size !== before.size || visible.size !== before.size
        || used !== Number(before.size) || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs) throw fail('record_changed');
      const bytes = Buffer.concat(chunks, used);
      return { bytes, sha256: hash(bytes), size: used, identity: identity(after) };
    } finally {
      scratch.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      await handle.close();
    }
  }
  function create({ home, flush } = {}) {
    if (!absolute(home) || typeof flush !== 'function') throw fail('host_invalid');
    codec();
    const location = () => {
      const dir = p.join(home, DIR);
      return { home, dir, file: p.join(dir, NAME) };
    };
    const receiptOf = (value, captured) => Object.freeze({
      base: value.base, sha256: captured.sha256, dev: captured.identity.dev, ino: captured.identity.ino,
    });
    let mutating = false;
    async function currentRecord(loc) {
      let before;
      try { before = await io.lstat(loc.file, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!before.isFile() || alias(before) || before.nlink !== 1n || before.size < 1n || before.size > BigInt(LIMIT)) throw fail('record_invalid');
      const captured = await capture(loc.file, LIMIT);
      const value = codec().decode(captured.bytes);
      if (!value) throw fail('record_invalid');
      return { value, captured };
    }
    async function baseRow(base, expected) {
      let rows;
      try { rows = await directory(base); }
      catch (error) { if (error && error.code === 'ENOENT') throw fail('base_changed'); throw error; }
      const current = rows.at(-1);
      if (expected && !sameIdentity(current, expected)) throw fail('base_changed');
      return current;
    }
    async function locate() {
      const loc = location();
      await homeDirectory(loc.home);
      if (!await recordDirectory(loc, true)) return null;
      const names = await io.readdir(loc.dir);
      if (names.some(name => fold(name).startsWith(STAGE))) throw fail('stage_pending');
      if (!names.some(name => fold(name) === NAME)) return null;
      const found = await currentRecord(loc);
      if (!found) throw fail('record_changed');
      // The record is metadata: a stale/deleted old target must stay removable and
      // replaceable by exact CAS. Boot (not this store) decides whether a target is
      // still usable; every write below re-proves the NEW target's alias/dev-ino.
      return found;
    }
    async function ensureDir(loc) {
      let stat;
      try { stat = await io.lstat(loc.dir, { bigint: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!stat) {
        try { await io.mkdir(loc.dir, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      await recordDirectory(loc);
    }
    async function inspect() {
      try {
        const found = await locate();
        if (!found) return Object.freeze({ present: false });
        return Object.freeze({ present: true, value: found.value, receipt: receiptOf(found.value, found.captured) });
      } catch (error) {
        if (String(error && error.code || '').startsWith('work_data_boot_root.')) throw error;
        throw fail('inspect_failed', error);
      }
    }
    async function write(value, previous = null) {
      let bytes, selected, expected;
      try {
        if (!codec().validate(value)) throw fail('record_invalid');
        bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > LIMIT) throw fail('record_invalid');
        selected = codec().decode(bytes);
        if (!selected) throw fail('record_invalid');
        expected = hash(bytes);
      } catch (error) {
        if (String(error && error.code || '').startsWith('work_data_boot_root.')) throw error;
        throw fail('record_invalid', error);
      }
      if (mutating) throw fail('busy');
      mutating = true;
      let stage = null, stageIdentity = null;
      // Only a stage this call created through wx and can still prove to be the same
      // ordinary single-link file may be removed on failure. A collision with an
      // unknown stage (or a replaced/hard-linked one) is left untouched.
      const discardOwnStage = async () => {
        if (stage === null || stageIdentity === null) return;
        try {
          const stat = await io.lstat(stage, { bigint: true });
          if (stat.isFile() && !alias(stat) && stat.nlink === 1n && sameIdentity(identity(stat), stageIdentity)) await io.unlink(stage);
        } catch { /* best effort: never mask the original failure */ }
      };
      try {
        const loc = location();
        await homeDirectory(loc.home);
        await baseRow(selected.base, selected.baseIdentity);
        const observed = await locate();
        if (observed) {
          // Byte-identical (same sha256) is already the desired durable state: never rewrite it.
          if (observed.captured.sha256 === expected) return receiptOf(observed.value, observed.captured);
          if (previous === null || previous === undefined) throw fail('record_exists');
          if (!receiptShape(previous)) throw fail('receipt_invalid');
          // The receipt binds the exact old FILE (sha/dev/ino); its base is diagnostic.
          // A newer restore may legitimately move the preference to another target.
          if (previous.sha256 !== observed.captured.sha256
            || !sameIdentity(previous, observed.captured.identity)) throw fail('record_changed');
        } else if (previous !== null && previous !== undefined) {
          throw fail('record_changed');
        }
        await baseRow(selected.base, selected.baseIdentity);
        await ensureDir(loc);
        stage = p.join(loc.dir, STAGE + c.randomBytes(24).toString('hex'));
        const handle = await io.open(stage, 'wx', 0o600);
        try {
          const opened = await handle.stat({ bigint: true });
          if (opened.isFile()) stageIdentity = identity(opened);
          if (!opened.isFile() || opened.nlink !== 1n) throw fail('record_invalid');
          await handle.writeFile(bytes);
          await handle.sync();
        } finally { await handle.close(); }
        await flush([loc.dir, loc.home]);
        // The target may have been replaced while this write was in flight.
        await baseRow(selected.base, selected.baseIdentity);
        const actual = await currentRecord(loc);
        if (observed) {
          if (!actual || actual.captured.sha256 !== observed.captured.sha256
            || !sameIdentity(actual.captured.identity, observed.captured.identity)) throw fail('record_changed');
        } else if (actual) {
          throw fail('record_exists');
        }
        await io.rename(stage, loc.file);
        stage = null;
        stageIdentity = null;
        await flush([loc.dir, loc.home]);
        const proof = await capture(loc.file, LIMIT);
        if (proof.sha256 !== expected) throw fail('record_changed');
        return receiptOf(selected, proof);
      } catch (error) {
        await discardOwnStage();
        if (String(error && error.code || '').startsWith('work_data_boot_root.')) throw error;
        throw fail('write_failed', error);
      } finally { mutating = false; }
    }
    // Exact CAS removal exists only for test/owner maintenance. A read never
    // deletes or rewrites the record; an unknown stage keeps the file stuck.
    async function remove(receipt) {
      if (!receiptShape(receipt)) throw fail('receipt_invalid');
      if (mutating) throw fail('busy');
      mutating = true;
      try {
        const loc = location();
        await homeDirectory(loc.home);
        if (!await recordDirectory(loc, true)) return true;
        const names = await io.readdir(loc.dir);
        if (names.some(name => fold(name).startsWith(STAGE))) throw fail('stage_pending');
        if (!names.some(name => fold(name) === NAME)) return true;
        const found = await currentRecord(loc);
        if (!found) throw fail('record_changed');
        if (found.value.base !== receipt.base || found.captured.sha256 !== receipt.sha256
          || !sameIdentity(found.captured.identity, receipt)) throw fail('record_changed');
        await io.unlink(loc.file);
        await flush([loc.dir, loc.home]);
        try { await io.lstat(loc.file); }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        throw fail('record_changed');
      } catch (error) {
        if (String(error && error.code || '').startsWith('work_data_boot_root.')) throw error;
        throw fail('remove_failed', error);
      } finally { mutating = false; }
    }
    return Object.freeze({ inspect, write, remove, validate: value => codec().validate(value) });
  }
  return Object.freeze({ DIR, NAME, STAGE, LIMIT, validate: value => codec().validate(value),
    decode: bytes => codec().decode(bytes), create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
