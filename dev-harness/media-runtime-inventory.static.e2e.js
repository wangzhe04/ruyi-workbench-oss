'use strict';
// Static gate: the pinned media inventory must stay internally closed - every
// distribution is covered by at least one artifact, every artifact names a pinned
// distribution (case/underscore variants canonicalized), component-less artifacts
// are only python_embed native-runtime files, proofs are present, and no path escapes.
const fs = require('node:fs'), path = require('node:path');
const t = require('./lib/harness').createRunner('MEDIA RUNTIME INVENTORY'), { ok } = t;
const inventory = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../ruyi-workbench/resources/media-runtime-dependencies.json'), 'utf8'));
const canon = value => String(value || '').toLowerCase().replace(/_/g, '-');
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const components = new Map((inventory.components || []).map(row => [canon(row.name), row]));
ok(components.size === 21, 'inventory pins 21 distributions (actual ' + components.size + ')');
const artifacts = Array.isArray(inventory.artifacts) ? inventory.artifacts : [];
ok(artifacts.length > 0, 'inventory lists artifacts (actual ' + artifacts.length + ')');
ok(Array.isArray(inventory.artifactClosureProblems) && inventory.artifactClosureProblems.length === 0, 'artifact closure problems stay empty');
const covered = new Set(), unknown = [], badPath = [], badProof = [], looseNative = [];
for (const row of artifacts) {
  const value = String(row.path || '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..') || value.includes('\\')) badPath.push(value);
  if (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/.test(String(row.sha256 || '')) || row.bytes === 0 && row.sha256 !== EMPTY_SHA) badProof.push(value + ' (size/hash)');
  if (!row.component) {
    if (!value.startsWith('python_embed/') || row.role !== 'native-runtime') looseNative.push(value);
  } else if (canon(row.component) === 'cpython') {
    if (!value.startsWith('python_embed/')) looseNative.push(value);
  } else if (components.has(canon(row.component))) covered.add(canon(row.component));
  else unknown.push(value + ':' + row.component);
  const proofs = Array.isArray(row.proofs) ? row.proofs : [];
  if (!proofs.length) badProof.push(value + ' (no proof)');
  for (const proof of proofs) {
    if (!proof || typeof proof.kind !== 'string' || !proof.kind.length) { badProof.push(value + ' (proof kind)'); continue; }
    const text = JSON.stringify(proof);
    if (!/[a-f0-9]{64}|sha256=/.test(text)) badProof.push(value + ' (proof hash)');
  }
}
ok(unknown.length === 0, 'no artifact points at an unpinned component (' + unknown.slice(0, 3).join(', ') + ')');
ok(looseNative.length === 0, 'component-less artifacts are only python_embed native-runtime files (' + looseNative.slice(0, 3).join(', ') + ')');
ok(badPath.length === 0, 'no artifact path escapes or uses backslashes (' + badPath.slice(0, 3).join(', ') + ')');
ok(badProof.length === 0, 'every artifact carries size, hash and a shaped manifest proof (' + badProof.slice(0, 3).join(', ') + ')');
const missing = [...components.keys()].filter(name => !covered.has(name));
ok(missing.length === 0, 'every pinned distribution is covered by an artifact (' + missing.slice(0, 3).join(', ') + ')');
const readiness = inventory.productionReadiness && typeof inventory.productionReadiness === 'object' ? inventory.productionReadiness : {};
ok(['image', 'pdf', 'office', 'video'].every(name => typeof readiness[name] === 'string' && readiness[name].length > 0), 'production readiness states are present for image/pdf/office/video');
t.done({ exit: true });
