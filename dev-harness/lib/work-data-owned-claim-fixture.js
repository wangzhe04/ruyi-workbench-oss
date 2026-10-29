'use strict';
// Shared constructed crash window. The producer runs actual claim/native/owner
// modules and exits 73 with an owned claim. It never runs maintenance, and this
// helper never calls that constructed window a production cold-worker crash.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), assert = require('node:assert/strict');
const core = require('./work-data-production-upload-core'), upload = require('../work-data-production-upload.e2e');
const { createProcesses, createStrictStop } = require('./work-data-production-upload-process');
const { snapshotProcessTable, ownDescendants } = require('./kill-own-tree');
const {publishJsonOnce,markerFailure}=require('./work-data-fixture-marker');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const SOURCES = ['01g-server-ownership.js', '01v-work-data-manifest.js', '01w-work-data-native-publish.js', '13av-work-data-handoff-claim.js', '13aj-work-data-control.js', '01ae-work-data-maintenance-result.js'];
const PRODUCER = path.join(__dirname, 'work-data-completed-claim-producer.cjs');
function write(file, value) { publishJsonOnce(file,value); }
function safeProducerError(error) {
  let errorName='UnknownError',stack='';
  try{if(['Error','SyntaxError','AssertionError','TypeError','RangeError'].includes(error?.name))errorName=error.name;}catch{}
  try{if(typeof error?.stack==='string')stack=error.stack;}catch{}
  const frames=stack.split(/\r?\n/).filter(line=>/^\s*at /.test(line)).map(line=>/(?:[\\/()]|^)(work-data-owned-claim-fixture\.js|work-data-completed-intent-recovery\.e2e\.js|work-data-production-restore\.e2e\.js|work-data-production-upload-process\.js):(\d+):(\d+)\)?$/.exec(line))
    .filter(Boolean).slice(0,4).map(frame=>({file:frame[1],line:Number(frame[2]),column:Number(frame[3])}));
  return {errorName,frames,marker:markerFailure(error)};
}
async function waitJson(file, milliseconds, onFailure) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    let captured=null;
    try { captured=fs.readFileSync(file);return JSON.parse(captured.toString('utf8')); } catch (error) {
      if (error.code !== 'ENOENT') {
        // Retain metadata from this one failed read. Incomplete/invalid JSON is
        // still the original immediate failure, never a reason to read again.
        try{onFailure?.({file:['job-ready.json','producer-ready.json','job-assigned.json','producer-owned.json','outer-job-result.json'].includes(path.basename(file))?path.basename(file):null,
          capturedBytes:captured===null?null:captured.length,capturedSha256:captured===null?null:core.H(captured),...safeProducerError(error),rawBodiesOmitted:true});}catch{}
        throw error;
      }
    }
    if (Date.now() >= deadline) throw Error('synthetic evidence deadline: ' + path.basename(file));
    await pause(25);
  }
}
function bindTarget(harness, entry) {
  const original = core.loadProductTarget(harness), additions = [entry, __filename, PRODUCER,path.join(__dirname,'work-data-fixture-marker.js')].map(file => core.read(file).row);
  const boundFiles = [...original.boundFiles, ...additions];
  const digest = core.H(Buffer.from(JSON.stringify(boundFiles.map(row => ({ file: core.norm(row.file), bytes: row.bytes, sha256: row.sha256 }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0))));
  return { ...original, boundFiles, executionInputSha256: digest, recheck() {
    original.recheck(); for (const row of additions) core.read(row.file, row);
    return { sameInputs: true, files: boundFiles.length, productSource: true, executionInputSha256: digest };
  } };
}
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
// Independent default-stream census digest, matching the published proof shape;
// this does not replace the product's owner-held domain/decryption verification.
function sourceProof(canonical, inventory) {
  const root = inventory.directories[0], bytes = inventory.files.reduce((sum, row) => sum + row.bytes, 0);
  const value = { root: canonical, rootIdentity: root.dev + ':' + root.ino,
    directories: inventory.directories.slice(1).map(row => ({ path: relative(root.file, row.file), identity: row.dev + ':' + row.ino })),
    files: inventory.files.map(row => ({ path: relative(root.file, row.file), identity: row.dev + ':' + row.ino, size: row.bytes, sha256: row.sha256 })), bytes };
  return { sha256: core.H(Buffer.from(JSON.stringify(value))), bytes, files: value.files.length, directories: value.directories.length };
}
function createProducer({ world, target, harness, root, evidence, label = 'producer' }) {
  assert.match(label, /^[a-z0-9-]+$/);
  let started = false, keeper = null, keeperDirectory = null, producerManager = null;
  let stage='not-started',producer=null,jsonFailure=null,jobId=null,operationName=null;
  function diagnostic(){
    let state=null;try{if(producerManager&&producer){const value=producerManager.inspect(producer);state=Object.fromEntries(['pid','spawnSeen','exitSeen','closeSeen','exitCode','exitSignal','closeCode','closeSignal'].map(key=>[key,value[key]]));}}catch{}
    return{label,stage,id:jobId,operation:operationName,process:state,jsonFailure,rawBodiesOmitted:true};
  }
  function mark(value){stage=value;world.ctx.phase=label+'-'+value;world.ctx.diagnostics={...(world.ctx.diagnostics||{}),producer:diagnostic()};world.record({kind:'producer-stage',...diagnostic()});}
  const wait=(file,budget)=>waitJson(file,budget,value=>{jsonFailure=value;world.ctx.diagnostics={...(world.ctx.diagnostics||{}),producer:diagnostic()};});
  async function run({ f, id, operation, ownedAt, parent, completeIntent }) {
    jobId=typeof id==='string'&&/^[a-f0-9]{48}$/.test(id)?id:null;operationName=['enable','disable','export','restore'].includes(operation)?operation:null;
    assert.equal(started, false); started = true; world.healthy(); target.recheck();
    mark('precondition');
    assert.equal(await world.absentByCim(parent.identity), true, 'the original serve parent is already dead');
    const ownerApi = upload.loadPure(core.read(path.join(target.src, SOURCES[0])).bytes.toString('utf8'), 'ServerOwnership');
    const canonical = await ownerApi.canonicalRoot(f.base);
    keeperDirectory = path.join(root, label + '-keeper'); fs.mkdirSync(keeperDirectory);
    keeper = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(harness, 'lib/work-data-production-maintenance-outer-job.ps1')],
      { cwd: harness, env: { ...process.env, RUYI_PM_ROOT: keeperDirectory }, stdio: 'ignore', windowsHide: true });
    keeper.unref();mark('keeper-ready');await wait(path.join(keeperDirectory, 'job-ready.json'), 30000);
    const commands = path.join(root, label + '-commands'); fs.mkdirSync(commands);
    const request = path.join(commands, 'request.json');
    write(request, { base: f.base, temp: f.temp, id, operation, ownedAt, port: parent.port,
      parentPid: parent.pid, commands, ...(completeIntent?{completeIntent}:{}), sources: SOURCES.map(name => core.read(path.join(target.src, name)).row) });
    const processLabel = label === 'producer' ? 'claim-producer' : label;
    const producerOutput = Object.fromEntries(['stdout', 'stderr'].map(kind => [kind, fs.openSync(path.join(evidence, processLabel + '-' + kind + '.log'), 'wx', 0o600)]));
    producerManager = createProcesses({ record: world.record,
      writeOutput: (_label, kind, bytes) => { fs.writeFileSync(producerOutput[kind], bytes); },
      latch: world.latch, isUnknown: () => world.ctx.unknown,
      beforeStart: () => { world.healthy(); target.recheck(); world.healthy(); }, snapshotProcessTable, ownDescendants,
      killOwnTree: createStrictStop({ snapshotProcessTable, ownDescendants, latch: world.latch, isUnknown: () => world.ctx.unknown }) });
    mark('spawn');
    producer = producerManager.start(process.execPath, [PRODUCER, request], { cwd: root, env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, processLabel);
    mark('spawn-event');
    await producer.spawned;
    mark('ready-json');
    const producerReady = await wait(path.join(commands, 'producer-ready.json'), 30000);
    assert.equal(producerReady.pid, producerManager.pid(producer));
    mark('identity');
    const identity = await world.cimIdentity(producerReady.pid);
    mark('job-assignment');
    write(path.join(keeperDirectory, 'job-target.json'), { schema: 1, pid: identity.pid, cimCreated: identity.created });
    const assigned = await wait(path.join(keeperDirectory, 'job-assigned.json'), 30000);
    assert.equal(assigned.pid, identity.pid); assert.equal(assigned.cimCreated, identity.created);
    mark('owned-json');
    write(path.join(commands, 'producer-go.json'), { schema: 1, go: true });
    const owned = await wait(path.join(commands, 'producer-owned.json'), 180000);
    assert.equal(owned.pid, identity.pid); assert.equal(owned.sourceOwnerHeld, true); assert.equal(owned.realNativeFlush, true);
    mark('owned-verification');
    let contender = null;
    try { contender = await ownerApi.acquire([canonical]); } catch (error) { assert.equal(error.code, 'DATA_ROOT_IN_USE'); }
    if (contender) { await contender.release(); assert.fail('producer must hold the actual OS source owner'); }
    const claimBefore = await world.claimApi(f.temp).inspect({ base: canonical });
    assert.equal(claimBefore.present, true); assert.equal(claimBefore.value.phase, 'owned');
    assert.equal(claimBefore.value.id, id); assert.equal(claimBefore.value.parentPid, parent.pid); assert.equal(claimBefore.value.childPid, identity.pid);
    const claimRaw = core.read(world.claimFile(f));
    assert.equal(claimRaw.row.sha256, claimBefore.receipt.sha256); assert.equal(claimRaw.row.dev, claimBefore.receipt.dev); assert.equal(claimRaw.row.ino, claimBefore.receipt.ino);
    world.checkpoint(label === 'producer' ? 'constructed-owned' : label + '-constructed-owned', { owned, claim: claimBefore, identity, oldServeIdentity: parent.identity, constructedCrashWindow: true });
    mark('crash-close');
    write(path.join(commands, 'producer-crash.json'), { schema: 1, crash: true });
    const ended = await producerManager.waitClose(producer, 30000);
    assert.deepEqual(ended, { code: 73, signal: null });
    await producerManager.certifyNaturalExit(producer, { code: 73, signal: null, verify: async () => assert.equal(await world.absentByCim(identity), true) });
    for (const fd of Object.values(producerOutput)) { fs.fsyncSync(fd); fs.closeSync(fd); }
    mark('keeper-release');
    write(path.join(keeperDirectory, 'job-release.json'), { schema: 1, released: true });
    const outer = await wait(path.join(keeperDirectory, 'outer-job-result.json'), 60000);
    assert.equal(outer.ok, true); assert.equal(outer.closed, true); assert.deepEqual(outer.survived, []); assert.deepEqual(outer.members, []);
    const keeperDeadline = Date.now() + 20000;
    while (keeper.exitCode === null && Date.now() < keeperDeadline) await pause(25);
    assert.equal(keeper.exitCode, 0);
    world.checkpoint(label + '-death', { process: producerManager.inspect(producer), outer, keeperCode: keeper.exitCode });
    mark('complete');
    return { canonical, claimBefore, claimRaw, identity, owned };
  }
  return { run,diagnostic,
    assertClosed() { assert.ok(producerManager); assert.equal(producerManager.hasUnclosed(), false); assert.equal(producerManager.hasUnverifiedSpawn(), false); },
    holdFailure() { if (keeperDirectory) write(path.join(keeperDirectory, 'job-hold.json'), { schema: 1, held: true, reason: 'test-failure' }); }
  };
}
module.exports = { bindTarget, createProducer, sourceProof, safeProducerError };
