'use strict';
// ── 27 号文 §11.21.7 债④:夹具 HOME 守卫 ──────────────────────────────────────────────
//
// 装法(run-all 那一套):`node --require <本文件> <夹具>`。本文件只做一件事 ——
// 拦「env 里带了 RUYI_HOME(数据家隔离了),但家目录没跟着隔离」的子进程。
//
// 判据:凡 spawn-family 调用的 options.env 里带 RUYI_HOME,USERPROFILE 与 HOME 就必须
// 同时存在、且都【不是真机家】(见 ./fixture-home;那里同时给出 RUYI_REAL_HOME 的来路)。
// 不过就当场红退出(exit 1)—— 绝不放那个子进程出去碰真机家。守卫只读 env,不改写任何调用参数。
//
// 为什么装法不是 NODE_OPTIONS=--require:Node 的 NODE_OPTIONS 分词器会吃掉引号与反斜杠,
// 而本仓检出路径含空格("...\Documents\Claude Code\...")—— 实测 NODE_OPTIONS 传路径必挂
// (Cannot find module 'C:Users...'),本地全红、CI 侥幸能过。改用 spawn 的 CLI 实参,Node 认路径
// 且会把 --require 从子进程 argv 里剔掉(argv 形状对夹具保持原样)。
// 代价(已登记为残余债):夹具的【孙进程】不再被守卫覆盖;exec/spawn 之外的自建通道同样不经守卫。

const cp = require('child_process');
const { REAL_HOME, REAL_HOME_SOURCE, normalizeHome, isFakeHome } = require('./fixture-home');

// 覆盖 spawn-family 全部入口(任务点名的四个 + exec/execSync/fork 三个同形状的)。
// 这些包装只在 env 真带 RUYI_HOME 时才会红,没带的调用完全不受影响。
const PATCHED_METHODS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

// options 在参数表里的位置:spawn(cmd, [args], [options]) —— 从后往前找第一个「不是数组的对象」。
// 末位可能是回调函数(string/function 都会被排除),所以只认 object 且排除 Array/Buffer/URL。
function optionsIndexOf(argv) {
  for (let i = argv.length - 1; i >= 1; i--) {
    const a = argv[i];
    if (a && typeof a === 'object' && !Array.isArray(a) && !Buffer.isBuffer(a) && !(a instanceof URL)) return i;
  }
  return -1;
}

// 返回问题列表(空数组 = 通过)。判据本身是纯函数,便于本件之外复用/复核。
function violationsOf(env) {
  if (!env || typeof env !== 'object') return [];
  if (!Object.prototype.hasOwnProperty.call(env, 'RUYI_HOME')) return [];
  const problems = [];
  // UserProfile 那条:没设就说明子进程的 os.homedir() 会落回真机家(这正是债的形状);
  // 设了但就是真机家 —— 显式写死真机家,同样红。
  if (!normalizeHome(env.USERPROFILE)) problems.push('USERPROFILE 没设 —— 子进程的 os.homedir() 会落回真机家');
  else if (!isFakeHome(env.USERPROFILE)) problems.push('USERPROFILE 就是真机家:' + env.USERPROFILE);
  if (!normalizeHome(env.HOME)) problems.push('HOME 没设(git/npm 一类会读它)');
  else if (!isFakeHome(env.HOME)) problems.push('HOME 就是真机家:' + env.HOME);
  if (normalizeHome(env.RUYI_HOME) && !isFakeHome(env.RUYI_HOME)) {
    problems.push('RUYI_HOME 自己就指向真机家:' + env.RUYI_HOME);
  }
  return problems;
}

function die(methodName, target, problems) {
  const bar = '='.repeat(78);
  process.stderr.write([
    '',
    bar,
    'FAIL 夹具 HOME 守卫红(fixture-home-guard):子进程带了 RUYI_HOME,家目录却没一起隔离',
    '  夹具: ' + (process.argv[1] || '(未知)'),
    '  调用: child_process.' + methodName + '(' + String(target) + ')',
    ...problems.map(p => '  问题: ' + p),
    '  真机家(来自 ' + REAL_HOME_SOURCE + '): ' + REAL_HOME,
    '  依据: 27 号文 §11.21.7 债④ —— 数据家隔离了、家目录没隔离,子进程照样真读真写 ~/.claude。',
    '  修法: env 里 spread process.env(run-all 注入的临时 USERPROFILE/HOME 就在里面),',
    '        或显式把 USERPROFILE/HOME 指向本夹具自己的临时目录。',
    bar,
    '',
  ].join('\n'));
  process.exit(1);
}

function wrap(methodName) {
  const original = cp[methodName];
  if (typeof original !== 'function') return;
  cp[methodName] = function guardedFixtureSpawn(...argv) {
    const oi = optionsIndexOf(argv);
    if (oi > 0) {
      const opts = argv[oi];
      const problems = violationsOf(opts && opts.env);
      if (problems.length) die(methodName, argv[0], problems);
    }
    return original.apply(this, argv);
  };
}

for (const m of PATCHED_METHODS) wrap(m);
