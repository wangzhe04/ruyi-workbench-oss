// LIVE model-tier probe (v1.0-S6b): 同一套 agentic 场景打不同档位的模型,量化对比,为「是否做小模型
// 针对性优化」提供数据。**不是回归件**(无 .e2e.js 后缀,不进离线回归 grep;判定行为 DONE 而非 ALL PASS)。
//
// 用法:  node model-tier-probe.js <API_KEY> <MODEL> [BASE_URL]
//   例:  node model-tier-probe.js sk-... deepseek-v4-pro
//         node model-tier-probe.js sk-... deepseek-v4-flash
//
// 安全纪律:key 只经命令行进入本进程,写入每场景的临时 HOME config(finally 连同整个 HOME 删除),
// 不落任何仓库文件。输出中不回显 key。
//
// 场景(每个场景独立 HOME + 独立 server,互不污染):
//   A 多步工具链  read → write → read-back 三连,考多步串联与结果回灌
//   B todo 纪律   要求先 todo_write 列计划再执行合并任务,考结构化遵从
//   C 抗幻觉      不明说用工具,问文件里的标记串,考「查了再答」vs 编造
//   D 并行格式    一回合并行两次 file_read,考 tool 批次格式纪律(400/连续性错误)
//
// 每场景记录:tool_use 序列、tool_result 错误数、error 事件数、最终文本达标、耗时、usage 累计。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const KEY = process.argv[2];
const MODEL = process.argv[3] || 'deepseek-v4-pro';
const BASE = process.argv[4] || 'https://api.deepseek.com';
if (!KEY) { console.error('用法: node model-tier-probe.js <API_KEY> <MODEL> [BASE_URL]'); process.exit(2); }

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const PORT = 8795;
const TURN_TIMEOUT_MS = 240000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// 起一个带独立 HOME/工作区的 workbench;setup(work) 先布置工作区文件。
async function withServer(tag, setup, fn) {
  const HOME = path.join(os.tmpdir(), `wcw-tier-${tag}-${MODEL.replace(/[^a-z0-9-]/gi, '_')}`);
  const WORK = path.join(HOME, 'work');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  setup(WORK);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 4, version: '0.6.0', permissionMode: 'bypass', defaultWorkspace: WORK,
    providers: [{ id: 'deepseek', label: 'DeepSeek', type: 'openai-compat', baseUrl: BASE, apiKey: KEY, model: MODEL, models: [{ id: MODEL, label: MODEL }], reasoning: true }],
    activeProvider: 'deepseek',
  }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(PORT); }
    if (!h) throw new Error('workbench 未能启动');
    return await fn(WORK);
  } finally {
    killp(wb);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true }); // 临时 config 含 key,必须清
  }
}

function metrics(events, t0) {
  const toolUses = events.filter(e => e.type === 'tool_use');
  const toolErrs = events.filter(e => e.type === 'tool_result' && e.isError === true);
  const errEvents = events.filter(e => e.type === 'error');
  const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
  const result = events.find(e => e.type === 'result');
  const usages = events.filter(e => e.type === 'usage');
  const lastUsage = usages.length ? usages[usages.length - 1] : null;
  return {
    tools: toolUses.map(t => t.name),
    toolErrors: toolErrs.length,
    errorEvents: errEvents.map(e => String(e.message || e.error || '').slice(0, 120)),
    text,
    resultOk: !!(result && result.ok === true),
    durationMs: Date.now() - t0,
    usage: lastUsage ? { in: lastUsage.inputTokens ?? lastUsage.input_tokens, out: lastUsage.outputTokens ?? lastUsage.output_tokens } : null,
  };
}

async function runTurn(message) {
  const t0 = Date.now();
  const events = await Promise.race([
    postStream(PORT, { message }),
    sleep(TURN_TIMEOUT_MS).then(() => { throw new Error(`回合超时 ${TURN_TIMEOUT_MS}ms`); }),
  ]);
  return metrics(events, t0);
}

(async () => {
  const report = [];
  const scenario = async (id, name, setup, message, judge) => {
    process.stdout.write(`\n=== [${id}] ${name} ===\n`);
    try {
      const r = await withServer(id.toLowerCase(), setup, async (work) => {
        const m = await runTurn(message(work));
        m.judge = judge(m, work);
        return m;
      });
      console.log(`  tools: ${JSON.stringify(r.tools)}`);
      console.log(`  toolErrors=${r.toolErrors} errorEvents=${r.errorEvents.length}${r.errorEvents.length ? ' ' + JSON.stringify(r.errorEvents) : ''}`);
      console.log(`  达标=${r.judge.ok}${r.judge.note ? '(' + r.judge.note + ')' : ''} resultOk=${r.resultOk} 耗时=${(r.durationMs / 1000).toFixed(1)}s usage=${JSON.stringify(r.usage)}`);
      console.log(`  text(尾160): ${JSON.stringify(r.text.slice(-160))}`);
      report.push({ id, name, ok: r.judge.ok, note: r.judge.note || '', tools: r.tools.length, toolErrors: r.toolErrors, errorEvents: r.errorEvents.length, seconds: +(r.durationMs / 1000).toFixed(1), usage: r.usage });
    } catch (e) {
      console.log(`  场景异常: ${e.message}`);
      report.push({ id, name, ok: false, note: '异常: ' + e.message.slice(0, 80), tools: 0, toolErrors: 0, errorEvents: 0, seconds: 0, usage: null });
    }
  };

  const MARK = 'ZX_TIER_MARK_7742';

  await scenario('A', '多步工具链 read→write→read-back',
    work => { fs.writeFileSync(path.join(work, 'data.txt'), '第一行:苹果\n第二行:香蕉总量为42箱\n第三行:橙子\n'); },
    work => `请在工作区完成三步:1) 用 file_read 读取 data.txt;2) 用 file_write 新建 summary.txt,内容只有一行:「结论:」加上 data.txt 第二行的内容;3) 再用 file_read 读回 summary.txt 确认,并把 summary.txt 的最终内容原样告诉我。`,
    (m, work) => {
      let disk = ''; try { disk = fs.readFileSync(path.join(work, 'summary.txt'), 'utf8'); } catch { /* absent */ }
      const diskOk = /结论[:：]/.test(disk) && disk.includes('42');
      return { ok: diskOk && m.text.includes('42'), note: diskOk ? '' : 'summary.txt 缺失或内容错(' + JSON.stringify(disk.slice(0, 60)) + ')' };
    });

  await scenario('B', 'todo 纪律(先列计划再执行)',
    work => { fs.writeFileSync(path.join(work, 'a.txt'), 'AAA内容\n'); fs.writeFileSync(path.join(work, 'b.txt'), 'BBB内容\n'); },
    work => `这是一个多步任务,请务必先用 todo_write 列出计划再动手:把工作区 a.txt 和 b.txt 的内容合并成 merged.txt(a 在前 b 在后),完成后把 todo 逐项标记完成,最后告诉我 merged.txt 的内容。`,
    (m, work) => {
      let disk = ''; try { disk = fs.readFileSync(path.join(work, 'merged.txt'), 'utf8'); } catch { /* absent */ }
      const mergedOk = disk.indexOf('AAA') >= 0 && disk.indexOf('BBB') >= 0 && disk.indexOf('AAA') < disk.indexOf('BBB');
      const usedTodo = m.tools.includes('todo_write');
      return { ok: mergedOk && usedTodo, note: (usedTodo ? '' : '未用 todo_write;') + (mergedOk ? '' : 'merged.txt 错/缺') };
    });

  await scenario('C', '抗幻觉(不明说用工具)',
    work => { fs.writeFileSync(path.join(work, 'secret.txt'), '本文件记录:标记串是 ' + MARK + ' ,请勿外传。\n'); },
    work => `工作区里的 secret.txt 中有一个以 ZX_ 开头的标记串,它是什么?请精确原样告诉我。`,
    m => ({ ok: m.tools.includes('file_read') && m.text.includes(MARK), note: (m.tools.includes('file_read') ? '' : '未读文件;') + (m.text.includes(MARK) ? '' : '答案不含标记(疑似编造/未完成)') }));

  await scenario('D', '并行工具格式纪律',
    work => { fs.writeFileSync(path.join(work, 'a.txt'), '这是甲文档,主题是天气。\n'); fs.writeFileSync(path.join(work, 'b.txt'), '这是乙文档,主题是美食。\n'); },
    work => `请在同一个回合内并行调用两次 file_read 分别读取 a.txt 与 b.txt,然后各用一句话概括两个文件的主题。`,
    m => {
      const reads = m.tools.filter(t => t === 'file_read').length;
      return { ok: reads >= 2 && m.errorEvents.length === 0 && /天气/.test(m.text) && /美食/.test(m.text), note: `file_read×${reads}` + (m.errorEvents.length ? ';有 error 事件' : '') };
    });

  console.log('\n================ 汇总 (' + MODEL + ') ================');
  console.log(JSON.stringify(report, null, 2));
  const okN = report.filter(r => r.ok).length;
  console.log(`\nMODEL-TIER PROBE (${MODEL}): DONE — ${okN}/${report.length} 场景达标`);
})().catch(e => { console.error('PROBE ERROR: ' + e.message); process.exit(1); });
