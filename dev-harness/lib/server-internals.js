'use strict';
// 取 server.js 的【未导出】顶层符号来做单测(函数、常量、命名空间对象),不动 14-main.js 的导出面。
//
// 为什么不直接 export:14-main.js 的 module.exports 有总数上限且每个导出都要被 dev-harness 引用
// (unit/export-surface.test.js [X1][X2]),为了测一个内部函数去加导出不值当,也会让「公共接口」越长越乱。
// 为什么不按源码切片放进 vm(source-slice.js 那一套):要测的往往带着对 fsp/paths/logEvent 等一串模块级依赖,
// 切片得手工补桩,桩与真实现一漂移测试就在测假东西。
// 做法:读【真】server.js 全文,在尾部追加一行 `module.exports.__internals = { name1, name2 }`,用 Module#_compile 编译 ——
// 追加的那行与整份产物同处一个模块作用域,能直接引用任何顶层 function / const / let,跑的是真代码、真依赖。
//
// 用法(须先把 RUYI_HOME / HOME 等指到临时目录再调用,与 require(server.js) 的隔离规矩相同):
//   const { loadServerInternals } = require('../lib/server-internals');
//   const { syncClaudeCliSettings, memorySearchTerms } = loadServerInternals(['syncClaudeCliSettings', 'memorySearchTerms']);
// 注意:这【代替】对 server.js 的 require,同一进程里别再 require 一次(会是两份互不相通的模块状态)。
// 要的名字不存在会直接抛 ReferenceError(拼错/被改名时测试红,而不是静默拿到 undefined)。
const fs = require('fs');
const path = require('path');
const Module = require('module');

// RUYI_TEST_SERVER_JS:反向验证用 —— 指到修前的 server.js(从基线提交导出一份),确认新测试在旧码上确实红。
const SERVER = process.env.RUYI_TEST_SERVER_JS
  ? path.resolve(process.env.RUYI_TEST_SERVER_JS)
  : path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'server.js');

function loadServerInternals(names) {
  if (!Array.isArray(names) || !names.length || !names.every(n => /^[A-Za-z_$][\w$]*$/.test(n))) {
    throw new Error('loadServerInternals: names must be a non-empty array of identifiers');
  }
  const src = fs.readFileSync(SERVER, 'utf8');
  const mod = new Module(SERVER, module);
  mod.filename = SERVER;
  mod.paths = Module._nodeModulePaths(path.dirname(SERVER));
  mod._compile(`${src}\n;module.exports.__internals = { ${names.join(', ')} };\n`, SERVER);
  return mod.exports.__internals;
}

module.exports = { loadServerInternals };
