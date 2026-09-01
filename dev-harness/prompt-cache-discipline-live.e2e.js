#!/usr/bin/env node
// LIVE E2E · 22 号线 #1「Prompt Cache 纪律验证」(B 类证据门,手工运行,不进 run-all)。
//
// 用固定多轮请求对真实 DeepSeek(deepseek-v4-flash)做冷/热对照,验证提示词布局纪律的
// 缓存经济性前提 —— 不改 Ruyi 任何行为,不宣告收益已兑现,只产出可复核的计量证据:
//   S1 identical-hot   同一请求立即重发               → 命中应大幅出现(provider 有自动缓存)
//   S4 prefix-sensitivity 与 S1 仅差首句一个词         → 前缀匹配必须逐字节,尾部相同不算数
//   S2 append-only     Ruyi 纪律布局:稳定 sys+只追加历史  → 后续轮次命中率高
//   S3 volatile-early  反纪律对照:系统层早期放易变内容    → 长尾被污染,命中率显著掉落
//   S5 tools 字段 A/B  同一批消息字节 × 三种 tools 形态    → 判定 tools 是否计入缓存前缀
//      S5-stable      tools 恒定的热重发(对照)           → 带 tools 时缓存本身可用
//      S5-mid         tools 数组中间插入一个工具           → 命中塌陷=tools 计入前缀且位置敏感
//      S5-append      tools 数组尾部追加一个工具           → 若容忍则 append-only 是安全修法
//   S5 残余命中还带位置信息:≈0 说明 tools 在 token 流最前;≈sys 占比说明 tools 夹在 sys 与会话之间。
//
// 关键 A/B 断言(V4a/V5):S2 显著优于 S3、S1 热 ≫ S4 —— 两项同时成立才支持
// 「首部稳定/易变后置」纪律在该 provider+model 上有真实费用意义。
//
// Key 经环境变量或 argv 进入进程(argv 优先级低于 env,便于 `DEEPSEEK_API_KEY=… node … '' out.json`
// 的无回显用法),不落盘不入日志(临时目录模式与 deepseek-live 一致)。
// 定价默认取工作台 deepseek-v4-flash 预设(CNY/1M):input 1 / cached 0.02 / output 2,
// 可用 PRICE_*_PER_M 环境变量覆盖;所有费用均为估算,不是供应商账单。
// 结果 JSON 可经 argv[3] 落盘归档(benchmark-results/)。
//
// 用法: node dev-harness/prompt-cache-discipline-live.e2e.js <DEEPSEEK_API_KEY> [结果JSON路径]
'use strict';
const fs = require('fs');

const KEY = process.env.DEEPSEEK_API_KEY || process.argv[2] || '';
const OUT = process.argv[3] || '';
const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const PRICING = {
  inputPerM: Number(process.env.PRICE_INPUT_PER_M ?? 1),
  cachedPerM: Number(process.env.PRICE_CACHED_PER_M ?? 0.02),
  outputPerM: Number(process.env.PRICE_OUTPUT_PER_M ?? 2),
};

if (!KEY) { console.error('Usage: node dev-harness/prompt-cache-discipline-live.e2e.js <DEEPSEEK_API_KEY> [out.json]'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 运行盐:每次探针实例默认生成唯一夹具字节(可用 RUYI_PROBE_SALT 固定复现)。没有它,上一轮探针
// 发送过的相同请求会在服务端缓存里存活很久(实测 >15 分钟),把后续运行的"冷"基线整体污染 ——
// 第二次验证曾因此误报:S4 与 S3 的"新"字节其实是上一轮的热数据。盐保证所有冷/热配对
// 都在同一运行窗口内成立,这是本探针判定有效性的前提。
const SALT = process.env.RUYI_PROBE_SALT || `salt-${Date.now().toString(36)}-${process.pid}`;

// ── 固定夹具(确定性生成,无随机;中文为主贴近真实工作台语言构成) ────────────────────────────────────────
function stableSystem() {
  let s = `你是一个档案整理助手【夹具批次 ${SALT}】。以下是不可变的工作规范,请严格记住。\n\n`;
  for (let i = 1; i <= 40; i++) s += `规范${i}:处理第 ${i} 类条目时,先核对来源标签,再按时间排序,重复项保留最早版本并在备注中标注冲突来源(${SALT});金额字段统一保留两位小数并使用半角符号;日期一律转换为 YYYY-MM-DD;文件名中的空格改为下划线。\n`;
  return s;
}
function userTurn(k) { return `第 ${k} 批任务:请确认第 ${(k * 7) % 40 || 40} 类规范仍然有效,并用一句话回报状态编号 K-${k}。`; }
// 反纪律注入槽:固定宽度标记替换在系统层的早期位置(约第 180 字节处),每轮内容不同但长度不变,
// 使两轮请求在极早位置分叉 —— 之后的长尾字节完全一致却无法命中。
function poison(sys, k) {
  const marker = (`<轮次状态:${k}>`).padEnd(12, '·');
  return sys.slice(0, 60) + marker + sys.slice(72);
}

// ── S5 夹具:8 个中文工具 schema(贴近 Ruyi 体量),派生中间插入/尾部追加两种扰动 ──
// 三种形态共享同一批消息字节,确保若 tools 不计入前缀则三者命中同一缓存。
function toolsFixture() {
  const mk = (name, desc, props) => ({
    type: 'function',
    function: {
      name,
      description: `${desc}(${SALT})。调用前确认参数完整;失败时返回结构化错误而不是重试。`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(props.map(([p, d]) => [p, { type: 'string', description: `${d}(${SALT})` }])),
        required: [props[0][0]],
      },
    },
  });
  const base = [
    mk('file_read', '读取本地文本文件内容', [['path', '文件绝对路径'], ['encoding', '编码,默认 utf-8']]),
    mk('file_write', '写入本地文件,自动建父目录', [['path', '目标路径'], ['content', '完整文本内容']]),
    mk('file_search', '按正则递归搜索目录内文本', [['pattern', '正则表达式'], ['root', '起始目录']]),
    mk('shell_run', '执行一条 shell 命令并回传输出', [['command', '命令行'], ['cwd', '工作目录']]),
    mk('web_fetch', '抓取公网网页正文', [['url', 'http(s) 地址']]),
    mk('git_status', '查看仓库工作区状态', [['cwd', '仓库目录']]),
    mk('git_diff', '查看未提交改动的差异', [['cwd', '仓库目录'], ['path', '限定文件']]),
    mk('memory_save', '保存一条长期记忆候选', [['key', '记忆键'], ['content', '记忆正文']]),
  ];
  const extra = mk('chart_render', '渲染一张统计图表为 png', [['title', '图表标题'], ['data', '序列化数据']]);
  const mid = base.slice(); mid.splice(2, 0, extra);   // 中间插入:模拟 Ruyi catalog 序原位插入(G2)
  const end = base.concat([extra]);                    // 尾部追加:append-only 候选修法
  return { base, mid, end };
}

async function callOnce(messages, tag, tools) {
  const t0 = Date.now();
  const body = { model: MODEL, messages, max_tokens: 120, temperature: 0, stream: false };
  if (Array.isArray(tools) && tools.length) { body.tools = tools; body.tool_choice = 'auto'; } // 镜像 Ruyi chat 分支(09-workflow.js)
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) {
    throw new Error(`[${tag}] HTTP ${res.status}: ${JSON.stringify(j && j.error || (j ? j : await res.text().catch(() => ''))).slice(0, 300)}`);
  }
  const u = j.usage || {};
  // 分 provider 归一的缓存口径:DeepSeek 原生 prompt_cache_hit_tokens / OpenAI 式 prompt_tokens_details
  const hit = Number(u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens ?? ((u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? 0)) || 0;
  const missDeclared = Number(u.prompt_cache_miss_tokens ?? 0) || 0;
  const promptTokens = Number(u.prompt_tokens ?? (hit + missDeclared)) || 0;
  const outTokens = Number(u.completion_tokens ?? 0) || 0;
  const reply = String(((j.choices && j.choices[0] && j.choices[0].message) || {}).content || '');
  return { tag, status: res.status, httpMs: Date.now() - t0, hit, missDeclared, promptTokens, outTokens, reply, usageRawKeys: Object.keys(u), modelResp: j.model || MODEL };
}
const costOf = r => (r.promptTokens - r.hit) / 1e6 * PRICING.inputPerM + r.hit / 1e6 * PRICING.cachedPerM + r.outTokens / 1e6 * PRICING.outputPerM;
const hitShare = r => (r.promptTokens > 0 ? r.hit / r.promptTokens : 0);

(async () => {
  let hardFail = 0;
  const softFail = [];
  const records = [];
  const ok = (c, l) => { console.log((c ? 'PASS ' : 'FAIL ') + l); if (!c) hardFail++; };
  const soft = (c, l) => { console.log((c ? 'PASS ' : 'SOFT-FAIL ') + l); if (!c) softFail.push(l); };
  const push = r => { records.push(r); return r; };

  try {
    // ── 连通性/auth 冒烟(硬门) ──
    const smoke = push(await callOnce([{ role: 'user', content: '回复两个字:就绪' }], 'smoke'));
    console.log(`--- smoke: HTTP ${smoke.status}, usage keys [${smoke.usageRawKeys.join(',') || '无'}] ---`);
    ok(smoke.promptTokens >= 0, `endpoint/model available (${MODEL})`);

    const cacheTelemetryOn = records.some(r => r.promptTokens > 0 && (/prompt_cache_hit_tokens|cached_tokens|cache_read/.test(JSON.stringify(r.usageRawKeys))));
    // ── S1 · 同一请求冷→热重发 ──
    const sysS = stableSystem();
    const bodyS1 = [{ role: 'system', content: sysS }, { role: 'user', content: userTurn(1) }];
    const cold = push(await callOnce(bodyS1, 'S1-r1-cold')); await sleep(300);
    const hot = push(await callOnce(bodyS1, 'S1-r2-hot'));
    ok(cold.promptTokens > 500 && hot.promptTokens > 500, `fixture size realistic (cold=${cold.promptTokens} tok)`);

    // ── S4 · 前缀敏感:与 S1 完全相同的请求但首句换一个词 ──
    const sysPerturbed = sysS.replace('档案整理助手', '资料整理助手');
    const s4 = push(await callOnce([{ role: 'system', content: sysPerturbed }, { role: 'user', content: userTurn(1) }], 'S4-perturb'));

    // ── S2 · Ruyi 纪律布局(稳定系统层 + 只追加历史) 4 轮 agent-loop 模拟 ──
    const conv = [{ role: 'system', content: sysS }, { role: 'user', content: userTurn(11) }];
    const rounds2 = [];
    for (let k = 1; k <= 4; k++) {
      const r = push(await callOnce(conv, `S2-round${k}${k === 1 ? '-cold' : '-hot'}`));
      rounds2.push(r);
      conv.push({ role: 'assistant', content: r.reply || '(空)' });
      conv.push({ role: 'user', content: userTurn(11 + k) });
      await sleep(250);
    }

    // ── S3 · 反纪律对照(同样追加,但系统层每轮早期注入不同易变标记) ──
    const conv3 = [{ role: 'system', content: poison(sysS, 1) }, { role: 'user', content: userTurn(21) }];
    const rounds3 = [];
    for (let k = 1; k <= 4; k++) {
      if (k > 1) conv3[0].content = poison(sysS, k); // 每轮在早期换一个等宽标记 → 早分叉
      const r = push(await callOnce(conv3, `S3-round${k}`));
      rounds3.push(r);
      conv3.push({ role: 'assistant', content: r.reply || '(空)' });
      conv3.push({ role: 'user', content: userTurn(21 + k) });
      await sleep(250);
    }

    // ── S5 · tools 字段缓存语义 A/B(同一批消息字节 × tools 恒定/中插/尾追加) ──
    // 回答 106 #1 核查的关键缺口:tools 是否计入 deepseek 缓存前缀(G2 的真实影响前提)。
    // 消息夹具独立生成(不复用模型回复),保证三种 tools 形态下 messages 逐字节相同。
    const tf = toolsFixture();
    const sys5 = stableSystem().replace('档案整理助手', '工具纪律助手');
    const conv5 = [
      { role: 'system', content: sys5 },
      { role: 'user', content: userTurn(31) },
      { role: 'assistant', content: `状态编号 K-31 已确认有效(${SALT})。` },
      { role: 'user', content: userTurn(32) },
      { role: 'assistant', content: `状态编号 K-32 已确认有效(${SALT})。` },
      { role: 'user', content: userTurn(33) },
    ];
    const s5Cold = push(await callOnce(conv5, 'S5-cold', tf.base)); await sleep(300);
    const s5Stable = push(await callOnce(conv5, 'S5-hot-stable', tf.base)); await sleep(300);
    const s5Mid = push(await callOnce(conv5, 'S5-mid-insert', tf.mid)); await sleep(300);
    const s5End = push(await callOnce(conv5, 'S5-end-append', tf.end));

    // ── 判定(总费用纳入命中/未命中/输出三分项) ──
    console.log('\n=== 计量明细(prompt/hit/hitShare/cost估算CNY) ===');
    for (const r of records) console.log(`${r.tag.padEnd(14)} p=${String(r.promptTokens).padStart(6)} hit=${String(r.hit).padStart(6)} share=${hitShare(r).toFixed(2)} cost≈${costOf(r).toFixed(5)} out=${r.outTokens}`);

    if (!cacheTelemetryOn) {
      console.log('INCONCLUSIVE: provider 未返回任何缓存计量字段 —— 按 §6.2 纪律不得填成“缓存未命中”或推算已省费用');
      soft(cacheTelemetryOn, 'provider exposes cache usage accounting');
    } else {
      soft(true, 'provider exposes cache usage accounting');
      // V3 热重发命中(SOFT:服务端缓存时效不受契约保护)
      soft(hitShare(hot) >= 0.5, `V3 immediate hot repeat hits (share=${hitShare(hot).toFixed(2)} ≥ 0.5; cold baseline=${hitShare(cold).toFixed(2)})`);
      // V5 前缀敏感性配对:S1热 与 S4 只差首句一词 → 命中必须显著塌陷
      soft(hitShare(hot) - hitShare(s4) >= 0.25, `V5 byte-exact prefix required (hot=${hitShare(hot).toFixed(2)} vs perturbed=${hitShare(s4).toFixed(2)}, Δ≥25pp)`);
      // V4 追加式布局后续轮保持高命中(SOFT)
      soft(hitShare(rounds2[3]) >= 0.5, `V4a append-only final round hit share=${hitShare(rounds2[3]).toFixed(2)} ≥ 0.5`);
      // V4a 关键 A/B:纪律 vs 反纪律末轮差 ≥25pp(B 类主证据)
      soft(hitShare(rounds2[3]) - hitShare(rounds3[3]) >= 0.25, `V4b KEY A/B disciplined vs volatile-early final round (Δ=${(hitShare(rounds2[3]) - hitShare(rounds3[3])).toFixed(2)}pp ≥ 25pp)`);
      // 费用视角:同一任务形态下,纪律布局四轮总费低于反纪律布局
      const c2 = rounds2.reduce((a, r) => a + costOf(r), 0), c3 = rounds3.reduce((a, r) => a + costOf(r), 0);
      soft(c2 < c3, `cost view: append-only Σ≈¥${c2.toFixed(5)} < volatile-early Σ≈¥${c3.toFixed(5)} (preset pricing, estimate not bill)`);

      // ── V6 · tools 字段是否计入缓存前缀(S5,106 #1 核查 G2 前置证据) ──
      const shStable = hitShare(s5Stable), shMid = hitShare(s5Mid), shEnd = hitShare(s5End);
      soft(shStable >= 0.5, `V6a tools present, stable tools still cache-hits (share=${shStable.toFixed(2)} ≥ 0.5; cold=${hitShare(s5Cold).toFixed(2)})`);
      const dMid = shStable - shMid, dEnd = shStable - shEnd;
      const midDecisive = dMid >= 0.25 || dMid <= 0.10;
      soft(midDecisive, `V6b tools mid-insert decisive (Δ=${dMid.toFixed(2)}pp vs stable; ≥25pp=计入前缀且位置敏感, ≤10pp=不计入)`);
      const endDecisive = dEnd >= 0.25 || dEnd <= 0.10;
      soft(endDecisive, `V6c tools end-append decisive (Δ=${dEnd.toFixed(2)}pp; ≤10pp=append-only 修法安全)`);
      console.log(`\n=== S5 结论(tools 缓存语义) ===`);
      console.log(`mid-insert 残余命中 share=${shMid.toFixed(2)}(≈0→tools 在 token 流最前;≈sys 占比→夹在 sys 与会话间;≈stable→不计入前缀)`);
      console.log(`end-append 残余命中 share=${shEnd.toFixed(2)}`);
      console.log(`判定: tools ${dMid >= 0.25 ? '计入缓存前缀(位置敏感),G2 为真实问题' : (dMid <= 0.10 ? '不计入缓存前缀,G2 无实际费用影响' : '影响 inconclusive,需复测')}; append-only ${dEnd <= 0.10 ? '被容忍' : (dEnd >= 0.25 ? '不被容忍' : 'inconclusive')}`);
    }

    console.log('\n=== 结论 ===');
    console.log(`hard-fails=${hardFail} soft-fails=${softFail.length}`);
    if (hardFail) { console.log('PROMPT-CACHE LIVE PROBE: FAIL'); process.exitCode = 1; }
    else if (softFail.length) { console.log('PROMPT-CACHE LIVE PROBE: PARTIAL(' + softFail.length + ' 项未达阈值,明细见上)'); process.exitCode = 0; }
    else console.log('PROMPT-CACHE LIVE PROBE: ALL PASS');
  } catch (e) {
    console.log('ERROR ' + (e && e.message || e));
    process.exitCode = 1;
  } finally {
    if (OUT) {
      const payload = {
        probe: '22-line #1 prompt-cache discipline validation', protocol: 'chat-completions', base: BASE, model: MODEL,
        runSalt: SALT, pricingAssumptionCNYperM: PRICING, generatedAt: new Date().toISOString(),
        records: records.map(({ reply, ...r }) => ({ ...r, replyBytes: Buffer.byteLength(reply || '') })),
        note: 'estimate uses workbench preset pricing; provider cache timing is server-managed and not contractual; fixture bytes are unique per run via SALT so cold/hot pairs are valid within-run',
      };
      try { fs.mkdirSync(require('path').dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(payload, null, 2)); console.log('evidence written: ' + OUT); } catch (er) { console.log('evidence write failed: ' + er.message); }
    }
    process.exit(process.exitCode || 0);
  }
})();
