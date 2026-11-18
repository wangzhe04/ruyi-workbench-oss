'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06hb-semantic-runtime.js'), 'utf8');
const context = vm.createContext({ SemanticRuntimeHooks: {}, Buffer, setTimeout, clearTimeout, Date, require, process, __dirname, WeakRef });
vm.runInContext(source + '\n;globalThis.api = SemanticRuntimeClient;', context);
const fingerprint = 'a'.repeat(64);
function fixture(mode = 'good', enabled = async () => true) {
  const children = []; let launches = 0, writes = 0;
  const script = `const readline=require('node:readline'); const fp='${fingerprint}';
    console.log(JSON.stringify({type:'ready',modelFingerprint:fp,dimensions:8}));
    readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
      const warm=r.texts[0]==='Local semantic runtime warmup.';
      if('${mode}'==='hang'&&!warm)return;
      const vectors=r.texts.map(()=> '${mode}'==='bad'&&!warm ? [1] : [1,0,0,0,0,0,0,0]);
      console.log(JSON.stringify({ok:true,requestId:r.requestId,vectors,modelFingerprint:fp}));});`;
  const client = context.api.create({ enabled, startupMs: 2000, idleMs: 1000,
    settings: () => ({ command: process.execPath, args: ['-e', script], env: {}, cwd: process.cwd() }),
    spawn(...args) { launches++; const child = cp.spawn(...args); const write = child.stdin.write.bind(child.stdin); child.stdin.write = (...values) => { if(!String(values[0]).includes('Local semantic runtime warmup.'))writes++; return write(...values); }; children.push(child); return child; },
  });
  return { client, launches: () => launches, writes: () => writes, async close() {
    const closing = children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once('close', resolve)));
    await client.stop('disabled'); await Promise.all(closing);
  } };
}
test('bridge starts one isolated worker and validates normalized result identity', async () => {
  const f = fixture();
  try {
    assert.equal(f.launches(), 0);
    const ready = await Promise.all([f.client.prepare({ budgetMs: 1500 }), f.client.prepare({ budgetMs: 1500 })]);
    assert.equal(ready.every(row => row.available), true); assert.equal(f.launches(), 1);
    const result = await f.client.encode(['中文', 'English'], { role: 'document' });
    assert.equal(result.ok, true); assert.equal(result.vectors.length, 2); assert.equal(result.modelFingerprint, fingerprint);
  } finally { await f.close(); }
});
test('disabled never spawns; policy exceptions are not availability fallback', async () => {
  const f = fixture('good', async () => false);
  try { assert.equal((await f.client.prepare()).reason, 'disabled'); assert.equal(f.launches(), 0); } finally { await f.close(); }
  const guarded = fixture('good', async () => { throw Object.assign(Error('work_data_key.locked'), { code: 'work_data_key.locked' }); });
  try { await assert.rejects(guarded.client.prepare(), { code: 'work_data_key.locked' }); assert.equal(guarded.launches(), 0); } finally { await guarded.close(); }
});
test('malformed vectors terminate worker instead of poisoning caller cache', async () => {
  const f = fixture('bad');
  try {
    await f.client.prepare({ budgetMs: 1500 });
    await assert.rejects(f.client.encode(['secret'], { role: 'query' }), /vector_contract/);
    assert.equal(f.client.descriptor().available, false);
  } finally { await f.close(); }
});
test('absolute deadline reaps stalled worker; aborted request is an error', async () => {
  const f = fixture('hang');
  try {
    await f.client.prepare({ budgetMs: 1500 }); const start = Date.now();
    const response = await f.client.encode(['a'], { role: 'query', deadline: Date.now() + 220 });
    assert.equal(response.reason, 'timeout'); assert.ok(Date.now() - start < 1000);
  } finally { await f.close(); }
  const g = fixture('hang');
  try {
    await g.client.prepare({ budgetMs: 1500 }); const controller = new AbortController();
    const promise = g.client.encode(['a'], { role: 'query', signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(promise, { name: 'AbortError' }); assert.equal(g.client.descriptor().available, false);
  } finally { await g.close(); }
});
test('input and role limits are enforced before launching', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.client.encode(Array(33).fill('a'), { role: 'document' }), /invalid_texts/);
    await assert.rejects(f.client.encode(['a'], { role: 'system' }), /invalid_role/);
    assert.equal(f.launches(), 0);
  } finally { await f.close(); }
});

test('source revoked during async preparation never reaches worker stdin', async () => {
  let preparation = 0, revoked = false;
  const f = fixture('good', async () => { if (++preparation > 1) revoked = true; return true; });
  try {
    await f.client.prepare({ budgetMs: 1500 });
    await assert.rejects(f.client.encode(['private source'], { role: 'document', beforeEncode: async () => {
      assert.equal(revoked, true);
      throw Object.assign(Error('privacy.denied'), { code: 'privacy.denied' });
    } }), { code: 'privacy.denied' });
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test('insufficient remaining batch budget preserves a ready worker and still validates its source', async () => {
  const f=fixture();let guarded=false;
  try {
    await f.client.prepare({budgetMs:1500});
    const result=await f.client.encode(['private fragment'],{role:'document',deadline:Date.now()+100,minimumBudgetMs:200,beforeEncode:async()=>{guarded=true;}});
    assert.equal(result.reason,'timeout');assert.equal(guarded,true);assert.equal(f.writes(),0);assert.equal(f.client.descriptor().available,true);
    assert.equal((await f.client.encode(['next query'],{role:'query'})).ok,true);assert.equal(f.launches(),1);
  } finally {await f.close();}
});

test('expired cold requests do not launch and clean timeout can explicitly restart', async () => {
  const cold=fixture();
  try {assert.equal((await cold.client.prepare({deadline:Date.now()-1})).reason,'timeout');assert.equal(cold.launches(),0);} finally {await cold.close();}
  const hung=fixture('hang');
  try {
    await hung.client.prepare({budgetMs:1500});
    assert.equal((await hung.client.encode(['bounded work'],{role:'document',deadline:Date.now()+220})).reason,'timeout');
    assert.equal((await hung.client.restart()).available,true);assert.equal(hung.launches(),2);
  } finally {await hung.close();}
});
