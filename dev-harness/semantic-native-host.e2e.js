// Opt-in native host qualification. No downloads, providers, user data or acceptance fixtures.
require('./lib/self-isolate-home.js');
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { PassThrough } = require('node:stream');
const { createRunner } = require('./lib/harness');
const t = createRunner('SEMANTIC NATIVE HOST'), { ok } = t;
const root = process.env.RUYI_NATIVE_TEST_ROOT;
const file = path.resolve(__dirname, 'semantic/native-host-prototype.cjs');
const source = fs.readFileSync(file, 'utf8');
const api = vm.runInNewContext(source + '\nSemanticNativeClient;', { require, Buffer, Date, setTimeout, clearTimeout, fetch, AbortController, AbortSignal });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [], report = { schemaVersion: 1, generatedAt: new Date().toISOString(), sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  network: { applicationOffline: true, osFirewall: false }, limits: ['Explicit native host only. Default Node backend unchanged.', 'No hard-parent-kill claim for the default direct launcher; Job Object integration is separate.'] };
const shaFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let launchNative;
if (process.env.RUYI_NATIVE_TEST_JOB_HELPER) {
  const helperPath = path.resolve(process.env.RUYI_NATIVE_TEST_JOB_HELPER), sourcePath = path.resolve(__dirname, 'semantic/native-job-host.cs');
  const { createJobLauncher } = require('./semantic/native-job-launcher.cjs');
  launchNative = createJobLauncher({ helperPath, sourcePath, helperSha256: shaFile(helperPath), sourceSha256: shaFile(sourcePath) });
  report.jobLauncher = { helperSha256: shaFile(helperPath), helperSourceSha256: shaFile(sourcePath), launcherSha256: shaFile(path.resolve(__dirname, 'semantic/native-job-launcher.cjs')) };
}
function client(extra = {}) { const value = api.create({ root: path.resolve(root), enabled: async () => true, ...(launchNative ? { launchNative } : {}), ...extra }); clients.push(value); return value; }
async function poll(predicate, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await pause(20); } return false; }
(async () => {
  if (!root) { console.log('SKIP optional native assets: set RUYI_NATIVE_TEST_ROOT'); t.done(); return; }
  try {
    const main = client(), start = Date.now(), ready = await main.prepare({ budgetMs: 20000 }); report.ready = ready; report.prepareMs = Date.now() - start;
    ok(ready.available && ready.backend === 'llama.cpp-cpu' && ready.contract.physicalBatch === 1, 'strict native assets prepare without research script or fixture');
    const denied = new Error('privacy.synthetic_scope_changed'), before = main.stats();
    let deniedResult; try { await main.encode(['public sample'], { role: 'document', beforeEncode: async () => { throw denied; } }); } catch (error) { deniedResult = error; }
    ok(deniedResult === denied && main.stats().embeddingWrites === before.embeddingWrites, 'source guard rejection stays original and sends no model input');
    const q = await main.encode(['What is the capital of China?', 'Explain gravity'], { role: 'query' });
    const d = await main.encode(['The capital of China is Beijing.', 'Gravity is a force that attracts two bodies towards each other. It gives weight to physical objects and is responsible for the movement of planets around the sun.'], { role: 'document' });
    const dot = (a, b) => a.reduce((sum, value, n) => sum + value * b[n], 0);
    if (!q.ok || !d.ok) throw Error('official sanity inputs did not finish within unchanged one-second encode budget');
    const matrix = q.vectors.map(a => d.vectors.map(b => dot(a, b))), expected = [[.7714104304567193, .17570631574096274], [.1726304794448558, .5586212138374024]];
    report.matrix = matrix; report.matrixMaxDiff = Math.max(...matrix.flatMap((row, i) => row.map((value, j) => Math.abs(value - expected[i][j]))));
    ok(report.matrixMaxDiff < 1e-9, 'real physical1 official example exactly matches the fixed research representation');
    const zero = await main.encode(['public'], { role: 'query', budgetMs: 0 });
    ok(zero.reason === 'timeout' && main.stats().processAlive, 'empty budget writes nothing and preserves the healthy native process');
    const abort = new AbortController(), cancelled = new Error('synthetic.cancel'), prior = main.stats().embeddingWrites;
    const monitor = setInterval(() => { if (main.stats().embeddingWrites > prior) abort.abort(cancelled); }, 1);
    let caught; try { await main.encode(['A public ordinary sentence. '.repeat(40)], { role: 'document', signal: abort.signal }); } catch (error) { caught = error; } finally { clearInterval(monitor); }
    ok(caught === cancelled && !main.stats().processAlive, 'in-flight cancellation waits native close and throws the original reason');
    const slow = client(); await slow.prepare({ budgetMs: 20000 }); const timeoutAt = Date.now();
    const timed = await slow.encode(['A public ordinary sentence. '.repeat(60)], { role: 'document', budgetMs: 260 });
    report.deadline = { elapsedUntilExitMs: Date.now() - timeoutAt, result: { ok: timed.ok, reason: timed.reason }, stats: slow.stats() };
    ok(timed.reason === 'timeout' && !slow.stats().processAlive, 'real HTTP timeout owns cleanup and leaves no background native CPU');
    const loading = await slow.prepare({ budgetMs: 1000 });
    ok(loading.state === 'loading' && await poll(() => slow.descriptor().available), 'one background preparation recovers after timeout');
    let enabled = true; const disabled = client({ enabled: async () => enabled }); await disabled.prepare({ budgetMs: 20000 }); enabled = false;
    const off = await disabled.prepare(); ok(off.reason === 'disabled' && !disabled.stats().processAlive, 'disable revalidates and awaits actual native exit');
    const eof = new PassThrough(), pipe = client({ parentStream: eof }); await pipe.prepare({ budgetMs: 20000 }); eof.end(); eof.resume();
    ok(await poll(() => !pipe.stats().processAlive), 'explicit parent channel EOF reclaims the native process');
    await Promise.all(clients.map(value => value.stop('before-idle-check')));
    const idle = client({ idleMs: Number(process.env.RUYI_NATIVE_TEST_IDLE_MS) || 80 }); await idle.prepare({ budgetMs: 20000 }); const idleAt = Date.now();
    ok(await poll(() => !idle.stats().processAlive, 65000), 'configured idle timeout releases the real native process'); report.idleUntilExitMs = Date.now() - idleAt;
    report.stats = clients.map(value => value.stats()); report.status = t.failures ? 'FAIL' : 'PASS';
  } catch (error) { t.fail(error.stack || String(error)); report.status = 'FAIL'; report.error = String(error.stack || error); }
  finally {
    report.cleanupInitial = await Promise.all(clients.map(value => value.stop('test-complete')));
    // Earlier clients may see the last client's in-progress observation. Take
    // the final verdict only after every owned finalize promise has settled.
    report.cleanup = await Promise.all(clients.map(value => value.stop('test-complete-observed')));
    ok(report.cleanup.every(value => value.workerExited === true && value.cleanupStatus === 'observed'), 'all native exit proofs observed before the final verdict');
    report.status = t.failures ? 'FAIL' : 'PASS';
    if (process.env.RUYI_NATIVE_TEST_REPORT) fs.writeFileSync(path.resolve(process.env.RUYI_NATIVE_TEST_REPORT), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    t.done();
  }
})().catch(error => { t.fail(error.stack || String(error)); t.done(); });
