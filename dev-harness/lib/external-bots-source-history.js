'use strict';
// Exact historical source is test data, never a runtime downgrade or a service import.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../..'),src=()=>fs.readFileSync(path.join(repo,'ruyi-workbench/app/src/13w-external-bots.js'),'utf8'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const replyRetryContracts=require('../fixtures/external-bots-retry/contracts.json');
function beforeRetention(value) {
  const history=require('../fixtures/external-bots-retention/history.json');
  if(hash(value)!==history.sha256)return value;
  for(const row of [...history.inverseSpans].reverse()){assert.equal(value.split(row.before).length,2);value=value.replace(row.before,row.after);}
  assert.equal(hash(value),history.baseSha256);return value;
}
function beforeRetentionAuth(value) {
  const {auth}=require('../fixtures/external-bots-retention/history.json');
  assert.equal(hash(value),auth.sha256);assert.equal(value.split(auth.rows).length,2);value=value.replace(auth.rows,'');
  assert.equal(hash(value),auth.baseSha256);return value;
}
function historicalSource(version) {
  const history=require('../fixtures/external-bots-cancel/history.json');
  let value=beforeRetention(src());
  if (hash(value) === history.v5?.sha256) {
    for (const row of [...history.v5.inverseSpans].reverse()) {
      assert.equal(value.split(row.before).length,2);value=value.replace(row.before,row.after);
    }
  }
  if (hash(value) === history.v4?.sha256) {
    for (const row of [...history.v4.inverseSpans].reverse()) {
      assert.equal(value.split(row.before).length,2); value=value.replace(row.before,row.after);
    }
  }
  assert.equal(hash(value),history.v3Sha256);
  if (version==='v3') return value;
  for(const row of [...history.v2.inverseSpans].reverse()) {
    assert.equal(value.split(row.before).length,2);value=value.replace(row.before,row.after);
  }
  assert.equal(crypto.createHash('sha256').update(value).digest('hex'),history.v2.sha256);
  if(version==='v2')return value;
  assert.equal(version,'v1');const lines=value.split('\n');
  for(const row of [...history.v1.inverseHunks].reverse()) {
    assert.equal(lines.slice(row.start,row.start+row.before.length).join('\n'),row.before.join('\n'));
    lines.splice(row.start,row.before.length,...row.after);
  }
  value=lines.join('\n');assert.equal(crypto.createHash('sha256').update(value).digest('hex'),history.v1.sha256);return value;
}
function replyRetrySourceV2(value) {
  value=beforeRetention(value);
  if(hash(value)===replyRetryContracts.hint.sha256)for(const row of [...replyRetryContracts.hint.spans].reverse()){assert.equal(value.split(row.after).length,2);value=value.replace(row.after,row.before);}
  assert.equal(hash(value),replyRetryContracts.product.sha256);return value;
}
function retryCoreSource(value=src()) {
  value=replyRetrySourceV2(value);
  for(const row of [...replyRetryContracts.apiSpans].reverse()) {assert.equal(value.split(row.after).length,2);value=value.replace(row.after,row.before);}
  assert.equal(hash(value),replyRetryContracts.product.coreSha256);return value;
}
module.exports={historicalSource,retryCoreSource,replyRetryContracts,replyRetrySourceV2,beforeRetention,beforeRetentionAuth};
