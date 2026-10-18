'use strict';
require('./lib/self-isolate-home');
// 官方 2026-10-17 Search/Fetch 契约的离线假端点；覆盖普通工具和管家共用配置、分页、错误与缓存。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('DEEPSEEK SEARCH FETCH');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-deepseek-web-'));
process.env.RUYI_HOME = root;
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key];
const s = loadServerInternals(['webSearch', 'webFetch', 'writeConfig', 'readConfig', 'maskSecrets', 'unmaskSecrets', 'normalizeConfig', 'toolCall', 'stewardImplWebSearch', 'stewardImplWebFetch']);
const seen = [];
let mode = 'good', status = 200;
const markdown = '# 完整网页\n\n' + '😀中文正文与引用 https://example.com/source\n'.repeat(100);
const api = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
  res.setHeader('content-type', 'application/json');
  if (mode === 'hang') return;
  if (mode === 'redirect') { res.writeHead(302, { location: '/stolen' }); return res.end('{}'); }
  if (status !== 200) { res.writeHead(status); return res.end(JSON.stringify({ error: { message: 'untrusted remote error body' } })); }
  if (mode === 'html') { res.setHeader('content-type', 'text/html'); return res.end('<html>login</html>'); }
  if (mode === 'bad') return res.end('{}');
  if (req.url.endsWith('/search')) return res.end(JSON.stringify({ results: mode === 'empty' ? [] : [{ title: '官方资料', url: 'https://example.com/source', snippet: '短摘要', summary: '给模型的长摘要', date: '2026-10-17T00:00:00Z' }, null] }));
  res.end(JSON.stringify({ title: '网页标题', content: markdown }));
});
const ctx = () => ({ session: { id: 'web-test', cwd: root }, config: { permissionMode: 'default' } });
(async () => {
  try {
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${api.address().port}`;
    const cfg = { ...(await s.readConfig()), searchBackendMigrated: true, searchBackend: { type: 'deepseek', baseUrl: base + '/v1/', apiKey: 'deepseek-test-secret' } };
    await s.writeConfig(cfg);
    ok((await s.readConfig()).searchBackend.type === 'deepseek', 'DeepSeek 配置可保存和重新读取');
    const masked = s.maskSecrets(cfg);
    ok(!JSON.stringify(masked).includes('deepseek-test-secret'), '搜索密钥沿用现有遮罩');
    ok(s.unmaskSecrets(masked, cfg).searchBackend.apiKey === cfg.searchBackend.apiKey, '遮罩配置往返不清空密钥');
    ok(s.normalizeConfig({ searchBackend: { type: 'unknown' } }).config.searchBackend.type === 'builtin', '未知后端仍回落默认');
    const result = await s.toolCall('web_search', { query: '如意 site:example.com', maxResults: 3 }, ctx());
    ok(result.ok && result.backend === 'deepseek' && result.results.length === 1 && result.results[0].summary === '给模型的长摘要', '普通搜索工具接入 DeepSeek 并保留摘要');
    ok(seen[0].method === 'POST' && seen[0].url === '/v1/tools/search' && seen[0].auth === 'Bearer deepseek-test-secret', '官方路径、POST 与 Bearer 鉴权正确, /v1 不重复');
    ok(seen[0].body.count === 3 && seen[0].body.need_content === false && seen[0].body.query.includes('site:'), '条数与操作符原样传递,搜索不额外拉全文');
    let count = seen.length;
    const long = await s.webSearch({ query: '😀'.repeat(129) }, cfg);
    ok(!long.ok && seen.length === count, '超出 128 Unicode 字符在本地拒绝');
    ok((await s.webSearch({ query: '😀'.repeat(128) }, cfg)).ok, '128 个非 BMP 字符合法,不按 UTF-16 单元误拒绝');
    const url = 'https://8.8.8.8/article';
    const page = await s.toolCall('web_fetch', { url, maxChars: 500 }, ctx());
    ok(page.ok && page.backend === 'deepseek' && page.title === '网页标题' && page.nextOffset > 0, '普通抓取工具使用 DeepSeek 并保留分页');
    ok(seen.at(-1).url === '/v1/tools/fetch' && seen.at(-1).body.url === url, 'Fetch 只发送目标网址');
    count = seen.length;
    const next = await s.toolCall('web_fetch', { url, maxChars: 500, offset: page.nextOffset }, ctx());
    ok(next.ok && next.fromCache && next.offset === page.nextOffset && seen.length === count, '续页使用完整缓存,不重复付费抓取');
    ok(page.text + next.text === markdown.slice(0, next.nextOffset), '跨页无遗漏、无重复,Unicode 保持完整');
    const eyes = { session: { id: 'steward', turnSeq: 1 } };
    const search = await s.stewardImplWebSearch({ q: '如意' }, eyes, cfg);
    ok(search.ok && search.tainted && search.results[0].snippet === '短摘要', '管家搜索共用 DeepSeek 配置');
    const fetch = await s.stewardImplWebFetch({ url: url + '?steward=1', maxChars: 500 }, eyes, cfg);
    ok(fetch.ok && fetch.backend === 'deepseek' && fetch.tainted && fetch.content.includes('external-content'), '管家 Fetch 共用后端,外部内容保留围栏');
    count = seen.length;
    for (const target of ['http://127.0.0.1/private', 'http://10.0.0.1/secret', 'file:///etc/passwd', 'https://user:pass@8.8.8.8/private']) {
      ok(!(await s.webFetch({ url: target }, { config: cfg })).ok, '拒绝私网、非 HTTP 或带凭据目标: ' + target.split('@').at(-1));
    }
    ok(seen.length === count, '非法目标不外发给 DeepSeek');
    mode = 'empty';
    const empty = await s.webSearch({ query: 'no results' }, cfg);
    ok(empty.ok && empty.results.length === 0, '真实空结果仍成功,不冒充故障');
    for (const st of [400, 401, 402, 403, 404, 429, 500]) {
      status = st; mode = 'good'; count = seen.length;
      const fail = await s.webSearch({ query: 'failure' }, cfg);
      ok(!fail.ok && fail.statusCode === st && seen.length === count + 1 && !JSON.stringify(fail).includes('untrusted remote'), 'HTTP ' + st + ' 如实失败,不泄露响应正文或默认回退');
      const f = await s.webFetch({ url }, { config: cfg });
      ok(st >= 429 ? f.ok && f.fromCache && !!f.staleReason : !f.ok, 'Fetch HTTP ' + st + ' 的缓存回退边界正确');
    }
    status = 200;
    for (const broken of ['html', 'bad', 'redirect']) {
      mode = broken; count = seen.length;
      ok(!(await s.webSearch({ query: 'bad response' }, cfg)).ok && seen.length === count + 1, broken + ' 响应不伪装空结果,不跟随重定向');
      ok(!(await s.webFetch({ url }, { config: cfg })).ok, broken + ' Fetch 不用缓存掩盖契约错误');
    }
    mode = 'hang';
    const abort = new AbortController();
    const pending = s.webFetch({ url }, { config: cfg, signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    const stopped = await pending;
    ok(!stopped.ok && stopped.failClass === 'aborted', '用户取消及时中断 Fetch,不伪装缓存成功');
    const abortSearch = new AbortController();
    const searching = s.webSearch({ query: 'cancel search' }, cfg, { signal: abortSearch.signal });
    setTimeout(() => abortSearch.abort(), 50);
    const cancelled = await searching;
    ok(!cancelled.ok && cancelled.failClass === 'aborted' && !cancelled.fallbackTried, '用户取消也中断 Search,不转发给其它引擎');
    mode = 'good'; count = seen.length;
    ok(!(await s.webSearch({ query: 'missing key' }, { searchBackend: { type: 'deepseek', baseUrl: base } })).ok && seen.length === count, '缺少密钥时不发送请求');
  } catch (error) { t.fail(error.stack); }
  finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
  t.done();
})();
