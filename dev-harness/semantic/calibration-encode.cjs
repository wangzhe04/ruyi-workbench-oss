'use strict';
// Encode only the new synthetic development fixture. Output never overwrites a prior run.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process'), readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { fixtureChildEnv } = require('../lib/fixture-home');
const { killOwnTree } = require('../lib/kill-own-tree');
const fixturePath = path.join(__dirname, 'calibration-fixture.cjs'), fixture = require(fixturePath);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
  const runtimeRoot = path.resolve(process.argv[2] || 'output/semantic-runtime-default-only');
  const output = path.resolve(process.argv[3] || 'output/semantic-calibration-v1-vectors.json');
  if (fs.existsSync(output)) throw Error('Use a new output file; prior evidence is immutable.');
  const contentMode=process.argv.includes('--content');
  const stripMode=process.argv.includes('--strip-ids');if(stripMode&&contentMode)throw Error('Representation experiments must remain separate.');
  const roleProbe=process.argv.includes('--role-probe');if(roleProbe&&(stripMode||contentMode))throw Error('Role probe must use original text.');
  const probeQueries=roleProbe?require('./calibration-language-projection-core.cjs').pairedTrainQueries(fixture).flatMap(pair=>[pair.zh,pair.en]):null;
  const strip=stripMode?require('./calibration-strip-ids.cjs'):null;
  const modelAt=process.argv.indexOf('--model'),modelId=modelAt>=0?process.argv[modelAt+1]:null;
  if(modelAt>=0&&!modelId)throw Error('Model id is required.');
  const rawPath=contentMode?path.resolve(process.argv[4]||'output/semantic-calibration-v2-vectors.json'):null;
  const raw=contentMode?JSON.parse(fs.readFileSync(rawPath,'utf8')):null;
  if(raw&&(raw.status!=='PASS'||raw.fixtureSha256!==hash(fs.readFileSync(fixturePath))))throw Error('Raw vector provenance mismatch.');
  const transformed=contentMode?fixture.queries.map(query=>({...query,...require('./calibration-content-query.cjs').contentQuery(query.text)})):stripMode?fixture.queries.map(query=>({...query,...strip.stripIds(query.text)})):null;
  const documentInputs=roleProbe?probeQueries:stripMode?fixture.documents.map(doc=>({...doc,...strip.stripIds(doc.text)})):fixture.documents;
  const toEncode=roleProbe?[]:contentMode?transformed.filter(query=>query.text&&query.changed):stripMode?transformed.filter(query=>query.text.trim()):fixture.queries;
  const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/semantic-runtime'), home = fixtureChildEnv({ perTest: true });
  const report = { schemaVersion: 1, status: 'RUNNING', generatedAt: new Date().toISOString(), fixtureSha256: hash(fs.readFileSync(fixturePath)),
    fixture: fixture.name, documents: [], queries: [], stderrBytes: 0, peakRssBytes: 0, truncated: [], requests: [] };
  if(roleProbe)report.roleProbe={kind:'train-paired-query-text-encoded-as-document',queryIds:probeQueries.map(q=>q.id),coreSha256:hash(fs.readFileSync(require.resolve('./calibration-language-projection-core.cjs')))};
  if(contentMode){report.contentPolicy=require('./calibration-content-query.cjs').rules;report.contentPolicySha256=hash(fs.readFileSync(path.join(__dirname,'calibration-content-rules.json')));report.rawVectorsSha256=hash(fs.readFileSync(rawPath));report.transformed=transformed.map(query=>({id:query.id,text:query.text,changed:query.changed}));}
  if(stripMode)report.inputTransform={id:strip.id,parserSha256:strip.parserSha256,sourceSha256:strip.sourceSha256,documents:documentInputs.map(({id,text,removedSpans,removedIdentifiers})=>({id,text,removedSpans,removedIdentifiers})),queries:transformed.map(({id,text,removedSpans,removedIdentifiers})=>({id,text,removedSpans,removedIdentifiers})),identityAndCitation:'original fixture text only'};
  const child = cp.spawn(process.execPath, [path.join(sourceRoot, 'worker.cjs'), '--root', runtimeRoot,...(modelId?['--model',modelId]:[])], { windowsHide: true, env: home.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let seq = 0, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const started = performance.now(), startup = setTimeout(() => readyReject(Error('READY_TIMEOUT')), 30000);
  child.on('error', readyReject); child.on('exit', () => { readyReject(Error('WORKER_EXIT')); for (const task of pending.values()) task.reject(Error('WORKER_EXIT')); });
  child.stderr.on('data', bytes => { report.stderrBytes += bytes.length; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line); } catch { readyReject(Error('INVALID_NDJSON')); return; }
    if (value.type === 'ready') { clearTimeout(startup); return value.ok ? readyResolve(value) : readyReject(Error(value.error.code)); }
    const task = pending.get(value.requestId); if (!task) return; pending.delete(value.requestId); clearTimeout(task.timer);
    value.ok ? task.resolve(value) : task.reject(Error(value.error.code));
  });
  async function encode(role, values) {
    const requestId = 'calibration-' + ++seq, begin = performance.now();
    const result = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(Error('ENCODE_TIMEOUT')); }, 30000); pending.set(requestId, { resolve, reject, timer }); });
    child.stdin.write(JSON.stringify({ requestId, op: 'encode', role, texts: values.map(value => value.text), deadlineMs: Date.now() + 30000 }) + '\n');
    const message = await result;
    report.peakRssBytes = Math.max(report.peakRssBytes, message.metrics?.peakRssBytes || message.metrics?.rssBytes || 0);
    report.requests.push({ role, count: values.length, elapsedMs: performance.now() - begin });
    values.forEach((value, i) => { if (message.truncated?.[i]) report.truncated.push(value.id); });
    return values.map((value, i) => ({ id: value.id, vector: message.vectors[i], tokens: message.tokenCounts[i] }));
  }
  try {
    report.ready = await ready; report.coldReadyMs = performance.now() - started;
    if(stripMode){report.representationFingerprint='sha256:'+hash(JSON.stringify([report.ready.modelFingerprint,strip.id,strip.parserSha256,strip.sourceSha256]));report.queries.push(...transformed.filter(query=>!query.text.trim()).map(query=>({id:query.id,vector:null,emptyRepresentation:true})));}
    if(contentMode){if(raw.ready.modelFingerprint!==report.ready.modelFingerprint)throw Error('Runtime fingerprint changed; recollect raw vectors first.');report.documents=raw.documents;const originals=new Map(raw.queries.map(query=>[query.id,query]));report.queries=transformed.filter(query=>!query.changed).map(query=>({...originals.get(query.id),reused:true})).concat(transformed.filter(query=>!query.text).map(query=>({id:query.id,vector:null,emptyContent:true})));}
    else for (let i = 0; i < documentInputs.length; i += 8) report.documents.push(...await encode('document', documentInputs.slice(i, i + 8)));
    for (let i = 0; i < toEncode.length; i += 8) report.queries.push(...await encode('query', toEncode.slice(i, i + 8)));
    if (report.truncated.length) throw Error('Development inputs truncated; do not score incomplete encodings.');
    report.status = 'PASS';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.code || error.message); process.exitCode = 1; }
  finally {
    clearTimeout(startup); for (const task of pending.values()) clearTimeout(task.timer);
    report.cleanup = await killOwnTree(child);
    if (!path.basename(home.home).startsWith('ruyi-e2e-home-')) throw Error('Invalid owned fixture home'); fs.rmSync(home.home, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report) + '\n', { encoding: 'utf8', flag: 'wx' });
  }
  console.log(JSON.stringify({ output, status: report.status, modelFingerprint: report.ready?.modelFingerprint, documents: report.documents.length, queries: report.queries.length, truncated: report.truncated, peakRssBytes: report.peakRssBytes }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
