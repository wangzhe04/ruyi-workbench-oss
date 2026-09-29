'use strict';
// 内置免费搜索(searchBackend.type = 'builtin':Bing CN 为主、百度补充)的结果质量。夹具按两家真实页面的结构写
// (标题块、点击跟踪链接、广告位、自家聚合卡片、带高亮词的摘要、人机验证页),全部走本机假服务器,不外连。
//   [Q1] Bing:只认 b_algo 里 <h2> 的链接;ck/a 跳转链接解出原网址;广告、Bing 自家页面、没有标题的块不收;
//        最后一块不吞进分页 / 相关搜索;摘要去掉「网页」角标、script/style 不进摘要
//   [Q2] 百度:result-op(自家聚合卡片)与广告不收;网址取容器 mu 属性里的真实网址;摘要不在第一个高亮词处截断
//   [Q3] 合并:中文查询两个引擎交错合并、跨引擎去重(协议 / www. / 末尾斜杠 / utm 参数不算区别);与查询零重合的排到最后
//   [Q4] 不够时翻 Bing 第二页;纯英文查询带 ensearch=1(国际版结果)
//   [Q5] 被人机验证页拦下:如实说明(blocked + 换后端建议),不说「没有结果」
//   [Q6] 缺省返回 8 条
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-search-quality-'));
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

const b64url = s => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bingAlgo = (title, url, snippet, { redirect = false, slug = true } = {}) => {
  const href = redirect ? `https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${b64url(url)}&amp;ntb=1` : url;
  return `<li class="b_algo" data-id="" iid="SERP.1"><div class="b_tpcn"><a class="tilk" href="${href}"><div class="tptt">站点</div>`
    + `<div class="b_attribution"><cite>${url.replace(/^https?:\/\//, '')}</cite></div></a></div>`
    + `<h2><a target="_blank" href="${href}" h="ID=SERP,1.1">${title}</a></h2>`
    + `<div class="b_caption"><p class="b_lineclamp2 b_algoSlug">${slug ? '<span class="algoSlug_icon" data-priority="2">网页</span>' : ''}${snippet}</p>`
    + `<ul class="b_vList"><li><a href="${url}/deep">深链</a></li></ul></div></li>`;
};
const bingPage = (items, tail = '') => `<!DOCTYPE html><html><head><title>q - 搜索</title><style>.b_algo{color:red}</style></head><body>`
  + `<ol id="b_results">${items.join('')}${tail}</ol><script>var junk = "不该进摘要";</script></body></html>`;
const BING_TAIL = '<li class="b_ad b_adBottom"><ul><li class="b_adLastChild"><h2><a href="https://ads.example/buy">底部广告</a></h2></li></ul></li>'
  + '<li class="b_rs"><h2>相关搜索</h2><ul><li><a href="/search?q=related">相关词</a></li></ul></li>'
  + '<li class="b_pag"><nav><a href="/search?q=x&amp;first=11">下一页</a></nav></li>';

const baiduResult = (title, realUrl, snippetHtml, { mu = true, id = 1 } = {}) =>
  `<div class="result c-container xpath-log new-pmd" srcid="1599" id="${id}" tpl="se_com_default"${mu ? ` mu="${realUrl}"` : ''}>`
  + `<div class="c-container"><h3 class="c-title t t tts-title"><a href="http://www.baidu.com/link?url=REDIR${id}" target="_blank">${title}</a></h3>`
  + `<div class="c-row"><span class="content-right_2s-H4"><span class="c-color-gray2">2025年3月1日&nbsp;</span>${snippetHtml}</span></div></div></div>`;
const BAIDU_JUNK = '<div class="result-op c-container xpath-log new-pmd" tpl="recommend_list"><h3><a href="http://www.baidu.com/s?wd=x">大家还在搜</a></h3></div>'
  + '<div class="result c-container ec_wise_ad" id="3001"><h3><a href="http://ads.baidu.com/x">推广链接</a></h3><span>广告</span></div>';

const servers = [];
async function serve(handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
after(async () => { for (const s of servers) await new Promise(r => s.close(r)); fs.rmSync(root, { recursive: true, force: true }); });

test('[Q1] Bing:标题链接、跳转解码、广告与噪声不收、摘要干净', () => {
  const html = bingPage([
    bingAlgo('Node.js <strong>fs.rename</strong> EXDEV 跨盘报错', 'https://nodejs.org/api/fs.html', '跨设备 <strong>rename</strong> 会报 EXDEV,需要先复制再删除。', { redirect: true }),
    '<li class="b_algo"><div class="b_caption"><p>没有标题的块</p><a href="https://noise.example/x">杂链接</a></div></li>',
    bingAlgo('Bing 自家视频页', 'https://www.bing.com/videos/search?q=x', '视频'),
    '<li class="b_algo b_adTop"><h2><a href="https://ads.example/top">顶部广告</a></h2><p class="b_adSlug">广告</p></li>',
    bingAlgo('第二条真结果', 'https://example.com/second', '第二条摘要', { slug: false }),
  ], BING_TAIL);
  const out = srv.parseBingHtml(html, 10);
  assert.deepEqual(out.map(r => r.url), ['https://nodejs.org/api/fs.html', 'https://example.com/second'], '只留两条真结果,跳转链接解成原网址');
  assert.equal(out[0].title, 'Node.js fs.rename EXDEV 跨盘报错');
  assert.equal(out[0].snippet, '跨设备 rename 会报 EXDEV,需要先复制再删除。', '摘要去掉「网页」角标、不带深链与 CSS / JS');
  assert.ok(!out.some(r => /广告|相关搜索|下一页|noise\.example|ads\.example/.test(r.title + r.url)), '广告、相关搜索、分页、无标题块都不收');
});

test('[Q2] 百度:聚合卡片与广告不收、mu 真实网址、摘要不截断', () => {
  const html = BAIDU_JUNK
    + baiduResult('Node.js <em>fs.rename</em> 报 EXDEV 怎么办', 'https://blog.example.cn/post/1', '原因是跨分区,<em>rename</em> 不能跨设备,改用 <em>copyFile</em> 加 unlink 即可解决。')
    + baiduResult('没有 mu 的结果', 'https://ignored.example', '只有跳转链接', { mu: false, id: 2 });
  const out = srv.parseBaiduHtml(html, 10);
  assert.equal(out.length, 2, `只留两条自然结果(${JSON.stringify(out.map(r => r.title))})`);
  assert.equal(out[0].url, 'https://blog.example.cn/post/1', '网址取 mu 属性里的真实网址');
  assert.match(out[0].snippet, /跨分区,rename 不能跨设备,改用 copyFile 加 unlink 即可解决/, `摘要完整(${out[0].snippet})`);
  assert.match(out[1].url, /baidu\.com\/link\?url=REDIR2/, '没有 mu 时退回标题上的跳转链接');
});

test('[Q3][Q4][Q6] 合并去重、零重合靠后、翻页、ensearch、缺省 8 条', async () => {
  const bingHits = [];
  const bingRoot = await serve((req, res) => {
    bingHits.push(req.url);
    const u = new URL(req.url, 'http://x');
    const first = Number(u.searchParams.get('first') || 1);
    const items = [];
    if (u.searchParams.get('q') === 'english only query') {
      for (let i = 0; i < 3; i++) items.push(bingAlgo(`english only query result ${i}`, `https://en.example/${i}`, 'english only query text'));
    } else if (first === 1) {
      items.push(bingAlgo('完全无关的推荐内容', 'https://spam.example/ad', '买一送一 限时特价', { redirect: true }));
      items.push(bingAlgo('如意工作台 上下文压缩 原理', 'https://docs.example/ruyi/compact/', '如意工作台的上下文压缩分两级'));
      for (let i = 0; i < 8; i++) items.push(bingAlgo(`如意工作台 压缩 第${i}篇`, `https://b.example/p${i}`, '如意工作台 压缩'));
    } else {
      items.push(bingAlgo('如意工作台 压缩 翻页结果', 'https://b.example/page2', '如意工作台 第二页'));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(bingPage(items, BING_TAIL));
  });
  const baiduRoot = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(BAIDU_JUNK
      + baiduResult('如意工作台 上下文压缩 原理(百度)', 'http://www.docs.example/ruyi/compact?utm_source=baidu', '同一篇,跨引擎应去重', { id: 1 })
      + baiduResult('如意工作台 压缩 百度独有', 'https://only-baidu.example.cn/a', '如意工作台 百度独有的一条', { id: 2 }));
  });
  const cfg = { searchBackend: { type: 'builtin', baseUrl: bingRoot, baiduBaseUrl: baiduRoot, apiKey: '' } };

  const r = await srv.webSearch({ query: '如意工作台 压缩', maxResults: 12 }, cfg);
  assert.equal(r.ok, true);
  assert.equal(r.engine, 'bing+baidu');
  const urls = r.results.map(x => x.url);
  assert.equal(new Set(urls.map(u => u.replace(/^https?:\/\/(www\.)?/, '').replace(/[/?].*$/, '') + new URL(u).pathname.replace(/\/$/, ''))).size, urls.length, '去重后没有同一页面两次');
  assert.ok(urls.includes('https://docs.example/ruyi/compact/') && !urls.some(u => /utm_source=baidu/.test(u)), '跨引擎同一篇只留一条(Bing 的在前)');
  assert.ok(urls.includes('https://only-baidu.example.cn/a'), '百度独有的补进来');
  assert.ok(urls.includes('https://b.example/page2'), 'Bing 第一页不够时翻到第二页');
  assert.equal(urls[urls.length - 1], 'https://spam.example/ad', '与查询零重合的推荐排到最后');
  assert.ok(bingHits.some(u => /first=\d+/.test(u)), '请求过第二页');
  assert.ok(!bingHits.some(u => /ensearch=1/.test(u)), '中文查询不带 ensearch');

  const d = await srv.webSearch({ query: '如意工作台 压缩' }, cfg);
  assert.equal(d.results.length, 8, '缺省 8 条');

  bingHits.length = 0;
  const en = await srv.webSearch({ query: 'english only query', maxResults: 3 }, { searchBackend: { type: 'builtin', baseUrl: bingRoot, apiKey: '' } });
  assert.equal(en.results.length, 3);
  assert.ok(bingHits.every(u => /ensearch=1/.test(u)), `纯英文查询走国际版(${bingHits.join(' ')})`);
});

test('[Q5] 人机验证页:如实说明,不说「没有结果」', async () => {
  const bingRoot = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><div id="b_captcha" class="b_captcha">请完成验证</div></body></html>'); });
  const baiduRoot = await serve((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><title>百度安全验证</title></head><body>wappass.baidu.com</body></html>'); });
  const r = await srv.webSearch({ query: '如意' }, { searchBackend: { type: 'builtin', baseUrl: bingRoot, baiduBaseUrl: baiduRoot, apiKey: '' } });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 0);
  assert.equal(r.blocked, true);
  assert.match(r.note, /人机验证/);
  assert.match(r.note, /设置→搜索后端/);
});
