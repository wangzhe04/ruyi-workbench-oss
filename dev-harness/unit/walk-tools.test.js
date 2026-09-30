// Unit(files-walk):遍历 / 搜索 / 归档 / 画像类文件工具的「静默假阴性」与「说谎」回归。
// 每一条都是审计(native-files F2/F7/F8/F9/F12/F13/F14)里实测过的缺陷,修法的注释在 app/src/11-native-tools.js 对应处。
//
//   [W1]  glob / file_search / codebase_symbol_search 的配额只数「命中的候选」,前面塞满无关文件也找得到
//   [W2]  共用忽略清单(__pycache__ / venv / dist / .claude/worktrees …)+ includeIgnored 退出口;prunedDirs 披露
//   [W3]  截断必说(truncated + hint):file_search / symbol_search / docs_search / glob
//   [W4]  file_search:>1MB 的文件(日志)被搜到;超过 maxFileBytes 的列 skippedLargeFiles;rg 与 JS 引擎对隐藏文件同口径;二进制跳过
//   [W5]  file_list:glob 形的 pattern 可用、非法正则给 bad_pattern+hint;信封只带相对路径且 500 条 < 60K;project_snapshot 先列全顶层
//   [W6]  docs_search 只搜文档后缀
//   [W7]  codebase_symbol_search 默认区分大小写(caseSensitive:false 放开)
//   [W8]  data_profile:5MB CSV 不再谎称 sampled:false;超窗口的文件 truncatedInput+estimatedRowCount;合法大 JSON 不再判「不合法」;
//         超大 JSON 数组流式取样;GBK CSV 正确解码;错误分类
//   [W10] 审计复核(review/native-files):显式点名的目录不剪 + 剪了必报 prunedDirs;rg 深度默认不限;隐藏文件默认不搜(includeHidden);
//         file_list pattern 按 '/' 归一路径求值;rg 排除 glob 在 Windows 上 --iglob;zip 不写 65535 条;data_profile 流式数组 sampled 准确
//   [W9]  archive:自己打的包自己能解(>2000 条目);默认排除清单;GBK 条目名;CRC 篡改被拒;声明体积炸弹被拒;list 模式;压缩不卡事件循环
//
// 强制走 JS 引擎:模式里带前瞻 (?=.*)(rg 的 Rust regex 拒环视 → 退回 JS),CI 机器上有没有 rg 都测得到同一条路径。
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { describe, it, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-walk-tools-'));
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
fs.mkdirSync(dataRootDir, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
process.env.RUYI_HOME = dataRootDir;
const srv = require(process.env.WALK_TEST_SERVER || path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

let seq = 0;
function freshWs() { const ws = path.join(home, 'w' + (++seq)); fs.mkdirSync(ws, { recursive: true }); return ws; }
const ctxFor = ws => ({ sessionId: 'sess_walk_tools', turnSeq: 1, workingDir: ws, session: { id: 'sess_walk_tools', cwd: ws }, config: {} });
const put = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const norm = s => String(s).replace(/\\/g, '/');
const rels = files => files.map(f => norm(f.relativePath));
const JS_ONLY = '(?=.*)';   // 追加在模式末尾,迫使走 JS 引擎

describe('[W1][W2][W3] 遍历配额与忽略清单', () => {
  it('[W1] glob:前面有 6000 个无关文件,后面的 **/*.md 仍找得到', async () => {
    const ws = freshWs();
    for (let i = 0; i < 6000; i++) put(path.join(ws, 'aaa', 'g' + (i % 60), 'f' + i + '.txt'), 'x');
    put(path.join(ws, 'zdocs', 'guide.md'), '# g');
    put(path.join(ws, 'zdocs', 'deep', 'more.md'), '# m');
    const r = await srv.toolCall('glob', { root: ws, pattern: '**/*.md' }, ctxFor(ws));
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.deepEqual(rels(r.files).sort(), ['zdocs/deep/more.md', 'zdocs/guide.md']);
    assert.ok(!r.truncated, '2 个命中、没撞任何上限 → 不该报 truncated');
  });

  it('[W1] file_search(JS 引擎)带 glob:配额只数匹配 glob 的文件', async () => {
    const ws = freshWs();
    for (let i = 0; i < 6000; i++) put(path.join(ws, 'aaa', 'g' + (i % 60), 'f' + i + '.txt'), 'x');
    put(path.join(ws, 'zsrc', 'deep.js'), 'var NEEDLE_W1 = 1;\n');
    const r = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W1' + JS_ONLY, glob: '*.js' }, ctxFor(ws));
    assert.equal(r.ok, true);
    assert.equal(r.engine, 'js');
    assert.equal(r.matches.length, 1, JSON.stringify(r).slice(0, 300));
    assert.ok(!r.truncated);
  });

  it('[W1] codebase_symbol_search:1500 个非代码文件排在前面,符号仍找得到', async () => {
    const ws = freshWs();
    for (let i = 0; i < 1600; i++) put(path.join(ws, 'aaa', 'n' + i + '.txt'), 'x');
    put(path.join(ws, 'zsrc', 'mod.js'), 'function handlerW1(x) { return x; }\n');
    const r = await srv.toolCall('codebase_symbol_search', { root: ws, symbol: 'handlerW1' }, ctxFor(ws));
    assert.equal(r.ok, true);
    assert.equal(r.definitionCount, 1, JSON.stringify(r).slice(0, 300));
    assert.equal(r.truncated, false);
  });

  it('[W2] 共用忽略清单:__pycache__ / venv / dist / .claude/worktrees 不进 file_list、glob;includeIgnored 放开;prunedDirs 披露', async () => {
    const ws = freshWs();
    put(path.join(ws, 'src', 'a.py'), '1');
    put(path.join(ws, 'app', '__pycache__', 'a.pyc'), '1');
    put(path.join(ws, 'venv', 'lib', 'x.py'), '1');
    put(path.join(ws, 'dist', 'bundle.js'), '1');
    put(path.join(ws, '.claude', 'worktrees', 'wt1', 'src', 'a.py'), '1');
    put(path.join(ws, '.claude', 'settings.json'), '{}');
    const l = await srv.toolCall('file_list', { root: ws }, ctxFor(ws));
    const lr = rels(l.files);
    assert.ok(lr.includes('src/a.py') && lr.includes('.claude/settings.json'), lr.join());
    assert.ok(!lr.some(p => /__pycache__|^venv|^dist|worktrees/.test(p)), lr.join());
    assert.ok(Array.isArray(l.prunedDirs) && l.prunedDirs.some(d => /__pycache__/.test(d)) && l.prunedDirs.includes('.claude/worktrees'), JSON.stringify(l.prunedDirs));
    const g = await srv.toolCall('glob', { root: ws, pattern: '**/*.py' }, ctxFor(ws));
    assert.deepEqual(rels(g.files), ['src/a.py']);
    const all = await srv.toolCall('glob', { root: ws, pattern: '**/*.py', includeIgnored: true }, ctxFor(ws));
    assert.ok(rels(all.files).some(p => /worktrees|venv/.test(p)), rels(all.files).join());
    const extra = await srv.toolCall('file_list', { root: ws, ignoreDirs: ['src'] }, ctxFor(ws));
    assert.ok(!rels(extra.files).some(p => p.startsWith('src')), 'ignoreDirs 是追加');
    // 非递归 = 目录浏览:build/dist 之类要能看见,只藏 node_modules/.git/.venv。
    const browse = await srv.toolCall('file_list', { root: ws, recursive: false }, ctxFor(ws));
    assert.ok(rels(browse.files).includes('dist') && rels(browse.files).includes('venv'), rels(browse.files).join());
  });

  it('[W2] .NET:有 *.csproj 的目录下 bin/obj 被剪,没有 csproj 的 bin 保留', async () => {
    const ws = freshWs();
    put(path.join(ws, 'App', 'App.csproj'), '<Project/>');
    put(path.join(ws, 'App', 'Program.cs'), 'class P {}');
    put(path.join(ws, 'App', 'bin', 'Debug', 'App.dll'), 'x');
    put(path.join(ws, 'App', 'obj', 'x.cache'), 'x');
    put(path.join(ws, 'scripts', 'bin', 'run.sh'), 'x');
    const l = await srv.toolCall('file_list', { root: ws }, ctxFor(ws));
    const lr = rels(l.files);
    assert.ok(lr.includes('App/Program.cs') && lr.includes('scripts/bin/run.sh'), lr.join());
    assert.ok(!lr.some(p => /^App\/(bin|obj)/.test(p)), lr.join());
  });

  it('[W3] 撞 maxFiles:file_search / symbol_search / docs_search / glob 都带 truncated + hint', async () => {
    const ws = freshWs();
    for (let i = 0; i < 40; i++) put(path.join(ws, 'src', 'm' + i + '.js'), 'function zz' + i + '() {}\n// NEEDLE_W3\n');
    for (let i = 0; i < 40; i++) put(path.join(ws, 'docs', 'd' + i + '.md'), 'NEEDLE_W3\n');
    const ctx = ctxFor(ws);
    const fsr = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W3' + JS_ONLY, maxFiles: 10 }, ctx);
    assert.equal(fsr.truncated, true); assert.match(fsr.hint || '', /maxFiles|narrow/); assert.equal(fsr.scannedFiles, 10);
    const sym = await srv.toolCall('codebase_symbol_search', { root: ws, symbol: 'zz5', maxFiles: 5 }, ctx);
    assert.equal(sym.truncated, true); assert.match(sym.hint || '', /maxFiles|narrow/);
    const ds = await srv.toolCall('docs_search', { root: ws, query: 'NEEDLE_W3', maxFiles: 5 }, ctx);
    assert.equal(ds.truncated, true); assert.match(ds.hint || '', /maxFiles|narrow/);
    const gl = await srv.toolCall('glob', { root: ws, pattern: '**/*.js', maxResults: 3 }, ctx);
    assert.equal(gl.truncated, true); assert.equal(gl.files.length, 3); assert.ok(gl.hint);
  });
});

describe('[W4] file_search 大文件 / 隐藏文件 / 二进制', () => {
  it('[W4] 2.3MB 日志末行的标记能被搜到(rg 与 JS 两个引擎)', async () => {
    const ws = freshWs();
    put(path.join(ws, 'app.log'), ('log line filler filler filler\n'.repeat(80000)) + 'FATAL_ERROR_MARK_W4\n');
    assert.ok(fs.statSync(path.join(ws, 'app.log')).size > 2 * 1024 * 1024);
    const viaAny = await srv.toolCall('file_search', { root: ws, pattern: 'FATAL_ERROR_MARK_W4' }, ctxFor(ws));
    assert.equal(viaAny.matches.length, 1, JSON.stringify(viaAny).slice(0, 300));
    const viaJs = await srv.toolCall('file_search', { root: ws, pattern: 'FATAL_ERROR_MARK_W4' + JS_ONLY }, ctxFor(ws));
    assert.equal(viaJs.engine, 'js');
    assert.equal(viaJs.matches.length, 1, JSON.stringify(viaJs).slice(0, 300));
  });

  it('[W4] 超过 maxFileBytes 的文件不再静默:JS 引擎列 skippedLargeFiles', async () => {
    const ws = freshWs();
    put(path.join(ws, 'big.log'), 'x'.repeat(3000) + '\nNEEDLE_BIG_W4\n');
    put(path.join(ws, 'small.log'), 'NEEDLE_BIG_W4\n');
    const r = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_BIG_W4' + JS_ONLY, maxFileBytes: 1000 }, ctxFor(ws));
    assert.equal(r.matches.length, 1);
    assert.deepEqual(r.skippedLargeFiles.map(norm), ['big.log']);
    assert.match(r.skippedLargeHint, /maxFileBytes/);
  });

  it('[W4] 隐藏文件:rg 与 JS 引擎口径一致(默认都不搜 .github/,includeHidden:true 才搜;JS 不读 .gitignore)', async () => {
    const ws = freshWs();
    put(path.join(ws, '.github', 'workflows', 'ci.yml'), 'env:\n  SECRET_TOKEN_W4: abc\n');
    put(path.join(ws, 'src', 'deep.js'), 'var SECRET_TOKEN_W4 = 2;\n');
    put(path.join(ws, 'ignored', 'x.js'), 'var SECRET_TOKEN_W4 = 3;\n');
    put(path.join(ws, '.gitignore'), 'ignored/\n');
    put(path.join(ws, 'dist', 'bundle.js'), 'var SECRET_TOKEN_W4 = 4;\n');
    const set = r => r.matches.map(m => norm(m.relativePath)).sort();
    const a = await srv.toolCall('file_search', { root: ws, pattern: 'SECRET_TOKEN_W4' }, ctxFor(ws));
    const b = await srv.toolCall('file_search', { root: ws, pattern: 'SECRET_TOKEN_W4' + JS_ONLY }, ctxFor(ws));
    assert.deepEqual(set(b), ['ignored/x.js', 'src/deep.js']);
    assert.deepEqual(set(a), set(b), `engine ${a.engine} vs ${b.engine}`);   // 非 git 目录里 rg 也不套 .gitignore
    const c = await srv.toolCall('file_search', { root: ws, pattern: 'SECRET_TOKEN_W4', includeHidden: true }, ctxFor(ws));
    const d = await srv.toolCall('file_search', { root: ws, pattern: 'SECRET_TOKEN_W4' + JS_ONLY, includeHidden: true }, ctxFor(ws));
    assert.deepEqual(set(d), ['.github/workflows/ci.yml', 'ignored/x.js', 'src/deep.js']);
    assert.deepEqual(set(c), set(d), `engine ${c.engine} vs ${d.engine}`);
  });

  it('[W4] JS 引擎跳过含 NUL 的二进制文件', async () => {
    const ws = freshWs();
    put(path.join(ws, 'blob.bin'), Buffer.concat([Buffer.from('NEEDLE_BIN_W4'), Buffer.from([0, 1, 2, 3])]));
    put(path.join(ws, 'text.txt'), 'NEEDLE_BIN_W4\n');
    const r = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_BIN_W4' + JS_ONLY }, ctxFor(ws));
    assert.deepEqual(r.matches.map(m => norm(m.relativePath)), ['text.txt']);
  });
});

describe('[W5] file_list / project_snapshot 信封与 pattern', () => {
  it('[W5] file_list:glob 形 pattern 按 glob 生效;非法正则给 bad_pattern + hint,不再是原始 SyntaxError', async () => {
    const ws = freshWs();
    put(path.join(ws, 'a.js'), '1'); put(path.join(ws, 'sub', 'b.js'), '1'); put(path.join(ws, 'c.md'), '1');
    for (const pat of ['*.js', '**/*.js']) {
      const r = await srv.toolCall('file_list', { root: ws, pattern: pat }, ctxFor(ws));
      assert.equal(r.ok, true, pat + ' ' + JSON.stringify(r).slice(0, 200));
      assert.deepEqual(rels(r.files).sort(), ['a.js', 'sub/b.js'], pat);
    }
    const re = await srv.toolCall('file_list', { root: ws, pattern: '\\.md$' }, ctxFor(ws));
    assert.deepEqual(rels(re.files), ['c.md']);
    let bad;
    try { bad = await srv.toolCall('file_list', { root: ws, pattern: 'foo(' }, ctxFor(ws)); } catch (e) { bad = { thrown: String(e && e.message) }; }
    assert.equal(bad.ok, false, JSON.stringify(bad));
    assert.equal(bad.code, 'bad_pattern');
    assert.ok(bad.hint && /regular expression/.test(bad.hint));
  });

  it('[W5] file_list 信封:只带相对路径,默认 500 条 < 45000 字符;absolute:true 才带 path', async () => {
    const ws = freshWs();
    for (let i = 0; i < 700; i++) put(path.join(ws, 'src', 'pkg' + String(i % 20).padStart(2, '0'), 'module_' + i + '.js'), 'x');
    const r = await srv.toolCall('file_list', { root: ws }, ctxFor(ws));
    assert.equal(r.files.length, 500);
    assert.equal(r.truncated, true); assert.ok(r.hint);
    assert.ok(r.files.every(f => f.path === undefined && typeof f.relativePath === 'string'));
    assert.ok(r.files.filter(f => f.type === 'directory').every(f => f.size === undefined));
    const len = JSON.stringify(r).length;
    assert.ok(len < 45000, 'envelope ' + len);
    const abs = await srv.toolCall('file_list', { root: ws, maxFiles: 5, absolute: true }, ctxFor(ws));
    assert.ok(abs.files.every(f => path.isAbsolute(f.path)));
  });

  it('[W5] project_snapshot:第一个目录有 1000 个文件时,顶层条目仍全部列出(广度优先)', async () => {
    const ws = freshWs();
    for (let i = 0; i < 1000; i++) put(path.join(ws, 'a_first', 'f' + i + '.txt'), 'x');
    for (const d of ['b_src', 'c_docs', 'd_tests']) put(path.join(ws, d, 'x.txt'), 'x');
    put(path.join(ws, 'README.md'), '#');
    const r = await srv.toolCall('project_snapshot', { root: ws }, ctxFor(ws));
    const top = rels(r.files).filter(p => !p.includes('/'));
    assert.deepEqual(top.sort(), ['README.md', 'a_first', 'b_src', 'c_docs', 'd_tests']);
    assert.equal(r.truncated, true); assert.ok(r.hint);
  });
});

describe('[W6][W7] docs_search / codebase_symbol_search', () => {
  it('[W6] docs_search 只搜文档后缀:代码文件里的命中不占位', async () => {
    const ws = freshWs();
    for (let i = 0; i < 60; i++) put(path.join(ws, 'src', 'm' + i + '.js'), '// how to configure widgets\n');
    put(path.join(ws, 'docs', 'guide.md'), '# guide\nhow to configure widgets here\n');
    put(path.join(ws, 'README.md'), 'how to configure widgets\n');
    put(path.join(ws, 'notes.rst'), 'how to configure widgets\n');
    const r = await srv.toolCall('docs_search', { root: ws, query: 'configure widgets' }, ctxFor(ws));
    assert.equal(r.ok, true);
    const files = r.matches.map(m => norm(m.relativePath)).sort();
    assert.deepEqual(files, ['README.md', 'docs/guide.md', 'notes.rst']);
    assert.equal(r.matches[0].relativePath, 'README.md', '根下 README 排第一');
    assert.ok(!r.truncated);
    const t = await srv.toolCall('docs_search', { root: ws, query: 'configure widgets', maxResults: 2 }, ctxFor(ws));
    assert.equal(t.matches.length, 2); assert.equal(t.truncated, true);
  });

  it('[W7] codebase_symbol_search 默认区分大小写;caseSensitive:false 放开', async () => {
    const ws = freshWs();
    put(path.join(ws, 'a.js'), 'class User {}\nconst user = new User();\nuser.save();\n');
    const r = await srv.toolCall('codebase_symbol_search', { root: ws, symbol: 'User' }, ctxFor(ws));
    assert.equal(r.definitionCount, 1, JSON.stringify(r.definitions));
    assert.equal(r.definitions[0].kind, 'class');
    assert.equal(r.referenceCount, 1, JSON.stringify(r.references));
    assert.equal(r.references[0].line, 2, 'new User() 是引用,没被 const user 那行吞掉');
    const ci = await srv.toolCall('codebase_symbol_search', { root: ws, symbol: 'User', caseSensitive: false }, ctxFor(ws));
    assert.ok(ci.definitionCount + ci.referenceCount >= 3);
  });
});

describe('[W8] data_profile', () => {
  const canGbk = (() => { try { new TextDecoder('gb18030'); return true; } catch { return false; } })();

  it('[W8] 5MB CSV(5000 行 × ~1KB):rowCount 是 maxRows,sampled:true,给出精确总行数', async () => {
    const ws = freshWs();
    const pad = 'x'.repeat(1000);
    const lines = ['id,pad']; for (let i = 0; i < 5000; i++) lines.push(i + ',' + pad);
    put(path.join(ws, 'wide.csv'), lines.join('\n'));
    const r = await srv.toolCall('data_profile', { path: path.join(ws, 'wide.csv') }, ctxFor(ws));
    assert.equal(r.ok, true);
    assert.equal(r.rowCount, 2000);
    assert.equal(r.sampled, true, '5000 行只画像 2000 行,必须 sampled:true(修前 1MB 截断后报 1044 行 sampled:false)');
    assert.equal(r.totalRowCount, 5000);
  });

  it('[W8] 12MB CSV 超过读取窗口:truncatedInput:true + bytesRead/fileBytes + estimatedRowCount(≈总行数)', async () => {
    const ws = freshWs();
    const pad = 'y'.repeat(1000);
    const lines = ['id,pad']; for (let i = 0; i < 12000; i++) lines.push(i + ',' + pad);
    put(path.join(ws, 'huge.csv'), lines.join('\n'));
    const fileBytes = fs.statSync(path.join(ws, 'huge.csv')).size;
    const r = await srv.toolCall('data_profile', { path: path.join(ws, 'huge.csv'), maxRows: 50000 }, ctxFor(ws));
    assert.equal(r.ok, true);
    assert.equal(r.truncatedInput, true);
    assert.equal(r.sampled, true);
    assert.equal(r.fileBytes, fileBytes);
    assert.ok(r.bytesRead < fileBytes && r.bytesRead > 0);
    assert.ok(Math.abs(r.estimatedRowCount - 12000) < 600, 'estimated ' + r.estimatedRowCount);
    assert.ok(r.rowCount < 12000, '只画像了窗口内的行');
  });

  it('[W8] 3MB 合法 JSON 数组不再被判「不是合法 JSON」', async () => {
    const ws = freshWs();
    const arr = []; for (let i = 0; i < 40000; i++) arr.push({ id: i, name: 'name-' + i, pad: 'z'.repeat(60) });
    put(path.join(ws, 'big.json'), JSON.stringify(arr));
    assert.ok(fs.statSync(path.join(ws, 'big.json')).size > 3 * 1024 * 1024);
    const r = await srv.toolCall('data_profile', { path: path.join(ws, 'big.json') }, ctxFor(ws));
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    assert.equal(r.format, 'json');
    assert.equal(r.colCount, 3);
    assert.equal(r.rowCount, 2000);
    assert.equal(r.sampled, true);
    assert.equal(r.totalRowCount, 40000);
  });

  it('[W8] 20MB JSON 数组(超过整读上限):流式取前 N 个元素,truncatedInput,不读整个文件', async () => {
    const ws = freshWs();
    const chunks = ['[']; for (let i = 0; i < 160000; i++) chunks.push((i ? ',' : '') + JSON.stringify({ id: i, s: 'a,b]}"' + i, pad: 'p'.repeat(90) }));
    chunks.push(']');
    put(path.join(ws, 'giant.json'), chunks.join(''));
    const size = fs.statSync(path.join(ws, 'giant.json')).size;
    assert.ok(size > 16 * 1024 * 1024, 'size ' + size);
    const r = await srv.toolCall('data_profile', { path: path.join(ws, 'giant.json'), maxRows: 500 }, ctxFor(ws));
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(r.rowCount, 500);
    assert.equal(r.sampled, true);
    assert.equal(r.truncatedInput, true);
    assert.ok(r.bytesRead < size / 2, 'bytesRead ' + r.bytesRead);
    const idCol = r.columns.find(c => c.name === 'id');
    assert.equal(idCol.max, 499);
  });

  it('[W8] GBK 编码的 CSV:表头与值按 GB18030 解码(不是 U+FFFD 乱码)', async (t) => {
    if (!canGbk) { t.skip('本机 Node 不带 gb18030'); return; }
    const ws = freshWs();
    // "姓名,年龄\n张三,30\n李四,41\n" 的 GBK 字节
    const gbk = Buffer.from('d0d5c3fb2cc4eac1e40ad5c5c8fd2c33300ac0eecbc42c34310a', 'hex');
    put(path.join(ws, 'gbk.csv'), gbk);
    const r = await srv.toolCall('data_profile', { path: path.join(ws, 'gbk.csv') }, ctxFor(ws));
    assert.equal(r.ok, true);
    assert.equal(r.encoding, 'gb18030');
    assert.deepEqual(r.columns.map(c => c.name), ['姓名', '年龄']);
    assert.deepEqual(r.columns[0].sampleValues, ['张三', '李四']);
  });

  it('[W8] 错误分类:不存在 / 是目录 / 空文件各有各的话', async () => {
    const ws = freshWs();
    put(path.join(ws, 'empty.csv'), '');
    const nf = await srv.toolCall('data_profile', { path: path.join(ws, 'nope.csv') }, ctxFor(ws));
    assert.equal(nf.ok, false); assert.equal(nf.code, 'not_found'); assert.match(nf.error, /不存在/);
    const em = await srv.toolCall('data_profile', { path: path.join(ws, 'empty.csv') }, ctxFor(ws));
    assert.equal(em.ok, false); assert.equal(em.code, 'empty'); assert.match(em.error, /为空/);
    const dr = await srv.toolCall('data_profile', { path: ws }, ctxFor(ws));
    assert.equal(dr.ok, false); assert.equal(dr.code, 'not_file');
  });
});

describe('[W9] archive_zip / archive_unzip', () => {
  it('[W9] 自己打的包自己能解:2500 个条目(修前 unzip 用 2000 条目上限把它当 zip 炸弹拒收)', async () => {
    const ws = freshWs();
    for (let i = 0; i < 2500; i++) put(path.join(ws, 'proj', 'src', 'd' + (i % 25), 'f' + i + '.txt'), 'c' + i);
    const ctx = ctxFor(ws);
    const z = await srv.toolCall('archive_zip', { paths: [path.join(ws, 'proj')], dest: path.join(ws, 'out', 'p.zip') }, ctx);
    assert.equal(z.ok, true, JSON.stringify(z).slice(0, 300));
    assert.ok(z.entries > 2000);
    const u = await srv.toolCall('archive_unzip', { src: path.join(ws, 'out', 'p.zip'), destDir: path.join(ws, 'un') }, ctx);
    assert.equal(u.ok, true, JSON.stringify(u).slice(0, 300));
    assert.equal(u.files, 2500);
    assert.equal(fs.readFileSync(path.join(ws, 'un', 'proj', 'src', 'd3', 'f1003.txt'), 'utf8'), 'c1003');
  });

  it('[W9] archive_zip 默认不打 node_modules/.git/__pycache__/venv,并披露;includeIgnored:true 才包含', async () => {
    const ws = freshWs();
    put(path.join(ws, 'proj', 'src', 'a.js'), 'a');
    put(path.join(ws, 'proj', 'node_modules', 'lib', 'x.js'), 'x');
    put(path.join(ws, 'proj', '__pycache__', 'a.pyc'), 'x');
    put(path.join(ws, 'proj', 'logs', 'l.txt'), 'l');
    const ctx = ctxFor(ws);
    const z = await srv.toolCall('archive_zip', { paths: [path.join(ws, 'proj')], dest: path.join(ws, 'a.zip'), exclude: ['logs'] }, ctx);
    assert.equal(z.ok, true);
    assert.ok(z.skippedExcluded >= 3, JSON.stringify(z));
    assert.ok(z.excludedDirs.includes('node_modules') && z.excludedDirs.includes('logs'));
    const listed = await srv.toolCall('archive_unzip', { src: path.join(ws, 'a.zip'), list: true }, ctx);
    assert.equal(listed.ok, true);
    const names = listed.entries.map(e => e.name);
    assert.ok(names.includes('proj/src/a.js') && !names.some(n => /node_modules|__pycache__|logs/.test(n)), names.join());
    const all = await srv.toolCall('archive_zip', { paths: [path.join(ws, 'proj')], dest: path.join(ws, 'b.zip'), includeIgnored: true }, ctx);
    const listedAll = await srv.toolCall('archive_unzip', { src: path.join(ws, 'b.zip'), list: true }, ctx);
    assert.ok(listedAll.entries.some(e => /node_modules/.test(e.name)), 'includeIgnored 包含 node_modules');
    assert.ok(all.entries > z.entries);
    // 显式传入的顶层路径不被排除
    const nm = await srv.toolCall('archive_zip', { paths: [path.join(ws, 'proj', 'node_modules')], dest: path.join(ws, 'c.zip') }, ctx);
    assert.equal(nm.ok, true); assert.ok(nm.files >= 1);
  });

  it('[W9] 没有 UTF-8 标志的 GBK 条目名解码成中文;list 模式报 nameEncoding', async (t) => {
    try { new TextDecoder('gb18030'); } catch { t.skip('本机 Node 不带 gb18030'); return; }
    const ws = freshWs();
    const nameGbk = Buffer.from('d6d0cec42e747874', 'hex');   // 中文.txt
    const data = Buffer.from('hello');
    const crc = zlib.crc32 ? zlib.crc32(data) : srv.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(5, 18); lh.writeUInt32LE(5, 22); lh.writeUInt16LE(nameGbk.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc >>> 0, 16); cd.writeUInt32LE(5, 20); cd.writeUInt32LE(5, 24); cd.writeUInt16LE(nameGbk.length, 28); cd.writeUInt32LE(0, 42);
    const local = Buffer.concat([lh, nameGbk, data]);
    const cdBuf = Buffer.concat([cd, nameGbk]);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(local.length, 16);
    put(path.join(ws, 'gbk.zip'), Buffer.concat([local, cdBuf, eocd]));
    const ctx = ctxFor(ws);
    const l = await srv.toolCall('archive_unzip', { src: path.join(ws, 'gbk.zip'), list: true }, ctx);
    assert.equal(l.ok, true, JSON.stringify(l));
    assert.equal(l.entries[0].name, '中文.txt');
    assert.equal(l.nameEncoding, 'gb18030');
    const u = await srv.toolCall('archive_unzip', { src: path.join(ws, 'gbk.zip'), destDir: path.join(ws, 'out') }, ctx);
    assert.equal(u.ok, true, JSON.stringify(u));
    assert.equal(fs.readFileSync(path.join(ws, 'out', '中文.txt'), 'utf8'), 'hello');
  });

  it('[W9] 篡改一个存储字节 → CRC32 校验失败,ok:false 且不落坏文件', async () => {
    const ws = freshWs();
    put(path.join(ws, 'p', 'a.txt'), 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const ctx = ctxFor(ws);
    const buf = srv.zipWrite([{ name: 'a.txt', data: Buffer.from('important payload'), isDir: false }]);
    // zipWrite 对非空数据用 deflate;改成 stored 需要手工造 —— 直接改压缩流里的一个字节会让 inflate 报错或产出错数据,两者都必须被拒。
    const tampered = Buffer.from(buf);
    const nameLen = tampered.readUInt16LE(26);
    tampered[30 + nameLen + 3] ^= 0x55;
    put(path.join(ws, 't.zip'), tampered);
    const u = await srv.toolCall('archive_unzip', { src: path.join(ws, 't.zip'), destDir: path.join(ws, 'out') }, ctx);
    assert.equal(u.ok, false, JSON.stringify(u));
    // stored 条目 + 错 CRC:精确命中 CRC 比对
    const st = srv.zipWrite([{ name: 'e.txt', data: Buffer.alloc(0), isDir: false }]);
    const recs = srv.zipReadCentralDir(st);
    assert.equal(recs.length, 1);
    const good = Buffer.from('stored-bytes');
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(0, 14); lh.writeUInt32LE(good.length, 18); lh.writeUInt32LE(good.length, 22); lh.writeUInt16LE(5, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt32LE(0xDEADBEEF, 16); cd.writeUInt32LE(good.length, 20); cd.writeUInt32LE(good.length, 24); cd.writeUInt16LE(5, 28);
    const nm = Buffer.from('s.txt');
    const local = Buffer.concat([lh, nm, good]); const cdb = Buffer.concat([cd, nm]);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdb.length, 12); eocd.writeUInt32LE(local.length, 16);
    put(path.join(ws, 'crc.zip'), Buffer.concat([local, cdb, eocd]));
    const u2 = await srv.toolCall('archive_unzip', { src: path.join(ws, 'crc.zip'), destDir: path.join(ws, 'out2') }, ctx);
    assert.equal(u2.ok, false, JSON.stringify(u2));
    assert.match(u2.error, /CRC32/);
    assert.equal(fs.existsSync(path.join(ws, 'out2', 's.txt')), false);
  });

  it('[W9] 声明的解压总大小超过上限 → 解压前就拒绝(体积炸弹靠体积判,不靠条目数)', async () => {
    const ws = freshWs();
    const buf = Buffer.from(srv.zipWrite([{ name: 'a.txt', data: Buffer.from('tiny'), isDir: false }]));
    // 改中央目录里的声明大小为 600MB(本地头保持原样):精心构造的「小包声称巨大」
    const eocd = buf.length - 22;
    const cdOff = buf.readUInt32LE(eocd + 16);
    buf.writeUInt32LE(600 * 1024 * 1024, cdOff + 24);
    put(path.join(ws, 'bomb.zip'), buf);
    const u = await srv.toolCall('archive_unzip', { src: path.join(ws, 'bomb.zip'), destDir: path.join(ws, 'out') }, ctxFor(ws));
    assert.equal(u.ok, false);
    assert.match(u.error + (u.hint || ''), /上限|炸弹/);
    assert.equal(fs.existsSync(path.join(ws, 'out', 'a.txt')), false);
  });

  it('[W9] 打包大文件不卡事件循环(修前 deflateRawSync 一次停顿数秒)', async () => {
    const ws = freshWs();
    const crypto = require('crypto');
    const blobs = [crypto.randomBytes(30 * 1024 * 1024), crypto.randomBytes(30 * 1024 * 1024)];
    blobs.forEach((b, i) => put(path.join(ws, 'big', 'r' + i + '.bin'), b));
    // 标定:同一进程、同一负载下,同步压缩一个 30MB 随机文件要多久 —— 修前的事件循环停顿 ≥ 这个数;
    // 绝对毫秒阈值在忙碌的 CI 机上会抖,所以用相对阈值(修后的最长停顿应远小于一次同步压缩)。
    // 满载跑整套 unit 时(node --test 多文件并行),进程被 CPU 争用挂起也会记成「停顿」;真回归(同步压缩)每次都停,
    // 所以最多测 3 次、取最好的一次 —— 抖动放过,回归照样红。
    let best = Infinity, cal = 0;
    for (let attempt = 0; attempt < 3 && !(best < cal * 0.6); attempt++) {
      const c0 = process.hrtime.bigint();
      zlib.deflateRawSync(blobs[0]);
      const calMs = Number((process.hrtime.bigint() - c0) / 1000000n);
      let last = process.hrtime.bigint(), maxGap = 0n;
      const iv = setInterval(() => { const now = process.hrtime.bigint(); const g = now - last; if (g > maxGap) maxGap = g; last = now; }, 10);
      const z = await srv.toolCall('archive_zip', { paths: [path.join(ws, 'big')], dest: path.join(ws, 'big.zip') }, ctxFor(ws));
      clearInterval(iv);
      assert.equal(z.ok, true, JSON.stringify(z).slice(0, 200));
      const gapMs = Number(maxGap / 1000000n);
      if (gapMs < best) { best = gapMs; cal = calMs; }
    }
    assert.ok(best < cal * 0.6, `事件循环最长停顿 ${best} ms,应远小于一次同步压缩(${cal} ms);修前实测 3.7 s`);
    const u = await srv.toolCall('archive_unzip', { src: path.join(ws, 'big.zip'), destDir: path.join(ws, 'un') }, ctxFor(ws));
    assert.equal(u.ok, true);
    assert.equal(fs.readFileSync(path.join(ws, 'un', 'big', 'r1.bin')).equals(fs.readFileSync(path.join(ws, 'big', 'r1.bin'))), true);
  });
});

// ── [W10] 审计复核回归 ─────────────────────────────────────────────────────────────────────────────────────
const hasRgBinary = (() => { try { return cp.spawnSync('rg', ['--version']).status === 0; } catch { return false; } })();
// 抓 rg 的命令行:换掉 cp.spawn,回一个立刻「无命中」收尾的假子进程。platform 可临时改成 win32。
async function captureRgArgs(ws, args, platform) {
  const realSpawn = cp.spawn;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let captured = null;
  cp.spawn = function fake(cmd, a) {
    if (Array.isArray(a) && a.includes('--json')) {
      captured = a.slice();
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 1));
      return child;
    }
    return realSpawn.apply(this, arguments);
  };
  if (platform) Object.defineProperty(process, 'platform', { value: platform });
  try { await srv.toolCall('file_search', { root: ws, ...args }, ctxFor(ws)); }
  finally { cp.spawn = realSpawn; if (platform) Object.defineProperty(process, 'platform', realPlatform); }
  return captured;
}

describe('[W10] 显式点名不剪 + prunedDirs 必报', () => {
  function seed() {
    const ws = freshWs();
    put(path.join(ws, 'src', 'build', 'compile.js'), 'NEEDLE_W10\n');
    put(path.join(ws, 'src', 'out', 'emit.js'), 'NEEDLE_W10\n');
    put(path.join(ws, 'dist', 'bundle.js'), 'NEEDLE_W10\n');
    put(path.join(ws, 'lib', 'plain.js'), 'NEEDLE_W10\n');
    return ws;
  }
  it('[W10] glob `dist/**/*.js` 点名了 dist → 不剪;`**/compile.js` 没点名 → 剪,且 prunedDirs + prunedHint 必报', async () => {
    const ws = seed();
    const a = await srv.toolCall('glob', { root: ws, pattern: 'dist/**/*.js' }, ctxFor(ws));
    assert.deepEqual(rels(a.files), ['dist/bundle.js'], JSON.stringify(a));
    assert.ok(!(a.prunedDirs || []).includes('dist'));
    const b = await srv.toolCall('glob', { root: ws, pattern: '**/compile.js' }, ctxFor(ws));
    assert.deepEqual(b.files, []);
    assert.ok(b.prunedDirs.includes('src/build'), JSON.stringify(b));
    assert.match(b.prunedHint, /includeIgnored:true/);
    const c = await srv.toolCall('glob', { root: ws, pattern: 'src/build/*.js' }, ctxFor(ws));
    assert.deepEqual(rels(c.files), ['src/build/compile.js'], '中段点名(src/build)也算');
  });

  for (const [label, suffix] of [['默认引擎', ''], ['JS 引擎', JS_ONLY]]) {
    it(`[W10] file_search(${label}):默认剪 build/out/dist 并披露;glob 点名 dist 则搜它;includeIgnored 全搜`, async () => {
      const ws = seed();
      const r = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10' + suffix }, ctxFor(ws));
      assert.deepEqual(r.matches.map(m => norm(m.relativePath)), ['lib/plain.js'], JSON.stringify(r).slice(0, 400));
      assert.ok(r.prunedDirs.includes('dist') && r.prunedDirs.includes('src/build') && r.prunedDirs.includes('src/out'), JSON.stringify(r.prunedDirs));
      assert.match(r.prunedHint, /includeIgnored:true/);
      const g = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10' + suffix, glob: 'dist/**' }, ctxFor(ws));
      assert.deepEqual(g.matches.map(m => norm(m.relativePath)), ['dist/bundle.js'], JSON.stringify(g).slice(0, 400));
      const all = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10' + suffix, includeIgnored: true }, ctxFor(ws));
      assert.equal(all.matches.length, 4);
      assert.equal(all.prunedDirs, undefined);
    });
  }

  it('[W10] root 本身叫 build:其下同名子目录不剪', async () => {
    const ws = freshWs();
    put(path.join(ws, 'build', 'build', 'inner.js'), 'NEEDLE_W10R\n');
    const r = await srv.toolCall('file_search', { root: path.join(ws, 'build'), pattern: 'NEEDLE_W10R' + JS_ONLY }, ctxFor(ws));
    assert.deepEqual(r.matches.map(m => norm(m.relativePath)), ['build/inner.js'], JSON.stringify(r).slice(0, 300));
  });

  it('[W10] file_list / project_snapshot 也带 prunedHint', async () => {
    const ws = seed();
    const l = await srv.toolCall('file_list', { root: ws }, ctxFor(ws));
    assert.ok(l.prunedDirs.includes('dist'));
    assert.match(l.prunedHint, /includeIgnored:true/);
    const p = await srv.toolCall('project_snapshot', { root: ws }, ctxFor(ws));
    assert.match(p.prunedHint, /includeIgnored:true/);
    const d = await srv.toolCall('file_list', { root: ws, pattern: '^dist/' }, ctxFor(ws));
    assert.deepEqual(rels(d.files), ['dist/bundle.js'], '正则里点名 dist → 不剪');
  });
});

describe('[W10] 深度 / 隐藏 / gitignore 两个引擎同口径', () => {
  it('[W10] 深度默认不限:10 层深的文件两个引擎都搜得到;传 maxDepth 才限', async () => {
    const ws = freshWs();
    put(path.join(ws, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'deep.java'), 'NEEDLE_W10D\n');
    for (const suffix of ['', JS_ONLY]) {
      const r = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10D' + suffix }, ctxFor(ws));
      assert.equal(r.matches.length, 1, `engine ${r.engine}: ` + JSON.stringify(r).slice(0, 300));
      const shallow = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10D' + suffix, maxDepth: 3 }, ctxFor(ws));
      assert.equal(shallow.matches.length, 0, `engine ${shallow.engine} maxDepth:3`);
      const exact = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10D' + suffix, maxDepth: 10 }, ctxFor(ws));
      assert.equal(exact.matches.length, 1, `engine ${exact.engine} maxDepth:10(10 层目录 + 文件)`);
    }
  });

  it('[W10] 默认不搜 .ssh/.env;includeHidden:true 才搜;glob 字面点名 .github/** 则搜它(两个引擎)', async () => {
    const ws = freshWs();
    put(path.join(ws, '.ssh', 'id_rsa'), 'NEEDLE_W10H\n');
    put(path.join(ws, '.env'), 'NEEDLE_W10H=1\n');
    put(path.join(ws, '.github', 'workflows', '.hidden.yml'), 'NEEDLE_W10H\n');
    put(path.join(ws, 'src', 'a.js'), 'NEEDLE_W10H\n');
    const set = r => r.matches.map(m => norm(m.relativePath)).sort();
    for (const suffix of ['', JS_ONLY]) {
      const a = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10H' + suffix }, ctxFor(ws));
      assert.deepEqual(set(a), ['src/a.js'], `engine ${a.engine}`);
      const b = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10H' + suffix, includeHidden: true }, ctxFor(ws));
      assert.deepEqual(set(b), ['.env', '.github/workflows/.hidden.yml', '.ssh/id_rsa', 'src/a.js'], `engine ${b.engine}`);
      const c = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10H' + suffix, glob: '.github/**' }, ctxFor(ws));
      assert.deepEqual(set(c), ['.github/workflows/.hidden.yml'], `engine ${c.engine}`);
    }
  });

  it('[W10] rg 引擎遵守 .gitignore(git 仓库内);includeIgnored:true 才 --no-ignore', { skip: !hasRgBinary }, async () => {
    const ws = freshWs();
    fs.mkdirSync(path.join(ws, '.git'));
    put(path.join(ws, '.gitignore'), 'vendorx/\n');
    put(path.join(ws, 'vendorx', 'lib.js'), 'NEEDLE_W10G\n');
    put(path.join(ws, 'src', 'a.js'), 'NEEDLE_W10G\n');
    const a = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10G' }, ctxFor(ws));
    if (a.engine !== 'rg') return;
    assert.deepEqual(a.matches.map(m => norm(m.relativePath)), ['src/a.js']);
    const b = await srv.toolCall('file_search', { root: ws, pattern: 'NEEDLE_W10G', includeIgnored: true }, ctxFor(ws));
    assert.deepEqual(b.matches.map(m => norm(m.relativePath)).sort(), ['src/a.js', 'vendorx/lib.js']);
  });

  it('[W10] rg 命令行:默认无 --max-depth / --hidden / --no-ignore;传了才加;win32 排除 glob 走 --iglob', { skip: !hasRgBinary }, async () => {
    const ws = freshWs();
    put(path.join(ws, 'a.txt'), 'x\n');
    await srv.toolCall('file_search', { root: ws, pattern: 'warm' }, ctxFor(ws));   // 预热 rg 探测(探测结果进程内缓存)
    const a = await captureRgArgs(ws, { pattern: 'x' });
    if (!a) return;   // 这台机器最终走了 JS 引擎
    assert.ok(!a.includes('--max-depth'), a.join(' '));
    assert.ok(!a.includes('--hidden') && !a.includes('--no-ignore'), a.join(' '));
    const b = await captureRgArgs(ws, { pattern: 'x', maxDepth: 4, includeHidden: true, includeIgnored: true });
    assert.equal(b[b.indexOf('--max-depth') + 1], '5');
    assert.ok(b.includes('--hidden') && b.includes('--no-ignore'));
    const w = await captureRgArgs(ws, { pattern: 'x', glob: '*.TXT' }, 'win32');
    if (w) {
      const i = w.indexOf('!build/');
      assert.ok(i > 0 && w[i - 1] === '--iglob', '排除 glob 必须 --iglob(rg 的 -g 区分大小写): ' + w.join(' '));
      assert.equal(w[w.indexOf('*.TXT') - 1], '-g', '调用方自己的 glob 不动');
    }
  });
});

describe('[W10] file_list pattern 按 "/" 归一路径(Windows)', () => {
  it('[W10] 路径分隔符是反斜杠时 ^src/.*\\.ts$ 仍匹配(path.sep 模拟 Windows)', async () => {
    const ws = freshWs();
    put(path.join(ws, 'src', 'a.ts'), 'x');
    put(path.join(ws, 'src', 'deep', 'b.ts'), 'x');
    put(path.join(ws, 'other', 'c.ts'), 'x');
    // 别处(护栏 guardFileToolPath / isSensitiveDataPath)也读 path.sep,整个调用都改会被它们当成非法路径;
    // 所以只对 walkFiles / toSlash 自己的读取返回 '\\'(按调用栈判定),模拟 Windows 上 rel 用反斜杠拼接。
    const realSepDesc = Object.getOwnPropertyDescriptor(path, 'sep');
    Object.defineProperty(path, 'sep', { get: () => (/^\s*at (?:async )?(?:toSlash|walkFiles)\b/.test(String(new Error().stack).split('\n')[2] || '') ? '\\' : '/'), configurable: true });
    let r;
    try { r = await srv.toolCall('file_list', { root: ws, pattern: '^src/.*\\.ts$' }, ctxFor(ws)); }
    finally { Object.defineProperty(path, 'sep', realSepDesc); }
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
        assert.deepEqual(rels(r.files).sort(), ['src/a.ts', 'src/deep/b.ts']);
  });
});

describe('[W10] zip 条目上限 / data_profile 流式数组', () => {
  it('[W10] archive_zip 不写 65535 条(0xFFFF 是 zip64 哨兵);65534 条的包 archive_unzip 能列', async () => {
    const ws = freshWs();
    const big = path.join(ws, 'many');
    fs.mkdirSync(big);
    for (let i = 0; i < 65534; i++) fs.writeFileSync(path.join(big, 'f' + i), '');
    const ctx = ctxFor(ws);
    // 65534 个文件 + 根目录条目 = 65535 条:必须被拒(修前写成功,自己又解不开)。
    const z = await srv.toolCall('archive_zip', { paths: [big], dest: path.join(ws, 'a.zip') }, ctx);
    assert.equal(z.ok, false, JSON.stringify(z).slice(0, 300));
    assert.match(String(z.error), /65534/);
    fs.unlinkSync(path.join(big, 'f0'));
    const y = await srv.toolCall('archive_zip', { paths: [big], dest: path.join(ws, 'b.zip') }, ctx);
    assert.equal(y.ok, true, JSON.stringify(y).slice(0, 300));
    const l = await srv.toolCall('archive_unzip', { src: path.join(ws, 'b.zip'), list: true }, ctx);
    assert.equal(l.ok, true, JSON.stringify(l).slice(0, 300));
  });

  it('[W10] data_profile:顶层数组在 `]` 处结束、后面还有大量空白 → sampled:false,rowCount 精确', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'tail.json');
    const arr = JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: i, v: 'x' + i })));
    fs.writeFileSync(f, arr);
    fs.appendFileSync(f, ' '.repeat(17 * 1024 * 1024));
    const r = await srv.toolCall('data_profile', { path: f }, ctxFor(ws));
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(r.rowCount, 1500);
    assert.equal(r.sampled, false, JSON.stringify(r).slice(0, 300));
    assert.equal(r.truncatedInput, undefined);
  });
});
