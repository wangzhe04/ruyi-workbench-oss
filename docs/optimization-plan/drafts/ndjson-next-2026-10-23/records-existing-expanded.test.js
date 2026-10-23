'use strict';
// Existing suite verbatim except the intentionally expanded registered-kind list.
// Compile at its real filename so every original dependency/assertion stays intact.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const repo = process.env.RUYI_NDJSON_REPO || process.cwd();
const filename = path.join(repo, 'dev-harness/unit/work-data-records.test.js');
const original = fs.readFileSync(filename, 'utf8');
const before = "assert.deepEqual([...records.KINDS], ['messages', 'provider', 'interventions', 'changes']);";
const after = "assert.deepEqual([...records.KINDS], ['messages', 'provider', 'interventions', 'changes', 'steward-inbox', 'steward-decisions', 'agent-run-events']);";
if (original.split(before).length !== 2) throw Error('registered-kind assertion changed; inspect original before updating this TEMP runner');
const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(original.replace(before, after), filename);
