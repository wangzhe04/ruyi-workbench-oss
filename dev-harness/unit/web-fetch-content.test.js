'use strict';
// web_fetch 的字符集 / 类型闸 / 正文抽取 / 翻页 / 缓存(审计 NE-8、NE-9)。夹具按真实页面的形状内联写(文档站有大菜单与页脚,
// 老政企站是 GBK + 一个 <form> 包住整页),全部走本机假服务器,不外连。
//   [C1] GBK:Content-Type 的 charset、<meta http-equiv>、什么都没声明(猜 GB18030),另有 Big5 / Shift_JIS
//   [C2] 类型闸:pdf / 图片 / octet-stream / 无类型但有 %PDF 魔数 → ok:false + 改用 http_download 的提示,且不写缓存;json 原样返回
//   [C3] 抽取:文章在最前、菜单页脚被丢、<pre> 缩进原样、链接编号 + 相对地址解析、标题 / 列表 / 表格
//   [C4] 抽取的边界:<form> 包整页不丢内容、没关的 <nav> 不吞后文、article 里的 header 保留、main 太短退回整页
//   [C5] 缓存存完整文本、翻页(offset / nextOffset / truncated)、离线读缓存与翻页拼回原文
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-web-content-'));
process.env.RUYI_HOME = root;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete process.env[k];
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

const servers = [];
async function serve(handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
after(async () => { for (const s of servers) await new Promise(r => s.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
const bytes = (...parts) => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

// ── [C1] ────────────────────────────────────────────────────────────────────────────────────────────────
// 「标题」GBK = B1EA CCE2;「你好,世界」= C4E3 BAC3 A3AC CAC0 BDE7
const GBK_TITLE = [0xb1, 0xea, 0xcc, 0xe2];
const GBK_BODY = [0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7];
const gbkPage = head => bytes('<html><head>', head, '<title>', GBK_TITLE, '</title></head><body><p>', GBK_BODY, '</p></body></html>');

test('[C1] GBK 页面按 Content-Type charset 解码', async () => {
  const base = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=GBK' }); res.end(gbkPage('')); });
  const r = await srv.webFetch({ url: base + '/hdr' });
  assert.equal(r.ok, true);
  assert.equal(r.title, '标题');
  assert.match(r.text, /你好,世界|你好，世界/);
  assert.ok(!r.text.includes('\ufffd'), '没有替换字符');
  assert.equal(r.charset, 'gbk');
});

test('[C1] GBK 页面按 <meta http-equiv> 与 <meta charset> 解码(响应头没声明)', async () => {
  const base = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/a')
      ? gbkPage('<meta http-equiv="Content-Type" content="text/html; charset=gb2312">')
      : gbkPage('<meta charset="gbk">'));
  });
  for (const p of ['/a', '/b']) {
    const r = await srv.webFetch({ url: base + p });
    assert.equal(r.ok, true, p);
    assert.equal(r.title, '标题', p);
    assert.match(r.text, /你好/, p);
    assert.ok(!r.text.includes('\ufffd'), p);
  }
});

test('[C1] 什么都没声明的 GBK 页面:严格 UTF-8 失败后按 GB18030 猜,并给 warning', async () => {
  const base = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(gbkPage('')); });
  const r = await srv.webFetch({ url: base + '/guess' });
  assert.equal(r.ok, true);
  assert.equal(r.title, '标题');
  assert.equal(r.charset, 'gb18030');
  assert.match(r.warning || '', /GB18030/);
});

test('[C1] Big5 / Shift_JIS / UTF-8 带 BOM / 合法 UTF-8 不动', async () => {
  const base = await serve((req, res) => {
    const p = req.url;
    if (p === '/big5') { res.writeHead(200, { 'content-type': 'text/html; charset=big5' }); res.end(bytes('<p>', [0xa4, 0xa4, 0xa4, 0xe5], '</p>')); return; }
    if (p === '/sjis') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(bytes('<meta charset="Shift_JIS"><p>', [0x93, 0xfa, 0x96, 0x7b], '</p>')); return; }
    if (p === '/bom') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>带BOM的中文</p>', 'utf8')])); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<p>普通 UTF-8 中文</p>');
  });
  assert.match((await srv.webFetch({ url: base + '/big5' })).text, /中文/);
  assert.match((await srv.webFetch({ url: base + '/sjis' })).text, /日本/);
  const bom = await srv.webFetch({ url: base + '/bom' });
  assert.equal(bom.text, '带BOM的中文', 'BOM 被吃掉');
  const u8 = await srv.webFetch({ url: base + '/u8' });
  assert.equal(u8.text, '普通 UTF-8 中文');
  assert.equal(u8.charset, 'utf-8');
});

// ── [C2] ────────────────────────────────────────────────────────────────────────────────────────────────
test('[C2] 二进制类型不当网页读:ok:false + 改用 http_download,且不写缓存', async () => {
  const pdf = bytes('%PDF-1.4\n1 0 obj<<>>endobj\n', [0x80, 0x81, 0xff, 0xfe, 0, 1]);
  const base = await serve((req, res) => {
    const t = { '/pdf': 'application/pdf', '/png': 'image/png', '/bin': 'application/octet-stream', '/zip': 'application/zip', '/docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }[req.url];
    const h = t ? { 'content-type': t } : {};
    res.writeHead(200, h);
    res.end(pdf);
  });
  for (const p of ['/pdf', '/png', '/bin', '/zip', '/docx', '/nomagic']) {
    const r = await srv.webFetch({ url: base + p });
    assert.equal(r.ok, false, p);
    assert.equal(r.failClass, 'not-text', p);
    assert.match(r.hint || '', /http_download/, p);
    assert.ok(!('text' in r), p);
    assert.equal(await srv.readWebCache(base + p), null, p + ' 没写缓存');
  }
});

test('[C2] json / 纯文本不走 HTML 抽取,原样返回', async () => {
  const json = JSON.stringify({ a: 1, list: ['<b>x</b>', 'y'] }, null, 2);
  const base = await serve((req, res) => {
    if (req.url === '/j') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(json); return; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('line1\r\n  indented line2\n');
  });
  const j = await srv.webFetch({ url: base + '/j' });
  assert.equal(j.ok, true);
  assert.equal(j.text, json, 'JSON 里的 <b> 不会被当标签剥掉');
  const t = await srv.webFetch({ url: base + '/t' });
  assert.equal(t.text, 'line1\n  indented line2\n', '纯文本保留缩进,CRLF 归一');
});

// ── [C3] ────────────────────────────────────────────────────────────────────────────────────────────────
const menu = Array.from({ length: 60 }, (_, i) => `<li><a href="/docs/${i}">Menu item ${i}</a></li>`).join('');
const DOC_PAGE = `<!DOCTYPE html><html><head><title>API Guide</title><meta charset="utf-8"><script>var junk = 1 < 2;</script></head><body>
<header class="site"><nav><ul>${menu}</ul></nav></header>
<aside class="toc"><ul>${menu}</ul></aside>
<main><article>
<h1>Install</h1>
<p>Run <a href="https://example.com/dl?x=1&amp;y=2#top">the installer</a> then read <a href="/guide/next">next page</a>, or <a href="#faq">the FAQ</a> or <a href="javascript:void(0)">nothing</a>.</p>
<h2>Options</h2>
<ul><li>fast</li><li>safe &amp; slow</li></ul>
<table><tr><th>name</th><th>value</th></tr><tr><td>a</td><td>1</td></tr></table>
<pre>def f():
    if x:
        return "&lt;ok&gt;"

# tab	kept</pre>
<p>Inline <code>code</code> stays.</p>
</article></main>
<footer><p>Copyright 2026</p><ul>${menu}</ul></footer>
<svg><path d="M0 0"/></svg><select><option>zh</option></select><button>Go</button>
</body></html>`;

test('[C3] 文档站:文章在最前、菜单侧栏页脚被丢、<pre> 原样、链接编号', () => {
  const r = srv.extractMainText(DOC_PAGE, { baseUrl: 'https://docs.example.org/guide/start' });
  assert.equal(r.title, 'API Guide');
  assert.ok(r.text.startsWith('# Install'), `文章在最前:${JSON.stringify(r.text.slice(0, 40))}`);
  assert.ok(!/Menu item|Copyright|zh\b|Go\b/.test(r.text), '菜单 / 页脚 / select / button 都不在');
  assert.ok(!/junk/.test(r.text), 'script 不在');
  assert.match(r.text, /## Options/);
  assert.match(r.text, /\n- fast\n- safe & slow\n/);
  assert.match(r.text, /name \| value\na \| 1/);
  assert.match(r.text, /```\ndef f\(\):\n    if x:\n        return "<ok>"\n\n# tab\tkept\n```/, `<pre> 缩进 / 空行 / 制表符原样:${r.text}`);
  assert.match(r.text, /Inline code stays\./);
  // 链接:只编号有文字的 http(s) 链接;#锚点、javascript: 丢;相对地址按 baseUrl 解析;#top 去掉。
  assert.match(r.text, /the installer \[1\] then read next page \[2\]/);
  assert.deepEqual(r.links, [{ n: 1, url: 'https://example.com/dl?x=1&y=2' }, { n: 2, url: 'https://docs.example.org/guide/next' }]);
  assert.ok(!/FAQ \[|nothing \[/.test(r.text));
});

test('[C3] 旧调用(不带 opts)照常返回 {title,text},相对链接无 baseUrl 时不编号', () => {
  const r = srv.extractMainText('<html><head><title>T</title></head><body><p>Hello <a href="/rel">rel</a> <a href="http://abs.example/x">abs</a></p></body></html>');
  assert.equal(r.title, 'T');
  assert.equal(r.text, 'Hello rel abs [1]');
  assert.deepEqual(r.links, [{ n: 1, url: 'http://abs.example/x' }]);
});

// ── [C4] ────────────────────────────────────────────────────────────────────────────────────────────────
test('[C4] <form> 包住整页(ASP.NET WebForms)不丢内容', () => {
  const r = srv.extractMainText('<html><body><form id="aspnetForm" action="x"><div class="c"><h2>关于开展年度检查的通知</h2><p>各单位:请于本月底前完成。</p></div><input type="hidden" value="v"></form></body></html>');
  assert.match(r.text, /关于开展年度检查的通知/);
  assert.match(r.text, /各单位:请于本月底前完成/);
});

test('[C4] 没有关闭的 <nav> 不吞掉后文', () => {
  const r = srv.extractMainText('<html><body><nav><a href="/x">home</a><div><p>Real content that must survive the sloppy markup.</p></div></body></html>');
  assert.match(r.text, /Real content that must survive/);
});

test('[C4] article 里的 header(题头带标题)保留,article 外的 header / footer 丢', () => {
  const body = 'Body text of the article. '.repeat(12);
  const r = srv.extractMainText(`<html><body><header><p>SITE BANNER</p></header><article><header><h1>Post Title</h1><p>2026-09-01</p></header><p>${body}</p><footer>share links</footer></article><footer>SITE FOOTER</footer></body></html>`);
  assert.match(r.text, /Post Title/);
  assert.match(r.text, /2026-09-01/);
  assert.ok(!/SITE BANNER|SITE FOOTER/.test(r.text));
});

test('[C4] <main> 太短就退回整页;role=navigation 的容器丢弃', () => {
  const long = 'Real page text paragraph. '.repeat(10);
  const r = srv.extractMainText(`<html><body><div role="navigation"><p>NAVBOX</p></div><main><p>tiny</p></main><div><p>${long}</p></div></body></html>`);
  assert.match(r.text, /Real page text paragraph/);
  assert.ok(!/NAVBOX/.test(r.text));
});

test('[C4] 疑似 JS 壳:正文很少且多个 <script> → note', async () => {
  const base = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></head><body><div id="app"></div></body></html>');
  });
  const r = await srv.webFetch({ url: base + '/spa' });
  assert.equal(r.ok, true);
  assert.match(r.note || '', /JavaScript/);
});

// ── [C5] ────────────────────────────────────────────────────────────────────────────────────────────────
test('[C5] 缓存存完整文本;maxChars / offset 翻页;离线读缓存与翻页拼回原文', async () => {
  const paras = Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i} — ${'lorem ipsum dolor '.repeat(6)}</p>`).join('\n');
  const html = `<html><head><title>Long</title></head><body><main><h1>Long page</h1>${paras}<p><a href="/tail">tail link</a></p></main></body></html>`;
  let hits = 0;
  const s = http.createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/long`;
  const full = srv.extractMainText(html, { baseUrl: url }).text;
  assert.ok(full.length > 5000);

  const a = await srv.webFetch({ url, maxChars: 500 });
  assert.equal(a.ok, true);
  assert.equal(a.text.length, 500);
  assert.equal(a.truncated, true);
  assert.equal(a.nextOffset, 500);
  assert.equal(a.totalChars, full.length);
  // 缓存里是完整文本(修前是被 maxChars 切过的 500 字)。
  const cached = await srv.readWebCache(url);
  assert.equal(cached.text, full, '缓存存完整抽取文本');

  // 翻页:offset>0 且缓存新 → 不再打网络。
  const before = hits;
  const b = await srv.webFetch({ url, maxChars: 500, offset: a.nextOffset });
  assert.equal(hits, before, '翻页读缓存,不重抓');
  assert.equal(b.fromCache, true);
  assert.equal(b.offset, 500);
  assert.equal(a.text + b.text, full.slice(0, 1000));

  // 最后一页:不再有 nextOffset,truncated:false,链接表里有 tail 链接。
  const last = await srv.webFetch({ url, maxChars: 60000, offset: full.length - 300 });
  assert.equal(last.truncated, false);
  assert.ok(!('nextOffset' in last));
  assert.ok(last.links.some(l => /\/tail$/.test(l)), JSON.stringify(last.links));

  // 服务器没了(离线)→ 读缓存拿到的是整页,不是 500 字的残片;分页口径仍然诚实。
  await new Promise(r => s.close(r));
  const off = await srv.webFetch({ url, maxChars: 60000 });
  assert.equal(off.ok, true);
  assert.equal(off.fromCache, true);
  assert.equal(off.text, full, '离线副本是完整正文');
  assert.equal(off.truncated, false, '整页放得下就不是 truncated');
  const offSmall = await srv.webFetch({ url, maxChars: 500 });
  assert.equal(offSmall.truncated, true);
  assert.equal(offSmall.nextOffset, 500);
});

test('[C5] 重定向后的页面也按请求网址缓存;maxChars 上限收在 60000', async () => {
  const body = '<html><body><main><p>' + 'x'.repeat(70000) + '</p></main></body></html>';
  const base = await serve((req, res) => {
    if (req.url === '/old') { res.writeHead(302, { location: '/new' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
  });
  const r = await srv.webFetch({ url: base + '/old', maxChars: 200000 });
  assert.equal(r.ok, true);
  assert.equal(r.text.length, 60000, 'maxChars 收在 60000');
  assert.equal(r.nextOffset, 60000);
  assert.ok(await srv.readWebCache(base + '/old'), '按请求网址也有缓存');
  assert.ok(await srv.readWebCache(base + '/new'), '按最终网址有缓存');
});
