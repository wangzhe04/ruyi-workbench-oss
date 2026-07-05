#!/usr/bin/env node
'use strict';
/*
 * gen-manifest.js <payloadDir> <version> [overlayLabel]
 * Emits <payloadDir>/update-manifest.json listing every payload file with its sha256, using paths
 * RELATIVE to the payload root (== relative to the deployed folder after apply). The workbench's
 * /api/status reads this at <externalRoot>/update-manifest.json to verify integrity. The manifest
 * excludes itself.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const payloadDir = path.resolve(process.argv[2] || '.');
const version = process.argv[3] || '0.0.0';
const overlay = process.argv[4] || `overlay-${version}`;

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else {
      const rel = path.relative(base, full).replace(/\\/g, '/');
      if (rel === 'update-manifest.json') continue;
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      out.push({ path: rel, sha256, bytes: fs.statSync(full).size });
    }
  }
}

const files = [];
walk(payloadDir, payloadDir, files);
files.sort((a, b) => a.path.localeCompare(b.path));
const manifest = { name: 'Ruyi Overlay', version, overlay, generatedFrom: 'gen-manifest.js', fileCount: files.length, files };
fs.writeFileSync(path.join(payloadDir, 'update-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`Wrote update-manifest.json: ${files.length} files, version ${version}`);
