'use strict';
// 151 阶段 5 P14 的机械锁:研究证据归档(dev-harness/archive/semantic-research-d5d3caff.*)。
//   ① 冻结身份:清单字节的 sha256 钉死在本文件;SHA256SUMS 与之一致。
//   ② 清单与归档一致:逐条目 sha256 / 字节数 / git blob 号 / 顺序,tar 为规范形(用读出的条目重写逐字节相同)。
//   ③ 校验器不是空转:改一个字节、少一条、多一条、改一个名字,各自都被报出来。
//   ④ 默认回归加载不到归档内的件:归档路径在工作区里都已不存在;unit glob 与 run-all 的发现集合里没有它们;
//      dev-harness 与 ruyi-workbench/tools 里没有一处代码再按路径去找研究目录;CI 只跑 unit glob 与 run-all;
//      研究目录里的名字恰为清单 notArchived 声明的那些(本机 .gitignore 挡住的盲测材料名除外)。
//   ⑤ 盲测材料从不进包,只按名字登记在 notArchived。
// 本锁对 dev-harness/semantic/ 只列名字;读内容的只有两份留在原处的产品维护脚本(核它们只依赖产品文件)。
// 盲测件从不打开。不需要 git(CI 是浅克隆)。
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const A = require('../lib/research-archive');
const { MOVED, KEPT_CONFIG, BASENAME, ARCHIVE_DIR } = require('../research-archive');

const ROOT = path.resolve(__dirname, '../..'), HARNESS = path.resolve(__dirname, '..');
const FROZEN_MANIFEST_SHA256 = '211dccf41c9ebd52fd8412e99f8f472768f451aa7cc8ef6df6bee8daccb218c0';
const names = {
  manifestFile: path.join(ARCHIVE_DIR, BASENAME + '.manifest.json'),
  archiveFile: path.join(ARCHIVE_DIR, BASENAME + '.tar.gz'),
  sumsFile: path.join(ARCHIVE_DIR, BASENAME + '.sha256'),
};
const manifest = JSON.parse(fs.readFileSync(names.manifestFile, 'utf8'));
let verified;
const verifiedArchive = () => (verified ||= A.verifyArchive(names));

test('① frozen identity: the pinned manifest sha256 and SHA256SUMS name the same manifest bytes', () => {
  const bytes = fs.readFileSync(names.manifestFile);
  assert.equal(A.sha256(bytes), FROZEN_MANIFEST_SHA256, 'the frozen research manifest changed; it is evidence and must not be rewritten');
  const sums = A.parseSums(fs.readFileSync(names.sumsFile, 'utf8'));
  assert.deepEqual([...sums.keys()].sort(), [BASENAME + '.manifest.json', BASENAME + '.tar.gz'].sort());
  assert.equal(sums.get(BASENAME + '.manifest.json'), FROZEN_MANIFEST_SHA256);
  assert.equal(sums.get(BASENAME + '.tar.gz'), manifest.archive.sha256);
  assert.match(manifest.sourceCommit, /^d5d3caff[0-9a-f]{32}$/);
});

test('② archive matches the manifest entry by entry and is in canonical ustar form', () => {
  const result = verifiedArchive();
  assert.deepEqual(result.problems, []);
  assert.equal(result.entries.length, manifest.files.length);
  assert.equal(manifest.counts.files, manifest.files.length);
  assert.equal(manifest.counts.movedTests + manifest.counts.semanticResearch, manifest.files.length);
  assert.ok(manifest.files.length >= 900, 'scanner must actually see the archived research set, got ' + manifest.files.length);
  assert.equal(result.archiveSha256, manifest.archive.sha256);
});

test('③ the verifier reports a flipped byte, a dropped entry, an extra entry and a renamed entry', () => {
  const entries = verifiedArchive().entries;
  assert.ok(entries.length > 2);
  const flipped = entries.map((entry, i) => i === 1 ? { ...entry, bytes: Buffer.from(entry.bytes.map((b, j) => j === 0 ? b ^ 1 : b)) } : entry);
  assert.ok(A.verifyEntries(manifest, flipped).some(p => p.startsWith('sha256 mismatch: ' + entries[1].path)));
  assert.ok(A.verifyEntries(manifest, entries.slice(1)).some(p => p === 'missing from archive: ' + entries[0].path));
  const extra = [...entries, { path: 'dev-harness/unit/extra.test.js', bytes: Buffer.from('x') }];
  assert.ok(A.verifyEntries(manifest, extra).some(p => p === 'not in manifest: dev-harness/unit/extra.test.js'));
  const renamed = entries.map((entry, i) => i === 0 ? { ...entry, path: entry.path + '.renamed' } : entry);
  const problems = A.verifyEntries(manifest, renamed);
  assert.ok(problems.includes('missing from archive: ' + entries[0].path) && problems.includes('not in manifest: ' + entries[0].path + '.renamed'));
  // 包本身改一个字节:gzip 校验或摘要必报。
  const gz = fs.readFileSync(names.archiveFile), bad = Buffer.from(gz); bad[Math.floor(bad.length / 2)] ^= 0xff;
  assert.notEqual(A.sha256(bad), manifest.archive.sha256);
  assert.throws(() => A.readTar(A.gunzip(bad)));
});

test('④a every archived path is gone from the working tree, so nothing in the repo can load it', () => {
  const present = manifest.files.map(row => row.path).filter(p => fs.existsSync(path.join(ROOT, ...p.split('/'))));
  assert.deepEqual(present, []);
});

test('④b unit glob and run-all discovery contain no archived research test', () => {
  // 与 node --test "dev-harness/unit/*.test.js"、run-all 的 listE2e、facts-generate 同一条发现规则。
  const unit = fs.readdirSync(path.join(HARNESS, 'unit')).filter(f => f.endsWith('.test.js')).map(f => 'dev-harness/unit/' + f);
  const e2e = fs.readdirSync(HARNESS).filter(f => f.endsWith('.e2e.js')).map(f => 'dev-harness/' + f);
  assert.ok(unit.length > 100 && e2e.length > 100, 'discovery must see the real suites');
  const archived = new Set(manifest.files.map(row => row.path));
  assert.deepEqual([...unit, ...e2e].filter(p => archived.has(p)), []);
  assert.deepEqual(manifest.movedOutOfDefaultRegression.map(row => row.path), MOVED.map(row => row.path));
  for (const row of manifest.movedOutOfDefaultRegression) {
    assert.ok(archived.has(row.path), row.path + ' is archived');
    assert.ok(['unit', 'run-all'].includes(row.suite) && row.reason.length > 10, row.path + ' records why it left the default regression');
  }
});

const RESEARCH_REFERENCES = [
  // require('../semantic/x.cjs')、'dev-harness/semantic/x'、'semantic/x'、__dirname + '/semantic/x'、`${HARNESS}/semantic/x`
  /(?:(?:dev-harness|\.\.?)[\\/]+|['"`][\\/]*|\}[\\/]+)semantic[\\/]/,
  /\.(?:join|resolve)\([^)]*['"`]semantic['"`]\s*[,)]/s,                        // path.join / p.join(__dirname, '..', 'semantic', …),接收者不限、参数可跨行
  /semantic-research-[0-9a-f]{8}\.tar\.gz/,                                   // 归档本身只许本锁与归档工具引用
];
const BLIND_NAME = /blind|v7|盲测/i;
const OWN = new Set([__filename, path.join(HARNESS, 'research-archive.js'), path.join(HARNESS, 'lib', 'research-archive.js')].map(p => path.resolve(p)));
// 扫描面:dev-harness 全树(研究目录与 archive/ 除外)加 ruyi-workbench/tools。
function harnessSources(dir = HARNESS, out = { files: [], skippedBlind: [] }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 研究目录只剩盲测材料与两份产品维护脚本,从不遍历(其名字集合由 ④e 单独钉);archive/ 是冻结证据本身。
      if (dir === HARNESS && (entry.name === 'semantic' || entry.name === 'archive')) continue;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (BLIND_NAME.test(entry.name)) { out.skippedBlind.push(path.relative(ROOT, full)); continue; }
      harnessSources(full, out);
    } else if (/\.(?:c|m)?js$/.test(entry.name) && !OWN.has(path.resolve(full))) {
      if (BLIND_NAME.test(entry.name)) out.skippedBlind.push(path.relative(ROOT, full));
      else out.files.push(full);
    }
  }
  return out;
}
const scannedSources = () => {
  const out = harnessSources();
  harnessSources(path.join(ROOT, 'ruyi-workbench', 'tools'), out);
  return out;
};
const researchHits = text => RESEARCH_REFERENCES.filter(pattern => pattern.test(text)).map(pattern => pattern.source);

test('④c no harness or tools code addresses the research directory or the archive by path', () => {
  const { files } = scannedSources();
  assert.ok(files.length > 1000, 'scanner must see the real harness, got ' + files.length);
  assert.ok(files.some(f => f.endsWith(path.join('unit', 'semantic-production-admission.test.js'))));
  assert.ok(files.some(f => f.includes(path.join('ruyi-workbench', 'tools') + path.sep)), 'ruyi-workbench/tools is scanned');
  const hits = [];
  for (const file of files) for (const source of researchHits(fs.readFileSync(file, 'utf8'))) hits.push(path.relative(ROOT, file) + ' ~ ' + source);
  assert.deepEqual(hits, []);
  // 判据自身能命中原形与各绕过形状(防正则失明)。
  for (const sample of ["require('../semantic/calibration-fixture.cjs')", "path.resolve(__dirname, 'semantic/native-host-prototype.cjs')",
    "path.join(ROOT,'dev-harness/semantic/resident-proxy-matrix-worker.cjs')", "path.join(HARNESS, 'semantic', 'x.cjs')",
    "path.join(\n  __dirname,\n  'semantic',\n  'x.cjs')", '`${HARNESS}/semantic/x.cjs`', "__dirname + '/semantic/x.cjs'", "__dirname + '\\\\semantic\\\\x.cjs'",
    "const p = require('path'); p.join(__dirname,\n'..',\n'semantic','x.cjs')"]) {
    assert.ok(researchHits(sample).length, sample);
  }
});

// .gitignore 里挡住的盲测材料名规则(只在本机主树里存在、从不入库)。只按名字匹配,不读内容。
function ignoredBlindPatterns(text = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')) {
  return text.split(/\r?\n/)
    .map(line => /^\/dev-harness\/semantic\/([A-Za-z0-9_.-]+)\*$/.exec(line.trim())).filter(Boolean)
    .map(m => new RegExp('^dev-harness/semantic/' + m[1].replace(/[.]/g, '\\.')));
}
// 列名字(不读内容),返回仓库相对、以 / 分隔的文件路径;目录本身不列 —— 目录只经它仍含的文件被看见。
function semanticFileNames(dir, prefix = 'dev-harness/semantic/', out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) semanticFileNames(path.join(dir, entry.name), prefix + entry.name + '/', out);
    else out.push(prefix + entry.name);
  }
  return out;
}
// Python 字节码缓存:主树检出本提交后,git 删掉跟踪文件,全局 .gitignore 挡住的 __pycache__/*.pyc 与其目录会留下。
const PYTHON_CACHE = name => /(^|\/)__pycache__(\/|$)/.test(name) || /\.pyc$/i.test(name);
// 名字清单里没被声明的那些。只容忍两类:Python 字节码缓存;既命中 .gitignore 规则、又按名字是盲测材料的本机未入库件。
function undeclaredSemanticNames(names, declared, ignoredPatterns) {
  return names.filter(name => !PYTHON_CACHE(name))
    .filter(name => !(ignoredPatterns.some(re => re.test(name)) && A.isBlindMaterialPath(name)))
    .filter(name => !declared.has(name));
}

test('④e the research directory holds exactly the declared not-archived files, nothing grows back', () => {
  const declared = new Set(manifest.notArchived.map(row => row.path));
  const ignored = ignoredBlindPatterns();
  assert.ok(ignored.length >= 1, '.gitignore still names the local blind material');
  const names = semanticFileNames(path.join(HARNESS, 'semantic'));
  assert.deepEqual(undeclaredSemanticNames(names, declared, ignored), [], 'undeclared names under dev-harness/semantic');
  assert.deepEqual([...declared].filter(p => !names.includes(p)), [], 'declared not-archived files are present');
});

test('④e tolerates Python caches and git-ignored blind names only; a research file or a widened .gitignore rule is caught', () => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'research-archive-names-'));
  try {
    const semantic = path.join(base, 'semantic'), put = (rel, text = '') => { const f = path.join(semantic, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    const declared = new Set(['dev-harness/semantic/kept.cjs']);
    put('kept.cjs');
    put('__pycache__/kept.cpython-312.pyc');
    put('m5-fixed-http/__pycache__/server.cpython-312.pyc');   // 子目录里只剩字节码缓存
    put('stray.pyc');
    put('acceptance-v7-local.cjs');                           // 本机未入库的盲测件(名字命中 .gitignore 且是盲测名)
    const realRules = ignoredBlindPatterns('/dev-harness/semantic/acceptance-v7*\n/dev-harness/semantic/acceptance-zh-v1*\n');
    assert.deepEqual(undeclaredSemanticNames(semanticFileNames(semantic), declared, realRules), []);
    put('calib-new.cjs');                                      // 研究件长回来
    assert.deepEqual(undeclaredSemanticNames(semanticFileNames(semantic), declared, realRules), ['dev-harness/semantic/calib-new.cjs']);
    // 有人在 .gitignore 加一条宽规则想把它藏起来:名字不是盲测材料,照样报出。
    const widened = ignoredBlindPatterns('/dev-harness/semantic/acceptance-v7*\n/dev-harness/semantic/calib*\n');
    assert.deepEqual(undeclaredSemanticNames(semanticFileNames(semantic), declared, widened), ['dev-harness/semantic/calib-new.cjs']);
    put('m5-fixed-http/handler.cjs');                          // 只含缓存的子目录里冒出普通文件
    assert.deepEqual(undeclaredSemanticNames(semanticFileNames(semantic), declared, realRules).sort(),
      ['dev-harness/semantic/calib-new.cjs', 'dev-harness/semantic/m5-fixed-http/handler.cjs']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('④d CI runs only the unit glob and run-all, never the research directory or the archive', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'e2e.yml'), 'utf8');
  const runs = [...workflow.matchAll(/^\s*run:\s*(.+)$/gm)].map(m => m[1].trim());
  const unitRuns = runs.filter(line => /node\s+--test\b/.test(line));
  assert.ok(unitRuns.length >= 2, 'the workflow still has unit steps');
  for (const line of unitRuns) assert.equal(line, 'node --test "dev-harness/unit/*.test.js"');
  assert.ok(runs.includes('node dev-harness/run-all.js'));
  assert.doesNotMatch(workflow, /dev-harness[\\/]+(?:semantic|archive)\b|research-archive/);
});

test('⑤ blind material is never archived and is declared by name only', () => {
  for (const row of manifest.files) assert.equal(A.isBlindMaterialPath(row.path), false, row.path);
  assert.ok(manifest.notArchived.length >= 1);
  for (const row of manifest.notArchived) {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'gitBlob', 'path', 'reason'], 'no content digest computed for ' + row.path);
    assert.ok(A.isBlindMaterialPath(row.path) || KEPT_CONFIG.has(row.path), row.path);
    if (KEPT_CONFIG.has(row.path)) assert.equal(row.reason, KEPT_CONFIG.get(row.path));
  }
  assert.ok(manifest.notArchived.some(row => /semantic-coarse-policy-candidate-v7\.cjs$/.test(row.path)));
  for (const kept of ['refresh-license-lock.cjs', 'download-candidates.cjs']) {
    const row = manifest.notArchived.find(r => r.path === 'dev-harness/semantic/' + kept);
    assert.ok(row && row.reason.startsWith('产品维护脚本'), kept + ' is declared as a product maintenance script');
  }
});

// 一份留下的维护脚本按文件位置能碰到的目标:字面 require 的相对路径,与每个 __dirname 起头的 path.join/path.resolve。
// 非字面 require、非字面参数、或 __dirname 的任何其他用法都记成问题 —— 核不了的就不许有。
function keptScriptTargets(file, text) {
  const targets = [], problems = [];
  const literalRequires = [...text.matchAll(/require\(\s*(['"])([^'"]+)\1\s*\)/g)];
  if ((text.match(/require\s*\(/g) || []).length !== literalRequires.length) problems.push('non-literal require');
  for (const m of literalRequires) if (m[2].startsWith('.')) targets.push(path.resolve(path.dirname(file), m[2]));
  const anchored = [...text.matchAll(/path\.(?:join|resolve)\(\s*__dirname\s*,([^)]*)\)/g)];
  if ((text.match(/__dirname/g) || []).length !== anchored.length) problems.push('__dirname used outside a literal path.join/path.resolve');
  for (const m of anchored) {
    if (m[1].replace(/'[^']*'|"[^"]*"/g, '').replace(/[\s,]/g, '') !== '') { problems.push('non-literal path segment: ' + m[0].slice(0, 80)); continue; }
    targets.push(path.resolve(path.dirname(file), ...[...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map(x => x[1] ?? x[2])));
  }
  return { targets: targets.map(t => path.relative(ROOT, t).split(path.sep).join('/')), problems };
}

test('product maintenance scripts left in place load only product files, never archived research', () => {
  const archived = new Set(manifest.files.map(row => row.path));
  let total = 0;
  for (const kept of ['refresh-license-lock.cjs', 'download-candidates.cjs']) {
    const file = path.join(HARNESS, 'semantic', kept);
    const { targets, problems } = keptScriptTargets(file, fs.readFileSync(file, 'utf8'));
    assert.deepEqual(problems, [], kept);
    assert.ok(targets.length >= 2, kept + ' has both a relative require and a __dirname target to check');
    for (const rel of targets) {
      assert.ok(rel.startsWith('ruyi-workbench/semantic-runtime/') && fs.existsSync(path.join(ROOT, rel)), kept + ' -> ' + rel);
      assert.equal(archived.has(rel), false);
    }
    total += targets.length;
  }
  // 判据自身:动态形必须被看见。
  const probe = path.join(HARNESS, 'semantic', 'probe.cjs');
  assert.deepEqual(keptScriptTargets(probe, "require(path.join(__dirname,'pilot-fixture.cjs'))").targets, ['dev-harness/semantic/pilot-fixture.cjs']);
  assert.ok(keptScriptTargets(probe, "require(path.join(__dirname,'pilot-fixture.cjs'))").problems.includes('non-literal require'));
  assert.deepEqual(keptScriptTargets(probe, "fs.readFileSync(path.resolve(__dirname,'pilot-fixture.cjs'))").targets, ['dev-harness/semantic/pilot-fixture.cjs']);
  assert.ok(keptScriptTargets(probe, "const d = __dirname + '/x';").problems.length);
  assert.ok(keptScriptTargets(probe, "path.join(__dirname, name)").problems.length);
  assert.ok(total >= 4);
});

test('ustar writer and reader: long paths split into prefix, checksums hold, unsafe names are refused', () => {
  const longPath = 'a/' + 'b'.repeat(120) + '/' + 'c'.repeat(90) + '.cjs';
  const entries = [{ path: 'z.txt', bytes: Buffer.from('z\n') }, { path: longPath, bytes: Buffer.alloc(513, 7) }, { path: 'empty', bytes: Buffer.alloc(0) }];
  const tar = A.writeTar(entries, 1795145165);
  assert.equal(tar.length % 512, 0);
  const back = A.readTar(tar);
  assert.deepEqual(back.map(e => e.path), ['a/' + 'b'.repeat(120) + '/' + 'c'.repeat(90) + '.cjs', 'empty', 'z.txt']);
  assert.ok(back[0].bytes.equals(entries[1].bytes) && back[1].bytes.length === 0);
  assert.ok(A.writeTar(back, 1795145165).equals(tar), 'rewrite is byte-identical');
  assert.ok(A.gunzip(A.gzip(tar)).equals(tar));
  assert.equal(A.gzip(tar)[9], A.GZIP_OS_UNKNOWN);
  const corrupt = Buffer.from(tar); corrupt[0] ^= 1;
  assert.throws(() => A.readTar(corrupt), /checksum/);
  for (const bad of ['../x', '/x', 'a\\b', 'C:/x', 'a//b', 'a/./b']) assert.throws(() => A.writeTar([{ path: bad, bytes: Buffer.alloc(0) }], 0), /unsafe/);
  assert.throws(() => A.writeTar([{ path: 'x', bytes: Buffer.alloc(0) }, { path: 'x', bytes: Buffer.alloc(0) }], 0), /duplicate/);
});

test('Windows-unsafe names are refused: colon, trailing dot or space, reserved device names', () => {
  for (const bad of ['a:b', 'dir/file.cjs:stream', 'x.', 'dir./x', 'x ', 'dir /x', 'CON', 'con.txt', 'a/nul', 'a/NUL.json', 'aux.cjs', 'prn', 'COM1', 'com9.log', 'lpt1', 'LPT9.txt']) {
    assert.throws(() => A.assertSafeRelative(bad), /unsafe/, bad);
  }
  for (const good of ['console.cjs', 'a/connection.js', 'com10.txt', 'lpt.txt', 'nul-check.cjs', 'x.y', 'auxiliary/z']) assert.equal(A.assertSafeRelative(good), good);
});

test('names that differ only in case are refused when writing, reading and extracting', () => {
  const pair = [{ path: 'dir/Readme.md', bytes: Buffer.from('a') }, { path: 'dir/README.md', bytes: Buffer.from('b') }];
  assert.throws(() => A.writeTar(pair, 0), /case-insensitive/);
  // 手工拼一个含两条只差大小写的包(绕过写入端),读取端必须拒绝。
  const one = A.writeTar([pair[0]], 0), two = A.writeTar([pair[1]], 0);
  const crafted = Buffer.concat([one.subarray(0, one.length - 1024), two]);
  assert.throws(() => A.readTar(crafted), /case-insensitive/);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'research-archive-case-'));
  try {
    assert.throws(() => A.extractEntries(pair, dir), /case-insensitive/);
    assert.deepEqual(fs.readdirSync(dir), [], 'preflight refuses before writing anything');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clean removes only files byte-identical to the archive, keeps modified ones and prunes emptied directories', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'research-archive-clean-'));
  try {
    const entries = [
      { path: 'dev-harness/semantic/a.cjs', bytes: Buffer.from('a') },
      { path: 'dev-harness/semantic/sub/b.cjs', bytes: Buffer.from('b') },
      { path: 'dev-harness/semantic/sub/c.cjs', bytes: Buffer.from('c') },
      { path: 'dev-harness/unit/d.test.js', bytes: Buffer.from('d') },
      { path: 'dev-harness/unit/never-extracted.test.js', bytes: Buffer.from('e') },
    ];
    assert.equal(A.extractEntries(entries.slice(0, 4), root).written, 4);
    fs.writeFileSync(path.join(root, 'dev-harness', 'semantic', 'sub', 'c.cjs'), 'c changed');   // 用户改过
    fs.writeFileSync(path.join(root, 'dev-harness', 'unit', 'other.test.js'), 'not from the archive');
    const done = A.cleanEntries(entries, root);
    assert.equal(done.removed, 3);
    assert.deepEqual(done.kept, ['dev-harness/semantic/sub/c.cjs']);
    assert.equal(done.missing, 1);
    assert.equal(fs.readFileSync(path.join(root, 'dev-harness', 'semantic', 'sub', 'c.cjs'), 'utf8'), 'c changed');
    assert.ok(!fs.existsSync(path.join(root, 'dev-harness', 'semantic', 'a.cjs')) && !fs.existsSync(path.join(root, 'dev-harness', 'unit', 'd.test.js')));
    assert.ok(fs.existsSync(path.join(root, 'dev-harness', 'unit', 'other.test.js')), 'files not from the archive stay');
    assert.ok(fs.existsSync(path.join(root, 'dev-harness', 'semantic', 'sub')), 'a directory still holding a kept file stays');
    fs.unlinkSync(path.join(root, 'dev-harness', 'semantic', 'sub', 'c.cjs'));
    fs.writeFileSync(path.join(root, 'dev-harness', 'semantic', 'sub', 'c.cjs'), 'c');
    const again = A.cleanEntries(entries, root);
    assert.equal(again.removed, 1);
    assert.ok(!fs.existsSync(path.join(root, 'dev-harness', 'semantic')), 'emptied directories are pruned');
    assert.ok(fs.existsSync(path.join(root, 'dev-harness', 'unit')) && fs.existsSync(root), 'non-empty directories and the root stay');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('extraction refuses to write through a symlink or junction below the target root', () => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'research-archive-link-'));
  try {
    const root = path.join(base, 'root'), outside = path.join(base, 'outside');
    fs.mkdirSync(root); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'dev-harness'), 'junction');
    const entries = [{ path: 'dev-harness/semantic/x.cjs', bytes: Buffer.from('x') }];
    assert.throws(() => A.extractEntries(entries, root), /through a link/);
    assert.deepEqual(fs.readdirSync(outside), [], 'nothing escaped through the junction');
    fs.unlinkSync(path.join(root, 'dev-harness'));
    const done = A.extractEntries(entries, root);
    assert.equal(done.written, 1);
    assert.equal(fs.readFileSync(path.join(root, 'dev-harness', 'semantic', 'x.cjs'), 'utf8'), 'x');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
