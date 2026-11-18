'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const hash = b => createHash('sha256').update(b).digest('hex');
const implementation = fs.readFileSync(path.join(__dirname, 'flush-policy.cjs'), 'utf8');
const product = fs.readFileSync(path.join(__dirname, '../../../ruyi-workbench/app/src/01w-work-data-native-publish.js'), 'utf8');

function fixture() {
  const p = path.win32;
  const root = String.raw`C:\synthetic\m5`;
  const cwd = p.join(root, 'ruyi-workbench');
  const temp = p.join(root, 'case-home', 'tmp');
  const home = p.join(temp, 'ruyi-e2e-home-Ab4ggd');
  const SystemRoot = String.raw`C:\Windows`;
  const exe = p.join(SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { SystemRoot, WINDIR: SystemRoot, SystemDrive: 'C:', PATH: p.join(SystemRoot, 'System32'),
    TEMP: temp, TMP: temp, HOME: home, USERPROFILE: home, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home,
    APPDATA: p.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: p.join(home, 'AppData', 'Local'),
    RUYI_REAL_APPDATA: p.join(root, 'case-home', 'roaming'), RUYI_REAL_LOCALAPPDATA: p.join(root, 'case-home', 'local'),
    RUYI_C2_FAULT_DIR: p.join(home, 'fault-control'), NODE_OPTIONS: 'fixed guard' };
  const source = p.join(cwd, 'app', 'src', '01w-work-data-native-publish.js');
  const server = p.join(cwd, 'app', 'server.js');
  const files = new Map([[source, product], [server, 'mock server'], [exe, 'mock PowerShell']]);
  const directories = new Set([root, temp, home, env.APPDATA, env.LOCALAPPDATA, p.join(home, 'child'), p.join(cwd, 'app', 'vendor-bin')]);
  const aliases = new Map(), directoryEntries = new Map();
  const mockFs = {
    lstatSync(name) {
      assert.ok(files.has(name) || directories.has(name), 'attempted read outside the synthetic file model');
      return { isSymbolicLink: () => false, isFile: () => files.has(name), isDirectory: () => directories.has(name),
        nlink: 1, size: files.has(name) ? Buffer.byteLength(files.get(name)) : 0 };
    },
    readdirSync: name => directoryEntries.get(name) || [],
    realpathSync: { native: name => aliases.get(name) || name },
    readFileSync: name => files.get(name),
  };
  const ctx = { Buffer, module: { exports: {} }, require: n => n === 'node:fs' ? mockFs : n === 'node:path' ? p : require(n) };
  vm.runInNewContext(implementation, ctx);
  const policy = ctx.module.exports;
  const scope = { root, cwd, env, sourceSha256: hash(product), serverSha256: hash(files.get(server)), powershellSha256: hash(files.get(exe)) };
  return { files, directories, directoryEntries, aliases, exe, source, server, home, policy, scope };
}

async function captureProduct(env) {
  const result = {};
  const fake = { spawn(file, args, options) { Object.assign(result, { file, args, options }); throw Error('offline'); } };
  const options = { process: { platform: 'win32', env }, Buffer, WorkDataManifest: { Hooks: {} },
    require: name => name === 'node:path' ? path.win32 : name === 'node:child_process' ? fake : require(name) };
  vm.runInNewContext(product + '\n globalThis.flush = WorkDataNativePublish.createFlush();', options);
  await assert.rejects(options.flush([env.RUYI_HOME]), /flush_unavailable/);
  return result;
}

test('fixed real product plan is the sole admitted child command', async () => {
  const { scope, policy, home, files, exe, source, server } = fixture();
  const { file, args, options } = await captureProduct(scope.env);
  assert.equal(file, exe);
  assert.equal(policy.admit(file, args, options, scope)?.home, home);
  const vendorPath = path.win32.join(scope.cwd, 'app', 'vendor-bin') + ';' + scope.env.PATH;
  assert.equal(policy.admit(file, args, { ...options, env: { ...options.env, PATH: vendorPath } }, scope)?.options.env.PATH,
    scope.env.PATH);
  for (const patch of [{ cwd: home }, { shell: false }, { detached: true }, { windowsHide: false }, { stdio: ['pipe', 'pipe', 'ignore'] }]) {
    assert.equal(policy.admit(file, args, { ...options, ...patch }, scope), null);
  }
  for (const badArgs of [[...args, 'extra'], [...args.slice(0, 4), args[4] + 'A'], [...args.slice(0, 3), '-Command', args[4]]]) {
    assert.equal(policy.admit(file, badArgs, options, scope), null);
  }
  for (const patch of [{ TEMP: path.win32.dirname(home) + '\\other' }, { PATH: 'C:\\outside' },
    { RUYI_MANIFEST_PUBLISHER_SOURCE: 'altered' }, { PSModulePath: 'C:\\outside' }]) {
    assert.equal(policy.admit(file, args, { ...options, env: { ...options.env, ...patch } }, scope), null);
  }
  assert.equal(policy.admit('powershell.exe', args, options, scope), null);
  for (const target of [exe, source, server]) {
    const original = files.get(target);
    files.set(target, 'altered');
    assert.equal(policy.admit(file, args, options, scope), null);
    files.set(target, original);
  }
});

test('only one exact JSON line reaches PowerShell stdin', () => {
  const { policy, home, aliases } = fixture();
  const payload = dirs => JSON.stringify({ flushDirectories: dirs }) + '\n';
  const valid = payload([home, path.win32.join(home, 'child')]);
  const outside = path.win32.join(path.win32.dirname(home), 'ruyi-e2e-home-sibling');
  for (const bad of [payload([outside]), payload([home, home]), payload([home + '\\..']), valid + valid,
    JSON.stringify({ flushDirectories: [home], extra: true }) + '\n', Buffer.from(valid)]) {
    assert.equal(policy.payloadAllowed(bad, home), false);
  }
  aliases.set(path.win32.join(home, 'child'), outside);
  assert.equal(policy.payloadAllowed(valid, home), false);
  aliases.clear();
  assert.equal(policy.payloadAllowed(valid, home), true);
  const writes = [];
  const make = () => policy.bindInput({ stdin: { end: x => writes.push(x), destroy: () => {} } }, home,
    () => { throw Error('denied'); });
  const child = make();
  child.stdin.end(valid);
  assert.throws(() => child.stdin.end(valid), /denied/);
  assert.throws(() => make().stdin.write(valid), /denied/);
  assert.throws(() => make().stdin.end(payload([outside])), /denied/);
  assert.deepEqual(writes, [valid]);
});
const guard = fs.readFileSync(path.join(__dirname, 'loopback-guard.cjs'), 'utf8');
test('server guard reaches one mocked child only through exact flush admission', async () => {
  const { policy, scope, home } = fixture();
  const p = path.win32;
  const events = p.join(scope.root, 'case-output', 'guard-child-events.jsonl');
  Object.assign(scope.env, { RUYI_M5_ROLE: 'server', RUYI_M5_FROZEN_ROOT: scope.root, RUYI_M5_PROCESS_EVENTS: events,
    RUYI_M5_FLUSH_SOURCE_SHA256: scope.sourceSha256, RUYI_M5_FLUSH_SERVER_SHA256: scope.serverSha256,
    RUYI_M5_FLUSH_POWERSHELL_SHA256: scope.powershellSha256 });
  const { file, args, options } = await captureProduct(scope.env);
  const rows = [], calls = [], writes = [], children = [];
  const cp = { spawn(...plan) {
    calls.push(plan);
    const c = new (require('node:events').EventEmitter)();
    c.pid = 142;
    c.stdin = { end: line => writes.push(line), destroy() {} };
    children.push(c);
    return c;
  } };
  const mocks = { 'node:fs': { appendFileSync: (file, text) => rows.push({ file, ...JSON.parse(text) }) },
    'node:child_process': cp, 'node:path': p, './flush-policy.cjs': policy,
    'node:net': { Socket: class { connect() {} } },
    'node:http': {}, 'node:https': {}, 'node:dns': { promises: {} },
    'node:tls': {}, 'node:dgram': {}, 'node:http2': {} };
  vm.runInNewContext(guard, { Buffer, URL, require: id => mocks[id] || require(id),
    process: { pid: 141, cwd: () => scope.cwd, env: scope.env },
    __dirname: scope.root, __filename: p.join(scope.root, 'loopback-guard.cjs'), module: { exports: {} } });
  assert.throws(() => cp.spawn(file, args, { ...options, shell: true }), /loopback_guard.denied/);
  assert.throws(() => cp.execFile(file, args, options), /loopback_guard.denied/);
  assert.equal(calls.length, 0);
  assert.equal(rows.length, 2);
  rows.length = 0;
  const child = cp.spawn(file, args, options);
  const line = JSON.stringify({ flushDirectories: [home] }) + '\n';
  child.stdin.end(line);
  child.emit('spawn');
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(calls.length, 1);
  assert.equal(child, children[0]);
  assert.deepEqual(writes, [line]);
  assert.equal(rows[0].inputAccepted, true);
  assert.deepEqual(rows.map(({ kind, pid, parentPid, file }) => [kind, pid, parentPid, p.basename(file)]),
    ['spawn', 'exit', 'close'].map(kind => [kind, 142, 141, 'guard-flush-events.jsonl']));
});
test('source startup singleton upload flush is confined to the exact fresh case sibling', async () => {
  const { policy, home, files, directories, directoryEntries, aliases } = fixture();
  const p = path.win32;
  const temp = p.dirname(home), upload = p.join(temp, 'ruyi-work-data-upload-fHDauX').toLowerCase();
  const owner = p.join(upload, 'restore-upload-owner.json');
  const uploadSource = fs.readFileSync(path.join(__dirname, '../../../ruyi-workbench/app/src/13at-work-data-restore-uploads.js'), 'utf8');
  directories.add(upload);
  const planned = [];
  const captured = Error('stop after capturing product flush');
  const fsPromises = {
    lstat: async () => ({ dev: 1n, ino: 3n, isDirectory: () => true, isSymbolicLink: () => false }),
    realpath: async target => target,
    readdir: async target => directoryEntries.get(target) || [],
    async open(target, flags) {
      assert.equal(flags, 'wx');
      assert.equal(target, owner);
      return { writeFile: async bytes => { files.set(target, bytes); directoryEntries.set(upload, [p.basename(target)]); },
        sync: async () => {}, close: async () => {} };
    }
  };
  const ctx = { Buffer, process: { platform: 'win32' }, WorkDataRecovery: { LIMITS: { serialized: 1024 } },
    require: n => n === 'node:fs/promises' ? fsPromises : n === 'node:path' ? p : require(n) };
  vm.runInNewContext(uploadSource + '\nglobalThis.create = WorkDataRestoreUploads.create;', ctx);
  const base = home.toLowerCase();
  await assert.rejects(ctx.create({ base, root: upload, ownership: { roots: [base, upload] },
    assertExclusive: async () => true, flush: async directories => {
      planned.push(...directories);
      throw captured;
    }
  }), error => error === captured);
  assert.deepEqual(planned, [upload]);
  const payload = dirs => JSON.stringify({ flushDirectories: dirs }) + '\n';
  const good = files.get(owner).toString('utf8');
  files.set(owner, good);
  assert.equal(policy.payloadAllowed(payload(planned), home), true);
  assert.equal(policy.payloadAllowed(payload([temp]), home), false);
  assert.equal(policy.payloadAllowed(payload([upload, home]), home), false);
  assert.equal(policy.payloadAllowed(payload([p.join(upload, 'unowned')]), home), false);
  files.set(owner, JSON.stringify({ ...JSON.parse(good), base: p.join(temp, 'another-case') }));
  assert.equal(policy.payloadAllowed(payload(planned), home), false);
  files.set(owner, good);
  aliases.set(owner, p.join(temp, 'unowned-marker'));
  assert.equal(policy.payloadAllowed(payload(planned), home), false);
  aliases.clear();
  directoryEntries.get(upload).push('extra-file');
  assert.equal(policy.payloadAllowed(payload(planned), home), false);
});
