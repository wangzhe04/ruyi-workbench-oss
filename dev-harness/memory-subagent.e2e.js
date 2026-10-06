'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:provider 子代理与工作流节点的记忆面(走查 记忆 B #15 + #6 的节点同源处)。真工作台 + 脚本化假 provider,断网可跑。
//
//   修前:子代理的工具表带着全部 6 个记忆工具(propose / revise / relation_* 都能写),却拿不到记忆本体 —— 用户的核心偏好
//   (中文回复、提交规范)到不了子代理;而子代理以 parentSession 的身份调工具,它写的候选占掉父线程每回合唯一的候选槽。
//   现在:
//     S1 子代理工具表剔除 propose / revise / relation_propose / relation_revoke,保留 list / read;
//     S2 子代理系统提示里有【核心胶囊】(<workbench-memory-core>),且不含相关索引(相关召回是按主线那句话排的);
//     S3 工作流节点的任务正文里只有检索回执 + 相关索引(核心胶囊已在系统提示里,不在同一次请求里出现两遍),
//        索引行是 [id](scope)、指示 workbench_memory_read(provider 的 file_read 封了记忆目录);
//     S4 模型凭记忆硬调记忆写工具 → 分发点确定性拒绝(双保险),父线程的候选槽纹丝不动;
//     S5 会话级「关闭记忆」(memories:[])同样管着子代理:没有核心胶囊。
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-subagent-'));
const WORK = path.join(ROOT, 'work');
const t = createRunner('MEMORY SUBAGENT');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WRITE_TOOLS = ['workbench_memory_propose', 'workbench_memory_revise', 'workbench_memory_relation_propose', 'workbench_memory_relation_revoke'];

function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); } });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitFor(fn, tries = 150, gap = 100) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}
const userTextOf = m => (typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && p.type === 'text') ? String(p.text || '') : '').join('\n') : ''));
const sysOf = req => userTextOf((req.messages || []).find(m => m && m.role === 'system') || {});
const isSub = req => sysOf(req).includes('子任务执行体');

(async () => {
  let fake = null, wb = null;
  try {
    fs.mkdirSync(WORK, { recursive: true });
    const subReqs = [];
    fake = await startFakeProvider({
      handler(req) {
        if (!req.stream) return textFrames('aux');
        if (!isSub(req)) return textFrames('parent ok');
        subReqs.push(req);
        const gotTool = req.messages.some(m => m && m.role === 'tool');
        if (!gotTool && /HALLUCINATE/.test(JSON.stringify(req.messages))) {
          // 模型凭记忆硬调一个没 offer 给子代理的记忆写工具
          return toolCallFrames('workbench_memory_propose', { name: '子代理想写的记忆', description: '子代理凭记忆调了 propose', type: 'lesson', scope: 'project', body: 'x', reason: 'r' }, 'call_prop');
        }
        return textFrames('sub done');
      },
    });
    const home = path.join(ROOT, 'home'); fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      configSchema: 12, permissionMode: 'bypass', defaultWorkspace: WORK, stewardThreadBriefV1: false, autoImportClaudeCodeMcp: false,
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'sub-model' }], activeProvider: 'fake',
    }));
    const port = await getFreePort();
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home } });
    let log = ''; wb.stdout.on('data', d => { log += d; }); wb.stderr.on('data', d => { log += d; });
    const up = await waitFor(() => request(port, 'GET', '/health').catch(() => null), 100, 150);
    if (!up) throw new Error('workbench did not start: ' + log.slice(-800));
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const headers = { 'x-wcw-token': token };
    const save = memory => request(port, 'POST', '/api/memory', { memory, cwd: WORK }, headers);
    const saved = [
      await save({ id: 'core-zh', scope: 'project', type: 'preference', name: '默认中文回复', description: '默认使用简体中文回答用户', body: 'x', core: true }),
      await save({ id: 'deploy-notes', scope: 'project', type: 'lesson', name: 'deploy pipeline notes', description: 'deploy pipeline must run the release workflow first', body: 'x' }),
    ];
    ok(saved.every(r => r && r.ok), 'S0 记忆夹具落盘(1 核心偏好 + 1 教训)');

    async function runNode(task, sessionId) {
      const launch = await request(port, 'POST', '/api/agent-workflow/launch', { token, sessionId, async: true, nodes: [{ id: 'n1', task, toolTier: 'read' }] }, headers);
      return waitFor(async () => {
        const list = await request(port, 'GET', `/api/agent-runs?sessionId=${encodeURIComponent(sessionId)}`, null, headers);
        const r = list && Array.isArray(list.runs) && list.runs.find(x => x.id === launch.runId);
        return r && !r.live && ['succeeded', 'failed', 'partial', 'stopped', 'cancelled'].includes(r.status) ? r : null;
      }, 400, 100);
    }
    const created = await request(port, 'POST', '/api/sessions', { title: 'memory-subagent', cwd: WORK }, headers);
    const sid = created.session.id;
    const run1 = await runNode('子任务:了解 deploy pipeline 的注意事项。HALLUCINATE', sid);
    ok(run1 && run1.status === 'succeeded', `S0b 子代理节点跑完(${run1 && run1.status})`);
    const first = subReqs[0];
    ok(!!first, 'S0c 抓到了子代理的第一发请求');
    if (first) {
      const names = first.tools.map(t2 => t2.function && t2.function.name);
      ok(WRITE_TOOLS.every(n => !names.includes(n)), `S1 子代理工具表没有记忆写工具(${WRITE_TOOLS.filter(n => names.includes(n)).join(',') || '无'})`);
      ok(names.includes('workbench_memory_list') && names.includes('workbench_memory_read'), 'S1b 只读的 list / read 还在');
      const sys = sysOf(first);
      ok(/<workbench-memory-core>[\s\S]*\[core-zh\][\s\S]*<\/workbench-memory-core>/.test(sys), 'S2 子代理系统提示里有核心胶囊(用户的核心偏好到得了子代理)');
      ok(!/<workbench-memory>/.test(sys), 'S2b 系统提示里没有相关索引(只带核心)');
      const task = userTextOf(first.messages.filter(m => m.role === 'user')[0] || {});
      ok(/<workbench-memory-check mode="default"/.test(task) && /<workbench-memory>[\s\S]*\[deploy-notes\]\(project\):/.test(task), 'S3 工作流节点任务正文里有检索回执 + 相关索引,行是 [id](scope)');
      ok(!/<workbench-memory-core>/.test(task), 'S3b 任务正文里没有核心胶囊(已在系统提示里,同一次请求不出现两遍)');
      ok(/用 workbench_memory_read 工具按方括号里的 id 读取/.test(task) && !task.includes(WORK) && !/memory[\\/]project[\\/][0-9a-f]{16}/.test(task), 'S3c 节点索引指示 workbench_memory_read、不带记忆文件路径');
    }
    const second = subReqs.find(r => r.messages.some(m => m && m.role === 'tool'));
    const toolMsg = second && second.messages.find(m => m && m.role === 'tool');
    ok(toolMsg && /子代理不能提议或修订工作台记忆/.test(String(toolMsg.content)), `S4 凭记忆硬调 propose → 分发点拒绝(${toolMsg ? String(toolMsg.content).slice(0, 60) : '没有工具结果'})`);
    const proposalFile = path.join(home, 'memory', 'proposals', sid + '.json');
    let slot = null; try { slot = JSON.parse(fs.readFileSync(proposalFile, 'utf8')); } catch { slot = null; }
    ok(!slot || !slot.current, 'S4b 父线程的候选槽纹丝不动(子代理没有占它)');

    // S5 关闭记忆:会话级 memories:[] 管着子代理
    const off = await request(port, 'POST', '/api/session/memories', { sessionId: sid, memories: [] }, headers);
    ok(off && off.ok, 'S5a 会话级关闭记忆');
    subReqs.length = 0;
    const run2 = await runNode('子任务:再看一次 deploy pipeline。', sid);
    ok(run2 && run2.status === 'succeeded' && subReqs[0] && !/<workbench-memory-core>/.test(sysOf(subReqs[0])), 'S5 关闭记忆后子代理没有核心胶囊');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (wb) { try { killOwnTree(wb); } catch { /* gone */ } }
    if (fake) await fake.close();
    if (!t.failures) { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ } }
    else console.log('[kept for inspection] ' + ROOT);
  }
  t.done({ exit: true });
})();
