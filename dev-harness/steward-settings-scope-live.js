'use strict';
// 显式运行才读取本机配置。只复制选中的 DeepSeek 端点到隔离家目录，结束清理当前配置和备份中的凭据。
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { readLocalConfig } = require('./lib/local-provider-key');
const source = readLocalConfig();
const provider = source.config?.providers?.find(p => p.apiKey && /deepseek/i.test([p.label, p.baseUrl, p.model].join(' ')));
if (!provider) { console.log('SKIP: configured DeepSeek provider unavailable'); process.exit(0); }
const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source.file)).digest('hex');
require('./lib/self-isolate-home');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD SETTINGS SCOPE LIVE'); const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-settings-scope-live-'));
const home = path.join(root, 'home'), work = path.join(root, 'work');
fs.mkdirSync(home); fs.mkdirSync(work);
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ providers: [provider], activeProvider: provider.id, stewardProviderId: provider.id, stewardModel: provider.model,
  defaultWorkspace: work, recentWorkspaces: [work], includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, stewardEnabledV1: true,
  permissionMode: 'default', questionTimeoutMs: 240000, newThreadEngine: 'last', lastUsedEngineRoute: { engine: 'openai', providerId: provider.id, model: provider.model } }));
const s = loadServerInternals(['runStewardTurn', 'readConfig', 'createSession']);
const checks = { model: provider.model };
const defaults = config => JSON.stringify([config.activeProvider, config.model, config.newThreadEngine, config.lastUsedEngineRoute, config.providers]);
(async () => {
  const watchdog = setTimeout(() => { console.log('FAIL live timeout'); cleanup(); process.exit(1); }, 240000);
  function cleanup() {
    for (const name of ['config.json', 'config.json.prev']) {
      const file = path.join(home, name);
      if (!fs.existsSync(file)) continue;
      const config = JSON.parse(fs.readFileSync(file, 'utf8')); config.providers = []; config.activeProvider = ''; fs.writeFileSync(file, JSON.stringify(config));
    }
  }
  try {
    const first = await s.runStewardTurn({ trigger: 'user', message: '把如意的提问等待时长 questionTimeoutMs 改成 360000 毫秒（6分钟），范围是应用设置。不要改权限，不要新建任务。先读取当前值并用 expected 校验后保存，按真实 receipt 说明范围和生效时机。' });
    const receipt = first.actions?.find(row => row.tool === 'steward_config_set' && row.result?.ok)?.result;
    checks.waitSaved = (await s.readConfig()).questionTimeoutMs === 360000;
    checks.actualReceipt = receipt?.receipt?.changes?.some(change => change.key === 'questionTimeoutMs' && change.value === 360000 && change.effective === 'next_wait') === true;
    ok(checks.waitSaved && checks.actualReceipt, '真实模型读取并修改等待时长，回包带真实范围/值/下次等待时机');
    const task = await s.createSession({ title: '隔离模型验证任务', cwd: work });
    const before = defaults(await s.readConfig());
    const second = await s.runStewardTurn({ trigger: 'user', message: '只把「隔离模型验证任务」这条任务换模型，仅此任务，后续新任务默认保持不变。请打开这条任务的模型入口，由我手选，不要改全局设置，也不要替我选强弱。' });
    checks.threadNavigation = second.acts?.some(act => act.kind === 'open_thread' && act.sessionId === task.id) === true;
    checks.threadTiming = /下一回合|下个回合/.test(second.say || '') && !/选中即生效|立即生效/.test(second.say || '');
    checks.defaultsUnchanged = defaults(await s.readConfig()) === before;
    ok(checks.threadNavigation && checks.defaultsUnchanged, '真实模型导航到准确任务，未用全局设置模拟线程模型');
    ok(checks.threadTiming, '真实模型说明从下一回合使用，不声称在途执行已切换');
    const cap = (await s.readConfig()).stewardNotifyPerHour;
    const third = await s.runStewardTurn({ trigger: 'user', message: '减少普通提醒，但错误提醒必须保留。现有能力做不到就明确告诉我并询问具体范围；不改权限，也不关闭所有通知。' });
    checks.notificationBounded = (await s.readConfig()).stewardNotifyPerHour === cap && !third.actions?.some(row => row.tool === 'steward_config_set' && row.result?.ok);
    ok(checks.notificationBounded, '真实模型没有把总频率上限冒充为按类型保留错误提醒');
    checks.sourceUnchanged = crypto.createHash('sha256').update(fs.readFileSync(source.file)).digest('hex') === sourceHash;
    ok(checks.sourceUnchanged, '本机原配置逐字节不变');
    fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({ ...checks, pass: t.failures === 0, replies: [first.say, second.say, third.say] }, null, 2));
    console.log('ARTIFACTS ' + root);
  } catch { t.fail('live run failed; no credentials printed'); }
  finally { clearTimeout(watchdog); cleanup(); t.done({ exit: true }); }
})();
