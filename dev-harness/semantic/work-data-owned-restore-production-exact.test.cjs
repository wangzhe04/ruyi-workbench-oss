'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const pairs=[['01ab-work-data-full-snapshot.js','./work-data-owned-restore-production-preview.cjs'],['13aq-work-data-native-adapters.js','./work-data-owned-restore-adapter-production-preview.cjs'],['13u-migration-center.js','./work-data-owned-restore-native-production-preview.cjs']];
for(const [file,tool] of pairs)test('production exact reviewed transform '+file,()=>{const old=fs.readFileSync('output/semantic-gemma-q4-backup-diagnostic-v1/source-input/src/'+file,'utf8'),actual=fs.readFileSync('ruyi-workbench/app/src/'+file,'utf8');assert.equal(actual,require(tool).transform(old));});
