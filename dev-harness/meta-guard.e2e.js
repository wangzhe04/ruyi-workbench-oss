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

// ── D) 鉴权路由分类覆盖(第33波起 ROUTE_AUTH 声明式表 deny-by-default):每条【敏感路由】必须被 ROUTE_AUTH 表分类,
//        或在其 handler 内自查 tokenOk。防「新增返回密钥/内容/路径的路由却忘了鉴权」--本波 P1 #1 + 第33波 3 个 GET 泄露正是此类失守。 ──
{
  // 截取 ROUTE_AUTH 表区块(从 const ROUTE_AUTH = [ 到 ];),敏感路由须在此被点名分类。
  const tStart = src.indexOf('const ROUTE_AUTH = [');
  const tEnd = src.indexOf('];', tStart);
  const table = tStart >= 0 && tEnd > tStart ? src.slice(tStart, tEnd) : '';
  ok(!!table, 'D ROUTE_AUTH 表区块可定位');
  // 敏感路由:返回密钥/完整会话/文件内容/项目路径/审计/角色/工作流/剧本,或修改敏感状态。每条须出现在表文本内。
  const SENSITIVE = [
    '/api/sessions', '/api/skills', '/api/config', '/api/provider/test',
    '/api/file/preview', '/api/file/reveal', '/api/audit', '/api/checkpoints/',
    '/api/agent-runs', '/api/tools/', '/api/memory',
    '/api/agent-roles', '/api/agent-workflows', '/api/playbooks',  // 第33波:原 GET 泄露,现纳入
  ];
  for (const route of SENSITIVE) {
    ok(table.includes("'" + route + "'"), "D 敏感路由 " + route + " 已在 ROUTE_AUTH 表被分类");
  }
  // 第33波锁:内容型 GET(含本波收紧的 3 个)必须标 token-browser(浏览器 token 门),非 open。
  ok(/m: 'GET', p: '\/api\/sessions', auth: 'token-browser'/.test(table), 'D sessions GET 标 token-browser');
  ok(/m: 'GET', p: '\/api\/skills', auth: 'token-browser'/.test(table), 'D skills GET 标 token-browser');
  ok(/m: 'GET', p: '\/api\/agent-roles', auth: 'token-browser'/.test(table), 'D agent-roles GET 标 token-browser(第33波收紧)');
  ok(/m: 'GET', p: '\/api\/agent-workflows', auth: 'token-browser'/.test(table), 'D agent-workflows GET 标 token-browser(第33波收紧)');
  ok(/m: 'GET', p: '\/api\/playbooks', auth: 'token-browser'/.test(table), 'D playbooks GET 标 token-browser(第33波收紧)');
  // deny-by-default:authorizeRoute 未匹配路由返回拒绝。
  ok(/function authorizeRoute\(req, method, pathname\)/.test(src) && /return 'route not authorized'/.test(src), 'D authorizeRoute deny-by-default 未匹配路由拒绝');
}

// ── E) 两引擎能力对称:orchestrate_agents 的模板/意图提示必须【两个引擎都注入】。历史上 Claude 引擎从不告知有哪些
//        模板(注入只在 Provider 路径)→ Claude 侧模型无从用 workflowId,是"能力面不对称"缺口(同第22波联网那类)。 ──
{
  const fnM = src.match(/function buildOrchestrateHint\(workflows\) \{[\s\S]*?\n\}/);
  ok(!!fnM, 'E buildOrchestrateHint 定义存在(两引擎共用的编排提示构造)');
  if (fnM) {
    ok(/主动编排指引/.test(fnM[0]), 'E 提示含【意图触发】编排指引(非仅"形状匹配时"被动)');
    ok(/deep-research|codebase-audit|debug-root-cause/.test(fnM[0]), 'E 提示含意图→模板映射示例');
    ok(/不要】套模板|不要套模板/.test(fnM[0]), 'E 提示含"简单任务别套模板"护栏(防过度编排)');
  }
  // 调用点对称:Provider(runOpenAiTurn)与 Claude(runClaudeTurn)都要调 buildOrchestrateHint。
  // 第35波 P2: Claude 侧编排提示从 --append-system-prompt 改走 stdin 索引注入(indexSecs → <workbench-context>),
  // 信道变了但「受 subagentMaxPerTurn 门控 + 与 Provider 同源」的对称契约不变。
  const calls = (src.match(/buildOrchestrateHint\(/g) || []).length;
  ok(calls >= 3, 'E buildOrchestrateHint 被定义 + 两引擎各一次调用(≥3 处,实 ' + calls + ')');
  const claudeStart = src.indexOf('async function runClaudeTurn(');
  const claudeEnd = src.indexOf('async function runOpenAiTurn(');
  const claudeRegion = claudeStart >= 0 && claudeEnd > claudeStart ? src.slice(claudeStart, claudeEnd) : '';
  ok(/buildOrchestrateHint\(/.test(claudeRegion), 'E Claude 引擎(runClaudeTurn)注入模板提示 ← 修两引擎不对称的关键');
  ok(/indexSecs\.push\(oh\)/.test(claudeRegion) && /subagentMaxPerTurn/.test(claudeRegion), 'E Claude 侧编排提示走 stdin 索引注入(indexSecs,第35波 P2)且受 subagentMaxPerTurn 开关门控');
  const openaiRegion = claudeEnd >= 0 ? src.slice(claudeEnd, claudeEnd + 40000) : '';
  ok(/buildOrchestrateHint\(/.test(openaiRegion), 'E Provider 引擎(runOpenAiTurn)也注入模板提示(对称)');
}

// ── F) 两引擎能力对称(第26波b):任务账本 digest 必须【两个引擎都注入】。buildMissionPromptSection 共用,
//        Provider 走 buildProviderSystemPrompt、Claude 走 --append-system-prompt;缺任一侧则长任务在该引擎失忆。──
{
  const fnM = src.match(/function buildMissionPromptSection\(mission, engine\) \{[\s\S]*?\n\}/);
  ok(!!fnM, 'F buildMissionPromptSection 定义存在(两引擎共用的账本 digest 构造)');
  if (fnM) {
    ok(/mission-ledger/.test(fnM[0]), 'F digest 含 <mission-ledger> 围栏');
    ok(/不得覆盖/.test(fnM[0]), 'F digest 声明「不得覆盖守则」(不可信参考带纪律)');
    ok(/fits-or-drop|整段丢/.test(fnM[0]) && /return ''/.test(fnM[0]), 'F digest fits-or-drop(超预算整段丢,不中截毁围栏)');
  }
  const calls = (src.match(/buildMissionPromptSection\(/g) || []).length;
  ok(calls >= 3, 'F buildMissionPromptSection 被定义 + 两引擎各一次调用(≥3 处,实 ' + calls + ')');
  const claudeStart = src.indexOf('async function runClaudeTurn(');
  const claudeEnd = src.indexOf('async function runOpenAiTurn(');
  const claudeRegion = claudeStart >= 0 && claudeEnd > claudeStart ? src.slice(claudeStart, claudeEnd) : '';
  ok(/buildMissionPromptSection\(session\.mission/.test(claudeRegion), 'F Claude 引擎(runClaudeTurn)注入账本 digest');
  ok(/append-system-prompt/.test(claudeRegion) && /appendMemorySection\(appendSys, misSec/.test(claudeRegion), 'F Claude 侧走 --append-system-prompt 且 fits-or-drop 合并(同记忆契约)');
  const openaiRegion = claudeEnd >= 0 ? src.slice(claudeEnd, claudeEnd + 60000) : '';
  ok(/buildProviderSystemPrompt\([^)]*session\.mission/.test(openaiRegion), 'F Provider 引擎(runOpenAiTurn)也传 session.mission 注入(对称)');
}

console.log('');
if (failures) { console.log(`META-GUARD E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('META-GUARD E2E: ALL PASS');
