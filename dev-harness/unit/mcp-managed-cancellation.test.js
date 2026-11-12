'use strict';
// Real generated ManagedMcp.runTurn/prepare/postflight and MCP client methods.
// Only the byte transport is in memory. No client.start(), subprocess, listener,
// remote request or native helper runs; the existing real kill() sees pid=null.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-managed-cancel-'));
const data = path.join(root, 'data');
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
  configSchema: 14, privacyModeV1: 'off', privacyTechnicalV1: false, privacyRulesV1: [],
  privacyPolicyRecoveryRequiredV1: false, credentialEncryptionV1: false, workDataEncryptionV1: false,
  providers: [], externalMcpServers: [], includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
  autoImportKimiCodeMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false },
  schedulerEnabledV1: false, stewardEnabledV1: false,
}));
const app = require('../lib/server-internals').loadServerInternals([
  'ManagedMcp', 'McpStdioClient', 'McpHttpClient', 'mutateConfig', 'readConfig', 'flushWorkbenchLogs',
  'mcpClients', 'mcpClientFingerprints', 'mcpClientGen', 'mcpEntryFingerprint', 'resolveExternalMcpServers',
]);
const secretResult = 'RESULT_MUST_REMAIN_WITHHELD';
let serial = 0;

async function setup(t, { http = false, onCall, cleanupError } = {}) {
  const id = 'managed-cancel-' + (++serial);
  const configured = http
    ? { id, enabled: true, transport: 'http', url: 'http://127.0.0.1:9/mcp' }
    : { id, enabled: true, command: process.execPath, args: ['synthetic-transport-never-spawned.cjs'] };
  await app.mutateConfig(config => Object.assign(config, {
    privacyModeV1: 'off', privacyTechnicalV1: false, privacyRulesV1: [], privacyPolicyRecoveryRequiredV1: false,
    credentialEncryptionV1: false, workDataEncryptionV1: false, providers: [],
    externalMcpServers: [configured], includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
    autoImportKimiCodeMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false },
    stewardEnabledV1: false, schedulerEnabledV1: false,
  }));
  const config = await app.readConfig();
  assert.equal(config.privacyModeV1, 'off');
  assert.equal(config.credentialEncryptionV1, false);
  assert.equal(config.workDataEncryptionV1, false);
  assert.equal(config.privacyPolicyRecoveryRequiredV1, false);
  const entry = app.resolveExternalMcpServers(config).find(row => row.id === id);
  assert.ok(entry, 'actual normalized committed entry exists');
  const client = http ? new app.McpHttpClient(entry) : new app.McpStdioClient(entry);
  const abort = new AbortController(), writes = [];
  const observed = { killCalls: 0, endCalls: 0 };
  const ordinaryKill = client.kill;
  client.kill = function (...args) {
    observed.killCalls++;
    if (cleanupError) throw cleanupError;
    return Reflect.apply(ordinaryKill, this, args);
  };
  const invalidate = () => app.mcpClientGen.set(id, app.mcpClientGen.get(id) + 1);
  if (!http) {
    client.child = { stdin: { writable: true,
      write(bytes) {
        const message = JSON.parse(String(bytes)); writes.push(message);
        if (message.method === 'tools/call') onCall?.({ client, message, abort, invalidate });
        return true;
      },
      end() { observed.endCalls++; },
    } };
    // The production kill method updates dead/pending/child as usual; no PID
    // exists in this in-memory transport, so it cannot launch an OS killer.
    assert.equal(client.pid, null);
  } else {
    client._request = async function (method, url, message, timeout, headers, options = {}) {
      writes.push(message);
      if (message.method !== 'tools/call') return { status: 202, headers: {}, body: Buffer.alloc(0) };
      options.managedAssert?.();
      options.managedSent?.();
      abort.abort();
      return { error: 'synthetic transport abort', why: 'abort' };
    };
  }
  app.mcpClients.set(id, client);
  app.mcpClientFingerprints.set(id, app.mcpEntryFingerprint(entry));
  app.mcpClientGen.set(id, 0);
  t.after(() => {
    app.mcpClients.delete(id); app.mcpClientFingerprints.delete(id); app.mcpClientGen.delete(id);
  });
  const run = work => app.ManagedMcp.runTurn({ sessionId: 'sess_managed_cancel_' + serial }, work);
  return { client, abort, writes, observed, run };
}

function assertWithheld(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(result.operationMayHaveExecuted, true);
  assert.equal(result.resultUnavailable, true);
  assert.equal(JSON.stringify(result).includes(secretResult), false);
}
function assertOneSentCall(fixture, reason) {
  const requests = fixture.writes.filter(row => row.method === 'tools/call');
  const cancellations = fixture.writes.filter(row => row.method === 'notifications/cancelled');
  assert.equal(requests.length, 1, 'no retry or replay');
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].params.requestId, requests[0].id);
  assert.equal(cancellations[0].params.reason, reason);
  assert.equal(fixture.client._pending.size, 0);
}

test('sent managed stdio abort cleans the original client exactly once while retaining privacy withholding', async t => {
  const f = await setup(t, { onCall: ({ abort }) => queueMicrotask(() => abort.abort()) });
  const result = await f.run(() => f.client.callTool('slow_task', { ms: 30000 }, 10000, { signal: f.abort.signal }));
  assertWithheld(result, 'privacy.mcp_cancelled');
  assertOneSentCall(f, 'user_steer');
  assert.equal(f.observed.killCalls, 1);
  assert.equal(f.observed.endCalls, 1);
  assert.equal(f.client.dead, true);
  assert.equal(f.client.child, null);
});

test('sent managed stdio timeout still cleans exactly once if recipient postflight also changed', async t => {
  const f = await setup(t, { onCall: ({ invalidate }) => invalidate() });
  const result = await f.run(() => f.client.callTool('slow_task', { ms: 30000 }, 1000));
  assertWithheld(result, 'privacy.mcp_recipient_changed');
  assertOneSentCall(f, 'timeout');
  assert.equal(f.observed.killCalls, 1);
  assert.equal(f.observed.endCalls, 1);
  assert.equal(f.client.dead, true);
});

test('cleanup failure remains secondary to the same primary postflight privacy error', async t => {
  const cleanupError = Error('synthetic cleanup failed');
  const f = await setup(t, { cleanupError, onCall: ({ abort }) => queueMicrotask(() => abort.abort()) });
  await f.run(async () => {
    await assert.rejects(f.client._rpc('tools/call', { name: 'slow_task', arguments: { ms: 30000 } }, 10000, { signal: f.abort.signal }), error => {
      assert.equal(error.code, 'privacy.mcp_cancelled');
      assert.equal(error.mcpOperationMayHaveExecuted, true);
      assert.equal(error.mcpCleanupError, cleanupError);
      assert.equal(Object.prototype.propertyIsEnumerable.call(error, 'mcpCleanupError'), false);
      return true;
    });
  });
  assertOneSentCall(f, 'user_steer');
  assert.equal(f.observed.killCalls, 1);
  assert.equal(f.observed.endCalls, 0);
});

test('actual callTool unavailable JSON never exposes a failed cleanup secret', async t => {
  const marker = 'CLEANUP_SECRET_MUST_NOT_ESCAPE';
  const f = await setup(t, { cleanupError: Error(marker), onCall: ({ abort }) => queueMicrotask(() => abort.abort()) });
  const result = await f.run(() => f.client.callTool('slow_task', {}, 10000, { signal: f.abort.signal }));
  assertWithheld(result, 'privacy.mcp_cancelled');
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(Object.hasOwn(result, 'mcpCleanupError'), false);
  assertOneSentCall(f, 'user_steer');
  assert.equal(f.observed.killCalls, 1);
  assert.equal(f.client.dead, false, 'cleanup failure is never reported as successful cleanup');
});

test('pre-dispatch aborted scope sends nothing and does not kill a healthy stdio client', async t => {
  const f = await setup(t);
  f.abort.abort();
  const result = await f.run(() => f.client.callTool('slow_task', {}, 10000, { signal: f.abort.signal }));
  assert.equal(result.code, 'privacy.mcp_cancelled');
  assert.equal(result.operationMayHaveExecuted, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.observed.killCalls, 0);
  assert.equal(f.client.dead, false);
});

test('successful transport with changed recipient withholds its result without transport-cancel cleanup', async t => {
  const f = await setup(t, { onCall: ({ client, message, invalidate }) => {
    invalidate();
    client._onLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: secretResult }] } }));
  } });
  const result = await f.run(() => f.client.callTool('slow_task', {}, 10000));
  assertWithheld(result, 'privacy.mcp_recipient_changed');
  assert.equal(f.writes.filter(row => row.method === 'tools/call').length, 1);
  assert.equal(f.writes.filter(row => row.method === 'notifications/cancelled').length, 0);
  assert.equal(f.observed.killCalls, 0);
  assert.equal(f.client.dead, false);
});

test('server-authored timeout words and flags do not authorize killing a healthy managed stdio client', async t => {
  const f = await setup(t, { onCall: ({ client, message }) => {
    client._onLine(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000,
      message: 'upstream API timed out after 30s', mcpTimeout: true, mcpAborted: true } }));
  } });
  const result = await f.run(() => f.client.callTool('slow_task', {}, 10000));
  assert.deepEqual(result, { ok: false, error: 'upstream API timed out after 30s' });
  assert.equal(f.writes.filter(row => row.method === 'tools/call').length, 1);
  assert.equal(f.observed.killCalls, 0);
  assert.equal(f.client.dead, false);
});

test('unmanaged stdio abort retains the existing exactly-once cancellation cleanup', async t => {
  const f = await setup(t, { onCall: ({ abort }) => queueMicrotask(() => abort.abort()) });
  const result = await f.client.callTool('slow_task', {}, 10000, { signal: f.abort.signal });
  assert.equal(result.steerInterrupted, true);
  assertOneSentCall(f, 'user_steer');
  assert.equal(f.observed.killCalls, 1);
  assert.equal(f.client.dead, true);
});

test('managed HTTP postflight cancellation remains withheld without the new stdio process cleanup', async t => {
  const f = await setup(t, { http: true });
  const result = await f.run(() => f.client.callTool('slow_task', {}, 10000, { signal: f.abort.signal }));
  assertWithheld(result, 'privacy.mcp_cancelled');
  assertOneSentCall(f, 'user_steer');
  assert.equal(f.observed.killCalls, 0);
  assert.equal(f.client.dead, false);
});

after(async () => {
  await app.flushWorkbenchLogs();
  assert.equal(path.dirname(root), temp);
  assert.ok(path.basename(root).startsWith('ruyi-managed-cancel-'));
  fs.rmSync(root, { recursive: true, force: true });
});
