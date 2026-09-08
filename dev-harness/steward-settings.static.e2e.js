#!/usr/bin/env node
'use strict';

// 第117波 117e 静态契约（27 号文 §5 117e 行／§8.6「权限的界面表达」／§4「面板」／§11.1 拍板 6·7）：
// 管家设置页与壳头部两个常驻控件的机械口径。
//   A 页签存在且顺序（基础 → 管家 → Agent CLI）、六组 <section> 与全部 cfgSteward* 控件 id；
//   B 四档表与全自动确认文案【从 steward-chips.js import】——settings 模块不定义第二份四档表；
//   C 开关的启停顺序锚（打开：save → start；关闭：stop → save）；
//   D 零 innerHTML、零计时器、`<a download>` 只用于记忆导出这一处；
//   E 头部盾牌与常驻停机键的骨架 + 头像菜单三项；
//   F 组合根口径：app.js 净增 ≤2 行（1280 护栏内）、provider-settings 只多一处调用；
//   G 新样式层三处登记 + 零硬编码色 + reduced-motion + 390px；
//   H i18n 两组键中英对称 + 禁词 + 引用到的键都齐备；
//   I 只调既有路由 + 117e 第 0 步那一条新只读面，零其它新增后端面；
//   J 117l-A3：新开线程用什么模型（强/快两档）——六个新 id、fillProviderOptions 三处 select
//     共用一份定义、写口整对象上传、六个新 i18n 键中英都非空且挂在面板里。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const app = read('app.js');
const settings = read('js/steward-settings.js');
const chips = read('js/steward-chips.js');
const conversation = read('js/steward-conversation.js');
const stewardShell = read('js/steward-shell.js');
const providerSettings = read('js/provider-settings.js');
const css = read('css/views/steward-settings.css');
const styles = read('styles.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));
const overlay = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');
const readFrontendCss = fs.readFileSync(path.join(__dirname, 'read-frontend-css.js'), 'utf8');

// 注释里要写清楚「零 innerHTML」这类纪律本身，扫危险 API 前先把注释剥掉（与 117c/117d 同一手法）。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const settingsCode = stripComments(settings);
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {

// ─── A 页签顺序、六组 section、全部控件 id ────────────────────────────────────────
const tabs = [...html.matchAll(/data-stab="([a-z]+)"/g)].map(match => match[1]);
ok(tabs.indexOf('steward') === tabs.indexOf('basic') + 1 && tabs.indexOf('claude') === tabs.indexOf('steward') + 1,
  `A1 页签顺序是「基础 → 管家 → Agent CLI」（实测 ${JSON.stringify(tabs.slice(0, 4))}）`);
ok(/<div class="settings-tab" id="stab-steward">/.test(html), 'A2 #stab-steward 面板存在');

const panelStart = html.indexOf('id="stab-steward"');
const panelEnd = html.indexOf('<!-- ===== Agent CLI', panelStart);
const panel = html.slice(panelStart, panelEnd);
ok(panelStart > 0 && panelEnd > panelStart, 'A3 管家面板在 Agent CLI 面板之前，边界可定位');

// 117l-A3 重钉：旧断言钉的是「117e 那一版」六组面板。117l-A3 在「模型与预算」之后插入第七组
// 「新开线程用什么模型」（强/快两档，§11.9）——新契约是七组、顺序固定，不是放宽旧契约，是把新组
// 纳入同一条「齐全且顺序固定」的判据（companion 见下面 A4b，单独钉住新组的插入位置）。
const GROUP_IDS = ['cfgStewardGroupPower', 'cfgStewardGroupPermission', 'cfgStewardGroupAuto',
  'cfgStewardGroupBudget', 'cfgStewardGroupThreadModels', 'cfgStewardGroupMemory', 'cfgStewardGroupDecisions'];
const groupOrder = [...panel.matchAll(/<section class="steward-settings-group" id="(cfgStewardGroup[A-Za-z]+)"/g)].map(m => m[1]);
ok(JSON.stringify(groupOrder) === JSON.stringify(GROUP_IDS),
  `A4 七组 <section> 齐全且顺序固定（实测 ${JSON.stringify(groupOrder)}）`);
// A4b companion（117l-A3 新增）：新组必须紧跟在「模型与预算」之后、「管家记得的关于你」之前——
// 不许插到别处（比如页尾或权限组旁边，那样会打散「预算相关的钱都聚在一起」这条既有阅读顺序）。
ok(groupOrder.indexOf('cfgStewardGroupThreadModels') === groupOrder.indexOf('cfgStewardGroupBudget') + 1
  && groupOrder.indexOf('cfgStewardGroupMemory') === groupOrder.indexOf('cfgStewardGroupThreadModels') + 1,
  'A4b 117l-A3：「新开线程用什么模型」紧跟在「模型与预算」之后、「管家记得的关于你」之前');

// 每一组都必须是真的 <section>（不是 div 冒充）且带 aria-labelledby（§8.8 无障碍）。
ok(GROUP_IDS.every(id => new RegExp(`<section class="steward-settings-group" id="${id}" aria-labelledby="`).test(panel)),
  'A5 每组 <section> 都有 aria-labelledby');

const CONTROL_IDS = [
  'cfgStewardEnabled', 'cfgStewardShellBtn', 'cfgStewardStopBtn', 'cfgStewardRunState',
  'cfgStewardDefaultPermission', 'cfgStewardPermissionHint', 'cfgStewardPermissionConfirm',
  'cfgStewardPermissionConfirmList', 'cfgStewardPermissionCancel', 'cfgStewardPermissionOk',
  'cfgStewardAutoRetry', 'cfgStewardAutoResume', 'cfgStewardAutoRelay', 'cfgStewardAutoNewThread',
  'cfgStewardProviderId', 'cfgStewardModel', 'cfgStewardPollMs', 'cfgStewardVisitIdle',
  'cfgStewardMaxTurnsPerHour', 'cfgStewardMaxCostPerDay', 'cfgStewardMaxParallelThreads',
  'cfgStewardGlobalMaxTurnsPerHour', 'cfgStewardGlobalMaxCostPerDay', 'cfgStewardRetention',
  // 117l-A3：新开线程「强模型」／「快速模型」两档，各自服务商 + 模型名。
  'cfgStewardStrongProviderId', 'cfgStewardStrongModel', 'cfgStewardFastProviderId', 'cfgStewardFastModel',
  'cfgStewardMemoryPanel', 'cfgStewardMemoryRefreshBtn', 'cfgStewardMemoryExportBtn',
  'cfgStewardMemoryClearBtn', 'cfgStewardMemoryClearConfirm', 'cfgStewardMemoryClearInput',
  'cfgStewardMemoryClearCancel', 'cfgStewardMemoryClearOk',
  'cfgStewardDecisions', 'cfgStewardDecisionsThread', 'cfgStewardDecisionsDate',
  'cfgStewardDecisionsRefreshBtn', 'cfgStewardDecisionsMoreBtn', 'cfgStewardNote',
];
const missingControls = CONTROL_IDS.filter(id => !new RegExp(`id="${id}"`).test(panel));
ok(missingControls.length === 0, `A6 ${CONTROL_IDS.length} 个 cfgSteward* 控件都在面板里（缺: ${missingControls.join(',') || '无'}）`);
// 控件命名纪律：面板里的 id 一律 cfgSteward 前缀（防日后混进不带前缀的散装 id）。
const panelIds = [...panel.matchAll(/\sid="([A-Za-z0-9_]+)"/g)].map(m => m[1]);
ok(panelIds.every(id => id.startsWith('cfgSteward')), `A7 面板内所有 id 都是 cfgSteward* 前缀（实测异类 ${panelIds.filter(id => !id.startsWith('cfgSteward')).join(',') || '无'}）`);
// 对话保留三档与到访静默都在「模型与预算」组里（§5 117e 行逐条点名的两项）。
ok(/id="cfgStewardRetention"[\s\S]{0,400}value="visit"[\s\S]{0,200}value="24h"[\s\S]{0,200}value="forever"/.test(panel),
  'A8 对话保留三档 visit/24h/forever 齐全且顺序固定');

// ─── B 四档表只有一份：settings 从 chips import，自己不再列举 ────────────────────
const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-settings.js')).href);
const chipsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-chips.js')).href);
const imports = [...settings.matchAll(/^import \{([\s\S]*?)\} from '([^']+)';$/gm)]
  .map(match => ({ names: match[1].split(',').map(name => name.trim()).filter(Boolean), from: match[2] }));
const fromChips = imports.find(entry => entry.from === './steward-chips.js');
ok(Boolean(fromChips), 'B1 steward-settings.js 从 steward-chips.js import 权限档位');
ok(fromChips && ['STEWARD_PERMISSION_MODES', 'STEWARD_PERMISSION_CONFIRM_MODES', 'STEWARD_CONFIRM_KEYS',
  'permissionLabelKey', 'permissionHintKey'].every(name => fromChips.names.includes(name)),
  `B2 四档表、确认档、确认文案键、两个人话键全部复用（实测 ${JSON.stringify(fromChips && fromChips.names)}）`);
ok(imports.every(entry => entry.from.startsWith('./')), 'B3 import 全部是本域内相对路径（零第三方库）');
// 「不定义第二份四档表」的机械判据：settings 模块里不许出现四档枚举的字面量。
ok(!/'acceptEdits'/.test(settingsCode) && !/'plan'/.test(settingsCode) && !/'auto'/.test(settingsCode),
  'B4 settings 模块零四档字面量（枚举只有 steward-chips.js 那一份）');
ok(!/confirmTitle[\s\S]{0,200}confirm1/.test(settingsCode)
  && (settingsCode.match(/STEWARD_CONFIRM_KEYS/g) || []).length >= 1
  && (chips.match(/stewardShell\.permission\.confirm1/g) || []).length === 1,
  'B5 §8.6 那五条确认文案只在 chips 里列一次，settings 只引用常量');
ok(JSON.stringify(chipsMod.STEWARD_PERMISSION_MODES) === JSON.stringify(['default', 'acceptEdits', 'plan', 'auto'])
  && JSON.stringify(chipsMod.STEWARD_PERMISSION_CONFIRM_MODES) === JSON.stringify(['auto']),
  'B6 复用到的四档表本身没被改动（顺序与内容仍是 117d 钉住的那一份）');
ok(Array.isArray(mod.STEWARD_MEMORY_KINDS)
  && JSON.stringify(mod.STEWARD_MEMORY_KINDS) === JSON.stringify(['profile', 'preference', 'habit', 'focus', 'policy']),
  'B7 记忆五类与后端 STEWARD_MEMORY_KINDS 同序');

// ─── C 开关的启停顺序（打开 save→start；关闭 stop→save）───────────────────────────
// `POST /api/config` 只落盘不启停：打开必须先落盘再 start（start 自己读 config，先 start 必 409），
// 关闭必须先 stop 再落盘（先落盘 false 的话 stop 会被同一道开关闸挡在门外）。
const enableBlock = settings.slice(settings.indexOf('async function toggleEnabled'), settings.indexOf('async function toggleStopped'));
const saveAt = enableBlock.indexOf("saveConfig({ stewardEnabledV1: true })");
const startAt = enableBlock.indexOf('stewardStart()');
ok(saveAt > 0 && startAt > saveAt, 'C1 打开：先 saveConfigPartial({stewardEnabledV1:true}) 再 POST /api/steward/start');
const stopAt = enableBlock.indexOf('stewardStop()');
const saveFalseAt = enableBlock.indexOf("saveConfig({ stewardEnabledV1: false })", stopAt);
ok(stopAt > startAt && saveFalseAt > stopAt, 'C2 关闭：先 POST /api/steward/stop 再落盘 false');
ok(/if \(!await saveConfig\(\{ stewardEnabledV1: true \}\)\) \{ if \(box\) box\.checked = false; return false; \}/.test(settings)
  && /if \(!started\) \{ if \(box\) box\.checked = true|if \(!started\) \{ if \(box\) box\.checked = false;/.test(settings),
  'C3 任一步失败都回滚勾选框（不留下「界面开着、盘上没开」）');
ok(/async function stewardStart\(\) \{ return call\('\/api\/steward\/start', \{ method: 'POST' \}\); \}/.test(settings)
  && /async function stewardStop\(\) \{ return call\('\/api\/steward\/stop', \{ method: 'POST' \}\); \}/.test(settings),
  'C4 启停各只有一个函数封装（别处不许再拼这两条请求）');
// 一键停机只动运行态，不动配置（§8.6「常驻且永远可点」）。
const stopBlock = settings.slice(settings.indexOf('async function toggleStopped'), settings.indexOf('function setStopped'));
ok(!/saveConfig\(/.test(stopBlock), 'C5 一键停机／唤醒不写配置（只动运行态）');

// ─── D 零 innerHTML、零计时器、<a download> 只此一处 ─────────────────────────────
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(settingsCode),
  'D1 零 innerHTML/insertAdjacentHTML/document.write');
// 117n-M1 重钉：el()/button()/clear() 搬进 steward-chips.js 集中定义（六个消费方零本地重复）之后，
// settings.js 自己不再直接调 .createElement——但它仍然只经从 chips.js import 的共享
// el()/button()/clear() 生成节点，createElement 本体仍可在 chips.js 里查证；同一条 chips import
// 也确实带着 doc/byId/el/clear/button 这五个名字（fromChips 是下面 B 节已经解析好的那份，此处复用
// 不再重新解析一次）。原判据只证明「某处调过 createElement」；新判据在此之上再加两条正面证据
// （五个名字真的都 import 了、零本地重复定义），是更强而不是更弱的版本。
ok(/textContent/.test(settings)
  && /createElement\(/.test(chips)
  && ['doc', 'byId', 'el', 'clear', 'button'].every(name => fromChips.names.includes(name))
  && !/function el\(tag, className, text\) \{/.test(settingsCode)
  && !/function button\(className, text, onClick\) \{/.test(settingsCode)
  && !/function clear\(node\) \{ if \(node\)/.test(settingsCode)
  && !/const doc = \(\) => globalThis\.document \|\| null;/.test(settingsCode)
  && !/const byId = id => \(doc\(\) \? doc\(\)\.getElementById\(id\) : null\);/.test(settingsCode),
  'D2 设置页的节点创建委托给 steward-chips.js 共享的 el()/button()/clear()（117n-M1 去重）：五个名字都从同一条 import 拿、零本地重复定义，createElement 仍可在 chips.js 里查证');
const count = (source, pattern) => (source.match(pattern) || []).length;
ok(count(settingsCode, /setInterval\(/g) === 0 && count(settingsCode, /setTimeout\(/g) === 0,
  'D3 设置页零计时器（不轮询；停机态由壳层那一处已有的 setInterval 喂进来）');
ok(count(settingsCode, /\.download = /g) === 1 && /anchor\.download = 'steward-memory\.json';/.test(settings),
  'D4 全模块恰好一处 `<a download>`，且只用于记忆导出');
ok(count(stewardShell, /setInterval\(/g) === 1,
  'D5 steward-shell.js 仍然全文件恰好一处 setInterval（117b 的 C2a 未被 117e 稀释）');
ok(count(stewardShell, /\bapi\(/g) === 1,
  'D6 steward-shell.js 仍然全文件恰好一处 api() 调用（117a 的 C3a 未被稀释；settings 拿到的是注入的引用）');
// 结构化 error 绝不 String() 直落（与 117e 第 0 步给 conversation 立的同一条纪律）。
const afterHelper = settingsCode.slice(settingsCode.indexOf('async function call('));
ok(!/String\([^)]*\berror\b/.test(afterHelper), 'D7 errorText 之外零 String(<error 值>)');
// 117n-M1②：settings.js 原来的本地 errorText 少了 error instanceof Error 分支（api() 抛出的原始
// Error 会退化成「[object Object]」那一类）——它旁边的注释自己也承认「与 steward-conversation
// 同一条纪律」，那就该是【同一份】而不是【抄一份】。现在直接 import steward-conversation.js 的
// stewardErrorText，本文件零第二份错误解包实现。
ok(/import \{ stewardErrorText \} from '\.\/steward-conversation\.js';/.test(settings),
  'D7b settings.js 的错误信封解包从 steward-conversation.js import，不是自己再写一份');
ok(!/function errorText\(error\) \{/.test(settingsCode),
  'D7c 旧的本地 errorText（漏了 error instanceof Error 分支的弱化版）已经不在了');
ok((settingsCode.match(/stewardErrorText\(/g) || []).length >= 2,
  'D7d call() 里两处（response.error 分支与 catch 分支）都改用了 stewardErrorText');

// ─── E 壳头部两个常驻控件 + 头像菜单三项 ────────────────────────────────────────
const stewardStart_ = html.indexOf('<section id="stewardShell"');
const headerEnd = html.indexOf('</header>', stewardStart_);
const header = html.slice(stewardStart_, headerEnd);
ok(/id="stewardShieldBtn"[^>]*aria-haspopup="true"/.test(header) && /id="stewardShieldMenu"[^>]*role="menu"/.test(header),
  'E1 盾牌按钮与四档菜单在 #stewardHeader 里（§8.2 右上两个常驻图标之一）');
ok(/id="stewardStopBtn"/.test(header), 'E2 一键停机键常驻在 #stewardHeader 里');
ok(/class="steward-header-actions"/.test(header), 'E3 两个常驻控件在同一条 actions 行里');
ok(Array.isArray(mod.STEWARD_MEMORY_KINDS) && typeof mod.createStewardSettingsDomain === 'function',
  'E4 设置域是导出的工厂函数');
const menuSections = (await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-conversation.js')).href)).STEWARD_MENU_SECTIONS;
ok(Array.isArray(menuSections) && JSON.stringify(menuSections) === JSON.stringify([
  ['stewardShell.menu.settings', ''],
  ['stewardShell.menu.memory', 'memory'],
  ['stewardShell.menu.decisions', 'decisions'],
]), `E5 头像菜单在「细节」之后加三项，顺序固定（实测 ${JSON.stringify(menuSections)}）`);
ok(/openStewardPanel\(section\)/.test(conversation) && /openStewardPanel = null,/.test(conversation),
  'E6 对话模块只负责调用注入的 openStewardPanel（不认识设置页的任何 id）');
ok(/openStewardPanel: section => settings\.openPanel\(section\),/.test(stewardShell),
  'E7 注入在 steward-shell.js 内完成（组合根不参与）');

// ─── F 组合根口径 ───────────────────────────────────────────────────────────────
const appLines = app.split(/\r?\n/).length;
ok(appLines <= 1280, `F1 app.js 仍在 1280 行护栏内（实测 ${appLines}）`);
const appStewardLines = app.split('\n').filter(line => /fillStewardSettings|openSettingsTab:/.test(line));
ok(appStewardLines.length === 2 && appStewardLines.every(line => /\/\/ 117e/.test(line)),
  `F2 组合根为 117e 净增恰好两行注入（fillStewardSettings + openSettingsTab；实测 ${appStewardLines.length} 行）`);
// 117j classic-2 重钉：这两条管家侧的旁路各自包了一层 try/catch（谁抛错都不该把它后面的草稿播种与
// renderProviders() 一起带走）。「只多一处调用」这条契约一个字没变，变的是它外面多了一层守卫。
ok(count(providerSettings, /fillStewardSettings\(\)/g) === 1
  && /try \{ fillStewardSettings\(\); \}          \/\/ 117e/.test(providerSettings),
  'F3 provider-settings.js 只多一处 fillStewardSettings() 调用（既有静态锁只加）');
ok(/try \{ syncStewardShellAvailability\(\); \}[\s\S]{0,120}console\.warn\('\[steward\] syncStewardShellAvailability failed'/.test(providerSettings)
  && /try \{ fillStewardSettings\(\); \}[\s\S]{0,120}console\.warn\('\[steward\] fillStewardSettings failed'/.test(providerSettings),
  'F3b 117j classic-2：两条管家旁路各自 try/catch + console.warn，任何抛错不得阻断其后的草稿播种与 renderProviders()');
// 117j UX-F1 重钉：注入表多了 syncShellAvailability（总开关关掉即回经典，判定仍在壳层单点）。
ok(/const settings = createStewardSettingsDomain\(\{\s*api, state, t, saveConfigPartial, openSettingsTab, presence: presenceApi,\s*syncShellAvailability: \(\) => syncStewardShellAvailability\(\),\s*\}\);/.test(stewardShell),
  'F4 设置域在 steward-shell.js 内组装并注入依赖');
ok(/try \{ syncShellAvailability\(\); \} catch \(error\) \{ console\.warn\('\[steward\] syncShellAvailability failed', error\); \}/.test(settings),
  'F4b 117j UX-F1：总开关落盘之后跑一次准入判定 —— 人在管家壳里就 recoverStewardShell 回经典（状态行说的和看到的必须是同一件事）');

// ─── G 新样式层三处登记 + token / 降级 / 窄屏 ───────────────────────────────────
ok(styles.includes('@import url("/css/views/steward-settings.css");')
  && html.includes('<link rel="stylesheet" href="/css/views/steward-settings.css" />'),
  'G1 styles.css @import 与 index.html 直链同步收录 steward-settings.css');
ok(readFrontendCss.includes("'css/views/steward-settings.css',"),
  'G2 read-frontend-css.js 的 CSS_PAYLOAD_GROUPS 收录 steward-settings.css');
ok(overlay.includes("'app/public/css/views/steward-settings.css'")
  && overlay.includes("'app/public/js/steward-settings.js'"),
  'G3 离线包清单收录 117e 的两个新文件');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(cssCode), 'G4 设置层 CSS 全部使用主题/语义 token，无硬编码色值');
ok(/@media \(prefers-reduced-motion: reduce\)/.test(css), 'G5 reduced-motion 降级分支存在');
ok(/@media \(max-width: 390px\)/.test(css), 'G6 390px 窄屏断点存在');
ok(/\.steward-decisions \{ overflow-x: auto; \}/.test(css), 'G7 宽表自己横向滚（页面不横滚）');

// ─── H i18n：两组键中英对称 + 禁词 + 引用齐备 ──────────────────────────────────
for (const prefix of ['settings.steward.', 'stewardShell.menu.']) {
  const zhKeys = Object.keys(zh).filter(key => key.startsWith(prefix)).sort();
  const enKeys = Object.keys(en).filter(key => key.startsWith(prefix)).sort();
  ok(zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `H1 ${prefix}* 中英键对称（${zhKeys.length} 条）`);
}
const FORBIDDEN = [/速问/, /不立单/, /已切到档位/, /Pretender/, /3\.0/];
const namespaced = Object.keys(zh).filter(key => key.startsWith('settings.steward.') || key.startsWith('stewardShell.'));
for (const pattern of FORBIDDEN) {
  ok(namespaced.every(key => !pattern.test(String(zh[key])) && !pattern.test(String(en[key])))
    && !pattern.test(settingsCode) && !pattern.test(cssCode),
    `H2 文案与源码零出现 ${pattern.source}`);
}
const usedKeys = [...new Set([...settings.matchAll(/'((?:settings\.steward|stewardShell)\.[a-zA-Z0-9_.]+)'/g)].map(m => m[1]))];
const missingKeys = usedKeys.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string');
ok(missingKeys.length === 0, `H3 模块引用的 ${usedKeys.length} 个 i18n 键中英都齐备（缺: ${missingKeys.join(',') || '无'}）`);
// 两组模板键（记忆 kind 与流水列头）也必须齐备 —— 它们是 `${}` 拼出来的，上面那条扫不到。
const template = [
  ...mod.STEWARD_MEMORY_KINDS.map(kind => `settings.steward.memory.kind.${kind}`),
  ...['at', 'what', 'thread', 'permission', 'basis', 'cost', 'undo'].map(col => `settings.steward.decisions.col.${col}`),
  ...Object.values(mod.STEWARD_TOOL_LABEL_KEYS),
];
const missingTemplate = template.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string');
ok(missingTemplate.length === 0, `H4 模板拼出来的 ${template.length} 个键也齐备（缺: ${missingTemplate.join(',') || '无'}）`);

// ─── I 后端面：只用 116 已有的 + 117e 第 0 步那一条 ───────────────────────────────
const routes = [...new Set([
  ...[...settingsCode.matchAll(/'(\/api\/[a-z/-]+)[^']*'/g)].map(match => match[1]),
  ...[...settingsCode.matchAll(/`(\/api\/[a-z/-]+)\?/g)].map(match => match[1]),
])].sort();
const ALLOWED = [
  '/api/config-is-not-called-here',  // 占位：配置写口只经注入的 saveConfigPartial，本模块不拼它
  '/api/session/rewind', '/api/steward/decisions', '/api/steward/memory', '/api/steward/memory/clear',
  '/api/steward/memory/edit', '/api/steward/memory/export', '/api/steward/memory/restore',
  '/api/steward/memory/veto', '/api/steward/start', '/api/steward/state', '/api/steward/stop',
].filter(route => !route.includes('not-called-here')).sort();
ok(JSON.stringify(routes) === JSON.stringify(ALLOWED),
  `I1 只调 116 已有的路由 + 117e 第 0 步的 /api/steward/decisions（实测 ${JSON.stringify(routes)}）`);
ok(!/\/api\/config/.test(settingsCode) && count(settingsCode, /saveConfigPartial\(/g) >= 1,
  'I2 配置写口只经注入的 saveConfigPartial（本模块不自己拼 POST /api/config）');
ok(count(settingsCode, /\bfetch\(/g) === 0, 'I3 零直调 fetch（一律经注入的 api()）');

// ─── J 117l-A3：新开线程用什么模型（强/快两档）──────────────────────────────────
const THREAD_MODEL_IDS = ['cfgStewardGroupThreadModels', 'cfgStewardThreadModelsHeading',
  'cfgStewardStrongProviderId', 'cfgStewardStrongModel', 'cfgStewardFastProviderId', 'cfgStewardFastModel'];
const missingThreadModelIds = THREAD_MODEL_IDS.filter(id => !new RegExp(`id="${id}"`).test(panel));
ok(missingThreadModelIds.length === 0, `J1 六个新 id 都在管家面板里（缺: ${missingThreadModelIds.join(',') || '无'}）`);
const budgetIdx = panel.indexOf('id="cfgStewardGroupBudget"');
const threadModelsIdx = panel.indexOf('id="cfgStewardGroupThreadModels"');
ok(budgetIdx > 0 && threadModelsIdx > budgetIdx, 'J2 六个新 id 所在的组确实在 cfgStewardGroupBudget 之后');
// fillProviderOptions 只有一处定义、三处调用（管家自己／强模型／快模型三个 select 共用同一份填充逻辑，
// 不复制第二份）：字面量出现次数 = 1 处 `function fillProviderOptions(` + 3 处调用 = 4。
ok(count(settingsCode, /function fillProviderOptions\(/g) === 1, 'J3 fillProviderOptions 只有一处定义');
ok(count(settingsCode, /fillProviderOptions\(/g) === 4,
  `J4 fillProviderOptions 恰好三处调用（连同定义共 4 处字面量；实测 ${count(settingsCode, /fillProviderOptions\(/g)}）`);
// stewardThreadModels 整对象上传：merge 出来的补丁必须带上 current（既有的另一档），不是只传半个。
ok(/const current = \(config\(\)\.stewardThreadModels/.test(settings) && /\.\.\.current, \[tier\]:/.test(settings),
  'J5 强/快两档的写口在当前 config 基础上合并整个 stewardThreadModels 对象上传（不是只传半个）');
const THREAD_MODEL_KEYS = [
  'settings.steward.group.threadModels', 'settings.steward.threadModels.strongProvider',
  'settings.steward.threadModels.strongModel', 'settings.steward.threadModels.fastProvider',
  'settings.steward.threadModels.fastModel', 'settings.steward.threadModels.hint',
];
const missingThreadModelKeys = THREAD_MODEL_KEYS.filter(key => !(typeof zh[key] === 'string' && zh[key].length > 0 && typeof en[key] === 'string' && en[key].length > 0));
ok(missingThreadModelKeys.length === 0, `J6 六个新 i18n 键 zh/en 都非空（缺: ${missingThreadModelKeys.join(',') || '无'}）`);
ok(THREAD_MODEL_KEYS.every(key => panel.includes(`data-i18n="${key}"`)),
  'J7 六个新键都在面板里以 data-i18n 挂上（不是孤儿翻译）');

console.log(`\nSTEWARD SETTINGS STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
