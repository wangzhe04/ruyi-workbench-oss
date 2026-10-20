const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { fixture } = require('../lib/privacy-test-fixture');
const { PrivacyRegex: regex, PrivacyCore: core } = fixture();
const rule = (value, flags = '') => ({ id: 'employee', kind: 'regex', value, flags, category: 'INTERNAL' });

test('packaged bytecode without function source still runs isolated workers with unchanged budgets', async () => {
  const sourceDir = path.join(__dirname, '../../ruyi-workbench/app/src');
  const source = ['01i-privacy-rules.js', '01h-privacy-core.js', '01m-privacy-regex.js']
    .map(file => fs.readFileSync(path.join(sourceDir, file), 'utf8')).join('\n');
  const workers = [];
  const compiled = vm.runInNewContext(`Function.prototype.toString = () => 'function () { [native code] }';\n${source}\n({regex: PrivacyRegex, stripped: (function () {}).toString()})`, {
    require: name => name === 'node:worker_threads' ? {
      Worker: class extends require('node:worker_threads').Worker {
        constructor(program, options) { workers.push({ program, options }); super(program, options); }
      },
    } : require(name), Buffer, URL, structuredClone, setTimeout, clearTimeout,
  });
  assert.equal(compiled.stripped, 'function () { [native code] }');
  const sample = '🙂 EMP-4321';
  assert.deepEqual(structuredClone((await compiled.regex.scan([rule('EMP-[0-9]{4}')], [sample])).get(sample)).map(row => [row.start, row.end]), [[3, 11]]);
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 30);
  try { await assert.rejects(compiled.regex.scan([rule('(a+)+$')], ['a'.repeat(40000) + '!']), /regex_timeout/); }
  finally { clearTimeout(timer); }
  assert.equal(heartbeat, true); assert.equal(compiled.regex.activeJobs(), 0);
  assert.equal((await compiled.regex.scan([rule('recovered')], ['recovered'])).get('recovered').length, 1);
  assert.equal(compiled.regex.LIMITS.startupMs, 3000); assert.equal(compiled.regex.LIMITS.runMs, 250);
  for (const { program, options } of workers) {
    assert.equal(typeof program, 'string'); assert.equal(program.includes('[native code]'), false);
    assert.equal(program.includes(sample), false); assert.equal(program.includes('EMP-[0-9]{4}'), false);
    assert.equal(options.eval, true);
    assert.deepEqual(structuredClone(options.resourceLimits), { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 });
  }
});

test('custom regex executes in workers with flags and UTF-16 offsets; core never treats its source as a literal', async () => {
  const rules = [rule('EMP-[0-9]{4}', 'i')];
  const result = await regex.scan(rules, ['🙂 emp-4321 / EMP-1234']);
  assert.deepEqual(structuredClone(result.get('🙂 emp-4321 / EMP-1234')).map(row => [row.start, row.end]), [[3, 11], [14, 22]]);
  const matches = await regex.scan([rule('foo$')], ['foo$', 'foo']);
  const detector = core.createDetector({ rules: [rule('foo$')], regexMatches: input => matches.get(input) });
  assert.equal(detector.detect('foo$').length, 0);
  assert.equal(detector.detect('foo').length, 1);
  assert.throws(() => core.createDetector({ rules }).detect('emp-4321'), /regex_worker_required/);
});

test('invalid patterns, flags and zero-width matches fail with sanitized errors and no sample or source', async () => {
  await assert.rejects(regex.scan([rule('(')], ['private sample']), error => error.code === 'privacy.regex_invalid' && error.ruleId === 'employee' && !error.message.includes('('));
  for (const flags of ['ii', 'y', null, false, 0]) await assert.rejects(regex.scan([rule('a', flags)], ['a']), /regex_invalid/);
  await assert.rejects(regex.validate([rule('a*')]), /regex_empty_match/);
  await assert.rejects(regex.scan([rule('(?=a)')], ['a']), /regex_empty_match/);
  assert.equal(regex.activeJobs(), 0);
});

test('catastrophic regex is terminated without blocking host timers and a later scan works', async () => {
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 30);
  try { await assert.rejects(regex.scan([rule('(a+)+$')], ['a'.repeat(40000) + '!']), /regex_timeout/); }
  finally { clearTimeout(timer); }
  assert.equal(heartbeat, true); assert.equal(regex.activeJobs(), 0);
  assert.equal((await regex.scan([rule('safe')], ['safe'])).get('safe').length, 1);
});

test('worker jobs, input and match budgets refuse overflow; cancellation releases the worker', async () => {
  await assert.rejects(regex.scan([rule('a')], ['a'.repeat(regex.LIMITS.sample + 1)]), /regex_input_limit/);
  await assert.rejects(regex.scan([], null), /regex_input_limit/);
  await assert.rejects(regex.scan(Array.from({ length: 21 }, (_, i) => ({ ...rule('a'), id: 'r' + i })), ['a']), /regex_rules_limit/);
  await assert.rejects(regex.scan([rule('a')], ['a'.repeat(regex.LIMITS.matches + 1)]), /regex_matches_limit/);
  const a = new AbortController(), b = new AbortController();
  const first = regex.scan([rule('(a+)+$')], ['a'.repeat(40000) + '!'], { signal: a.signal });
  const second = regex.scan([rule('(a+)+$')], ['a'.repeat(40000) + '!'], { signal: b.signal });
  const settled = Promise.allSettled([first, second]);
  await assert.rejects(regex.scan([rule('safe')], ['safe']), /regex_busy/);
  a.abort(); b.abort();
  assert.ok((await settled).every(result => result.status === 'rejected' && result.reason.code === 'privacy.regex_aborted'));
  assert.equal(regex.activeJobs(), 0);
});
