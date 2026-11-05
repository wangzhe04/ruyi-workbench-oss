'use strict';
// Static gate: per-distribution source evidence must be generated, cover all 21
// pinned distributions and never claim a source archive the inventory lacks.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
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
const check = cp.spawnSync(process.execPath, [path.join(root, 'tools/generate-media-source-evidence.cjs'), '--check'], { encoding: 'utf8' });
ok(check.status === 0 && /fresh/.test(check.stdout || ''), 'evidence matches the generator (' + String((check.stdout || check.stderr || '').trim()).split('\n')[0] + ')');
t.done({ exit: true });
