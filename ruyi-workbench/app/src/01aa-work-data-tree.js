// Complete byte census for a quiesced, owner-held tree. No repair, filtering,
// publication or domain-validation claims. The host owns native metadata and
// portable conversions (notably original-object skill capsules) separately.
// rootScope below is a separate, pure data-root content policy: the census
// itself never consults it, so every proof/digest still covers every object.
const WorkDataTree = ((fsApi, pathApi, cryptoApi) => {
  const fail = (suffix, details = {}) => { throw Object.assign(new Error('work_data_tree.' + suffix), {
    code: 'work_data_tree.' + suffix, apiCode: 'work_data_tree.' + suffix, statusCode: 409, ...details,
  }); };
  // One engineering budget for a preserved native census of a whole data root
  // (the 13u broker applies it to data-root censuses; skill-backup capsule
  // captures keep their own 10,000-entry / 96,000,000-byte capsule caps).
  // It replaces the former fixed 10,000-entry / 96,000,000-byte whole-root cap:
  //   files / directories  each at most 100,000 (01aa reader limits);
  //   entries        files + directories + root (200,001);
  //   bytes          all default + named DATA streams, 120 MiB. Its base64 is
  //                  160 MiB, leaving about 79 MiB of the 239 MiB reply budget
  //                  (transportBytes minus 1 MiB) for metadata: enough for about
  //                  100,000 files with short ASCII paths at ~800 bytes each.
  //                  Larger metadata mixes stop with the typed 'transport'
  //                  limit; the census never reaches a capsule (capsule
  //                  captures keep 96,000,000 bytes / 10,000 entries);
  //   fileBytes      one stream (96,000,000, the capsule per-file cap);
  //   transportBytes one broker response line in UTF-8 bytes: 13u
  //                  MIGRATION_CAPSULE_ARCHIVE_LIMIT counts bytes; the C#
  //                  pre-serialisation estimate counts escaped/non-ASCII
  //                  characters at 6 bytes and MaxJsonLength (chars) equals it;
  //   depth          path segments below the census root (the broker's 256).
  // The census still covers the whole root (proofs stay complete), so trees the
  // package omits (webcache, worktrees, retired generations) count here too.
  const NATIVE_BUDGET = Object.freeze({ files: 100000, directories: 100000, entries: 200001,
    bytes: 120 * 1024 * 1024, fileBytes: 96000000, transportBytes: 240 * 1024 * 1024, depth: 256 });
  // Product-owned top-level names an over-budget report may name; any other
  // top-level name (user-created, possibly private) is reported as 'other'.
  // Inside a generation namespace the logical top-level name is used.
  const AREA_NAMES = Object.freeze(['sessions', 'uploads', 'logs', 'generated', 'checkpoints', 'playbooks', 'skills', 'webcache',
    'agent-runs', 'agent-workflows', 'agent-worktrees', 'usage', 'memory', 'migrations', 'steward', 'missions', 'scheduler',
    'privacy-scopes', 'external-bots', 'desktop', 'overlay-tool', 'quarantine-v1', '.work-data']);
  const AREA_SET = new Set(AREA_NAMES);
  // One area row from untrusted broker/report input: {area, entries, bytes}
  // with a known name (else 'other') and safe non-negative integers.
  function limitAreas(rows) {
    if (!Array.isArray(rows)) return Object.freeze([]);
    const merged = new Map();
    for (const row of rows.slice(0, 64)) {
      if (!row || typeof row !== 'object') continue;
      const raw = typeof row.area === 'string' ? row.area.toLowerCase() : '', area = AREA_SET.has(raw) ? raw : 'other';
      const entries = row.entries, bytes = row.bytes;
      if (!Number.isSafeInteger(entries) || entries < 0 || !Number.isSafeInteger(bytes) || bytes < 0) continue;
      const value = merged.get(area) || { area, entries: 0, bytes: 0 };
      value.entries += entries; value.bytes += bytes; merged.set(area, value);
    }
    return Object.freeze([...merged.values()].sort((a, b) => b.bytes - a.bytes || b.entries - a.entries || (a.area < b.area ? -1 : 1))
      .slice(0, 5).map(value => Object.freeze(value)));
  }
  // The single typed over-budget error of a preserved census (also raised for
  // the broker's own census_*_limit refusals): code + limit {kind, maximum} +
  // flat params for UI copy, and the top areas seen when known. The areas are
  // what the census had already covered when it stopped: together they exceed
  // the limit, other areas may add more.
  const LIMIT_KINDS = new Set(['entries', 'files', 'directories', 'bytes', 'file-bytes', 'transport', 'depth']);
  const limitMaximum = kind => ({ entries: NATIVE_BUDGET.entries, files: NATIVE_BUDGET.files, directories: NATIVE_BUDGET.directories,
    'file-bytes': NATIVE_BUDGET.fileBytes, transport: NATIVE_BUDGET.transportBytes, depth: NATIVE_BUDGET.depth })[kind] ?? NATIVE_BUDGET.bytes;
  function limitDetails(kind, configured, areas) {
    if (!LIMIT_KINDS.has(kind)) kind = 'bytes';
    const maximum = Number.isSafeInteger(configured) && configured > 0 ? configured : limitMaximum(kind);
    return { retry: false, limit: Object.freeze({ kind, maximum }), areas: limitAreas(areas),
      params: Object.freeze({ kind, maximum, maxFiles: NATIVE_BUDGET.files, maxMegabytes: Math.floor(NATIVE_BUDGET.bytes / 1048576),
        maxFileMegabytes: Math.floor(NATIVE_BUDGET.fileBytes / 1048576) }) };
  }
  function engineeringLimit(kind, cause, configured, areas) {
    const code = 'work_data_tree.preserved_native_engineering_limit';
    return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code, apiCode: code, statusCode: 409,
      ...limitDetails(kind, configured, areas) });
  }
  const digest = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const identity = stat => String(stat.dev) + ':' + String(stat.ino);
  const pathKey = name => process.platform === 'win32' ? name.toUpperCase() : name;
  function capturedCleanupFailure(code,primary,failed,errors,releaseFailed=false) {
    const unknown=value=>{
      if(value===null||!['object','function'].includes(typeof value))return false;
      const seen=new Set();try{for(let depth=0;value!==null&&depth<8;depth++){
        if(seen.has(value))return true;seen.add(value);const flag=Object.getOwnPropertyDescriptor(value,'helperMayStillRun');
        if(flag)return !Object.hasOwn(flag,'value')||flag.value===true;value=Object.getPrototypeOf(value);
      }return value!==null;}catch{return true;}
    };
    const causes=[...(failed?[primary]:[]),...errors];
    return Object.assign(new AggregateError(causes,code,{cause:causes[0]}),{code,apiCode:code,statusCode:503,
      cleanupFailed:true,ownershipRetained:true,helperMayStillRun:releaseFailed||causes.some(unknown)});
  }
  // Only an actual preserved owner may lend its already captured file bytes.
  // Tokens have no serializable authority; ordinary captures never enter here.
  const preservedCaptures = new WeakMap(), capturedFileLeases = new WeakMap(), preservedReadbacks = new WeakMap();
  const capturedReadScope = new (require('node:async_hooks').AsyncLocalStorage)();
  function claimPreservedReadback(token, root, revision) {
    const known = preservedReadbacks.get(token);
    return !!known && known.root === root && known.revision === revision && preservedReadbacks.delete(token);
  }
  function claimPreservedReadbackContext(token, root, revision) { const known=preservedReadbacks.get(token); if(!known || known.root!==root || known.revision!==revision) return null; preservedReadbacks.delete(token); return Object.freeze({candidateBoundary:known.candidateBoundary||null}); }
  const fileKey = file => typeof file === 'string' && pathApi.isAbsolute(file) ? pathKey(pathApi.resolve(file)) : null;
  function currentCapturedFile(token, file) {
    const known = capturedFileLeases.get(token);
    if (!known || known.released || fileKey(file) !== known.file) fail('captured_file_invalid');
    known.capture.admitSync(); known.capture.check();
    if (digest(known.bytes) !== known.sha256 || known.copies.some(bytes => digest(bytes) !== known.sha256)) fail('snapshot_changed');
    return known;
  }
  async function checkedCapturedFile(token, file) {
    const known = currentCapturedFile(token, file);
    await verifyCapturedRead(known.capture); return currentCapturedFile(token, file);
  }
  async function verifyCapturedRead(capture) {
    const scope = capturedReadScope.getStore();
    if (!scope?.active || scope.capture !== capture) await capture.verify();
  }
  // Only read-only owners can batch their internal Store reads. Each grant
  // still checks its bytes and lease, and no read result leaves the scope
  // until the complete captured tree has been checked against disk again.
  async function readCapturedScope(captured, ownership, read) {
    const capture = preservedCaptures.get(captured);
    if (!capture || capture.ownership !== ownership || typeof read !== 'function') fail('captured_file_invalid');
    capture.admitSync(); capture.check();
    const scope = { capture, active: true };
    try {
      const result = await capturedReadScope.run(scope, read);
      scope.active = false;
      await capture.verify();
      return result;
    } finally { scope.active = false; }
  }
  function assertCapturedFile(token, file) { currentCapturedFile(token, file); return true; }
  async function borrowCapturedFile(captured, file, ownership, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'maxBytes')) fail('captured_file_invalid');
    const maxBytes = options.maxBytes === undefined ? 4 * 1024 * 1024 : options.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) fail('captured_file_invalid');
    const capture = preservedCaptures.get(captured), selected = fileKey(file);
    if (!capture || capture.ownership !== ownership || !selected) fail('captured_file_invalid');
    capture.admitSync(); await capture.admit(); capture.admitSync(); capture.check();
    const row = captured.files.find(value => fileKey(pathApi.join(captured.root, ...value.path.split('/'))) === selected);
    if (!row || !Buffer.isBuffer(row.data) || row.data.length > maxBytes) fail('captured_file_invalid');
    const bytes = Buffer.from(row.data);
    if (digest(bytes) !== row.sha256) { bytes.fill(0); fail('snapshot_changed'); }
    const known = { capture, file: selected, bytes, sha256: row.sha256, copies: [], read: false, released: false };
    const token = Object.freeze({ release() {
      if(!known.released){known.released=true;const errors=[];
        try{for(const bytes of [known.bytes,...known.copies])try{bytes.fill(0);}catch(cause){errors.push(cause);}}
        finally{capture.leases.delete(token);}
        if(errors.length)throw capturedCleanupFailure('work_data_tree.captured_cleanup',undefined,false,errors);
      }
    } });
    capturedFileLeases.set(token, known); capture.leases.add(token); return token;
  }
  async function readCapturedFile(token, file) {
    const known = await checkedCapturedFile(token, file);
    currentCapturedFile(token, file); if (known.read) fail('captured_file_invalid'); known.read = true;
    const bytes = Buffer.from(known.bytes); known.copies.push(bytes); return bytes;
  }
  async function consumeCapturedFile(token, file, consume) {
    if (typeof consume !== 'function') fail('captured_file_invalid');
    const known = currentCapturedFile(token, file);
    if (known.read) fail('captured_file_invalid');
    known.read = true;
    // Copy privately, then run the Store's pre-consumption gate. The copy
    // cannot reach the Store until the live tree and this exact grant agree.
    const bytes = Buffer.from(known.bytes); known.copies.push(bytes);
    await verifyCapturedRead(known.capture);
    currentCapturedFile(token, file);
    return consume(bytes);
  }
  async function verifyCapturedFile(token, file) { await checkedCapturedFile(token, file); return assertCapturedFile(token, file); }
  const validName = name => {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\x00-\x1f<>:"|?*\\/]/.test(name)
      || /[. ]$/.test(name) || Buffer.from(name).toString('utf8') !== name
      || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) fail('name_invalid');
    return name;
  };
  // verified: optional per-pass set. A directory proven real once in one
  // binding pass is not re-walked for each child; every row still compares
  // its own realpath and native identity, which re-covers all its ancestors.
  async function realDirectory(directory, verified) {
    const absolute = pathApi.resolve(directory), parsed = pathApi.parse(absolute); let cursor = parsed.root;
    for (const part of ['', ...absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean)]) {
      if (part) cursor = pathApi.join(cursor, part);
      if (verified && verified.has(pathKey(cursor))) continue;
      const stat = await fsApi.lstat(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || pathKey(pathApi.resolve(await fsApi.realpath(cursor))) !== pathKey(cursor)) fail('path_alias');
      if (verified) verified.add(pathKey(cursor));
    }
  }
  function create({ bytes = 256 * 1024 * 1024, files = 100000, directories = 100000, pathLength = 1024 } = {}) {
    if ([bytes, files, directories, pathLength].some(value => !Number.isSafeInteger(value) || value < 1)) fail('limits_invalid');
    const issued = new WeakMap();
    async function census(root, retain) {
      if (typeof root !== 'string' || !pathApi.isAbsolute(root)) fail('root_invalid');
      root = pathApi.resolve(root); await realDirectory(root);
      const result = { root, directories: [], files: [] }, contents = [];
      let used = 0, succeeded = false;
      try {
        const visit = async relative => {
          const directory = pathApi.join(root, relative);
          await realDirectory(directory);
          const before = await fsApi.lstat(directory, { bigint: true });
          if (!relative) result.rootIdentity = identity(before);
          const names = await fsApi.readdir(directory), folded = new Set();
          names.sort();
          for (const name of names) {
            validName(name);
            if (folded.has(name.toUpperCase())) fail('namespace_conflict'); folded.add(name.toUpperCase());
            const entry = relative ? relative + '/' + name : name;
            if (entry.length > pathLength) fail('path_limit');
            const file = pathApi.join(root, entry), stat = await fsApi.lstat(file, { bigint: true });
            if (stat.isSymbolicLink()) fail('path_alias');
            if (stat.isDirectory()) {
              if (result.directories.length >= directories) fail('engineering_limit', limitDetails('directories', directories));
              result.directories.push({ path: entry, identity: identity(stat) }); await visit(entry); continue;
            }
            if (!stat.isFile() || stat.nlink !== 1n) fail('file_capability');
            if (result.files.length >= files) fail('engineering_limit', limitDetails('files', files));
            if (stat.size > BigInt(bytes - used)) fail('engineering_limit', limitDetails('bytes', bytes));
            const handle = await fsApi.open(file, 'r'), chunks = [], hasher = cryptoApi.createHash('sha256'), scratch = Buffer.alloc(65536);
            let count = 0, transferred = false;
            try {
              const opened = await handle.stat({ bigint: true });
              if (!opened.isFile() || opened.nlink !== 1n || identity(opened) !== identity(stat)) fail('source_changed');
              for (;;) {
                const read = await handle.read(scratch, 0, Math.min(scratch.length, bytes - used - count + 1), null);
                if (!read.bytesRead) break;
                count += read.bytesRead;
                if (count > bytes - used) fail('engineering_limit', limitDetails('bytes', bytes));
                const part = scratch.subarray(0, read.bytesRead); hasher.update(part);
                if (retain) chunks.push(Buffer.from(part));
              }
              const after = await handle.stat({ bigint: true }), current = await fsApi.lstat(file, { bigint: true });
              if (identity(after) !== identity(stat) || identity(current) !== identity(stat) || current.isSymbolicLink()
                || after.nlink !== 1n || current.nlink !== 1n
                || count !== Number(stat.size) || after.size !== stat.size || current.size !== stat.size
                || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) fail('source_changed');
              const row = { path: entry, identity: identity(stat), size: count, sha256: hasher.digest('hex') };
              if (retain) { row.data = Buffer.concat(chunks, count); contents.push(row.data); }
              result.files.push(row); used += count; transferred = true;
            } finally {
              scratch.fill(0); for (const chunk of chunks) chunk.fill(0);
              try { await handle.close(); } catch (error) { if (transferred) fail('descriptor_close'); throw error; }
            }
          }
          const after = await fsApi.lstat(directory, { bigint: true });
          if (identity(before) !== identity(after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
            || after.isSymbolicLink()) fail('source_changed');
        };
        await visit(''); result.bytes = used; succeeded = true; return result;
      } finally { if (!succeeded) for (const content of contents) content.fill(0); }
    }
    const proof = result => ({ root: result.root, rootIdentity: result.rootIdentity, directories: result.directories.map(row => ({ ...row })),
      files: result.files.map(({ data, ...row }) => row), bytes: result.bytes });
    async function capture(root) {
      const captured = await census(root, true); let released = false;
      const result = Object.freeze({ root: captured.root, bytes: captured.bytes,
        directories: Object.freeze(captured.directories.map(row => row.path)),
        files: Object.freeze(captured.files.map(row => Object.freeze({ path: row.path, data: row.data, sha256: row.sha256 }))),
        release() { if (!released) { released = true; for (const row of captured.files) row.data.fill(0); } },
      });
      issued.set(result, { proof: proof(captured), released: () => released }); return result;
    }
    async function verify(captured) {
      const owned = issued.get(captured);
      if (!owned || owned.released()) fail('snapshot_unavailable');
      for (const row of captured.files) if (digest(row.data) !== row.sha256) fail('snapshot_changed');
      const actual = await census(captured.root, false);
      if (JSON.stringify(proof(actual)) !== JSON.stringify(owned.proof)) fail('source_changed');
      if (owned.released()) fail('snapshot_unavailable');
      for (const row of captured.files) if (digest(row.data) !== row.sha256) fail('snapshot_changed');
      return Object.freeze({ bytes: actual.bytes, files: actual.files.length, directories: actual.directories.length,
        sha256: digest(JSON.stringify(owned.proof)), domainValidation: 'host-owner-required', nativeMetadata: 'host-owner-required' });
    }
    return Object.freeze({ capture, verify });
  }
  // Explicit, owner-held native reader. Ordinary capture/verify above retain
  // their original byte contract. This mode issues the same private receipt,
  // without reopening file data or enumerating directories through Node.
  // Explicit bounded-native-v1 engineering profile: entries follow the
  // configured file/directory limits and all default + named DATA streams
  // share NATIVE_BUDGET.bytes (overridable as limits.nativeBytes, never above
  // the broker transport budget). The default reader keeps its own budgets.
  function createPreserved({ capturePreserved, ownership, assertExclusive, assertExclusiveSync, candidateAuthority, limits = {} } = {}) {
    if (typeof capturePreserved !== 'function' || typeof assertExclusive !== 'function'
      || assertExclusiveSync !== undefined && typeof assertExclusiveSync !== 'function'
      || candidateAuthority !== undefined && typeof candidateAuthority !== 'function'
      || !ownership || !Array.isArray(ownership.roots)) fail('preserved_owner_required');
    const { bytes = 256 * 1024 * 1024, files = 100000, directories = 100000, pathLength = 1024, nativeBytes: nativeByteLimit = NATIVE_BUDGET.bytes } = limits;
    if ([bytes, files, directories, pathLength, nativeByteLimit].some(value => !Number.isSafeInteger(value) || value < 1)
      || nativeByteLimit > NATIVE_BUDGET.bytes) fail('limits_invalid');
    const issued = new WeakMap(), exactKeys = (value, expected) => value && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;
    const hash = value => cryptoApi.createHash('sha256').update(value).digest('hex');
    const samePath = (a, b) => pathKey(pathApi.resolve(a)) === pathKey(pathApi.resolve(b));
    function rootOwned(root) {
      return typeof root === 'string' && pathApi.isAbsolute(root) && pathApi.resolve(root) === root
        && ownership.roots.some(base => {
          if (typeof base !== 'string' || !pathApi.isAbsolute(base)) return false;
          const relative = pathApi.relative(pathKey(pathApi.resolve(base)), pathKey(root));
          return relative === '' || relative !== '..' && !relative.startsWith('..' + pathApi.sep) && !pathApi.isAbsolute(relative);
        });
    }
    async function admitted(root) {
      if (!rootOwned(root) || await assertExclusive(ownership) !== true) fail('preserved_owner_required');
    }
    function admittedSync(root) {
      const guard = assertExclusiveSync || assertExclusive;
      if (!rootOwned(root)) fail('preserved_owner_required');
      // A promise is not a synchronous authority proof. Known async predicates
      // are refused before invocation; an unexpected pending result is latched
      // as uncertain so callers cannot infer it is safe to release ownership.
      if (guard.constructor?.name === 'AsyncFunction') fail('captured_file_sync_owner_required');
      const current = guard(ownership);
      if (current && typeof current.then === 'function') {
        Promise.resolve(current).catch(() => {});
        throw Object.assign(new Error('work_data_tree.captured_file_owner_uncertain'), {
          code: 'work_data_tree.captured_file_owner_uncertain', apiCode: 'work_data_tree.captured_file_owner_uncertain',
          statusCode: 409, helperMayStillRun: true, ownershipRetained: true,
        });
      }
      if (current !== true) fail('preserved_owner_required');
    }
    function parse(snapshot) {
      const data = [], rows = [], paths = new Set(), ids = new Set(); let used = 0, nativeBytes = 0, dirCount = 0, fileCount = 0, complete = false, failed=false, primary;
      try {
        if (!exactKeys(snapshot, 'entries,platform,revision,schema') || snapshot.schema !== 1
          || snapshot.platform !== 'ntfs-objects-v1' || !/^[a-f0-9]{64}$/.test(snapshot.revision || '')
          || !Array.isArray(snapshot.entries) || snapshot.entries.length < 1) fail('preserved_native_invalid');
        if (snapshot.entries.length > files + directories + 1)
          throw engineeringLimit('entries', undefined, files + directories + 1);
        for (const entry of snapshot.entries) {
          if (!exactKeys(entry, 'attrs,dir,id,opaque,rel,shortName,streams,times')
            || typeof entry.rel !== 'string' || entry.rel.length > pathLength
            || entry.rel && entry.rel.split('/').some(part => { validName(part); return false; })
            || paths.has(entry.rel.toUpperCase()) || !/^[a-f0-9]{24}$/.test(entry.id || '') || ids.has(entry.id)
            || !/^[a-f0-9]{64}$/.test(entry.opaque || '') || typeof entry.dir !== 'boolean'
            || typeof entry.shortName !== 'string' || entry.shortName.length > 14 || /[\x00-\x1f\\/:<>"|?*]/.test(entry.shortName)
            || !Array.isArray(entry.times) || entry.times.length !== 4
            || entry.times.some(time => typeof time !== 'string' || !/^\d{1,19}$/.test(time) || BigInt(time) > 9223372036854775807n)
            || !Array.isArray(entry.streams)) fail('preserved_native_invalid');
          // The reader preserves all native-supported Basic/ADS metadata. The
          // separate disposable owner decides deletion eligibility; this reader
          // never turns readonly/ADS into an ordinary-file deletion permission.
          if (!Number.isSafeInteger(entry.attrs) || entry.attrs < 0 || (entry.attrs & ~0x31b7) !== 0
            || Boolean(entry.attrs & 16) !== entry.dir || entry.streams.length > 10000) fail('preserved_metadata_unknown');
          paths.add(entry.rel.toUpperCase()); ids.add(entry.id);
          const row = { rel: entry.rel, id: entry.id, dir: entry.dir, attrs: entry.attrs,
            times: [...entry.times], shortName: entry.shortName, streams: [] };
          if (entry.dir) { if (entry.rel && ++dirCount > directories) throw engineeringLimit('directories', undefined, directories); }
          else if (!entry.rel) fail('preserved_native_invalid');
          else if (++fileCount > files) throw engineeringLimit('files', undefined, files);
          const streams = new Set();
          for (const stream of entry.streams) {
            if (!exactKeys(stream, 'data,hash,name,size') || typeof stream.name !== 'string' || stream.name.length > 1024
              || stream.name !== '' && !/^:[^:\\/*?"<>|\x00-\x1f]+:\$DATA$/.test(stream.name)
              || streams.has(stream.name.toUpperCase()) || entry.dir && stream.name === '' || !Number.isSafeInteger(stream.size)
              || stream.size < 0 || !/^[a-f0-9]{64}$/.test(stream.hash || '')
              || typeof stream.data !== 'string' || stream.data.length !== 4 * Math.ceil(stream.size / 3)) fail('preserved_native_invalid');
            streams.add(stream.name.toUpperCase()); nativeBytes += stream.size;
            if (stream.size > NATIVE_BUDGET.fileBytes) throw engineeringLimit('file-bytes');
            if (nativeBytes > nativeByteLimit) throw engineeringLimit('bytes', undefined, nativeByteLimit);
            const content = Buffer.from(stream.data, 'base64'); data.push(content);
            if (content.length !== stream.size || content.toString('base64') !== stream.data || hash(content) !== stream.hash) fail('preserved_native_invalid');
            if (stream.name === '') { row.data = content; used += content.length; if (used > bytes) fail('engineering_limit', limitDetails('bytes', bytes)); }
            row.streams.push({ name: stream.name, size: content.length, hash: stream.hash });
          }
          if (!entry.dir && !streams.has('')) fail('preserved_native_invalid');
          row.streams.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
          rows.push(row);
        }
        const byPath = new Map(rows.map(row => [row.rel, row]));
        if (!byPath.get('')?.dir) fail('preserved_native_invalid');
        for (const row of rows) if (row.rel) {
          const at = row.rel.lastIndexOf('/'), parent = at < 0 ? '' : row.rel.slice(0, at);
          if (!byPath.get(parent)?.dir) fail('preserved_native_invalid');
        }
        rows.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
        const nativeSha256 = hash(JSON.stringify(rows.map(({ data: ignored, ...row }) => row)));
        complete = true; return { rows, used, nativeSha256, release() {const errors=[];for(const content of data)try{content.fill(0);}catch(cause){errors.push(cause);}if(errors.length)throw capturedCleanupFailure('work_data_tree.captured_cleanup',undefined,false,errors);} };
      } catch(cause){failed=true;primary=cause;throw cause;}
      finally{if(!complete){const errors=[];for(const content of data)try{content.fill(0);}catch(cause){errors.push(cause);}if(errors.length)throw capturedCleanupFailure('work_data_tree.captured_cleanup',primary,failed,errors);}}
    }
    async function census(root, retain, candidateBoundary = null) {
      await admitted(root); await realDirectory(root);
      const firstRevision = cryptoApi.randomBytes(32).toString('hex'), revision = cryptoApi.randomBytes(32).toString('hex');
      let first, second, result, binding, bindingCompleted = false, accepting = true, success = false, failed = false, primary;
      async function bindFirst(snapshot) {
        if(snapshot?.revision!==firstRevision)fail('preserved_native_invalid');
        first = parse(snapshot);
        await admitted(root);
        result = { root, directories: [], files: [], bytes: first.used }; const bound = new Map(), verified = new Set();
        // All Node metadata/namespace checks precede the final, closed native
        // readback. No Node open/read/readdir occurs in this owner at all.
        for (const row of first.rows) {
          const file = row.rel ? pathApi.join(root, ...row.rel.split('/')) : root;
          await realDirectory(row.dir ? file : pathApi.dirname(file), verified);
          const stat = await fsApi.lstat(file, { bigint: true });
          if (stat.isSymbolicLink() || row.dir !== stat.isDirectory() || !row.dir && (!stat.isFile() || stat.nlink !== 1n)
            || !samePath(await fsApi.realpath(file), file)) fail('path_alias');
          const nativeId = BigInt(stat.dev).toString(16).padStart(8, '0') + BigInt(stat.ino).toString(16).padStart(16, '0');
          if (nativeId !== row.id || !row.dir && stat.size !== BigInt(row.data.length)) fail('source_changed');
          bound.set(row.rel, identity(stat));
        }
        const children = new Map();
        for (const row of first.rows) if (row.rel) {
          const at = row.rel.lastIndexOf('/'), parent = at < 0 ? '' : row.rel.slice(0, at);
          if (!children.has(parent)) children.set(parent, []); children.get(parent).push(row);
        }
        const walk = relative => {
          for (const row of (children.get(relative) || []).sort((a, b) => {
            const aName = a.rel.slice(a.rel.lastIndexOf('/') + 1), bName = b.rel.slice(b.rel.lastIndexOf('/') + 1);
            return aName < bName ? -1 : aName > bName ? 1 : 0;
          })) {
            if (row.dir) { result.directories.push({ path: row.rel, identity: bound.get(row.rel) }); walk(row.rel); }
            else result.files.push({ path: row.rel, identity: bound.get(row.rel), size: row.data.length,
              sha256: row.streams.find(stream => stream.name === '').hash, ...(retain ? { data: Buffer.from(row.data) } : {}) });
          }
        };
        result.rootIdentity = bound.get(''); walk('');
        await admitted(root);
      }
      const bind = snapshot => {
        if(!accepting||binding)fail('preserved_native_invalid');
        binding = bindFirst(snapshot).then(() => { bindingCompleted = true; });
        binding.catch(()=>{}); // Even a provider failing before it awaits bind must not orphan this rejection.
        return binding;
      };
      const readback = Object.freeze({ revision, bind });
      preservedReadbacks.set(readback,{root,revision:firstRevision,candidateBoundary});
      try {
        // The native producer may use one broker for both readings. Its first
        // response proves all captured handles closed before these Node checks,
        // and its final response is withheld until the actual broker closes.
        let snapshot = await capturePreserved(root, firstRevision, readback);
        accepting = false;
        if (!binding) {
          if(candidateBoundary)fail('preserved_native_invalid');
          // Hosts implementing only the original single-read interface still
          // provide two fully closed, independent native readings.
          await bindFirst(snapshot);
          snapshot = await capturePreserved(root, revision);
        } else if (!bindingCompleted) {
          await binding;
          fail('preserved_native_invalid');
        }
        if(snapshot?.revision!==revision)fail('preserved_native_invalid');
        second = parse(snapshot);
        if (second.nativeSha256 !== first.nativeSha256) fail('source_changed');
        // Only the actual owner assertion runs after final native close. It must
        // inspect its held lease, not reopen target data/namespace.
        await admitted(root); success = true;
        return { result, nativeSha256: second.nativeSha256 };
      } catch(cause){failed=true;primary=cause;throw cause;}
      finally {
        accepting=false;
        preservedReadbacks.delete(readback);
        const errors=[];let releaseFailed=false;
        if(binding&&!bindingCompleted)try{await binding;}catch(cause){if(!failed||!Object.is(cause,primary))errors.push(cause);}
        for(const captured of [first,second])if(captured)try{const released=captured.release();if(released!==undefined){Promise.resolve(released).catch(()=>{});throw new Error('captured_release_unproven');}}catch(cause){releaseFailed=true;errors.push(cause);}
        // No buffers escape either an unsuccessful proof or an uncertain cleanup.
        if((!success||errors.length)&&result)for(const row of result.files)try{row.data?.fill(0);}catch(cause){errors.push(cause);}
        if(errors.length)throw capturedCleanupFailure('work_data_tree.captured_cleanup',primary,failed,errors,releaseFailed);
      }
    }
    const proofOf = result => ({ root: result.root, rootIdentity: result.rootIdentity,
      directories: result.directories.map(row => ({ ...row })), files: result.files.map(({ data, ...row }) => row), bytes: result.bytes });
    async function capture(root, candidate) {
      const boundary=candidate===undefined?null:(typeof candidateAuthority==='function'?candidateAuthority(candidate,root):fail('preserved_owner_required'));
      if(candidate!==undefined&&!boundary)fail('preserved_owner_required');
      const { result: captured, nativeSha256 } = await census(root, true, boundary); let released = false;
      const result = Object.freeze({ root, bytes: captured.bytes, directories: Object.freeze(captured.directories.map(row => row.path)),
        files: Object.freeze(captured.files.map(row => Object.freeze({ path: row.path, data: row.data, sha256: row.sha256 }))),
        release() {if(!released){released=true;const errors=[];let releaseFailed=false;
          for(const lease of [...(preservedCaptures.get(result)?.leases||[])])try{const released=lease.release();if(released!==undefined){Promise.resolve(released).catch(()=>{});throw new Error('captured_release_unproven');}}catch(cause){releaseFailed=true;errors.push(cause);}
          for(const row of captured.files)try{row.data.fill(0);}catch(cause){errors.push(cause);}
          if(errors.length)throw capturedCleanupFailure('work_data_tree.captured_cleanup',undefined,false,errors,releaseFailed);
        }}  });
      issued.set(result, { proof: proofOf(captured), nativeSha256, boundary, released: () => released });
      preservedCaptures.set(result, { ownership, admit: () => admitted(root), admitSync: () => admittedSync(root), check: () => fingerprint(result), verify: () => verify(result), leases: new Set() }); return result;
    }
    async function verify(captured) {
      const owned = issued.get(captured);
      if (!owned || owned.released()) fail('snapshot_unavailable');
      for (const row of captured.files) if (digest(row.data) !== row.sha256) fail('snapshot_changed');
      const actual = await census(captured.root, false, owned.boundary);
      if (JSON.stringify(proofOf(actual.result)) !== JSON.stringify(owned.proof)) fail('source_changed');
      if (owned.released()) fail('snapshot_unavailable');
      for (const row of captured.files) if (digest(row.data) !== row.sha256) fail('snapshot_changed');
      // Byte/identity verification keeps the original contract. A checkpoint
      // owner explicitly compares this actual metadata fingerprint with its
      // durable record; legitimate earlier preparation reads are not frozen.
      owned.nativeSha256 = actual.nativeSha256;
      return fingerprint(captured);
    }
    function fingerprint(captured) {
      const owned = issued.get(captured);
      if (!owned || owned.released()) fail('snapshot_unavailable');
      for (const row of captured.files) if (digest(row.data) !== row.sha256) fail('snapshot_changed');
      return Object.freeze({ bytes: owned.proof.bytes, files: owned.proof.files.length, directories: owned.proof.directories.length,
        sha256: digest(JSON.stringify(owned.proof)), nativeSha256: owned.nativeSha256,
        domainValidation: 'host-owner-required', nativeMetadata: 'preserved-reader-closed' });
    }
    function nativeFingerprint(snapshot) {
      const parsed = parse(snapshot);
      try { return parsed.nativeSha256; }
      finally { parsed.release(); }
    }
    return Object.freeze({ capture, verify, fingerprint, nativeFingerprint });
  }

  // Data-root content policy (150 W3/W4/W13). Pure classification of paths in
  // a complete census; it never filters a census, proof or digest. A package or
  // a new generation omits these objects and leaves them exactly where they are
  // (nothing here deletes, moves or repairs). Classes:
  //   excluded  regenerable caches, external VCS trees and the product's own
  //             quarantine area (by top-level logical name, in a data root or in
  //             one generation namespace);
  //   leftover  crash leftovers in product-generated shapes: <file>.corrupt[-N]
  //             (quarantine copies) and <file>.<pid>.<8hex>.tmp (atomic stage),
  //             never inside skills/ or uploads/ (user-chosen names keep their
  //             owner refusal) and never under any .work-data control namespace;
  //   retired / legacy  only with a valid active pointer (generation >= 1) and
  //             no native skill-backup object anywhere: the other generations and
  //             the superseded base-level root. Leftovers inside them are still
  //             reported individually (area 'superseded'): they may be plaintext.
  // Control paths and every skill-backup (native owner) scope are never
  // classified: their owners keep refusing. Audit logs migrate with their
  // owner; a torn last row is handled by the record codecs (committed prefix).
  const rootScope = (() => {
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
    // regenerable: classified regenerable by the durable-state inventory.
    const rule = (reason, inventory, regenerable) => Object.freeze({ reason, inventory, regenerable });
    const EXCLUDED = new Map([
      ['webcache', rule('regenerable-cache', 'web-cache', true)],
      ['proxy-models-cache.json', rule('regenerable-cache', 'proxy-models-cache', true)],
      ['storage-trend.json', rule('regenerable-telemetry', 'storage-trend', true)],
      ['last-start-error.json', rule('regenerable-telemetry', 'last-start-error', true)],
      ['agent-worktrees', rule('external-vcs-worktree', null, false)],
      ['quarantine-v1', rule('product-quarantine', null, false)],
    ]);
    const CORRUPT = /\.corrupt(?:-\d{1,20})?$/, STAGE = /\.\d{1,10}\.[a-f0-9]{8}\.tmp$/;
    const GENERATION = /^\.work-data\/generations\/([a-f0-9]{48})(?:\/(.*))?$/;
    // Also every copy of the binding store (e.g. its .corrupt-<ts> quarantine): owner refusal, never a leftover.
    const SKILL_BACKUP = /^(?:migrations\/skill-backups(?:\/|$)|migrations\/skill-backup-bindings-v2\.sealed(?:$|[.-]))/;
    // 06 archiveAgentRunEvents stages <run>.events.ndjson.gz.tmp under agent-runs/ (single tmp name).
    const ARCHIVE_STAGE = /\.events\.ndjson\.gz\.tmp$/;
    const USER_NAMED = new Set(['skills', 'uploads']);
    // Split a base-relative path into its generation prefix and logical path.
    function locate(relative, base) {
      const folded = fold(relative);
      if (!base) return { prefix: '', generation: null, logical: folded, control: false };
      const found = GENERATION.exec(folded);
      if (found) return { prefix: '.work-data/generations/' + found[1] + '/', generation: found[1], logical: found[2] || '', control: !found[2] };
      return { prefix: '', generation: null, logical: folded, control: folded === '.work-data' || folded.startsWith('.work-data/') };
    }
    const controlLogical = logical => logical === '.work-data' || logical.startsWith('.work-data/');
    function leftoverOf(relative, where) {
      const parts = where.logical.split('/');
      if (USER_NAMED.has(parts[0])) return null;
      if (parts[0] === 'agent-runs' && parts.length > 1 && ARCHIVE_STAGE.test(parts[parts.length - 1]))
        return Object.freeze({ class: 'leftover', reason: 'archive-stage', inventory: null, regenerable: false, scope: relative });
      let offset = where.prefix.length;
      for (const part of parts) {
        offset += part.length;
        const kind = STAGE.test(part) ? 'crash-stage' : CORRUPT.test(part) ? 'quarantined-corrupt' : '';
        if (kind) return Object.freeze({ class: 'leftover', reason: kind, inventory: null, regenerable: false, scope: relative.slice(0, offset) });
        offset += 1;
      }
      return null;
    }
    // Static policy only: excluded classes and leftovers, relative to a data
    // root (base:true also understands one generation namespace prefix).
    function classify(relative, { base = false } = {}) {
      if (typeof relative !== 'string' || !relative) return null;
      const where = locate(relative, base);
      if (where.control || !where.logical || controlLogical(where.logical) || SKILL_BACKUP.test(where.logical)) return null;
      const top = where.logical.split('/')[0], excluded = EXCLUDED.get(top);
      if (excluded) return Object.freeze({ class: 'excluded', ...excluded, scope: relative.slice(0, where.prefix.length + top.length) });
      return leftoverOf(relative, where);
    }
    const sizeOf = row => Buffer.isBuffer(row.data) ? row.data.length : Number.isSafeInteger(row.size) ? row.size : 0;
    // The active pointer as checkAuthority reads it; anything else disables
    // the retired/legacy classes (the snapshot's own authority check decides).
    function activeOf(files, directories) {
      const pointer = files.find(row => fold(row.path) === '.work-data/active-v1.json');
      if (!pointer || !Buffer.isBuffer(pointer.data)) return null;
      let value; try { value = JSON.parse(pointer.data.toString('utf8')); } catch { return null; }
      if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'activeRoot,generation,id,mode,schema'
        || value.schema !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1 || !/^[a-f0-9]{48}$/.test(value.id || '')
        || value.activeRoot !== 'generations/' + value.id
        || !directories.some(name => fold(name) === '.work-data/generations/' + value.id)) return null;
      return Object.freeze({ id: value.id, generation: value.generation, mode: value.mode });
    }
    // Partition a complete base-relative census. Omitted subtrees are reported
    // (path, counts, bytes); omitted leftovers are listed individually with
    // their area: 'active' (current root) or 'superseded' (legacy/retired).
    function partition(files, directories, { active: given, listLimit = 200 } = {}) {
      if (!Array.isArray(files) || !Array.isArray(directories)) fail('scope_invalid');
      const active = given === undefined ? activeOf(files, directories) : given;
      // Any native skill-backup object (legacy, per generation or the control
      // store) may depend on key headers or provenance in a superseded root:
      // its owner, not this policy, decides, so nothing is retired/legacy then.
      const nativePresent = [...directories, ...files.map(row => row.path)].some(name => {
        const where = locate(name, true), folded = fold(name);
        return SKILL_BACKUP.test(where.logical) || folded === '.work-data/skill-backups' || folded.startsWith('.work-data/skill-backups/');
      });
      const superseded = active && !nativePresent ? active : null;
      const decide = name => {
        const where = locate(name, true);
        if (superseded) {
          const retired = where.generation && where.generation !== superseded.id, legacy = !where.generation && !where.control;
          if (retired || legacy) {
            // Excluded trees (quarantine copies, worktrees, caches) never yield leftovers.
            const leftover = !controlLogical(where.logical) && where.logical && !SKILL_BACKUP.test(where.logical) && !EXCLUDED.has(where.logical.split('/')[0]) ? leftoverOf(name, where) : null;
            if (leftover) return { ...leftover, area: 'superseded' };
            return retired ? { class: 'retired', reason: 'superseded-generation', inventory: null, scope: name.slice(0, '.work-data/generations/'.length + 48) }
              : { class: 'legacy', reason: 'superseded-plain-root', inventory: null, scope: name.split('/')[0] };
          }
        }
        const verdict = classify(name, { base: true });
        return verdict && verdict.class === 'leftover' ? { ...verdict, area: 'active' } : verdict;
      };
      const groups = new Map(), leftovers = [], keptFiles = [], keptDirectories = [];
      let leftoverCount = 0, leftoverBytes = 0, includedBytes = 0, supersededLeftovers = 0;
      const group = (verdict, directory, bytes) => {
        const id = verdict.class + '\0' + fold(verdict.scope);
        if (!groups.has(id)) groups.set(id, { class: verdict.class, reason: verdict.reason, inventory: verdict.inventory, regenerable: verdict.regenerable === true, path: verdict.scope, files: 0, directories: 0, bytes: 0 });
        const value = groups.get(id); if (directory) value.directories++; else { value.files++; value.bytes += bytes; }
      };
      const leftover = (verdict, path, directory, bytes) => {
        leftoverCount++; leftoverBytes += bytes; if (verdict.area === 'superseded') supersededLeftovers++;
        if (leftovers.length < listLimit) leftovers.push({ path, directory, reason: verdict.reason, area: verdict.area, bytes });
      };
      for (const name of directories) { const verdict = decide(name); if (!verdict) keptDirectories.push(name); else if (verdict.class === 'leftover') leftover(verdict, name, true, 0); else group(verdict, true, 0); }
      for (const row of files) {
        const verdict = decide(row.path), bytes = sizeOf(row);
        if (!verdict) { keptFiles.push(row); includedBytes += bytes; }
        else if (verdict.class === 'leftover') leftover(verdict, row.path, false, bytes);
        else group(verdict, false, bytes);
      }
      const report = Object.freeze({ schema: 1, active: active ? Object.freeze({ id: active.id, generation: active.generation }) : null, supersededOmitted: !!superseded,
        included: Object.freeze({ files: keptFiles.length, directories: keptDirectories.length, bytes: includedBytes }),
        omitted: Object.freeze([...groups.values()].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).map(value => Object.freeze(value))),
        leftovers: Object.freeze(leftovers.map(value => Object.freeze(value))), leftoverCount, leftoverBytes, supersededLeftovers, leftoversTruncated: leftoverCount > leftovers.length });
      return Object.freeze({ files: keptFiles, directories: keptDirectories, report });
    }
    return Object.freeze({ classify, partition, activeOf, EXCLUDED_NAMES: Object.freeze([...EXCLUDED.keys()]) });
  })();

  // Late, immutable adapter: only this module can validate its private issued
  // capabilities. The store keeps its parser and cryptographic context.
  if (typeof WorkDataStore !== 'undefined' && WorkDataStore.Hooks) Object.defineProperty(WorkDataStore.Hooks, 'capturedFiles', {
    enumerable: true, configurable: false, writable: false, value: Object.freeze({
      read: readCapturedFile, consume: consumeCapturedFile, verify: verifyCapturedFile, assert: assertCapturedFile,
    }),
  });
  return Object.freeze({ create, createPreserved, claimPreservedReadback, claimPreservedReadbackContext, borrowCapturedFile, readCapturedFile, verifyCapturedFile, assertCapturedFile, readCapturedScope, rootScope, NATIVE_BUDGET, AREA_NAMES, engineeringLimit, limitAreas });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
