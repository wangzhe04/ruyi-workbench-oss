#!/usr/bin/env node
'use strict';
// Generates the bundled media-runtime third-party notices from the pinned inventory.
// Usage: node tools/generate-media-notices.cjs [--check]
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const inventoryPath = path.join(root, 'resources', 'media-runtime-dependencies.json');
const outputPath = path.join(root, 'resources', 'media-runtime-notices.txt');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const rows = (inventory.components || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
if (!rows.length) throw new Error('media notices: inventory has no components');
const classifierLicense = row => {
  const list = Array.isArray(row.licenseClassifiers) ? row.licenseClassifiers : [];
  const hit = list.find(value => typeof value === 'string' && value.startsWith('License :: OSI Approved :: '));
  return hit ? hit.slice('License :: OSI Approved :: '.length).replace(/ License$/, '') : null;
};
for (const row of rows) {
  if (!row.name || !row.version) throw new Error('media notices: component is missing name/version: ' + JSON.stringify(row.name || null));
  if (!row.license) row.license = classifierLicense(row);
  if (!row.license) throw new Error('media notices: component has no license evidence: ' + row.name);
  if (!Array.isArray(row.licenseFiles) || !row.licenseFiles.length) throw new Error('media notices: component has no license files: ' + row.name);
}
const lines = [
  'Ruyi Workbench - media runtime third-party notices',
  '',
  'This file is generated from resources/media-runtime-dependencies.json.',
  'Do not edit by hand; run: node tools/generate-media-notices.cjs',
  '',
  'Platform: ' + String(inventory.windows || 'unspecified'),
  'Python: ' + String(inventory.python || 'unspecified'),
  'Inventory scope: ' + String(inventory.scope || 'unspecified'),
  'Corresponding source and build evidence: resources/media-runtime-sources.json,',
  'resources/offline-manifest.json and docs/OFFLINE_DEPLOYMENT.md.',
  '',
  'Components (' + rows.length + '):',
  ''
];
for (const row of rows) {
  lines.push('- ' + row.name + ' ' + row.version + ' - ' + row.license);
  lines.push('  license files: ' + row.licenseFiles.join(', '));
  if (row.metadata) lines.push('  metadata: ' + row.metadata);
  if (row.record) lines.push('  record: ' + row.record);
}
lines.push('');
const text = lines.join('\n');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== text) { console.error('media notices: stale (run node tools/generate-media-notices.cjs)'); process.exit(1); }
  console.log('media notices: fresh (' + rows.length + ' components)');
  process.exit(0);
}
fs.writeFileSync(outputPath, text, 'utf8');
console.log('media notices: wrote ' + rows.length + ' components -> ' + path.relative(root, outputPath));
