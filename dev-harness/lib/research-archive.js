'use strict';
// 研究证据归档的公共件(151 阶段 5 P14)。零 npm 依赖,只用 Node 内建的 zlib / crypto / child_process。
//
// 格式:POSIX ustar + gzip(.tar.gz)。自己写 ustar 而不是调 tar.exe,原因有三:
//   ① 产物要逐字节可复现:固定 mtime(源提交的提交时间)、uid/gid 0、属主名空、路径按字节序排序,
//      gzip 头的 MTIME 为 0、OS 字节改成 255(unknown)—— 同一组输入在 Windows 与 Linux 上得到同一份 tar;
//   ② 要在 Node 里逐条核对 sha256 与 git blob 号,读包本来就得解析 tar;
//   ③ 产物仍是标准 ustar:Windows 10/11 自带的 tar.exe(bsdtar)、GNU tar、7-Zip 都能直接列出与解开,
//      不依赖本工具也能独立复核。
// 包内容用 gzip 压缩,不只是为了体积:研究目录与盲测材料同住过一个目录,压缩后包里的文本不会被
// git grep / rg 之类的普通文本搜索读到。
//
// 归档的字节只来自 git 对象(git ls-tree / git cat-file),从不遍历工作区目录:主树的
// dev-harness/semantic/ 下可能有被 .gitignore 挡住、未入库的盲测材料,工作区遍历会把它们卷进来。
// 盲测相关的路径(名字带 v7 / blind / 盲测,以及 .rgignore 声明的 acceptance*)只按名字识别,
// 内容从不读取:既不进包,也不经本工具计算摘要(清单里只记 git ls-tree 给出的 blob 号与大小)。

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const BLOCK = 512;
const GZIP_OS_UNKNOWN = 255;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gitBlobId = bytes => crypto.createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');

// 盲测材料:只看路径名。v7(含 V7R3)、blind、盲测,以及 semantic/.rgignore 声明的 acceptance*.cjs 与 acceptance-*/。
function isBlindMaterialPath(p) {
  const value = String(p).replace(/\\/g, '/');
  if (/v7/i.test(value) || /blind/i.test(value) || value.includes('盲测')) return true;
  return /(^|\/)dev-harness\/semantic\/acceptance[^/]*(\/|$)/.test(value);
}

// Windows 一等:拒绝 `:`(盘符与 NTFS 备用数据流)、段尾的 `.` 或空格(Win32 会静默剥掉,两个名字落到同一个文件)、
// 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9,带扩展名也算,比如 nul.txt 打开的是设备)。
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.[^/]*)?$/i;
function assertSafeRelative(p) {
  const value = String(p);
  if (!value || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/')
    || value.split('/').some(part => part === '' || part === '.' || part === '..' || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part))) {
    throw new Error('unsafe archive path: ' + JSON.stringify(value));
  }
  return value;
}
// NTFS 默认大小写不敏感:只差大小写的两条会写到同一个文件,预检就拒绝。
const caseKey = p => String(p).toLowerCase();

function octal(value, width) {
  const text = Number(value).toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || text.length > width - 1) throw new Error('ustar numeric field overflow: ' + value);
  return text.padStart(width - 1, '0') + '\0';
}

function splitUstarName(p) {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: '' };
  for (let i = p.lastIndexOf('/'); i > 0; i = p.lastIndexOf('/', i - 1)) {
    const prefix = p.slice(0, i), name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error('path does not fit a ustar header: ' + p);
}

function headerChecksum(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : block[i];
  return sum;
}

function ustarHeader(entry, mtime) {
  const block = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitUstarName(entry.path);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(entry.mode & 0o7777, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(entry.bytes.length, 12), 124, 'ascii');
  block.write(octal(mtime, 12), 136, 'ascii');
  block.write('0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  if (prefix) block.write(prefix, 345, 155, 'utf8');
  block.write(octal(headerChecksum(block), 7) + ' ', 148, 'ascii');
  return block;
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));

// entries: [{ path, bytes: Buffer, mode? }]。输出按路径字节序排序,同一输入永远得到同一串字节。
function writeTar(entries, mtime) {
  const seen = new Set(), parts = [];
  for (const entry of [...entries].sort(byteOrder)) {
    assertSafeRelative(entry.path);
    if (seen.has(caseKey(entry.path))) throw new Error('duplicate archive path (case-insensitive): ' + entry.path);
    seen.add(caseKey(entry.path));
    parts.push(ustarHeader({ path: entry.path, bytes: entry.bytes, mode: entry.mode ?? 0o644 }, mtime));
    parts.push(entry.bytes);
    const pad = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function readField(block, start, length) {
  const end = block.indexOf(0, start);
  return block.toString('utf8', start, end >= start && end < start + length ? end : start + length);
}
function readOctal(block, start, length) {
  const text = block.toString('ascii', start, start + length).replace(/[\0 ]+$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('bad ustar numeric field at ' + start);
  return parseInt(text, 8);
}

// 只认本工具写出的形状:普通文件、ustar 魔数、校验和正确、路径安全、无重复、结尾两块全零且其后无杂字节。
function readTar(tar) {
  const entries = [], seen = new Set();
  let offset = 0;
  for (;;) {
    if (offset + BLOCK > tar.length) throw new Error('truncated tar at ' + offset);
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every(x => x === 0)) {
      const rest = tar.subarray(offset);
      if (rest.length < BLOCK * 2 || !rest.every(x => x === 0)) throw new Error('tar end marker is not two zero blocks followed by zero padding');
      break;
    }
    const stored = readOctal(block, 148, 8);
    if (stored !== headerChecksum(block)) throw new Error('tar header checksum mismatch at ' + offset);
    if (block.toString('ascii', 257, 263) !== 'ustar\0' || block.toString('ascii', 263, 265) !== '00') throw new Error('not a ustar header at ' + offset);
    const type = block[156];
    if (type !== 0x30 && type !== 0) throw new Error('unsupported tar entry type ' + type + ' at ' + offset);
    const name = readField(block, 0, 100), prefix = readField(block, 345, 155);
    const p = assertSafeRelative(prefix ? prefix + '/' + name : name);
    if (seen.has(caseKey(p))) throw new Error('duplicate tar entry (case-insensitive): ' + p);
    seen.add(caseKey(p));
    const size = readOctal(block, 124, 12), mode = readOctal(block, 100, 8), mtime = readOctal(block, 136, 12);
    const start = offset + BLOCK;
    if (start + size > tar.length) throw new Error('truncated tar entry: ' + p);
    entries.push({ path: p, bytes: Buffer.from(tar.subarray(start, start + size)), mode, mtime });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

function gzip(tar) {
  const out = zlib.gzipSync(tar, { level: 9 });
  out[9] = GZIP_OS_UNKNOWN; // gzip 头的 OS 字节随 zlib 编译平台变化;归一后跨平台同字节。头里没有 FHCRC,改它不破坏校验。
  return out;
}
const gunzip = gz => zlib.gunzipSync(gz);

// 清单:顶层键逐行缩进,对象数组每项一行(953 条文件也只有约千行,diff 可读)。
function formatManifest(manifest) {
  const keys = Object.keys(manifest), lines = ['{'];
  keys.forEach((key, i) => {
    const value = manifest[key], comma = i < keys.length - 1 ? ',' : '';
    if (Array.isArray(value) && value.length && value.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      lines.push('  ' + JSON.stringify(key) + ': [');
      value.forEach((row, j) => lines.push('    ' + JSON.stringify(row) + (j < value.length - 1 ? ',' : '')));
      lines.push('  ]' + comma);
    } else {
      lines.push('  ' + JSON.stringify(key) + ': ' + JSON.stringify(value, null, 2).replace(/\n/g, '\n  ') + comma);
    }
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

function formatSums(rows) {
  return rows.map(row => row.sha256 + '  ' + row.file + '\n').join('');
}
function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error('bad SHA256SUMS line: ' + JSON.stringify(line));
    out.set(m[2], m[1]);
  }
  return out;
}

// 拿清单逐条核对一组已解出的条目。只报问题,不抛:调用方据此决定退出码,单测据此做「改一个字节必须被发现」。
function verifyEntries(manifest, entries) {
  const problems = [];
  const want = manifest.files || [];
  const got = new Map(entries.map(entry => [entry.path, entry]));
  if (entries.length !== want.length) problems.push('entry count ' + entries.length + ' != manifest ' + want.length);
  const wanted = new Set();
  want.forEach((row, i) => {
    wanted.add(row.path);
    const entry = got.get(row.path);
    if (!entry) { problems.push('missing from archive: ' + row.path); return; }
    if (entries[i] && entries[i].path !== row.path) problems.push('order differs at #' + i + ': ' + entries[i].path + ' vs ' + row.path);
    if (entry.bytes.length !== row.bytes) problems.push('size mismatch: ' + row.path);
    if (sha256(entry.bytes) !== row.sha256) problems.push('sha256 mismatch: ' + row.path);
    if (gitBlobId(entry.bytes) !== row.gitBlob) problems.push('git blob mismatch: ' + row.path);
    if (isBlindMaterialPath(row.path)) problems.push('blind-material path inside archive: ' + row.path);
  });
  for (const entry of entries) if (!wanted.has(entry.path)) problems.push('not in manifest: ' + entry.path);
  for (const row of manifest.notArchived || []) if (got.has(row.path)) problems.push('declared not-archived but present: ' + row.path);
  return problems;
}

// 整包核对:SHA256SUMS → 清单与包的 sha256 → gzip 解开后的 tar sha256 → 逐条目 → 用读出的条目重写 tar 必须逐字节相同。
function verifyArchive({ manifestFile, archiveFile, sumsFile }) {
  const problems = [];
  const manifestBytes = fs.readFileSync(manifestFile), gz = fs.readFileSync(archiveFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (sumsFile) {
    const sums = parseSums(fs.readFileSync(sumsFile, 'utf8'));
    if (sums.get(path.basename(manifestFile)) !== sha256(manifestBytes)) problems.push('manifest sha256 differs from ' + path.basename(sumsFile));
    if (sums.get(path.basename(archiveFile)) !== sha256(gz)) problems.push('archive sha256 differs from ' + path.basename(sumsFile));
  }
  const a = manifest.archive || {};
  if (a.file !== path.basename(archiveFile)) problems.push('manifest names archive ' + a.file);
  if (a.bytes !== gz.length || a.sha256 !== sha256(gz)) problems.push('archive bytes/sha256 differ from manifest');
  let tar, entries = [];
  try { tar = gunzip(gz); } catch (error) { problems.push('gunzip failed: ' + error.message); return { manifest, entries, problems }; }
  if (a.tarBytes !== tar.length || a.tarSha256 !== sha256(tar)) problems.push('tar bytes/sha256 differ from manifest');
  try { entries = readTar(tar); } catch (error) { problems.push('tar parse failed: ' + error.message); return { manifest, entries, problems }; }
  problems.push(...verifyEntries(manifest, entries));
  if (entries.some(entry => entry.mtime !== a.mtime)) problems.push('entry mtime differs from manifest');
  if (!writeTar(entries, a.mtime).equals(tar)) problems.push('tar is not in canonical form (rewrite differs)');
  return { manifest, entries, problems, manifestSha256: sha256(manifestBytes), archiveSha256: sha256(gz) };
}

// 目标根之下、已存在的每一级(含目标本身)都不许是符号链接或 junction(Node 在 Windows 上把 junction 报成 symlink):
// 否则写入会穿出目标根。目标根本身由调用方给定,不在此列。
function assertNoLinkBelow(root, target) {
  const parts = path.relative(root, target).split(path.sep);
  let at = root;
  for (const part of parts) {
    at = path.join(at, part);
    let stat;
    try { stat = fs.lstatSync(at); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('refusing to write through a link: ' + path.relative(root, at));
  }
}

// 解包:先全量预检(路径安全、大小写不敏感重名、链接、冲突)再落盘;同字节的已存在文件跳过,不同字节一律拒绝(不覆盖)。
function extractEntries(entries, intoDir) {
  const root = path.resolve(intoDir), plan = [], conflicts = [], keys = new Set();
  for (const entry of entries) {
    const target = path.resolve(root, ...assertSafeRelative(entry.path).split('/'));
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('entry escapes target: ' + entry.path);
    if (keys.has(caseKey(entry.path))) throw new Error('duplicate entry (case-insensitive): ' + entry.path);
    keys.add(caseKey(entry.path));
    assertNoLinkBelow(root, target);
    let existing = null;
    try { existing = fs.readFileSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.equals(entry.bytes)) conflicts.push(entry.path);
    else plan.push({ entry, target, skip: Boolean(existing) });
  }
  if (conflicts.length) return { written: 0, identical: 0, conflicts };
  let written = 0, identical = 0;
  for (const row of plan) {
    if (row.skip) { identical++; continue; }
    assertNoLinkBelow(root, row.target); // 预检之后到落盘之间又冒出来的链接也拦住
    fs.mkdirSync(path.dirname(row.target), { recursive: true });
    fs.writeFileSync(row.target, row.entry.bytes, { flag: 'wx' });
    written++;
  }
  return { written, identical, conflicts };
}

// 收回一次解包:只删与归档条目逐字节相同的文件;字节不同(被改过)的保留并报告;不存在的计数。
// 删完后自下而上移除因此变空的父目录(只到目标根之下;非空目录 rmdir 失败即停)。不穿过链接删除。
function cleanEntries(entries, intoDir) {
  const root = path.resolve(intoDir), kept = [], parents = new Set();
  let removed = 0, missing = 0;
  for (const entry of entries) {
    const target = path.resolve(root, ...assertSafeRelative(entry.path).split('/'));
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('entry escapes target: ' + entry.path);
    assertNoLinkBelow(root, target);
    let existing;
    try { existing = fs.readFileSync(target); } catch (error) { if (error.code === 'ENOENT') { missing++; continue; } throw error; }
    if (!existing.equals(entry.bytes)) { kept.push(entry.path); continue; }
    fs.unlinkSync(target);
    removed++;
    for (let dir = path.dirname(target); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) parents.add(dir);
  }
  let prunedDirs = 0;
  for (const dir of [...parents].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(dir); prunedDirs++; } catch (error) { if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error; }
  }
  return { removed, kept, missing, prunedDirs };
}

// ---- 以下只在建包与「与源提交逐字节比对」时用,需要 git ----

function git(repo, args, options = {}) {
  return cp.execFileSync('git', args, { cwd: repo, maxBuffer: 1 << 30, windowsHide: true, ...options });
}

// git ls-tree -r -l -z:<mode> SP <type> SP <oid> SP+ <size> TAB <path>。只读树,不读任何 blob 内容。
function lsTree(repo, commit, paths) {
  const out = git(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit, '--', ...paths]).toString('utf8');
  return out.split('\0').filter(Boolean).map(line => {
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\s+(\d+|-)\t(.+)$/s.exec(line);
    if (!m) throw new Error('unexpected ls-tree line: ' + JSON.stringify(line));
    return { mode: m[1], type: m[2], oid: m[3], bytes: Number(m[4]), path: m[5] };
  });
}

// git cat-file --batch,按对象名逐个取回字节。调用方负责不把盲测件的对象名放进来。
function catBlobs(repo, names) {
  if (!names.length) return [];
  const r = cp.spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: names.join('\n') + '\n', maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error('git cat-file failed: ' + String(r.stderr));
  const out = r.stdout, blobs = [];
  let offset = 0;
  for (const name of names) {
    const nl = out.indexOf(0x0a, offset);
    const head = out.toString('utf8', offset, nl);
    const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(head);
    if (!m) throw new Error('git cat-file did not return a blob for ' + name + ': ' + head);
    const size = Number(m[2]);
    blobs.push({ name, oid: m[1], bytes: Buffer.from(out.subarray(nl + 1, nl + 1 + size)) });
    offset = nl + 1 + size + 1;
  }
  return blobs;
}

module.exports = {
  BLOCK, GZIP_OS_UNKNOWN, sha256, gitBlobId, isBlindMaterialPath, assertSafeRelative, assertNoLinkBelow,
  writeTar, readTar, gzip, gunzip, formatManifest, formatSums, parseSums,
  verifyEntries, verifyArchive, extractEntries, cleanEntries, lsTree, catBlobs, git,
};
