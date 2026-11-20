'use strict';
// 150 号文 §4 P9: custom regex rules queue for a worker, get a size-scaled budget, reuse results already
// scanned under the same rules, are probed for zero-width matches when saved, and name the rule on timeout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

const sourceDir = path.join(__dirname, '../../ruyi-workbench/app/src');
function load() {
  const source = ['01i-privacy-rules.js', '01h-privacy-core.js', '01m-privacy-regex.js'].map(file => fs.readFileSync(path.join(sourceDir, file), 'utf8')).join('\n');
  const spawned = [];
  const regex = vm.runInNewContext(source + '\nPrivacyRegex', {
    require: name => name === 'node:worker_threads' ? {
      Worker: class extends require('node:worker_threads').Worker { constructor(program, options) { spawned.push(1); super(program, options); } },
    } : require(name), Buffer, URL, structuredClone, setTimeout, clearTimeout,
  });
  return { regex, spawned };
}
const rule = (value, id = 'custom-rule', flags = '') => ({ id, kind: 'regex', value, flags, category: 'INTERNAL' });

test('a busy pool queues jobs in order, a full queue still refuses, and aborting a queued job frees nothing it did not take', async () => {
  const { regex } = load();
  const slow = ['(a+)+$', 'a'.repeat(40000) + '!'];
  const controllers = [new AbortController(), new AbortController()];
  const running = controllers.map(c => regex.scan([rule(slow[0])], [slow[1]], { signal: c.signal }).catch(error => error.code));
  const queuedAbort = new AbortController();
  const abandoned = regex.scan([rule('x')], ['x abandoned'], { signal: queuedAbort.signal }).catch(error => error.code);
  const waiting = regex.scan([rule('y')], ['y waits']);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(regex.activeJobs(), 2); assert.equal(regex.queued(), 2);
  queuedAbort.abort();
  assert.equal(await abandoned, 'privacy.regex_aborted');
  assert.equal(regex.queued(), 1); assert.equal(regex.activeJobs(), 2);
  for (const c of controllers) c.abort();
  assert.deepEqual(await Promise.all(running), ['privacy.regex_aborted', 'privacy.regex_aborted']);
  assert.equal((await waiting).get('y waits').length, 1);
  assert.equal(regex.activeJobs(), 0); assert.equal(regex.queued(), 0);
  assert.ok(regex.LIMITS.queue >= 8 && regex.LIMITS.queueMs > 0);
});

test('the run budget grows with the bytes sent to the worker and is capped', () => {
  const { regex } = load();
  assert.equal(regex.runBudget(0), regex.LIMITS.runMs);
  assert.ok(regex.runBudget(30 * 1024) >= regex.LIMITS.runMs + 30 * regex.LIMITS.runMsPerKiB);
  assert.ok(regex.runBudget(30 * 1024) > 1.5 * regex.LIMITS.runMs, 'a 30 KB history has more than the old fixed budget');
  assert.equal(regex.runBudget(8 * 1024 * 1024), regex.LIMITS.runMsMax);
});

test('inputs already scanned under the same rules reuse their matches without a worker; a rule change rescans', async () => {
  const { regex, spawned } = load();
  const rules = [rule('EMP-[0-9]{4}', 'employee')];
  const first = await regex.scan(rules, ['history EMP-1234', 'fresh']);
  assert.equal(spawned.length, 1);
  const again = await regex.scan(rules, ['history EMP-1234', 'fresh']);
  assert.equal(spawned.length, 1, 'fully cached scan starts no worker');
  assert.deepEqual(structuredClone(again.get('history EMP-1234')), structuredClone(first.get('history EMP-1234')));
  const mixed = await regex.scan(rules, ['history EMP-1234', 'new EMP-9999 text']);
  assert.equal(spawned.length, 2, 'only the unseen input is scanned');
  assert.deepEqual(structuredClone(mixed.get('new EMP-9999 text')).map(row => [row.start, row.end]), [[4, 12]]);
  assert.deepEqual(structuredClone(mixed.get('history EMP-1234')).map(row => [row.start, row.end]), [[8, 16]]);
  await regex.scan([rule('EMP-[0-9]{3}', 'employee')], ['history EMP-1234']);
  assert.equal(spawned.length, 3, 'a different rule source is a different cache key');
  await regex.scan([{ ...rule('EMP-[0-9]{4}', 'employee'), category: 'IDENTITY' }], ['history EMP-1234']);
  assert.equal(spawned.length, 4, 'category is part of the key');
  assert.ok(Object.isFrozen(again.get('history EMP-1234')) && Object.isFrozen(again.get('history EMP-1234')[0]));
  assert.ok(regex.cacheSize() <= regex.LIMITS.cacheEntries);
});

test('saving probes every position: lookaheads, optional groups, anchors and word boundaries are refused with the rule id', async () => {
  const { regex } = load();
  // 4B review v2: CJK and full-width punctuation inside a lookbehind belong to the probe literal.
  for (const value of ['(?=secret)', '(?:abc)?', 'a*', '\\b', '$', '(?<=项目)', '(?=合同编号)', '(?<=密码：)\\S*', '(?<=（编号）)\\d*', '(?<=密码:)\\S*']) {
    await assert.rejects(regex.validate([rule('EMP-[0-9]{4}', 'ok-first'), rule(value, 'zero-width')]),
      error => error.code === 'privacy.regex_empty_match' && error.ruleId === 'zero-width', value);
  }
  for (const value of ['EMP-[0-9]{4}', 'secret(?=x)', '(?<=项目)[A-Z]{3}', '合同编号[:：]?\\s*[A-Z0-9-]{4,20}', '\\bvalue\\b']) {
    assert.equal(await regex.validate([rule(value, 'fine')]), true, value);
  }
  assert.equal(regex.activeJobs(), 0);
});

test('a timeout names the rule that was running, never the sample', async () => {
  const { regex } = load();
  const sample = 'private ' + 'a'.repeat(40000) + '!';
  await assert.rejects(regex.scan([rule('safe', 'first-safe'), rule('(a+)+$', 'catastrophic')], [sample]),
    error => error.code === 'privacy.regex_timeout' && error.ruleId === 'catastrophic' && !error.message.includes('private'));
  assert.equal(regex.activeJobs(), 0);
});
