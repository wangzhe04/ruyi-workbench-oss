// Unit: 第117波 117q-B7(30 号文 §3 总表 P2-16「argsHash 指纹算法两份字面相同」+ §8.9②「TOOL_TIER_RANK
// 落点误判」)—— hashArgs(args) 的真值表 + 单一事实源静态锁。
//
// 根因(30 号文 §3 总表 P2-16):sha1+hex 截 12 位这一款指纹算法在 06f-autonomy-grants.js::consumeGrant
// (用量事件,收对象 args,`crypto.createHash('sha1').update(JSON.stringify(args || {})).digest('hex').slice(0,12)`)
// 与 09b-replan-ledger.js::recordNodeContinuation(节点续点 pending 步骤,收预先算好的 argsStr 字符串,
// `crypto.createHash('sha1').update(argsStr).digest('hex').slice(0,12)`)各写一遍,字面完全相同,只是一个
// 收对象一个收字符串。117q-B7 把它收进 00-boot.js 的 hashArgs:入参是字符串就直接用,否则
// JSON.stringify(args || {});任何异常兜底返回空串(与两处原有 try/catch 兜底行为一致)。
// 两个调用点原样改成调它。
//
// 与本次同刀:TOOL_TIER_RANK(30 号文 §8.9②)从 07-autonomy.js 迁到 00-boot.js —— 117q-B5 把它落在
// 07-autonomy.js 时,09b-replan-ledger.js 因此新增了一条循环边 09b-replan-ledger.js->07-autonomy.js,
// 被迫登记进 module-dependency-policy.json 白名单;107q-B7 改正落点后 09b 不再引用 07 的任何符号,
// 那条边真的消失,已从白名单撤回(见 module-dependency-policy.json 的 note 与
// dev-harness/module-dependency-graph.static.e2e.js 的图数据自证,本文件不重复断言依赖图,只锁
// hashArgs 这一个纯函数)。
//
// 覆盖:
//   ① server.js 导出了 hashArgs
//   ② 对象形态与「预先 JSON.stringify 好的字符串」形态,对同一份逻辑参数得到同一指纹(两处调用点的
//      两种入参形状统一到一条真值表)
//   ③ 输出形状:12 位十六进制小写字符串(sha1 截 12 位的既有形状,不是新引入的宽松化)
//   ④ 不同入参得到不同指纹(不是恒定值/常量兜底)
//   ⑤ 异常入参(含循环引用对象,JSON.stringify 会抛)不抛出,兜底返回空串
//   ⑥ null/undefined/空对象等边界入参按 `args || {}` 起点处理,不抛
//   ⑦ 静态锁:00-boot.js 里 hashArgs 只有一份定义;06f-autonomy-grants.js::consumeGrant 与
//      09b-replan-ledger.js::recordNodeContinuation 两个调用点都已改调它,不再各自手写
//      `crypto.createHash('sha1').update(...).digest('hex').slice(0, 12)` 字面量
//
// 与既有 dev-harness/unit 件同款约定(见 neutralize-fence-tag.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录;PASS/FAIL 逐条打印,process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-hash-args-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { hashArgs } = srv;

/* ═══════════ ① 导出形状 ═══════════ */
ok(typeof hashArgs === 'function', '① server.js 导出了 hashArgs');

/* ═══════════ ② 对象形态与字符串形态对同一逻辑参数得到同一指纹 ═══════════ */
{
  const args = { tool: 'file_write', path: 'a/b.txt', content: '你好世界' };
  const fromObject = hashArgs(args); // 06f-autonomy-grants.js::consumeGrant 的入参形状
  const fromString = hashArgs(JSON.stringify(args)); // 09b-replan-ledger.js::recordNodeContinuation 的入参形状(预先 stringify 好)
  ok(fromObject === fromString, '②a 对象形态与预先 stringify 好的字符串形态,同一逻辑参数得到同一指纹: ' + fromObject + ' === ' + fromString);

  const args2 = { a: 1, b: [1, 2, 3] };
  ok(hashArgs(args2) === hashArgs(JSON.stringify(args2)), '②b 换一份参数,两种入参形状依旧得到同一指纹');

  // 与手算的 sha1 对照(确认算法本身就是既有的 sha1+hex 截 12 位,不是换了一款别的哈希)。
  const manual = crypto.createHash('sha1').update(JSON.stringify(args)).digest('hex').slice(0, 12);
  ok(fromObject === manual, '②c 与手算 sha1(JSON.stringify(args)).hex.slice(0,12) 逐字节相同');
}

/* ═══════════ ③ 输出形状:12 位十六进制小写 ═══════════ */
{
  const out = hashArgs({ x: 1 });
  ok(out.length === 12, '③a 输出恰好 12 个字符(got ' + out.length + ')');
  ok(/^[0-9a-f]{12}$/.test(out), '③b 输出是十六进制小写字符串: ' + out);
}

/* ═══════════ ④ 不同入参得到不同指纹 ═══════════ */
{
  const h1 = hashArgs({ path: 'a.txt' });
  const h2 = hashArgs({ path: 'b.txt' });
  ok(h1 !== h2, '④ 不同逻辑参数得到不同指纹(不是恒定值兜底): ' + h1 + ' vs ' + h2);
}

/* ═══════════ ⑤ 异常入参不抛,兜底返回空串 ═══════════ */
{
  const circular = {};
  circular.self = circular; // JSON.stringify 遇到循环引用会抛 TypeError
  let threw = false;
  let result;
  try { result = hashArgs(circular); } catch { threw = true; }
  ok(!threw, '⑤a 循环引用对象不让 hashArgs 抛出');
  ok(result === '', '⑤b 循环引用对象兜底返回空串(got ' + JSON.stringify(result) + ')');

  const withBigInt = { n: 10n }; // BigInt 也会让 JSON.stringify 抛 TypeError
  let threw2 = false;
  let result2;
  try { result2 = hashArgs(withBigInt); } catch { threw2 = true; }
  ok(!threw2, '⑤c 含 BigInt 字段的对象不让 hashArgs 抛出');
  ok(result2 === '', '⑤d 含 BigInt 字段的对象兜底返回空串(got ' + JSON.stringify(result2) + ')');
}

/* ═══════════ ⑥ null/undefined/空对象边界入参 ═══════════ */
{
  ok(hashArgs(null) === hashArgs({}), '⑥a null 走 `args || {}` 起点,与空对象得到同一指纹');
  ok(hashArgs(undefined) === hashArgs({}), '⑥b undefined 走 `args || {}` 起点,与空对象得到同一指纹');
  // 注:空字符串是「字符串形态」输入(typeof === 'string'),`typeof args === 'string' ? args : ...` 判据
  // 直接把它当 sha1 的输入源字符串——不落入 `args || {}` 分支,也不是异常兜底,产出 sha1("") 截 12 位
  // 的合法指纹,不是空串本身(空串本身只在 catch 兜底路径出现,见 ⑤)。
  ok(hashArgs('') === crypto.createHash('sha1').update('').digest('hex').slice(0, 12),
    '⑥c 空字符串走字符串形态分支,得到 sha1("") 截 12 位(不是空串兜底): ' + JSON.stringify(hashArgs('')));
  ok(/^[0-9a-f]{12}$/.test(hashArgs('')), '⑥d 空字符串输入产出合法 12 位十六进制指纹,不是异常兜底的空串');
  ok(typeof hashArgs({}) === 'string' && hashArgs({}).length === 12, '⑥e 空对象产出合法指纹,不抛');
}

/* ═══════════ ⑦ 静态锁:单一事实源 + 两个调用点都已迁移 ═══════════ */
{
  const bootSrc = fs.readFileSync(path.join(app, 'src', '00-boot.js'), 'utf8');
  const defs = (bootSrc.match(/function hashArgs\(/g) || []).length;
  ok(defs === 1, '⑦a 00-boot.js 里 hashArgs 只有一份定义(got ' + defs + ')');

  const grants = fs.readFileSync(path.join(app, 'src', '06f-autonomy-grants.js'), 'utf8');
  ok(grants.includes('hashArgs(args)'), '⑦b 06f-autonomy-grants.js::consumeGrant 已改调 hashArgs(args)');
  ok(!/crypto\.createHash\('sha1'\)\.update\(JSON\.stringify\(args \|\| \{\}\)\)/.test(grants),
    '⑦c 06f-autonomy-grants.js 不再残留手写的 sha1(JSON.stringify(args||{})) 字面量');

  const ledger = fs.readFileSync(path.join(app, 'src', '09b-replan-ledger.js'), 'utf8');
  ok(ledger.includes('hashArgs(argsStr)'), '⑦d 09b-replan-ledger.js::recordNodeContinuation 已改调 hashArgs(argsStr)');
  ok(!/crypto\.createHash\('sha1'\)\.update\(argsStr\)/.test(ledger),
    '⑦e 09b-replan-ledger.js 不再残留手写的 sha1(argsStr) 字面量');
}

console.log('\nHASH-ARGS UNIT: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
