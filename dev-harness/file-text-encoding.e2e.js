require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(走查 W1·F4):文本文件的两处「给人 / 给模型看」的解码入口按内容判编码(BOM > 严格 UTF-8 > GB18030),不再一律当 UTF-8:
//   (1) POST /api/upload → 附件记录的 textPreview(它会原样进喂给模型的 <attached_files>):GBK 的 .txt、带 BOM 的 UTF-16LE .csv、
//       带 BOM 的 UTF-8、普通 UTF-8 都解对;修前 GBK / UTF-16 满屏 U+FFFD。
//   (2) GET /api/file/preview:同上三类;另一份 >1MB 的 UTF-8 中文文件,1MB 截断处恰好切在汉字中间 —— 截断前缀按「前缀」嗅探
//       (不误判成 GBK、也不在末尾留半个字符的 U+FFFD)。
// 判定行:`FILE TEXT ENCODING E2E: ALL PASS`。
(async () => {
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createRunner } = require('./lib/harness');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('FILE TEXT ENCODING');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const WB_DIR = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-text-enc-'));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-text-enc-ws-'));
const GBK_HELLO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]);   // GBK:你好,世界
const CSV_TEXT = '名称,数量\r\n苹果,3\r\n';
const U16_CSV = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CSV_TEXT, 'utf16le')]);

let wb = null;
try {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 10, permissionMode: 'default', defaultWorkspace: WS, recentWorkspaces: [WS], includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false,
  }, null, 2));
  const port = await getFreePort();
  wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(port)], { cwd: WB_DIR, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  const httpJson = (method, route, body, headers) => new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 30000, headers: { ...(headers || {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  let live = null; for (let i = 0; i < 100 && !live; i++) { await sleep(150); live = await httpJson('GET', '/health').catch(() => null); }
  const page = await new Promise(r => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.setEncoding('utf8'); res.on('data', c => (b += c)); res.on('end', () => r(b)); }));
  const token = (String(page).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
  const auth = { 'x-wcw-token': token };
  const created = await httpJson('POST', '/api/sessions', { title: 'text enc', cwd: WS }, auth);
  const sid = created && created.session && created.session.id;
  ok(!!sid && !!token, 'E0 前置:真服务起得来、拿得到令牌、能建会话');

  // (1) 上传 → 附件记录的 textPreview
  const upload = async (name, buf) => (await httpJson('POST', '/api/upload', { name, data: buf.toString('base64') }, auth)).file || {};
  const fGbk = await upload('gbk-note.txt', GBK_HELLO);
  ok(fGbk.textPreview === '你好，世界', `U1 GBK 的 .txt 附件预览解成「你好，世界」(修前 U+FFFD;got ${JSON.stringify(fGbk.textPreview)})`);
  const fU16 = await upload('u16-data.csv', U16_CSV);
  ok(fU16.textPreview === CSV_TEXT, `U2 带 BOM 的 UTF-16LE .csv 附件预览解对、BOM 不进文本(got ${JSON.stringify(fU16.textPreview)})`);
  const fUtf8 = await upload('plain-utf8.md', Buffer.from('# 标题\n正文 ok\n', 'utf8'));
  ok(fUtf8.textPreview === '# 标题\n正文 ok\n', `U3 普通 UTF-8 附件预览不变(got ${JSON.stringify(fUtf8.textPreview)})`);
  const fBom = await upload('bom-utf8.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带 BOM', 'utf8')]));
  ok(fBom.textPreview === '﻿带 BOM', `U4 带 BOM 的 UTF-8 保持修前口径:BOM 字符留在文本里(got ${JSON.stringify(fBom.textPreview)})`);

  // (2) /api/file/preview
  const pv = p => httpJson('GET', '/api/file/preview?path=' + encodeURIComponent(p) + '&sessionId=' + sid, null, auth);
  const gbkPath = path.join(WS, 'gbk-note.txt'); fs.writeFileSync(gbkPath, GBK_HELLO);
  const rGbk = await pv(gbkPath);
  ok(rGbk.ok === true && rGbk.kind === 'text' && rGbk.content === '你好，世界', `P1 GBK 的 .txt 预览解成「你好，世界」(got ${JSON.stringify(rGbk.content)})`);
  const u16Path = path.join(WS, 'u16-data.csv'); fs.writeFileSync(u16Path, U16_CSV);
  const rU16 = await pv(u16Path);
  ok(rU16.ok === true && rU16.kind === 'text' && rU16.content === CSV_TEXT, `P2 带 BOM 的 UTF-16LE .csv 预览解对(got ${JSON.stringify(rU16.content)})`);
  const htmlPath = path.join(WS, 'gbk-page.html'); fs.writeFileSync(htmlPath, Buffer.concat([Buffer.from('<p>', 'latin1'), GBK_HELLO, Buffer.from('</p>', 'latin1')]));
  const rHtml = await pv(htmlPath);
  ok(rHtml.ok === true && rHtml.kind === 'html' && rHtml.content === '<p>你好，世界</p>', `P3 GBK 的 .html 源码预览同样按内容判(got ${JSON.stringify(rHtml.content)})`);
  const bigPath = path.join(WS, 'big-cn.txt'); fs.writeFileSync(bigPath, '中'.repeat(400000));   // 1.2MB;1048576 = 3 × 349525 + 1,第 349526 个字被切开
  const rBig = await pv(bigPath);
  ok(rBig.ok === true && rBig.truncated === true && rBig.content === '中'.repeat(349525),
    `P4 >1MB 的 UTF-8 中文预览:截断在字中间只留完整的字,不判成 GBK、不带 U+FFFD(got length ${rBig.content && rBig.content.length}, 末字 ${JSON.stringify(rBig.content && rBig.content.slice(-1))})`);
  const mdPath = path.join(WS, 'ok.md'); fs.writeFileSync(mdPath, '# Hello 世界\n', 'utf8');
  const rMd = await pv(mdPath);
  ok(rMd.ok === true && rMd.content === '# Hello 世界\n', `P5 普通 UTF-8 预览不变(got ${JSON.stringify(rMd.content)})`);
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { if (wb) killOwnTree(wb); } catch { /* ignore */ }
  await sleep(300);
  for (const d of [HOME, WS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  t.done();
}
})();
