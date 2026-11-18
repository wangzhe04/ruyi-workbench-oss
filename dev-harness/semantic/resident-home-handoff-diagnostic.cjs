'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pins = Object.freeze({
  fixture: '13ddb447a8a91734d7ff8f0b3e569d094a83295c952b73ac17573d35c978ee1b',
  controller: '6a1329fca52282d25716534ca0bf622bb4d5f5304b7fba342f34ddd487b73fb5',
  probe: '0749931a86c55868513e2d7278d71d2b5620d16085eaa2db7f861b3312c6993a',
});
function replaceOne(source, from, to) {
  assert.equal(source.split(from).length, 2, 'Expected one frozen source match');
  return source.replace(from, () => to);
}

function fixture(bytes) {
  assert.equal(hash(bytes), pins.fixture);
  let result = bytes.toString('utf8');
  result = replaceOne(result, 'async function next(role){const grant=await client.issue(role,',
    'async function next(targetRole){const grant=await client.issue(targetRole,');
  result = replaceOne(result, 'row.role!==role)no(Error(', 'row.role!==targetRole)no(Error(');
  // Keep the original actor-role expression and prove the phase boundaries.
  result = replaceOne(result, " const activeEnd=performance.now()", " marker('registered');\n const activeEnd=performance.now()");
  result = replaceOne(result, "  if(role==='cold'){const before=", "  marker('active');\n  if(role==='cold'){const before=");
  result = replaceOne(result, "proof.status='COLD_NO_RUNTIME';persist();await next('successor');",
    "proof.status='COLD_NO_RUNTIME';persist();marker('cold-runtime-denied');await next('successor');");
  return result;
}

function probe(bytes) {
  assert.equal(hash(bytes), pins.probe);
  const from = '            Emit("actual-product-host",value);';
  return replaceOne(bytes.toString('utf8'), from, [
    '            // These finite fields are already validated by the frozen product host.',
    '            if(phase=="close-failure-diagnostic"||phase=="node-close-diagnostic")',
    '                foreach(string key in new[]{"origin","stage","reason","name","nativeCode","membersCount","membersContainsCurrent","membersElapsedMs","kind","seq"})',
    '                    if(data.TryGetValue(key,out item))value.Add(key,item);',
    from,
  ].join('\n'));
}

function controller(bytes, exePin, repo, observers, proof) {
  assert.equal(hash(bytes), pins.controller);
  assert.match(exePin, /^[0-9a-f]{64}$/);
  let result = bytes.toString('utf8');
  result = replaceOne(result, 'ROOT=path.resolve(__dirname,\'../..\')', 'ROOT=' + JSON.stringify(repo));
  result = replaceOne(result, "require('./observers.cjs')", 'require(' + JSON.stringify(observers) + ')');
  result = replaceOne(result, "require('./proof.cjs')", 'require(' + JSON.stringify(proof) + ')');
  result = replaceOne(result, "EXE_PIN='515acd87e63b7bca0c6815c7dceea3f2108e439a2594f859c189ef4b44ee377e'",
    "EXE_PIN='" + exePin + "'");
  // Keep the first failure latched, then continue parsing remaining bounded
  // frames received before the existing controller deadline.
  result = replaceOne(result, "if(['uncertain','abnormal-owner-reclaimed','close-failure-diagnostic'].includes(v.phase))throw Error('SCENE_PRODUCT_UNCERTAIN');",
    "if(['uncertain','abnormal-owner-reclaimed','close-failure-diagnostic'].includes(v.phase))fail(Error('SCENE_PRODUCT_UNCERTAIN'));");
  result = replaceOne(result, '}catch(e){fail(e);}finally{report.actorClose',
    "}catch(e){fail(e);if(first?.value?.message==='SCENE_PRODUCT_UNCERTAIN'){const end=Math.min(deadline,performance.now()+200);while(!report.events.some(row=>row.value?.phase==='close-failure-diagnostic')&&performance.now()<end)await new Promise(r=>setTimeout(r,10));}}finally{report.actorClose");
  return result;
}

module.exports = Object.freeze({ hash, fixture, controller, probe, pins });
