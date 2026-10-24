// M3-3 authority IO only. The host holds the single serve owner and transition gate.
// This byte comparison is not a cross-process CAS. No file below a generation is
// scanned, transformed, retired, or removed here; the migration host owns those steps.
const WorkDataManifest = ((fsApi, pathApi, cryptoApi) => {
  const Hooks = {}; // 01w supplies the Windows publisher after both independent modules load.
  const SCHEMA = 1, MAX_BYTES = 4096, ID = /^[a-f0-9]{48}$/;
  const error = (suffix, cause, commitUncertain = false) => Object.assign(new Error('work_data_manifest.' + suffix), {
    code: 'work_data_manifest.' + suffix, statusCode: 409, commitUncertain,
    helperMayStillRun: cause?.helperMayStillRun === true,
    ...(cause !== undefined ? { cause } : {}),
  });
  const digest = raw => cryptoApi.createHash('sha256').update(raw, 'utf8').digest('hex');
  const generationValid = value => Number.isSafeInteger(value) && value >= 1;
  const modeValid = value => value === 'plain' || value === 'encrypted';
  const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const receipt = (raw, state, root) => Object.freeze({
    schema: SCHEMA, id: state?.id || null, generation: state?.generation || 0,
    mode: state?.mode || 'plain', root,
    proof: Object.freeze({ raw, sha256: raw === null ? null : digest(raw) }),
  });
  function parse(raw) {
    let value;
    try { value = JSON.parse(raw); } catch (cause) { throw error('invalid', cause); }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'activeRoot,generation,id,mode,schema'
      || value.schema !== SCHEMA || !generationValid(value.generation) || typeof value.id !== 'string' || !ID.test(value.id)
      || !modeValid(value.mode) || value.activeRoot !== 'generations/' + value.id) throw error('invalid');
    return value;
  }
  // Check every existing ancestor, rather than relying on the leaf realpath alone.
  // Junctions/symlinks anywhere in the control namespace refuse authority access.
  async function directory(target, allowMissing = false) {
    const absolute = pathApi.resolve(target), parsed = pathApi.parse(absolute);
    let cursor = parsed.root;
    const parts = absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean);
    for (const part of ['', ...parts]) {
      if (part) cursor = pathApi.join(cursor, part);
      let stat;
      try { stat = await fsApi.lstat(cursor); }
      catch (cause) { if (allowMissing && cause.code === 'ENOENT') return false; throw error('directory_unavailable', cause); }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('directory_invalid');
      let real;
      try { real = await fsApi.realpath(cursor); } catch (cause) { throw error('directory_unavailable', cause); }
      if (pathKey(pathApi.resolve(real)) !== pathKey(pathApi.resolve(cursor))) throw error('directory_invalid');
    }
    return true;
  }
  async function syncDirectory(target) {
    let handle;
    try { handle = await fsApi.open(target, 'r'); await handle.sync(); }
    catch (cause) { throw error('durability_unsupported', cause); }
    finally { if (handle) await handle.close(); }
  }
  function create({ base, publish: explicitPublish } = {}) {
    if (typeof base !== 'string' || !pathApi.isAbsolute(base)) throw error('base_invalid');
    const publish = explicitPublish === undefined ? Hooks.publish : explicitPublish;
    if (publish !== undefined && typeof publish !== 'function') throw error('publisher_invalid');
    const root = pathApi.resolve(base), control = pathApi.join(root, '.work-data');
    const generations = pathApi.join(control, 'generations'), active = pathApi.join(control, 'active-v1.json');
    const candidates = new WeakMap();
    let committing = false;
    async function readActive() {
      await directory(root);
      await directory(control, true);
      let stat;
      try { stat = await fsApi.lstat(active); }
      catch (cause) {
        if (cause.code === 'ENOENT') return receipt(null, null, root);
        throw error('read_unavailable', cause);
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw error('invalid');
      let handle, bytes;
      try {
        handle = await fsApi.open(active, 'r');
        // A bounded descriptor read prevents readFile from allocating after a concurrent growth.
        const buffer = Buffer.alloc(MAX_BYTES + 1); let used = 0;
        while (used < buffer.length) {
          const next = await handle.read(buffer, used, buffer.length - used, null);
          if (!next.bytesRead) break;
          used += next.bytesRead;
        }
        if (used > MAX_BYTES) throw error('invalid');
        bytes = buffer.subarray(0, used);
      } catch (cause) {
        if (String(cause.code || '').startsWith('work_data_manifest.')) throw cause;
        throw error('read_unavailable', cause);
      } finally { if (handle) await handle.close(); }
      const raw = bytes.toString('utf8');
      if (!Buffer.from(raw, 'utf8').equals(bytes)) throw error('invalid');
      const state = parse(raw), target = pathApi.join(generations, state.id);
      await directory(target);
      return receipt(raw, state, target);
    }
    function expectedProof(expected) {
      const proof = expected?.proof;
      if (!expected || !proof) throw error('expected_invalid');
      const raw = proof.raw, sha256 = proof.sha256;
      if ((raw !== null && typeof raw !== 'string')
        || sha256 !== (raw === null ? null : digest(raw))) throw error('expected_invalid');
      const state = raw === null ? null : parse(raw);
      if (expected.generation !== (state?.generation || 0) || expected.id !== (state?.id || null)
        || expected.mode !== (state?.mode || 'plain')
        || expected.root !== (state ? pathApi.join(generations, state.id) : root)) throw error('expected_invalid');
      // Copy before the first await. Caller mutation cannot alter this admission.
      return Object.freeze({ raw, sha256 });
    }
    async function checkExpected(proof) {
      const current = await readActive();
      if (current.proof.raw !== proof.raw || current.proof.sha256 !== proof.sha256) throw error('conflict');
      return current;
    }
    async function prepare({ expected, mode } = {}) {
      const proof = expectedProof(expected);
      if (!modeValid(mode)) throw error('mode_invalid');
      const previous = await checkExpected(proof);
      if (!Number.isSafeInteger(previous.generation + 1)) throw error('generation_invalid');
      await directory(control, true);
      try { await fsApi.mkdir(control); } catch (cause) { if (cause.code !== 'EEXIST') throw error('prepare_failed', cause); }
      await directory(control);
      await directory(generations, true);
      try { await fsApi.mkdir(generations); } catch (cause) { if (cause.code !== 'EEXIST') throw error('prepare_failed', cause); }
      await directory(generations);
      const id = cryptoApi.randomBytes(24).toString('hex'), target = pathApi.join(generations, id);
      try { await fsApi.mkdir(target); } catch (cause) { throw error('prepare_failed', cause); }
      await directory(target);
      const candidate = Object.freeze({ schema: SCHEMA, id, generation: previous.generation + 1, mode,
        activeRoot: 'generations/' + id, root: target });
      candidates.set(candidate, Object.freeze({ proof, generation: candidate.generation, mode, root: target }));
      return candidate;
    }
    async function commit({ expected, candidate } = {}) {
      const proof = expectedProof(expected), owned = candidates.get(candidate);
      if (!owned || owned.proof.raw !== proof.raw || owned.proof.sha256 !== proof.sha256
        || candidate.generation !== owned.generation || candidate.mode !== owned.mode || candidate.root !== owned.root) throw error('candidate_invalid');
      if (committing) throw error('busy');
      committing = true;
      let handle, publishing = false;
      try {
        const stage = pathApi.join(control, '.active-v1.stage-' + cryptoApi.randomBytes(24).toString('hex') + '.json');
        const previous = await checkExpected(proof);
        if (candidate.generation !== previous.generation + 1) throw error('candidate_invalid');
        await directory(candidate.root);
        // Node directory fsync reports EPERM on tested Windows 24.14.1. A Windows
        // host must inject a verified native write-through publisher; no ignored fsync.
        if (!publish) {
          await syncDirectory(candidate.root); await syncDirectory(generations);
          await syncDirectory(control); await syncDirectory(root);
        }
        const raw = JSON.stringify({ schema: SCHEMA, generation: candidate.generation, id: candidate.id,
          mode: candidate.mode, activeRoot: candidate.activeRoot }) + '\n';
        handle = await fsApi.open(stage, 'wx', 0o600);
        await handle.writeFile(raw, 'utf8'); await handle.sync(); await handle.close(); handle = null;
        await checkExpected(proof);
        await directory(candidate.root);
        publishing = true;
        // The injected publisher is a trusted platform adapter. It must atomically
        // replace on this same volume and durably publish all listed directory
        // entries; an ordinary rename-only test stub is not that guarantee.
        if (publish) await publish(Object.freeze({ stage, target: active, directory: control,
          directories: Object.freeze([candidate.root, generations, control, root]) }));
        else { await fsApi.rename(stage, active); await syncDirectory(control); }
        const result = await readActive();
        if (result.proof.raw !== raw) throw error('published_mismatch');
        candidates.delete(candidate);
        return result;
      } catch (cause) {
        // A platform publisher may throw a frozen Error or any JS value. Never
        // mutate it: the wrapper owns the authoritative uncertainty indicator.
        if (String(cause && cause.code || '').startsWith('work_data_manifest.'))
          throw error(String(cause.code).slice('work_data_manifest.'.length), cause,
            publishing || cause.commitUncertain === true);
        throw error('commit_failed', cause, publishing);
      } finally {
        if (handle) await handle.close().catch(() => {});
        // An uncertain candidate/stage may be the only recoverable copy. Never
        // unlink it or restore an earlier manifest based on an exception alone.
        committing = false;
      }
    }
    return Object.freeze({ readActive, prepare, commit });
  }
  return Object.freeze({ create, SCHEMA, Hooks });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
