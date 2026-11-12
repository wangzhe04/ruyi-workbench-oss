'use strict';
// Build-time only. No third-party JS dependencies and no network access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

function sha256(file) {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, size));
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function safeChild(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')
    || path.isAbsolute(relative)) throw new Error('Invalid relative payload path: ' + relative);
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new Error('Payload escapes root: ' + relative);
  return file;
}
function inventory(root) {
  root = fs.realpathSync(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Expected a payload directory');
  const entries = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (path.isAbsolute(target) || !inside(root, fs.realpathSync(file))) throw new Error('Unsafe payload symlink: ' + relative);
        entries.push({ path: relative, type: 'symlink', target });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 });
        walk(file);
      } else if (stat.isFile()) {
        entries.push({ path: relative, type: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: sha256(file) });
      } else throw new Error('Unsupported payload file: ' + relative);
    }
  }
  walk(root);
  return entries;
}
function treeDigest(entries) {
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
function copyTree(source, destination) {
  // Validate the complete source before copying; preserve internal relative symlinks verbatim.
  inventory(source);
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
}
function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
    ...options, detached: process.platform !== 'win32' });
  if ((result.error || result.status !== 0) && process.platform !== 'win32' && result.pid > 0) {
    // This is the dedicated group created by this invocation, never a PID/name search.
    try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (result.error || result.status !== 0) throw new Error(path.basename(command) + ' failed: '
    + (result.error?.message || result.stderr || result.stdout).slice(-8000));
  return result.stdout.trim();
}
function verifyAssets(root, lock, variant) {
  if (lock.schemaVersion !== 1 || lock.platform !== 'darwin' || lock.arch !== 'arm64') throw new Error('Unsupported asset lock');
  const required = variant === 'full' ? ['node', 'ripgrep', 'python', 'chromium', 'python-notices'] : ['node', 'ripgrep'];
  const components = {};
  for (const id of required) {
    const component = lock.components.find(item => item.id === id);
    if (!component || !/^[a-f0-9]{64}$/.test(component.treeSha256) || !component.version || !component.sources?.length
      || !component.licenseFiles?.length) throw new Error('Incomplete asset lock: ' + id);
    const directory = safeChild(root, component.path);
    if (!inside(fs.realpathSync(root), fs.realpathSync(directory))) throw new Error('Asset directory escapes root');
    if (treeDigest(inventory(directory)) !== component.treeSha256) throw new Error('Asset hash mismatch: ' + id);
    for (const license of component.licenseFiles) {
      if (!fs.statSync(safeChild(directory, license)).isFile()) throw new Error('Missing license: ' + id);
    }
    components[id] = { ...component, directory };
  }
  if (variant === 'full') {
    const wheels = safeChild(root, lock.wheelsPath);
    const expected = lock.wheels.map(item => item.filename).sort();
    if (JSON.stringify(fs.readdirSync(wheels).sort()) !== JSON.stringify(expected)) throw new Error('Wheelhouse contents differ from lock');
    for (const wheel of lock.wheels) {
      if (sha256(safeChild(wheels, wheel.filename)) !== wheel.sha256) throw new Error('Wheel hash mismatch: ' + wheel.filename);
    }
    components.wheels = { directory: wheels };
  }
  return components;
}
function nativeAudit(root) {
  root = fs.realpathSync(root);
  const result = [];
  // Resolve selector shims before passing an inherited descriptor. The actual developer tool
  // receives fd3 directly, without an intermediate xcrun handoff that may reuse descriptors.
  const lipo = run('/usr/bin/xcrun', ['--find', 'lipo']);
  const otool = run('/usr/bin/xcrun', ['--find', 'otool']);
  const systemPath = value => {
    if (!path.isAbsolute(value)) return false;
    const normalized = path.resolve(value);
    return normalized.startsWith('/System/Library/') || normalized.startsWith('/usr/lib/');
  };
  function inspect(command, args, file) {
    // otool interprets parentheses in a filename as archive-member syntax. An inherited read-only
    // descriptor avoids that ambiguity and also supports arbitrary Unicode and space-containing paths.
    const descriptor = fs.openSync(file, 'r');
    try { return run(command, [...args, '/dev/fd/3'], { stdio: ['ignore', 'pipe', 'pipe', descriptor] }); }
    finally { fs.closeSync(descriptor); }
  }
  for (const entry of inventory(root)) {
    if (entry.type !== 'file' || entry.bytes < 4) continue;
    const file = safeChild(root, entry.path);
    const fd = fs.openSync(file, 'r');
    const magic = Buffer.alloc(4);
    try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (!['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'cafebabf'].includes(magic.toString('hex'))) continue;
    const architectures = inspect(lipo, ['-archs'], file).split(/\s+/);
    if (!architectures.includes('arm64')) throw new Error('Non-arm64 native payload: ' + entry.path);
    const output = inspect(otool, ['-arch', 'arm64', '-L'], file);
    const dependencies = output.split('\n').slice(1).map(line => line.trim().split(' (compatibility version')[0]).filter(Boolean);
    const commands = inspect(otool, ['-arch', 'arm64', '-l'], file);
    const rpaths = [...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)].map(match => match[1]);
    const versions = [...commands.matchAll(/\bminos\s+(\d+\.\d+(?:\.\d+)?)/g),
      ...commands.matchAll(/cmd LC_VERSION_MIN_MACOSX[\s\S]*?\bversion\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
    if (!versions.length || versions.some(value => Number(value.split('.')[0]) > 14
      || (Number(value.split('.')[0]) === 14 && Number(value.split('.')[1]) > 0))) {
      throw new Error('Native payload exceeds macOS14.0 target or has no deployment metadata: ' + entry.path + ' ' + versions.join(','));
    }
    const header = inspect(otool, ['-arch', 'arm64', '-hv'], file);
    const executable = /\bEXECUTE\b/.test(header);
    // otool -L lists LC_ID_DYLIB before the library's actual load commands.
    if (/\bDYLIB\b/.test(header)) dependencies.shift();
    for (const dependency of dependencies) {
      if (path.isAbsolute(dependency) && !systemPath(dependency)) {
        throw new Error('Nonportable native dependency: ' + entry.path + ' -> ' + dependency);
      }
    }
    result.push({ path: entry.path, architectures, minimumVersions: versions, dependencies, rpaths, executable });
  }
  const executables = result.filter(item => item.executable);
  function expand(value, item, executable) {
    if (value.startsWith('@loader_path/')) return path.resolve(root, path.dirname(item.path), value.slice(13));
    if (value.startsWith('@executable_path/')) return path.resolve(root, path.dirname(executable.path), value.slice(17));
    return path.isAbsolute(value) ? value : '';
  }
  const byFile = new Map(result.map(item => [fs.realpathSync(path.join(root, item.path)), item]));
  const visited = new Set();
  const reached = new Set();
  function visit(item, executable, inherited = []) {
    const search = [...new Set([...item.rpaths.map(value => expand(value, item, executable)), ...inherited].filter(Boolean))];
    const key = JSON.stringify([item.path, executable.path, search]);
    if (visited.has(key)) return;
    visited.add(key); reached.add(item.path);
    for (const dependency of item.dependencies) {
      if (systemPath(dependency)) continue;
      const candidates = dependency.startsWith('@rpath/')
        ? search.map(directory => path.join(directory, dependency.slice(7)))
        : [expand(dependency, item, executable)].filter(Boolean);
      const resolved = candidates.find(candidate => systemPath(candidate)
        || (inside(root, candidate) && fs.existsSync(candidate) && inside(root, fs.realpathSync(candidate))));
      if (!resolved) throw new Error('Unresolved native dependency: ' + item.path + ' -> ' + dependency + ' (entry ' + executable.path + ')');
      if (systemPath(resolved)) continue;
      const child = byFile.get(fs.realpathSync(resolved));
      if (!child) throw new Error('Native dependency is not a qualified Mach-O: ' + resolved);
      visit(child, executable, search);
    }
  }
  for (const executable of executables) visit(executable, executable);
  for (const item of result) {
    if (reached.has(item.path)) continue;
    // Python extension modules and browser plugins are dlopen-loaded, not static edges. Bind
    // those to their enclosing runtime/application; never borrow an unrelated entry's rpaths.
    const python = /^(.*\/runtime\/python\/)lib\/python3\.12\//.exec(item.path);
    const appEnd = item.path.lastIndexOf('.app/Contents/');
    const prefix = python ? python[1] + 'bin/' : appEnd >= 0 ? item.path.slice(0, appEnd + 5) + 'Contents/MacOS/' : '';
    const owners = prefix ? executables.filter(executable => executable.path.startsWith(prefix)) : [];
    if (owners.length !== 1) {
      // An unreferenced library with loader-relative/system-only edges needs no executable
      // context. Executable-relative edges without a provable owner are deliberately refused.
      if (item.dependencies.some(value => value.startsWith('@executable_path/'))) throw new Error('No unique runtime owner: ' + item.path);
      visit(item, { path: item.path, rpaths: [] });
    } else {
      const owner = owners[0];
      visit(item, owner, owner.rpaths.map(value => expand(value, owner, owner)));
    }
  }
  return result;
}
function verifyPackage(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !['full', 'slim'].includes(manifest.variant) || manifest.app !== 'Ruyi.app') throw new Error('Invalid package manifest');
  const app = path.join(directory, manifest.app);
  if (fs.lstatSync(app).isSymbolicLink() || !fs.lstatSync(app).isDirectory()) throw new Error('App root must be a real directory');
  const actual = inventory(app);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files) || treeDigest(actual) !== manifest.treeSha256) throw new Error('Package integrity check failed');
  return manifest;
}
module.exports = { sha256, safeChild, inside, inventory, treeDigest, copyTree, run, verifyAssets, nativeAudit, verifyPackage };
