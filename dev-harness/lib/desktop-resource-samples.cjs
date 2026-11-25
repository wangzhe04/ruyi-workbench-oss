'use strict';

const assert = require('node:assert/strict');

const counters = ['workingSetBytes', 'privateCommitBytes', 'userTime100ns', 'kernelTime100ns', 'threads'];
const key = row => row.pid + ':' + row.born;
const roles = ['desktop', 'service', 'model', 'webview-browser'];
const ticksPerMs = 10000n, unixEpoch = 116444736000000000n;

// A retained identity stays attributable if its parent has since exited. New
// descendants need a live parent link whose birth precedes their own.
function sampleTree(snapshot, originals, known) {
  assert.equal(originals.length, roles.length, 'desktop, service, model and WebView identity required');
  const rows = snapshot.rows;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  assert.equal(byPid.size, rows.length, 'one active process per PID in the counter collection');
  const selected = new Map();
  const originalRoles = new Map();
  for (const [index, original] of originals.entries()) {
    const row = byPid.get(original.pid);
    // Win32_Process (used at readiness) reports FILETIME only to microseconds.
    assert.ok(row && row.parent === original.parent && /^\d+$/.test(row.born)
      && BigInt(row.born) / 10n * 10n === BigInt(original.created), 'missing or replaced original ' + roles[index]);
    const id = key(row);
    if (known.size) assert.ok(known.has(id), 'original birth changed since the first counter sample');
    selected.set(id, row);
    originalRoles.set(id, roles[index]);
  }
  for (const row of rows) if (known.has(key(row))) selected.set(key(row), row);
  let previous;
  do {
    previous = selected.size;
    for (const row of rows) {
      const parent = byPid.get(row.parent);
      if (parent && selected.has(key(parent))) {
        assert.match(row.born, /^\d+$/, 'missing child creation time');
        const born = BigInt(row.born);
        assert.ok(born > 0n && born <= BigInt(row.tick), 'invalid child creation time');
        if (born >= BigInt(parent.born)) selected.set(key(row), row);
      }
    }
  } while (selected.size !== previous);

  const totals = Object.fromEntries(counters.map(name => [name, 0]));
  const tick = selected.values().next().value.tick;
  assert.match(tick, /^\d+$/);
  const sampledMs = Number((BigInt(tick) - unixEpoch) / ticksPerMs);
  const memoryMs = Date.parse(snapshot.memorySampledUtc);
  assert.ok(Math.abs(sampledMs - memoryMs) <= 3000, 'system memory timestamp must be near the process snapshot');
  assert.ok(Number.isSafeInteger(snapshot.availablePhysicalBytes) && snapshot.availablePhysicalBytes >= 0);
  const processes = Array.from(selected.values(), row => {
    assert.ok(row.tick === tick && row.frequency === 10000000, 'all process counters share one 100ns clock sample');
    for (const name of counters) {
      assert.ok(Number.isSafeInteger(row[name]) && row[name] >= 0, 'missing or invalid ' + name + ' for PID ' + row.pid);
      totals[name] += row[name];
      assert.ok(Number.isSafeInteger(totals[name]));
    }
    assert.ok(row.threads > 0, 'sampled process must have a live thread');
    const process = { pid: row.pid, parent: row.parent, born: row.born, name: row.name, role: originalRoles.get(key(row)) || 'descendant' };
    for (const name of counters) process[name] = row[name];
    return process;
  });
  assert.ok(processes.some(row => row.parent === originals[3].pid), 'at least one WebView browser child is measured');
  const noLongerObserved = [...known.values()].filter(row => !selected.has(key(row))).map(({pid, born}) => ({pid, born}));
  for (const row of processes) known.set(key(row), row);
  return { startedUtc: snapshot.startedUtc, sampledUtc: new Date(sampledMs).toISOString(), tick, memorySampledUtc: snapshot.memorySampledUtc,
    availablePhysicalBytes: snapshot.availablePhysicalBytes, processes, totals, noLongerObserved };
}

module.exports = { sampleTree };
