'use strict';
// ── 直跑夹具的家目录自隔离（121 换机器实测，34 号文 §13.10／32 号文 §4 纪律 15）──────────────
//
// 病根：产品启动期会把 config.externalMcpServers 同步进【用户全局】的 CLI 配置——
//   · syncMcpServersToClaude（01-config）走 `claude mcp add-json` 写 ~/.claude.json；
//   · syncMcpServersToKimi（01-config）直接改 ~/.kimi-code/mcp.json。
// 经 run-all 跑时，子进程的 USERPROFILE/HOME 已换成临时家（lib/fixture-home.js），写的是临时家；
// 但 `node dev-harness/x.e2e.js` 直跑时家目录就是真机家，凡是注册过 fake-mcp 夹具（stdio-hang／
// dummy-tool／confl-mcp…）的件都会把它们写进真机的 Claude Code 与 Kimi 配置里——2026-09-12 在新
// 机器上清出来 14 条（~/.claude.json）＋ 9 条（~/.kimi-code/mcp.json），全是这条路漏的。
//
// 本文件只做一件事：被夹具在【任何 spawn 之前】require 时，若此刻的家目录还是真机家，就把本进程的
// USERPROFILE／HOME／HOMEDRIVE／HOMEPATH 换成一份临时家（与 run-all 用同一个 mkdtemp 口径），并把
// RUYI_REAL_HOME 记下来给守卫认。子进程（服务、claude、kimi）从 process.env 继承，于是与 run-all
// 跑时看到的世界一致。已经隔离过（run-all 跑）时零动作。它不改任何调用参数、不碰真机家的任何文件。
//
// 装法：在会注册 MCP 服务器的夹具文件第一行 `require('./lib/self-isolate-home.js');`（先于一切
// require——别的模块可能在加载期就读 os.homedir()）。
const os = require('os');
const path = require('path');
const { REAL_HOME, isRealHome, fixtureHomeDir, fakeAppDataDirs } = require('./fixture-home');

function selfIsolateHome() {
  const current = process.env.USERPROFILE || os.homedir();
  if (!isRealHome(current)) return { isolated: false, home: current };
  const home = fixtureHomeDir();
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  if (process.platform === 'win32') {
    const parsed = path.parse(home);
    process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, '');
    process.env.HOMEPATH = home.slice(parsed.root.length - 1);
  }
  // 123-M3（37 号文 §3.7）：与 fixtureChildEnv 同一条纪律——LOCALAPPDATA/APPDATA 不是从
  // USERPROFILE 派生的，直跑时不换这两个就还是真机的（36 号文 §5.1 的泄漏根）。
  const { local, roaming } = fakeAppDataDirs(home);
  process.env.LOCALAPPDATA = local;
  process.env.APPDATA = roaming;
  if (!process.env.RUYI_REAL_HOME) process.env.RUYI_REAL_HOME = REAL_HOME;
  return { isolated: true, home };
}

module.exports = { selfIsolateHome, result: selfIsolateHome() };
