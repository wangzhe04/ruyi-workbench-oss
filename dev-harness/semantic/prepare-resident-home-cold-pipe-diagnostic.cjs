'use strict';
// Stage from an inert historical replay. This script starts no processes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const diagnostics = require('./resident-home-cold-pipe-diagnostic.cjs');

const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, 'output');
const hash = diagnostics.hash;
const json = v => JSON.stringify(v, null, 2) + '\n';
const write = (file, data) => fs.writeFileSync(file, data, { flag: 'wx' });
const bind = (file, bytes) => ({ file, bytes: bytes.length, sha256: hash(bytes) });
function check(row) {
  const bytes = fs.readFileSync(row.file);
  assert.equal(bytes.length, row.bytes, row.file);
  assert.equal(hash(bytes), row.sha256, row.file);
  return bytes;
}
function readPinned(file, pin) {
  assert.match(pin, /^[a-f0-9]{64}$/);
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), pin, file);
  return bytes;
}
function stage(name, baseName, basePin, build, buildPin) {
  assert.equal(process.platform, 'win32');
  assert.equal(fs.realpathSync.native(output), output);
  assert.match(baseName, /^home-handoff-replay-pipe-base-[a-z0-9-]+$/);
  assert.match(build, /^home-cold-pipe-build-[a-z0-9-]+$/);
  assert.match(name, /^home-handoff-replay-cold-pipe-[a-z0-9-]+$/);
  const before = path.join(output, baseName), directory = path.join(output, name);
  assert.ok(!fs.existsSync(directory));
  assert.ok(!fs.existsSync(path.join(before, 'CONSUMED')), 'Baseline replay must be inert');
  const originalFile = path.join(before, 'freeze.json'), original = readPinned(originalFile, basePin);
  const old = JSON.parse(original);
  assert.equal(old.directory, before);
  assert.equal(old.scene, 'handoff');
  assert.equal(old.bindings.length, 104);
  assert.equal(old.nativeExecutionApproved, false);
  const receiptFile = path.join(output, build, 'compile-receipt.json');
  const receipt = readPinned(receiptFile, buildPin), compiled = JSON.parse(receipt);
  assert.equal(compiled.status, 'COMPILE_ONLY_COLD_PIPE_DIAGNOSTIC');
  assert.equal(compiled.compiledOutputExecuted, false);
  const origSource = (name) => compiled.original.find(row => path.basename(row.file) === name);
  assert.equal(check(compiled.host).toString(), diagnostics.host(check(origSource('DesktopLifetimeHost.cs'))));
  assert.equal(check(compiled.source).toString(), diagnostics.probe(check(origSource('DesktopLifecycleProbe.cs'))));

  const map = value => {
    if (typeof value === 'string') return value === before || value.startsWith(before + path.sep)
      ? directory + value.slice(before.length) : value;
    if (Array.isArray(value)) return value.map(map);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,map(v)]));
    return value;
  };
  const frozen = map(old);
  const config = path.join(old.base, 'app', 'scene-lock.json');
  const fixtureOld = path.join(old.base, 'app', 'server.js');
  const traceSource = require.resolve('./resident-home-cold-phase-trace.cjs');
  const traceTarget = path.join(frozen.base, 'app', 'cold-phase-trace.cjs');
  const trace = fs.readFileSync(traceSource);
  const fixture = Buffer.from(diagnostics.fixture(check(old.bindings.find(row => row.file === fixtureOld))));
  const tool = check(compiled.output);
  const externalController = old.executionLayout.externalTestController.file;
  const controllerFile = path.join(directory, 'controller-cold-pipe.cjs');
  const controller = Buffer.from(diagnostics.controller(check(old.bindings.find(r => r.file === externalController)),
    compiled.output.sha256, repo, path.join(path.dirname(externalController), 'observers.cjs'),
    path.join(path.dirname(externalController), 'proof.cjs')));

  fs.mkdirSync(directory);
  frozen.bindings = old.bindings.map(row => {
    const input = check(row);
    const file = map(row.file);
    if (file === row.file) return row;
    let bytes = input;
    if (row.file === old.actor) bytes = tool;
    if (row.file === fixtureOld) bytes = fixture;
    if (row.file === config) {
      const cfg = map(JSON.parse(input));
      Object.assign(cfg.bindings.find(r => r.file === map(fixtureOld)), bind(map(fixtureOld), fixture));
      cfg.bindings.push(bind(traceTarget, trace));
      bytes = Buffer.from(json(cfg));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    write(file, bytes);
    return bind(file, bytes);
  });
  write(traceTarget, trace);
  write(controllerFile, controller);
  const fixtureSource = path.join(directory, 'server-cold-pipe.cjs');
  write(fixtureSource, fixture);
  for (const home of [frozen.actorHome, frozen.observerHome])
    for (const sub of ['tmp', 'local', 'roaming']) fs.mkdirSync(path.join(home, sub), { recursive: true });
  fs.mkdirSync(frozen.output);
  fs.mkdirSync(frozen.workData);
  for (const [target, source, bytes] of [[frozen.actor, compiled.output.file, tool], [map(fixtureOld), fixtureSource, fixture]])
    Object.assign(frozen.copies.find(r => r.target === target), bind(target, bytes), { source });
  frozen.copies.push({ ...bind(traceTarget, trace), target: traceTarget, source: traceSource });
  frozen.compiledSha256 = compiled.output.sha256;
  frozen.executionLayout.externalTestController.file = controllerFile;
  frozen.executionLayout.actualExecutedOrLeasedInputs.push({ file: traceTarget, underReadonlyRoot: true, usage: 'cold-only finite event diagnostics' });
  frozen.coldPipeDiagnostic = { inertBaseSha256: basePin, compileReceiptSha256: buildPin,
    hostChanges: 'diagnostic stage/reason and HRESULT only', coldTrace: path.join(frozen.output, 'cold-pipe-phases.jsonl') };
  const sourceInputs = [__filename, traceSource, require.resolve('./resident-home-cold-pipe-diagnostic.cjs'),
    require.resolve('./resident-home-handoff-diagnostic.cjs'), require.resolve('./compile-resident-home-cold-pipe-diagnostic.cjs')];
  frozen.bindings = [...new Map([...frozen.bindings, ...compiled.original, compiled.host, compiled.source, compiled.log, compiled.output,
    bind(originalFile, original), bind(receiptFile, receipt), bind(traceTarget, trace), bind(controllerFile, controller),
    bind(fixtureSource, fixture), ...sourceInputs.map(file => bind(file, fs.readFileSync(file)))].map(row => [row.file, row])).values()];
  frozen.bindings.forEach(check);
  JSON.parse(fs.readFileSync(map(config))).bindings.forEach(check);
  const file = path.join(directory, 'freeze.json');
  const data = Buffer.from(json(frozen));
  write(file, data);
  const powershell = frozen.bindings.find(row => path.basename(row.file).toLowerCase() === 'powershell.exe').file;
  return { file, sha256: hash(data), bindings: frozen.bindings.length, nativeExecutionApproved: false,
    rootReviewCommand: { executable: powershell, arguments: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', frozen.keeper, '-Root', directory, '-Node', frozen.node, '-Script', controllerFile,
      '-ControllerSha256', hash(controller), '-Contract', file, '-ContractSha256', hash(data)] } };
}
if (require.main === module) console.log(json(stage(...process.argv.slice(2))));
