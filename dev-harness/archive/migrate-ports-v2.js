#!/usr/bin/env node
// V1.8-A Phase 1b: Fix remaining single-line port declarations missed by first pass.
// Pattern: `const VAR = PORT;` on its own line (not comma-separated).
// Run: node dev-harness/migrate-ports-v2.js [--dry-run]
'use strict';
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const DIR = __dirname;

// Find all e2e files that still have hardcoded port declarations
const e2eFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.e2e.js'));
const PORT_RE = /\b(8[7-9]\d\d|9[01]\d\d)\b/g;
const SINGLE_DECL_RE = /^(\s*)(const|let)\s+(\w+)\s*=\s*(8[7-9]\d\d|9[01]\d\d)\s*;\s*$/gm;

let total = 0;
let fixed = 0;
const results = [];

for (const file of e2eFiles) {
  const filePath = path.join(DIR, file);
  let src = fs.readFileSync(filePath, 'utf8');
  
  // Skip if already has getFreePort
  if (src.includes('getFreePort')) {
    // Check if there are still hardcoded ports in code (not just comments)
    const stripped = stripComments(src);
    const remaining = [...stripped.matchAll(PORT_RE)];
    if (remaining.length === 0) {
      results.push({ file, status: 'ALREADY_DONE' });
      continue;
    }
  }

  // Find all single-line port declarations
  const decls = [...src.matchAll(SINGLE_DECL_RE)];
  if (decls.length === 0) {
    results.push({ file, status: 'NO_SINGLE_DECLS' });
    continue;
  }

  total += decls.length;
  const portVars = decls.map(d => d[3]); // variable names

  // Check if these are inside an async function (can use await)
  // or at the top level (need to move into async IIFE)
  const isInsideAsync = checkInsideAsync(src, decls[0].index);

  if (!isInsideAsync) {
    // Top-level: need to move into async IIFE
    results.push({ file, status: 'TOP_LEVEL_NEEDS_WRAP', vars: portVars });
    continue;
  }

  // Inside async: replace with await getFreePort()
  let newSrc = src;

  // Replace each declaration (in reverse order to preserve indices)
  for (let i = decls.length - 1; i >= 0; i--) {
    const d = decls[i];
    const indent = d[1];
    const varName = d[3];
    const start = d.index;
    const end = start + d[0].length;
    newSrc = newSrc.slice(0, start) + `${indent}const ${varName} = await getFreePort();` + newSrc.slice(end);
  }

  // Add import if not present
  if (!newSrc.includes("require('./free-port.js')")) {
    newSrc = addImport(newSrc, file);
  }

  if (newSrc !== src) {
    fixed++;
    results.push({ file, status: 'FIXED', vars: portVars });
    if (!DRY_RUN) {
      fs.writeFileSync(filePath, newSrc, 'utf8');
    }
  } else {
    results.push({ file, status: 'NO_CHANGE', vars: portVars });
  }
}

// Summary
console.log(`\n=== V1.8-A Phase 1b: Single-line port fix ${DRY_RUN ? '(DRY RUN) ' : ''}===\n`);
for (const r of results) {
  if (r.status !== 'ALREADY_DONE') {
    console.log(`  ${r.status.padEnd(25)} ${r.file}${r.vars ? ' [' + r.vars.join(', ') + ']' : ''}`);
  }
}
console.log(`\nTotal single-line port declarations found: ${total}`);
console.log(`Files fixed: ${fixed}`);

function stripComments(src) {
  let out = ''; let i = 0; const n = src.length; let st = 'code';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (st === 'code') {
      if (c === '/' && d === '/') { st = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { st = 'block'; i += 2; continue; }
      if (c === "'") { st = 'sq'; out += c; i++; continue; }
      if (c === '"') { st = 'dq'; out += c; i++; continue; }
      if (c === '`') { st = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') { if (c === '\n') { out += '\n'; st = 'code'; } i++; continue; }
    if (st === 'block') { if (c === '*' && d === '/') { st = 'code'; i += 2; continue; } if (c === '\n') out += '\n'; i++; continue; }
    const term = st === 'sq' ? "'" : st === 'dq' ? '"' : '`';
    if (c === '\\') { out += c + (d || ''); i += 2; continue; }
    out += c; i++;
    if (c === term) st = 'code';
  }
  return out;
}

function checkInsideAsync(src, index) {
  // Check if the declaration is inside an async function/arrow
  const before = src.slice(Math.max(0, index - 2000), index);
  // Look for (async or async function patterns
  return before.includes('async');
}

function addImport(src, file) {
  // Find the last require() line and add after it
  const requireLines = [...src.matchAll(/^(const .+ = require\(.+\));?\s*$/gm)];
  if (requireLines.length > 0) {
    const lastReq = requireLines[requireLines.length - 1];
    const insertPos = lastReq.index + lastReq[0].length;
    return src.slice(0, insertPos) + "\nconst { getFreePort } = require('./free-port.js');" + src.slice(insertPos);
  }
  // No requires — add after 'use strict'
  const useStrict = src.indexOf("'use strict'");
  if (useStrict >= 0) {
    const eol = src.indexOf('\n', useStrict) + 1;
    return src.slice(0, eol) + "const { getFreePort } = require('./free-port.js');\n" + src.slice(eol);
  }
  return "const { getFreePort } = require('./free-port.js');\n" + src;
}
