require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
'use strict';
// 114a（45 号文 §2 ①）：语音识别（ASR）配置地基的静态锁。纯静态，不起服务、不跑浏览器。
//   ① 两个 caps 取值域的隔离（45 号文 §1.2）：PROVIDER_MODEL_CAPS（05，模型能力标签 asr/embedding）
//      与 PLAYBOOK_REQUIRES（06，运行环境能力矩阵 network/desktopMcp/vision）同名不同物，
//      【不许互相引用】，06 里连 'asr' 字面量都不许出现。
//   ② CONFIG_SCHEMA 故意【不】因 114a 而 bump（45 号文 §6.1 对 26 号文的显式改判：纯增量 +
//      normalizeConfig 消毒 ⇒ 读回空即未配置，既有迁移分支处理的全是「旧值要改写」，这里没有旧值）。
//      常量本身是全仓共用的：107-T1 为 126-111b/d/e 的一次性迁移把它抬到了 12（46 号文 §5），
//      本条钉的是【当前值 + ASR 三键零迁移分支】，谁再动它先回来读 45 号文与 46 号文 §5。
//   ③ 后端落点：models[].caps 走 providerModelCaps 白名单；audioBaseUrl 与 baseUrl 同待遇
//      （trim + 截 400，不发明 URL 校验）；asrProviderId/asrModel 默认值 + 清洗（provider 没了两个一起清）。
//   ④ 前端落点：选择器只列 caps 含 asr 的模型；无候选也渲染（128f-⑭ 改判，修前是「整块不渲染」）并带「添加并启用」口；
//      选中即存 saveConfigPartial 部分补丁；分隔符 fromCharCode 构造（32 号文 §16-bis：源码零控制字符）。
//   ⑤ 双语键齐全；index.html 零静态 asr 标记；provider-settings.js 零控制字符。
// 反向：摘掉 PROVIDER_MODEL_CAPS 白名单（改成裸通过）→ failover.e2e.js 的 (C) 断言当场红并打出实得数组；
//       128f-⑭ 之后：把无候选那一支的「添加口」拿掉 → ④ 的那一条锚红（修前这里写的是「把无候选不渲染摘掉」，那条边界已被用户改判）。
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
// 130（51 号文）：白名单加 asr-stream（流式识别端点，只给麦克风用）；两个取值域仍不相交。
assert.match(src05, /const PROVIDER_MODEL_CAPS = new Set\(\['asr', 'embedding', 'asr-stream'\]\)/, '05: PROVIDER_MODEL_CAPS 白名单（asr/embedding/asr-stream）');
assert.match(src06, /const PLAYBOOK_REQUIRES = \['network', 'desktopMcp', 'vision'\]/, '06: PLAYBOOK_REQUIRES 取值域原样');
const capsModelDomain = ['asr', 'embedding', 'asr-stream'], capsRuntimeDomain = ['network', 'desktopMcp', 'vision'];
assert.ok(!capsModelDomain.some(v => capsRuntimeDomain.includes(v)), '两个 caps 取值域必须不相交');
assert.ok(!src06.includes('PROVIDER_MODEL_CAPS'), '06 不得引用模型能力标签域（PROVIDER_MODEL_CAPS）');
assert.ok(!src06.includes("'asr'") && !src06.includes('"asr"'), "06 不得出现 'asr' 字面量（串域）");
const mentions = src05.split('\n').filter(l => l.includes('PLAYBOOK_REQUIRES'));
assert.ok(mentions.length === 1 && /^\s*\/\//.test(mentions[0].trimStart()) || (mentions.length === 1 && mentions[0].trim().startsWith('//')), '05 只允许 114a 隔离注释点名 PLAYBOOK_REQUIRES 一次（不许代码引用）：实得 ' + mentions.length + ' 处');
// ② schema:114a 自己不 bump（45 号文 §6.1），但常量是全仓共用的 —— 107-T1 为了把 126-111b/d/e
//    三个开关的一次性迁移挂上阶梯，把它抬到了 12（46 号文 §5）。本条继续钉住【当前值】，好让
//    「谁又动了它」还是红的；判据同时钉住「ASR 三个键没有任何迁移分支」，那才是 114a 真正要守的。
//    128a 又把它抬到 13（稀疏落盘，48 号文 §2；13 本身不挂迁移）。
assert.match(src00, /const CONFIG_SCHEMA = 13;/, 'CONFIG_SCHEMA 当前为 13（114a 自己不 bump；11→12 是 107-T1 为 126-111b/d/e 迁移抬的，46 号文 §5；12→13 是 128a 稀疏落盘，48 号文 §2）');
assert.ok(!/incomingConfigSchema[^\n]*asr/i.test(src01) && !/asr(ProviderId|Model)[^\n]*incomingConfigSchema/i.test(src01),
  '114a 的 asrProviderId/asrModel 仍然没有任何 schema 迁移分支（纯增量：读回空串即「未配置」）');
// ③ 后端落点
assert.match(src05, /function providerModelCaps\(rawCaps\)/, '05: providerModelCaps 白名单清洗函数');
assert.match(src05, /const caps = providerModelCaps\(m\.caps\);/, '05: models 归一化走白名单');
// 107-S2：baseUrl 与 audioBaseUrl 一起多了一道「掩码永不落盘」的末闸（configUrlOrCleared）。本条锚点钉的
// 一直是「两者同待遇」，所以判据改成【两行同形】：谁单独改了包装，这一条就红。
assert.match(src05, /const audioBaseUrl = configUrlOrCleared\(str\(raw\.audioBaseUrl, 400\)\.trim\(\)\);/, '05: audioBaseUrl 仍是 trim + 截 400（外加 107-S2 的掩码末闸）');
assert.match(src05, /const mainBase = configUrlOrCleared\(str\(raw\.baseUrl, 400\)\.trim\(\)\);/, '05: audioBaseUrl 与 baseUrl 同待遇（同一个 400 截断 + 同一道 configUrlOrCleared 末闸）');
assert.match(src01, /asrProviderId: '',/, '01: asrProviderId 默认空（未配置）');
assert.match(src01, /asrModel: '',/, '01: asrModel 默认空（未配置）');
assert.match(src01, /for \(const key of \['asrProviderId', 'asrModel', 'asrStreamProviderId', 'asrStreamModel'\]\)/, '01: asr 形状清洗块（130 起连实时识别那一对一起洗）');
assert.match(src01, /if \(config\.asrStreamProviderId && !config\.providers\.some\(p => p && p\.id === config\.asrStreamProviderId\)\)/, '01: 实时识别指着的 provider 没了 → 两个一起清空');
assert.match(src01, /if \(config\.asrProviderId && !config\.providers\.some\(p => p && p\.id === config\.asrProviderId\)\)/, '01: provider 没了 → asr 两个一起清空');
// ④ 前端落点
assert.match(providersJs, /function renderAsrSettings\(\)/, '前端: renderAsrSettings 存在');
assert.match(providersJs, /caps\.includes\('asr'\)/, '前端: 只列 caps 含 asr 的模型');
// 128f-⑭（用户 2026-09-19 拍板 A）改判：修前「无候选整块不渲染（未配置 = 不可见）」，而界面上没有任何地方能把模型标成可语音识别
// —— 这一栏与输入框麦克风在正常安装里永远不出现。现在无候选也渲染：一句怎么办 ＋「添加语音识别模型」（添加并启用）。
assert.match(providersJs, /if \(!options\.length\) \{\n    block\.append\(label, roleHint, el\('p', 'field-help muted', t\('settings\.asr\.none'\)\), buildAsrAddRow\(\)\);/,
  '前端: 无候选也渲染这一栏（一句怎么办 ＋ 添加口），不再整块不渲染（130 起多一行「这一栏管校正」的说明）');
assert.match(providersJs, /const streamBlock = buildAsrStreamBlock\(\);/, '前端: 130 实时识别那一栏在同一处渲染（先出字的在前）');
assert.match(providersJs, /const saved = await saveConfigPartial\(\{ providers: providersNext, asrProviderId: providerId, asrModel: modelId \}\);/,
  '前端: 添加并启用 = 给那个模型加 asr 能力（没有就追加一条）＋ 选成语音识别模型，一次部分补丁');
// 2026-09-20（用户实报「保存了语音模型后，再点保存会消失」）：添加只写了 config、没并进弹窗里的 providersDraft，
// 底部「保存」把旧草稿整份盖回去 → caps:['asr'] 被抹掉。锁：同一处改动【并进】草稿（不是重播，别处没存的编辑不丢）。
assert.ok(providersJs.includes("if (saved && state.providersDraftSeeded === true && Array.isArray(state.providersDraft)) {\n    state.providersDraft = withAsrModel(state.providersDraft, providerId, modelId, protocol);"),
  '前端: 添加成功后把同一处改动并进 providersDraft（否则下一次整份保存会把它抹掉）');
// 同日「点了语音输入收不到字」：真因是百炼没有 /audio/transcriptions（上游 404）＋ 手填了 realtime 型号。
// 锁三件：添加行自带接口类型并按地址预选；realtime 型号当场拦下；上游 404 在输入框那头说成「接口类型不对」（见下方 voiceJs 段）。
// 同一个「消失」还有三条旁路（真浏览器 voice-setup V4d/V4e 抓到的真根因）：GET /api/models 合并清单时丢 caps、
// 前端把那份清单折回 state.config 时丢 caps、服务商卡片的手动模型清单一改就丢 caps。三处都按 id 把 caps 带上。
{
  const src13 = fs.readFileSync(path.join(APP, 'src', '13-http-router.js'), 'utf8');
  assert.ok(src13.includes('if (Array.isArray(caps) && caps.length) o.caps = caps.slice();') && src13.includes('add(m.id, m.label, m.contextLength, m.caps);'),
    '13: GET /api/models 合并时把配置里那条的 caps 带出去');
  // 第四条（用户真机的直接原因）：清单上限 100，百炼一刷新就满；追加在末尾的语音模型被「前 100 条」当场截掉。
  assert.ok(src05.includes('const marked = models.filter(m => m.caps);') && src05.includes('if (models.length > 100) {'),
    '05: 模型清单超限时先留带能力标记的条目（不是前 100 条）');
  assert.ok(providersJs.includes('models: keepModelCaps(fresh, p.models)'), '前端: 刷新清单折回 state.config 时保留 caps');
  assert.ok(providersJs.includes('p.models = keepModelCaps(models, p.models);'), '前端: 手动模型清单改动时保留 caps');
  // 2026-09-21（用户真机，第五条）：折回的是「名字清单」，手填的语音模型（百炼清单里没有的名字）不在里面 —— 修前 keepModelCaps
  // 只给 next 里有的条目补 caps，不在 next 里的带标记条目就地蒸发 → 候选没了 → 再添加、再折回，永远配不上。行为锁（真跑那个函数）：
  const fnSrc = providersJs.match(/function keepModelCaps\(next, previous\) \{[\s\S]*?\n\}/);
  assert.ok(fnSrc, '前端: keepModelCaps 存在');
  const keepModelCaps = new Function('return ' + fnSrc[0])();
  const fresh = Array.from({ length: 100 }, (_, i) => ({ id: 'm' + i, label: 'm' + i }));
  const kept = keepModelCaps(fresh, [...fresh.slice(0, 99), { id: 'qwen3-asr-flash', label: 'qwen3-asr-flash', caps: ['asr'] }]);
  assert.ok(kept.length === 101 && kept[100].id === 'qwen3-asr-flash' && kept[100].caps.includes('asr'), '前端: 折回名字清单时，不在清单里的带标记模型补回末尾');
  assert.ok(keepModelCaps(fresh, fresh).length === 100, '前端: 没有带标记的条目时原样返回');
  // 手动清单那条路是用户逐行删：删掉的带标记行不许被补回来（调用处按打出来的行再筛一遍）。
  assert.ok(providersJs.includes("p.models = p.models.filter(m => seen.has(String((m && m.id) || '')));"), '前端: 手动清单删掉的行就是删了（不被 keepModelCaps 补回）');
  // 同日第六条（日志 config_providers_shrunk lost:['toolbox-asr-shim']）：设置页整份保存带的是页面加载时的草稿快照，晚一两秒才自动
  // 接入的 toolbox- 服务商不在里面，一次保存就把它撤掉、语音识别选择随即被清空。锁两头：服务端以现值为准（改不了、造不出、撤不掉），
  // 前端弹窗开着时也把这几条照 config 同步进草稿。行为在 toolbox-discovery.e2e K1/K2 真跑。
  assert.ok(src13.includes('const owned = (Array.isArray(current.providers) ? current.providers : []).filter(isToolbox);') && src13.includes('merged.providers = [...foreign, ...owned];'),
    '13: applyConfigPatch 里 toolbox- 服务商以现值为准（自动发现所有的前缀）');
  assert.ok(providersJs.includes("} else if (Array.isArray(c.providers) && Array.isArray(state.providersDraft)) {"), '前端: fillSettings 弹窗开着时同步 toolbox- 服务商进草稿');
}
// 130（51 号文；用户拍板：校正默认静默替换、只做麦克风）：流式路的两个纯函数真跑。
{
  const voiceJs = fs.readFileSync(path.join(APP, 'public', 'js', 'composer-voice.js'), 'utf8');
  const pick = name => { const m = voiceJs.match(new RegExp('export function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}')); assert.ok(m, '前端: ' + name + ' 存在'); return new Function('return ' + m[0].replace(/^export /, ''))(); };
  const streamJoin = pick('streamJoin'), replaceStreamRegion = pick('replaceStreamRegion');
  assert.equal(streamJoin(['你好', '今天开会', 'pull request', 'now', '再见']), '你好今天开会pull request now再见', '前端: 句间只在拉丁字母／数字两侧加空格');
  assert.equal(streamJoin(['', 'a', '', 'b']), 'a b', '前端: 空句跳过');
  const r1 = replaceStreamRegion('前缀你好世界后缀', { start: 2, end: 6 }, '你好世界', '你好，世界。');
  assert.deepEqual(r1, { value: '前缀你好，世界。后缀', region: { start: 2, end: 8 } }, '前端: 那一段没被碰过 → 整段换成校正后的文本，区间跟着变');
  assert.equal(replaceStreamRegion('前缀你好世X后缀', { start: 2, end: 6 }, '你好世界', '你好，世界。'), null, '前端: 那一段被用户改过一个字 → 不动（静默替换只动没碰过的字）');
  assert.ok(voiceJs.includes("if (!text || text === item.text || s.session.discard) return;") && voiceJs.includes("if (!box || !streamReplace(s, box, item, text)) return;   // 那一句被用户碰过 → 一个字不动"),
    '前端: 第二遍回来相同／已取消 → 不替换；那一句被碰过 → 一个字不动（replaceStreamRegion 判）');
  assert.ok(voiceJs.includes("if (!composerVoiceConfigured(state && state.config)) return;   // 没配第二遍 = 不校正"), '前端: 没配整段识别就不跑第二遍');
  assert.ok(voiceJs.includes("catch { sx = null; try { notify(t('composer.voice.error.streamFallback'), ''); }"), '前端: 流式开不了 → 说一句、回落按停顿切段');
  for (const [name, dict] of [['zh-CN', zh], ['en-US', en]]) {
    for (const k of ['settings.asrStream.title', 'settings.asrStream.disabled', 'settings.asrStream.hintSet', 'settings.asrStream.hintUnset', 'settings.asrStream.none', 'settings.asr.roleHint', 'composer.voice.hintStream', 'composer.voice.streaming', 'composer.voice.error.streamFallback']) {
      assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, name + ' 缺键 ' + k);
    }
  }
}
assert.ok(providersJs.includes('const saved = await addAsrModel(providerId, modelId, protocolSelect.value);'), '前端: 添加行把接口类型一起写进去');
assert.ok(providersJs.includes('/dashscope\\.aliyuncs\\.com|xiaomimimo\\.com/.test(base)'), '前端: 百炼／MiMo 预选对话型（实测 Whisper 形 404）');
assert.ok(providersJs.includes("if (/realtime/i.test(modelId)) { toast(t('settings.asr.addRealtime'), 'err');"), '前端: realtime 型号当场拦下');
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

// ⑥ 127-⑦ B-114c-①（45 号文 §4 ⑦ / §1.5）：输入框麦克风。
//   ⑥a 真浏览器件的无头 Edge 启动参数【必须】带两个假媒体开关 —— §1.5 A 组实证：不加就是
//      NotFoundError（拿不到设备），以后谁「顺手清理启动参数」都会把那件清成永远红，而且红得像产品坏了。
//      判的是 spawn 浏览器那一个参数数组本身（不是文件里哪儿出现过这两个词），并点名文件。
//   ⑥b 显示判据四件（asr 两字段／安全上下文／mediaDevices／webm-opus）、3 分钟上限、上传覆盖 content-type、
//      零静态标记、模块引用的每个 composer.voice.* 键四份 locale 都能解析、模块零控制字符。
// 反向：从 composer-voice.browser.e2e.js 的启动参数里删掉任一开关 → ⑥a 当场红并打出文件名与实得数组。
const HARNESS = __dirname;
const VOICE_E2E = 'composer-voice.browser.e2e.js';
const voiceE2e = fs.readFileSync(path.join(HARNESS, VOICE_E2E), 'utf8');
const browserSpawn = voiceE2e.match(/browser = cp\.spawn\(executable, \[([\s\S]*?)\], \{/);
assert.ok(browserSpawn, VOICE_E2E + ': 找不到 `browser = cp.spawn(executable, [...]` 那一处启动参数数组（锁的扫描面失效）');
const launchArgs = [...browserSpawn[1].matchAll(/'(--[^']+)'/g)].map(m => m[1]);
assert.ok(launchArgs.includes('--headless=new') && launchArgs.length >= 8, VOICE_E2E + ': 启动参数数组读不全（实得 ' + JSON.stringify(launchArgs) + '）');
for (const flag of ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']) {
  assert.ok(launchArgs.includes(flag), VOICE_E2E + ' 的无头 Edge 启动参数缺 ' + flag + '（45 号文 §1.5：不加就是 NotFoundError）；实得 ' + JSON.stringify(launchArgs));
}
const voiceJs = fs.readFileSync(path.join(APP, 'public', 'js', 'composer-voice.js'), 'utf8');
assert.match(voiceJs, /export const COMPOSER_VOICE_MIME = 'audio\/webm;codecs=opus';/, 'composer-voice: 唯一录制格式 webm/opus（§1.5：wav 录不了）');
assert.match(voiceJs, /export const COMPOSER_VOICE_MAX_MS = 3 \* 60 \* 1000;/, 'composer-voice: 录满 3 分钟自动结束');
assert.match(voiceJs, /String\(config\.asrProviderId \|\| ''\)\.trim\(\) \|\| !String\(config\.asrModel \|\| ''\)\.trim\(\)/, 'composer-voice: 显示判据含 asrProviderId && asrModel');
assert.match(voiceJs, /env\.isSecureContext !== true/, 'composer-voice: 显示判据含安全上下文');
assert.match(voiceJs, /nav\.mediaDevices/, 'composer-voice: 显示判据含 navigator.mediaDevices');
assert.match(voiceJs, /Recorder\.isTypeSupported\(COMPOSER_VOICE_MIME\)/, 'composer-voice: 显示判据含 isTypeSupported(webm/opus)');
// 107-A1：上传类型不再是常量，而是「转码成了就 audio/wav、没成就回退 audio/webm」这一对（见 ⑦d）。
// 钉的仍是同一件事：必须覆盖 apiRaw 默认的 JSON content-type，否则服务端 400 asr.content_type。
assert.match(voiceJs, /const uploadType = wav \? COMPOSER_VOICE_WAV_TYPE : COMPOSER_VOICE_UPLOAD_TYPE;/, 'composer-voice: 上传 content-type 二选一（wav／回退 webm）');
assert.match(voiceJs, /headers: \{ 'content-type': uploadType \}/, 'composer-voice: 上传覆盖 apiRaw 默认的 JSON content-type（否则 400 asr.content_type）');
assert.ok(!/composerVoice|composer-voice/.test(indexHtml), 'index.html 零静态麦克风标记（未配置 DOM 零漂移）');
const voiceKeys = [...new Set([...voiceJs.matchAll(/'(composer\.voice\.[a-zA-Z.]+)'/g)].map(m => m[1]))];
const docsZh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'i18n', 'locales', 'zh-CN.json'), 'utf8'));
const docsEn = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'i18n', 'locales', 'en-US.json'), 'utf8'));
assert.ok(voiceKeys.length >= 15, 'composer-voice 引用的 composer.voice.* 键扫得到（实得 ' + voiceKeys.length + '）');
for (const [name, dict] of [['app zh-CN', zh], ['app en-US', en], ['docs zh-CN', docsZh], ['docs en-US', docsEn]]) {
  const holes = voiceKeys.filter(k => typeof dict[k] !== 'string' || !dict[k]);
  assert.deepEqual(holes, [], name + ' 缺 composer.voice.* 键');
}
const voiceBad = [...voiceJs].findIndex(ch => { const code = ch.charCodeAt(0); return code < 32 && code !== 9 && code !== 10; });
assert.equal(voiceBad, -1, 'composer-voice.js 含控制字符／CR @' + voiceBad);

// ⑦ 107-A1（46 号文 §5 A1；45 号文 §9.6.3 真机实测）：语音识别【协议】适配的机械锁。
//   ⑦a provider 级开关只落合法值、空不落字段（存量 config 零漂移，与 audioBaseUrl 同模具）；
//   ⑦b 出站真的分叉（chat-audio 打 /chat/completions + input_audio data URI），且 usage 按
//      prompt_tokens/completion_tokens 映射（chat 回体没有 input_tokens —— 抄错就永远落估算）；
//   ⑦c 安全性质仍在【同一支】上：目标 URL 只来自配置、错误体先脱敏再裁 1000、120s 超时、8KB 回体；
//   ⑦d 浏览器端【无条件】转 WAV，且前端不许知道 provider 配的是哪种协议（知道了就会长出第二条分叉）；
//   ⑦e 设置页有选择器、缺省值 delete 不落字段、双语键齐全。
// 反向：把 ⑦b 的分叉改成永远走 transcriptions → asr-transcribe.e2e.js H2 红；把 ⑦d 的转码摘掉 →
//   composer-voice.browser.e2e.js ①c/c2 红（请求体退回 EBML 魔数）。
assert.match(src05, /const asrProtocol = raw\.asrProtocol === 'chat-audio' \? 'chat-audio' : '';/, '05: asrProtocol 只落合法值（⑦a）');
assert.match(src05, /\.\.\.\(asrProtocol \? \{ asrProtocol \} : \{\}\), \/\/ 107-A1/, '05: asrProtocol 空不落字段（⑦a 零漂移）');
assert.match(src05, /const chatAudio = provider\.asrProtocol === 'chat-audio';/, '05: 转写出站按协议分叉（⑦b）');
assert.match(src05, /target = base \+ '\/chat\/completions';/, "05: chat-audio 打 /chat/completions（⑦b）");
assert.match(src05, /type: 'input_audio', input_audio: \{ data: 'data:' \+ mime \+ ';base64,'/, '05: chat-audio 用 input_audio data URI（⑦b）');
assert.match(src05, /const realIn = chatAudio \? pick\('prompt_tokens', 'input_tokens'\)/, '05: chat 回体 usage 映射 prompt_tokens（⑦b）');
assert.match(src05, /const realOut = chatAudio \? pick\('completion_tokens', 'output_tokens'\)/, '05: chat 回体 usage 映射 completion_tokens（⑦b）');
{
  // ⑦c 安全与记账性质【只有一份】：这些行必须落在两条协议都会经过的公共段里，不许某一支独有。
  const fn = src05.slice(src05.indexOf('async function transcribeAudioViaProvider('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.ok(body.includes("const base = providerBaseWithV1(provider.audioBaseUrl || provider.baseUrl);"), '05: 目标 URL 只来自配置（⑦c）');
  assert.equal((body.match(/AbortSignal\.timeout\(120000\)/g) || []).length, 1, '05: 120s 超时只有一处（⑦c 两协议共用）');
  assert.equal((body.match(/if \(upstreamText\.length > 8192\) upstreamText = upstreamText\.slice\(0, 8192\);/g) || []).length, 1, '05: 8KB 回体上限只有一处（⑦c）');
  assert.equal((body.match(/const snippet = redact\(/g) || []).length, 1, '05: 上游错误体脱敏只有一处（⑦c）');
  assert.match(body, /redact\(upstreamText\.replace\([^)]*\)\)\.slice\(0, 1000\)/, '05: 顺序仍是【先脱敏再裁 1000】（⑦c，107-S1 的教训）');
  assert.equal((body.match(/kind: 'aux', note: 'asr'/g) || []).length, 1, "05: 记账 kind:'aux' note:'asr' 只有一处（⑦c）");
  for (const code of ['asr.upstream_unreachable', 'asr.upstream', 'asr.bad_response']) {
    assert.ok(body.includes("code: '" + code + "'"), '05: 错误码 ' + code + ' 沿用（⑦c）');
  }
}
// ⑦d 浏览器端无条件转 WAV（不看协议）
assert.match(voiceJs, /export const COMPOSER_VOICE_SAMPLE_RATE = 16000;/, 'composer-voice: 目标采样率 16 kHz（⑦d）');
assert.match(voiceJs, /export async function encodeVoiceWav\(blob, env = globalThis\)/, 'composer-voice: WAV 转码函数（⑦d）');
assert.match(voiceJs, /const wav = await encodeVoiceWav\(blob\);/, 'composer-voice: 上传前无条件转码（⑦d）');
assert.ok(voiceJs.includes("if (info && info.code === 'asr.upstream' && (status === 404 || status === 405)) return 'composer.voice.error.protocol';"),
  'composer-voice: 上游 404/405 说成「接口类型不对」，不是「稍后再试」（再试一万次也是 404）');
// 只做语音的服务商不进【对话】候选（用户 2026-09-21 拍板；起因是 ruyi-toolbox 的本地语音识别被自动接成一个服务商）。
// 判据只有一份事实源 util.js 的 isSpeechOnlyProvider；onboarding-wizard.js 锁死零 import，放的是【逐字相同】的副本。
{
  const js = name => fs.readFileSync(path.join(APP, 'public', 'js', name), 'utf8');
  const fnBody = src => { const m = src.match(/function isSpeechOnlyProvider\(provider\) \{\n[\s\S]*?\n\}\n/); return m ? m[0] : ''; };
  const stateJs = js('util.js'), wizardJs = js('onboarding-wizard.js');
  assert.ok(fnBody(stateJs) && fnBody(stateJs) === fnBody(wizardJs), 'isSpeechOnlyProvider: util.js 与 onboarding-wizard.js 两份函数体一字不差（改一处必须改另一处）');
  assert.ok(fnBody(stateJs).includes("models.length > 0 && models.every(m => m && typeof m === 'object' && Array.isArray(m.caps) && m.caps.includes('asr'))"),
    'isSpeechOnlyProvider: 判据＝模型清单非空且每个模型都带语音识别标记（混用的服务商不受影响）');
  assert.ok(wizardJs.includes('asArray(c.providers).filter(p => p && !isSpeechOnlyProvider(p))'), '新手向导:「已有对话引擎」不把只做语音的服务商算进去');
  for (const [file, needle, label] of [
    ['navigation-controls.js', 'for (const p of chatProviders(state.config)) {', '命令面板的引擎／模型候选'],
    ['navigation-controls.js', 'for (const provider of chatProviders(state.config)) {', '压缩模型选择器'],
    ['steward-chips.js', 'for (const provider of chatProviders(config())) {', '线程头引擎菜单'],
    ['agent-roles.js', 'const providers = chatProviders(state.config);', '子代理首选端点'],
    ['steward-settings.js', 'const providers = chatProviders(config());', '管家端点选择'],
    ['session-experience.js', 'const providers = chatProviders(state.config);', '起始页「已有对话引擎」判断'],
    ['steward-conversation.js', 'const providers = chatProviders(state && state.config);', '管家「取第一个端点」兜底'],
  ]) assert.ok(js(file).includes(needle), '只做语音的服务商不进对话候选: ' + label + '（' + file + '）');
  // 反向:语音识别自己的选择器不许被这条过滤掉 —— 它列的正是这些模型。
  assert.ok(!/asrCapableOptions[\s\S]{0,400}chatProviders/.test(providersJs), '语音识别选择器仍按 caps 含 asr 列候选,不经 chatProviders');
}
// ⑨ 边说边出字（用户 2026-09-20 拍板方案一「按停顿切段」）。锁的是【费用形状】与【退路】：每段一只录音器、先起新的再停旧的
// （切口不丢声）；一次录音的各段走同一条 Promise 链按序落字；不够 SEGMENT_MIN 不切（短录音与从前逐字节相同）；
// 宿主没有 AudioContext 就不切。行为本身由 composer-voice.browser 的 S1–S8 在真浏览器里钉。
assert.match(voiceJs, /export const COMPOSER_VOICE_PAUSE_MS = 700;/, 'composer-voice: 停顿 700ms 算一句说完');
assert.match(voiceJs, /export const COMPOSER_VOICE_SEGMENT_MIN_MS = 2000;/, 'composer-voice: 一段至少 2s 才切（既有短录音测试的「恰好一发请求」靠它）');
assert.ok(voiceJs.includes('try { startSegment(session); } catch { return; }') && voiceJs.indexOf('try { startSegment(session); } catch { return; }') < voiceJs.indexOf("try { old.stop(); } catch { /* 旧录音器已经停了 */ }"),
  'composer-voice: 切段时先起新录音器、再停旧的（切口不丢声）');
assert.ok(voiceJs.includes('session.queue = session.queue.then(() => transcribeSegment(session, blob));'), 'composer-voice: 各段排一条队，字按说话顺序落进输入框');
assert.ok(voiceJs.includes('const skip = silent && (!last || session.sent > 0);'), 'composer-voice: 静音段不出网（整次唯一的一段除外）');
assert.ok(!/setInterval\([^)]*request|while \(.*recording/.test(voiceJs), 'composer-voice: 没有「每隔几秒把整段重发」的轮询式转写');
assert.ok(voiceJs.includes("try { notify(t(key), 'err'); }"), 'composer-voice: 失败原因用看得见的 toast 说出来（修前只在悬停提示与读屏播报里）');
assert.ok(src05.includes("logEvent({ kind: 'asr_transcribe_failed', code: failure.code,"), '05: 转写失败落日志（修前本地运行记录里零痕迹）');
assert.match(voiceJs, /const upload = wav \|\| blob;/, 'composer-voice: 转码失败原样发 webm（⑦d 回退）');
{
  // ⑦d 的要害是【代码】不许读协议（注释里说清楚「为什么无条件转」反而是要留的）。所以判的是
  // 非注释行：谁哪天写了 if (config.asrProtocol === …) 才红，改注释措辞不会误伤。
  const codeUse = voiceJs.split('\n').filter(l => l.includes('asrProtocol') && !l.trimStart().startsWith('//'));
  assert.deepEqual(codeUse, [], 'composer-voice 的代码不许读 provider 协议（⑦d：知道了就会长出第二条分叉）');
}
// ⑦e 设置页
assert.match(providersJs, /ac\.value = p\.asrProtocol === 'chat-audio' \? 'chat-audio' : 'transcriptions';/, '前端: provider 卡片有协议选择器（⑦e）');
assert.match(providersJs, /if \(ac\.value === 'chat-audio'\) p\.asrProtocol = 'chat-audio'; else delete p\.asrProtocol;/, '前端: 缺省值 delete 不落字段（⑦e）');
for (const [name, dict] of [['zh-CN', zh], ['en-US', en]]) {
  for (const k of ['provider.asrProtocol', 'provider.asrProtocol.transcriptions', 'provider.asrProtocol.chatAudio', 'provider.asrProtocol.hint']) {
    assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, name + ' 缺键 ' + k + '（⑦e）');
  }
}

console.log('ASR CONFIG UI STATIC E2E: ALL PASS');
