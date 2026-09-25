'use strict';
// ── 107-F9b：测试浏览器的 profile 范围 —— 收尸只收【这一件】的浏览器 ─────────────────────────
//
// 修的是 F8 取证的测试框架缺陷：run-all 每件浏览器测试跑完都调一次 stopRuyiTestBrowsers() 且【不传目录】，
// 而它不传目录时匹配的是【整台机器上】所有 `--user-data-dir=…\ruyi-` / `wcw-` 的 msedge/chrome。
// `--parallel 4` 下任何一件浏览器测试收尾，都会把另外三条车道正在用的测试浏览器一起杀掉；那几件的 CDP
// 调用往已关的 socket 里发、永远不返回，挂到 120 s 超时（steward-settings B3 历史三次偶发的 136/137/133 s
// 正是「120 s 超时＋一次正常重跑」；F8 对照臂关掉这一处 30 轮 0 失败、0 次浏览器被杀）。
//
// 修法：run-all 给每件开浏览器的测试建一个【属于这一件】的临时根（createScope），把路径经环境变量
// RUYI_E2E_TEST_TMPDIR 交给子进程，并以 `--require` 装上本文件；本文件在那个夹具进程里把 os.tmpdir()
// 指到这个根 —— 夹具里 `fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-…'))` 建的 profile 就自然落在里面。
// 收尸时只传这个根（reapScope），PowerShell 那边按命令行「含这个路径」匹配，别的车道一个都碰不到。
//
// 为什么改 os.tmpdir() 而不是给子进程设 TEMP/TMP（F8 的原始建议）：产品把桌面 MCP 的 python 探针结果
// 跨进程缓存在 os.tmpdir() 下（01-config.js 的 desktopPythonDiskCachePath，一轮三个候选 ~5 s）。夹具起的
// 服务会继承 TEMP —— 每件一个新 TEMP 就是每件一次冷探针，正是 123 合并时「8 路全量 37 红」那一个模具
// （那次是 LOCALAPPDATA，见 lib/fixture-home.js 的 fakeAppDataDirs 头注）。这里只改【夹具进程自己】的
// os.tmpdir()，环境变量原样传下去，服务照旧共用那份缓存。代价：夹具进程里 os.tmpdir() 与它起的子进程的
// os.tmpdir() 不再相同 —— 审计过：开浏览器的 29 件没有一件把两者当成同一个目录用（都显式传路径）。
//
// 同一处顺带一把机械锁：装上之后，夹具里任何 spawn-family 调用带着 `--user-data-dir=` 却指向这个根【之外】，
// 当场红（stderr 打 FAIL 横幅并抛错，夹具的 finally 照常收尾）—— 不在根里的 profile 收尸时不会被匹配，
// 漏出来的 Edge 就再没人收，攒几百个之后冷启动 4 s → 86 s（记忆 ruyi-browser-e2e-leaks-edge）。
//
// 不经 run-all 直跑（没有这个环境变量）时本文件什么都不做：os.tmpdir() 不动，也不查 profile。

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCOPE_ENV = 'RUYI_E2E_TEST_TMPDIR';
const SCOPE_PREFIX = 'ruyi-e2e-tmp-';
const SCOPE_FILE = __filename;
const PATCHED_METHODS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

// Windows 路径大小写不敏感；比较前统一成一种。
function norm(p) {
  const s = path.resolve(String(p));
  return process.platform === 'win32' ? s.toLowerCase() : s;
}
function isInsideScope(dir, scope) {
  if (!dir || !scope) return false;
  const d = norm(dir), s = norm(scope);
  return d.startsWith(s.endsWith(path.sep) ? s : s + path.sep);
}

// 从一次 spawn-family 调用的实参里挑出所有 `--user-data-dir=` 的值（数组实参逐项认；字符串命令按引号/空白切）。
function profileDirsOf(argv) {
  const dirs = [];
  const fromString = s => {
    const re = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/g;
    let m;
    while ((m = re.exec(s))) dirs.push(m[1] || m[2] || m[3]);
  };
  for (const a of argv) {
    if (typeof a === 'string') fromString(a);
    else if (Array.isArray(a)) {
      for (const item of a) {
        if (typeof item !== 'string') continue;
        const m = /^--user-data-dir=(.*)$/.exec(item);
        if (m) dirs.push(m[1].replace(/^"(.*)"$/, '$1'));
      }
    }
  }
  return dirs;
}

// run-all 侧：给一件测试建它自己的根（与夹具临时家平级，不放进家里 —— 放进去会让夹具的工作目录变成
// 「在家目录下面」，那是另一个产品分支）。
function createScope(base) {
  return fs.mkdtempSync(path.join(base || os.tmpdir(), SCOPE_PREFIX));
}

// run-all 侧：收这一件的尸。【永远】带范围调用收尸器 —— 空范围直接不收（不收的代价是下一轮 run-all
// 开头的全局收尸兜底；收错的代价是杀掉别的车道正在用的浏览器，F8 的原形）。收完把根删掉【仅当它已空】：
// 夹具有意留下的东西（截图、失败现场）一个字节都不碰。返回收尸器报的个数。
function reapScope(scope, reaper) {
  if (!scope || typeof reaper !== 'function') return 0;
  const needle = scope.endsWith(path.sep) ? scope : scope + path.sep;
  let count = 0;
  try { count = Number(reaper(needle)) || 0; } catch { count = 0; }
  try { fs.rmdirSync(scope); } catch { /* 非空（夹具留了东西）或已不在：原样留着 */ }
  return count;
}

// 测试浏览器用真机的家目录环境。run-all 给每件夹具一份全新的空家（USERPROFILE/HOME）与一对假
// LOCALAPPDATA/APPDATA（fixture-home.js，122 §2.7 / 123-M3），夹具里 spawn 的 Edge 原样继承。
// CI 取证（GitHub windows-2025 runner，同一镜像同一 Node）：run 220 还能连上 CDP，run 221 起四十来件
// 浏览器件全部「进程活着、/json/list 15 s 一直不回话」—— 两次之间测试框架唯一的环境变化就是 956b025a
// 「每件独立临时家」。浏览器的数据已经由 --user-data-dir 隔离在本件的根里，它并不读如意的配置，
// 所以把这四个变量还给它不削弱隔离；夹具进程与它起的服务照旧用假家。
const REAL_HOME_ENV_MAP = Object.freeze({
  USERPROFILE: 'RUYI_REAL_HOME', HOME: 'RUYI_REAL_HOME',
  LOCALAPPDATA: 'RUYI_REAL_LOCALAPPDATA', APPDATA: 'RUYI_REAL_APPDATA',
});
function realHomeEnvFor(env) {
  const out = {};
  for (const [key, source] of Object.entries(REAL_HOME_ENV_MAP)) {
    const value = env && env[source];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}
// 纯函数：给一次拉起浏览器的 spawn-family 实参补上 options.env（其余实参原样）。只认 argv 里带
// --user-data-dir= 的调用；认不出 options 的位置就原样返回，宁可不改也不改错。
function withRealHomeEnv(methodName, argv, env) {
  const real = realHomeEnvFor(env);
  if (!Object.keys(real).length || !profileDirsOf(argv).length) return argv;
  const shellForm = methodName === 'exec' || methodName === 'execSync';
  const at = shellForm ? 1 : (Array.isArray(argv[1]) ? 2 : 1);
  // 浏览器用不着如意的数据家变量；留着它们，fixture-home-guard 会把「带 RUYI_HOME 却指回真机家」当越界拦下。
  const browserEnv = base => {
    const out = { ...base, ...real };
    delete out.RUYI_HOME;
    delete out.WIN_CLAUDE_WORKBENCH_HOME;
    return out;
  };
  const next = argv.slice();
  const current = next[at];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    next[at] = { ...current, env: browserEnv(current.env || env) };
  } else if (current === undefined) {
    next[at] = { env: browserEnv(env) };
  } else if (typeof current === 'function') {
    next.splice(at, 0, { env: browserEnv(env) });
  } else {
    return argv;
  }
  return next;
}

// 测试浏览器的两项默认显示环境，与开发机一致:界面语言 zh-CN、不减少动态效果。
// CI(GitHub windows-2025 runner)是英文系统，且 Windows Server 默认关掉系统动画 → Edge 报
// prefers-reduced-motion: reduce。前者让一批断言中文文案的件读到英文，后者让视图过渡与转圈动画按设计
// 「零动画」—— 量的就不是产品本身了。件自己带了 --lang / --accept-lang / --force-prefers-* 就不动;
// 需要「减少动态效果」的件用 CDP Emulation.setEmulatedMedia 现场设，优先级高于启动开关。
const BROWSER_DEFAULT_FLAGS = Object.freeze([
  { prefix: '--lang=', flag: '--lang=zh-CN' },
  { prefix: '--accept-lang=', flag: '--accept-lang=zh-CN' },
  { prefix: '--force-prefers-', flag: '--force-prefers-no-reduced-motion' },
]);
// 纯函数：只认 spawn-family 的「命令 + 实参数组」形态且数组里带 --user-data-dir= 的调用(即拉起测试浏览器)。
function withBrowserDefaults(argv) {
  const args = Array.isArray(argv[1]) ? argv[1] : null;
  if (!args || !args.some(a => typeof a === 'string' && a.startsWith('--user-data-dir='))) return argv;
  const missing = BROWSER_DEFAULT_FLAGS
    .filter(({ prefix }) => !args.some(a => typeof a === 'string' && a.startsWith(prefix)))
    .map(({ flag }) => flag);
  if (!missing.length) return argv;
  // 一律补在末尾：Chromium 不论位置都认 `--` 开头的开关(测试里拉浏览器从不带单独的 `--`)；补在前面的话，
  // 被拉起的若不是浏览器(单测探针就是 `node -e … -- --user-data-dir=…`)会把它们当成自己的选项拒掉。
  const next = argv.slice();
  next[1] = [...args, ...missing];
  return next;
}

// 夹具侧：装上范围。只在 run-all 注入了 SCOPE_ENV 的夹具进程里跑（见文件末尾）。
function install(scope) {
  os.tmpdir = () => scope;
  for (const methodName of PATCHED_METHODS) {
    const original = cp[methodName];
    if (typeof original !== 'function') continue;
    cp[methodName] = function scopedBrowserSpawn(...argv) {
      const outside = profileDirsOf(argv).filter(dir => !isInsideScope(dir, scope));
      if (outside.length) {
        const bar = '='.repeat(78);
        const lines = [
          '', bar,
          'FAIL 测试浏览器 profile 越界(browser-profile-scope):--user-data-dir 不在本件的临时根下',
          '  夹具: ' + (process.argv[1] || '(未知)'),
          '  调用: child_process.' + methodName + '(' + String(argv[0]) + ')',
          ...outside.map(dir => '  profile: ' + dir),
          '  本件的根: ' + scope,
          '  后果: run-all 收尸只收本件的根,根外的 profile 漏出来的 Edge 再没人收(107-F9b)。',
          '  修法: profile 用 fs.mkdtempSync(path.join(os.tmpdir(), \'ruyi-…\')) 建(os.tmpdir() 已指到本件的根)。',
          bar, '',
        ];
        process.stderr.write(lines.join('\n'));
        throw new Error('browser profile outside the per-test scope: ' + outside.join(', '));
      }
      return original.apply(this, withRealHomeEnv(methodName, withBrowserDefaults(argv), process.env));
    };
  }
}

module.exports = { SCOPE_ENV, SCOPE_PREFIX, SCOPE_FILE, isInsideScope, profileDirsOf, createScope, reapScope, install, withRealHomeEnv, withBrowserDefaults };

// 以 `--require` 装进夹具时：带着 run-all 注入的根才生效；直跑（没有这个变量）什么都不做。
// run-all 自己 require 本文件只为拿常量与 createScope/reapScope —— 它自己的环境里没有这个变量，不会装。
if (process.env[SCOPE_ENV]) install(process.env[SCOPE_ENV]);
