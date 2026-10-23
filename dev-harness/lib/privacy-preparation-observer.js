'use strict';
// Test-only rendezvous at a real cooperative gateway yield. It never aborts a signal,
// changes policy, fabricates a provider response, or replaces a privacy transformer.
const { AsyncLocalStorage } = require('node:async_hooks');
function createPreparationObserver({ onPause, rows = 4096 } = {}) {
  const local = new AsyncLocalStorage();
  let scenario = null, held = null;
  const counts = { main: 0, child: 0 };
  function arm(value) {
    if (held) throw Error('cannot replace a held preparation');
    scenario = { ...value }; counts.main = 0; counts.child = 0;
  }
  async function boundary(kind, options, invoke) {
    if (!scenario) return invoke(options);
    const attempt = ++counts[kind], target = kind === scenario.kind && attempt === (scenario.holdAttempt || 1);
    const metadata = { ...(options.body.metadata || {}), ruyiFixtureCase: scenario.id, ruyiFixtureKind: kind, ruyiFixtureAttempt: String(attempt) };
    if (target) metadata.ruyiFixtureRows = Array.from({ length: rows }, (_, i) => ({ ordinal: i, ordinary: 'public bounded preparation padding' }));
    const body = { ...options.body, metadata };
    const binding = { id: scenario.id, kind, attempt, target, signal: options.signal, rows: target ? rows : 0, bodyBytes: Buffer.byteLength(JSON.stringify(body)) };
    return local.run(binding, () => invoke({ ...options, body }));
  }
  function schedule(original, callback, ...args) {
    const binding = local.getStore();
    if (!binding?.target || binding.observed || held || !/\bconsumeSteps\b/.test(new Error().stack || '')) return original(callback, ...args);
    if (!binding.signal || binding.signal.aborted) throw Error('rendezvous must begin with a live real transport signal');
    binding.observed = true;
    held = { binding, release: () => original(callback, ...args) };
    onPause?.({ ...snapshot(), phase: 'inside-consumeSteps-setImmediate', signalAbortedAtPause: false });
    return { ref() { return this; }, unref() { return this; }, hasRef() { return false; } };
  }
  function snapshot() {
    const binding = held?.binding;
    return { scenario: scenario?.id || '', held: !!held, counts: { ...counts },
      ...(binding ? { kind: binding.kind, attempt: binding.attempt, rows: binding.rows, bodyBytes: binding.bodyBytes, signalAborted: binding.signal.aborted } : {}) };
  }
  function release() {
    if (!held) return false;
    const resume = held.release; held = null; resume(); return true;
  }
  return { arm, boundary, schedule, snapshot, release };
}
module.exports = { createPreparationObserver };
