'use strict';
// Independent, no-model audit. Only train/cal metadata is projected out of the
// development fixture; no acceptance fixture or check query is evaluated.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const vm = require('node:vm'), assert = require('node:assert/strict');
const base = path.resolve('output/semantic-mmarco-dual-output-v1');
const output = path.resolve(process.argv[2]);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => sha(fs.readFileSync(file));
const collector = path.join(__dirname, 'calibration-mmarco-dual.cjs');
const collectorText = fs.readFileSync(collector, 'utf8');
const plan = read(path.join(base, 'collection-plan.json'));
const collection = read(path.join(base, 'collection-v1.json'));
const fixtureFile = path.join(__dirname, 'calibration-fixture.cjs');
const fixture = (() => {
  const all = require(fixtureFile);
  return { documents: all.documents, queries: all.queries.filter(q => q.split === 'train' || q.split === 'calibration') };
})();
const result = { schemaVersion: 1, status: 'RUNNING', modelsRun: 0,
  sources: [__filename, collector, fixtureFile, path.join(base, 'collection-plan.json'), path.join(base, 'collection-v1.json'), path.join(base, 'export-receipt.json')]
    .map(file => ({ file, bytes: fs.statSync(file).size, sha256: hash(file) })), checks: [] };
function check(name, work) { work(); result.checks.push({ name, passed: true }); }
try {
  check('historical collector, fixture, plan and export identity', () => {
    for (const item of collection.sources) assert.equal(hash(item.file), item.sha256);
    assert.equal(collection.fixtureSha256, hash(fixtureFile));
    assert.equal(plan.fixtureSha256, hash(fixtureFile));
    assert.equal(plan.exportReceiptSha256, hash(path.join(base, 'export-receipt.json')));
    assert.deepEqual(collection.plan, plan);
  });
  check('one to one ID/order and finite normalized 384-dimensional vectors', () => {
    for (const [kind, items, expected] of [['documents', collection.documents, fixture.documents], ['queries', collection.queries, fixture.queries]]) {
      assert.deepEqual(items.map(x => x.id), expected.map(x => x.id));
      assert.equal(new Set(items.map(x => x.id)).size, items.length);
      assert.equal(items.length, plan.encoding[kind]);
      for (const item of items) {
        assert(item.tokens > 0 && item.tokens <= 512);
        for (const mode of ['cls', 'mean']) {
          assert.equal(item[mode].length, 384); assert(item[mode].every(Number.isFinite));
          assert(Math.abs(Math.hypot(...item[mode]) - 1) < 1e-10);
        }
      }
    }
  });
  check('all 36 fixed paired classifier inputs are aligned and original logits exactly equal', () => {
    const queries = fixture.queries.filter(q => q.split === 'train' && q.kind === 'positive' && ['zh-zh','zh-en','en-zh','en-en'].includes(q.group)).slice(0, 12);
    const expectedPairs = queries.flatMap(q => {
      const i = fixture.documents.findIndex(d => q.relevant.includes(d.id)); assert(i >= 0);
      return [i, (i+1)%fixture.documents.length, (i+17)%fixture.documents.length].map(index => {
        const d = fixture.documents[index]; return { queryId: q.id, documentId: d.id, querySha256: sha(q.text), documentSha256: sha(d.text) };
      });
    });
    assert.deepEqual(plan.pairs, expectedPairs); assert.equal(expectedPairs.length, 36);
    assert.equal(sha(JSON.stringify(expectedPairs)), plan.pairsSha256);
    const a = collection.pairChecks.original.scores, b = collection.pairChecks.hidden.scores;
    assert.equal(a.length, 36); assert.equal(b.length, 36); assert(a.every(Number.isFinite)); assert.deepEqual(a,b);
    assert.deepEqual(collection.logitEquivalence, { pairs: 36, maxAbsoluteDifference: 0, exactlyEqual: true });
  });
  check('actual collector pooling function honors masks, CLS position and L2', () => {
    const begin = collectorText.indexOf('function normalized('), end = collectorText.indexOf('function metrics(');
    assert(begin >= 0 && end > begin);
    const pools = vm.runInNewContext(collectorText.slice(begin, end) + ';pools');
    const data = new Float32Array(3*384); data[0]=1; data[384]=10000; data[385]=10000; data[2*384+1]=3;
    const out = pools({ type:'float32', dims:[1,3,384], data }, { data:BigInt64Array.from([1n,0n,1n]) });
    assert.equal(out.cls[0],1); assert.equal(out.cls[1],0);
    assert(Math.abs(out.mean[0]-1/Math.sqrt(10)) < 1e-14); assert(Math.abs(out.mean[1]-3/Math.sqrt(10)) < 1e-14);
    assert.throws(() => pools({type:'float32',dims:[1,3,384],data},{data:BigInt64Array.from([0n,0n,0n])}));
  });
  result.metrics = {};
  check('independent ID-based cosine ranking and positive-only language denominators', () => {
    const positive = fixture.queries.filter(q => q.kind === 'positive' && ['zh-zh','zh-en','en-zh','en-en'].includes(q.group));
    for (const mode of ['cls','mean']) {
      const qmap = new Map(collection.queries.map(q => [q.id,q[mode]])), dmap = new Map(collection.documents.map(d => [d.id,d[mode]]));
      const rows = positive.map(q => {
        const vector = qmap.get(q.id);
        const scored = fixture.documents.map((d,index) => {
          const doc = dmap.get(d.id); let score=0; for(let j=0;j<384;j++) score+=vector[j]*doc[j];
          return {id:d.id,index,score};
        }).sort((a,b) => b.score-a.score || a.index-b.index);
        return {id:q.id,split:q.split,group:q.group,rank:scored.findIndex(d => q.relevant.includes(d.id))+1};
      });
      assert.deepEqual(rows, collection.retrieval[mode].rows);
      const splits = {};
      for(const split of ['train','calibration','combined']) {
        splits[split]={};
        for(const group of ['zh-zh','zh-en','en-zh','en-en']) {
          const eligible = rows.filter(r => r.group===group && (split==='combined'||r.split===split));
          assert(eligible.length>0);
          splits[split][group]={count:eligible.length,recall:Object.fromEntries([1,5,10,20].map(k => [k,eligible.filter(r => r.rank>0&&r.rank<=k).length/eligible.length]))};
        }
      }
      assert.deepEqual(splits,collection.retrieval[mode].splits);
      result.metrics[mode]=splits;
      assert.equal(collection.retrieval[mode].viableAt20,false);
    }
    assert.equal(collection.status,'RED_RAW_RECALL_AT20');
  });
  result.counts={documents:collection.documents.length,trainCalibrationQueries:collection.queries.length,pairs:36};
  result.status='PASS_INDEPENDENT_ALIGNMENT_POOLING_AND_METRIC_AUDIT';
  result.limits=['No inference rerun; saved individual vectors cannot independently prove the original native tensor values.', 'No acceptance data or check query evaluated; all retrieval metrics use train/cal positive queries only.', 'Correct extraction/alignment does not turn a classifier into a trained bi-encoder; observed raw R20 remains RED.', 'Physical batch one, CLS index zero, native special tokens included in masked mean; no alternative pooling or parameter search.'];
} catch(error) { result.status='FAIL'; result.error=String(error.stack||error); process.exitCode=1; }
fs.mkdirSync(path.dirname(output),{recursive:true}); fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,checks:result.checks.length,counts:result.counts,error:result.error,output}));
