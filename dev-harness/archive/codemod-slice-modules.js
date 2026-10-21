#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// codemod-slice-modules.js — 第43波一次性切片器(机械切,不手工搬)
//
// 把 app/server.js 按 CUTS 行区间切成 app/src/NN-name.js + manifest.json。
// 铁律:切片 = 原文连续行区间,拼接后必须【字节级】还原(全 LF、无 BOM、模块间 join('\n'))。
// 验收:跑完后 `node app/build.js` 重建,`git diff app/server.js` 必须为空。
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', 'ruyi-workbench', 'app');
const SRC = path.join(APP, 'src');
const SERVER = path.join(APP, 'server.js');

// [起始行(1-based), 模块名, 主题注记] —— 43a 测绘,全部经 safeAt 程序验证(前一行空白+切点顶格)
const CUTS = [
  [1, '00-boot', 'shebang/use strict/requires/paths/小工具'],
  [389, '01-config', 'defaultConfig/normalizeConfig/readConfig/launcher 解析/ROUTE_AUTH'],
  [1895, '02-session-store', '会话存储 v2(head+NDJSON 正文)/索引/load-save/checkpoint journal/日志'],
  [3312, '03-bridge-guard', '桥接写族覆盖审计/工作区护栏'],
  [3984, '04-permission-runtime', '视觉回路/pendingPermissions/plan 批准/原生权限请求'],
  [4926, '05-claude-engine', 'runClaudeTurn/stream-json 解析/spawn 环境/权限桥接线'],
  [5756, '06-provider-engine', 'provider 引擎助手/能力探测/metrics/转录 GC/存储管家/playbooks'],
  [7197, '07-autonomy', '授权书/工具 gate/资源归一化'],
  [9109, '08-agent-runs', 'run 事件日志/恢复分级/runSubAgentCore'],
  [10718, '09-workflow', '调度器/launchPersistedAgentRun/runOpenAiTurn'],
  [12451, '10-context-governance', '上下文窗口三级/摘要内核/L1 蒸发/L2 重播种'],
  [13164, '11-native-tools', 'shell 会话/git 族/web_search/归档族/桌面桥'],
  [14862, '12-tool-dispatch', 'invokeAdaptiveMcpTool/TOOL_DISPATCH 注册表/toolCall'],
  [15883, '13-http-router', 'handleApi 全路由'],
  [18245, '14-main', 'main()/module.exports'],
];

const text = fs.readFileSync(SERVER, 'utf8');
if (text.includes('\r')) { console.error('文件含 CR,切片器只认全 LF —— 先停手查换行'); process.exit(1); }
const lines = text.split('\n');
fs.rmSync(SRC, { recursive: true, force: true });
fs.mkdirSync(SRC, { recursive: true });

const modules = [];
for (let i = 0; i < CUTS.length; i++) {
  const [start, name, note] = CUTS[i];
  const end = i + 1 < CUTS.length ? CUTS[i + 1][0] - 1 : lines.length;
  const body = lines.slice(start - 1, end).join('\n');
  const file = name + '.js';
  fs.writeFileSync(path.join(SRC, file), body, 'utf8'); // 无尾换行:拼接时 join('\n') 还原原字节
  modules.push({ file, startLine: start, endLine: end, note });
  // 装载断言同款:模块首行必须顶格、非续行字符(切点自检,错刀启动即炸)
  const first = lines[start - 1];
  if (/^\s/.test(first) || /^[)\]};,]/.test(first)) {
    console.error(`切点不安全: ${file} 首行 ${JSON.stringify(first.slice(0, 50))}`); process.exit(1);
  }
}
fs.writeFileSync(path.join(SRC, 'manifest.json'), JSON.stringify({
  schema: 1,
  note: '第43波 构建期拼接模块化:模块 = 原单体连续行区间(顺序即原声明顺序);node app/build.js 拼接出 app/server.js 产物。改代码改 src/,产物由 build 重建,不手改。',
  modules,
}, null, 2), 'utf8');
console.log(`切片完成: ${modules.length} 模块 → ${SRC}`);
for (const m of modules) console.log(`  ${m.file.padEnd(28)} ${String(m.endLine - m.startLine + 1).padStart(5)} 行  ${m.note}`);
