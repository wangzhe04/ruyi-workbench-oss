'use strict';
// Exact source codec/store/journal owner, usable before the generated runtime is rebuilt.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { constBlock } = require('./source-slice');
const { loadWorkDataChunks } = require('./work-data-chunks-fixture');
function loadWorkDataJournals(options = {}) {
  const base = loadWorkDataChunks(options), io = options.io || fsp;
  const source = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
  const context = { require: name => name === 'node:fs/promises' ? io : require(name), Buffer,
    WorkDataCrypto: base.crypto, WorkDataChunks: base.chunks, WorkDataStore: base.store };
  const records = vm.runInNewContext(constBlock(source('01q-work-data-records.js'), 'WorkDataRecords') + '\nWorkDataRecords;', context);
  const journals = vm.runInNewContext(constBlock(source('01s-work-data-journals.js'), 'WorkDataJournals') + '\nWorkDataJournals;', { ...context, WorkDataRecords: records });
  return { ...base, WorkDataCrypto: base.crypto, WorkDataChunks: base.chunks, WorkDataStore: base.store,
    WorkDataRecords: records, WorkDataJournals: journals };
}
module.exports = { loadWorkDataJournals };
