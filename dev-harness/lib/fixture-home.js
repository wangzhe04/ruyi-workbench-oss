'use strict';
// ── 27 号文 §11.21.7 债④(夹具不隔离家目录)的【判据源】 ────────────────────────────────
//
// 债的形状:RUYI_HOME 定的是【数据目录】,它管不到 os.homedir()。夹具只给子进程设 RUYI_HOME、
// 不把 USERPROFILE/HOME 一起指到临时目录时,子进程里的 os.homedir() 仍是真机家 —— 于是
// ~/.claude、~/.claude.json、~/.gitconfig 这些「家目录侧」的东西照样被真读真写。
//
// 判据成立的前提(唯一,且是 run-all 注入的副作用):本模块要在【USERPROFILE/HOME 已被换成临时家】
// 的进程里被加载。那时 os.homedir() 已经不是真机家,真机家只能靠 run-all 用 RUYI_REAL_HOME 另传一份。
// 直跑(node dev-harness/xxx.e2e.js,不经 run-all)时没有任何注入,REAL_HOME 退回当前 homedir ——
// 判据退化成「不许显式指向自己的家」,弱一档但不假绿(已登记为残余债)。
//
// 「真机家」为什么判【精确相等】而不是「是否在其子树下」:Windows 的 %TEMP% 就在
// C:\Users\<user>\AppData\Local\Temp —— 用子树判会把所有合法临时家全判成违规。假红比漏判贵。

const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD_FILE = path.join(__dirname, 'fixture-home-guard.js');

// Windows 路径大小写不敏感、尾分隔符不敏感;各夹具拼路径的写法五花八门,比较前统一成一种。
function normalizeHome(homePath) {
  if (homePath === undefined || homePath === null) return '';
  let s = String(homePath).trim();
  if (!s) return '';
  s = path.resolve(s);
  while (s.length > 3 && (s.endsWith(path.sep) || s.endsWith('/'))) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

const DECLARED_REAL_HOME = normalizeHome(process.env.RUYI_REAL_HOME);
const REAL_HOME = DECLARED_REAL_HOME || normalizeHome(os.homedir());
const REAL_HOME_SOURCE = DECLARED_REAL_HOME ? 'RUYI_REAL_HOME(run-all 注入)' : 'os.homedir()(未注入,直跑)';

function isRealHome(homePath) {
  const n = normalizeHome(homePath);
  return !!n && n === REAL_HOME;
}

// 「非真机家」= 有个家目录,且它不是真机家。
function isFakeHome(homePath) {
  const n = normalizeHome(homePath);
  return !!n && n !== REAL_HOME;
}

// ── run-all 侧:给夹具子进程造一份临时家 ───────────────────────────────────────────────
// 每次 runner 进程一个(整轮跑共用),mkdtemp 保证唯一,跑完由 OS 的 %TEMP% 回收。
let cachedFixtureHome = '';
function fixtureHomeDir() {
  if (!cachedFixtureHome) cachedFixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-e2e-home-'));
  return cachedFixtureHome;
}

// 122 波 §2.7:先跑的件往(整轮共用的)临时家写 .claude.json,后跑的件又把它导入 —— 8 路全量下
// websearch 红的真根。修法:每一件自己一份 mkdtemp,不跨件共用。
// 用一个新目录、跑完由调用方(run-all)自行 rmSync 回收。
function fixtureHomeDirPerTest() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-e2e-home-'));
}

// 123-M3(37 号文 §3.7):USERPROFILE/HOME 换了临时家,但 Windows 上 LOCALAPPDATA/APPDATA
// 是【两个独立的环境变量】,不是从 USERPROFILE 派生的 —— 换家目录时若不跟着换,子进程读到的
// 还是真机的 %LOCALAPPDATA%/%APPDATA%(36 号文 §5.1 实测的泄漏根:index-dedup E3 就是
// migrateLegacyAccMemory() 扫到真机 %LOCALAPPDATA%/ai-computer-control/data/memory.json
// 命中出来的)。这里补齐同一套映射:<home>/AppData/Local、<home>/AppData/Roaming,并且
// mkdir 出来 —— 有些代码路径认「目录已存在」不做首次初始化,不建目录会把「目录不存在」这个
// 事实也算进产品分支里,引入本波并未打算测的第二个变量。
// 无头 Edge 的 --user-data-dir 是每个 *.browser.e2e.js 各自显式拼在临时家下面传的
// (grep -rn "user-data-dir" dev-harness/*.browser.e2e.js 核过,一个不例外),不读
// LOCALAPPDATA/APPDATA,所以这两个变量换掉不影响浏览器件的 profile 落点。
// 107-F9b:经 run-all 跑时,开浏览器的件另有一个【属于这一件】的临时根 —— 夹具进程的 os.tmpdir() 被
// lib/browser-profile-scope.js 指到那里(TEMP 环境变量不动),收尸只收这个根。见那个文件的头注。
// 123 合并复核（主会话，2026-09-13 夜）：假 AppData 【整机一份、跨件共用】，不是每件一份。
// 第一版把它挂在每件独立的临时家下面，合并后 8 路全量 37 红——桌面 MCP 的 python 探针磁盘缓存
// （01-config desktopPythonDiskCacheId）的键含 %LOCALAPPDATA% 派生的候选路径，每件一个新目录＝
// 每件一个新键＝每件都冷探针（首个 /api/status 6 s，真机 LOCALAPPDATA 时 2.5 s），凡是给
// /api/status 留 5 s 预算的件全部超时。隔离的目标只是「不许指回真机」，共用一份假的就够；
// 目录名固定，缓存键从第二个进程起就命中。
function fakeAppDataDirs() {
  const base = path.join(os.tmpdir(), 'ruyi-e2e-appdata');
  const local = path.join(base, 'Local');
  const roaming = path.join(base, 'Roaming');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
  return { local, roaming };
}

// 夹具子进程的环境:家目录一套换成临时家(USERPROFILE 管 os.homedir(),HOME 管 git/npm 一类,
// LOCALAPPDATA/APPDATA 管 Windows 应用数据两个惯用目录),真机家另走 RUYI_REAL_HOME ——
// 守卫靠它才知道「真机家」是哪个(夹具自己已经看不见了)。
//
// 不传 opts(或 opts.perTest 为假):沿用整轮共用的那份临时家,返回值仍是【环境对象】本身
// (向后兼容旧签名)。传 { perTest: true }:每次调用都 mkdtemp 一份全新目录,返回
// { env, home } —— 调用方(run-all)拿 home 在该件跑完(仅 ok 件)时自行 rmSync 回收;
// 失败件保留目录,便于取证。
function fixtureChildEnv(opts) {
  const options = opts || {};
  const home = options.perTest ? fixtureHomeDirPerTest() : fixtureHomeDir();
  const { local, roaming } = fakeAppDataDirs();
  const base = options.baseEnv || process.env;
  const env = {
    ...base,
    USERPROFILE: home, HOME: home, RUYI_REAL_HOME: REAL_HOME,
    LOCALAPPDATA: local, APPDATA: roaming,
    // 真机的两个应用数据目录另存一份 —— 只给测试浏览器用(lib/browser-profile-scope.js 在拉起浏览器时还原),
    // 夹具与它起的服务照旧只看见假的那一对。
    RUYI_REAL_LOCALAPPDATA: base.RUYI_REAL_LOCALAPPDATA || base.LOCALAPPDATA || '',
    RUYI_REAL_APPDATA: base.RUYI_REAL_APPDATA || base.APPDATA || '',
  };
  return options.perTest ? { env, home } : env;
}

module.exports = {
  GUARD_FILE,
  REAL_HOME,
  REAL_HOME_SOURCE,
  normalizeHome,
  isRealHome,
  isFakeHome,
  fixtureHomeDir,
  fixtureHomeDirPerTest,
  fixtureChildEnv,
  fakeAppDataDirs,
};
