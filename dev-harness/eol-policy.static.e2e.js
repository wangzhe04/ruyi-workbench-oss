'use strict';

// Repository EOL policy gate. Git's index normalizes text, so `git status` alone can hide an externally
// written CRLF or mixed-EOL worktree file. Inspect the actual bytes of every tracked text file instead.
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const attrs = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
let failed = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failed += 1; console.error('FAIL ' + label); }
};

ok(/^\*\s+text=auto\s+eol=lf\s*$/m.test(attrs), 'all text defaults to LF');
for (const ext of ['cmd', 'bat', 'ps1']) {
  ok(new RegExp('^\\*\\.' + ext + '\\s+text\\s+eol=crlf\\s*$', 'm').test(attrs), '*.' + ext + ' remains an explicit CRLF exception');
}

function parseEolLine(line) {
  const match = /^i\/(?<index>\S+)\s+w\/(?<worktree>\S+)\s+attr\/(?<attr>\S+)(?:\s+eol=(?<eol>\S+))?\s+(?<file>.+)$/.exec(line);
  return match ? { index: match.groups.index, worktree: match.groups.worktree, attr: match.groups.attr, eol: match.groups.eol || '', file: match.groups.file } : null;
}
function byteEolKind(buffer) {
  let crlf = 0, loneLf = 0, loneCr = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 13) {
      if (buffer[i + 1] === 10) { crlf += 1; i += 1; }
      else loneCr += 1;
    } else if (buffer[i] === 10) loneLf += 1;
  }
  if (!crlf && !loneLf && !loneCr) return 'none';
  if (loneLf && !crlf && !loneCr) return 'lf';
  if (crlf && !loneLf && !loneCr) return 'crlf';
  return 'mixed';
}

const rows = childProcess.execFileSync('git', ['ls-files', '--eol'], { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean).map(parseEolLine).filter(Boolean);
const violations = [];
let checked = 0;
for (const row of rows) {
  if (row.attr === '-text') continue;
  if (row.eol !== 'lf' && row.eol !== 'crlf') {
    violations.push(row.file + ' has no explicit EOL attribute (' + row.attr + ')');
    continue;
  }
  checked += 1;
  const kind = byteEolKind(fs.readFileSync(path.join(ROOT, row.file)));
  if (row.eol === 'lf' && !['lf', 'none'].includes(kind)) violations.push(row.file + ' expected LF, found ' + kind);
  if (row.eol === 'crlf' && !['crlf', 'none'].includes(kind)) violations.push(row.file + ' expected CRLF, found ' + kind);
}
ok(violations.length === 0, 'all ' + checked + ' tracked text files match their declared EOL' + (violations.length ? ':\n  - ' + violations.join('\n  - ') : ''));

if (failed) process.exit(1);
console.log('EOL POLICY STATIC E2E: ALL PASS');
