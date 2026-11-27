'use strict';
// 152 L5: one resident worker lease with a ranked wait queue, and soft timeouts that do not reap a worker
// which still answers. The real child process honours deadlineMs the way the packaged Gemma worker does.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06hb-semantic-runtime.js'), 'utf8');
const context = vm.createContext({ SemanticRuntimeHooks: {}, Buffer, setTimeout, clearTimeout, Date, require, process, __dirname, WeakRef });
vm.runInContext(source + '\n;globalThis.api = SemanticRuntimeClient;', context);
const fingerprint = 'b'.repeat(64);
// Text prefixes choose the per-request service time. Past deadlineMs the worker answers timeout itself,
// after finishing the text it was on (the packaged worker checks the deadline between texts).
const script = `const readline=require('node:readline');const fp='${fingerprint}';
  console.log(JSON.stringify({type:'ready',modelFingerprint:fp,dimensions:8}));
  readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);const t=r.texts[0];
    const ms=/^slow/.test(t)?400:/^mid/.test(t)?200:/^mute/.test(t)?-1:5;
    console.error('order:'+t);if(ms<0)return;
    setTimeout(()=>{if(t.startsWith('deadline')||Date.now()>r.deadlineMs)console.log(JSON.stringify({ok:false,requestId:r.requestId,error:{code:'EG2_DEADLINE'}}));
      else console.log(JSON.stringify({ok:true,requestId:r.requestId,vectors:r.texts.map(()=>[1,0,0,0,0,0,0,0]),modelFingerprint:fp}));},ms);});`;
function fixture({ exitObservationMs = 0, softTimeoutCooldownMs } = {}) {
  const children = [], closed = new Set(), order = [];
  const client = context.api.create({ enabled: async () => true, startupMs: 5000, softTimeoutCooldownMs,
    observe: async pid => { if (!closed.has(pid)) return { exists: true, pid, creationFileTime: '133000000000000000' }; await sleep(exitObservationMs); return { exists: false }; },
    settings: () => ({ command: process.execPath, args: ['-e', script], env: {}, cwd: process.cwd() }),
    spawn(...args) {
      const child = cp.spawn(...args); children.push(child);
      child.once('close', () => closed.add(child.pid));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { for (const line of chunk.split('\n')) if (line.startsWith('order:') && line !== 'order:Local semantic runtime warmup.') order.push(line.slice(6)); });
      return child;
    },
  });
  return { client, order, async close() {
    const closing = children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once('close', resolve)));
    await client.stop('disabled'); await Promise.all(closing);
  } };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Hold the lease after the response arrives, until all competing callers have entered acquire().
function holdLease(client) {
  const holding = Promise.withResolvers(), released = Promise.withResolvers();
  let calls = 0;
  const done = client.encode(['holder'], { role: 'document', budgetMs: 8000, beforeEncode: async () => {
    if (++calls === 2) {
      holding.resolve();
      await released.promise;
    }
  } });
  return { holding: holding.promise, release: released.resolve, done };
}

test('a full queue refuses its seventeenth waiter and runs equal-priority waiters in arrival order', async () => {
  const f = fixture();
  let holder;
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    holder = holdLease(f.client);
    await holder.holding;
    const names = Array.from({length: 16}, (_, n) => 'queued ' + n);
    const queued = names.map(text => f.client.encode([text], {role: 'query', budgetMs: 8000}));
    const overflow = await f.client.encode(['overflow'], {role: 'query', budgetMs: 8000});
    assert.equal(overflow.reason, 'overloaded');
    assert.equal(f.client.stats().queueWaits, 16);
    holder.release();
    assert.equal((await holder.done).ok, true);
    assert.ok((await Promise.all(queued)).every(result => result.ok));
    assert.deepEqual(f.order, ['holder', ...names]);
  } finally { holder?.release(); await f.close(); }
});

test('handoff discards an expired maxWaitMs even before the waiter timer can run', async () => {
  const f = fixture();
  let holder;
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    holder = holdLease(f.client);
    await holder.holding;
    const late = f.client.encode(['expired'], {role: 'query', budgetMs: 8000, maxWaitMs: 80});
    // Yield only to promises until queued, then simulate a blocked event loop past maxWaitMs.
    for (let n = 0; n < 100 && !f.client.stats().queueWaits; n++) await Promise.resolve();
    assert.equal(f.client.stats().queueWaits, 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    holder.release();
    assert.equal((await holder.done).ok, true);
    assert.equal((await late).reason, 'overloaded');
    assert.equal(f.client.stats().queryTexts, 0);
  } finally { holder?.release(); await f.close(); }
});

test('three consecutive soft timeouts pause admission, preserve the resident worker and recover', async () => {
  const f = fixture({softTimeoutCooldownMs: 250});
  const encode = text => f.client.encode([text], {role: 'query', budgetMs: 2000});
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    assert.equal((await encode('deadline 1')).reason, 'timeout');
    assert.equal((await encode('deadline 2')).reason, 'timeout');
    assert.equal((await encode('success resets the streak')).ok, true);
    assert.equal((await f.client.encode(['slow caller deadline'], {role: 'query', budgetMs: 220})).reason, 'timeout');
    assert.equal((await encode('deadline 4')).reason, 'timeout');
    assert.equal((await encode('deadline 5')).reason, 'timeout');
    assert.equal((await encode('held during cooldown')).reason, 'overloaded');
    assert.equal(f.client.stats().softTimeouts, 5);
    assert.equal(f.client.stats().queryTexts, 6);
    assert.equal(f.client.stats().stops, 0);
    assert.equal(f.client.descriptor().state, 'ready');
    await sleep(300);
    assert.equal((await encode('after cooldown')).ok, true);
    assert.equal(f.client.stats().starts, 1);
    assert.equal(f.client.stats().kills, 0);
  } finally { await f.close(); }
});

test('restart clears an active soft-timeout cooldown', async () => {
  const f = fixture({softTimeoutCooldownMs: 30000});
  const encode = text => f.client.encode([text], {role: 'query', budgetMs: 2000});
  try {
    assert.equal((await f.client.prepare({budgetMs: 5000})).available, true);
    for (let n = 0; n < 3; n++) assert.equal((await encode('deadline ' + n)).reason, 'timeout');
    assert.equal((await encode('before restart')).reason, 'overloaded');
    assert.equal((await f.client.restart()).available, true);
    assert.equal((await encode('after restart')).ok, true);
  } finally { await f.close(); }
});

test('a busy worker hands its lease to queries first, then interactive, then background; maxWaitMs:0 does not queue', async () => {
  const f = fixture();
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    const deadline = Date.now() + 4000;
    const first = f.client.encode(['mid first'], { role: 'document', deadline });
    await sleep(40);
    // Pre-fix: every one of these returned overloaded at once and the callers polled.
    const background = f.client.encode(['background doc'], { role: 'document', priority: 'background', deadline });
    const interactive = f.client.encode(['interactive doc'], { role: 'document', deadline });
    const query = f.client.encode(['query text'], { role: 'query', deadline });
    const skipped = await f.client.encode(['never sent'], { role: 'document', priority: 'background', maxWaitMs: 0, deadline });
    assert.equal(skipped.reason, 'overloaded');
    const results = await Promise.all([first, background, interactive, query]);
    assert.deepEqual(results.map(r => r.ok), [true, true, true, true]);
    assert.deepEqual(f.order, ['mid first', 'query text', 'interactive doc', 'background doc']);
    assert.equal(f.client.stats().kills, 0);
    assert.ok(f.client.stats().queueWaits >= 3);
  } finally { await f.close(); }
});

test('a waiter whose deadline passes gives up with overloaded and leaves the worker healthy', async () => {
  const f = fixture();
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    const busy = f.client.encode(['slow holder'], { role: 'document', deadline: Date.now() + 4000 });
    await sleep(30);
    const began = Date.now();
    const late = await f.client.encode(['too late'], { role: 'query', deadline: Date.now() + 200 });
    assert.equal(late.reason, 'overloaded');
    assert.ok(Date.now() - began < 300, 'the waiter gave up at its own deadline');
    assert.equal((await busy).ok, true);
    assert.ok(!f.order.includes('too late'), 'an expired waiter never reaches the worker');
    assert.equal(f.client.descriptor().available, true);
    assert.equal(f.client.stats().kills, 0);
  } finally { await f.close(); }
});

test('a soft timeout answers at the caller deadline, keeps the worker, and holds the lease until the late reply', async () => {
  const f = fixture();
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    const began = Date.now();
    // 200 ms clears the client's 150 ms minimum budget for one query, so the request is really sent.
    const result = await f.client.encode(['slow but alive'], { role: 'query', deadline: Date.now() + 200 });
    const elapsed = Date.now() - began;
    assert.equal(result.reason, 'timeout');
    assert.ok(elapsed < 380, `soft timeout answered ${elapsed}ms after the request`);
    // The worker is still finishing that text: the next caller waits for the lease rather than writing into it.
    const next = await f.client.encode(['after it'], { role: 'query', deadline: Date.now() + 2000 });
    assert.equal(next.ok, true);
    assert.deepEqual(f.order, ['slow but alive', 'after it']);
    // Pre-fix: the client timer fired stop('timeout'): one kill and a 30 s fault cooldown.
    assert.equal(f.client.stats().kills, 0);
    assert.equal(f.client.stats().softTimeouts, 1);
    assert.equal(f.client.descriptor().available, true);
  } finally { await f.close(); }
});

test('a worker silent past deadline plus grace is still reaped as hung', async () => {
  const f = fixture();
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    const result = await f.client.encode(['mute forever'], { role: 'query', deadline: Date.now() + 250 });
    assert.equal(result.reason, 'timeout');
    assert.deepEqual(f.order, ['mute forever'], 'the request reached the worker (a deadline below the minimum budget is never sent)');
    for (let n = 0; n < 300 && (f.client.descriptor().available || f.client.descriptor().state === 'stopping'); n++) await sleep(10);
    assert.equal(f.client.descriptor().available, false, 'the hung worker was stopped after the grace window');
    // The fixture exits on stdin end, so the stop needs no kill; the hung timeout still enters the fault cooldown.
    assert.equal(f.client.stats().stops, 1);
    assert.equal(f.client.descriptor().state, 'failed');
  } finally { await f.close(); }
});

test('an explicit restart during a soft-timed-out request is not turned into a fault by the abandoned request', async () => {
  // The exit observation (PowerShell in production, 0.8 s under load) outlasts the 500 ms grace of the abandoned request.
  const f = fixture({ exitObservationMs: 900 });
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    assert.equal((await f.client.encode(['mute forever'], { role: 'query', deadline: Date.now() + 250 })).reason, 'timeout');
    // Pre-fix: the abandoned request's reap timer fired stop('timeout') mid-restart and the new worker was refused for 30 s.
    const restarted = await f.client.restart();
    assert.equal(restarted.available, true, JSON.stringify(restarted));
    assert.equal((await f.client.encode(['after restart'], { role: 'query', deadline: Date.now() + 2000 })).ok, true);
  } finally { await f.close(); }
});

test('a request aborted in flight rejects with its abort reason even when the soft deadline wins the race', async () => {
  // stop('cancelled') settles the request only after the exit observation (900 ms here), long after the 250 ms deadline.
  const f = fixture({ exitObservationMs: 900 });
  try {
    assert.equal((await f.client.prepare({ budgetMs: 5000 })).available, true);
    const controller = new AbortController();
    const pending = f.client.encode(['mute forever'], { role: 'query', deadline: Date.now() + 250, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    // Review finding: the soft-timeout branch returned unavailable('timeout') without checking the signal.
    await assert.rejects(pending, error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  } finally { await f.close(); }
});
