'use strict';
// 体验门 G-codes 的静态量具:后端会发到前端的稳定失败码里,有多少没有中英文案。
//
// 判据的方向是「宁可漏报,不可误报」——一个码只有同时满足下面两条才记「缺文案」:
//   (一) 它【确实】是后端在出错路径上发出的字面量码(只认整串字面量,拼接出来的码一律不收 → 漏报方向):
//        A 级(HTTP 必达):apiFailure('<码>' 的第一参;apiCode: / apiCode = '<码>'(01-config sendError 只认 apiCode);
//            apiSessionIdInvalid()/apiSessionNotFound() 被调用过 → session.id_invalid/session.not_found;
//            01k 的 fail('<x>') → credential_vault.<x>(该 fail 自带 apiCode)。
//        B 级(隐私码):03a 网关的 fail('<x>') → privacy.<x>;01l 的 fail('<x>') → credential_recovery.<x>;以及内核三文件
//            (01h/01i/01m)之外出错语境中的 'privacy.<x>' 字面量。前端 privacy-failure.js 本来就按码识别这一族。
//            01h/01m 内核的 fail() 码混着纯编程不变量,归 C 级(其中也有用户真能撞上的,如 whitespace_sensitive —— 漏报方向)。
//        C 级(工作数据 / 语义家族,151 点名的 work_data_*、work_data_key.*、semantic.*;另含隐私内核码):出错语境(`code:`、`apiCode:`、
//            `Error(`、`fail(`、`throw` 后的首个字面量)里的整串字面量;只做前缀判断(`.startsWith('work_data.')`)的
//            半截串、以 `.`/`_` 结尾的前缀串都不收。C 级是否每个都真能走到界面没有逐条证实,所以单独计数(见下)。
//   (二) 前端对它【没有】任何可识别的文案通路。以下任一成立就算有文案(都是宽判,方向同上):
//        ① 运行 public/js/api-error-i18n.js 的 createApiErrorPresenter,码命中它的表,且目标键在 zh-CN 与 en-US 都在;
//        ② 运行 public/js/privacy-failure.js 的 privacyFailure(码),返回的 key 在两份 locale 都在;
//        ③ locale(两份都要)里有键 = 码、以「.码」结尾,或「命名空间(去 _ . 小写)+ 末段(原样或驼峰)」能对上;
//        ④ 码的整串字面量出现在 public/ 的任意 .js/.html 里(可能有专门的分支给文案;没去证实,按有算)。
//   ①②是「运行时的值」;③④是读文本的宽判。报告里分开列出 ④ 这一类(「只被提到」),它们可能仍是原样显示码。
//
// 门值 = A 级 + B 级的缺失数(都能证明会到前端);C 级的缺失数另列为 familyMissing,不进门值但写进报告。
// 已知误差:漏掉所有动态拼接的码('work_data_setup.' + suffix 等);④ 会把「代码里出现过但界面仍显示原码」的算成有文案;
// 出错语境的正则也可能把个别非错误用途的字面量收进 C 级(所以 C 级不进门值)。
const fs = require('fs');
const path = require('path');

const CODE = '[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+';

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}
const camel = s => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const nsNorm = s => s.replace(/[_.]/g, '').toLowerCase();

function addCode(map, code, tier, file, how) {
  if (!new RegExp('^' + CODE + '$').test(code)) return;
  if (/[._]$/.test(code)) return;
  const cur = map.get(code) || { code, tiers: new Set(), sources: new Set(), how: new Set() };
  cur.tiers.add(tier); cur.sources.add(file); cur.how.add(how);
  map.set(code, cur);
}

function collectEmitted(srcDir) {
  const emitted = new Map();
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const m of text.matchAll(new RegExp(`\\bapiFailure\\(\\s*(['"])(${CODE})\\1`, 'g'))) addCode(emitted, m[2], 'A', file, 'apiFailure');
    for (const m of text.matchAll(new RegExp(`\\bapiCode\\s*[:=]\\s*(['"])(${CODE})\\1`, 'g'))) addCode(emitted, m[2], 'A', file, 'apiCode');
    if (file !== '00-boot.js') {
      if (/\bapiSessionIdInvalid\(\)/.test(text)) addCode(emitted, 'session.id_invalid', 'A', file, 'apiSessionIdInvalid');
      if (/\bapiSessionNotFound\(\)/.test(text)) addCode(emitted, 'session.not_found', 'A', file, 'apiSessionNotFound');
    }
    // 01h/01m 是 PrivacyCore/正则 worker 的内核:fail() 里混着纯编程不变量(detector_required、ttl_invalid…),到不到得了界面
    // 没法逐条证实,按「宁可漏报」记 C 级(不进门值);03a 网关与 01l 恢复流程跑在请求里,记 B 级。
    const CORE = new Set(['01h-privacy-core.js', '01m-privacy-regex.js', '01i-privacy-rules.js']);
    const prefixedFail = { '01h-privacy-core.js': ['privacy.', 'C'], '01m-privacy-regex.js': ['privacy.', 'C'], '03a-privacy-gateway.js': ['privacy.', 'B'],
      '01k-credential-vault.js': ['credential_vault.', 'A'], '01l-credential-recovery.js': ['credential_recovery.', 'B'] }[file];
    if (prefixedFail) for (const m of text.matchAll(/\bfail\(\s*'([a-z0-9_]+)'/g)) addCode(emitted, prefixedFail[0] + m[1], prefixedFail[1], file, 'fail()');
    // 出错语境:code: / apiCode: / Error( / fail( / throw 后紧跟的字面量。
    const ctx = new RegExp(`(?:\\bcode\\s*:\\s*|\\bapiCode\\s*:\\s*|\\bError\\(\\s*|\\bfail\\(\\s*|\\bthrow\\s+)(['"])(${CODE})\\1`, 'g');
    for (const m of text.matchAll(ctx)) {
      const code = m[2];
      if (code.startsWith('privacy.')) addCode(emitted, code, CORE.has(file) ? 'C' : 'B', file, 'error-context');
      else if (/^work_data/.test(code) || code.startsWith('semantic.')) addCode(emitted, code, 'C', file, 'error-context');
    }
  }
  return emitted;
}

async function coverageTools(publicDir) {
  const zh = flatten(JSON.parse(fs.readFileSync(path.join(publicDir, 'locales', 'zh-CN.json'), 'utf8')));
  const en = flatten(JSON.parse(fs.readFileSync(path.join(publicDir, 'locales', 'en-US.json'), 'utf8')));
  const both = key => zh.has(key) && en.has(key) && String(zh.get(key)).trim() !== '' && String(en.get(key)).trim() !== '';
  // 两个模块都没有 import,按 data: URL 以 ES 模块装入(免得 Node 对无 type 的 .js 先按 CJS 解析再报警告)。
  const esm = file => import('data:text/javascript;charset=utf-8,' + encodeURIComponent(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8')));
  const { createApiErrorPresenter } = await esm('api-error-i18n.js');
  const { privacyFailure } = await esm('privacy-failure.js');
  // t 原样回键;raw 回 null —— 于是 presenter 只在码命中它自己的表时给出键。
  const presenter = createApiErrorPresenter({ t: key => key, apiErrorInfo: e => ({ code: e.code, params: {}, message: '' }), rawApiErrText: () => null, privacyFailure: () => null });
  const keys = [...zh.keys()].filter(k => en.has(k));
  const publicText = [];
  const walk = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'vendor' && ent.name !== 'locales') walk(full); continue; }
      if (/\.(?:js|html)$/.test(ent.name) && !/^(?:api-error-i18n|privacy-failure)\.js$/.test(ent.name)) publicText.push({ file: path.relative(publicDir, full).replace(/\\/g, '/'), text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(publicDir);
  return { zh, en, both, presenter, privacyFailure, keys, publicText };
}

function coveredBy(code, tools) {
  const table = tools.presenter({ code });
  if (table && tools.both(table)) return 'api-error-i18n';
  const pf = tools.privacyFailure(code);
  if (pf && tools.both(pf.key)) return 'privacy-failure';
  const dot = code.indexOf('.');
  const ns = nsNorm(code.slice(0, dot)), tail = code.slice(dot + 1), last = code.slice(code.lastIndexOf('.') + 1);
  for (const key of tools.keys) {
    if (key === code || key.endsWith('.' + code)) return 'locale-key';
    const segs = key.split('.');
    const end = segs[segs.length - 1];
    if ((end === last || end === camel(last) || end === tail || end === camel(tail)) && segs.slice(0, -1).some(s => nsNorm(s) === ns)) return 'locale-key';
  }
  for (const { file, text } of tools.publicText) if (text.includes(`'${code}'`) || text.includes(`"${code}"`) || text.includes('`' + code + '`')) return 'mentioned:' + file;
  return null;
}

async function scanErrorCopy(repoRoot) {
  const srcDir = path.join(repoRoot, 'ruyi-workbench', 'app', 'src');
  const publicDir = path.join(repoRoot, 'ruyi-workbench', 'app', 'public');
  const emitted = collectEmitted(srcDir);
  const tools = await coverageTools(publicDir);
  const rows = [...emitted.values()].map(row => {
    const tier = row.tiers.has('A') ? 'A' : row.tiers.has('B') ? 'B' : 'C';
    return { code: row.code, tier, via: coveredBy(row.code, tools), sources: [...row.sources].sort(), how: [...row.how].sort() };
  }).sort((a, b) => a.tier.localeCompare(b.tier) || a.code.localeCompare(b.code));
  const byTier = {};
  for (const r of rows) {
    const t = byTier[r.tier] || (byTier[r.tier] = { total: 0, covered: 0, mentionedOnly: 0, missing: 0 });
    t.total++;
    if (!r.via) t.missing++;
    else if (r.via.startsWith('mentioned:')) { t.covered++; t.mentionedOnly++; }
    else t.covered++;
  }
  const missing = rows.filter(r => !r.via);
  const byNamespace = {};
  for (const r of missing) {
    const ns = r.code.slice(0, r.code.indexOf('.'));
    const row = byNamespace[ns] || (byNamespace[ns] = { tier: r.tier, count: 0 });
    row.count++;
    if (r.tier < row.tier) row.tier = r.tier;
  }
  return {
    missingByNamespace: Object.fromEntries(Object.entries(byNamespace).sort((x, y) => y[1].count - x[1].count)),
    byTier,
    gateMissing: missing.filter(r => r.tier !== 'C').length,
    familyMissing: missing.filter(r => r.tier === 'C').length,
    missing: missing.map(r => ({ code: r.code, tier: r.tier, sources: r.sources, how: r.how })),
    mentionedOnly: rows.filter(r => r.via && r.via.startsWith('mentioned:')).map(r => ({ code: r.code, tier: r.tier, where: r.via.slice('mentioned:'.length) })),
    localeKeys: { zh: tools.zh.size, en: tools.en.size },
  };
}

module.exports = { scanErrorCopy, collectEmitted };
