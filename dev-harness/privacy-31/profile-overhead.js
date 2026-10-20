'use strict';
// Local synthetic gateway costs only; no model, HTTP, user config or real credentials.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { fixture, gateway } = require('../lib/privacy-test-fixture');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-profile-cost-'));
async function main() {
  const rows = [];
  try {
    for (const mode of ['off', 'basic', 'enhanced', 'strict']) {
      const f = fixture(); let seals = 0, scans = 0;
      const seal = f.vault.sealLocal;
      const g = gateway(root, { ...f, vault: { ...f.vault, sealLocal: (...args) => { seals++; return seal(...args); } }, PrivacyRegex: { ...f.PrivacyRegex, scan: (...args) => { scans++; return f.PrivacyRegex.scan(...args); } } });
      const config = { credentialEncryptionV1: mode !== 'off', privacyModeV1: mode, privacyTechnicalV1: false, privacyRulesV1: [], providers: [] };
      const body = { messages: [{ role: 'user', content: 'public text '.repeat(256) + 'contact profile@example.test password="profile-synthetic-secret"' }] };
      const result = { content: 'profile@example.test password="profile-synthetic-secret"' };
      const input = { name: 'file_write', rawArgs: JSON.stringify({ content: 'profile@example.test' }) };
      const samples = []; g.configure(config);
      await g.run('overhead-' + mode, config, async () => {
        for (let i = 0; i < 101; i++) {
          const before = performance.now();
          const protectedBody = await g.beforeModelRequest(body), protectedResult = await g.modelToolResult(result);
          g.prepareCall(input);
          if (mode === 'off') { assert.equal(protectedBody, body); assert.equal(protectedResult, result); }
          if (i) samples.push(performance.now() - before);
        }
      });
      samples.sort((a, b) => a - b);
      rows.push({ mode, iterations: samples.length, inputChars: body.messages[0].content.length, medianMs: +samples[49].toFixed(4), p95Ms: +samples[94].toFixed(4), seals, regexWorkerScans: scans });
      assert.equal(scans, 0, 'no custom regex means no regex worker');
      assert.equal(seals, mode === 'off' ? 0 : 1, 'stable references persist once; off never encrypts');
      f.vault.clear();
    }
    const report = { schema: 1, node: process.version, platform: process.platform, sourceSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/03a-privacy-gateway.js'))).digest('hex'), synthetic: true, networkCalls: 0, storageProtector: 'synthetic wrapper with real AES; DPAPI startup and model latency excluded', rows };
    const output = process.argv.find(value => value.startsWith('--report='))?.slice(9);
    if (output) fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (path.dirname(root) !== temp || !path.basename(root).startsWith('ruyi-profile-cost-')) throw Error('cleanup_scope');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
