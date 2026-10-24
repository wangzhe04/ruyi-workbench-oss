// The cold lifecycle's one pending intent. A private issued receipt is required
// for every update/removal. A failed or interrupted write never authorizes the
// next mutation; the next boot refuses before normal recovery/ensureDirs.
const WorkDataMaintenanceControl = ((fsApi, pathApi, cryptoApi) => {
  const NAME = 'maintenance-v1.json', STAGE = '.maintenance-v1.stage-', LIMIT = 32 * 1024;
  const hash = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const fail = (suffix, cause) => Object.assign(new Error('work_data_setup.' + suffix), {
    code: 'work_data_setup.' + suffix, apiCode: 'work_data_setup.' + suffix, statusCode: 409,
    retry: false, operationMayHaveExecuted: true, ...(cause !== undefined ? { cause } : {}),
  });
  async function directory(root, missing = false) {
    const absolute = pathApi.resolve(root), parsed = pathApi.parse(absolute);
    let current = parsed.root;
    for (const part of ['', ...absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean)]) {
      if (part) current = pathApi.join(current, part);
      let stat;
      try { stat = await fsApi.lstat(current); } catch (error) { if (missing && error.code === 'ENOENT') return false; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || fold(await fsApi.realpath(current)) !== fold(current)) throw fail('control_alias');
    }
    return true;
  }
  async function read(file) {
    const before = await fsApi.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(LIMIT)) throw fail('intent_invalid');
    const handle = await fsApi.open(file, 'r');
    try {
      const bytes = Buffer.alloc(LIMIT + 1); let used = 0;
      for (;;) {
        const result = await handle.read(bytes, used, bytes.length - used, null); used += result.bytesRead;
        if (used > LIMIT) throw fail('intent_invalid');
        if (!result.bytesRead) break;
      }
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw fail('intent_changed');
      return { bytes: bytes.subarray(0, used), identity: { dev: String(after.dev), ino: String(after.ino) } };
    } finally { await handle.close(); }
  }
  function stateValid(state) {
    return state && typeof state === 'object' && !Array.isArray(state)
      && Object.keys(state).sort().join(',') === 'backup,candidate,createdAt,expectedAuthority,id,operation,phase,schema'
      && state.schema === 1 && /^[a-f0-9]{48}$/.test(state.id || '')
      && ['enable', 'disable', 'restore'].includes(state.operation)
      && ['prepared', 'candidate', 'key-ready', 'published', 'complete'].includes(state.phase)
      && typeof state.createdAt === 'string' && new Date(state.createdAt).toISOString() === state.createdAt
      && state.backup && Object.keys(state.backup).sort().join(',') === 'path,sha256'
      && typeof state.backup.path === 'string' && pathApi.isAbsolute(state.backup.path)
      && /^[a-f0-9]{64}$/.test(state.backup.sha256 || '')
      && state.expectedAuthority && Object.keys(state.expectedAuthority).sort().join(',') === 'generation,id,mode,sha256'
      && Number.isSafeInteger(state.expectedAuthority.generation) && state.expectedAuthority.generation >= 0
      && (state.expectedAuthority.id === null || /^[a-f0-9]{48}$/.test(state.expectedAuthority.id))
      && ['plain', 'encrypted'].includes(state.expectedAuthority.mode)
      && (state.expectedAuthority.sha256 === null || /^[a-f0-9]{64}$/.test(state.expectedAuthority.sha256))
      && (state.candidate === null || state.candidate && Object.keys(state.candidate).sort().join(',') === 'headerSha256,id,mode'
        && /^[a-f0-9]{48}$/.test(state.candidate.id || '') && ['plain', 'encrypted'].includes(state.candidate.mode)
        && (state.candidate.headerSha256 === null || /^[a-f0-9]{64}$/.test(state.candidate.headerSha256)));
  }
  function create({ base, ownership, assertExclusive, assertDurableBackup, flush }) {
    if (typeof base !== 'string' || !pathApi.isAbsolute(base) || pathApi.resolve(base) !== base
      || typeof assertExclusive !== 'function' || typeof assertDurableBackup !== 'function'
      || typeof flush !== 'function') throw fail('control_host_invalid');
    const root = pathApi.join(base, '.work-data'), file = pathApi.join(root, NAME), issued = new WeakMap();
    let writing = false;
    async function admission() {
      if (!ownership || !Array.isArray(ownership.roots) || !ownership.roots.some(value => fold(value) === fold(base))
        || await assertExclusive(ownership) !== true) throw fail('ownership_required');
      await directory(base);
    }
    async function inspect() {
      await admission(); if (!await directory(root, true)) return Object.freeze({ pending: false });
      const names = await fsApi.readdir(root);
      if (names.some(name => fold(name).startsWith(STAGE))) throw fail('intent_stage_pending');
      if (!names.some(name => fold(name) === NAME)) return Object.freeze({ pending: false });
      const captured = await read(file); let state;
      try {
        const text = captured.bytes.toString('utf8'); if (!Buffer.from(text).equals(captured.bytes)) throw fail('intent_invalid');
        state = JSON.parse(text); if (!stateValid(state)) throw fail('intent_invalid');
      } catch (cause) { throw fail('intent_invalid', cause); }
      return Object.freeze({ pending: true, id: state.id, operation: state.operation, phase: state.phase,
        backupPath: state.backup.path, sha256: hash(captured.bytes) });
    }
    async function verify(receipt) {
      const known = issued.get(receipt); if (!known) throw fail('intent_receipt_invalid');
      await admission(); await directory(root); const captured = await read(file);
      if (hash(captured.bytes) !== known.sha256 || captured.identity.dev !== known.identity.dev
        || captured.identity.ino !== known.identity.ino) throw fail('intent_changed');
      return receipt;
    }
    async function write(state, previous = null) {
      let serialized, selected;
      try { serialized = JSON.stringify(state); selected = JSON.parse(serialized); if (!stateValid(selected)) throw fail('intent_invalid'); }
      catch (cause) { throw fail('intent_invalid', cause); }
      if (Buffer.byteLength(serialized) > LIMIT) throw fail('intent_invalid');
      if (writing) throw fail('intent_busy'); writing = true;
      let stage;
      try {
        await admission();
        const observed = await inspect();
        if (await assertDurableBackup(JSON.parse(serialized).backup) !== true) throw fail('backup_unverified');
        if (previous) {
          await verify(previous); const prior = issued.get(previous), next = JSON.parse(serialized);
          for (const key of ['schema', 'id', 'operation', 'createdAt', 'expectedAuthority', 'backup'])
            if (JSON.stringify(prior.state[key]) !== JSON.stringify(next[key])) throw fail('intent_binding_changed');
          const order = ['prepared', 'candidate', 'key-ready', 'published', 'complete'];
          const difference = order.indexOf(next.phase) - order.indexOf(prior.state.phase);
          if (difference < 0 || difference > 1) throw fail('intent_phase_invalid');
          if (prior.state.candidate && (!next.candidate || prior.state.candidate.id !== next.candidate.id
            || prior.state.candidate.mode !== next.candidate.mode
            || prior.state.candidate.headerSha256 !== null && prior.state.candidate.headerSha256 !== next.candidate.headerSha256)) throw fail('intent_binding_changed');
        }
        else {
          if (selected.phase !== 'prepared' || selected.candidate !== null) throw fail('intent_phase_invalid');
          if (observed.pending) throw fail('intent_pending');
        }
        if (selected.phase !== 'prepared' && selected.candidate === null
          || ['key-ready', 'published', 'complete'].includes(selected.phase)
            && selected.candidate?.mode === 'encrypted' && !selected.candidate.headerSha256) throw fail('intent_phase_invalid');
        if (!await directory(root, true)) await fsApi.mkdir(root, { mode: 0o700 });
        await directory(root);
        stage = pathApi.join(root, STAGE + cryptoApi.randomBytes(24).toString('hex'));
        const handle = await fsApi.open(stage, 'wx', 0o600);
        try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        await flush([root, base]); await admission();
        if (previous) await verify(previous);
        else { try { await fsApi.lstat(file); throw fail('intent_pending'); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        await fsApi.rename(stage, file); stage = null;
        await flush([root, base]);
        const captured = await read(file);
        if (hash(captured.bytes) !== hash(Buffer.from(serialized))) throw fail('intent_changed');
        const receipt = Object.freeze({ name: '.work-data/' + NAME, sha256: hash(captured.bytes),
          identity: Object.freeze(captured.identity), id: selected.id, phase: selected.phase });
        issued.set(receipt, { ...receipt, state: JSON.parse(serialized) }); return receipt;
      } catch (cause) {
        // Retain a staged/selected intent on every uncertainty. Normal boot sees
        // either name and refuses; no data mutation follows a failed write.
        throw fail('intent_write_failed', cause);
      } finally { writing = false; }
    }
    async function finish(receipt, verifyPublished) {
      if (writing) throw fail('intent_busy'); writing = true;
      try {
        await inspect();
        const current = await verify(receipt);
        if (current.phase !== 'complete' || issued.get(receipt).state.phase !== 'complete'
          || typeof verifyPublished !== 'function' || await verifyPublished() !== true) throw fail('completion_unverified');
        await verify(receipt); await fsApi.unlink(file); await flush([root, base]); issued.delete(receipt);
      } finally { writing = false; }
    }
    return Object.freeze({ inspect, write, verify, finish });
  }
  return Object.freeze({ create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
