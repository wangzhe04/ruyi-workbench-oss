'use strict';
// Rebind a locally pinned offline profile to this frozen worker, keeping all asset and license checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../semantic-runtime/gemma2-source/embeddinggemma2-live-contract.cjs');
const { validate } = require('../semantic-runtime/gemma2-profile-validation.cjs');

async function prepare(baseDir, baseDigest, destination) {
  const input = fs.readFileSync(path.join(baseDir, 'asset-lock.json'));
  assert.match(baseDigest, /^[a-f0-9]{64}$/);
  assert.equal(contract.hash(input), baseDigest, 'base profile digest');
  const lock = JSON.parse(input);
  lock.spec = contract.SPEC;
  lock.sourceBindings = [];
  for (const part of ['contract', 'worker', 'host', 'profile-prepare']) {
    const file = path.join(__dirname, '../semantic-runtime/gemma2-source', 'embeddinggemma2-live-' + part + '.cjs');
    lock.sourceBindings.push({ file, bytes: contract.strictFile(file).size, sha256: await contract.digest(file) });
  }
  lock.workerFile = lock.sourceBindings[1].file;
  await validate(lock).verify(lock);
  const bytes = Buffer.from(JSON.stringify(lock, null, 2) + '\n');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'asset-lock.json'), bytes, { flag: 'wx' });
  return { lockSha256: contract.hash(bytes), model: contract.fingerprint(lock), space: contract.vectorSpaceId(lock) };
}

if (require.main === module) {
  prepare(...process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = { prepare };
