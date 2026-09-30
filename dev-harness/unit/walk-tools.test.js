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
//   [W9]  archive:自己打的包自己能解(>2000 条目);默认排除清单;GBK 条目名;CRC 篡改被拒;声明体积炸弹被拒;list 模式;压缩不卡事件循环
//
// 强制走 JS 引擎:模式里带前瞻 (?=.*)(rg 的 Rust regex 拒环视 → 退回 JS),CI 机器上有没有 rg 都测得到同一条路径。
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
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

  it('[W4] 隐藏文件:rg 与 JS 引擎口径一致(都搜 .github/,都不套 .gitignore)', async () => {
    const ws = freshWs();
    put(path.join(ws, '.github', 'workflows', 'ci.yml'), 'env:\n  SECRET_TOKEN_W4: abc\n');
    put(path.join(ws, 'src', 'deep.js'), 'var SECRET_TOKEN_W4 = 2;\n');
    put(path.join(ws, 'ignored', 'x.js'), 'var SECRET_TOKEN_W4 = 3;\n');
    put(path.join(ws, '.gitignore'), 'ignored/\n');
    put(path.join(ws, 'dist', 'bundle.js'), 'var SECRET_TOKEN_W4 = 4;\n');
    const a = await srv.toolCall('file_search', { root: ws, pattern: 'SECRET_TOKEN_W4' }, ctxFor(ws));
    const b = await srv.toolCall('file_search', { root: ws, pattern: 'SECRET_TOKEN_W4' + JS_ONLY }, ctxFor(ws));
    const set = r => r.matches.map(m => norm(m.relativePath)).sort();
    assert.deepEqual(set(b), ['.github/workflows/ci.yml', 'ignored/x.js', 'src/deep.js']);
    assert.deepEqual(set(a), set(b), `engine ${a.engine} vs ${b.engine}`);
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
    const c0 = process.hrtime.bigint();
    zlib.deflateRawSync(blobs[0]);
    const calMs = Number((process.hrtime.bigint() - c0) / 1000000n);
    let last = process.hrtime.bigint(), maxGap = 0n;
    const iv = setInterval(() => { const now = process.hrtime.bigint(); const g = now - last; if (g > maxGap) maxGap = g; last = now; }, 10);
    const z = await srv.toolCall('archive_zip', { paths: [path.join(ws, 'big')], dest: path.join(ws, 'big.zip') }, ctxFor(ws));
    clearInterval(iv);
    assert.equal(z.ok, true, JSON.stringify(z).slice(0, 200));
    const gapMs = Number(maxGap / 1000000n);
    assert.ok(gapMs < calMs * 0.6, `事件循环最长停顿 ${gapMs} ms,应远小于一次同步压缩(${calMs} ms);修前实测 3.7 s`);
    const u = await srv.toolCall('archive_unzip', { src: path.join(ws, 'big.zip'), destDir: path.join(ws, 'un') }, ctxFor(ws));
    assert.equal(u.ok, true);
    assert.equal(fs.readFileSync(path.join(ws, 'un', 'big', 'r1.bin')).equals(fs.readFileSync(path.join(ws, 'big', 'r1.bin'))), true);
  });
});
