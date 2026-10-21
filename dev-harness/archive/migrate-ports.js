#!/usr/bin/env node
// V1.8-A Phase 1: Automate port dynamic allocation across all e2e files.
// Replaces hardcoded port constants (8700-9199) with getFreePort() calls.
// Run: node dev-harness/migrate-ports.js [--dry-run]
'use strict';
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const E2E_DIR = path.join(__dirname, 'e2e') === path.join(__dirname, 'e2e')
  ? __dirname : __dirname; // dev-harness/
const PORT_BAND = /\b(8[7-9]\d\d|9[01]\d\d)\b/g;

// Patterns to replace:
// 1. const FAKE_PORT = 9013, WB_PORT = 9014;
// 2. const FAKE_PORT = 9013;
// 3. const WB_PORT = 9014;
// 4. const PORT = 8700;
// 5. const PORT2 = 8800;
// NOT replaced: port numbers inside strings (URLs), comments (stripped by stripJsComments)

const results = [];
let totalFiles = 0;
let modifiedFiles = 0;

function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let st = 'code';
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

function findPortDeclarations(codeBody) {
  // Find all port constant declarations in the port band
  // Pattern: const VAR_NAME = PORT_NUMBER [, VAR2 = PORT2, ...];
  const re = /\b(const|let)\s+((?:\w+\s*=\s*(?:8[7-9]\d\d|9[01]\d\d)\s*,?\s*)+);/g;
  const matches = [];
  let m;
  while ((m = re.exec(codeBody)) !== null) {
    matches.push({ full: m[0], start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

const e2eFiles = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.e2e.js'))
  .sort();

totalFiles = e2eFiles.length;

for (const file of e2eFiles) {
  const filePath = path.join(__dirname, file);
  const src = fs.readFileSync(filePath, 'utf8');

  // Skip files that already use getFreePort
  if (src.includes('getFreePort')) {
    results.push({ file, status: 'SKIP_ALREADY_DYNAMIC' });
    continue;
  }

  // Check if file has any port-band numbers in non-comment code
  const stripped = stripJsComments(src);
  const portMatches = [...stripped.matchAll(PORT_BAND)];
  if (portMatches.length === 0) {
    results.push({ file, status: 'SKIP_NO_PORTS' });
    continue;
  }

  // Find port constant declarations in the stripped code
  const decls = findPortDeclarations(stripped);
  if (decls.length === 0) {
    // Ports used but not as named constants (inline numbers)
    results.push({ file, status: 'REVIEW_INLINE_PORTS', ports: portMatches.map(m => m[0]) });
    continue;
  }

  // Build the replacement
  let newSrc = src;

  // Collect all port variable names and their port numbers
  const portVars = [];
  for (const decl of decls) {
    const assigns = decl.full.match(/(\w+)\s*=\s*(\d{4})/g);
    if (assigns) {
      for (const a of assigns) {
        const [, varName, portNum] = a.match(/(\w+)\s*=\s*(\d{4})/);
        portVars.push({ varName, portNum });
      }
    }
  }

  // Replace each port declaration line in the ORIGINAL source
  // We need to find these lines in the original (with comments) source
  for (const decl of decls) {
    // Find the declaration in the original source by matching the variable names
    const varNames = portVars.map(v => v.varName);
    const declRe = new RegExp(
      `(const|let)\\s+(${varNames.map(n => n + '\\s*=\\s*\\d{4}').join('\\s*,\\s*')})\\s*;`,
      'm'
    );
    const match = declRe.exec(newSrc);
    if (match) {
      // Build the new declaration with getFreePort()
      const newDecl = `const ${portVars.map(v => `${v.varName} = await getFreePort()`).join(', ')};`;
      newSrc = newSrc.slice(0, match.index) + newDecl + newSrc.slice(match.index + match[0].length);
    }
  }

  // Add import if not already present
  const importLine = `const { getFreePort } = require('./free-port.js');\n`;
  if (!newSrc.includes("require('./free-port.js')")) {
    // Add after the last require() line in the header
    const requireLines = [...newSrc.matchAll(/^(const .+ = require\(.+\));?\s*$/gm)];
    if (requireLines.length > 0) {
      const lastReq = requireLines[requireLines.length - 1];
      const insertPos = lastReq.index + lastReq[0].length;
      newSrc = newSrc.slice(0, insertPos) + '\n' + importLine + newSrc.slice(insertPos);
    } else {
      // No requires found — add at top after 'use strict'
      const useStrict = newSrc.indexOf("'use strict'");
      if (useStrict >= 0) {
        const eol = newSrc.indexOf('\n', useStrict) + 1;
        newSrc = newSrc.slice(0, eol) + importLine + newSrc.slice(eol);
      } else {
        newSrc = importLine + newSrc;
      }
    }
  }

  // Verify the test function is async (it() callback must be async for await)
  // Most e2e files use: it('name', async () => { ... })
  // If the outer test() or it() is not async, we need to add async
  if (!newSrc.includes('async ()') && !newSrc.includes('async function')) {
    results.push({ file, status: 'REVIEW_NOT_ASYNC', ports: portVars });
    continue;
  }

  if (newSrc !== src) {
    modifiedFiles++;
    results.push({ file, status: 'MODIFIED', ports: portVars });
    if (!DRY_RUN) {
      fs.writeFileSync(filePath, newSrc, 'utf8');
    }
  } else {
    results.push({ file, status: 'NO_CHANGE', ports: portVars });
  }
}

// Summary
console.log(`\n=== V1.8-A Phase 1: Port Migration ${DRY_RUN ? '(DRY RUN) ' : ''}===\n`);
console.log(`Total e2e files: ${totalFiles}`);
console.log(`Already dynamic: ${results.filter(r => r.status === 'SKIP_ALREADY_DYNAMIC').length}`);
console.log(`No ports found: ${results.filter(r => r.status === 'SKIP_NO_PORTS').length}`);
console.log(`Modified: ${results.filter(r => r.status === 'MODIFIED').length}`);
console.log(`Need review (inline): ${results.filter(r => r.status === 'REVIEW_INLINE_PORTS').length}`);
console.log(`Need review (not async): ${results.filter(r => r.status === 'REVIEW_NOT_ASYNC').length}`);
console.log('');

for (const r of results) {
  if (r.status !== 'SKIP_NO_PORTS') {
    const ports = r.ports ? (Array.isArray(r.ports) ? r.ports.map(p => typeof p === 'object' ? `${p.varName}=${p.portNum}` : p).join(', ') : '') : '';
    console.log(`  ${r.status.padEnd(25)} ${r.file}${ports ? ' [' + ports + ']' : ''}`);
  }
}
