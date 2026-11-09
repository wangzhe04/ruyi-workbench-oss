'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { fixtureChildEnv } = require('./lib/fixture-home');
const t = createRunner('MACOS PROCESS RUNTIME');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-supervise-'));
process.env.RUYI_HOME = path.join(root, 'data');
const helper = path.resolve(__dirname, '../ruyi-workbench/runtime/macos/ruyi-process-helper');
const capabilityReport = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
const capabilityPrelude = `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(capabilityReport))});process.exit(0);}`;
const handles = [];
const children = [];
let runtime;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  do { const result = await check(); if (result) return result; await sleep(20); } while (Date.now() < deadline);
  throw new Error('condition timed out');
}
function heartbeat(file) {
  return `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(file)},'x'),10);setTimeout(()=>process.exit(0),8000);`;
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP native supervisor requires macOS'); return; }
    if (!fs.existsSync(helper)) throw new Error('Build the macOS helper before running this test');
    const S = loadServerInternals(['ProcessRuntime', 'ProcessRuntimeHooks', 'DesktopShell', 'McpStdioClient', 'killKimiAcpTerminal', 'stopToolboxService', 'toolboxServices', 'cleanupKimiAcpTerminals', 'handleKimiAcpTerminalRequest']);
    runtime = S.ProcessRuntime;
    const capability = runtime.helperCapability();
    t.ok(capability.ready && capability.installed && capability.protocolVersion === 2 && Object.isFrozen(capability),
      'native helper capability requires executable versioned libproc probe');
    const originalHelperPath = S.ProcessRuntimeHooks.helperPath;
    const probeHelper = path.join(root, 'capability-fixture');
    const marker = path.join(root, 'unapproved-target');
    try {
      S.ProcessRuntimeHooks.helperPath = () => probeHelper;
      let blocked = false;
      try { runtime.start({ executable: process.execPath, argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }); }
      catch (error) { blocked = error.code === 'process_helper_missing'; }
      t.ok(blocked && !fs.existsSync(marker), 'missing helper blocks every managed execution without unsupervised fallback');
      const gateFailure = await S.DesktopShell.runProcess(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], { shape: true });
      t.ok(!gateFailure.ok && gateFailure.code === -1 && gateFailure.errorCode === 'process_helper_missing'
        && !gateFailure.capability.ready && !fs.existsSync(marker), 'normal execution entry point returns structured helper failure without running target');
      for (const report of [{ ...capabilityReport, protocolVersion: 1 }, { ...capabilityReport, privateFd: false }, null]) {
        fs.writeFileSync(probeHelper, '#!' + process.execPath + '\nconsole.log(' + JSON.stringify(JSON.stringify(report)) + ');', { mode: 0o700 });
        const unavailable = runtime.helperCapability();
        blocked = false;
        try { runtime.start({ executable: process.execPath, argv: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }); }
        catch (error) { blocked = error.code === 'process_helper_incompatible'; }
        t.ok(!unavailable.ready && blocked && !fs.existsSync(marker), 'incompatible version/capability report blocks target before execution');
      }
      fs.copyFileSync(helper, probeHelper); fs.chmodSync(probeHelper, 0o700);
      t.ok(runtime.helperCapability().ready, 'replacing unavailable helper restores readiness');
      fs.chmodSync(probeHelper, 0o600);
      t.ok(!runtime.helperCapability().ready, 'execute permission removal invalidates cached readiness');
      fs.chmodSync(probeHelper, 0o700);
      t.ok(runtime.helperCapability().ready, 'restoring execute permission reprobes successfully');
      fs.unlinkSync(probeHelper);
      t.ok(!runtime.helperCapability().ready, 'helper removal invalidates cached readiness immediately');
      fs.writeFileSync(probeHelper, '#!/bin/sh\nwhile :; do :; done\n', { mode: 0o700 });
      const started = Date.now();
      t.ok(!runtime.helperCapability().ready && Date.now() - started < 3000, 'hung capability probe is bounded and remains unavailable');
    } finally { S.ProcessRuntimeHooks.helperPath = originalHelperPath; }

    const shellCommand = await S.DesktopShell.runProcess('printf', ['shell-gated'], { shell: true });
    t.ok(shellCommand.code === 0 && shellCommand.stdout === 'shell-gated' && shellCommand.cleanupScope === 'owned-group-and-observed',
      'existing shell option executes through explicit supervised shell');
    const innocent = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { env: fixtureChildEnv(), stdio: 'ignore' });
    children.push(innocent);
    for (const fault of ['primary', 'guardian', 'primary-before-write']) {
      const faultBeat = path.join(root, fault + '-loss-beat');
      const command = fault === 'primary-before-write'
        ? `const fs=require('fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(faultBeat)},'bad'),400);setTimeout(()=>process.exit(0),2000)`
        : heartbeat(faultBeat);
      const faultHandle = runtime.start({ executable: process.execPath, argv: ['-e', command], env: fixtureChildEnv(), owner: { kind: 'helper-loss' } });
      handles.push(faultHandle);
      const guardian = runtime.child(faultHandle);
      t.ok((await runtime.ready(guardian)).ok, fault + ' fixture starts under versioned guardian');
      if (fault !== 'primary-before-write') await until(() => fs.existsSync(faultBeat));
      if (fault === 'guardian') guardian.kill('SIGKILL'); // Intentional fault on the live owned ChildProcess.
      else {
        const table = snapshotProcessTable();
        const guardianRow = table.find(row => row.pid === guardian.pid);
        const primary = table.find(row => row.ppid === guardian.pid && guardianRow && row.created >= guardianRow.created);
        if (!primary || !snapshotProcessTable().some(row => row.pid === primary.pid && row.created === primary.created)) throw new Error('owned primary identity unavailable');
        process.kill(primary.pid, 'SIGKILL'); // Fault injection after verifying owned ancestry and creation identity.
      }
      let outcome;
      runtime.completion(faultHandle).then(value => { outcome = value; });
      await until(() => outcome);
      const stoppedSize = fs.existsSync(faultBeat) ? fs.statSync(faultBeat).size : 0;
      await sleep(fault === 'primary-before-write' ? 450 : 150);
      const finalSize = fs.existsSync(faultBeat) ? fs.statSync(faultBeat).size : 0;
      t.ok(outcome.incomplete && stoppedSize === finalSize && (fault !== 'primary-before-write' || finalSize === 0),
        fault + ' loss actually stops target side effects and reports incomplete lifecycle');
      t.ok(snapshotProcessTable().some(row => row.pid === innocent.pid), fault + ' recovery leaves unrelated sibling alive');
    }

    const naturalBeat = path.join(root, 'natural-beat');
    const naturalScript = `const cp=require('child_process');cp.spawn(process.execPath,['-e',${JSON.stringify(heartbeat(naturalBeat))}],{stdio:'inherit'});setTimeout(()=>process.exit(23),150);`;
    const natural = await S.DesktopShell.runProcess(process.execPath, ['-e', naturalScript], { timeoutMs: 4000 });
    t.ok(natural.code === 23 && !natural.timedOut, 'normal entry point preserves target exit code after root exits before its child');
    const size = fs.statSync(naturalBeat).size;
    await sleep(100);
    t.ok(size > 0 && fs.statSync(naturalBeat).size === size, 'orphaned same-group descendant stops after natural root exit');
    t.ok(natural.cleanupScope === 'owned-group-and-observed' && !natural.cleanupIncomplete, 'natural completion reports verified scope');

    const cancelBeat = path.join(root, 'cancel-beat');
    const handle = runtime.start({ executable: process.execPath, argv: ['-e', heartbeat(cancelBeat)], env: fixtureChildEnv(), owner: { sessionId: 'fixture', toolCallId: 'cancel' } });
    handles.push(handle);
    await until(() => runtime.identity(handle) && fs.existsSync(cancelBeat));
    t.ok(Object.isFrozen(handle) && !('pid' in handle) && Object.isFrozen(runtime.identity(handle)), 'opaque handle retains immutable startup identity privately');
    t.ok(runtime.owner(handle).sessionId === 'fixture' && Object.isFrozen(runtime.owner(handle)), 'owner association is immutable');
    let refused = false;
    try { runtime.stop({ pid: runtime.identity(handle).pid }); } catch { refused = true; }
    t.ok(refused, 'fabricated PID object cannot authorize cancellation');
    const stopped = await runtime.stop(handle, 'user-cancel');
    const repeated = await runtime.stop(handle, 'repeat');
    t.ok(stopped.signal === 'SIGKILL' && !stopped.incomplete && repeated.signal === stopped.signal, 'cancellation is idempotent and preserves target signal');
    const cancelSize = fs.statSync(cancelBeat).size;
    await sleep(100);
    t.ok(fs.statSync(cancelBeat).size === cancelSize, 'cancelled execution stops writing');
    t.ok(snapshotProcessTable().some(row => row.pid === innocent.pid), 'unrelated sibling survives supervisor cleanup');

    const abortBeat = path.join(root, 'abort-beat');
    const controller = new AbortController();
    const execution = S.DesktopShell.runProcess(process.execPath, ['-e', heartbeat(abortBeat)], { signal: controller.signal });
    await until(() => fs.existsSync(abortBeat));
    controller.abort();
    const aborted = await execution;
    t.ok(aborted.interrupted && !aborted.cleanupIncomplete && aborted.cleanupEscapeCoverage === 'observed-only'
      && !aborted.stderr.includes('process tree killed'), 'normal cancellation exposes supervised scope without claiming complete escape coverage');

    const forged = await S.DesktopShell.runProcess(process.execPath, ['-e', `console.log('noise\\n{"event":"cleanup","value":0,"detail":1}');process.exit(7)`]);
    t.ok(forged.code === 7 && forged.stdout.includes('"event":"cleanup"'), 'ordinary stdout cannot spoof private control protocol');
    const failedStart = runtime.start({ executable: path.join(root, 'missing-ready'), env: fixtureChildEnv() });
    handles.push(failedStart);
    const readiness = await runtime.ready(runtime.child(failedStart));
    t.ok(!readiness.ok && readiness.error.code === 'ENOENT', 'execution readiness rejects missing target after supervisor spawn');
    const missing = await S.DesktopShell.runProcess(path.join(root, 'does-not-exist'), []);
    t.ok(missing.commandNotFound === true && missing.ok === false, 'exec failure retains command-not-found behavior');

    for (const stdio of [['ignore'], ['ignore', 'pipe', 'pipe', 'pipe']]) {
      let rejected = false;
      try { runtime.start({ executable: process.execPath, spawnOptions: { stdio } }); } catch (error) { rejected = error instanceof TypeError; }
      t.ok(rejected, 'unsupported stdio layout is rejected before spawning a supervisor');
    }
    const realHelperPath = S.ProcessRuntimeHooks.helperPath;
    try {
      for (const frame of ['null', '{"event":"unexpected"}',
        JSON.stringify({ event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }) + '\n'
          + JSON.stringify({ event: 'started', value: 123, created: '1' })]) {
        const fakeHelper = path.join(root, 'protocol-fixture');
        fs.writeFileSync(fakeHelper, '#!' + process.execPath + '\n' + capabilityPrelude +
          `require('fs').writeSync(3,${JSON.stringify(frame + '\n')});setTimeout(()=>process.exit(0),100);\n`, { mode: 0o700 });
        S.ProcessRuntimeHooks.helperPath = () => fakeHelper;
        const malformed = runtime.start({ executable: process.execPath, env: fixtureChildEnv(), owner: { kind: 'malformed-protocol' } });
        handles.push(malformed);
        const result = await runtime.completion(malformed);
        t.ok(result.incomplete && result.status === 'incomplete', 'malformed private control frame is contained as incomplete cleanup');
      }
    } finally { S.ProcessRuntimeHooks.helperPath = realHelperPath; }

    try {
      const fakeHelper = path.join(root, 'late-control-fixture');
      const frames = [{ event: 'started', value: 123, created: '1' },
        { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 },
        { event: 'exit', value: 0, detail: 0 },
        { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      fs.writeFileSync(fakeHelper, '#!' + process.execPath + '\n' + capabilityPrelude
        + `require('fs').writeSync(3,${JSON.stringify(frames.map(frame => JSON.stringify(frame) + '\n').join(''))});`, { mode: 0o700 });
      S.ProcessRuntimeHooks.helperPath = () => fakeHelper;
      const delayed = runtime.start({ executable: process.execPath, env: fixtureChildEnv() });
      handles.push(delayed);
      const child = runtime.child(delayed);
      child.stdio[3].pause();
      await new Promise(resolve => child.once('exit', resolve));
      child.stdio[3].resume();
      const result = await runtime.completion(delayed);
      t.ok(!result.incomplete && result.code === 0, 'exit before buffered control delivery preserves successful guardian confirmation');
    } finally { S.ProcessRuntimeHooks.helperPath = realHelperPath; }

    const normalHelperPath = S.ProcessRuntimeHooks.helperPath;
    try {
      const fakeHelper = path.join(root, 'incomplete-fixture');
      const frames = [{ event: 'started', value: 123, created: '1' },
        { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 },
        { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }].map(frame => JSON.stringify(frame) + '\n').join('');
      fs.writeFileSync(fakeHelper, '#!' + process.execPath + '\n' + capabilityPrelude + `require('fs').writeSync(3,${JSON.stringify(frames)});\n`, { mode: 0o700 });
      S.ProcessRuntimeHooks.helperPath = () => fakeHelper;
      const incompleteDesktop = await S.DesktopShell.runProcess(process.execPath, [], { shape: true });
      t.ok(!incompleteDesktop.ok && incompleteDesktop.cleanupIncomplete && !incompleteDesktop.stderr.includes('process tree killed')
        && /尚未确认/.test(incompleteDesktop.error), 'incomplete cleanup is not reported as full tree termination');
      const incompleteHandle = runtime.start({ executable: process.execPath, env: fixtureChildEnv(), owner: { kind: 'incomplete-test' } });
      handles.push(incompleteHandle);
      await runtime.completion(incompleteHandle);
      const incompleteChild = runtime.child(incompleteHandle);
      for (const initiallyExited of [true, false]) {
        const terminal = { child: incompleteChild, exited: initiallyExited };
        terminal.waitPromise = Promise.resolve().then(() => { terminal.exited = true; });
        let rejected = false;
        try { await S.killKimiAcpTerminal(terminal); } catch (error) { rejected = /not been confirmed/.test(error.message); }
        t.ok(rejected, 'Kimi terminal close cannot report successful incomplete cleanup, exited=' + initiallyExited);
      }
      const retainedTerminal = { id: 'retry', sessionId: 'fixture', child: incompleteChild, exited: true, released: false };
      const releaseContext = { reg: { nativeSessionId: 'fixture', kimiAcpTerminals: new Map([['retry', retainedTerminal]]) } };
      let refusedReleases = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await S.handleKimiAcpTerminalRequest('terminal/release', { sessionId: 'fixture', terminalId: 'retry' }, releaseContext); }
        catch (error) { if (/not been confirmed/.test(error.message)) refusedReleases++; }
      }
      t.ok(refusedReleases === 2 && releaseContext.reg.kimiAcpTerminals.has('retry') && !retainedTerminal.released,
        'failed terminal release retains ownership for retry');
      const cleanupEvents = [];
      const cleanupReg = { kimiAcpTerminals: new Map([['incomplete', { child: incompleteChild, exited: true }]]), onEvent: event => cleanupEvents.push(event) };
      const collected = await S.cleanupKimiAcpTerminals(cleanupReg);
      t.ok(collected.unconfirmed === 1 && cleanupReg.kimiAcpCleanupIncomplete === 1 && cleanupEvents.length === 1,
        'background Kimi terminal cleanup records failure without rejecting owner teardown');
      const entry = { owned: true, child: incompleteChild, state: 'running', error: '' };
      S.toolboxServices.set('incomplete-test', entry);
      try {
        S.stopToolboxService('incomplete-test');
        await until(() => entry.state === 'failed');
        t.ok(entry.cleanup.incomplete && entry.error === 'cleanup-unconfirmed', 'toolbox preserves failed cleanup instead of reporting stopped');
      } finally { S.toolboxServices.delete('incomplete-test'); }
    } finally { S.ProcessRuntimeHooks.helperPath = normalHelperPath; }

    for (const mode of ['exit', 'sigkill']) {
      const ownerBeat = path.join(root, 'owner-beat-' + mode);
      const leave = mode === 'exit' ? 'process.exit(0)' : "process.kill(process.pid,'SIGKILL')";
      const ownerScript = `const cp=require('child_process'),fs=require('fs');const p=cp.spawn(${JSON.stringify(helper)},['--supervise-v2',process.execPath,'-e',${JSON.stringify(heartbeat(ownerBeat))}],{stdio:['ignore','ignore','ignore','pipe']});p.stdio[3].on('data',()=>{});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ownerBeat)})){clearInterval(timer);${leave}}},10);setTimeout(()=>process.exit(1),3000);`;
      const owner = cp.spawn(process.execPath, ['-e', ownerScript], { env: fixtureChildEnv(), stdio: 'ignore' });
      children.push(owner);
      await until(() => owner.exitCode !== null || owner.signalCode !== null);
      await sleep(150);
      const ownerSize = fs.statSync(ownerBeat).size;
      await sleep(150);
      t.ok((owner.exitCode === 0 || owner.signalCode === 'SIGKILL') && ownerSize > 0 && fs.statSync(ownerBeat).size === ownerSize,
        mode + ' owner death closes private control channel and stops execution');
    }
    for (const mode of ['natural', 'timeout']) {
      const mcpBeat = path.join(root, 'mcp-' + mode);
      const mcpFile = path.join(root, 'mcp-' + mode + '.js');
      fs.writeFileSync(mcpFile, `
const cp=require('child_process');
cp.spawn(process.execPath,['-e',${JSON.stringify(heartbeat(mcpBeat))}],{stdio:'ignore',detached:true});
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;
 const result=m.method==='initialize'?{capabilities:{},serverInfo:{name:'fixture'}}:m.method==='tools/list'?{tools:[{name:'wait'}]}:null;
 if(result)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});rl.on('close',()=>process.exit(17));setTimeout(()=>process.exit(0),8000);
`);
      const client = new S.McpStdioClient({ id: 'supervised-' + mode, command: process.execPath, args: [mcpFile], env: fixtureChildEnv() });
      try {
        await client.start();
        const mcpHandle = runtime.handle(client.child); handles.push(mcpHandle);
        t.ok(runtime.owner(mcpHandle).serverId === 'supervised-' + mode, 'real MCP startup registers connector ownership');
        await until(() => fs.existsSync(mcpBeat));
        if (mode === 'natural') {
          client.child.stdin.end();
          // EOF-sensitive MCP roots may exit before their detached descendants.
          // The fixture ends on stdin EOF using the same normal process exit path.
          const result = await client.callTool('wait', {}, 1000);
          t.ok(!result.ok, 'MCP pending call reports root exit or timeout');
        } else {
          const result = await client.callTool('wait', {}, 1000);
          t.ok(result.cleanupScope === 'owned-group-and-observed' && result.cleanupEscapeCoverage === 'observed-only'
            && result.cleanupIncomplete === false && result.cleanupUnconfirmed === 0, 'MCP timeout waits for verified supervised cleanup');
        }
        await runtime.completion(mcpHandle);
        const mcpSize = fs.statSync(mcpBeat).size; await sleep(100);
        t.ok(fs.statSync(mcpBeat).size === mcpSize, 'MCP descendants stop after completion');
      } finally { client.kill(); }
    }

    for (const launchMode of ['--supervise', '--supervise-v2']) {
      const anchoredBeat = path.join(root, 'anchored-beat-' + launchMode);
      const anchorInfo = path.join(root, 'anchor-info-' + launchMode);
      const anchorGate = path.join(root, 'anchor-go-' + launchMode);
      const anchoredTarget = `const fs=require('fs');const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(heartbeat(anchoredBeat))}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(anchorInfo)},JSON.stringify({root:process.pid,leaf:c.pid}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(anchorGate)}))process.exit(0)},10);setTimeout(()=>process.exit(0),8000);`;
      const anchorOwnerScript = `const cp=require('child_process');const p=cp.spawn(${JSON.stringify(helper)},[${JSON.stringify(launchMode)},process.execPath,'-e',${JSON.stringify(anchoredTarget)}],{stdio:['ignore','ignore','ignore','pipe']});p.stdio[3].on('data',d=>{for(const l of String(d).trim().split('\\n')){try{if(JSON.parse(l).event==='started')process.stdout.write(String(p.pid)+'\\n')}catch{}}});setTimeout(()=>process.exit(0),8000);`;
      const anchorOwner = cp.spawn(process.execPath, ['-e', anchorOwnerScript], { env: fixtureChildEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(anchorOwner);
      let anchorOutput = ''; anchorOwner.stdout.on('data', d => { anchorOutput += d; });
      const anchorPid = await until(() => Number(anchorOutput.trim()) || 0);
      await until(() => fs.existsSync(anchorInfo) && fs.existsSync(anchoredBeat));
      if (launchMode === '--supervise-v2') {
        const table = snapshotProcessTable();
        const anchor = table.find(row => row.pid === anchorPid);
        const primary = table.find(row => row.ppid === anchorPid && anchor && row.created >= anchor.created);
        if (!primary) throw new Error('owned primary unavailable before freeze');
        process.kill(primary.pid, 'SIGSTOP'); // Freeze both layers so the orphan remains for external recovery.
      }
      process.kill(anchorPid, 'SIGSTOP'); // Deliberate fault injection into this fixture's owned supervisor.
      fs.writeFileSync(anchorGate, 'go');
      const anchorIds = JSON.parse(fs.readFileSync(anchorInfo, 'utf8'));
      await until(() => !snapshotProcessTable().some(row => row.pid === anchorIds.root));
      const beforeRecovery = fs.statSync(anchoredBeat).size; await sleep(80);
      t.ok(fs.statSync(anchoredBeat).size > beforeRecovery, launchMode + ' frozen supervisors leave an active orphan for external cleanup');
      const recovered = killOwnTree(anchorOwner);
      t.ok(recovered.killed.includes(anchorPid) && recovered.killed.includes(anchorIds.leaf), 'external cleaner includes orphaned members of an owned anchored session group');
      const anchoredSize = fs.statSync(anchoredBeat).size; await sleep(100);
      t.ok(fs.statSync(anchoredBeat).size === anchoredSize, 'external cleanup stops orphan writes even with the supervisor frozen');
    }

    const escapeBeat = path.join(root, 'escape-beat');
    const escapeScript = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(heartbeat(escapeBeat))}],{stdio:'ignore',detached:true});setTimeout(()=>process.exit(0),200);`;
    const escape = await S.DesktopShell.runProcess(process.execPath, ['-e', escapeScript]);
    const escapeSize = fs.statSync(escapeBeat).size;
    await sleep(100);
    t.ok(escape.ok && escapeSize > 0 && fs.statSync(escapeBeat).size === escapeSize, 'observed detached descendant stops after root exits');
    t.ok(escape.cleanupEscapeCoverage === 'observed-only' && escape.cleanupUnconfirmed === 0,
      'result exposes escape observation limit and unconfirmed count');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const handle of handles) await runtime.stop(handle, 'fixture-cleanup');
    for (const child of children) killOwnTree(child);
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
