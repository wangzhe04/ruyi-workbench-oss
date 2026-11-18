'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const output = path.resolve(__dirname, '../../output');
const source = path.join(output, 'semantic-standalone-napi-guard-candidate-v1/freeze.json');
const sourceHash = 'de668a12790c2bd3e2ecd8318f6f1ee18c810af908959fa992980697c59b3e2b';
const keeperSource = path.join(__dirname, 'resident-proxy-win32-keeper.ps1');
const keeperHash = '9e0d09baed2a7e991d8637f6baddbf099f89fc60d4440f863253f28650526435';
const witness = path.join(__dirname, 'standalone-napi-runtime-149-witness.ps1');
const allowedBuilds = {
  'standalone-napi-149-compile-r1': '63ed1315b70dac7b0c0082b905d07787470908c61af17944cdaf82044d719380',
  'standalone-napi-149-terra-r1': '8fd3dd7d08a509b222114751aea9bcfeed29df4407a3b03745a53454087a7f24',
};
const pass = 'PASS_STANDALONE_NAPI_PRIMITIVE_ONLY';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pin = file => {
  const bytes = fs.readFileSync(file);
  return { file, bytes: bytes.length, sha256: hash(bytes) };
};
const verify = rows => rows.forEach(row => assert.deepEqual(pin(row.file), {
  file: row.file, bytes: row.bytes, sha256: row.sha256,
}));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });

function prepare(name, build) {
  assert.equal(process.platform, 'win32');
  assert.match(name, /^standalone-napi-149-runtime-[\w-]+$/);
  assert.ok(Object.hasOwn(allowedBuilds, build));
  assert.equal(pin(source).sha256, sourceHash);
  assert.equal(pin(keeperSource).sha256, keeperHash);
  const compile = read(source);
  assert.equal(compile.bindings.length, 46);
  verify(compile.bindings);
  const receipt = path.join(output, build, 'build-receipt.json');
  assert.equal(pin(receipt).sha256, allowedBuilds[build]);
  const compiled = read(receipt);
  assert.equal(compiled.status, 'COMPILE_ONLY_PASS_NOT_LOADED_NOT_NATIVE_QUALIFIED');
  assert.equal(compiled.freezeSha256, sourceHash);
  assert.equal(pin(process.execPath).sha256, compiled.node.sha256);
  verify([compiled.artifact, compiled.compiler]);
  const root = path.join(output, name);
  fs.mkdirSync(root);
  write(path.join(root, 'OWNER.json'), { owner: 'standalone-napi-149-runtime', synthetic: true });
  const keeperHome = path.join(root, 'keeper-home');
  fs.mkdirSync(path.join(keeperHome, 'tmp'), { recursive: true });
  const addon = path.join(root, '合成 guard.node');
  const invalid = path.join(root, 'invalid.node');
  const keeper = path.join(root, 'keeper.ps1');
  fs.copyFileSync(compiled.artifact.file, addon, fs.constants.COPYFILE_EXCL);
  assert.equal(pin(addon).sha256, compiled.artifact.sha256);
  fs.writeFileSync(invalid, 'Synthetic malformed PE fixture\n', { flag: 'wx' });
  const adapted = fs.readFileSync(keeperSource, 'utf8')
    .replace('PASS_PROXY_SYNTHETIC_CASE_NOT_FULL_QUALIFICATION', pass)
    .replaceAll('PASS_PROXY_SYNTHETIC_OUTER_DRAINED', 'PASS_STANDALONE_NAPI_OUTER_DRAINED')
    .replace('scoped synthetic proxy trial', 'scoped synthetic standalone N-API trial');
  fs.writeFileSync(keeper, adapted, { flag: 'wx' });
  const ps = fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const file = path.join(root, 'freeze.json');
  write(file, {
    root, node: process.execPath, addon, invalid, keeper, witness, ps,
    bindings: [...compile.bindings, ...[__filename, source, keeperSource, receipt, compiled.artifact.file,
      addon, invalid, keeper, witness, ps, process.execPath].map(pin)],
  });
  return { file, sha256: pin(file).sha256 };
}

function loadFreeze(file, sha256) {
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.equal(pin(file).sha256, sha256);
  const contract = read(file);
  assert.equal(contract.root, path.dirname(path.resolve(file)));
  assert.equal(pin(process.execPath).sha256, contract.bindings.find(row => row.file === contract.node).sha256);
  verify(contract.bindings);
  return contract;
}

function managed(file, args, options) {
  const child = cp.spawn(file, args, { windowsHide: true, ...options });
  const stdout = [], stderr = [];
  child.stdout?.on('data', data => stdout.push(data));
  child.stderr?.on('data', data => stderr.push(data));
  const finished = new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message }));
    child.once('close', (code, signal) => resolve({
      code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
    }));
  });
  return { child, finished };
}

async function evidence(file, pattern = /^\d+,\d+$/) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8');
      if (pattern.test(value)) return value;
    }
    await delay(20);
  }
  throw Error('Witness readiness deadline');
}

function expectCold(value) {
  assert.ok(Object.isFrozen(value));
  assert.equal(value.state, 'cold');
  assert.equal(value.protected, false);
  assert.equal(value.activeProcesses, 0);
  assert.equal(value.pid, process.pid);
  assert.match(value.creationFileTime, /^\d{17,}$/);
}

function expectArmed(value, onlySelf) {
  assert.ok(Object.isFrozen(value));
  assert.equal(value.state, 'armed');
  assert.equal(value.protected, true);
  assert.equal(value.activeProcesses, onlySelf ? 1 : 2);
  assert.equal(value.onlySelfObserved, onlySelf);
  assert.equal(value.inheritableJobHandle, false);
  assert.equal(value.win32Error, 0);
}

async function actor(root, addon, invalid, scenario) {
  if (scenario === 'invalid') {
    assert.throws(() => require(invalid), { code: 'ERR_DLOPEN_FAILED' });
    process.send({ rejected: 'ERR_DLOPEN_FAILED' }, () => process.disconnect());
    return;
  }
  const api = require(addon);
  assert.ok(Object.isFrozen(api));
  assert.deepEqual(Object.keys(api).sort(), ['arm', 'descriptor', 'scope']);
  expectCold(api.descriptor());
  for (const fn of [api.arm, api.descriptor]) assert.throws(() => fn(true), { code: 'RUYI_GUARD_NO_ARGUMENTS' });
  expectCold(api.descriptor());
  const armed = scenario !== 'unarmed';
  if (armed) {
    const first = api.arm();
    expectArmed(first, true);
    assert.deepEqual(api.arm(), first);
    delete require.cache[require.resolve(addon)];
    assert.deepEqual(require(addon).descriptor(), first);
  }
  const descendant = cp.spawn(process.execPath, [__filename, 'descendant', root, scenario], {
    cwd: root, windowsHide: true, detached: true, stdio: 'ignore',
  });
  descendant.on('error', error => { throw error; });
  descendant.unref();
  const ready = await evidence(path.join(root, scenario + '.descendant-ready'), /^\d+$/);
  assert.equal(Number(ready), descendant.pid);
  const descriptor = api.descriptor();
  if (armed) expectArmed(descriptor, false);
  else expectCold(descriptor);
  process.once('message', message => {
    assert.equal(message, 'normal-exit');
    process.disconnect();
  });
  process.send({ pid: descendant.pid, descriptor });
}

async function run(file, sha256) {
  const f = loadFreeze(file, sha256);
  const receipt = { status: 'FAIL', freezeSha256: sha256, cases: {} };
  try {
    for (const scenario of ['invalid', 'normal', 'hard', 'unarmed']) {
      const row = receipt.cases[scenario] = {};
      const owner = managed(f.node, [__filename, 'actor', f.root, f.addon, f.invalid, scenario], {
        cwd: f.root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      row.ready = await Promise.race([
        new Promise(resolve => owner.child.once('message', resolve)),
        owner.finished.then(result => { throw Error('Actor ended before readiness: ' + JSON.stringify(result)); }),
      ]);
      if (scenario === 'invalid') {
        assert.deepEqual(row.ready, { rejected: 'ERR_DLOPEN_FAILED' });
        row.owner = await owner.finished;
        assert.equal(row.owner.code, 0);
        continue;
      }
      assert.equal(row.ready.descriptor.pid, owner.child.pid);
      const watcher = managed(f.ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', f.witness,
        f.root, String(row.ready.pid), f.node, scenario], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
      const identity = await evidence(path.join(f.root, scenario + '.witness-ready'));
      assert.equal(identity.split(',')[0], String(row.ready.pid));
      if (scenario === 'hard') assert.equal(owner.child.kill('SIGKILL'), true);
      else owner.child.send('normal-exit');
      row.owner = await owner.finished;
      if (scenario === 'hard') assert.equal(row.owner.signal, 'SIGKILL');
      else assert.equal(row.owner.code, 0);
      if (scenario === 'unarmed') fs.writeFileSync(path.join(f.root, scenario + '.check'), 'check', { flag: 'wx' });
      row.witness = await watcher.finished;
      assert.equal(row.witness.code, 0, row.witness.stderr);
      row.descendant = JSON.parse(row.witness.stdout);
      assert.equal(row.descendant.exited, true);
      assert.equal(row.descendant.pid + ',' + row.descendant.creationFileTime, identity);
      const stop = path.join(f.root, scenario + '.stop');
      const returned = path.join(f.root, scenario + '.descendant-returned');
      assert.equal(fs.existsSync(stop), scenario === 'unarmed');
      assert.equal(fs.existsSync(returned), scenario === 'unarmed');
      if (scenario === 'unarmed') assert.equal(row.descendant.exitCode, 0);
    }
    verify(f.bindings);
    receipt.status = pass;
  } catch (error) {
    receipt.error = error.stack;
    process.exitCode = 1;
  } finally {
    write(path.join(f.root, 'receipt.json'), receipt);
  }
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'prepare') return console.log(JSON.stringify(prepare(...args)));
  if (operation === 'run') return run(...args);
  if (operation === 'actor') {
    try {
      await actor(...args);
    } catch (error) {
      process.disconnect();
      throw error;
    }
    return;
  }
  if (operation === 'descendant') {
    const [root, scenario] = args;
    const stop = path.join(root, scenario + '.stop');
    fs.writeFileSync(path.join(root, scenario + '.descendant-ready'), String(process.pid), { flag: 'wx' });
    while (!fs.existsSync(stop)) await delay(20);
    fs.writeFileSync(path.join(root, scenario + '.descendant-returned'), 'return', { flag: 'wx' });
    return;
  }
  assert.equal(operation, 'execute');
  const f = loadFreeze(...args);
  const system = path.resolve(path.dirname(f.ps), '../../..');
  const home = path.join(f.root, 'keeper-home');
  const temp = path.join(home, 'tmp');
  const env = {
    SystemRoot: system, WINDIR: system, SystemDrive: path.parse(system).root.slice(0, 2),
    PATH: path.join(system, 'System32'), PSModulePath: path.join(path.dirname(f.ps), 'Modules'),
    USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp,
  };
  const result = cp.spawnSync(f.ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', f.keeper,
    '-Root', f.root, '-Node', f.node, '-Script', __filename, '-ControllerSha256', pin(__filename).sha256,
    '-Contract', path.resolve(args[0]), '-ContractSha256', args[1]], { env, windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  console.log(JSON.stringify(read(path.join(f.root, 'outer-job-receipt.json'))));
  assert.equal(result.status, 0);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
