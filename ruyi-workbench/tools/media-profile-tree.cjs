'use strict';
// Read-only closed-tree observation. This module never grants a launch/egress
// capability or an atomic namespace lease. Its caller must pin the inventory.
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const fail = (suffix, cause) => Object.assign(new Error('media.profile_' + suffix, cause ? { cause } : undefined), { code:'media.profile_' + suffix, retry:false });
const fields = ['dev','ino','size','mtimeNs','ctimeNs','nlink'];
const snapshot = stat => Object.freeze(Object.fromEntries(fields.map(key => [key, stat[key]])));
const same = (left, right) => fields.every(key => left[key] === right[key]);
const fold = value => value.toLowerCase(); // Every profile targets Windows.
function relative(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[^\x20-\x7e]|[<>:"\\|?*]/.test(value)) throw fail('path_invalid');
  const bits = value.split('/');
  if (bits.some(bit => !bit || bit === '.' || bit === '..' || /[. ]$/.test(bit) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(bit))) throw fail('path_invalid');
  return bits;
}
function forbidden(value) {
  if (/(?:^|\/)(?:__pycache__)(?:\/|$)|\.py[co]$/i.test(value)) throw fail('bytecode_forbidden');
  if (/\.pth$/i.test(value) || (/\._pth$/i.test(value) && value !== 'payload/python_embed/python312._pth')) throw fail('pth_forbidden');
  if (/(?:^|\/)Scripts(?:\/|$)/i.test(value)) throw fail('scripts_forbidden');
}
function captureRows(supplied) {
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > 10000) throw fail('inventory_invalid');
  const count = supplied.length;
  const rows = [], names = new Map(), directories = new Set(['']); let bytes = 0;
  // Fully capture/validate caller primitives before the first await. The public
  // admission wrapper uses only code-pinned JSON, never caller-supplied rows.
  for (let index = 0; index < count; index++) {
    const value = supplied[index];
    const row = Object.freeze({ path:value?.path, bytes:value?.bytes, sha256:value?.sha256 });
    const bits = relative(row.path); forbidden(row.path);
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 134217728 || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw fail('inventory_invalid');
    const key = fold(row.path); if (names.has(key)) throw fail('path_alias'); names.set(key, row.path);
    for (let index = 1; index < bits.length; index++) directories.add(bits.slice(0,index).join('/'));
    rows.push(row); bytes += row.bytes;
    if (bytes > 1073741824) throw fail('inventory_limit');
  }
  const directoryNames = new Map();
  for (const directory of directories) {
    const key = fold(directory);
    if (names.has(key) || directoryNames.has(key) && directoryNames.get(key) !== directory) throw fail('path_alias');
    directoryNames.set(key, directory);
  }
  const children = new Map([...directories].map(directory => [directory, []]));
  for (const name of [...directories].filter(Boolean).concat(rows.map(row => row.path))) {
    const split = name.lastIndexOf('/'), parent = split < 0 ? '' : name.slice(0,split), leaf = name.slice(split+1);
    children.get(parent).push(leaf);
  }
  for (const values of children.values()) values.sort();
  return { rows:Object.freeze(rows), bytes, directories:[...directories].sort(), children };
}
async function observeTree(root, supplied, { signal } = {}) {
  const inventory = captureRows(supplied);
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root) throw fail('root_invalid');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('options_invalid');
  const cancelled = () => { if (signal?.aborted) throw fail('cancelled'); };
  const held = new Map(), identities = new Set(); let completed = 0;
  const assertVisible = async (absolute, directory) => {
    cancelled(); const stat = await fs.lstat(absolute, { bigint:true }); cancelled();
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || !directory && stat.nlink !== 1n || !stat.ino) throw fail('alias');
    const canonical = await fs.realpath(absolute); cancelled();
    if (fold(canonical) !== fold(absolute)) throw fail('alias');
    const prior = held.get(absolute);
    if (prior && !same(prior, stat)) throw fail('changed');
    if (!prior) held.set(absolute, snapshot(stat));
    return stat;
  };
  const parsed = path.parse(root); let ancestor = parsed.root;
  await assertVisible(ancestor, true);
  for (const bit of root.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, bit); await assertVisible(ancestor, true);
  }
  const scan = async () => {
    for (const directory of inventory.directories) {
      const absolute = directory ? path.join(root,...directory.split('/')) : root;
      await assertVisible(absolute, true);
      const values = await fs.readdir(absolute); cancelled();
      if (!Array.isArray(values)) throw fail('tree_invalid');
      for (const name of values) { relative(name); forbidden(directory ? directory + '/' + name : name); }
      if (JSON.stringify(values.slice().sort()) !== JSON.stringify(inventory.children.get(directory))) throw fail('tree_extra_or_missing');
    }
  };
  await scan();
  for (const row of inventory.rows) {
    const absolute = path.join(root,...row.path.split('/'));
    const visible = await assertVisible(absolute, false), identity = visible.dev + ':' + visible.ino;
    if (identities.has(identity)) throw fail('alias'); identities.add(identity);
    const handle = await fs.open(absolute,'r');
    try {
      cancelled();
      const before = await handle.stat({ bigint:true }); cancelled();
      if (!before.isFile() || before.nlink !== 1n || !same(visible,before) || before.size !== BigInt(row.bytes)) throw fail('changed');
      const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let count = 0;
      try {
        for (;;) {
          const result = await handle.read(buffer,0,buffer.length,null); cancelled();
          if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length) throw fail('read_invalid');
          if (!result.bytesRead) break;
          count += result.bytesRead; if (count > row.bytes) throw fail('changed');
          digest.update(buffer.subarray(0,result.bytesRead));
        }
        if (count !== row.bytes || digest.digest('hex') !== row.sha256) throw fail('drift');
      } finally { buffer.fill(0); }
      const after = await handle.stat({ bigint:true }); cancelled();
      if (!same(before,after)) throw fail('changed');
      await assertVisible(absolute,false); completed++;
    } finally { await handle.close(); }
  }
  await scan();
  // Recheck every ancestor, directory and file after the last content read.
  for (const [absolute, prior] of held) {
    const stat = await fs.lstat(absolute,{bigint:true}); cancelled();
    if (stat.isSymbolicLink() || !same(prior,stat)) throw fail('changed');
  }
  cancelled();
  return Object.freeze({ schema:1, kind:'closed-tree-byte-observation', files:completed, bytes:inventory.bytes,
    namespaceLeaseProved:false, executionAuthorized:false, sourceArchiveAvailable:false, provenanceComplete:false, legalAcceptance:false, ready:false });
}
async function verifyClosedTree(root, rows, options) {
  try { return await observeTree(root,rows,options); }
  catch (cause) { if (cause?.code?.startsWith('media.profile_')) throw cause; throw fail(cause?.code === 'ENOENT' ? 'missing' : 'unavailable',cause); }
}
module.exports = Object.freeze({ verifyClosedTree });
