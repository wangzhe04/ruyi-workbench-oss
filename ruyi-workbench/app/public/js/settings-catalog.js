// 设置补全目录（用户 2026-10-01：「把所有能配置的都放进设置页，且要美观」）。
//
// 修前约 70 个用户可配的 config 键在设置弹窗里没有任何控件，只能手改 config.json —— 其中有几条的提示词与管家文案
// 还明说「只能用户到设置面板改」（allowCommandTools／allowDesktopTools／includeWorkbenchMcp），面板里却没有。
// 本模块是这些键的【唯一】登记处：一行一个键（标签、说明、取值范围、显示单位、挂在哪个页签哪一段），
// 渲染、回填、写盘全部从这张表推出来，不再逐个手抄 HTML 与补丁构造器。
//
// 分层：上半是零 DOM 的纯函数（值换算、补丁构造、依赖判定），unit/settings-catalog.test.js 直接 import 钉；
// 下半是 DOM 渲染，由 provider-settings.js 注入 t／saveConfigPartial／保存后钩子，本模块不 import 任何兄弟模块
// （不进依赖环，也不会因为别的模块挂掉而整条 import 失败）。
//
// 钳位口径与服务端 normalizeConfig（app/src/01-config.js）一致；服务端仍会再钳一次，这里钳是为了界面上回显的值
// 就是落盘的值，不让用户看到一个「存了但其实被改掉」的数。

/* ═══════════════ 目录 ═══════════════ */
// field.type：toggle | number | select | text | textarea | lines | allowRules | tierMap
// number 的 scale：落盘值 = 显示值 × scale（分钟→毫秒 60000、秒→毫秒 1000、百分比→比例 0.01）。
// zeroOff：0 表示「不设／关闭」，不受 min 约束（服务端同样把 0 当关闭）。
// dependsOn：{ key, equals } —— 依赖项不满足时控件置灰（不隐藏：用户要看得见「还有这么一项」）。
// path：嵌套键（如 searchBackend.fallbackToBuiltin），写盘时连同父对象的现值一起回传。
const MIN = 60000;
const SEC = 1000;
const PCT = 0.01;

export const SETTINGS_CATALOG = Object.freeze([
  // ── 基础 ──
  {
    id: 'setcatAppearance', tab: 'basic', titleKey: 'settings.catalog.appearance.title',
    fields: [
      { key: 'theme', type: 'select', options: ['system', 'light', 'dark'], optionKeyPrefix: 'settings.catalog.theme.', fallback: 'system' },
    ],
  },
  {
    id: 'setcatInstructions', tab: 'basic', titleKey: 'settings.catalog.instructions.title', hintKey: 'settings.catalog.instructions.hint',
    fields: [
      { key: 'appendSystemPrompt', type: 'textarea', maxLength: 8000, rows: 4, fallback: '' },
    ],
  },
  {
    id: 'setcatStewardRoot', tab: 'basic', titleKey: 'settings.catalog.stewardRoot.title',
    fields: [
      { key: 'stewardWorkspaceRoot', type: 'text', maxLength: 400, fallback: '', placeholderKey: 'settings.catalog.stewardWorkspaceRoot.placeholder' },
    ],
  },
  // ── 权限与安全 ──
  {
    id: 'setcatToolGates', tab: 'security', titleKey: 'settings.catalog.toolGates.title', hintKey: 'settings.catalog.toolGates.hint',
    fields: [
      { key: 'allowCommandTools', type: 'toggle', fallback: true },
      { key: 'allowDesktopTools', type: 'toggle', fallback: true },
    ],
  },
  {
    id: 'setcatAllowRules', tab: 'security', titleKey: 'settings.catalog.allowRules.title', hintKey: 'settings.catalog.allowRules.hint',
    fields: [{ key: 'toolAllowRules', type: 'allowRules' }],
  },
  {
    id: 'setcatTierMap', tab: 'security', titleKey: 'settings.catalog.tierMap.title', hintKey: 'settings.catalog.tierMap.hint',
    fields: [{ key: 'bridgedToolTiers', type: 'tierMap' }],
  },
  {
    id: 'setcatUnattended', tab: 'security', titleKey: 'settings.catalog.unattended.title', hintKey: 'settings.catalog.unattended.hint',
    fields: [
      { key: 'autonomyPauseOnTimeout', type: 'toggle', fallback: false },
      { key: 'autonomyPauseTtlMs', type: 'number', scale: MIN, min: 5, max: 360, unitKey: 'settings.catalog.unit.minutes', fallback: 2700000,
        dependsOn: { key: 'autonomyPauseOnTimeout', equals: true } },
      { key: 'autonomyAutoResume', type: 'toggle', fallback: false },
    ],
  },
  // ── 用量与限额 ──
  {
    id: 'setcatBudgetGuard', tab: 'limits', titleKey: 'settings.catalog.budgetGuard.title', hintKey: 'settings.catalog.budgetGuard.hint',
    fields: [
      { key: 'runtimeBudgetGuardV1', type: 'toggle', fallback: false },
      { key: 'budgetGuardTurnTokensV1', type: 'number', min: 1, max: 10000000, zeroOff: true, step: 1000, unitKey: 'settings.catalog.unit.tokens', fallback: 0,
        dependsOn: { key: 'runtimeBudgetGuardV1', equals: true } },
      { key: 'budgetGuardWarnRatioV1', type: 'number', scale: PCT, min: 10, max: 99, unitKey: 'settings.catalog.unit.percent', fallback: 0.8,
        dependsOn: { key: 'runtimeBudgetGuardV1', equals: true } },
    ],
  },
  {
    id: 'setcatToolTime', tab: 'limits', titleKey: 'settings.catalog.toolTime.title', hintKey: 'settings.catalog.toolTime.hint',
    fields: [
      { key: 'runtimeToolTimeBudgetV1', type: 'toggle', fallback: false },
      { key: 'toolTimeBudgetWarnMsV1', type: 'number', scale: SEC, min: 1, max: 3600, zeroOff: true, unitKey: 'settings.catalog.unit.seconds', fallback: 0,
        dependsOn: { key: 'runtimeToolTimeBudgetV1', equals: true } },
      { key: 'toolTimeBudgetHardMsV1', type: 'number', scale: SEC, min: 5, max: 7200, zeroOff: true, unitKey: 'settings.catalog.unit.seconds', fallback: 0,
        dependsOn: { key: 'runtimeToolTimeBudgetV1', equals: true } },
    ],
  },
  {
    id: 'setcatContext', tab: 'limits', titleKey: 'settings.catalog.context.title',
    fields: [
      { key: 'autoCompactThreshold', type: 'number', scale: PCT, min: 50, max: 95, unitKey: 'settings.catalog.unit.percent', fallback: 0.8 },
      { key: 'shellSessionMax', type: 'number', min: 1, max: 8, fallback: 3 },
    ],
  },
  {
    id: 'setcatTaskPool', tab: 'limits', titleKey: 'settings.catalog.taskPool.title', hintKey: 'settings.catalog.taskPool.hint',
    fields: [
      { key: 'agentTaskPoolPolicy', type: 'select', options: ['manual', 'auto-capped', 'off'], optionKeyPrefix: 'settings.catalog.taskPool.', fallback: 'manual' },
      { key: 'agentTaskPoolAutoCap', type: 'number', min: 0, max: 16, fallback: 3, dependsOn: { key: 'agentTaskPoolPolicy', equals: 'auto-capped' } },
      { key: 'agentAutoModelTiering', type: 'toggle', fallback: false },
    ],
  },
  {
    id: 'setcatMemoryCap', tab: 'limits', titleKey: 'settings.catalog.memoryCap.title', hintKey: 'settings.catalog.memoryCap.hint', fold: true,
    fields: [
      { key: 'memoryRelevanceMaxV1', type: 'number', min: 0, max: 64, fallback: 8 },
      { key: 'coreMemoryMaxItemsV1', type: 'number', min: 0, max: 2000, fallback: 200 },
      { key: 'coreMemoryCharBudgetV1', type: 'number', min: 0, max: 200000, step: 1000, unitKey: 'settings.catalog.unit.chars', fallback: 16000 },
      { key: 'memoryFixedSelectionMaxV1', type: 'number', min: 1, max: 1024, fallback: 64 },
      { key: 'memoryIndexCharCapV1', type: 'number', min: 500, max: 100000, step: 500, unitKey: 'settings.catalog.unit.chars', fallback: 6000 },
    ],
  },
  // ── 管家 ──
  {
    id: 'setcatScheduler', tab: 'steward', titleKey: 'settings.catalog.scheduler.title', hintKey: 'settings.catalog.scheduler.hint',
    fields: [
      { key: 'schedulerEnabledV1', type: 'toggle', fallback: true },
      { key: 'schedulerAskWaitMinutes', type: 'number', min: 1, max: 240, unitKey: 'settings.catalog.unit.minutes', fallback: 30,
        dependsOn: { key: 'schedulerEnabledV1', equals: true } },
    ],
  },
  {
    id: 'setcatStewardPace', tab: 'steward', titleKey: 'settings.catalog.stewardPace.title',
    fields: [
      { key: 'stewardNotifyPerHour', type: 'number', min: 1, max: 60, unitKey: 'settings.catalog.unit.perHour', fallback: 6 },
      { key: 'stewardReadBudgetChars', type: 'number', min: 4000, max: 400000, step: 1000, unitKey: 'settings.catalog.unit.chars', fallback: 48000 },
    ],
  },
  // ── Agent CLI ──
  {
    id: 'setcatCliDirs', tab: 'claude', titleKey: 'settings.catalog.cliDirs.title', hintKey: 'settings.catalog.cliDirs.hint',
    fields: [{ key: 'additionalDirectories', type: 'lines', maxItems: 20, rows: 3, fallback: [] }],
  },
  // ── 联网搜索 ──
  {
    id: 'setcatNetworkExtra', tab: 'network', titleKey: 'settings.catalog.networkExtra.title',
    fields: [
      { key: 'searchBackend.fallbackToBuiltin', path: ['searchBackend', 'fallbackToBuiltin'], type: 'toggle', fallback: false },
      { key: 'capabilityProbeUrl', type: 'text', maxLength: 400, fallback: '', placeholderKey: 'settings.catalog.capabilityProbeUrl.placeholder' },
    ],
  },
  // ── 集成与 MCP ──
  {
    id: 'setcatMcpExtra', tab: 'integrations', titleKey: 'settings.catalog.mcpExtra.title', before: 'toolboxSettingsHost',
    fields: [
      { key: 'includeWorkbenchMcp', type: 'toggle', fallback: true },
      { key: 'enableMcpDropIn', type: 'toggle', fallback: true },
      { key: 'toolCatalogCacheTtlMs', type: 'number', scale: SEC, min: 5, max: 600, unitKey: 'settings.catalog.unit.seconds', fallback: 60000 },
    ],
  },
  // ── 高级 ──
  {
    id: 'setcatDiagnostics', tab: 'advanced', titleKey: 'settings.catalog.diagnostics.title',
    fields: [
      { key: 'monitorIncremental', type: 'toggle', fallback: true },
      { key: 'sessionSearchIndexV1', type: 'toggle', fallback: true },
      { key: 'runtimeMemoryVectorRecallV1', type: 'toggle', fallback: true },
    ],
  },
  {
    id: 'setcatExperiments', tab: 'advanced', titleKey: 'settings.catalog.experiments.title', hintKey: 'settings.catalog.experiments.hint', fold: true,
    fields: [
      { key: 'runtimeSummarySingleShotV1', type: 'toggle', fallback: true },
      { key: 'runtimeSummaryFactTableV1', type: 'toggle', fallback: true },
      { key: 'summaryFactTableMaxSamplesV1', type: 'number', min: 4, max: 64, fallback: 64, dependsOn: { key: 'runtimeSummaryFactTableV1', equals: true } },
      { key: 'runtimeSummaryRefineV1', type: 'toggle', fallback: false },
      { key: 'runtimeSummaryEntityCheckV1', type: 'toggle', fallback: true },
      { key: 'runtimeSummaryPromptI18nV1', type: 'toggle', fallback: true },
      { key: 'runtimeSessionNotesV1', type: 'toggle', fallback: true },
      { key: 'runtimeSessionNotesInjectV1', type: 'toggle', fallback: true, dependsOn: { key: 'runtimeSessionNotesV1', equals: true } },
      { key: 'runtimeSessionNotesMergeV1', type: 'toggle', fallback: true, dependsOn: { key: 'runtimeSessionNotesV1', equals: true } },
      { key: 'runtimeObservationReducerV1', type: 'toggle', fallback: true },
      { key: 'runtimeObservationRecallV1', type: 'toggle', fallback: true },
      { key: 'runtimeHistoryReadDedupV1', type: 'toggle', fallback: true },
      { key: 'runtimeReseedTailUnitsV1', type: 'toggle', fallback: true },
      { key: 'runtimeReseedReattachFilesV1', type: 'toggle', fallback: false },
      { key: 'runtimeEvaporateBudgetBoundaryV1', type: 'toggle', fallback: false },
      { key: 'runtimeEstimateBucketsV1', type: 'toggle', fallback: true },
      { key: 'runtimeToolRetrievalV1', type: 'toggle', fallback: false },
      { key: 'runtimeAppendOnlyToolSchemasV1', type: 'toggle', fallback: true },
      { key: 'runtimeVolatileTailLayoutV1', type: 'toggle', fallback: false },
      { key: 'runtimeExecResultCacheV1', type: 'toggle', fallback: true },
      { key: 'execResultCacheMaxEntriesV1', type: 'number', min: 0, max: 2000, fallback: 200, dependsOn: { key: 'runtimeExecResultCacheV1', equals: true } },
      { key: 'boundedReadSchedulerV1', type: 'toggle', fallback: false },
      { key: 'boundedReadConcurrencyV1', type: 'number', min: 1, max: 8, fallback: 4, dependsOn: { key: 'boundedReadSchedulerV1', equals: true } },
      { key: 'metaToolHintsV1', type: 'toggle', fallback: false },
      { key: 'actionArgumentModelViewV1', type: 'toggle', fallback: false },
    ],
  },
  {
    id: 'setcatObservability', tab: 'advanced', titleKey: 'settings.catalog.observability.title', hintKey: 'settings.catalog.observability.hint', fold: true,
    fields: [
      { key: 'runtimeOptimizationShadowV1', type: 'toggle', fallback: true },
      { key: 'toolEconomicsShadowV1', type: 'toggle', fallback: true },
      { key: 'runtimeFailureTelemetryV1', type: 'toggle', fallback: false },
      { key: 'runtimeToolTimeBudgetShadowV1', type: 'toggle', fallback: false },
      { key: 'toolByteBudgetShadowBytesV1', type: 'number', scale: 1024 * 1024, min: 0, max: 100, unitKey: 'settings.catalog.unit.mb', fallback: 0 },
    ],
  },
]);

/* ═══════════════ 纯函数层 ═══════════════ */

export function catalogFields() {
  const out = [];
  for (const section of SETTINGS_CATALOG) for (const field of section.fields) out.push({ ...field, section: section.id, tab: section.tab });
  return out;
}

export function catalogFieldId(field) {
  return 'setcat_' + String(field.key).replace(/[^A-Za-z0-9]+/g, '_');
}

export function catalogLabelKey(field) { return `settings.catalog.${field.key}`; }
export function catalogHintKey(field) { return `settings.catalog.${field.key}.hint`; }

function readPath(config, field) {
  const path = field.path || [field.key];
  let node = config;
  for (const part of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

// 落盘值（config 里的）→ 控件上显示的值。
export function catalogDisplayValue(field, config) {
  const raw = readPath(config || {}, field);
  const value = raw === undefined || raw === null ? field.fallback : raw;
  switch (field.type) {
    case 'toggle': return value === true;
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return '';
      const shown = n / (field.scale || 1);
      return String(Math.round(shown * 100) / 100);
    }
    case 'select': return (field.options || []).includes(value) ? value : field.fallback;
    case 'lines': return Array.isArray(value) ? value.join('\n') : '';
    case 'text':
    case 'textarea': return typeof value === 'string' ? value : '';
    default: return value;
  }
}

// 控件上的值 → 落盘值；返回 undefined 表示「这次输入无效，不写盘、回显旧值」。
export function catalogStoredValue(field, input) {
  switch (field.type) {
    case 'toggle': return input === true;
    case 'number': {
      const text = String(input === undefined || input === null ? '' : input).trim();
      if (text === '') return undefined;
      const n = Number(text);
      if (!Number.isFinite(n)) return undefined;
      if (field.zeroOff && n <= 0) return 0;
      const clamped = Math.min(field.max, Math.max(field.min, n));
      const stored = clamped * (field.scale || 1);
      return field.scale && field.scale < 1 ? Math.round(stored * 100) / 100 : Math.round(stored);
    }
    case 'select': return (field.options || []).includes(input) ? input : field.fallback;
    case 'lines': {
      const items = String(input || '').split('\n').map(s => s.trim()).filter(Boolean);
      return [...new Set(items)].slice(0, field.maxItems || 50);
    }
    case 'text':
    case 'textarea': return String(input || '').trim().slice(0, field.maxLength || 4000);
    default: return input;
  }
}

// 一次写盘的补丁。嵌套键连同父对象现值一起回传（POST /api/config 是顶层浅合并，只送子键会把兄弟字段冲掉）。
export function catalogPatch(field, stored, config) {
  if (!field.path || field.path.length < 2) return { [field.key]: stored };
  const [parent, child] = field.path;
  const current = config && config[parent] && typeof config[parent] === 'object' ? config[parent] : {};
  return { [parent]: { ...current, [child]: stored } };
}

export function catalogDependencyMet(field, config) {
  if (!field.dependsOn) return true;
  const dep = catalogFields().find(f => f.key === field.dependsOn.key);
  const value = dep ? catalogDisplayValue(dep, config) : (config || {})[field.dependsOn.key];
  return value === field.dependsOn.equals;
}

/* ═══════════════ DOM 层 ═══════════════ */

const TIERS = ['read', 'edit', 'exec'];

function make(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function renderValueControl(doc, field, t) {
  const id = catalogFieldId(field);
  switch (field.type) {
    case 'toggle': {
      const input = make(doc, 'input', 'setcat-switch');
      input.type = 'checkbox';
      input.id = id;
      input.setAttribute('role', 'switch');
      return input;
    }
    case 'number': {
      const wrap = make(doc, 'div', 'setcat-number');
      const input = make(doc, 'input');
      input.type = 'number';
      input.id = id;
      input.min = String(field.zeroOff ? 0 : field.min);
      input.max = String(field.max);
      input.step = String(field.step || (field.scale && field.scale < 1 ? 1 : 1));
      input.inputMode = 'numeric';
      wrap.appendChild(input);
      if (field.unitKey) wrap.appendChild(make(doc, 'span', 'setcat-unit', t(field.unitKey)));
      return wrap;
    }
    case 'select': {
      const select = make(doc, 'select');
      select.id = id;
      for (const value of field.options) {
        const option = make(doc, 'option', '', t(`${field.optionKeyPrefix}${value}`));
        option.value = value;
        select.appendChild(option);
      }
      return select;
    }
    case 'text': {
      const input = make(doc, 'input');
      input.type = 'text';
      input.id = id;
      input.maxLength = field.maxLength || 400;
      input.spellcheck = false;
      if (field.placeholderKey) input.placeholder = t(field.placeholderKey);
      return input;
    }
    case 'textarea':
    case 'lines': {
      const area = make(doc, 'textarea');
      area.id = id;
      area.rows = field.rows || 3;
      area.spellcheck = false;
      if (field.maxLength) area.maxLength = field.maxLength;
      return area;
    }
    default: return null;
  }
}

function renderRow(doc, field, t) {
  const wide = field.type === 'textarea' || field.type === 'lines' || field.type === 'text';
  const row = make(doc, 'div', 'setcat-row' + (wide ? ' setcat-row-wide' : ''));
  row.dataset.key = field.key;
  const text = make(doc, 'div', 'setcat-text');
  const label = make(doc, 'label', 'setcat-label', t(catalogLabelKey(field)));
  label.htmlFor = catalogFieldId(field);
  text.appendChild(label);
  text.appendChild(make(doc, 'p', 'setcat-hint', t(catalogHintKey(field))));   // 每一项都有一句说明（unit/settings-catalog.test.js 钉两份语言都齐）
  row.appendChild(text);
  const control = renderValueControl(doc, field, t);
  if (control) {
    const cell = make(doc, 'div', 'setcat-control');
    cell.appendChild(control);
    row.appendChild(cell);
  }
  return row;
}

function renderSection(doc, section, t) {
  const node = make(doc, 'section', 'settings-section setcat-section');
  node.id = section.id;
  node.dataset.catalog = section.tab;
  const headingId = `${section.id}Heading`;
  node.setAttribute('aria-labelledby', headingId);
  const heading = make(doc, 'h4', 'settings-subhead', t(section.titleKey));
  heading.id = headingId;
  let body = node;
  if (section.fold) {
    const fold = make(doc, 'details', 'settings-fold setcat-fold');
    const summary = make(doc, 'summary');
    summary.appendChild(heading);
    fold.appendChild(summary);
    node.appendChild(fold);
    body = fold;
  } else {
    node.appendChild(heading);
  }
  if (section.hintKey) body.appendChild(make(doc, 'p', 'muted prov-hint', t(section.hintKey)));
  const list = make(doc, 'div', 'setcat-list');
  for (const field of section.fields) {
    if (field.type === 'allowRules' || field.type === 'tierMap') {
      const host = make(doc, 'div', 'setcat-map');
      host.id = catalogFieldId(field);
      host.dataset.key = field.key;
      list.appendChild(host);
    } else {
      list.appendChild(renderRow(doc, { ...field, tab: section.tab }, t));
    }
  }
  body.appendChild(list);
  return node;
}

// 把目录里每一段挂进对应页签（已挂过的跳过 —— fillSettings 会反复调用）。返回新挂上的段数。
export function mountSettingsCatalog({ doc = document, t, onSave }) {
  let mounted = 0;
  for (const section of SETTINGS_CATALOG) {
    if (doc.getElementById(section.id)) continue;
    const panel = doc.getElementById(`stab-${section.tab}`);
    if (!panel) continue;
    const node = renderSection(doc, section, t);
    const anchor = section.before ? doc.getElementById(section.before) : null;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor);
    else panel.appendChild(node);
    for (const field of section.fields) wireField(doc, field, onSave);
    mounted += 1;
  }
  return mounted;
}

function wireField(doc, field, onSave) {
  if (field.type === 'allowRules' || field.type === 'tierMap') return;   // 这两种在 fill 时整块重画、按钮各自接线
  const node = doc.getElementById(catalogFieldId(field));
  if (!node) return;
  node.addEventListener('change', () => {
    const input = field.type === 'toggle' ? node.checked : node.value;
    const stored = catalogStoredValue(field, input);
    void onSave(field, stored);
  });
}

// 回填：按 config 写每个控件的值与置灰态；正在打字的那一格不动。
export function fillSettingsCatalog({ doc = document, t, config, onSave }) {
  const focused = doc.activeElement;
  for (const field of catalogFields()) {
    if (field.type === 'allowRules') { renderAllowRules(doc, field, t, config, onSave); continue; }
    if (field.type === 'tierMap') { renderTierMap(doc, field, t, config, onSave); continue; }
    const node = doc.getElementById(catalogFieldId(field));
    if (!node) continue;
    const met = catalogDependencyMet(field, config);
    node.disabled = !met;
    const row = node.closest ? node.closest('.setcat-row') : null;
    if (row) row.classList.toggle('is-off', !met);
    if (node === focused && field.type !== 'toggle') continue;
    const shown = catalogDisplayValue(field, config);
    if (field.type === 'toggle') node.checked = shown === true;
    else node.value = shown;
  }
}

function emptyNote(doc, text) {
  return make(doc, 'p', 'setcat-empty muted', text);
}

function renderAllowRules(doc, field, t, config, onSave) {
  const host = doc.getElementById(catalogFieldId(field));
  if (!host) return;
  const rules = (config && config.toolAllowRules && typeof config.toolAllowRules === 'object') ? config.toolAllowRules : {};
  const names = Object.keys(rules).filter(name => rules[name] === 'allow').sort();
  host.replaceChildren();
  if (!names.length) { host.appendChild(emptyNote(doc, t('settings.catalog.allowRules.empty'))); return; }
  const list = make(doc, 'ul', 'setcat-chips');
  for (const name of names) {
    const item = make(doc, 'li', 'setcat-chip');
    item.appendChild(make(doc, 'code', '', name));
    const revoke = make(doc, 'button', 'setcat-chip-btn', t('settings.catalog.allowRules.revoke'));
    revoke.type = 'button';
    revoke.dataset.tool = name;
    revoke.setAttribute('aria-label', t('settings.catalog.allowRules.revokeLabel', { tool: name }));
    revoke.addEventListener('click', () => {
      const next = { ...rules };
      delete next[name];
      void onSave(field, next);
    });
    item.appendChild(revoke);
    list.appendChild(item);
  }
  host.appendChild(list);
}

function tierSelect(doc, t, value) {
  const select = make(doc, 'select', 'setcat-tier');
  for (const tier of TIERS) {
    const option = make(doc, 'option', '', t(`settings.catalog.tier.${tier}`));
    option.value = tier;
    select.appendChild(option);
  }
  select.value = TIERS.includes(value) ? value : 'exec';
  return select;
}

function renderTierMap(doc, field, t, config, onSave) {
  const host = doc.getElementById(catalogFieldId(field));
  if (!host) return;
  // 新增行正在填写时不重画（重画会把输入框里的工具名冲掉）。
  if (host.contains(doc.activeElement) && doc.activeElement && doc.activeElement.classList.contains('setcat-tier-name')) return;
  const tiers = (config && config.bridgedToolTiers && typeof config.bridgedToolTiers === 'object') ? config.bridgedToolTiers : {};
  const names = Object.keys(tiers).sort();
  host.replaceChildren();
  if (!names.length) host.appendChild(emptyNote(doc, t('settings.catalog.tierMap.empty')));
  else {
    const list = make(doc, 'ul', 'setcat-tier-list');
    for (const name of names) {
      const item = make(doc, 'li', 'setcat-tier-row');
      item.appendChild(make(doc, 'code', 'setcat-tier-tool', name));
      const select = tierSelect(doc, t, tiers[name]);
      select.setAttribute('aria-label', t('settings.catalog.tierMap.tierLabel', { tool: name }));
      select.addEventListener('change', () => { void onSave(field, { ...tiers, [name]: select.value }); });
      item.appendChild(select);
      const remove = make(doc, 'button', 'setcat-chip-btn', t('settings.catalog.tierMap.remove'));
      remove.type = 'button';
      remove.addEventListener('click', () => {
        const next = { ...tiers };
        delete next[name];
        void onSave(field, next);
      });
      item.appendChild(remove);
      list.appendChild(item);
    }
    host.appendChild(list);
  }
  const add = make(doc, 'div', 'setcat-tier-add');
  const nameInput = make(doc, 'input', 'setcat-tier-name');
  nameInput.type = 'text';
  nameInput.spellcheck = false;
  nameInput.placeholder = t('settings.catalog.tierMap.namePlaceholder');
  nameInput.setAttribute('aria-label', t('settings.catalog.tierMap.namePlaceholder'));
  const select = tierSelect(doc, t, 'read');
  const button = make(doc, 'button', 'btn btn-sm', t('settings.catalog.tierMap.add'));
  button.type = 'button';
  button.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    nameInput.value = '';
    void onSave(field, { ...tiers, [name]: select.value });
  });
  add.append(nameInput, select, button);
  host.appendChild(add);
}
