'use strict';

// Restage one pinned prebuilt scene for review. This script starts no processes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const diagnostic = require('./resident-home-handoff-diagnostic.cjs');

const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, 'output');
const scenes = {
  'normal-close': ['home-normal-r2', '15b99d4c87b3e16d83787c397a4cc8806b42a8b965b9380aad381b9a6ab4762e'],
  handoff: ['home-handoff-r2', '459287e1e8c2dfa8ecb60f100dfcf3335be6de2d5debee1663a9af7007476851'],
};
const manifest = path.join(repo, 'ruyi-workbench/app/src/manifest.json');
const archive = path.join(repo, 'docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-blocker-first-batch-reviewed-r1/0315.gz');
const archivePin = 'f6d3c6259e228535558ecd4e779a25ba0bdfc7edd9e5bbd6e8522180d2364c33';
const filesystemObserver = path.join(__dirname, 'resident-home-replay-filesystem-observer.ps1');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readPinned = (file, pin) => {
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), pin, file);
  return bytes;
};
const readBinding = (row, file = row.file) => {
  const bytes = readPinned(file, row.sha256);
  assert.equal(bytes.length, row.bytes, file);
  return bytes;
};
const write = (file, bytes) => fs.writeFileSync(file, bytes, { flag: 'wx' });
const json = value => JSON.stringify(value, null, 2) + '\n';
const inRoot = (root, file) => file.startsWith(root + path.sep);

function prepare(scene, name, buildName, buildPin) {
  assert.ok(Object.hasOwn(scenes, scene) && /^home-(normal|handoff)-replay-[a-z0-9-]+$/.test(name)
    && name.startsWith(scene === 'normal-close' ? 'home-normal-' : 'home-handoff-'),
    'Choose normal-close or handoff and a fresh home-normal-replay-* or home-handoff-replay-* directory name');
  assert.equal(process.platform, 'win32');
  assert.equal(fs.realpathSync(output), output, 'The output root must be canonical');
  const [originalName, originalPin] = scenes[scene];
  const original = path.join(output, originalName);
  const directory = path.join(output, name);
  assert.ok(!fs.existsSync(directory), 'Replay directory already exists');
  const originalFile = path.join(original, 'freeze.json');
  const frozen = JSON.parse(readPinned(originalFile, originalPin));
  assert.equal(frozen.scene, scene);
  assert.equal(frozen.directory, original);
  assert.equal(frozen.bindings.length, 104);
  assert.equal(frozen.nativeExecutionApproved, false);

  const archived = gunzipSync(readPinned(archive, archivePin));
  const oldManifestBinding = frozen.bindings.find(row => row.file === manifest);
  assert.ok(oldManifestBinding, 'Historical manifest binding missing');
  assert.equal(archived.length, oldManifestBinding.bytes);
  assert.equal(hash(archived), oldManifestBinding.sha256);
  const config = path.join(frozen.base, 'app', 'scene-lock.json');
  const localBytes = new Map();
  for (const row of frozen.bindings) {
    if (row === oldManifestBinding) continue;
    const bytes = readBinding(row);
    if (inRoot(original, row.file)) localBytes.set(row.file, bytes);
  }
  assert.equal(hash(localBytes.get(frozen.actor)), frozen.compiledSha256);

  let preparedProbe = null, fixtureBytes = null, diagnosticBindings = [];
  if (buildName || buildPin) {
    assert.match(buildName, /^home-diagnostic-build-[a-z0-9-]+$/);
    assert.match(buildPin, /^[0-9a-f]{64}$/);
    const build = path.join(output, buildName);
    const receiptFile = path.join(build, 'compile-receipt.json');
    const receiptBytes = readPinned(receiptFile, buildPin);
    const compiled = JSON.parse(receiptBytes);
    assert.equal(compiled.status, 'COMPILE_ONLY_DIAGNOSTIC_PROBE');
    assert.equal(compiled.compiledOutputExecuted, false);
    assert.equal(compiled.output.file, path.join(build, 'DesktopLifecycleProbe.exe'));
    assert.equal(compiled.source.file, path.join(build, 'DesktopLifecycleProbe.cs'));
    assert.equal(readBinding(compiled.source).toString('utf8'), diagnostic.probe(
      readBinding(compiled.original.find(row => path.basename(row.file) === 'DesktopLifecycleProbe.cs'))));
    compiled.original.forEach(row => readBinding(row));
    preparedProbe = compiled.output;
    localBytes.set(frozen.actor, readBinding(preparedProbe));
    const fixture = path.join(frozen.base, 'app', 'server.js');
    fixtureBytes = Buffer.from(diagnostic.fixture(localBytes.get(fixture)));
    localBytes.set(fixture, fixtureBytes);
    diagnosticBindings = [compiled.source, compiled.output, ...compiled.original, compiled.log,
      { file: receiptFile, bytes: receiptBytes.length, sha256: buildPin }];
  }

  const restoredManifest = path.join(directory, 'archived-source', 'ruyi-workbench', 'app', 'src', 'manifest.json');
  const relocate = file => file === original ? directory : file === manifest ? restoredManifest
    : inRoot(original, file) ? path.join(directory, path.relative(original, file)) : file;
  function relocateValues(value) {
    if (typeof value === 'string') return relocate(value);
    if (Array.isArray(value)) return value.map(relocateValues);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, relocateValues(entry)]));
    }
    return value;
  }

  fs.mkdirSync(directory);
  fs.mkdirSync(path.dirname(restoredManifest), { recursive: true });
  write(restoredManifest, archived);
  for (const [file, bytes] of localBytes) {
    const target = relocate(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file === config) {
      const cfg = relocateValues(JSON.parse(bytes));
      if (fixtureBytes) {
        const targetBinding = cfg.bindings.find(row => row.file === path.join(relocate(frozen.base), 'app', 'server.js'));
        Object.assign(targetBinding, { bytes: fixtureBytes.length, sha256: hash(fixtureBytes) });
      }
      write(target, json(cfg));
    } else write(target, bytes);
  }
  const replay = relocateValues(frozen);
  fs.mkdirSync(replay.output);
  fs.mkdirSync(replay.workData);
  for (const home of [replay.actorHome, replay.observerHome]) {
    for (const leaf of ['tmp', 'local', 'roaming']) fs.mkdirSync(path.join(home, leaf), { recursive: true });
  }

  const newConfig = relocate(config);
  const configBytes = fs.readFileSync(newConfig);
  const configBinding = replay.bindings.find(row => row.file === newConfig);
  Object.assign(configBinding, { bytes: configBytes.length, sha256: hash(configBytes) });
  const observerBinding = replay.bindings.find(row => row.file === replay.fsScript);
  const observerBytes = fs.readFileSync(filesystemObserver);
  replay.fsScript = filesystemObserver;
  replay.fsScriptSha256 = hash(observerBytes);
  Object.assign(observerBinding, { file: replay.fsScript, bytes: observerBytes.length, sha256: replay.fsScriptSha256 });
  if (preparedProbe) {
    const refresh = (row, bytes) => Object.assign(row, { bytes: bytes.length, sha256: hash(bytes) });
    const fixturePath = path.join(replay.base, 'app', 'server.js');
    const fixtureSource = path.join(directory, 'server-diagnostic.cjs');
    write(fixtureSource, fixtureBytes);
    const actorBinding = replay.bindings.find(row => row.file === replay.actor);
    const fixtureBinding = replay.bindings.find(row => row.file === fixturePath);
    const actorBytes = readBinding(preparedProbe);
    refresh(actorBinding, actorBytes);
    refresh(fixtureBinding, fixtureBytes);
    const actorCopy = replay.copies.find(row => row.target === replay.actor);
    const fixtureCopy = replay.copies.find(row => row.target === fixturePath);
    refresh(actorCopy, actorBytes).source = preparedProbe.file;
    refresh(fixtureCopy, fixtureBytes).source = fixtureSource;
    const fixtureSourceBinding = refresh({ file: fixtureSource }, fixtureBytes);
    const historicalController = replay.executionLayout.externalTestController.file;
    const historicalSource = path.dirname(historicalController);
    const controller = path.join(directory, 'controller-diagnostic.cjs');
    const controllerBytes = Buffer.from(diagnostic.controller(fs.readFileSync(historicalController), preparedProbe.sha256,
      repo, path.join(historicalSource, 'observers.cjs'), path.join(historicalSource, 'proof.cjs')));
    write(controller, controllerBytes);
    replay.executionLayout.externalTestController.file = controller;
    replay.compiledSha256 = preparedProbe.sha256;
    replay.diagnosticProbe = { compileReceiptSha256: buildPin, originalProbeSha256: diagnostic.pins.probe,
      originalControllerSha256: diagnostic.pins.controller, originalFixtureSha256: diagnostic.pins.fixture,
      productHostChanged: false };
    const ownBindings = [__filename, require.resolve('./resident-home-handoff-diagnostic.cjs'),
      require.resolve('./compile-resident-home-handoff-diagnostic.cjs')].map(file => refresh({ file }, fs.readFileSync(file)));
    replay.bindings = [...new Map([...replay.bindings, ...diagnosticBindings, ...ownBindings,
      fixtureSourceBinding, refresh({ file: controller }, controllerBytes)].map(row => [row.file, row])).values()];
  }
  for (const row of replay.bindings) readBinding(row);
  for (const row of JSON.parse(configBytes).bindings) readBinding(row);
  const controller = replay.executionLayout.externalTestController.file;
  const controllerPin = replay.bindings.find(row => row.file === controller).sha256;
  const powershell = replay.bindings.find(row => path.basename(row.file).toLowerCase() === 'powershell.exe').file;
  const file = path.join(directory, 'freeze.json');
  const bytes = json(replay);
  write(file, bytes);
  return {
    scene, file, sha256: hash(bytes), bindings: replay.bindings.length, compiledSha256: replay.compiledSha256,
    original: { file: originalFile, sha256: originalPin }, sourceArchive: { file: archive, sha256: archivePin },
    filesystemObserver: { file: replay.fsScript, sha256: replay.fsScriptSha256 },
    nativeExecutionApproved: false,
    rootReviewCommand: { executable: powershell, arguments: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', replay.keeper, '-Root', directory, '-Node', replay.node, '-Script', controller,
      '-ControllerSha256', controllerPin, '-Contract', file, '-ContractSha256', hash(bytes)] },
  };
}

if (require.main === module) console.log(json(prepare(process.argv[2], process.argv[3], process.argv[4], process.argv[5])));
