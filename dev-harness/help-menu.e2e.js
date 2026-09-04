'use strict';
/*
 * E2E (第118波 118d): 帮助菜单背后的两条「真动作」通道。
 *
 * 立项理由(§2 UX 红线):不做「给用户一个路径或命令,让他自己去别处打开」的交互。所以
 *   · 「打开数据目录 / 日志目录 / 工作文件夹 / 手册目录」= POST /api/open-path,服务端把资源管理器开出来;
 *   · 「在如意里看日志」= GET /api/logs/tail,等宽只读面板直接显示内容(远程/无图形外壳的机器也能自查)。
 * 这两条通道都碰得到文件系统与进程启动,所以本件把契约与安全边界钉死:
 *
 *   ① open-path 只接受源码枚举 target(data/logs/workspace/manuals),客户端【不能传路径】;
 *   ② 枚举外的一切(空/大小写变体/带尾空格/穿越串/注入样本 data;calc)一律 400,且在拼路径之前就被挡;
 *   ③ workspace 没有会话 cwd 时 400 人话,不去猜一个目录打开;
 *   ④ 无 token / 错 token -> 403(ROUTE_AUTH token 级 + handler 自查);
 *   ⑤ logs/tail 行数上限 2000、下限 1、非数字回落默认,file 只回文件名不回目录;
 *   ⑥ 日志文件不存在时 200 降级 logs.none(前端在应用内解释),不 500 也不回退成给路径;
 *   ⑦ 源码锁:open-path handler 里没有任何「把请求串拼进路径」的写法,枚举表是 Object.freeze 常量。
 *
 * 全离线。判定行:`HELP MENU E2E: ALL PASS`。
 * 注:③ 之后有且只有一次真实的资源管理器打开(target=data),与 artifacts.e2e 的 /api/file/reveal 同一口径。
 */
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-help-menu-e2e');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };
const errCode = json => (json && json.error && typeof json.error === 'object' ? json.error.code : (json && json.error) || '');
// normalizeApiErrorPayload 把 {ok:false,error:'<tag>'} 改写成 {code:'api.request_failed',message:'<tag>'},
// 所以判定标签要先看 message 再看 code(与前端 helpErrorTag 同一口径)。
const errTag = json => { const e = json && json.error; if (!e) return ''; return typeof e === 'string' ? e : String(e.message || e.code || ''); };

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
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, timeout: 20000, headers: h }, res => {
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

    /* ④ 鉴权(先跑,免得后面的用例把没鉴权的动作当成通过) */
    const opNoTok = await request('POST', '/api/open-path', { target: 'data' }, {}, false);
    ok(opNoTok.status === 403, '④ open-path 无 token -> 403');
    const opBadTok = await request('POST', '/api/open-path', { target: 'data' }, { 'x-wcw-token': 'not-the-token' }, false);
    ok(opBadTok.status === 403, '④ open-path 错 token -> 403');
    const logNoTok = await request('GET', '/api/logs/tail?lines=10', undefined, {}, false);
    ok(logNoTok.status === 403, '④ logs/tail 无 token -> 403');
    const logBadTok = await request('GET', '/api/logs/tail?lines=10', undefined, { 'x-wcw-token': 'not-the-token' }, false);
    ok(logBadTok.status === 403, '④ logs/tail 错 token -> 403');

    /* ② 枚举外一律 400(含任务书点名的两个注入样本) */
    const rejects = [
      { target: '../..' },
      { target: 'data;calc' },
      { target: 'data && calc' },
      { target: 'data|calc' },
      { target: '../../../Windows' },
      { target: 'C:/Windows' },
      { target: 'C:\\Windows\\System32' },
      { target: 'DATA' },
      { target: 'data ' },
      { target: ' data' },
      { target: 'data\u0000' },
      { target: 'logs/../..' },
      { target: 'manuals%2F..%2F..' },
      { target: '' },
      { target: 'nope' },
      { target: 123 },
      { target: null },
      { target: ['data'] },
      { target: { toString: 'data' } },
      { path: 'C:/Windows' },       // 旧式「客户端传路径」的形状:根本不被识别
      { dir: 'C:/Windows' },
      {},
    ];
    let rejectOk = true;
    for (const body of rejects) {
      const res = await request('POST', '/api/open-path', body);
      const blocked = res.status === 400 && res.json && res.json.ok === false && errCode(res.json) === 'openPath.target_unknown';
      if (!blocked) { rejectOk = false; console.log('   [open-path leak] ' + JSON.stringify(body) + ' -> ' + res.status + ' ' + res.raw.slice(0, 140)); }
    }
    ok(rejectOk, `② 枚举外的 ${rejects.length} 个样本(含 '../..'、'data;calc'、大小写/空格变体、客户端传路径)全部 400 openPath.target_unknown`);

    /* ③ workspace 没有会话 cwd -> 400 人话(不猜目录) */
    const wsNoSession = await request('POST', '/api/open-path', { target: 'workspace' });
    ok(wsNoSession.status === 400 && errCode(wsNoSession.json) === 'openPath.workspace_missing',
      '③ target=workspace 且无会话 -> 400 openPath.workspace_missing');
    const wsBadSession = await request('POST', '/api/open-path', { target: 'workspace', sessionId: '../../etc' });
    ok(wsBadSession.status === 400 && errCode(wsBadSession.json) === 'openPath.workspace_missing',
      '③ sessionId 穿越串被 safeSessionId 挡掉,退化为「没有会话」而不是拼路径');

    /* ① 合法枚举 -> 真的把资源管理器开出来(与 /api/file/reveal 同一口径:只断言 ok,不验证弹窗) */
    const opData = await request('POST', '/api/open-path', { target: 'data' });
    ok(opData.status === 200 && opData.json && opData.json.ok === true && opData.json.target === 'data',
      '① target=data -> {ok:true,target:"data"}(服务端把资源管理器开出来)');
    ok(!('path' in (opData.json || {})) && !('dir' in (opData.json || {})) && !/[A-Za-z]:\\\\|[A-Za-z]:\//.test(opData.raw),
      '① 成功响应里不含任何绝对路径(界面上不会出现「照着去找」的路径)');

    /* ⑤ logs/tail 契约 */
    const logDefault = await request('GET', '/api/logs/tail');
    ok(logDefault.status === 200 && logDefault.json && logDefault.json.ok === true && Array.isArray(logDefault.json.lines),
      '⑤ logs/tail 默认 -> ok:true + lines 数组');
    ok(logDefault.json.requested === 200 && logDefault.json.maxLines === 2000,
      '⑤ 缺省 200 行,上限声明 2000(前端行数选择器与服务端同值)');
    ok(/^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(String(logDefault.json.file || ''))
      && !String(logDefault.json.file || '').includes('/') && !String(logDefault.json.file || '').includes('\\'),
      '⑤ file 只回文件名不回目录: ' + logDefault.json.file);
    ok(logDefault.json.lines.every(l => typeof l === 'string' && l.length > 0), '⑤ lines 全是非空字符串(空行已过滤)');
    const logHuge = await request('GET', '/api/logs/tail?lines=99999');
    ok(logHuge.status === 200 && logHuge.json.requested === 2000 && logHuge.json.lines.length <= 2000,
      '⑤ lines 超上限被夹到 2000');
    const logZero = await request('GET', '/api/logs/tail?lines=0');
    ok(logZero.status === 200 && logZero.json.requested === 1, '⑤ lines=0 被夹到 1');
    const logNeg = await request('GET', '/api/logs/tail?lines=-50');
    ok(logNeg.status === 200 && logNeg.json.requested === 1, '⑤ lines 负数被夹到 1');
    const logNaN = await request('GET', '/api/logs/tail?lines=abc');
    ok(logNaN.status === 200 && logNaN.json.requested === 200, '⑤ lines 非数字回落默认 200');
    const logInject = await request('GET', '/api/logs/tail?lines=' + encodeURIComponent('10; drop'));
    ok(logInject.status === 200 && logInject.json.requested === 10, '⑤ lines 带尾巴只取前缀数字(parseInt),不进任何路径/命令');
    const logSmall = await request('GET', '/api/logs/tail?lines=3');
    ok(logSmall.status === 200 && logSmall.json.lines.length <= 3, '⑤ lines=3 只回三行以内');
    const logPost = await request('POST', '/api/logs/tail', {});
    ok(logPost.status !== 200, '⑤ POST 同路径不被本路由服务(status=' + logPost.status + ')');

    /* ⑥ 日志文件不存在 -> 200 降级 logs.none */
    // 用改名而不是删除:服务端的写流还开着,Windows 上 delete-pending 的文件仍留在目录列表里,
    // 改名才能真正让「目录里没有 workbench-YYYY-MM-DD.ndjson」这件事成立(等价于精简部署的首启状态)。
    const logsDir = path.join(HOME, 'logs');
    let removed = 0;
    try {
      for (const name of fs.readdirSync(logsDir)) {
        if (/^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) { fs.renameSync(path.join(logsDir, name), path.join(logsDir, name + '.moved')); removed += 1; }
      }
    } catch (e) { console.log('   [logs rename] ' + String(e && e.message || e)); }
    const logGone = await request('GET', '/api/logs/tail?lines=5');
    ok(removed > 0 && logGone.status === 200 && logGone.json && logGone.json.ok === false && errTag(logGone.json) === 'logs.none',
      `⑥ 日志文件不在 -> 200 降级 logs.none(移走 ${removed} 份;实得 ${JSON.stringify(logGone.json)})`);
    ok(!/[A-Za-z]:\\\\|[A-Za-z]:\//.test(logGone.raw), '⑥ 降级响应里也没有路径,前端只能在应用内解释');
    // 上线形状:00-boot 的 normalizeApiErrorPayload 会把 error:'logs.none' 改写成结构化信封,
    // 前端只比字符串就会漏掉降级分支(118a-fix 的 help.doc_missing 正是这么漏的),两边都要认。
    ok(logGone.json && logGone.json.error && typeof logGone.json.error === 'object'
      && logGone.json.error.message === 'logs.none' && logGone.json.error.code === 'api.request_failed',
      '⑥ 降级信封被 normalizeApiErrorPayload 结构化(前端必须按 message/code 判定,不能只比字符串)');
    const publicDir = path.join(WB, 'app', 'public', 'js');
    const menuSrc = fs.readFileSync(path.join(publicDir, 'help-menu.js'), 'utf8');
    const viewerSrc = fs.readFileSync(path.join(publicDir, 'help-viewer.js'), 'utf8');
    ok(menuSrc.includes('export function helpErrorTag(res)') && menuSrc.includes('const tag = helpErrorTag(res);')
      && menuSrc.includes("tag === 'logs.none'") && menuSrc.includes("tag === 'logs.read_failed'")
      && !/res\.error === 'logs\.none'/.test(menuSrc),
      '⑥ 日志面板按 helpErrorTag 判定两条降级分支(不再只比字符串)');
    ok(viewerSrc.includes('export function helpErrorTag(res)') && viewerSrc.includes("helpErrorTag(res) === 'help.doc_missing'")
      && !/if \(res && res\.error === 'help\.doc_missing'\)/.test(viewerSrc),
      '⑥ 手册阅读器的缺文件降级同款修补(118a-fix 遗留的恒不命中已修)');

    /* ⑦ 源码锁:请求串永不进路径 / 枚举是源码常量 */
    const routerSrc = fs.readFileSync(path.join(WB, 'app', 'src', '13-http-router.js'), 'utf8');
    ok(/const OPEN_PATH_TARGETS = Object\.freeze\(\['data', 'logs', 'workspace', 'manuals'\]\);/.test(routerSrc),
      '⑦ OPEN_PATH_TARGETS 是 Object.freeze 的源码枚举');
    const opStart = routerSrc.indexOf("if (req.method === 'POST' && pathname === '/api/open-path') {");
    const opEnd = routerSrc.indexOf('\n  }\n', opStart);
    const opBlock = opStart >= 0 && opEnd > opStart ? routerSrc.slice(opStart, opEnd) : '';
    ok(!!opBlock && !/path\.(join|resolve)\(/.test(opBlock),
      '⑦ open-path handler 内没有任何 path.join/path.resolve(目录只由 openPathTargetDir 的常量映射给出)');
    ok(!!opBlock && !/body\.(path|dir|target)\s*\|\|\s*['"]/.test(opBlock.replace(/typeof \(body && body\.target\)[^\n]*\n/, ''))
      && opBlock.includes('OPEN_PATH_TARGETS.includes(target)'),
      '⑦ target 必须先过 OPEN_PATH_TARGETS.includes,handler 不读任何路径型 body 字段');
    ok(/function openPathTargetDir\(target, session\) \{[\s\S]*?return '';\n\}/.test(routerSrc)
      && /if \(target === 'data'\) return paths\.data;/.test(routerSrc)
      && /if \(target === 'workspace'\) return String\(\(session && session\.cwd\) \|\| ''\);/.test(routerSrc),
      '⑦ 目录映射是四条硬编码分支 + 兜底空串,没有任何字符串拼接');
    ok(/const hits = names\.filter\(n => \/\^workbench-\\d\{4\}-\\d\{2\}-\\d\{2\}\\\.ndjson\$\/\.test\(n\)\)/.test(routerSrc),
      '⑦ 日志文件名在服务端已知目录里按固定正则筛,请求里没有文件名入参');
    // 读失败分支绝不能把 Node 的 ENOENT/EPERM 文本回给前端: 那句话里带着日志文件的绝对路径。
    const logStart = routerSrc.indexOf("if (req.method === 'GET' && pathname === '/api/logs/tail') {");
    const logEnd = routerSrc.indexOf('\n  }\n', logStart);
    const logBlock = logStart >= 0 && logEnd > logStart ? routerSrc.slice(logStart, logEnd) : '';
    ok(!!logBlock && logBlock.includes("error: 'logs.read_failed', maxLines: LOG_TAIL_MAX_LINES")
      && !/detail:/.test(logBlock) && logBlock.includes("kind: 'logs_tail_failed'"),
      '⑦ 读失败只回机器码,e.message(含绝对路径)只进结构化日志,不回前端');
    const authSrc = fs.readFileSync(path.join(WB, 'app', 'src', '01b-route-auth.js'), 'utf8');
    ok(authSrc.includes("{ m: 'POST', p: '/api/open-path', auth: 'token' }")
      && authSrc.includes("{ m: 'GET', p: '/api/logs/tail', auth: 'token' }"),
      '⑦ 两条路由都在 ROUTE_AUTH 表里登记为 token 级');
  } finally {
    try { wb.kill(); } catch { /* already gone */ }
  }

  console.log('\nHELP MENU E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('HELP MENU E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
