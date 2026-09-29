'use strict';
// 真机数据根(只给 *-live / replay / report 这类读真机数据的脚本用;离线 e2e 一律用自己的临时家目录)。
// 与服务端 00-boot dataRoot() 同一口径(3.0 改名):RUYI_HOME → WIN_CLAUDE_WORKBENCH_HOME(旧变量名)→ ~/.ruyi-workbench;
// 新目录还不存在、旧目录 ~/.win-claude-workbench 在(还没被 3.0 启动迁移过)时用旧目录。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 某个家目录下的缺省数据根(不看环境变量)。homeDir 可以是另一台机器的路径字面量(如 realhist 夹具的来源机)。
function defaultDataRootIn(homeDir = os.homedir()) {
  const next = path.join(homeDir, '.ruyi-workbench');
  const legacy = path.join(homeDir, '.win-claude-workbench');
  if (fs.existsSync(next)) return next;
  return fs.existsSync(legacy) ? legacy : next;
}

function realDataRoot(homeDir) {
  return process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME || defaultDataRootIn(homeDir);
}

module.exports = { defaultDataRootIn, realDataRoot };
