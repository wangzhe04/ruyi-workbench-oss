const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en-US']);
const FALLBACK_LOCALE = 'zh-CN';
const catalogs = new Map();
const missingKeys = new Set();
let activeLocale = FALLBACK_LOCALE;

export function normalizeLocale(value) {
  const locale = String(value || '').replace(/_/g, '-');
  if (SUPPORTED_LOCALES.includes(locale)) return locale;
  const language = locale.toLowerCase().split('-')[0];
  if (language === 'en') return 'en-US';
  if (language === 'zh') return 'zh-CN';
  return FALLBACK_LOCALE;
}

export function detectLocale(languages = globalThis.navigator?.languages || [globalThis.navigator?.language]) {
  for (const language of languages || []) {
    const normalized = normalizeLocale(language);
    if (String(language || '').toLowerCase().startsWith('en')) return normalized;
    if (String(language || '').toLowerCase().startsWith('zh')) return normalized;
  }
  return FALLBACK_LOCALE;
}

export function interpolate(template, params = {}) {
  return String(template).replace(/{{\s*([\w.-]+)\s*}}/g, (match, key) => {
    const value = params[key];
    return value == null ? match : String(value);
  });
}

const PSEUDO_CHARACTERS = Object.freeze({
  A: 'Å', B: 'ß', C: 'Ç', D: 'Ð', E: 'Ë', F: 'Ƒ', G: 'Ğ', H: 'Ħ', I: 'Ï', J: 'Ĵ', K: 'Ķ', L: 'Ŀ', M: 'Ḿ',
  N: 'Ń', O: 'Ø', P: 'Ṕ', Q: 'Ɋ', R: 'Ŕ', S: 'Š', T: 'Ŧ', U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ÿ', Z: 'Ž',
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'ë', f: 'ƒ', g: 'ğ', h: 'ħ', i: 'ï', j: 'ĵ', k: 'ķ', l: 'ŀ', m: 'ḿ',
  n: 'ń', o: 'ø', p: 'ṕ', q: 'ɋ', r: 'ŕ', s: 'š', t: 'ŧ', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ÿ', z: 'ž',
});

// Test-only pseudo locale helper. It exaggerates English length while preserving {{placeholders}},
// making clipping and accidental concatenation visible without introducing a third production locale.
export function pseudoLocalize(value) {
  const source = String(value ?? '');
  const segments = source.split(/({{\s*[\w.-]+\s*}})/g);
  const translated = segments.map(segment => /^{{\s*[\w.-]+\s*}}$/.test(segment)
    ? segment
    : [...segment].map(char => PSEUDO_CHARACTERS[char] || char).join('')).join('');
  const visibleLength = source.replace(/{{\s*[\w.-]+\s*}}/g, '').length;
  return '［' + translated + '~'.repeat(Math.max(2, Math.ceil(visibleLength * 0.3))) + '］';
}

function catalogFor(source, locale) {
  return source instanceof Map ? source.get(locale) : source?.[locale];
}

export function translate(source, locale, key, params = {}) {
  const value = catalogFor(source, locale)?.[key] ?? catalogFor(source, FALLBACK_LOCALE)?.[key];
  return value == null ? undefined : interpolate(value, params);
}

function resolveLocale(value) {
  return value === 'auto' || !value ? detectLocale() : normalizeLocale(value);
}

async function loadCatalog(locale) {
  if (catalogs.has(locale)) return catalogs.get(locale);
  try {
    const response = await fetch(new URL(`../locales/${locale}.json`, import.meta.url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('catalog is not an object');
    catalogs.set(locale, catalog);
    return catalog;
  } catch (error) {
    console.warn(`[i18n] Could not load ${locale}:`, error);
    return null;
  }
}

export function getLocale() {
  return activeLocale;
}

export function t(key, params = {}) {
  const value = translate(catalogs, activeLocale, key, params);
  if (value !== undefined) return value;
  if (!missingKeys.has(key)) {
    missingKeys.add(key);
    console.warn(`[i18n] Missing translation key: ${key}`);
  }
  return `[${key}]`;
}

export function tCount(key, count, params = {}) {
  const category = new Intl.PluralRules(activeLocale).select(Number(count));
  const selectedKey = `${key}.${category}`;
  return translatedValue(selectedKey) !== undefined
    ? t(selectedKey, { ...params, count })
    : t(`${key}.other`, { ...params, count });
}

function translatedValue(key) {
  return translate(catalogs, activeLocale, key);
}

// 「这个键有没有译文」。t() 对缺键回的是可见的 `[key]`（真字符串），所以 `t(k) || fallback` 这种写法永远
// 走不到 fallback —— 按动态值拼键（状态名之类）又要退回原值的地方先问这一句。
export function hasTranslation(key) {
  return translatedValue(key) !== undefined;
}

function applyAttributes(node) {
  for (const part of (node.dataset.i18nAttr || '').split(';')) {
    const [attribute, key] = part.split(':').map(value => value?.trim());
    if (!attribute || !key) continue;
    const value = translatedValue(key);
    if (value !== undefined) node.setAttribute(attribute, value);
  }
}

export function applyTranslations(root = document) {
  const nodes = [];
  if (root.matches?.('[data-i18n], [data-i18n-attr]')) nodes.push(root);
  nodes.push(...root.querySelectorAll?.('[data-i18n], [data-i18n-attr]') || []);
  for (const node of nodes) {
    if (node.dataset.i18n) {
      const value = translatedValue(node.dataset.i18n);
      if (value !== undefined) node.textContent = value;
    }
    if (node.dataset.i18nAttr) applyAttributes(node);
  }
}

// 连着两次 setLocale（开机 initI18n('auto') 与读到配置后的 setLocale(配置值)）时，目录是异步拉的：修前谁的
// 目录后到谁说了算，慢的那一次会把用户刚选的语言盖回去。每次取一个序号，回来时已不是最新那一次就不落地，
// 并把【最新那一次】的结果交给自己的调用方（设置页拿返回值写 config.locale，不能写成被盖掉的旧值）。
let localeSeq = 0;
let localeDispatched = false;   // 至少派过一发 i18n:change 了没有(第一发的 changed 恒为 true)
let latestLocaleRun = null;
export async function setLocale(preferredLocale = 'auto') {
  const seq = ++localeSeq;
  const run = (async () => {
    const target = resolveLocale(preferredLocale);
    await Promise.all([loadCatalog(FALLBACK_LOCALE), target === FALLBACK_LOCALE ? null : loadCatalog(target)]);
    if (seq !== localeSeq) return latestLocaleRun;
    // 性能(前端):detail.changed 告诉监听方语言到底换没换。开机连着两次 setLocale(initI18n('auto') 与读到配置后
    // 的 setLocale(配置值))多半是同一种语言,修前第二发让 app.js 把当前会话整段重画(长会话 ~0.4 s)。第一发恒为 true。
    const previousLocale = localeDispatched ? activeLocale : null;
    activeLocale = catalogs.has(target) ? target : FALLBACK_LOCALE;
    document.documentElement.lang = activeLocale;
    applyTranslations();
    localeDispatched = true;
    window.dispatchEvent(new CustomEvent('i18n:change', { detail: { locale: activeLocale, changed: previousLocale !== activeLocale } }));
    return activeLocale;
  })();
  latestLocaleRun = run;
  return run;
}

export function initI18n(preferredLocale = 'auto') {
  return setLocale(preferredLocale);
}
