'use strict';
// TEMP read-only overlay for the original pure record-format suite, not a build.
const fs = require('node:fs'), path = require('node:path');
const repo = process.env.RUYI_NDJSON_REPO || process.cwd();
const target = path.join(repo, 'ruyi-workbench/app/src/01q-work-data-records.js');
const read = fs.readFileSync.bind(fs), candidate = read(path.join(__dirname, 'src/01q-work-data-records.js'));
fs.readFileSync = function(file, options) {
  if (typeof file === 'string' && path.resolve(file) === target) return typeof options === 'string' || options?.encoding ? candidate.toString(typeof options === 'string' ? options : options.encoding) : Buffer.from(candidate);
  return read(file, options);
};
