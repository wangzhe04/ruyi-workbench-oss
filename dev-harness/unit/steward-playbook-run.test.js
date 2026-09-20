// Unit: 第 129 波 129h（31 号文 §2.7 放①）—— 管家按 playbook 办事，纯函数那一半。
//
// 「跑一个 playbook」拆开看只有两步：按模板组装一段话 → 开一条线程去办。后一步早就在
// steward_thread_new 里了（带着工作区表、权限档、分档、事项、undoRef、决策账本一整套闸），
// 所以 129h 有意**不新加工具**，只给 brief 加一个 playbook 字段。本件钉前一步：
//
//   ① **组装口径与前端逐字一致**。前端那份 assemblePlaybookPrompt（session-experience.js）是
//      「开始」按钮真正用的那一份；服务端这份是第二份实现（浏览器模块拉不进单文件产物）。
//      两份说不到一起去，就会出现「面板里跑出来是一个样、管家跑出来是另一个样」。
//      本件**不抄第三份镜像**（仓里已经有两份镜像：playbooks.e2e.js:232 与 stream-patch.test.js:42）——
//      直接从前端源码里把那个函数取出来求值，与服务端的逐例对照。钉的是真家伙，不是副本。
//   ② **没给值的参数要点出来**，而且比前端严：弹窗前面坐着用户，他把某格留空是他的选择；
//      管家填空是猜。猜出来的空串会让模板在错的地方动手。
//   ③ **playbook 正文不走「管家补充」那条路**。supplement 预算 1200 字，promptTemplate 上限
//      20000 字 —— 塞进去会被静默截断，线程拿到半条指令还照办，那是最坏的一种错。
//      所以它自成一块、不裁剪，且排在最后（顺序即优先级：用户原话永远在最前）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-pbrun-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

/* ① 与前端逐字同义 —— 取的是前端源码里那一份，不是镜像 */
{
  const src = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'public', 'js', 'session-experience.js'), 'utf8');
  const at = src.indexOf('function assemblePlaybookPrompt(');
  ok(at >= 0, '①0 在前端源码里找得到 assemblePlaybookPrompt（找不到 = 本条静默失效）');
  // 函数体到下一个第 0 列的 `}` 为止（与 steward-tools.static ⑫b 取函数体同一把尺子）。
  const rest = src.slice(at);
  const end = rest.indexOf('\n}\n');
  const body = end < 0 ? rest : rest.slice(0, end + 2);
  ok(/out\.split/.test(body), '①0b 取到的确实是那个函数体（自带尺子：里面有 out.split）');
  const frontend = new Function(body + '\nreturn assemblePlaybookPrompt;')();

  const CASES = [
    { name: '常规替换', pb: { promptTemplate: '整理 {folder} 里 {month} 的表', inputs: [{ key: 'folder' }, { key: 'month' }] }, v: { folder: 'D:/报表', month: '9月' } },
    { name: '同一个占位出现多次', pb: { promptTemplate: '{a} 和 {a} 还有 {a}', inputs: [{ key: 'a' }] }, v: { a: 'X' } },
    { name: '野占位原样留着（它不是参数，是正文）', pb: { promptTemplate: '{a} 但 {notdeclared} 留着', inputs: [{ key: 'a' }] }, v: { a: 'X' } },
    { name: '给了值但是空串', pb: { promptTemplate: '[{a}]', inputs: [{ key: 'a' }] }, v: { a: '' } },
    { name: '一个值都没给', pb: { promptTemplate: '[{a}][{b}]', inputs: [{ key: 'a' }, { key: 'b' }] }, v: {} },
    { name: '值里带正则元字符（split/join 才不会炸）', pb: { promptTemplate: '{a}', inputs: [{ key: 'a' }] }, v: { a: '$& \\1 (.*)' } },
    { name: '没有 inputs', pb: { promptTemplate: '原样 {x}', inputs: [] }, v: { x: '不该被替' } },
  ];
  for (const c of CASES) {
    const a = frontend(c.pb, c.v);
    const b = srv.stewardAssemblePlaybookPrompt(c.pb, c.v);
    ok(a === b, `① ${c.name}：两份实现同义（前端 ${JSON.stringify(a)} / 服务端 ${JSON.stringify(b)}）`);
  }
}

/* ② 没给值的参数 */
{
  const pb = { inputs: [{ key: 'folder', label: '文件夹', type: 'folder' }, { key: 'month', label: '月份', type: 'text' }] };
  ok(srv.stewardPlaybookMissingInputs(pb, { folder: 'D:/x', month: '9月' }).length === 0, '②1 全给了 -> 零缺项');
  const miss = srv.stewardPlaybookMissingInputs(pb, { folder: 'D:/x' });
  ok(miss.length === 1 && miss[0].key === 'month' && miss[0].label === '月份' && miss[0].type === 'text',
    `②2 缺项带 key/label/type（管家要拿它去问用户，不是拿一句话;got ${JSON.stringify(miss)}）`);
  ok(srv.stewardPlaybookMissingInputs(pb, { folder: '   ', month: '9月' }).some(m => m.key === 'folder'),
    '②3 只填了空白也算没给（空串跑进模板 = 在错的地方动手）');
  ok(srv.stewardPlaybookMissingInputs(pb, {}).length === 2, '②4 一个没给 -> 两项都点出来');
  ok(srv.stewardPlaybookMissingInputs({ inputs: [] }, {}).length === 0, '②5 不要参数的 playbook -> 零缺项');
  ok(srv.stewardPlaybookMissingInputs(pb, { folder: 'a', month: 'b', extra: 'c' }).length === 0,
    '②6 多给的参数不报错（只看它声明过的那几项）');
}

/* ③ playbook 正文自成一块、不裁剪、排在最后 */
{
  const LONG = 'P'.repeat(6000);   // 远超 supplement 的 1200 字预算
  const out = srv.buildStewardBrief({
    userText: '像上次那样再来一遍',
    goal: '出一份周报',
    playbookId: 'weekly-report', playbookTitle: '周报', playbookText: LONG,
  });
  ok(out.text.indexOf('像上次那样再来一遍') === 0, '③1 用户原话仍然逐字在最前（§3.5 铁律没被这一刀动过）');
  ok(out.text.includes(LONG), `③2 6000 字的 playbook 正文【一个字都没被裁】（正文长 ${LONG.length}，整段长 ${out.text.length}）`);
  ok(out.text.indexOf('<playbook id="weekly-report"') > out.text.indexOf('</steward-brief>'),
    '③3 playbook 块排在管家补充【之后】（顺序即优先级）');
  ok(out.text.includes('<playbook id="weekly-report" title="周报">') && out.text.trim().endsWith('</playbook>'),
    '③4 围栏另起一对，带 id 与标题 —— 不拿 added-by="steward" 那个壳去套用户自己写的模板');
  ok(out.playbookText === LONG, '③5 返回值里也带着正文（落盘与事后对账要用）');

  // 对照组：【管家补充】那条路仍然会被截断 —— 证明 ③2 不是因为「预算本来就够大」。
  // 注意不能拿 goal 去撑：单项先过 itemChars(300) 的钳制，6000 字进去只剩 300，压根碰不到
  // supplementChars 那道线（本件第一版正是这么写的，对照组等于没摆 —— 与 ③2 同一个错法）。
  // 用 12 条各 300 字的 context 才真的把 supplement 顶过 1200。
  const supp = srv.buildStewardBrief({ userText: 'u', context: Array.from({ length: 12 }, () => 'x'.repeat(300)) });
  ok(supp.truncated === true && supp.supplement.length <= srv.STEWARD_BRIEF_LIMITS.supplementChars + 40,
    `③6 对照：同样长的管家补充照旧被截断（${supp.supplement.length} 字 / 预算 ${srv.STEWARD_BRIEF_LIMITS.supplementChars}）`);

  // 不给 playbook 时整段一个字节都不变。
  const bare = srv.buildStewardBrief({ userText: '只有原话' });
  ok(bare.text === '只有原话' && !bare.playbookText, '③7 没给 playbook 时既有行为逐字不变');
}

console.log(fail === 0 ? 'STEWARD PLAYBOOK RUN UNIT: ALL PASS' : `STEWARD PLAYBOOK RUN UNIT: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
