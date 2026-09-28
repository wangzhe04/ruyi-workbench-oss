'use strict';

// 架构还债（ENGINEERING-SPEC §11.1 末行）：前端对「哪一个 Agent CLI」的全部知识住在这一张表里。
//
// 修前这些知识散在六个文件约 32 处：两份 AGENT_CLI_LABELS、`agentCliType === 'kimi' ? 'kimi' : 'claude'` 的归一化、
// 思考强度候选、Kimi 状态刷新的接口、压缩入口（/compact 回合 vs 服务端原生压缩）、头像字母、CLI 路径键……
// 现在调用点只问这张表（agentCliMeta(id).xxx），不再和 'kimi'／'claude' 字面量比较；加第三个 CLI = 在这里加一行
// （外加 index.html 里它那一格路径输入与服务端 01 AGENT_CLI_TYPES / 05 AGENT_CLI_ADAPTERS 各一行）。
//
// 边界：零 import、零 DOM —— 经典壳、3.0 管家壳与 node 单测都直接 import 它；chat-render-primitives /
// chat-stream-runtime 这两个零 import 工厂由组合根 app.js 以 deps.agentCliMeta 注入同一个函数。
// 表的键集与服务端 AGENT_CLI_TYPES 逐一相同、每行字段齐全，由 dev-harness/unit/agent-cli-registry-frontend.test.js 钉住。
//
// 字段：
//   id                       与键相同（= 会话 engineRoute.agentCliType / config.agentCliType 的取值）
//   label                    品牌名（不是文案，两个语言下逐字相同）：设置页、引擎菜单、线程头 chip、就绪行
//   avatarLetter             消息头像／徽标上的那一个字母（engineVisual）
//   eventTag                 原始事件日志 meta 行的前缀兜底（服务端 meta 帧没带 agentCliLabel 时用；claude 历来印小写 'claude'）
//   pathKey / detectedKey    config 里的 CLI 路径键 / /api/status 里探测到的路径键（就绪判定、空态 CTA、当前 CLI 路径）
//   thinkingEfforts          模型菜单「思考强度」下拉的候选（顺序即显示顺序）
//   settingsThinkingEfforts  设置页 #cfgThinkingEffort 可用的档位；null = 全部可用（其余选项置灰隐藏）
//   compactDefaultLabelKey   上下文弹层「压缩用哪个模型」缺省项的 i18n 键（不配服务商时走这个 CLI 的原生压缩）
//   nativeCompact            手动「立即压缩」怎么走：'slash-command' = 发一条 /compact 流式回合；
//                            'server-api' = POST /api/agent/compact（服务端原生压缩）
//   statusEndpoint           打开线程／电量表时刷新原生用量的接口（'' = 这个 CLI 没有）
//   alwaysInteractive        true = 活回合永远可插话；false = 要 engineMode === 'interactive' 才行
//   legacyUsageSources       旧用量行（没有 contextEngine 标签）按 usage.source 认领到这个 CLI 的取值
export const AGENT_CLI_DEFAULT_ID = 'claude';

export const AGENT_CLI_REGISTRY = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    avatarLetter: 'C',
    eventTag: 'claude',
    pathKey: 'claudePath',
    detectedKey: 'detectedClaudePath',
    thinkingEfforts: Object.freeze(['', 'low', 'medium', 'high', 'xhigh', 'max']),
    settingsThinkingEfforts: null,
    compactDefaultLabelKey: 'ctx.compact.defaultClaude',
    nativeCompact: 'slash-command',
    statusEndpoint: '',
    alwaysInteractive: false,
    legacyUsageSources: Object.freeze([]),
  }),
  kimi: Object.freeze({
    id: 'kimi',
    label: 'Kimi Code',
    avatarLetter: 'K',
    eventTag: 'Kimi Code',
    pathKey: 'kimiPath',
    detectedKey: 'detectedKimiPath',
    thinkingEfforts: Object.freeze(['', 'low', 'medium', 'high', 'max']),
    settingsThinkingEfforts: Object.freeze(['', 'low', 'high', 'max']),
    compactDefaultLabelKey: 'ctx.compact.defaultKimi',
    nativeCompact: 'server-api',
    statusEndpoint: '/api/kimi/status',
    alwaysInteractive: true,
    legacyUsageSources: Object.freeze(['kimi-native', 'kimi-wire']),
  }),
});

// 表的键，按登记顺序（设置页主模型下拉、管家引擎菜单的列出顺序就是它）。
export const AGENT_CLI_IDS = Object.freeze(Object.keys(AGENT_CLI_REGISTRY));

// config.claudeThinkingEffort（两个 CLI 共用的那一个键）接受的全部取值 = 各行 thinkingEfforts 的并集，按登记顺序。
export const AGENT_CLI_THINKING_EFFORT_VALUES = Object.freeze([...new Set(AGENT_CLI_IDS.flatMap(id => AGENT_CLI_REGISTRY[id].thinkingEfforts))]);

export function isAgentCliId(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_CLI_REGISTRY, value);
}
// 不认识的值（缺省、旧数据、非字符串）一律归到缺省 CLI —— 与服务端 selectedAgentCli 同一判据。
export function normalizeAgentCliType(value) {
  return isAgentCliId(value) ? value : AGENT_CLI_DEFAULT_ID;
}
// 那一行（不认识的值 → 缺省 CLI 那一行）。
export function agentCliMeta(value) {
  return AGENT_CLI_REGISTRY[normalizeAgentCliType(value)];
}
// 认识就给那一行，不认识给 null（需要区分「没登记」的调用点用，例如头像徽标的 'Agent CLI' 兜底名）。
export function knownAgentCliMeta(value) {
  return isAgentCliId(value) ? AGENT_CLI_REGISTRY[value] : null;
}
