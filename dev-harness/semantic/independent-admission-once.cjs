'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const cp = require('node:child_process');
const readline = require('node:readline');

const [sealedPath, packagePath, verifiedProfile, privatePath, reportPath] = process.argv.slice(2);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => digest(fs.readFileSync(file));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = file => fs.readFileSync(path.join(sealedPath, file), 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
const save = (dir, file, value) => fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
const utc = () => new Date().toISOString();

function checkManifest(protocol) {
  const manifest = path.join(sealedPath, 'SHA256SUMS');
  assert.equal(fileHash(manifest), protocol.holdoutManifest);
  const names = new Set();
  for (const line of fs.readFileSync(manifest, 'ascii').trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([\w.-]+)$/.exec(line);
    assert.ok(match && !names.has(match[2]));
    names.add(match[2]);
    assert.equal(fileHash(path.join(sealedPath, match[2])), match[1]);
  }
  assert.deepEqual([...names].sort(), ['candidates.jsonl','coverage.json','gold.jsonl','pools.jsonl','protocol.md','queries.jsonl','verify.py']);
}

function normalized(vector) {
  assert.equal(vector.length, 768);
  const norm = Math.hypot(...vector);
  assert.ok(Number.isFinite(norm) && norm > 0);
  return vector.map(x => x / norm);
}

async function encodeInputs(provider, settings, protocol, batches) {
  let worker;
  try {
    await provider.verify(settings, () => {});
    worker = cp.spawn(settings.command, settings.args, {cwd:settings.cwd, env:settings.env,
      windowsHide:true, stdio:['pipe','pipe','ignore']});
    await new Promise((resolve,reject) => {worker.once('spawn',resolve); worker.once('error',reject);});
  } catch (err) {settings.onSpawnFailure(); throw err;}
  const closed = new Promise(resolve => worker.once('close', resolve));
  const lines = readline.createInterface({input:worker.stdout})[Symbol.asyncIterator]();
  async function next(timeout) {
    let timer;
    try {
      const result = await Promise.race([lines.next(), new Promise((_,reject) => {
        timer = setTimeout(() => reject(Error('worker reply timeout')), timeout);
      })]);
      assert.ok(!result.done);
      return JSON.parse(result.value);
    } finally {clearTimeout(timer);}
  }
  try {
    os.setPriority(worker.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    const ready = await next(120000);
    assert.equal(ready.ok,true);
    provider.validateReady(ready);
    assert.equal(ready.modelFingerprint, protocol.modelFingerprint);
    let sequence = 0;
    const outputs = [];
    for (const {role, texts} of batches) {
      const vectors = [];
      for (let offset = 0; offset < texts.length; offset += 4) {
        const input = texts.slice(offset,offset + 4);
        const requestId = 'batch' + ++sequence;
        worker.stdin.write(JSON.stringify({requestId,op:'encode',role,texts:input,deadlineMs:Date.now()+60000}) + '\n');
        const reply = await next(70000);
        assert.equal(reply.requestId,requestId);
        assert.equal(reply.ok,true,reply.error?.code);
        provider.validateReply(reply,input);
        assert.equal(reply.vectors.length,input.length);
        vectors.push(...reply.vectors.map(normalized));
      }
      outputs.push(vectors);
    }
    return outputs;
  } finally {
    worker.stdin.end();
    const force = setTimeout(() => worker.kill(),7000);
    await closed;
    clearTimeout(force);
    settings.onObservedExit();
  }
}

const dot = (a,b) => a.reduce((sum,x,i) => sum + x * b[i],0);

function predictions(queries, pools, documents, windows, vectors, protocol) {
  const [notes, anchors, prompts] = vectors;
  const fields = new Map(documents.map(d => [d.candidate_id,[]]));
  windows.forEach((w,i) => fields.get(w.id).push(notes[i]));
  return queries.map((query,i) => {
    const prompt = prompts[i];
    const reference = anchors.reduce((sum,a) => sum + dot(prompt,a),0) / anchors.length;
    const scores = pools.get(query.pool_id).map((id,order) => ({
      id,order,score:Math.max(...fields.get(id).map(v => dot(prompt,v)))
    })).sort((a,b) => b.score - a.score || a.order - b.order);
    const baseline = scores.filter(v => v.score >= protocol.absoluteFloor);
    const candidate = baseline.filter(v => v.score - reference >= protocol.referenceMargin);
    return {query_id:query.query_id, poolSize:scores.length, baseline:baseline.slice(0,5).map(v => v.id),
      candidate:candidate.slice(0,5).map(v => v.id)};
  });
}

function summarize(items) {
  const positives = items.filter(x => x.target !== null);
  const negatives = items.filter(x => x.target === null);
  const out = {positive:positives.length, negative:negatives.length};
  for (const rule of ['baseline','candidate']) {
    const ranks = positives.map(x => x[rule].indexOf(x.target)+1);
    out[rule] = {first:ranks.filter(k => k === 1).length, firstFive:ranks.filter(Boolean).length,
      mrrAtFive:positives.length ? Number((ranks.reduce((s,k) => s+(k ? 1/k : 0),0)/positives.length).toFixed(8)) : null,
      falseAccepts:negatives.filter(x => x[rule].length > 0).length};
  }
  return out;
}

function grouped(items, by) {
  return Object.fromEntries([...new Set(items.map(by))].sort().map(group => [group,summarize(items.filter(x => by(x) === group))]));
}

async function main() {
  const configFile = path.join(reportPath,'preregistration.json');
  const protocol = readJson(configFile);
  const registrationSha256 = fileHash(configFile);
  assert.equal(registrationSha256, fs.readFileSync(path.join(reportPath,'preregistration.sha256'),'utf8').trim());
  assert.equal(fileHash(__filename),protocol.instrument);
  assert.equal(fileHash(path.join(packagePath,'semantic-runtime/gemma2-provider.cjs')),protocol.provider);
  assert.equal(fileHash(path.join(packagePath,'semantic-runtime/gemma2-profile-validation.cjs')),protocol.profileValidator);
  assert.equal(fileHash(path.join(verifiedProfile,'asset-lock.json')),protocol.assetLock);
  const referenceFile = path.join(__dirname,'admission-dev-corpus.cjs');
  const {anchors} = require(referenceFile);
  assert.equal(fileHash(referenceFile),protocol.referenceModule);
  assert.equal(anchors.length,32);
  assert.equal(digest(JSON.stringify(anchors)),protocol.referenceArray);
  // The gold file is only streamed as opaque bytes for the manifest hash here.
  checkManifest(protocol);
  fs.mkdirSync(privatePath,{recursive:false});
  const isolatedProfile = path.join(privatePath,'profile');
  fs.mkdirSync(isolatedProfile);
  fs.copyFileSync(path.join(verifiedProfile,'asset-lock.json'),path.join(isolatedProfile,'asset-lock.json'),fs.constants.COPYFILE_EXCL);
  const provider = require(path.join(packagePath,'semantic-runtime/gemma2-provider.cjs')).create({
    directory:isolatedProfile,lockSha256:protocol.assetLock,enabled:() => true,clientFactory:x => x});
  const start = utc();
  save(reportPath,'started.json',{utc:start,registrationSha256});
  const documents = rows('candidates.jsonl');
  const pools = new Map(rows('pools.jsonl').map(p => [p.pool_id,p.candidate_ids]));
  const queries = rows('queries.jsonl');
  const windows = documents.flatMap(d => {
    const result = [];
    for(let at=0; at<d.text.length; at+=80) {
      result.push({id:d.candidate_id,text:d.text.slice(at,at+96)});
      if(at+96>=d.text.length) break;
    }
    return result;
  });
  const vectors = await encodeInputs(provider, provider.settings(), protocol, [
    {role:'document',texts:windows.map(w => w.text)}, {role:'document',texts:anchors},
    {role:'query',texts:queries.map(q => q.query)}
  ]);
  const predictionsFile = 'rankings.json';
  save(privatePath,predictionsFile,predictions(queries,pools,documents,windows,vectors,protocol));
  const predictionSha256 = fileHash(path.join(privatePath,predictionsFile));
  save(reportPath,'predictions-sealed.json',{utc:utc(),registrationSha256,predictionSha256});
  const gold = new Map(rows('gold.jsonl').map(x => [x.query_id,x]));
  const sealedPredictions = readJson(path.join(privatePath,predictionsFile));
  assert.equal(gold.size,112);
  assert.equal(new Set(sealedPredictions.map(p => p.query_id)).size,gold.size);
  const cases = sealedPredictions.map(p => {
    const label = gold.get(p.query_id);
    return {...p,target:label.target_fields[0]?.candidate_id ?? null,category:label.category,form:label.form,
      direction:label.query_language+'->'+label.candidate_language};
  });
  const overall = summarize(cases);
  const directions = grouped(cases,x => x.direction);
  const chinese = directions['zh->zh'];
  const positives = cases.filter(x => x.target !== null);
  const negatives = cases.filter(x => x.target === null);
  const zhCases = cases.filter(x => x.direction === 'zh->zh');
  const recallHolds = group => group.candidate.first >= group.baseline.first && group.candidate.firstFive >= group.baseline.firstFive;
  const gates = {globalRecallHeld:recallHolds(overall),chineseMonolingualRecallHeld:recallHolds(chinese),
    falseAcceptsStrictlyReduced:overall.candidate.falseAccepts < overall.baseline.falseAccepts};
  const results = {overall,directions,poolSizes:grouped(cases,x => x.poolSize),negativeCategories:grouped(negatives,x => x.category),
    nearTopicAndChitchat:grouped(negatives,x => x.category === 'chitchat' ? 'chitchat' : 'near-topic'),
    negativeCategoryByDirection:grouped(negatives,x => x.direction+'/'+x.category),
    positiveForms:grouped(positives,x => x.form),chinesePositiveForms:grouped(zhCases.filter(x => x.target),x => x.form),
    chineseNegativeCategories:grouped(zhCases.filter(x => !x.target),x => x.category),
    chinesePoolSizes:grouped(zhCases,x => x.poolSize),gates,supportsNextStage:Object.values(gates).every(Boolean)};
  save(reportPath,'aggregate.json',results);
  save(reportPath,'receipt.json',{utc:utc(),registrationSha256,predictionSha256,aggregateSha256:fileHash(path.join(reportPath,'aggregate.json')),
    modelFingerprint:protocol.modelFingerprint,assetLockSha256:protocol.assetLock,holdoutManifestSha256:protocol.holdoutManifest,
    anchorsSha256:protocol.referenceArray,queries:queries.length,uniqueFields:documents.length,fieldWindows:windows.length,
    referenceDocuments:anchors.length,verifiedUntruncatedEncodes:queries.length+windows.length+anchors.length,comparisonRuns:1,
    sharedVectors:true,measureLatency:false,isolatedWorkerHome:true,goldParsedAfterPredictionSeal:true});
  console.log(JSON.stringify({overall,directions,gates}));
}

main().catch(e => {console.error(e.message);process.exitCode=1;});
