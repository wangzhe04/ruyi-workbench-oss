'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourcePin = 'b1f18f9053bd6499bbb859d99fde28476f77de6c6f70712a8dffdd6a6b5aed31';
const scriptPin = '467c4295fd44431a2dd19ce39a23c1c9042174472fdd8c404cac779a6efaaf45';
const nativePin = '12e946e37882d1c2c70aa28ddf609c3b0ff94f612ffed05e4d9afc9ceb1c57a0';
const sourceKey = 'RUYI_MANIFEST_PUBLISHER_SOURCE';
const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();

function canonical(file, directory) {
  if (typeof file !== 'string' || !/^[a-z]:\\/i.test(file) || path.resolve(file) !== file ||
      /[\x00-\x1f<>"|?*/]/.test(file) || file.slice(2).includes(':') ||
      file.slice(3).split('\\').some(piece => /[. ]$/.test(piece))) return false;
  const stat = fs.lstatSync(file);
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()) &&
    samePath(fs.realpathSync.native(file), file);
}

function admit(file, args, options, scope) {
  try {
    const { root, env, sourceSha256, serverSha256, powershellSha256, cwd } = scope;
    const keys = Object.keys(options).sort().join(',');
    if (sourceSha256 !== sourcePin || keys !== 'env,stdio,windowsHide' || options.windowsHide !== true ||
        !Array.isArray(options.stdio) || options.stdio.length !== 3 || options.stdio.some(v => v !== 'pipe') ||
        !Array.isArray(args) || args.length !== 5 ||
        !['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'].every((arg, index) => args[index] === arg) ||
        typeof args[4] !== 'string' || args[4].length > 2048 || hash(args[4]) !== scriptPin) return null;
    const executable = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const source = path.join(root, 'ruyi-workbench', 'app', 'src', '01w-work-data-native-publish.js');
    const server = path.join(root, 'ruyi-workbench', 'app', 'server.js');
    if (cwd !== path.join(root, 'ruyi-workbench') || file !== executable || !canonical(file, false) ||
        !canonical(source, false) || !canonical(server, false) || hash(fs.readFileSync(file)) !== powershellSha256 ||
        hash(fs.readFileSync(source)) !== sourcePin || hash(fs.readFileSync(server)) !== serverSha256) return null;

    const home = env.RUYI_HOME;
    const temp = path.join(root, 'case-home', 'tmp');
    const appData = path.join(home, 'AppData');
    if (env.TEMP !== temp || env.TMP !== temp || path.dirname(home) !== temp ||
        !/^ruyi-e2e-home-[a-z0-9]+$/i.test(path.basename(home)) ||
        ![env.HOME, env.USERPROFILE, env.WIN_CLAUDE_WORKBENCH_HOME].every(v => v === home) ||
        env.APPDATA !== path.join(appData, 'Roaming') || env.LOCALAPPDATA !== path.join(appData, 'Local') ||
        env.RUYI_REAL_LOCALAPPDATA !== path.join(root, 'case-home', 'local') ||
        env.RUYI_REAL_APPDATA !== path.join(root, 'case-home', 'roaming') ||
        env.RUYI_C2_FAULT_DIR !== path.join(home, 'fault-control') ||
        env.WINDIR !== env.SystemRoot || env.PATH !== path.join(env.SystemRoot, 'System32') ||
        env.SystemDrive !== path.parse(env.SystemRoot).root.replace(/[\\/]+$/, '') ||
        ![root, temp, home, env.APPDATA, env.LOCALAPPDATA].every(p => canonical(p, true))) return null;
    const requested = options.env;
    // Current product prepends its own vendor-bin to PATH during boot. Accept
    // that exact derivation, then pass the original system-only PATH to PowerShell.
    const vendor = path.join(cwd, 'app', 'vendor-bin');
    const vendorPath = requested.PATH === vendor + path.delimiter + env.PATH && canonical(vendor, true);
    if (Object.hasOwn(env, sourceKey) || Object.keys(requested).length !== Object.keys(env).length + 1 ||
        !Object.entries(env).every(([name, value]) => Object.hasOwn(requested, name) &&
          (requested[name] === value || (name === 'PATH' && vendorPath))) ||
        !Object.hasOwn(requested, sourceKey) || typeof requested[sourceKey] !== 'string' ||
        requested[sourceKey].length > 65536 || hash(requested[sourceKey]) !== nativePin) return null;
    return Object.freeze({ home, options: { env: { ...env, [sourceKey]: requested[sourceKey] },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] } });
  } catch { return null; }
}

// Serve startup uses a disjoint upload root created by WorkData ownership in
// the case TEMP. The first flush commits only its fresh owner marker.
function bootUploadAllowed(directory, home) {
  const temp = path.dirname(home);
  if (!samePath(path.dirname(directory), temp) ||
      !/^ruyi-work-data-upload-[a-z0-9]{6}$/i.test(path.basename(directory)) ||
      !canonical(temp, true) || !canonical(directory, true)) return false;
  const names = fs.readdirSync(directory);
  if (names.length !== 1 || names[0] !== 'restore-upload-owner.json') return false;
  const marker = path.join(directory, names[0]);
  if (!canonical(marker, false)) return false;
  const before = fs.lstatSync(marker);
  if (before.nlink !== 1 || before.size < 1 || before.size > 16384) return false;
  const raw = fs.readFileSync(marker, 'utf8');
  const after = fs.lstatSync(marker);
  if (Buffer.byteLength(raw) !== before.size ||
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some(k => before[k] !== after[k]) ||
      !canonical(marker, false)) return false;
  const value = JSON.parse(raw);
  return value && Object.keys(value).sort().join(',') === 'base,nonce,root,schema' &&
    raw === JSON.stringify(value) && value.schema === 1 && typeof value.base === 'string' &&
    typeof value.root === 'string' && typeof value.nonce === 'string' && /^[a-f0-9]{64}$/.test(value.nonce) &&
    samePath(value.base, home) && samePath(value.root, directory) && canonical(home, true);
}

function payloadAllowed(chunk, home) {
  try {
    if (typeof chunk !== 'string' || Buffer.byteLength(chunk) > 65537 ||
        Buffer.from(chunk).toString('utf8') !== chunk) return false;
    const parsed = JSON.parse(chunk);
    if (!parsed || Object.keys(parsed).join(',') !== 'flushDirectories' ||
        !Array.isArray(parsed.flushDirectories) || parsed.flushDirectories.length < 1 ||
        parsed.flushDirectories.length > 256 || chunk !== JSON.stringify(parsed) + '\n') return false;
    const seen = new Set();
    for (const directory of parsed.flushDirectories) {
      if (typeof directory !== 'string' || directory.length > 8192 || directory.endsWith('\\')) return false;
      const rel = path.relative(home, directory);
      if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..\\')) {
        return parsed.flushDirectories.length === 1 && bootUploadAllowed(directory, home) === true;
      }
      if (!canonical(directory, true)) return false;
      const key = directory.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      for (let current = directory; !samePath(current, home); current = path.dirname(current)) {
        if (!canonical(current, true)) return false;
      }
      if (!canonical(home, true)) return false;
    }
    return true;
  } catch { return false; }
}

function bindInput(child, home, onDenied, onAccepted = () => {}) {
  const stream = child.stdin, end = stream.end;
  let consumed = false;
  const deny = () => {
    consumed = true;
    stream.destroy();
    return onDenied();
  };
  stream.write = deny;
  stream.end = function(chunk, ...rest) {
    if (consumed || rest.length || !payloadAllowed(chunk, home)) return deny();
    consumed = true;
    const result = Reflect.apply(end, stream, [chunk]);
    onAccepted();
    return result;
  };
  return child;
}

module.exports = Object.freeze({ admit, bindInput, payloadAllowed, sourcePin });
