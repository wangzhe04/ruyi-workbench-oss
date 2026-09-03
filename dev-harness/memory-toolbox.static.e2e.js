'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let failures = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { failures++; console.log('FAIL ' + label); } };

const html = read('ruyi-workbench/app/public/index.html');
const js = read('ruyi-workbench/app/public/js/skills-memory.js');
const nav = read('ruyi-workbench/app/public/js/navigation-controls.js');
const css = read('ruyi-workbench/app/public/css/components/tool-pane.css');
// 110-1: MCP_TOOLS(含 workbench_memory_* schema)已搬至 13f-native-tool-schemas.js,改拼接读取,断言原样保留。
const router = read('ruyi-workbench/app/src/13-http-router.js') + read('ruyi-workbench/app/src/13f-native-tool-schemas.js');
const autonomy = read('ruyi-workbench/app/src/06d-memory-domain.js');
const zh = JSON.parse(read('ruyi-workbench/app/public/locales/zh-CN.json'));
const en = JSON.parse(read('ruyi-workbench/app/public/locales/en-US.json'));

ok(/data-tab="memory"/.test(html) && /id="tab-memory"/.test(html), 'tool pane exposes a first-class Memory tab');
ok(/memoryToolboxOverview/.test(html) && /memoryToolboxSearch/.test(html) && /data-memory-filter="core"/.test(html), 'memory toolbox has budget overview, search, and core/review filters');
ok(/openMemoryToolbox\(\)/.test(nav) && /tab === 'memory'/.test(nav), 'Memory tab lazy-loads its own data');
ok(/buildMemoryToolboxCard/.test(js) && /openMemoryEditModal/.test(js) && /deleteMemoryRow/.test(js), 'toolbox supports viewing, editing, and deleting entries');
ok(/\/api\/memory\/metadata/.test(js) && /memory-core-toggle/.test(js) && /memory-important-toggle/.test(js), 'toolbox supports core membership and importance protection controls');
ok(/CORE_MEMORY_MAX = 24/.test(autonomy) && /CORE_MEMORY_CHAR_CAP = 4200/.test(autonomy), 'core capsule uses widened count and character limits');
ok(/memoryCoreScore/.test(autonomy) && /important/.test(autonomy) && /core-rule/.test(autonomy), 'protected LRU accounts for importance and implicit rule use');
ok(/pathname === '\/api\/memory\/metadata'/.test(router), 'metadata quick actions preserve the full memory through a dedicated backend route');
ok(/memory-card\.status-active/.test(css) && /memory-budget-track/.test(css) && /@media \(max-width: 420px\)/.test(css), 'toolbox has distinct active states, budget feedback, and narrow-screen polish');
ok(zh['memory.toolbox.title'] && en['memory.toolbox.title'] && zh['memory.edit.typePreference'] && en['memory.edit.typePreference'], 'new memory UI is localized in Chinese and English');

console.log('\nMEMORY TOOLBOX STATIC E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exit(failures ? 1 : 0);
