'use strict';

const path = require('path');
const {
  normalizeAgentResource,
  normalizeAgentResources,
  remapAgentResources,
  agentResourcesConflict,
  inferToolResources,
  acquireResourceLease,
  releaseResourceLease,
  resourceBlockers,
} = require('../ruyi-workbench/app/server.js');

let failures = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.error('FAIL ' + label); }
}

(async () => {
  const cwd = path.resolve(__dirname, 'resource-fixture');
  const file = normalizeAgentResource('file:' + path.join(cwd, 'src', 'a.js'), cwd);
  const sameOffice = normalizeAgentResource('office:' + path.join(cwd, 'src', 'a.js'), cwd);
  const workspace = normalizeAgentResource('workspace:' + cwd, cwd);
  const other = normalizeAgentResource('file:' + path.join(cwd, 'other', 'b.js'), cwd);
  const readA = normalizeAgentResource('read:file:' + path.join(cwd, 'src', 'a.js'), cwd);
  const readB = normalizeAgentResource('read:office:' + path.join(cwd, 'src', 'a.js'), cwd);

  ok(agentResourcesConflict(file, sameOffice), 'file and Office aliases for the same path conflict');
  ok(agentResourcesConflict(workspace, file), 'workspace lease conflicts with descendant file');
  ok(agentResourcesConflict(workspace, other), 'workspace lease covers every descendant path');
  ok(!agentResourcesConflict(readA, readB), 'two shared readers may overlap');
  ok(agentResourcesConflict(file, readA), 'writer conflicts with shared reader');
  const remapped = remapAgentResources(['workspace:' + cwd, 'file:' + path.join(cwd, 'src', 'a.js'), 'desktop'], cwd, path.join(cwd, 'isolated'));
  ok(remapped[0].includes(path.join(cwd, 'isolated')) && remapped[1].includes(path.join(cwd, 'isolated', 'src', 'a.js')) && remapped[2] === 'desktop', 'worktree isolation remaps filesystem resources but preserves global resources');
  ok(!agentResourcesConflict(
    normalizeAgentResource('browser:profile-a', cwd),
    normalizeAgentResource('browser:profile-b', cwd)
  ), 'different browser profiles may overlap');
  ok(agentResourcesConflict(
    normalizeAgentResource('browser:profile-a', cwd),
    normalizeAgentResource('browser:PROFILE-A', cwd)
  ), 'same browser profile is exclusive and case-normalized');

  const desktop = inferToolResources('acc__hotkey', { keys: 'ctrl+l' }, { toolName: 'hotkey' }, cwd, 'exec');
  ok(desktop.some(r => r.type === 'desktop'), 'desktop hotkey is automatically recognized');
  const moved = inferToolResources('file_move', { source: path.join(cwd, 'a'), destination: path.join(cwd, 'b') }, null, cwd, 'edit');
  ok(moved.filter(r => r.type === 'file' && r.mode === 'write').length === 2, 'file move locks source and destination');
  const shell = inferToolResources('shell_start', { cwd }, null, cwd, 'exec');
  ok(shell.some(r => r.type === 'workspace' && r.mode === 'write'), 'shell execution locks its workspace');

  const exclusive = normalizeAgentResources(['desktop'], cwd);
  const first = await acquireResourceLease('agent-a', exclusive);
  let secondAcquired = false;
  const secondPromise = acquireResourceLease('agent-b', exclusive).then(token => { secondAcquired = true; return token; });
  await new Promise(resolve => setTimeout(resolve, 40));
  ok(!secondAcquired && resourceBlockers('agent-b', exclusive).length === 1, 'conflicting agent waits while lease is held');
  releaseResourceLease(first);
  const second = await secondPromise;
  ok(secondAcquired, 'waiting agent resumes immediately after release');
  releaseResourceLease(second);

  const shared = normalizeAgentResources(['read:file:' + path.join(cwd, 'shared.txt')], cwd);
  const sr1 = await acquireResourceLease('reader-a', shared);
  const sr2 = await acquireResourceLease('reader-b', shared);
  ok(!!sr1 && !!sr2, 'shared readers acquire concurrently');
  releaseResourceLease(sr1); releaseResourceLease(sr2);

  const sharedPath = path.join(cwd, 'fair.txt');
  const fairRead = normalizeAgentResources(['read:file:' + sharedPath], cwd);
  const fairWrite = normalizeAgentResources(['file:' + sharedPath], cwd);
  const heldReader = await acquireResourceLease('fair-reader-1', fairRead);
  let writerToken = '', lateReaderToken = '';
  const queuedWriter = acquireResourceLease('fair-writer', fairWrite).then(token => { writerToken = token; return token; });
  const lateReader = acquireResourceLease('fair-reader-2', fairRead).then(token => { lateReaderToken = token; return token; });
  await new Promise(resolve => setTimeout(resolve, 30));
  ok(!writerToken && !lateReaderToken, 'late reader queues behind an already-waiting writer');
  releaseResourceLease(heldReader); await queuedWriter;
  await new Promise(resolve => setTimeout(resolve, 20));
  ok(!!writerToken && !lateReaderToken, 'writer receives the lease before the late reader');
  releaseResourceLease(writerToken); await lateReader; releaseResourceLease(lateReaderToken);

  const ownDeclared = await acquireResourceLease('same-agent', normalizeAgentResources(['workspace:' + cwd], cwd));
  const ownTool = await acquireResourceLease('same-agent', normalizeAgentResources(['file:' + path.join(cwd, 'nested.txt')], cwd));
  ok(!!ownTool, 'tool-level lock does not deadlock against its node declaration');
  releaseResourceLease(ownTool); releaseResourceLease(ownDeclared);

  if (failures) { console.error(`RESOURCE AWARENESS E2E: ${failures} FAIL`); process.exitCode = 1; }
  else console.log('RESOURCE AWARENESS E2E: ALL PASS');
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
