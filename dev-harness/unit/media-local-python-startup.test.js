'use strict';
require('../lib/media-artifact-test-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { constBlock } = require('../lib/source-slice');

const appRoot = path.resolve(__dirname, '../../ruyi-workbench');
const source = fs.readFileSync(path.join(appRoot, 'app/src/13be-media-image-host.js'), 'utf8');
const startupHashes = vm.runInNewContext(constBlock(source, 'localPythonStartupHashes') + '\nlocalPythonStartupHashes;');
const site = 'python_embed/Lib/site-packages';

function fixture(t, afterInput = () => {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ruyi-python-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'mcp/ai-computer-control');
  const helper = path.join(root, 'resources/native-video-read.py');
  const executable = path.join(runtime, 'python_embed/python.exe');
  const write = (relative, contents = 'unexpected startup code') => {
    const file = path.join(runtime, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  write('python_embed/python.exe', 'synthetic executable');
  for (const relative of Object.keys(startupHashes)) write('python_embed/' + relative, relative);
  for (const name of ['pythonwin', 'pywin32_system32']) fs.mkdirSync(path.join(runtime, site, name));
  fs.mkdirSync(path.dirname(helper));
  fs.copyFileSync(path.join(appRoot, 'resources/native-video-read.py'), helper);

  const spawns = [], hooks = {};
  const spawn = (file, argv, options) => {
    spawns.push({ file, argv, options });
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin.end = (bytes, callback) => queueMicrotask(() => {
      assert.equal(bytes.toString(), 'synthetic input');
      callback();
      afterInput(write);
      child.stdout.emit('data', Buffer.from('{"ok":true}'));
      child.emit('close', 0);
    });
    return child;
  };
  const load = name => {
    if (name === 'node:child_process') return { spawn };
    if (name === '../tools/verify-media-artifacts.cjs') return { verifyMediaArtifacts: async () => {} };
    return require(name);
  };
  // Use synthetic startup files to keep this test independent of Full packaging.
  const hash = algorithm => ({
    update(bytes) {
      const digest = startupHashes[bytes.toString()];
      return digest ? { digest: () => digest } : crypto.createHash(algorithm).update(bytes);
    },
  });
  vm.runInNewContext(source, {
    fs, path, crypto: { createHash: hash, randomBytes: crypto.randomBytes }, Buffer, AbortSignal, TextDecoder, setTimeout, clearTimeout,
    require: load, process: { platform: 'win32', env: {} }, externalRoot: () => root,
    PrivacyGateway: { setHost() {} }, MediaImageService: { create: () => ({}) }, WorkDataMaintenanceHooks: {},
    MediaImageHooks: hooks, ProviderMediaHooks: {}, VisualMediaHooks: {},
  });
  const run = () => hooks.runLocalMediaHelper('native-video-read.py', ['matroska'], Buffer.from('synthetic input'), {
    timeoutMs: 1000, maxBytes: 1024, env: {
      OPENCV_FFMPEG_CAPTURE_OPTIONS: 'protocol_whitelist;ruyi-no-external-io|format_whitelist;matroska,webm|input_format;matroska|max_pixels;8294400',
    },
  });
  return { executable, spawns, write, run };
}

test('locked startup paths preserve worker launch and bypass existing bytecode caches', async t => {
  const f = fixture(t);
  f.write(`${site}/_distutils_hack/__pycache__/__init__.cpython-312.pyc`);
  assert.equal((await f.run()).ok, true);
  assert.equal((await f.run()).ok, true);
  const prefixes = f.spawns.map(({ file, argv, options }) => {
    assert.equal(file, f.executable);
    assert.equal(options.cwd, path.dirname(f.executable));
    assert.deepEqual(Array.from(argv.slice(0, 5)), ['-I', '-B', '-X', 'utf8', '-X']);
    assert.match(argv[5], /^pycache_prefix=.+\.ruyi-pycache-[a-f0-9]{32}$/);
    const prefix = argv[5].slice('pycache_prefix='.length);
    assert.equal(fs.existsSync(prefix), false);
    return prefix;
  });
  assert.equal(new Set(prefixes).size, 2);
});

for (const relative of [
  'pyvenv.cfg', 'python_embed/pyvenv.cfg', 'python_embed/added.pth', `${site}/added.pth`,
  `${site}/pywin32.pth`, `${site}/_distutils_hack/__init__.py`,
  `${site}/win32/sitecustomize.pyc`, `${site}/pythonwin/sitecustomize/__init__.py`,
  `${site}/pywin32_bootstrap.cp312-win_amd64.pyd`, `${site}/pywin32_system32/__init__.py`,
]) test(`unexpected startup input refuses before spawning ${relative}`, async t => {
  const f = fixture(t);
  f.write(relative);
  await assert.rejects(f.run(), { code: 'privacy.image_runtime_unavailable' });
  assert.equal(f.spawns.length, 0);
});

test('a new startup hook observed after worker close invalidates its result', async t => {
  const f = fixture(t, write => write(`${site}/added.pth`));
  await assert.rejects(f.run(), { code: 'privacy.image_runtime_unavailable' });
  assert.equal(f.spawns.length, 1);
});
