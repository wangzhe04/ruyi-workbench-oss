'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runBounded, INVENTORY_PS } = require('./dependency-probe');

test('bounded child captures successful read-only receipt', async () => {
  const r = await runBounded(process.execPath, ['-e', 'process.stdout.write("receipt")']);
  assert.equal(r.stdout, 'receipt');
  assert.equal(r.exitCode, 0);
  assert.equal(r.reason, null);
});
test('failed spawn reports unknown rather than successful inventory', async () => {
  const r = await runBounded('ruyi-namespace-nonexistent-command', []);
  assert.equal(r.reason, 'spawn-error');
});
test('output ceiling rejects oversized inventory', async () => {
  const r = await runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048))'], { maxBytes: 64 });
  assert.equal(r.reason, 'output-limit');
  assert.equal(r.stdout, '');
  assert.ok(r.cleanup);
});
test('timeout cleans owned long-lived process', async () => {
  const r = await runBounded(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 100 });
  assert.equal(r.reason, 'timeout');
  assert.ok(r.cleanup.killed.length > 0);
});
test('inventory has no feature mutation or guest launch commands', () => {
  assert.doesNotMatch(INVENTORY_PS, /Enable-WindowsOptionalFeature|Start-VM|New-VM|Set-VM|Start-Service|Mount-VHD|Set-ItemProperty/i);
});
