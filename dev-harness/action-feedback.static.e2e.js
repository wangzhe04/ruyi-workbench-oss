#!/usr/bin/env node
'use strict';
// 128f-⑫ 审计 D／F 里【没有配真浏览器件】的那几处:用户动作成功之后,别的面(右栏页签、设置里的列表、口袋角标、左栏头上的
// 仲裁数)要跟着重读。真浏览器件(action-feedback.browser)钉住了左栏／焦点栏／线程头／中栏／并发上限这几面的【行为】;
// 下面这几处要搭的夹具太重(要一回合真的改过文件、要一条带 undoRef 的管家决策、要一张记忆维护提议卡、要缺清单弹窗、要
// 一条排队中的回合),所以只钉【代码形状】—— 判据是「成功分支所在的那个函数里真的调了那一个重读」,不是「字出现过」:
// 每一条都把范围收到那一个函数体里(花括号配对切出来),并且要求重读排在那一发写请求【之后】。
// 这是比行为件弱的锁:它证明不了屏上真的变了,只证明没有人把那一行删掉。反向:逐条删掉那一行调用 → 对应一条红。
// 判定行:`ACTION FEEDBACK STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const PUB = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public');
const read = rel => fs.readFileSync(path.join(PUB, rel), 'utf8');
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

// 从 marker 往前找最近的函数头(function 名字( 或 名字 = async ( … ) => / 箭头回调),再从它的第一个 { 起配对花括号切出函数体。
function enclosingBody(src, marker, headPattern) {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const heads = [...src.slice(0, at).matchAll(headPattern)];
  if (!heads.length) return '';
  const start = heads[heads.length - 1].index;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}
const FN = /(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/g;
const after = (body, first, second) => body.indexOf(first) >= 0 && body.indexOf(second, body.indexOf(first)) > body.indexOf(first);

const experience = read('js/session-experience.js');
const primitives = read('js/chat-render-primitives.js');
const settings = read('js/steward-settings.js');
const skills = read('js/skills-memory.js');
const provider = read('js/provider-settings.js');
const drawer = read('js/steward-drawer.js');
const board = read('js/steward-board.js');
const stream = read('js/event-stream.js');
const pocket = read('js/rail-pocket.js');
const app = read('app.js');

// D1 中栏「本轮变更」卡上的撤销 → 右栏页签重读(变更那一页开着的话,刚撤掉的那几处当场消失)
{
  const body = enclosingBody(experience, "'/api/checkpoints/rollback'", FN);
  ok(after(body, "'/api/checkpoints/rollback'", 'refreshToolPane()') && after(body, "classList.add('done')", 'refreshToolPane()'),
    'D1 撤销成功之后(按钮已经标成「已撤销」)右栏页签重读');
}
// D2 回溯 → 右栏页签重读(回溯连文件一起退的话「变更」页签要跟上)
{
  const at = primitives.indexOf("'/api/session/rewind'");
  const tail = at >= 0 ? primitives.slice(at, at + 2400) : '';
  ok(after(tail, 'await refreshSessions();', 'refreshToolPane()') && /refreshToolPane = \(\) => \{\},/.test(primitives),
    'D2 回溯成功之后(会话已重读、左栏已刷)右栏页签重读;缺省空实现可注入');
}
// D3 行动流水「撤销」→ 那张表重读(修前那一行仍挂着「撤销」)
{
  const body = enclosingBody(settings, "'/api/session/rewind'", FN);
  ok(/^async function undoDecision\(/.test(body) && after(body, "'/api/session/rewind'", 'await loadDecisions()') && /if \(response\.ok === true\) await loadDecisions\(\);/.test(body),
    'D3 行动流水撤销【成功】之后重读流水表(失败时不重读,那一行保持原样)');
}
// D4 清空管家记忆 → 口袋「记忆·新」角标跟着变(页内广播,口袋订了)
{
  const body = enclosingBody(settings, "'/api/steward/memory/clear'", FN);
  ok(after(body, "'/api/steward/memory/clear'", "publishLocal('steward.memory.changed'") && /settingsEventStream = stream;/.test(settings)
    && /'steward\.memory\.changed'\]\)/.test(pocket),
    'D4 清空记忆之后页内广播 steward.memory.changed,口袋订了它');
}
// D5 记忆维护提议「应用」→ 记忆视图重读
{
  const at = skills.indexOf("'/api/memory/proposal/apply'");
  const tail = at >= 0 ? skills.slice(at, at + 700) : '';
  ok(after(tail, "toast(t('memory.proposal.applied'), 'ok');", 'await refreshMemoryViews();'), 'D5 应用提议成功之后记忆视图重读');
}
// D6 缺清单弹窗「一键应用」→「MCP 运维」那张表重读(它读自己那份缓存,不跟 config 走)
{
  const at = provider.indexOf("'/api/mcp/import-config/apply'");
  const tail = at >= 0 ? provider.slice(at, at + 900) : '';
  ok(after(tail, 'await refreshStatus();', 'refreshMcpOps(false)') && /refreshMcpOps = async \(\) => \{\},/.test(provider)
    && /refreshMcpOps: probe => refreshMcpOps\(probe\),   \/\/ 128f-⑫/.test(app),
    'D6 一键应用成功之后「MCP 运维」重读;组合根把 settings-operations 那一份注入 provider-settings');
}
// D7 组合根把右栏页签重读注入给中栏两处(撤销在 session-experience、回溯在 chat-render-primitives)
ok((app.match(/refreshToolPane: \(\) => refreshToolPane\(\),   \/\/ 128f-⑫/g) || []).length === 2, 'D7 组合根把 refreshToolPane 注入给撤销与回溯两处');
// F2 焦点栏里「停止」→ 左栏头上的仲裁数(排队 N)重读:排队中的回合被停一帧线程推送都没有
{
  const body = enclosingBody(drawer, 'const stopped = await stewardThreadStop({ api, sessionId });', FN);
  ok(/^async function stopThread\(\)/.test(body) && after(body, 'await refreshOnce();', "publishLocal('steward.arbiter.changed'")
    && /drawerEventStream = stream;/.test(drawer)
    && /stream\.on\('steward\.arbiter\.changed', \(\) => \{ void loadArbiter\(\)\.then\(\(\) => \{ renderArbiterFacts\(\); \}\); \}\);/.test(board),
    'F2 焦点栏停掉一条之后页内广播 steward.arbiter.changed,左栏只重读仲裁面这一发');
}
// P 页内广播本身:publishLocal 走的是同一个 emit(与服务端来的同名帧同一批订阅者),不经服务端
ok(/function publishLocal\(name, payload\) \{ return emit\(name, payload\); \}/.test(stream) && /\n    publishLocal,\n/.test(stream),
  'P event-stream 导出 publishLocal = 同一个 emit(页内广播,不经服务端、不进补发环)');

console.log(fail === 0 ? 'ACTION FEEDBACK STATIC E2E: ALL PASS' : `ACTION FEEDBACK STATIC E2E: FAILURES ${fail}`);
process.exit(fail === 0 ? 0 : 1);
