'use strict';
// Owned path construction and actual child close observations shared by the
// native regression and the generated-runtime migration E2E. No native stubs.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');

function createOwnedProbeStage(root, ordinal, requestedLength) {
  assert.equal(path.resolve(root), root);
  const leaf = '.ruyi-short-probe-' + 'a'.repeat(64);
  const caseRoot = path.join(root, 'probe-' + ordinal), tail = path.join('skills', '.ruyi-copy-probe-stage');
  const minimum = path.join(caseRoot, 'P', tail).length + leaf.length + 1;
  // A long runner TEMP may already exceed the nominal lower boundary. Keep the
  // actual length explicit and continue testing beyond MAX_PATH in that case.
  const probeLength = Math.max(requestedLength, minimum);
  let left = probeLength - leaf.length - 1 - path.join(caseRoot, 'P', tail).length + 1;
  assert.ok(Number.isSafeInteger(left) && left >= 1 && left <= 4096);
  const parts = [];
  while (left > 100) { const take = Math.min(100, left - 2); parts.push('P'.repeat(take)); left -= take + 1; }
  parts.push('P'.repeat(left));
  const stage = path.join(caseRoot, ...parts, tail), relative = path.relative(root, stage);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.equal(path.join(stage, leaf).length, probeLength);
  assert.ok(relative.split(path.sep).every(part => part.length <= 100));
  fs.mkdirSync(stage, { recursive: true });
  return { stage, requestedLength, probeLength };
}

async function runNativeShortProbes(api, root, lengths = [250, 259, 260, 261, 270, 350, 512, 1024]) {
  const original = cp.spawn, children = [], results = [];
  cp.spawn = function (...args) {
    const child = Reflect.apply(original, this, args), row = { pid: child.pid, spawn: false, exit: false, close: false };
    children.push(row);
    child.once('spawn', () => { row.spawn = true; });
    child.once('exit', code => { row.exit = true; row.exitCode = code; });
    child.once('close', code => { row.close = true; row.closeCode = code; });
    return child;
  };
  try {
    for (let ordinal = 0; ordinal < lengths.length; ordinal++) {
      const target = createOwnedProbeStage(root, ordinal, lengths[ordinal]), start = children.length;
      const broker = await api.migrationCapsuleBroker();
      let primary, failed = false;
      try {
        await broker.command({ cmd: 'short-probe', root: target.stage });
        await broker.command({ cmd: 'store-flush', root: target.stage });
      }
      catch (error) { primary = error; failed = true; }
      try { await broker.close(); }
      catch (cleanup) { throw new AggregateError([...(failed ? [primary] : []), cleanup], 'owned native probe close failed'); }
      if (failed) throw primary;
      assert.equal(api.MigrationHooks.helperMayStillRun(), false);
      const observed = children.slice(start);
      assert.equal(observed.length, 1);
      for (const row of observed) {
        assert.equal(row.spawn, true); assert.equal(row.exit, true); assert.equal(row.close, true);
        assert.equal(row.exitCode, 0); assert.equal(row.closeCode, 0);
      }
      assert.deepEqual(fs.readdirSync(target.stage), [], 'delete-on-close leaves no probe file');
      results.push({ ...target, helpers: observed });
    }
    return results;
  } finally { cp.spawn = original; }
}

module.exports = { createOwnedProbeStage, runNativeShortProbes };
