#!/usr/bin/env node
// 静态锁(第 103 波 103a): 路由清册单一事实源防漂移。
// route-inventory.js 把 ROUTE_AUTH(01-config.js)与 handleApi/域路由判定点(13*)扫成
// docs/architecture/route-inventory.{json,md};本件【独立重算】并逐字节比对提交件 ——
// 改了路由/鉴权而没跑生成器,这里即红(同 facts.json 的 46f 纪律)。
// 另锁三条不变量:
//   (1) 双向校验零漂移(鉴权→handler 无死行;handler→鉴权无 403 死路由)——生成器已算,这里复核;
//   (2) deny-by-default:合成未知路由经 ROUTE_AUTH 首配模拟必须落空(authorizeRoute 的兜底 403);
//   (3) 关键端点的鉴权级别不降级:bootstrap 保持 open、contract 决策端点保持 token、
//       全局 interventions 聚合保持 token-browser(75b/56 波既定等级,降级 = 安全回归)。
'use strict';
const fs = require('fs');
const path = require('path');
const { computeInventory, canonical, renderMarkdown, withStableTimestamp, authFirstMatch, JSON_PATH, MD_PATH } = require('./route-inventory.js');

const ROOT = path.resolve(__dirname, '..');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const inv = computeInventory();
ok(inv.summary.decisionPoints > 0 && inv.summary.routeAuthEntries > 0,
  `重算非空: ${inv.summary.decisionPoints} 判定点 / ${inv.summary.routeAuthEntries} 鉴权行`);

// (1) 双向交叉校验(死鉴权行 / 403 死路由)。
ok(inv.problems.length === 0, `双向校验零漂移(problems=${inv.problems.length})${inv.problems.length ? ' :: ' + inv.problems[0] : ''}`);

// 提交件逐字节比对(剥 generatedAt):改了源码没重生成即红。
let committed = null;
try { committed = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch { /* null */ }
ok(!!committed && committed.schema === 1, 'docs/architecture/route-inventory.json 存在且 schema=1(不存在则跑 node dev-harness/route-inventory.js)');
if (committed) {
  ok(canonical(committed) === canonical(inv),
    'route-inventory.json 与源码重算逐字节一致(漂移则跑 node dev-harness/route-inventory.js)');
}
ok(fs.existsSync(MD_PATH), 'docs/architecture/route-inventory.md 存在(人读表随 JSON 一起生成)');
// 架构还债批 2:清册不再记 app/src 行号(锚 = 文件 + handler 函数名),人读表也就能逐字节锁住了 ——
// 以提交件的 generatedAt 重渲染,必须与提交的 .md 一致(只改 JSON 不改 MD、或手改 MD 都会红)。
if (committed && fs.existsSync(MD_PATH)) {
  ok(fs.readFileSync(MD_PATH, 'utf8') === renderMarkdown(withStableTimestamp(inv, committed)),
    'route-inventory.md 与重算逐字节一致(漂移则跑 node dev-harness/route-inventory.js)');
}
const lineFields = JSON.stringify(committed || {}).match(/"line"\s*:/g) || [];
ok(lineFields.length === 0, `route-inventory.json 不含 app/src 行号字段(实得 ${lineFields.length} 处;行号入库会让加一行注释就漂移)`);

// (2) deny-by-default:未知路由首配必须落空(authorizeRoute 落空即 403)。
ok(authFirstMatch(inv.routeAuth, 'GET', '/api/__definitely-unknown-route__') === null
  && authFirstMatch(inv.routeAuth, 'POST', '/api/__definitely-unknown-route__') === null,
  'deny-by-default: 合成未知 /api 路由无首配(落空 = 运行期 403)');

// (3) 关键端点鉴权级别不降级(级别收紧是允许的演进,降级是安全事故)。
const levelAt = (method, p) => { const h = authFirstMatch(inv.routeAuth, method, p); return h ? h.auth : 'DENY'; };
ok(levelAt('POST', '/api/bootstrap') === 'open', 'POST /api/bootstrap 保持 open(47c 浏览器握手唯一通道)');
ok(levelAt('POST', '/api/missions/m_x/interventions/iv_x/decision') === 'token', 'contract 决策端点保持 token(75b)');
ok(levelAt('GET', '/api/interventions') === 'token-browser', 'GET /api/interventions 保持 token-browser(56 波)');
ok(levelAt('GET', '/api/sessions') === 'token-browser' && levelAt('DELETE', '/api/sessions/s_x') === 'token-browser',
  'sessions 读/删保持 token-browser');
ok(levelAt('POST', '/api/tools/x') === 'token', 'POST /api/tools/ 前缀保持 token');
ok(levelAt('POST', '/api/overlay/rollback') === 'token', 'overlay 回滚保持 token(53b 破坏性档)');

console.log(fail ? `\nROUTE INVENTORY STATIC E2E: FAIL (${fail})` : '\nROUTE INVENTORY STATIC E2E: ALL PASS');
process.exit(fail ? 1 : 0);
