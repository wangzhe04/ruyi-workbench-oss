'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS FILE POLICY');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-files-'));
process.env.RUYI_HOME = path.join(root, 'data');
const workspace = path.join(root, 'work'); fs.mkdirSync(workspace); fs.mkdirSync(process.env.RUYI_HOME);
const context = { session: { id: 'file-policy', cwd: workspace }, config: { permissionMode: 'default', defaultWorkspace: workspace } };
const wide = { ...context, config: { ...context.config, permissionMode: 'bypass', allowOutsideWorkspace: true } };
let mounted = false;
const mount = path.join(root, 'case-volume');
function disk(args) {
  const result = cp.spawnSync('/usr/bin/hdiutil', args, { encoding: 'utf8', timeout: 60000, env: { ...process.env } });
  if (args[0] === 'attach') {
    try { mounted = fs.statSync(mount).dev !== fs.statSync(root).dev; } catch { /* attach did not mount */ }
  }
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error || result.status));
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP macOS filesystem policy requires macOS'); return; }
    const S = loadServerInternals(['guardFileToolPath', 'toolCall', 'workspaceWriteRoots', 'fileAllowedRoots', 'normalizeConfig', 'withFileToolWriteLock', 'fileToolWriteChains']);
    const guard = (file, ctx = context, write = true) => S.guardFileToolPath(file, ctx, { tool: 'file_write', write });
    for (const target of ['/System/ruyi-no-write', '/bin/ruyi-no-write', '/sbin/ruyi-no-write', '/usr/bin/ruyi-no-write',
      '/etc/hosts', '/private/etc/hosts', '/private/var/db/ruyi-no-write', '/var/log/ruyi-no-write', '/dev/ruyi-no-write', '/', '/private', '/Users']) {
      const result = await guard(target, wide);
      t.ok(!result.ok && result.code === 'os-critical-denied', 'system write floor rejects ' + target);
    }
    for (const target of ['/Applications/ruyi-no-write.txt', '/Library/ruyi-no-write.txt', '/usr/local/share/ruyi-no-write.txt', '/opt/homebrew/ruyi-no-write.txt']) {
      const result = await guard(target, wide);
      t.ok(!result.ok && result.code === 'managed-location-denied', 'managed application/package location rejects file writes: ' + target);
    }
    t.ok((await guard('/etc/hosts', wide, false)).ok, 'system read still follows existing read authorization');
    const name = path.join(workspace, '中文 空格😀*.txt');
    const written = await S.toolCall('file_write', { path: name, content: 'v1' }, context);
    t.ok(written.ok && fs.readFileSync(name, 'utf8') === 'v1', 'ordinary Unicode/space/emoji/literal-star file writes succeed');
    const canonical = fs.realpathSync(name);
    const alias = '/System/Volumes/Data' + canonical;
    t.ok((await guard(alias)).ok, 'verified APFS Data alias of a workspace file remains writable');
    const caseAlias = path.join(path.dirname(workspace), 'WORK', 'new.txt');
    let insensitive = false;
    try { insensitive = fs.statSync(path.dirname(caseAlias)).ino === fs.statSync(workspace).ino; } catch { /* case-sensitive host volume */ }
    t.ok((await guard(caseAlias)).ok === insensitive, 'workspace spelling follows the actual host filesystem identity');
    if (insensitive) {
      const concurrent = path.join(workspace, 'Concurrent.txt');
      fs.writeFileSync(concurrent, 'AAA BBB');
      const results = await Promise.all([
        S.toolCall('file_edit', { path: concurrent, oldText: 'AAA', newText: '111' }, context),
        S.toolCall('file_edit', { path: path.join(workspace, 'CONCURRENT.TXT'), oldText: 'BBB', newText: '222' }, context),
      ]);
      t.ok(results.every(result => result.ok) && fs.readFileSync(concurrent, 'utf8') === '111 222',
        'concurrent case-alias edits preserve both changes across atomic replacement');
    }
    if (insensitive) t.ok(!(await guard(path.join(process.env.RUYI_HOME, 'SESSIONS', 'new.json'), wide)).ok, 'missing sensitive directory cannot be created through a case alias');
    const osLink = path.join(workspace, 'system-link'); fs.symlinkSync('/etc', osLink);
    t.ok(!(await guard(path.join(osLink, 'ruyi-no-write'), wide)).ok, 'workspace symlink cannot bypass system write floor');
    const cancelSource = path.join(workspace, 'cancel-source.txt');
    const cancelDestination = path.join(workspace, 'cancel-destination.txt');
    fs.writeFileSync(cancelSource, 'original');
    const mutations = [
      ['file_write', { path: cancelSource, content: 'changed' }],
      ['file_edit', { path: cancelSource, oldText: 'original', newText: 'changed' }],
      ['file_delete', { path: cancelSource }],
      ['file_move', { from: cancelSource, to: cancelDestination }],
      ['file_copy', { from: cancelSource, to: cancelDestination }],
    ];
    for (const [tool, args] of mutations) {
      const controller = new AbortController();
      let release;
      const held = S.withFileToolWriteLock([cancelSource], null, () => new Promise(resolve => { release = resolve; }));
      while (!release) await new Promise(resolve => setImmediate(resolve));
      const previous = S.fileToolWriteChains.get('darwin-file-writes');
      const pending = S.toolCall(tool, args, { ...context, signal: controller.signal });
      try {
        const deadline = Date.now() + 5000;
        while (S.fileToolWriteChains.get('darwin-file-writes') === previous && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        t.ok(S.fileToolWriteChains.get('darwin-file-writes') !== previous, tool + ' waits behind the active writer');
        controller.abort();
      } finally { release(); await held; }
      const result = await pending;
      t.ok(result.code === 'aborted' && fs.readFileSync(cancelSource, 'utf8') === 'original'
        && !fs.existsSync(cancelDestination), tool + ' cancelled while queued leaves source and destination intact');
      const pre = await S.toolCall(tool, args, { ...context, signal: controller.signal });
      t.ok(pre.code === 'aborted', tool + ' rejects a pre-cancelled write');
    }
    const recovered = await S.toolCall('file_write', { path: cancelSource, content: 'recovered' }, context);
    t.ok(recovered.ok && fs.readFileSync(cancelSource, 'utf8') === 'recovered', 'write queue accepts work after cancelled requests');
    const managedLink = path.join(workspace, 'managed-link'); fs.symlinkSync('/opt/homebrew', managedLink);
    t.ok(!(await guard(path.join(managedLink, 'ruyi-no-write'), wide)).ok, 'existing or dangling link cannot bypass managed-directory floor');
    const dangling = path.join(workspace, 'dangling'); fs.symlinkSync(path.join(root, 'outside', 'missing'), dangling);
    t.ok(!(await guard(path.join(dangling, 'new.txt'))).ok, 'dangling link cannot create an outside-workspace file');
    const locked = path.join(workspace, 'readonly'); fs.mkdirSync(locked); fs.chmodSync(locked, 0o555);
    try {
      if (process.getuid() === 0) console.log('SKIP Unix readonly-directory denial requires a non-root user');
      else {
        const result = await S.toolCall('file_write', { path: path.join(locked, 'new.txt'), content: 'denied' }, context).catch(error => ({ ok: false, error }));
        t.ok(!result.ok && !fs.existsSync(path.join(locked, 'new.txt')) && fs.readdirSync(locked).length === 0,
          'readonly-directory failure leaves no file or temporary artifact');
      }
    } finally { fs.chmodSync(locked, 0o755); }

    fs.mkdirSync(mount);
    const image = path.join(root, 'case.sparseimage');
    disk(['create', '-size', '64m', '-fs', 'Case-sensitive APFS', '-volname', 'RuyiP1Case', '-type', 'SPARSE', '-quiet', image]);
    disk(['attach', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-quiet', image]); mounted = true;
    const upper = path.join(mount, 'Project'), lower = path.join(mount, 'project');
    fs.mkdirSync(upper); fs.mkdirSync(lower);
    t.ok(fs.statSync(upper).ino !== fs.statSync(lower).ino, 'controlled APFSX volume proves case-distinct directories');
    const parent = path.join(mount, 'Parent'); fs.mkdirSync(parent);
    fs.symlinkSync(parent, path.join(mount, 'parent'));
    const missingRoot = path.join(parent, 'New');
    const missingContext = { session: { cwd: missingRoot }, config: { permissionMode: 'default', defaultWorkspace: missingRoot } };
    t.ok(!(await guard(path.join(parent, 'new', 'file.txt'), missingContext)).ok,
      'case-sensitive missing roots cannot be merged by a differently-cased symlink');
    const upperOnly = { session: { cwd: upper }, config: { permissionMode: 'default', defaultWorkspace: upper } };
    t.ok(!(await guard(path.join(lower, 'outside.txt'), upperOnly)).ok, 'case-sensitive sibling cannot inherit workspace permission');
    const both = { ...upperOnly, config: { ...upperOnly.config, workspaces: [{ path: lower, write: true, read: true }] } };
    t.ok(S.workspaceWriteRoots(both.session, both.config).includes(lower) && S.fileAllowedRoots(both.session, both.config).includes(lower),
      'case-distinct explicit workspace grants survive deduplication');
    const normalized = S.normalizeConfig({ configSchema: 10, workspaces: [{ path: upper }, { path: lower }],
      recentWorkspaces: [upper, lower], stewardManagedWorkspaces: [{ path: upper }, { path: lower }] }).config;
    t.ok(normalized.workspaces.some(row => row.path === upper) && normalized.workspaces.some(row => row.path === lower)
      && normalized.recentWorkspaces.includes(upper) && normalized.recentWorkspaces.includes(lower)
      && normalized.stewardManagedWorkspaces.length === 2,
      'configuration normalization retains case-distinct workspace and managed-directory rows');
    const allowed = await S.toolCall('file_write', { path: path.join(lower, '文件*.txt'), content: 'lower' }, both);
    t.ok(allowed.ok && fs.readFileSync(path.join(lower, '文件*.txt'), 'utf8') === 'lower' && !fs.existsSync(path.join(upper, '文件*.txt')),
      'normal file entry point writes only the separately authorized case-sensitive directory');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (mounted) {
      try { disk(['detach', '-quiet', mount]); mounted = false; }
      catch (error) {
        try { disk(['detach', '-force', '-quiet', mount]); mounted = false; }
        catch (retryError) { t.fail('owned fixture volume detach failed: ' + retryError.message); }
      }
    }
    if (!mounted) fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
