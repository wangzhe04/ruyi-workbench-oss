'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const io = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { test } = require('node:test');
const { createPreservedReaderModel } = require('../lib/work-data-preserved-reader-model');

const source = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const read = name => fs.readFileSync(path.join(source, name), 'utf8');
const { tree, manifestType } = vm.runInNewContext(
  read('01v-work-data-manifest.js') + '\n' + read('01aa-work-data-tree.js')
    + '\n({ tree: WorkDataTree, manifestType: WorkDataManifest });',
  { require, Buffer, process }
);
async function directoryId(file) {
  const stat = await io.lstat(file, { bigint: true });
  return stat.dev.toString(16).padStart(8, '0') + stat.ino.toString(16).padStart(16, '0');
}

test('only a manifest-issued candidate for the exact baseline crosses a paired source census', async t => {
  const root = await io.mkdtemp(path.join(os.tmpdir(), 'ruyi-candidate-boundary-'));
  t.after(() => io.rm(root, { recursive: true, force: false }));
  await io.writeFile(path.join(root, 'stable.json'), 'original');
  const owner = { roots: [root] };
  const baseline = { sourceFiles: [{ path: 'stable.json' }], sourceDirectories: [{ path: '' }] };
  const baselineSha256 = crypto.createHash('sha256').update(JSON.stringify(baseline)).digest('hex');
  let created;
  const manifest = manifestType.create({
    base: root,
    async candidateAllocator({ candidate, assertIssued }) {
      created = candidate;
      assert.equal(assertIssued(candidate), true);
      assert.equal(assertIssued({ ...candidate }), false);
      await io.mkdir(candidate.root);
      return {
        candidate, root: candidate.root, id: await directoryId(candidate.root), baselineSha256,
        parents: await Promise.all([root, path.join(root, '.work-data'), path.dirname(candidate.root)].map(directoryId)),
      };
    },
  });
  const candidate = await manifest.prepare({ expected: await manifest.readActive(), mode: 'encrypted' });
  assert.equal(candidate, created);
  await io.writeFile(path.join(candidate.root, 'output.bin'), 'candidate bytes');
  assert.throws(() => manifest.candidateBoundary({ ...candidate }, baseline), /candidate_invalid/);
  assert.throws(() => manifest.candidateBoundary(candidate, { ...baseline, sourceFiles: [] }), /candidate_invalid/);

  const model = createPreservedReaderModel(), seen = [];
  const capturePreserved = async (file, revision, readback) => {
    const context = tree.claimPreservedReadbackContext(readback, file, revision);
    assert.equal(tree.claimPreservedReadbackContext(readback, file, revision), null);
    seen.push(context.candidateBoundary);
    const scan = async rev => {
      const state = await model(file, rev);
      const rel = context.candidateBoundary?.rel;
      if (rel) state.entries = state.entries.filter(row => row.rel !== rel && !row.rel.startsWith(rel + '/'));
      return state;
    };
    await readback.bind(await scan(revision));
    return scan(readback.revision);
  };
  const reader = tree.createPreserved({
    capturePreserved, ownership: owner, assertExclusive: value => value === owner,
    candidateAuthority(value, scope) {
      assert.equal(scope, root);
      return manifest.candidateBoundary(value, baseline);
    },
  });
  const scoped = await reader.capture(root, candidate);
  try {
    assert.deepEqual(Array.from(scoped.files, row => row.path), ['stable.json']);
    await reader.verify(scoped);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.equal(seen[0].id, await directoryId(candidate.root));
  } finally { scoped.release(); }

  const full = await reader.capture(root);
  try {
    assert.equal(seen[2], null);
    assert.ok(full.files.some(row => row.path.endsWith('/output.bin')));
  } finally { full.release(); }
  const unpaired = tree.createPreserved({
    capturePreserved: model, ownership: owner, assertExclusive: value => value === owner,
    candidateAuthority: value => manifest.candidateBoundary(value, baseline),
  });
  await assert.rejects(() => unpaired.capture(root, candidate), /preserved_native_invalid/);
});
