#!/usr/bin/env node
'use strict';
// Builds resources/media-runtime-source-evidence.md: per-distribution source/build
// evidence derived from the pinned inventory. Wheels are binary artifacts, so a
// distribution without an sdist/tarball is recorded explicitly as wheel-only.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'media-runtime-dependencies.json'), 'utf8'));
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
lines.push('Known ffmpeg source/build evidence: ' + JSON.stringify(inventory.correspondingSourceEvidence || {}));
lines.push('');
lines.push('Findings: ' + (findings.length ? findings.join('; ') : 'none at inventory level.'));
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
