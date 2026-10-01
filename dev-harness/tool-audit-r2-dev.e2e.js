require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(2026-10 工具走查第二轮 · 分析 / git 工具):钉住第一轮审计里「确认过、当时未修」的这批问题。
// 每条断言写的是修后该有的行为,修前在这里会红:
//
//  (P) data_profile:P1 二进制(xlsx 魔数 / NUL)→ binary_file(修前 ok:true 画一堆乱码列);P2 空行不计行;
//      P3 `;` 自动探测 + 分隔符名字(tab/semicolon…)+ 多字符分隔符拒绝;P4 JSON 缺字段/对象值不再出现
//      "undefined" / "[object Object]",uniqueCount 不数缺失;P5 `[1,2,3]` 画成单个 value 列;P6 列数封顶 200;
//      P7 encodingNote 与真实原因一致(Node 带 GB18030 时不再说「不支持」)。
//  (S) codebase_symbol_search:S1 Go 方法 / JS class 方法 / `function*` / C# 方法属性 record / C `int main(void)`;
//      S2 新增后缀(.kt .swift .lua .bat .psm1 .vb …);S3 `typedef struct Foo Foo_t` 里 Foo 不是定义;
//      S4 结果只带 relativePath(absolute:true 才补 path);S5 零定义 / maxResults 截断给 hint。
//  (R) code_review_scan:R1 默认跳过测试/夹具(includeTests:true 才扫);R2 密钥规则不再命中三元式/占位符/本地化文案;
//      R3 `innerHTML = ''` 不报;R4 每条带 confidence,路径只给相对;R5 maxFindings / maxFiles / maxDepth 为 0 或撞顶 → truncated + hint。
//  (F) frontend_audit:F1 任意外部主机(ajax.googleapis.com / code.jquery.com / `//cdn.x` / https://example.com/x.png)都报,
//      <a href> 与本机主机不报;F2 .js 里的 `<html>…</html>` 字符串不报 missing-viewport,真页面报且带行号;F3 maxFiles 撞顶 → truncated。
//  (D) docs_search:D1 UTF-16 / GBK / UTF-8 BOM 文档可搜;D2 超 4MB 的 .md 能搜;D3 合法但本意是字面的查询零命中时按字面重试;D4 空查询拒绝。
//  (C) claude_md_audit:C1 没缺章节时不再说「Update missing sections」。
//  (M) dependency_inventory:M1 认 .csproj/.sln/Gemfile/.nvmrc/requirements-*.txt 等;M2 根下没有时列一层子目录并说明。
//  (H) debug_hypothesis:H1 init 重复 id 改名;H2 超过 50 个假设有警告;H3 超过 50 条实验保留精确计数并声明修剪;
//      H4 reopen 解锁;H5 根因锁定后不能再为别的假设记「支持」证据。
//  (G) git:G1 git_status 封顶 300 行(计数仍精确)+ 未跟踪目录提示;G2 仓库外 git_diff 不再塞用法文本;
//      G3 pre-commit 钩子拒绝 → 明说 + 钩子输出;G4 空仓库 git_log → unborn;G5 不存在的 path → hint;
//      G6 提交失败后列出仍在暂存区的文件;G7 git_diff / git_log 的 ref(范围、非法值、`-` 开头拒绝)+ author/since + 完整 hash。
//
// 判定行:`TOOL AUDIT R2 DEV E2E: ALL PASS`。
(async () => {
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const t = createRunner('TOOL AUDIT R2 DEV');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.RUYI_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2dev-'));
process.env.RUYI_HOME = HOME; process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2dev-ws-'));
const hasGit = (() => { try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const git = (cwd, ...a) => cp.execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gbSupported = (() => { try { return new TextDecoder('gb18030').encoding === 'gb18030'; } catch { return false; } })();
const w = (rel, body) => { const p = path.join(WS, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return p; };

const config = {
  configSchema: 7, permissionMode: 'default', engineMode: 'interactive', defaultWorkspace: WS, recentWorkspaces: [WS],
  workspaces: [{ path: WS, read: true, write: true, execute: true }],
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false,
  // 远端服务商:本机模型才放行工作区外读(既有策略),这里验的是远端模型下的围栏内行为。
  providers: [{ id: 'p1', label: 'P1', type: 'openai-compat', baseUrl: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }],
  activeProvider: 'p1',
};
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2));
const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
const cfg = await srv.readConfig();
const session = await srv.createSession({ title: 'r2 dev', cwd: WS });
session.turnSeq = 1;
const call = async (name, args) => {
  const ctx = { sessionId: session.id, turnSeq: session.turnSeq, session, config: cfg, workingDir: WS };
  try { return await srv.toolCall(name, args, ctx); } catch (e) { return { threw: String((e && e.message) || e) }; }
};
const col = (r, name) => (r.columns || []).find(c => c.name === name);

try {
  /* ═════════ (P) data_profile ═════════ */
  const xlsx = w('book.xlsx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]));
  const p1 = await call('data_profile', { path: xlsx });
  ok(p1.ok === false && p1.code === 'binary_file' && /CSV/.test(String(p1.hint || '')), `P1 xlsx(PK 魔数)→ binary_file + 导出 CSV 的提示(got ${JSON.stringify(p1).slice(0, 140)})`);
  const p1b = await call('data_profile', { path: w('blob.dat', Buffer.from([0, 1, 2, 255, 254, 0, 10])) });
  ok(p1b.ok === false && p1b.code === 'binary_file', `P1b 含 NUL 的 .dat → binary_file(got ${p1b.ok} ${p1b.code})`);

  const p2 = await call('data_profile', { path: w('blank.csv', 'a,b\n1,2\n\n3,4\n\n\n') });
  ok(p2.ok && p2.rowCount === 2 && col(p2, 'a').nullCount === 0, `P2 空行不计入数据行(rowCount=${p2.rowCount} nullCount=${col(p2, 'a') && col(p2, 'a').nullCount})`);

  const p3 = await call('data_profile', { path: w('semi.csv', 'a;b;c\n1,5;2,5;3\n4,5;5,5;6\n') });
  ok(p3.ok && p3.delimiter === ';' && p3.colCount === 3, `P3 分号分隔自动探测,且小数逗号不抢分隔符(delimiter=${p3.delimiter} cols=${p3.colCount})`);
  const p3b = await call('data_profile', { path: w('tabname.csv', 'a\tb\n1\t2\n'), delimiter: 'tab' });
  ok(p3b.ok && p3b.colCount === 2, `P3b delimiter:'tab' 按名字解析(cols=${p3b.colCount})`);
  const p3c = await call('data_profile', { path: w('multi.csv', 'a::b\n1::2\n'), delimiter: '::' });
  ok(p3c.ok === false && p3c.code === 'bad_delimiter', `P3c 多字符分隔符被明确拒绝(got ${p3c.ok} ${p3c.code})`);

  const p4 = await call('data_profile', { path: w('miss.json', JSON.stringify([{ a: 1, b: { x: 1 } }, { a: 2 }, { a: 3, b: '' }])) });
  const b4 = col(p4, 'b') || {};
  ok(p4.ok && !JSON.stringify(b4.sampleValues).includes('undefined') && !JSON.stringify(b4.sampleValues).includes('[object Object]'),
    `P4 缺字段/对象值不出现 undefined / [object Object](got ${JSON.stringify(b4.sampleValues)})`);
  ok(b4.uniqueCount === 1 && b4.nullCount === 2, `P4b uniqueCount 不数缺失/空串(unique=${b4.uniqueCount} null=${b4.nullCount})`);

  const p5 = await call('data_profile', { path: w('scalars.json', '[1,2,3]') });
  ok(p5.ok && p5.colCount === 1 && col(p5, 'value') && col(p5, 'value').type === 'numeric', `P5 标量数组画成单个 value 列(cols=${p5.colCount})`);

  const names = Array.from({ length: 300 }, (_, i) => 'c' + i);
  const p6 = await call('data_profile', { path: w('wide.csv', names.join(',') + '\n' + names.map(() => '1').join(',') + '\n') });
  ok(p6.ok && p6.colCount === 300 && p6.columns.length === 200 && p6.columnsTruncated === true, `P6 列数封顶 200(colCount=${p6.colCount} shown=${p6.columns && p6.columns.length} truncated=${p6.columnsTruncated})`);

  const p7 = await call('data_profile', { path: w('lossy.csv', Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xff, 0x2c, 0x78, 0x0a])) });
  ok(p7.ok && typeof p7.encodingNote === 'string' && (gbSupported ? !/不支持 GB18030/.test(p7.encodingNote) : true),
    `P7 encodingNote 与真实原因一致(gb18030 ${gbSupported ? '可用' : '不可用'}: ${p7.encodingNote})`);

  /* ═════════ (S) codebase_symbol_search ═════════ */
  w('sym/s.go', 'package main\nfunc (s *Server) Handle() {\n}\nfunc main() { s.Handle() }\n');
  w('sym/c.js', 'class A {\n  async handleReq(req) {\n  }\n  static make(x) {\n  }\n}\nasync function* streamer() {}\nfoo.handleReq(x);\nthing.on("e", function() {\n  handleReq(1);\n});\n');
  w('sym/c.cs', 'namespace N {\n public record Rec(int A);\n public class C {\n  public string Name { get; set; }\n  public async Task<int> RunAsync(int x)\n  {\n   return Helper(x);\n  }\n  private static int Helper(int x) { return x; }\n }\n}\n');
  w('sym/m.c', 'typedef struct Foo Foo_t;\nstruct Foo { int a; };\nint main(void)\n{\n  return helper(1);\n}\nstatic int helper(int x) { return x; }\ntypedef struct { int q; } Bar_t;\n');
  w('sym/k.kt', 'fun String.shout(): String = this\nclass K { fun go() {} }\n');
  w('sym/l.lua', 'local function lf() end\nfunction M.mf() end\n');
  w('sym/a.bat', '@echo off\ncall :sub1\n:sub1\nset FOO=1\n');
  w('sym/p.psm1', 'Function Get-Thing { }\nGet-Thing\n');
  w('sym/v.vb', 'Public Sub DoIt()\nEnd Sub\nPublic Class Cls\nEnd Class\n');
  w('sym/sw.swift', 'func sw() {}\nprotocol Proto {}\n');
  const defs = async (symbol, extra = {}) => {
    const r = await call('codebase_symbol_search', { root: 'sym', symbol, ...extra });
    return { r, list: (r.definitions || []).map(d => `${d.relativePath}:${d.line}`) };
  };
  const expectDef = async (symbol, where, label) => {
    const { list } = await defs(symbol);
    ok(list.includes(where), `S1 ${label || symbol} 识别为定义 ${where}(got ${JSON.stringify(list)})`);
  };
  await expectDef('Handle', 's.go:2', 'Go 方法');
  await expectDef('main', 'm.c:3', 'C int main(void)');
  await expectDef('handleReq', 'c.js:2', 'JS class 方法');
  await expectDef('make', 'c.js:4', 'JS static 方法');
  await expectDef('streamer', 'c.js:7', 'async function*');
  await expectDef('Name', 'c.cs:4', 'C# 属性');
  await expectDef('RunAsync', 'c.cs:5', 'C# 方法(大括号换行)');
  await expectDef('Rec', 'c.cs:2', 'C# record');
  await expectDef('Helper', 'c.cs:9', 'C# 私有静态方法');
  const hr = await defs('handleReq');
  ok(!hr.list.includes('c.js:8') && !hr.list.includes('c.js:10'), `S1b 调用(foo.handleReq(x); / 回调里的 handleReq(1);)不算定义(got ${JSON.stringify(hr.list)})`);
  await expectDef('shout', 'k.kt:1', 'Kotlin 扩展函数(.kt 后缀)');
  await expectDef('lf', 'l.lua:1', 'Lua(.lua 后缀)');
  await expectDef('sub1', 'a.bat:3', '批处理标签(.bat 后缀)');
  await expectDef('Get-Thing', 'p.psm1:1', 'PowerShell 模块(.psm1 后缀)');
  await expectDef('DoIt', 'v.vb:1', 'VB Sub(.vb 后缀)');
  await expectDef('Proto', 'sw.swift:2', 'Swift protocol(.swift 后缀)');
  const foo = await defs('Foo');
  ok(foo.list.includes('m.c:2') && !foo.list.includes('m.c:1'), `S3 typedef struct Foo Foo_t 里的 Foo 不是定义,struct Foo {…} 才是(got ${JSON.stringify(foo.list)})`);
  const alias = await defs('Bar_t');
  ok(alias.list.includes('m.c:8'), `S3b } Bar_t; 是别名定义(got ${JSON.stringify(alias.list)})`);
  const slim = await call('codebase_symbol_search', { root: 'sym', symbol: 'Handle' });
  ok(slim.definitions.every(d => d.path === undefined && typeof d.relativePath === 'string') && slim.references.every(d => d.path === undefined) && slim.files.every(f => f.path === undefined),
    'S4 命中与 files[] 只带 relativePath');
  const abs = await call('codebase_symbol_search', { root: 'sym', symbol: 'Handle', absolute: true });
  ok(abs.definitions.every(d => path.isAbsolute(d.path)), 'S4b absolute:true 补回绝对 path');
  const none = await call('codebase_symbol_search', { root: 'sym', symbol: 'handleReq', kind: 'any', maxResults: 1 });
  ok(none.truncated === true && /maxResults/.test(String(none.hint || '')), `S5 撞 maxResults 给 hint(got ${none.hint})`);
  const refOnly = await call('codebase_symbol_search', { root: 'sym', symbol: 'helper', kind: 'any' });
  const noDef = await call('codebase_symbol_search', { root: 'sym', symbol: 'NoSuchThing' });
  ok(noDef.definitionCount === 0 && /没有找到/.test(String(noDef.hint || '')), `S5b 零命中给 hint(got ${noDef.hint})`);
  ok(refOnly.definitionCount >= 1, 'S5c 有定义时不误报零定义 hint');

  /* ═════════ (R) code_review_scan ═════════ */
  // 「真密钥」夹具在运行时拼出来:源码里写整串会被 repo-hygiene (b) 的密钥扫描当成泄露(Windows CI 实测)。
  const FAKE_KEY = 'sk' + '-' + 'abcdef0123456789abcdef';
  w('rev/src/cfg.js', "const a = includes(token) ? token : 'not-installed';\nconst apiKey = '" + FAKE_KEY + "';\nel.innerHTML = '';\nel.innerHTML = userHtml;\nconst t = { password: 'Password must be at least 8 characters' };\nconst l = { 'x-api-key': 'provider.anthropicAuth.xApiKey' };\nconst z = { token: '令牌缺失或无效，请重新登录' };\n");
  w('rev/tests/t.js', "const modelsApiKey = 'abcdefgh12345678';\n");
  w('rev/dev-harness/x.e2e.js', "const apiKey = 'abcdefgh12345678';\n");
  w('rev/src/a.test.js', "const apiKey = 'abcdefgh12345678';\n");
  const rv = await call('code_review_scan', { root: 'rev' });
  // relativePath 用的是宿主分隔符(Windows 上是 src\\cfg.js,与 file_list 同口径),比较前统一成 /。
  const fwd = p => String(p || '').replace(/\\/g, '/');
  const rvIds = (rv.findings || []).map(f => `${f.id}:${fwd(f.relativePath)}:${f.line}`);
  ok(rvIds.join(',') === 'hardcoded-secret:src/cfg.js:2,xss-html:src/cfg.js:4', `R1/R2/R3 只剩真密钥与非空 innerHTML,测试/夹具与误报全跳过(got ${JSON.stringify(rvIds)})`);
  ok(rv.skippedTestFiles === 3 && /includeTests/.test(String(rv.hint || '')), `R1b 报 skippedTestFiles 并说怎么放开(got ${rv.skippedTestFiles})`);
  const rvAll = await call('code_review_scan', { root: 'rev', includeTests: true });
  ok((rvAll.findings || []).some(f => fwd(f.relativePath).startsWith('tests/')) && (rvAll.findings || []).some(f => fwd(f.relativePath) === 'src/a.test.js'), 'R1c includeTests:true 才扫测试/夹具');
  ok(rv.findings.every(f => ['high', 'medium', 'low'].includes(f.confidence) && f.path === undefined && typeof f.relativePath === 'string'), 'R4 每条带 confidence、路径只给相对');
  const rvCap = await call('code_review_scan', { root: 'rev', maxFindings: 1 });
  ok(rvCap.truncated === true && /maxFindings/.test(String(rvCap.hint || '')), `R5 撞 maxFindings → truncated + hint(got ${rvCap.truncated})`);
  const rvZero = await call('code_review_scan', { root: 'rev', maxFiles: 0 });
  ok(rvZero.truncated === true && rvZero.scannedFiles !== undefined, `R5b maxFiles:0 不再被当成默认 1200(scannedFiles=${rvZero.scannedFiles} truncated=${rvZero.truncated})`);
  const rvDepth = await call('code_review_scan', { root: 'rev', maxDepth: 0, includeTests: true });
  ok(rvDepth.total === 0, `R5c maxDepth:0 只看根层、不下钻(total=${rvDepth.total})`);

  /* ═════════ (F) frontend_audit ═════════ */
  w('fe/web/index.html', '<html><head>\n<script src="https://ajax.googleapis.com/ajax/libs/jquery.js"></script>\n<script src="//cdn.example.com/x.js"></script>\n<script src="https://code.jquery.com/jquery.min.js"></script>\n<a href="https://github.com/x">gh</a>\n<img src="http://localhost:3000/ok.png">\n</head></html>\n');
  w('fe/web/img.html', '<html><meta name="viewport" content="width=device-width"><img src="https://example.com/x.png"></html>');
  w('fe/web/s.css', '@import url("https://fonts.googleapis.com/css");\nb { background: url(https://maxcdn.bootstrapcdn.com/x.png); }\n');
  w('fe/web/local.html', '<html><meta name="viewport" content="w"><a href="https://github.com/x">gh</a><img src="http://localhost:3000/ok.png"></html>');
  w('fe/src/tpl.js', "const mail = '<html><body>hi</body></html>';\n");
  const fe = await call('frontend_audit', { root: 'fe' });
  const feHit = (id, rel) => (fe.issues || []).find(i => i.id === id && i.relativePath.replace(/\\/g, '/') === rel);
  ok(feHit('external-asset', 'web/index.html') && feHit('external-asset', 'web/index.html').line === 2 && feHit('external-asset', 'web/index.html').count === 3, `F1 ajax.googleapis.com / //cdn.x / code.jquery.com 都算(got ${JSON.stringify(feHit('external-asset', 'web/index.html'))})`);
  ok(feHit('external-asset', 'web/img.html'), 'F1b 任意外部图片 https://example.com/x.png 也报');
  ok(feHit('external-asset', 'web/s.css') && feHit('external-asset', 'web/s.css').count === 2, 'F1c CSS 的 @import / url() 外部主机');
  ok(!feHit('external-asset', 'web/local.html'), 'F1d <a href> 导航与 localhost 不报');
  ok(!(fe.issues || []).some(i => i.id === 'missing-viewport' && /tpl\.js$/.test(i.relativePath)), 'F2 .js 里的 <html> 字符串不报 missing-viewport');
  ok(feHit('missing-viewport', 'web/index.html') && feHit('missing-viewport', 'web/index.html').line === 1, 'F2b 真页面报 missing-viewport 且带行号');
  const feCap = await call('frontend_audit', { root: 'fe', maxFiles: 2 });
  ok(feCap.truncated === true && typeof feCap.scannedFiles === 'number' && /maxFiles/.test(String(feCap.hint || '')), `F3 maxFiles 撞顶 → truncated + scannedFiles + hint(got ${feCap.truncated}/${feCap.scannedFiles})`);

  /* ═════════ (D) docs_search ═════════ */
  w('docs/u16.md', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# 标题 hello\n内容 world\n', 'utf16le')]));
  w('docs/bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Heading\nbody\n')]));
  w('docs/big.md', 'x'.repeat(5 * 1024 * 1024) + '\nneedle-in-big\n');
  w('docs/win.md', 'path C:\\Users\\bob here\nTODO (urgent) fix\n');
  if (gbSupported) w('docs/gbk.md', Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from(' ascii-hit\n')]));   // 「中文 ascii-hit」的 GBK 字节
  const ds = async (query, extra = {}) => call('docs_search', { root: 'docs', query, ...extra });
  const d1 = await ds('内容 world');
  ok((d1.matches || []).some(m => m.relativePath === 'u16.md'), `D1 UTF-16LE(BOM)文档可搜(got ${JSON.stringify(d1.matches).slice(0, 120)})`);
  if (gbSupported) {
    const d1b = await ds('中文'); const d1c = await ds('ascii-hit');
    ok((d1b.matches || []).some(m => m.relativePath === 'gbk.md'), 'D1b GBK 文档里中文查询命中');
    ok((d1c.matches || []).some(m => m.relativePath === 'gbk.md' && /中文/.test(m.text)), 'D1c GBK 文档英文命中的文本不是乱码');
  }
  const d1d = await ds('^# Heading');
  ok((d1d.matches || []).some(m => m.relativePath === 'bom.md' && m.line === 1 && !m.text.startsWith('\ufeff')), `D1d UTF-8 BOM 剥掉后 ^# 配得上第 1 行(got ${JSON.stringify(d1d.matches).slice(0, 120)})`);
  const d2 = await ds('needle-in-big');
  ok((d2.matches || []).some(m => m.relativePath === 'big.md'), `D2 5MB 的 .md 也能搜(got ${JSON.stringify(d2.matches).slice(0, 100)})`);
  const d2b = await ds('needle-in-big', { maxFileBytes: 1024 * 1024 });
  ok((d2b.skippedLargeFiles || []).includes('big.md'), `D2b 超限的文件列进 skippedLargeFiles(got ${JSON.stringify(d2b.skippedLargeFiles)})`);
  const d3 = await ds('C:\\Users');
  ok((d3.matches || []).length === 1 && /literal/.test(String(d3.patternNote || '')), `D3 合法但本意是字面的 C:\\Users → 按字面重试并说明(got ${(d3.matches || []).length} ${d3.patternNote})`);
  const d3b = await ds('TODO (urgent)');
  ok((d3b.matches || []).length === 1, `D3b TODO (urgent) 按字面重试命中(got ${(d3b.matches || []).length})`);
  const d4 = await ds('');
  ok(d4.ok === false && /query/.test(String(d4.error || '')), `D4 空查询拒绝(got ${JSON.stringify(d4).slice(0, 100)})`);

  /* ═════════ (C) claude_md_audit ═════════ */
  w('cm/CLAUDE.md', '# Overview\nRun the tests with `npm test`. Follow the style conventions. No secrets. Works offline.\n');
  const cm = await call('claude_md_audit', { root: 'cm' });
  ok(cm.found === 1 && cm.audits[0].missing.length === 0 && !/Update missing sections/.test(cm.recommendation), `C1 没缺章节不再叫人「Update missing sections」(got ${cm.recommendation})`);
  w('cm2/CLAUDE.md', 'latest thoughts\n');
  const cm2 = await call('claude_md_audit', { root: 'cm2' });
  ok(/Update missing sections/.test(cm2.recommendation) && /commands/.test(cm2.recommendation), `C1b 有缺时点名缺哪些(got ${cm2.recommendation})`);

  /* ═════════ (M) dependency_inventory ═════════ */
  for (const f of ['App.csproj', 'App.sln', 'Gemfile', '.nvmrc', 'requirements-dev.txt', 'uv.lock', 'environment.yml', 'setup.py', 'deno.json', 'Directory.Packages.props', 'packages.config', '.python-version']) w('dep/' + f, '');
  const dep = await call('dependency_inventory', { root: 'dep' });
  const depFiles = (dep.files || []).map(f => f.relativePath);
  ok(['App.csproj', 'App.sln', 'Gemfile', '.nvmrc', 'requirements-dev.txt', 'uv.lock', 'environment.yml', 'setup.py', 'deno.json', 'Directory.Packages.props', 'packages.config', '.python-version'].every(f => depFiles.includes(f)),
    `M1 认出 .NET / Ruby / uv / conda / deno / 版本钉文件(got ${JSON.stringify(depFiles)})`);
  w('mono/readme.txt', 'x');
  const mono = await call('dependency_inventory', { root: 'mono' });
  ok((mono.files || []).length === 0 && /顶层/.test(String(mono.note || '')), `M2 根及一层子目录都没有清单 → note 说明只看顶层(got ${mono.note})`);
  w('mono2/a/package.json', '{}'); w('mono2/b/go.mod', 'module b');
  const mono2 = await call('dependency_inventory', { root: 'mono2' });
  const nested2 = (mono2.nestedManifests || []).map(n => n.relativePath.replace(/\\/g, '/')).sort();
  ok(nested2.join(',') === 'a/package.json,b/go.mod', `M2b 根下没有清单 → 列出一层子目录里的(got ${JSON.stringify(nested2)})`);

  /* ═════════ (H) debug_hypothesis ═════════ */
  const dh = a => call('debug_hypothesis', a);
  const h1 = await dh({ action: 'init', hypotheses: [{ id: 'H2', description: 'a' }, { description: 'second' }, { id: 'H2', description: 'dup' }] });
  const ids = h1.ledger.hypotheses.map(h => h.id);
  ok(new Set(ids).size === ids.length && ids[0] === 'H2' && /重复/.test(String(h1.warning || '')), `H1 init 重复 id 改名并提示(got ${JSON.stringify(ids)} ${h1.warning})`);
  const h2 = await dh({ action: 'init', hypotheses: Array.from({ length: 60 }, (_, i) => ({ description: 'd' + i })) });
  ok(h2.ledger.hypotheses.length === 50 && /50/.test(String(h2.warning || '')), `H2 超过 50 个假设有警告(got ${h2.ledger.hypotheses.length} ${h2.warning})`);
  let led = (await dh({ action: 'init', hypotheses: [{ description: 'a' }, { description: 'b' }] })).ledger;
  let last = null;
  for (let i = 0; i < 55; i += 1) { last = await dh({ action: 'test', ledger: led, hypothesisId: 'H1', result: i % 2 ? 'supports' : 'inconclusive', evidence: 'e' + i }); led = last.ledger; }
  const hh = led.hypotheses[0];
  ok(hh.testCount === 55 && hh.tests.length === 50 && hh.trimmedTests === 5 && /修剪/.test(String(last.testsTrimmedWarning || '')), `H3 testCount 精确、说明修剪(testCount=${hh.testCount} kept=${hh.tests.length} trimmed=${hh.trimmedTests})`);
  ok(hh.tests[hh.tests.length - 1].evidence === 'e54', 'H3b 最新一条实验没被丢(修前切掉的是最新的)');
  const concl = await dh({ action: 'conclude', ledger: led, hypothesisId: 'H1' });
  ok(concl.ok === true, 'H4 conclude 成功');
  const sup = await dh({ action: 'test', ledger: concl.ledger, hypothesisId: 'H2', result: 'supports', evidence: 'x' });
  ok(sup.ok === false && /reopen/.test(String(sup.error || '')), `H5 根因锁定后不能再为别的假设记支持证据(got ${sup.error})`);
  const rf = await dh({ action: 'test', ledger: concl.ledger, hypothesisId: 'H2', result: 'refutes', evidence: 'x' });
  ok(rf.ok === true, 'H5b 锁定后排除其余假设(refutes)仍允许(earlyStopWarning 要求的收尾动作)');
  const reo = await dh({ action: 'reopen', ledger: concl.ledger });
  ok(reo.ok === true && reo.reopened === 'H1' && reo.ledger.concluded === null && reo.ledger.hypotheses[0].status === 'supported', `H4b reopen 解锁并回到 supported(got ${JSON.stringify(reo).slice(0, 120)})`);
  const again = await dh({ action: 'test', ledger: reo.ledger, hypothesisId: 'H2', result: 'supports', evidence: 'y' });
  ok(again.ok === true, 'H4c reopen 之后可以继续实验');

  /* ═════════ (G) git ═════════ */
  if (hasGit) {
    const repo = path.join(WS, 'repo');
    fs.mkdirSync(repo);
    const outRepo = await call('git_diff', { cwd: repo });
    ok(outRepo.ok === false && /不是 Git 仓库/.test(String(outRepo.error)) && String(outRepo.detail || '').length < 400, `G2 仓库外 git_diff 不塞用法文本(detail ${String(outRepo.detail || '').length} 字符)`);
    git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@e.c'); git(repo, 'config', 'user.name', 'Tester');
    const unborn = await call('git_log', { cwd: repo });
    ok(unborn.ok === true && unborn.unborn === true && unborn.count === 0 && /还没有任何提交/.test(String(unborn.hint || '')), `G4 空仓库 git_log → 还没有任何提交(got ${JSON.stringify(unborn).slice(0, 120)})`);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'first');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'second');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');

    const lg = await call('git_log', { cwd: repo });
    ok(lg.commits.length === 2 && lg.commits.every(c => /^[0-9a-f]{40}$/.test(c.fullHash) && c.hash.length < 40), 'G7 git_log 行带完整 hash(fullHash)');
    const lgA = await call('git_log', { cwd: repo, author: 'tester', since: '2 weeks ago', ref: 'HEAD~1' });
    ok(lgA.ok && lgA.count === 1 && lgA.commits[0].subject === 'first', `G7b git_log ref+author+since(got ${JSON.stringify(lgA).slice(0, 140)})`);
    const lgN = await call('git_log', { cwd: repo, author: 'nobody-here' });
    ok(lgN.ok && lgN.count === 0, 'G7c author 过滤无匹配 → 0 条');
    for (const bad of ['--output=' + path.join(WS, 'smuggle.txt'), '-p', 'HEAD; rm -rf', 'a b']) {
      const rl = await call('git_log', { cwd: repo, ref: bad }); const rd = await call('git_diff', { cwd: repo, ref: bad });
      ok(rl.ok === false && rd.ok === false && rl.code === 'invalid_ref', `G7d 非法 ref ${JSON.stringify(bad)} 被拒(log=${rl.code} diff=${rd.code})`);
    }
    ok(!fs.existsSync(path.join(WS, 'smuggle.txt')), 'G7e ref 走私探针:--output 文件未被创建');
    const rd1 = await call('git_diff', { cwd: repo, ref: 'HEAD~1' });
    ok(rd1.ok && rd1.ref === 'HEAD~1' && /^\+three/m.test(rd1.diff) && /^-one/m.test(rd1.diff), `G7f git_diff ref:HEAD~1 = 工作区对 HEAD~1(got ${JSON.stringify(String(rd1.diff).slice(0, 100))})`);
    const rd2 = await call('git_diff', { cwd: repo, ref: 'HEAD~1..HEAD' });
    ok(rd2.ok && /^\+two/m.test(rd2.diff) && !/three/.test(rd2.diff), 'G7g git_diff ref:HEAD~1..HEAD = 两个提交之间');
    const rNo = await call('git_diff', { cwd: repo, ref: 'no-such-branch' });
    ok(rNo.ok === false && /ref/.test(String(rNo.error)), `G7h 不存在的 ref → 明确报错(got ${rNo.error})`);

    const noPathD = await call('git_diff', { cwd: repo, path: 'nonexistent.txt' });
    const noPathL = await call('git_log', { cwd: repo, path: 'nonexistent.txt' });
    ok(/不存在/.test(String(noPathD.hint || '')) && /不存在/.test(String(noPathL.hint || '')), `G5 不存在的 path 给 hint(diff=${noPathD.hint} log=${noPathL.hint})`);

    for (let i = 0; i < 350; i += 1) fs.writeFileSync(path.join(repo, `f${i}.txt`), 'x');
    fs.mkdirSync(path.join(repo, 'newdir')); for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(repo, 'newdir', `n${i}.txt`), 'x');
    const st = await call('git_status', { cwd: repo });
    ok(st.statusTruncated === true && st.status.split('\n').filter(Boolean).length <= 301 && st.changes === 352 && /352/.test(st.summary), `G1 git_status 封顶 300 行、计数仍精确(lines=${st.status.split('\n').filter(Boolean).length} changes=${st.changes})`);
    ok(st.untrackedDirs === 1 && /目录/.test(String(st.hint || '')), `G1b 未跟踪目录折叠成一条,提示里说明(untrackedDirs=${st.untrackedDirs})`);

    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed: bad style" >&2\nexit 1\n', { mode: 0o755 });
    if (process.platform !== 'win32') {
      const hook = await call('git_commit', { cwd: repo, message: 'x', paths: ['f1.txt'] });
      ok(hook.ok === false && /pre-commit 钩子拒绝/.test(String(hook.error)) && /lint failed/.test(String(hook.detail || '')), `G3 钩子拒绝 → 明说并带钩子输出(got ${hook.error} / ${String(hook.detail).slice(0, 40)})`);
      ok(hook.stagedCount === 1 && hook.staged.includes('f1.txt'), `G6 提交失败后列出仍在暂存区的文件(got ${JSON.stringify(hook.staged)})`);
    } else {
      console.log('SKIP G3/G6 (sh pre-commit hook needs a POSIX shell)');
    }
  } else {
    console.log('SKIP (G) git not installed');
  }
} catch (e) {
  t.fail('fatal: ' + ((e && e.stack) || e));
}
t.done({ exit: true });
})();
