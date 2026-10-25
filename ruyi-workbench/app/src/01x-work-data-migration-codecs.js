// Codec bridge only. The host owns a frozen source, a new shadow, domain/crash
// reconciliation and the lifecycle gate. Byte proofs are not a cross-process CAS.
// No source repair, quarantine, sanitization, retirement or active switch occurs here.
const WorkDataMigrationCodecs = ((fsApi, pathApi, cryptoApi, zlibApi, Decoder) => {
  const MAX_LOGICAL = 256 * 1024 * 1024, DEFAULT_PHYSICAL = 512 * 1024 * 1024;
  const fail = (suffix, details = {}) => { throw Object.assign(new Error('work_data_migration.' + suffix), {
    code: 'work_data_migration.' + suffix, apiCode: 'work_data_migration.' + suffix, statusCode: 409, ...details,
  }); };
  const hash = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const nativeIdentity = name => process.platform === 'win32' ? name.toLowerCase() : name;
  const reserved = new Set(['index', 'con', 'prn', 'aux', 'nul',
    ...Array.from({ length: 9 }, (_, n) => 'com' + (n + 1)), ...Array.from({ length: 9 }, (_, n) => 'lpt' + (n + 1))]);
  const safeId = value => /^[A-Za-z0-9_-]{1,64}$/.test(value) && !value.startsWith('_') && !reserved.has(value.toLowerCase());
  const shortId = '([A-Za-z0-9_-]{1,64})', project = '([a-f0-9]{16})';
  const entries = [];
  const define = (family, codec, purpose, pattern, bind, options = {}) => {
    entries.push(Object.freeze({ family, codec, purpose, pattern, bind, ...options }));
  };
  const text = (family, purpose, pattern, scopeId, recordId, options = {}) => define(family, 'text', purpose,
    pattern, match => ({ scopeId: typeof scopeId === 'function' ? scopeId(match) : scopeId,
      recordId: typeof recordId === 'function' ? recordId(match) : recordId }), options);
  const session = (family, suffix, kind) => define(family, 'session-records', 'session',
    new RegExp('^sessions/' + shortId + '\\.' + suffix + '\\.ndjson$'), match => ({ scopeId: match[1], kind }), { sessionId: true });
  // Specific patterns precede generic session head names. Bindings come from actual
  // owner factories, never from an envelope or caller-supplied purpose/record ID.
  text('session-index', 'session', /^sessions\/index\.json$/, 'sessions', 'session-index', { chunked: true, shape: 'array' });
  text('session-search-index', 'search-index', /^sessions\/_search-index-v1\.json$/, 'global', 'session-search-index', { chunked: true });
  // Fulltext payload format/normalizer revisions do not change the owner's Store schema/AAD.
  text('session-fulltext-state', 'search-index', /^sessions\/_fulltext-index-v1\/state\.json$/, 'sessions', 'fulltext-index:state', { chunked: true, maxPlaintextBytes: 1024 });
  text('session-fulltext-manifest', 'search-index', new RegExp('^sessions/_fulltext-index-v1/' + shortId + '/manifest\\.json$'),
    'sessions', m => 'fulltext-index:' + m[1] + ':manifest', { chunked: true, sessionId: true, maxPlaintextBytes: 4 * 1024 * 1024 });
  text('session-fulltext-shard', 'search-index', new RegExp('^sessions/_fulltext-index-v1/' + shortId + '/([a-f0-9]{32})\\.(0|[1-9][0-9]*)\\.json$'),
    'sessions', m => 'fulltext-index:' + m[1] + ':' + nativeIdentity(m[2]) + '.' + m[3], { chunked: true, sessionId: true, maxPlaintextBytes: 256 * 1024 });
  text('pretender-index', 'search-index', /^sessions\/\.pretender\/projection-index\.json$/, 'global', 'pretender-index', { chunked: true });
  session('session-messages', 'messages', 'messages'); session('session-provider', 'provider', 'provider');
  session('session-interventions', 'interventions', 'interventions'); session('session-changes', 'changes', 'changes');
  text('session-scratchpad', 'session', new RegExp('^sessions/' + shortId + '\\.scratchpad\\.json$'), 'sessions', m => m[1], { sessionId: true });
  text('session-v1-backup', 'session', new RegExp('^sessions/' + shortId + '\\.json\\.v1bak$'), m => m[1], 'session-v1-backup', { chunked: true, sessionId: true });
  text('background-job-ledger', 'task', new RegExp('^sessions/background-jobs/' + shortId + '\\.json$'), m => m[1], 'background-job-ledger', { chunked: true, shape: 'array', sessionId: true });
  text('session-head', 'session', new RegExp('^sessions/' + shortId + '\\.json$'), 'sessions', m => m[1], { schema: 2, sessionId: true });
  text('journal-index', 'session', new RegExp('^checkpoints/' + shortId + '/index\\.json$'), m => m[1], 'journal-index', { chunked: true, shape: 'array', sessionId: true });
  text('journal-reverts', 'session', new RegExp('^checkpoints/' + shortId + '/reverts\\.json$'), m => m[1], 'journal-reverts', { chunked: true, sessionId: true });
  define('journal-history', 'gzip', 'session', new RegExp('^checkpoints/' + shortId + '/(\\d+-\\d+\\.gz|history-\\d+(?:-[a-f0-9]{16})?\\.json\\.gz)$'),
    m => ({ scopeId: m[1], recordId: m[2] }), { sessionId: true });
  text('mission-container', 'task', new RegExp('^missions/' + shortId + '\\.json$'), m => m[1], 'mission-container', { chunked: true });
  text('memory-usage', 'memory', /^memory\/_usage-v1\.json$/, 'global', 'memory-usage');
  text('agent-instructions-import', 'memory', /^memory\/\.agent-instructions-import-v1\.json$/, 'global', 'agent-instructions-import');
  text('memory-proposals', 'memory', new RegExp('^memory/proposals/' + shortId + '\\.json$'), m => m[1], 'memory-proposals', { sessionId: true });
  text('memory-meta', 'memory', new RegExp('^memory/project/' + project + '/meta\\.json$'), m => 'project:' + nativeIdentity(m[1]), 'memory-meta');
  text('memory-relations', 'memory', new RegExp('^memory/(global|project/' + project + ')/_relations\\.json$'),
    m => nativeIdentity(m[1]) === 'global' ? 'global' : 'project:' + nativeIdentity(m[2]), 'memory-relations', { shape: 'array' });
  text('memory-body', 'memory', new RegExp('^memory/(global|project/' + project + ')/' + shortId + '\\.md$'),
    m => nativeIdentity(m[1]) === 'global' ? 'global' : 'project:' + nativeIdentity(m[2]), m => 'memory:' + m[3], { chunked: true, markdown: true });
  text('engine-transcript-index', 'cache', /^engine-transcripts\.json$/, 'global', 'engine-transcript-index');
  text('voice-lexicon', 'user-config', /^voice-lexicon\.json$/, 'global', 'voice-lexicon');
  text('steward-memory', 'memory', /^steward\/memory-v1\.json$/, 'global', 'steward-memory');
  text('steward-cursor', 'queue', /^steward\/cursor-v1\.json$/, 'global', 'steward-cursor');
  text('steward-visits', 'memory', /^steward\/visits\/([^/]+\.json)$/, 'steward', m => 'visit:' + hash(nativeIdentity(m[1])), { chunked: true });
  text('scheduler-tasks', 'task', /^scheduler\/tasks-v1\.json$/, 'scheduler', 'scheduler-tasks', { chunked: true });
  text('external-bots', 'queue', /^external-bots\/state-v1\.json$/, 'global', 'external-bots:state-v1', { chunked: true });
  text('personal-workflows', 'workflow', /^agent-workflows\/([^/]+\.json)$/, 'global', m => 'workflow:' + hash(nativeIdentity(m[1])), { chunked: true });
  text('playbooks', 'workflow', /^playbooks\/([^/]+\.json)$/, 'user', m => 'playbook:' + hash(m[1]), { chunked: true });
  text('web-cache', 'cache', /^webcache\/([a-f0-9]{64})\.json$/, 'global', m => 'web-cache:' + nativeIdentity(m[1]), { chunked: true });
  text('proxy-models-cache', 'cache', /^proxy-models-cache\.json$/, 'global', 'proxy-models-cache', { chunked: true });
  text('migration-log', 'migration', /^migrations\/([0-9TZ-]+)\.json$/, 'global', m => 'migration-log:' + m[1], { chunked: true });
  text('skill-import-record', 'backup', new RegExp('^skills/' + shortId + '/\\.ruyi-import\\.json$'), 'skills', m => 'skill-import:' + nativeIdentity(m[1]), { chunked: true });
  const aux = (family, purpose, pattern, binding, options = {}) => define(family, 'aux-records', purpose, pattern,
    match => ({ ...binding(match), kind: family }), options);
  aux('steward-inbox', 'queue', /^steward\/inbox-v1\.ndjson$/, () => ({ scopeId: 'steward' }));
  aux('steward-decisions', 'queue', /^steward\/decisions-v1\.ndjson$/, () => ({ scopeId: 'steward' }));
  aux('scheduler-fires', 'task', /^scheduler\/fires-v1\.ndjson$/, () => ({ scopeId: 'scheduler-global' }));
  aux('audit-log', 'audit', /^logs\/workbench-(\d{4}-\d{2}-\d{2})\.ndjson$/, m => ({ scopeId: m[1] }));
  define('agent-run-events', 'aux-records', 'task', new RegExp('^agent-runs/' + shortId + '/' + shortId + '\\.events\\.ndjson(\\.gz)?$'),
    m => ({ scopeId: m[1], runId: m[2], kind: 'agent-run-events', archive: !!m[3], recordId: 'agent-run-events-archive:' + m[2] }), { sessionId: true });
  text('agent-run-snapshot', 'task', new RegExp('^agent-runs/' + shortId + '/' + shortId + '\\.json$'),
    m => m[1], m => 'agent-run:' + m[2], { chunked: true, sessionId: true });
  define('migration-skill-backups', 'special-owner-required', 'backup', /^migrations\/skill-backups(?:\/|$)/,
    () => ({}), { reason: 'original-ntfs-object-capsule' });
  const catalog = () => Object.freeze(entries.map(value => Object.freeze({ family: value.family, purpose: value.purpose,
    codec: value.codec, support: value.codec === 'special-owner-required' ? 'special-owner-required' : 'codec-only',
    domainValidation: 'host-owner-required' })));
  function relativePath(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/')
      || value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) fail('path_invalid');
    return value;
  }
  function describe(relative) {
    relativePath(relative);
    if (/(?:\.prevbody|\.corrupt(?:[-.]|$)|\.tmp(?:[.-]|$)|\.sealed-stage-|\.work-data-stage-|\.migration-codec-)/.test(nativeIdentity(relative)))
      return Object.freeze({ family: null, codec: 'special-owner-required', reason: 'retained-or-uncommitted-owner-artifact' });
    for (const entry of entries) {
      const match = new RegExp(entry.pattern.source, process.platform === 'win32' ? 'i' : '').exec(relative); if (!match) continue;
      if (entry.sessionId && !safeId(match[1])) fail('path_invalid');
      if (nativeIdentity(relative).startsWith('agent-runs/') && !safeId(match[2])) fail('path_invalid');
      return Object.freeze({ family: entry.family, codec: entry.codec, purpose: entry.purpose,
        schema: entry.schema || (entry.codec === 'session-records' ? 2 : 1), chunked: entry.chunked === true, shape: entry.shape || 'object',
        markdown: entry.markdown === true, ...entry.bind(match), ...(entry.maxPlaintextBytes ? { maxPlaintextBytes: entry.maxPlaintextBytes } : {}), ...(entry.reason ? { reason: entry.reason } : {}) });
    }
    if (/^sessions\/_fulltext-index-v1(?:\/|$)/.test(nativeIdentity(relative)))
      return Object.freeze({ family: null, codec: 'special-owner-required', reason: 'fulltext-owned-namespace-artifact' });
    fail('path_unmapped');
  }
  const nativeKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  function describeRetained(relative) {
    relativePath(relative);
    // Only the session owner's two physical body snapshots have this binding.
    // Other .prev/.bak/stage names require their own owner, never caller metadata.
    if (!new RegExp('^sessions/' + shortId + '\\.(messages|provider)\\.ndjson\\.prevbody$', process.platform === 'win32' ? 'i' : '').test(relative))
      fail('special_owner_required', { reason: 'retained-owner-unmapped' });
    const canonical = relative.slice(0, -'.prevbody'.length), descriptor = describe(canonical);
    return Object.freeze({ ...descriptor, canonical, retainedSuffix: '.prevbody' });
  }
  async function realDirectory(value) {
    const absolute = pathApi.resolve(value), parsed = pathApi.parse(absolute); let cursor = parsed.root;
    for (const part of ['', ...absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean)]) {
      if (part) cursor = pathApi.join(cursor, part);
      const stat = await fsApi.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || nativeKey(pathApi.resolve(await fsApi.realpath(cursor))) !== nativeKey(pathApi.resolve(cursor))) fail('path_alias');
    }
  }
  const utf8 = bytes => {
    try { const textValue = new Decoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (!Buffer.from(textValue, 'utf8').equals(bytes)) fail('utf8_invalid'); return textValue;
    } catch (cause) { if (cause?.code === 'work_data_migration.utf8_invalid') throw cause; fail('utf8_invalid'); }
  };
  function create({ sourceRoot, targetRoot, sourceKeys, targetKeys, writeJson,
    maxLogicalBytes = MAX_LOGICAL, maxPhysicalBytes = DEFAULT_PHYSICAL } = {}) {
    if (![sourceRoot, targetRoot].every(value => typeof value === 'string' && pathApi.isAbsolute(value))
      || typeof writeJson !== 'function') fail('host_invalid');
    if (!Number.isSafeInteger(maxLogicalBytes) || maxLogicalBytes < 1 || maxLogicalBytes > MAX_LOGICAL
      || !Number.isSafeInteger(maxPhysicalBytes) || maxPhysicalBytes < 1 || maxPhysicalBytes > 1024 * 1024 * 1024) fail('engineering_limit_invalid');
    const source = pathApi.resolve(sourceRoot), target = pathApi.resolve(targetRoot);
    if (nativeKey(source) === nativeKey(target)) fail('path_alias');
    const activeTargets = new Set();
    async function readPhysical(file) {
      await realDirectory(pathApi.dirname(file));
      const stat = await fsApi.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('path_alias');
      const handle = await fsApi.open(file, 'r');
      try {
        const parts = []; let total = 0; const block = Buffer.alloc(64 * 1024);
        for (;;) {
          const { bytesRead } = await handle.read(block, 0, Math.min(block.length, maxPhysicalBytes - total + 1), null);
          if (!bytesRead) break;
          total += bytesRead; if (total > maxPhysicalBytes) fail('engineering_limit');
          parts.push(Buffer.from(block.subarray(0, bytesRead)));
        }
        return Buffer.concat(parts, total);
      } finally { await handle.close(); }
    }
    async function absent(file) {
      try { await fsApi.lstat(file); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
      fail('target_exists');
    }
    async function parents(file) {
      const segments = pathApi.relative(target, pathApi.dirname(file)).split(pathApi.sep).filter(Boolean);
      let cursor = target; await realDirectory(cursor);
      for (const part of segments) {
        cursor = pathApi.join(cursor, part);
        try { await fsApi.mkdir(cursor); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
        await realDirectory(cursor);
      }
    }
    const logicalLimit = (bytes, maximum = maxLogicalBytes) => { if (bytes.length > maximum) fail('engineering_limit'); return bytes; };
    const validateText = (descriptor, value) => {
      const bytes = logicalLimit(Buffer.from(value, 'utf8'), Math.min(maxLogicalBytes, descriptor.maxPlaintextBytes || maxLogicalBytes));
      if (descriptor.markdown) return bytes;
      let data; try { data = JSON.parse(value.replace(/^\uFEFF/, '')); } catch { fail('special_owner_required', { reason: 'invalid-legacy-json' }); }
      if (!data || typeof data !== 'object' || (descriptor.shape === 'array' ? !Array.isArray(data) : Array.isArray(data)))
        fail('special_owner_required', { reason: 'invalid-legacy-shape' });
      return bytes;
    };
    async function transform({ relative, targetMode } = {}, retained = false, readOnly = false) {
      const descriptor = retained ? describeRetained(relative) : describe(relative);
      if (descriptor.codec === 'special-owner-required') fail('special_owner_required', { family: descriptor.family, reason: descriptor.reason });
      if (targetMode !== 'plain' && targetMode !== 'encrypted') fail('mode_invalid');
      const input = pathApi.join(source, ...relative.split('/')), output = pathApi.join(target, ...relative.split('/'));
      if (activeTargets.has(output)) fail('target_busy');
      activeTargets.add(output);
      let oldLease, newLease, stage, published = false, failed = false;
      const ownedBuffers = [];
      const credential = async which => {
        const keys = which === 'source' ? sourceKeys : targetKeys;
        if (!keys || !(typeof keys.snapshot === 'function'
          || typeof keys.unlock === 'function' && typeof keys.instance === 'function')) fail('keys_required');
        if (which === 'source') return oldLease || (oldLease = await WorkDataStore.acquireSnapshot(keys));
        return newLease || (newLease = await WorkDataStore.acquireSnapshot(keys));
      };
      const borrowed = which => ({ snapshot: async () => {
        const lease = await credential(which); return { key: lease.key, instanceId: lease.instanceId, release: () => {} };
      } });
      const textStore = (file, which, enabled, metadata = {}) => WorkDataStore.createText({
        file: () => file, purpose: descriptor.purpose, schema: descriptor.schema, scopeId: descriptor.scopeId,
        recordId: descriptor.recordId, chunked: descriptor.chunked, maxPlaintextBytes: Math.min(maxLogicalBytes, descriptor.maxPlaintextBytes || maxLogicalBytes),
        ...(descriptor.markdown ? { legacyText: 'markdown' } : {}), keys: borrowed(which), enabled: () => enabled, writeJson,
        validateSealedText: () => { metadata.authenticated = true; return true; },
      });
      const binaryStore = (file, which, enabled, metadata = {}) => WorkDataStore.createBinary({
        file: () => file, purpose: descriptor.purpose, schema: 1, scopeId: descriptor.scopeId, recordId: descriptor.recordId,
        chunked: true, maxPlaintextBytes: maxLogicalBytes,
        maxBinaryBytes: descriptor.archive ? Math.min(maxLogicalBytes, 192 * 1024 * 1024 - 1024) : maxLogicalBytes,
        keys: borrowed(which), enabled: () => enabled, writeJson,
        validateLegacyBinary: (bytes, context) => {
          zlibApi.gunzipSync(bytes, { maxOutputLength: maxLogicalBytes });
          if (context?.sealed === true) metadata.authenticated = true; return true;
        },
      });
      async function records(bytes, which) {
        const raw = utf8(bytes);
        if (!raw) return { rows: [], logical: Buffer.alloc(0), authenticated: 0 };
        if (!raw.endsWith('\n')) fail('special_owner_required', { reason: 'uncommitted-or-no-lf-tail' });
        const rows = raw.slice(0, -1).split('\n'), plain = []; let authenticated = 0;
        for (let ordinal = 0; ordinal < rows.length; ordinal++) {
          const row = rows[ordinal];
          if (!row.trim()) fail('special_owner_required', { reason: 'blank-physical-row' });
          const probe = WorkDataRecords.lineProbe(); probe.feed(Buffer.from(row));
          let value = row;
          if (probe.reserved()) {
            const lease = await credential(which), context = { instanceId: lease.instanceId,
              sessionId: descriptor.scopeId, kind: descriptor.kind, runId: descriptor.runId, ordinal };
            value = descriptor.codec === 'session-records' ? WorkDataRecords.decodeLine(row, lease.key, context)
              : await WorkDataRecords.decodeRecordLine(row, lease.key, context, maxLogicalBytes);
            authenticated++;
          }
          let data; try { data = JSON.parse(value); } catch { fail('special_owner_required', { reason: 'invalid-legacy-row' }); }
          if (!data || typeof data !== 'object' || Array.isArray(data)) fail('special_owner_required', { reason: 'invalid-legacy-row' });
          plain.push(value);
        }
        return { rows: plain, logical: logicalLimit(Buffer.from(plain.join('\n') + '\n')), authenticated };
      }
      const encodedRows = (rows, enabled) => async function* () {
        for (let ordinal = 0; ordinal < rows.length; ordinal++) {
          if (!enabled) { yield rows[ordinal] + '\n'; continue; }
          const lease = await credential('target'), context = { instanceId: lease.instanceId,
            sessionId: descriptor.scopeId, kind: descriptor.kind, runId: descriptor.runId, ordinal };
          if (descriptor.codec === 'session-records') { yield WorkDataRecords.encodeLine(rows[ordinal], lease.key, context) + '\n'; continue; }
          const factory = WorkDataRecords.encodeRecordFactory(rows[ordinal], lease.key, context, maxLogicalBytes);
          try { yield* factory(); } finally { factory.dispose(); }
        }
      };
      try {
        await realDirectory(source); if (!readOnly) { await realDirectory(target); await absent(output); }
        const original = await readPhysical(input); ownedBuffers.push(original);
        const sourcePhysicalHash = hash(original), enabled = targetMode === 'encrypted';
        let logical, rowData, binary; const readMetadata = {};
        if (descriptor.codec === 'text') {
          utf8(original); logical = validateText(descriptor, await textStore(input, 'source', false, readMetadata).read());
        } else if (descriptor.codec === 'gzip' || descriptor.archive) {
          // Valid gzip is binary, never UTF8-probed for a coincidental marker.
          if (!(original[0] === 31 && original[1] === 139 && original[2] === 8)) utf8(original);
          binary = await binaryStore(input, 'source', false, readMetadata).read(); ownedBuffers.push(binary);
          if (descriptor.archive) {
            const inner = zlibApi.gunzipSync(binary, { maxOutputLength: maxLogicalBytes }); ownedBuffers.push(inner);
            rowData = await records(inner, 'source'); logical = rowData.logical;
          } else logical = logicalLimit(binary);
        } else { rowData = await records(original, 'source'); logical = rowData.logical; }
        ownedBuffers.push(logical);
        if (readOnly) {
          if (descriptor.codec === 'text' || descriptor.codec === 'gzip' || descriptor.archive) {
            if ((readMetadata.authenticated === true) !== enabled) fail('verification_failed');
          }
          if (rowData && rowData.authenticated !== (enabled ? rowData.rows.length : 0)) fail('verification_failed');
          return Object.freeze({ family: descriptor.family, logicalHash: hash(logical), logicalBytes: logical.length,
            physicalHash: sourcePhysicalHash, readOnly: true });
        }
        await parents(output); await absent(output);
        stage = pathApi.join(pathApi.dirname(output), '.migration-codec-' + cryptoApi.randomBytes(24).toString('hex') + '.stage');
        const reservation = await fsApi.open(stage, 'wx', 0o600); await reservation.close();
        if (descriptor.codec === 'text') await textStore(stage, 'target', enabled).write(utf8(logical));
        else if (descriptor.archive) {
          const parts = []; let size = 0;
          for await (const part of encodedRows(rowData.rows, enabled)()) {
            const bytes = Buffer.from(part); size += bytes.length; if (size > maxPhysicalBytes) fail('engineering_limit'); parts.push(bytes);
          }
          const inner = Buffer.concat(parts, size); ownedBuffers.push(inner);
          const gzip = zlibApi.gzipSync(inner); ownedBuffers.push(gzip);
          await binaryStore(stage, 'target', enabled).write(gzip);
        } else if (descriptor.codec === 'gzip') await binaryStore(stage, 'target', enabled).write(binary);
        else await writeJson(stage, encodedRows(rowData.rows, enabled), { stream: true, mode: 0o600 });
        let verified; const verification = {};
        const verifyRows = result => {
          if (result.authenticated !== (enabled ? result.rows.length : 0)) fail('verification_failed'); return result.logical;
        };
        if (descriptor.codec === 'text') {
          verified = validateText(descriptor, await textStore(stage, 'target', enabled, verification).read());
          if ((verification.authenticated === true) !== enabled) fail('verification_failed');
        }
        else if (descriptor.codec === 'gzip' || descriptor.archive) {
          const bytes = await binaryStore(stage, 'target', enabled, verification).read(); ownedBuffers.push(bytes);
          if ((verification.authenticated === true) !== enabled) fail('verification_failed');
          if (descriptor.archive) {
            const inner = zlibApi.gunzipSync(bytes, { maxOutputLength: maxLogicalBytes }); ownedBuffers.push(inner);
            verified = verifyRows(await records(inner, 'target'));
          } else verified = bytes;
        } else {
          const bytes = await readPhysical(stage); ownedBuffers.push(bytes); verified = verifyRows(await records(bytes, 'target'));
        }
        ownedBuffers.push(verified);
        if (!logical.equals(verified)) fail('verification_failed');
        const stagedBytes = await readPhysical(stage); ownedBuffers.push(stagedBytes);
        const current = await readPhysical(input); ownedBuffers.push(current);
        if (hash(current) !== sourcePhysicalHash) fail('source_changed');
        await realDirectory(pathApi.dirname(output));
        // Exclusive hard-link publication cannot overwrite a raced existing file.
        // Unsupported filesystems refuse; there is no rename-overwrite fallback.
        await fsApi.link(stage, output); published = true;
        const finalBytes = await readPhysical(output); ownedBuffers.push(finalBytes);
        if (!finalBytes.equals(stagedBytes)) fail('verification_failed');
        await fsApi.unlink(stage); stage = null;
        return Object.freeze({ family: descriptor.family, codec: descriptor.archive ? 'nested-gzip-journal' : descriptor.codec,
          targetMode, logicalBytes: logical.length, logicalHash: hash(logical), sourcePhysicalHash,
          targetPhysicalHash: hash(finalBytes), domainValidation: 'host-owner-required' });
      } catch (cause) {
        failed = true;
        if (String(cause?.code || '').startsWith('work_data')) {
          const wrapped = new Error(String(cause.code));
          throw Object.assign(wrapped, { code: cause.code, apiCode: cause.apiCode || cause.code, statusCode: cause.statusCode || 409,
            ...(typeof cause.reason === 'string' ? { reason: cause.reason } : {}),
            cause, ...(stage ? { retainedStage: stage } : {}), targetRetained: published });
        }
        fail('io_failed', { cause, ...(stage ? { retainedStage: stage } : {}), targetRetained: published });
      } finally {
        activeTargets.delete(output);
        for (const bytes of ownedBuffers) if (Buffer.isBuffer(bytes)) bytes.fill(0);
        const releases = await Promise.allSettled([oldLease, newLease].filter(Boolean).map(lease => Promise.resolve().then(() => lease.release())));
        if (!failed && releases.some(result => result.status === 'rejected')) fail('key_release_failed', { targetRetained: published });
      }
    }
    return Object.freeze({ describe, describeRetained, catalog, transform: options => transform(options), transformRetained: options => transform(options, true), verify: options => transform(options, false, true), verifyRetained: options => transform(options, true, true) });
  }
  return Object.freeze({ create, describe, describeRetained, catalog });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'), require('node:zlib'), require('node:util').TextDecoder);
