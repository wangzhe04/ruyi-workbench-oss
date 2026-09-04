'use strict';
/*
 * E2E (第118波 118a-fix): 应用内手册阅读器的服务端契约。
 *
 * 立项理由:118a 的向导完成页只印了一行 docs/manuals/USER-GUIDE_CN.md 加一个「复制路径」按钮,
 * 等于把用户推去文件管理器自己找文件。产品口径是每件事都要能在如意里做完,所以手册改成应用内读:
 * GET /api/help/doc?id=&lang= 只吐 markdown 原文,渲染在前端复用既有 marked + sanitizeNode 管线。
 * 本件锁住这条通道的契约与安全边界:
 *
 *   ① 白名单命中:id=user-guide 取到真手册正文(含真实的一级标题与 ## 小节标题),信封字段齐;
 *   ② 语言:lang=en-US 取英文本;lang 非法/缺省时跟随 config.locale,再回落 zh-CN;
 *   ③ 未知 id -> 404 且是结构化错误信封(help.doc_unknown),不泄漏任何文件系统信息;
 *   ④ 穿越面为零:id=../../.. / id=user-guide%2F..%2F.. / 绝对路径 / 空 id 一律 404,
 *      服务端从不把请求串拼进路径(真正进 path.join 的只有白名单常量文件名);
 *   ⑤ 鉴权:无 token -> 403(ROUTE_AUTH 记 token 级,handler 再自查一遍);
 *   ⑥ admin-guide 走同一条通道;
 *   ⑦ 只读:POST 同路径不被本路由服务(方法面不放宽)。
 *
 * 全离线。判定行:`HELP VIEWER E2E: ALL PASS`。
 */
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const MANUALS = path.join(WB, 'docs', 'manuals');
const HOME = path.join(os.tmpdir(), 'wcw-help-viewer-e2e');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };

let PORT = 0;
let TOKEN = '';
function request(method, p, body, headers = {}, withToken = true) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = {
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      ...(withToken && TOKEN ? { 'x-wcw-token': TOKEN } : {}),
      ...headers,
    };
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, timeout: 15000, headers: h }, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* non-JSON */ } resolve({ status: res.statusCode, json, raw }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + p)); });
    if (data) req.write(data);
    req.end();
  });
}
async function up() {
  for (let i = 0; i < 60; i++) {
    try { const r = await request('GET', '/health'); if (r.status === 200) return true; } catch { /* not yet */ }
    await sleep(150);
  }
  return false;
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  PORT = await getFreePort();

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
    cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    ok(await up(), 'workbench listening on :' + PORT);
    const boot = await request('POST', '/api/bootstrap', {});
    TOKEN = (boot.json && boot.json.token) || '';
    ok(boot.status === 200 && !!TOKEN, 'bootstrap 换到 token');

    /* ① 白名单命中 */
    const cnDisk = fs.readFileSync(path.join(MANUALS, 'USER-GUIDE_CN.md'), 'utf8');
    const firstH2 = (cnDisk.split(/\r?\n/).find(l => /^##\s+\S/.test(l)) || '').trim();
    const cn = await request('GET', '/api/help/doc?id=user-guide&lang=zh-CN');
    ok(cn.status === 200 && cn.json && cn.json.ok === true, '① id=user-guide 命中白名单 -> 200 ok');
    ok(cn.json.id === 'user-guide' && cn.json.lang === 'zh-CN' && typeof cn.json.markdown === 'string',
      '① 信封含 {ok,id,lang,markdown}');
    ok(typeof cn.json.markdown === 'string' && cn.json.markdown.includes('# 如意 Ruyi 用户手册'),
      '① 正文是真手册(含一级标题「如意 Ruyi 用户手册」)');
    ok(!!firstH2 && cn.json.markdown.includes(firstH2),
      '① 正文含真实 ## 小节标题(前端目录跳转的取材面): ' + firstH2);
    ok(cn.json.title === '如意 Ruyi 用户手册', '① title 取自正文一级标题');
    ok(Array.isArray(cn.json.available) && cn.json.available.join(',') === 'zh-CN,en-US',
      '① available 列出该文档的两种语言(前端据此决定要不要显示切换器)');
    ok(cn.json.truncated === false && cn.json.bytes === Buffer.byteLength(cnDisk, 'utf8'),
      '① 手册未超 512KB 上限,truncated=false 且 bytes 与磁盘一致');

    /* ② 语言选择 */
    const en = await request('GET', '/api/help/doc?id=user-guide&lang=en-US');
    ok(en.status === 200 && en.json.ok === true && en.json.lang === 'en-US'
      && en.json.markdown.includes('# Ruyi User Guide'), '② lang=en-US 取到英文本');
    const bogusLang = await request('GET', '/api/help/doc?id=user-guide&lang=fr-FR');
    ok(bogusLang.status === 200 && bogusLang.json.ok === true && bogusLang.json.lang === 'zh-CN',
      '② 非法 lang 回落(config.locale=auto -> zh-CN),不报错');
    await request('POST', '/api/config', { locale: 'en-US' });
    const followed = await request('GET', '/api/help/doc?id=user-guide');
    ok(followed.status === 200 && followed.json.lang === 'en-US',
      '② 不传 lang 时跟随 config.locale');
    await request('POST', '/api/config', { locale: 'auto' });

    /* ③④ 未知 id 与穿越面 */
    const unknown = await request('GET', '/api/help/doc?id=nope');
    ok(unknown.status === 404 && unknown.json && unknown.json.ok === false
      && unknown.json.error && unknown.json.error.code === 'help.doc_unknown',
      '③ 未知 id -> 404 + 结构化信封 help.doc_unknown');
    const traversals = [
      'id=../../..',
      'id=user-guide%2F..%2F..',
      'id=' + encodeURIComponent('../../../../Windows/win.ini'),
      'id=' + encodeURIComponent('..\\..\\config.json'),
      'id=' + encodeURIComponent('C:/Windows/win.ini'),
      'id=' + encodeURIComponent('USER-GUIDE_CN.md'),
      'id=',
    ];
    let traversalOk = true;
    for (const q of traversals) {
      const res = await request('GET', '/api/help/doc?' + q);
      const rejected = res.status === 404 && res.json && res.json.ok === false;
      if (!rejected) { traversalOk = false; console.log('   [traversal leak] ' + q + ' -> ' + res.status + ' ' + res.raw.slice(0, 120)); }
    }
    ok(traversalOk, '④ 穿越/绝对路径/裸文件名/空 id 一律 404(请求串永不进 path.join)');
    const langTraversal = await request('GET', '/api/help/doc?id=user-guide&lang=' + encodeURIComponent('../../etc'));
    ok(langTraversal.status === 200 && langTraversal.json.ok === true && langTraversal.json.lang === 'zh-CN',
      '④ lang 也走白名单:穿越串被当作非法值回落,不参与拼路径');

    /* ⑤ 鉴权 */
    const noToken = await request('GET', '/api/help/doc?id=user-guide', undefined, {}, false);
    ok(noToken.status === 403, '⑤ 无 token -> 403(ROUTE_AUTH token 级)');
    const badToken = await request('GET', '/api/help/doc?id=user-guide', undefined, { 'x-wcw-token': 'not-the-token' }, false);
    ok(badToken.status === 403, '⑤ 错 token -> 403');

    /* ⑥ 管理员手册同一通道 */
    const admin = await request('GET', '/api/help/doc?id=admin-guide&lang=zh-CN');
    ok(admin.status === 200 && admin.json.ok === true && admin.json.markdown.includes('# 如意 Ruyi 管理员手册'),
      '⑥ id=admin-guide 走同一条通道');

    /* ⑦ 只读:POST 不被本路由服务 */
    const post = await request('POST', '/api/help/doc?id=user-guide', {});
    ok(post.status !== 200, '⑦ POST 同路径不被本路由服务(status=' + post.status + ')');

    /* 缺文件降级:白名单里的文件不在磁盘上时给 help.doc_missing。
       源码不可改,所以这里不去伪造缺失;改为核对降级分支确实写在源码里,并锁住它给的是
       应用内解释(help.doc_missing),而不是「自己去某个路径打开文件」。 */
    const routerSrc = fs.readFileSync(path.join(WB, 'app', 'src', '13-http-router.js'), 'utf8');
    ok(routerSrc.includes("json({ ok: false, error: 'help.doc_missing', id, lang })"),
      '⑧ 源码含缺文件降级分支 help.doc_missing(精简包不带 docs/ 时不 500)');
    // handler 块 = 从判定行起到本 if 块结束(下一行同缩进的收口花括号)。只在这段里查 path.join 的实参。
    const handlerStart = routerSrc.indexOf("if (req.method === 'GET' && pathname === '/api/help/doc') {");
    const handlerEnd = routerSrc.indexOf('\n  }\n', handlerStart);
    const handlerBlock = handlerStart >= 0 && handlerEnd > handlerStart ? routerSrc.slice(handlerStart, handlerEnd) : '';
    const joinLines = handlerBlock.split(/\r?\n/).filter(l => l.includes('path.join('));
    ok(/const HELP_DOC_FILES = Object\.freeze\(\{/.test(routerSrc)
      && joinLines.length === 1
      && joinLines[0].includes('path.join(helpDocsDir(), fileName)')
      && !/q\.get\(/.test(joinLines[0]),
      '⑧ 白名单是源码常量,handler 里唯一的 path.join 是 (helpDocsDir(), fileName),请求串不参与拼路径');
  } finally {
    try { wb.kill(); } catch { /* already gone */ }
  }

  console.log('\nHELP VIEWER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('HELP VIEWER E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
