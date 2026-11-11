#!/usr/bin/env node
'use strict';
// Builds resources/media-runtime-source-evidence.md: per-distribution source/build
// evidence derived from the pinned inventory. Wheels are binary artifacts, so a
// distribution without an sdist/tarball is recorded explicitly as wheel-only.
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inventoryBytes = read('resources/media-runtime-dependencies.json');
const inventory = JSON.parse(inventoryBytes);
const localBytes = read('tools/media-runtime-sources-local-full.json');
const local = JSON.parse(localBytes);
const audit = JSON.parse(read('resources/media-runtime-public-source-audit.json'));
if (audit.schema !== 1 || audit.runtimeLockSha256 !== sha(inventoryBytes)
  || audit.localSourceLockSha256 !== sha(localBytes) || local.runtimeLockSha256 !== sha(inventoryBytes)
  || audit.toolchainBuildAttestation !== false || audit.allDistributionSourceCorrespondenceClosed !== false
  || audit.redistributionAdmitted !== false || local.toolchainBuildAttestation !== false || local.redistributionAdmitted !== false) {
  throw new Error('media source evidence: audit/lock identity or unreviewed approval state changed');
}
for (const binary of audit.binaryObservations) {
  const row = inventory.artifacts.find(item => item.path === binary.path);
  if (!row || row.bytes !== binary.bytes || row.sha256 !== binary.sha256) throw new Error('media source evidence: binary observation mismatch');
}
const output = path.join(root, 'resources', 'media-runtime-source-evidence.md');
const components = (inventory.components || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
const artifacts = Array.isArray(inventory.artifacts) ? inventory.artifacts : [];
const canon = value => String(value || '').toLowerCase().replace(/_/g, '-');
const byComponent = new Map();
for (const row of artifacts) {
  const key = canon(row.component);
  if (!key) continue;
  if (!byComponent.has(key)) byComponent.set(key, []);
  byComponent.get(key).push(row);
}
const lines = [
  '# Media runtime source evidence (M4)',
  '',
  'Generated from resources/media-runtime-dependencies.json. Do not edit by hand; run:',
  '`node tools/generate-media-source-evidence.cjs`.',
  '',
  'This report separates runtime inventory, recorded source identities and public-distribution readiness.',
  'It performs no network lookup or external archive verification and grants no execution or redistribution approval.',
  '',
  '## Runtime inventory coverage',
  '',
  'The table counts only artifacts in the runtime inventory; external sidecars and local qualification sources are listed separately below.',
  '',
  '| Distribution | Version | License | Wheel artifacts | Source archives | Status |',
  '| --- | --- | --- | --- | --- | --- |'
];
const findings = [];
for (const row of components) {
  const rows = byComponent.get(canon(row.name)) || [];
  const wheels = rows.filter(item => /\.whl$/.test(String(item.path || ''))).length;
  const sources = rows.filter(item => /\.(tar\.gz|zip|tgz)$/i.test(String(item.path || '')) && !/\.whl$/.test(String(item.path || '')));
  const status = sources.length ? 'source archive present' : wheels ? 'wheel-only (no source archive in inventory)' : 'no artifact';
  if (!wheels && !sources.length) findings.push(row.name + ': no artifact');
  lines.push('| ' + row.name + ' | ' + row.version + ' | ' + String(row.license || 'classifier') + ' | ' + wheels + ' | ' + sources.length + ' | ' + status + ' |');
}
lines.push('');
lines.push('Runtime inventory SHA-256: `' + sha(inventoryBytes) + '`.');
lines.push('');
lines.push('## Legacy source references');
lines.push('');
const legacy = inventory.correspondingSourceEvidence || {};
if (typeof legacy.file !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(legacy.file)) throw new Error('media source evidence: invalid legacy reference');
const reference = path.join(root, 'resources', legacy.file);
const referenceStatus = !fs.existsSync(reference) ? 'missing from this repository'
  : sha(fs.readFileSync(reference)) === legacy.sha256 ? 'present with matching SHA-256' : 'present with mismatched SHA-256';
lines.push('- Referenced provenance `resources/' + legacy.file + '`: **' + referenceStatus + '**; expected SHA-256 `' + legacy.sha256 + '`.');
lines.push('- Legacy sidecar identity: `' + legacy.sidecarZipSha256 + '`, ' + legacy.sidecarZipBytes + ' bytes. Its presence is not established by this report; a recorded hash does not recover an archive.');
lines.push('- Ordinary Full keeps `resources/media-runtime-sources.json`; the local qualification profile below does not replace that lock.');
lines.push('');
lines.push('## Explicit local-full-v2 qualification sources');
lines.push('');
lines.push('Manifest `tools/media-runtime-sources-local-full.json`, SHA-256 `' + sha(localBytes) + '`, binds the runtime lock above.');
lines.push('These are registered identities, not a claim that external files are present or that all 21 distributions have corresponding source.');
lines.push('');
for (const row of local.artifacts) lines.push('- `' + row.path + '`: ' + row.bytes + ' bytes; SHA-256 `' + row.sha256 + '`.');
lines.push('');
lines.push('Toolchain build attestation: **pending**. All-distribution source correspondence: **pending**. Public redistribution admission: **not granted**.');
lines.push('');
lines.push('## Separate wheel and plugin build observations');
lines.push('');
lines.push('Bounded public observations are recorded in `resources/media-runtime-public-source-audit.json`; embedded version strings and recipes do not attest the actual build environment.');
lines.push('');
for (const row of audit.binaryObservations) lines.push('- `' + row.path + '`: runtime hash `' + row.sha256 + '`; ' + row.compilerVersionObservation + '.');
lines.push('- Wheel source commit `' + audit.wheel.sourceCommit + '`, OpenCV gitlink `' + audit.wheel.opencvGitlink + '`: [fixed Windows wheel workflow](' + audit.wheel.workflowUrl + '), SHA-256 `' + audit.wheel.workflowSha256 + '`.');
lines.push('- FFmpeg plugin binary commit `' + audit.plugin.binaryCommit + '`, source commit `' + audit.plugin.sourceCommit + '`, separate OpenCV wrapper source `' + audit.plugin.opencvSourceCommit + '`.');
for (const row of audit.plugin.recipeObservations) lines.push('- [Fixed upstream recipe](' + row.url + '), SHA-256 `' + row.sha256 + '`: ' + row.facts + '.');
lines.push('');
lines.push('## Evidence still required for public distribution');
lines.push('');
for (const pending of audit.pendingEvidence) lines.push('- ' + pending);
lines.push('');
lines.push('Inventory structural findings: ' + (findings.length ? findings.join('; ') : 'none. Source/build/distribution gaps above remain open.'));
lines.push('');
const text = lines.join('\n');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
  if (current !== text) { console.error('media source evidence: stale (run node tools/generate-media-source-evidence.cjs)'); process.exit(1); }
  console.log('media source evidence: fresh (' + components.length + ' distributions)');
  process.exit(0);
}
fs.writeFileSync(output, text, 'utf8');
console.log('media source evidence: wrote ' + components.length + ' distributions');
