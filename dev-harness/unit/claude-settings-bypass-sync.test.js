// Unit(第二波安全走查 S9):切到「全自动」(bypass)不再把用户全局 ~/.claude/settings.json 写成 permissions.defaultMode:'bypassPermissions'。
//
// 修前:POST /api/config {permissionMode:'bypass',confirm:true} 之后 syncClaudeCliSettings 无条件把 defaultMode 写成 bypassPermissions —— 所有脱离
// 如意的独立 claude 会话都被无声放宽成免问,直到用户手动切回。如意自己的 Claude 回合每回合已带 --permission-mode(05),全局键并不需要。
// 修后:如意档位是 bypass 时同步【不写】这个值;若这个键是如意先前写的(sidecar 记账:defaultMode = 上次我们写的值,defaultModePrior = 写之前用户自己的值)
// 就撤回成 prior / 删掉;不是我们写的(用户自己改过 / 老版本留下分不出来)一律原样不碰。其余档位的同步行为不变。
//
// 反向验证:RUYI_TEST_SERVER_JS=<修前 server.js> node --test 本文件 → bypass 相关断言红。
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-settings-bypass-'));
const home = path.join(root, 'home');
const data = path.join(home, '.ruyi-workbench');
fs.mkdirSync(data, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.RUYI_HOME = data;
process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
const { loadServerInternals } = require('../lib/server-internals');
const { syncClaudeCliSettings } = loadServerInternals(['syncClaudeCliSettings']);
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const claudeDir = path.join(home, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const sidecarPath = path.join(data, 'claude-settings-sync.json');
const reset = () => { fs.rmSync(claudeDir, { recursive: true, force: true }); fs.rmSync(sidecarPath, { force: true }); fs.mkdirSync(claudeDir, { recursive: true }); };
const settings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const sidecar = () => JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
const cfg = (permissionMode, extra) => ({ permissionMode, model: '', thinkingBudget: 0, configExplicitKeysV1: ['permissionMode'], ...(extra || {}) });

test('[1] 全新:bypass 不写 defaultMode(settings 里没有 bypassPermissions),sidecar 记我们不拥有它', async () => {
  reset();
  await syncClaudeCliSettings(cfg('bypass'));
  const s = settings();
  assert.notEqual(s.permissions && s.permissions.defaultMode, 'bypassPermissions', JSON.stringify(s));
  assert.equal(s.permissions && s.permissions.defaultMode, undefined);
  assert.equal(sidecar().defaultMode, null);
  await syncClaudeCliSettings(cfg('bypassPermissions'));   // CLI 原生名也认
  assert.equal(settings().permissions && settings().permissions.defaultMode, undefined);
});

test('[2] 其余档位照旧同步(default / acceptEdits / plan / auto)', async () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) {
    reset();
    await syncClaudeCliSettings(cfg(mode));
    assert.equal(settings().permissions.defaultMode, mode, mode);
    assert.equal(sidecar().defaultMode, mode);
  }
});

test('[3] 先同步过 default、再切 bypass:撤回我们写的键(之前没有 → 整个 permissions 空了就一并删掉);切回 default 又写回', async () => {
  reset();
  await syncClaudeCliSettings(cfg('default'));
  assert.equal(settings().permissions.defaultMode, 'default');
  assert.deepEqual({ d: sidecar().defaultMode, p: sidecar().defaultModePrior }, { d: 'default', p: null });
  await syncClaudeCliSettings(cfg('bypass'));
  assert.equal(Object.prototype.hasOwnProperty.call(settings(), 'permissions'), false, JSON.stringify(settings()));
  assert.equal(sidecar().defaultMode, null);
  await syncClaudeCliSettings(cfg('default'));
  assert.equal(settings().permissions.defaultMode, 'default');
});

test('[4] 用户自己原有的 defaultMode:我们覆盖时记下 prior,切 bypass 时撤回到用户自己的值;permissions 里别的键(allow)全程保留', async () => {
  reset();
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(npm test)'], defaultMode: 'acceptEdits' }, env: { MY_VAR: '1' } }));
  await syncClaudeCliSettings(cfg('auto'));
  assert.equal(settings().permissions.defaultMode, 'auto');
  assert.deepEqual({ d: sidecar().defaultMode, p: sidecar().defaultModePrior }, { d: 'auto', p: 'acceptEdits' });
  await syncClaudeCliSettings(cfg('plan'));   // 连续同步:prior 不被我们自己写的值冲掉
  assert.deepEqual({ d: sidecar().defaultMode, p: sidecar().defaultModePrior }, { d: 'plan', p: 'acceptEdits' });
  await syncClaudeCliSettings(cfg('bypass'));
  const s = settings();
  assert.equal(s.permissions.defaultMode, 'acceptEdits', '撤回到用户自己原来的值');
  assert.deepEqual(s.permissions.allow, ['Bash(npm test)']);
  assert.equal(s.env.MY_VAR, '1');
  assert.equal(sidecar().defaultMode, null);
});

test('[5] 用户在我们写完之后自己改过 defaultMode:切 bypass 原样不碰', async () => {
  reset();
  await syncClaudeCliSettings(cfg('default'));
  const s = settings(); s.permissions.defaultMode = 'plan';
  fs.writeFileSync(settingsPath, JSON.stringify(s));
  await syncClaudeCliSettings(cfg('bypass'));
  assert.equal(settings().permissions.defaultMode, 'plan');
  assert.equal(sidecar().defaultMode, null);
});

test('[6] 老版本留下的 bypassPermissions(sidecar 没记 defaultMode,分不出是谁写的):bypass 档下原样不碰,不误删用户可能自己设的值', async () => {
  reset();
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  fs.writeFileSync(sidecarPath, JSON.stringify({ model: null, maxThinkingTokens: null }));
  await syncClaudeCliSettings(cfg('bypass'));
  assert.equal(settings().permissions.defaultMode, 'bypassPermissions');
  // 之后用户把如意切到别的档:照旧覆盖(同步行为不变),并从此有权属记录
  await syncClaudeCliSettings(cfg('default'));
  assert.equal(settings().permissions.defaultMode, 'default');
  assert.equal(sidecar().defaultMode, 'default');
  assert.equal(sidecar().defaultModePrior, 'bypassPermissions', 'prior 记的是同步前的值(此处是旧版留下的 bypassPermissions)');
  // 再切回 bypass:撤回我们写的 default,但【不】把 prior 里的 bypassPermissions 写回去(写回 = 又放宽独立 claude 会话),直接删键
  await syncClaudeCliSettings(cfg('bypass'));
  assert.equal(settings().permissions && settings().permissions.defaultMode, undefined, JSON.stringify(settings()));
});

test('[7] 用户没选过档位(出厂值):不碰 defaultMode,已有权属记录带下去;bypass 出厂值同样不写', async () => {
  reset();
  await syncClaudeCliSettings({ permissionMode: 'auto', model: '', thinkingBudget: 0, configExplicitKeysV1: [] });
  assert.equal(settings().permissions, undefined);
  await syncClaudeCliSettings({ permissionMode: 'bypass', model: '', thinkingBudget: 0, configExplicitKeysV1: [] });
  assert.equal(settings().permissions, undefined);
  // 有权属记录时,非显式同步不丢它
  reset();
  await syncClaudeCliSettings(cfg('plan'));
  await syncClaudeCliSettings({ permissionMode: 'auto', model: '', thinkingBudget: 0, configExplicitKeysV1: [] });
  assert.equal(settings().permissions.defaultMode, 'plan');
  assert.equal(sidecar().defaultMode, 'plan');
});

test('[8] model / MAX_THINKING_TOKENS 的权属记账不受影响', async () => {
  reset();
  await syncClaudeCliSettings(cfg('bypass', { model: 'm-x', thinkingBudget: 4000 }));
  assert.equal(settings().model, 'm-x');
  assert.equal(settings().env.MAX_THINKING_TOKENS, '4000');
  assert.deepEqual({ m: sidecar().model, t: sidecar().maxThinkingTokens }, { m: 'm-x', t: '4000' });
  await syncClaudeCliSettings(cfg('bypass'));
  assert.equal(settings().model, undefined, '我们写的 model 仍可撤回');
  assert.equal(settings().env && settings().env.MAX_THINKING_TOKENS, undefined);
});
