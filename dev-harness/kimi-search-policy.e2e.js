'use strict';

// Offline contract tests for the 05c Kimi native-search classifier. The fragment is loaded in a VM with
// controlled guard/path helpers, so these tests do not start Ruyi/Kimi, do not spawn an attack command, and
// do not replace the product implementation. One optional host case uses a real rg discovered on Ruyi's own
// PATH; it is explicitly skipped when this machine has no independently visible host rg.
const assert = require('assert');
const cp = require('child_process');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FRAGMENT = path.join(ROOT, 'ruyi-workbench', 'app', 'src', '05c-kimi-search-policy.js');
const source = fs.readFileSync(FRAGMENT, 'utf8');

function loadClassifier(options) {
  const sandbox = {
    console,
    process,
    os,
    path,
    fsp,
    dataRoot: () => options.dataRoot,
    appRoot: () => options.appRoot,
    pathWithinRoot(target, root) {
      const relative = path.relative(root, target);
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    },
    async realpathForContainment(raw) {
      const abs = path.resolve(String(raw || ''));
      let probe = abs;
      const missing = [];
      for (;;) {
        try {
          const real = await fsp.realpath(probe);
          return missing.length ? path.join(real, ...missing) : real;
        } catch (error) {
          if (!error || !['ENOENT', 'ENOTDIR'].includes(error.code)) return abs;
          const parent = path.dirname(probe);
          if (parent === probe) return abs;
          missing.unshift(path.basename(probe));
          probe = parent;
        }
      }
    },
    isSensitiveDataPath(candidate) {
      const root = path.resolve(options.dataRoot);
      const sensitive = ['config.json', 'runtime.json', 'sessions', 'memory', 'usage', 'logs', 'generated', 'agent-runs'];
      const resolved = path.resolve(candidate);
      return sensitive.some(name => {
        const child = path.join(root, name);
        const rel = path.relative(child, resolved);
        return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
      });
    },
    async guardFileToolPath(raw, context) {
      const canonical = await sandbox.realpathForContainment(raw);
      const roots = [
        context && context.session && context.session.cwd,
        context && context.config && context.config.defaultWorkspace,
        ...(context && context.config && Array.isArray(context.config.recentWorkspaces) ? context.config.recentWorkspaces : []),
        ...(context && context.config && Array.isArray(context.config.workspaces) ? context.config.workspaces.map(row => row && row.path) : []),
        options.dataRoot,
      ].filter(value => typeof value === 'string' && value);
      const allowed = roots.some(root => sandbox.pathWithinRoot(canonical, path.resolve(root)));
      if (!allowed || sandbox.isSensitiveDataPath(raw) || sandbox.isSensitiveDataPath(canonical)) {
        return { ok: false, error: 'denied by controlled read guard' };
      }
      return { ok: true, absPath: canonical };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.__classifyKimiAcpReadonlySearch = classifyKimiAcpReadonlySearch;`, sandbox, { filename: FRAGMENT });
  return sandbox.__classifyKimiAcpReadonlySearch;
}

function resultIsDenied(result, fragment) {
  return result && result.ok === false && String(result.reason).includes(fragment);
}

function findHostRg() {
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const raw of dirs) {
    const dir = String(raw || '').trim().replace(/^"|"$/g, '');
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch { /* next PATH entry */ }
  }
  return '';
}

function nativeGlobArgs(pattern) {
  return ['-j', '1', '--files', '--hidden', '--sortr=modified', '--glob', '!.git', '--glob', pattern,
    '--glob', '**/.env', '--no-ignore', '.'];
}

function nativeGrepArgs(pattern, searchPath) {
  return ['-j', '1', '--hidden', '--max-columns', '500', '--null', '--glob', '!.git', '-l', '--glob', '*.js',
    '--no-ignore', '--', pattern, searchPath];
}

async function main() {
  assert.ok(!/\b(?:cp\.)?spawn\s*\(/.test(source), 'classifier fragment does not spawn processes');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-kimi-search-policy-'));
  const workspace = path.join(root, 'workspace');
  const appRoot = path.join(root, 'app-root');
  const vendorBin = path.join(appRoot, 'vendor-bin');
  const dataRoot = path.join(root, 'ruyi-data');
  const outside = path.join(root, 'outside');
  const fakeWorkspaceBin = path.join(workspace, 'bin');
  const searchFile = path.join(workspace, 'src', 'sample.js');
  try {
    await fsp.mkdir(path.dirname(searchFile), { recursive: true });
    await fsp.mkdir(vendorBin, { recursive: true });
    await fsp.mkdir(path.join(dataRoot, 'sessions'), { recursive: true });
    await fsp.mkdir(path.join(dataRoot, 'uploads'), { recursive: true });
    await fsp.mkdir(fakeWorkspaceBin, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    await fsp.mkdir(path.join(workspace, '.git'), { recursive: true });
    await fsp.writeFile(searchFile, 'const MARKER = true;\n', 'utf8');
    await fsp.writeFile(path.join(workspace, '.env'), 'CONTENT_MARKER=must-not-be-returned\n', 'utf8');
    await fsp.writeFile(path.join(workspace, '.git', 'visible.txt'), 'CONTENT_MARKER=must-not-be-returned\n', 'utf8');
    const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const trustedFakeRg = path.join(vendorBin, rgName);
    const fakeWorkspaceRg = path.join(fakeWorkspaceBin, rgName);
    await fsp.writeFile(trustedFakeRg, 'controlled trusted fixture\n', 'utf8');
    await fsp.writeFile(fakeWorkspaceRg, 'controlled workspace impostor\n', 'utf8');
    if (process.platform !== 'win32') await fsp.chmod(trustedFakeRg, 0o755);
    if (process.platform !== 'win32') await fsp.chmod(fakeWorkspaceRg, 0o755);

    const context = {
      session: { cwd: workspace },
      config: { defaultWorkspace: workspace, recentWorkspaces: [], workspaces: [], permissionMode: 'plan' },
      reg: { kimiAcpNativeMode: 'plan' },
    };
    const classify = loadClassifier({ dataRoot, appRoot });

    const trustedGlob = await classify({ command: trustedFakeRg, args: nativeGlobArgs('*.js'), cwd: workspace }, context);
    assert.strictEqual(trustedGlob.ok, true, 'trusted vendor rg accepts native Glob shape in plan mode');
    assert.strictEqual(trustedGlob.command, await fsp.realpath(trustedFakeRg), 'result command is canonical absolute vendor rg');
    assert.strictEqual(trustedGlob.cwd, await fsp.realpath(workspace), 'result cwd is canonical and read-guarded');
    assert.strictEqual(trustedGlob.env.RIPGREP_CONFIG_PATH, '', 'result clears RIPGREP_CONFIG_PATH');
    assert.strictEqual(trustedGlob.env.RG_CONFIG_PATH, '', 'result clears RG_CONFIG_PATH');
    assert.strictEqual(Object.keys(trustedGlob.env).length, 2, 'result exposes only safe config-clearing env overrides');
    assert.ok(trustedGlob.args.includes('--no-config'), 'Glob always forces --no-config');
    assert.ok(trustedGlob.args.includes('--glob') && trustedGlob.args.includes('!**/.env'), 'Glob preserves hard negative sensitive exclusion');
    assert.strictEqual(trustedGlob.args[trustedGlob.args.length - 1], '.', 'Glob canonical argv ends with .');

    const userVcsGlob = await classify({ command: trustedFakeRg, args: ['--files', '--hidden', '--sortr=modified', '--glob', '.git/**', '.'], cwd: workspace }, context);
    const userVcsIndex = userVcsGlob.args.lastIndexOf('.git/**');
    const fixedVcsIndex = userVcsGlob.args.lastIndexOf('!.git');
    assert.strictEqual(userVcsGlob.ok, true, 'user VCS glob remains a valid native shape');
    assert.ok(fixedVcsIndex > userVcsIndex, 'fixed VCS negative glob is appended after user globs');
    assert.ok(!userVcsGlob.args.includes('**/.env'), 'sensitive fixed globs are never emitted as positive patterns');

    const trustedGrep = await classify({ command: trustedFakeRg, args: nativeGrepArgs('--starts-with-dash', searchFile), cwd: workspace }, context);
    assert.strictEqual(trustedGrep.ok, true, 'trusted vendor rg accepts native Grep shape');
    assert.strictEqual(trustedGrep.args[trustedGrep.args.indexOf('--') + 1], '--starts-with-dash', 'Grep pattern after -- is not parsed as an option');
    assert.strictEqual(trustedGrep.args[trustedGrep.args.length - 1], await fsp.realpath(searchFile), 'Grep path is canonicalized through read guard');
    assert.ok(trustedGrep.args.includes('--max-columns') && trustedGrep.args.includes('500'), 'Grep preserves Kimi non-content max-columns shape');

    const content = await classify({ command: trustedFakeRg, args: [
      '--hidden', '--null', '--with-filename', '-n', '-C', '3', '--type', 'js', '-i', '-U', '--multiline-dotall',
      '--glob', '*.js', '--', 'TODO', searchFile,
    ], cwd: workspace }, context);
    assert.strictEqual(content.ok, true, 'content Grep allowlist accepts bounded context/type/multiline flags');
    assert.ok(content.args.includes('-C') && content.args.includes('3') && content.args.includes('--type'), 'content Grep flags are normalized');

    const cacheHome = path.join(root, 'kimi-home');
    const cacheRg = path.join(cacheHome, 'bin', rgName);
    await fsp.mkdir(path.dirname(cacheRg), { recursive: true });
    await fsp.writeFile(cacheRg, 'unverified cache fixture\n', 'utf8');
    if (process.platform !== 'win32') await fsp.chmod(cacheRg, 0o755);
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = cacheHome;
    try {
      const cacheResult = await classify({ command: cacheRg, args: nativeGlobArgs('*.js'), cwd: workspace }, context);
      assert.ok(resultIsDenied(cacheResult, 'unverified-kimi-rg'), 'KIMI_CODE_HOME/bin cache is not auto-trusted');
    } finally {
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousKimiHome;
    }

    const fakeWorkspace = await classify({ command: fakeWorkspaceRg, args: nativeGlobArgs('*.js'), cwd: workspace }, context);
    assert.ok(resultIsDenied(fakeWorkspace, 'rg-in-workspace'), 'workspace rg impostor is rejected after canonicalization');

    const originalPath = process.env.PATH;
    const originalPathAlias = process.env.Path;
    try {
      process.env.PATH = fakeWorkspaceBin + path.delimiter + String(originalPath || '');
      const absolutePathRg = await classify({ command: fakeWorkspaceRg, args: nativeGlobArgs('*.js'), cwd: workspace }, context);
      assert.ok(resultIsDenied(absolutePathRg, 'rg-in-workspace'), 'absolute PATH rg inside workspace is rejected before trust return');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathAlias === undefined) delete process.env.Path;
      else process.env.Path = originalPathAlias;
    }
    const originalRuyiRgPath = process.env.RUYI_RG_PATH;
    try {
      process.env.RUYI_RG_PATH = fakeWorkspaceRg;
      const absoluteOverrideRg = await classify({ command: fakeWorkspaceRg, args: nativeGlobArgs('*.js'), cwd: workspace }, context);
      assert.ok(resultIsDenied(absoluteOverrideRg, 'rg-in-workspace'), 'absolute RUYI_RG_PATH inside workspace is rejected before trust return');
    } finally {
      if (originalRuyiRgPath === undefined) delete process.env.RUYI_RG_PATH;
      else process.env.RUYI_RG_PATH = originalRuyiRgPath;
    }

    const shell = await classify({ command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', args: ['-c', `${rgName} --files`], cwd: workspace }, context);
    assert.strictEqual(shell.ok, false, 'shell wrapper is rejected');
    const pre = await classify({ command: trustedFakeRg, args: ['--files', '--hidden', '--sortr=modified', '--pre', 'evil', '--glob', '*.js', '.'], cwd: workspace }, context);
    assert.ok(resultIsDenied(pre, 'unknown-option'), '--pre is rejected as an unknown native search option');
    const preGlob = await classify({ command: trustedFakeRg, args: ['--files', '--hidden', '--sortr=modified', '--pre-glob', 'evil', '--glob', '*.js', '.'], cwd: workspace }, context);
    assert.ok(resultIsDenied(preGlob, 'unknown-option'), '--pre-glob is rejected');
    const hostname = await classify({ command: trustedFakeRg, args: ['--files', '--hidden', '--sortr=modified', '--hostname-bin', 'evil', '--glob', '*.js', '.'], cwd: workspace }, context);
    assert.ok(resultIsDenied(hostname, 'unknown-option'), '--hostname-bin is rejected');
    const follow = await classify({ command: trustedFakeRg, args: ['--files', '--hidden', '--sortr=modified', '--follow', '--glob', '*.js', '.'], cwd: workspace }, context);
    assert.ok(resultIsDenied(follow, 'unknown-option'), '--follow is rejected so ripgrep cannot traverse symlinks');
    const config = await classify({ command: trustedFakeRg, args: ['--files', '--hidden', '--sortr=modified', '--config', 'evil', '--glob', '*.js', '.'], cwd: workspace }, context);
    assert.ok(resultIsDenied(config, 'unknown-option'), '--config is rejected');
    const filesFrom = await classify({ command: trustedFakeRg, args: ['--files', '--hidden', '--sortr=modified', '--files-from', 'evil', '--glob', '*.js', '.'], cwd: workspace }, context);
    assert.ok(resultIsDenied(filesFrom, 'unknown-option'), '--files-from is rejected');

    const inputEnv = await classify({
      command: trustedFakeRg,
      args: nativeGlobArgs('*.js'),
      cwd: workspace,
      env: [{ name: 'PATH', value: fakeWorkspaceBin }, { name: 'RIPGREP_CONFIG_PATH', value: outside }],
    }, context);
    assert.ok(resultIsDenied(inputEnv, 'unsafe-env'), 'input PATH/rg-config environment cannot influence the classifier');

    const badNumber = await classify({ command: trustedFakeRg, args: ['--hidden', '--null', '--with-filename', '-n', '-C', '1001', '--', 'x', searchFile], cwd: workspace }, context);
    assert.ok(resultIsDenied(badNumber, 'range'), 'context numeric bound is enforced');
    const badUnknown = await classify({ command: trustedFakeRg, args: ['--hidden', '--null', '--mystery', '--', 'x', searchFile], cwd: workspace }, context);
    assert.ok(resultIsDenied(badUnknown, 'unknown-option'), 'unknown Grep flag is rejected');

    const sensitiveRoot = await classify({ command: trustedFakeRg, args: nativeGrepArgs('secret', path.join(dataRoot, 'sessions')), cwd: workspace }, context);
    assert.ok(resultIsDenied(sensitiveRoot, 'path-denied') || resultIsDenied(sensitiveRoot, 'sensitive-root'), 'sensitive Ruyi control-plane search path is rejected');
    const outOfBounds = await classify({ command: trustedFakeRg, args: nativeGlobArgs('*.js'), cwd: outside }, context);
    assert.ok(resultIsDenied(outOfBounds, 'path-denied') || resultIsDenied(outOfBounds, 'guard'), 'out-of-workspace search root is rejected by the normal read guard');
    const ancestorRoot = await classify({ command: trustedFakeRg, args: nativeGlobArgs('*.json'), cwd: root }, { ...context, session: { cwd: root }, config: { ...context.config, defaultWorkspace: root } });
    assert.ok(resultIsDenied(ancestorRoot, 'sensitive-root'), 'search root ancestor containing Ruyi dataRoot is rejected');
    const traversal = await classify({ command: trustedFakeRg, args: nativeGlobArgs('*.js'), cwd: path.join(workspace, '..', 'workspace') }, context);
    assert.strictEqual(traversal.ok, true, 'normal lexical path normalization remains compatible with a guarded workspace');

    const hostRg = findHostRg();
    if (!hostRg) {
      console.log('SKIP hostcase: no real rg found in Ruyi process PATH');
    } else {
      const hostResult = await classify({ command: hostRg, args: nativeGlobArgs('*.js'), cwd: workspace }, context);
      assert.strictEqual(hostResult.ok, true, 'real host rg in Ruyi PATH accepts native Glob shape');
      assert.strictEqual(hostResult.command, hostRg, 'real host rg result remains canonical');
      const contentResult = await classify({ command: hostRg, args: [
        '--hidden', '--null', '--with-filename', '-n', '--glob', '**/*', '--glob', '.git/**', '--', 'MARKER', workspace,
      ], cwd: workspace }, context);
      assert.strictEqual(contentResult.ok, true, 'real host rg accepts normalized content Grep safety shape');
      const childEnv = { ...process.env, ...contentResult.env };
      const run = await runDirect(contentResult.command, contentResult.args, contentResult.cwd, childEnv);
      assert.strictEqual(run.code, 0, 'real host rg content safety probe exits successfully');
      assert.ok(run.stdout.includes('sample.js'), 'real rg content probe returns the safe workspace file');
      assert.ok(!run.stdout.includes('.env'), 'real rg content probe never returns .env');
      assert.ok(!/\.git[\\/]/.test(run.stdout), 'real rg content probe cannot reopen .git through user --glob .git/**');
      console.log('PASS hostcase: real rg was found and classified');
    }
    console.log('PASS kimi-search-policy.e2e');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function runDirect(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
