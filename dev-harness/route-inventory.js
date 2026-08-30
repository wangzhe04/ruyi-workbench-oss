#!/usr/bin/env node
// 路由清册生成器(第 103 波 103a · 路由与 command surface 收敛)。
//
// 为什么存在(23 号方案 §2 103a):ROUTE_AUTH(01-config.js)声明鉴权、handleApi/域路由(13*)用 if 链匹配
// handler,两张事实源各自演进会漂移 —— 新增路由忘登记鉴权 = deny-by-default 死路由;删了 handler 留鉴权行
// = 死配置。本生成器把「鉴权表 + handler 判定点」机械扫成一份可生成/可校验的清册:
//   · docs/architecture/route-inventory.json —— 机器可读(method/路径形态/auth/handler 位置/域/测试覆盖);
//   · docs/architecture/route-inventory.md  —— 人读表(按域分组)。
// route-inventory.static.e2e.js 独立重算并与提交件逐字节比对,漂移即红(同 facts.json 的 46f 纪律)。
//
// 扫描口径(只认现行代码风格,出现新写法时宁可报错也不猜):
//   · 精确:  pathname === '/api/...'(含 u.pathname === '/health' 顶层探活);
//   · 前缀:  pathname.startsWith('/api/...');
//   · 正则:  pathname.match(/^...$/) —— 需在 REGEX_ROUTE_SAMPLES 登记代表路径(用于鉴权首配模拟);
//   · 方法改写: x-http-method === 'DELETE'/'PATCH' 记为 wire POST + 原生 DELETE/PATCH 双通道;
//   · 块内分派: 条件里没有 req.method 时(如 /api/sessions/ 前缀块),扫 if 块体内的 req.method === 'X'。
// 双向交叉校验:
//   (1) 鉴权→handler:每条 ROUTE_AUTH 至少命中一个判定点(死鉴权行 = 漂移);
//   (2) handler→鉴权:每个判定点每个 wire 方法都被 ROUTE_AUTH 首配命中(否则运行期 403 死路由)。
//
// 用法: node dev-harness/route-inventory.js          # 重算并覆写 docs/architecture/route-inventory.{json,md}
//       node dev-harness/route-inventory.js --check  # 只校验不写文件(静态门用;也可直接 require computeInventory)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const OUT_DIR = path.join(ROOT, 'docs', 'architecture');
const JSON_PATH = path.join(OUT_DIR, 'route-inventory.json');
const MD_PATH = path.join(OUT_DIR, 'route-inventory.md');

// 路由判定点所在模块(顺序即 manifest 声明顺序;13e 只有索引助手、无判定点,扫出来是空,保留在口径里防漏)。
const ROUTER_FILES = [
  '13-http-router.js',
  '13b-api-domain-routes.js',
  '13c-overlay-routes.js',
  '13d-core-domain-routes.js',
  '13e-pretender-index.js',
];
const ROUTE_AUTH_FILE = '01-config.js';

// 正则路由的代表路径(鉴权首配模拟用):key = 正则源码原文,value = 具体化样例路径。
// 新增正则路由而不登记样例 -> 生成器直接报错,指路此处。
const REGEX_ROUTE_SAMPLES = {
  '^\\/api\\/missions\\/([^/]+)\\/interventions\\/([^/]+)\\/decision$': '/api/missions/:missionId/interventions/:interventionId/decision',
};

// 域归属:按 handler 所在函数名归域(与 23 号方案 103a「按域分批」的批次单位一致)。
const DOMAIN_BY_HANDLER = [
  ['handleMcpApiRoutes', 'mcp'],
  ['handleCheckpointApiRoutes', 'checkpoint-storage'],
  ['handleSteerApiRoute', 'steer'],
  ['handleOverlayApiRoutes', 'overlay'],
  ['handleSessionApiRoutes', 'session'],
  ['handleMissionsApiRoutes', 'mission'],
  ['handleInterventionApiRoutes', 'intervention'],
  ['handleAgentRunApiRoutes', 'agent-run'],
];
const DOMAIN_BY_FILE = {
  '13-http-router.js': 'core-inline',
  '13b-api-domain-routes.js': 'mcp/checkpoint-storage/steer',
  '13c-overlay-routes.js': 'overlay',
  '13d-core-domain-routes.js': 'core-domain',
  '13e-pretender-index.js': 'pretender-index',
};

// ─────────────────────────────────────────────────────────────────────────────
// 解析 ROUTE_AUTH(01-config.js 的字面量数组,每条单行:{ m, p, auth[, prefix] })。
// ─────────────────────────────────────────────────────────────────────────────
function parseRouteAuth(srcText) {
  const start = srcText.indexOf('const ROUTE_AUTH = [');
  if (start < 0) throw new Error('未找到 const ROUTE_AUTH = [ —— 01-config.js 结构变了,先更新生成器口径');
  const end = srcText.indexOf('\n];', start);
  if (end < 0) throw new Error('ROUTE_AUTH 数组未闭合(找不到 \\n];)');
  const block = srcText.slice(start, end);
  const entries = [];
  const re = /\{\s*m:\s*'([^']+)',\s*p:\s*'([^']+)',\s*auth:\s*'([^']+)'(?:\s*,\s*prefix:\s*(true|false))?\s*\}/g;
  let m;
  while ((m = re.exec(block))) {
    entries.push({ m: m[1], p: m[2], auth: m[3], prefix: m[4] === 'true' });
  }
  if (!entries.length) throw new Error('ROUTE_AUTH 解析出 0 条 —— 条目写法变了,先更新生成器口径');
  return entries;
}

// authorizeRoute 首配语义的纯函数复刻(01-config.js):method 归一(HEAD→GET)、m '*' 通配、prefix startsWith。
function authFirstMatch(routeAuth, method, pathname) {
  const m = method === 'HEAD' ? 'GET' : method;
  for (const r of routeAuth) {
    if (r.m !== '*' && r.m !== m) continue;
    const match = r.prefix ? pathname.startsWith(r.p) : pathname === r.p;
    if (match) return r;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫单个路由文件的判定点。
// ─────────────────────────────────────────────────────────────────────────────
function stripStringsAndComments(line, inBlock) {
  // 粗略但够用:去 // 行注释与 '...' "..." `...` 内容,防字符串里的花括号干扰深度计数。
  let out = '', i = 0, quote = null;
  while (i < line.length) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function blockText(lines, startIdx) {
  // 从判定点行起按花括号深度圈出整个 if 块(用于找块内方法分派/纵深自查)。
  let depth = 0, started = false;
  const body = [];
  for (let i = startIdx; i < lines.length; i++) {
    const clean = stripStringsAndComments(lines[i]);
    for (const ch of clean) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    body.push(lines[i]);
    if (started && depth <= 0) break;
  }
  return body.join('\n');
}

function enclosingFunction(lines, idx) {
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/^(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/) || lines[i].match(/^const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/);
    if (m) return m[1];
  }
  return '(top-level)';
}

function methodsFromText(text) {
  const wire = new Set();
  for (const m of text.matchAll(/req\.method\s*===\s*'([A-Z]+)'/g)) wire.add(m[1]);
  // 方法改写约定:POST + x-http-method: DELETE/PATCH 与原生 DELETE/PATCH 走同一 handler。
  for (const m of text.matchAll(/x-http-method'\]\s*===\s*'([A-Z]+)'/g)) wire.add(m[1]);
  // 405 反向守卫(`req.method !== 'POST'` -> method not allowed):排除法声明的方法也算服务面。
  if (/method not allowed/.test(text)) {
    for (const m of text.matchAll(/req\.method\s*!==\s*'([A-Z]+)'/g)) wire.add(m[1]);
  }
  return [...wire].sort();
}

function scanRouterFile(fileName) {
  const text = fs.readFileSync(path.join(SRC, fileName), 'utf8');
  const lines = text.split('\n');
  const points = [];
  const delegations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (line.includes('return await handleApi(')) continue; // 顶层 /api/ 分派行,不是路由判定点

    // 域路由委派行(handleApi -> 域 handler),记录为域入口。
    const dm = line.match(/await\s+(handle[A-Za-z]+ApiRoutes?|handleSteerApiRoute)\s*\(/);
    if (dm && !/^(async\s+)?function/.test(trimmed)) {
      delegations.push({ file: fileName, line: i + 1, target: dm[1] });
    }

    let point = null;
    const exact = line.match(/pathname\s*===\s*'([^']+)'/);
    const prefix = line.match(/pathname\.startsWith\(\s*'([^']+)'\s*\)/);
    const regex = line.match(/pathname\.match\(\s*\/(\^.*?)\/([a-z]*)\s*\)/);
    const suffix = line.match(/pathname\.endsWith\(\s*'([^']+)'\s*\)/);
    if (regex) {
      const sample = REGEX_ROUTE_SAMPLES[regex[1]];
      if (!sample) throw new Error(`${fileName}:${i + 1} 出现未登记的正则路由 /${regex[1]}/ —— 请在 route-inventory.js REGEX_ROUTE_SAMPLES 补代表路径`);
      point = { kind: 'regex', pattern: regex[1], path: sample };
    } else if (prefix) {
      point = { kind: 'prefix', path: prefix[1], ...(suffix ? { suffix: suffix[1] } : {}) };
    } else if (exact) {
      point = { kind: 'exact', path: exact[1] };
    }
    if (!point) continue;

    // 方法集合:条件行优先;条件行没有方法(块内分派)时扫整个 if 块。
    const block = blockText(lines, i);
    let methods = methodsFromText(line);
    if (!methods.length) methods = methodsFromText(block);
    if (!methods.length) methods = ['*']; // 无方法判定 = 任意方法(如 /api/mission 块内再分流)

    points.push({
      ...point,
      file: fileName,
      line: i + 1,
      handler: enclosingFunction(lines, i),
      methods,
      selfChecksToken: /tokenOk\(req\)/.test(block), // handler 内 token 自查(表为主、自查兜底纵深)
      methodOverride: /x-http-method'\]/.test(line) || /x-http-method'\]/.test(block.split('\n')[0]),
    });
  }
  return { points, delegations };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试覆盖列:dev-harness/*.e2e.js + unit/*.test.js 里出现路径字面量即记名(启发式,只读统计)。
// ─────────────────────────────────────────────────────────────────────────────
function coverageMap(points) {
  const HARNESS = path.join(ROOT, 'dev-harness');
  const files = [];
  for (const f of fs.readdirSync(HARNESS)) {
    // 自引用断环:本清册的静态门自身含有路径字面量(鉴权级别断言),计入覆盖会让每次重生成自漂移。
    if (f.endsWith('.e2e.js') && f !== 'route-inventory.static.e2e.js') files.push(path.join('dev-harness', f));
  }
  const unitDir = path.join(HARNESS, 'unit');
  if (fs.existsSync(unitDir)) for (const f of fs.readdirSync(unitDir)) if (f.endsWith('.test.js')) files.push(path.join('dev-harness', 'unit', f));
  const contents = files.map(f => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  const out = new Map();
  for (const p of points) {
    // 正则/前缀用静态前缀做检索针;精确用全路径。针太短(<8)宁可空也不误报。
    const needle = p.kind === 'exact' ? p.path
      : p.kind === 'prefix' ? p.path
        : String(p.path.split(':')[0]).replace(/\/$/, '') + '/';
    if (!needle || needle.length < 8) { out.set(p, []); continue; }
    out.set(p, contents.filter(c => c.text.includes(needle)).map(c => c.f).sort());
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 双向交叉校验(鉴权→handler、handler→鉴权)与结构性告警。
// ─────────────────────────────────────────────────────────────────────────────
function crossCheck(routeAuth, points) {
  const problems = [];
  const warnings = [];

  // (2) handler→鉴权:每个判定点每个 wire 方法必须有首配(非 /api 的 /health 等走 host 门,不在此列)。
  for (const p of points) {
    if (!p.path.startsWith('/api/')) continue;
    for (const method of p.methods) {
      const probe = method === '*'
        ? ['GET', 'POST', 'DELETE', 'PATCH'] // 任意方法判定点:全方法面都必须有首配
        : [method];
      for (const m of probe) {
        const hit = authFirstMatch(routeAuth, m, p.path);
        if (!hit) problems.push(`handler 无鉴权首配(运行期 403 死路由): ${m} ${p.path} (${p.file}:${p.line})`);
      }
    }
  }

  // (1) 鉴权→handler:每条 ROUTE_AUTH 至少命中一个判定点。
  const pointServes = (entry, p) => {
    if (entry.m !== '*' && !p.methods.includes(entry.m) && !p.methods.includes('*')) return false;
    if (p.kind === 'exact' || p.kind === 'regex') return entry.prefix ? p.path.startsWith(entry.p) : entry.p === p.path;
    // prefix 判定点服务 P+ 任意路径:entry 与之有交 = entry.p 以 P 开头或 P 以 entry.p(须为 prefix)开头。
    if (entry.prefix) return entry.p.startsWith(p.path) || p.path.startsWith(entry.p);
    return entry.p.startsWith(p.path);
  };
  for (const entry of routeAuth) {
    if (!points.some(p => pointServes(entry, p))) {
      problems.push(`ROUTE_AUTH 死行(无 handler 命中): ${entry.m} ${entry.p}${entry.prefix ? ' (prefix)' : ''} auth=${entry.auth}`);
    }
  }

  // 结构告警(不阻断,进清册):同方法+同路径重复判定点;鉴权表重复行;首配被前行遮蔽。
  const seen = new Map();
  for (const p of points) {
    if (p.kind !== 'exact') continue;
    for (const m of p.methods) {
      const k = m + ' ' + p.path;
      if (seen.has(k)) warnings.push(`重复精确判定点: ${k} (${seen.get(k)} 与 ${p.file}:${p.line})`);
      else seen.set(k, `${p.file}:${p.line}`);
    }
  }
  const authSeen = new Set();
  for (const r of routeAuth) {
    const k = `${r.m} ${r.p} ${r.prefix ? 1 : 0}`;
    if (authSeen.has(k)) warnings.push(`ROUTE_AUTH 重复行: ${k}`);
    authSeen.add(k);
  }
  return { problems, warnings };
}

function domainOf(point) {
  for (const [fn, domain] of DOMAIN_BY_HANDLER) if (point.handler === fn) return domain;
  return DOMAIN_BY_FILE[point.file] || point.file;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主计算:全部数据派生自源码,结果按 (file,line) 排序保证字节稳定。
// ─────────────────────────────────────────────────────────────────────────────
function computeInventory() {
  const routeAuth = parseRouteAuth(fs.readFileSync(path.join(SRC, ROUTE_AUTH_FILE), 'utf8'));
  const allPoints = [];
  const allDelegations = [];
  for (const f of ROUTER_FILES) {
    const { points, delegations } = scanRouterFile(f);
    allPoints.push(...points);
    allDelegations.push(...delegations);
  }
  allPoints.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // 每个判定点记首配 auth(按 wire 方法逐一;同点多方法 auth 不同则逐方法列出)。
  for (const p of allPoints) {
    p.domain = domainOf(p);
    if (p.path.startsWith('/api/')) {
      const byMethod = {};
      for (const m of p.methods) {
        if (m === '*') {
          const levels = new Set(['GET', 'POST', 'DELETE', 'PATCH'].map(x => { const h = authFirstMatch(routeAuth, x, p.path); return h ? h.auth : 'DENY'; }));
          byMethod['*'] = [...levels].sort().join('|');
        } else {
          const hit = authFirstMatch(routeAuth, m, p.path);
          byMethod[m] = hit ? hit.auth : 'DENY';
        }
      }
      const levels = [...new Set(Object.values(byMethod))];
      p.auth = levels.length === 1 ? levels[0] : byMethod;
    } else {
      p.auth = 'host-gate'; // 顶层 host 门(非 /api,不进 ROUTE_AUTH)
    }
  }

  const coverage = coverageMap(allPoints);
  for (const p of allPoints) p.coveredBy = coverage.get(p) || [];

  const { problems, warnings } = crossCheck(routeAuth, allPoints);
  return {
    schema: 1,
    _comment: '第 103 波 103a 路由清册。由 dev-harness/route-inventory.js 机械生成,route-inventory.static.e2e.js 重算比对。改路由/鉴权后请跑生成器,不要手改本文件。',
    generatedAt: new Date().toISOString(),
    sources: { routeAuth: 'ruyi-workbench/app/src/01-config.js', routers: ROUTER_FILES.map(f => 'ruyi-workbench/app/src/' + f) },
    summary: {
      routeAuthEntries: routeAuth.length,
      decisionPoints: allPoints.length,
      byKind: {
        exact: allPoints.filter(p => p.kind === 'exact').length,
        prefix: allPoints.filter(p => p.kind === 'prefix').length,
        regex: allPoints.filter(p => p.kind === 'regex').length,
      },
      authLevels: [...new Set(allPoints.flatMap(p => typeof p.auth === 'string' ? [p.auth] : Object.values(p.auth).flatMap(v => String(v).split('|'))))].sort(),
      uncoveredPoints: allPoints.filter(p => !p.coveredBy.length).length,
      problems: problems.length,
      warnings: warnings.length,
    },
    routeAuth,
    decisionPoints: allPoints,
    delegations: allDelegations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
    problems,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 人读表(按域分组)。
// ─────────────────────────────────────────────────────────────────────────────
function renderMarkdown(inv) {
  const L = [];
  L.push('# 路由清册(第 103 波 103a · 机器生成)');
  L.push('');
  L.push('> 由 `dev-harness/route-inventory.js` 生成,`route-inventory.static.e2e.js` 重算比对;手改无效。');
  L.push(`> 判定点 ${inv.summary.decisionPoints}(精确 ${inv.summary.byKind.exact} / 前缀 ${inv.summary.byKind.prefix} / 正则 ${inv.summary.byKind.regex}),ROUTE_AUTH ${inv.summary.routeAuthEntries} 条,生成于 ${inv.generatedAt}。`);
  L.push('');
  L.push('鉴权级别:`open` 低敏读 · `origin` 同源 · `token` 始终 token · `token-browser` 浏览器须 token/loopback 须同源 · `body-token` handler 自查 body token · `host-gate` 顶层 host 门(非 /api)。`self` = handler 内另有 tokenOk 纵深自查。');
  L.push('');
  const byDomain = new Map();
  for (const p of inv.decisionPoints) {
    if (!byDomain.has(p.domain)) byDomain.set(p.domain, []);
    byDomain.get(p.domain).push(p);
  }
  for (const [domain, points] of [...byDomain.entries()].sort()) {
    L.push(`## ${domain}(${points.length})`);
    L.push('');
    L.push('| 方法 | 路径 | 形态 | auth | handler | 测试覆盖 |');
    L.push('|---|---|---|---|---|---|');
    for (const p of points) {
      const auth = typeof p.auth === 'string' ? p.auth : Object.entries(p.auth).map(([m, a]) => `${m}:${a}`).join(' ');
      const shown = p.coveredBy.slice(0, 3).map(f => path.basename(f));
      const tests = p.coveredBy.length ? `${shown.join(', ')}${p.coveredBy.length > 3 ? ` 等 ${p.coveredBy.length} 件` : ''}` : '—';
      const self = p.selfChecksToken ? ' self' : '';
      const shownPath = p.suffix ? `${p.path}…${p.suffix}` : p.path;
      L.push(`| ${p.methods.join('/')} | \`${shownPath}\` | ${p.kind} | ${auth}${self} | ${p.file}:${p.line} | ${tests} |`);
    }
    L.push('');
  }
  if (inv.warnings.length) {
    L.push('## 结构告警(不阻断)');
    L.push('');
    for (const w of inv.warnings) L.push(`- ${w}`);
    L.push('');
  }
  L.push('## 域路由委派(handleApi → 域 handler)');
  L.push('');
  for (const d of inv.delegations) L.push(`- ${d.file}:${d.line} → \`${d.target}\``);
  L.push('');
  return L.join('\n');
}

// 比对用规范化:剥 generatedAt,其余逐字节。
function canonical(inv) {
  const { generatedAt, ...rest } = inv;
  return JSON.stringify(rest, null, 2) + '\n';
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const inv = computeInventory();
  if (inv.problems.length) {
    for (const p of inv.problems) console.error('DRIFT ' + p);
    console.error(`\n路由清册交叉校验 FAIL(${inv.problems.length}):鉴权表与 handler 判定点已漂移`);
    process.exit(1);
  }
  if (checkOnly) {
    let committed = '';
    try { committed = canonical(JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))); } catch { committed = ''; }
    if (committed !== canonical(inv)) {
      console.error('route-inventory.json 与源码重算不一致 —— 跑 node dev-harness/route-inventory.js 重新生成');
      process.exit(1);
    }
    console.log(`route-inventory --check OK(${inv.summary.decisionPoints} 判定点 / ${inv.summary.routeAuthEntries} 鉴权行,双向校验无漂移)`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(inv, null, 2) + '\n');
  fs.writeFileSync(MD_PATH, renderMarkdown(inv));
  console.log(`# route-inventory 已生成: ${inv.summary.decisionPoints} 判定点(exact ${inv.summary.byKind.exact}/prefix ${inv.summary.byKind.prefix}/regex ${inv.summary.byKind.regex}),ROUTE_AUTH ${inv.summary.routeAuthEntries} 条,未覆盖判定点 ${inv.summary.uncoveredPoints},告警 ${inv.summary.warnings}`);
  for (const w of inv.warnings) console.log('#   warn: ' + w);
}

if (require.main === module) main();

module.exports = { computeInventory, canonical, authFirstMatch, parseRouteAuth, JSON_PATH, MD_PATH };
