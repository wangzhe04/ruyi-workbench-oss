#!/usr/bin/env node
'use strict';
// 静态锁(第118波 118e + 118c):本机零配置预设 与 启动体验。
//
// 为什么要静态锁:这一刀的三处改动跑不到 e2e 里 --
//   · `Start-Workbench.cmd` 与打包器生成的同款启动器:双击行为要在真 Windows 桌面上才看得见;
//   · `desktop/RuyiDesktop.cs`:本仓库的 e2e 不编译 C#(编译在 release-dryrun 里,人话文案更是要
//     在一台【没装 / 被策略禁用】WebView2 的机器上才会弹出来);
//   · `README-START-HERE.txt`:解压前读的文件,没有任何运行时会碰它。
// 于是把它们的关键事实钉在源码层。118e 那半边则钉「两个本地预设 <-> 前端免 Key 判定 <-> 手册小节」
// 这条三段耦合:任何一端改了而另两端没跟上,门就红。
//
// 判定行:`START EXPERIENCE STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const PUBLIC = path.join(WB, 'app', 'public');
const MANUALS = path.join(WB, 'docs', 'manuals');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const locales = {
  'zh-CN': readJson(path.join(PUBLIC, 'locales', 'zh-CN.json')),
  'en-US': readJson(path.join(PUBLIC, 'locales', 'en-US.json')),
};
const docsLocales = {
  'zh-CN': readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json')),
  'en-US': readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json')),
};

/* ═══════════════ ① 118e:两个本地预设的服务端事实源 ═══════════════ */

const engineSrc = read(WB, 'app', 'src', '05-claude-engine.js');
const presetBlock = engineSrc.slice(engineSrc.indexOf('const PROVIDER_PRESETS = ['), engineSrc.indexOf('\n];', engineSrc.indexOf('const PROVIDER_PRESETS = [')));
ok(presetBlock.includes("id: 'ollama'") && presetBlock.includes("baseUrl: 'http://127.0.0.1:11434/v1'"),
  '① PROVIDER_PRESETS 有 ollama 预设,指向 http://127.0.0.1:11434/v1');
ok(presetBlock.includes("id: 'lmstudio'") && presetBlock.includes("baseUrl: 'http://127.0.0.1:1234/v1'"),
  '① PROVIDER_PRESETS 有 lmstudio 预设,指向 http://127.0.0.1:1234/v1');
// 形状照抄既有条目:type/reasoning/defaultModel/models 一个不缺,defaultModel 与 models 刻意留空
// (本机装了哪些模型只有探测才知道)。
const localEntries = presetBlock.split(/\n  \{/).filter(chunk => /id: '(ollama|lmstudio)'/.test(chunk));
ok(localEntries.length === 2 && localEntries.every(chunk =>
  /type: 'openai-compat'/.test(chunk) && /reasoning: false/.test(chunk)
  && /defaultModel: ''/.test(chunk) && /models: \[\]/.test(chunk) && /keyOptional: true/.test(chunk)),
  '① 两条本地预设的字段形状与既有预设一致(type/reasoning/defaultModel/models),且都带 keyOptional');
// PROVIDER_PRESETS 里带 keyOptional 的 id 必须与前端纯函数的 KEY_OPTIONAL_PRESET_IDS 逐字相等。
const keyOptionalIds = [...presetBlock.matchAll(/id: '([a-z0-9-]+)'[\s\S]{0,400}?keyOptional: true/g)].map(m => m[1]);
const wizardSrc = read(PUBLIC, 'js', 'onboarding-wizard.js');
const declaredIds = (wizardSrc.match(/KEY_OPTIONAL_PRESET_IDS = Object\.freeze\(\[([^\]]*)\]\)/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
ok(keyOptionalIds.length === 2 && declaredIds.join(',') === keyOptionalIds.join(','),
  `① 服务端 keyOptional 预设(${keyOptionalIds.join(', ')})与前端 KEY_OPTIONAL_PRESET_IDS(${declaredIds.join(', ')})逐字一致`);

/* ═══════════════ ② 118e:免 Key 与人话探测失败的前端接线 ═══════════════ */

ok(/export function presetAllowsEmptyKey\(presetId\)/.test(wizardSrc)
  && /const allowsEmpty = presetAllowsEmptyKey\(preset\);/.test(wizardSrc),
  '② validateApiKeyShape 认「本预设免 Key」(走同一个纯函数,不各写一份判定)');
ok(/export function localEndpointDownKey\(presetId\)/.test(wizardSrc)
  && /'onboarding\.wizard\.provider\.localDown\.' \+ id/.test(wizardSrc),
  '② 探测失败的人话按预设 id 取键(localDown.<id>)');
ok(/const downKey = localEndpointDownKey\(currentPresetKey\(\)\);/.test(wizardSrc)
  && /if \(downKey && result && result\.errorClass === 'network_down'\)/.test(wizardSrc),
  '② 本地预设连不上时改说人话,而不是把传输层错误直接甩给用户');
ok(/openHelpViewer\(\{ docId: ONBOARDING_MANUAL_DOC_ID, anchor: t\(LOCAL_MODELS_ANCHOR_KEY\) \}\)/.test(wizardSrc),
  '② 「看手册这一节」走应用内阅读器 + 锚点(不是外链、不是路径)');
// 产品红线:这条提示不许给命令行,也不许给下载链接。
for (const lang of ['zh-CN', 'en-US']) {
  for (const id of declaredIds) {
    const text = locales[lang]['onboarding.wizard.provider.localDown.' + id] || '';
    ok(text.length > 0 && !/https?:\/\//.test(text) && !/ollama (run|serve|pull)/i.test(text) && !/`/.test(text),
      `② ${lang} localDown.${id} 是人话,不给命令行也不给下载链接`);
  }
}
const providerSrc = read(PUBLIC, 'js', 'provider-settings.js');
ok(/if \(presetAllowsEmptyKey\(currentPresetKey\(\)\) && !String\(wiz\.model \|\| ''\)\.trim\(\)\) \{/.test(wizardSrc)
  && /t\('onboarding\.wizard\.provider\.localNeedModel'\)/.test(wizardSrc),
  '② 本机预设没选模型时不许保存(defaultModel 为空,存下去第一条消息必炸)');
ok(/const keyOptional = providerKeyOptional\(p\);/.test(providerSrc)
  && /ki\.placeholder = keyOptional \? t\('provider\.apiKeyOptionalPlaceholder'\) : 'sk-\.\.\.';/.test(providerSrc)
  && /t\('provider\.apiKeyOptionalHint'\)/.test(providerSrc),
  '② 设置页对本机预设不再摆 sk-... 占位符,并明说不需要 Key');
ok(/function providerTestErrorText\(payload\)/.test(providerSrc)
  && /paintProviderTestFailure\(status, p, r\)/.test(providerSrc)
  && !/status\.textContent = `✗ \$\{\(r && r\.error\)/.test(providerSrc),
  '② 设置页测试失败不再直接插值 r.error(信封形状会印成 [object Object])');
ok(/openSharedHelpDoc\(\{ docId: ONBOARDING_MANUAL_DOC_ID, anchor: t\(LOCAL_MODELS_ANCHOR_KEY\) \}\)/.test(providerSrc),
  '② 设置页失败态同样给「看手册这一节」按钮,复用共享阅读器实例');

/* ═══════════════ ②b 手册小节 vs 锚点文案逐字比对(照 118b/118d 的 D4/③b 先例) ═══════════════ */

const headings = lang => read(MANUALS, lang === 'zh-CN' ? 'USER-GUIDE_CN.md' : 'USER-GUIDE_EN.md')
  .split(/\r?\n/).filter(l => /^##\s+\S/.test(l)).map(l => l.replace(/^##\s+/, '').trim());
const anchorKey = (wizardSrc.match(/LOCAL_MODELS_ANCHOR_KEY = '([\w.]+)'/) || [, ''])[1];
ok(anchorKey === 'help.anchor.localModels', '②b 手册锚点键是 help.anchor.localModels');
const anchorProblems = [];
for (const lang of ['zh-CN', 'en-US']) {
  const value = locales[lang][anchorKey];
  if (typeof value !== 'string') { anchorProblems.push(`${lang} 缺键 ${anchorKey}`); continue; }
  if (docsLocales[lang][anchorKey] !== value) { anchorProblems.push(`${lang} ${anchorKey} 与 docs/i18n 不一致`); continue; }
  if (!headings(lang).includes(value)) anchorProblems.push(`${lang} ${anchorKey}="${value}" 不是手册的 ## 标题`);
}
ok(anchorProblems.length === 0,
  '②b 锚点文案与两份手册的 ## 标题逐字相符' + (anchorProblems.length ? ' -- ' + anchorProblems.join(' | ') : ''));
for (const lang of ['zh-CN', 'en-US']) {
  const body = read(MANUALS, lang === 'zh-CN' ? 'USER-GUIDE_CN.md' : 'USER-GUIDE_EN.md');
  ok(body.includes('http://127.0.0.1:11434/v1') && body.includes('http://127.0.0.1:1234/v1'),
    `②b ${lang} 手册的本机模型小节写清了两个默认地址`);
}

/* ═══════════════ ②c 13 条新键在四个 locale 齐备且逐字一致 ═══════════════ */

const newKeys = [
  'help.anchor.localModels',
  'onboarding.wizard.provider.apiKeyOptionalPlaceholder',
  'onboarding.wizard.provider.keyOptionalNote',
  'onboarding.wizard.provider.noKeyNeeded',
  'onboarding.wizard.provider.localDown.ollama',
  'onboarding.wizard.provider.localDown.lmstudio',
  'onboarding.wizard.provider.localDown.readManual',
  'onboarding.wizard.provider.localNeedModel',
  'provider.apiKeyOptionalPlaceholder',
  'provider.apiKeyOptionalHint',
  'startNotice.portFallback',
  'startNotice.error.portUnavailable',
  'startNotice.error.dataDirUnwritable',
  'startNotice.error.startupFailed',
];
const missing = newKeys.filter(k => ['zh-CN', 'en-US'].some(l => !locales[l][k] || docsLocales[l][k] !== locales[l][k]));
ok(missing.length === 0, `②c ${newKeys.length} 条新键在四个 locale 齐备且逐字一致` + (missing.length ? ' -- 缺: ' + missing.join(', ') : ''));
for (const lang of ['zh-CN', 'en-US']) {
  const value = locales[lang]['startNotice.portFallback'];
  ok(/\{\{actual\}\}/.test(value) && /\{\{requested\}\}/.test(value),
    `②c ${lang} 的改用端口提示同时说清【改用了谁】与【原来是谁】`);
}

/* ═══════════════ ③ 118c:启动提示条接线 ═══════════════ */

const indexHtml = read(PUBLIC, 'index.html');
ok(/id="startNoticeBar"[^>]*role="status"[^>]*aria-live="polite"/.test(indexHtml)
  && /id="startNoticeBody"/.test(indexHtml) && /id="startNoticeDismiss"/.test(indexHtml),
  '③ 顶部条在位:role=status + aria-live=polite + 可关闭');
ok(/class="start-notice hidden"/.test(indexHtml), '③ 默认隐藏(没有提示时不占地方)');
ok(/renderStartNotice\(\); \/\/ 118c/.test(providerSrc) && /function renderStartNotice\(\)/.test(providerSrc),
  '③ refreshStatus 每次都重画顶部条');
ok(/START_NOTICE_ERROR_KEYS = Object\.freeze\(\{/.test(providerSrc)
  && /'port-unavailable': 'startNotice\.error\.portUnavailable'/.test(providerSrc)
  && /'data-dir-unwritable': 'startNotice\.error\.dataDirUnwritable'/.test(providerSrc)
  && /'startup-failed': 'startNotice\.error\.startupFailed'/.test(providerSrc),
  '③ 三类 kind 都有对应的本地化文案键');
ok(/key \? t\(key\) : String\(failure\.message \|\| ''\)/.test(providerSrc),
  '③ 未知 kind 退回服务端写在文件里的那句人话,而不是印键名');
const onboardingCss = read(PUBLIC, 'css', 'components', 'onboarding.css');
ok(onboardingCss.includes('.start-notice {') && onboardingCss.includes('.start-notice-dismiss')
  && onboardingCss.includes('.onboard-wiz-status-action') && onboardingCss.includes('.prov-key-optional'),
  '③ 118e/118c 的样式落在【已注册的】onboarding.css 层内,不新开样式表');

/* ═══════════════ ④ 118c:启动器不再留黑窗 ═══════════════ */

const cmdBytes = fs.readFileSync(path.join(WB, 'Start-Workbench.cmd'));
const cmdText = cmdBytes.toString('latin1');
ok([...cmdBytes].every(b => b < 128), '④ Start-Workbench.cmd 纯 ASCII(任何控制台代码页下 cmd.exe 都能解析一致)');
ok(!/(?<!\r)\n/.test(cmdText) && /\r\n/.test(cmdText), '④ Start-Workbench.cmd 全 CRLF(cmd.exe 误解析纯 LF 批处理)');
const launchBlock = cmdText.slice(0, cmdText.indexOf(':package_incomplete'));
ok(!/^\s*pause\s*$/m.test(launchBlock), '④ 启动路径上没有 pause(不再靠黑窗留住失败信息)');
ok(/^pause$/m.test(cmdText.slice(cmdText.indexOf(':package_incomplete'))),
  '④ 包不完整的既有检查与提示保留(那条路径的 pause 是有意的:此刻还没有任何界面可用)');
ok(/PACKAGE INCOMPLETE/.test(cmdText) && /Do not run Start-Workbench\.cmd from inside the ZIP preview/.test(cmdText),
  '④ 「勿在压缩包预览里运行」的提示保留');
ok(/powershell -NoLogo -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath \$env:RUYI_NODE/.test(cmdText)
  && /-WindowStyle Hidden"/.test(cmdText),
  '④ node 回落路径改由 PowerShell 隐藏启动');
ok(/set "RUYI_NODE=/.test(cmdText) && /set "RUYI_SERVER=/.test(cmdText) && !/-FilePath "%RUYI_ROOT%/.test(cmdText),
  '④ 路径经环境变量传给 PowerShell(不做内联引号拼接,带空格/单引号/&的目录名不会劈参数)');
ok(/if not errorlevel 1 exit \/b 0/.test(cmdText) && /"%RUYI_NODE%" "%RUYI_SERVER%" serve --open/.test(cmdText),
  '④ PowerShell 不可用时仍有直启兜底(宁可退化,不许起不来)');
// 打包器生成的那份启动器必须同步,否则发布件里的黑窗照旧。
const packager = read(WB, 'tools', 'package-offline.ps1');
ok(/powershell -NoLogo -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath `\$env:RUYI_NODE/.test(packager)
  && !/echo \[Ruyi\] Workbench stopped with exit code/.test(packager),
  '④ package-offline.ps1 生成的启动器同步去黑窗(发布件才是用户真正双击的那个)');

/* ═══════════════ ⑤ 118c:WebView2 失败人话化(C# 静态锁) ═══════════════ */

const desktopSrc = read(WB, 'desktop', 'RuyiDesktop.cs');
ok(/internal static string WebViewFallbackKind\(int hr\)/.test(desktopSrc)
  && /internal static string WebViewFallbackMessage\(int hr, string stage\)/.test(desktopSrc),
  '⑤ 存在错误码 -> 分类 -> 人话的两级映射函数');
ok(/WebViewFallbackRuntimeMissing = "runtime-missing"/.test(desktopSrc)
  && /WebViewFallbackPolicyBlocked = "policy-blocked"/.test(desktopSrc)
  && /WebViewFallbackUnknown = "unknown"/.test(desktopSrc),
  '⑤ 三种分支齐备:组件缺失 / 被策略禁用 / 其它未知');
ok(/0x8007007E/.test(desktopSrc) && /0x80040154/.test(desktopSrc), '⑤ 组件缺失分支覆盖 DLL 找不到与 COM 类未注册');
ok(/0x80070005/.test(desktopSrc) && /0x800704EC/.test(desktopSrc), '⑤ 策略禁用分支覆盖访问被拒与组策略禁用');
ok(/系统缺少 WebView2 组件，已改用默认浏览器打开，功能不受影响。/.test(desktopSrc),
  '⑤ 缺 Runtime 给的是人话,不是 0x 码');
ok(/这台电脑的安全策略禁用了 WebView2 组件/.test(desktopSrc) && /转给 IT/.test(desktopSrc),
  '⑤ 被策略禁用时给 IT 说明');
ok(/private void EnterBrowserFallback\(int hr, string stage\)/.test(desktopSrc)
  && !/EnterBrowserFallback\("/.test(desktopSrc),
  '⑤ 调用点一律传错误码 + 阶段,没有任何一处再把 0x 串拼进提示');
ok(/技术详情（支持排查用）：/.test(desktopSrc), '⑤ 原始 0x 码退到末尾的技术详情行(留给支持排查,不再当主文案)');

/* ═══════════════ ⑥ README-START-HERE.txt ═══════════════ */

const readme = read(WB, 'README-START-HERE.txt');
const readmeLines = readme.replace(/\n$/, '').split('\n');
ok(readmeLines.length <= 10, `⑥ README-START-HERE.txt 十行以内(实际 ${readmeLines.length} 行)`);
ok(!/\r/.test(readme), '⑥ README-START-HERE.txt 全 LF(与 .gitattributes 的默认口径一致)');
ok(/压缩包预览/.test(readme) && /ZIP preview/.test(readme), '⑥ 保留「勿在压缩包预览里运行」');
ok(/C:\\Ruyi/.test(readme) && (readme.match(/C:\\Ruyi/g) || []).length >= 2, '⑥ 保留「建议解压到 C:\\Ruyi」(中英各一)');
ok(/向导/.test(readme) && /wizard/i.test(readme), '⑥ 指向欢迎向导');
ok(/帮助/.test(readme) && /Help/.test(readme), '⑥ 出问题指向应用内帮助菜单,而不是终端或某个日志路径');

console.log('\nSTART EXPERIENCE STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
