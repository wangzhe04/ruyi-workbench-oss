'use strict';
// 151 阶段 1E:每轮记忆检查(meta.memoryCheck)随本回合助手消息落盘,重载后尾标才画得出来。
// 真回合(Provider 引擎走假 OpenAI 端点、Claude 引擎走 fake-claude)→ 回合收尾那一存 → 从盘上重新装载,逐项核:
//   · 助手消息带 memoryCheck,值等于流里 meta 那一份的白名单精简副本(只有计数与回退原因);
//   · 用户消息不带;待落标记 __turnMemoryCheck 不进盘、不留在会话对象上;
//   · 同一会话的第二回合各盖各的(turnSeq 对得上才盖)。
require('./lib/self-isolate-home');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunner } = require('./lib/harness'), { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const t = createRunner('MEMORY CHECK PERSIST'), { ok } = t;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-check-persist-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home; process.env.RUYI_DISABLE_SEMANTIC = '1'; process.env.WCW_TEST_NO_NET_ANCHORS = '1';
const app = path.resolve(__dirname, '../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const COUNTERS = ['candidateCount', 'matchCount', 'projectMatches', 'globalMatches', 'coreActiveCount', 'ruleFillCount'];
function expected(check) {
  const out = { enabled: check.enabled === true, checked: check.checked === true };
  if (out.enabled && out.checked) for (const key of COUNTERS) out[key] = Number.isSafeInteger(check[key]) && check[key] >= 0 ? check[key] : 0;
  const reason = check.semantic && check.semantic.fallback && check.semantic.fallback.reason;
  if (typeof reason === 'string') out.semantic = { fallback: { reason } };
  return out;
}
(async () => {
  const fake = await startFakeProvider({ handler: () => textFrames('persisted badge answer') });
  try {
    const config = extra => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: 13, permissionMode: 'bypass', defaultWorkspace: home,
      autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false }, ...extra }));
    const provider = { providers: [{ id: 'p', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }], activeProvider: 'p' };
    async function turn(sessionId, message) {
      const events = [];
      await srv.runSessionTurn({ sessionId, message, cwd: home, onEvent: event => events.push(event) });
      return events;
    }
    async function check(label, engineConfig) {
      config(engineConfig);
      const session = await srv.createSession({ title: label, cwd: home });
      const first = await turn(session.id, 'persist the memory badge please');
      const meta1 = first.find(e => e.type === 'meta' && e.memoryCheck);
      ok(!!meta1, label + ': the turn streams meta.memoryCheck');
      ok(first.some(e => e.type === 'result'), label + ': the turn finished');
      const second = await turn(session.id, 'and once more');
      const meta2 = second.find(e => e.type === 'meta' && e.memoryCheck);
      const loaded = await srv.loadSession(session.id);
      const assistants = loaded.messages.filter(m => m.role === 'assistant');
      const users = loaded.messages.filter(m => m.role === 'user');
      ok(assistants.length === 2, label + ': two assistant messages persisted (' + assistants.length + ')');
      ok(meta1 && JSON.stringify(assistants[0] && assistants[0].memoryCheck) === JSON.stringify(expected(meta1.memoryCheck)),
        label + ': first assistant carries the whitelisted copy of its own meta.memoryCheck ' + JSON.stringify(assistants[0] && assistants[0].memoryCheck));
      ok(meta2 && JSON.stringify(assistants[1] && assistants[1].memoryCheck) === JSON.stringify(expected(meta2.memoryCheck)), label + ': second turn stamps its own message');
      ok(users.every(m => m.memoryCheck === undefined), label + ': user messages never carry it');
      ok(Number(assistants[0].turnSeq) !== Number(assistants[1].turnSeq), label + ': the two stamps belong to different turns');
      const files = fs.readdirSync(path.join(home, 'sessions')).filter(name => name.startsWith(session.id));
      const disk = files.map(name => fs.readFileSync(path.join(home, 'sessions', name), 'utf8')).join('\n');
      ok(disk.includes('"memoryCheck"'), label + ': the field is on disk');
      ok(!disk.includes('__turnMemoryCheck'), label + ': the pending mark never reaches disk');
      ok(!JSON.stringify(loaded).includes('__turnMemoryCheck'), label + ': nor the reloaded session');
      const keys = new Set(assistants.flatMap(m => Object.keys(m.memoryCheck || {})));
      ok([...keys].every(key => ['enabled', 'checked', ...COUNTERS, 'semantic'].includes(key)), label + ': only whitelisted keys ' + [...keys].join(','));
      return session.id;
    }
    // 1E 复审:CLI 引擎在助手消息之后、收尾存之前还会追加一条 {role:'system', source:'stderr'}(05 / 05b)。
    // 修前只看最后一条消息,有 stderr 的回合尾标整个丢失。fake-claude 的 stderrflood 场景先刷 stderr、再照常答完。
    async function stderrTurn(sessionId) {
      const events = await turn(sessionId, 'stderrflood please');
      const meta = events.find(e => e.type === 'meta' && e.memoryCheck);
      const loaded = await srv.loadSession(sessionId);
      const tail = loaded.messages.slice(-2);
      ok(tail.length === 2 && tail[0].role === 'assistant' && tail[1].role === 'system' && tail[1].source === 'stderr',
        'claude stderr: the turn ends with the assistant row followed by a stderr system row ' + JSON.stringify(tail.map(m => [m.role, m.source])));
      ok(meta && tail[0] && JSON.stringify(tail[0].memoryCheck) === JSON.stringify(expected(meta.memoryCheck)), 'claude stderr: the assistant row before the stderr row still carries its memoryCheck');
      ok(tail[1] && tail[1].memoryCheck === undefined, 'claude stderr: the stderr row itself carries nothing');
    }
    await check('provider', provider);
    process.env.WCW_FAKE_CLAUDE = path.resolve(app, '../tools/fake-claude.js');
    const claudeSession = await check('claude', { engineMode: 'print', providers: [], activeProvider: '' });
    await stderrTurn(claudeSession);
  } catch (error) { t.fail('fatal: ' + (error && error.stack || error)); }
  finally {
    delete process.env.WCW_FAKE_CLAUDE;
    await fake.close();
    if (path.dirname(home) !== path.resolve(os.tmpdir()) || !path.basename(home).startsWith('ruyi-memory-check-persist-')) throw Error('fixture cleanup outside owned temp');
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows may still hold a log handle; the temp root is owned */ }
  }
  t.done({ exit: true });
})().catch(error => { console.error(error); process.exit(1); });
