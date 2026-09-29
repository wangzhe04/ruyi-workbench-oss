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
export const PROVIDER_API_STYLE_DEFAULT = 'chat';

export const PROVIDER_API_STYLES = Object.freeze({
  chat: Object.freeze({ id: 'chat', labelKey: 'provider.apiStyle.chat', serverWebSearch: false }),
  responses: Object.freeze({ id: 'responses', labelKey: 'provider.apiStyle.responses', serverWebSearch: true }),
});

export const PROVIDER_API_STYLE_IDS = Object.freeze(Object.keys(PROVIDER_API_STYLES));

// 与服务端 normalizeProviderApiStyle 同一口径:登记过的键原样,其余(缺失、空串、大小写不对、原型链名字、非字符串)一律缺省。
export function normalizeProviderApiStyle(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_API_STYLES, value) ? value : PROVIDER_API_STYLE_DEFAULT;
}

export function providerApiStyleMeta(value) {
  return PROVIDER_API_STYLES[normalizeProviderApiStyle(value)];
}
