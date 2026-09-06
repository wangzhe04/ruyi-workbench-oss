#!/usr/bin/env node
'use strict';

// 第117波 117a 静态契约：壳模式三态（classic / preview / steward）长期并存、未知偏好回经典、
// 管家壳是 .app-shell 与 #previewShell 的同级容器、显隐只由 data-shell-mode 这一个状态源驱动、
// 管家壳模块零 innerHTML / 零轮询 / 三分支 fail-closed，且新资源进入离线 overlay 与样式清单。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const app = read('app.js');
const previewShell = read('js/preview-shell.js');
const stewardShell = read('js/steward-shell.js');
const providerSettings = read('js/provider-settings.js');
const css = read('css/views/steward-shell.css');
const styles = read('styles.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));
const overlay = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

// ─── A 三态与唯一状态源 ──────────────────────────────────────────────────────────
const modesMatch = previewShell.match(/export const SHELL_MODES = Object\.freeze\((\[[^\]]*\])\);/);
const declaredModes = modesMatch ? JSON.parse(modesMatch[1].replace(/'/g, '"')) : null;
ok(JSON.stringify(declaredModes) === JSON.stringify(['classic', 'preview', 'steward']),
  'A1 SHELL_MODES 是冻结三态且顺序固定 classic/preview/steward');
ok(previewShell.includes("SHELL_MODES.includes(value) ? value : 'classic'"),
  'A2 normalizeShellMode 是显式白名单判定，未知值回 classic');

// 预绘脚本与白名单同构：脚本认得的非 classic 模式，必须正好是 SHELL_MODES 去掉 classic。
const prePaint = html.slice(html.indexOf("localStorage.getItem('wcw.shellMode')"), html.indexOf('</script>'));
const prePaintModes = [...prePaint.matchAll(/stored === '([a-z]+)'/g)].map(match => match[1]);
ok(JSON.stringify(prePaintModes) === JSON.stringify(['preview', 'steward'])
  && /: 'classic'/.test(prePaint)
  && /catch \(e\) \{ document\.documentElement\.setAttribute\('data-shell-mode', 'classic'\); \}/.test(html),
  'A3 index.html 预绘白名单与 SHELL_MODES 同构，异常与未知都回 classic');

// data-shell-mode 是唯一状态源：全仓写入点只有预绘脚本(2)、applyShellMode(1)、
// recoverClassicShell(1)、recoverStewardShell(1)，别处一律不许写。
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(?:js|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const writeSites = [];
for (const file of walk(PUBLIC)) {
  const source = fs.readFileSync(file, 'utf8');
  const count = (source.match(/setAttribute\('data-shell-mode'/g) || []).length;
  if (count) writeSites.push([path.relative(PUBLIC, file).replace(/\\/g, '/'), count]);
}
ok(JSON.stringify(writeSites.sort()) === JSON.stringify([
  ['index.html', 2], ['js/preview-shell.js', 2], ['js/steward-shell.js', 1],
]), 'A4 data-shell-mode 写入点只有预绘脚本 / applyShellMode+recoverClassicShell / recoverStewardShell'
  + `（实测 ${JSON.stringify(writeSites)}）`);
ok(/function recoverClassicShell[\s\S]{0,200}setAttribute\('data-shell-mode', 'classic'\)|const recoverClassicShell = \(\) => \{[\s\S]{0,200}setAttribute\('data-shell-mode', 'classic'\)/.test(previewShell)
  && /function applyShellMode\(value[\s\S]{0,700}document\.documentElement\.setAttribute\('data-shell-mode', mode\);/.test(previewShell),
  'A5 preview-shell 的两处写入分别住在 recoverClassicShell 与 applyShellMode 里');
ok(/if \(mode === 'steward' && !canEnterSteward\(\)\) return recoverStewardShell\(\{ persist \}\) \|\| recoverClassicShell\(\);/.test(previewShell)
  && /canEnterSteward = \(\) => false,/.test(previewShell)
  && /recoverStewardShell = \(\) => '',/.test(previewShell),
  'A6 进管家壳前先过注入的准入判定，缺省注入即 fail-closed（准入恒 false）');

// ─── B 同级容器与骨架空位 ────────────────────────────────────────────────────────
const appShellStart = html.indexOf('<div class="app-shell">');
const previewStart = html.indexOf('<section id="previewShell"');
const previewEnd = html.indexOf('id="previewShellStatus"', previewStart);
const stewardStart = html.indexOf('<section id="stewardShell"');
ok(appShellStart >= 0 && previewStart > appShellStart && previewEnd > previewStart && stewardStart > previewEnd,
  'B1 #stewardShell 是 .app-shell 与 #previewShell 之后的同级后置容器，两壳骨架未被包入新壳');
const stewardEnd = html.indexOf('</section>', stewardStart);
const stewardMarkup = html.slice(stewardStart, stewardEnd);
for (const id of ['stewardHeader', 'stewardFeed', 'stewardComposer', 'stewardStatus', 'stewardClassicBtn']) {
  ok(new RegExp(`id="${id}"`).test(stewardMarkup), `B2 ${id} 空位在管家壳容器内`);
}
ok(/<section id="stewardShell"[^>]*tabindex="-1"/.test(html), 'B3 管家壳容器可编程获焦（tabindex=-1）');
ok(/id="stewardFeed"[^>]*role="log"[^>]*aria-live="polite"/.test(stewardMarkup),
  'B4 对话流是 role="log" 的礼貌播报区');
ok(/id="stewardStatus"[^>]*role="status"[^>]*aria-live="polite"/.test(stewardMarkup),
  'B5 状态区是 role="status" 的礼貌播报区');
ok(/<textarea id="stewardComposerInput"[\s\S]{0,200}disabled/.test(stewardMarkup),
  'B6 117a 的输入框只是禁用占位（真输入归 117c）');
ok(/<option value="steward" data-i18n="stewardShell\.settingOption">/.test(html)
  && /id="stewardShellModeHint"[^>]*data-i18n="stewardShell\.settingDisabledHint"[^>]*hidden/.test(html),
  'B7 设置页壳模式第三项与「先打开管家」提示都在 DOM 里');

// ─── C 管家壳模块：零 innerHTML、零轮询、三分支 fail-closed ─────────────────────
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(stewardShell),
  'C1 管家壳模块零 innerHTML/insertAdjacentHTML/document.write');
ok(!/setInterval|setTimeout/.test(stewardShell),
  'C2 管家壳模块零 timer —— 开关关时不产生任何后台活动');
ok(!/\bapi\(|\bfetch\(/.test(stewardShell),
  'C3 117a 的管家壳不发任何请求（api 只是留给 117c 的注入口）');
ok(/if \(!dependenciesReady\) setStatusText\('stewardShell\.recovery\.dependency'\);/.test(stewardShell)
  && /else if \(!stewardShellDomReady\(\)\) setStatusText\('stewardShell\.recovery\.missingShell'\);/.test(stewardShell)
  && /else setStatusText\('stewardShell\.recovery\.disabled'\);/.test(stewardShell),
  'C4 recoverStewardShell 的三条 fail-closed 分支（依赖缺失/骨架缺失/开关关）各有 i18n 原因');
ok(/function recoverStewardShell\(\{ persist = true \} = \{\}\) \{/.test(stewardShell)
  && /if \(persist\) setStoredMode\('classic'\);/.test(stewardShell)
  && /syncModeSelector\('classic'\)/.test(stewardShell),
  'C5 fail-closed 会写属性、按需落盘本机偏好、同步设置页选择器');
ok(/function canEnterSteward\(\) \{\s*return stewardEnabledInConfig\(state && state\.config\) && stewardShellDomReady\(\);\s*\}/.test(stewardShell),
  'C6 canEnterSteward 只看管家开关与骨架齐备两件事');
ok(/config\.stewardEnabledV1 === true/.test(stewardShell)
  && /STEWARD_SHELL_SLOT_IDS = Object\.freeze\(\[/.test(stewardShell),
  'C7 开关判据读 config.stewardEnabledV1，空位清单是冻结常量');
ok(stewardShell.includes('return Object.freeze({'), 'C8 管家壳领域导出是冻结对象');
ok(app.includes("from './js/steward-shell.js'") && app.includes('createStewardShellDomain({')
  && app.includes('bindStewardShell();')
  && app.includes('stewardShellGuard = stewardShellDomain;')
  && providerSettings.includes('syncStewardShellAvailability(); // 117a'),
  'C9 组合根只做领域组合与绑定，config 刷新点同步第三项可选性');

// ─── D 样式层 ────────────────────────────────────────────────────────────────────
ok(/:root\[data-shell-mode="steward"\] body > \.app-shell \{ display: none !important; \}/.test(css),
  'D1 管家模式隐藏经典壳');
ok(/:root\[data-shell-mode="steward"\] body > \.preview-shell \{ display: none !important; \}/.test(css),
  'D2 管家模式隐藏交办台预览壳');
ok(/\.steward-shell \{\s*display: none;/.test(css)
  && /:root\[data-shell-mode="steward"\] body > \.steward-shell \{[\s\S]{0,200}display: grid/.test(css),
  'D3 管家壳默认不显示，只有管家模式才铺开');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'D4 管家壳 CSS 全部使用主题/语义 token，无硬编码色值');
ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'D5 reduced-motion 降级分支存在');
ok(/@media \(max-width: 390px\)/.test(css), 'D6 390px 窄屏断点存在');
ok(!/setInterval|animation:/.test(css), 'D7 骨架层零动画、零默认轮询税');

// ─── E i18n 与离线载荷 ───────────────────────────────────────────────────────────
const zhKeys = Object.keys(zh).filter(key => key.startsWith('stewardShell.')).sort();
const enKeys = Object.keys(en).filter(key => key.startsWith('stewardShell.')).sort();
ok(zhKeys.length >= 8 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
  `E1 管家壳 i18n 中英键对称(${zhKeys.length})`);
ok(zhKeys.every(key => !/Pretender|3\.0/.test(String(zh[key])))
  && enKeys.every(key => !/Pretender|3\.0/.test(String(en[key]))),
  'E2 管家壳文案不提前暴露内部代号与保留大版本号');
ok(['stewardShell.recovery.disabled', 'stewardShell.recovery.missingShell', 'stewardShell.recovery.dependency']
  .every(key => zhKeys.includes(key)), 'E3 三条 fail-closed 原因文案都在目录里');
ok(overlay.includes("'app/public/js/steward-shell.js'")
  && overlay.includes("'app/public/css/views/steward-shell.css'"), 'E4 管家壳 JS/CSS 进入 overlay 载荷');
ok(styles.includes('@import url("/css/views/steward-shell.css");')
  && html.includes('<link rel="stylesheet" href="/css/views/steward-shell.css" />'),
  'E5 兼容样式清单与直载 CSS 同步');

console.log(`\nSTEWARD SHELL STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
