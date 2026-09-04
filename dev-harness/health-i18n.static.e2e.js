#!/usr/bin/env node
'use strict';
// 静态锁 + 纯函数行为件(第118波 118b):人话体检映射表。
//
// 断言六个方向:
//   ① 覆盖面:computeHealth() 源码里 push 的【每一个】id 都在 health-i18n.js 的映射表里有条目,
//      且每个 id 的每个变体(ok/bad,desktop-control 是六态)都能解析出 label + hint。
//   ② 零裸 id:describeHealthItem 产出的 label/hint/next 里不出现原始 id、不出现英文 detail;
//      渲染路径(provider-settings.js renderDoctor)确实走映射表,不再 healthRow(h.ok, h.id, h.detail)。
//   ③ 未知 id 兜底:没登记过的 id 也回落成一句人话(而不是把标识打给用户),严重度不谎报为 ok。
//   ④ UX 红线(§2):next 文案里不得出现文件路径或终端命令 —— 反斜杠、docs/ 路径、node/npm/powershell。
//   ⑤ i18n:引用到的每个 health.* 键在四个 locale 文件里齐备且逐字一致,占位符对齐。
//   ⑥ 接线:desktop-control 的状态词典前后端一致;新模块进 overlay 载荷;样式落在已注册的所有权层。
//
// 判定行:`HEALTH I18N STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const modulePath = path.join(PUBLIC, 'js', 'health-i18n.js');
const moduleSrc = fs.readFileSync(modulePath, 'utf8');
const providerSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'provider-settings.js'), 'utf8');
const sessionSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'session-experience.js'), 'utf8');
const helpViewerSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'help-viewer.js'), 'utf8');
const dispatchSrc = fs.readFileSync(path.join(SRC, '12-tool-dispatch.js'), 'utf8');
const routerSrc = fs.readFileSync(path.join(SRC, '13-http-router.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(SRC, '14-main.js'), 'utf8');
const overlayBuilder = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');
const toolPaneCss = fs.readFileSync(path.join(PUBLIC, 'css', 'components', 'tool-pane.css'), 'utf8');
const primitivesCss = fs.readFileSync(path.join(PUBLIC, 'css', 'components', 'chat-primitives.css'), 'utf8');
const layoutCss = fs.readFileSync(path.join(PUBLIC, 'css', 'layout.css'), 'utf8');

// computeHealth() 段落里 push('<id>', ...) 的 id 清单 —— 事实源是服务端源码,不是这份测试里的手抄表。
function healthIdsFromServer() {
  const start = dispatchSrc.indexOf('async function computeHealth(config) {');
  const end = dispatchSrc.indexOf('\nfunction parseFrontmatter(', start);
  const body = dispatchSrc.slice(start, end > start ? end : undefined);
  return [...new Set([...body.matchAll(/\bpush\('([a-z0-9-]+)'/g)].map(m => m[1]))];
}

(async () => {
  const serverIds = healthIdsFromServer();
  ok(serverIds.length >= 8 && serverIds.includes('desktop-control'),
    `A1 computeHealth 的 id 清单从源码枚举成功(${serverIds.length} 项,含 desktop-control): ${serverIds.join(', ')}`);

  const mod = await import(`data:text/javascript;base64,${Buffer.from(moduleSrc).toString('base64')}`);
  ok(typeof mod.describeHealthItem === 'function' && typeof mod.summarizeHealth === 'function'
    && typeof mod.healthSummaryText === 'function' && typeof mod.healthSeverity === 'function'
    && mod.HEALTH_ID_LABELS && Array.isArray(mod.DESKTOP_CONTROL_STATES) && mod.HEALTH_ACTIONS,
    'A2 模块导出面齐(describeHealthItem / summarizeHealth / healthSummaryText / healthSeverity / 三张表)');

  const missingIds = serverIds.filter(id => !Object.prototype.hasOwnProperty.call(mod.HEALTH_ID_LABELS, id));
  ok(missingIds.length === 0, 'A3 computeHealth 的每个 id 都在映射表里' + (missingIds.length ? ' (缺: ' + missingIds.join(', ') + ')' : ''));

  /* ═══════════ ⑤ i18n:四文件齐 + 占位符对齐 ═══════════ */
  const zh = readJson(path.join(PUBLIC, 'locales', 'zh-CN.json'));
  const en = readJson(path.join(PUBLIC, 'locales', 'en-US.json'));
  const docsZh = readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json'));
  const docsEn = readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json'));
  const t = (key, params) => {
    const value = zh[key];
    if (typeof value !== 'string') return `[${key}]`;
    return value.replace(/{{\s*([\w.-]+)\s*}}/g, (_m, name) => (params && name in params ? String(params[name]) : ''));
  };

  // 需要存在的键 = 表驱动枚举(和运行时同一套推导),不是人工清单。
  const wanted = new Set([
    'health.action.howto', 'health.anchor.faq', 'health.cli.title', 'health.tech.toggle',
    'health.status.ok', 'health.status.warn', 'health.status.error',
    'health.summary.errors', 'health.summary.warnings', 'health.summary.open',
    'health.item.unknown.label', 'health.item.unknown.hint.ok', 'health.item.unknown.hint.bad',
  ]);
  const variantsFor = id => (id === 'desktop-control' ? mod.DESKTOP_CONTROL_STATES.slice() : ['ok', 'bad']);
  for (const id of serverIds) {
    wanted.add(`health.item.${id}.label`);
    for (const variant of variantsFor(id)) {
      wanted.add(`health.item.${id}.hint.${variant}`);
      const severity = mod.healthSeverity({ id, ok: variant === 'ok' || variant === 'ready', detail: `${variant}: probe` });
      if (severity !== 'ok' && Object.prototype.hasOwnProperty.call(mod.HEALTH_ACTIONS, id)) wanted.add(`health.item.${id}.next.${variant}`);
    }
  }
  const missingKeys = [...wanted].filter(key => typeof zh[key] !== 'string' || !zh[key] || typeof en[key] !== 'string' || !en[key]);
  ok(missingKeys.length === 0, `E1 health.* 文案键齐(${wanted.size} 条)` + (missingKeys.length ? ' (缺: ' + missingKeys.slice(0, 4).join(', ') + ')' : ''));
  const drifted = [...wanted].filter(key => docsZh[key] !== zh[key] || docsEn[key] !== en[key]);
  ok(drifted.length === 0, 'E2 四个 locale 文件逐字一致' + (drifted.length ? ' (漂移: ' + drifted.slice(0, 3).join(', ') + ')' : ''));
  const placeholders = value => [...String(value).matchAll(/{{\s*([\w.-]+)\s*}}/g)].map(m => m[1]).sort().join(',');
  const badPlaceholder = [...wanted].filter(key => placeholders(zh[key]) !== placeholders(en[key]));
  ok(badPlaceholder.length === 0, 'E3 中英占位符契约一致' + (badPlaceholder.length ? ' (' + badPlaceholder.join(', ') + ')' : ''));

  /* ═══════════ ①② 每个 id x 每个变体都能解析成人话,且不泄漏裸 id ═══════════ */
  const leaks = [];
  const unresolved = [];
  const nextTexts = [];
  for (const id of serverIds) {
    for (const variant of variantsFor(id)) {
      const isOk = id === 'desktop-control' ? variant === 'ready' : variant === 'ok';
      const detail = id === 'desktop-control' ? `${variant}: 42 desktop tools bridged` : `${id} probe detail`;
      const info = mod.describeHealthItem({ id, ok: isOk, detail }, t);
      for (const [field, value] of Object.entries(info)) {
        if (field === 'severity') continue;
        if (/^\[health\./.test(String(value))) unresolved.push(`${id}/${variant}/${field}`);
        if (value && String(value).includes(id)) leaks.push(`${id}/${variant}/${field}`);
      }
      if (!info.label || !info.hint) unresolved.push(`${id}/${variant}/empty`);
      if (info.next) nextTexts.push(info.next);
    }
  }
  ok(unresolved.length === 0, 'B1 每个 id 的每个变体都解析出 label + hint' + (unresolved.length ? ' (未解析: ' + unresolved.slice(0, 4).join(', ') + ')' : ''));
  ok(leaks.length === 0, 'B2 人话文案里不出现原始 id' + (leaks.length ? ' (泄漏: ' + leaks.slice(0, 4).join(', ') + ')' : ''));
  const readyInfo = mod.describeHealthItem({ id: 'desktop-control', ok: true, detail: 'ready: 42 desktop tools bridged' }, t);
  ok(readyInfo.severity === 'ok' && /42/.test(readyInfo.hint) && readyInfo.next === '',
    'B3 desktop-control 已就绪态带上桥接工具数且不给多余的下一步 (' + readyInfo.hint + ')');
  const deskStates = mod.DESKTOP_CONTROL_STATES.map(state => mod.healthSeverity({ id: 'desktop-control', ok: state === 'ready', detail: state + ': x' }));
  ok(deskStates.join(',') === 'ok,warn,warn,warn,warn,error',
    'B4 desktop-control 六态严重度:就绪=ok,未装/关闭/缺环境/准备中=warn(不挡主功能),连不上=error (' + deskStates.join(',') + ')');
  ok(mod.healthSeverity({ id: 'server-source', ok: false, detail: '(running from baked exe)' }) === 'ok',
    'B5 打包运行不是故障:server-source 的 ok:false 仍判为正常,不给用户报红');

  /* ═══════════ ③ 未知 id 兜底 ═══════════ */
  const unknown = mod.describeHealthItem({ id: 'brand-new-check', ok: false, detail: 'whatever happened' }, t);
  ok(!unknown.label.includes('brand-new-check') && !unknown.hint.includes('whatever happened')
    && !/^\[health\./.test(unknown.label) && unknown.severity === 'warn',
    'C1 未登记 id 回落成通用人话(不显示 id/detail),严重度不谎报为 ok');
  ok(mod.summarizeHealth([{ id: 'agent-cli', ok: false, detail: 'x' }, { id: 'claude-cli', ok: false, detail: 'x' }]).warnings === 1,
    'C2 agent-cli 的旧别名 claude-cli 不重复计数');
  const summary = mod.healthSummaryText([{ id: 'data-writable', ok: false, detail: 'EPERM' }], t);
  ok(summary && summary.tone === 'error' && /1/.test(summary.text), 'C3 摘要文案按最重的一档取语气 (' + (summary && summary.text) + ')');
  ok(mod.healthSummaryText([{ id: 'mcp-target', ok: true, detail: 'x' }], t) === null, 'C4 无待办时摘要返回 null(不渲染恒亮徽标)');

  /* ═══════════ ④ UX 红线:next 里不许有路径与命令行 ═══════════ */
  const forbidden = [/\\/, /\/docs\//, /\bnode\s/i, /\bnpm\s/i, /powershell/i, /cmd\.exe/i, /[A-Za-z]:\//];
  const offenders = nextTexts.filter(text => forbidden.some(re => re.test(text)));
  ok(nextTexts.length >= 8 && offenders.length === 0,
    `D1 ${nextTexts.length} 条「怎么办」文案里没有文件路径、没有终端命令` + (offenders.length ? ' (违规: ' + offenders.slice(0, 2).join(' | ') + ')' : ''));
  const enNext = Object.keys(en).filter(key => /^health\.item\..+\.next\./.test(key)).map(key => en[key]);
  ok(enNext.length >= 8 && enNext.every(text => !forbidden.some(re => re.test(text))), `D2 英文「怎么办」文案同样零路径零命令(${enNext.length} 条)`);
  ok(Object.values(mod.HEALTH_ACTIONS).every(a => a && (a.kind === 'settings' || a.kind === 'manual')),
    'D3 每个「怎么办」都指向一个应用内落点(切设置页签 / 开应用内手册),没有第三种「自己去别处」');
  // 手册锚点是【小节标题原文】(help-viewer 的 buildToc 用 label === anchor 命中)。改了手册标题却忘了
  // 改这两条文案,「怎么办」会静默退化成「只打开手册、停在开头」—— 锁住中英两侧的等值关系。
  const headings = lang => fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'docs', 'manuals', lang), 'utf8')
    .split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3).trim());
  ok(headings('USER-GUIDE_CN.md').includes(zh['health.anchor.faq'])
    && headings('USER-GUIDE_EN.md').includes(en['health.anchor.faq']),
    `D4 手册锚点文案与两份手册的小节标题逐字相符(zh: ${zh['health.anchor.faq']} / en: ${en['health.anchor.faq']})`);

  /* ═══════════ ② 渲染路径确实走映射表 ═══════════ */
  ok(providerSrc.includes("from './health-i18n.js'") && providerSrc.includes('describeHealthItem(item, t)'),
    'F1 renderDoctor 经 describeHealthItem 取人话');
  ok(!/healthRow\(h\.ok, h\.id, h\.detail\)/.test(providerSrc) && !/el\('div', 'h-id', h\.id\)/.test(providerSrc),
    'F2 旧的「id + 英文 detail 原样上屏」写法已消失');
  ok(providerSrc.includes("el('div', 'h-id', info.label)") && providerSrc.includes("'h-tech-body'")
    && providerSrc.includes("t('health.tech.toggle')"),
    'F3 标题取映射 label,原始 id/detail 只进折叠的「技术详情」');
  ok(providerSrc.includes("t('health.action.howto')") && providerSrc.includes('runHealthAction(action)')
    && providerSrc.includes('switchSettingsTab(action.tab, true)') && providerSrc.includes('openSharedHelpDoc(')
    && /createProviderSettingsDomain\(\{[\s\S]*switchSettingsTab:\s*\(name, force\)/.test(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8')),
    'F4 「怎么办」是真动作:切设置页签(force,不被简易模式收敛)或开应用内手册阅读器');
  ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(moduleSrc), 'F5 映射模块零 innerHTML');
  ok(!/^import\s/m.test(moduleSrc), 'F6 映射模块零 import(纯函数,t 由调用方注入)');
  ok(helpViewerSrc.includes('export function registerHelpViewer(') && helpViewerSrc.includes('export function openSharedHelpDoc(')
    && sessionSrc.includes('registerHelpViewer(createHelpViewerDomain({'),
    'F7 阅读器仍只有一个实例:经典壳建好后登记,设置域复用同一个(组合根零改动)');
  ok(sessionSrc.includes('buildHealthSummaryChip()') && sessionSrc.includes("switchSettingsTab('doctor', true)")
    && sessionSrc.includes("healthSummaryText("),
    'F8 首跑卡的体检摘要红点存在且点击直达体检页');
  ok(providerSrc.includes('renderHealthEntryBadge()') && providerSrc.includes("$('openSettingsBtn')"),
    'F9 侧栏「设置」入口带摘要计数(没进设置也看得见)');

  /* ═══════════ ⑥ 前后端状态词典一致 + 载荷/样式登记 ═══════════ */
  const declared = dispatchSrc.match(/DESKTOP_CONTROL_DETAILS = Object\.freeze\(\{([\s\S]*?)\}\);/);
  const serverTokens = declared ? [...new Set([...declared[1].matchAll(/'([a-z-]+):\s/g)].map(m => m[1]))] : [];
  ok(serverTokens.length === mod.DESKTOP_CONTROL_STATES.length
    && serverTokens.every(token => mod.DESKTOP_CONTROL_STATES.includes(token)),
    `G1 desktop-control 状态词典前后端一致(${serverTokens.join(', ')})`);
  // 安装器日志只允许出现在注释里(说明「为什么不读它」);一旦落到代码行就是新造了跨组件路径耦合。
  const accLogInCode = dispatchSrc.split('\n').filter(line => line.includes('acc-install-latest') && !line.trim().startsWith('//'));
  ok(dispatchSrc.includes("push('desktop-control'") && dispatchSrc.includes('function desktopControlState(config)')
    && dispatchSrc.includes('peekCapabilities()') && accLogInCode.length === 0,
    'G2 服务端 desktop-control 只用工作台已有的数据(config + 只读能力缓存 + 桥接解析),不去读安装器日志');
  ok(routerSrc.includes('function doctorHumanLines(') && routerSrc.includes("argv.human === true")
    && routerSrc.includes('doctorLocaleCatalog(') && mainSrc.includes('doctor(argv)'),
    'G3 CLI doctor --human 已接线且默认仍走 JSON');
  ok(/console\.log\(JSON\.stringify\(info, null, 2\)\);\r?\n\s*\/\/ 118b/.test(routerSrc),
    'G4 默认 JSON 输出在 --human 判定之前打印,脚本调用逐字节不变');
  ok(overlayBuilder.includes("'app/public/js/health-i18n.js'"), 'G5 overlay 离线载荷含映射模块');
  ok(/\.health-row \.h-pill\b/.test(toolPaneCss) && /\.health-summary-line\b/.test(toolPaneCss)
    && /\.health-summary-chip\b/.test(primitivesCss) && /\.health-entry-dot\b/.test(layoutCss),
    'G6 样式落在已注册的所有权层(tool-pane / chat-primitives / layout),未新开样式层');
  ok(toolPaneCss.includes('@media (max-width: 520px)'), 'G7 体检行含窄屏(390px 档)收敛规则');

  console.log('\nHEALTH I18N STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('HEALTH I18N STATIC E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
