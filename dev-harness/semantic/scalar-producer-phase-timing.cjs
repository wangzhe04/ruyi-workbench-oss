'use strict';
// Request-local timing only. Never records arguments, source text, identities
// or error payloads. Inclusive sums are not mistaken for wall-clock cost.
const { AsyncLocalStorage } = require('node:async_hooks'), { performance } = require('node:perf_hooks');
function createTiming() {
  const local = new AsyncLocalStorage(), events = [], counts = new Map(); let nextId = 0, truncated = false;
  const record = event => { if (events.length < 200000) events.push(event); else truncated = true; };
  const state = () => local.getStore() || { request: 'unscoped', id: null };
  const count = name => { const key = JSON.stringify([state().request, name]); counts.set(key, (counts.get(key) || 0) + 1); };
  async function measure(name, work) {
    const previous = state(), id = ++nextId, start = performance.now(); let ok = false;
    try { const value = await local.run({ ...previous, id }, work); ok = true; return value; }
    finally { record({ request: previous.request, id, parent: previous.id, name, start, end: performance.now(), ok }); }
  }
  function measureSync(name, work) {
    const previous = state(), id = ++nextId, start = performance.now(); let ok = false;
    try { const value = local.run({ ...previous, id }, work); ok = true; return value; }
    finally { record({ request: previous.request, id, parent: previous.id, name, start, end: performance.now(), ok }); }
  }
  function union(spans) { let total = 0, end = -Infinity; for (const span of spans.slice().sort((a, b) => a.start - b.start)) { if (span.end > end) { total += span.end - Math.max(span.start, end); end = span.end; } } return total; }
  function snapshot() {
    const groups = new Map(); for (const event of events) { const key = JSON.stringify([event.request, event.name]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event); }
    return { truncated, events: events.slice(), counters: [...counts].map(([key, calls]) => ({ key: JSON.parse(key), calls })),
      phases: [...groups].map(([key, spans]) => ({ key: JSON.parse(key), calls: spans.length, inclusiveSumMs: spans.reduce((sum, span) => sum + span.end - span.start, 0), wallUnionMs: union(spans), failed: spans.filter(span => !span.ok).length })) };
  }
  return Object.freeze({ measure, measureSync, count, snapshot, withRequest: (request, work) => local.run({ request, id: null }, work),
    reset: () => { events.length = 0; counts.clear(); truncated = false; } });
}
module.exports = { createTiming };
