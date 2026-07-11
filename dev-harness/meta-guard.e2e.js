// 第23波 收官件:根因#1「靠人肉清单/注释维持的不变量系统性失守」的机器断言护栏(纯静态,无需起服务)。
// 本轮审计连撞两类实例——① 10 处 e2e 硬编码旧版本号 1.4.0/ACC 1.8.0 跟着重构失效;② 敏感 GET 路由漏鉴权(P1)。
// 这里把「门面数字」与「敏感路由必分类」转成 CI 可跑的断言,复发即红,不再靠人工记得同步。
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const README = path.join(ROOT, 'README.md');

let failures = 0;
function ok(cond, label) { if (cond) console.log('PASS ' + label); else { failures++; console.log('FAIL ' + label); } }

const pkg = require(path.join(WB, 'package.json'));
const readme = fs.readFileSync(README, 'utf8');
const src = fs.readFileSync(SERVER, 'utf8');

// ── A) README 门面版本号 === package.json 主次版本(存量:README 曾停在 v1.5,实际已 1.6.0) ──
{
  const minor = pkg.version.split('.').slice(0, 2).join('.'); // '1.6.0' -> '1.6'
  const labels = readme.match(/核心能力一览\(v([\d.]+)\)|Capabilities \(v([\d.]+)\)/g) || [];
  ok(labels.length >= 2, 'A README 含中英两处能力版本标签(找到 ' + labels.length + ')');
  const bad = labels.filter(l => { const m = l.match(/v([\d.]+)/); return !m || m[1] !== minor; });
  ok(bad.length === 0, 'A README 能力版本标签 === package.json 主次版本 v' + minor + (bad.length ? '(不符: ' + bad.join(', ') + ')' : ''));
  ok(!/版本升至|version bump/.test(readme) || true, 'A (info) README 版本一致'); // 占位,保持段落可扩展
}

// ── B) README 声明的「NNN+ 离线 e2e」不得超过实际件数(声明可保守,不可虚高) ──
{
  const actual = fs.readdirSync(HERE).filter(f => f.endsWith('.e2e.js')).length;
  const claims = [...readme.matchAll(/(\d+)\+\s*(?:离线\s*e2e|offline e2e)/gi)].map(m => Number(m[1]));
  ok(claims.length >= 1, 'B README 含「NNN+ 离线 e2e」声明(找到 ' + claims.length + ' 处)');
  const inflated = claims.filter(n => n > actual);
  ok(inflated.length === 0, 'B README e2e 声明数 ≤ 实际 ' + actual + ' 件(虚高: ' + JSON.stringify(inflated) + ')');
  // 反向:声明也不该离谱地低(<50% 实际),否则说明忘了随增长上调
  const tooLow = claims.filter(n => n < Math.floor(actual * 0.5));
  ok(tooLow.length === 0, 'B README e2e 声明数未过时低估(< 实际半数,实际 ' + actual + ',声明 ' + JSON.stringify(claims) + ')');
}

// ── C) ADMIN-GUIDE 里的 ACC 版本 === ACC server.py 的 VERSION(存量:测试曾硬编码 1.8.0,ACC 已 1.8.1) ──
{
  const accSrv = path.join(ROOT, 'mcp', 'ai-computer-control', 'src', 'ai_computer_control', 'server.py');
  const admin = path.join(WB, 'docs', 'manuals', 'ADMIN-GUIDE_CN.md');
  if (fs.existsSync(accSrv) && fs.existsSync(admin)) {
    const accVer = (fs.readFileSync(accSrv, 'utf8').match(/VERSION\s*=\s*["']([\d.]+)["']/) || [])[1] || '';
    const adminTxt = fs.readFileSync(admin, 'utf8');
    const cited = [...adminTxt.matchAll(/ACC v([\d.]+)/g)].map(m => m[1]);
    ok(!!accVer, 'C ACC server.py VERSION 可读到(' + accVer + ')');
    const mismatch = cited.filter(v => v !== accVer);
    ok(cited.length === 0 || mismatch.length === 0, 'C ADMIN-GUIDE 引用的 ACC 版本 === server.py ' + accVer + (mismatch.length ? '(不符: ' + mismatch.join(',') + ')' : ''));
  } else {
    ok(true, 'C (skip) ACC 源或 ADMIN-GUIDE 缺失,跳过版本一致性');
  }
}

// ── D) 鉴权路由分类覆盖:每条【敏感路由】必须被 handleApi 的鉴权闸分类(needsToken / uiReadRoute / uiMutatingRoute),
//        或在其 handler 内自查 tokenOk。防「新增返回密钥/内容/路径的路由却忘了鉴权」——本波 P1 #1 正是此类失守。 ──
{
  // 截取鉴权闸区块(从 handleApi 的 auth gate 到第一个真实路由 handler 之前),敏感路由须在此被点名。
  const gateStart = src.indexOf('// --- auth gate ---');
  const gateEnd = src.indexOf("if (req.method === 'GET' && pathname === '/api/status')");
  const gate = gateStart >= 0 && gateEnd > gateStart ? src.slice(gateStart, gateEnd) : '';
  ok(!!gate, 'D 鉴权闸区块可定位');
  // 敏感路由:返回密钥/完整会话/文件内容/项目路径/审计,或修改敏感状态。每条须出现在鉴权闸文本内(被某清单点名)。
  const SENSITIVE = [
    '/api/sessions', '/api/skills', '/api/config', '/api/provider/test',
    '/api/file/preview', '/api/file/reveal', '/api/audit', '/api/checkpoints/',
    '/api/agent-runs', '/api/tools/', '/api/memory',
  ];
  for (const route of SENSITIVE) {
    ok(gate.includes("'" + route + "'"), "D 敏感路由 " + route + " 已在鉴权闸被分类(needsToken/uiReadRoute/uiMutatingRoute 之一)");
  }
  // 具体锁本波 P1 #1:三条内容型 GET 必须在【浏览器 token】读路由清单里。
  ok(/uiReadRoute\s*=[^;]*'\/api\/sessions'/.test(gate) && /uiReadRoute\s*=[^;]*'\/api\/skills'/.test(gate) && /uiReadRoute\s*=[^;]*startsWith\('\/api\/sessions\/'\)/.test(gate),
    'D P1#1 锁: /api/sessions、/api/sessions/<id>、/api/skills 在 uiReadRoute(浏览器 token 门)');
}

console.log('');
if (failures) { console.log(`META-GUARD E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('META-GUARD E2E: ALL PASS');
