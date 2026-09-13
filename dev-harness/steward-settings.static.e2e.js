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
// 121-K7 翻面重钉（34 号文 §13.5 登记③与 §7.2 表首行）：在「新开线程用什么模型」之后
// 插入两组 ——「任务索引」（threadIndexRecent 的设置入口）与「定时任务」（口袋第一项与
// 焦点栏「接下来」落到的那一面）。新契约是八组、顺序固定，不是放宽旧契约。
const GROUP_IDS = ['cfgStewardGroupPower', 'cfgStewardGroupPermission', 'cfgStewardGroupAuto',
  'cfgStewardGroupBudget', 'cfgStewardGroupThreadModels', 'cfgStewardGroupIndex', 'cfgStewardGroupSchedule',
  'cfgStewardGroupMemory', 'cfgStewardGroupDecisions'];
const groupOrder = [...panel.matchAll(/<section class="steward-settings-group" id="(cfgStewardGroup[A-Za-z]+)"/g)].map(m => m[1]);
ok(JSON.stringify(groupOrder) === JSON.stringify(GROUP_IDS),
  `A4 八组 <section> 齐全且顺序固定（实测 ${JSON.stringify(groupOrder)}）`);
// A4b companion（117l-A3 新增）：新组必须紧跟在「模型与预算」之后、「管家记得的关于你」之前——
// 不许插到别处（比如页尾或权限组旁边，那样会打散「预算相关的钱都聚在一起」这条既有阅读顺序）。
// 121-K7 翻面：K7 的两组插在 ThreadModels 与 Memory 之间，所以 A4b 的后半从「紧挨着 Memory」
// 改成「紧挨着 Index」，前半（紧跟 Budget）一个字不动 —— 钉的仍是那条阅读顺序：
// 钱的三组连在一起 → 任务索引 → 定时任务 → 记忆 → 流水。
ok(groupOrder.indexOf('cfgStewardGroupThreadModels') === groupOrder.indexOf('cfgStewardGroupBudget') + 1
  && groupOrder.indexOf('cfgStewardGroupIndex') === groupOrder.indexOf('cfgStewardGroupThreadModels') + 1
  && groupOrder.indexOf('cfgStewardGroupSchedule') === groupOrder.indexOf('cfgStewardGroupIndex') + 1
  && groupOrder.indexOf('cfgStewardGroupMemory') === groupOrder.indexOf('cfgStewardGroupSchedule') + 1,
  'A4b 117l-A3＋121-K7：「新开线程用什么模型」紧跟「模型与预算」，其后依次是「任务索引」「定时任务」「管家记得的关于你」');

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
// 33 号文 §4（M3-a）：确认类知识（§8.6 那五条文案键 + 「哪一档要二次确认」）登记表的正身 —— B5* 组正面查它。
const confirmPanelMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'confirm-panel.js')).href);
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
// M3-a **重钉 B5**（33 号文 §4）：旧判据是 chips 的字面计数（`(chips.match(/…confirm1/g) || []).length === 1`）
// ——它把「这五条只在 chips 里列一次」钉成「谁抄了这几行」。键搬进 js/confirm-panel.js（危险操作确认的
// 共用件）之后 chips 计数变 0，这条锁必然真红。新判据不数 chips，改成三条【结构判定】（比旧判据强）：
//   ① 前端 js 源码里那五条键的字面量只许出现在 confirm-panel.js（locales 里的译文键不算编码面）；
//   ② chips 里不再有那份定义，只剩「import … from './confirm-panel.js'」与 re-export 两行；
//   ③ 运行时同一性：chips 导出的就是 confirm-panel 那个数组对象本身，settings 只引用常量（零字面量）。
const confirmPanel = read('js/confirm-panel.js');
const countConfirmKeys = source => (stripComments(source).match(/stewardShell\.permission\.confirm[1-5]/g) || []).length;
const jsFiles = [];
(function walkJs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'locales') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full);
    else if (entry.name.endsWith('.js')) jsFiles.push(full);
  }
})(PUBLIC);
const strayKeyFiles = jsFiles
  .filter(file => path.basename(file) !== 'confirm-panel.js' && countConfirmKeys(fs.readFileSync(file, 'utf8')) > 0)
  .map(file => path.relative(PUBLIC, file));
ok(countConfirmKeys(confirmPanel) === 5 && strayKeyFiles.length === 0,
  `B5 §8.6 那五条确认文案键全仓只在 js/confirm-panel.js 登记一次（实测 confirm-panel=${countConfirmKeys(confirmPanel)}，别处 ${strayKeyFiles.join(',') || '零'}）`);
ok(/^import \{[^}]*\bSTEWARD_CONFIRM_KEYS\b[^}]*\} from '\.\/confirm-panel\.js';$/m.test(chips)
  && /export \{[^}]*\bSTEWARD_CONFIRM_KEYS\b[^}]*\};/.test(chips)
  && !/export const STEWARD_CONFIRM_KEYS/.test(chips),
  'B5b chips 不再自列那五条：从 confirm-panel.js import 后原样 re-export（117d 起的公开面一字未改）');
ok(chipsMod.STEWARD_CONFIRM_KEYS === confirmPanelMod.STEWARD_CONFIRM_KEYS
  && chipsMod.STEWARD_CONFIRM_KEYS.length === 5
  && !/confirmTitle[\s\S]{0,200}confirm1/.test(settingsCode)
  && (settingsCode.match(/STEWARD_CONFIRM_KEYS/g) || []).length >= 1,
  'B5c 运行时同一性：chips 那份就是 confirm-panel 登记表那个数组（同一个对象），settings 只引用常量、不复制文案');
// 「要不要二次确认」的判据也只有一份：chips 菜单口与 settings 两处判定（onPermissionChange / toggleShield）
// 读的是同一个数组对象；判据表达式的形状仍由 K8 与 steward-drawer.static 的 E10 逐字钉着（没放宽）。
ok(chipsMod.STEWARD_PERMISSION_CONFIRM_MODES === confirmPanelMod.STEWARD_PERMISSION_CONFIRM_MODES
  && !/export const STEWARD_PERMISSION_CONFIRM_MODES/.test(chips),
  'B5d 「哪一档要二次确认」同样只有一份定义（confirm-panel.js），chips 与 settings 读同一个数组对象');
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

// ─── E 两个常驻控件（121-K4 起住在外框顶栏）+ 头像菜单三项 ──────────────────────
// 121-K4（34 号文 §2.2）：盾牌（新任务默认权限）与一键停机从管家壳头部搬到【两视角共用的顶栏】
// —— 它们管的是全局默认权限与全局停机，不该只在一个视角里够得着。行为与 id 一个字没动
// （js/steward-settings.js 仍按 id 接线），所以这里改的只是「在哪一段 HTML 里找它们」。
const topbarStart_ = html.indexOf('<header class="app-topbar"');
const topbarEnd_ = html.indexOf('</header>', topbarStart_);
const topbar = html.slice(topbarStart_, topbarEnd_);
const stewardStart_ = html.indexOf('<section id="stewardShell"');
const headerEnd = html.indexOf('</header>', stewardStart_);
const header = html.slice(stewardStart_, headerEnd);
ok(/id="stewardShieldBtn"[^>]*aria-haspopup="true"/.test(topbar) && /id="stewardShieldMenu"[^>]*role="menu"/.test(topbar)
  && !/id="stewardShieldBtn"/.test(header),
  'E1 盾牌按钮与四档菜单在外框顶栏里（两视角共用；管家壳头部不再有第二份）');
ok(/id="stewardStopBtn"/.test(topbar) && !/id="stewardStopBtn"/.test(header),
  'E2 一键停机键常驻在外框顶栏里（工作台视角由样式层收起 —— 它是管家专用）');
ok(/class="tb-right"/.test(topbar) && !/class="steward-header-actions"/.test(html),
  'E3 两个常驻控件在顶栏右侧那一组里；壳头部那条 actions 行随搬家退役');
ok(Array.isArray(mod.STEWARD_MEMORY_KINDS) && typeof mod.createStewardSettingsDomain === 'function',
  'E4 设置域是导出的工厂函数');
// 121-K7 翻面重钉（34 号文 §2.3 末段／§2.4／§9 K7 验收「头像菜单只剩『细节』『设置』」）：
// 「记得的关于你」「行动流水」搬进左栏栏底的口袋（js/rail-pocket.js），头像菜单只剩一项。
// **两半一起钉**（否则「搬走」会退化成「删掉」）：这里钉菜单表只剩 settings，下面 E5b 钉那两个
// section 名在口袋那张表里各出现一次、且落在同一个 openStewardPanel 上。
const menuSections = (await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-conversation.js')).href)).STEWARD_MENU_SECTIONS;
ok(Array.isArray(menuSections) && JSON.stringify(menuSections) === JSON.stringify([
  ['stewardShell.menu.settings', ''],
]), `E5 头像菜单在「细节」之后只剩「设置」一项（实测 ${JSON.stringify(menuSections)}）`);
const pocketMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'rail-pocket.js')).href);
const pocketItems = pocketMod.RAIL_POCKET_ITEMS;
ok(Array.isArray(pocketItems) && pocketItems.length === 4
  && pocketItems.map(item => item.id).join(',') === 'schedule,decisions,memory,doctor'
  && pocketItems.map(item => item.panel).join(',') === 'schedule,decisions,memory,',
  `E5b 口袋恰四项、顺序与 section 名固定（§2.3：定时任务／行动流水／记得的关于你／体检 · 用量；实测 ${JSON.stringify(pocketItems.map(i => [i.id, i.panel]))}）`);
const settingsSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'steward-settings.js'), 'utf8');
ok(pocketItems.filter(item => item.panel).every(item => new RegExp(`\\n    ${item.panel}: 'cfgStewardGroup`).test(settingsSrc)),
  'E5b2 口袋那三个 section 名在 steward-settings.js 的 PANEL_SECTIONS 表里各有一条落点（deep link 不是死链）');
ok(pocketItems.every(item => typeof pocketMod.RAIL_POCKET_ITEMS === 'object' && zh[item.labelKey] && en[item.labelKey]),
  'E5c 口袋四项的短词四份 locale 齐');
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
// H5（117m）：这张表必须盖住 13h 的 STEWARD_ACTION_HOOKS 全部键 —— 逐名对账，不是计数。
// 117m-A4 新增 steward_thread_stop 时就漏了这一条，后果是「行动流水」那一列把内部 id
// 原样显给用户（§8.1 原则 7 明文禁止，上一轮用户就为这类事提过意见）。
// 钉成逐名对账：以后再加管家工具，漏登记会当场红，而不是等用户在界面上看到 id。
// 117 波 T2(32 号文 §5):13h 拆成六个文件(纯搬家),STEWARD_ACTION_HOOKS 这张表随共享常量块
// 搬进 13m-steward-runner-base.js。钉的事实(表里每个工具在前端都有人话标签)一字未改,只换读取来源。
const runnerSrc = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '13m-steward-runner-base.js'), 'utf8');
const hooksBlock = (runnerSrc.split('const STEWARD_ACTION_HOOKS = Object.freeze({')[1] || '').split('});')[0];
const hookNames = [...hooksBlock.matchAll(new RegExp('^\\s*(steward_[a-z_]+):', 'gm'))].map(m => m[1]);
const labelled = new Set(Object.keys(mod.STEWARD_TOOL_LABEL_KEYS));
const unlabelled = hookNames.filter(name => !labelled.has(name));
ok(hookNames.length >= 10 && unlabelled.length === 0,
  `H5 STEWARD_ACTION_HOOKS 的 ${hookNames.length} 个工具在前端都有人话标签（缺: ${unlabelled.join(',') || '无'}）`);


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
  // 123-M2(37 号文 §3.6):定时任务块从只读改成可建可改 —— 六条 /api/scheduler/tasks 里的
  // GET/POST/PATCH/DELETE/run-now/runs 全部落在这一个前缀上(正则只抓到前缀,后面的 /:id 与
  // ?limit= 不入表);另加 /api/missions —— 「在一条已有线程里跑」那个下拉的候选来自左栏
  // 已经在取的那一份,不裸发第二种取数。两者都是【读/写定时任务】这件事本身要的面,不是绕道。
  '/api/missions', '/api/scheduler/tasks',
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

// ─── K F5a 图标集：头部两枚常驻控件（27 号文 §11.13.1「F 追加」／32 号文 §2.2 F5）──────
// 这一组钉的是【哪件事必须成立】，不是「某个字面量还在不在」（32 号文 §4 纪律 4）：
//   · 本模块零 SVG 路径常量 —— F5a 之前这里躺着 ICON_SHIELD 与 ICON_STOP 两份孤本；
//   · 停机键与线程「停止」【不是同一枚图标】—— 这正是派单要求重钉的那条可证伪事实
//     （修前两处都是「圆里一个方块」，同形不同义）；
//   · 四档各有自己的盾内字形，且字形名【由档位名派生】（本模块仍然零四档字面量，B4 未被稀释）；
//   · 按钮的可及名一个字没变（读屏读到的仍是那句人话，界面上多出来的角标是图标不是文字）。
const iconsSrc = read('js/icons.js');
const iconsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'icons.js')).href);
const iconNameSet = new Set(iconsMod.iconNames());
ok(!/ICON_STOP|ICON_SHIELD|SVG_NS/.test(settingsCode)
  && !/M12 3a9 9 0 100 18 9 9 0 000-18z/.test(settings)
  && !/createElementNS/.test(settingsCode)
  && count(settingsCode, /'M\d[\d .a-zA-Z-]{8,}'/g) === 0,
  'K1 本模块零 SVG 路径常量、零 createElementNS：两枚控件的字形全部由 icons.js 的 icon() 建（ICON_STOP 那份孤本已死）');
const settingsIconNames = [...settingsCode.matchAll(/icon\('([A-Za-z]+)'/g)].map(match => match[1]);
ok(settingsIconNames.length >= 1 && settingsIconNames.every(name => iconNameSet.has(name)),
  `K2 本模块取用的每一个字形名都真的在 ICONS 表里（实测 ${JSON.stringify([...new Set(settingsIconNames)])}）`);
ok(/paintIconButton\(node, stopped \? 'powerOff' : 'power', label\)/.test(settingsCode)
  && iconNameSet.has('power') && iconNameSet.has('powerOff')
  && !/'stop'/.test(settingsCode)
  && count(iconsSrc, /M4\.5 19\.5 19\.5 4\.5/g) === 1,
  'K3 停机键与线程「停止」不是同一枚图标：管家停机／唤醒用电源符（已停机加一道斜杠，全表只此一处斜杠），实心方块 stop 只归线程用，本模块一次都不取它');
const permissionGlyphs = chipsMod.STEWARD_PERMISSION_MODES.map(mode => iconsMod.permissionIconName(mode));
ok(permissionGlyphs.every(name => iconNameSet.has(name) && name !== 'shield')
  && new Set(permissionGlyphs).size === chipsMod.STEWARD_PERMISSION_MODES.length,
  `K4 四档【各有】自己的盾内字形：都在表里、两两不同、没有一档退回家族标 shield（实测 ${JSON.stringify(permissionGlyphs)}）`);
const SHIELD_OUTLINE = 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z';
ok(permissionGlyphs.every(name => new RegExp('^ {2}' + name + ': \\[[\\s\\S]{0,120}?'
  + SHIELD_OUTLINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'm').test(iconsSrc)),
  'K4b 四枚盾牌共享同一条盾牌轮廓（家族标不变，四档只换盾【里面】那个字形）');
ok(/permissionIconName\(mode\)/.test(settingsCode)
  && !/'acceptEdits'/.test(settingsCode) && !/'plan'/.test(settingsCode) && !/'auto'/.test(settingsCode)
  && count(stripComments(iconsSrc), /STEWARD_PERMISSION_MODES|'acceptEdits'|'plan'|'auto'/g) === 0,
  'K4c 盾内字形名【由档位名派生】而不是查第二张表：settings 零四档字面量（B4 未被本刀稀释），icons.js 也不认识那张四档表');
ok(/node\.appendChild\(el\('span', 'steward-icon-label', label\)\);/.test(settingsCode)
  && /node\.title = label;/.test(settingsCode) && /node\.setAttribute\('aria-label', label\);/.test(settingsCode),
  'K5 停机键的可及名一个字没变：只给读屏的 .steward-icon-label ＋ title ＋ aria-label 仍是同一句人话');
ok(/const caret = icon\('caret', 12\);/.test(settingsCode)
  && !/[▾▼⌄∨]/.test(settingsCode) && !/[▾▼]/.test(cssCode)
  && /paintShieldButton\(btn, permissionIconName\(mode\), t\(permissionLabelKey\(mode\)\)\);/.test(settingsCode),
  'K6 胶囊右边的角标是一枚【图标】不是文字字符 —— 否则盾牌按钮的 textContent 就不再逐字等于档位名（既有 C0b 读的就是它）');
ok(/\.steward-shield \{[\s\S]{0,400}?border-radius: var\(--r-pill\);/.test(css)
  && /\.steward-shield-label \{/.test(css) && /\.steward-shield-caret \{/.test(css)
  && /\.steward-stop-btn \{[\s\S]{0,300}?width: 34px;/.test(css),
  'K7 盾牌是「盾＋档位名＋角标」的胶囊（档位名常驻，图标不再是唯一信号）；停机键仍是那颗 34px 圆键');
// 改了外形不许改行为：菜单仍然进同一个 Esc 栈、仍然带自己那份「哪些节点算我的」判据（117j copy-P2-4
// 与 117k 的点别处收回），四档选项仍然是 role="menuitemradio" ＋ aria-checked，全自动仍然先过二次确认。
ok(/releaseShieldEscape = stewardEscapeStack\.push\(/.test(settingsCode)
  && /const own = byId\('stewardShieldMenu'\);/.test(settingsCode)
  && /const trigger = byId\('stewardShieldBtn'\);/.test(settingsCode)
  && /option\.setAttribute\('role', 'menuitemradio'\);/.test(settingsCode)
  && /option\.setAttribute\('aria-checked', current === mode \? 'true' : 'false'\);/.test(settingsCode)
  && /btn\.setAttribute\('aria-controls', 'stewardShieldMenu'\);/.test(settingsCode)
  && /if \(STEWARD_PERMISSION_CONFIRM_MODES\.includes\(mode\)\) \{/.test(settingsCode.slice(settingsCode.indexOf('function toggleShield()'))),
  'K8 换了外形没换行为：菜单仍进同一个 Esc 栈（连「点别处算不算我的」那份判据一起）、四档仍是 menuitemradio ＋ aria-checked ＋ aria-controls，需要二次确认的那一档仍先过确认');

console.log(`\nSTEWARD SETTINGS STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
