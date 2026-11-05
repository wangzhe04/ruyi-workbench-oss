'use strict';
// Static gate: the bundled media-runtime notices must be generated from the pinned
// inventory, cover every component and name each license file.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const t = require('./lib/harness').createRunner('MEDIA RUNTIME NOTICES'), { ok } = t;
const root = path.resolve(__dirname, '../ruyi-workbench');
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'resources/media-runtime-dependencies.json'), 'utf8'));
const noticesPath = path.join(root, 'resources/media-runtime-notices.txt');
ok(fs.existsSync(noticesPath), 'media-runtime-notices.txt exists');
const notices = fs.readFileSync(noticesPath, 'utf8');
ok(/[^\r\n]/.test(notices) && !notices.includes('\uFFFD'), 'notices are non-empty and hold no replacement characters');
const components = Array.isArray(inventory.components) ? inventory.components : [];
ok(components.length === 21, 'inventory pins 21 media distributions (actual ' + components.length + ')');
for (const row of components) {
  const line = '- ' + row.name + ' ' + row.version + ' - ';
  ok(notices.split('\n').some(text => text.startsWith(line) && text.length > line.length), 'notices name ' + row.name + ' ' + row.version + ' with a license');
  for (const file of row.licenseFiles || []) ok(notices.includes(file), 'notices list the license file for ' + row.name + ': ' + file);
}
const check = cp.spawnSync(process.execPath, [path.join(root, 'tools/generate-media-notices.cjs'), '--check'], { encoding: 'utf8' });
ok(check.status === 0 && /fresh/.test(check.stdout || ''), 'notices match the generator output (' + String((check.stdout || check.stderr || '').trim()).split('\n')[0] + ')');
t.done({ exit: true });
