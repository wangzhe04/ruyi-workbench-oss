'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD SETTINGS SCOPE'); const { ok } = t;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-settings-scope-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ stewardEnabledV1: true, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, defaultWorkspace: home,
  activeProvider: 'fake', providers: [{ id: 'fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-secret', model: 'base' }], newThreadEngine: 'last', lastUsedEngineRoute: { engine: 'openai', providerId: 'fake', model: 'base' } }));
const s = loadServerInternals(['readConfig', 'ConfigPatchHooks', 'mutateConfig', 'createSession', 'loadSession', 'saveSession', 'updateSessionMeta', 'stewardDecisionsRead', 'stewardDecisionChain', 'activeChildren'], { withEval: true });
const ctx = { sessionId: 'steward', session: { id: 'steward', kind: 'steward', providerHistory: [] } };
const call = args => s.__eval('StewardHooks.configSet')(args, ctx);
(async () => {
  try {
    const { settingsReceiptOf } = await import(require('url').pathToFileURL(path.resolve(__dirname, '../ruyi-workbench/app/public/js/steward-settings-receipt.js')));
    ok(!settingsReceiptOf({ ok: true, receipt: { kind: 'settings', object: 'ruyi', changes: [null] } }) && !settingsReceiptOf({ ok: false, receipt: { kind: 'settings', object: 'ruyi', changes: [{ key: 'theme', value: 'dark', scope: 'application', effective: 'next_read' }] } }), '破损历史或失败结果不能伪造结构化成功回执');
    const get = await s.__eval('StewardHooks.configGet')({ keys: ['questionTimeoutMs', 'permissionMode', 'stewardModel', 'newThreadEngine'] }, ctx);
    ok(get.settings.questionTimeoutMs.effective === 'next_wait' && get.settings.permissionMode.scope === 'defaults' && get.settings.stewardModel.scope === 'steward', '读取时逐键说明等待、缺省权限和管家自己的范围');
    const first = await call({ patch: { questionTimeoutMs: 360000 } });
    ok(first.ok && first.receipt.changes[0].value === (await s.readConfig()).questionTimeoutMs && first.receipt.changes[0].effective === 'next_wait', '回执来自实际写盘值，已有等待不宣称重置');
    ok(first.undoRef.action.args.expected.questionTimeoutMs === 360000, '撤销带原修改后的现值条件');
    await call({ patch: { questionTimeoutMs: 420000 } });
    const stale = await call(first.undoRef.action.args);
    ok(stale.error === 'config.conflict' && (await s.readConfig()).questionTimeoutMs === 420000, '旧撤销不能覆盖后来的同键修改');
    const fresh = await call({ patch: { questionTimeoutMs: 480000 } });
    await call({ patch: { outputStyle: 'concise' } });
    const undone = await call(fresh.undoRef.action.args);
    ok(undone.ok && (await s.readConfig()).questionTimeoutMs === 420000 && (await s.readConfig()).outputStyle === 'concise', '撤销只恢复本次键，保留其他键的后来修改');
    const twice = await call(fresh.undoRef.action.args);
    ok(twice.error === 'config.conflict', '同一撤销不能重复改写');
    const at = await call({ patch: { stewardNotifyPerHour: 3 } });
    const concurrent = await Promise.all([call(at.undoRef.action.args), call(at.undoRef.action.args)]);
    ok(concurrent.filter(x => x.ok).length === 1 && concurrent.some(x => x.error === 'config.conflict'), '并发撤销在同一写锁中只有一个成功');
    const mixed = await call({ patch: { locale: 'en-US', permissionMode: 'auto' } });
    ok(mixed.error === 'propose_required' && (await s.readConfig()).locale !== 'en-US' && !mixed.receipt, '混合权限提议整份未写入、没有成功回执');
    const forbidden = await call({ patch: { providers: [] } });
    ok(forbidden.error === 'steward.forbidden' && !forbidden.receipt, '秘密与服务商配置仍整份拒绝');
    const forgedUndo = await s.__eval('StewardHooks.configSet')({ undo: true, patch: { permissionMode: 'auto' }, expected: { permissionMode: 'default' } }, { ...ctx, userPressed: true });
    ok(forgedUndo.error === 'steward.forbidden' && (await s.readConfig()).permissionMode !== 'auto', '伪造历史撤销按钮也不能绕过确认分档');
    const thread = await s.createSession({ title: '仅此任务', cwd: home });
    const baseline = JSON.stringify(await s.readConfig());
    const wrongScope = await call({ scope: 'thread', sessionId: thread.id, patch: { model: 'strong' } });
    ok(wrongScope.error === 'scope_requires_thread' && wrongScope.sessionId === thread.id && JSON.stringify(await s.readConfig()) === baseline, '线程意图返回准确入口，零全局写入');
    ok((await call({ scope: 'new_threads', patch: { questionTimeoutMs: 500000 } })).error === 'invalid_request', '新任务作用域不能夹带全局等待设置');
    ok((await call({ patch: { model: 'strong' } })).error === 'invalid_request', '不能把 CLI 默认模型回执冒充为当前服务商模型');
    ok((await call({ patch: { activeProvider: 'missing' } })).error === 'propose_required', '默认端点仍需确认');
    const confirmed = await s.__eval('StewardHooks.configSet')({ patch: { activeProvider: 'missing' } }, { ...ctx, userPressed: true });
    ok(confirmed.error === 'invalid_request', '确认后也不能指向不存在的端点');
    // 故意让真实写盘原语失败，不能靠假失败回包代替磁盘分支验证。
    s.__eval('globalThis.scopeOriginalWriteConfig = writeConfig; writeConfig = async () => { throw new Error("fixture disk failure"); }');
    const failed = await call({ patch: { questionTimeoutMs: 999000 } });
    s.__eval('writeConfig = globalThis.scopeOriginalWriteConfig; delete globalThis.scopeOriginalWriteConfig');
    ok(!failed.ok && !failed.receipt && (await s.readConfig()).questionTimeoutMs === 420000, '写盘失败不返回生效值、成功回执或撤销');
    s.__eval('globalThis.scopeOriginalPatch = ConfigPatchHooks.applyConfigPatch; ConfigPatchHooks.applyConfigPatch = async (patch, options) => { await mutateConfig(current => { current.questionTimeoutMs = 450000; }); return globalThis.scopeOriginalPatch(patch, options); }');
    const raced = await call({ patch: { questionTimeoutMs: 540000 } });
    s.__eval('ConfigPatchHooks.applyConfigPatch = globalThis.scopeOriginalPatch; delete globalThis.scopeOriginalPatch');
    ok(raced.receipt.changes[0].before === 450000 && raced.undoRef.before.questionTimeoutMs === 450000, '工具初读后发生其他写入，回执和撤销仍取锁内真实旧值');
    await call({ patch: { questionTimeoutMs: 420000 } });
    const old = await s.loadSession(thread.id);
    const route = { engine: 'openai', providerId: 'fake', model: 'strong' };
    await s.updateSessionMeta(thread.id, { engineRoute: route, engineRouteScope: 'thread' });
    await s.saveSession(old); // 模拟旧回合迟到收尾
    const saved = await s.loadSession(thread.id);
    const next = await s.createSession({ title: '后续任务', cwd: home });
    ok(saved.engineRoute.model === 'strong' && saved.engineRouteScope === 'thread' && next.engineRoute.model === 'base', '旧回合收尾保留仅此任务的模型与作用域，新任务默认不变');
    const raw = JSON.stringify((await s.stewardDecisionsRead({ limit: 200 })).rows);
    ok(!raw.includes('fixture-secret'), '回执、撤销与行动流水不泄露服务商密钥');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { t.done({ exit: true }); }
})();
