'use strict';
const fs = require('fs');
const path = require('path');
const inventory = require('./durable-state-inventory.js');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
function ok(value, label) { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } }

try {
  const data = inventory.check();
  ok(data.count === inventory.entries.length && data.count >= 35, 'inventory artifact is fresh and covers every declared surface');
  ok(data.entries.every(entry => entry.owner && entry.schema && entry.writePrimitive && entry.corruption && entry.capacity && entry.cache && entry.recovery),
    'every surface declares owner/schema/write/corruption/capacity/cache/recovery');
  ok(data.entries.every(entry => entry.lifecycle === 'shared-lifecycle' || entry.exemptionReason), 'every private lifecycle is migrated or has an auditable exemption');
  const context = data.entries.find(entry => entry.id === 'context-calibration');
  ok(context && /DurableJsonStore/.test(context.writePrimitive) && context.lifecycle === 'shared-lifecycle', 'context calibration is the representative full-lifecycle migration');
  const source = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '10-context-governance.js'), 'utf8');
  ok(/DurableJsonStore\.create/.test(source) && !/const tmp = file \+ '\.tmp'/.test(source), 'context calibration no longer carries a private tmp/quarantine/write chain');
  // 架构还债批 2 B3:06d 的两个「坏了就当空」小存储迁到 DurableJsonStore(quarantine:false + cache:false),
  // 不再各自手写 read/parse/schema/mkdir/atomicWriteJson;清册里记的写原语跟着改。
  const src06d = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '06d-memory-domain.js'), 'utf8');
  for (const [id, storeName, fileFn] of [['memory-import-marker', 'accMemoryImportStore', 'accMemoryImportMarker'], ['agent-instructions-import', 'agentInstructionImportStore', 'agentInstructionImportFile']]) {
    const entry = data.entries.find(item => item.id === id);
    ok(entry && /DurableJsonStore/.test(entry.writePrimitive) && entry.lifecycle === 'shared-lifecycle', `${id} is recorded on the DurableJsonStore lifecycle`);
    ok(new RegExp('const ' + storeName + ' = DurableJsonStore\\.create\\(').test(src06d) && !new RegExp('atomicWriteJson\\(' + fileFn + '\\(').test(src06d),
      `${id}: 06d writes it only through ${storeName} (no private atomicWriteJson on that file)`);
  }
  const server = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'), 'utf8');
  // 5 处固定 tmp 写点与 autonomy-durability 的白名单同源:④ 处既有豁免 + 134 后台任务台账
  // background-jobs/<sessionId>.json(child close 同步事件内串行写,已在 durable-state-inventory.js 登记)。
  // 工具集优化批 F11:11b 的 atomicWriteFile 给【用户文件】做同目录 tmp+rename(名字带 pid+随机后缀,不是固定 tmp,
  // 也不是工作台自有的 JSON 状态,故不进清册),计数 5 -> 6。
  ok((server.match(/\+ '\.tmp'/g) || []).length === 6, 'no undeclared fixed-tmp JSON writer remains');
} catch (error) { console.error(error.stack || error); failures++; }

if (failures) process.exitCode = 1;
