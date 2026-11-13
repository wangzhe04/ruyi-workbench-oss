'use strict';
require('./lib/self-isolate-home');
// Opt-in real production helper + capture-only owned Cocoa window in actual motion.
// Tests a witnessed window_changed refusal, plus exact stable coordinate/pixel controls.
// Moving successes check dimensions/pattern and motion bounds, not exact instant-by-instant origin.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { decodePng } = require('./lib/png-grid');
const t = createRunner('MACOS CAPTURE TRANSITION');
const evidence = process.env.RUYI_P5_TRANSITION_EVIDENCE;
const helper = process.env.RUYI_P5_TRANSITION_HELPER || path.resolve(__dirname, '../ruyi-workbench/runtime/macos/ruyi-automation-helper');
const reports = [], captures = [], cleanups = [], observed = new Map(), activeHelpers = new Set();
let root, fixture, helperHash, retained = false;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function check(condition, label) { t.ok(condition, label); if (!condition) throw new Error('Stopped after failed assertion: ' + label); }
async function until(read, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out: ' + label);
}
function observe(child) {
  const table = snapshotProcessTable();
  if (!table) throw new Error('Owned process snapshot unavailable');
  const row = table.find(item => item.pid === child.pid);
  if (!row || row.ppid !== process.pid || child.exitCode !== null || child.signalCode !== null)
    throw new Error('Cannot confirm live owned process identity');
  const tree = ownDescendants(table, child.pid);
  if (!tree.root || tree.root.created !== row.created) throw new Error('Owned tree identity unavailable');
  for (const item of [tree.root, ...tree.descendants]) observed.set(item.pid + '/' + item.created, item);
  return row;
}
async function command(text) {
  const offset = reports.length; fixture.stdin.write(text + '\n');
  return until(() => reports.slice(offset).find(row => row.event === text || row.event === 'motion-unavailable'), 'fixture ' + text);
}
async function native(payload, label) {
  if (sha(fs.readFileSync(helper)) !== helperHash) throw new Error('Native helper changed before capture');
  const startedAt = Date.now();
  const child = cp.spawn(helper, [], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  activeHelpers.add(child);
  const chunks = [], errors = []; let length = 0, stderrBytes = 0, failure;
  const endedPromise = new Promise(resolve => {
    child.once('error', error => { failure ||= error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stop = error => {
    failure ||= error; retained = true;
    cleanups.push({ label, forced: true, receipt: killOwnTree(child) });
  };
  const timer = setTimeout(() => stop(new Error('Native helper exceeded external bounded deadline')), 18000);
  child.stdout.on('data', chunk => { length += chunk.length; if (length > 68 * 1024 * 1024) stop(new Error('Native response too large')); else chunks.push(chunk); });
  child.stdout.on('error', error => stop(error));
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes <= 8192) errors.push(chunk); });
  child.stderr.on('error', error => stop(error));
  child.stdin.on('error', error => { failure ||= error; });
  try { observe(child); child.stdin.end(JSON.stringify({ version: 1, ...payload })); }
  catch (error) { stop(error); }
  const ended = await endedPromise;
  clearTimeout(timer); activeHelpers.delete(child);
  const row = { label, startedAt, endedAt: Date.now(), exitCode: ended.code, signal: ended.signal,
    stderr: Buffer.concat(errors).toString('utf8'), stderrBytes, stderrTruncated: stderrBytes > 8192 };
  captures.push(row);
  if (failure) { row.failure = failure.message; throw failure; }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || typeof result.ok !== 'boolean' || ended.signal !== null || ended.code !== (result.ok ? 0 : 1)
      || result.ok && result.protocolVersion !== 1) throw new Error('Invalid actual helper envelope or abnormal exit');
  if (sha(fs.readFileSync(helper)) !== helperHash) throw new Error('Native helper changed during capture');
  const image = result.png && Buffer.from(result.png, 'base64');
  const { png: _png, ...metadata } = result;
  Object.assign(row, { result: metadata, pngSha256: image && sha(image) });
  if (evidence && image) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, label + '.png'), image); }
  return { result: metadata, image, row };
}
function pattern(capture, contentOffset, backingScale, label) {
  const result = capture.result, image = decodePng(capture.image);
  const points = [[30, 30, [255, 0, 0]], [contentOffset.width - 30, 30, [0, 255, 0]],
    [30, contentOffset.height - 30, [0, 0, 255]], [contentOffset.width - 30, contentOffset.height - 30, [255, 255, 0]]];
  const matched = points.map(([x, y, expected]) => {
    const px = Math.floor((contentOffset.x + x) * backingScale), py = Math.floor((contentOffset.y + y) * backingScale);
    if (px < 0 || py < 0 || px >= image.width || py >= image.height) return false;
    const offset = (py * image.width + px) * 4;
    return expected.every((value, index) => Math.abs(image.pixels[offset + index] - value) < 30);
  });
  capture.row.patternMatches = matched; capture.row.fixtureBackingScale = backingScale;
  check(Number.isFinite(backingScale) && backingScale > 0 && image.width === result.width && image.height === result.height
    && result.width === Math.ceil(result.logical_bounds.width * backingScale) && result.height === Math.ceil(result.logical_bounds.height * backingScale) && matched.every(Boolean), label + ' has coherent physical dimensions and all four content markers');
}
function stableGeometry(capture, actual, label) {
  check(capture.result.ok && capture.result.window_id === actual.id && capture.result.pid === actual.pid
    && ['x', 'y', 'width', 'height'].every(key => capture.result.logical_bounds?.[key] === actual.frame[key]),
    label + ' matches actual owned WindowServer identity and logical bounds');
}
(async () => {
  try {
    if (process.platform !== 'darwin' || process.env.RUYI_P5_TRANSITION_REQUIRED !== '1') { console.log('SKIP opt-in real capture/window transition'); return; }
    root = fs.mkdtempSync('/tmp/p5motion-'); helperHash = sha(fs.readFileSync(helper));
    const status = await native({ op: 'status' }, 'status');
    check((status.result.ready === true || status.result.ready === 1) && status.result.locked === false, 'actual production capture helper is ready on an unlocked desktop');
    const binary = path.join(root, 'fixture');
    const built = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.0',
      '-framework', 'AppKit', '-framework', 'ApplicationServices', path.join(__dirname, 'fixtures/macos-capture-motion.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (built.status !== 0) throw new Error(built.stderr);
    fixture = cp.spawn(binary, [], { env: { ...fixtureChildEnv(), TMPDIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let fixtureError; fixture.once('error', error => { fixtureError = error; });
    fixture.stderr.resume(); let buffer = '';
    fixture.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
      reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    observe(fixture);
    const ready = await until(() => { if (fixtureError) throw fixtureError; return reports.find(row => row.event === 'ready'); }, 'owned stable window');
    check(ready.ok === true && ready.pid === fixture.pid && ready.onScreen === true, 'fixture reports its exact owned visible WindowServer identity');
    const offset = { x: ready.content.x - ready.frame.x, y: ready.content.y - ready.frame.y, width: ready.content.width, height: ready.content.height };
    const before = await native({ op: 'capture', window_title: ready.title }, 'stable-before');
    stableGeometry(before, ready, 'stable before motion'); pattern(before, offset, ready.backingScale, 'stable before motion');
    const start = await command('motion-start');
    check(start.event === 'motion-start' && start.ok && start.moving, 'only the owned fixture starts actual monotonic window movement');
    let changed = 0, witnessed = 0, successes = 0;
    for (let index = 0; index < 8; index++) {
      const capture = await native({ op: 'capture', window_title: ready.title }, 'moving-' + index);
      const observedAfter = await command('state'); // Drain earlier fixture records without injecting input or restarting capture.
      const during = reports.filter(row => row.event === 'motion-frame' && row.wall_ms >= capture.row.startedAt && row.wall_ms <= capture.row.endedAt);
      const positions = [...new Set(during.filter(row => row.ok && row.pid === ready.pid && row.id === ready.id
        && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(row.frame?.[key])))
        .map(row => JSON.stringify(['x', 'y', 'width', 'height'].map(key => row.frame[key]))))];
      capture.row.observedFramesDuringRequest = positions.length;
      if (positions.length >= 2) witnessed++;
      if (capture.result.ok) {
        successes++; pattern(capture, offset, ready.backingScale, 'moving frame ' + index);
        check(observedAfter.ok && observedAfter.backingScale === ready.backingScale && capture.result.window_id === ready.id && capture.result.pid === ready.pid
          && capture.result.logical_bounds.x >= start.frame.x && capture.result.logical_bounds.x <= observedAfter.frame.x
          && capture.result.logical_bounds.y === ready.frame.y
          && capture.result.logical_bounds.width === ready.frame.width && capture.result.logical_bounds.height === ready.frame.height,
          'moving success retains owned identity, actual motion range and fixed nontranslation geometry');
      } else {
        check(['window_changed', 'capture_failed'].includes(capture.result.code) && !capture.image, 'moving capture returns a bounded explicit refusal with no image');
        if (capture.result.code === 'window_changed' && positions.length >= 2) changed++;
      }
    }
    const stopped = await command('motion-stop');
    check(stopped.ok && !stopped.moving && stopped.ticks > 0 && stopped.frame.x > ready.frame.x,
      'actual window movement ends at a changed owned position without touching display settings');
    check(changed >= 1 && witnessed >= 1, 'at least one real geometry transition during a capture is refused as window_changed');
    const after = await native({ op: 'capture', window_title: ready.title }, 'stable-after');
    stableGeometry(after, stopped, 'stable after motion'); pattern(after, offset, stopped.backingScale, 'stable after motion');
    captures.push({ label: 'motion-summary', changedRefusalsWithWitness: changed, requestsWithMotionWitness: witnessed, movingSuccesses: successes });
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const child of activeHelpers) { retained = true; cleanups.push({ label: 'unfinished native capture', receipt: killOwnTree(child) }); }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      try { observe(fixture); } catch (error) { retained = true; t.fail(error.message); }
      fixture.stdin.write('quit\n');
      try { await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 'fixture exit', 5000); }
      catch (error) { retained = true; t.fail(error.message); cleanups.push({ label: 'fixture fallback', receipt: killOwnTree(fixture) }); }
    }
    if (root) {
      try { if (!observed.size) throw new Error('No owned birth identities were confirmed');
        await until(() => { const table = snapshotProcessTable(); return table && [...observed.values()].every(prior => !table.some(row => row.pid === prior.pid && row.created === prior.created)); }, 'observed owned identities exit', 10000);
        t.ok(true, 'all observed owned fixture/helper birth identities exited');
      } catch (error) { retained = true; t.fail(error.message); }
    }
    if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ helper, helperHash, captures, reports, cleanups,
      observed: [...observed.values()].map(row => ({ ...row, created: String(row.created) })), retainedRoot: retained ? root : null,
      scope: 'Production helper raw capture, actual owned-window movement and stable controls. No input/clipboard mutation, OS lock, TCC revoke, physical display reconfiguration or normal provider/App launch.' }, null, 2) + '\n'); }
    if (root && !retained) fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
