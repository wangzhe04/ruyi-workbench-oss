'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('MACOS OPENER');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-opener-'));
process.env.RUYI_HOME = path.join(root, 'data');
const children = [], calls = [];
const originalSpawn = cp.spawn;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS opener policy'); return; }
    const S = loadServerInternals(['spawnDetachedChecked', 'toolCall']);
    const context = { session: { id: 'opener', cwd: root }, config: { defaultWorkspace: root, permissionMode: 'default' } };
    const marker = path.join(root, 'completed');
    let mode = 'success';
    cp.spawn = function(command, args, options) {
      let child;
      if (command === '/usr/bin/open') {
        calls.push({ command, args, options });
        const code = mode === 'success' ? `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'done');process.exit(0)},150)`
          : mode === 'failure' ? 'process.exit(13)' : mode === 'signal' ? 'process.kill(process.pid,"SIGTERM")'
            : `setInterval(()=>require('fs').appendFileSync(${JSON.stringify(marker)},'x'),10);setTimeout(()=>process.exit(0),10000);`;
        child = originalSpawn.call(this, mode === 'missing' ? path.join(root, 'missing') : process.execPath, ['-e', code], options);
      } else child = originalSpawn.apply(this, arguments);
      children.push(child); return child;
    };
    const folder = await S.toolCall('office_open', { path: root }, context);
    if (!folder.ok) throw new Error(JSON.stringify(folder));
    t.ok(folder.ok && fs.existsSync(marker), 'office_open waits for successful Mac handoff completion');
    t.ok(calls.at(-1).args.join('|') === '--|' + fs.realpathSync(root) && calls.at(-1).options.detached, 'folder handoff retains literal argv and delegated application lifetime');
    fs.unlinkSync(marker);
    const browser = await S.toolCall('browser_open', { url: 'https://example.test/a?x=1&y=2' }, context);
    t.ok(browser.ok && fs.existsSync(marker) && browser.preservedWorkbench === null && calls.at(-1).args.at(-1) === 'https://example.test/a?x=1&y=2', 'browser handoff waits for completion without shell interpolation');
    const script = path.join(root, '脚本 &;.command'); fs.writeFileSync(script, 'exit 99');
    const reveal = await S.toolCall('office_open', { path: script }, context);
    t.ok(reveal.ok && reveal.opened === false && reveal.revealed === script && calls.at(-1).args[0] === '-R', 'executable documents remain reveal-only after the completion change');
    const bundle = path.join(root, '测试.app'); fs.mkdirSync(bundle);
    const bundleAlias = path.join(root, 'folder-alias'); fs.symlinkSync(bundle, bundleAlias);
    const officeBundle = await S.toolCall('office_open', { path: bundleAlias }, context);
    t.ok(officeBundle.ok && officeBundle.opened === false && calls.at(-1).args[0] === '-R' && calls.at(-1).args.at(-1) === fs.realpathSync(bundle), 'office app-bundle aliases are canonically revealed instead of executed');
    const browserBundle = await S.toolCall('browser_open', { url: bundleAlias }, context);
    t.ok(browserBundle.ok && browserBundle.opened === false && browserBundle.browserMode === 'file-selection' && calls.at(-1).args[0] === '-R', 'browser folder aliases cannot launch application bundles');
    const textAlias = path.join(root, 'safe.txt'); fs.symlinkSync(script, textAlias);
    const officeScript = await S.toolCall('office_open', { path: textAlias }, context);
    t.ok(officeScript.ok && officeScript.opened === false && calls.at(-1).args[0] === '-R', 'safe-looking document aliases cannot execute scripts');
    const htmlAlias = path.join(root, 'safe.html'); fs.symlinkSync(script, htmlAlias);
    const before = calls.length;
    t.ok(!(await S.toolCall('browser_open', { url: htmlAlias }, context)).ok && calls.length === before, 'HTML aliases to executable files are rejected before handoff');
    const { pathToFileURL, fileURLToPath } = require('url');
    t.ok(!(await S.toolCall('browser_open', { url: pathToFileURL(script).href }, context)).ok && calls.length === before, 'file URLs cannot bypass browser target validation');
    const html = path.join(root, '网页.html'); fs.writeFileSync(html, '<html>fixture</html>');
    const local = await S.toolCall('browser_open', { url: pathToFileURL(html).href + '?fixture=1#section' }, context);
    t.ok(local.ok && fileURLToPath(calls.at(-1).args.at(-1)) === fs.realpathSync(html) && new URL(calls.at(-1).args.at(-1)).search === '?fixture=1' && new URL(calls.at(-1).args.at(-1)).hash === '#section', 'canonical local HTML URLs preserve their query and fragment');
    mode = 'failure';
    t.ok(!(await S.toolCall('office_open', { path: root }, context)).ok, 'nonzero opener exit cannot advertise an opened document');
    t.ok(!(await S.toolCall('browser_open', { url: 'https://example.test/' }, context)).ok, 'nonzero opener exit cannot advertise an opened browser');
    mode = 'signal';
    const signalled = await S.spawnDetachedChecked('/usr/bin/open', ['--', root], { detached: true, stdio: 'ignore' });
    t.ok(!signalled.ok && signalled.signal === 'SIGTERM', 'signal exit reports a failed handoff');
    mode = 'missing';
    t.ok((await S.spawnDetachedChecked('/usr/bin/open', ['--', root], { stdio: 'ignore' })).code === 'ENOENT', 'spawn errors retain their original code without an uncaught exception');
    mode = 'timeout'; fs.unlinkSync(marker);
    const timeout = await S.spawnDetachedChecked('/usr/bin/open', ['--', root], { detached: true, stdio: 'ignore' });
    const stoppedAt = fs.statSync(marker).size; await sleep(150);
    t.ok(!timeout.ok && timeout.code === 'open_timeout' && fs.statSync(marker).size === stoppedAt, 'five-second handoff timeout stops only the owned launcher and reports failure');
    const W = loadServerInternals(['spawnDetachedChecked'], { testPlatform: 'win32' });
    const legacy = await W.spawnDetachedChecked(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),2000)'], { detached: true, stdio: 'ignore' });
    const last = children.at(-1);
    t.ok(legacy.ok && last.exitCode === null && last.signalCode === null, 'non-Mac branch retains spawn-event success semantics');
    cp.spawn = originalSpawn;
    const realMissing = await S.toolCall('office_open', { path: path.join(root, 'missing.txt') }, context);
    t.ok(!realMissing.ok, 'missing local documents are rejected before claiming an opened result');
    const realFailure = await S.spawnDetachedChecked('/usr/bin/open', ['--', path.join(root, 'also-missing.txt')], { detached: true, stdio: 'ignore' });
    t.ok(!realFailure.ok && realFailure.exitCode !== 0, 'real macOS open nonzero exit is reported as failure');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { cp.spawn = originalSpawn; for (const child of children) killOwnTree(child); fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
