require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(2026-10 工具走查·第二轮 · 文件工具组):首轮走查之后【确认过但还没修】的那批文件工具缺陷。
// 每一条都是修前真调复现过的现场,断言写的是修后该有的行为(修前在这里会红):
//
//  (S) file_search  S1 GBK 文件里的中文搜得到、命中行的中文不再是乱码(rg 与 JS 两个引擎都验);
//                   S2 结果里如实报 nonUtf8Files;S3 命中数恰等于 maxResults 不报 truncated(多于它才报)。
//  (R) file_read    R1 前 8KB 含 NUL 的 .dat / .docx / .xlsx / .jar / .sqlite 不再 ok:true + 乱码(code:binary,hint 指向该用的工具);
//                   R2 带 UTF-16 BOM 的文本照常可读;R3 limit:0 / lineLimit:0 不再给「空内容 + nextOffset 不变」的死循环。
//  (W) file_write   W1 latin1 / ascii 写含中文的内容 → unencodable(修前静默取低字节写出乱码);
//                   W2 新文件内容统一 CRLF 时保留 CRLF(修前压成 LF),LF 内容照旧;lineEnding 显式 lf/crlf/preserve;
//                   已存在文件的原换行风格照旧保持;W3 `~/x.txt` 展开成家目录(修前在工作区里建出名叫「~」的文件夹)。
//  (G) glob / file_list  G1 `./src/*.js` 与落在 root 内的绝对 pattern 配得上、root 外的绝对 pattern 给 patternNote;
//                   G2 深层目录被 maxDepth 截掉时报 depthLimited:true + hint(修前静默回空)。
//  (E) 裸异常 → 信封  E1 file_move / file_copy 目标是目录;E2 archive_zip dest 是目录;E3 archive_unzip src 是目录 / destDir 是文件;
//                   E4 file_write 父级是文件;E5 路径含 NUL;E6 audio_transcribe 路径是目录;E7 file_edit oldText:"" / glob pattern:"" 。
//  (M) file_move / file_copy  M1 工作区外路径的围栏先于 stat(存在 / 不存在给同一个答案,不泄露存在性);
//                   M2 move 到自己身上不记检查点;M3 同一文件判定(win32 大小写改名)的纯逻辑 —— Windows 未实机验证。
//  (Z) archive_zip / archive_unzip  Z1 同名输入保留相对结构(修前两个 n.txt 互相覆盖);Z2 重复输入去重并报告;
//                   Z3 dest 落在被打包的目录里时不把自己装进去;Z4 符号链接如实报 skippedLinks;Z5 原子写不留临时文件;
//                   Z6 包内路径冲突(f 与 f/g.txt)整包拒绝、一个文件不写;Z7 盘上冲突时报 partial 而不是抛 EEXIST。
//  (X) 其它小项     X1 maxFiles:0 / -1 按默认;X2 file_edit oldText==newText 不写盘不记检查点(unchanged:true);
//                   X3 50MB 提示不再点名不存在的 read_file;not_utf8 文案不再只提 UTF-8。
//
// RUYI_TEST_SERVER_JS 仅用于「改前 / 改后」对照跑(指向另一份构建产物);缺省就是本仓产物。
// 判定行:`TOOL AUDIT R2 FILES E2E: ALL PASS`。
(async () => {
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const { functionBlock } = require('./lib/source-slice');
const t = createRunner('TOOL AUDIT R2 FILES');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.RUYI_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2files-'));
process.env.RUYI_HOME = HOME; process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2files-ws-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2files-out-'));
const sw = p => p.replace(/\\/g, '/');
const rd = (p, enc) => fs.readFileSync(path.join(WS, p), enc);

const config = {
  configSchema: 7, permissionMode: 'default', engineMode: 'interactive', defaultWorkspace: WS, recentWorkspaces: [WS],
  workspaces: [{ path: WS, read: true, write: true, execute: true }],
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false,
  // 远端服务商:工作区围栏对它最严(本机模型才放行区外读)。
  providers: [{ id: 'p1', label: 'P1', type: 'openai-compat', baseUrl: 'https://api.example.invalid/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }],
  activeProvider: 'p1',
};
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2));
const srv = require(process.env.RUYI_TEST_SERVER_JS || path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
const cfg = await srv.readConfig();
const session = await srv.createSession({ title: 'r2 files', cwd: WS });
session.turnSeq = 1;
const call = async (name, args, extra = {}) => {
  const ctx = { sessionId: session.id, turnSeq: session.turnSeq, session, config: cfg, workingDir: WS, ...(extra.ctx || {}) };
  try { return await srv.toolCall(name, args, ctx); } catch (e) { return { threw: String((e && e.message) || e) }; }
};
const journalIndex = () => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'checkpoints', session.id, 'index.json'), 'utf8')); } catch { return []; }
};

// 手搓一个 stored 的 zip(用于造「包内路径冲突」这种 archive_zip 自己打不出来的包)。
const crcTable = (() => { const tb = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tb.push(c >>> 0); } return tb; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(items) {
  const local = [], central = [];
  let off = 0;
  for (const it of items) {
    const name = Buffer.from(it.name, 'utf8'), data = Buffer.from(it.data || '', 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(it.name.endsWith('/') ? 0x10 : 0, 38); cd.writeUInt32LE(off, 42);
    central.push(Buffer.concat([cd, name]));
    off += lh.length + name.length + data.length;
  }
  const lb = Buffer.concat(local), cb = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(items.length, 8); eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cb.length, 12); eocd.writeUInt32LE(lb.length, 16);
  return Buffer.concat([lb, cb, eocd]);
}

fs.writeFileSync(path.join(WS, 'a.txt'), 'line1\nline2 hello\nline3\n');
fs.mkdirSync(path.join(WS, 'src', 'deep'), { recursive: true });
fs.writeFileSync(path.join(WS, 'src', 'app.js'), 'x');
fs.writeFileSync(path.join(WS, 'src', 'deep', 'util.py'), 'x');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'OUTSIDE SECRET');

try {
  /* ═════════ (S) file_search 与非 UTF-8 ═════════ */
  fs.mkdirSync(path.join(WS, 'gbkdir'));
  // 「你好」「世界」的 GBK 字节;另一行纯 ASCII。
  fs.writeFileSync(path.join(WS, 'gbkdir', 'g.txt'), Buffer.concat([Buffer.from('c4e3bac3', 'hex'), Buffer.from(' hello '), Buffer.from('cac0bde7', 'hex'), Buffer.from('\r\nplain ascii\r\n')]));
  fs.writeFileSync(path.join(WS, 'gbkdir', 'u.txt'), '你好 utf8 file\n');
  // 默认引擎(装了 rg 就是 rg)与强制落 JS 引擎(环视模式 rg 不支持 → 退到 JS)各验一遍。
  for (const [label, pattern] of [['默认引擎', '你好'], ['JS 引擎', '(?<=^)你好']]) {
    const r = await call('file_search', { pattern, root: 'gbkdir' });
    const g = (r.matches || []).find(m => /g\.txt$/.test(m.path));
    ok(r.ok === true && !!g && g.text.includes('你好'), `S1 ${label}:GBK 文件里的中文搜得到、命中文本是解码后的(engine=${r.engine} got ${JSON.stringify(r.matches).slice(0, 200)})`);
    ok(Array.isArray(r.nonUtf8Files) && r.nonUtf8Files.some(f => /g\.txt$/.test(f.relativePath) && /gb/.test(f.encoding)), `S2 ${label}:如实报 nonUtf8Files(got ${JSON.stringify(r.nonUtf8Files)})`);
    ok((r.matches || []).some(m => /u\.txt$/.test(m.path)), `S1b ${label}:UTF-8 文件照常命中`);
  }
  const asciiHit = await call('file_search', { pattern: 'hello', root: 'gbkdir' });
  const ah = (asciiHit.matches || []).find(m => /g\.txt$/.test(m.path));
  ok(!!ah && ah.text.includes('世界') && !/\ufffd/.test(ah.text), `S1c ASCII 模式命中 GBK 文件里的行:同一行里的中文不再是乱码(got ${JSON.stringify(ah)})`);
  fs.writeFileSync(path.join(WS, 'm.txt'), 'foo 1\nfoo 2\n');
  const exact = await call('file_search', { pattern: 'foo', root: '.', glob: 'm.txt', maxResults: 2 });
  ok(exact.ok && exact.matches.length === 2 && exact.truncated !== true, `S3 命中数恰等于 maxResults 不报 truncated(engine=${exact.engine} got truncated=${exact.truncated})`);
  const over = await call('file_search', { pattern: 'foo', root: '.', glob: 'm.txt', maxResults: 1 });
  ok(over.ok && over.matches.length === 1 && over.truncated === true, `S3b 上限之后还有命中 → truncated:true(got ${over.truncated})`);
  const zeroMax = await call('file_search', { pattern: 'foo', root: '.', glob: 'm.txt', maxResults: 0 });
  ok(zeroMax.ok && zeroMax.matches.length === 2, `S3c maxResults:0 按默认(got ${(zeroMax.matches || []).length})`);

  /* ═════════ (R) file_read ═════════ */
  for (const [name, bytes] of [['x.docx', 'PK\x03\x04aaaa\0\0'], ['x.xlsx', 'PK\x03\x04bb\0'], ['x.jar', 'PK\x03\x04\0'], ['x.sqlite', 'SQLite format 3\0abc\0'], ['x.dat', 'abc\0def\n'], ['x.log', 'log\0line\n']]) {
    fs.writeFileSync(path.join(WS, name), Buffer.from(bytes, 'latin1'));
    const r = await call('file_read', { path: name });
    ok(r.ok === false && r.code === 'binary', `R1 ${name} 拒绝并报 binary(got ${JSON.stringify(r).slice(0, 140)})`);
  }
  const rdoc = await call('file_read', { path: 'x.docx' });
  ok(/read_document|archive_unzip/.test(String(rdoc.hint || '')), `R1b .docx 的 hint 指向该用的工具(got ${rdoc.hint})`);
  const rdb = await call('file_read', { path: 'x.sqlite' });
  ok(/script_run|sqlite/i.test(String(rdb.hint || '')), `R1c .sqlite 的 hint 指向查询办法(got ${rdb.hint})`);
  fs.writeFileSync(path.join(WS, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi 你好\nabc\n', 'utf16le')]));
  const r16 = await call('file_read', { path: 'u16.txt' });
  ok(r16.ok === true && r16.encoding === 'utf16le' && r16.content.includes('你好'), `R2 带 UTF-16 BOM 的文本照常可读(got ${JSON.stringify(r16).slice(0, 140)})`);
  const lim0 = await call('file_read', { path: 'a.txt', limit: 0 });
  ok(lim0.ok === true && lim0.content.length > 0 && !(lim0.truncated && lim0.nextOffset === 0), `R3 limit:0 不给「空内容 + nextOffset=0」的死循环(got ${JSON.stringify(lim0).slice(0, 160)})`);
  const lim1 = await call('file_read', { path: 'a.txt', lineLimit: 0 });
  ok(lim1.ok === true && lim1.returnedLines > 0 && !(lim1.truncated && lim1.nextLine === 1), `R3b lineLimit:0 同上(got ${JSON.stringify(lim1).slice(0, 160)})`);

  fs.writeFileSync(path.join(WS, 'emoji.txt'), '\u{1F600}\u{1F600}x');
  const lim2 = await call('file_read', { path: 'emoji.txt', limit: 1 });
  ok(lim2.ok === true && lim2.content.length > 0 && !(lim2.truncated && lim2.nextOffset === 0), `R3c limit:1 落在增补平面字符上不劈开代理对、也不回「空内容 + nextOffset=0」(got ${JSON.stringify(lim2).slice(0, 160)})`);

  /* ═════════ (W) file_write ═════════ */
  for (const enc of ['latin1', 'ascii', 'binary']) {
    const w = await call('file_write', { path: `enc-${enc}.txt`, content: '你好abc', encoding: enc });
    ok(w.ok === false && w.code === 'unencodable' && !fs.existsSync(path.join(WS, `enc-${enc}.txt`)), `W1 encoding:${enc} 写中文 → unencodable,文件不落盘(got ${JSON.stringify(w).slice(0, 140)})`);
  }
  const lat = await call('file_write', { path: 'lat.txt', content: 'caf\u00e9', encoding: 'latin1' });
  ok(lat.ok === true && rd('lat.txt').toString('hex') === '636166e9', `W1b latin1 能表示的字符照常写(got ${JSON.stringify(lat).slice(0, 100)})`);

  await call('file_write', { path: 'n-crlf.txt', content: 'a\r\nb\r\n' });
  ok(rd('n-crlf.txt', 'utf8') === 'a\r\nb\r\n', `W2 新建 .txt 内容统一 CRLF → 保留 CRLF(got ${JSON.stringify(rd('n-crlf.txt', 'utf8'))})`);
  await call('file_write', { path: 'n-lf.txt', content: 'a\nb\n' });
  ok(rd('n-lf.txt', 'utf8') === 'a\nb\n', 'W2b 新建 .txt 的 LF 内容照旧');
  await call('file_write', { path: 'n-mixed.txt', content: 'a\r\nb\nc\r\n' });
  ok(rd('n-mixed.txt', 'utf8') === 'a\nb\nc\n', `W2c 新建 .txt 内容混用换行 → 规范成 LF(got ${JSON.stringify(rd('n-mixed.txt', 'utf8'))})`);
  await call('file_write', { path: 'n.cmd', content: 'echo a\necho b\n' });
  ok(rd('n.cmd', 'utf8') === 'echo a\r\necho b\r\n', 'W2d 新建 .cmd 仍默认 CRLF');
  await call('file_write', { path: 'n-force.txt', content: 'a\nb\n', lineEnding: 'crlf' });
  ok(rd('n-force.txt', 'utf8') === 'a\r\nb\r\n', 'W2e lineEnding:"crlf" 强制 CRLF');
  await call('file_write', { path: 'n-force2.cmd', content: 'a\r\nb\r\n', lineEnding: 'lf' });
  ok(rd('n-force2.cmd', 'utf8') === 'a\nb\n', 'W2f lineEnding:"lf" 强制 LF(连 .cmd 也听显式的)');
  await call('file_write', { path: 'n-pres.txt', content: 'a\r\nb\nc\r\n', lineEnding: 'preserve' });
  ok(rd('n-pres.txt', 'utf8') === 'a\r\nb\nc\r\n', 'W2g lineEnding:"preserve" 原样写入');
  fs.writeFileSync(path.join(WS, 'old-lf.txt'), 'x\ny\n');
  await call('file_write', { path: 'old-lf.txt', content: 'p\r\nq\r\n' });
  ok(rd('old-lf.txt', 'utf8') === 'p\nq\n', `W2h 已存在的 LF 文件覆写:仍按原风格 LF(既有行为不变;got ${JSON.stringify(rd('old-lf.txt', 'utf8'))})`);
  fs.writeFileSync(path.join(WS, 'old-crlf.txt'), 'x\r\ny\r\n');
  await call('file_write', { path: 'old-crlf.txt', content: 'p\nq\n' });
  ok(rd('old-crlf.txt', 'utf8') === 'p\r\nq\r\n', 'W2i 已存在的 CRLF 文件覆写:仍按原风格 CRLF');

  // ~ 展开:把家目录指到工作区里的一个子目录,于是 ~/x.txt 应该落在 WS/fakehome/x.txt,而不是 WS/~/x.txt。
  const prevHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  fs.mkdirSync(path.join(WS, 'fakehome'));
  process.env.HOME = path.join(WS, 'fakehome'); process.env.USERPROFILE = path.join(WS, 'fakehome');
  const tw = await call('file_write', { path: '~/x.txt', content: 'hi' });
  ok(tw.ok === true && fs.existsSync(path.join(WS, 'fakehome', 'x.txt')) && !fs.existsSync(path.join(WS, '~')), `W3 ~/x.txt 展开成家目录,不再在工作区里建「~」文件夹(got ${JSON.stringify(tw).slice(0, 140)})`);
  const tw2 = await call('file_write', { path: '%USERPROFILE%' + path.sep + 'y.txt', content: 'hi' });
  ok(tw2.ok === true && fs.existsSync(path.join(WS, 'fakehome', 'y.txt')) && !fs.existsSync(path.join(WS, '%USERPROFILE%')), `W3b %USERPROFILE%/y.txt 同样展开(got ${JSON.stringify(tw2).slice(0, 140)})`);
  fs.writeFileSync(path.join(WS, '~keep.txt'), 'real file named ~keep');
  const keep = await call('file_read', { path: '~keep.txt' });
  ok(keep.ok === true && /real file/.test(keep.content), 'W3c `~keep.txt` 这种真实文件名不被当成家目录');
  process.env.HOME = OUTSIDE; process.env.USERPROFILE = OUTSIDE;     // 家目录在工作区外:展开后照常过围栏
  const tw3 = await call('file_write', { path: '~/z.txt', content: 'hi' });
  ok(tw3.ok === false && !fs.existsSync(path.join(OUTSIDE, 'z.txt')), `W3d 展开后落在工作区外 → 围栏照常拒(got ${JSON.stringify(tw3).slice(0, 140)})`);
  for (const [k, v] of Object.entries(prevHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const exp = new Function(functionBlock(fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '12-tool-dispatch.js'), 'utf8'), 'expandFileToolPathVars') + '; return expandFileToolPathVars;')();
  ok(exp('~', {}, 'H') === 'H' && exp('~/a', {}, 'H') === 'H/a' && exp('~\\a', {}, 'H') === 'H\\a' && exp('~a', {}, 'H') === '~a' && exp('~$x.docx', {}, 'H') === '~$x.docx', 'W3e 纯函数:~ / ~/ / ~\\ 展开,~a 与 ~$x 不展开');
  ok(exp('%USERPROFILE%\\a', { USERPROFILE: 'C:\\Users\\u' }, 'H') === 'C:\\Users\\u\\a' && exp('%HOMEPATH%\\a', { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u' }, 'H') === 'C:\\Users\\u\\a'
    && exp('%APPDATA%/x', { APPDATA: 'C:\\A' }, 'H') === 'C:\\A/x' && exp('%NOPE%\\a', {}, 'H') === '%NOPE%\\a' && exp('x/%USERPROFILE%', { USERPROFILE: 'Q' }, 'H') === 'x/%USERPROFILE%', 'W3f 纯函数:%USERPROFILE% / %HOMEPATH% / %APPDATA% 只在开头展开,未知变量原样');

  /* ═════════ (G) glob / file_list ═════════ */
  const g1 = await call('glob', { pattern: './src/*.js' });
  ok(g1.ok && (g1.files || []).map(f => sw(f.relativePath)).join() === 'src/app.js', `G1 glob「./src/*.js」配得上(got ${JSON.stringify(g1.files)})`);
  const g2 = await call('glob', { pattern: path.join(WS, 'src', '*.js') });
  ok(g2.ok && (g2.files || []).map(f => sw(f.relativePath)).join() === 'src/app.js' && !!g2.patternNote, `G1b root 内的绝对 pattern 改写成相对 root(got ${JSON.stringify(g2).slice(0, 200)})`);
  const g3 = await call('glob', { pattern: path.join(OUTSIDE, '*.txt') });
  ok(g3.ok && g3.files.length === 0 && /outside root/.test(String(g3.patternNote || '')), `G1c root 外的绝对 pattern → 空表 + patternNote(got ${JSON.stringify(g3).slice(0, 200)})`);
  const l1 = await call('file_list', { pattern: './src/*.js' });
  ok(l1.ok && (l1.files || []).map(f => sw(f.relativePath)).join() === 'src/app.js', `G1d file_list「./src/*.js」同样配得上(got ${JSON.stringify(l1.files)})`);
  const l2 = await call('file_list', { pattern: path.join(WS, 'src', '*.js') });
  ok(l2.ok && (l2.files || []).map(f => sw(f.relativePath)).join() === 'src/app.js', `G1e file_list 的绝对 glob(got ${JSON.stringify(l2.files)})`);
  let dd = WS;
  for (let i = 0; i < 15; i += 1) dd = path.join(dd, 'd' + i);
  fs.mkdirSync(dd, { recursive: true }); fs.writeFileSync(path.join(dd, 'deep.txt'), 'x');
  const gd = await call('glob', { pattern: '**/deep.txt' });
  ok(gd.ok && gd.files.length === 0 && gd.depthLimited === true && /maxDepth/.test(String(gd.depthHint || '')), `G2 glob 在默认 12 层处被截:depthLimited:true + hint(got ${JSON.stringify(gd).slice(0, 220)})`);
  const gd2 = await call('glob', { pattern: '**/deep.txt', maxDepth: 20 });
  ok(gd2.ok && gd2.files.length === 1 && gd2.depthLimited !== true, `G2b 放开 maxDepth 就找得到、不再报截断(got ${JSON.stringify(gd2).slice(0, 160)})`);
  const ld = await call('file_list', { maxDepth: 3 });
  ok(ld.ok && ld.depthLimited === true && Array.isArray(ld.depthCutDirs) && ld.depthCutDirs.length > 0, `G2c file_list 同样报 depthLimited(got ${JSON.stringify(ld).slice(0, 220)})`);
  fs.mkdirSync(path.join(WS, 'emptydeep', 'e1', 'e2'), { recursive: true });
  const ld2 = await call('file_list', { root: 'emptydeep', maxDepth: 1 });
  ok(ld2.ok && ld2.depthLimited !== true, `G2d 被截的目录里是空的 → 不报 depthLimited(没东西可漏;got ${JSON.stringify(ld2).slice(0, 200)})`);

  /* ═════════ (E) 裸异常 → 信封 ═════════ */
  fs.mkdirSync(path.join(WS, 'dd'));
  fs.writeFileSync(path.join(WS, 'f1.txt'), 'f1');
  for (const tool of ['file_move', 'file_copy']) {
    const r = await call(tool, { from: 'f1.txt', to: 'dd', overwrite: true });
    ok(r.ok === false && r.code === 'target_is_directory' && !r.threw, `E1 ${tool} 目标是目录 → 信封(got ${JSON.stringify(r).slice(0, 160)})`);
  }
  ok(fs.existsSync(path.join(WS, 'f1.txt')), 'E1b 失败后源文件还在');
  const ez = await call('archive_zip', { paths: ['src'], dest: path.join(WS, 'dd') });
  ok(ez.ok === false && ez.code === 'target_is_directory' && !ez.threw, `E2 archive_zip dest 是目录 → 信封(got ${JSON.stringify(ez).slice(0, 160)})`);
  const eu1 = await call('archive_unzip', { src: 'dd', destDir: path.join(WS, 'out-e') });
  ok(eu1.ok === false && eu1.code === 'is_directory', `E3 archive_unzip src 是目录 → is_directory(got ${JSON.stringify(eu1).slice(0, 160)})`);
  fs.writeFileSync(path.join(WS, 'ok.zip'), makeZip([{ name: 'k.txt', data: 'k' }]));
  const eu2 = await call('archive_unzip', { src: 'ok.zip', destDir: path.join(WS, 'a.txt') });
  ok(eu2.ok === false && eu2.code === 'not_a_directory', `E3b destDir 是已存在的文件 → not_a_directory(got ${JSON.stringify(eu2).slice(0, 160)})`);
  const ew = await call('file_write', { path: 'a.txt/x.txt', content: 'x' });
  ok(ew.ok === false && !ew.threw && /^(already_exists|not_a_directory)$/.test(String(ew.code)), `E4 file_write 父级是文件 → 信封(got ${JSON.stringify(ew).slice(0, 160)})`);
  for (const [tool, args] of [['file_read', { path: 'a\0b' }], ['file_write', { path: 'a\0b', content: 'x' }], ['file_delete', { path: 'a\0b' }], ['file_edit', { path: 'a\0b', oldText: 'a', newText: 'b' }]]) {
    const r = await call(tool, args);
    ok(r.ok === false && r.code === 'bad_path' && !r.threw, `E5 ${tool} 路径含 NUL → bad_path 信封(got ${JSON.stringify(r).slice(0, 160)})`);
  }
  fs.mkdirSync(path.join(WS, 'dir.wav'));
  const ea = await call('audio_transcribe', { path: 'dir.wav' });
  ok(ea.ok === false && ea.code === 'is_directory' && !ea.threw, `E6 audio_transcribe 路径是目录 → 信封(got ${JSON.stringify(ea).slice(0, 160)})`);
  const ee = await call('file_edit', { path: 'a.txt', oldText: '', newText: 'x' });
  ok(ee.ok === false && !ee.threw, `E7 file_edit oldText:"" → 信封,不抛(got ${JSON.stringify(ee).slice(0, 160)})`);
  const eg = await call('glob', { pattern: '' });
  ok(eg.ok === false && !eg.threw, `E7b glob pattern:"" → 信封,不抛(got ${JSON.stringify(eg).slice(0, 160)})`);
  const egd = await call('glob', { pattern: './' });
  ok(egd.ok === false && !egd.threw, `E7c glob pattern:"./" → 信封,不抛(got ${JSON.stringify(egd).slice(0, 160)})`);

  /* ═════════ (M) file_move / file_copy ═════════ */
  const mvExist = await call('file_move', { from: path.join(OUTSIDE, 'secret.txt'), to: 'stolen.txt' });
  const mvMissing = await call('file_move', { from: path.join(OUTSIDE, 'no-such-file.txt'), to: 'stolen.txt' });
  ok(mvExist.ok === false && mvMissing.ok === false && mvExist.code === mvMissing.code && mvExist.code !== 'not_found', `M1 工作区外的源路径:存在与不存在给同一个围栏答案,不泄露存在性(got ${mvExist.code} / ${mvMissing.code})`);
  ok(fs.existsSync(path.join(OUTSIDE, 'secret.txt')) && !fs.existsSync(path.join(WS, 'stolen.txt')), 'M1b 区外文件没被移走');
  const cpExist = await call('file_copy', { from: path.join(OUTSIDE, 'secret.txt'), to: 'stolen.txt' });
  const cpMissing = await call('file_copy', { from: path.join(OUTSIDE, 'no-such-file.txt'), to: 'stolen.txt' });
  ok(cpExist.ok === false && cpMissing.ok === false && cpExist.code === cpMissing.code && cpExist.code !== 'not_found', `M1c file_copy 同理(got ${cpExist.code} / ${cpMissing.code})`);
  fs.writeFileSync(path.join(WS, 'self.txt'), 'same');
  const before = journalIndex().length;
  const self = await call('file_move', { from: 'self.txt', to: 'self.txt', overwrite: true });
  ok(self.ok === true && self.unchanged === true && journalIndex().length === before && rd('self.txt', 'utf8') === 'same', `M2 file_move 到自己身上:不动、不记检查点(got ${JSON.stringify(self).slice(0, 140)} journal ${before}→${journalIndex().length})`);
  const mv = await call('file_move', { from: 'self.txt', to: 'moved.txt' });
  ok(mv.ok === true && rd('moved.txt', 'utf8') === 'same' && !fs.existsSync(path.join(WS, 'self.txt')), 'M2b 普通移动照常');
  // 同一文件判定(纯逻辑;win32 大小写改名的依据)。Windows 未实机验证。
  const sameKind = new Function(functionBlock(fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '12-tool-dispatch.js'), 'utf8'), 'fileMoveSameFileKind') + '; return fileMoveSameFileKind;')();
  const st1 = { dev: 1, ino: 77 }, st2 = { dev: 1, ino: 78 };
  ok(sameKind('C:\\w\\data.csv', 'C:\\w\\DATA.csv', st1, st1, 'win32') === 'case-only', 'M3 win32:同 dev+ino 仅大小写不同 → case-only(允许改名)');
  ok(sameKind('/w/data.csv', '/w/DATA.csv', st1, st1, 'darwin') === 'case-only', 'M3b darwin 同理');
  ok(sameKind('/w/data.csv', '/w/DATA.csv', st1, st1, 'linux') === null, 'M3c linux:大小写敏感,同 ino 只可能是硬链接,不当改名');
  ok(sameKind('C:\\w\\data.csv', 'C:\\w\\DATA.csv', st1, st2, 'win32') === null, 'M3d win32:ino 不同 = 两个文件 → 照常「目标已存在」');
  ok(sameKind('C:\\w\\a.csv', 'C:\\w\\a.csv', st1, st1, 'win32') === 'identical' && sameKind('a', 'b', st1, null, 'win32') === null, 'M3e 逐字相同 → identical;目标不存在 → null');

  /* ═════════ (Z) archive_zip / archive_unzip ═════════ */
  fs.mkdirSync(path.join(WS, 'd1')); fs.mkdirSync(path.join(WS, 'd2'));
  fs.writeFileSync(path.join(WS, 'd1', 'n.txt'), 'one'); fs.writeFileSync(path.join(WS, 'd2', 'n.txt'), 'two');
  const z1 = await call('archive_zip', { paths: [path.join(WS, 'd1', 'n.txt'), path.join(WS, 'd2', 'n.txt')], dest: path.join(WS, 'c.zip') });
  const z1l = await call('archive_unzip', { src: 'c.zip', list: true });
  const names1 = (z1l.entries || []).map(e => e.name).sort();
  ok(z1.ok && names1.length === 2 && new Set(names1).size === 2 && names1.join().includes('d1') && names1.join().includes('d2'), `Z1 同名输入保留相对结构,包内两个名字不同(got ${JSON.stringify(names1)})`);
  ok(Array.isArray(z1.renamedInputs) && z1.renamedInputs.length === 2, `Z1b 改了名的输入如实报告(got ${JSON.stringify(z1.renamedInputs)})`);
  const z1x = await call('archive_unzip', { src: 'c.zip', destDir: path.join(WS, 'c-out') });
  ok(z1x.ok && z1x.files === 2 && rd(path.join('c-out', 'd1', 'n.txt'), 'utf8') === 'one' && rd(path.join('c-out', 'd2', 'n.txt'), 'utf8') === 'two', `Z1c 解压后两份内容都在、互不覆盖(got ${JSON.stringify(z1x).slice(0, 140)})`);
  const z2 = await call('archive_zip', { paths: [path.join(WS, 'a.txt'), path.join(WS, 'a.txt')], dest: path.join(WS, 'c2.zip') });
  const z2l = await call('archive_unzip', { src: 'c2.zip', list: true });
  ok(z2.ok && (z2l.entries || []).length === 1 && z2.dedupedInputs && z2.dedupedInputs.length === 1, `Z2 重复输入只打一份并报告(got ${JSON.stringify(z2l.entries)} ${JSON.stringify(z2.dedupedInputs)})`);
  const z3a = await call('archive_zip', { paths: [path.join(WS, 'd1')], dest: path.join(WS, 'd1', 'x.zip') });
  const z3b = await call('archive_zip', { paths: [path.join(WS, 'd1')], dest: path.join(WS, 'd1', 'x.zip') });
  const z3l = await call('archive_unzip', { src: 'd1/x.zip', list: true });
  ok(z3a.ok && z3b.ok && !(z3l.entries || []).some(e => /x\.zip/.test(e.name)) && z3b.skippedDest === true, `Z3 dest 在被打包的目录里时不把自己装进去(got ${JSON.stringify((z3l.entries || []).map(e => e.name))})`);
  let linked = false;
  fs.mkdirSync(path.join(WS, 'lk'));
  fs.writeFileSync(path.join(WS, 'lk', 'real.txt'), 'r');
  try { fs.symlinkSync(path.join(WS, 'lk', 'real.txt'), path.join(WS, 'lk', 'link.txt')); linked = true; } catch { /* Windows 无权限建链接时跳过 */ }
  if (linked) {
    const z4 = await call('archive_zip', { paths: [path.join(WS, 'lk')], dest: path.join(WS, 'lk.zip') });
    ok(z4.ok && z4.skippedLinks === 1, `Z4 符号链接不入包但如实报 skippedLinks(got ${JSON.stringify(z4).slice(0, 200)})`);
  } else console.log('SKIP Z4 无法建符号链接');
  ok(!fs.readdirSync(WS).some(n => /\.tmp$/.test(n)) && !fs.readdirSync(path.join(WS, 'd1')).some(n => /\.tmp$/.test(n)), 'Z5 原子写不留临时文件');
  const z5 = await call('archive_zip', { paths: [path.join(WS, 'a.txt')], dest: path.join(WS, 'c2.zip') });
  ok(z5.ok && z5.op === 'modify', `Z5b 覆盖已有 zip 仍走 modify 检查点(got ${z5.op})`);

  // 包内路径冲突:`f` 是文件,`f/g.txt` 又要它当目录。
  fs.writeFileSync(path.join(WS, 'bad.zip'), makeZip([{ name: 'ok.txt', data: 'ok' }, { name: 'f', data: 'file' }, { name: 'f/g.txt', data: 'g' }]));
  const zc = await call('archive_unzip', { src: 'bad.zip', destDir: path.join(WS, 'bad-out') });
  ok(zc.ok === false && zc.code === 'entry_conflict' && !zc.threw && !fs.existsSync(path.join(WS, 'bad-out', 'ok.txt')), `Z6 包内路径冲突整包拒绝,一个文件都不写(got ${JSON.stringify(zc).slice(0, 200)})`);
  // 盘上冲突:destDir 里已有一个叫 d 的【文件】,包里要写 d/x.txt。
  fs.mkdirSync(path.join(WS, 'disk-out')); fs.writeFileSync(path.join(WS, 'disk-out', 'd'), 'i am a file');
  fs.writeFileSync(path.join(WS, 'disk.zip'), makeZip([{ name: 'a1.txt', data: 'a1' }, { name: 'd/x.txt', data: 'x' }]));
  const zd = await call('archive_unzip', { src: 'disk.zip', destDir: path.join(WS, 'disk-out') });
  ok(zd.ok === false && !zd.threw && zd.partial === true && zd.filesExtracted === 1 && /^(already_exists|not_a_directory)$/.test(String(zd.code)), `Z7 盘上冲突:报 partial + filesExtracted,不抛裸 EEXIST(got ${JSON.stringify(zd).slice(0, 240)})`);
  ok(rd(path.join('disk-out', 'a1.txt'), 'utf8') === 'a1', 'Z7b 已写成的文件如实在盘上(与 filesExtracted 一致)');

  /* ═════════ (X) 其它小项 ═════════ */
  const ml = await call('file_list', { recursive: false, maxFiles: 0 });
  ok(ml.ok && ml.files.length > 1, `X1 maxFiles:0 按默认,不再只回 1 条(got ${(ml.files || []).length} 条)`);
  const ml2 = await call('file_list', { recursive: false, maxFiles: -5 });
  ok(ml2.ok && ml2.files.length > 1, `X1b maxFiles:-5 同上(got ${(ml2.files || []).length} 条)`);
  fs.writeFileSync(path.join(WS, 'same.txt'), 'foo\nbar\n');
  const jBefore = journalIndex().length;
  const mt0 = fs.statSync(path.join(WS, 'same.txt')).mtimeMs;
  await new Promise(r => setTimeout(r, 30));
  const same = await call('file_edit', { path: 'same.txt', oldText: 'foo', newText: 'foo' });
  ok(same.ok === true && same.unchanged === true && journalIndex().length === jBefore && fs.statSync(path.join(WS, 'same.txt')).mtimeMs === mt0, `X2 oldText==newText:不写盘、不记检查点(got ${JSON.stringify(same).slice(0, 160)})`);
  const real = await call('file_edit', { path: 'same.txt', oldText: 'foo', newText: 'baz' });
  ok(real.ok === true && real.replacements === 1 && rd('same.txt', 'utf8') === 'baz\nbar\n', 'X2b 真改动照常');
  const src12 = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '12-tool-dispatch.js'), 'utf8');
  ok(!/请改用 read_file/.test(src12) && !/file_edit 只编辑 UTF-8 文件/.test(src12), 'X3 文案:不再点名不存在的 read_file,not_utf8 不再只说 UTF-8');
  fs.writeFileSync(path.join(WS, 'bin-ish.txt'), Buffer.from([0x81, 0x20, 0xfe, 0xfe, 0x80, 0x81, 0xff]));
  const nu = await call('file_edit', { path: 'bin-ish.txt', oldText: 'x', newText: 'y' });
  ok(nu.ok === false && nu.code === 'not_utf8' && /GBK|UTF-16/.test(String(nu.error)), `X3b not_utf8 文案提到 GBK / UTF-16(got ${JSON.stringify(nu).slice(0, 200)})`);
} catch (e) {
  t.fail('fatal: ' + ((e && e.stack) || e));
}
t.done({ exit: true });
})();
