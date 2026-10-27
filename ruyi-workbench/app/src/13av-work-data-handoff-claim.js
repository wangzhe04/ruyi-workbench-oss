// Handoff claim metadata lives in TEMP, never in the base or a backup package.
// It records which parent/child pair may be executing one maintenance job; it is
// never authority to execute, release or call an operation complete. Every
// update/removal is bound to the exact previous sha256 plus native dev/ino, and
// classification only says whether the record itself may be cleaned.
const WorkDataHandoffClaim = ((io, p, c) => {
  const NAME = 'claim-v1.json', DIR = 'ruyi-work-data-handoff-', STAGE = '.claim-v1.stage-';
  const LIMIT = 16 * 1024, ID = /^[a-f0-9]{48}$/, SHA = /^[a-f0-9]{64}$/, PHASES = ['armed', 'committed', 'owned'];
  const fail = (suffix, cause) => Object.assign(Error('work_data_claim.' + suffix), {
    code: 'work_data_claim.' + suffix, apiCode: 'work_data_claim.' + suffix, statusCode: 409, retry: false,
    ...(cause === undefined ? {} : { cause }),
  });
  const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  const shape = (value, expected) => keys(value) === expected;
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const hash = bytes => c.createHash('sha256').update(bytes).digest('hex');
  const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\0\r\n]/.test(value) && Buffer.from(value).toString('utf8') === value
    && p.isAbsolute(value) && p.resolve(value) === value && p.parse(value).root !== value;
  const inside = (root, value) => {
    const rel = p.relative(fold(root), fold(value));
    return rel === '' || rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel);
  };
  const alias = stat => stat.isSymbolicLink() || stat.reparsePoint === true || typeof stat.reparseTag === 'number' && stat.reparseTag !== 0;
  const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
  const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const stamp = value => typeof value === 'string' && new Date(value).toISOString() === value;
  const listener = value => shape(value, 'host,port') && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535
    && ['127.0.0.1', '::1', 'localhost'].includes(value.host);
  const receiptShape = value => shape(value, 'base,dev,ino,name,sha256') && absolute(value.base) && value.name === NAME
    && SHA.test(value.sha256 || '') && /^\d{1,40}$/.test(value.dev || '') && /^\d{1,40}$/.test(value.ino || '');
  function validate(value) {
    try {
      return keys(value) === 'base,baseIdentity,childPid,createdAt,id,nonce,operation,parentPid,phase,schema,serve,updatedAt'
        && value.schema === 1 && absolute(value.base) && ID.test(value.id || '') && SHA.test(value.nonce || '')
        && ['enable', 'disable', 'export'].includes(value.operation) && PHASES.includes(value.phase)
        && Number.isSafeInteger(value.parentPid) && value.parentPid >= 1 && value.parentPid <= 0xffffffff
        && Number.isSafeInteger(value.childPid) && value.childPid >= 1 && value.childPid <= 0xffffffff
        && value.parentPid !== value.childPid && listener(value.serve)
        && shape(value.baseIdentity, 'dev,ino')
        && [value.baseIdentity.dev, value.baseIdentity.ino].every(item => typeof item === 'string' && /^\d{1,40}$/.test(item))
        && stamp(value.createdAt) && stamp(value.updatedAt) && value.updatedAt >= value.createdAt;
    } catch { return false; }
  }
  const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
  function decode(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > LIMIT) throw fail('claim_invalid');
    try {
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw fail('claim_invalid');
      const value = JSON.parse(text);
      if (!validate(value)) throw fail('claim_invalid');
      return freeze(value);
    } catch { throw fail('claim_invalid'); }
  }
  async function directory(root, missing = false) {
    const parsed = p.parse(root); let cursor = parsed.root; const rows = [];
    for (const part of ['', ...root.slice(parsed.root.length).split(p.sep).filter(Boolean)]) {
      if (part) cursor = p.join(cursor, part);
      let stat;
      try { stat = await io.lstat(cursor, { bigint: true }); }
      catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
      if (!stat.isDirectory() || alias(stat) || fold(await io.realpath(cursor)) !== fold(cursor)) throw fail('path_alias');
      rows.push({ path: cursor, ...identity(stat) });
    }
    return rows;
  }
  async function capture(file, maximum) {
    const before = await io.lstat(file, { bigint: true });
    if (!before.isFile() || alias(before) || before.nlink !== 1n || before.size > BigInt(maximum)) throw fail('claim_invalid');
    const handle = await io.open(file, 'r'), scratch = Buffer.alloc(65536), chunks = [];
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(identity(opened), identity(before)) || !opened.isFile() || opened.nlink !== 1n) throw fail('claim_changed');
      let used = 0;
      for (;;) {
        const part = await handle.read(scratch, 0, Math.min(scratch.length, maximum + 1 - used), null);
        if (!part.bytesRead) break;
        used += part.bytesRead;
        if (used > maximum) throw fail('claim_invalid');
        chunks.push(Buffer.from(scratch.subarray(0, part.bytesRead)));
      }
      const after = await handle.stat({ bigint: true }), visible = await io.lstat(file, { bigint: true });
      if (!sameIdentity(identity(after), identity(before)) || !sameIdentity(identity(visible), identity(before))
        || alias(visible) || after.nlink !== 1n || visible.nlink !== 1n || after.size !== before.size || visible.size !== before.size
        || used !== Number(before.size) || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || visible.mtimeNs !== after.mtimeNs || visible.ctimeNs !== after.ctimeNs) throw fail('claim_changed');
      const bytes = Buffer.concat(chunks, used);
      return { bytes, sha256: hash(bytes), size: used, identity: identity(after) };
    } finally { scratch.fill(0); for (const chunk of chunks) chunk.fill(0); await handle.close(); }
  }
  function create({ temp, flush, probe = pid => process.kill(pid, 0) } = {}) {
    if (!absolute(temp) || typeof flush !== 'function' || typeof probe !== 'function') throw fail('host_invalid');
    let mutating = false;
    const location = base => {
      if (!absolute(base)) throw fail('base_invalid');
      const root = p.join(temp, DIR + hash(Buffer.from(fold(base), 'utf8')));
      if (inside(base, root) || inside(root, base)) throw fail('base_invalid');
      return { base, root, file: p.join(root, NAME) };
    };
    const tempPresent = async () => { if (!await directory(temp, true)) throw fail('temp_invalid'); };
    const baseRow = async (base, expected) => {
      let rows;
      try { rows = await directory(base); }
      catch (error) { if (error?.code === 'ENOENT') throw fail('base_changed'); throw error; }
      const current = rows.at(-1);
      if (expected && !sameIdentity(current, expected)) throw fail('base_changed');
      return current;
    };
    async function current(loc) {
      let before;
      try { before = await io.lstat(loc.file, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!before.isFile() || alias(before) || before.nlink !== 1n || before.size > BigInt(LIMIT)) throw fail('claim_invalid');
      const captured = await capture(loc.file, LIMIT), value = decode(captured.bytes);
      if (value.base !== loc.base) throw fail('base_changed');
      return { value, captured };
    }
    const receipt = found => Object.freeze({ base: found.value.base, name: NAME, sha256: found.captured.sha256,
      dev: found.captured.identity.dev, ino: found.captured.identity.ino });
    async function inspect(observation = {}) {
      try {
        if (!shape(observation, 'base')) throw fail('observation_invalid');
        const loc = location(observation.base);
        await tempPresent();
        if (!await directory(loc.root, true)) return Object.freeze({ present: false });
        const names = await io.readdir(loc.root);
        if (names.some(name => fold(name).startsWith(STAGE))) throw fail('stage_pending');
        if (!names.some(name => fold(name) === NAME)) return Object.freeze({ present: false });
        const found = await current(loc);
        if (!found) throw fail('claim_changed');
        await baseRow(loc.base, found.value.baseIdentity);
        return Object.freeze({ present: true, value: found.value, receipt: receipt(found) });
      } catch (error) {
        if (String(error?.code || '').startsWith('work_data_claim.')) throw error;
        throw fail('inspect_failed', error);
      }
    }
    async function write(value, previous = null) {
      let bytes, selected, expected;
      try { bytes = Buffer.from(JSON.stringify(value)); selected = decode(bytes); expected = hash(bytes); }
      catch (error) { if (String(error?.code || '').startsWith('work_data_claim.')) throw error; throw fail('claim_invalid', error); }
      if (bytes.length > LIMIT) throw fail('claim_invalid');
      if (mutating) throw fail('busy');
      mutating = true;
      let stage = null;
      try {
        const loc = location(selected.base);
        await tempPresent();
        const observed = await inspect({ base: selected.base });
        if (previous === null) {
          if (observed.present) throw fail('claim_exists');
          if (selected.phase !== 'armed' || selected.createdAt !== selected.updatedAt) throw fail('phase_invalid');
        } else {
          if (!receiptShape(previous)) throw fail('receipt_invalid');
          if (!observed.present || previous.base !== selected.base) throw fail('claim_changed');
          if (observed.receipt.sha256 !== previous.sha256 || !sameIdentity(observed.receipt, previous)) throw fail('claim_changed');
          const prior = observed.value;
          if (prior.schema !== selected.schema || prior.base !== selected.base || prior.id !== selected.id
            || prior.nonce !== selected.nonce || prior.parentPid !== selected.parentPid || prior.childPid !== selected.childPid
            || prior.operation !== selected.operation || prior.createdAt !== selected.createdAt
            || prior.baseIdentity.dev !== selected.baseIdentity.dev || prior.baseIdentity.ino !== selected.baseIdentity.ino
            || prior.serve.host !== selected.serve.host || prior.serve.port !== selected.serve.port) throw fail('binding_changed');
          if (selected.updatedAt < prior.updatedAt) throw fail('phase_invalid');
          if (PHASES.indexOf(selected.phase) !== PHASES.indexOf(prior.phase) + 1) throw fail('phase_invalid');
        }
        await baseRow(loc.base, selected.baseIdentity);
        if (!await directory(loc.root, true)) { await io.mkdir(loc.root, { mode: 0o700 }); await directory(loc.root); }
        stage = p.join(loc.root, STAGE + c.randomBytes(24).toString('hex'));
        const handle = await io.open(stage, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await flush([loc.root, temp]);
        await baseRow(loc.base, selected.baseIdentity);
        const actual = await current(loc);
        if (previous === null) {
          if (actual) throw fail('claim_exists');
        } else if (!actual || actual.captured.sha256 !== previous.sha256 || !sameIdentity(actual.captured.identity, previous)) throw fail('claim_changed');
        await io.rename(stage, loc.file); stage = null;
        await flush([loc.root, temp]);
        const proof = await capture(loc.file, LIMIT);
        if (proof.sha256 !== expected) throw fail('claim_changed');
        return Object.freeze({ base: selected.base, name: NAME, sha256: proof.sha256, dev: proof.identity.dev, ino: proof.identity.ino });
      } catch (error) {
        if (String(error?.code || '').startsWith('work_data_claim.')) throw error;
        throw fail('write_failed', error);
      } finally { mutating = false; }
    }
    async function remove(value) {
      if (!receiptShape(value)) throw fail('receipt_invalid');
      if (mutating) throw fail('busy');
      mutating = true;
      try {
        const loc = location(value.base);
        await tempPresent();
        if (!await directory(loc.root, true)) return true;
        const names = await io.readdir(loc.root);
        if (names.some(name => fold(name).startsWith(STAGE))) throw fail('stage_pending');
        if (!names.some(name => fold(name) === NAME)) return true;
        const found = await current(loc);
        if (!found) throw fail('claim_changed');
        if (found.captured.sha256 !== value.sha256 || !sameIdentity(found.captured.identity, value)) throw fail('claim_changed');
        await baseRow(loc.base, found.value.baseIdentity);
        await io.unlink(loc.file);
        await flush([loc.root, temp]);
        try { await io.lstat(loc.file); }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
        throw fail('claim_changed');
      } catch (error) {
        if (String(error?.code || '').startsWith('work_data_claim.')) throw error;
        throw fail('remove_failed', error);
      } finally { mutating = false; }
    }
    const liveness = pid => {
      try { return probe(pid) === false ? 'dead' : 'alive'; }
      catch (error) { return error?.code === 'ESRCH' ? 'dead' : 'unknown'; }
    };
    async function classify(observation = {}) {
      const top = shape(observation, 'base,intent,result'), runtime = shape(observation, 'base,hasIntent,hasResult');
      if (!top && !runtime) throw fail('observation_invalid');
      const base = observation.base;
      const intent = top ? observation.intent : observation.hasIntent;
      const supplied = top ? observation.result : observation.hasResult;
      if (typeof intent !== 'boolean') throw fail('observation_invalid');
      // A completion result is the record itself, never a boolean or a bare
      // existence flag. Only a result bound to this exact claim can ever count.
      let result = null;
      if (supplied !== false && supplied !== null && supplied !== undefined) {
        if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw fail('observation_invalid');
        let id, operation;
        try { id = supplied.id; operation = supplied.operation; } catch { throw fail('observation_invalid'); }
        if (typeof id !== 'string' || typeof operation !== 'string') throw fail('observation_invalid');
        result = { id, operation };
      }
      const observed = await inspect({ base });
      if (!observed.present) return 'absent';
      // An existing intent stays with the ordinary intent_pending path; a claim
      // never authorizes its cleanup. Only an owned claim with a matching result
      // is complete. Committed with this job's result is an impossible ordering
      // and stays pending; a stale/other-job result is ignored so it cannot keep
      // a never-acquired attempt pending forever. Every owned claim without a
      // match remains pending: backup, rehearsal or mutation may have happened.
      if (intent) return 'pending';
      if (observed.value.phase === 'armed') return 'inert';
      const matches = result !== null && result.id === observed.value.id && result.operation === observed.value.operation;
      if (observed.value.phase === 'committed') {
        if (matches) return 'pending';
        return liveness(observed.value.childPid) === 'dead' ? 'inert' : 'pending';
      }
      if (matches) return 'complete';
      return 'pending';
    }
    return Object.freeze({ inspect, write, remove, classify });
  }
  return Object.freeze({ NAME, STAGE, LIMIT, validate, decode, create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
