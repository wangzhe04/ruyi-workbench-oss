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
  return Object.freeze({ create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
