#!/usr/bin/env node
'use strict';
// Wave 103b: zero-dependency dependency contracts for the build-time concatenated backend.
//
// The source modules intentionally share one script scope. This scanner turns that implicit scope into
// a reviewable contract without changing runtime loading: top-level declarations are `provides`, and
// identifier reads/calls resolved to another module are `requires`. Generated files are committed so a
// source-only cross-module reference fails --check until its contract/documentation is reviewed.
//
// Usage:
//   node dev-harness/module-dependency-graph.js --write
//   node dev-harness/module-dependency-graph.js --check
//   node dev-harness/module-dependency-graph.js --bootstrap-policy  # maintainer-only baseline creation
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const DOCS = path.join(ROOT, 'docs', 'architecture');
const MANIFEST_PATH = path.join(SRC, 'manifest.json');
const CONTRACT_PATH = path.join(SRC, 'module-contracts.json');
const POLICY_PATH = path.join(SRC, 'module-dependency-policy.json');
const GRAPH_PATH = path.join(DOCS, 'module-dependency-graph.json');
const MARKDOWN_PATH = path.join(DOCS, 'module-dependency-graph.md');

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return',
  'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined',
  'var', 'void', 'while', 'with', 'yield',
]);

function rel(file) { return file.replace(/\\/g, '/'); }
function stableJson(value) { return JSON.stringify(value, null, 2) + '\n'; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function moduleLayer(file) {
  if (/^00-/.test(file)) return 'bootstrap';
  if (/^0[1-4]-/.test(file)) return 'foundation';
  if (/^0[56][a-z]?-/.test(file)) return 'engine';
  if (/^(07|08|09|10)-/.test(file)) return 'orchestration';
  if (/^(11|12)-/.test(file)) return 'tools';
  if (/^13[a-z]?-/.test(file)) return 'transport';
  if (/^14-/.test(file)) return 'entrypoint';
  return 'unclassified';
}

function isIdentifierStart(ch) { return /[A-Za-z_$]/.test(ch || ''); }
function isIdentifierPart(ch) { return /[A-Za-z0-9_$]/.test(ch || ''); }

// Tokenizer deliberately discards comments, string/regex bodies and template literal text. `${...}` inside
// templates is retained by a small recursive code-mode stack, so dependencies used only in interpolation
// are not silently missed. It is not a general parser; node --check remains the syntax authority.
function tokenize(source) {
  const tokens = [];
  let i = 0, line = 1;
  const modeStack = [{ type: 'code', templateExprDepth: null }];
  let prev = null;
  const push = (type, value, start, tokenLine) => {
    const token = { type, value, start, line: tokenLine };
    tokens.push(token);
    prev = token;
  };
  const regexCanStart = () => {
    if (!prev) return true;
    if (prev.type === 'id') return new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do']).has(prev.value);
    return !new Set([')', ']', '}', '++', '--']).has(prev.value);
  };
  while (i < source.length) {
    const mode = modeStack[modeStack.length - 1];
    const ch = source[i], next = source[i + 1];
    if (mode.type === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { modeStack.pop(); i++; continue; }
      if (ch === '$' && next === '{') {
        modeStack.push({ type: 'code', templateExprDepth: 1 });
        push('punct', '{', i, line);
        i += 2;
        continue;
      }
      if (ch === '\n') line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) { if (ch === '\n') line++; i++; continue; }
    if (ch === '/' && next === '/') {
      i += 2; while (i < source.length && source[i] !== '\n') i++; continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch; i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        if (source[i] === '\n') line++;
        i++;
      }
      continue;
    }
    if (ch === '`') { modeStack.push({ type: 'template' }); i++; continue; }
    if (ch === '/' && regexCanStart()) {
      i++; let inClass = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) { i++; while (/[A-Za-z]/.test(source[i] || '')) i++; break; }
        if (source[i] === '\n') line++;
        i++;
      }
      continue;
    }
    if (isIdentifierStart(ch)) {
      const start = i, tokenLine = line;
      i++; while (isIdentifierPart(source[i])) i++;
      push('id', source.slice(start, i), start, tokenLine);
      continue;
    }
    const three = source.slice(i, i + 3), two = source.slice(i, i + 2);
    const punct = ['===', '!==', '>>>', '**=', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '++', '--', '&&', '||', '??', '?.', '**', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(three)
      ? three : (['=>', '==', '!=', '<=', '>=', '++', '--', '&&', '||', '??', '?.', '**', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='].includes(two) ? two : ch);
    push('punct', punct, i, line);
    i += punct.length;
    if (mode.templateExprDepth != null) {
      if (punct === '{') mode.templateExprDepth++;
      else if (punct === '}') {
        mode.templateExprDepth--;
        if (mode.templateExprDepth === 0) modeStack.pop();
      }
    }
  }
  return tokens;
}

function declarationInfo(tokens) {
  const provides = [];
  const declarationTokenIndexes = new Set();
  let braces = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const atTop = braces === 0;
    if (atTop && token.type === 'id' && (token.value === 'function' || token.value === 'class')) {
      let j = i + 1;
      if (tokens[j] && tokens[j].value === '*') j++;
      if (tokens[j] && tokens[j].type === 'id') {
        provides.push({ name: tokens[j].value, kind: token.value, line: tokens[j].line });
        declarationTokenIndexes.add(j);
      }
    }
    if (atTop && token.type === 'id' && ['const', 'let', 'var'].includes(token.value)) {
      let parens = 0, brackets = 0, objects = 0, expectBinding = true, destructure = false;
      for (let j = i + 1; j < tokens.length; j++) {
        const part = tokens[j];
        if (part.value === ';' && parens === 0 && brackets === 0 && objects === 0) { i = j; break; }
        if (expectBinding && part.value === '{' && parens === 0 && brackets === 0 && objects === 0) { destructure = true; objects = 1; continue; }
        if (destructure) {
          if (part.value === '{') objects++;
          else if (part.value === '}') { objects--; if (objects === 0) { destructure = false; expectBinding = false; } }
          else if (objects === 1 && part.type === 'id' && !KEYWORDS.has(part.value)) {
            const previous = tokens[j - 1] && tokens[j - 1].value;
            const next = tokens[j + 1] && tokens[j + 1].value;
            if (previous !== '.' && previous !== '?.' && next !== ':') {
              provides.push({ name: part.value, kind: token.value, line: part.line });
              declarationTokenIndexes.add(j);
            }
          }
          continue;
        }
        if (expectBinding && part.type === 'id' && !KEYWORDS.has(part.value)) {
          provides.push({ name: part.value, kind: token.value, line: part.line });
          declarationTokenIndexes.add(j);
          expectBinding = false;
          continue;
        }
        if (part.value === '(') parens++;
        else if (part.value === ')') parens--;
        else if (part.value === '[') brackets++;
        else if (part.value === ']') brackets--;
        else if (part.value === '{') objects++;
        else if (part.value === '}') objects--;
        else if (part.value === ',' && parens === 0 && brackets === 0 && objects === 0) expectBinding = true;
      }
    }
    if (token.value === '{') braces++;
    else if (token.value === '}') braces = Math.max(0, braces - 1);
  }
  return { provides, declarationTokenIndexes };
}

function stronglyConnectedComponents(moduleNames, edges) {
  const adjacency = new Map(moduleNames.map(name => [name, []]));
  for (const edge of edges) adjacency.get(edge.from).push(edge.to);
  let index = 0;
  const stack = [], onStack = new Set(), indexes = new Map(), low = new Map(), result = [];
  function visit(node) {
    indexes.set(node, index); low.set(node, index); index++; stack.push(node); onStack.add(node);
    for (const next of adjacency.get(node)) {
      if (!indexes.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indexes.get(next)));
    }
    if (low.get(node) === indexes.get(node)) {
      const component = [];
      while (stack.length) {
        const value = stack.pop(); onStack.delete(value); component.push(value);
        if (value === node) break;
      }
      if (component.length > 1) result.push(component.sort());
    }
  }
  for (const name of moduleNames) if (!indexes.has(name)) visit(name);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

function edgeKey(edge) { return `${edge.from}->${edge.to}`; }

function buildGraph() {
  const manifest = readJson(MANIFEST_PATH);
  const entries = manifest.modules.map((item, index) => ({
    file: typeof item === 'string' ? item : item.file,
    index,
    note: typeof item === 'string' ? '' : String(item.note || ''),
  }));
  const analyses = entries.map(entry => {
    const source = fs.readFileSync(path.join(SRC, entry.file), 'utf8');
    const tokens = tokenize(source);
    return { ...entry, layer: moduleLayer(entry.file), tokens, ...declarationInfo(tokens) };
  });
  const providers = new Map();
  for (const analysis of analyses) {
    for (const symbol of analysis.provides) {
      if (!providers.has(symbol.name)) providers.set(symbol.name, []);
      providers.get(symbol.name).push({ file: analysis.file, line: symbol.line, kind: symbol.kind });
    }
  }
  const duplicates = [...providers.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([symbol, owners]) => ({ symbol, owners }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const uniqueProviders = new Map([...providers.entries()].filter(([, owners]) => owners.length === 1).map(([name, owners]) => [name, owners[0]]));
  const requirements = new Map(analyses.map(item => [item.file, new Map()]));
  for (const analysis of analyses) {
    for (let i = 0; i < analysis.tokens.length; i++) {
      const token = analysis.tokens[i];
      if (token.type !== 'id' || KEYWORDS.has(token.value) || analysis.declarationTokenIndexes.has(i)) continue;
      const owner = uniqueProviders.get(token.value);
      if (!owner || owner.file === analysis.file) continue;
      const previous = analysis.tokens[i - 1] && analysis.tokens[i - 1].value;
      const next = analysis.tokens[i + 1] && analysis.tokens[i + 1].value;
      if (previous === '.' || previous === '?.' || next === ':') continue;
      const map = requirements.get(analysis.file);
      const key = `${owner.file}\0${token.value}`;
      const existing = map.get(key) || { provider: owner.file, symbol: token.value, kinds: new Set(), lines: new Set() };
      existing.kinds.add(next === '(' || (previous === 'new' && next === '(') ? 'call' : 'read');
      existing.lines.add(token.line);
      map.set(key, existing);
    }
  }
  const modules = analyses.map(analysis => ({
    file: analysis.file,
    order: analysis.index,
    layer: analysis.layer,
    note: analysis.note,
    provides: analysis.provides.map(item => item.name).sort(),
    requires: [...requirements.get(analysis.file).values()].map(item => ({
      provider: item.provider,
      symbol: item.symbol,
      kinds: [...item.kinds].sort(),
      lines: [...item.lines].sort((a, b) => a - b),
    })).sort((a, b) => a.provider.localeCompare(b.provider) || a.symbol.localeCompare(b.symbol)),
  }));
  const edgeMap = new Map();
  for (const module of modules) for (const req of module.requires) {
    const key = `${module.file}\0${req.provider}`;
    const edge = edgeMap.get(key) || { from: module.file, to: req.provider, symbols: [] };
    edge.symbols.push(req.symbol);
    edgeMap.set(key, edge);
  }
  const order = new Map(entries.map(entry => [entry.file, entry.index]));
  const edges = [...edgeMap.values()].map(edge => ({
    ...edge,
    symbols: [...new Set(edge.symbols)].sort(),
    direction: order.get(edge.to) <= order.get(edge.from) ? 'backward' : 'forward',
  })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const sccs = stronglyConnectedComponents(entries.map(entry => entry.file), edges);
  const cyclicModules = new Set(sccs.flat());
  const cycleEdges = edges.filter(edge => cyclicModules.has(edge.from) && sccs.some(scc => scc.includes(edge.from) && scc.includes(edge.to)));
  return {
    schema: 1,
    generatedFrom: 'ruyi-workbench/app/src/manifest.json + module source',
    scanner: 'dev-harness/module-dependency-graph.js',
    summary: {
      modules: modules.length,
      providedSymbols: modules.reduce((sum, item) => sum + item.provides.length, 0),
      requiredSymbols: modules.reduce((sum, item) => sum + item.requires.length, 0),
      edges: edges.length,
      forwardEdges: edges.filter(edge => edge.direction === 'forward').length,
      duplicateProvides: duplicates.length,
      stronglyConnectedComponents: sccs.length,
    },
    modules,
    edges,
    duplicateProvides: duplicates,
    stronglyConnectedComponents: sccs,
    cycleEdgeKeys: cycleEdges.map(edgeKey).sort(),
    forwardEdgeKeys: edges.filter(edge => edge.direction === 'forward').map(edgeKey).sort(),
  };
}

function buildContract(graph) {
  return {
    schema: 1,
    note: '103b companion contract. Generated by dev-harness/module-dependency-graph.js; CI rejects source/contract drift.',
    modules: graph.modules.map(module => ({
      file: module.file,
      layer: module.layer,
      provides: module.provides,
      requires: module.requires.map(req => ({ provider: req.provider, symbol: req.symbol, kinds: req.kinds })),
    })),
  };
}

function buildPolicy(graph) {
  return {
    schema: 1,
    note: '103b architectural debt ceiling. The generator never widens this file during --write; additions require explicit architecture review.',
    allowedCycleEdges: graph.cycleEdgeKeys,
    allowedForwardEdges: graph.forwardEdgeKeys,
  };
}

function buildMarkdown(graph) {
  const lines = [
    '# 后端模块依赖图（第 103b 波）', '',
    '> 本文件由 `node dev-harness/module-dependency-graph.js --write` 从 `app/src/manifest.json` 与源码生成。请勿手改。',
    '> `provides/requires` 是构建期拼接作用域的显式契约；运行时仍执行单文件 `app/server.js`。', '',
    '## 摘要', '',
    '| 模块 | 顶层符号 | 跨模块符号引用 | 模块边 | 前向边 | 重复导出 | 强连通分量 |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    `| ${graph.summary.modules} | ${graph.summary.providedSymbols} | ${graph.summary.requiredSymbols} | ${graph.summary.edges} | ${graph.summary.forwardEdges} | ${graph.summary.duplicateProvides} | ${graph.summary.stronglyConnectedComponents} |`, '',
    '“前向边”表示较早拼接的模块引用较晚模块，依赖函数提升或延迟执行；它不是自动判错，但已由债务上限锁住，禁止无评审增加。', '',
    '## 模块清单', '',
    '| # | 模块 | 层 | provides | requires | 直接依赖 |',
    '|---:|---|---|---:|---:|---:|',
  ];
  for (const module of graph.modules) {
    lines.push(`| ${module.order} | \`${module.file}\` | ${module.layer} | ${module.provides.length} | ${module.requires.length} | ${new Set(module.requires.map(req => req.provider)).size} |`);
  }
  lines.push('', '## 模块边', '', '| 调用方 | 提供方 | 方向 | 符号 |', '|---|---|---|---|');
  for (const edge of graph.edges) lines.push(`| \`${edge.from}\` | \`${edge.to}\` | ${edge.direction} | ${edge.symbols.map(s => `\`${s}\``).join(', ')} |`);
  lines.push('', '## 强连通分量', '');
  if (!graph.stronglyConnectedComponents.length) lines.push('无。');
  else graph.stronglyConnectedComponents.forEach((scc, index) => lines.push(`${index + 1}. ${scc.map(file => `\`${file}\``).join(' ↔ ')}`));
  lines.push('', '## 维护规则', '',
    '- 源码新增或删除跨模块引用时，契约与本图必须同步更新；`--check`/CI 会拒绝漂移。',
    '- 重复顶层导出名始终拒绝。循环边和前向边只能减少；若确需增加，必须显式修改 `module-dependency-policy.json` 并说明理由。',
    '- 隔离批次优先把内部符号收进命名空间，只暴露真实公共面；每批保持拼接顺序和运行语义。', '');
  return lines.join('\n');
}

function policyViolations(graph, policy) {
  const allowedCycles = new Set((policy && policy.allowedCycleEdges) || []);
  const allowedForward = new Set((policy && policy.allowedForwardEdges) || []);
  return {
    cycles: graph.cycleEdgeKeys.filter(key => !allowedCycles.has(key)),
    forward: graph.forwardEdgeKeys.filter(key => !allowedForward.has(key)),
  };
}

function generatedArtifacts(graph) {
  return new Map([
    [CONTRACT_PATH, stableJson(buildContract(graph))],
    [GRAPH_PATH, stableJson(graph)],
    [MARKDOWN_PATH, buildMarkdown(graph)],
  ]);
}

function checkGraph(graph) {
  const errors = [];
  for (const [file, expected] of generatedArtifacts(graph)) {
    const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (actual !== expected) errors.push(`${rel(path.relative(ROOT, file))} 与源码不一致（运行 --write）`);
  }
  if (graph.duplicateProvides.length) errors.push(`重复顶层导出: ${graph.duplicateProvides.map(item => item.symbol).join(', ')}`);
  if (!fs.existsSync(POLICY_PATH)) errors.push(`${rel(path.relative(ROOT, POLICY_PATH))} 缺失`);
  else {
    const violations = policyViolations(graph, readJson(POLICY_PATH));
    if (violations.cycles.length) errors.push(`新增循环边: ${violations.cycles.join(', ')}`);
    if (violations.forward.length) errors.push(`新增前向/越层边: ${violations.forward.join(', ')}`);
  }
  return errors;
}

function main() {
  const graph = buildGraph();
  const argv = new Set(process.argv.slice(2));
  if (argv.has('--bootstrap-policy')) {
    fs.writeFileSync(POLICY_PATH, stableJson(buildPolicy(graph)), 'utf8');
    console.log(`module dependency policy: ${rel(path.relative(ROOT, POLICY_PATH))}`);
  }
  if (argv.has('--write') || argv.has('--bootstrap-policy')) {
    fs.mkdirSync(DOCS, { recursive: true });
    for (const [file, content] of generatedArtifacts(graph)) fs.writeFileSync(file, content, 'utf8');
    console.log(`module dependency graph: ${graph.summary.modules} modules, ${graph.summary.edges} edges, ${graph.summary.stronglyConnectedComponents} SCC`);
  }
  if (argv.has('--check')) {
    const errors = checkGraph(graph);
    if (errors.length) { console.error(`module dependency graph --check: FAIL\n  - ${errors.join('\n  - ')}`); process.exit(1); }
    console.log(`module dependency graph --check: PASS (${graph.summary.modules} modules, ${graph.summary.edges} edges)`);
  }
  if (![...argv].some(arg => ['--write', '--check', '--bootstrap-policy'].includes(arg))) {
    process.stdout.write(stableJson(graph.summary));
  }
}

if (require.main === module) main();

module.exports = { buildGraph, buildContract, buildPolicy, buildMarkdown, policyViolations, tokenize, declarationInfo };
