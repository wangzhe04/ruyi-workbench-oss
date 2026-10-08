require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(工具分发批):真服务进程 + 脚本化假 provider,按用户消息里的 SCN-<X> 分支,走主回合工具循环(09 runOpenAiTurn → 12 toolCall)。
//   [N4] allowCommandTools:false 时模型直接吐出 script_run 也不执行(bypass 下 gate 恒放行,修前只是藏了 schema):回 code:'tool-disabled',
//        证明文件不存在;经 tool_invoke_exec 代理调同一个工具同样被拒。
//   [N5] 未知工具名 → did-you-mean(list_directory → file_list)+ tool_search 指引;file_read {} → invalid-arguments 点名 path,不再是 EISDIR。
//   [N1] tool_invoke_edit{file_write} 带着 ctx 进目标:有检查点(无 checkpointWarn)、turn_summary 里 revertible:true。
//   [N1b] tool_invoke_exec{script_run} 在回合摘要的不可逆账里按 script_run 记(修前账是空的)。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const t = createRunner('TOOL DISPATCH HARDENING');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const scenarioOf = messages => {
  const tagged = messages.filter(m => m && m.role === 'user' && /SCN-[A-Z0-9]+/.test(contentText(m.content)));
  const m = tagged.length ? /SCN-([A-Z0-9]+)/.exec(contentText(tagged[tagged.length - 1].content)) : null;
  return m ? m[1] : '';
};

async function withServer(configExtra, body) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-dispatch-hardening-'));
  const WS = path.join(HOME, 'ws');
  fs.mkdirSync(WS, { recursive: true });
  const proof = path.join(HOME, 'nocmd-proof.txt');
  const WP = await getFreePort();
  const fake = await startFakeProvider({
    async handler(req) {
      const msgs = req.messages;
      if (!req.stream) return textFrames('{"title":"t","gist":"g"}');
      const answered = msgs.slice(msgs.map(m => m && m.role).lastIndexOf('user') + 1).some(m => m.role === 'tool');
      if (answered) return textFrames('done');
      const code = `require('fs').writeFileSync(${JSON.stringify(proof)},'ran');console.log('ran')`;
      switch (scenarioOf(msgs)) {
        case 'NOCMD': return toolCallFrames('script_run', { language: 'node', code }, 'n1');
        case 'NOCMDINV': return toolCallFrames('tool_invoke_exec', { name: 'script_run', arguments: { language: 'node', code } }, 'n2');
        case 'UNK': return toolCallFrames('list_directory', { path: '.' }, 'u1');
        case 'BADARG': return toolCallFrames('file_read', {}, 'b1');
        case 'INV': return toolCallFrames('tool_invoke_edit', { name: 'file_write', arguments: { path: path.join(WS, 'via-invoke.txt'), content: 'hello' } }, 'i1');
        case 'INVEXEC': return toolCallFrames('tool_invoke_exec', { name: 'script_run', arguments: { language: 'node', code: "console.log('ran')" } }, 'i2');
        default: return textFrames('default');
      }
    },
  });
  fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WS, toolLoadingMode: 'auto', ...configExtra,
    // 本件只测原生工具分发;本机 ACC 的 list_directory 不应占用未知工具反例的名字。
    desktopMcp: { enabled: false, autodetect: false },
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
    activeProvider: 'fake',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, stdio: 'ignore', env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME } });
  const request = (method, p) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: WP, path: p, method }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end();
  });
  const stream = payload => new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const evs = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!l.trim()) continue; try { evs.push(JSON.parse(l)); } catch { /* skip */ } } });
      res.on('end', () => resolve(evs));
    });
    r.on('error', reject); r.write(raw); r.end();
  });
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { try { up = (await request('GET', '/health')) === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
    ok(up, 'server up');
    // 跑一个场景:返回 { toolText(模型下一发请求里看到的 tool 消息), summary(turn_summary), evs }
    const run = async scn => {
      const evs = await stream({ message: `SCN-${scn} go` });
      const reqs = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === scn);
      const last = reqs[reqs.length - 1];
      const toolText = last ? last.messages.filter(m => m.role === 'tool').map(m => contentText(m.content)).join('\n') : '';
      const summary = (evs.find(e => e.type === 'turn_summary') || {}).summary || (evs.find(e => e.type === 'turn_summary') || {});
      return { toolText, summary, evs };
    };
    await body({ run, HOME, WS, proof });
  } finally {
    try { killOwnTree(wb.pid); } catch { /* gone */ }
    await fake.close();
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

try {
  await withServer({ allowCommandTools: false, allowDesktopTools: false }, async ({ run, WS, proof }) => {
    const a = await run('NOCMD');
    ok(/tool-disabled/.test(a.toolText) && /allowCommandTools/.test(a.toolText), `N4 直调 script_run 被分发点拒绝(got ${a.toolText.slice(0, 160)})`);
    ok(!fs.existsSync(proof), 'N4 证明文件不存在(命令没有执行)');
    const b = await run('NOCMDINV');
    ok(/tool-disabled/.test(b.toolText), `N4 经 tool_invoke_exec 代理同样被拒(got ${b.toolText.slice(0, 160)})`);
    ok(!fs.existsSync(proof), 'N4 代理路径也没有执行');
    const u = await run('UNK');
    ok(/unknown-tool/.test(u.toolText) && /file_list/.test(u.toolText) && /tool_search/.test(u.toolText), `N5 未知工具 list_directory → did-you-mean file_list + tool_search 指引(got ${u.toolText.slice(0, 260)})`);
    const g = await run('BADARG');
    ok(/invalid-arguments/.test(g.toolText) && /'path'/.test(g.toolText) && !/EISDIR/.test(g.toolText), `N5 file_read {} → invalid-arguments 点名 path(got ${g.toolText.slice(0, 200)})`);
    const i = await run('INV');
    ok(!/checkpointWarn/.test(i.toolText) && fs.existsSync(path.join(WS, 'via-invoke.txt')), `N1 tool_invoke_edit{file_write} 写成功且没有 checkpointWarn(got ${i.toolText.slice(0, 200)})`);
    const fc = Array.isArray(i.summary.filesChanged) ? i.summary.filesChanged : [];
    ok(fc.length === 1 && fc[0].revertible === true, `N1 turn_summary.filesChanged[0].revertible === true(got ${JSON.stringify(i.summary).slice(0, 240)})`);
  });
  await withServer({}, async ({ run }) => {
    const x = await run('INVEXEC');
    const irr = Array.isArray(x.summary.irreversible) ? x.summary.irreversible : [];
    ok(irr.length === 1 && irr[0].name === 'script_run' && irr[0].kind === 'exec', `N1b tool_invoke_exec{script_run} 在不可逆账里按 script_run 记(got ${JSON.stringify(x.summary).slice(0, 240)})`);
    ok(x.summary.commands === 1, `N1b commands 计数为 1(got ${x.summary.commands})`);
  });
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
}
t.done({ exit: true });
})();
