'use strict';
require('./lib/self-isolate-home');
// Real native input -> actual MCP cooperative cancellation -> persistent audit, before/after dispatch.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS AUDIT CANCELLATION');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-audit-cancel-'));
process.env.RUYI_HOME = path.join(root, 'data');
const data = path.join(root, 'acc-data');
const barrier = path.join(data, 'cancel-barrier');
fs.mkdirSync(barrier, { recursive: true });
let fixture, client, runtime;
const reports = [], results = [];
const pendingCalls = [];
async function until(read, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Owned cancellation condition timed out');
}
async function command(text) {
  const offset = reports.length;
  fixture.stdin.write(text + '\n');
  return until(() => reports.slice(offset).find(report => report.event === text));
}
async function call(name, args = {}) {
  const result = await client.callTool(name, args);
  results.push({ name, result });
  return result;
}
async function auditCancellation(phase, target, button, normalize, options = {}) {
  const tool = options.macro ? 'macro_run' : 'act_and_verify';
  const sent = phase === 'after';
  const expectedCount = options.macro ? 2 : 1;
  const expectedOutcome = options.macro ? 'unknown' : sent ? 'unconfirmed' : 'not_dispatched';
  const auditOffset = (await call('audit_tail', { n: 100 })).records.length;
  fs.writeFileSync(path.join(barrier, 'phase'), phase);
  for (const name of ['entered', 'release', 'finished']) fs.rmSync(path.join(barrier, name), { force: true });
  const requestId = client._nextId;
  const args = options.macro ? { delay_ms: 0, steps: [
    { tool: 'mouse_click', args: { target, x: button.x, y: button.y } },
    { tool: 'act_and_verify', args: { target, action: { type: 'click', x: button.x, y: button.y }, settle_ms: 0 } }
  ] } : { target, action: { type: 'click', x: button.x, y: button.y }, settle_ms: 0 };
  pendingCalls.push(client.callTool(tool, args, 60000));
  await until(() => fs.existsSync(path.join(barrier, 'entered')));
  const received = await command('state');
  t.ok(received.counts[0] === expectedCount, phase + ' barrier is reached with the exact expected native receiver count');
  // Exercise the standard MCP notification while keeping this server alive to inspect its log.
  client._notify('notifications/cancelled', { requestId, reason: 'owned audit acceptance' });
  const record = await until(async () => {
    const audit = await call('audit_tail', { n: 100 });
    return audit.records?.slice(auditOffset).find(row => row.tool === tool && row.cancelled);
  });
  const dispatchState = options.macro ? !Object.hasOwn(record, 'action_sent') : record.action_sent === sent && record.confirmed === null;
  t.ok(record.ok === false && record.cancelled && dispatchState && record.outcome === expectedOutcome,
    phase + ' cooperative cancellation persists exact dispatch state without a success claim');
  t.ok(typeof record.ms === 'number' && record.error && typeof record.args === 'object',
    phase + ' cancellation retains duration, error and bounded audit arguments');
  const normalized = normalize({ records: [record] });
  t.ok(normalized.length === 1 && normalized[0].source === 'desktop' && normalized[0].detail.cancelled
    && normalized[0].detail.action_sent === record.action_sent && normalized[0].detail.outcome === record.outcome,
    phase + ' workbench audit timeline preserves the actual ACC cancellation metadata');
  const busy = await call('act_and_verify', { target, action: { type: 'key', key: 'escape' } });
  t.ok(!busy.ok && busy.code === 'verification_busy' && (await command('state')).counts[0] === expectedCount,
    phase + ' retained observer gate refuses a second input while cancellation cleanup is pending');
  fs.writeFileSync(path.join(barrier, 'release'), 'owned release');
  await until(() => fs.existsSync(path.join(barrier, 'finished')));
  await new Promise(resolve => setTimeout(resolve, 25));
  const records = (await call('audit_tail', { n: 100 })).records;
  t.ok(records.slice(auditOffset).filter(row => row.tool === tool && row.cancelled).length === 1,
    phase + ' cancelled invocation is audited exactly once after its observer completes');
  if (options.macro) {
    const inner = records.slice(auditOffset).find(row => row.tool === 'act_and_verify' && row.cancelled);
    t.ok(inner && inner.action_sent === false && inner.outcome === 'not_dispatched' && record.outcome === 'unknown',
      'macro cancellation preserves inner pre-dispatch state without erasing its earlier completed click');
  }
  results.push({ phase, requestId, received, cancellation: record });
  // MCP cancellation need not return a response. Cleanup settles the bounded pending request.
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP native Mac cancellation audit'); return; }
    const helper = process.env.RUYI_P5_AUDIT_HELPER || path.resolve(__dirname, '../ruyi-workbench/runtime/macos/ruyi-automation-helper');
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const status = JSON.parse(probe.stdout);
    if (!status.ready || !status.inputReady) {
      if (process.env.RUYI_P5_AUDIT_REQUIRED === '1') t.fail('cancellation audit requires authorized unlocked capture/input desktop');
      else console.log('SKIP authorize the desktop for native cancellation audit');
      return;
    }
    const binary = path.join(root, 'receiver');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-ocr-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    fixture = cp.spawn(binary, [], { env: fixtureChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    fixture.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        reports.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    fixture.stderr.resume();
    const ready = await until(() => reports.find(report => report.event === 'ready'));
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime', 'desktopAuditEntriesFromResult']);
    runtime = S.ProcessRuntime;
    client = new S.McpStdioClient({ id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', path.join(__dirname, 'fixtures/macos-audit-cancel-server.py')], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: data,
        ACC_TOOLSETS: 'desktop,observe,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } });
    await client.start();
    const target = (await call('list_windows')).windows.find(row => row.pid === fixture.pid && row.handle === ready.id)?.target;
    if (!target) throw new Error('Owned cancellation receiver missing');
    await call('focus_window', { target });
    const b = ready.buttons[0].bounds;
    const button = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    await auditCancellation('after', target, button, S.desktopAuditEntriesFromResult);
    // The next helper observes that the cancelled observer has actually released its gate.
    const noChange = await until(async () => {
      const result = await call('act_and_verify', { target, action: { type: 'key', key: 'escape' }, settle_ms: 0 });
      if (!result.ok && result.code === 'verification_busy') return false;
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result;
    });
    t.ok(noChange.ok && !noChange.effect_observed, 'a completed cancellation observer releases the gate for a subsequent real action');
    await auditCancellation('before', target, button, S.desktopAuditEntriesFromResult);
    t.ok((await command('state')).counts[0] === 1, 'cancellation before capture never posts a late click after the observation barrier is released');
    await auditCancellation('macro-before', target, button, S.desktopAuditEntriesFromResult, { macro: true });
    t.ok((await command('state')).counts[0] === 2, 'cancelled macro keeps exactly its completed prefix and posts no late second click');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    fs.writeFileSync(path.join(barrier, 'release'), 'finally release');
    if (client?.child) {
      const child = client.child;
      client.kill();
      await Promise.all(pendingCalls);
      const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned cancellation MCP and native helper cleanup is confirmed');
    }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.stdin.write('quit\n');
      try { await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 5000); }
      catch { killOwnTree(fixture); }
    }
    if (process.env.RUYI_P5_AUDIT_EVIDENCE) {
      const evidence = path.resolve(process.env.RUYI_P5_AUDIT_EVIDENCE);
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, reports }, null, 2) + '\n');
    }
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
