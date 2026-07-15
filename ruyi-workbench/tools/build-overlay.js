#!/usr/bin/env node
'use strict';
/*
 * build-overlay.js [version] — assemble the incremental overlay package under dist/overlay/.
 * Produces dist/overlay/{Manage-Overlay.cmd,Manage-Overlay.ps1,APPLY-OVERLAY.md,payload/...}
 * then you zip dist/overlay -> workbench-overlay-<version>.zip.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const version = process.argv[2] || '0.3.0';
const outRoot = path.join(root, 'dist', 'overlay');
const payload = path.join(outRoot, 'payload');

// Files that land in the deployed folder (path relative to deployed root == relative to `root`).
const PAYLOAD_FILES = [
  'app/server.js',
  'app/public/index.html',
  'app/public/app.js',
  'app/public/js/icons.js',
  'app/public/locales/zh-CN.json',
  'app/public/locales/en-US.json',
  'app/public/styles.css',
  'app/public/vendor/marked.min.js',
  'app/public/vendor/highlight.min.js',
  'app/public/vendor/github-dark.min.css',
  'app/public/vendor/github.min.css',
  'Start-Workbench.cmd',
  'resources/scripts/install-workbench.ps1',
  'tools/fake-claude.js',
  'tools/dev-serve.cmd',
];
// Files that live at the overlay-package root (the applicator + docs).
const OVERLAY_FILES = ['tools/Manage-Overlay.cmd', 'tools/Manage-Overlay.ps1', 'tools/APPLY-OVERLAY.md'];

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(payload, { recursive: true });

for (const rel of PAYLOAD_FILES) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) { console.error(`MISSING payload file: ${rel}`); process.exit(1); }
  copy(src, path.join(payload, rel));
}
for (const rel of OVERLAY_FILES) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) { console.error(`MISSING overlay file: ${rel}`); process.exit(1); }
  copy(src, path.join(outRoot, path.basename(rel)));
}

// Generate the manifest over the payload.
cp.execFileSync(process.execPath, [path.join(root, 'tools', 'gen-manifest.js'), payload, version, `overlay-${version}`], { stdio: 'inherit' });

console.log(`Overlay assembled at ${outRoot}`);
console.log(`Payload files: ${PAYLOAD_FILES.length}`);
