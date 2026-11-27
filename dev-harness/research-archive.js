#!/usr/bin/env node
'use strict';
// 研究证据归档的校验 / 解包 / 比对 / 建包入口(151 阶段 5 P14)。零 npm 依赖;格式与取材规则见 lib/research-archive.js 头注。
// 不进 run-all(不是 *.e2e.js),也不进 node --test(不是 unit/*.test.js);默认回归里替它站岗的是
// unit/research-archive.test.js。
//
//   node dev-harness/research-archive.js verify                       核对 SHA256SUMS、清单、包与逐条目摘要(不需要 git)
//   node dev-harness/research-archive.js extract --into <空目录或仓库根>  先 verify 再解包;已有且字节相同的文件跳过,字节不同一律拒绝
//   node dev-harness/research-archive.js clean --dir <解包目录或仓库根>   收回解包:只删与归档逐字节相同的文件,改过的保留并报告(有保留时退出码 1)
//   node dev-harness/research-archive.js compare-git --dir <解包目录>    把解出的每个文件与清单 sourceCommit 里的 git 对象逐字节比对(需要完整历史)
//   node dev-harness/research-archive.js build --commit <sha> [--out <目录>]  从 git 对象重建(建包与复现性复核用;不读工作区)
//
// 解到仓库根即原地复原研究目录与研究单测:node --test 的 glob 会重新扫到那些单测,只在需要复现研究时这么做,用完删掉。

const fs = require('node:fs');
const path = require('node:path');
const A = require('./lib/research-archive');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_DIR = path.join(__dirname, 'archive');
const BASENAME = 'semantic-research-d5d3caff';

// 移出默认回归的研究件(semantic/ 之外)。理由写进清单,供审计逐条对照。
const MOVED = [
  ...['os-alias-canonical-controller', 'os-alias-controller', 'owned-kill-transport-v3', 'proxy-death-controller-v2',
    'proxy-death-controller', 'proxy-matrix-controller', 'proxy-native-witness', 'proxy-startup-controller',
    'proxy-startup-watchdog-v2', 'proxy-startup-watchdog-v3', 'proxy-win32-controller-v2', 'proxy-win32-controller']
    .map(name => ({ path: 'dev-harness/unit/semantic-resident-' + name + '.test.js', suite: 'unit',
      reason: name === 'proxy-native-witness'
        ? '只测 semantic/resident-proxy-native-witness.cjs 研究见证解析器(纯函数,不依赖 output/,干净检出可过);产品 semantic-runtime 与 app/src 无对应模块,它只服务研究控制器链的资格判定'
        : '常驻运行时研究控制器单测:只测 semantic/resident-*.cjs 研究控制器与冻结哈希,依赖未入库的 output/ 证据目录,干净检出必红' })),
  { path: 'dev-harness/unit/semantic-native.test.js', suite: 'unit', reason: '只测 semantic/native-host-prototype.cjs 原生宿主原型;产品源码无对应模块' },
  { path: 'dev-harness/semantic-native-host.e2e.js', suite: 'run-all', reason: '原生宿主原型的手动资格件(缺 RUYI_NATIVE_TEST_ROOT 即 SKIP),顶层读取 semantic/ 原型源码' },
  { path: 'dev-harness/unit/semantic-calibration.test.js', suite: 'unit', reason: '原件整体归档;守产品 06ha 的 6 条用例与第 2 条里的 2 句 structuredIds 断言原样迁到 unit/semantic-production-admission.test.js,研究校准夹具、研究策略与内容查询实验的断言随证据移出' },
  { path: 'dev-harness/unit/semantic-id-strip.test.js', suite: 'unit', reason: '只测 semantic/calibration-strip-ids.cjs 研究实验' },
  { path: 'dev-harness/unit/semantic-language-projection.test.js', suite: 'unit', reason: '只测 semantic/calibration-language-projection-core.cjs 与研究校准夹具' },
  { path: 'dev-harness/unit/semantic-role-centering.test.js', suite: 'unit', reason: '只测 semantic/calibration-role-centering-core.cjs 与研究校准夹具' },
  { path: 'dev-harness/unit/work-data-owned-restore-cold-research.test.js', suite: 'unit', reason: '被测源码是 output/ 下的研究草稿副本(未入库)加 semantic/ 研究变换,干净检出必红;产品冷操作由 unit/work-data-cold-operations.test.js 等守着' },
];
// 留在 dev-harness/semantic/ 原处、不归档的非盲测件。两份产品维护脚本只依赖产品文件(models.lock.json、verify.cjs、
// licenses/),由 ruyi-workbench/semantic-runtime 的 README 与 licenses/NOTICE.md 按原路径指向。
const KEPT_CONFIG = new Map([
  ['dev-harness/semantic/.rgignore', '保留:声明 acceptance* 为盲测材料、让普通文本搜索跳过,与留在原处的盲测件同去留'],
  ['dev-harness/semantic/refresh-license-lock.cjs', '产品维护脚本:刷新 semantic-runtime/licenses 的许可证锁;只依赖产品的 models.lock.json 与 licenses/,licenses/NOTICE.md 按原路径指向它'],
  ['dev-harness/semantic/download-candidates.cjs', '产品维护脚本:按 models.lock.json 下载模型资产并用产品 verify.cjs 校验;只依赖产品文件,semantic-runtime/README.md 按原路径指向它'],
  // Maintained evaluation entry points added after the historical archive was frozen.
  ...['gemma-session-timeout.cjs', 'sr2-encoder-comparison.cjs', 'sr2-product-evaluation.cjs', 'sr2-product-summary.cjs',
    'admission-dev-corpus.cjs', 'admission-replay.cjs', 'gemma-library-counts.cjs', 'gemma-memory-latency.cjs',
    'gemma-stored-restart.cjs'].map(file => ['dev-harness/semantic/' + file, 'Current offline evaluation harness']),
]);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const key = argv[i].slice(2); out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else out._.push(argv[i]);
  }
  return out;
}
const files = dir => ({
  manifestFile: path.join(dir, BASENAME + '.manifest.json'),
  archiveFile: path.join(dir, BASENAME + '.tar.gz'),
  sumsFile: path.join(dir, BASENAME + '.sha256'),
});

function verify(dir) {
  const result = A.verifyArchive(files(dir));
  for (const problem of result.problems) console.error('FAIL ' + problem);
  if (!result.problems.length) {
    console.log('verify: ' + result.entries.length + ' entries match manifest; manifest sha256 ' + result.manifestSha256 + '; archive sha256 ' + result.archiveSha256);
  }
  return result;
}

function build(commitArg, outDir) {
  const commit = A.git(ROOT, ['rev-parse', '--verify', commitArg + '^{commit}']).toString().trim();
  const mtime = Number(A.git(ROOT, ['show', '-s', '--format=%ct', commit]).toString().trim());
  const semantic = A.lsTree(ROOT, commit, ['dev-harness/semantic']);
  const moved = A.lsTree(ROOT, commit, MOVED.map(row => row.path));
  if (moved.length !== MOVED.length) throw new Error('moved research files missing at ' + commit);
  const notArchived = [], selected = [];
  for (const row of semantic) {
    if (row.type !== 'blob') throw new Error('unexpected tree entry ' + row.path);
    if (A.isBlindMaterialPath(row.path)) notArchived.push({ path: row.path, gitBlob: row.oid, bytes: row.bytes, reason: '盲测材料:按名字识别,未读取、未归档,留在原处' });
    else if (KEPT_CONFIG.has(row.path)) notArchived.push({ path: row.path, gitBlob: row.oid, bytes: row.bytes, reason: KEPT_CONFIG.get(row.path) });
    else selected.push(row);
  }
  for (const row of moved) { if (A.isBlindMaterialPath(row.path)) throw new Error('moved file looks like blind material: ' + row.path); selected.push(row); }
  const blobs = A.catBlobs(ROOT, selected.map(row => row.oid));
  const entries = selected.map((row, i) => {
    const bytes = blobs[i].bytes;
    if (A.gitBlobId(bytes) !== row.oid || bytes.length !== row.bytes) throw new Error('blob bytes do not hash to tree oid: ' + row.path);
    if (row.mode !== '100644') throw new Error('unexpected mode ' + row.mode + ' for ' + row.path);
    return { path: row.path, bytes, mode: 0o644 };
  });
  const tar = A.writeTar(entries, mtime), gz = A.gzip(tar);
  const sorted = A.readTar(tar);
  const manifest = {
    schema: 1,
    title: 'dev-harness/semantic 研究证据归档(151 阶段 5 P14)',
    sourceCommit: commit,
    format: 'POSIX ustar + gzip(level 9,gzip 头 MTIME=0、OS=255);路径按 UTF-8 字节序,mode 0644,uid/gid 0,mtime=源提交的提交时间',
    archive: { file: BASENAME + '.tar.gz', bytes: gz.length, sha256: A.sha256(gz), tarBytes: tar.length, tarSha256: A.sha256(tar), mtime },
    counts: { files: sorted.length, semanticResearch: sorted.length - MOVED.length, movedTests: MOVED.length, notArchived: notArchived.length },
    tools: 'node dev-harness/research-archive.js verify | extract --into <dir> | compare-git --dir <dir> | build --commit <sha>',
    movedOutOfDefaultRegression: MOVED,
    notArchived,
    files: sorted.map(entry => ({ path: entry.path, bytes: entry.bytes.length, sha256: A.sha256(entry.bytes), gitBlob: A.gitBlobId(entry.bytes), mode: '100644' })),
  };
  const manifestText = A.formatManifest(manifest);
  const names = files(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(names.archiveFile, gz);
  fs.writeFileSync(names.manifestFile, manifestText);
  fs.writeFileSync(names.sumsFile, A.formatSums([
    { file: path.basename(names.archiveFile), sha256: A.sha256(gz) },
    { file: path.basename(names.manifestFile), sha256: A.sha256(Buffer.from(manifestText)) },
  ]));
  console.log('build: ' + sorted.length + ' files from ' + commit + ' (not archived: ' + notArchived.length + '); tar sha256 ' + A.sha256(tar) + '; archive sha256 ' + A.sha256(gz));
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function compareGit(dir, commitArg) {
  const { manifest, problems } = A.verifyArchive(files(ARCHIVE_DIR));
  if (problems.length) { problems.forEach(p => console.error('FAIL ' + p)); return 1; }
  const commit = commitArg || manifest.sourceCommit;
  const blobs = A.catBlobs(ROOT, manifest.files.map(row => commit + ':' + row.path));
  let same = 0; const diffs = [];
  manifest.files.forEach((row, i) => {
    let disk = null;
    try { disk = fs.readFileSync(path.join(dir, ...row.path.split('/'))); } catch { diffs.push('missing on disk: ' + row.path); return; }
    if (disk.equals(blobs[i].bytes) && A.sha256(disk) === row.sha256) same++;
    else diffs.push('bytes differ from ' + commit.slice(0, 8) + ': ' + row.path);
  });
  const extra = walkFiles(path.resolve(dir)).filter(p => !manifest.files.some(row => row.path === p));
  diffs.forEach(d => console.error('FAIL ' + d));
  console.log('compare-git: ' + same + '/' + manifest.files.length + ' files byte-identical to ' + commit + '; files on disk outside manifest: ' + extra.length);
  return diffs.length ? 1 : 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2)), command = args._[0] || 'verify';
  if (command === 'verify') return verify(ARCHIVE_DIR).problems.length ? 1 : 0;
  if (command === 'extract') {
    if (typeof args.into !== 'string') { console.error('extract needs --into <dir>'); return 2; }
    const result = verify(ARCHIVE_DIR);
    if (result.problems.length) return 1;
    const done = A.extractEntries(result.entries, args.into);
    if (done.conflicts.length) { done.conflicts.forEach(p => console.error('CONFLICT existing file differs: ' + p)); return 1; }
    console.log('extract: wrote ' + done.written + ', already identical ' + done.identical + ' into ' + path.resolve(args.into));
    return 0;
  }
  if (command === 'clean') {
    if (typeof args.dir !== 'string') { console.error('clean needs --dir <dir>'); return 2; }
    const result = verify(ARCHIVE_DIR);
    if (result.problems.length) return 1;
    const done = A.cleanEntries(result.entries, args.dir);
    done.kept.forEach(p => console.error('KEPT differs from archive: ' + p));
    console.log('clean: removed ' + done.removed + ', kept (modified) ' + done.kept.length + ', absent ' + done.missing + ', emptied directories removed ' + done.prunedDirs + ' under ' + path.resolve(args.dir));
    return done.kept.length ? 1 : 0;
  }
  if (command === 'compare-git') {
    if (typeof args.dir !== 'string') { console.error('compare-git needs --dir <dir>'); return 2; }
    return compareGit(path.resolve(args.dir), typeof args.commit === 'string' ? args.commit : '');
  }
  if (command === 'build') {
    if (typeof args.commit !== 'string') { console.error('build needs --commit <sha>'); return 2; }
    build(args.commit, path.resolve(typeof args.out === 'string' ? args.out : ARCHIVE_DIR));
    return 0;
  }
  console.error('unknown command: ' + command);
  return 2;
}

if (require.main === module) process.exitCode = main();
module.exports = { MOVED, KEPT_CONFIG, BASENAME, ARCHIVE_DIR };
