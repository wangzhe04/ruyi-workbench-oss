// Unit: 第 129 波 129k(用户 2026-09-20 真机报障:「管家有时候会把自己的工具包装成按钮让用户按,
// 但用户点击后会显示对应工具不能被按钮点击触发」)。
//
// 病根不在某一个工具,在【产出侧不过滤】:
//   · 按钮按下去走 POST /api/steward/act -> stewardRunAct,那里按 STEWARD_ACTION_HOOKS 查实现,
//     查不到就回 `not_allowed: xxx 不能作为 act 执行`(13q:859)——那句话就是用户看到的那一句;
//   · 而 acts 的归一化(stewardNormalizeAct)修前只问「是不是 steward_ 开头」,**不问它能不能被按**。
//   · 13m 那张表的表头早就写明了这个后果(「不进表就是同一种『按了报错』」),但一直没人在产出侧堵。
//
// 为什么不是「给按钮全量权限」(用户给的另一个选项):只读工具当按钮【没有归宿】—— act 的回执是
// 一行「做完了」,没有地方显示一份清单;用户要的那个答案,模型应当在这一回合里直接调工具拿到、
// 写进话里。放开执行只会把「按了报错」换成「按了没反应」。
//
// 覆盖:
//   ① 只读工具提成按钮 -> 丢掉(一枚按不动的按钮都画不出来)
//   ② 写类工具提成按钮 -> 照常保留(没有误伤)
//   ③ open_thread / dismiss 不受影响(它们根本不查那张表)
//   ④ 非 steward_ 工具仍然进不来(既有闸没被这一刀弄松)
//   ⑤ 全表推导:STEWARD_ACTION_HOOKS 里的每一个键都真的能变成按钮;管家工具里不在表里的
//      每一个都真的变不成按钮 —— 钉的是不变量,不是我手挑的那两个例子。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-actbtn-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// 经【真的那条路】拿 acts:模型的回复原文 -> stewardParseReply -> acts。不直接戳归一化函数,
// 免得测的是一个产线上没人走的入口。
const actsOf = acts => {
  const parsed = srv.stewardParseReply(JSON.stringify({ say: '看看', why: '', acts, actions: [] }));
  return (parsed && Array.isArray(parsed.acts)) ? parsed.acts : [];
};
const toolNames = list => list.filter(a => a.kind === 'tool').map(a => a.tool);

/* ① 只读工具不许变成按钮 */
{
  const out = actsOf([
    { label: '看清单', kind: 'tool', tool: 'steward_threads_search', args: { q: 'x' } },
    { label: '看定时', kind: 'tool', tool: 'steward_schedule_list', args: {} },
  ]);
  ok(out.length === 0, `① 只读工具提成按钮 -> 一枚都不画(实得 ${JSON.stringify(toolNames(out))})`);
}

/* ② 写类工具照常保留 —— 这一刀不许误伤真按钮 */
{
  const out = actsOf([{ label: '接着办', kind: 'tool', tool: 'steward_thread_continue', args: { sessionId: 'sess_x', message: '继续' } }]);
  ok(out.length === 1 && out[0].tool === 'steward_thread_continue', `② 写类工具照常是按钮(实得 ${JSON.stringify(toolNames(out))})`);
}

/* ③ 另外两种 kind 不查那张表 */
{
  const out = actsOf([
    { label: '打开', kind: 'open_thread', sessionId: 'sess_abc' },
    { label: '知道了', kind: 'dismiss' },
  ]);
  ok(out.length === 2 && out[0].kind === 'open_thread' && out[1].kind === 'dismiss',
    `③ open_thread / dismiss 不受影响(实得 ${JSON.stringify(out.map(a => a.kind))})`);
}

/* ④ 既有的那道闸没被弄松 */
{
  const out = actsOf([{ label: '写文件', kind: 'tool', tool: 'file_write', args: { path: 'x' } }]);
  ok(out.length === 0, '④ 非 steward_ 的工具仍然一个都进不来(动世界的工具永远不能是管家按钮)');
}

/* ⑤ 全表推导:不挑例子,把两边都跑一遍 */
{
  const src13m = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '13m-steward-runner-base.js'), 'utf8');
  const block = src13m.slice(src13m.indexOf('const STEWARD_ACTION_HOOKS'), src13m.indexOf('const STEWARD_ACTION_HOOKS') + 2600);
  const inTable = [...block.matchAll(/^\s{2}(steward_[a-z_]+):/gm)].map(m => m[1]);
  ok(inTable.length >= 15, `⑤0 扫得到 act 表(实得 ${inTable.length} 个键;扫不到 = 本条静默失效)`);
  const rejected = inTable.filter(tool => actsOf([{ label: 'x', kind: 'tool', tool, args: {} }]).length !== 1);
  ok(rejected.length === 0, `⑤ 表里的每一个工具都真的能变成按钮(变不成的:${JSON.stringify(rejected)})`);

  const src13f = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '13f-native-tool-schemas.js'), 'utf8');
  const allTools = [...new Set([...src13f.matchAll(/name:\s*'(steward_[a-z_]+)'/g)].map(m => m[1]))];
  ok(allTools.length >= 30, `⑤1 扫得到管家工具全集(实得 ${allTools.length} 个;扫不到 = 本条静默失效)`);
  const outside = allTools.filter(t => !inTable.includes(t));
  ok(outside.length >= 10, `⑤2 表外确实有一批工具(实得 ${outside.length} 个;否则下一条无话可说)`);
  const leaked = outside.filter(tool => actsOf([{ label: 'x', kind: 'tool', tool, args: {} }]).length !== 0);
  ok(leaked.length === 0, `⑤3 表外的每一个工具都变不成按钮(漏出来的:${JSON.stringify(leaked)})`);
}

console.log(fail === 0 ? 'STEWARD ACT BUTTONS UNIT: ALL PASS' : `STEWARD ACT BUTTONS UNIT: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
