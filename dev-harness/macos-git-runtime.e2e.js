'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS GIT RUNTIME');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-git-runtime-'));
process.env.RUYI_HOME = path.join(root, 'data');
const capabilityReport = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
const capabilityPrelude = `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilityReport))});process.exit(0);}`;
const handles = [];
let runtime;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP macOS supervisor requires macOS'); return; }
    const S = loadServerInternals(['ProcessRuntime', 'ProcessRuntimeHooks', 'runGit', 'gitHumanError', 'gitCommit', 'gitReadOnlyGuard', 'gitDiff', 'toolCall', 'DesktopShell', 'gitExec', 'createAgentWorktree', 'cleanupAgentWorktree', 'applyAgentWorktree', 'agentRunFile'], { withEval: true });
    runtime = S.ProcessRuntime;
    if (!fs.existsSync(S.ProcessRuntimeHooks.helperPath())) throw new Error('Build the native macOS process helper first');
    async function capture(script, options = {}) {
      const job = runtime.capture(process.execPath, ['-e', script], {
        cwd: root, env: fixtureChildEnv(), maxBuffer: 1024, encoding: 'buffer', ...options,
      }, { kind: 'git-capture-fixture' });
      handles.push(runtime.handle(job.child));
      return job.output;
    }
    const binary = await capture("process.stdout.write(Buffer.from([0,128,255,13,10]));process.stderr.write('err')");
    t.ok(!binary.error && Buffer.isBuffer(binary.stdout) && binary.stdout.toString('hex') === '0080ff0d0a', 'capture preserves exact binary bytes');
    t.ok(Buffer.isBuffer(binary.stderr) && binary.stderr.toString() === 'err', 'buffer encoding also applies to stderr');
    const unicode = await capture("const b=Buffer.from('中文😀');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),10)", { encoding: 'utf8' });
    t.ok(!unicode.error && unicode.stdout === '中文😀', 'UTF-8 split across chunks decodes after capture');
    const status = await capture("process.stdout.write('partial');process.exitCode=7");
    t.ok(status.error?.code === 7 && status.stdout.toString() === 'partial', 'nonzero exit preserves partial output and numeric status');
    for (const stream of ['stdout', 'stderr']) {
      const limited = await capture(`process.${stream}.write('x'.repeat(4096));setTimeout(()=>{},8000)`, { maxBuffer: 256 });
      t.ok(limited.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && limited[stream].length === 256,
        stream + ' output budget triggers supervised cancellation and retains bounded bytes');
    }
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    async function git(args, options = {}) { return S.runGit(args, repo, 4000, options); }
    for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
      const result = await git(args); if (!result.ok) throw new Error(JSON.stringify(result));
    }
    const bytes = Buffer.from([0, 255, 128, 0, 10]);
    fs.writeFileSync(path.join(repo, 'binary.dat'), bytes);
    if (!(await git(['add', '.'])).ok || !(await git(['commit', '-q', '-m', 'fixture'])).ok) throw new Error('fixture commit failed');
    const blob = await git(['show', 'HEAD:binary.dat'], { encoding: 'buffer' });
    t.ok(blob.ok && Buffer.isBuffer(blob.stdout) && blob.stdout.equals(bytes), 'real git blob output preserves binary contents');
    t.ok(blob.cleanupScope === 'owned-group-and-observed' && !blob.cleanupIncomplete && blob.cleanupEscapeCoverage === 'observed-only', 'git result reports confirmed supervised scope');
    const spawned = [];
    const originalSpawn = cp.spawn;
    try {
      cp.spawn = function(command, args, options) {
        const child = originalSpawn.call(this, command, args, options);
        if (command === S.ProcessRuntimeHooks.helperPath()) spawned.push(child);
        return child;
      };
      const contexts = ['owner-a', 'owner-b'].map(id => ({ session: { id, cwd: repo }, config: { permissionMode: 'default' } }));
      const results = await Promise.all(contexts.map(context => S.toolCall('git_status', {}, context)));
      const owners = spawned.map(child => runtime.owner(runtime.handle(child)));
      t.ok(results.every(result => result.ok) && owners.some(owner => owner.sessionId === 'owner-a') && owners.some(owner => owner.sessionId === 'owner-b')
        && owners.every(owner => owner.toolName === 'git_status' && owner.invocationId && Object.isFrozen(owner)),
        'normal tool dispatch associates concurrent git executions with immutable session/tool owners');
      t.ok(new Set(owners.map(owner => owner.invocationId)).size === 2 && runtime.currentOwner() === undefined,
        'async owner context stays isolated across concurrent tool invocations and clears afterward');
      const desktop = await runtime.withOwner({ sessionId: 'owner-desktop', toolName: 'script_run' },
        () => S.DesktopShell.runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], { owner: { toolCallId: 'command-1' } }));
      const desktopOwner = runtime.owner(runtime.handle(spawned.at(-1)));
      t.ok(desktop.ok && desktopOwner.sessionId === 'owner-desktop' && desktopOwner.toolCallId === 'command-1'
        && desktopOwner.kind === 'desktop-shell', 'one-shot execution combines inherited owner context with explicit command identity');
      const worktreeRoot = await runtime.withOwner({ sessionId: 'worktree-owner' }, () => S.gitExec(repo, ['rev-parse', '--show-toplevel']));
      const worktreeOwner = runtime.owner(runtime.handle(spawned.at(-1)));
      t.ok(fs.realpathSync(worktreeRoot) === fs.realpathSync(repo) && worktreeOwner.kind === 'agent-worktree'
        && worktreeOwner.sessionId === 'worktree-owner', 'worktree Git reuses supervised execution and immutable owner context');
    } finally { cp.spawn = originalSpawn; }
    const beat = path.join(root, 'hook-heartbeat');
    const background = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),8000);`;
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\n' + quote(process.execPath) + ' -e ' + quote(background) + ' &\n'
      + 'while [ ! -s ' + quote(beat) + ' ]; do sleep 0.01; done\nexit 0\n', { mode: 0o700 });
    const commit = await git(['commit', '--allow-empty', '-q', '-m', 'hook-completes']);
    t.ok(commit.ok && !commit.timedOut, 'git commit completes normally while its hook leaves a background descendant');
    const size = fs.statSync(beat).size; await sleep(100);
    t.ok(size > 0 && fs.statSync(beat).size === size, 'hook descendant stops after git exits naturally');
    fs.unlinkSync(beat);
    await S.gitExec(repo, ['commit', '--allow-empty', '-q', '-m', 'worktree-git-hook']);
    const worktreeBeatSize = fs.statSync(beat).size; await sleep(100);
    t.ok(worktreeBeatSize > 0 && fs.statSync(beat).size === worktreeBeatSize, 'worktree Git entry point stops hook descendants after normal exit');
    const isolation = await S.createAgentWorktree(repo, 'worktree-run', 'node-a', 1);
    const retainedFile = path.join(isolation.path, 'retained.txt'); fs.writeFileSync(retainedFile, 'keep');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 8\n');
    const timeout = await S.runGit(['commit', '--allow-empty', '-q', '-m', 'timeout'], repo, 1000);
    const human = S.gitHumanError(timeout, repo);
    t.ok(timeout.timedOut && !timeout.cleanupIncomplete && human.cleanupEscapeCoverage === 'observed-only', 'git timeout keeps cleanup metadata through user-facing error');

    const realHelper = S.ProcessRuntimeHooks.helperPath;
    try {
      const fake = path.join(root, 'incomplete-helper');
      for (const exitCode of [0, 1, 128]) {
        const frames = [{ event: 'started', value: 123, created: '1' },
          { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 },
          { event: 'exit', value: exitCode, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }].map(frame => JSON.stringify(frame) + '\n').join('');
        fs.writeFileSync(fake, '#!' + process.execPath + '\n' + capabilityPrelude + `require('fs').writeSync(3,${JSON.stringify(frames)});process.stdout.write('nothing to commit');process.exitCode=${exitCode};\n`, { mode: 0o700 });
        S.ProcessRuntimeHooks.helperPath = () => fake;
        let worktreeError;
        try { await S.cleanupAgentWorktree(isolation); } catch (error) { worktreeError = error; }
        t.ok(worktreeError?.cleanupIncomplete && isolation.path && fs.readFileSync(retainedFile, 'utf8') === 'keep',
          'unconfirmed worktree removal preserves directory and retry path, code=' + exitCode);
        const incomplete = await git(['status']);
        t.ok(!incomplete.ok && incomplete.error?.code === 'ERR_PROCESS_CLEANUP_INCOMPLETE'
          && S.gitHumanError(incomplete, repo).cleanupIncomplete, 'unconfirmed cleanup survives git exit code ' + exitCode);
        const failedCommit = await S.gitCommit({ cwd: repo, message: 'fixture' });
        t.ok(!failedCommit.ok && failedCommit.cleanupIncomplete && !failedCommit.hookRejected && /清理/.test(failedCommit.error),
          'commit cannot disguise unconfirmed cleanup as an empty commit or hook rejection, code=' + exitCode);
        const guard = await S.gitReadOnlyGuard(repo, 1000);
        t.ok(!guard.ok && guard.res.cleanupIncomplete, 'read-only guard rejects incomplete cleanup, code=' + exitCode);
      }
      for (const phase of ['stat', 'untracked', 'cached', 'head']) {
        fs.writeFileSync(fake, '#!' + process.execPath + '\n' + capabilityPrelude + `
const fs=require('fs'),args=process.argv.slice(2),phase=${JSON.stringify(phase)};
const failed=phase==='head'?args.includes('rev-parse'):phase==='stat'?args.some(a=>a.startsWith('--stat=')):phase==='untracked'?args.includes('ls-files'):args.includes('--quiet');
const code=failed?128:args.includes('config')?1:0;
const frames=[{event:'started',value:123,created:'1'},{event:'cleanup',value:failed?1:0,detail:failed?0:1,terminated:0,alreadyExited:failed?0:1,observed:1},{event:'exit',value:code,detail:0},{event:'guardian-cleanup',value:0,detail:1,terminated:0,alreadyExited:0,observed:0}];
fs.writeSync(3,frames.map(f=>JSON.stringify(f)+'\\n').join(''));
if(phase==='stat'&&args.includes('diff')&&!failed)process.stdout.write('x'.repeat(60000));
process.exitCode=code;
`, { mode: 0o700 });
        const result = phase === 'head' ? await S.gitCommit({ cwd: repo, message: 'fixture' }) : await S.gitDiff({ cwd: repo });
        t.ok(!result.ok && result.cleanupIncomplete, 'auxiliary ' + phase + ' cleanup failure prevents overall success');
      }
      const mutationLog = path.join(root, 'worktree-mutation-log');
      fs.writeFileSync(fake, '#!' + process.execPath + '\n' + capabilityPrelude + `
const fs=require('fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(mutationLog)},JSON.stringify(args)+'\\n');
const failed=args.includes('cherry-pick');
const frames=[{event:'started',value:123,created:'1'},{event:'cleanup',value:failed?1:0,detail:failed?0:1,terminated:0,alreadyExited:failed?0:1,observed:1},{event:'exit',value:0,detail:0},{event:'guardian-cleanup',value:0,detail:1,terminated:0,alreadyExited:0,observed:0}];
fs.writeSync(3,frames.map(frame=>JSON.stringify(frame)+'\\n').join(''));
if(args.includes('rev-parse'))process.stdout.write(${JSON.stringify(isolation.repoRoot)});
`, { mode: 0o700 });
      const failedApply = await S.applyAgentWorktree({ id: 'run_abc111', sessionId: 'sess_abc111', nodes: [{ id: 'node-a', isolation: { ...isolation, status: 'ready', commit: 'fixture-commit' } }] }, 'node-a');
      t.ok(!failedApply.ok && failedApply.cleanupIncomplete && !fs.readFileSync(mutationLog, 'utf8').includes('--abort'),
        'unconfirmed cherry-pick cleanup prevents a concurrent abort or success result');
      fs.writeFileSync(mutationLog, '');
      const cleanupFailureSource = fs.readFileSync(fake, 'utf8').replace("const failed=args.includes('cherry-pick');", "const failed=args.includes('worktree');");
      fs.writeFileSync(fake, cleanupFailureSource);
      const appliedRun = { id: 'run_cleanup1234', sessionId: 'session_cleanup1234', nodes: [{ id: 'node-a', isolation: { ...isolation, status: 'ready', commit: 'fixture-commit' } }] };
      const concurrentApply = await Promise.all([S.applyAgentWorktree(appliedRun, 'node-a'), S.applyAgentWorktree(structuredClone(appliedRun), 'node-a')]);
      const appliedWithCleanupFailure = concurrentApply.find(result => result.applied);
      t.ok(concurrentApply.some(result => result.alreadyApplied), 'concurrent same-repository apply reloads committed state under the execution lock');
      const savedRun = JSON.parse(fs.readFileSync(S.agentRunFile(appliedRun.sessionId, appliedRun.id), 'utf8'));
      const retriedApply = await S.applyAgentWorktree(savedRun, 'node-a');
      const mutationCalls = fs.readFileSync(mutationLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      t.ok(!appliedWithCleanupFailure.ok && appliedWithCleanupFailure.applied && appliedWithCleanupFailure.cleanupIncomplete
        && savedRun.nodes[0].isolation.status === 'applied' && savedRun.nodes[0].isolation.path === isolation.path,
        'successful cherry-pick is durably recorded before failed cleanup and retains its path');
      t.ok(retriedApply.alreadyApplied && retriedApply.cleanupPending && mutationCalls.filter(args => args.includes('cherry-pick')).length === 1,
        'reloaded apply retry does not cherry-pick an already applied commit again');
      fs.writeFileSync(fake, cleanupFailureSource.replace("const failed=args.includes('worktree');", 'const failed=false;'));
      fs.writeFileSync(mutationLog, '');
      const persistenceRun = { id: 'run_abc222', sessionId: 'sess_abc222', nodes: [{ id: 'node-a', isolation: { ...isolation, status: 'ready', commit: 'fixture-commit' } }] };
      const persistenceFile = S.agentRunFile(persistenceRun.sessionId, persistenceRun.id);
      S.__eval(`globalThis.__worktreeOriginalWrite = atomicWriteJson; atomicWriteJson = async (file,value,...rest) => {
        const snapshot = typeof value === 'string' ? JSON.parse(value) : value;
        if(file === ${JSON.stringify(persistenceFile)} && snapshot.nodes?.[0]?.isolation?.status === 'applied') throw Object.assign(new Error('synthetic applied persistence failure'),{code:'EIO'});
        return globalThis.__worktreeOriginalWrite(file,value,...rest);
      };`);
      let persistenceError;
      try { await S.applyAgentWorktree(persistenceRun, 'node-a'); } catch (error) { persistenceError = error; }
      finally { S.__eval('atomicWriteJson = globalThis.__worktreeOriginalWrite; delete globalThis.__worktreeOriginalWrite;'); }
      const pendingApply = JSON.parse(fs.readFileSync(persistenceFile, 'utf8'));
      const blockedReplay = await S.applyAgentWorktree(pendingApply, 'node-a');
      t.ok(persistenceError?.applied && persistenceError.applicationUnconfirmed && pendingApply.nodes[0].isolation.status === 'applying'
        && !blockedReplay.ok && blockedReplay.applicationUnconfirmed, 'failed applied-state persistence retains durable uncertainty and refuses replay');
      t.ok(fs.readFileSync(mutationLog, 'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(args=>args.includes('cherry-pick')).length === 1,
        'persistence failure and reload cannot cause duplicate cherry-pick');
      fs.writeFileSync(mutationLog, '');
      const intentRun = { id: 'run_abc333', sessionId: 'sess_abc333', nodes: [{ id: 'node-a', isolation: { ...isolation, status: 'ready', commit: 'fixture-commit' } }] };
      const intentFile = S.agentRunFile(intentRun.sessionId, intentRun.id);
      S.__eval(`globalThis.__worktreeOriginalWrite = atomicWriteJson; atomicWriteJson = async (file,value,...rest) => {
        if(file === ${JSON.stringify(intentFile)}) throw Object.assign(new Error('synthetic intent persistence failure'),{code:'EIO'});
        return globalThis.__worktreeOriginalWrite(file,value,...rest);
      };`);
      let intentError;
      try { await S.applyAgentWorktree(intentRun, 'node-a'); } catch (error) { intentError = error; }
      finally { S.__eval('atomicWriteJson = globalThis.__worktreeOriginalWrite; delete globalThis.__worktreeOriginalWrite;'); }
      t.ok(intentError?.code === 'EIO' && intentRun.nodes[0].isolation.status === 'ready' && !fs.readFileSync(mutationLog, 'utf8').includes('cherry-pick'),
        'failed intent persistence prevents Git mutation and restores in-memory readiness');
      const completeFrames = [{ event: 'started', value: 123, created: '1' },
        { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 },
        { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }].map(frame => JSON.stringify(frame) + '\n').join('');
      fs.writeFileSync(fake, '#!' + process.execPath + '\n' + capabilityPrelude + `
const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1500)'],{stdio:['ignore','inherit','inherit']});child.unref();
require('fs').writeSync(3,${JSON.stringify(completeFrames)});process.stdout.write('nothing to commit');process.exit(0);
`, { mode: 0o700 });
      const pipeFailure = await S.gitCommit({ cwd: repo, message: 'fixture' });
      t.ok(!pipeFailure.ok && !pipeFailure.hookRejected && pipeFailure.error !== '没有可提交的改动'
        && /Process output pipes did not close after exit/.test(pipeFailure.detail || ''),
        'retained output pipes fail bounded capture without becoming hook rejection or empty commit');
      // Fault-injected helper descendants have an independent bounded lifetime.
      await sleep(1600);
    } finally { S.ProcessRuntimeHooks.helperPath = realHelper; await S.cleanupAgentWorktree(isolation); }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const handle of handles) await runtime.stop(handle, 'fixture-cleanup');
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
