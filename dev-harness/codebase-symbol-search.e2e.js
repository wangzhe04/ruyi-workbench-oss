(async () => {
// E2E (M5 候选 D 波): codebase_symbol_search 符号定义/引用检索的行为直测。
// 直调 /api/tools/codebase_symbol_search(UI-token 路径,无 provider)。覆盖:
//   (a) 定义/引用分类:function/def 定义 vs 调用引用
//   (b) 符号转义:含正则元字符的 symbol 不崩(字面匹配兜底)
//   (c) kind 过滤:definition-only / reference-only
//   (d) files[] 文件级聚合
//   (e) note 诚实标注 grep 级
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-codebase-symbol-search-e2e');
const WORK = path.join(HOME, 'work');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.join(WORK, 'sub'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 6, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WORK,
}, null, 2));
// Seed: JS function def + calls, and a nested Python def + call (cross-language + subdirectory walk).
fs.writeFileSync(path.join(WORK, 'seed.js'), [
  'function foo() {',
  '  return 1;',
  '}',
  '',
  'function bar() {',
  '  return foo() + 2;',
  '}',
  '',
  'const baz = foo(3);',
  'const $dollarVar = 1;',
].join('\n'));
fs.writeFileSync(path.join(WORK, 'sub', 'nested.py'), [
  'def calc_total(x, y):',
  '    return x + y',
  '',
  'def helper():',
  '    return calc_total(1, 2)',
].join('\n'));
// Seed: 工作区外目录(对抗验证 HIGH 收口) —— 越界 root 应被工作区读闸拒绝。
const OUTSIDE = path.join(os.tmpdir(), 'wcw-codebase-symbol-search-OUTSIDE');
fs.rmSync(OUTSIDE, { recursive: true, force: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.js'), 'const secretKey = "abc";\n');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function tool(port, token, name, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/tools/' + name, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error('bad json: ' + b)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    // (a) JS: symbol=foo → 1 function definition (line 1) + 2 references (lines 6, 9).
    const a = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: 'foo' })).result;
    ok(a && a.ok === true, '(a) foo → ok:true, err=' + (a && a.error));
    ok(a && a.definitionCount === 1, '(a) foo definitionCount=1 (got ' + (a && a.definitionCount) + ')');
    ok(a && a.definitions && a.definitions.length === 1 && a.definitions[0].kind === 'function' && a.definitions[0].line === 1, '(a) foo 定义为 function@line1');
    ok(a && a.referenceCount === 2, '(a) foo referenceCount=2 (got ' + (a && a.referenceCount) + ')');
    ok(a && Array.isArray(a.files) && a.files.some(f => f.relativePath === 'seed.js' && f.definitions === 1 && f.references === 2), '(d) files[] 文件级聚合:seed.js def=1 ref=2');

    // (b) regex metacharacter symbol must not crash (escaped to literal).
    const b = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: '(' })).result;
    ok(b && b.ok === true, '(b) 元字符 symbol=(\u0028 不崩(转义为字面), err=' + (b && b.error) + ')');

    // (c) kind filtering.
    const c1 = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: 'foo', kind: 'definition' })).result;
    ok(c1 && c1.ok === true && c1.definitionCount === 1 && c1.referenceCount === 0, '(c) kind=definition 只返回定义(def=1 ref=0)');
    const c2 = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: 'foo', kind: 'reference' })).result;
    ok(c2 && c2.ok === true && c2.definitionCount === 0 && c2.referenceCount === 2, '(c) kind=reference 只返回引用(def=0 ref=2)');
    ok(c1 && Array.isArray(c1.files) && c1.files.every(f => f.references === 0), '(c) kind=definition 时 files[].references 全 0(与顶层 referenceCount=0 一致)');

    // (a2) cross-language + subdirectory: Python `def calc_total` + one call.
    const a2 = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: 'calc_total' })).result;
    ok(a2 && a2.ok === true && a2.definitionCount === 1 && a2.referenceCount === 1, '(a2) Python def calc_total:def=1 ref=1 (子目录遍历)');
    ok(a2 && a2.definitions && a2.definitions[0] && a2.definitions[0].kind === 'function' && /nested\.py$/.test(a2.definitions[0].relativePath), '(a2) calc_total 定义为 function 且位于 nested.py');

    // (e) honesty note present.
    const e = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: 'nope_missing_symbol' })).result;
    ok(e && e.ok === true && e.definitionCount === 0 && e.referenceCount === 0, '(e) 不存在的符号返回 0 命中(不幻觉)');
    ok(a && typeof a.note === 'string' && /grep-level/.test(a.note), '(e) note 诚实标注 grep-level');

    // (g) 越界 root 拒绝(对抗验证 HIGH 收口): 无 provider/远端模型越界读任意代码文件内容被工作区读闸拒绝。
    const g = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: OUTSIDE, symbol: 'secretKey' })).result;
    ok(g && g.ok === false && g.code === 'not-allowed', '(g) 越界 root 被工作区读闸拒绝(code=not-allowed, got ' + (g && g.code) + ')');
    // (h) 含 $ 元字符的符号字面精确匹配(非仅"不崩")。
    const h2 = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: '$dollarVar' })).result;
    ok(h2 && h2.ok === true && h2.definitionCount === 1 && h2.definitions && h2.definitions[0] && h2.definitions[0].kind === 'variable', '(h) $dollarVar → variable 定义(字面转义精确命中)');

    // (f) invalid args rejected with a human error.
    const f1 = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK })).result;
    ok(f1 && f1.ok === false && /symbol/.test(f1.error || ''), '(f) 缺 symbol 被人话拒绝');
    const f2 = (await tool(WB_PORT, token, 'codebase_symbol_search', { root: WORK, symbol: 'foo', kind: 'bogus' })).result;
    ok(f2 && f2.ok === false && /kind/.test(f2.error || ''), '(f) 非法 kind 被人话拒绝');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCODEBASE-SYMBOL-SEARCH E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
