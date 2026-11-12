'use strict';
// Keep original ChildProcess/provider-startup owners after a caller's close
// deadline. This never reacquires a PID or declares descendant kernel closure.
const { knownCleanup } = require('./external-bots-c2/actual-http-fixture.cjs');
const retained = new Set();
function ownersClosed(actors, provider) {
  return actors.every(row => knownCleanup(row)) && (!provider || provider.snapshot().closeStatus === 'closed');
}
function retainUnknownOwners({ actors, provider, deadline, stop, note, hardExit = code => process.exit(code),
  schedule = setTimeout, cancel = clearTimeout }) {
  let resolve, finished = false;
  const promise = new Promise(value => { resolve = value; });
  const retention = { actors, provider, promise, deadline, diagnosticErrors: [] };
  retained.add(retention);
  const snapshot = status => ({ status, deadline, actors: actors.map(row => ({ ...row.facts, killReceipt: row.killReceipt,
    knownCleanup: Boolean(knownCleanup(row)) })), provider: provider?.snapshot() || null, diagnosticErrors: retention.diagnosticErrors.slice(),
    allDescendantKernelExitCertified: false });
  function record(status) {
    const value = snapshot(status);
    try { note(value); } catch (error) { retention.diagnosticErrors.push(error.message); }
    return value;
  }
  function check() {
    if (!finished && ownersClosed(actors, provider)) {
      finished = true; cancel(timer);
      const value = record('RED_ORIGINAL_FAILURE_RETAINED_ORIGINAL_OWNERS_CLOSED_LATE');
      retained.delete(retention); resolve(value);
    }
  }
  const timer = schedule(() => {
    if (finished) return;
    finished = true;
    const value = record('RED_UNKNOWN_ORIGINAL_OWNER_DEADLINE');
    resolve(value);
    // The original objects remain retained. Exiting our manual driver does not
    // turn UNKNOWN into success or assert that any descendant has stopped.
    hardExit(1);
  }, Math.max(1, deadline - Date.now()));
  for (const row of actors) {
    row.child.on('close', check);
    row.child.on('spawn', () => { Promise.resolve().then(() => stop(row, deadline)).then(check, error => {
      retention.diagnosticErrors.push(error.message); record('RED_ORIGINAL_CHILD_RETENTION_ERROR');
    }); });
    if (!knownCleanup(row)) Promise.resolve().then(() => stop(row, deadline)).then(check, error => {
      retention.diagnosticErrors.push(error.message); record('RED_ORIGINAL_CHILD_RETENTION_ERROR');
    });
  }
  if (provider) Promise.resolve().then(() => provider.requestClose()).then(check, error => {
    retention.diagnosticErrors.push(error.message); record('RED_ORIGINAL_PROVIDER_RETENTION_ERROR');
  });
  record('RED_RETAINING_ORIGINAL_OWNERS'); check();
  return retention;
}
module.exports = { ownersClosed, retainUnknownOwners };
