'use strict';
// 「渲染 + 遮盖」的接缝:MediaImageHooks.prepareRenderedPages。
// 顺序固定(会话 → 策略 → 收件人 → 处理器),任何一步不满足都必须 fail-closed —— 尤其不能把原始像素交回。
// 本机没有媒体运行时组件,所以"处理器"这一步通常得到 privacy.image_processor_dependency_failed;
// 装了组件的机器则应当拿到受保护引用。用例两种都接受,但绝不接受"静默成功却没有引用"或"回了原始像素"。
//
// 注意:接缝内部会重新 readConfig() 并 assertPolicyAvailable,所以夹具必须把同一份策略写进 config.json
// (只 configure 内存对象会得到 privacy.policy_changed —— 2026-11-05 第一版就这么踩过)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rendered-prepare-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const vision = flag => ({ id: 'v', label: 'V', type: 'openai-compat', baseUrl: 'https://api.example.invalid', apiKey: 'k', model: 'm', vision: flag });
const base = () => ({ configSchema: 14, privacyModeV1: 'enhanced', credentialEncryptionV1: true,
  autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, providers: [vision(true)], activeProvider: 'v',
  workspace: root, defaultWorkspace: root, recentWorkspaces: [root] });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(base()));
const app = require('../lib/server-internals').loadServerInternals(['MediaImageHooks', 'PrivacyGateway', 'PrivacyCore', 'readConfig', 'mutateConfig']);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 0x5a)]);
const rendered = () => [{ name: 'page-1.png', bytes: PNG }];
async function syncPolicy(patch) {
  await app.mutateConfig(current => { Object.assign(current, patch); return {}; });
  const config = await app.readConfig();
  app.PrivacyGateway.configure(config);
  return config;
}
const call = (sessionId, config) => app.PrivacyGateway.run(sessionId, config, () => app.MediaImageHooks.prepareRenderedPages({ sessionId, pages: rendered() }));

test('输入形状先拦:空页 / 非 Buffer / 空名字 / 超限都算 render_invalid', async () => {
  await syncPolicy({ privacyModeV1: 'enhanced', providers: [vision(true)] });
  for (const pages of [[], [{ name: 'x.png', bytes: 'not-a-buffer' }], [{ name: '', bytes: PNG }],
    [{ name: 'x.png', bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }], 'nope']) {
    await assert.rejects(app.MediaImageHooks.prepareRenderedPages({ sessionId: 'sess_render', pages }),
      error => error.code === 'privacy.image_render_invalid', String(typeof pages === 'string' ? pages : pages.length));
  }
});

test('保护关着 → protection_disabled(不许绕过遮盖直接给像素)', async () => {
  const config = await syncPolicy({ privacyModeV1: 'off' });
  await assert.rejects(call('sess_render', config), error => error.code === 'privacy.image_protection_disabled');
});

test('没有 vision 能力 → vision_required(收件人不能凭空定)', async () => {
  const config = await syncPolicy({ privacyModeV1: 'enhanced', providers: [vision(false)] });
  await assert.rejects(call('sess_render', config), error => error.code === 'privacy.image_vision_required');
});

test('vision provider:要么给受保护引用,要么在处理器缺席时 fail-closed', async () => {
  const config = await syncPolicy({ privacyModeV1: 'enhanced', providers: [vision(true)] });
  let outcome;
  try {
    outcome = await call('sess_render', config);
  } catch (error) {
    // 本机没有媒体运行时组件:必须是一个明确的依赖缺席,而不是"回原始像素"或别的错。
    // 注意这条用例在没装组件的机器上【只】验到 fail-closed;成功分支的形状断言要装组件才会真的跑。
    assert.equal(error.code, 'privacy.image_processor_dependency_failed', 'got ' + error.code);
    return;
  }
  assert.deepEqual(Object.keys(outcome).sort(), ['recipient', 'references'], '成功分支只许回引用与收件人');
  assert.ok(Array.isArray(outcome.references) && outcome.references.length === 1);
  assert.match(outcome.references[0].reference, /^https:\/\/ruyi\.invalid\/protected-image\/[a-f0-9]{32}$/);
  // 判别力:Buffer 序列化成 {"type":"Buffer","data":[...]};若谁把 page.bytes 带回来,这里必红。
  const serialized = JSON.stringify(outcome);
  assert.equal(serialized.includes('"type":"Buffer"'), false, '结果里不许出现原始像素(Buffer)');
  assert.equal(serialized.includes('"data":[137,80,78,71]'), false, '结果里不许出现 PNG 头字节');
});

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
