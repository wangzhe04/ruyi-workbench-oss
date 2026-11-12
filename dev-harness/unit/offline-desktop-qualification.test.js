'use strict';
// Pure fixture acceptance boundaries. No Desktop, PowerShell observer, window,
// server, fake provider, real native process or DPAPI is launched here.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { parseArgs, assertUiCompletion, assertAbortMarker, assertNormalClosure } = require('../lib/offline-desktop-qualification.cjs');
const pin = 'a'.repeat(64), nonce = 'b'.repeat(32), readyAt = Date.parse('2026-11-11T10:00:00.000Z');
const args = () => ['--stage', path.resolve('synthetic-desktop-stage'), '--output', path.resolve('synthetic-desktop-output'), '--expected-server-sha', pin];
const marker = () => ({ schema: 1, nonce, observer: '@oai/sky', skyWindowId: 'opaque-sky-window', guiLoaded: true, settingsRead: true,
  normalClose: true, closedObserved: true, loadedAt: '2026-11-11T10:00:01.000Z', settingsReadAt: '2026-11-11T10:00:02.000Z',
  closeRequestedAt: '2026-11-11T10:00:03.000Z', closedObservedAt: '2026-11-11T10:00:04.000Z', evidenceFiles: [path.resolve('synthetic-sky-evidence.json')] });
function desktop() {
  return { facts: { spawn: true, error: null, exit: { code: 0, signal: null }, close: { code: 0, signal: null },
    streams: { stdout: { availability: 'original-pipe', end: true, close: true, error: null }, stderr: { availability: 'original-pipe', end: true, close: true, error: null } } }, killReceipt: null };
}
const native = () => ({ schema: 1, kind: 'ORIGINAL_BACKEND_HANDLE_SIGNALED', nonce, originalHandleSignaled: true, handleDisposed: true,
  serverPid: 222, nativeCreated: '12345', cimCreated: '12340', timedOut: false, exitCode: 0, signaledAt: '2026-11-11T10:00:03.100Z' });
const expected = { serverPid: 222, nativeCreated: '12345', cimCreated: '12340' };

test('manual Desktop arguments require absolute explicit stage/output/source pin and refuse duplicate/unknown flags', () => {
  assert.equal(parseArgs(args()).expectedServerSha, pin);
  for (const value of [[], args().slice(0, -1), [...args(), '--stage', path.resolve('different')], [...args(), '--ui-automation', 'true'],
    ['--stage', 'relative', ...args().slice(2)], [...args().slice(0, -1), 'bad-sha']]) assert.throws(() => parseArgs(value));
});
test('GUI completion requires root Sky identity, all read-only/normal-close observations, archive and actual ordered times after READY', () => {
  assertUiCompletion(marker(), nonce, readyAt);
  const mutations = [row => { row.nonce = 'other'; }, row => { row.observer = 'synthesized-dom'; }, row => { row.guiLoaded = false; },
    row => { row.settingsRead = false; }, row => { row.normalClose = false; }, row => { row.closedObserved = false; },
    row => { row.skyWindowId = ''; }, row => { row.evidenceFiles = []; }, row => { row.loadedAt = '2026-11-11T09:59:59.000Z'; },
    row => { row.closeRequestedAt = row.loadedAt; }, row => { row.closedObservedAt = 'invalid'; }];
  for (const mutate of mutations) { const row = marker(); mutate(row); assert.throws(() => assertUiCompletion(row, nonce, readyAt)); }
});
test('normal GUI closure never substitutes Desktop exit/PID alone, forced kill, unknown native wait or missing pipe EOF', () => {
  assertNormalClosure(desktop(), native(), nonce, marker(), expected);
  for (const mutate of [row => { row.facts.exit = null; }, row => { row.facts.close = null; }, row => { row.facts.streams.stdout.end = false; },
    row => { row.facts.streams.stderr.close = false; }, row => { row.facts.exit.code = row.facts.close.code = 1; },
    row => { row.killReceipt = { skipped: 'root-exited' }; }]) { const row = desktop(); mutate(row); assert.throws(() => assertNormalClosure(row, native(), nonce, marker(), expected)); }
  for (const mutate of [row => { row.originalHandleSignaled = false; }, row => { row.handleDisposed = false; }, row => { row.timedOut = true; },
    row => { row.exitCode = 1; }, row => { row.nonce = 'different'; }, row => { row.signaledAt = '2026-11-11T10:00:02.999Z'; },
    row => { row.serverPid = 333; }, row => { row.nativeCreated = 'different'; }, row => { row.cimCreated = 'different'; }]) {
    const row = native(); mutate(row); assert.throws(() => assertNormalClosure(desktop(), row, nonce, marker(), expected));
  }
});
test('explicit Desktop abort marker requires this owner nonce and a bounded reason, never a PID or injected command', () => {
  assertAbortMarker({ schema: 1, nonce, reason: 'Sky cannot target the owned qualification window' }, nonce);
  for (const row of [null, [], {}, { schema: 1, nonce: 'another-owner', reason: 'blocked' }, { schema: 2, nonce, reason: 'blocked' },
    { schema: 1, nonce, reason: '' }, { schema: 1, nonce, reason: ' blocked' }, { schema: 1, nonce, reason: 'a'.repeat(1001) },
    { schema: 1, nonce, reason: 'line\nbreak' }, { schema: 1, nonce, reason: 'blocked', pid: 123 },
    { schema: 1, nonce, reason: 'blocked', command: 'taskkill' }]) assert.throws(() => assertAbortMarker(row, nonce));
});
