#!/usr/bin/env node
'use strict';
// 静态锁 + DOM 桩行为件(第118波 118a):壳无关欢迎向导。
//
// 断言七个方向:
//   ① 模块导出面:纯函数 shouldShowOnboarding / onboardingStepsFor / validateApiKeyShape /
//      validateBaseUrlShape + 版本常量 + 工厂 createOnboardingWizardDomain(117 管家可直接复用纯函数)。
//   ② 步骤定义:恒为 6 步、次序固定,done 位只由 config 派生(不读 UI 运行态)。
//   ③ 前置校验:key 形状(空/空白/遮盖/过短/过长/前缀提示)与 URL 形状(空/空格/协议)。
//   ④ DOM 桩行为(不需要浏览器/服务):模态骨架(role=dialog + aria-modal + aria-live 状态行)、
//      六步导航、Esc/取消 -> onboarding{skipped:true}、走到完成页 -> {completedAt,version:1}、
//      预设保存复用注入的 providerDraftFromPreset 并 POST providers + activeProvider、保存后密钥不留存。
//   ⑤ 零 innerHTML:模块源码不含 innerHTML/insertAdjacentHTML/document.write,DOM 走 el()+replaceChildren。
//   ⑥ 两壳与设置页共用同一个模块(经典壳持有实例并导出入口;预览壳与设置运维域由组合根注入同一入口)。
//   ⑦ i18n 四文件齐 + CSS 层已在 index.html/styles.css/read-frontend-css/build-overlay 注册且尊重 reduced-motion。
//
// 判定行:`ONBOARDING STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const modulePath = path.join(PUBLIC, 'js', 'onboarding-wizard.js');
const moduleSrc = fs.readFileSync(modulePath, 'utf8');
// 118a-fix: 应用内手册阅读器(完成页「打开手册」的落点)。
const helpViewerPath = path.join(PUBLIC, 'js', 'help-viewer.js');
const helpViewerSrc = fs.readFileSync(helpViewerPath, 'utf8');
const sessionSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'session-experience.js'), 'utf8');
const previewSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'preview-shell.js'), 'utf8');
const settingsOpsSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'settings-operations.js'), 'utf8');
const providerSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'provider-settings.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const stylesManifest = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const cssSrc = fs.readFileSync(path.join(PUBLIC, 'css', 'components', 'onboarding.css'), 'utf8');
const cssHarness = fs.readFileSync(path.join(__dirname, 'read-frontend-css.js'), 'utf8');
const overlayBuilder = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');

/* ═══════════ ⑤ 零 innerHTML(源码级) ═══════════ */
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(moduleSrc),
  'E1 向导模块零 innerHTML / insertAdjacentHTML / document.write');
ok(moduleSrc.includes('replaceChildren(') && moduleSrc.includes("el('"),
  'E2 DOM 全部经 el() 与 replaceChildren() 构建');
ok(!/^import\s/m.test(moduleSrc),
  'E3 模块零 import(壳无关:每个环境依赖都从工厂注入,117 管家可零 DOM 复用纯函数)');
// 118a-fix: 「复制路径让用户自己去打开」的反模式在向导里彻底消失(键、类名、剪贴板调用三处一起锁)。
ok(!/onboarding\.wizard\.done\.(copyPath|copied|copyFailed)/.test(moduleSrc)
  && !/onboard-wiz-copy/.test(moduleSrc)
  && !/clipboard/i.test(moduleSrc)
  && !/ONBOARDING_MANUAL_PATHS/.test(moduleSrc)
  && !/docs\/manuals\//.test(moduleSrc),
  'E4 向导零「复制路径」出口(无 copyPath/copied/copyFailed 键、无 onboard-wiz-copy、无 clipboard、无手册相对路径)');
ok(moduleSrc.includes('openHelpViewer({ docId: ONBOARDING_MANUAL_DOC_ID })')
  && moduleSrc.includes("export const ONBOARDING_MANUAL_DOC_ID = 'user-guide'"),
  'E5 完成页手册入口改为调用注入的 openHelpViewer(应用内阅读器)');
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(helpViewerSrc),
  'E6 手册阅读器零 innerHTML / insertAdjacentHTML / document.write');
ok(!/^import\s/m.test(helpViewerSrc) && helpViewerSrc.includes('renderMarkdownInto')
  && !/clipboard/i.test(helpViewerSrc),
  'E7 阅读器零 import、markdown 只经注入的 renderMarkdownInto 落 DOM、零剪贴板出口');
ok(overlayBuilder.includes("'app/public/js/help-viewer.js'"), 'E8 overlay 离线载荷含手册阅读器模块');
ok(/\.help-viewer-toc-link\s*\{/.test(cssSrc) && /\.modal\.help-viewer\s*\{/.test(cssSrc)
  && cssSrc.includes('@media (max-width: 720px)'),
  'E9 阅读器样式在已注册的 onboarding.css 层内(含窄屏单栏收敛),不新增样式层');
ok(sessionSrc.includes("from './help-viewer.js'") && sessionSrc.includes('createHelpViewerDomain({')
  && sessionSrc.includes('openHelpViewer: (...args) => openHelpViewer(...args)')
  && appSrc.includes('renderMarkdownInto: (...args) => renderMarkdownInto(...args), highlightIn: (...args) => highlightIn(...args)'),
  'E10 阅读器实例与向导同一接线口径:经典壳持有,组合根只透传 markdown 渲染原语');

/* ═══════════ ⑥ 两壳与设置页共用同一模块 ═══════════ */
ok(sessionSrc.includes("from './onboarding-wizard.js'") && sessionSrc.includes('createOnboardingWizardDomain({'),
  'F1 经典壳(session-experience)持有唯一向导实例');
ok(sessionSrc.includes("t('onboarding.wizard.start')") && sessionSrc.includes('openOnboardingWizard()'),
  'F2 经典首跑卡有「开始引导」主按钮');
ok(/openOnboardingWizard,\n/.test(sessionSrc) || sessionSrc.includes('    openOnboardingWizard,'),
  'F3 经典壳导出 openOnboardingWizard 供组合根分发');
ok(previewSrc.includes('openOnboardingWizard = () => {},') && previewSrc.includes("t('onboarding.wizard.start')"),
  'F4 预览壳首跑引导用注入的同一入口(不另建一套引导)');
ok(settingsOpsSrc.includes("$('reopenOnboardingBtn')") && settingsOpsSrc.includes('openOnboarding()'),
  'F5 设置页「重新打开引导」按钮由运维域接线');
ok(appSrc.includes('openOnboardingWizard: () => openOnboardingWizard()') && appSrc.includes('openOnboarding: () => openOnboardingWizard()'),
  'F6 组合根把同一个实例注入预览壳与设置运维域');
ok(indexHtml.includes('id="reopenOnboardingBtn"') && indexHtml.includes('data-i18n="onboarding.wizard.reopen"'),
  'F7 index.html 设置基础页含可重开入口且文案走 i18n');
ok(providerSrc.includes('export function providerDraftFromPreset(')
  && providerSrc.includes('providerDraftFromPreset(preset, state.providersDraft.map(p => p.id))')
  && sessionSrc.includes("import { providerDraftFromPreset } from './provider-settings.js'"),
  'F8 provider 序列化只有一份实现,设置页与向导共用');
// 118b: 首跑卡的体检摘要红点。新手不会自己想到「设置里有一页体检」,所以待办数直接摆在首屏,
// 且必须是可点的真动作(直达体检页),不是一句「去设置里看看」。
ok(sessionSrc.includes("import { healthSummaryText } from './health-i18n.js'")
  && sessionSrc.includes('function buildHealthSummaryChip()')
  && /const healthSummary = buildHealthSummaryChip\(\);\s*\n\s*if \(healthSummary\) wrap\.appendChild\(healthSummary\);/.test(sessionSrc),
  'F9 首跑卡渲染体检摘要红点(无待办时 buildHealthSummaryChip 返回 null,不渲染)');
ok(/chip\.onclick = \(\) => \{ openModal\('settingsModal'\); switchSettingsTab\('doctor', true\); \};/.test(sessionSrc)
  && sessionSrc.includes("t('health.summary.open')"),
  'F10 红点可点且直达体检页签(force=true,不被简易模式收敛弹回基础页)');

/* ═══════════ ⑦ CSS 注册与 reduced-motion ═══════════ */
ok(indexHtml.includes('<link rel="stylesheet" href="/css/components/onboarding.css" />'), 'G1 index.html 已加载新样式层');
ok(stylesManifest.includes('@import url("/css/components/onboarding.css");'), 'G2 styles.css 兼容清单同步');
ok(cssHarness.includes("'css/components/onboarding.css'"), 'G3 CSS 载荷组清单登记新层');
ok(overlayBuilder.includes("'app/public/css/components/onboarding.css'") && overlayBuilder.includes("'app/public/js/onboarding-wizard.js'"),
  'G4 overlay 离线载荷含新模块与新样式层');
ok(/\.onboard-wiz-card\s*\{/.test(cssSrc) && /\.onboard-wiz-rail\s*\{/.test(cssSrc) && /\.onboard-wiz-status\s*\{/.test(cssSrc),
  'G5 样式层含卡片/步骤条/状态行规则');
ok(!/animation\s*:/.test(cssSrc) && cssSrc.includes('@media (prefers-reduced-motion: reduce)'),
  'G6 无自带动画且显式尊重 reduced-motion');
ok(cssSrc.includes('@media (max-width: 520px)'), 'G7 含窄屏(390px 档)收敛规则');

/* ═══════════ ①②③④ 动态加载 ═══════════ */
class FakeClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  add(...names) { for (const name of names) if (name) this.values.add(String(name)); this.sync(); }
  remove(...names) { for (const name of names) this.values.delete(String(name)); this.sync(); }
  contains(name) { return this.values.has(String(name)); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(String(name)) : Boolean(force);
    if (next) this.values.add(String(name)); else this.values.delete(String(name));
    this.sync();
    return next;
  }
  setFrom(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); this.sync(); }
  sync() { this.owner._className = [...this.values].join(' '); }
}
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this._className = '';
    this.classList = new FakeClassList(this);
    this._textContent = '';
    this.listeners = {};
    this.offsetParent = this; // every shim node counts as visible
  }
  get className() { return this._className; }
  set className(value) { this.classList.setFrom(value); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.parentNode = null;
    this.children = [];
    this._textContent = '';
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  contains(node) { let cur = node; while (cur) { if (cur === this) return true; cur = cur.parentNode; } return false; }
  set textContent(value) { this._textContent = String(value ?? ''); this.children = []; }
  get textContent() {
    if (this._textContent) return this._textContent;
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return '';
  }
  setAttribute(name, value) { this.attributes[String(name)] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  focus() { fakeDoc.activeElement = this; }
  // 只支持这两类选择器:纯标签名(118a-fix 阅读器建目录用 'h2'),其余一律按「可聚焦控件集合」处理
  // (向导与阅读器的焦点陷阱只用这一种)。递归收集 input/select/textarea/button。
  querySelectorAll(selector) {
    const tag = /^[a-z][a-z0-9]*$/i.test(String(selector || '')) ? String(selector).toUpperCase() : '';
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (tag ? child.tagName === tag : ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(child.tagName)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}
const fakeEl = (tag, cls, text) => {
  const e = new FakeElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const fakeDoc = { body: new FakeElement('body'), activeElement: null };
function findAll(node, cls) {
  const found = [];
  const visit = n => { for (const child of n.children) { if (child.classList.contains(cls)) found.push(child); visit(child); } };
  visit(node);
  return found;
}
const findOne = (node, cls) => findAll(node, cls)[0] || null;
const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(moduleSrc).toString('base64')}`);

  /* ① 导出面 */
  for (const name of ['ONBOARDING_VERSION', 'ONBOARDING_STEP_IDS', 'ONBOARDING_SAFETY_MODES', 'ONBOARDING_PLAYBOOK_IDS',
    'shouldShowOnboarding', 'onboardingStepsFor', 'validateApiKeyShape', 'validateBaseUrlShape', 'createOnboardingWizardDomain']) {
    ok(mod[name] !== undefined, `A1 导出 ${name}`);
  }
  ok(mod.ONBOARDING_VERSION === 1, 'A2 ONBOARDING_VERSION === 1');
  ok(mod.ONBOARDING_PLAYBOOK_IDS.join(',') === 'clean-downloads,meeting-minutes,translate-document',
    'A3 完成页三张任务卡 = 清理下载文件夹/整理会议纪要/翻译文档');
  ok(mod.LOCAL_ENDPOINT_EXAMPLE === 'http://127.0.0.1:11434/v1', 'A4 本地端点示例是 Ollama 默认地址(仅预填,需用户确认)');
  ok(mod.errorMessageOf({ error: '密钥无效' }) === '密钥无效'
    && mod.errorMessageOf({ error: { code: 'api.request_failed', message: '密钥无效或无权限(HTTP 401)' } }) === '密钥无效或无权限(HTTP 401)'
    && mod.errorMessageOf({}) === '',
  'A4b errorMessageOf 同时读裸字符串与 {code,params,message} 信封(不渲染 [object Object])');

  /* 首跑判定 */
  ok(mod.shouldShowOnboarding({}, []) === true, 'A5 空配置 + 无会话 -> 提示引导');
  ok(mod.shouldShowOnboarding({}, [{ id: 's1' }]) === false, 'A6 已有会话 -> 不再提示');
  ok(mod.shouldShowOnboarding({ recentWorkspaces: ['C:/x'] }, []) === false, 'A7 已有最近工作区 -> 不再提示');
  ok(mod.shouldShowOnboarding({ onboarding: { completedAt: '2026-09-03T00:00:00.000Z', version: 1, skipped: false } }, []) === false,
    'A8 已完成 -> 不再提示');
  ok(mod.shouldShowOnboarding({ onboarding: { completedAt: null, version: 1, skipped: true } }, []) === false,
    'A9 已跳过 -> 不再自动提示(仍可从设置重开)');

  /* ② 步骤定义 */
  const steps = mod.onboardingStepsFor({});
  ok(steps.length === 6, 'B1 步骤定义恒为 6 步');
  ok(steps.map(s => s.id).join(',') === 'language,engine,provider,workspace,safety,done',
    'B2 步骤次序 = 语言/引擎/密钥/文件夹/安全档/完成');
  ok(steps.every((s, i) => s.index === i && typeof s.titleKey === 'string' && s.titleKey.startsWith('onboarding.wizard.')),
    'B3 每步带 index 与 onboarding.wizard.* 文案键(117 管家可直接复用)');
  const doneSteps = mod.onboardingStepsFor({
    locale: 'zh-CN', providers: [{ id: 'p' }], defaultWorkspace: 'C:/w', permissionMode: 'default',
    onboarding: { completedAt: '2026-09-03T00:00:00.000Z', version: 1, skipped: false },
  });
  ok(doneSteps.every(s => s.done === true), 'B4 done 位纯由 config 派生(全配齐 -> 六步全绿)');
  ok(mod.onboardingStepsFor({ locale: 'auto' })[0].done === false, 'B5 locale=auto 不算已选语言');

  /* ③ 前置校验 */
  ok(mod.validateApiKeyShape('deepseek', '').ok === false && mod.validateApiKeyShape('deepseek', '').code === 'keyEmpty', 'C1 空 key 被拦');
  ok(mod.validateApiKeyShape('local', '').ok === true, 'C2 本地端点允许空 key');
  ok(mod.validateApiKeyShape('deepseek', 'sk-abc def123').code === 'keyWhitespace', 'C3 含空格 -> keyWhitespace');
  ok(mod.validateApiKeyShape('deepseek', 'sk-abc\ndef123').code === 'keyWhitespace', 'C4 含换行 -> keyWhitespace');
  ok(mod.validateApiKeyShape('deepseek', '\u2022\u2022\u2022\u20221234').code === 'keyMasked', 'C5 遮盖值 -> keyMasked');
  ok(mod.validateApiKeyShape('deepseek', 'sk-abc').code === 'keyTooShort', 'C6 过短 -> keyTooShort');
  ok(mod.validateApiKeyShape('deepseek', 'sk-' + 'a'.repeat(600)).code === 'keyTooLong', 'C7 过长 -> keyTooLong');
  ok(mod.validateApiKeyShape('deepseek', 'sk-1234567890').ok === true && mod.validateApiKeyShape('deepseek', 'sk-1234567890').warn === '',
    'C8 正常 sk- key 通过且无提示');
  ok(mod.validateApiKeyShape('deepseek', 'abcdefghij').ok === true && mod.validateApiKeyShape('deepseek', 'abcdefghij').warn === 'keyPrefixWarning',
    'C9 非 sk- 前缀只提示不拦(自建端点合法)');
  ok(mod.validateApiKeyShape('glm', 'abcdefghij').warn === '', 'C10 非 sk- 家族(GLM)不做前缀提示');
  ok(mod.validateBaseUrlShape('').code === 'urlEmpty', 'C11 空地址 -> urlEmpty');
  ok(mod.validateBaseUrlShape('api.deepseek.com').code === 'urlScheme', 'C12 缺协议 -> urlScheme');
  ok(mod.validateBaseUrlShape('http://127.0.0.1:11434 /v1').code === 'urlSpace', 'C13 含空格 -> urlSpace');
  ok(mod.validateBaseUrlShape('http://127.0.0.1:11434/v1').ok === true && mod.validateBaseUrlShape('https://api.deepseek.com').ok === true,
    'C14 合法 http/https 地址通过');

  /* ④ DOM 桩行为 */
  const helpOpens = [];
  const presets = [{ id: 'fakeco', label: 'FakeCo', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'fake-model', reasoning: true, models: [{ id: 'fake-model', label: 'Fake Model' }] }];
  function makeHost(overrides = {}) {
    const calls = [];
    const state = { config: { locale: 'zh-CN', permissionMode: 'default', providers: [] }, sessions: [], status: { providerPresets: presets }, playbooks: [] };
    const api = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      if (url === '/api/config') { state.config = { ...state.config, ...body }; return { ok: true, config: state.config }; }
      if (url === '/api/provider/test') return overrides.testResult || { ok: true, models: [{ id: 'fake-model' }, { id: 'fake-reasoner' }] };
      return { ok: true };
    };
    const domain = mod.createOnboardingWizardDomain({
      state, api, el: fakeEl,
      // t 桩：把 params 拼回文本，以便断言「怎么办」行确实嵌入了 errorClass 对应的目录键。
      t: (key, params) => key + (params && Object.keys(params).length ? '{' + Object.entries(params).map(([k, v]) => k + '=' + v).join(',') + '}' : ''),
      toast: () => {},
      getLocale: () => 'zh-CN',
      setLocale: async locale => locale,
      providerDraftFromPreset: (preset, existing) => ({
        id: existing.includes(preset.id) ? preset.id + '-2' : preset.id,
        label: preset.label, type: 'openai-compat', baseUrl: preset.baseUrl || '', apiKey: '',
        model: preset.defaultModel || '', models: (preset.models || []).map(m => ({ id: m.id, label: m.label || m.id })),
        reasoning: !!preset.reasoning, systemPrompt: '', temperature: '',
      }),
      pickWorkspace: async () => { state.config.defaultWorkspace = 'C:/chosen'; },
      openSettings: () => {},
      openPlaybook: () => {},
      // 118a-fix: 完成页手册入口注入的是应用内阅读器,不再有剪贴板/路径出口。
      openHelpViewer: options => { helpOpens.push(options || {}); },
      doc: fakeDoc,
    });
    return { domain, state, calls };
  }

  // 骨架 + a11y
  const host1 = makeHost();
  const backdrop = host1.domain.openOnboardingWizard();
  await flush();
  const modal = findOne(backdrop, 'onboard-wizard');
  ok(!!modal && modal.getAttribute('role') === 'dialog' && modal.getAttribute('aria-modal') === 'true',
    'D1 模态是 role=dialog + aria-modal=true');
  const status = findOne(backdrop, 'onboard-wiz-status');
  ok(!!status && status.getAttribute('aria-live') === 'polite' && status.getAttribute('role') === 'status',
    'D2 状态行是 aria-live=polite 的 live region');
  ok(fakeDoc.body.children.includes(backdrop), 'D3 模态已挂载到 document.body');
  ok(typeof backdrop.__cancel === 'function' && typeof backdrop.__close === 'function',
    'D4 backdrop 暴露 __cancel/__close(全局 Esc 处理器据此把 Esc 当「以后再说」)');
  ok(findAll(backdrop, 'onboard-wiz-rail-item').length === 6, 'D5 步骤条 6 格');
  ok(host1.domain.openOnboardingWizard() === backdrop, 'D6 已有向导打开时不叠第二个');

  // 语言步 -> 引擎步 -> 密钥步(跳过) -> 文件夹 -> 安全 -> 完成
  ok(findOne(backdrop, 'onboard-wiz-locale') !== null, 'D7 第 1 步是语言选择');
  findOne(backdrop, 'onboard-wiz-next').onclick();
  await flush();
  ok(findAll(backdrop, 'onboard-wiz-card').length >= 3, 'D8 第 2 步是引擎三选一');
  findOne(backdrop, 'onboard-wiz-next').onclick();
  await flush();
  ok(findOne(backdrop, 'onboard-wiz-key') !== null && findOne(backdrop, 'onboard-wiz-key').type === 'password',
    'D9 第 3 步只显示密码型 API Key 输入');
  ok(findOne(backdrop, 'onboard-wiz-advanced') !== null && findOne(backdrop, 'onboard-wiz-advanced').open === false,
    'D10 baseUrl/模型收在默认折叠的「高级」里');
  ok(findOne(backdrop, 'onboard-wiz-skipstep') !== null, 'D11 密钥步可跳过(无 key 也能走完向导)');
  findOne(backdrop, 'onboard-wiz-skipstep').onclick();
  await flush();
  ok(findOne(backdrop, 'onboard-wiz-drop') !== null, 'D12 第 4 步是工作文件夹拖放/选择区');
  await findOne(backdrop, 'onboard-wiz-pick').onclick();
  await flush();
  ok(host1.state.config.defaultWorkspace === 'C:/chosen', 'D13 「选择文件夹」走注入的原生选择器');
  findOne(backdrop, 'onboard-wiz-next').onclick();
  await flush();
  const safetyCards = findAll(backdrop, 'onboard-wiz-card');
  ok(safetyCards.length === 4 && safetyCards[0].getAttribute('aria-checked') === 'true',
    'D14 第 5 步是四档安全单选,默认「每步都问」');
  await safetyCards[1].onclick();
  await flush();
  ok(host1.state.config.permissionMode === 'acceptEdits', 'D15 选安全档立即落 permissionMode');
  findOne(backdrop, 'onboard-wiz-next').onclick();
  await flush();
  ok(findAll(backdrop, 'onboard-wiz-playbook').length === 3, 'D16 完成页三张 Playbook 卡');
  // 118a-fix: 完成页不再印相对路径、不再有复制按钮;只有一个「打开手册」,点了就在应用内读。
  ok(findOne(backdrop, 'onboard-wiz-manual-path') === null && findOne(backdrop, 'onboard-wiz-copy') === null,
    'D17 完成页已无手册路径文本与复制按钮(反模式已消除)');
  const manualBtn = findOne(backdrop, 'onboard-wiz-manual-open');
  ok(!!manualBtn && manualBtn.textContent === 'help.doc.open', 'D18 完成页手册入口是「打开手册」按钮');
  manualBtn.onclick();
  ok(helpOpens.length === 1 && helpOpens[0].docId === 'user-guide',
    'D18b 点「打开手册」调注入的 openHelpViewer({docId:user-guide}),不碰剪贴板/文件管理器');
  await findOne(backdrop, 'onboard-wiz-finish').onclick();
  await flush();
  const record = host1.state.config.onboarding;
  ok(record && typeof record.completedAt === 'string' && record.version === 1 && record.skipped === false,
    'D19 「完成」写入 onboarding{completedAt,version:1,skipped:false}');
  ok(!fakeDoc.body.children.includes(backdrop), 'D20 完成后模态关闭并从 body 摘除');

  // 「以后再说」/Esc -> skipped:true 且仍可重开
  const host2 = makeHost();
  const backdrop2 = host2.domain.openOnboardingWizard();
  await flush();
  await findOne(backdrop2, 'onboard-wiz-skip').onclick();
  await flush();
  ok(host2.state.config.onboarding && host2.state.config.onboarding.skipped === true && host2.state.config.onboarding.completedAt === null,
    'D21 「以后再说」写入 skipped:true(completedAt 留空)');
  ok(mod.shouldShowOnboarding(host2.state.config, []) === false && host2.domain.openOnboardingWizard() !== null,
    'D22 跳过后不再自动提示,但仍可显式重开');
  const backdrop2b = fakeDoc.body.children[fakeDoc.body.children.length - 1];
  backdrop2b.__cancel();
  await flush();

  // 预设保存:复用注入的 providerDraftFromPreset,POST providers + activeProvider,保存后不留密钥
  const host3 = makeHost();
  const backdrop3 = host3.domain.openOnboardingWizard();
  await flush();
  findOne(backdrop3, 'onboard-wiz-next').onclick(); await flush();
  findOne(backdrop3, 'onboard-wiz-next').onclick(); await flush();
  const keyInput = findOne(backdrop3, 'onboard-wiz-key');
  keyInput.value = 'sk-onboarding-test-key';
  keyInput.oninput();
  await findOne(backdrop3, 'onboard-wiz-test').onclick();
  await flush();
  const testCall = host3.calls.find(c => c.url === '/api/provider/test');
  ok(!!testCall && testCall.body.provider.baseUrl === 'http://127.0.0.1:9/v1' && testCall.body.provider.apiKey === 'sk-onboarding-test-key',
    'D23 「测试连接」走既有 /api/provider/test,带上草稿与明文密钥');
  const modelSelect = findOne(backdrop3, 'onboard-wiz-model');
  ok(!!modelSelect && modelSelect.tagName === 'SELECT' && modelSelect.children.length === 2,
    'D24 测试成功后模型输入变成服务端返回的可选清单');
  await findOne(backdrop3, 'onboard-wiz-save').onclick();
  await flush();
  const saveCall = [...host3.calls].reverse().find(c => c.url === '/api/config' && c.body && c.body.providers);
  ok(!!saveCall && saveCall.body.providers.length === 1 && saveCall.body.activeProvider === 'fakeco',
    'D25 保存写 providers[] 并把新端点设为活动引擎');
  ok(saveCall.body.providers[0].type === 'openai-compat' && saveCall.body.providers[0].reasoning === true,
    'D26 provider 形状来自注入的设置页序列化器(不是第二套)');
  ok(saveCall.body.providers[0].apiKey === 'sk-onboarding-test-key', 'D27 明文密钥只在这一次请求里发给本机服务');
  const afterSaveKey = findOne(backdrop3, 'onboard-wiz-key');
  ok(!afterSaveKey || afterSaveKey.value === '', 'D28 保存后界面不再持有/回显密钥');
  findOne(backdrop3, 'onboard-wiz-skip') && findOne(backdrop3, 'onboard-wiz-skip').onclick();
  await flush();

  // 失败路径:服务端人话 + 「怎么办」
  const host4 = makeHost({ testResult: { ok: false, error: { code: 'api.request_failed', params: {}, message: '密钥无效或无权限(HTTP 401)' }, errorClass: 'provider_misconfigured' } });
  const backdrop4 = host4.domain.openOnboardingWizard();
  await flush();
  findOne(backdrop4, 'onboard-wiz-next').onclick(); await flush();
  findOne(backdrop4, 'onboard-wiz-next').onclick(); await flush();
  const key4 = findOne(backdrop4, 'onboard-wiz-key');
  key4.value = 'sk-bad-key-value'; key4.oninput();
  await findOne(backdrop4, 'onboard-wiz-test').onclick();
  await flush();
  const status4 = findOne(backdrop4, 'onboard-wiz-status');
  ok(status4.textContent.includes('HTTP 401') && status4.textContent.includes('error.providerMisconfigured.next'),
    'D29 测试失败显示服务端人话 + 复用 errorClass 的「怎么办」文案');
  ok(status4.classList.contains('err'), 'D30 失败态状态行带 err 样式钩子');
  // 校验前置:空 key 根本不发请求
  const before = host4.calls.length;
  key4.value = ''; key4.oninput();
  await findOne(backdrop4, 'onboard-wiz-test').onclick();
  await flush();
  ok(host4.calls.length === before && findOne(backdrop4, 'onboard-wiz-status').textContent === 'onboarding.wizard.validate.keyEmpty',
    'D31 前置校验不通过时不发网络请求');
  findOne(backdrop4, 'onboard-wiz-skip').onclick();
  await flush();
  // opts.startStep:设置深链/117 管家可以从指定步骤打开。
  const hostDeep = makeHost();
  const deep = hostDeep.domain.openOnboardingWizard({ startStep: 'safety' });
  await flush();
  ok(findOne(deep, 'onboard-wiz-safety') !== null && findAll(deep, 'onboard-wiz-card').length === 4,
    'D6b openOnboardingWizard({startStep}) 直接打开指定步骤');
  deep.__cancel();
  await flush();

  /* ⑧ 手册阅读器(118a-fix):导出面 + 纯函数 + DOM 桩行为 */
  const help = await import(`data:text/javascript;base64,${Buffer.from(helpViewerSrc).toString('base64')}`);
  for (const name of ['HELP_DOC_IDS', 'HELP_LOCALES', 'helpDocRequestPath', 'helpAnchorId', 'helpDocRefFor',
    'isCrossOriginHref', 'createHelpViewerDomain']) {
    ok(help[name] !== undefined, `I1 阅读器导出 ${name}`);
  }
  ok(help.HELP_DOC_IDS.join(',') === 'user-guide,admin-guide', 'I2 文档 id 是写死的白名单枚举');
  ok(help.helpDocRequestPath('user-guide', 'zh-CN') === '/api/help/doc?id=user-guide&lang=zh-CN'
    && help.helpDocRequestPath('user-guide', '') === '/api/help/doc?id=user-guide',
    'I3 取文 URL 只带 id/lang 两个受控参数(不带任何路径)');
  ok(help.helpDocRequestPath('../../..', 'zh-CN') === ''
    && help.helpDocRequestPath('user-guide/../../etc', 'zh-CN') === ''
    && help.helpDocRequestPath('', '') === '',
    'I4 非白名单 id(含穿越串)在前端就被挡住,连请求都不发');
  ok(help.helpAnchorId('2. 开始一个任务', 1) === 'help-sec-1-2-开始一个任务'
    && help.helpAnchorId('Getting Started (fast)', 0) === 'help-sec-0-getting-started-fast',
    'I5 锚点 id 由标题文本推导(中英都可用,目录跳转与 anchor 参数同一套)');

  // DOM 桩:阅读器自带 document(要 addEventListener 才能装 Esc 捕获处理器)。
  const helpDoc = {
    body: new FakeElement('body'), activeElement: null, listeners: [],
    addEventListener: (type, handler, capture) => { helpDoc.listeners.push({ type, handler, capture }); },
    removeEventListener: (type, handler) => { helpDoc.listeners = helpDoc.listeners.filter(l => l.handler !== handler); },
  };
  const helpCalls = [];
  const helpApi = async url => {
    helpCalls.push(url);
    if (url.includes('lang=en-US')) {
      return { ok: true, id: 'user-guide', lang: 'en-US', available: ['zh-CN', 'en-US'], title: 'User Guide', markdown: '# User Guide' };
    }
    return { ok: true, id: 'user-guide', lang: 'zh-CN', available: ['zh-CN', 'en-US'], title: '如意使用手册', markdown: '# 如意使用手册' };
  };
  // renderMarkdownInto 桩:模拟消毒后的正文(两个 h2),阅读器据此补锚点并建目录。
  const fakeRender = (container, value) => {
    container.replaceChildren();
    container.append(fakeEl('h1', '', String(value || '').replace(/^#\s+/, '')));
    container.append(fakeEl('h2', '', '第一步 选文件夹'));
    container.append(fakeEl('h2', '', '第二步 交任务'));
    return container;
  };
  const helpDomain = help.createHelpViewerDomain({
    api: helpApi, el: fakeEl, t: key => key, toast: () => {},
    getLocale: () => 'zh-CN', renderMarkdownInto: fakeRender, highlightIn: () => {}, doc: helpDoc,
  });
  const helpBackdrop = helpDomain.openHelpViewer({ docId: 'user-guide' });
  await flush();
  await flush();
  const helpModal = findOne(helpBackdrop, 'help-viewer');
  ok(!!helpModal && helpModal.getAttribute('role') === 'dialog' && helpModal.getAttribute('aria-modal') === 'true',
    'I6 阅读器是 role=dialog + aria-modal=true 的模态');
  ok(helpCalls.length === 1 && helpCalls[0] === '/api/help/doc?id=user-guide&lang=zh-CN',
    'I7 打开即按当前语言请求手册正文');
  ok(findOne(helpBackdrop, 'help-viewer-title').textContent === '如意使用手册', 'I8 抬头用服务端返回的文档标题');
  const tocLinks = findAll(helpBackdrop, 'help-viewer-toc-link');
  ok(tocLinks.length === 2 && tocLinks[0].textContent === '第一步 选文件夹' && tocLinks[0].tagName === 'BUTTON',
    'I9 目录由正文 h2 生成,条目是可键盘到达的按钮');
  const langBtns = findAll(helpBackdrop, 'help-viewer-lang');
  ok(langBtns.length === 2, 'I10 两种语言都在时给出中英切换');
  langBtns.find(b => !b.classList.contains('active')).onclick();
  await flush();
  await flush();
  ok(helpCalls.length === 2 && helpCalls[1].includes('lang=en-US'), 'I11 切换语言重取同一份文档的另一语种');
  ok(helpDomain.openHelpViewer({ docId: 'user-guide' }) === helpBackdrop, 'I12 已打开时不叠第二个阅读器');
  // Esc 只关最上面这一层:捕获相位处理器停止冒泡,底下的向导不会被顺手当「以后再说」关掉。
  const escHandler = helpDoc.listeners.find(l => l.type === 'keydown' && l.capture === true);
  let propagationStopped = false;
  ok(!!escHandler, 'I13 阅读器在 document 捕获相位自持 Esc(叠层语义)');
  escHandler.handler({ key: 'Escape', stopPropagation: () => { propagationStopped = true; }, preventDefault: () => {} });
  ok(propagationStopped && !helpDoc.body.children.includes(helpBackdrop),
    'I14 Esc 关掉阅读器并阻止冒泡(全局 Esc 不会连带取消底下的向导)');
  ok(helpDoc.listeners.length === 0, 'I15 关闭后摘掉 Esc 监听(不泄漏处理器)');
  // 手册文件缺失(精简包):降级文案仍是应用内的下一步,不是「自己去某个路径打开」。
  const missingDomain = help.createHelpViewerDomain({
    api: async () => ({ ok: false, error: 'help.doc_missing' }), el: fakeEl, t: key => key, toast: () => {},
    getLocale: () => 'zh-CN', renderMarkdownInto: fakeRender, highlightIn: () => {}, doc: helpDoc,
  });
  const missingBackdrop = missingDomain.openHelpViewer({ docId: 'user-guide' });
  await flush();
  await flush();
  ok(findOne(missingBackdrop, 'help-viewer-missing-body') !== null
    && findOne(missingBackdrop, 'help-viewer-missing-body').textContent === 'help.doc.missingBody',
    'I16 手册文件缺失时给应用内解释(help.doc.missingBody),不给路径');
  missingBackdrop.__close();
  ok(help.helpDocRequestPath('admin-guide', 'en-US') === '/api/help/doc?id=admin-guide&lang=en-US',
    'I17 管理员手册同一条通道(白名单第二项)');
  // 正文里的相对链接收口:手册互引 -> 应用内切换;其余相对链接 -> 摘掉 href;跨站 http(s) -> 放行给新标签页。
  ok(JSON.stringify(help.helpDocRefFor('USER-GUIDE_CN.md')) === '{"id":"user-guide","lang":"zh-CN"}'
    && JSON.stringify(help.helpDocRefFor('./ADMIN-GUIDE_EN.md#x')) === '{"id":"admin-guide","lang":"en-US"}'
    && help.helpDocRefFor('../../../SECURITY.md') === null
    && help.helpDocRefFor('') === null,
    'I18 手册互引的磁盘文件名被翻译成应用内 {id,lang}(非手册的相对链接不认领)');
  ok(help.isCrossOriginHref('https://example.com/x', 'http://127.0.0.1:8793/') === true
    && help.isCrossOriginHref('USER-GUIDE_CN.md', 'http://127.0.0.1:8793/') === false
    && help.isCrossOriginHref('http://127.0.0.1:8793/a', 'http://127.0.0.1:8793/') === false,
    'I19 跨站判定:只有真外站算外链(相对链接与同源一律按应用内处理)');
  ok(helpViewerSrc.includes('help-viewer-doclink') && helpViewerSrc.includes('help-viewer-deadlink')
    && /\.help-viewer-doclink\s*\{/.test(cssSrc),
    'I20 正文相对链接不留死链(手册互引变按钮,其余降级为文字)且样式已就位');

  /* ⑦ i18n 四文件 */
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const zh = readJson(path.join(PUBLIC, 'locales', 'zh-CN.json'));
  const en = readJson(path.join(PUBLIC, 'locales', 'en-US.json'));
  const docsZh = readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json'));
  const docsEn = readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json'));
  const wizardKeys = Object.keys(zh).filter(key => key.startsWith('onboarding.wizard.'));
  ok(wizardKeys.length >= 80, `H1 onboarding.wizard.* 键齐(${wizardKeys.length} 条)`);
  const missing = wizardKeys.filter(key => !(typeof en[key] === 'string' && en[key]) || docsZh[key] !== zh[key] || docsEn[key] !== en[key]);
  ok(missing.length === 0, 'H2 四个 locale 文件逐字一致' + (missing.length ? ' (缺: ' + missing.slice(0, 3).join(', ') + ')' : ''));
  // 源码里引用的每个 onboarding.wizard.* 静态键都必须可解析(动态拼接的键单独枚举)。
  const referenced = new Set([...moduleSrc.matchAll(/'(onboarding\.wizard\.[A-Za-z0-9_.-]+)'/g)].map(m => m[1]));
  for (const mode of mod.ONBOARDING_SAFETY_MODES) { referenced.add('onboarding.wizard.safety.' + mode + '.title'); referenced.add('onboarding.wizard.safety.' + mode + '.description'); }
  for (const id of mod.ONBOARDING_PLAYBOOK_IDS) { referenced.add('onboarding.wizard.done.playbook.' + id); referenced.add('onboarding.wizard.done.playbookHint.' + id); }
  for (const code of ['keyEmpty', 'keyWhitespace', 'keyMasked', 'keyTooShort', 'keyTooLong', 'keyPrefixWarning', 'urlEmpty', 'urlSpace', 'urlScheme']) referenced.add('onboarding.wizard.validate.' + code);
  for (const id of mod.ONBOARDING_STEP_IDS) referenced.add('onboarding.wizard.step.' + id);
  // 剥掉字符串拼接前缀（如 'onboarding.wizard.validate.' + code），只校完整键。
  const unresolved = [...referenced].filter(key => !key.endsWith('.')).filter(key => typeof zh[key] !== 'string');
  // 118a-fix: 阅读器文案键四文件齐;退役的复制路径键必须从四个文件里一起消失。
  const helpDocKeys = [...new Set([...helpViewerSrc.matchAll(/'(help\.doc\.[A-Za-z0-9_.-]+)'/g)].map(m => m[1]))]
    .filter(key => !key.endsWith('.'))
    .concat(['help.doc.open', 'help.doc.lang.zh-CN', 'help.doc.lang.en-US']);
  const helpMissing = helpDocKeys.filter(key => typeof zh[key] !== 'string' || typeof en[key] !== 'string'
    || docsZh[key] !== zh[key] || docsEn[key] !== en[key]);
  ok(helpMissing.length === 0, 'H4 help.doc.* 文案键四文件齐'
    + (helpMissing.length ? ' (缺: ' + helpMissing.slice(0, 3).join(', ') + ')' : ''));
  const retired = ['onboarding.wizard.done.copyPath', 'onboarding.wizard.done.copied', 'onboarding.wizard.done.copyFailed'];
  const stillThere = retired.filter(key => key in zh || key in en || key in docsZh || key in docsEn);
  ok(stillThere.length === 0, 'H5 复制路径相关文案键已从四个 locale 文件里删除'
    + (stillThere.length ? ' (残留: ' + stillThere.join(', ') + ')' : ''));
  ok(!/复制/.test(zh['onboarding.wizard.done.manualHint'] || '') && !/copy/i.test(en['onboarding.wizard.done.manualHint'] || ''),
    'H6 完成页手册提示语不再教用户复制路径');

  ok(unresolved.length === 0, 'H3 模块引用的每个向导文案键都能解析' + (unresolved.length ? ' (缺: ' + unresolved.join(', ') + ')' : ''));

  console.log('\nONBOARDING STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('ONBOARDING STATIC E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
