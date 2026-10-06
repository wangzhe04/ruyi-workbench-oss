// 如意 Ruyi — client util module (v1.3-FE1 前端模块化 Phase 1)。
//
// 纯搬家:无状态的 DOM / 格式化小工具,从原 app.js 原样搬来。app.js 通过
// `import { $, el, ... } from './js/util.js'` 取回同名绑定,全文件 233×$()/482×el()/95×toast() 等
// 调用点无需改动 —— import 绑定在模块作用域全文件可见,调用时点解析,行为与经典脚本一致。
//
// 依赖:仅浏览器原生 DOM API + 全局 marked/hljs(经典 vendor 脚本先于 module 加载,仍是全局)。
// i18n 为单向依赖：本模块只读取当前 locale，i18n 本身不依赖 util，故无循环。
import { getLocale, t } from './i18n.js';

// 按 id 取元素 / 造元素(全站两大高频 helper)。
export const $ = id => document.getElementById(id);
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// Preserve a keyboard user's place across a synchronous list rebuild. Never move
// focus when they were typing or interacting elsewhere.
export function preserveListFocus(list, fallback) {
  const active = list?.ownerDocument?.activeElement;
  if (!active || !list.contains(active)) return () => {};
  const selector = 'button:not([disabled])';
  const before = [...list.querySelectorAll(selector)];
  const index = Math.max(0, before.indexOf(active));
  const key = active.dataset?.focusKey;
  return () => {
    const after = [...list.querySelectorAll(selector)];
    const target = (key && after.find(node => node.dataset.focusKey === key))
      || after[Math.min(index, after.length - 1)] || fallback;
    target?.focus?.({ preventScroll: true });
  };
}
export const fileBasename = pathValue => {
  const value = String(pathValue || '');
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;
};

// W7(用户 2026-09-24「如意自己开的工作区,默认不显示在常用工作区中」):这个目录是不是如意自己的 ——
// 落在数据目录里(管家会话自己的目录、子代理的临时工作树、上传与临时文件全在那儿),或者是如意为任务
// 开的、用户还没亲手加进常用的(config.stewardManagedWorkspaces 里 adopted !== true 的那些)。
// 判据与服务端 06i 的 stewardRuyiOwnedPath 同一口径:分隔符两种写法都认、不分大小写、前缀按整段比。
const workspaceKey = value => String(value == null ? '' : value).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
// dataRootAliases:/api/status 给的数据根其它写法(改名迁移后旧位置上的联接;改名前存的工作区写的是旧前缀)。
export function isRuyiOwnedWorkspace(pathValue, { dataRoot = '', dataRootAliases = [], owned = [] } = {}) {
  const target = workspaceKey(pathValue);
  if (!target) return false;
  for (const base of [dataRoot, ...(Array.isArray(dataRootAliases) ? dataRootAliases : [])]) {
    const root = workspaceKey(base);
    if (root && (target === root || target.startsWith(root + '/'))) return true;
  }
  return (Array.isArray(owned) ? owned : []).some(row => row && row.adopted !== true && workspaceKey(row.path) === target);
}
// 「常用工作区」该显示哪几行:config.workspaces 去掉如意自己的。只管【显示】—— 保存时仍用整张表
// (调用方负责),否则藏起来的行会在下一次保存时被删掉。
export function visibleFavoriteWorkspaces(rows, ctx) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && String(row.path || '') && !isRuyiOwnedWorkspace(row.path, ctx));
}

// 工作文件夹路径的两个纯判定（原在 workspace-preferences.js，设置页「添加/默认工作文件夹」要同一口径所以搬到这里）。
// v1.0.2 返修:Windows「复制文件地址」会给路径包上双引号("C:\path"),部分终端复制还带单引号/全角引号——
// 先剥掉成对的包裹引号再校验,否则用户按系统习惯复制的路径全被误拒。只剥【成对且在首尾】的引号,不动路径内部。
export function stripWrappingQuotes(p) {
  let s = String(p || '').trim();
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (let guard = 0; guard < 3; guard++) { // 最多剥三层(防 ""C:\x"" 类粘贴),够用且防死循环
    const hit = pairs.find(([a, b]) => s.length >= 2 && s.startsWith(a) && s.endsWith(b));
    if (!hit) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}
export function looksAbsolutePath(p) {
  const s = stripWrappingQuotes(p);
  if (!s) return false;
  // Windows 盘符 (C:\ / C:/) 或 UNC (\\server\share) 或 POSIX 绝对 (/foo)。
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\//.test(s);
}

// HTML 转义(XSS 安全渲染兜底)。
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
}
// 字节数人类可读。
// 进位按【显示出来的那一位小数】判:1048575 B 是 1023.999 KB,toFixed(1) 会印成「1024.0 KB」——取整后够 1024 就升一档(→「1.0 MB」)。
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (unit < units.length - 1 && Number(value.toFixed(1)) >= 1024) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
// CSV 预览用的切分器(RFC 4180 的够用子集):带引号的字段里的逗号/换行不切,"" 是转义的引号;剥掉 UTF-8 BOM
// (Excel 另存的 CSV 开头都有,不剥的话首个表头单元格带一个看不见的 ﻿);末尾的换行不产生空行。
// 最多取 maxRows 行:多出来的只记 truncated:true、不再往后解析——「恰好 maxRows 行」不算截断。
export function parseCsv(text, maxRows = Infinity) {
  let source = String(text == null ? '' : text);
  if (source.charCodeAt(0) === 0xFEFF) source = source.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let truncated = false;
  // 收一行;返回 false 表示已超过 maxRows,调用方停手。
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
    if (rows.length > maxRows) { rows.length = maxRows; truncated = true; return false; }
    return true;
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (source[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      if (!endRow()) return { rows, truncated };
    } else field += ch;
  }
  if (field !== '' || row.length) endRow();
  return { rows, truncated };
}
// ISO 时间 → 当前语言的短格式。
// 每种语言一个格式器(toLocaleString 带 options 每次都新建一个;打开长会话时每行都调)。输出与 toLocaleString 相同。
const fmtTimeFormatters = new Map();
export function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const locale = getLocale();
    if (Number.isNaN(d.getTime())) return d.toLocaleString(getLocale());   // 「Invalid Date」:与修前同一个字符串(format() 会抛)
    let f = fmtTimeFormatters.get(locale);
    if (!f) { f = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }); fmtTimeFormatters.set(locale, f); }
    return f.format(d);
  } catch { return ''; }
}
// token 数人类可读(K/M,尾零裁剪)。ctx-meter 与各处读数共用。
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?';
  // toFixed then trim trailing zeros ONLY after a decimal point (so 150000 -> "150K", not "15K").
  const f = (x, d) => { let s = x.toFixed(d); if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, ''); return s; };
  // 999,500–999,999 按 K 取整会进位成「1000K」：取整后够 1000K 的一律升到 M 档（→「1M」）。
  if (n >= 1e6 || Math.round(n / 1e3) >= 1000) return f(n / 1e6, n >= 1e7 ? 0 : 2) + 'M';
  if (n >= 1e3) return f(n / 1e3, n >= 1e5 ? 0 : 1) + 'K';
  return String(n);
}

// 33 号文 §4:标题/任务名截短的【唯一口径】。按码点数([...text])而不是 UTF-16 码元数 —— 直接
// `s.length > N ? s.slice(0, N) + '…'` 会把代理对(emoji)从中间切开,上屏是一个孤立半字。
// 两个壳共用同一份:线程 chip(2.0 顶栏/3.0 抽屉/看板)与 2.0 的工具卡/子代理卡/工作流节点卡。
// STEWARD_TITLE_MAX=24 是线程 chip 的历史宽度,故默认值留在这里;名字带 steward 前缀是历史,不改。
export const STEWARD_TITLE_MAX = 24;
export function stewardShortTitle(title, max = STEWARD_TITLE_MAX) {
  const text = String(title == null ? '' : title).trim();
  const limit = Number(max) > 0 ? Number(max) : STEWARD_TITLE_MAX;
  return [...text].length > limit ? [...text].slice(0, limit).join('') + '…' : text;
}

// toast 停留时长。普通提示 3.2 s;err 类常带一整句服务端原因(几十到上百字),3.2 s 读不完且 #toastTray 点不到(pointer-events:none,
// 走查 U13:提示条不能挡下面的按钮,所以没有「悬停暂停」),按字数延长:3200 + 80 ms/字,夹在 [6 s, 15 s]。
export function toastDurationMs(msg, kind = '') {
  if (kind !== 'err') return 3200;
  const length = String(msg == null ? '' : msg).length;
  return Math.min(15000, Math.max(6000, 3200 + length * 80));
}
// toast 通知(依赖同文件 el/$;宿主 #toastTray 在 index.html)。kind 只认 ok / err / warn(见 tool-pane.css 的 .toast.*)。
export function toast(msg, kind = '') {
  const t = el('div', `toast ${kind}`, msg);
  $('toastTray').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, toastDurationMs(msg, kind));
}
// 键盘等价(a11y):role="button" 的 div/span 没有原生按钮的 Enter/空格 → click,这里补上。
// 只认事件目标就是本节点(行内嵌的真按钮、输入框冒泡上来的按键不算),空格 preventDefault 防页面跟着滚。
// 触发走 node.click(),所以原有的 onclick/addEventListener('click') 一处不用改。
export function bindKeyboardClick(node) {
  if (!node || typeof node.addEventListener !== 'function') return node;
  node.addEventListener('keydown', event => {
    if (event.target !== node || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
    event.preventDefault();
    node.click();
  });
  return node;
}
// 连接状态行（121-K5，34 号文 §13.7 登记⑦）。
// 121-K4 把 #statusLine 从侧栏底部搬进外框顶栏之后只剩一个 sr-only 的藏身处 —— 理由是「§2.2 末条
// 明令顶栏不印模型名，而往这里写的正是『服务商 · 模型』」。K5 把两件事拆开，节点搬进线程头第二行
// 右端那个【真看得见】的位置：
//   · setStatus(text) —— 给人看的那一句【连接状态】。签名一字未改（app.js 两处调用不动）；
//     可选的 tone 只影响那颗点的颜色，不传就是中性。
//   · setStatusDetail(detail) —— 「服务商 · 模型」「引擎: 可执行文件路径」这类【配置事实】
//     只进 title：悬停与读屏问得到，扫一眼线程头看不到（§2.2 不印模型名、§8.1 第 4 条不印路径）。
export function setStatus(text, tone = '') {
  const node = $('statusLine');
  if (!node) return text;
  node.textContent = text;
  node.dataset.tone = String(tone || '');
  return text;
}
export function setStatusDetail(detail) {
  const node = $('statusLine');
  if (node) node.title = String(detail == null ? '' : detail);
  return detail;
}

// composer 文本域自适应高度(≤260px)。
export function autoGrow(ta) {
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
  watchGrowWidth(ta);
}
// W2-F4：高度是按【当时的宽度】量的。回合进行中输入框被工具键挤窄时，占位符/长句折成很多行，autoGrow 量到的是窄宽下的高度
// （实测停在 144px）；发送后下拉收起、输入框变宽，但没人再量 —— 高度就卡在那，要等下一次 input。
// 所以每个量过的输入框挂一只 ResizeObserver：每次量高度时记下「按多宽量的」，观察者发现宽度与那个记录不同才重量一次
// （高度变化不触发，免得自己喂自己；记在量的那一刻而不是观察到的那一刻，量完立刻又变宽、观察者没来得及看见窄宽的情形也覆盖）。
// 没有 ResizeObserver（单测桩子、旧环境）就什么都不做；元素不可见（宽 0）时不量，显示出来那一下宽度变了，照样会量。
function watchGrowWidth(ta) {
  if (!ta || typeof ta.clientWidth !== 'number') return;
  ta.__ruyiGrowWidth = ta.clientWidth;
  if (ta.__ruyiGrowWatch || typeof ResizeObserver !== 'function') return;
  const observer = new ResizeObserver(() => {
    const width = ta.clientWidth;
    if (width === ta.__ruyiGrowWidth) return;
    ta.__ruyiGrowWidth = width;
    if (!width) return;
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
  });
  try { observer.observe(ta); ta.__ruyiGrowWatch = observer; } catch { /* 观察不了就算了：回到修前行为 */ }
}

// 只做语音的服务商不进【对话】候选（用户 2026-09-21 拍板）。ruyi-toolbox 的本地语音识别组件会被自动接成一个服务商
// （toolbox-<id>），它只有转写接口、没有对话接口：出现在引擎菜单／命令面板／压缩模型／子代理与管家的端点选择里，
// 选中只会换来一个 404；更糟的是新手向导与「取第一个服务商」的兜底会把它当成「已经有对话引擎了」。
// 判据不看 id 前缀（用户自己加一个只放 whisper 的服务商同理）：模型清单非空、且【每一个】模型都带语音识别标记。
// 混用的服务商（百炼那种既有对话模型又标了一个语音模型）不受影响；语音识别自己的选择器另有一套判据，也不受影响。
// 纯函数。住在 util.js 而不是 state.js:管家那几个模块会被静态件在 Node 里直接 import,而 state.js 顶层要 window。
// 133d(真机实拍):asr-stream 组件的流式模型标记是 asr-stream(不是 asr),修前它不算「只做语音」,于是「本地实时语音识别」
// 被列进对话端点候选(基础页主端点、命令面板、压缩器)。两种语音标记都算;服务端 06i stewardChatCapableProvider 同口径。
export function isSpeechOnlyProvider(provider) {
  const models = provider && Array.isArray(provider.models) ? provider.models : [];
  return models.length > 0 && models.every(m => m && typeof m === 'object' && Array.isArray(m.caps) && (m.caps.includes('asr') || m.caps.includes('asr-stream')));
}
export function chatProviders(config) {
  const providers = config && Array.isArray(config.providers) ? config.providers : [];
  return providers.filter(p => p && !isSpeechOnlyProvider(p));
}

// U14 走查：Provider/Claude 端点预设的 label 是后端 05-claude-engine.js 里的字面量（不过 i18n
// 管线），其中几条带中文描述（"自定义 (OpenAI 兼容 / 内网自建)"／本机模型这几处）
// 在 en-US 下仍会照原样露出。不改后端（硬约束：app/src 之外也不轻易碰它），前端按 preset id 查一份
// 可选的翻译键（provider.preset.<id>.label / claudeEndpoint.preset.<id>.label），命中就替换显示，
// 查不到（没有对应翻译键）就照旧显示服务端给的 label。
// provider-settings.js 与 onboarding-wizard.js 的预设卡片/下拉共用同一份查法。
function camelizePresetId(id) {
  return String(id || '').replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
}
export function presetDisplayLabel(namespace, preset) {
  if (!preset) return '';
  const key = `${namespace}.preset.${camelizePresetId(preset.id)}.label`;
  const translated = t(key);
  return translated === `[${key}]` ? (preset.label || preset.id) : translated;
}

// 内置多智能体工作流模板(08-agent-runs.js 的 BUILTIN_AGENT_WORKFLOWS)的 title/description 是后端
// 字面量中文,不过 i18n 管线,en-US 下原样露出。同 presetDisplayLabel 的查法:只对 tpl.builtin===true
// 的模板按 id 查一份可选翻译键(agentWorkflow.template.<id>.title/.description),查不到就照旧显示服务端
// 给的字符串——个人/项目自建的工作流(source 非 builtin,哪怕 id 恰好撞了内置模板的 id)永远走服务端原文,
// 不会被这份翻译表意外接管。agent-workflows.js 的模板选择器、快速运行弹层、toast 与编辑器载入共用同一份查法。
export function workflowTemplateLabel(tpl) {
  if (!tpl) return { title: '', description: '' };
  if (!tpl.builtin) return { title: tpl.title || tpl.id || '', description: tpl.description || '' };
  const titleKey = `agentWorkflow.template.${tpl.id}.title`;
  const descKey = `agentWorkflow.template.${tpl.id}.description`;
  const translatedTitle = t(titleKey);
  const translatedDesc = t(descKey);
  return {
    title: translatedTitle === `[${titleKey}]` ? (tpl.title || tpl.id || '') : translatedTitle,
    description: translatedDesc === `[${descKey}]` ? (tpl.description || '') : translatedDesc,
  };
}

// W6 设置重组：键序无关的 JSON（两份配置「是不是同一个值」只看内容，不看服务端与浏览器谁先写了哪个键）。
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

// W6（设置重组，修「草稿过期会回滚」）：服务商卡片的草稿与别处写口的三方合并。纯函数，不改入参。
//   base  = 草稿上一次与配置对齐时的那份 providers；draft = 用户正在编辑的那份；next = 配置的最新值。
// 逐条服务商、逐个字段：用户没动过的字段（draft 与 base 一样）跟着 next 走，动过的留用户的 —— 线程头「设为新任务
// 默认」、推理强度、删模型行、管家改配置这些写口改掉的字段，不会再被一份旧草稿整份盖回去。
//   · 草稿里新加的（base 没有）原样保留；草稿里删掉的（base 有、draft 没有）不再补回来；
//   · 别处删掉的（base 有、next 没有）：用户没动过就跟着删，动过就留着（以用户手上的为准）；
//   · 别处新加的（base 与 draft 都没有）补在末尾；
//   · serverOwned(p) 为真的条目（toolbox- 自动接入的）一律照 next，用户改不了、也撤不掉。
// 返回 { providers, changed }：changed = 合出来的与 draft 不是同一个值。
export function rebaseProvidersDraft(base, draft, next, { serverOwned = () => false } = {}) {
  const list = value => (Array.isArray(value) ? value : []);
  const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const same = (a, b) => canonicalJson(a) === canonicalJson(b);
  const byId = value => new Map(list(value).filter(p => p && typeof p === 'object' && p.id).map(p => [String(p.id), p]));
  const baseById = byId(base);
  const nextById = byId(next);
  const out = [];
  const seen = new Set();
  for (const item of list(draft)) {
    if (!item || typeof item !== 'object' || !item.id) { out.push(clone(item)); continue; }
    const id = String(item.id);
    seen.add(id);
    const fresh = nextById.get(id);
    const was = baseById.get(id);
    if (serverOwned(item)) { if (fresh) out.push(clone(fresh)); continue; }
    if (!was) { out.push(clone(item)); continue; }
    if (!fresh) { if (!same(item, was)) out.push(clone(item)); continue; }
    const merged = {};
    for (const key of new Set([...Object.keys(was), ...Object.keys(item), ...Object.keys(fresh)])) {
      const pick = same(item[key], was[key]) ? fresh[key] : item[key];
      if (pick !== undefined) merged[key] = clone(pick);
    }
    out.push(merged);
  }
  for (const [id, fresh] of nextById) {
    if (seen.has(id)) continue;
    if (baseById.has(id) && !serverOwned(fresh)) continue;
    out.push(clone(fresh));
  }
  return { providers: out, changed: !same(out, draft) };
}

// 体验走查 #12:线程头下面那一行。专业模式照旧印整条工作目录;普通模式只说「在「文件夹名」里干活」——
// 整条路径（常常是一长串临时目录）对非程序员是噪声,留在悬停提示里,要看的人一指就有。
export function paintSessionMeta(node, session) {
  if (!node) return;
  const cwd = session && typeof session.cwd === 'string' ? session.cwd : '';
  const plain = document.documentElement.getAttribute('data-ui-mode') === 'simple';
  const name = cwd ? fileBasename(cwd.replace(/[\\/]+$/, '')) : '';
  node.textContent = plain && name ? t('session.meta.folder', { name }) : cwd;
  node.title = cwd;
}
