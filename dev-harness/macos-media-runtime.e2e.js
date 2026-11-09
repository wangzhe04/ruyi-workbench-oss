'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree } = require('./lib/kill-own-tree');
const t = createRunner('MACOS MEDIA RUNTIME');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-runtime-'));
process.env.RUYI_HOME = path.join(root, 'data');
const originalSpawn = cp.spawn;
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (check()) return; await sleep(20); }
  throw new Error('fixture condition timed out');
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS supervisor'); return; }
    const S = loadServerInternals(['MediaInspection', 'ProcessRuntime', 'ProcessRuntimeHooks', 'toolCall']);
    cp.spawn = function(...args) { const child = originalSpawn.apply(this, args); children.push(child); return child; };
    const executable = path.join(root, 'ffmpeg');
    process.env.PATH = root; process.env.IMAGEIO_FFMPEG_EXE = executable; process.env.FFMPEG_BINARY = '';
    process.env.RUYI_BUNDLED_PYTHON = path.join(root, 'python3'); process.env.VIRTUAL_ENV = '';
    const file = path.join(root, '音频.wav'); fs.writeFileSync(file, 'fixture');
    const context = { session: { id: 'media-runtime', cwd: root }, config: { defaultWorkspace: root, permissionMode: 'default' } };
    const call = (name, args, signal) => S.toolCall(name, args, { ...context, signal });
    const write = source => fs.writeFileSync(executable, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    const beat = path.join(root, 'heartbeat');
    const leaf = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),75000);`;
    const withLeaf = source => `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'});const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);${source}}},10);`;
    const version = 'if(process.argv.includes("-version")){console.log("ffmpeg 中文😀");process.exit(0)}';
    const frames = 'frame:0 pts_time:0\nlavfi.astats.Overall.Peak_level=-3\nlavfi.r128.I=-20\nframe:1 pts_time:1\nlavfi.astats.Overall.Peak_level=-2\n';
    write(version + withLeaf(`process.stderr.write(${JSON.stringify(frames)});process.exit(0)`));
    const good = await call('audio_inspect', { path: file });
    t.ok(good.ok && good.curve.length === 2 && good.integratedLufs === -20 && good.cleanupEscapeCoverage === 'observed-only', 'audio_inspect preserves streamed measurements and exposes cleanup coverage');
    const stopped = async () => { const size = fs.statSync(beat).size; await sleep(150); return size > 0 && fs.statSync(beat).size === size; };
    t.ok(!good.cleanupIncomplete && await stopped(), 'successful audio inspection stops its writing descendant');
    t.ok(children.some(child => { const handle = S.ProcessRuntime.handle(child); return handle && S.ProcessRuntime.owner(handle).sessionId === 'media-runtime' && S.ProcessRuntime.owner(handle).kind === 'media-inspection'; }), 'media execution inherits caller ownership');
    const versionResult = await S.MediaInspection.locate('ffmpeg');
    t.ok(versionResult.available && versionResult.version === 'ffmpeg 中文😀', 'version probe preserves Unicode');
    const pre = new AbortController(); pre.abort(); const before = children.length;
    t.ok((await call('audio_inspect', { path: file }, pre.signal)).code === 'aborted' && children.length === before, 'pre-aborted audio inspection starts no executable');
    for (const mode of ['abort', 'timeout']) {
      fs.unlinkSync(beat); write(version + withLeaf('setTimeout(()=>process.exit(0),75000);'));
      const controller = new AbortController(); const result = call('audio_inspect', { path: file }, controller.signal);
      await until(() => fs.existsSync(beat)); if (mode === 'abort') controller.abort();
      const value = await result;
      t.ok(!value.ok && value.code === (mode === 'abort' ? 'aborted' : 'media_timeout') && !value.cleanupIncomplete && await stopped(), mode + ' confirms cleanup and stops descendant writes');
    }
    write(version + 'process.stderr.write("decode failure");process.exit(9)');
    t.ok((await call('audio_inspect', { path: file })).code === 'audio_decode_failed', 'nonzero audio exit remains a decoding failure');
    const python = process.env.RUYI_BUNDLED_PYTHON;
    fs.writeFileSync(python, '#!' + process.execPath + '\nif(process.argv.includes("--version")){console.log("Python fixture");process.exit(0)}process.stdin.setEncoding("utf8");let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{if(s!=="print(\\"中文😀\\")")process.exit(9)});', { mode: 0o700 });
    t.ok((await call('code_check', { path: path.join(root, 'code.py'), content: 'print("中文😀")' })).ok, 'code_check sends complete Unicode source through supervised stdin');
    for (const mode of ['abort', 'timeout']) {
      fs.unlinkSync(beat);
      fs.writeFileSync(python, '#!' + process.execPath + '\nif(process.argv.includes("--version")){console.log("Python fixture");process.exit(0)}' + withLeaf('process.stdin.resume();setTimeout(()=>process.exit(0),75000);'), { mode: 0o700 });
      const source = path.join(root, 'unchanged.py'); fs.writeFileSync(source, '# preserved');
      const controller = new AbortController();
      const pending = call('file_write', { path: source, content: 'print(1)', validateSyntax: true }, controller.signal);
      await until(() => fs.existsSync(beat)); if (mode === 'abort') controller.abort();
      const result = await pending;
      const preserved = fs.readFileSync(source, 'utf8') === '# preserved';
      const heartbeatStopped = await stopped();
      const valid = !result.ok && result.written === false && result.code === (mode === 'abort' ? 'aborted' : 'syntax_check_timeout') && preserved && heartbeatStopped;
      if (!valid) console.log('DIAGNOSTIC syntax validation', JSON.stringify({ mode, result, preserved, heartbeatStopped,
        cleanup: S.ProcessRuntime.result(children.filter(child => S.ProcessRuntime.handle(child)).at(-1)) }));
      t.ok(valid, mode + ' in write-time syntax validation preserves original bytes and stops descendants');
    }
    const real = await call('code_check', { path: path.join(root, 'code.cjs'), content: 'throw new Error("must never execute")' });
    t.ok(real.ok && real.executed === false && !real.cleanupIncomplete, 'real Node parse-only check remains supervised without executing source');
    const helperPath = S.ProcessRuntimeHooks.helperPath;
    try {
      S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
      const missing = await S.MediaInspection.locate('ffmpeg');
      t.ok(!missing.available && missing.code === 'process_helper_missing', 'cached executable availability is revoked when supervisor disappears');
      const helper = path.join(root, 'incomplete-helper');
      const capabilities = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
      const events = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 }, { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      const fake = extra => '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilities))});process.exit(0)}${extra}require('fs').writeSync(3,${JSON.stringify(events.map(e=>JSON.stringify(e)+'\n').join(''))});process.stdout.write('ffmpeg valid');process.stderr.write(${JSON.stringify(frames)});process.exit(0);`;
      fs.writeFileSync(helper, fake(''), { mode: 0o700 }); S.ProcessRuntimeHooks.helperPath = () => helper;
      const incomplete = await S.MediaInspection.locate('ffmpeg', true);
      t.ok(!incomplete.available && incomplete.code === 'process_cleanup_incomplete', 'valid version output cannot conceal incomplete cleanup or trigger candidate fallback');
      fs.renameSync(executable, executable + '.saved');
      try {
        const nestedPython = await S.MediaInspection.locate('ffmpeg', true);
        t.ok(nestedPython.code === 'process_cleanup_incomplete' && nestedPython.cleanupIncomplete, 'nested Python discovery preserves cleanup failure');
        const nestedFfmpeg = await S.MediaInspection.locate('ffprobe', true);
        t.ok(nestedFfmpeg.code === 'process_cleanup_incomplete' && nestedFfmpeg.cleanupIncomplete, 'nested FFmpeg discovery preserves cleanup failure');
      } finally { fs.renameSync(executable + '.saved', executable); }
      const beforeBatch = children.filter(c => S.ProcessRuntime.handle(c)).length;
      const batch = await call('media_probe', { refresh: true });
      t.ok(!batch.ok && batch.cleanupIncomplete && children.filter(c => S.ProcessRuntime.handle(c)).length === beforeBatch + 1, 'media_probe stops further discovery after unconfirmed cleanup');
      const badAudio = await call('audio_inspect', { path: file });
      t.ok(!badAudio.ok && badAudio.cleanupIncomplete, 'valid audio measurements cannot conceal incomplete cleanup');
      events[1] = { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 };
      fs.writeFileSync(helper, fake("const leaf=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),2000)'],{stdio:['ignore','inherit','inherit']});leaf.unref();"), { mode: 0o700 });
      const retained = await call('audio_inspect', { path: file });
      const child = children.filter(c => S.ProcessRuntime.handle(c)).at(-1);
      t.ok(!retained.ok && child.stdout.destroyed && child.stderr.destroyed, 'retained output pipes cause bounded failure and release stream handles');
      await sleep(2100);
    } finally { S.ProcessRuntimeHooks.helperPath = helperPath; }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    cp.spawn = originalSpawn;
    for (const child of children) killOwnTree(child);
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
