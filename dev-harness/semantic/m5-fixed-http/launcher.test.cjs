'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path').win32;
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require('node:path').join(__dirname, 'launcher.cjs'), 'utf8');
test('relative contract is canonical before verification and cwd change; each launch has one receipt', () => {
  const root = 'C:/workspace/case'.replaceAll('/', '\\');
  const out = path.join(root, 'case-output');
  const relative = 'case/case-output/freeze.json';
  const canonical = path.join(out, 'freeze.json');
  const pinned = { root, output: out, node: path.join(root, 'node.exe'),
    powershell: path.join(root, 'powershell.exe'), systemRoot: 'C:\\Windows',
    bindings: [{ path: path.join(root, 'powershell.exe') },
      { path: path.join(root, 'controller.cjs'), sha256: 'controller-hash' }] };
  const written = new Map();
  const mockFs = { realpathSync: { native(file) { assert.equal(file, relative); return canonical; } },
    existsSync: name => name === path.join(out, 'OWNER.json'), mkdirSync() {},
    writeFileSync(name, text, options) {
      assert.equal(options.flag, 'wx');
      if (written.has(name)) throw Error('already consumed');
      written.set(name, JSON.parse(text));
    } };
  const mocks = { 'node:fs': mockFs, 'node:path': path, 'node:child_process': {},
    './controller.cjs': { verify(file, pin) { assert.equal(file, canonical); assert.equal(pin, 'reviewed-hash'); return pinned; } } };
  const context = { require: id => mocks[id], module: { exports: {} }, process: { execPath: pinned.node } };
  vm.runInNewContext(source, context);
  let count = 0;
  const lower = (file, args, options) => {
    count++;
    assert.equal(file, pinned.powershell);
    assert.equal(options.cwd, out);
    assert.equal(args[args.indexOf('-Contract') + 1], canonical);
    const child = new EventEmitter();
    Object.assign(child, { pid: 17, stdout: { pipe() {} }, stderr: { pipe() {} } });
    return child;
  };
  const { launch } = context.module.exports;
  launch(relative, 'reviewed-hash', lower).emit('close', 0, null);
  assert.throws(() => launch(relative, 'reviewed-hash', lower), /already consumed/);
  assert.equal(count, 1);
  assert.deepEqual(written.get(path.join(out, 'LAUNCH_CONSUMED')), { freezeSha256: 'reviewed-hash' });
  assert.deepEqual(written.get(path.join(out, 'launcher-receipt.json')), { pid: 17, code: 0, signal: null, closeObserved: true });
});
