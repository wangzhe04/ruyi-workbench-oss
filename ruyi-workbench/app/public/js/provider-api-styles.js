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
