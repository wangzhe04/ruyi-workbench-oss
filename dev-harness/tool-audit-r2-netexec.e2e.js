require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(2026-10 工具走查第二轮·网络 / 命令 / 桌面组):钉住 net-exec 组的一批确认过的缺陷。每条都是【修前真调复现过】,
// 断言写的是修后该有的行为(修前在这里会红)。
//
//  (N1) web_fetch / http_download / http_request 认 Content-Encoding(gzip / deflate 裸与 zlib 封装 / br / 多层):
//       修前 web_fetch 把压缩字节当文本(乱码)、http_download 把压缩字节原样存盘;上限数的是【解压后】字节(压缩炸弹被掐在上限处)。
//  (N1b) http_request 按 Content-Type 的字符集解码(GBK 不再 U+FFFD)、二进制响应标 binary:true 且不内联正文。
//  (N2) 抓取成功过的页面后来回 404 → ok:false(修前 ok:true + fromCache:true 把已删页面当成功);真断网时仍回落缓存。
//  (N3) http_download:dest 是文件夹(已存在 / 以分隔符结尾)→ 存进去并取响应头 / URL 的文件名(修前裸 EISDIR / 悄悄写成同名文件);
//       fs 失败翻成 {ok:false, code, error}(修前裸异常 ENAMETOOLONG);timeoutMs 同时是总期限(修前只是空闲超时,滴灌能拖很久);
//       ctx.signal 能取消下载 / 请求(修前根本没接)。
//  (N4) http_request:timeoutMs 为负数不再报 Node 的 out of range(还被归成 timeout);3xx 带 location。
//  (N5) shell_start 的上限是【每个会话】的(修前全进程共用,B 会话被 A 的 shell 挤满却看不见、杀不掉);全局另有安全上限;
//       超长命令(-EncodedCommand 超命令行上限)→ command_too_long + 指路 script_run;没有 PowerShell → 明确失败(修前 ok:true 的死会话)。
//  (N6) keyboard_send_keys:空 keys → {ok:false}(修前抛异常);literal:true 转义 SendKeys 控制符;delayMs 限 0..10000。
//  (N7) 没有 PowerShell(非 Windows)的几个工具:desktop_screenshot / keyboard_send_keys / script_run / powershell_run
//       回 {ok:false, code:'windows_only', hint}(修前裸 `spawn powershell.exe ENOENT`);desktop_screenshot 只在文件真生成时给 path。
//  (N8) desktop_screenshot 的脚本先设 DPI 感知(SetProcessDPIAware)再碰 System.Windows.Forms —— 【Windows 真机未验证】,
//       这里对生成的脚本文本做断言(运行时值:fake powershell 记录下来的脚本 + 对生成函数的静态切片)。
//  (N9) 空 / 非法参数给 {ok:false} 信封而不是抛异常或「打开服务进程的当前目录」。
//
// Linux 上用一个假 powershell.exe(node 脚本)记录收到的 -File 脚本 / 撑住交互 shell;Windows 上 PATH 假件不适用,
// 相关块 `process.platform !== 'win32'` 才跑(Windows CI 不会跑到它们,改这些断言要留意)。
// 判定行:`TOOL AUDIT R2 NETEXEC E2E: ALL PASS`。
(async () => {
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), zlib = require('zlib');
const { createRunner } = require('./lib/harness');
const { functionBlock } = require('./lib/source-slice');
const t = createRunner('TOOL AUDIT R2 NETEXEC');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const HOME = process.env.RUYI_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2net-'));
process.env.RUYI_HOME = HOME; process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2net-ws-'));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2net-bin-'));
const REC = path.join(BIN, 'ps-record.jsonl');
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
process.env.NO_PROXY = '127.0.0.1'; process.env.no_proxy = '127.0.0.1';

const config = {
  configSchema: 7, permissionMode: 'bypass', engineMode: 'interactive', defaultWorkspace: WS, recentWorkspaces: [WS],
  workspaces: [{ path: WS, read: true, write: true, execute: true }],
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false, providers: [], shellSessionMax: 3,
};
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2));
const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
const cfg = await srv.readConfig();
const mkSession = async title => { const s = await srv.createSession({ title, cwd: WS }); s.turnSeq = 1; return s; };
const sessA = await mkSession('r2 A');
const call = async (name, args, extra = {}) => {
  const sess = extra.session || sessA;
  const ctx = { sessionId: sess.id, turnSeq: sess.turnSeq, session: sess, config: cfg, workingDir: WS, signal: extra.signal };
  try { return await srv.toolCall(name, args, ctx); } catch (e) { return { threw: String((e && e.message) || e) }; }
};

// ── 夹具服务器 ──────────────────────────────────────────────────────────────────────────────────────────────────
const BOMB = zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024, 65));      // ~200KB 压缩 → 200MB 解压
let pageMode = 'ok';
const fixture = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/gz') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync('hello gzip body ' + 'g'.repeat(300))); }
  if (p === '/br') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' }); return res.end(zlib.brotliCompressSync('hello brotli body ' + 'b'.repeat(300))); }
  if (p === '/deflate') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' }); return res.end(zlib.deflateSync('hello zlib deflate body')); }
  if (p === '/rawdeflate') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' }); return res.end(zlib.deflateRawSync('hello raw deflate body')); }
  if (p === '/badgz') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end('this is not gzip'); }
  if (p === '/bomb') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(BOMB); }
  if (p === '/gbkjson') { res.writeHead(200, { 'content-type': 'application/json; charset=gbk' }); return res.end(Buffer.from('7b226d223a22c4e3bac3227d', 'hex')); } // {"m":"你好"}
  if (p === '/bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from([0, 1, 2, 255, 254, 253, 0x80])); }
  if (p === '/jsonasbin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end('{"hello":"world"}'); }
  if (p === '/redir') { res.writeHead(302, { location: '/target' }); return res.end(); }
  if (p === '/page') {
    if (pageMode === 'ok') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><body><p>' + 'cache me please '.repeat(40) + '</p></body></html>'); }
    res.writeHead(pageMode === 'gone' ? 404 : 410); return res.end('gone');
  }
  if (p === '/file.bin') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report 2024.bin"' }); return res.end(Buffer.from('BINDATA')); }
  if (p === '/path/named.dat') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from('NAMED')); }
  if (p === '/evil') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="..\\..\\escape.txt"' }); return res.end(Buffer.from('EVIL')); }
  if (p === '/drip') { // 每 300ms 滴一个字节,持续 ~9 秒:空闲超时永远不触发,只有总期限 / 中断能停它
    res.writeHead(200, { 'content-type': 'text/plain' });
    let i = 0; const tm = setInterval(() => { res.write('x'); if (++i > 30) { clearInterval(tm); res.end(); } }, 300);
    res.on('close', () => clearInterval(tm)); return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('default ' + p);
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const B = `http://127.0.0.1:${fixture.address().port}`;

// ── 假 powershell.exe(仅非 Windows):记录 -File 脚本;交互模式撑住直到 stdin 关闭 ────────────────────────────────────────
function installFakePowerShell() {
  const f = path.join(BIN, 'powershell.exe');
  fs.writeFileSync(f, `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
const fi = a.indexOf('-File');
if (fi >= 0) {
  const script = fs.readFileSync(a[fi + 1], 'utf8').replace(/^\\uFEFF/, '');
  fs.appendFileSync(${JSON.stringify(REC)}, JSON.stringify({ script }) + '\\n');
  if (process.env.FAKE_PS_PNG === '1') { const m = /Save\\('([^']+\\.png)'/.exec(script); if (m) fs.writeFileSync(m[1], Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); }
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`);
  fs.chmodSync(f, 0o755);
  process.env.PATH = BIN + path.delimiter + process.env.PATH;
}
const records = () => (fs.existsSync(REC) ? fs.readFileSync(REC, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).script) : []);

const openShells = [];
try {
  /* ═════════ (N7 前半) 没有 PowerShell 的环境(Linux 且假件还没装进 PATH)═════════ */
  if (!IS_WIN) {
    const shot0 = await call('desktop_screenshot', {});
    ok(shot0.ok === false && shot0.code === 'windows_only' && !('path' in shot0) && !/spawn powershell/.test(JSON.stringify(shot0)),
      `N7a 无 PowerShell:desktop_screenshot → windows_only、不返回没生成的 path、不甩裸 spawn ENOENT(got ${JSON.stringify(shot0).slice(0, 220)})`);
    const key0 = await call('keyboard_send_keys', { keys: 'abc' });
    ok(key0.ok === false && key0.code === 'windows_only', `N7b keyboard_send_keys 无 PowerShell → windows_only(got ${JSON.stringify(key0).slice(0, 160)})`);
    const sc0 = await call('script_run', { code: 'echo hi' });
    ok(sc0.ok === false && sc0.code === 'windows_only' && /python|node/.test(String(sc0.hint || '')), `N7c script_run 缺省 powershell 无 PowerShell → windows_only 且指路 python/node(got ${JSON.stringify(sc0).slice(0, 200)})`);
    const ps0 = await call('powershell_run', { command: 'echo hi' });
    ok(ps0.ok === false && ps0.code === 'windows_only', `N7d powershell_run 无 PowerShell → windows_only(got ${JSON.stringify(ps0).slice(0, 160)})`);
    const sh0 = await call('shell_start', { shellId: 'dead1' });
    ok(sh0.ok === false && sh0.code === 'windows_only', `N5d shell_start 无 PowerShell → ok:false(修前 ok:true 的死会话;got ${JSON.stringify(sh0).slice(0, 160)})`);
    const list0 = await call('shell_list', {});
    ok(list0.ok === true && list0.shells.length === 0, `N5e 起不来的 shell 不留空壳会话(got ${JSON.stringify(list0.shells)})`);
    installFakePowerShell();
  }

  /* ═════════ (N1) 内容编码 ═════════ */
  const wgz = await call('web_fetch', { url: B + '/gz' });
  ok(wgz.ok === true && /hello gzip body/.test(String(wgz.text || '')), `N1a web_fetch 解开 gzip(got ${JSON.stringify(wgz).slice(0, 160)})`);
  for (const [p, needle, label] of [['/br', 'hello brotli body', 'br'], ['/deflate', 'hello zlib deflate body', 'deflate(zlib 封装)'], ['/rawdeflate', 'hello raw deflate body', 'deflate(裸)']]) {
    const r = await call('web_fetch', { url: B + p });
    ok(r.ok === true && String(r.text || '').includes(needle), `N1b web_fetch 解开 ${label}(got ${JSON.stringify(r).slice(0, 120)})`);
  }
  const hgz = await call('http_request', { url: B + '/gz' });
  ok(hgz.ok === true && /hello gzip body/.test(String(hgz.body || '')) && hgz.decodedFrom === 'gzip', `N1c http_request 解开 gzip 并标 decodedFrom(got ${JSON.stringify(hgz).slice(0, 200)})`);
  const bad = await call('web_fetch', { url: B + '/badgz' });
  ok(bad.ok === false && /解压失败/.test(String(bad.error || '')), `N1d 损坏的压缩体 → 如实报解压失败,不崩(got ${JSON.stringify(bad).slice(0, 160)})`);
  const dlz = path.join(WS, 'gz.txt');
  const dgz = await call('http_download', { url: B + '/gz', dest: dlz });
  ok(dgz.ok === true && fs.existsSync(dlz) && /^hello gzip body/.test(fs.readFileSync(dlz, 'utf8')), `N1e http_download 存的是解压后的内容(修前存的是 1f 8b 开头的压缩字节;got ${JSON.stringify(dgz).slice(0, 120)})`);
  const t0 = Date.now();
  const wb = await call('web_fetch', { url: B + '/bomb' });
  ok(wb.ok === true && String(wb.text || '').length > 1000 && wb.truncated === true, `N1f 压缩炸弹(200MB 解压)在上限处被掐断、交回截断页(got ok=${wb.ok} len=${String(wb.text || '').length} ${Date.now() - t0}ms)`);
  const hb = await call('http_request', { url: B + '/bomb', maxBodyChars: 1000 });
  ok(hb.ok === true && hb.truncated === true && String(hb.body || '').length <= 1000, `N1g http_request 对压缩炸弹同样有解压后字节上限(got len=${String(hb.body || '').length} truncated=${hb.truncated})`);
  const db = await call('http_download', { url: B + '/bomb', dest: path.join(WS, 'bomb.bin'), maxBytes: 1024 * 1024 });
  ok(db.ok === false && /上限/.test(String(db.error || '')) && !fs.existsSync(path.join(WS, 'bomb.bin')), `N1h http_download 的 maxBytes 也按解压后算,不落半截文件(got ${JSON.stringify(db).slice(0, 140)})`);

  /* ═════════ (N1b / N4) http_request 的解码、二进制、重定向、超时 ═════════ */
  const gj = await call('http_request', { url: B + '/gbkjson' });
  ok(gj.ok === true && String(gj.body).includes('你好') && !/�/.test(String(gj.body)), `N1i http_request 按 Content-Type 的 charset 解 GBK(got ${JSON.stringify(gj.body)})`);
  const bn = await call('http_request', { url: B + '/bin' });
  ok(bn.ok === true && bn.binary === true && bn.body === '' && bn.bytes === 7 && /http_download/.test(String(bn.note || '')), `N1j 二进制响应 → binary:true、不内联正文、指路 http_download(got ${JSON.stringify(bn).slice(0, 200)})`);
  const jb = await call('http_request', { url: B + '/jsonasbin' });
  ok(jb.ok === true && !jb.binary && /hello/.test(String(jb.body || '')), `N1k 声明成 octet-stream 但内容是合法文本的,照常当文本(got ${JSON.stringify(jb).slice(0, 160)})`);
  const rd = await call('http_request', { url: B + '/redir' });
  ok(rd.redirected === true && rd.statusCode === 302 && rd.location === B + '/target', `N4a 3xx 带 location(绝对地址;got ${rd.location})`);
  const neg = await call('http_request', { url: B + '/gz', timeoutMs: -5 });
  ok(neg.ok === true && !/out of range/.test(JSON.stringify(neg)), `N4b timeoutMs 为负数回落默认,不再报 Node 的 out of range(got ${JSON.stringify(neg).slice(0, 160)})`);

  /* ═════════ (N2) 404 / 410 不再回落缓存;断网仍回落 ═════════ */
  const first = await call('web_fetch', { url: B + '/page' });
  ok(first.ok === true && /cache me/.test(first.text) && first.fromCache === false, 'N2a 先抓一次成功并写入缓存');
  pageMode = 'gone';
  const gone = await call('web_fetch', { url: B + '/page' });
  ok(gone.ok === false && gone.statusCode === 404 && !gone.fromCache, `N2b 之后页面 404 → ok:false(修前 ok:true + fromCache:true;got ${JSON.stringify(gone).slice(0, 200)})`);
  pageMode = 'gone410';
  const gone410 = await call('web_fetch', { url: B + '/page' });
  ok(gone410.ok === false && gone410.statusCode === 410 && !gone410.fromCache, `N2c 410 同样不回落缓存(got ${JSON.stringify(gone410).slice(0, 160)})`);
  {
    const tmp = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><p>' + 'offline copy '.repeat(40) + '</p></body></html>'); });
    await new Promise(r => tmp.listen(0, '127.0.0.1', r));
    const U = `http://127.0.0.1:${tmp.address().port}/o`;
    const a = await call('web_fetch', { url: U });
    await new Promise(r => tmp.close(r));
    const b = await call('web_fetch', { url: U });
    ok(a.ok === true && b.ok === true && b.fromCache === true && /offline copy/.test(b.text), `N2d 真断网(连不上)时仍回落缓存(got ${JSON.stringify(b).slice(0, 160)})`);
  }

  /* ═════════ (N3) http_download ═════════ */
  const dir1 = path.join(WS, 'dl'); fs.mkdirSync(dir1);
  const into = await call('http_download', { url: B + '/file.bin', dest: dir1 });
  ok(into.ok === true && into.path === path.join(dir1, 'report 2024.bin') && fs.readFileSync(into.path, 'utf8') === 'BINDATA', `N3a dest 是已存在的文件夹 → 存进去,名字取 Content-Disposition(修前抛裸 EISDIR;got ${JSON.stringify(into).slice(0, 200)})`);
  const slash = await call('http_download', { url: B + '/path/named.dat', dest: path.join(WS, 'newdir') + path.sep });
  ok(slash.ok === true && slash.path === path.join(WS, 'newdir', 'named.dat') && fs.statSync(path.join(WS, 'newdir')).isDirectory(), `N3b dest 以分隔符结尾 = 文件夹,名字取 URL 末段(修前悄悄写成叫 newdir 的文件;got ${JSON.stringify(slash).slice(0, 200)})`);
  const evil = await call('http_download', { url: B + '/evil', dest: dir1 + path.sep });
  ok(evil.ok === true && path.dirname(evil.path) === dir1 && !fs.existsSync(path.join(WS, 'escape.txt')), `N3c 服务器给的文件名里的 ..\\ 不能让文件跳出 dest 文件夹(got ${JSON.stringify(evil).slice(0, 200)})`);
  const long = await call('http_download', { url: B + '/gz', dest: path.join(WS, 'a'.repeat(300)) });
  ok(long.ok === false && typeof long.error === 'string' && !long.threw && (IS_WIN || long.code === 'ENAMETOOLONG'), `N3d 名字过长 → {ok:false, code, error} 信封,不抛(修前裸异常 ENAMETOOLONG;got ${JSON.stringify(long).slice(0, 160)})`);
  const fileAsDir = await call('http_download', { url: B + '/gz', dest: dlz + path.sep });
  ok(fileAsDir.ok === false && !fileAsDir.threw, `N3e dest 以分隔符结尾却是已存在的文件 → ok:false(got ${JSON.stringify(fileAsDir).slice(0, 140)})`);
  const t1 = Date.now();
  const slow = await call('http_download', { url: B + '/drip', dest: path.join(WS, 'drip.txt'), timeoutMs: 1200 });
  const slowMs = Date.now() - t1;
  ok(slow.ok === false && slow.failClass === 'timeout', `N3f timeoutMs 是总期限:滴灌的下载在 ~1.2s 被判超时(修前跑满 9s 还 ok:true;${slowMs}ms,got ${JSON.stringify(slow).slice(0, 120)})`);
  ok(!fs.existsSync(path.join(WS, 'drip.txt')), 'N3g 超时不落半截文件');
  const ac = new AbortController(); setTimeout(() => ac.abort(), 500);
  const t2 = Date.now();
  const aborted = await call('http_download', { url: B + '/drip', dest: path.join(WS, 'drip2.txt'), timeoutMs: 60000 }, { signal: ac.signal });
  ok(aborted.ok === false && aborted.failClass === 'aborted', `N3h ctx.signal 能取消 http_download(修前不接信号,跑满 9s;${Date.now() - t2}ms,got ${JSON.stringify(aborted).slice(0, 120)})`);
  const ac2 = new AbortController(); setTimeout(() => ac2.abort(), 500);
  const t3 = Date.now();
  const abortedReq = await call('http_request', { url: B + '/drip' }, { signal: ac2.signal });
  ok(abortedReq.ok === false && abortedReq.failClass === 'aborted', `N3i ctx.signal 能取消 http_request(got ${JSON.stringify(abortedReq).slice(0, 120)})`);
  const ac3 = new AbortController(); setTimeout(() => ac3.abort(), 500);
  const t4 = Date.now();
  const abortedFetch = await call('web_fetch', { url: B + '/drip' }, { signal: ac3.signal });
  ok(abortedFetch.ok === false && abortedFetch.failClass === 'aborted' && !abortedFetch.fromCache, `N3j ctx.signal 能取消 web_fetch(got ${JSON.stringify(abortedFetch).slice(0, 120)})`);

  /* ═════════ (N5) shell 上限与长命令 ═════════ */
  const sessB = await mkSession('r2 B');
  const startShell = async (id, sess) => { const r = await call('shell_start', { shellId: id }, { session: sess }); if (r.ok) openShells.push([id, sess]); return r; };
  for (const id of ['a1', 'a2', 'a3']) { const r = await startShell(id, sessA); ok(r.ok === true, `N5a 会话 A 起 ${id}(got ${JSON.stringify(r).slice(0, 120)})`); }
  const a4 = await startShell('a4', sessA);
  ok(a4.ok === false && /上限/.test(String(a4.error || '')) && /本会话/.test(String(a4.error || '')), `N5b A 起第 4 个 → 本会话上限(got ${JSON.stringify(a4).slice(0, 160)})`);
  const b1 = await startShell('b1', sessB);
  ok(b1.ok === true, `N5c A 满了不挤占会话 B 的名额(修前全进程共用上限,B 被拒还看不见 A 的 shell;got ${JSON.stringify(b1).slice(0, 160)})`);
  const bList = await call('shell_list', {}, { session: sessB });
  ok(bList.shells.length === 1 && bList.shells[0].shellId === 'b1', `N5f B 的 shell_list 只看得见自己的(got ${JSON.stringify(bList.shells.map(s => s.shellId))})`);
  const tooLong = await call('shell_start', { shellId: 'long1', command: 'Write-Output ' + 'x'.repeat(13000) }, { session: sessB });
  ok(tooLong.ok === false && tooLong.code === 'command_too_long' && /script_run/.test(String(tooLong.hint || '')), `N5g 超长命令 → command_too_long 并指路 script_run(got ${JSON.stringify(tooLong).slice(0, 200)})`);
  if (!IS_WIN) {
    // 全局安全上限:A 3 + B 1 已开,再用 C / D / E 把总数推到 12,下一个会话的第 1 个被全局上限拒绝(错误里说清是全局的)。
    const extra = [];
    for (const nm of ['c', 'd', 'e']) extra.push(await mkSession('r2 ' + nm));
    let n = 4;
    for (const sess of extra) for (let i = 0; i < 3 && n < 12; i += 1) { const r = await startShell(`g${n}`, sess); if (r.ok) n += 1; }
    const sessF = await mkSession('r2 f');
    const over = await startShell('gover', sessF);
    ok(n === 12 && over.ok === false && /全局/.test(String(over.error || '')), `N5h 全局安全上限 12:再开一个被拒且错误说清是全局的(open=${n},got ${JSON.stringify(over).slice(0, 200)})`);
  }
  for (const [id, sess] of openShells.splice(0)) await call('shell_kill', { shellId: id }, { session: sess });

  /* ═════════ (N6 / N7 / N8) 键盘与截图(Linux 用假 PowerShell 记录脚本)═════════ */
  const emptyKeys = await call('keyboard_send_keys', { keys: '' });
  ok(emptyKeys.ok === false && !emptyKeys.threw, `N6a 空 keys → {ok:false}(修前抛 Error('keys is required');got ${JSON.stringify(emptyKeys).slice(0, 140)})`);
  if (!IS_WIN) {
    const kLit = await call('keyboard_send_keys', { keys: 'Hello (world) 50% a+b {x} [1]~^', literal: true, delayMs: 99999999 });
    const kRaw = await call('keyboard_send_keys', { keys: '^c' });
    const recs = records();
    const sLit = recs.find(s => s.includes('SendKeys') && s.includes('Hello'));
    ok(kLit.ok === true && !!sLit && sLit.includes("SendKeys('Hello {(}world{)} 50{%} a{+}b {{}x{}} {[}1{]}{~}{^}')"),
      `N6b literal:true 转义 + ^ % ~ ( ) { } [ ](got ${sLit})`);
    ok(!!sLit && /Start-Sleep -Milliseconds 10000;/.test(sLit), `N6c delayMs 限在 10000(got ${(sLit || '').slice(0, 120)})`);
    const sRaw = recs.find(s => s.includes("SendKeys('^c')"));
    ok(kRaw.ok === true && !!sRaw, `N6d 不带 literal 时 keys 原样交给 SendKeys(^c 仍是 Ctrl+C;got ${JSON.stringify(recs.map(s => s.slice(-60)))})`);
    const kNl = await call('keyboard_send_keys', { keys: 'line1\nline2', literal: true });
    ok(kNl.ok === true && records().some(s => s.includes("SendKeys('line1{ENTER}line2')")), 'N6e literal 模式下换行变 {ENTER}');
    const kNeg = await call('keyboard_send_keys', { keys: 'z', delayMs: -50 });
    ok(kNeg.ok === true && records().some(s => /Start-Sleep -Milliseconds 0;.*SendKeys\('z'\)/.test(s)), 'N6f delayMs 为负数夹到 0');

    // 截图:脚本里要有 DPI 感知,且在碰 System.Windows.Forms 之前
    process.env.FAKE_PS_PNG = '1';
    const shot = await call('desktop_screenshot', { outputPath: path.join(WS, 'shot.png') });
    delete process.env.FAKE_PS_PNG;
    ok(shot.ok === true && shot.path === path.join(WS, 'shot.png') && fs.existsSync(shot.path), `N7e 文件真生成时才返回 path(got ${JSON.stringify(shot).slice(0, 160)})`);
    const shotScript = records().find(s => s.includes('CopyFromScreen'));
    ok(!!shotScript && shotScript.indexOf('SetProcessDPIAware') >= 0 && shotScript.indexOf('SetProcessDPIAware') < shotScript.indexOf('System.Windows.Forms'),
      'N8a 截图脚本先 SetProcessDPIAware 再加载 System.Windows.Forms(Windows 真机未验证)');
    const shot2 = await call('desktop_screenshot', { outputPath: path.join(WS, 'never.png') }); // 假 PS 这次不生成文件
    ok(shot2.ok === false && !('path' in shot2) && !fs.existsSync(path.join(WS, 'never.png')), `N7f 脚本跑完却没生成文件 → ok:false 且不给 path(got ${JSON.stringify(shot2).slice(0, 200)})`);
  }
  // 静态:生成函数的文本(任何平台都跑;锁「DPI 在 try 里、先于 Forms」这个结构)
  const dispatchSrc = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '12-tool-dispatch.js'), 'utf8');
  const fn = functionBlock(dispatchSrc, 'buildDesktopScreenshotScript');
  ok(fn.length > 200, 'N8b 切到了 buildDesktopScreenshotScript');
  const iDpi = fn.indexOf('SetProcessDPIAware();'), iForms = fn.indexOf('Add-Type -AssemblyName System.Windows.Forms');
  ok(iDpi > 0 && iDpi < iForms && /try \{[\s\S]*?SetProcessDPIAware[\s\S]*?\} catch \{ \}/.test(fn.slice(0, iForms)) && /user32\.dll/.test(fn),
    'N8c DPI 感知调用在 try/catch 里(失败无害),且先于 System.Windows.Forms(Windows 真机未验证)');

  /* ═════════ (N9) 空 / 非法参数的信封 ═════════ */
  const blanks = [
    ['powershell_run', { command: '   ' }], ['script_run', { code: '  ' }], ['office_open', { path: '  ' }],
    ['keyboard_send_keys', { keys: '' }], ['desktop_screenshot', { outputPath: 123 }],
  ];
  for (const [tool, a] of blanks) {
    const r = await call(tool, a);
    ok(r.ok === false && !r.threw && typeof r.error === 'string', `N9 ${tool}(${JSON.stringify(a)})→ {ok:false, error} 信封(got ${JSON.stringify(r).slice(0, 140)})`);
  }
} catch (e) {
  t.fail('fatal: ' + ((e && e.stack) || e));
} finally {
  for (const [id, sess] of openShells.splice(0)) { try { await call('shell_kill', { shellId: id }, { session: sess }); } catch { /* 收尾 */ } }
  try { fixture.close(); } catch { /* ignore */ }
}
t.done({ exit: true });
})();
