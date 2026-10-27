// Complete byte census for a quiesced, owner-held tree. No repair, filtering,
// publication or domain-validation claims. The host owns native metadata and
// portable conversions (notably original-object skill capsules) separately.
const WorkDataTree = ((fsApi, pathApi, cryptoApi) => {
  const fail = suffix => { throw Object.assign(new Error('work_data_tree.' + suffix), {
    code: 'work_data_tree.' + suffix, apiCode: 'work_data_tree.' + suffix, statusCode: 409,
  }); };
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
  const preservedCaptures = new WeakMap(), capturedFileLeases = new WeakMap();
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
    await known.capture.verify(); return currentCapturedFile(token, file);
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
  async function verifyCapturedFile(token, file) { await checkedCapturedFile(token, file); return assertCapturedFile(token, file); }
  const validName = name => {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\x00-\x1f<>:"|?*\\/]/.test(name)
      || /[. ]$/.test(name) || Buffer.from(name).toString('utf8') !== name
      || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) fail('name_invalid');
    return name;
  };
  async function realDirectory(directory) {
    const absolute = pathApi.resolve(directory), parsed = pathApi.parse(absolute); let cursor = parsed.root;
    for (const part of ['', ...absolute.slice(parsed.root.length).split(pathApi.sep).filter(Boolean)]) {
      if (part) cursor = pathApi.join(cursor, part);
      const stat = await fsApi.lstat(cursor, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || pathKey(pathApi.resolve(await fsApi.realpath(cursor))) !== pathKey(cursor)) fail('path_alias');
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
              if (result.directories.length >= directories) fail('engineering_limit');
              result.directories.push({ path: entry, identity: identity(stat) }); await visit(entry); continue;
            }
            if (!stat.isFile() || stat.nlink !== 1n) fail('file_capability');
            if (result.files.length >= files || stat.size > BigInt(bytes - used)) fail('engineering_limit');
            const handle = await fsApi.open(file, 'r'), chunks = [], hasher = cryptoApi.createHash('sha256'), scratch = Buffer.alloc(65536);
            let count = 0, transferred = false;
            try {
              const opened = await handle.stat({ bigint: true });
              if (!opened.isFile() || opened.nlink !== 1n || identity(opened) !== identity(stat)) fail('source_changed');
              for (;;) {
                const read = await handle.read(scratch, 0, Math.min(scratch.length, bytes - used - count + 1), null);
                if (!read.bytesRead) break;
                count += read.bytesRead;
                if (count > bytes - used) fail('engineering_limit');
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
  // Explicit bounded-native-v1 engineering profile: the existing native owner
  // caps 10,000 entries and 96,000,000 bytes including all ADS. Selecting this
  // reader never changes the default reader's larger original budgets.
  function createPreserved({ capturePreserved, ownership, assertExclusive, assertExclusiveSync, limits = {} } = {}) {
    if (typeof capturePreserved !== 'function' || typeof assertExclusive !== 'function'
      || assertExclusiveSync !== undefined && typeof assertExclusiveSync !== 'function'
      || !ownership || !Array.isArray(ownership.roots)) fail('preserved_owner_required');
    const { bytes = 256 * 1024 * 1024, files = 100000, directories = 100000, pathLength = 1024 } = limits;
    if ([bytes, files, directories, pathLength].some(value => !Number.isSafeInteger(value) || value < 1)) fail('limits_invalid');
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
          || !Array.isArray(snapshot.entries) || snapshot.entries.length < 1
          || snapshot.entries.length > files + directories + 1 || snapshot.entries.length > 10000) fail('preserved_native_invalid');
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
          if (entry.dir) { if (entry.rel && ++dirCount > directories) fail('engineering_limit'); }
          else if (!entry.rel || ++fileCount > files) fail('preserved_native_invalid');
          const streams = new Set();
          for (const stream of entry.streams) {
            if (!exactKeys(stream, 'data,hash,name,size') || typeof stream.name !== 'string' || stream.name.length > 1024
              || stream.name !== '' && !/^:[^:\\/*?"<>|\x00-\x1f]+:\$DATA$/.test(stream.name)
              || streams.has(stream.name.toUpperCase()) || entry.dir && stream.name === '' || !Number.isSafeInteger(stream.size)
              || stream.size < 0 || !/^[a-f0-9]{64}$/.test(stream.hash || '')
              || typeof stream.data !== 'string' || stream.data.length !== 4 * Math.ceil(stream.size / 3)) fail('preserved_native_invalid');
            streams.add(stream.name.toUpperCase()); nativeBytes += stream.size;
            if (nativeBytes > 96000000) fail('preserved_native_engineering_limit');
            const content = Buffer.from(stream.data, 'base64'); data.push(content);
            if (content.length !== stream.size || content.toString('base64') !== stream.data || hash(content) !== stream.hash) fail('preserved_native_invalid');
            if (stream.name === '') { row.data = content; used += content.length; if (used > bytes) fail('engineering_limit'); }
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
    async function census(root, retain) {
      await admitted(root); await realDirectory(root);
      const first = parse(await capturePreserved(root, cryptoApi.randomBytes(32).toString('hex')));
      let second, result, success = false, failed=false, primary;
      try {
        await admitted(root);
        result = { root, directories: [], files: [], bytes: first.used }; const bound = new Map();
        // All Node metadata/namespace checks precede the final, closed native
        // readback. No Node open/read/readdir occurs in this owner at all.
        for (const row of first.rows) {
          const file = row.rel ? pathApi.join(root, ...row.rel.split('/')) : root;
          await realDirectory(row.dir ? file : pathApi.dirname(file));
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
        second = parse(await capturePreserved(root, cryptoApi.randomBytes(32).toString('hex')));
        if (second.nativeSha256 !== first.nativeSha256) fail('source_changed');
        // Only the actual owner assertion runs after final native close. It must
        // inspect its held lease, not reopen target data/namespace.
        await admitted(root); success = true;
        return { result, nativeSha256: second.nativeSha256 };
      } catch(cause){failed=true;primary=cause;throw cause;}
      finally {
        const errors=[];let releaseFailed=false;
        for(const captured of [first,second])if(captured)try{const released=captured.release();if(released!==undefined){Promise.resolve(released).catch(()=>{});throw new Error('captured_release_unproven');}}catch(cause){releaseFailed=true;errors.push(cause);}
        // No buffers escape either an unsuccessful proof or an uncertain cleanup.
        if((!success||errors.length)&&result)for(const row of result.files)try{row.data?.fill(0);}catch(cause){errors.push(cause);}
        if(errors.length)throw capturedCleanupFailure('work_data_tree.captured_cleanup',primary,failed,errors,releaseFailed);
      }
    }
    const proofOf = result => ({ root: result.root, rootIdentity: result.rootIdentity,
      directories: result.directories.map(row => ({ ...row })), files: result.files.map(({ data, ...row }) => row), bytes: result.bytes });
    async function capture(root) {
      const { result: captured, nativeSha256 } = await census(root, true); let released = false;
      const result = Object.freeze({ root, bytes: captured.bytes, directories: Object.freeze(captured.directories.map(row => row.path)),
        files: Object.freeze(captured.files.map(row => Object.freeze({ path: row.path, data: row.data, sha256: row.sha256 }))),
        release() {if(!released){released=true;const errors=[];let releaseFailed=false;
          for(const lease of [...(preservedCaptures.get(result)?.leases||[])])try{const released=lease.release();if(released!==undefined){Promise.resolve(released).catch(()=>{});throw new Error('captured_release_unproven');}}catch(cause){releaseFailed=true;errors.push(cause);}
          for(const row of captured.files)try{row.data.fill(0);}catch(cause){errors.push(cause);}
          if(errors.length)throw capturedCleanupFailure('work_data_tree.captured_cleanup',undefined,false,errors,releaseFailed);
        }}  });
      issued.set(result, { proof: proofOf(captured), nativeSha256, released: () => released });
      preservedCaptures.set(result, { ownership, admit: () => admitted(root), admitSync: () => admittedSync(root), check: () => fingerprint(result), verify: () => verify(result), leases: new Set() }); return result;
    }
    async function verify(captured) {
      const owned = issued.get(captured);
      if (!owned || owned.released()) fail('snapshot_unavailable');
      for (const row of captured.files) if (digest(row.data) !== row.sha256) fail('snapshot_changed');
      const actual = await census(captured.root, false);
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
    return Object.freeze({ capture, verify, fingerprint });
  }

  return Object.freeze({ create, createPreserved, borrowCapturedFile, readCapturedFile, verifyCapturedFile, assertCapturedFile });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
// Late, immutable adapter: only this module can validate its private issued
// capabilities. The store keeps its existing parser and cryptographic context.
if (typeof WorkDataStore !== 'undefined' && WorkDataStore.Hooks) Object.defineProperty(WorkDataStore.Hooks, 'capturedFiles', {
  enumerable: true, configurable: false, writable: false, value: Object.freeze({
    read: WorkDataTree.readCapturedFile, verify: WorkDataTree.verifyCapturedFile, assert: WorkDataTree.assertCapturedFile,
  }),
});
