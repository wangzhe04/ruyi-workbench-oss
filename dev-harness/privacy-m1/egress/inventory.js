#!/usr/bin/env node
'use strict';
// Offline, source-only review tripwire. No application imports, subprocesses, or user configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const portable = value => value.split(path.sep).join('/');
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.py', '.ps1', '.cmd', '.bat', '.cs', '.html', '.sh', '.json', '.toml', '.yaml', '.yml']);
const OMIT_DIRS = new Set(['vendor', 'node_modules', '.git', '__pycache__', '.venv', 'venv', 'tests', 'test', 'dist', 'build', 'build_offline', 'bin', 'obj', 'site-packages', 'python_embed']);
function sourceFiles(root) {
  const found = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (item.isSymbolicLink()) throw new Error('Source symlink requires explicit scope review');
      const full = path.join(dir, item.name), rel = portable(path.relative(root, full));
      if (item.isDirectory()) { if (!OMIT_DIRS.has(item.name)) walk(full); }
      else if (EXTENSIONS.has(path.extname(item.name)) && rel !== 'ruyi-workbench/app/server.js' && !rel.includes('/locales/') && !['package-lock.json'].includes(item.name)) found.push(rel);
    }
  }
  for (const dir of ['ruyi-workbench', 'mcp']) walk(path.join(root, dir));
  return found.sort();
}

// Small conservative lexer, not a JS/Python parser. Strings survive only in hashes; comments disappear.
// Whole-source byte fingerprints are review reminders, never proof that unknown syntax is understood.
function lex(source, python = false) {
  const out = []; let i = 0;
  while (i < source.length) {
    const start = i, c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if ((python && c === '#') || source.startsWith('//', i)) { while (i < source.length && source[i] !== '\n') i++; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const triple = python && source.startsWith(c.repeat(3), i), quote = triple ? c.repeat(3) : c;
      i += quote.length;
      while (i < source.length) { if (source[i] === '\\') { i += 2; continue; } if (source.startsWith(quote, i)) { i += quote.length; break; } i++; }
      out.push({ v: source.slice(start, i), kind: 'string', pos: start }); continue;
    }
    // Regex literals must not manufacture calls from a privacy rule's pattern text.
    if (!python && c === '/' && (!out.length || ['=', '(', '[', ',', ':', 'return', '!', '&&', '||', '?', ';', '{', '=>'].includes(out.at(-1).v))) {
      let j = i + 1, bracket = false;
      for (; j < source.length && source[j] !== '\n'; j++) { if (source[j] === '\\') { j++; continue; } if (source[j] === '[') bracket = true; if (source[j] === ']') bracket = false; if (source[j] === '/' && !bracket) break; }
      if (source[j] === '/') { i = j + 1; while (/[a-z]/i.test(source[i] || '') && i < source.length) i++; out.push({ v: source.slice(start, i), kind: 'regex', pos: start }); continue; }
    }
    if (/[A-Za-z_$]/.test(c)) { i++; while (i < source.length && /[\w$]/.test(source[i])) i++; out.push({ v: source.slice(start, i), kind: 'word', pos: start }); continue; }
    const pair = source.slice(i, i + 2);
    if (['=>', '?.', '&&', '||', '==', '!=', '**'].includes(pair)) i += 2; else i++;
    out.push({ v: source.slice(start, i), kind: 'punct', pos: start });
  }
  return out;
}
const digestTokens = tokens => sha(JSON.stringify(tokens.map(t => t.v)));
function pairs(tokens) {
  const result = new Map(), stack = [];
  for (let i = 0; i < tokens.length; i++) {
    if (['(', '[', '{'].includes(tokens[i].v)) stack.push(i);
    else if ([')', ']', '}'].includes(tokens[i].v)) {
      const open = stack.at(-1);
      if (open !== undefined && ({ '(': ')', '[': ']', '{': '}' })[tokens[open].v] === tokens[i].v) { stack.pop(); result.set(open, i); result.set(i, open); }
    }
  }
  return result;
}
function owners(tokens, matched, source, python) {
  const spans = [];
  if (python) {
    const lines = source.split('\n'); let pos = 0;
    for (let line = 0; line < lines.length; line++) {
      const m = /^(\s*)(?:async\s+)?def\s+([\w]+)\s*\(/.exec(lines[line]);
      if (m) {
        const indent = m[1].length; let end = pos + lines[line].length + 1;
        for (let j = line + 1; j < lines.length; j++) { if (lines[j].trim() && !/^[#)\]]/.test(lines[j].trimStart()) && lines[j].search(/\S/) <= indent) break; end += lines[j].length + 1; }
        spans.push({ name: m[2], start: pos, end });
      }
      pos += lines[line].length + 1;
    }
  } else for (let i = 0; i < tokens.length; i++) {
    let name, body;
    if (tokens[i].v === 'function') {
      name = tokens[i + 1]?.kind === 'word' ? tokens[i + 1].v : '<anonymous>';
      let open = i + 1; while (open < tokens.length && tokens[open].v !== '(') open++;
      body = matched.get(open) + 1;
    } else if (tokens[i].kind === 'word' && tokens[i + 1]?.v === '(' && matched.has(i + 1) && tokens[matched.get(i + 1) + 1]?.v === '{' && !['if', 'for', 'while', 'switch', 'catch', 'with'].includes(tokens[i].v)) {
      name = tokens[i].v; body = matched.get(i + 1) + 1;
    }
    if (name && tokens[body]?.v === '{' && matched.has(body)) spans.push({ name, start: tokens[i].pos, end: tokens[matched.get(body)].pos + 1 });
  }
  return position => spans.filter(s => s.start <= position && position < s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.name || '<module>';
}
const NETWORK_MODULE = /^(?:node:)?(?:https?|http2|net|tls|dgram|dns|child_process|undici|node-fetch|axios|ws|socket|subprocess|requests|httpx|urllib(?:\.request)?|webbrowser)$/;
const SINKS = new Map();
for (const name of ['fetch', 'request', 'urlopen', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'sendBeacon', 'createConnection', 'create_connection', 'connect', 'getaddrinfo', 'resolve4', 'resolve6', 'lookup', 'HTTPConnection', 'HTTPSConnection']) SINKS.set(name, 'network');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'Popen', 'run', 'check_call', 'check_output', 'system', 'create_subprocess_exec', 'create_subprocess_shell', 'startfile', 'Start-Process', 'Start']) SINKS.set(name, 'process');
for (const name of ['writeFile', 'writeFileSync', 'copyFile', 'copyFileSync', 'createWriteStream', 'save', 'Save', 'SaveAs', 'ExportAsFixedFormat', 'write_bytes', 'write_text', 'createObjectURL']) SINKS.set(name, 'file');
for (const name of ['goto', 'navigate', 'Navigate', 'NavigateToString', 'launchPersistentContext', 'launch', 'openExternal', 'connect_over_cdp']) SINKS.set(name, 'delegated');
for (const name of ['providerModelPostOnce', 'providerPostJsonOnce', 'openAiStreamOnce', 'singleSummaryCall', 'httpRequest', 'openHttpRequest', 'spawnDetachedChecked', 'sendMcp', 'sendMcpNotification']) SINKS.set(name, 'wrapper');

function analyze(file, source) {
  const python = file.endsWith('.py'), tokens = lex(source, python), matched = pairs(tokens), owner = owners(tokens, matched, source, python);
  const aliases = new Map();
  // Fixed-point simple aliases, including destructured renamed imports and aliases of aliases.
  for (let pass = 0; pass < 8; pass++) for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'word') continue;
    if (!python && tokens[i + 1]?.v === '=') {
      let end = i + 2; while (end < tokens.length && ![';', '\n'].includes(tokens[end].v) && end < i + 25) end++;
      const rhs = tokens.slice(i + 2, end);
      const candidate = rhs.find(t => SINKS.has(t.v) || aliases.has(t.v));
      if (candidate && rhs.length <= 8 && !rhs.some(t => ['{', '=>', '(', '=', ','].includes(t.v))) aliases.set(tokens[i].v, aliases.get(candidate.v) || candidate.v);
    }
    if (tokens[i + 1]?.v === ':' && tokens[i + 2]?.kind === 'word' && SINKS.has(tokens[i].v)) {
      let open = i - 1; while (open >= 0 && tokens[open].v !== '{') open--;
      const close = matched.get(open);
      if (['const', 'let', 'var'].includes(tokens[open - 1]?.v) && tokens[close + 1]?.v === '=') aliases.set(tokens[i + 2].v, tokens[i].v);
    }
    if (python && tokens[i + 1]?.v === 'as' && tokens[i + 2]?.kind === 'word' && SINKS.has(tokens[i].v)) aliases.set(tokens[i + 2].v, tokens[i].v);
  }
  const findings = [], ordinal = new Map();
  function add(i, category, callee, end = i + 1, uncertainty = '') {
    const symbol = owner(tokens[i].pos), anchor = `${file}#${symbol}#${callee}`;
    const nth = (ordinal.get(anchor) || 0) + 1; ordinal.set(anchor, nth);
    findings.push({ id: anchor + '#' + nth, file, symbol, callee, category, fingerprint: digestTokens(tokens.slice(i, end)), ...(uncertainty ? { uncertainty } : {}) });
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], next = tokens[i + 1]?.v, prev = tokens[i - 1]?.v;
    if (token.kind === 'string' && NETWORK_MODULE.test(token.v.slice(1, -1))) {
      // Capability imports are separate from physical send calls, never added to send totals.
      if (tokens.slice(Math.max(0, i - 6), i).some(t => ['require', 'import', 'from'].includes(t.v))) add(i, 'capability', '<transport-import>', i + 1, 'Imported implementation can add unrecognized or delegated sends');
    }
    if (token.kind === 'string' && token.v[0] === '`' && /\$\{/.test(token.v) && /\b(fetch|request|spawn|exec|import)\s*\(/.test(token.v)) add(i, 'dynamic', '<template-code>', i + 1, 'Template interpolation or embedded program requires manual review');
    if (token.v === ']' && next === '(' && matched.has(i)) add(i, 'dynamic', '<computed-call>', matched.get(i + 1) + 1 || i + 2, 'Computed callable cannot be statically resolved');
    if (['eval', 'Function', 'import'].includes(token.v) && next === '(') add(i, 'dynamic', token.v, matched.get(i + 1) + 1 || i + 2, 'Runtime code/module can introduce additional transports');
    if (['fetch', 'WebSocket', 'XMLHttpRequest'].includes(token.v) && next !== '(' && ![':', '='].includes(next) && !['typeof', 'function', 'def'].includes(prev)) add(i, 'dynamic', '<transport-reference>', i + 1, 'First-class transport reference, callback, binding or alias needs review');
    if (['evaluate', 'executescript', 'AddScriptToExecuteOnDocumentCreatedAsync'].includes(token.v) && next === '(') add(i, 'dynamic', token.v, matched.get(i + 1) + 1 || i + 2, 'Delegated program can fetch, navigate or spawn beyond the host boundary');
    if (token.v === 'download' && ['=', ':'].includes(next)) add(i, 'file', '<browser-download>', i + 2);
    if (['src', 'href', 'srcdoc', 'innerHTML'].includes(token.v) && ['.', '?.'].includes(prev) && next === '=') {
      let end = i + 2; while (end < tokens.length && tokens[end].v !== ';' && end < i + 100) end++;
      add(i, 'delegated', '<dom-' + token.v + '>', end, 'Browser navigation/resource/markup assignment; CSP, sanitization and user activation require manual review');
    }
    if (token.v === 'setAttribute' && next === '(' && ['"src"', "'src'", '"href"', "'href'", '"srcdoc"', "'srcdoc'"].includes(tokens[i + 2]?.v)) add(i, 'delegated', '<dom-attribute>', matched.get(i + 1) + 1 || i + 2, 'Browser resource or markup attribute; final destination and CSP effects require review');
    const actual = aliases.get(token.v) || token.v;
    let category = SINKS.get(actual);
    if ((actual === 'get' && ['http', 'https', 'lib', 'transport'].includes(tokens[i - 2]?.v)) || (actual === 'open' && ['opener', 'window', 'webbrowser', 'browser'].includes(tokens[i - 2]?.v))) category = 'network';
    if (actual === 'write' && tokens.slice(Math.max(0, i - 5), i).some(t => t.v === 'stdin')) category = 'stdio';
    if (actual === 'write' && tokens.slice(Math.max(0, i - 5), i).some(t => t.v === 'stdout')) category = 'stdio-output';
    if (!category || next !== '(' || token.kind !== 'word') continue;
    const end = matched.get(i + 1);
    // Exclude function/method definitions, while retaining calls with callback arguments.
    if (['function', 'def'].includes(prev) || (end !== undefined && ['{', ':'].includes(tokens[end + 1]?.v))) continue;
    // Generic exec/run/get may be local regex, transaction, map, or COM helpers: keep ambiguous calls unknown.
    add(i, category, token.v, end === undefined ? i + 2 : end + 1, aliases.has(token.v) ? `Simple alias of ${actual}; lexical alias resolution is scope-insensitive` : '');
  }
  if (/\.(json|toml|yaml|yml)$/.test(file) && tokens.length) add(0, 'capability', '<configuration>', tokens.length, 'Declarative configuration can define executable, endpoint or connector capabilities');
  if (python) {
    let pos = 0;
    for (const line of source.split('\n')) {
      if (/^\s*(?:from\s+(?:urllib|http|socket|subprocess|requests|httpx|webbrowser)\b|import\s+(?:urllib|http|socket|subprocess|requests|httpx|webbrowser)\b)/.test(line)) {
        const index = tokens.findIndex(t => t.pos >= pos);
        if (index >= 0) add(index, 'capability', '<python-transport-import>', index + 1, 'Python transport/process module; runtime use is not completely statically resolved');
      }
      pos += line.length + 1;
    }
  }
  // Non-JS launch/download boundaries. Fingerprint full line; do not expose arguments or URLs.
  if (/\.(ps1|cmd|bat|sh|cs)$/.test(file)) {
    let pos = 0;
    for (const line of source.split('\n')) {
      if (!/^\s*(#|\/\/|REM\b|::)/i.test(line) && /\b(?:Start-Process|Invoke-WebRequest|Invoke-RestMethod|curl|wget|Process\.Start|\.Start\(|\bstart\s+"|&\s*\$|powershell|cmd\.exe)\b/i.test(line)) {
        const index = tokens.findIndex(t => t.pos >= pos);
        if (index >= 0) add(index, 'dynamic', '<launcher-command>', index + 1, 'Shell/desktop command can delegate network, environment, or local file disclosure');
      }
      pos += line.length + 1;
    }
  }
  return { fingerprint: sha(source), findings };
}
function scan(root = ROOT) {
  const sources = [], findings = [];
  for (const file of sourceFiles(root)) {
    const bytes = fs.readFileSync(path.join(root, file));
    const data = analyze(file, bytes.toString('utf8'));
    sources.push({ file, fingerprint: sha(bytes) }); findings.push(...data.findings);
  }
  return { schemaVersion: 1, scope: ['ruyi-workbench', 'mcp'], excluded: ['app/server.js (generated concatenation)', ...[...OMIT_DIRS].sort()], sources, findings: findings.sort((a, b) => a.id.localeCompare(b.id, 'en')) };
}
const STATUSES = new Set(['protected', 'model-only', 'bypassed', 'blocked', 'unknown', 'local-only', 'non-egress']);
function validate(scanResult, manifest) {
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push('manifest-schema');
  const oldSources = new Map((manifest.sources || []).map(s => [s.file, s.fingerprint]));
  for (const s of scanResult.sources) { if (oldSources.get(s.file) !== s.fingerprint) errors.push('source-unreviewed:' + s.file); oldSources.delete(s.file); }
  for (const file of oldSources.keys()) errors.push('source-deleted:' + file);
  const entries = new Map();
  for (const e of manifest.entries || []) { if (entries.has(e.id)) errors.push('duplicate-classification:' + e.id); entries.set(e.id, e); }
  for (const f of scanResult.findings) {
    const e = entries.get(f.id); entries.delete(f.id);
    if (!e) { errors.push('unclassified:' + f.id); continue; }
    if (e.fingerprint !== f.fingerprint) errors.push('changed-boundary:' + f.id);
    const policy = manifest.groups?.[e.group];
    if (!policy || !STATUSES.has(policy.privacyStatus) || !policy.recipient || !policy.purpose || !policy.transport || !Array.isArray(policy.dataClasses) || !policy.dataClasses.length || !policy.evidence || !policy.productionRelation) errors.push('invalid-classification:' + f.id);
    if (policy?.privacyStatus === 'protected' && !policy.runtimeEvidence) errors.push('protected-without-runtime-evidence:' + f.id);
    if ((f.category === 'dynamic' || f.uncertainty) && policy && !['unknown', 'model-only', 'local-only', 'non-egress'].includes(policy.privacyStatus)) errors.push('unresolved-claim:' + f.id);
  }
  for (const id of entries.keys()) errors.push('stale-classification:' + id);
  return errors;
}
function render(scanResult, manifest) {
  const entries = new Map((manifest.entries || []).map(e => [e.id, e]));
  return { ...scanResult, manifestFingerprint: sha(JSON.stringify(manifest)), groups: manifest.groups, reviewErrors: validate(scanResult, manifest), findings: scanResult.findings.map(f => ({ ...f, group: entries.get(f.id)?.group || null })) };
}
function markdown(result) {
  const rows = result.findings.map(f => { const c = result.groups?.[f.group] || {}; return `| \`${f.file}\` | \`${f.symbol}\` / \`${f.callee}\` | ${f.category} | ${c.privacyStatus || 'unknown'} | ${c.recipient || 'unknown'} |`; });
  return '# Privacy egress inventory — M1 source review prototype\n\n' +
    'Generated by `node dev-harness/privacy-m1/egress/inventory.js --write`. The manual manifest is `dev-harness/privacy-m1/egress/manifest.json`. No product privacy behavior is changed.\n\n' +
    `Reviewed source files: ${result.sources.length}; boundary/capability candidates: ${result.findings.length}; review errors: ${result.reviewErrors.length}. These are candidates, not a count of proven external sends. Generated server.js is excluded.\n\n` +
    'UI same-origin calls, local IPC, local file storage, delegated processes, module capabilities, dynamic unknowns and physical network calls remain separate categories. Full classifications, data classes, transport, purpose and production call relations are in the JSON. Unknown is a reviewed limitation, not protection.\n\n' +
    'Runbook, model entry audit and static limitations: [egress/AUDIT.md](../../dev-harness/privacy-m1/egress/AUDIT.md).\n\n' +
    '| Source | Symbol / call | Category | Current privacy status | Recipient |\n|---|---|---|---|---|\n' + rows.join('\n') + '\n';
}
function formatJson(value) {
  return '{\n' + Object.entries(value).map(([key, entry]) => {
    const formatted = ['sources', 'entries', 'findings'].includes(key) && Array.isArray(entry)
      ? '[\n' + entry.map(item => '    ' + JSON.stringify(item)).join(',\n') + '\n  ]'
      : JSON.stringify(entry, null, 2).replace(/\n/g, '\n  ');
    return '  ' + JSON.stringify(key) + ': ' + formatted;
  }).join(',\n') + '\n}\n';
}
function cli(args = process.argv.slice(2)) {
  const result = scan(), manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const rendered = render(result, manifest), json = formatJson(rendered), md = markdown(rendered);
  const jsonPath = path.join(ROOT, 'docs/architecture/privacy-egress-inventory.json'), mdPath = path.join(ROOT, 'docs/architecture/privacy-egress-inventory.md');
  if (args.includes('--write')) { fs.writeFileSync(jsonPath, json); fs.writeFileSync(mdPath, md); }
  const errors = [...rendered.reviewErrors];
  if (args.includes('--check') && (!fs.existsSync(jsonPath) || fs.readFileSync(jsonPath, 'utf8') !== json || !fs.existsSync(mdPath) || fs.readFileSync(mdPath, 'utf8') !== md)) errors.push('generated-inventory-stale');
  // Source excerpts, literal payloads, headers and configured recipients are never printed.
  console.log(JSON.stringify({ sourceFiles: result.sources.length, candidates: result.findings.length, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
module.exports = { sourceFiles, lex, analyze, scan, validate, render, markdown, formatJson, cli };
if (require.main === module) cli();
