'use strict';
// Development App builder. Uses the installed Apple SDK and an ad-hoc development identity.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

function run(command, args) {
  const result = cp.spawnSync(command, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'Build command failed');
  return result.stdout.trim();
}

function buildMacDesktop(output, { bundled = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('The Mac desktop App requires macOS and the Apple SDK');
  const root = path.resolve(__dirname, '..');
  const destination = path.resolve(output || path.join(root, 'dist', 'Ruyi.app'));
  if (!destination.endsWith('.app')) throw new Error('The output must be an .app bundle');
  const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!architecture) throw new Error('Unsupported macOS architecture');
  const sdk = process.env.RUYI_MACOS_SDK_PATH || run('/usr/bin/xcrun', ['--show-sdk-path']);
  const compiler = run('/usr/bin/xcrun', ['--find', 'swiftc']);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-desktop-build-'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.ruyi-desktop-'));
  const bundle = path.join(staging, 'Ruyi.app');
  const contents = path.join(bundle, 'Contents');
  const binary = path.join(contents, 'MacOS', 'RuyiDesktop');
  let replaced = false;
  let preserveBackup = false;
  const backup = path.join(staging, 'previous.app');
  try {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'));
    const flags = ['-sdk', sdk, '-target', architecture + '-apple-macosx14.0', '-swift-version', '5',
      '-module-cache-path', path.join(work, 'cache')];
    // Some CLT upgrades leave equivalent auto-discovered SwiftBridging module maps.
    // Hide only the redundant map in the compiler's VFS. Never edit the installed toolchain.
    const include = path.resolve(path.dirname(compiler), '../include/swift');
    const oldMap = path.join(include, 'module.modulemap');
    const newMap = path.join(include, 'bridging.modulemap');
    const mapBody = file => fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '').trim();
    const duplicateMap = fs.existsSync(oldMap) && fs.existsSync(newMap)
      && mapBody(oldMap) === mapBody(newMap) && mapBody(oldMap).includes('module SwiftBridging');
    if (duplicateMap) {
      const empty = path.join(work, 'empty.modulemap');
      const overlay = path.join(work, 'overlay.json');
      fs.writeFileSync(empty, '');
      fs.writeFileSync(overlay, JSON.stringify({ version: 0, roots: [{ type: 'file', name: oldMap, 'external-contents': empty }] }));
      flags.push('-vfsoverlay', overlay, '-Xcc', '-ivfsoverlay', '-Xcc', overlay);
    }
    const sources = ['DesktopService.swift', 'MacHostBridge.swift', 'RuyiDesktop.swift', 'main.swift'].map(name => path.join(root, 'desktop-macos', name));
    const inputs = [...sources, path.join(root, 'desktop-macos', 'service-lease.cjs'), __filename];
    const fingerprints = () => Object.fromEntries(inputs.map(file => [path.relative(root, file),
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
    const sourceFingerprint = fingerprints();
    run(compiler, [...flags, ...sources, '-o', binary]);
    if (JSON.stringify(sourceFingerprint) !== JSON.stringify(fingerprints())) throw new Error('Desktop sources changed during compilation. Rebuild the App');
    const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const info = { CFBundleExecutable: 'RuyiDesktop', CFBundleIdentifier: 'org.ruyi.workbench.development',
      CFBundleName: '如意工作台', CFBundleDisplayName: '如意工作台', CFBundlePackageType: 'APPL',
      CFBundleShortVersionString: '3.0.1', CFBundleVersion: '3.0.1', LSMinimumSystemVersion: '14.0',
      NSMicrophoneUsageDescription: '将语音转换为工作台输入文字。',
      NSDocumentsFolderUsageDescription: '读取文稿目录中的本地工作台程序文件和你选择的工作区。',
      ...(bundled ? { RuyiBundledWorkbench: 'true' } : { RuyiWorkbenchRoot: root }) };
    fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      + '<plist version="1.0"><dict>' + Object.entries(info).map(([key, value]) => '<key>' + key + '</key><string>' + escape(value) + '</string>').join('')
      + '<key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>\n');
    fs.writeFileSync(path.join(contents, 'Resources', 'build.json'), JSON.stringify({
      schemaVersion: 1, architecture, sdk, compiler, duplicateSwiftModuleMapOverlay: duplicateMap,
      deploymentTarget: '14.0', identity: 'ad-hoc-development',
      ...(bundled ? { layout: 'bundled-workbench' } : { workbenchRoot: root }),
      sourceFingerprint,
    }, null, 2) + '\n');
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle]);
    run('/usr/bin/codesign', ['--verify', '--strict', bundle]);
    if (fs.existsSync(destination)) {
      const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(destination, 'Contents', 'Info.plist')]);
      if (identifier !== info.CFBundleIdentifier) throw new Error('Refusing to replace a different application');
      fs.renameSync(destination, backup);
      replaced = true;
    }
    try { fs.renameSync(bundle, destination); }
    catch (error) {
      if (replaced) {
        try { fs.renameSync(backup, destination); }
        catch {
          preserveBackup = true;
          throw new Error('App replacement failed. Previous App preserved at ' + backup);
        }
      }
      throw error;
    }
    return destination;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    if (!preserveBackup) fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { console.log(buildMacDesktop(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildMacDesktop };
