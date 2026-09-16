require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
'use strict';
// 114a（45 号文 §2 ①）：语音识别（ASR）配置地基的静态锁。纯静态，不起服务、不跑浏览器。
//   ① 两个 caps 取值域的隔离（45 号文 §1.2）：PROVIDER_MODEL_CAPS（05，模型能力标签 asr/embedding）
//      与 PLAYBOOK_REQUIRES（06，运行环境能力矩阵 network/desktopMcp/vision）同名不同物，
//      【不许互相引用】，06 里连 'asr' 字面量都不许出现。
//   ② CONFIG_SCHEMA 故意【不】bump（45 号文 §6.1 对 26 号文的显式改判：纯增量 + normalizeConfig
//      消毒 ⇒ 读回空即未配置，三条既有迁移分支处理的全是「旧值要改写」，这里没有旧值）。钉在 11，
//      谁 bump 了先回来读 45 号文。
//   ③ 后端落点：models[].caps 走 providerModelCaps 白名单；audioBaseUrl 与 baseUrl 同待遇
//      （trim + 截 400，不发明 URL 校验）；asrProviderId/asrModel 默认值 + 清洗（provider 没了两个一起清）。
//   ④ 前端落点：选择器只列 caps 含 asr 的模型；无候选整块不渲染（未配置 = 不可见，设置页 DOM 零漂移）；
//      选中即存 saveConfigPartial 部分补丁；分隔符 fromCharCode 构造（32 号文 §16-bis：源码零控制字符）。
//   ⑤ 双语键齐全；index.html 零静态 asr 标记；provider-settings.js 零控制字符。
// 反向：摘掉 PROVIDER_MODEL_CAPS 白名单（改成裸通过）→ failover.e2e.js 的 (C) 断言当场红并打出实得数组；
//       把「无候选不渲染」摘掉 → ④ 的 if (!options.length) 锚红。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'ruyi-workbench', 'app');
const src05 = fs.readFileSync(path.join(APP, 'src', '05-claude-engine.js'), 'utf8');
const src06 = fs.readFileSync(path.join(APP, 'src', '06-provider-engine.js'), 'utf8');
const src01 = fs.readFileSync(path.join(APP, 'src', '01-config.js'), 'utf8');
const src00 = fs.readFileSync(path.join(APP, 'src', '00-boot.js'), 'utf8');
const providersJs = fs.readFileSync(path.join(APP, 'public', 'js', 'provider-settings.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(APP, 'public', 'locales', 'zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(APP, 'public', 'locales', 'en-US.json'), 'utf8'));

// ① 域隔离（取值域不相交 + 互不引用；05 那行隔离注释是 45 号文 §1.2 点名要留的，允许它点名一次）
assert.match(src05, /const PROVIDER_MODEL_CAPS = new Set\(\['asr', 'embedding'\]\)/, '05: PROVIDER_MODEL_CAPS 白名单（asr/embedding）');
assert.match(src06, /const PLAYBOOK_REQUIRES = \['network', 'desktopMcp', 'vision'\]/, '06: PLAYBOOK_REQUIRES 取值域原样');
const capsModelDomain = ['asr', 'embedding'], capsRuntimeDomain = ['network', 'desktopMcp', 'vision'];
assert.ok(!capsModelDomain.some(v => capsRuntimeDomain.includes(v)), '两个 caps 取值域必须不相交');
assert.ok(!src06.includes('PROVIDER_MODEL_CAPS'), '06 不得引用模型能力标签域（PROVIDER_MODEL_CAPS）');
assert.ok(!src06.includes("'asr'") && !src06.includes('"asr"'), "06 不得出现 'asr' 字面量（串域）");
const mentions = src05.split('\n').filter(l => l.includes('PLAYBOOK_REQUIRES'));
assert.ok(mentions.length === 1 && /^\s*\/\//.test(mentions[0].trimStart()) || (mentions.length === 1 && mentions[0].trim().startsWith('//')), '05 只允许 114a 隔离注释点名 PLAYBOOK_REQUIRES 一次（不许代码引用）：实得 ' + mentions.length + ' 处');
// ② schema 不 bump
assert.match(src00, /const CONFIG_SCHEMA = 11;/, 'CONFIG_SCHEMA 保持 11（114a 显式不 bump，45 号文 §6.1）');
// ③ 后端落点
assert.match(src05, /function providerModelCaps\(rawCaps\)/, '05: providerModelCaps 白名单清洗函数');
assert.match(src05, /const caps = providerModelCaps\(m\.caps\);/, '05: models 归一化走白名单');
assert.match(src05, /const audioBaseUrl = str\(raw\.audioBaseUrl, 400\)\.trim\(\);/, '05: audioBaseUrl 与 baseUrl 同待遇（trim + 截 400）');
assert.match(src01, /asrProviderId: '',/, '01: asrProviderId 默认空（未配置）');
assert.match(src01, /asrModel: '',/, '01: asrModel 默认空（未配置）');
assert.match(src01, /for \(const key of \['asrProviderId', 'asrModel'\]\)/, '01: asr 形状清洗块');
assert.match(src01, /if \(config\.asrProviderId && !config\.providers\.some\(p => p && p\.id === config\.asrProviderId\)\)/, '01: provider 没了 → asr 两个一起清空');
// ④ 前端落点
assert.match(providersJs, /function renderAsrSettings\(\)/, '前端: renderAsrSettings 存在');
assert.match(providersJs, /caps\.includes\('asr'\)/, '前端: 只列 caps 含 asr 的模型');
assert.match(providersJs, /if \(!options\.length\) \{/, '前端: 无候选整块不渲染（未配置 = 不可见）');
assert.match(providersJs, /saveConfigPartial\(\{ asrProviderId, asrModel \}\)/, '前端: 选中即存部分补丁');
assert.match(providersJs, /const ASR_VALUE_SEP = String\.fromCharCode\(31\);/, '前端: 分隔符 fromCharCode 构造（零控制字符）');
assert.match(providersJs, /try \{ renderAsrSettings\(\); \}/, '前端: fillSettings 接线（带 117j 同款旁路保护）');
// ⑤ 双语键 + 零静态标记 + 零控制字符
for (const [name, dict] of [['zh-CN', zh], ['en-US', en]]) {
  for (const k of ['settings.asr.title', 'settings.asr.disabled', 'settings.asr.hintSet', 'settings.asr.hintUnset', 'settings.asr.toastSet', 'settings.asr.toastReset']) {
    assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, name + ' 缺键 ' + k);
  }
}
assert.ok(!indexHtml.includes('settings.asr') && !/id="[^"]*asr/i.test(indexHtml), 'index.html 零静态 asr 标记（未配置 DOM 零漂移）');
const bad = [...providersJs].findIndex(ch => { const code = ch.charCodeAt(0); return code < 32 && code !== 9 && code !== 10 && code !== 13; });
assert.equal(bad, -1, 'provider-settings.js 含控制字符 @' + bad);

console.log('ASR CONFIG UI STATIC E2E: ALL PASS');
