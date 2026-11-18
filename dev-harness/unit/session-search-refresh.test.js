'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/session-experience.js'), 'utf8');
const start = source.indexOf('let sessionSearchState =');
const end = source.indexOf('// 121-K4', start);
assert.ok(start > 0 && end > start);
// 150 号文 U2:回包并状态与续搜判据搬进了纯函数模块 session-search-state.js(session-experience.js 从那里 import),
// 切片里没有 import 语句,vm 上下文把那几个导出一并递进去。断言一条未改。
let searchState = null;
test.before(async () => { searchState = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/session-search-state.js')).href); });
function fixture(responses) {
  const input = { value: 'resume interrupted downloads' }, timers = new Map();
  let timerId = 0, requests = 0;
  const ctx = vm.createContext({
    ...searchState,
    $: () => input, renderSessions() {}, AbortController,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async api() { const result = responses[Math.min(requests++, responses.length - 1)]; return typeof result === 'function' ? result() : result; },
  });
  vm.runInContext(source.slice(start, end) + '\n;globalThis.schedule = scheduleSessionSearch; globalThis.current = () => sessionSearchState;', ctx);
  return { ctx, input, timers, requests: () => requests, async tick() {
    assert.ok(timers.size); const [id, fn] = timers.entries().next().value; timers.delete(id); await fn();
  } };
}
const response = semantic => ({ ok: true, results: [{ id: 'hit' }], semantic });
test('search UI continues a productive bounded timeout until complete', async () => {
  const f = fixture([response({ status: 'timeout', coverage: 'partial', cachedFragments: 20 }), response({ status: 'ready', coverage: 'complete', cachedFragments: 40 })]);
  f.ctx.schedule(); await f.tick(); assert.equal(f.timers.size, 1);
  await f.tick(); await f.tick();
  assert.equal(f.requests(), 2); assert.equal(f.timers.size, 0);
  assert.equal(f.ctx.current().semantic.coverage, 'complete');
});
test('search UI does not retry unavailable, zero-progress or truncated timeouts', async () => {
  for (const semantic of [
    { status: 'unavailable' }, { status: 'timeout', coverage: 'partial', cachedFragments: 0 },
    { status: 'timeout', coverage: 'partial', cachedFragments: 5, truncated: true },
    { status: 'partial', truncated: true },
  ]) {
    const f = fixture([response(semantic)]); f.ctx.schedule(); await f.tick(); assert.equal(f.timers.size, 0);
  }
});
test('search UI stops without progress and abandons changed queries', async () => {
  const value = response({ status: 'timeout', coverage: 'partial', cachedFragments: 20 });
  const capped = fixture([value]); capped.ctx.schedule();
  while (capped.timers.size) await capped.tick();
  assert.equal(capped.requests(), 2);
  const changed = fixture([value]); changed.ctx.schedule(); await changed.tick();
  changed.input.value = 'different topic'; await changed.tick(); assert.equal(changed.timers.size, 0); assert.equal(changed.requests(), 1);
});
test('clearing the query invalidates an in-flight semantic response', async () => {
  let resolve;
  const f = fixture([() => new Promise(done => { resolve = done; })]); f.ctx.schedule();
  const pending = f.tick(); f.input.value = ''; f.ctx.schedule();
  resolve(response({ status: 'timeout', coverage: 'partial', cachedFragments: 20 })); await pending;
  assert.equal(f.ctx.current().query, ''); assert.equal(f.ctx.current().results, null); assert.equal(f.timers.size, 0);
});
test('cold source indexing continues without vectors but paused and disabled sources do not', async () => {
  for (const phase of ['timeout', 'pending', 'building', 'idle', 'paused', 'disabled']) {
    const f = fixture([{ ...response({ status: 'timeout', coverage: 'partial' }), coverage: { phase, complete: false, indexedSessions: phase==='timeout'?null:4, pendingSessions: 207 } }]);
    f.ctx.schedule(); await f.tick();
    assert.equal(f.timers.size, ['pending', 'building', 'idle'].includes(phase) ? 1 : 0, phase);
    if(phase==='timeout')assert.equal(f.ctx.current().canResume,true);
  }
  for (const phase of ['paused', 'disabled']) {
    const f = fixture([{ ...response({ status: 'partial', coverage: 'partial', cachedFragments: 20 }), coverage: { phase, complete: false, pendingSessions: 207 } }]);
    f.ctx.schedule(); await f.tick(); assert.equal(f.timers.size, 0, phase);
  }
});
test('one search reaches a match in the last slice of a 400-thread catalog',async()=>{
 const replies=Array.from({length:100},(_,i)=>({ok:true,results:i===99?[{id:'last'}]:[],
   coverage:{phase:'idle',sessions:400,indexedSessions:4*(i+1),pendingSessions:396-4*i,complete:i===99}}));
 const f=fixture(replies);f.ctx.schedule();
 while(f.timers.size)await f.tick();
 assert.equal(f.requests(),100);assert.equal(f.ctx.current().results[0].id,'last');
});
