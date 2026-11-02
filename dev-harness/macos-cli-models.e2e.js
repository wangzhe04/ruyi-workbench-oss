'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS CLI MODELS');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-models-'));
process.env.RUYI_HOME = path.join(root, 'data');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
const originalSpawn = cp.spawn;
let runtime;
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac model probe supervision requires macOS'); return; }
    const S = loadServerInternals(['discoverKimiModels', 'agentCliAdapter', 'ProcessRuntime', 'ProcessRuntimeHooks'], { withEval: true });
    runtime = S.ProcessRuntime;
    // The explicitly configured fake CLI is the probe target; avoid ambient CLI locator probes.
    S.__eval('detectAgentCliPath = () => ""');
    cp.spawn = function(...args) { const child = originalSpawn.apply(this, args); children.push(child); return child; };
    const cli = path.join(root, '假 CLI 😀');
    const config = { kimiPath: cli, model: 'kept-choice', knownModels: ['must-not-leak'] };
    const models = { models: { 'kimi/中文😀': { displayName: '中文模型😀', maxContextSize: 123456 } } };
    const writeCli = source => fs.writeFileSync(cli, '#!' + process.execPath + '\n' + source, { mode: 0o700 });
    const beat = path.join(root, 'heartbeat');
    const heartbeat = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),15000);`;
    const spawnLeaf = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(heartbeat)}],{stdio:'ignore'});`;
    const afterHeartbeat = source => `${spawnLeaf}const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(beat)})){clearInterval(timer);${source}}},10);`;
    writeCli(afterHeartbeat(`const b=Buffer.from(${JSON.stringify(JSON.stringify(models))});const cut=b.indexOf(Buffer.from('中'))+1;process.stdout.write(b.subarray(0,cut));setTimeout(()=>{process.stdout.write(b.subarray(cut));process.exit(0)},20);`));
    const valid = await runtime.withOwner({ sessionId: 'model-probe-owner' }, () => S.agentCliAdapter('kimi').modelCatalog.discover(config));
    const owner = children.map(child => runtime.handle(child)).filter(Boolean).map(handle => runtime.owner(handle)).find(value => value.kind === 'cli-model-discovery');
    t.ok(valid.ok && valid.agentCliType === 'kimi' && valid.proxyCount === 1 && valid.discoveredCount === 1 && valid.models.some(model => model.id === 'kimi/中文😀' && model.contextLength === 123456),
      'normal model discovery preserves aliases, context lengths and split UTF-8');
    t.ok(!valid.models.some(model => model.id === 'must-not-leak') && valid.models[0].id === '', 'Kimi discovery preserves its own model catalog semantics');
    t.ok(owner && owner.sessionId === 'model-probe-owner' && owner.cliType === 'kimi' && Object.isFrozen(owner), 'model probe is registered with immutable caller ownership');
    const stoppedSize = fs.statSync(beat).size; await sleep(150);
    t.ok(stoppedSize > 0 && fs.statSync(beat).size === stoppedSize && !valid.cleanupIncomplete,
      'natural probe exit stops its writing descendant before reporting success');
    writeCli('process.stdout.write("not-json")');
    const invalid = await S.discoverKimiModels(config);
    t.ok(!invalid.ok && invalid.discoveredCount === 0 && invalid.models.some(model => model.id === 'kept-choice'), 'invalid JSON retains the configured fallback model');
    writeCli('process.stderr.write("fixture failure");process.exit(7)');
    const failed = await S.discoverKimiModels(config);
    t.ok(!failed.ok && failed.error.includes('fixture failure') && !failed.cleanupIncomplete, 'nonzero exit remains a failure with confirmed cleanup');
    for (const stream of ['stdout', 'stderr']) {
      fs.unlinkSync(beat);
      writeCli(afterHeartbeat(`process.${stream}.write(Buffer.alloc(${stream === 'stdout' ? 1024 * 1024 + 1 : 64 * 1024 + 1},120));setTimeout(()=>process.exit(0),15000);`));
      const result = await S.discoverKimiModels(config);
      const size = fs.statSync(beat).size; await sleep(150);
      t.ok(!result.ok && result.code === 'process_output_limit' && !result.cleanupIncomplete && fs.statSync(beat).size === size,
        stream + ' overflow fails closed and stops the descendant');
    }
    fs.unlinkSync(beat);
    writeCli(afterHeartbeat('setTimeout(()=>process.exit(0),15000);'));
    const timedOut = await S.discoverKimiModels(config);
    const timeoutSize = fs.statSync(beat).size; await sleep(150);
    t.ok(!timedOut.ok && timedOut.timedOut && !timedOut.cleanupIncomplete && fs.statSync(beat).size === timeoutSize,
      'real ten-second timeout confirms cleanup and stops further descendant writes');
    writeCli('process.stdout.write(Buffer.alloc(1024*1024+1,120));setTimeout(()=>process.exit(0),15000);');
    S.__eval('globalThis.__modelProbeKill = killChildTree; killChildTree = () => { throw new Error("synthetic stop failure"); };');
    let stopFailure;
    try { stopFailure = await S.discoverKimiModels(config); }
    finally { S.__eval('killChildTree = globalThis.__modelProbeKill; delete globalThis.__modelProbeKill;'); }
    t.ok(!stopFailure.ok && stopFailure.cleanupIncomplete && stopFailure.error.includes('清理尚未确认'),
      'a throwing cleanup implementation still settles the probe as incomplete');
    const stopFailureChild = children.filter(child => runtime.handle(child)).at(-1);
    runtime.stopChild(stopFailureChild); await runtime.waitForCleanup(stopFailureChild, 3000);
    const realHelper = S.ProcessRuntimeHooks.helperPath;
    try {
      const marker = path.join(root, 'blocked-marker'); writeCli(`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
      S.ProcessRuntimeHooks.helperPath = () => path.join(root, 'missing-helper');
      const missing = await S.discoverKimiModels(config);
      t.ok(!missing.ok && missing.code === 'process_helper_missing' && !fs.existsSync(marker), 'missing helper blocks the CLI probe before execution');
      const helper = path.join(root, 'incomplete-helper');
      const report = { protocolVersion: 2, guardian: true, supervise: true, privateFd: true, identityCleanup: true, escapeCoverage: 'observed-only' };
      const frames = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 1, detail: 0, terminated: 0, alreadyExited: 0, observed: 1 },
        { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(report))});process.exit(0)}require('fs').writeSync(3,${JSON.stringify(frames.map(frame => JSON.stringify(frame) + '\n').join(''))});process.stdout.write(${JSON.stringify(JSON.stringify(models))});`, { mode: 0o700 });
      S.ProcessRuntimeHooks.helperPath = () => helper;
      const incomplete = await S.discoverKimiModels(config);
      t.ok(!incomplete.ok && incomplete.cleanupIncomplete && incomplete.discoveredCount === 0 && incomplete.models.some(model => model.id === 'kept-choice'),
        'valid model JSON cannot disguise incomplete process cleanup as successful discovery');
      const completedFrames = [{ event: 'started', value: 123, created: '1' }, { event: 'cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 1, observed: 1 },
        { event: 'exit', value: 0, detail: 0 }, { event: 'guardian-cleanup', value: 0, detail: 1, terminated: 0, alreadyExited: 0, observed: 0 }];
      fs.writeFileSync(helper, '#!' + process.execPath + '\n' + `if(process.argv[2]==='--capabilities'){console.log(${JSON.stringify(JSON.stringify(report))});process.exit(0)}
const leaf=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),12000)'],{stdio:['ignore','inherit','inherit']});leaf.unref();
require('fs').writeSync(3,${JSON.stringify(completedFrames.map(frame => JSON.stringify(frame) + '\n').join(''))});process.stdout.write(${JSON.stringify(JSON.stringify(models))});process.exit(0);`, { mode: 0o700 });
      const retained = await S.discoverKimiModels(config);
      const retainedChild = children.filter(child => runtime.handle(child)).at(-1);
      t.ok(!retained.ok && retained.timedOut && retainedChild.stdout.destroyed && retainedChild.stderr.destroyed,
        'retained output pipes produce bounded failure and release both stream handles');
      await sleep(2200); // The deliberately unobserved fixture leaf has its own bounded lifetime.
    } finally { S.ProcessRuntimeHooks.helperPath = realHelper; }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    cp.spawn = originalSpawn;
    for (const child of children) {
      if (!runtime?.handle(child)) continue;
      runtime.stopChild(child);
      const cleanup = await runtime.waitForCleanup(child, 3000);
      if (!cleanup) t.fail('managed fixture lost its cleanup handle');
    }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();
