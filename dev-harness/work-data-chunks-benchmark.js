'use strict';
// Synthetic, source-driven capacity measurement. Each size/concurrency case gets an independent
// process and temporary data directory. No service, network, user home or generated server is used.
// node --expose-gc dev-harness/work-data-chunks-benchmark.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadWorkDataChunks } = require('./lib/work-data-chunks-fixture');
const child = process.argv.indexOf('--case');
if (child < 0) {
  for (const size of [40, 64, 128, 256]) {
    for (const concurrency of [1, 2]) {
      const result = spawnSync(process.execPath, ['--expose-gc', __filename, '--case', String(size), String(concurrency)], { encoding: 'utf8', windowsHide: true });
      process.stdout.write(result.stdout || '');
      if (result.status !== 0) { process.stderr.write(result.stderr || 'benchmark failed\n'); process.exitCode = 1; break; }
    }
    if (process.exitCode) break;
  }
} else {
  const size = Number(process.argv[child + 1]), concurrency = Number(process.argv[child + 2]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-chunks-bench-'));
  const api = loadWorkDataChunks(), key = crypto.randomBytes(32);
  const cap = api.chunks.MAX_PLAINTEXT_BYTES;
  if (global.gc) global.gc();
  const baseline = process.memoryUsage(), peak = { ...baseline };
  const sample = () => { const next = process.memoryUsage(); for (const name of Object.keys(peak)) peak[name] = Math.max(peak[name], next[name]); };
  const interval = setInterval(sample, 5);
  (async () => {
    const records = [];
    for (let i = 0; i < concurrency; i++) {
      // Real archive-like object shape; JSON serialization and retained domain objects count toward
      // the observed peak instead of hiding them outside the measurement window.
      const value = { schema: 1, sessionId: 'benchmark-' + i, messages: [{ role: 'user', createdAt: '2026-10-23T00:00:00.000Z', content: '' }] };
      const overhead = Buffer.byteLength(JSON.stringify(value));
      value.messages[0].content = String(i).repeat(size * 1024 * 1024 - overhead);
      const text = JSON.stringify(value);
      const file = path.join(root, 'record-' + i + '.json');
      records.push({ value, text, file, store: api.store.createText({ file: () => file, chunked: true,
        maxPlaintextBytes: cap, purpose: 'memory', schema: 1, scopeId: 'benchmark', recordId: 'archive-' + i,
        keys: { unlock: async () => key, instance: async () => 'benchmark-instance' }, enabled: async () => true,
        writeJson: api.atomicWriteJson }) });
    }
    sample();
    const writeAt = performance.now();
    await Promise.all(records.map(record => record.store.write(record.text)));
    const writeMs = performance.now() - writeAt; sample();
    const readAt = performance.now();
    const opened = await Promise.all(records.map(record => record.store.read()));
    const readMs = performance.now() - readAt;
    for (let i = 0; i < records.length; i++) {
      if (opened[i] !== records[i].text) throw new Error('round-trip mismatch');
      const domain = JSON.parse(opened[i]);
      if (domain.messages[0].content.length !== records[i].value.messages[0].content.length) throw new Error('domain mismatch');
      sample();
    }
    sample();
    console.log(JSON.stringify({ sizeMiB: size, concurrency, plainBytes: records.map(record => Buffer.byteLength(record.text)),
      diskBytes: records.map(record => fs.statSync(record.file).size), writeMs: Math.round(writeMs), readMs: Math.round(readMs),
      baseline, peak, peakRssMiB: Math.round(peak.rss / 1048576), processMaxRssKiB: process.resourceUsage().maxRSS }));
  })().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; }).finally(() => {
    clearInterval(interval); key.fill(0);
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ruyi-chunks-bench-')) throw new Error('unexpected benchmark directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
}
