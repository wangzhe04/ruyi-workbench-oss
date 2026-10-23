'use strict';
// Source-driven fixture: exercise the exact crypto/store/atomic writer before root regenerates server.
// No simulated storage implementation, DPAPI, service boot or real home is involved.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { constBlock, functionBlock } = require('./source-slice');
function loadWorkDataChunks(overrides = {}) {
  const source = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
  const code = [source('01h-privacy-core.js'), constBlock(source('01n-work-data-crypto.js'), 'WorkDataCrypto'),
    constBlock(source('01r-work-data-chunks.js'), 'WorkDataChunks'), constBlock(source('01p-work-data-store.js'), 'WorkDataStore'),
    functionBlock(source('01-config.js'), 'atomicWriteJson')].join('\n');
  const context = { require, Buffer, console, process, setTimeout, clearTimeout, crypto,
    fsp: overrides.fsp || fsp, ...overrides };
  return vm.runInNewContext(code + '\n({ chunks:WorkDataChunks, store:WorkDataStore, crypto:WorkDataCrypto, privacy:PrivacyCore, atomicWriteJson })', context);
}
module.exports = { loadWorkDataChunks };
