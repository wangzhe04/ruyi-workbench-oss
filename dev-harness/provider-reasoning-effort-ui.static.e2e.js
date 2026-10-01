'use strict';
// 思考强度的主入口仍是引擎/模型切换器(线程头模型菜单);2026-10 起服务商卡片「协议与能力」折叠组里也补了一个下拉(同一个 reasoningEffort 字段,
// 仅「推理链」打开时可选)。下面两条 doesNotMatch 钉的是【旧形状不回来】:不另立 hint 键、不再用 prov-reason 开关样式冒充强度选择器。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js');
const navigation = fs.readFileSync(path.join(root, 'navigation-controls.js'), 'utf8');
const providers = fs.readFileSync(path.join(root, 'provider-settings.js'), 'utf8');

assert.match(navigation, /const PROVIDER_REASONING_EFFORTS_UI = \['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'\]/);
assert.match(navigation, /async function setProviderReasoningEffort\(providerId, value\)/);
// 121-K5（34 号文 §3.1）：2.0 那张模型弹层（openModelChipPopover）退役，强度选择器搬进线程头
// 那组 chip 的模型菜单尾部。原来两份（appendClaudeEffort / appendProviderEffort，只差键名与写回
// 函数）合成一个 appendEffortControl —— 「选哪一档」这件事因此从两处变成一处。钉的事实没变：
// ① 强度仍然跟着引擎/模型选择器走，不回到服务商设置表单里；② provider 分支仍调
// setProviderReasoningEffort。反向验证：把 appendEffortControl 从 modelMenuExtras.appendTail 里
// 摘掉 → 第二条当场红。
assert.match(navigation, /function appendEffortControl\(container, close\)/);
assert.match(navigation, /appendTail: \(menu, ctx\) => \{[\s\S]{0,200}appendEffortControl\(menu, close\);/);
assert.match(navigation, /await setProviderReasoningEffort\(provider\.id, select\.value\)/);
// 121-K5：强度不再印在退役的 #modelChip 标题上（modelMenu.modelWithEffort 随 renderModelChip
// 一起没了消费者），改钉它现在真正的读面 —— 菜单里那个下拉的每一项都查目录，两套键各一条。
assert.match(navigation, /thinkingEffort\.\$\{value \|\| .default.\}/);
assert.match(navigation, /provider\.reasoningEffort\.\$\{value \|\| .default.\}/);
assert.doesNotMatch(providers, /provider\.reasoningEffortHint/);
assert.doesNotMatch(providers, /const effort = el\('label', 'check prov-reason'\)/);
// 2026-10：卡片里的下拉走协议表导出的候选、写同一个 p.reasoningEffort，且随「推理链」开关置灰（不隐藏）。
assert.match(providers, /for \(const value of PROVIDER_REASONING_EFFORT_CHOICES\)/);
assert.match(providers, /effortSel\.onchange = \(\) => \{ p\.reasoningEffort = effortSel\.value; \};/);
assert.match(providers, /effortSel\.disabled = !rc\.checked/);

console.log('PROVIDER REASONING EFFORT UI STATIC E2E: ALL PASS');
