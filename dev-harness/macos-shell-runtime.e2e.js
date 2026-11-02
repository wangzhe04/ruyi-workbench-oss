'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS SHELL RUNTIME');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-shell-test-'));
process.env.RUYI_HOME = path.join(root, 'data');
const shells = [];
let S;
const savedEnvironment = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const ctx = { sessionId: 'shell-test-a', session: { id: 'shell-test-a', cwd: root }, config: { permissionMode: 'default', defaultWorkspace: root } };
const other = { session: { id: 'shell-test-b', cwd: root }, config: ctx.config };
async function until(check) {
  const deadline = Date.now() + 7000;
  do { const result = await check(); if (result) return result; await sleep(25); } while (Date.now() < deadline);
  throw new Error('condition timed out');
}
async function call(name, args, context = ctx) { return S.toolCall(name, args, context); }
async function start(args, context = ctx) {
  const result = await call('shell_start', args, context);
  if (result.ok) shells.push({ id: result.shellId, context });
  return result;
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac shell requires macOS'); return; }
    S = loadServerInternals(['toolCall', 'shellStart', 'shellKill', 'shellSessions', 'nativeToolTier', 'suggestToolNames', 'ProcessRuntimeHooks']);
    if (!fs.existsSync(S.ProcessRuntimeHooks.helperPath())) throw new Error('Build the macOS helper first');
    const marker = path.join(root, 'startup-injection');
    const profile = path.join(root, 'injected-profile');
    fs.writeFileSync(profile, 'printf injected > ' + quote(marker) + '\n');
    for (const [key, value] of Object.entries({ BASH_ENV: profile, ENV: profile, SHELLOPTS: 'xtrace', BASHOPTS: 'extdebug',
      PS4: '$(touch ' + quote(marker) + ')', 'BASH_FUNC_ruyi_probe%%': '() { touch ' + quote(marker) + '; }', RUYI_SHELL_KEEP: '中文😀' })) {
      savedEnvironment.set(key, process.env[key]); process.env[key] = value;
    }
    for (const name of ['.bashrc', '.bash_profile', '.profile']) fs.writeFileSync(path.join(process.env.HOME, name), fs.readFileSync(profile));
    const once = await call('shell_run', { command: 'printf "%s" "$RUYI_SHELL_KEEP"; printf "%s" "${BASH_ENV-unset}"' });
    t.ok(once.ok && once.stdout === '中文😀unset' && !fs.existsSync(marker), 'platform one-shot shell preserves Unicode/env while refusing startup injections');
    t.ok(S.nativeToolTier('shell_run') === 'exec', 'platform shell remains exec tier');
    const disabled = await call('shell_run', { command: 'touch ' + quote(marker) }, { ...ctx, config: { ...ctx.config, allowCommandTools: false } });
    t.ok(!disabled.ok && !fs.existsSync(marker), 'disabled command policy blocks the new shell entry point');
    const outside = await call('shell_run', { command: 'touch ' + quote(marker), cwd: root },
      { ...ctx, config: { ...ctx.config, workspaces: [{ path: root, execute: false }] } });
    t.ok(!outside.ok && !fs.existsSync(marker), 'workspace execute=false is enforced before bash starts');
    const defaultScript = await call('script_run', { code: 'printf bash-default' });
    t.ok(defaultScript.ok && defaultScript.stdout === 'bash-default', 'Mac script_run defaults to bash');
    const powershell = await call('shell_run', { language: 'powershell', command: 'touch ' + quote(marker) });
    t.ok(!powershell.ok && !fs.existsSync(marker), 'explicit PowerShell is never interpreted as bash');
    const longScript = await call('script_run', { language: 'bash', code: '#' + 'x'.repeat(200000) + '\nprintf long-script-ok' });
    t.ok(longScript.ok && longScript.stdout === 'long-script-ok', 'one-shot script file avoids argv length limits');
    t.ok(S.suggestToolNames('bash', ['shell_run', 'powershell_run'])[0] === 'shell_run', 'bash name guidance points to the platform shell');

    const actualHelper = S.ProcessRuntimeHooks.helperPath;
    try {
      S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
      const absent = await call('shell_run', { command: 'touch ' + quote(marker) });
      t.ok(!absent.ok && absent.code === 'process_helper_missing' && !fs.existsSync(marker), 'missing supervisor blocks bash before executing a command');
      const absentSession = await call('shell_start', { command: 'touch ' + quote(marker) });
      t.ok(!absentSession.ok && absentSession.code === 'process_helper_missing' && !fs.existsSync(marker), 'missing supervisor blocks shell session creation');
    } finally { S.ProcessRuntimeHooks.helperPath = actualHelper; }

    const session = await start({ name: 'stateful' });
    t.ok(session.ok && session.shell === 'bash' && session.tty === false, 'persistent shell starts with explicit non-TTY semantics');
    const nested = path.join(root, '目录 😀 *\n'); fs.mkdirSync(nested);
    const sent = await call('shell_send', { shellId: session.shellId, input: 'export RUYI_VALUE="状态😀"\ncd ' + quote(nested) + '\nprintf "%s" "$RUYI_VALUE"' });
    t.ok(sent.ok && sent.settled === 'completed' && sent.output === '状态😀' && sent.cwd === fs.realpathSync(nested), 'multiline command preserves state and returns no-newline output with physical cwd');
    const retained = await call('shell_send', { shellId: session.shellId, input: 'printf "%s" "$RUYI_VALUE"; false' });
    t.ok(!retained.ok && retained.commandExitCode === 1 && retained.running && retained.output === '状态😀', 'nonzero command status is distinct from live shell state');
    const forged = await call('shell_send', { shellId: session.shellId, input: "printf '99\\0000\\000/tmp\\000'; false" });
    t.ok(!forged.ok && forged.commandExitCode === 1 && forged.cwd === fs.realpathSync(nested) && forged.output.includes('\0'), 'ordinary stdout cannot forge command completion or cwd');
    const privateChannel = await call('shell_send', { shellId: session.shellId, input: 'if ( : >&4 ) 2>/dev/null; then printf open; else printf closed; fi' });
    t.ok(privateChannel.ok && privateChannel.output === 'closed', 'evaluated commands cannot write the completion descriptor');
    const noInput = await call('shell_send', { shellId: session.shellId, input: 'read answer; printf "read=%s" "$?"' });
    t.ok(noInput.ok && noInput.output === 'read=1', 'command stdin is closed instead of consuming protocol input');
    const splitText = await call('shell_send', { shellId: session.shellId, input: quote(process.execPath) + ' -e '
      + quote('const b=Buffer.from("中文");process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),300)') });
    t.ok(splitText.ok && splitText.output === '中文', 'UTF-8 characters split across idle flush intervals remain intact');
    const hidden = await call('shell_list', {}, other);
    t.ok(!hidden.shells.some(shell => shell.shellId === session.shellId), 'session-object context cannot list another session shell');
    t.ok(!(await call('shell_send', { shellId: session.shellId, input: 'printf stolen' }, other)).ok
      && !(await call('shell_kill', { shellId: session.shellId }, other)).ok, 'cross-session send and kill are refused');
    const oversized = await call('shell_send', { shellId: session.shellId, input: 'x'.repeat(1024 * 1024 + 1) });
    t.ok(!oversized.ok && oversized.code === 'invalid_args', 'oversized persistent command is rejected before transport');
    const longInput = await call('shell_send', { shellId: session.shellId, input: '#' + 'x'.repeat(200000) + '\nprintf long-input' });
    t.ok(longInput.ok && longInput.output === 'long-input', 'persistent command transport supports input beyond argv limits');
    const delayed = await call('shell_send', { shellId: session.shellId, input: 'sleep 2; printf late', timeoutMs: 1000 });
    t.ok(delayed.settled === 'timeout' && delayed.commandRunning, 'silent long command remains explicitly pending after send timeout');
    t.ok(!(await call('shell_send', { shellId: session.shellId, input: 'printf overlap' })).ok, 'a pending command refuses overlapping input');
    const polled = await until(async () => { const value = await call('shell_poll', { shellId: session.shellId, cursor: delayed.cursor }); return !value.commandRunning && value.output.includes('late') && value; });
    t.ok(polled.commandExitCode === 0 && polled.running, 'poll reports completion while persistent shell stays alive');
    const large = await call('shell_send', { shellId: session.shellId, input: quote(process.execPath) + ' -e ' + quote('process.stdout.write("Z".repeat(80000))') });
    t.ok(large.ok && large.omittedChars > 0 && large.output.length < 31000, 'persistent output obeys the existing head/tail budget');

    const beat = path.join(root, 'heartbeat');
    const nodeCommand = quote(process.execPath) + ' -e ' + quote(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),8000);`);
    const background = await start({ command: nodeCommand, timeoutMs: 1000 });
    t.ok(background.ok && background.mode === 'background', 'finite bash background job starts through normal tool dispatch');
    const ended = await until(async () => { const value = await call('shell_poll', { shellId: background.shellId }); return !value.running && value.cleanupIncomplete === false && value; });
    const beatSize = fs.statSync(beat).size; await sleep(100);
    t.ok(ended.timedOut && fs.statSync(beat).size === beatSize, 'background timeout verifies descendant cleanup and stops side effects');
    const limitContext = { sessionId: 'limit-session', session: { id: 'limit-session', cwd: root } };
    const starts = await Promise.all(['limit-one', 'limit-two'].map(shellId => S.shellStart({ shellId, command: 'sleep 3', cwd: root }, { shellSessionMax: 1 }, limitContext)));
    for (const result of starts) if (result.ok) shells.push({ id: result.shellId, context: limitContext });
    t.ok(starts.filter(result => result.ok).length === 1, 'async background script creation reserves per-session capacity');
    const cancelMarker = path.join(root, 'cancel-start');
    const pendingStart = S.shellStart({ shellId: 'cancel-start', command: 'touch ' + quote(cancelMarker), cwd: root }, { shellSessionMax: 3 }, ctx);
    const cancelled = await S.shellKill({ shellId: 'cancel-start' }, ctx);
    const cancelledStart = await pendingStart;
    t.ok(cancelled.ok && cancelledStart.code === 'cancelled' && !fs.existsSync(cancelMarker), 'cancellation during script creation prevents spawning');
    const interruptSession = await start({ name: 'interruptible' });
    const controller = new AbortController();
    const interruptBeat = path.join(root, 'interrupt-beat');
    const interruptCode = quote(process.execPath) + ' -e ' + quote(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(interruptBeat)},'x'),10);setTimeout(()=>process.exit(0),8000);`);
    const pendingSend = call('shell_send', { shellId: interruptSession.shellId, input: interruptCode }, { ...ctx, signal: controller.signal });
    await until(() => fs.existsSync(interruptBeat)); controller.abort();
    const interrupted = await pendingSend;
    const interruptSize = fs.statSync(interruptBeat).size; await sleep(100);
    t.ok(!interrupted.ok && interrupted.interrupted && fs.statSync(interruptBeat).size === interruptSize,
      'explicit interruption cancels a persistent command and stops its descendants');
    const stopped = await call('shell_kill', { shellId: session.shellId });
    t.ok(stopped.ok && stopped.cleanupIncomplete === false && stopped.cleanupScope === 'owned-group-and-observed', 'shell_kill waits for confirmed cleanup before releasing the session');
    t.ok(!fs.existsSync(marker), 'no shell path evaluated inherited profile or function injections');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (S) for (const shell of shells) await S.shellKill({ shellId: shell.id }, shell.context);
    for (const [key, value] of savedEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
