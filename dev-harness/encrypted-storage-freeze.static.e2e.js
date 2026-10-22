'use strict';
// M3-1 closure gate. The census is only worth freezing if it cannot silently drift:
// every durable surface classified once, purposes identical on both sides, no family claiming
// encryption that does not exist yet, and the envelope constants matching the code.
const fs = require('fs');
const path = require('path');
const freeze = require('./encrypted-storage-freeze.js');
const inventory = require('./durable-state-inventory.js');
const { constBlock, functionBlock } = require('./lib/source-slice');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
function ok(value, label) { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } }

try {
  const data = freeze.check();
  const sources = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '01n-work-data-crypto.js'), 'utf8');
  const codePurposes = freeze.codePurposes();

  ok(data.count === inventory.entries.length && data.entries.length === data.count,
    `every durable surface is classified exactly once (${data.count} of ${inventory.entries.length})`);
  ok(data.entries.every(entry => ['required', 'excluded'].includes(entry.encryption)), 'every surface has an encryption class');
  ok(data.entries.every(entry => entry.reason && entry.reason.length > 20), 'every classification carries an auditable reason');
  ok(data.entries.filter(entry => entry.encryption === 'required').length === data.classCounts.required
    && data.entries.filter(entry => entry.encryption === 'excluded').length === data.classCounts.excluded,
    'class counts match the entries');
  ok(data.entries.filter(entry => entry.encryption === 'required').every(entry => codePurposes.includes(entry.keyPurpose)),
    'every required family names a purpose that exists in WorkDataCrypto.PURPOSES');
  ok(new Set(data.entries.filter(entry => entry.encryption === 'required').map(entry => entry.keyPurpose)).size === codePurposes.length,
    'every frozen purpose owns at least one family');
  ok(data.entries.filter(entry => entry.encryption === 'required')
    .every(entry => entry.plaintextMetadata.every(field => field.field && field.why && field.why.length > 10)),
    'every readable plaintext field is individually justified');
  ok(data.entries.filter(entry => entry.encryption === 'required')
    .every(entry => !entry.plaintextMetadata.some(field => /title|gist|path|url|prompt|body|text/i.test(field.field))),
    'no title/gist/path/url/prompt/body field is declared readable metadata');
  ok(data.entries.filter(entry => entry.encryption === 'excluded').every(entry => entry.keyPurpose === null && entry.migrationBatch === 'not-migrated'),
    'excluded families claim neither a key purpose nor a migration batch');
  for (const id of ['credential-vault-v1', 'credential-import-v1', 'privacy-mapping-v1', 'external-bot-credentials']) {
    ok(data.entries.some(entry => entry.id === id && entry.encryption === 'excluded'), `${id} stays in its own credential envelope`);
  }
  ok(data.encryptionImplemented === false && !data.entries.some(entry => entry.implemented === true),
    'M3-1 froze the contract only: no family may claim encryption before M3-2 exists');
  ok(JSON.stringify(data.purposes) === JSON.stringify(codePurposes), 'generated purposes equal the code purpose list');
  ok(data.envelope.formatVersion === Number((constBlock(sources, 'FORMAT_VERSION') || '').match(/=\s*(\d+)/)?.[1] || NaN),
    'artifact envelope format version matches WorkDataCrypto.FORMAT_VERSION');
  ok((constBlock(sources, 'KEY_PREFIX') || '').includes("'" + data.envelope.keyIdPrefix + "'"),
    'artifact key id prefix matches WorkDataCrypto.KEY_PREFIX');
  ok(/hkdfSync\('sha256'/.test(functionBlock(sources, 'deriveKey') || ''), 'purpose keys come from HKDF-SHA256, not from reusing the master');
  const deriveBlock = functionBlock(sources, 'deriveKey') || '';
  ok(deriveBlock.includes("'purpose:'") && deriveBlock.includes("':k'") && deriveBlock.includes('checkGeneration(generation)'),
    'derivation binds both purpose and generation, so rotation changes key material instead of only the label');
  ok(data.envelope.derivation.includes(freeze.codeSalt()) && data.envelope.derivation.includes(':k<generation>'),
    'artifact derivation description is composed from the sliced salt and the generation-bound info');
  ok(data.batchCounts.sessions > 0 && data.batchCounts['memory-queue'] > 0 && data.batchCounts.tasks > 0,
    'sessions, memory-queue and tasks each own a migration batch (M3-2 order)');
} catch (error) { console.error(error.stack || error); failures++; }

if (failures) process.exitCode = 1;
