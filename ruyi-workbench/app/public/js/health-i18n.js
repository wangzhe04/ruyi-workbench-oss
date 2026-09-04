'use strict';

// 118b: 体检项的人话映射表(纯模块,零 import、零 DOM)。
//
// 为什么存在:computeHealth() 下发的是 {id, ok, detail} -- id 是 agent-cli / overlay-integrity 这种
// 英文标识,detail 是给维护者看的英文技术短语。旧版 renderDoctor 把这两样原样打在屏幕上,对「电脑小白」
// 用户等于没说。本模块把每个 id 翻成一句话说清「这是什么」(label)、「现在什么情况」(hint)、
// 「该做什么」(next),再给一个 ok/warn/error 的严重度供 UI 上灯。
//
// 纪律:
//   · 纯函数,只依赖注入的 t();渲染、跳转、DOM 全在调用方(provider-settings.js)。
//   · 用户永远看不到裸 id -- 认不出来的 id 也回落成一句通用人话,原始 id/detail 只进「技术详情」折叠区。
//   · next 只描述【应用内】的下一步(去哪个页签、看手册哪一节),不给路径、不给命令行 -- §2 UX 红线。
//   · 与服务端 `doctor --human` 共用同一批 health.* 文案键(那边直接读 locales/*.json),文案只有一份。

// 已知体检项 -> 文案键前缀。键的完整形状:
//   health.item.<id>.label
//   health.item.<id>.hint.<variant>
//   health.item.<id>.next.<variant>
export const HEALTH_ID_LABELS = Object.freeze({
  'agent-cli': 'health.item.agent-cli.label',
  'claude-cli': 'health.item.claude-cli.label',
  'data-writable': 'health.item.data-writable.label',
  'server-source': 'health.item.server-source.label',
  'mcp-target': 'health.item.mcp-target.label',
  'vendor-libs': 'health.item.vendor-libs.label',
  'desktop-control': 'health.item.desktop-control.label',
  'overlay-integrity': 'health.item.overlay-integrity.label',
});
export const HEALTH_KNOWN_IDS = Object.freeze(Object.keys(HEALTH_ID_LABELS));

// claude-cli 与 agent-cli 是同一次探测的两条记录(后者是给旧 overlay/诊断留的别名)。两行一模一样的
// 中文会让人以为界面出了 bug,所以别名只进「技术详情」,不单独占一行。
export const HEALTH_ALIAS_IDS = Object.freeze(['claude-cli']);

// desktop-control 的状态写在 detail 的前缀里(服务端 12-tool-dispatch.js 的 DESKTOP_CONTROL_DETAILS)。
export const DESKTOP_CONTROL_STATES = Object.freeze([
  'ready', 'disabled', 'not-installed', 'python-missing', 'preparing', 'unreachable',
]);

// 严重度表。三档:ok=不用管;warn=可以更好,但主功能不受影响;error=会真的挡住用户,得处理。
// 两个刻意的判断:
//   · server-source 的 ok:false 只表示「以打包好的程序运行」,那是发布件的正常形态,不是故障 -> 恒 ok。
//   · agent-cli 缺失不是死路:配一个 API 服务商同样能用 -> warn 而不是 error。
const HEALTH_SEVERITY = Object.freeze({
  'agent-cli': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'claude-cli': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'data-writable': Object.freeze({ ok: 'ok', bad: 'error' }),
  'server-source': Object.freeze({ ok: 'ok', bad: 'ok' }),
  'mcp-target': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'vendor-libs': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'overlay-integrity': Object.freeze({ ok: 'ok', bad: 'error' }),
  'desktop-control': Object.freeze({
    ready: 'ok', disabled: 'warn', 'not-installed': 'warn',
    'python-missing': 'warn', preparing: 'warn', unreachable: 'error',
  }),
});

// 「怎么办」按下去到底发生什么。kind:'settings' 切设置页签(用户自己点那个页签时走的同一条 onclick);
// kind:'manual' 打开应用内手册阅读器并滚到某一节(anchorKey 是文案键,中英各自对应本语言的小节标题)。
// 没有条目 = 这一项没有可执行的下一步,不渲染按钮(比 disabled 按钮诚实)。
export const HEALTH_ACTIONS = Object.freeze({
  'agent-cli': Object.freeze({ kind: 'settings', tab: 'providers' }),
  'claude-cli': Object.freeze({ kind: 'settings', tab: 'providers' }),
  'data-writable': Object.freeze({ kind: 'manual', docId: 'user-guide', anchorKey: 'health.anchor.faq' }),
  'vendor-libs': Object.freeze({ kind: 'manual', docId: 'user-guide', anchorKey: 'health.anchor.faq' }),
  'overlay-integrity': Object.freeze({ kind: 'settings', tab: 'update' }),
  'desktop-control': Object.freeze({ kind: 'settings', tab: 'integrations' }),
});

// detail 的状态前缀 -> 变体键。认不出来的状态按最保守的「没装」处理(绝不谎报已就绪)。
export function desktopControlStateOf(detail) {
  const token = String(detail || '').split(':')[0].trim();
  return DESKTOP_CONTROL_STATES.includes(token) ? token : 'not-installed';
}

// 条目 -> 文案变体。desktop-control 用状态标识,其余项只有 ok / bad 两态。
export function healthVariant(item) {
  if (!item) return 'bad';
  if (item.id === 'desktop-control') return desktopControlStateOf(item.detail);
  return item.ok ? 'ok' : 'bad';
}

export function healthSeverity(item) {
  const table = HEALTH_SEVERITY[item && item.id];
  if (!table) return item && item.ok ? 'ok' : 'warn'; // 未知项:不敢说没事,也不敢说是灾难
  return table[healthVariant(item)] || (item && item.ok ? 'ok' : 'warn');
}

// detail 里的第一个整数(desktop-control 的已桥接工具数)。取不到就是 0。
function countIn(detail) {
  const m = String(detail || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

// 唯一的映射入口。返回 { label, hint, next, severity }:
//   label    这是什么(一个名词短语)
//   hint     现在什么情况(一句话)
//   next     该做什么(一句话,只指向应用内的去处);不需要行动时是空串
//   severity 'ok' | 'warn' | 'error'
export function describeHealthItem(item, t) {
  const translate = typeof t === 'function' ? t : (key => key);
  const id = String((item && item.id) || '');
  const severity = healthSeverity(item);
  if (!Object.prototype.hasOwnProperty.call(HEALTH_ID_LABELS, id)) {
    // 未知 id(旧 overlay 或将来新增的检查项)。用户看到的仍是人话;原始 id 与 detail 由调用方放进
    // 「技术详情」折叠区,方便把问题原样转给支持人员。
    return {
      label: translate('health.item.unknown.label'),
      hint: translate(item && item.ok ? 'health.item.unknown.hint.ok' : 'health.item.unknown.hint.bad'),
      next: '',
      severity,
    };
  }
  const variant = healthVariant(item);
  const hint = translate(`health.item.${id}.hint.${variant}`, { count: countIn(item && item.detail) });
  const nextKey = `health.item.${id}.next.${variant}`;
  const next = severity === 'ok' ? '' : String(translate(nextKey) || '');
  // t() 查不到键时回显 `[键名]`。那种情况按「没有下一步」处理,绝不把键名当文案打给用户。
  const nextResolved = (next === nextKey || next === `[${nextKey}]`) ? '' : next;
  return { label: translate(HEALTH_ID_LABELS[id]), hint, next: nextResolved, severity };
}

// 摘要红点用的计数。别名项不重复计。
export function summarizeHealth(health) {
  let errors = 0;
  let warnings = 0;
  for (const item of Array.isArray(health) ? health : []) {
    if (!item || HEALTH_ALIAS_IDS.includes(item.id)) continue;
    const severity = healthSeverity(item);
    if (severity === 'error') errors += 1;
    else if (severity === 'warn') warnings += 1;
  }
  return { errors, warnings, total: errors + warnings };
}

// 摘要文案 + 语气。没有任何待办时返回 null(调用方就此不渲染,空徽标比没有更糟)。
export function healthSummaryText(health, t) {
  const translate = typeof t === 'function' ? t : (key => key);
  const { errors, warnings } = summarizeHealth(health);
  if (errors > 0) return { tone: 'error', count: errors, text: translate('health.summary.errors', { count: errors }) };
  if (warnings > 0) return { tone: 'warn', count: warnings, text: translate('health.summary.warnings', { count: warnings }) };
  return null;
}
