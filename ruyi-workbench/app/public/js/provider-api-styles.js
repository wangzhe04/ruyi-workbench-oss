'use strict';

// 58 号方案批 1:前端对「服务商线协议」(provider.apiStyle)的知识只住这一张表 —— 设置页「协议」下拉由它生成,
// 「服务端搜索」开关按 serverWebSearch 显隐。修前 provider-settings.js 把两个协议写死在下拉里,显隐只认 'responses'。
// 键集合与服务端 04i PROVIDER_WIRE_PROTOCOLS 逐一相同(顺序也同)、serverWebSearch 与服务端同值,
// 由 dev-harness/unit/provider-wire-protocols.test.js 钉住。加一种协议 = 服务端登记表一项 + 这里一行 + 两份语言包的文案键。
//
// 边界:零 import、零 DOM(node 单测直接 import)。
//
// 字段:
//   id               与键相同(= provider.apiStyle 的取值;缺省协议不落字段)
//   labelKey         下拉里这一项的 i18n 键
//   serverWebSearch  这种协议能否把 web_search 交给服务端执行(决定「服务端搜索」开关显不显示)
//   anthropicOptions 这种协议有没有 Anthropic 专属的三项设置(认证方式 / 思考方式 / 拒答自动改派;服务端
//                    provider.anthropicAuth / anthropicThinking / anthropicFallbacks)。只给服务商卡片决定显不显示那一组,服务端没有对应成员。
export const PROVIDER_API_STYLE_DEFAULT = 'chat';

export const PROVIDER_API_STYLES = Object.freeze({
  chat: Object.freeze({ id: 'chat', labelKey: 'provider.apiStyle.chat', serverWebSearch: false, anthropicOptions: false }),
  responses: Object.freeze({ id: 'responses', labelKey: 'provider.apiStyle.responses', serverWebSearch: true, anthropicOptions: false }),
  // 58 号批 2:Anthropic Messages(官方与兼容网关);服务端搜索批 3 再开。
  anthropic: Object.freeze({ id: 'anthropic', labelKey: 'provider.apiStyle.anthropic', serverWebSearch: false, anthropicOptions: true }),
});

// 服务商卡片「思考强度」下拉的候选(空 = 按模型默认、不发送)。与服务端 04i PROVIDER_REASONING_EFFORTS 同一份取值、同一顺序
// (空串在最前),由 unit/provider-wire-protocols.test.js 钉;线程头模型菜单(navigation-controls.js)里那份是同一组值。
export const PROVIDER_REASONING_EFFORT_CHOICES = Object.freeze(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// Anthropic 专属三项的取值(空 = 缺省、不落字段;与服务端 04i 的 ANTHROPIC_AUTH_MODES / THINKING_MODES / FALLBACK_MODES 同值)。
export const ANTHROPIC_AUTH_CHOICES = Object.freeze(['', 'x-api-key', 'bearer']);
export const ANTHROPIC_THINKING_CHOICES = Object.freeze(['', 'adaptive', 'off']);


export const PROVIDER_API_STYLE_IDS = Object.freeze(Object.keys(PROVIDER_API_STYLES));

// 与服务端 normalizeProviderApiStyle 同一口径:登记过的键原样,其余(缺失、空串、大小写不对、原型链名字、非字符串)一律缺省。
export function normalizeProviderApiStyle(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_API_STYLES, value) ? value : PROVIDER_API_STYLE_DEFAULT;
}

export function providerApiStyleMeta(value) {
  return PROVIDER_API_STYLES[normalizeProviderApiStyle(value)];
}

// 用户往 Base URL 里粘的常是完整端点:剥掉端点后缀,只留到服务商要的 base(与服务端拼端点的口径一致:
// anthropic = base 到 /anthropic 或主机这一级、服务端补 /v1/messages;chat = base 到 /vN、服务端补 /chat/completions;
// responses = 原样 base + /responses)。认不出后缀就原样(只去掉首尾空白与末尾的 /)。
const PROVIDER_ENDPOINT_SUFFIXES = [/(?:\/v\d+)?\/messages$/i, /\/chat\/completions$/i, /\/responses$/i];
export function stripProviderEndpointSuffix(url) {
  let s = String(url == null ? '' : url).trim().replace(/\/+$/, '');
  for (const re of PROVIDER_ENDPOINT_SUFFIXES) {
    if (re.test(s)) { s = s.replace(re, ''); break; }
  }
  return s;
}

// 从地址推断协议(只在明显时;认不出 → ''):Anthropic 官方主机、路径里有 /anthropic 段、或粘的是 …/messages 端点 → anthropic;
// 粘的是 …/chat/completions → chat;…/responses → responses。设置页与向导据此在用户没手动选过协议时自动切换。
export function inferProviderApiStyleFromUrl(url) {
  const s = String(url == null ? '' : url).trim().replace(/\/+$/, '');
  if (!s) return '';
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)[^/?#]*([^?#]*)/i.exec(s);
  const host = m ? m[1].toLowerCase() : '';
  const pathPart = m ? m[2] : s;
  if (host === 'api.anthropic.com') return 'anthropic';
  if (/\/messages$/i.test(pathPart)) return 'anthropic';
  if (/(^|\/)anthropic(\/v\d+)?$/i.test(pathPart)) return 'anthropic';
  if (/\/chat\/completions$/i.test(pathPart)) return 'chat';
  if (/\/responses$/i.test(pathPart)) return 'responses';
  return '';
}

// 设置页 Base URL 输入框「边敲边认协议」的纯状态机(provider-settings.js 用它;纯函数,node 单测直接 import)。
//   state = { style, touched, auto }:style = 卡片现在的协议;touched = 用户亲手选过协议(之后地址怎么变都不动);
//         auto = null | { from, to } —— 当前协议是被【地址推断】自动切过去的,from 是切换前的协议、to 是现在这个。
//   返回 { style, auto, action }:action = 'switched'(推断出一个与现在不同的协议,切过去)
//         | 'reverted'(推断落空,或推断回到了 from,切回切换前的协议)| ''(什么都没动)。
// 为什么要「切回」:逐键输入时 …/anthropic-proxy/v1 敲到 …/anthropic 那一刻地址恰好以 /anthropic 结尾,会先切到 Anthropic;
// 之后继续敲推断落空了,若不切回,最终地址本不该认成 Anthropic 的卡就留在错的协议上。只有【自动切过去的】才会被切回:
// 存量卡本来就是 anthropic(地址推断一致不记 auto)、用户手动选的(touched),地址怎么改都不会被动。
export function stepAutoProviderStyle(state, url) {
  const cur = normalizeProviderApiStyle(state && state.style);
  if (state && state.touched) return { style: cur, auto: null, action: '' };
  const auto = state && state.auto && typeof state.auto === 'object' ? { from: normalizeProviderApiStyle(state.auto.from), to: normalizeProviderApiStyle(state.auto.to) } : null;
  const inferred = inferProviderApiStyleFromUrl(url);
  if (inferred) {
    if (inferred === cur) return { style: cur, auto, action: '' };
    if (auto && inferred === auto.from) return { style: inferred, auto: null, action: 'reverted' };
    return { style: inferred, auto: { from: auto ? auto.from : cur, to: inferred }, action: 'switched' };
  }
  if (auto) return { style: auto.from, auto: null, action: 'reverted' };
  return { style: cur, auto: null, action: '' };
}

// Anthropic 官方主机(只有它才认「拒答改派」等官方专属项;设置页据此显示那一个开关)。与服务端 anthropicOfficialHost 同一判据。
export function isAnthropicOfficialUrl(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(String(url || '').trim());
  return Boolean(m && m[1].toLowerCase() === 'api.anthropic.com');
}
