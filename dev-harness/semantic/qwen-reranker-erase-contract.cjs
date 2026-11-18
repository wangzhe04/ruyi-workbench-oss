'use strict';
// Executes actual request -> tokenize -> erase -> score -> stop source slices.
// Only HTTP transport and owned launcher outcome are fake; no assets/model/OS.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { functionBlock } = require('../lib/source-slice');
const file = path.resolve(__dirname, 'qwen-reranker-native.cjs'), source = fs.readFileSync(file, 'utf8'), hash = x => crypto.createHash('sha256').update(x).digest('hex');
// constBlock intentionally handles simple declarations and stops before this
// async arrow's body. Bound this exact declaration by the next named function.
const requestStart = source.indexOf('  const request ='), requestEnd = source.indexOf('\n  async function stop()', requestStart);
const requestSlice = source.slice(requestStart, requestEnd).trim();
if (requestStart < 0 || requestEnd <= requestStart || !requestSlice.endsWith('};')) throw Error('Actual request declaration absent.');
const slices = [functionBlock(source, 'check'), requestSlice, ...['stop', 'erase', 'prompt', 'tokenize', 'score'].map(name => functionBlock(source, name))];
if (slices.some(x => !x)) throw Error('Actual API source slice absent.');
const output = path.resolve(process.argv[2] || 'output/semantic-qwen-reranker-official-v1/erase-contract-v1.json');
if (fs.existsSync(output)) throw Error('Use a new immutable report.');
const results = [];
async function scenario(name, options, expect) {
  const controller = new AbortController(), cancelled = Object.hasOwn(options, 'cancelReason') ? options.cancelReason : new Error('synthetic.cancelled'),
    privacy = Object.hasOwn(options, 'guardReason') ? options.guardReason : new Error('privacy.synthetic_changed');
  const routes = []; let terminations = 0, guardCalls = 0;
  const owned = { exited: Promise.resolve({ cleanupStatus: options.cleanupFailure ? 'unknown' : 'observed' }),
    terminate: async () => { terminations++; if (options.cleanupFailure) throw new Error('observer.failed'); } };
  const transportError = Object.assign(new Error('synthetic.transport_abort'), { name: options.timeout ? 'TimeoutError' : 'AbortError' });
  const jsonError = new SyntaxError('synthetic.bad_json');
  const fetch = async url => {
    const endpoint = String(url).slice('http://127.0.0.1:1'.length); routes.push(endpoint);
    if (endpoint === '/tokenize') return { ok: true, json: async () => ({ tokens: Array(options.tooLong ? 513 : 10).fill(3) }) };
    if (endpoint === '/slots/0?action=erase') {
      if (options.transportAbort) { controller.abort(cancelled); throw transportError; }
      if (options.timeout) throw transportError;
      if (options.httpAbort) { controller.abort(cancelled); return { ok: false, status: 503, body: { cancel: async () => { throw transportError; } } }; }
      return { ok: true, json: async () => {
        if (options.abortDuringJson) controller.abort(cancelled);
        if (options.badJson) throw jsonError;
        return options.erase;
      } };
    }
    if (endpoint === '/rerank') return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: .75 }], usage: { prompt_tokens: 10 } }) };
    throw Error('Unexpected endpoint: ' + endpoint);
  };
  const api = vm.runInNewContext('let owner=owned,cleanup,active=false;const stats={eraseWrites:0,embeddingWrites:0,rankWrites:0,refusedOverLimit:0};const base="http://127.0.0.1:1",apiKey="synthetic",template="prefix {query} {document} suffix";\n'
    + slices.join('\n') + '\n({score,stop,stats});', { owned, fetch, AbortSignal, Array, Number, Error });
  const beforeRerank = async () => { guardCalls++; if (options.guardAfterErase && guardCalls === 3) { controller.abort(cancelled); throw privacy; } };
  let value, error, caught = false;
  try { value = await api.score('public query', 'public field', { signal: controller.signal, beforeRerank, ...(options.unsafe ? { verifyTwoClassVector: true } : {}) }); }
  catch (failure) { caught = true; error = failure; }
  try {
    const writes = routes.filter(x => x === '/rerank').length;
    if (expect === 'success') { assert.equal(value.ok, true); assert.equal(writes, 1); assert.equal(api.stats.eraseWrites, 1); assert.equal((await api.stop()).cleanupStatus, 'observed'); }
    else if (expect === 'overlimit') { assert.equal(value.reason, 'joint-token-limit'); assert.equal(writes, 0); assert.equal(api.stats.eraseWrites, 0); await api.stop(); }
    else {
      assert.equal(caught, true); assert.equal(writes, 0); assert.equal(terminations, options.unsafe ? 0 : 1);
      if (expect === 'cancel') assert.equal(error, cancelled);
      else if (expect === 'privacy') assert.equal(error, privacy);
      else if (expect === 'timeout') assert.equal(error, transportError);
      else if (expect === 'badjson') assert.equal(error, jsonError);
      else if (expect === 'http') assert.equal(error.message, 'NATIVE_HTTP_503');
      else if (expect === 'unsafe') assert.match(error.message, /unsafe RANK/);
      else assert.equal(error.code, 'INVALID_SLOT_ERASE');
    }
    results.push({ name, pass: true, rankWrites: writes, validatedErases: api.stats.eraseWrites, terminations }); console.log('PASS ' + name);
  } catch (failure) { results.push({ name, pass: false, error: String(failure.stack || failure) }); console.log('FAIL ' + name); }
}
(async () => {
  await scenario('zero erased tokens is a valid observed slot0 proof', { erase: { id_slot: 0, n_erased: 0 } }, 'success');
  await scenario('nonzero safe integer erased count is valid', { erase: { id_slot: 0, n_erased: 42 } }, 'success');
  for (const [name, erase] of [['wrong-slot', { id_slot: 1, n_erased: 0 }], ['missing-count', { id_slot: 0 }], ['missing-slot', { n_erased: 0 }],
    ['null', null], ['array', []], ['string-count', { id_slot: 0, n_erased: '0' }], ['negative', { id_slot: 0, n_erased: -1 }],
    ['fractional', { id_slot: 0, n_erased: .5 }], ['unsafe-integer', { id_slot: 0, n_erased: 2 ** 53 }], ['extra-key', { id_slot: 0, n_erased: 0, other: true }]])
    await scenario('invalid erase ' + name + ' stops before inference', { erase }, 'invalid');
  await scenario('valid erase followed by cancellation sends no inference', { erase: { id_slot: 0, n_erased: 0 }, abortDuringJson: true }, 'cancel');
  await scenario('wrong-slot proof wins over simultaneous JSON-stage abort', { erase: { id_slot: 1, n_erased: 0 }, abortDuringJson: true }, 'invalid');
  await scenario('fetch AbortError maps to original caller cancellation', { transportAbort: true }, 'cancel');
  await scenario('HTTP hard error survives simultaneous abort and cancel-body error', { httpAbort: true }, 'http');
  await scenario('JSON hard error survives simultaneous abort', { badJson: true, abortDuringJson: true }, 'badjson');
  await scenario('real transport timeout stops without inference', { timeout: true }, 'timeout');
  await scenario('post-erase source error identity survives abort and cleanup failure', { erase: { id_slot: 0, n_erased: 3 }, guardAfterErase: true, cleanupFailure: true }, 'privacy');
  await scenario('bad erase is not replaced by an observer cleanup failure', { erase: { id_slot: 1, n_erased: 0 }, cleanupFailure: true }, 'invalid');
  await scenario('joint513 is refused before erase or inference', { tooLong: true }, 'overlimit');
  await scenario('unsafe embedding endpoint is refused before any API work', { unsafe: true }, 'unsafe');
  for (const reason of [0, false, '']) {
    await scenario('falsy transport cancellation preserved: ' + JSON.stringify(reason), { transportAbort: true, cancelReason: reason }, 'cancel');
    await scenario('falsy post-erase source failure preserved: ' + JSON.stringify(reason), { erase: { id_slot: 0, n_erased: 0 }, guardAfterErase: true, guardReason: reason }, 'privacy');
  }
  const report = { schemaVersion: 1, status: results.every(x => x.pass) ? 'PASS' : 'FAIL', adapterSourceSha256: hash(source), testScriptSha256: hash(fs.readFileSync(__filename)), runtimeLockSha256: null, actualApiSlicesSha256: hash(slices.join('\n')),
    sourceStable: hash(fs.readFileSync(file)) === hash(source), results,
    limits: ['Real module API path source slices, fake transport and owned termination proof only; no model/compile/network/asset verification.', 'No real OS native lifecycle claim from this fake test. Actual job owner proof is covered by separate native lifecycle receipts.'] };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, status: report.status, pass: results.filter(x => x.pass).length, fail: results.filter(x => !x.pass).length }));
  if (report.status !== 'PASS') process.exitCode = 1;
})();
