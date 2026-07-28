'use strict';

// EC-D 第61波：成本/用量看板领域（缓存、范围筛选、聚合与 SVG 图表）。
import { api } from './net.js';
import { $, el, fmtTokens, toast } from './util.js';
import { getLocale, t } from './i18n.js';

export function createUsageDashboardDomain({
  apiErrText = error => String(error && error.message || error || ''),
  openSession = async () => {},
} = {}) {
/* ============================================================
   成本 / 用量看板（前端面板 + 手绘 SVG 图表）。数据来自只读端点
   GET /api/usage/summary?range=today|week|month|all（默认 month），
   经 api() 带 token 拉取。所有不可信内容一律 el()/textContent 渲染，
   SVG 数值自算 round，绝不 innerHTML 拼接。成本按币种分组（不换算），
   措辞用「约/估算」（非实际扣费）；第三方 Coding Plan（planBased/
   costTrusted=false）只显 token 消耗 + 来源，不伪造金额。
   ============================================================ */
const usageState = { loaded: false, range: 'month', data: null };
// 币种符号 + 排序权重（¥ 在前，与需求示例「¥1.80 · $0.42」一致）。未知币种回退为「CODE 」前缀。
const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: 'JP¥', HKD: 'HK$', TWD: 'NT$', KRW: '₩' };
const CURRENCY_ORDER = { CNY: 0, USD: 1, EUR: 2, GBP: 3, JPY: 4 };
// 数值小工具：整数千分位、金额（round 到合理精度，避免 0.30000004）、SVG 坐标两位小数。
function fmtInt(n) { return (Number(n) || 0).toLocaleString(getLocale()); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function fmtMoney(amount, currency) {
  const n = Number(amount) || 0;
  const sym = CURRENCY_SYMBOL[currency] || (currency ? currency + ' ' : '');
  // <1 的小额保留至多 4 位有效小数（如 $0.0032），其余 2 位；toLocaleString 负责千分位与裁尾零。
  const maxFrac = (n !== 0 && Math.abs(n) < 1) ? 4 : 2;
  return sym + n.toLocaleString(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: maxFrac });
}
// costsByCurrency({USD:0.42,CNY:1.8}) → 「约 ¥1.80 · 约 $0.42」。空/全 0 → ''。prefix 用于「约 」前缀。
function fmtCostsByCurrency(costs, prefix) {
  const entries = Object.entries(costs || {}).filter(([, v]) => Number(v) > 0);
  if (!entries.length) return '';
  entries.sort((a, b) => ((CURRENCY_ORDER[a[0]] ?? 9) - (CURRENCY_ORDER[b[0]] ?? 9)) || (a[0] < b[0] ? -1 : 1));
  return entries.map(([cur, v]) => (prefix || '') + fmtMoney(v, cur)).join(' · ');
}
// 诚实渲染判定：后端可能给 planBased(true)=第三方计划内计费，或 costTrusted(false)=成本不可当真实金额。
// 二者任一命中即视为「计划内 / 成本不可信」——只显 token，不显伪造金额。
function entryPlanBased(e) { return !!(e && (e.planBased === true || e.costTrusted === false)); }
function engineDisplayName(engine) { return engine === 'claude' ? 'Claude' : engine === 'openai' ? t('chat.providerNative') : (engine || t('common.other')); }

async function loadUsage(force) {
  const host = $('usagePanel'); if (!host) return;
  const range = usageState.range || 'month';
  host.setAttribute('aria-busy', 'true');
  if (force || !usageState.data) { host.textContent = ''; host.appendChild(usageNoticeCard(t('usage.loading'))); }
  try {
    const r = await api(`/api/usage/summary?range=${encodeURIComponent(range)}`);
    // 29c: 运营指标(干预/预算超支率)随用量面板一并拉,失败静默(纯附加信息,不阻断用量展示)。
    r.opsMetrics = await api('/api/ops/metrics?days=7').catch(() => null);
    usageState.data = r; usageState.loaded = true;
    renderUsage(r);
  } catch (e) {
    usageState.loaded = true; usageState.data = null;
    host.textContent = ''; host.appendChild(usageNoticeCard(t('usage.loadFailed', { reason: apiErrText(e) })));
  } finally { host.removeAttribute('aria-busy'); }
}
function setUsageRange(range) {
  if (!['today', 'week', 'month', 'all'].includes(range) || usageState.range === range) return;
  usageState.range = range;
  document.querySelectorAll('.usage-range-btn').forEach(b => { const on = b.dataset.range === range; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  loadUsage(true);
}
// 空态 / 加载态 / 错误态统一卡片（带如意云纹水印，textContent 安全）。
function usageNoticeCard(msg) {
  const card = el('div', 'usage-empty');
  card.appendChild(el('div', 'usage-empty-cloud'));
  card.appendChild(el('p', 'usage-empty-text', msg));
  return card;
}
function renderUsage(data) {
  const host = $('usagePanel'); if (!host) return;
  host.textContent = '';
  if (!data || data.ok === false) { host.appendChild(usageNoticeCard(t('usage.unavailable'))); return; }
  const totals = data.totals || {};
  const byEngine = Array.isArray(data.byEngine) ? data.byEngine : [];
  const byProvider = Array.isArray(data.byProvider) ? data.byProvider : [];
  const bySession = Array.isArray(data.bySession) ? data.bySession : [];
  const byDay = Array.isArray(data.byDay) ? data.byDay : [];
  // 预算软告警：budget 非 null 时常驻（超支=琥珀 alert；未超=进度条软提示）。放在最顶，不阻断。
  if (data.budget && (Number(data.budget.monthly) > 0 || Number(data.budget.spentThisMonth) > 0)) host.appendChild(usageBudgetBanner(data.budget));
  const hasAny = (Number(totals.inTok) || 0) + (Number(totals.outTok) || 0) + (Number(totals.turns) || 0) > 0
    || byEngine.length || byProvider.length || bySession.length || byDay.length;
  if (!hasAny) { host.appendChild(usageNoticeCard(t('usage.empty'))); return; }
  host.appendChild(usageAggHead(totals, byEngine.concat(byProvider)));
  // 29c: 运营指标行(近 7 天干预次数 / 任务预算超支率)——无人值守质量一眼可见;无数据(全 0)不占版面。
  const ops = data.opsMetrics;
  if (ops && ops.ok && ((ops.interventions && ops.interventions.total > 0) || (ops.missions && ops.missions.started > 0))) {
    const line = el('div', 'muted usage-ops-line');
    const bits = [t('usage.opsInterventions', { days: ops.days, count: ops.interventions.total })];
    if (ops.missions.started > 0) bits.push(t('usage.opsMissions', { count: ops.missions.started, rate: (ops.missions.budgetOverrunRate * 100).toFixed(0) + '%' }));
    line.textContent = '🛠 ' + bits.join(' ｜ ');
    host.appendChild(line);
  }
  if (byEngine.length) host.appendChild(usageGroup(t('usage.group.engine'), byEngine, 'engine'));
  if (byProvider.length) host.appendChild(usageGroup(t('usage.group.provider'), byProvider, 'provider'));
  if (bySession.length) host.appendChild(usageGroup(t('usage.group.session'), bySession, 'session'));
  if (byDay.length) host.appendChild(usageTrend(byDay));
}
// 预算横幅。over=超支 → 琥珀 role=alert；未超 → 软进度条 role=status。措辞带「约/估算」。
function usageBudgetBanner(b) {
  const monthly = Number(b.monthly) || 0, spent = Number(b.spentThisMonth) || 0, cur = b.currency || 'CNY';
  const over = monthly > 0 && spent > monthly;
  const wrap = el('div', 'usage-budget-banner' + (over ? ' over' : ''));
  wrap.setAttribute('role', over ? 'alert' : 'status');
  if (over) {
    wrap.appendChild(el('span', 'usage-budget-icon', '⚠'));
    wrap.appendChild(el('span', 'usage-budget-text', t('usage.budget.over', { spent: fmtMoney(spent, cur), budget: fmtMoney(monthly, cur), over: fmtMoney(spent - monthly, cur) })));
  } else {
    const pct = monthly > 0 ? Math.min(100, Math.round(spent / monthly * 100)) : 0;
    wrap.appendChild(el('span', 'usage-budget-text', monthly > 0 ? t('usage.budget.progress', { spent: fmtMoney(spent, cur), budget: fmtMoney(monthly, cur), percent: pct }) : t('usage.budget.unlimited', { spent: fmtMoney(spent, cur) })));
    if (monthly > 0) { const track = el('div', 'usage-budget-bar'); const fill = el('div', 'usage-budget-fill'); fill.style.width = pct + '%'; track.appendChild(fill); wrap.appendChild(track); }
  }
  return wrap;
}
// 聚合头：输入/输出 tokens + 轮次(含估算标注) + 各币种成本(约/估算) + 诚实脚注。
function usageAggHead(totals, mixedEntries) {
  const wrap = el('div', 'usage-agg');
  const stats = el('div', 'usage-agg-stats');
  stats.appendChild(usageStat(t('usage.inputTokens'), fmtInt(totals.inTok)));
  stats.appendChild(usageStat(t('usage.outputTokens'), fmtInt(totals.outTok)));
  const est = Number(totals.estimatedTurns) || 0;
  // v1.4-OSS 用量看板(补): 工作流子代理回合与辅助调用(压缩/起草)也计入总回合数，附一条小注记说明其构成。
  const subAgents = Number(totals.subagentTurns) || 0;
  const auxCalls = Number(totals.auxCalls) || 0;
  const turnSub = [est > 0 ? t('usage.turns.estimated', { count: fmtInt(est) }) : '', subAgents > 0 ? t('usage.turns.subagent', { count: fmtInt(subAgents) }) : '', auxCalls > 0 ? t('usage.turns.aux', { count: fmtInt(auxCalls) }) : ''].filter(Boolean).join(' · ');
  stats.appendChild(usageStat(t('usage.turns'), fmtInt(totals.turns), turnSub));
  wrap.appendChild(stats);
  const cost = el('div', 'usage-agg-cost');
  cost.appendChild(el('span', 'usage-agg-cost-label', t('usage.cost.estimate')));
  const costStr = fmtCostsByCurrency(totals.costsByCurrency, t('usage.cost.prefix'));
  cost.appendChild(el('span', 'usage-agg-cost-val' + (costStr ? '' : ' muted'), costStr || t('usage.cost.unavailable')));
  wrap.appendChild(cost);
  // 诚实脚注：优先用后端 totals.planBasedTurns（第三方 Coding Plan/订阅计费的轮数）；forward-compat 再兜底逐条 flag。
  const planTurns = Number(totals.planBasedTurns) || 0;
  let note = t('usage.note.cost');
  if (planTurns > 0) note += t('usage.note.planTurns', { count: fmtInt(planTurns) });
  else if ((mixedEntries || []).some(entryPlanBased)) note += t('usage.note.planUsage');
  wrap.appendChild(el('p', 'usage-agg-note muted', note));
  return wrap;
}
function usageStat(label, value, sub) {
  const box = el('div', 'usage-stat');
  box.appendChild(el('div', 'usage-stat-val', value));
  box.appendChild(el('div', 'usage-stat-label', label));
  if (sub) box.appendChild(el('div', 'usage-stat-sub', sub));
  return box;
}
// 分组条：按 tokens(币种无关)归一。sr-only 概述 + 逐条手绘 SVG 水平条。
function usageGroup(title, list, kind) {
  const wrap = el('div', 'usage-group');
  wrap.appendChild(el('div', 'usage-group-title', title));
  const rows = list.map(e => ({ e, tok: (Number(e.inTok) || 0) + (Number(e.outTok) || 0) }));
  const max = Math.max(1, ...rows.map(r => r.tok));
  const names = rows.map(r => usageEntryName(r.e, kind) + ' ' + t('usage.tokenCount', { count: fmtTokens(r.tok) })).join('；');
  wrap.appendChild(el('p', 'sr-only', t('usage.group.summary', { title, count: rows.length, names })));
  const bars = el('div', 'usage-bars');
  for (const r of rows) bars.appendChild(usageBar(r.e, r.tok, max, kind));
  wrap.appendChild(bars);
  return wrap;
}
function usageEntryName(e, kind) {
  if (kind === 'engine') return engineDisplayName(e.engine);
  if (kind === 'session') return e.title || e.sessionId || t('usage.session.unnamed');
  return e.label || e.provider || t('usage.provider.unknown');
}
function usageBar(entry, tok, max, kind) {
  const row = el('div', 'usage-bar-row');
  const labelWrap = el('div', 'usage-bar-label');
  labelWrap.appendChild(el('span', 'usage-bar-name', usageEntryName(entry, kind)));
  const src = entry.sourceLabel || entry.source;
  if (src && kind !== 'session') labelWrap.appendChild(el('span', 'usage-bar-src', src));
  const plan = entryPlanBased(entry);
  if (plan) { const pb = el('span', 'usage-bar-plan', t('usage.planIncluded')); pb.title = t('usage.planIncluded.title'); labelWrap.appendChild(pb); } // v3 (§2.8): 术语人话 tooltip
  // 会话条可点击 → 打开该会话（openSession 走 /api/sessions/:id）。键盘可达。
  if (kind === 'session' && entry.sessionId) {
    row.classList.add('clickable'); row.setAttribute('role', 'button'); row.tabIndex = 0;
    row.setAttribute('aria-label', t('usage.openSession', { title: usageEntryName(entry, kind) }));
    const go = () => { openSession(entry.sessionId).catch(e => toast(t('usage.openSession.failed', { reason: apiErrText(e) }), 'err')); };
    row.onclick = go; row.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } };
  }
  const pct = Math.max(0, Math.min(100, Math.round(tok / max * 100)));
  const colorVar = kind === 'engine' ? (entry.engine === 'claude' ? 'var(--wf-claude)' : 'var(--wf-provider)') : 'var(--accent)';
  row.appendChild(labelWrap);
  row.appendChild(usageBarSvg(pct, colorVar));
  const valWrap = el('div', 'usage-bar-val');
  valWrap.appendChild(el('span', 'usage-bar-tok', t('usage.tokenCount', { count: fmtTokens(tok) })));
  if (plan) valWrap.appendChild(el('span', 'usage-bar-cost muted', t('common.planned')));
  else { const c = fmtCostsByCurrency(entry.costsByCurrency, t('common.aboutPrefix')); if (c) valWrap.appendChild(el('span', 'usage-bar-cost', c)); }
  row.appendChild(valWrap);
  return row;
}
// 手绘 SVG 水平条：底轨 rect + 填充 rect(宽 = round(pct))。preserveAspectRatio=none 横向拉伸铺满。装饰性 → aria-hidden。
function usageBarSvg(pct, colorVar) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'usage-bar-svg'); svg.setAttribute('viewBox', '0 0 100 10');
  svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'rect');
  track.setAttribute('class', 'usage-bar-track'); track.setAttribute('x', '0'); track.setAttribute('y', '0'); track.setAttribute('width', '100'); track.setAttribute('height', '10'); track.setAttribute('rx', '2');
  const fill = document.createElementNS(NS, 'rect');
  fill.setAttribute('class', 'usage-bar-fill'); fill.setAttribute('x', '0'); fill.setAttribute('y', '0'); fill.setAttribute('width', String(round2(pct))); fill.setAttribute('height', '10'); fill.setAttribute('rx', '2'); fill.setAttribute('fill', colorVar);
  svg.appendChild(track); svg.appendChild(fill);
  return svg;
}
// 日趋势：手绘 SVG 迷你柱状。按 tokens 归一，深浅主题用 --accent 着色。sr-only 概述 + 首末日期 caption。
function usageTrend(byDay) {
  const wrap = el('div', 'usage-group usage-trend');
  wrap.appendChild(el('div', 'usage-group-title', t('usage.dailyTrend')));
  const days = byDay.map(d => ({ date: d.date || '', tok: (Number(d.inTok) || 0) + (Number(d.outTok) || 0) }));
  const max = Math.max(1, ...days.map(d => d.tok));
  const peak = days.reduce((a, b) => (b.tok > a.tok ? b : a), days[0] || { tok: 0, date: '' });
  wrap.appendChild(el('p', 'sr-only', t('usage.dailyTrend.summary', { count: days.length, tokens: t('usage.tokenCount', { count: fmtTokens(peak.tok) }), date: peak.date })));
  wrap.appendChild(usageTrendSvg(days, max));
  if (days.length) { const cap = el('div', 'usage-trend-cap'); cap.appendChild(el('span', '', days[0].date)); cap.appendChild(el('span', '', days[days.length - 1].date)); wrap.appendChild(cap); }
  return wrap;
}
function usageTrendSvg(days, max) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 100, H = 40, n = days.length, gap = n > 1 ? Math.min(2, 40 / n) : 0;
  const bw = n > 0 ? (W - gap * (n - 1)) / n : W;
  const peakTok = Math.max(0, ...days.map(d => d.tok));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'usage-trend-svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  days.forEach((d, i) => {
    const h = d.tok > 0 ? Math.max(1, Math.round(d.tok / max * (H - 2))) : 0;
    const x = round2(i * (bw + gap)), y = round2(H - h);
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('class', 'usage-trend-bar' + (d.tok > 0 && d.tok === peakTok ? ' peak' : ''));
    r.setAttribute('x', String(x)); r.setAttribute('y', String(y)); r.setAttribute('width', String(round2(bw))); r.setAttribute('height', String(h)); r.setAttribute('rx', '0.6');
    const titleEl = document.createElementNS(NS, 'title'); titleEl.textContent = t('usage.dailyTrend.point', { date: d.date, tokens: t('usage.tokenCount', { count: fmtTokens(d.tok) }) }); r.appendChild(titleEl);
    svg.appendChild(r);
  });
  return svg;
}

  function isUsageLoaded() { return usageState.loaded; }

  function openUsageDashboard() {
    if (!isUsageLoaded()) return loadUsage();
    renderUsage(usageState.data);
  }

  function refreshLocalizedUsage() {
    if (usageState.data) renderUsage(usageState.data);
  }

  function bindUsageDashboard() {
    const refresh = $('usageRefreshBtn');
    if (refresh) refresh.onclick = () => loadUsage(true);
    document.querySelectorAll('.usage-range-btn').forEach(button => {
      button.onclick = () => setUsageRange(button.dataset.range);
    });
  }

  return Object.freeze({
    bindUsageDashboard,
    loadUsage,
    openUsageDashboard,
    refreshLocalizedUsage,
  });
}
