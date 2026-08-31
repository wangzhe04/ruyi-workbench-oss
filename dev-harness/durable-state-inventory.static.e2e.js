'use strict';
const fs = require('fs');
const path = require('path');
const inventory = require('./durable-state-inventory.js');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
function ok(value, label) { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } }

try {
  const data = inventory.check();
  ok(data.count === inventory.entries.length && data.count >= 35, 'inventory artifact is fresh and covers every declared surface');
  ok(data.entries.every(entry => entry.owner && entry.schema && entry.writePrimitive && entry.corruption && entry.capacity && entry.cache && entry.recovery),
    'every surface declares owner/schema/write/corruption/capacity/cache/recovery');
  ok(data.entries.every(entry => entry.lifecycle === 'shared-lifecycle' || entry.exemptionReason), 'every private lifecycle is migrated or has an auditable exemption');
  const context = data.entries.find(entry => entry.id === 'context-calibration');
  ok(context && /DurableJsonStore/.test(context.writePrimitive) && context.lifecycle === 'shared-lifecycle', 'context calibration is the representative full-lifecycle migration');
  const source = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '10-context-governance.js'), 'utf8');
  ok(/DurableJsonStore\.create/.test(source) && !/const tmp = file \+ '\.tmp'/.test(source), 'context calibration no longer carries a private tmp/quarantine/write chain');
  const server = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'), 'utf8');
  ok((server.match(/\+ '\.tmp'/g) || []).length === 4, 'no undeclared fixed-tmp JSON writer remains');
} catch (error) { console.error(error.stack || error); failures++; }

if (failures) process.exitCode = 1;
