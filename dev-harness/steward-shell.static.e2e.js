#!/usr/bin/env node
'use strict';
(async () => {

// 第117波 117a 静态契约：管家壳是 .app-shell 的同级容器、显隐只由 data-shell-mode 这一个状态源
// 驱动、管家壳模块零 innerHTML / 三分支 fail-closed，且新资源进入离线 overlay 与样式清单。
// 117b 重钉 C2/C3（语义收紧,不是放宽）：avatar 状态轮询给本文件加了一个 timer 与一次请求，
// 「零轮询」改判「轮询只能活在 isStewardMode() 门控里」——七态 avatar 与轮询门控的完整静态契约见
// dev-harness/steward-avatar.static.e2e.js。
// 121-K1 重钉 A 段（34 号文 §2.7／§8.2）：一台两视 —— 视角只剩 steward | classic，登记表与
// applyShellMode 从退役的 js/preview-shell.js 搬进叶子 js/shell-mode.js，预绘脚本与
// normalizeShellMode 自此【同构】（K0 交付时两边兜底一个 steward 一个 classic，见 §13.1 末尾）。
// A3 因此从「白名单集合相等」升级成【行为同构】：同一组输入喂给两份实现，逐条比对落点。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const app = read('app.js');
const shellMode = read('js/shell-mode.js');
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

// ─── A 两视与唯一状态源 ──────────────────────────────────────────────────────────
const shellModeMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'shell-mode.js')).href);
const declaredModes = shellModeMod.SHELL_MODES;
ok(Array.isArray(declaredModes) && Object.isFrozen(declaredModes)
  && JSON.stringify(declaredModes) === JSON.stringify(['steward', 'classic']),
  'A1 SHELL_MODES 是冻结两值且顺序固定 steward/classic（默认在前）'
  + `（实测 ${JSON.stringify(declaredModes)}）`);
// A2 钉的是【归一化的落点】，不是它怎么写的。121-K1（34 号文 §2.7）：一台两视 —— 显式 classic 落
// classic；其余一切（没存过／空串／未知值／已退役的 preview）一律落 steward。
const NORMALIZE_TRUTH = [
  [undefined, 'steward'], [null, 'steward'], ['', 'steward'],
  ['classic', 'classic'], ['steward', 'steward'],
  ['preview', 'steward'],            // 退役的交办台偏好
  ['bogus', 'steward'], ['CLASSIC', 'steward'],
];
const normalizeBad = NORMALIZE_TRUTH.filter(([input, want]) => shellModeMod.normalizeShellMode(input) !== want);
ok(normalizeBad.length === 0,
  'A2 normalizeShellMode 的落点：显式 classic → classic，其余（无偏好／未知值／退役的 preview）一律 steward'
  + (normalizeBad.length ? `（实测偏差 ${JSON.stringify(normalizeBad.map(([input]) => [input, shellModeMod.normalizeShellMode(input)]))}）` : ''));
ok(shellModeMod.RETIRED_SHELL_MODES && shellModeMod.RETIRED_SHELL_MODES.preview === 'steward'
  && !declaredModes.includes('preview'),
  'A2b preview 只作为【退役映射】存在，不在 SHELL_MODES 里 —— 视角不许复活成三值');

// 预绘脚本与 normalizeShellMode 必须【行为同构】：把预绘那段规则从 index.html 里抠出来真跑一遍，
// 同一组输入逐条比对两边的落点。K0 交付时两边不同构（预绘 steward / normalizeShellMode classic，
// 见 34 号文 §13.1 末尾），K1 统一 —— 所以本条从「白名单集合相等」升级成「同一真值表两份实现」。
const prePaintSource = html.slice(html.indexOf("localStorage.getItem('wcw.shellMode')"), html.indexOf('</script>', html.indexOf("localStorage.getItem('wcw.shellMode')")));
const prePaintRule = (prePaintSource.match(/var shellMode = (.+);/) || [])[1] || '';
const prePaintCatch = (html.match(/catch \(e\) \{ document\.documentElement\.setAttribute\('data-shell-mode', '([a-z]+)'\); \}/) || [])[1] || '';
// eslint-disable-next-line no-new-func -- 抠出的是预绘脚本【自己那一行】，跑它才叫同构，不是抄一遍
const prePaintDecide = prePaintRule ? new Function('stored', `return ${prePaintRule};`) : null;
const isoBad = prePaintDecide
  ? NORMALIZE_TRUTH.filter(([input, want]) => prePaintDecide(input == null ? null : input) !== want)
  : [['<rule not found>', '?']];
ok(prePaintRule && isoBad.length === 0 && prePaintCatch === 'steward',
  'A3 index.html 预绘脚本与 normalizeShellMode 行为同构（同一真值表两份实现），localStorage 抛异常也落 steward'
  + `（实测 规则 '${prePaintRule}' / 异常 '${prePaintCatch}'`
  + (isoBad.length ? ` / 偏差 ${JSON.stringify(isoBad.map(([input]) => [input, prePaintDecide && prePaintDecide(input == null ? null : input)]))}` : '')
  + '）');

// data-shell-mode 是唯一状态源：全仓写入点只有预绘脚本(2)、shell-mode.js 的 applyShellMode(1)、
// steward-shell.js 的 recoverStewardShell(1)，别处一律不许写。
// 121-K1：原来 preview-shell.js 有两处（applyShellMode + recoverClassicShell 各写一次）；搬家后
// recoverClassicShell 改成走 applyShellMode('classic') 自己那条路，写者因此收成一处。
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
  ['index.html', 2], ['js/shell-mode.js', 1], ['js/steward-shell.js', 1],
]), 'A4 data-shell-mode 写入点只有预绘脚本 / applyShellMode / recoverStewardShell'
  + `（实测 ${JSON.stringify(writeSites)}）`);
ok(/function applyShellMode\(value[\s\S]{0,900}documentRef\.documentElement\.setAttribute\('data-shell-mode', mode\);/.test(shellMode)
  && /function recoverClassicShell\(\) \{\s*return applyShellMode\('classic', \{ focus: false \}\);\s*\}/.test(shellMode),
  'A5 shell-mode 唯一那处写入住在 applyShellMode 里，recoverClassicShell 走同一条路（不另开写口）');
ok(/if \(mode === 'steward' && !canEnterSteward\(\)\) return recoverStewardShell\(\{ persist \}\) \|\| 'classic';/.test(shellMode)
  && /canEnterSteward = \(\) => false,/.test(shellMode)
  && /recoverStewardShell = \(\) => '',/.test(shellMode),
  'A6 进管家视角前先过注入的准入判定，缺省注入即 fail-closed（准入恒 false）');

// ─── B 同级容器与骨架空位 ────────────────────────────────────────────────────────
const appShellStart = html.indexOf('<div class="app-shell">');
const stewardStart = html.indexOf('<section id="stewardShell"');
ok(appShellStart >= 0 && stewardStart > appShellStart
  && html.indexOf('previewShell') === -1,
  'B1 #stewardShell 是 .app-shell 之后的同级后置容器，且 #previewShell 已随交办台退役（DOM 里零残留）');
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
// 121-K1：视角选择器只剩两项，管家在前、且用的是 shell.* 那套键（原 stewardShell.settingOption
// 随「第三种壳」这个说法一起退役）。选项集合必须【恰好】等于 SHELL_MODES —— 少一项 = 某个视角
// 再也选不到，多一项 = 凭空发明了第三视角。
const selectorStart = html.indexOf('<select id="cfgShellMode">');
const selectorMarkup = html.slice(selectorStart, html.indexOf('</select>', selectorStart));
const optionValues = [...selectorMarkup.matchAll(/<option value="([a-z]+)"/g)].map(match => match[1]);
ok(JSON.stringify(optionValues) === JSON.stringify([...declaredModes]),
  `B7a 视角选择器的选项恰好是 SHELL_MODES 且同序（实测 ${JSON.stringify(optionValues)}）`);
ok(/<option value="steward" data-i18n="shell\.settingSteward">/.test(selectorMarkup)
  && /<label for="cfgShellMode" data-i18n="shell\.settingLabel">/.test(html)
  && /id="stewardShellModeHint"[^>]*data-i18n="stewardShell\.settingDisabledHint"[^>]*hidden/.test(html),
  'B7b 管家项与「先打开管家」提示都在 DOM 里，标签与选项文案走 shell.* 那套键');

// ─── C 管家壳模块：零 innerHTML、零轮询、三分支 fail-closed ─────────────────────
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(stewardShell),
  'C1 管家壳模块零 innerHTML/insertAdjacentHTML/document.write');
// 117b 重钉(语义收紧,不是放宽):avatar 的状态轮询需要一个 timer 与一次请求，「零 timer／零请求」
// 改判「timer／请求只能活在模式门控里」——setInterval/clearInterval/api() 各自全文件恰好一处，
// 分别锁死在 startPolling/stopPolling/pollStewardState 里，且唯一入口 syncPolling 先判
// isStewardMode()（非管家模式恒 stopPolling，不产生任何后台活动，跟 117a 的红线同一句意思）。
const setIntervalSites = (stewardShell.match(/setInterval\(/g) || []).length;
const clearIntervalSites = (stewardShell.match(/clearInterval\(/g) || []).length;
const apiCallSites = (stewardShell.match(/\bapi\(/g) || []).length;
ok(setIntervalSites === 1 && clearIntervalSites === 1,
  'C2a 全文件恰好一处 setInterval、一处 clearInterval(不会散落出第二套计时)');
// 117j W2-4 重钉：表按 5s 下限起（不再等于 config.stewardPollMs），真要不要拉由 pollStewardTick
// 自己判。「setInterval 只住在 startPolling 里」这条契约本身一个字没变，变的只是它的两个参数。
ok(/function startPolling\(\) \{\s*if \(pollTimer\) return;\s*pollStewardState\(\);\s*pollTimer = setInterval\(pollStewardTick, STEWARD_POLL_MS_MIN\);\s*\}/.test(stewardShell),
  'C2b setInterval 只住在 startPolling 里');
// 121-K2b（34 号文 §6.2／§6.4）**重钉 C2b2**：这一拍多了最外面一档 —— 事件流连着时它只是兜底
// 心跳（STEWARD_POLL_MS_CONNECTED＝30 s，常量在 steward-chips.js 那一份），断开才回到今天那两档
// （真有事在跑 5 s，否则 config.stewardPollMs）。被钉的两件事一个字没变：①「表按下限起、真要不要拉
// 由这一拍自己判」；②后端下限没动（pollIntervalMs 仍在最里层）。反向验证：把 STEWARD_POLL_MS_CONNECTED
// 换成 STEWARD_POLL_MS_MIN 立刻真红。
ok(/function pollStewardTick\(\) \{\s*const due = streamConnected \? STEWARD_POLL_MS_CONNECTED : \(stewardPollFast\(\) \? STEWARD_POLL_MS_MIN : pollIntervalMs\(\)\);/.test(stewardShell)
  && /if \(presenceInputs\.inflight\) return true;/.test(stewardShell),
  'C2b2 节拍由 pollStewardTick 判：连接时 30 s 兜底，断开时「壳可见且真有事在跑」才用 5s、否则仍按 config.stewardPollMs（后端下限未动）');
// 121-K2b 新钉：连接状态【只改 due，不改启停】—— syncPolling 的三重门控里一个 streamConnected 都
// 没有（否则「连着就不开表」会把兜底本身也关掉，推送漏一帧就永远追不回来）。
ok(!/function syncPolling\(\)[\s\S]{0,200}streamConnected/.test(stewardShell)
  && /eventStream\.on\('steward\.say', \(\) => \{ if \(isStewardMode\(\)\) pollStewardState\(\); \}\);/.test(stewardShell),
  'C2b3 事件流只改节拍不改启停：syncPolling 的门控零 streamConnected；steward.say 到达走的是既有那一处状态拉取（零新请求路）');
ok(/function stopPolling\(\) \{\s*if \(!pollTimer\) return;\s*clearInterval\(pollTimer\);\s*pollTimer = 0;\s*\}/.test(stewardShell),
  'C2c clearInterval 只住在 stopPolling 里');
ok(/function syncPolling\(\) \{\s*if \(isStewardMode\(\) && !\(globalThis\.document && globalThis\.document\.hidden\)\) startPolling\(\);\s*else stopPolling\(\);\s*\}/.test(stewardShell),
  'C2d 唯一入口 syncPolling 先判 isStewardMode()(与页面可见性)才决定启停，非管家模式恒 stopPolling');
ok(apiCallSites === 1 && !/\bfetch\(/.test(stewardShell),
  'C3a 全文件恰好一处 api() 调用、零直调 fetch(轮询之外零请求，一律经注入的 api())');
// 117l-B2 ①（用户第五轮走查 1）：头像那记「点一下」是一次性类 + animationend，不是新的后台活动。
// 这里是 C2a「恰好一处 setInterval」那条纪律在 setTimeout 一侧的补齐：本波之前本文件就是 0 个
// setTimeout，本波之后仍然是 0 —— 动效不许换来一条计时器。
ok((stewardShell.match(/setTimeout\(/g) || []).length === 0,
  'C2e 全文件零 setTimeout(117l-B2 的头像动效靠 animationend 摘类，没有引入第二种计时)');
ok(/function nudgeAvatar\(\) \{/.test(stewardShell)
  && /lastReply\.trigger === 'inbox'\) \{ nudgeAvatar\(\);/.test(stewardShell)
  && !/presenceInputs\.nudge|nudge:/.test(stewardShell),
  'C2f nudge 是显式的一次性口子，不写进 presenceInputs(derivePresence 是纯投影，不该有「播过没有」的记忆)');
ok(/function pollStewardState\(\) \{\s*if \(typeof api !== 'function'\) return;\s*Promise\.resolve\(api\('\/api\/steward\/state'\)\)/.test(stewardShell),
  'C3b 唯一的 api() 调用住在 pollStewardState 里，目标就是状态轮询端点');
ok(/function startPolling\(\) \{[\s\S]{0,80}pollStewardState\(\);/.test(stewardShell),
  'C3c pollStewardState 只被 startPolling 调用(不会绕开门控单独发请求)');
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
  && providerSettings.includes('try { syncStewardShellAvailability(); } // 117a'),   // 117j classic-2 重钉：调用点没变，外面多了一层 try/catch
  'C9 组合根只做领域组合与绑定，config 刷新点同步管家项的可选性');
ok(app.includes("from './js/shell-mode.js'") && app.includes('createShellModeController({')
  && app.includes('bindShellModeControl();')
  && !app.includes('preview-shell.js'),
  'C9b 121-K1：组合根从 js/shell-mode.js 取视角控制器并统一绑定，零 preview-shell 残留');

// ─── D 样式层 ────────────────────────────────────────────────────────────────────
ok(/:root\[data-shell-mode="steward"\] body > \.app-shell \{ display: none !important; \}/.test(css),
  'D1 管家视角隐藏工作台视角');
// 121-K1：交办台整层退役 —— 隐藏它那条规则、它的样式层、它的类名，一个字都不许留在本层。
ok(!/preview-shell|\.preview-/.test(css) && !styles.includes('preview-shell.css'),
  'D2 交办台的隐藏规则与样式层已随它退役（本层与兼容清单零残留）');
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
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
