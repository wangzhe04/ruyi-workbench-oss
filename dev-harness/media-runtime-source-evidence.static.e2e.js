'use strict';
// Static gate: per-distribution source evidence must be generated, cover all 21
// pinned distributions and never claim a source archive the inventory lacks.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const t = require('./lib/harness').createRunner('MEDIA SOURCE EVIDENCE'), { ok } = t;
const root = path.resolve(__dirname, '../ruyi-workbench');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'resources/media-runtime-dependencies.json'), 'utf8'));
const evidencePath = path.join(root, 'resources/media-runtime-source-evidence.md');
ok(fs.existsSync(evidencePath), 'media-runtime-source-evidence.md exists');
const evidence = fs.readFileSync(evidencePath, 'utf8');
const rows = evidence.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Distribution'));
const canon = value => String(value || '').toLowerCase().replace(/_/g, '-');
ok(inventory.components.length === 21, 'inventory pins 21 distributions');
ok(rows.length === inventory.components.length, 'evidence has one row per distribution (' + rows.length + ')');
const byName = new Map(rows.map(line => { const cells = line.split('|').map(cell => cell.trim()); return [canon(cells[1]), cells]; }));
for (const component of inventory.components) {
  const cells = byName.get(canon(component.name));
  ok(!!cells, 'evidence covers ' + component.name);
  if (!cells) continue;
  ok(cells[2] === component.version, 'evidence version matches for ' + component.name);
  const wheels = Number(cells[4]), sources = Number(cells[5]);
  ok(Number.isSafeInteger(wheels) && wheels >= 1, 'evidence counts wheel artifacts for ' + component.name);
  if (sources > 0) ok(/source archive present/.test(cells[6]), 'source count and status agree for ' + component.name);
  else ok(/wheel-only/.test(cells[6]), 'no source archive is honestly labelled for ' + component.name);
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const audit = JSON.parse(fs.readFileSync(path.join(root, 'resources/media-runtime-public-source-audit.json'), 'utf8'));
const localBytes = fs.readFileSync(path.join(root, 'tools/media-runtime-sources-local-full.json'));
const local = JSON.parse(localBytes);
ok(audit.schema === 1 && audit.kind === 'media-source-observations-not-distribution-approval', 'public source audit is observations with no distribution approval');
ok(audit.runtimeLockSha256 === sha(fs.readFileSync(path.join(root, 'resources/media-runtime-dependencies.json')))
  && audit.localSourceLockSha256 === sha(localBytes), 'audit binds exact runtime and local qualification manifest bytes');
ok(audit.toolchainBuildAttestation === false && audit.allDistributionSourceCorrespondenceClosed === false
  && audit.redistributionAdmitted === false && local.toolchainBuildAttestation === false && local.redistributionAdmitted === false,
'source registration never grants toolchain attestation, all-distribution closure or public admission');
ok(local.artifacts.length === 2 && local.artifacts.reduce((total, row) => total + row.bytes, 0) === 189682945
  && local.artifacts.every(row => evidence.includes(row.path) && evidence.includes(row.sha256)),
'the two local-full-v2 identities are listed separately at their exact byte counts and hashes');
const legacy = inventory.correspondingSourceEvidence, provenance = path.join(root, 'resources', legacy.file);
const observedStatus = !fs.existsSync(provenance) ? 'missing from this repository'
  : sha(fs.readFileSync(provenance)) === legacy.sha256 ? 'present with matching SHA-256' : 'present with mismatched SHA-256';
ok(evidence.includes('**' + observedStatus + '**') && evidence.includes(legacy.sha256), 'report distinguishes recorded legacy provenance hash from actual repository availability');
ok(evidence.includes('Its presence is not established by this report') && evidence.includes('a recorded hash does not recover an archive'),
'legacy sidecar identity is not reported as a recovered archive');
ok(sha(fs.readFileSync(path.join(root, 'resources/media-runtime-sources.json'))) === '96b07893303e89c9ba668247aa9fb95a15d879c7fd741e674dbfc8491d11fd29',
'ordinary Full keeps its original source lock');
ok(audit.binaryObservations.length === 2 && audit.binaryObservations.every(binary => {
  const item = inventory.artifacts.find(row => row.path === binary.path);
  return item && item.bytes === binary.bytes && item.sha256 === binary.sha256 && evidence.includes(binary.sha256);
}), 'wheel extension and FFmpeg plugin observations bind separate exact runtime binaries');
ok(audit.wheel.opencvGitlink !== audit.plugin.opencvSourceCommit && evidence.includes(audit.wheel.opencvGitlink)
  && evidence.includes(audit.plugin.opencvSourceCommit), 'wheel OpenCV source and plugin wrapper source stay separate');
ok(audit.plugin.recipeObservations.length === 3 && audit.plugin.recipeObservations.every(row =>
  row.url.startsWith('https://raw.githubusercontent.com/opencv/opencv_3rdparty/' + audit.plugin.sourceCommit + '/')
  && /^[a-f0-9]{64}$/.test(row.sha256) && evidence.includes(row.url) && evidence.includes(row.sha256)),
'fixed primary-source recipe links and digests are preserved without online lookups');
ok(evidence.includes('apt packages without version pins') && evidence.includes('ubuntu:24.04 base tag without digest')
  && evidence.includes('actual linked archive identities remain unproven'), 'unpinned recipe inputs cannot become an actual-build attestation');
ok(audit.pendingEvidence.length === 4 && audit.pendingEvidence.every(item => evidence.includes(item))
  && evidence.includes('Source/build/distribution gaps above remain open.'), 'actual toolchain/static archives and all-distribution review remain visible blockers');
ok(!/Findings: none at inventory level\./.test(evidence) && evidence.includes('Public redistribution admission: **not granted**'),
'a structurally valid inventory cannot wash public distribution gaps');
const check = cp.spawnSync(process.execPath, [path.join(root, 'tools/generate-media-source-evidence.cjs'), '--check'], { encoding: 'utf8' });
ok(check.status === 0 && /fresh/.test(check.stdout || ''), 'evidence matches the generator (' + String((check.stdout || check.stderr || '').trim()).split('\n')[0] + ')');
t.done({ exit: true });
